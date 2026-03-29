/**
 * User Registration & Validation Utilities
 * Extracted from repeated socket.on handlers: create_room, join_room, register_user, etc.
 */

const { Logger } = require('./logger');

/**
 * Auto-register user from socket if not already registered
 * Consolidates validation logic used in create_room, join_room, etc.
 * @param {object} socket - Socket.io socket object
 * @param {object} socketMetadata - Map of socket.id -> metadata
 * @param {object} userSockets - Map of userId -> socket.id+
 * @param {object} userData - User data to register
 * @param {function} broadcastStats - Function to broadcast updated stats
 * @returns {object|null} Metadata object if successful, null if failed
 */
function autoRegisterUserIfNeeded(socket, socketMetadata, userSockets, userData, broadcastStats, CONFIG) {
  try {
    // If already registered, return existing metadata
    const existingMeta = socketMetadata.get(socket.id);
    if (existingMeta && existingMeta.userId) {
      return existingMeta;
    }

    // Validate incoming user data
    const validation = validateUserData(userData, CONFIG);
    if (!validation.valid) {
      Logger.warn('autoRegisterUserIfNeeded', `Validation failed: ${validation.error}`, { socketId: socket.id });
      return null;
    }

    // Extract profile image from multiple possible keys
    const profileImagePath = extractProfileImage(userData);

    // Register the socket
    const meta = {
      userId: userData.userId,
      userName: userData.userName,
      avatarColor: userData.avatarColor || '#128C7E',
      avatarLetter: userData.avatarLetter || (userData.userName ? userData.userName[0].toUpperCase() : 'U'),
      profileImagePath: profileImagePath || null,
      joinedAt: Date.now(),
    };

    socketMetadata.set(socket.id, meta);
    userSockets.set(userData.userId, socket.id);

    Logger.info('autoRegisterUserIfNeeded', 'User auto-registered', {
      socketId: socket.id,
      userId: userData.userId,
      userName: userData.userName,
    });

    if (broadcastStats) broadcastStats();
    return meta;
  } catch (err) {
    Logger.error('autoRegisterUserIfNeeded', 'Error during auto-registration', err.message);
    return null;
  }
}

/**
 * Validate user data structure
 * Used in register_user, create_room, join_room, etc.
 * @param {object} userData - User data to validate
 * @param {object} CONFIG - Configuration with validation limits
 * @returns {object} {valid: boolean, error: string|null}
 */
function validateUserData(userData, CONFIG = {}) {
  const maxUsernameLength = CONFIG.MAX_USERNAME_LENGTH || 50;

  if (!userData || typeof userData !== 'object') {
    return { valid: false, error: 'Invalid user data object' };
  }

  if (typeof userData.userId !== 'string' || userData.userId.trim().length === 0) {
    return { valid: false, error: 'Invalid userId' };
  }

  if (typeof userData.userName !== 'string' || userData.userName.trim().length === 0) {
    return { valid: false, error: 'Invalid userName' };
  }

  if (userData.userName.length > maxUsernameLength) {
    return { valid: false, error: `userName exceeds ${maxUsernameLength} characters` };
  }

  return { valid: true };
}

/**
 * Extract profile image from userData (handles multiple key variants)
 * @param {object} userData - User data object
 * @returns {string|null} Profile image URL or null
 */
function extractProfileImage(userData) {
  if (!userData) return null;

  const candidates = [
    'profileImagePath',
    'profile_image_path',
    'profileImage',
    'profile_pic',
    'photo',
    'avatarUrl',
    'img',
  ];

  for (const key of candidates) {
    if (userData[key]) {
      return userData[key];
    }
  }

  return null;
}

/**
 * Check if socket is properly registered
 * @param {object} socketMetadata - Map of socket.id -> metadata
 * @param {string} socketId - Socket ID to check
 * @returns {boolean}
 */
function isSocketRegistered(socketMetadata, socketId) {
  const meta = socketMetadata.get(socketId);
  return !!(meta && meta.userId);
}

/**
 * Get user metadata for socket
 * @param {object} socketMetadata - Map of socket.id -> metadata
 * @param {string} socketId - Socket ID
 * @returns {object|null}
 */
function getSocketMetadata(socketMetadata, socketId) {
  return socketMetadata.get(socketId) || null;
}

module.exports = {
  autoRegisterUserIfNeeded,
  validateUserData,
  extractProfileImage,
  isSocketRegistered,
  getSocketMetadata,
};
