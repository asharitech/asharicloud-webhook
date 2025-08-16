/**
 * AWS Systems Manager Parameter Store service
 * Handles secure parameter retrieval and caching
 * 
 * @module SSMService
 */

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

/**
 * SSM Parameter Store service with caching
 */
class SSMService {
  /**
   * Initialize SSM service
   * @param {Object} config - Configuration object
   * @param {string} config.region - AWS region
   */
  constructor(config) {
    this.ssmClient = new SSMClient({ region: config.region });
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes cache
  }

  /**
   * Retrieve a parameter from SSM Parameter Store with caching
   * @param {string} parameterName - The name of the parameter to retrieve
   * @param {boolean} withDecryption - Whether to decrypt SecureString parameters
   * @param {boolean} useCache - Whether to use cached value if available
   * @returns {Promise<string>} The parameter value
   * @throws {Error} If parameter retrieval fails
   */
  async getParameter(parameterName, withDecryption = true, useCache = true) {
    const cacheKey = `${parameterName}:${withDecryption}`;
    
    // Check cache first
    if (useCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        console.log(`SSM parameter ${parameterName} retrieved from cache`);
        return cached.value;
      }
      // Remove expired cache entry
      this.cache.delete(cacheKey);
    }

    try {
      const command = new GetParameterCommand({
        Name: parameterName,
        WithDecryption: withDecryption,
      });

      console.log(`Retrieving SSM parameter: ${parameterName}`);
      const response = await this.ssmClient.send(command);
      const value = response.Parameter.Value;

      // Cache the result
      if (useCache) {
        this.cache.set(cacheKey, {
          value,
          timestamp: Date.now()
        });
      }

      return value;
    } catch (error) {
      console.error(
        `Failed to retrieve SSM parameter ${parameterName}:`,
        error
      );
      throw new Error(`SSM parameter retrieval failed: ${error.message}`);
    }
  }

  /**
   * Clear parameter cache
   * @param {string} [parameterName] - Specific parameter to clear, or all if not specified
   */
  clearCache(parameterName = null) {
    if (parameterName) {
      // Clear specific parameter (both encrypted and non-encrypted versions)
      const keysToDelete = Array.from(this.cache.keys())
        .filter(key => key.startsWith(`${parameterName}:`));
      keysToDelete.forEach(key => this.cache.delete(key));
      console.log(`Cleared cache for parameter: ${parameterName}`);
    } else {
      // Clear all cache
      this.cache.clear();
      console.log('Cleared all SSM parameter cache');
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    const now = Date.now();
    const entries = Array.from(this.cache.values());
    const expired = entries.filter(entry => now - entry.timestamp >= this.cacheTTL).length;
    
    return {
      totalEntries: this.cache.size,
      expiredEntries: expired,
      validEntries: this.cache.size - expired,
      cacheTTLMs: this.cacheTTL
    };
  }
}

module.exports = SSMService;