/**
 * Lambda function to handle and log webhook requests from API Gateway.
 *
 * This function processes REST API Gateway events, logs them to CloudWatch,
 * stores them in MongoDB for persistence and analysis, and publishes them to SNS.
 */

// Datadog Lambda Library - must be imported first
const { datadog } = require("datadog-lambda-js");

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const { MongoClient } = require("mongodb");

// Global variables for connection reuse
let mongoClient = null;
let mongoUri = null;

/**
 * SSM Parameter Store utilities
 */
class SSMService {
  constructor() {
    this.ssmClient = new SSMClient({ region: process.env.AWS_REGION });
  }

  /**
   * Retrieve a parameter from SSM Parameter Store
   * @param {string} parameterName - The name of the parameter to retrieve
   * @param {boolean} withDecryption - Whether to decrypt SecureString parameters
   * @returns {Promise<string>} The parameter value
   */
  async getParameter(parameterName, withDecryption = true) {
    try {
      const command = new GetParameterCommand({
        Name: parameterName,
        WithDecryption: withDecryption,
      });

      const response = await this.ssmClient.send(command);
      return response.Parameter.Value;
    } catch (error) {
      console.error(
        `Failed to retrieve SSM parameter ${parameterName}:`,
        error
      );
      throw new Error(`SSM parameter retrieval failed: ${error.message}`);
    }
  }
}

/**
 * SNS utilities
 */
class SNSService {
  constructor() {
    this.snsClient = new SNSClient({ region: process.env.AWS_REGION });
  }

  /**
   * Publish webhook event to SNS topic
   * @param {string} topicArn - SNS topic ARN
   * @param {Object} eventData - The webhook event data to publish
   * @param {string} environment - Environment name (dev, prod, etc.)
   * @param {Object} trackingIds - Object containing correlationId and requestId
   * @returns {Promise<Object>} Publish result
   */
  async publishWebhookEvent(
    topicArn,
    eventData,
    environment,
    trackingIds = {},
    datadogTraceId = null,
    datadogParentId = null
  ) {
    try {
      const message = {
        environment: environment,
        timestamp: eventData.timestamp,
        source: eventData.source,
        transport: eventData.transport,
        payload: eventData.payload,
        type: eventData.type,
        isBase64Encoded: eventData.isBase64Encoded,
      };

      const command = new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(message),
        Subject: `Webhook Event - ${eventData.transport.method} ${eventData.transport.path}`,
        MessageAttributes: {
          environment: {
            DataType: "String",
            StringValue: environment,
          },
          method: {
            DataType: "String",
            StringValue: eventData.transport.method,
          },
          path: {
            DataType: "String",
            StringValue: eventData.transport.path,
          },
          contentType: {
            DataType: "String",
            StringValue: eventData.type,
          },
          "x-correlation-id": {
            DataType: "String",
            StringValue:
              trackingIds.correlationId || require("crypto").randomUUID(),
          },
          "x-request-id": {
            DataType: "String",
            StringValue:
              trackingIds.requestId || require("crypto").randomUUID(),
          },
          "content-type": {
            DataType: "String",
            StringValue: "application/json",
          },
          "x-datadog-trace-id": {
            DataType: "String",
            StringValue: datadogTraceId || correlationId,
          },
          "x-datadog-parent-id": {
            DataType: "String",
            StringValue: datadogParentId || "",
          },
        },
      });

      const response = await this.snsClient.send(command);
      console.log(
        `Webhook event published to SNS topic ${topicArn} with MessageId: ${
          response.MessageId
        }, CorrelationId: ${
          trackingIds.correlationId || "generated"
        }, RequestId: ${trackingIds.requestId || "generated"}`
      );
      return response;
    } catch (error) {
      console.error(
        `Failed to publish webhook event to SNS topic ${topicArn}:`,
        error
      );
      throw new Error(`SNS publish failed: ${error.message}`);
    }
  }
}

/**
 * MongoDB utilities
 */
class MongoDBService {
  constructor() {
    this.client = null;
    this.db = null;
  }

  /**
   * Initialize MongoDB connection
   * @param {string} connectionUri - MongoDB connection string
   * @param {string} databaseName - Database name to connect to
   */
  async connect(connectionUri, databaseName) {
    try {
      // Reuse global MongoDB client across Lambda invocations to minimize connection latency
      if (!mongoClient) {
        mongoClient = new MongoClient(connectionUri, {
          maxPoolSize: 10,
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 45000,
        });
        await mongoClient.connect();
        console.log("Connected to MongoDB (new connection)");
      } else {
        console.log("Reusing existing MongoDB connection");
      }

      // Attach the shared client and DB reference to this service instance
      this.client = mongoClient;
      this.db = this.client.db(databaseName);

      return this.db;
    } catch (error) {
      console.error("Failed to connect to MongoDB:", error);
      throw new Error(`MongoDB connection failed: ${error.message}`);
    }
  }

