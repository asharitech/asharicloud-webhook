/**
 * Header processing utilities
 * Handles header sanitization, JSON serialization, and SNS attribute formatting
 * 
 * @module HeadersUtil
 */

/**
 * Header processing utilities
 */
class HeadersUtil {
  /**
   * Safely construct headers object, excluding problematic keys
   * @param {Object} originalHeaders - Original HTTP headers
   * @returns {Object} Sanitized headers object
   */
  static sanitizeHeaders(originalHeaders) {
    if (!originalHeaders || typeof originalHeaders !== 'object') {
      return {};
    }

    const constructedHeaders = {};
    
    for (const [key, value] of Object.entries(originalHeaders)) {
      // Skip "headers" key (case-insensitive) to avoid potential circular references
      // This prevents issues if a malicious or malformed request includes a "headers" header
      if (key.toLowerCase() !== "headers") {
        constructedHeaders[key] = value;
      }
    }

    return constructedHeaders;
  }

  /**
   * Create SNS message attribute for headers
   * @param {Object} headers - HTTP headers to process
   * @param {number} maxSize - Maximum size in bytes (default: 50KB)
   * @returns {Object|null} SNS message attribute or null if headers are empty
   * 
   * @example
   * const headerAttribute = HeadersUtil.createHeadersAttribute({
   *   "Content-Type": "application/json",
   *   "User-Agent": "BrainyBuddy-API/3.13.1"
   * });
   * // Returns: { DataType: "String", StringValue: '{"Content-Type":"application/json","User-Agent":"BrainyBuddy-API/3.13.1"}' }
   */
  static createHeadersAttribute(headers, maxSize = 50000) {
    if (!headers || typeof headers !== 'object') {
      return null;
    }

    try {
      // Sanitize headers first
      const sanitizedHeaders = this.sanitizeHeaders(headers);
      
      // Check if we have any headers after sanitization
      if (Object.keys(sanitizedHeaders).length === 0) {
        return null;
      }

      const headersJson = JSON.stringify(sanitizedHeaders);
      
      // Check size constraints
      if (headersJson.length <= maxSize) {
        return {
          DataType: "String",
          StringValue: headersJson,
        };
      } else {
        // Truncate headers if too large and add truncation indicator
        const truncated = headersJson.substring(0, maxSize - 20) + ',"_truncated":true}';
        console.warn(`Headers truncated from ${headersJson.length} to ${truncated.length} bytes`);
        
        return {
          DataType: "String",
          StringValue: truncated,
        };
      }
    } catch (error) {
      console.error("Failed to create headers attribute:", error);
      return null;
    }
  }

  /**
   * Parse headers from SNS message attribute
   * @param {Object} messageAttribute - SNS message attribute containing headers
   * @returns {Object|null} Parsed headers object or null if invalid
   */
  static parseHeadersAttribute(messageAttribute) {
    if (!messageAttribute || 
        messageAttribute.DataType !== "String" || 
        !messageAttribute.StringValue) {
      return null;
    }

    try {
      const headers = JSON.parse(messageAttribute.StringValue);
      
      // Check if headers were truncated
      if (headers._truncated) {
        console.warn('Headers were truncated in the original message');
        delete headers._truncated; // Remove the truncation marker
      }
      
      return headers;
    } catch (error) {
      console.error("Failed to parse headers attribute:", error);
      return null;
    }
  }

  /**
   * Extract correlation and request IDs from headers (case-insensitive)
   * @param {Object} headers - HTTP headers
   * @returns {Object} Object containing correlationId and requestId
   */
  static extractTrackingIds(headers) {
    if (!headers || typeof headers !== 'object') {
      return {
        correlationId: require("crypto").randomUUID(),
        requestId: require("crypto").randomUUID()
      };
    }

    // Case-insensitive header lookup
    const getHeaderValue = (headerName) => {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === headerName.toLowerCase()) {
          return value;
        }
      }
      return null;
    };

    const correlationId = 
      getHeaderValue("x-correlation-id") ||
      getHeaderValue("correlation-id") ||
      require("crypto").randomUUID();

    const requestId = 
      getHeaderValue("x-request-id") ||
      getHeaderValue("request-id") ||
      require("crypto").randomUUID();

    return { correlationId, requestId };
  }

  /**
   * Validate headers for security concerns
   * @param {Object} headers - HTTP headers to validate
   * @returns {Object} Validation result with isValid and issues array
   */
  static validateHeaders(headers) {
    const issues = [];
    
    if (!headers || typeof headers !== 'object') {
      return { isValid: true, issues: [] };
    }

    // Check for suspicious headers
    const suspiciousPatterns = [
      { pattern: /script/i, message: "Script content detected in headers" },
      { pattern: /<[^>]*>/g, message: "HTML tags detected in headers" },
      { pattern: /javascript:/i, message: "JavaScript protocol detected in headers" }
    ];

    for (const [key, value] of Object.entries(headers)) {
      const headerValue = String(value);
      
      // Check for excessively long header values
      if (headerValue.length > 8192) { // 8KB per header value
        issues.push(`Header "${key}" exceeds maximum length (${headerValue.length} bytes)`);
      }
      
      // Check for suspicious content
      suspiciousPatterns.forEach(({ pattern, message }) => {
        if (pattern.test(headerValue) || pattern.test(key)) {
          issues.push(`${message} in header "${key}"`);
        }
      });
    }

    return {
      isValid: issues.length === 0,
      issues
    };
  }

  /**
   * Get size statistics for headers
   * @param {Object} headers - HTTP headers
   * @returns {Object} Size statistics
   */
  static getHeadersStats(headers) {
    if (!headers || typeof headers !== 'object') {
      return { totalSize: 0, headerCount: 0, averageSize: 0 };
    }

    const sanitized = this.sanitizeHeaders(headers);
    const jsonString = JSON.stringify(sanitized);
    const headerCount = Object.keys(sanitized).length;
    
    return {
      totalSize: jsonString.length,
      headerCount,
      averageSize: headerCount > 0 ? Math.round(jsonString.length / headerCount) : 0,
      wouldBeTruncated: jsonString.length > 50000
    };
  }
}

module.exports = HeadersUtil;