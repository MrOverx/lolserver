/**
 * Input Validation Middleware
 * Provides reusable validation functions for API requests
 * 
 * Usage:
 * const { validateAuth, validateUserId } = require('./middleware/validation');
 * app.post('/auth/validate-token', validateAuth, handler);
 */

const { Logger } = require('../utils/logger');
const { sendError } = require('../utils/responseHandler');

/**
 * Validate authentication request body
 * Required: idToken or (email + password)
 */
function validateAuth(req, res, next) {
  try {
    const { idToken, email, password } = req.body;

    if (!idToken && (!email || !password)) {
      return sendError(res, 400, 'Missing required authentication fields', 'VALIDATION_ERROR');
    }

    // Sanitize inputs
    req.body = {
      idToken: idToken ? String(idToken).trim() : null,
      email: email ? String(email).toLowerCase().trim() : null,
      password: password ? String(password) : null,
      googleUserData: req.body.googleUserData || null,
    };

    Logger.debug('validation', 'Auth request validated', { method: req.method, path: req.path });
    next();
  } catch (err) {
    Logger.error('validation/auth', 'Validation error', err.message);
    sendError(res, 400, 'Invalid request format', 'VALIDATION_ERROR');
  }
}

/**
 * Validate user registration request
 * Required: userId, userName, email
 */
function validateRegistration(req, res, next) {
  try {
    const { userId, userName, email, password } = req.body;

    if (!userId || !userName || !email) {
      return sendError(res, 400, 'Missing required fields: userId, userName, email', 'VALIDATION_ERROR');
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return sendError(res, 400, 'Invalid email format', 'VALIDATION_ERROR');
    }

    // Validate username length
    if (userName.length < 2 || userName.length > 50) {
      return sendError(res, 400, 'Username must be 2-50 characters', 'VALIDATION_ERROR');
    }

    // Sanitize inputs
    req.body = {
      userId: String(userId).trim(),
      userName: String(userName).trim(),
      email: String(email).toLowerCase().trim(),
      password: password ? String(password) : null,
      gender: req.body.gender || 'other',
      country: req.body.country || null,
      avatarColor: req.body.avatarColor || '#128C7E',
    };

    Logger.debug('validation', 'Registration request validated');
    next();
  } catch (err) {
    Logger.error('validation/registration', 'Validation error', err.message);
    sendError(res, 400, 'Invalid registration data', 'VALIDATION_ERROR');
  }
}

/**
 * Validate user profile update request
 * Optional: userName, gender, country, avatarColor, profileImageUrl
 */
function validateProfileUpdate(req, res, next) {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return sendError(res, 400, 'User ID is required', 'VALIDATION_ERROR');
    }

    // Validate optional fields
    const { userName, gender, country, avatarColor } = req.body;

    if (userName && (userName.length < 2 || userName.length > 50)) {
      return sendError(res, 400, 'Username must be 2-50 characters', 'VALIDATION_ERROR');
    }

    if (gender && !['male', 'female', 'other'].includes(gender.toLowerCase())) {
      return sendError(res, 400, 'Invalid gender value', 'VALIDATION_ERROR');
    }

    // Sanitize inputs
    req.body = {
      userId: String(userId).trim(),
      userName: userName ? String(userName).trim() : undefined,
      gender: gender ? String(gender).toLowerCase() : undefined,
      country: country ? String(country).trim() : undefined,
      avatarColor: avatarColor ? String(avatarColor) : undefined,
      profileImageUrl: req.body.profileImageUrl ? String(req.body.profileImageUrl) : undefined,
      profileImagePath: req.body.profileImagePath ? String(req.body.profileImagePath) : undefined,
      pictureName: req.body.pictureName ? String(req.body.pictureName) : undefined,
      birthDate: req.body.birthDate ? String(req.body.birthDate).trim() : undefined,
      email: req.body.email ? String(req.body.email).toLowerCase().trim() : undefined,
      authType: req.body.authType ? String(req.body.authType).trim() : undefined,
      isGuest: typeof req.body.isGuest === 'boolean' ? req.body.isGuest : undefined,
    };

    Logger.debug('validation', 'Profile update validated');
    next();
  } catch (err) {
    Logger.error('validation/profile', 'Validation error', err.message);
    sendError(res, 400, 'Invalid profile data', 'VALIDATION_ERROR');
  }
}

/**
 * Validate room creation request
 * Required: roomName, roomType
 */
function validateRoomCreate(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid room data' };
  }

  const { roomName, roomType } = data;

  if (!roomName || typeof roomName !== 'string' || roomName.trim().length === 0) {
    return { valid: false, error: 'Room name is required and must be non-empty' };
  }

  if (roomName.length > 100) {
    return { valid: false, error: 'Room name exceeds 100 characters' };
  }

  if (!['public', 'private'].includes(roomType)) {
    return { valid: false, error: 'Room type must be "public" or "private"' };
  }

  return { valid: true };
}

/**
 * Validate socket metadata
 * Required: userId, userName, avatarColor
 */
function validateSocketMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return { valid: false, error: 'Invalid metadata object' };
  }

  if (!metadata.userId || typeof metadata.userId !== 'string') {
    return { valid: false, error: 'userId is required and must be a string' };
  }

  if (!metadata.userName || typeof metadata.userName !== 'string') {
    return { valid: false, error: 'userName is required and must be a string' };
  }

  if (metadata.userName.length > 50) {
    return { valid: false, error: 'userName exceeds 50 characters' };
  }

  return { valid: true };
}

/**
 * Generic field length validator
 */
function validateFieldLength(field, minLength, maxLength) {
  if (typeof field !== 'string') {
    return { valid: false, error: `Field must be a string` };
  }

  if (field.length < minLength) {
    return { valid: false, error: `Field must be at least ${minLength} characters` };
  }

  if (field.length > maxLength) {
    return { valid: false, error: `Field exceeds ${maxLength} characters` };
  }

  return { valid: true };
}

module.exports = {
  // Middleware functions
  validateAuth,
  validateRegistration,
  validateProfileUpdate,
  // Validation functions
  validateRoomCreate,
  validateSocketMetadata,
  validateFieldLength,
};