  /**
   * Store webhook event data in MongoDB
   * @param {string} collectionName - Collection name to store the data
   * @param {Object} eventData - The webhook event data to store
   * @returns {Promise<Object>} Insert result
   */
  async storeWebhookEvent(collectionName, eventData) {
    try {
      if (!this.db) {
        throw new Error("MongoDB not connected");
      }

      const collection = this.db.collection(collectionName);
      const result = await collection.insertOne(eventData);

      console.log(
        `Webhook event stored in collection '${collectionName}' with ID: ${result.insertedId}`
      );
      return result;
    } catch (error) {
      console.error(
        `Failed to store webhook event in collection '${collectionName}':`,
        error
      );
      throw new Error(`MongoDB insert failed: ${error.message}`);
    }
  }

  /**
   * Close MongoDB connection
   */
  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      console.log("MongoDB connection closed");
    }
  }
}

/**
 * Webhook processing utilities
 */
class WebhookProcessor {
  /**
   * Extract and structure webhook event data from API Gateway event
   * @param {Object} event - API Gateway event object (REST API format)
   * @returns {Object} Structured webhook event data
   */
  static extractEventData(event) {
    // Extract base domain and path information (REST API format)
    const domain = event.requestContext?.domainName ?? "unknown-domain";
    const stage = event.requestContext?.stage ?? "";
    const path = event.path ?? "/";
    const source = `https://${domain}${stage ? "/" + stage : ""}${path}`;

    // Extract transport details (REST API format)
    const method = event.requestContext?.httpMethod ?? "UNKNOWN";
    const headers = event.headers ?? {};
    const queryParams = event.queryStringParameters ?? {};
    const sourceIp = event.requestContext?.identity?.sourceIp ?? "unknown";

    // Extract and process payload
    const isBase64Encoded = event.isBase64Encoded ?? false;
    let payload = event.body ?? "";
    let type = "text/plain"; // Default type

    // Try to parse payload as JSON if it's not empty
    if (payload) {
      try {
        const parsedPayload = JSON.parse(payload);
        payload = parsedPayload; // Use the parsed object if successful
        type = "application/json"; // Set type to JSON
      } catch (e) {
        // If parsing fails, keep payload as is and type remains text/plain
      }
    }

    // Construct structured event data
    return {
      timestamp: new Date().toISOString(),
      source: source,
      transport: {
        method: method,
        path: path,
        headers: headers,
        queryStringParameters: queryParams,
        sourceIp: sourceIp,
      },
      payload: payload,
      type: type,
      isBase64Encoded: isBase64Encoded,
    };
  }

  /**
   * Generate collection name from transport path
   * Replace all non-alphanumeric characters with '-' and remove leading/trailing '-'
   * @param {string} path - The transport path
   * @returns {string} Sanitized collection name
   */
  static generateCollectionName(path) {
    if (!path || path === "/") {
      return "root";
    }

    // Replace all non-alphanumeric characters with '-'
    let collectionName = path.replace(/[^a-zA-Z0-9]/g, "-");

    // Remove leading and trailing '-'
    collectionName = collectionName.replace(/^-+|-+$/g, "");

    // Ensure we have a valid collection name
    if (!collectionName) {
      return "unknown";
    }

    return collectionName;
  }

  /**
   * Generate database name based on environment
   * @param {string} environment - Environment name (dev, prod, etc.)
   * @returns {string} Database name
   */
  static generateDatabaseName(environment) {
    return `${environment}-webhook`;
  }
}

/**
 * Main Lambda handler wrapped with Datadog tracing
 */
