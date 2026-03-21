/**
 * Caching Utility
 * Simple in-memory cache with TTL support for reducing database queries
 * 
 * Usage:
 * const cache = require('./utils/cache');
 * cache.set('user:123', userData, 300); // 5 minutes
 * const user = cache.get('user:123');
 * cache.invalidate('user:123');
 */

const { Logger } = require('./logger');

class Cache {
  constructor() {
    this.store = new Map();
    this.timers = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
    };
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {any} Cached value or null
   */
  get(key) {
    if (this.store.has(key)) {
      this.stats.hits++;
      Logger.debug('cache', `Cache HIT: ${key}`);
      return this.store.get(key);
    }

    this.stats.misses++;
    Logger.debug('cache', `Cache MISS: ${key}`);
    return null;
  }

  /**
   * Set value in cache with optional TTL
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttlSeconds - Time to live in seconds (default: no expiry)
   */
  set(key, value, ttlSeconds = null) {
    // Clear existing timer if any
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }

    this.store.set(key, value);
    this.stats.sets++;

    if (ttlSeconds) {
      const timer = setTimeout(() => {
        this.invalidate(key);
      }, ttlSeconds * 1000);

      this.timers.set(key, timer);
      Logger.debug('cache', `Cached: ${key} (TTL: ${ttlSeconds}s)`);
    } else {
      Logger.debug('cache', `Cached: ${key} (no expiry)`);
    }
  }

  /**
   * Invalidate (delete) cache entry
   * @param {string} key - Cache key to delete
   */
  invalidate(key) {
    if (this.store.has(key)) {
      this.store.delete(key);

      if (this.timers.has(key)) {
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
      }

      this.stats.deletes++;
      Logger.debug('cache', `Invalidated: ${key}`);
    }
  }

  /**
   * Invalidate multiple cache entries by pattern
   * @param {string|RegExp} pattern - Key pattern to match
   */
  invalidatePattern(pattern) {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    let count = 0;

    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        this.invalidate(key);
        count++;
      }
    }

    Logger.debug('cache', `Invalidated ${count} entries matching pattern`, { pattern: pattern.toString() });
  }

  /**
   * Get or set cache value
   * Useful for lazy loading
   * @param {string} key - Cache key
   * @param {Function} loader - Async function to load value if not cached
   * @param {number} ttlSeconds - TTL for cached value
   */
  async getOrSet(key, loader, ttlSeconds = 300) {
    const cached = this.get(key);

    if (cached !== null) {
      return cached;
    }

    try {
      const value = await loader();
      this.set(key, value, ttlSeconds);
      return value;
    } catch (err) {
      Logger.error('cache', `Error loading value for ${key}`, err.message);
      throw err;
    }
  }

  /**
   * Clear all cache
   */
  clear() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }

    this.store.clear();
    this.timers.clear();
    this.stats = { hits: 0, misses: 0, sets: 0, deletes: 0 };

    Logger.info('cache', 'All cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(2)
      : '0.00';

    return {
      size: this.store.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      deletes: this.stats.deletes,
      hitRate: `${hitRate}%`,
    };
  }

  /**
   * Log cache statistics
   */
  logStats() {
    const stats = this.getStats();
    Logger.info('cache', 'Cache Statistics', stats);
  }

  /**
   * Get all keys (for debugging)
   */
  getAllKeys() {
    return Array.from(this.store.keys());
  }

  /**
   * Check if key exists
   */
  has(key) {
    return this.store.has(key);
  }

  /**
   * Get cache size
   */
  size() {
    return this.store.size;
  }
}

// Create singleton instance
const cache = new Cache();

/**
 * Expiration time constants
 */
const CACHE_TTL = {
  SHORT: 60, // 1 minute
  MEDIUM: 300, // 5 minutes
  LONG: 900, // 15 minutes
  VERY_LONG: 3600, // 1 hour
};

module.exports = cache;
module.exports.Cache = Cache;
module.exports.CACHE_TTL = CACHE_TTL;
