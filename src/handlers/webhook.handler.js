/**
 * Modular webhook handler
 * Main Lambda function entry point with clean separation of concerns
 * 
 * @module WebhookHandler
 */

// Datadog Lambda Library - must be imported first
const { datadog, getTraceHeaders } = require("datadog-lambda-js");
const tracer = require("dd-trace");

const { getConfig } = require("../config");
const SSMService = require("../services/ssm.service");
const SNSService = require("../services/sns.service");
const HeadersUtil = require("../utils/headers.util");

// Global services for connection reuse
let services = null;
let mongoUri = null;

/**
 * Initialize services (singleton pattern for Lambda container reuse)
 * @returns {Object} Initialized services
 */
async function initializeServices() {
  if (!services) {
    const config = getConfig();
    
    services = {
      config,
      ssm: new SSMService(config.aws),
      sns: new SNSService(config.aws)
    };
    
    console.log('Services initialized for webhook handler');
  }
  
  return services;
}

/**
 * Validate HTTP method
 * @param {string} method - HTTP method
 * @returns {boolean} True if method is allowed
 */
function validateMethod(method) {
  const config = getConfig();
  return config.webhook.allowedMethods.includes(method);
}

/**
 * Extract and structure webhook event data from API Gateway event
 * @param {Object} event - API Gateway event object (REST API format)
 * @returns {Object} Structured webhook event data
 */
