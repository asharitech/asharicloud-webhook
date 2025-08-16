#!/usr/bin/env node
/**
 * Test suite for modular structure
 * Tests individual modules and their integration
 */

const assert = require('assert');
const { getConfig, resetConfig } = require('../src/config');
const SSMService = require('../src/services/ssm.service');
const SNSService = require('../src/services/sns.service');
const HeadersUtil = require('../src/utils/headers.util');

console.log('🧪 Testing Modular Structure...\n');
console.log('='.repeat(50));

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, testFn) {
  try {
    testFn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(`   Error: ${error.message}`);
    testsFailed++;
  }
}

// Test 1: Configuration Module
runTest('Config: Basic configuration loading', () => {
  // Reset config for clean test
  resetConfig();
  
  // Set required environment variables
  process.env.AWS_REGION = 'ap-southeast-3';
  process.env.MONGODB_URI_PARAMETER = '/test/mongodb-uri';
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'prod-webhook-receiver-handler';
  
  const config = getConfig();
  
  assert.strictEqual(config.aws.region, 'ap-southeast-3');
  assert.strictEqual(config.environment, 'prod');
  assert.strictEqual(config.getDatabaseName(), 'prod-webhook');
  assert.strictEqual(config.webhook.maxHeaderSize, 50000);
});

// Test 2: Configuration validation
runTest('Config: Validation with missing required fields', () => {
  resetConfig();
  
  // Remove required environment variable
  delete process.env.MONGODB_URI_PARAMETER;
  
  try {
    getConfig();
    assert.fail('Should have thrown validation error');
  } catch (error) {
    assert(error.message.includes('Missing required configuration'));
  }
  
  // Restore for other tests
  process.env.MONGODB_URI_PARAMETER = '/test/mongodb-uri';
});

// Test 3: Headers Utility - Sanitization
runTest('HeadersUtil: Header sanitization', () => {
  const maliciousHeaders = {
    "content-type": "application/json",
    "headers": "should-be-excluded",
    "Headers": "should-also-be-excluded",
    "HEADERS": "uppercase-should-be-excluded",
    "x-custom": "should-remain"
  };
  
  const sanitized = HeadersUtil.sanitizeHeaders(maliciousHeaders);
  
  assert(!sanitized.hasOwnProperty('headers'));
  assert(!sanitized.hasOwnProperty('Headers'));
  assert(!sanitized.hasOwnProperty('HEADERS'));
  assert(sanitized.hasOwnProperty('x-custom'));
  assert.strictEqual(sanitized['content-type'], 'application/json');
});

// Test 4: Headers Utility - SNS Attribute Creation
runTest('HeadersUtil: SNS attribute creation', () => {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Test/1.0",
    "X-Correlation-ID": "test-123"
  };
  
  const attribute = HeadersUtil.createHeadersAttribute(headers);
  
  assert.strictEqual(attribute.DataType, "String");
  assert(attribute.StringValue.includes('Content-Type'));
  assert(attribute.StringValue.includes('User-Agent'));
  
  // Verify it can be parsed back
  const parsed = JSON.parse(attribute.StringValue);
  assert.strictEqual(parsed['Content-Type'], 'application/json');
});

// Test 5: Headers Utility - Tracking ID Extraction
runTest('HeadersUtil: Tracking ID extraction', () => {
  const headers = {
    "X-Correlation-ID": "test-correlation-123",
    "X-Request-ID": "test-request-456",
    "Content-Type": "application/json"
  };
  
  const trackingIds = HeadersUtil.extractTrackingIds(headers);
  
  assert.strictEqual(trackingIds.correlationId, "test-correlation-123");
  assert.strictEqual(trackingIds.requestId, "test-request-456");
});

// Test 6: Headers Utility - Case Insensitive Tracking
runTest('HeadersUtil: Case insensitive tracking ID extraction', () => {
  const headers = {
    "x-correlation-id": "lowercase-correlation",
    "X-REQUEST-ID": "uppercase-request"
  };
  
  const trackingIds = HeadersUtil.extractTrackingIds(headers);
  
  assert.strictEqual(trackingIds.correlationId, "lowercase-correlation");
  assert.strictEqual(trackingIds.requestId, "uppercase-request");
});

