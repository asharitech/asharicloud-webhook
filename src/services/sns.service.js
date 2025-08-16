/**
 * AWS SNS service for webhook event publishing
 * Handles SNS message publishing with enhanced attributes including headers
 * 
 * @module SNSService
 */

const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const HeadersUtil = require("../utils/headers.util");

/**
 * SNS service for publishing webhook events
 */
class SNSService {
  /**
   * Initialize SNS service
   * @param {Object} config - Configuration object
   * @param {string} config.region - AWS region
   */
  constructor(config) {
    this.snsClient = new SNSClient({ region: config.region });
    this.config = config;
  }

  /**
   * Publish webhook event to SNS topic with enhanced message attributes
   * @param {string} topicArn - SNS topic ARN
   * @param {Object} eventData - The webhook event data to publish
   * @param {Object} eventData.transport - Transport information including headers
   * @param {Object} eventData.transport.headers - HTTP headers from the original request
   * @param {string} eventData.transport.method - HTTP method (POST, PUT, PATCH, DELETE)
   * @param {string} eventData.transport.path - Request path
   * @param {*} eventData.payload - The webhook payload
   * @param {string} eventData.type - Content type of the payload
   * @param {string} environment - Environment name (dev, prod, etc.)
   * @param {Object} trackingIds - Object containing correlationId and requestId
   * @param {string} [trackingIds.correlationId] - Correlation ID for distributed tracing
   * @param {string} [trackingIds.requestId] - Request ID for request tracking
   * @param {string|null} datadogTraceId - Datadog trace ID for APM
   * @param {string|null} datadogParentId - Datadog parent span ID for APM
   * @returns {Promise<Object>} SNS publish result with MessageId
   * @throws {Error} Throws error if SNS publish fails
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
      // Build the message payload
      const message = this._buildMessage(eventData, environment);
      
      // Build message attributes
      const messageAttributes = this._buildMessageAttributes(
        eventData,
        environment,
        trackingIds,
        datadogTraceId,
        datadogParentId
      );

      // Publish to SNS
      const command = new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(message),
        Subject: `Webhook Event - ${eventData.transport.method} ${eventData.transport.path}`,
        MessageAttributes: messageAttributes,
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

  /**
   * Build the SNS message payload
   * @private
   * @param {Object} eventData - Webhook event data
   * @param {string} environment - Environment name
   * @returns {Object} Message payload
   */
  _buildMessage(eventData, environment) {
    return {
      environment: environment,
      timestamp: eventData.timestamp,
      source: eventData.source,
      transport: eventData.transport,
      payload: eventData.payload,
      type: eventData.type,
      isBase64Encoded: eventData.isBase64Encoded,
    };
  }

  /**
   * Build SNS message attributes with headers
   * @private
   * @param {Object} eventData - Webhook event data
   * @param {string} environment - Environment name
   * @param {Object} trackingIds - Tracking IDs
   * @param {string|null} datadogTraceId - Datadog trace ID
   * @param {string|null} datadogParentId - Datadog parent span ID
   * @returns {Object} Message attributes
   */
  _buildMessageAttributes(eventData, environment, trackingIds, datadogTraceId, datadogParentId) {
    // Base message attributes
    const messageAttributes = {
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
        StringValue: trackingIds.correlationId || require("crypto").randomUUID(),
      },
      "x-request-id": {
        DataType: "String",
        StringValue: trackingIds.requestId || require("crypto").randomUUID(),
      },
      "content-type": {
        DataType: "String",
        StringValue: "application/json",
      },
    };

    // Add headers attribute
    this._addHeadersAttribute(messageAttributes, eventData.transport.headers);

    // Add Datadog attributes
    this._addDatadogAttributes(messageAttributes, datadogTraceId, datadogParentId);

    return messageAttributes;
  }

  /**
   * Add headers as SNS message attribute
   * @private
   * @param {Object} messageAttributes - Message attributes object to modify
   * @param {Object} headers - HTTP headers
   */
  _addHeadersAttribute(messageAttributes, headers) {
    if (!headers) return;

    const headersAttribute = HeadersUtil.createHeadersAttribute(headers, this.config.maxHeaderSize);
    if (headersAttribute) {
      messageAttributes["headers"] = headersAttribute;
    }
  }

  /**
   * Add Datadog tracing attributes
   * @private
   * @param {Object} messageAttributes - Message attributes object to modify
   * @param {string|null} datadogTraceId - Datadog trace ID
   * @param {string|null} datadogParentId - Datadog parent span ID
   */
  _addDatadogAttributes(messageAttributes, datadogTraceId, datadogParentId) {
    if (datadogTraceId) {
      messageAttributes["x-datadog-trace-id"] = {
        DataType: "String",
        StringValue: datadogTraceId,
      };
    }

    if (datadogParentId) {
      messageAttributes["x-datadog-parent-id"] = {
        DataType: "String",
        StringValue: datadogParentId,
      };
    }
  }

  /**
   * Validate SNS topic ARN format
   * @param {string} topicArn - SNS topic ARN to validate
   * @returns {boolean} True if valid ARN format
   */
  static validateTopicArn(topicArn) {
    if (!topicArn || typeof topicArn !== 'string') return false;
    return /^arn:aws:sns:[a-z0-9-]+:\d+:[a-zA-Z0-9_-]+$/.test(topicArn);
  }

  /**
   * Calculate approximate message size
   * @param {Object} message - Message payload
   * @param {Object} messageAttributes - Message attributes
   * @returns {number} Approximate size in bytes
   */
  static calculateMessageSize(message, messageAttributes) {
    return JSON.stringify(message).length + JSON.stringify(messageAttributes).length;
  }
}

module.exports = SNSService;