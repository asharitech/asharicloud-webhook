/**
 * Configuration module for webhook receiver
 * Centralizes all configuration and environment variables
 * 
 * @module Config
 */

/**
 * Application configuration
 */
class Config {
  constructor() {
    this.aws = {
      region: process.env.AWS_REGION || 'ap-southeast-3',
      snsTopicArn: process.env.SNS_TOPIC_ARN,
      mongodbUriParameter: process.env.MONGODB_URI_PARAMETER,
      dlqUrl: process.env.DLQ_URL,
      originalTopicArn: process.env.ORIGINAL_TOPIC_ARN,
      criticalFailureTopicArn: process.env.CRITICAL_FAILURE_TOPIC_ARN
    };

    this.datadog = {
      enabled: process.env.DD_TRACE_ENABLED === 'true',
      site: process.env.DD_SITE || 'us5.datadoghq.com',
      env: process.env.DD_ENV || 'prod',
      service: process.env.DD_SERVICE || 'webhook-receiver',
      version: process.env.DD_VERSION,
      logsInjection: process.env.DD_LOGS_INJECTION === 'true',
      captureLambdaPayload: process.env.DD_CAPTURE_LAMBDA_PAYLOAD === 'true'
    };

    this.logging = {
      level: process.env.LOG_LEVEL || 'INFO'
    };

    this.webhook = {
      allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
      maxHeaderSize: 50000, // 50KB conservative limit for SNS attributes
      maxRetries: 3,
      messageAgeHours: 24
    };

    this.environment = this._detectEnvironment();
    
    // Validate required configuration
    this._validate();
  }

  /**
   * Detect environment from Lambda function name
   * @private
   * @returns {string} Environment name (dev, prod, or unknown)
   */
  _detectEnvironment() {
    const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || '';
    if (functionName.includes('dev')) return 'dev';
    if (functionName.includes('prod')) return 'prod';
    return 'unknown';
  }

  /**
   * Validate required configuration
   * @private
   * @throws {Error} If required configuration is missing
   */
  _validate() {
    const required = [
      { key: 'AWS_REGION', value: this.aws.region },
      { key: 'MONGODB_URI_PARAMETER', value: this.aws.mongodbUriParameter }
    ];

    const missing = required.filter(config => !config.value);
    if (missing.length > 0) {
      const missingKeys = missing.map(config => config.key).join(', ');
      throw new Error(`Missing required configuration: ${missingKeys}`);
    }
  }

  /**
   * Get database name based on environment
   * @returns {string} Database name
   */
  getDatabaseName() {
    return `${this.environment}-webhook`;
  }

  /**
   * Check if SNS is configured
   * @returns {boolean} True if SNS topic ARN is configured
   */
  isSNSConfigured() {
    return Boolean(this.aws.snsTopicArn);
  }

  /**
   * Check if DLQ is configured
   * @returns {boolean} True if DLQ URL is configured
   */
  isDLQConfigured() {
    return Boolean(this.aws.dlqUrl);
  }

  /**
   * Check if critical failure notifications are configured
   * @returns {boolean} True if critical failure topic is configured
   */
  isCriticalFailureConfigured() {
    return Boolean(this.aws.criticalFailureTopicArn);
  }
}

// Singleton instance
let configInstance = null;

/**
 * Get configuration instance
 * @returns {Config} Configuration instance
 */
function getConfig() {
  if (!configInstance) {
    configInstance = new Config();
  }
  return configInstance;
}

/**
 * Reset configuration (for testing)
 */
function resetConfig() {
  configInstance = null;
}

module.exports = {
  getConfig,
  resetConfig,
  Config
};