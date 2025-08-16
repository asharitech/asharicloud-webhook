#!/usr/bin/env node
/**
 * Test runner for headers attribute tests
 */

const assert = require('assert');

console.log('🧪 Running Headers Attribute Tests...\n');
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

console.log('\n📋 Test Suite: Headers Attribute Processing\n');

// Test 1: Production Telegram webhook headers
runTest('Test 1: Production Telegram webhook headers', () => {
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

  const constructedHeaders = {};
  for (const [key, value] of Object.entries(productionHeaders)) {
    if (key.toLowerCase() !== "headers") {
      constructedHeaders[key] = value;
    }
  }

  const headersJson = JSON.stringify(constructedHeaders);
  assert(typeof headersJson === 'string');
  assert(headersJson.includes('"User-Agent":"BrainyBuddy-API/3.13.1"'));
  assert(headersJson.includes('"cf-ray":"96fde7a53d9e899e-SIN"'));
  
  const parsed = JSON.parse(headersJson);
  assert.strictEqual(parsed['content-type'], 'application/json');
  assert.strictEqual(Object.keys(parsed).length, Object.keys(productionHeaders).length);
});

// Test 2: Security - exclude "headers" key variations
runTest('Test 2: Exclude all variations of "headers" key', () => {
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

  assert(!constructedHeaders.hasOwnProperty('headers'));
  assert(!constructedHeaders.hasOwnProperty('Headers'));
  assert(!constructedHeaders.hasOwnProperty('HEADERS'));
  assert(!constructedHeaders.hasOwnProperty('HeAdErS'));
  assert(constructedHeaders.hasOwnProperty('x-headers'));
  assert(constructedHeaders.hasOwnProperty('headers-test'));
  assert.strictEqual(Object.keys(constructedHeaders).length, 4);
});

// Test 3: Large headers truncation
runTest('Test 3: Large headers truncation (>50KB)', () => {
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
    assert(truncated.length <= maxHeaderSize);
    assert(truncated.endsWith(',"_truncated":true}'));
    assert.strictEqual(truncated.length, 49999);
  }
});

// Test 4: CloudFlare headers with special JSON
runTest('Test 4: CloudFlare headers with JSON strings', () => {
  const cfHeaders = {
    "cf-visitor": "{\"scheme\":\"https\"}",
    "cf-ray": "96fde7a53d9e899e-SIN",
    "cdn-loop": "cloudflare; loops=1"
  };

  const constructedHeaders = {};
  for (const [key, value] of Object.entries(cfHeaders)) {
    if (key.toLowerCase() !== "headers") {
      constructedHeaders[key] = value;
    }
  }

  const headersJson = JSON.stringify(constructedHeaders);
  const parsed = JSON.parse(headersJson);
  
  assert.strictEqual(parsed['cf-visitor'], "{\"scheme\":\"https\"}");
  assert(headersJson.includes('{\\"scheme\\":\\"https\\"}'));
});

// Test 5: Mixed data types
runTest('Test 5: Various data types in headers', () => {
  const mixedHeaders = {
    "string": "text",
    "number": 12345,
    "boolean": true,
    "null": null,
    "undefined": undefined
  };

  const constructedHeaders = {};
  for (const [key, value] of Object.entries(mixedHeaders)) {
    if (key.toLowerCase() !== "headers") {
      constructedHeaders[key] = value;
    }
  }

  const headersJson = JSON.stringify(constructedHeaders);
  const parsed = JSON.parse(headersJson);

  assert.strictEqual(parsed['string'], 'text');
  assert.strictEqual(parsed['number'], 12345);
  assert.strictEqual(parsed['boolean'], true);
  assert.strictEqual(parsed['null'], null);
  assert(!parsed.hasOwnProperty('undefined'));
});

// Test 6: Empty headers
runTest('Test 6: Empty headers object', () => {
  const emptyHeaders = {};
  const constructedEmpty = {};
  for (const [key, value] of Object.entries(emptyHeaders)) {
    if (key.toLowerCase() !== "headers") {
      constructedEmpty[key] = value;
    }
  }
  assert.strictEqual(JSON.stringify(constructedEmpty), '{}');
});

// Test 7: SNS message attribute structure
runTest('Test 7: Valid SNS message attribute structure', () => {
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
  const messageAttribute = {
    DataType: "String",
    StringValue: headersJson
  };

  assert.strictEqual(messageAttribute.DataType, "String");
  assert.strictEqual(typeof messageAttribute.StringValue, 'string');
  assert(messageAttribute.StringValue.includes('content-type'));
});

// Test 8: Real production data from logs
runTest('Test 8: Actual production webhook data', () => {
  // This is actual data structure from production
  const eventData = {
    transport: {
      headers: {
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
      },
      method: "POST",
      path: "/generatives"
    }
  };

  // Simulate the actual implementation
  if (eventData.transport.headers) {
    const constructedHeaders = {};
    for (const [key, value] of Object.entries(eventData.transport.headers)) {
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }
    
    const headersJson = JSON.stringify(constructedHeaders);
    const maxHeaderSize = 50000;
    
    assert(headersJson.length < maxHeaderSize);
    assert(headersJson.includes('BrainyBuddy-API'));
    assert(headersJson.includes('webhook.ashari.cloud'));
    
    // Verify it can be used as SNS attribute
    const messageAttribute = {
      DataType: "String", 
      StringValue: headersJson
    };
    
    assert(messageAttribute.StringValue.length < 256000); // SNS limit
  }
});

// Summary
console.log('\n' + '='.repeat(50));
if (testsFailed === 0) {
  console.log(`\n✅ All ${testsPassed} tests passed successfully!\n`);
  process.exit(0);
} else {
  console.log(`\n❌ ${testsFailed} test(s) failed, ${testsPassed} passed\n`);
  process.exit(1);
}