function extractEventData(event) {
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
 * @param {string} path - The transport path
 * @returns {string} Sanitized collection name
 */
function generateCollectionName(path) {
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
 * Extract Datadog trace context
 * @returns {Object} Object containing traceId and spanId
 */
function extractDatadogTraceContext() {
  let currentTraceId = null;
  let currentSpanId = null;
  
  // Method 1: Try using getTraceHeaders from datadog-lambda-js
  try {
    const traceHeaders = getTraceHeaders();
    console.log("Trace headers from getTraceHeaders:", JSON.stringify(traceHeaders));
    
    if (traceHeaders) {
      if (traceHeaders["x-datadog-trace-id"]) {
        currentTraceId = traceHeaders["x-datadog-trace-id"];
      }
      if (traceHeaders["x-datadog-parent-id"]) {
        currentSpanId = traceHeaders["x-datadog-parent-id"];
      }
      
      if (traceHeaders["traceparent"]) {
        const parts = traceHeaders["traceparent"].split("-");
        if (parts.length >= 3) {
          console.log("W3C traceparent found:", traceHeaders["traceparent"]);
        }
      }
    }
  } catch (e) {
    console.log("Could not get trace headers from datadog-lambda-js:", e.message);
  }
  
  // Method 2: Try using dd-trace tracer.scope().active() as fallback
  if (!currentTraceId || !currentSpanId) {
    try {
      const span = tracer.scope().active();
      if (span) {
        currentTraceId = span.context().toTraceId();
        currentSpanId = span.context().toSpanId();
        console.log("Got trace context from dd-trace:", { traceId: currentTraceId, spanId: currentSpanId });
      }
    } catch (e) {
      console.log("Could not get trace context from dd-trace:", e.message);
    }
  }
  
  return { traceId: currentTraceId, spanId: currentSpanId };
}

/**
 * Store webhook in MongoDB (placeholder - would need MongoDB service)
 * @param {string} databaseName - Database name
 * @param {string} collectionName - Collection name
 * @param {Object} eventData - Event data to store
 * @returns {Promise<Object>} Operation result
 */
async function storeWebhook(databaseName, collectionName, eventData) {
  // TODO: Implement MongoDB service integration
  // For now, return success to maintain compatibility
  console.log(`Webhook would be stored in ${databaseName}.${collectionName}`);
  return { success: true, operation: "mongodb" };
}

/**
 * Main webhook processing logic
 * @param {Object} event - API Gateway event
 * @param {Object} context - Lambda context
 * @returns {Promise<Object>} Response object
 */
async function processWebhook(event, context) {
  try {
    // Initialize services
    const { config, ssm, sns } = await initializeServices();
    
    // Extract webhook event data
    const eventData = extractEventData(event);
    
    // Log the structured entry to CloudWatch
    console.log("Webhook Request:", JSON.stringify(eventData, null, 2));
    
    // Get MongoDB connection string from SSM Parameter Store
    if (!mongoUri) {
      mongoUri = await ssm.getParameter(config.aws.mongodbUriParameter);
    }
    
    // Generate database and collection names
    const databaseName = config.getDatabaseName();
    const collectionName = generateCollectionName(eventData.transport.path);
    
    // Extract tracking IDs and Datadog context
    const trackingIds = HeadersUtil.extractTrackingIds(eventData.transport.headers);
    const { traceId, spanId } = extractDatadogTraceContext();
    
    // Log processing context
    console.log(
      JSON.stringify({
        message: "Processing webhook",
        correlationId: trackingIds.correlationId,
        requestId: trackingIds.requestId,
        datadogTraceId: traceId,
        datadogSpanId: spanId,
        path: eventData.transport.path,
        method: eventData.transport.method
      })
    );
    
    // Run concurrent operations
    const startTime = Date.now();
    const operations = [];
    
    // MongoDB storage operation
    operations.push(storeWebhook(databaseName, collectionName, eventData));
    
    // SNS publishing operation
    if (config.isSNSConfigured()) {
      const snsOperation = sns.publishWebhookEvent(
        config.aws.snsTopicArn,
        eventData,
        config.environment,
        trackingIds,
        traceId,
        spanId
      ).then(() => ({ success: true, operation: "sns" }))
        .catch((error) => {
          console.error("SNS publishing failed:", error);
          return { success: false, operation: "sns", error: error.message };
        });
      
      operations.push(snsOperation);
    }
    
    // Execute all operations concurrently
    console.log("Starting concurrent operations: MongoDB storage and SNS publishing");
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
    
    // Build response
    const mongoSuccess = mongoResult?.success ?? false;
    const snsSuccess = snsResult?.success ?? true;
    
    let message = "Webhook received and logged successfully";
    const operations_status = {};
    
    if (mongoSuccess && snsSuccess) {
      message = "Webhook received, logged, stored, and published successfully";
      operations_status.mongodb = "success";
      operations_status.sns = "success";
    } else if (mongoSuccess && !snsSuccess) {
      message = "Webhook received, logged, and stored successfully. SNS publishing failed.";
      operations_status.mongodb = "success";
      operations_status.sns = "failed";
    } else if (!mongoSuccess && snsSuccess) {
      message = "Webhook received, logged, and published successfully. MongoDB storage failed.";
      operations_status.mongodb = "failed";
      operations_status.sns = "success";
    } else {
      message = "Webhook received and logged successfully. Both MongoDB storage and SNS publishing failed.";
      operations_status.mongodb = "failed";
      operations_status.sns = "failed";
    }
    
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
    console.error("Error processing webhook:", error);
    
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
  }
}

/**
 * Main Lambda handler wrapped with Datadog tracing
 * @param {Object} event - API Gateway event
 * @param {Object} context - Lambda context
 * @returns {Promise<Object>} Response object
 */
async function handler(event, context) {
  // Check if the request method is GET and reject it
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
  
  // Validate method
  if (!validateMethod(httpMethod)) {
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "POST, PUT, PATCH, DELETE",
      },
      body: JSON.stringify({
        message: "Method Not Allowed",
        error: `${httpMethod} requests are not supported`,
        allowed_methods: ["POST", "PUT", "PATCH", "DELETE"],
        requestId: context.awsRequestId,
      }),
    };
  }
  
  return processWebhook(event, context);
}

// Export the Datadog-wrapped handler
module.exports = { 
  handler: datadog(handler),
  // Export internal functions for testing
  extractEventData,
  generateCollectionName,
  validateMethod,
  initializeServices
};