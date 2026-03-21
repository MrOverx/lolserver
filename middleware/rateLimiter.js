/**
 * Rate Limiting Middleware
 * Prevents API abuse and DDoS attacks
 * 
 * Usage:
 * const { createRateLimiter, globalRateLimit } = require('./middleware/rateLimiter');
 * app.use(globalRateLimit);
 * app.post('/auth/login', createRateLimiter('login', 5, 15 * 60), handler);
 */

const { Logger } = require('../utils/logger');
const { sendError } = require('../utils/responseHandler');

// Store for tracking request counts
// Format: { key: { count, resetTime } }
const requestLimits = new Map();

/**
 * Global rate limiter - 100 requests per minute per IP
 */
function globalRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const key = `global:${ip}`;
  const now = Date.now();
  const windowSize = 60 * 1000; // 1 minute
  const maxRequests = 100;

  let record = requestLimits.get(key);

  if (!record || now - record.resetTime > windowSize) {
    record = { count: 1, resetTime: now };
    requestLimits.set(key, record);
    next();
  } else if (record.count < maxRequests) {
    record.count++;
    next();
  } else {
    Logger.warn('rateLimit', 'Global rate limit exceeded', {
      ip,
      count: record.count,
      limit: maxRequests,
    });
    sendError(res, 429, 'Too many requests. Please try again later.', 'RATE_LIMIT_EXCEEDED');
  }
}

/**
 * Create endpoint-specific rate limiter
 * @param {string} name - Identifier for this limit (e.g., 'login', 'register')
 * @param {number} maxRequests - Maximum requests allowed
 * @param {number} windowSizeSeconds - Time window in seconds
 * @returns {Function} Middleware function
 */
function createRateLimiter(name, maxRequests, windowSizeSeconds = 1800) {
  const windowSize = windowSizeSeconds * 1000;

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const userId = req.body?.userId || req.params?.userId || 'anonymous';
    // Use both IP and userId for more granular limiting
    const key = `${name}:${ip}:${userId}`;
    const now = Date.now();

    let record = requestLimits.get(key);

    if (!record || now - record.resetTime > windowSize) {
      // Reset counter
      record = { count: 1, resetTime: now };
      requestLimits.set(key, record);
      next();
    } else if (record.count < maxRequests) {
      record.count++;
      next();
    } else {
      const resetTime = new Date(record.resetTime + windowSize).toISOString();
      Logger.warn('rateLimit', `Rate limit exceeded for ${name}`, {
        ip,
        userId,
        count: record.count,
        limit: maxRequests,
        resetTime,
      });
      sendError(
        res,
        429,
        `Too many ${name} attempts. Reset at ${resetTime}`,
        'RATE_LIMIT_EXCEEDED'
      );
    }
  };
}

/**
 * Clean up expired rate limit records periodically
 * Call this once on server startup
 */
function startCleanupInterval() {
  setInterval(() => {
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours

    for (const [key, record] of requestLimits.entries()) {
      if (now - record.resetTime > maxAge) {
        requestLimits.delete(key);
      }
    }

    const size = requestLimits.size;
    Logger.debug('rateLimit', `Cleaned up expired records. Current size: ${size}`);
  }, 15 * 60 * 1000); // Run every 15 minutes
}

/**
 * Get current rate limit status for a key
 */
function getRateLimitStatus(name, ip, userId = 'anonymous') {
  const key = `${name}:${ip}:${userId}`;
  const record = requestLimits.get(key);
  
  return {
    limited: false,
    currentCount: record?.count || 0,
    resetTime: record?.resetTime || null,
  };
}

/**
 * Reset rate limit for a specific key
 */
function resetRateLimit(name, ip, userId = 'anonymous') {
  const key = `${name}:${ip}:${userId}`;
  requestLimits.delete(key);
  Logger.info('rateLimit', `Rate limit reset for ${name}`, { userId });
}

/**
 * Reset all rate limits
 */
function resetAllRateLimits() {
  requestLimits.clear();
  Logger.info('rateLimit', 'All rate limits reset');
}

module.exports = {
  globalRateLimit,
  createRateLimiter,
  startCleanupInterval,
  getRateLimitStatus,
  resetRateLimit,
  resetAllRateLimits,
};
