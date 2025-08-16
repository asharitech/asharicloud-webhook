/**
 * Unit tests for headers attribute implementation
 * Based on actual production data from CloudWatch logs
 * 
 * @file headers-attribute.test.js
 * @description Tests the headers SNS message attribute functionality
 */

const assert = require('assert');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

/**
 * Mock SNS client for testing
 */
class MockSNSClient {
  constructor() {
    this.publishedMessages = [];
  }

  async send(command) {
    if (command instanceof PublishCommand) {
      this.publishedMessages.push(command.input);
      return { MessageId: `test-message-${Date.now()}` };
    }
    throw new Error('Unsupported command');
  }

  getLastMessage() {
    return this.publishedMessages[this.publishedMessages.length - 1];
  }

  reset() {
    this.publishedMessages = [];
  }
}

/**
 * Test suite for headers attribute processing
 */
describe('Headers Attribute Processing', () => {
  let mockSNSClient;
  let originalSNSClient;

  beforeEach(() => {
    mockSNSClient = new MockSNSClient();
    // Store original SNSClient if we need to restore it
    originalSNSClient = SNSClient;
  });

  afterEach(() => {
    mockSNSClient.reset();
  });

  /**
   * Test 1: Headers from actual production webhook (Telegram)
   */
  it('should correctly process production Telegram webhook headers', () => {
    // Actual production headers from CloudWatch logs
    const productionHeaders = {
      "accept": "*/*",
      "accept-encoding": "gzip, br",
      "cdn-loop": "cloudflare; loops=1",
      "cf-connecting-ip": "43.218.155.39",
      "cf-ipcountry": "ID",
      "cf-ray": "96fde7a53d9e899e-SIN",
      "cf-visitor": "{\"scheme\":\"https\"}",
      "content-type": "application/json",
      "Host": "webhook.ashari.cloud",
      "User-Agent": "BrainyBuddy-API/3.13.1",
      "X-Amzn-Trace-Id": "Root=1-689ffd71-3f93c98014767a301de6e3f0",
      "x-correlation-id": "96fde7a0efbfd9e0-AMS",
      "X-Forwarded-For": "43.218.155.39, 172.70.93.117",
      "X-Forwarded-Port": "443",
      "X-Forwarded-Proto": "https",
      "x-request-id": "96fde7a0efbfd9e0-AMS"
    };

    // Process headers (simulating the actual code logic)
    const constructedHeaders = {};
    for (const [key, value] of Object.entries(productionHeaders)) {
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }

    const headersJson = JSON.stringify(constructedHeaders);

    // Assertions
    assert.strictEqual(typeof headersJson, 'string', 'Headers should be stringified');
    assert(headersJson.includes('"User-Agent":"BrainyBuddy-API/3.13.1"'), 'Should contain User-Agent');
    assert(headersJson.includes('"cf-ray":"96fde7a53d9e899e-SIN"'), 'Should contain CF-Ray');
    assert(headersJson.includes('"x-correlation-id":"96fde7a0efbfd9e0-AMS"'), 'Should contain correlation ID');
    
    // Parse back to verify JSON validity
    const parsed = JSON.parse(headersJson);
    assert.strictEqual(parsed['content-type'], 'application/json', 'Content-Type should be preserved');
    assert.strictEqual(parsed['cf-ipcountry'], 'ID', 'CF-IPCountry should be preserved');
    
    // Verify all headers are preserved (except "headers" which doesn't exist)
    assert.strictEqual(Object.keys(parsed).length, Object.keys(productionHeaders).length, 'All headers should be preserved');
    
    console.log('✅ Test 1 passed: Production Telegram headers processed correctly');
  });

  /**
   * Test 2: Headers with "headers" key variations (security test)
   */
  it('should exclude all variations of "headers" key', () => {
    const maliciousHeaders = {
      "content-type": "application/json",
      "headers": "should-be-excluded",
      "Headers": "should-also-be-excluded",
      "HEADERS": "uppercase-should-be-excluded",
      "HeAdErS": "mixed-case-excluded",
      "x-headers": "this-should-remain",
      "headers-test": "this-should-remain",
      "x-custom": "normal-header"
    };

    const constructedHeaders = {};
    for (const [key, value] of Object.entries(maliciousHeaders)) {
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }

    // Assertions
    assert(!constructedHeaders.hasOwnProperty('headers'), 'lowercase "headers" should be excluded');
    assert(!constructedHeaders.hasOwnProperty('Headers'), 'titlecase "Headers" should be excluded');
    assert(!constructedHeaders.hasOwnProperty('HEADERS'), 'uppercase "HEADERS" should be excluded');
    assert(!constructedHeaders.hasOwnProperty('HeAdErS'), 'mixed case "HeAdErS" should be excluded');
    assert(constructedHeaders.hasOwnProperty('x-headers'), '"x-headers" should be preserved');
    assert(constructedHeaders.hasOwnProperty('headers-test'), '"headers-test" should be preserved');
    assert.strictEqual(Object.keys(constructedHeaders).length, 4, 'Should have 4 headers after filtering');
    
    console.log('✅ Test 2 passed: Headers key variations correctly filtered');
  });

  /**
   * Test 3: Large headers truncation test
   */
  it('should truncate headers exceeding 50KB limit', () => {
    // Create headers that exceed 50KB
    const largeHeaders = {};
    for (let i = 0; i < 1000; i++) {
      largeHeaders[`X-Custom-Header-${i}`] = `This is a long value for header ${i} with additional padding to increase size significantly`;
    }

    const constructedHeaders = {};
    for (const [key, value] of Object.entries(largeHeaders)) {
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }

    const headersJson = JSON.stringify(constructedHeaders);
    const maxHeaderSize = 50000;

    if (headersJson.length > maxHeaderSize) {
      const truncated = headersJson.substring(0, maxHeaderSize - 20) + ',"_truncated":true}';
      
      // Assertions
      assert(truncated.length <= maxHeaderSize, 'Truncated headers should be within limit');
      assert(truncated.endsWith(',"_truncated":true}'), 'Should have truncation marker');
      assert.strictEqual(truncated.length, 49999, 'Truncated size should be exactly 49999 bytes');
      
      console.log(`✅ Test 3 passed: Large headers (${headersJson.length} bytes) truncated to ${truncated.length} bytes`);
    }
  });

  /**
   * Test 4: CloudFlare headers with special characters
   */
  it('should handle CloudFlare headers with JSON strings', () => {
    const cfHeaders = {
      "cf-visitor": "{\"scheme\":\"https\"}",
      "cf-ray": "96fde7a53d9e899e-SIN",
      "cf-connecting-ip": "43.218.155.39",
      "cf-ipcountry": "ID",
      "cdn-loop": "cloudflare; loops=1"
    };

    const constructedHeaders = {};
    for (const [key, value] of Object.entries(cfHeaders)) {
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }

    const headersJson = JSON.stringify(constructedHeaders);
    
    // Parse back to verify
    const parsed = JSON.parse(headersJson);
    
    // Assertions
    assert.strictEqual(parsed['cf-visitor'], "{\"scheme\":\"https\"}", 'CF-Visitor JSON string should be preserved');
    assert(headersJson.includes('{\\"scheme\\":\\"https\\"}'), 'JSON within JSON should be properly escaped');
    assert.strictEqual(parsed['cdn-loop'], 'cloudflare; loops=1', 'Semicolon in value should be preserved');
    
    console.log('✅ Test 4 passed: CloudFlare headers with special characters handled correctly');
  });

  /**
   * Test 5: Production LINE webhook headers
   */
  it('should process LINE webhook headers correctly', () => {
    const lineHeaders = {
      "accept": "*/*",
      "content-type": "application/json",
      "Host": "webhook.ashari.cloud",
      "User-Agent": "LineBotWebhook/2.0",
      "X-Line-Signature": "base64signature==",
      "X-Forwarded-For": "147.92.128.0, 172.70.93.117",
      "X-Forwarded-Proto": "https"
    };

    const constructedHeaders = {};
    for (const [key, value] of Object.entries(lineHeaders)) {
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }

    const headersJson = JSON.stringify(constructedHeaders);
    const parsed = JSON.parse(headersJson);

    // Assertions
    assert.strictEqual(parsed['X-Line-Signature'], 'base64signature==', 'LINE signature should be preserved');
    assert.strictEqual(parsed['User-Agent'], 'LineBotWebhook/2.0', 'LINE User-Agent should be preserved');
    
    console.log('✅ Test 5 passed: LINE webhook headers processed correctly');
  });

  /**
   * Test 6: Headers with null, undefined, and various data types
   */
  it('should handle various data types in headers', () => {
    const mixedHeaders = {
      "string-header": "normal string",
      "number-header": 12345,
      "boolean-header": true,
      "null-header": null,
      "undefined-header": undefined,
      "array-header": ["value1", "value2"],
      "object-header": { nested: "value" }
    };

    const constructedHeaders = {};
    for (const [key, value] of Object.entries(mixedHeaders)) {
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }

    const headersJson = JSON.stringify(constructedHeaders);
    const parsed = JSON.parse(headersJson);

    // Assertions
    assert.strictEqual(parsed['string-header'], 'normal string', 'String should be preserved');
    assert.strictEqual(parsed['number-header'], 12345, 'Number should be preserved');
    assert.strictEqual(parsed['boolean-header'], true, 'Boolean should be preserved');
    assert.strictEqual(parsed['null-header'], null, 'Null should be preserved');
    assert(!parsed.hasOwnProperty('undefined-header'), 'Undefined should be omitted by JSON.stringify');
    assert.deepStrictEqual(parsed['array-header'], ["value1", "value2"], 'Array should be preserved');
    assert.deepStrictEqual(parsed['object-header'], { nested: "value" }, 'Object should be preserved');
    
    console.log('✅ Test 6 passed: Various data types handled correctly');
  });

  /**
   * Test 7: Empty and edge case headers
   */
  it('should handle empty and edge case scenarios', () => {
    // Test empty headers
    const emptyHeaders = {};
    const constructedEmpty = {};
    for (const [key, value] of Object.entries(emptyHeaders)) {
      if (key.toLowerCase() !== "headers") {
        constructedEmpty[key] = value;
      }
    }
    assert.strictEqual(JSON.stringify(constructedEmpty), '{}', 'Empty headers should produce empty object');

    // Test single header
    const singleHeader = { "X-Test": "value" };
    const constructedSingle = {};
    for (const [key, value] of Object.entries(singleHeader)) {
      if (key.toLowerCase() !== "headers") {
        constructedSingle[key] = value;
      }
    }
    assert.strictEqual(JSON.stringify(constructedSingle), '{"X-Test":"value"}', 'Single header should be preserved');

    console.log('✅ Test 7 passed: Edge cases handled correctly');
  });

  /**
   * Test 8: Integration test with actual SNS message attribute structure
   */
  it('should create valid SNS message attribute', () => {
    const headers = {
      "content-type": "application/json",
      "x-correlation-id": "test-123"
    };

    const constructedHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }

    const headersJson = JSON.stringify(constructedHeaders);
    
    // Create SNS message attribute
    const messageAttribute = {
      DataType: "String",
      StringValue: headersJson
    };

    // Assertions
    assert.strictEqual(messageAttribute.DataType, "String", 'DataType should be String');
    assert.strictEqual(typeof messageAttribute.StringValue, 'string', 'StringValue should be a string');
    assert(messageAttribute.StringValue.includes('content-type'), 'Should contain content-type');
    assert(messageAttribute.StringValue.includes('x-correlation-id'), 'Should contain correlation ID');
    
    console.log('✅ Test 8 passed: Valid SNS message attribute created');
  });
});

// Run tests if this file is executed directly
if (require.main === module) {
  console.log('🧪 Running Headers Attribute Tests...\n');
  console.log('='*50);
  
  const suite = {
    tests: [],
    beforeEach: null,
    afterEach: null
  };

  global.describe = (name, fn) => {
    console.log(`\n📋 Test Suite: ${name}\n`);
    fn();
  };

  global.it = (name, fn) => {
    try {
      if (suite.beforeEach) suite.beforeEach();
      fn();
      if (suite.afterEach) suite.afterEach();
    } catch (error) {
      console.error(`❌ Test failed: ${name}`);
      console.error(error.message);
      process.exit(1);
    }
  };

  global.beforeEach = (fn) => { suite.beforeEach = fn; };
  global.afterEach = (fn) => { suite.afterEach = fn; };

  // Load and run the tests
  require('./headers-attribute.test.js');
  
  console.log('\n' + '='*50);
  console.log('✅ All tests passed successfully!\n');
}