exports.handler = datadog(async (event, context) => {
  // Check if the request method is GET and reject it (REST API format)
  const httpMethod = event.requestContext?.httpMethod;
  if (httpMethod === "GET") {
    console.log(
      `GET request rejected from ${
        event.requestContext?.identity?.sourceIp || "unknown"
      } to ${event.path || "/"}`
    );

    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "POST, PUT, PATCH, DELETE",
      },
      body: JSON.stringify({
        message: "Method Not Allowed",
        error: "GET requests are not supported by this webhook endpoint",
        allowed_methods: ["POST", "PUT", "PATCH", "DELETE"],
        requestId: context.awsRequestId,
      }),
    };
  }

  const ssmService = new SSMService();
  const mongoService = new MongoDBService();
  const snsService = new SNSService();

  try {
    // Extract webhook event data
    const eventData = WebhookProcessor.extractEventData(event);

    // Log the structured entry to CloudWatch (maintain existing functionality)
    console.log("Webhook Request:", JSON.stringify(eventData, null, 2));
    console.log("Deployment test: REST API migration working correctly");

    // Get MongoDB connection string from SSM Parameter Store
    if (!mongoUri) {
      const parameterName = process.env.MONGODB_URI_PARAMETER;
      if (!parameterName) {
        throw new Error("MONGODB_URI_PARAMETER environment variable not set");
      }
      mongoUri = await ssmService.getParameter(parameterName);
    }

    // Determine environment from Lambda function name or use default
    const functionName = context.functionName || "";
    const environment = functionName.includes("dev")
      ? "dev"
      : functionName.includes("prod")
      ? "prod"
      : "unknown";

    // Generate database and collection names
    const databaseName = WebhookProcessor.generateDatabaseName(environment);
    const collectionName = WebhookProcessor.generateCollectionName(
      eventData.transport.path
    );

    // Run MongoDB storage and SNS publishing concurrently
    const startTime = Date.now();
    const snsTopicArn = process.env.SNS_TOPIC_ARN;

    // Extract tracking IDs from headers (case-insensitive)
    const headers = eventData?.transport?.headers || {};
    
    // Check for Datadog trace headers first, then fall back to correlation IDs
    const datadogTraceId = headers["x-datadog-trace-id"] || headers["X-Datadog-Trace-Id"];
    const datadogParentId = headers["x-datadog-parent-id"] || headers["X-Datadog-Parent-Id"];
    
    const correlationId =
      datadogTraceId ||
      headers["x-correlation-id"] ||
      headers["X-Correlation-ID"] ||
      headers["x-correlation-id"] ||
      headers["X-Correlation-Id"] ||
      require("crypto").randomUUID();
    const requestId =
      headers["x-request-id"] ||
      headers["X-Request-ID"] ||
      headers["x-request-id"] ||
      headers["X-Request-Id"] ||
      require("crypto").randomUUID();

    // Add trace context to logs
    console.log(
      JSON.stringify({
        message: "Processing webhook",
        correlationId: correlationId,
        requestId: requestId,
        datadogTraceId: datadogTraceId,
        datadogParentId: datadogParentId,
        path: eventData.transport.path,
        method: eventData.transport.method
      })
    );

    const operations = [];

    // MongoDB storage operation
    const mongoOperation = async () => {
      try {
        await mongoService.connect(mongoUri, databaseName);
        await mongoService.storeWebhookEvent(collectionName, eventData);
        return { success: true, operation: "mongodb" };
      } catch (error) {
        console.error("MongoDB storage failed:", error);
        return { success: false, operation: "mongodb", error: error.message };
      }
    };

    operations.push(mongoOperation());

    // SNS publishing operation
    if (snsTopicArn) {
      const snsOperation = async () => {
        try {
          await snsService.publishWebhookEvent(
            snsTopicArn,
            eventData,
            environment,
            {
              correlationId: correlationId,
              requestId: requestId,
            },
            datadogTraceId,
            datadogParentId
          );
          return { success: true, operation: "sns" };
        } catch (error) {
          console.error("SNS publishing failed:", error);
          return { success: false, operation: "sns", error: error.message };
        }
      };

      operations.push(snsOperation());
    } else {
      console.warn(
        "SNS_TOPIC_ARN environment variable not set, skipping SNS publishing"
      );
    }

    // Execute all operations concurrently
    console.log(
      "Starting concurrent operations: MongoDB storage and SNS publishing"
    );
    const results = await Promise.allSettled(operations);
    const endTime = Date.now();
    const processingTime = endTime - startTime;

    console.log(`Concurrent operations completed in ${processingTime}ms`);

    // Process results
    const mongoResult = results[0]?.value;
    const snsResult = results[1]?.value;

    // Log operation results
    if (mongoResult) {
      console.log(
        `MongoDB operation: ${mongoResult.success ? "SUCCESS" : "FAILED"}`,
        mongoResult.error ? { error: mongoResult.error } : {}
      );
    }

    if (snsResult) {
      console.log(
        `SNS operation: ${snsResult.success ? "SUCCESS" : "FAILED"}`,
        snsResult.error ? { error: snsResult.error } : {}
      );
    }

    // Determine response based on results
    const mongoSuccess = mongoResult?.success ?? false;
    const snsSuccess = snsResult?.success ?? true; // Default true if SNS not configured

    // Build response message
    let message = "Webhook received and logged successfully";
    const operations_status = {};

    if (mongoSuccess && snsSuccess) {
      message = "Webhook received, logged, stored, and published successfully";
      operations_status.mongodb = "success";
      operations_status.sns = "success";
    } else if (mongoSuccess && !snsSuccess) {
      message =
        "Webhook received, logged, and stored successfully. SNS publishing failed.";
      operations_status.mongodb = "success";
      operations_status.sns = "failed";
    } else if (!mongoSuccess && snsSuccess) {
      message =
        "Webhook received, logged, and published successfully. MongoDB storage failed.";
      operations_status.mongodb = "failed";
      operations_status.sns = "success";
    } else {
      message =
        "Webhook received and logged successfully. Both MongoDB storage and SNS publishing failed.";
      operations_status.mongodb = "failed";
      operations_status.sns = "failed";
    }

    // Return success response (even if some operations failed)
    // This ensures webhook senders get immediate acknowledgment
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: message,
        requestId: context.awsRequestId,
        database: databaseName,
        collection: collectionName,
        operations_status: operations_status,
        processing_time_ms: processingTime,
      }),
    };
  } catch (error) {
    // Log the error
    console.error("Error processing webhook:", error);

    // Return an error response
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Error processing webhook",
        error: error.message,
        requestId: context.awsRequestId,
      }),
    };
  } finally {
    // Note: We don't close the MongoDB connection here to allow for connection reuse
    // Lambda will handle cleanup when the execution environment is destroyed
  }
});
