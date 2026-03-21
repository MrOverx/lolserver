/**
 * Centralized Response Handler
 * Reduces code duplication for API responses across all endpoints
 */

/**
 * Build standardized error response
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string|object} errorCode - Error code or details object
 * @returns {object} Formatted error response
 */
function sendError(res, statusCode, message, errorCode = null) {
  const response = { success: false, error: message };
  if (errorCode) {
    if (typeof errorCode === 'string') {
      response.code = errorCode;
    } else {
      Object.assign(response, errorCode);
    }
  }
  return res.status(statusCode).json(response);
}

/**
 * Build standardized success response
 * @param {object} res - Express response object
 * @param {object} data - Response data
 * @param {string} message - Success message (optional)
 * @returns {void}
 */
function sendSuccess(res, data, message = 'Success') {
  const response = { success: true, message };
  if (data) Object.assign(response, data);
  return res.json(response);
}

/**
 * Serialize user object with consistent fields
 * Prevents duplication of user object structure across responses
 * @param {object} user - Mongoose user document
 * @param {array} includeFields - Fields to include (null = all basic fields)
 * @returns {object} Serialized user object
 */
function serializeUser(user, includeFields = null) {
  if (!user) return null;

  const userObj = {
    userId: user.userId,
    userName: user.userName,
    email: user.email,
    gender: user.gender,
    country: user.country,
    avatarColor: user.avatarColor,
    profileImageUrl: user.profileImageUrl,
    likeCount: user.likeCount,
    starCount: user.starCount,
    createdAt: user.createdAt,
    authType: user.authType,
    isGuest: user.isGuest,
    lastLogin: user.lastLogin,
  };

  // Filter to specific fields if requested
  if (includeFields && Array.isArray(includeFields)) {
    const filtered = {};
    includeFields.forEach(field => {
      if (field in userObj) filtered[field] = userObj[field];
    });
    return filtered;
  }

  return userObj;
}

/**
 * Minimal user serialization for real-time use (video/chat rooms)
 * Reduces payload size
 * @param {object} userData - User metadata from socket
 * @returns {object} Minimal user object
 */
function serializeMinimalUser(userData) {
  if (!userData) return null;
  return {
    userId: userData.userId || null,
    userName: userData.userName || 'Unknown',
    avatarColor: userData.avatarColor || '#128C7E',
    avatarLetter: (userData.avatarLetter || (userData.userName ? userData.userName.charAt(0).toUpperCase() : 'U')).substring(0, 1),
    profileImagePath: userData.profileImagePath || userData.profile_image_path || null,
  };
}

module.exports = {
  sendError,
  sendSuccess,
  serializeUser,
  serializeMinimalUser,
};
