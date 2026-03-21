/**
 * Error Handling Middleware
 * Centralized error handling for all routes
 * 
 * Usage:
 * app.use(errorHandler);
 */

const { Logger } = require('../utils/logger');
const { sendError } = require('../utils/responseHandler');

/**
 * Custom application error class
 */
class AppError extends Error {
  constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.name = 'AppError';
  }
}

/**
 * Validation error class
 */
class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

/**
 * Not found error class
 */
class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND', null);
    this.name = 'NotFoundError';
  }
}

/**
 * Unauthorized error class
 */
class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized access') {
    super(message, 401, 'UNAUTHORIZED', null);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Forbidden error class
 */
class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden') {
    super(message, 403, 'FORBIDDEN', null);
    this.name = 'ForbiddenError';
  }
}

/**
 * Main error handling middleware
 * Pass it to app.use() AFTER all other route handlers
 */
function errorHandler(err, req, res, next) {
  let statusCode = 500;
  let errorCode = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details = null;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    errorCode = err.errorCode;
    message = err.message;
    details = err.details;
  } else if (err instanceof SyntaxError && 'body' in err) {
    // JSON parsing error
    statusCode = 400;
    errorCode = 'INVALID_JSON';
    message = 'Invalid JSON in request body';
  } else if (err.name === 'MongooseError') {
    // Database errors
    statusCode = 500;
    errorCode = 'DATABASE_ERROR';
    message = 'Database operation failed';
    details = process.env.NODE_ENV === 'development' ? err.message : null;
  } else if (err.name === 'CastError') {
    // MongoDB cast errors
    statusCode = 400;
    errorCode = 'INVALID_ID';
    message = 'Invalid ID format';
  } else {
    // Unknown error
    message = err.message || message;
  }

  // Log the error with appropriate level
  if (statusCode >= 500) {
    Logger.error('errorHandler', message, {
      errorCode,
      path: req.path,
      method: req.method,
      ip: req.ip,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  } else {
    Logger.warn('errorHandler', message, {
      errorCode,
      path: req.path,
      method: req.method,
      statusCode,
    });
  }

  // Send error response
  return sendError(res, statusCode, message, errorCode, details);
}

/**
 * Async route wrapper to catch async errors
 * Wrap async route handlers with this to catch errors and pass to errorHandler
 * 
 * Usage:
 * app.get('/user/:id', asyncHandler(async (req, res) => {
 *   const user = await User.findById(req.params.id);
 *   res.json(user);
 * }));
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 handler - must be last middleware
 */
function notFoundHandler(req, res, next) {
  const error = new NotFoundError(`Route ${req.method} ${req.path}`);
  errorHandler(error, req, res, next);
}

module.exports = {
  // Middleware
  errorHandler,
  notFoundHandler,
  asyncHandler,
  // Error classes
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
};
