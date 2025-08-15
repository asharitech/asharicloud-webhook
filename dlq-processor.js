/**
 * Lambda function to process messages from SNS Dead Letter Queue
 *
 * This function handles failed SNS deliveries by:
 * 1. Analyzing the failure reason
 * 2. Logging detailed error information
 * 3. Optionally retrying the delivery
 * 4. Sending notifications about critical failures
 */

// Datadog Lambda Library - must be imported first
const { datadog } = require("datadog-lambda-js");

const {
  SQSClient,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} = require("@aws-sdk/client-sqs");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const {
  CloudWatchClient,
  PutMetricDataCommand,
} = require("@aws-sdk/client-cloudwatch");

const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const cloudwatchClient = new CloudWatchClient({
  region: process.env.AWS_REGION,
});

/**
 * Process a single DLQ message
 * @param {Object} record - SQS record from the event
 * @returns {Promise<Object>} Processing result
 */
async function processDLQMessage(record) {
  try {
    const messageBody = JSON.parse(record.body);
    const messageAttributes = record.messageAttributes || {};

    // Extract failure information
    const failureInfo = {
      messageId: record.messageId,
      receiveCount: record.attributes?.ApproximateReceiveCount || 1,
      firstReceiveTimestamp:
        record.attributes?.ApproximateFirstReceiveTimestamp,
      sentTimestamp: record.attributes?.SentTimestamp,
      originalTopicArn: messageAttributes.TopicArn?.stringValue,
      failureReason: messageAttributes.FailureReason?.stringValue || "Unknown",
      subscriberEndpoint: messageAttributes.Endpoint?.stringValue,
      protocol: messageAttributes.Protocol?.stringValue,
    };

    console.log(
      "Processing DLQ message:",
      JSON.stringify(failureInfo, null, 2)
    );

    // Parse the original webhook event
    let webhookEvent;
    try {
      webhookEvent = JSON.parse(messageBody.Message || messageBody);
    } catch (e) {
      webhookEvent = messageBody.Message || messageBody;
    }

    // Analyze failure patterns
    const analysis = analyzeFailure(failureInfo, webhookEvent);

    // Send custom metrics
    await sendMetrics(failureInfo, analysis);

    // Determine if we should retry
    if (analysis.shouldRetry && failureInfo.receiveCount < 3) {
      console.log("Attempting to retry message delivery");
      await retryDelivery(webhookEvent, failureInfo);
    } else {
      console.log("Message will not be retried", {
        shouldRetry: analysis.shouldRetry,
        receiveCount: failureInfo.receiveCount,
      });

      // Send critical failure notification if configured
      if (process.env.CRITICAL_FAILURE_TOPIC_ARN && analysis.isCritical) {
        await sendCriticalFailureNotification(
          failureInfo,
          webhookEvent,
          analysis
        );
      }
    }

    // Store failure details for analysis (could be sent to S3, DynamoDB, etc.)
    await storeFailureDetails(failureInfo, webhookEvent, analysis);

    return {
      status: "processed",
      messageId: record.messageId,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Error processing DLQ message:", error);
    throw error;
  }
}

/**
 * Analyze failure to determine retry strategy
 * @param {Object} failureInfo - Information about the failure
 * @param {Object} webhookEvent - The original webhook event
 * @returns {Object} Analysis results
 */
function analyzeFailure(failureInfo, webhookEvent) {
  const analysis = {
    shouldRetry: false,
    isCritical: false,
    failureType: "unknown",
    recommendations: [],
  };

  // Check failure patterns
  if (failureInfo.failureReason?.includes("timeout")) {
    analysis.failureType = "timeout";
    analysis.shouldRetry = true;
    analysis.recommendations.push("Consider increasing timeout for subscriber");
  } else if (failureInfo.failureReason?.includes("5")) {
    analysis.failureType = "server_error";
    analysis.shouldRetry = true;
    analysis.recommendations.push("Subscriber experiencing server errors");
  } else if (failureInfo.failureReason?.includes("4")) {
    analysis.failureType = "client_error";
    analysis.shouldRetry = false;
    analysis.recommendations.push(
      "Check subscriber configuration or webhook payload"
    );
  }

  // Check if it's a critical webhook (e.g., payment, security)
  if (
    webhookEvent.path?.includes("/payment") ||
    webhookEvent.path?.includes("/security") ||
    webhookEvent.path?.includes("/critical")
  ) {
    analysis.isCritical = true;
  }

  // Age-based analysis
  const messageAgeMs = Date.now() - parseInt(failureInfo.sentTimestamp);
  const messageAgeHours = messageAgeMs / (1000 * 60 * 60);

  if (messageAgeHours > 24) {
    analysis.shouldRetry = false;
    analysis.recommendations.push("Message too old for retry");
  }

  return analysis;
}

/**
 * Send custom metrics to CloudWatch
 * @param {Object} failureInfo - Information about the failure
 * @param {Object} analysis - Analysis results
 */
async function sendMetrics(failureInfo, analysis) {
  try {
    const params = {
      Namespace: "WebhookReceiver/DLQ",
      MetricData: [
        {
          MetricName: "ProcessedMessages",
          Value: 1,
          Unit: "Count",
          Dimensions: [
            {
              Name: "Protocol",
              Value: failureInfo.protocol || "unknown",
            },
            {
              Name: "FailureType",
              Value: analysis.failureType,
            },
          ],
        },
      ],
    };

    if (analysis.isCritical) {
      params.MetricData.push({
        MetricName: "CriticalFailures",
        Value: 1,
        Unit: "Count",
        Dimensions: [
          {
            Name: "Protocol",
            Value: failureInfo.protocol || "unknown",
          },
        ],
      });
    }

    await cloudwatchClient.send(new PutMetricDataCommand(params));
  } catch (error) {
    console.error("Error sending metrics:", error);
  }
}

/**
 * Retry delivery of the webhook event
 * @param {Object} webhookEvent - The original webhook event
 * @param {Object} failureInfo - Information about the failure
 */
async function retryDelivery(webhookEvent, failureInfo) {
  // For HTTP/HTTPS endpoints, we could implement a direct HTTP retry
  // For now, we'll republish to the original SNS topic with retry metadata

  if (failureInfo.originalTopicArn) {
    const retryMessage = {
      ...webhookEvent,
      _retry: {
        attempt: failureInfo.receiveCount,
        originalMessageId: failureInfo.messageId,
        originalFailure: failureInfo.failureReason,
        retryTimestamp: new Date().toISOString(),
      },
    };

    const command = new PublishCommand({
      TopicArn: failureInfo.originalTopicArn,
      Message: JSON.stringify(retryMessage),
      MessageAttributes: {
        ...webhookEvent.MessageAttributes,
        RetryAttempt: {
          DataType: "Number",
          StringValue: failureInfo.receiveCount.toString(),
        },
      },
    });

    await snsClient.send(command);
    console.log("Message republished for retry");
  }
}

/**
 * Send notification about critical failures
 * @param {Object} failureInfo - Information about the failure
 * @param {Object} webhookEvent - The original webhook event
 * @param {Object} analysis - Analysis results
 */
async function sendCriticalFailureNotification(
  failureInfo,
  webhookEvent,
  analysis
) {
  const notification = {
    level: "CRITICAL",
    service: "webhook-receiver",
    environment: process.env.ENVIRONMENT || "unknown",
    failure: {
      messageId: failureInfo.messageId,
      endpoint: failureInfo.subscriberEndpoint,
      protocol: failureInfo.protocol,
      reason: failureInfo.failureReason,
      receiveCount: failureInfo.receiveCount,
    },
    webhookEvent: {
      path: webhookEvent.path,
      method: webhookEvent.method,
      timestamp: webhookEvent.timestamp,
    },
    analysis: analysis,
    timestamp: new Date().toISOString(),
  };

  const command = new PublishCommand({
    TopicArn: process.env.CRITICAL_FAILURE_TOPIC_ARN,
    Subject: `Critical Webhook Failure - ${analysis.failureType}`,
    Message: JSON.stringify(notification, null, 2),
  });

  await snsClient.send(command);
}

/**
 * Store failure details for later analysis
 * @param {Object} failureInfo - Information about the failure
 * @param {Object} webhookEvent - The original webhook event
 * @param {Object} analysis - Analysis results
 */
async function storeFailureDetails(failureInfo, webhookEvent, analysis) {
  // This could be extended to store in S3, DynamoDB, or other storage
  // For now, we'll just log comprehensive details

  const failureRecord = {
    timestamp: new Date().toISOString(),
    messageId: failureInfo.messageId,
    failure: failureInfo,
    webhookEvent: webhookEvent,
    analysis: analysis,
    environment: process.env.ENVIRONMENT || "unknown",
  };

  console.log("Failure details:", JSON.stringify(failureRecord, null, 2));

  // TODO: Implement storage to S3 or DynamoDB for long-term analysis
}

/**
 * Lambda handler wrapped with Datadog tracing
 * @param {Object} event - SQS event containing DLQ messages
 * @param {Object} context - Lambda context
 */
exports.handler = datadog(async (event, context) => {
  console.log("DLQ Processor started", {
    messageCount: event.Records?.length || 0,
    requestId: context.awsRequestId,
  });

  const results = [];

  for (const record of event.Records || []) {
    try {
      const result = await processDLQMessage(record);
      results.push(result);

      // Delete message from DLQ after successful processing
      if (process.env.DLQ_URL) {
        const deleteCommand = new DeleteMessageCommand({
          QueueUrl: process.env.DLQ_URL,
          ReceiptHandle: record.receiptHandle,
        });
        await sqsClient.send(deleteCommand);
      }
    } catch (error) {
      console.error("Failed to process message:", error);
      results.push({
        status: "failed",
        messageId: record.messageId,
        error: error.message,
      });
      // Don't delete the message, let it stay in DLQ
    }
  }

  const summary = {
    processed: results.filter((r) => r.status === "processed").length,
    failed: results.filter((r) => r.status === "failed").length,
    total: results.length,
  };

  console.log("DLQ Processing complete", summary);

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "DLQ processing complete",
      summary: summary,
      results: results,
    }),
  };
});