// Test 7: Headers Utility - Large Headers Truncation
runTest('HeadersUtil: Large headers truncation', () => {
  const largeHeaders = {};
  for (let i = 0; i < 1000; i++) {
    largeHeaders[`X-Header-${i}`] = `Long value ${i} with padding to increase size`;
  }
  
  const attribute = HeadersUtil.createHeadersAttribute(largeHeaders, 1000); // Small limit for test
  
  assert.strictEqual(attribute.DataType, "String");
  assert(attribute.StringValue.includes('_truncated":true}'));
  assert(attribute.StringValue.length <= 1000);
});

// Test 8: Headers Utility - Security Validation
runTest('HeadersUtil: Security validation', () => {
  const suspiciousHeaders = {
    "X-Script": "<script>alert('xss')</script>",
    "X-Normal": "normal-value",
    "X-JS": "javascript:alert('bad')"
  };
  
  const validation = HeadersUtil.validateHeaders(suspiciousHeaders);
  
  assert.strictEqual(validation.isValid, false);
  assert(validation.issues.length > 0);
  assert(validation.issues.some(issue => issue.includes('HTML tags')));
  assert(validation.issues.some(issue => issue.includes('JavaScript protocol')));
});

// Test 9: SSM Service - Configuration
runTest('SSMService: Service configuration', () => {
  const config = getConfig();
  const ssmService = new SSMService(config.aws);
  
  assert(ssmService.ssmClient);
  assert(ssmService.cache instanceof Map);
  assert.strictEqual(ssmService.cacheTTL, 5 * 60 * 1000);
});

// Test 10: SSM Service - Cache Management
runTest('SSMService: Cache management', () => {
  const config = getConfig();
  const ssmService = new SSMService(config.aws);
  
  // Manually add cache entry
  ssmService.cache.set('test-param:true', {
    value: 'test-value',
    timestamp: Date.now()
  });
  
  const stats = ssmService.getCacheStats();
  assert.strictEqual(stats.totalEntries, 1);
  assert.strictEqual(stats.validEntries, 1);
  
  ssmService.clearCache('test-param');
  assert.strictEqual(ssmService.cache.size, 0);
});

// Test 11: SNS Service - Configuration and Validation
runTest('SNSService: Configuration and ARN validation', () => {
  const config = getConfig();
  const snsService = new SNSService(config.aws);
  
  assert(snsService.snsClient);
  assert.strictEqual(snsService.config, config.aws);
  
  // Test ARN validation
  assert(SNSService.validateTopicArn('arn:aws:sns:us-east-1:123456789012:test-topic'));
  assert(!SNSService.validateTopicArn('invalid-arn'));
  assert(!SNSService.validateTopicArn(''));
  assert(!SNSService.validateTopicArn(null));
});

// Test 12: SNS Service - Message Size Calculation
runTest('SNSService: Message size calculation', () => {
  const message = { test: 'data', timestamp: '2023-01-01T00:00:00Z' };
  const attributes = {
    environment: { DataType: "String", StringValue: "test" },
    method: { DataType: "String", StringValue: "POST" }
  };
  
  const size = SNSService.calculateMessageSize(message, attributes);
  
  assert(typeof size === 'number');
  assert(size > 0);
  
  const expectedMessageSize = JSON.stringify(message).length;
  const expectedAttributesSize = JSON.stringify(attributes).length;
  assert.strictEqual(size, expectedMessageSize + expectedAttributesSize);
});

// Test 13: Integration Test - Full Message Attribute Building
runTest('Integration: Full message attribute construction', () => {
  const eventData = {
    timestamp: '2023-01-01T00:00:00Z',
    transport: {
      method: 'POST',
      path: '/test',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Test/1.0',
        'X-Correlation-ID': 'test-123'
      }
    },
    type: 'application/json'
  };
  
  const config = getConfig();
  const snsService = new SNSService(config.aws);
  
  const trackingIds = HeadersUtil.extractTrackingIds(eventData.transport.headers);
  const messageAttributes = snsService._buildMessageAttributes(
    eventData,
    'test',
    trackingIds,
    'trace-123',
    'span-456'
  );
  
  // Verify all expected attributes
  assert(messageAttributes.environment);
  assert(messageAttributes.method);
  assert(messageAttributes.path);
  assert(messageAttributes.headers);
  assert(messageAttributes['x-datadog-trace-id']);
  assert(messageAttributes['x-datadog-parent-id']);
  
  // Verify headers attribute
  const headersAttr = messageAttributes.headers;
  assert.strictEqual(headersAttr.DataType, 'String');
  const parsedHeaders = JSON.parse(headersAttr.StringValue);
  assert.strictEqual(parsedHeaders['Content-Type'], 'application/json');
});

// Test 14: Edge Cases - Empty and Null Inputs
runTest('Edge Cases: Empty and null inputs', () => {
  // Test HeadersUtil with empty inputs
  assert.deepStrictEqual(HeadersUtil.sanitizeHeaders(null), {});
  assert.deepStrictEqual(HeadersUtil.sanitizeHeaders(undefined), {});
  assert.deepStrictEqual(HeadersUtil.sanitizeHeaders({}), {});
  
  // Test tracking ID extraction with empty headers
  const trackingIds = HeadersUtil.extractTrackingIds({});
  assert(typeof trackingIds.correlationId === 'string');
  assert(typeof trackingIds.requestId === 'string');
  
  // Test headers attribute with empty headers
  const attribute = HeadersUtil.createHeadersAttribute({});
  assert.strictEqual(attribute, null);
});

// Test 15: Production Data Structure Test
runTest('Production Data: Actual webhook structure', () => {
  // This mirrors the actual production data structure from CloudWatch logs
  const productionEventData = {
    timestamp: "2025-08-16T04:27:23.162Z",
    source: "https://webhook.ashari.cloud/v1/generatives",
    transport: {
      method: "POST",
      path: "/generatives",
      headers: {
        "accept": "*/*",
        "accept-encoding": "gzip, br",
        "cdn-loop": "cloudflare; loops=1",
        "cf-connecting-ip": "43.218.155.39",
        "cf-ipcountry": "ID",
        "cf-ray": "96fdba20cc21ce19-SIN",
        "cf-visitor": "{\"scheme\":\"https\"}",
        "content-type": "application/json",
        "Host": "webhook.ashari.cloud",
        "User-Agent": "BrainyBuddy-API/3.13.1",
        "X-Amzn-Trace-Id": "Root=1-689ff629-471fdf8b3872f5281f43710d",
        "x-correlation-id": "96fdb9e5dac225b4-AMS",
        "X-Forwarded-For": "43.218.155.39, 172.71.124.50",
        "X-Forwarded-Port": "443",
        "X-Forwarded-Proto": "https",
        "x-request-id": "96fdb9e5dac225b4-AMS"
      }
    },
    payload: {
      conversation: {
        "_id": "684523439ce2fab20d150f07",
        "platform": "telegram",
        "platform_id": "1702884193"
      }
    },
    type: "application/json",
    isBase64Encoded: false
  };
  
  // Test with modular approach
  const sanitizedHeaders = HeadersUtil.sanitizeHeaders(productionEventData.transport.headers);
  const trackingIds = HeadersUtil.extractTrackingIds(productionEventData.transport.headers);
  const headersAttribute = HeadersUtil.createHeadersAttribute(productionEventData.transport.headers);
  
  // Assertions
  assert(sanitizedHeaders['User-Agent'].includes('BrainyBuddy-API'));
  assert.strictEqual(trackingIds.correlationId, '96fdb9e5dac225b4-AMS');
  assert.strictEqual(trackingIds.requestId, '96fdb9e5dac225b4-AMS');
  assert(headersAttribute.StringValue.includes('webhook.ashari.cloud'));
  
  // Verify the parsed structure matches original
  const parsedHeaders = JSON.parse(headersAttribute.StringValue);
  assert.strictEqual(parsedHeaders['cf-ipcountry'], 'ID');
  assert.strictEqual(parsedHeaders['cf-ray'], '96fdba20cc21ce19-SIN');
});

// Summary
console.log('\n' + '='.repeat(50));
if (testsFailed === 0) {
  console.log(`\n✅ All ${testsPassed} modular structure tests passed successfully!\n`);
  
  console.log('🏗️ Modular Structure Benefits Verified:');
  console.log('   • Separation of concerns working correctly');
  console.log('   • Individual modules testable');
  console.log('   • Configuration centralized and validated');
  console.log('   • Headers utility handles all edge cases');
  console.log('   • SNS service properly modularized');
  console.log('   • Production data compatibility maintained');
  console.log('   • Security validations in place');
  
  process.exit(0);
} else {
  console.log(`\n❌ ${testsFailed} test(s) failed, ${testsPassed} passed\n`);
  process.exit(1);
}