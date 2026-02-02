const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for socket.io
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Allow polling fallback for environments where pure websocket may fail
  transports: ['websocket', 'polling'], // ✅ WebSocket first for lower latency
  pingInterval: 15000, // ✅ Reduced from 25000 for faster detection
  pingTimeout: 45000,  // ✅ Reduced from 60000
});

// ✅ IMPROVED: Centralized error response formatter
function sendErrorResponse(socket, event, code, message, details = null) {
  const errorResponse = {
    success: false,
    error: {
      code: code,
      message: message,
      timestamp: new Date().toISOString(),
    },
  };
  if (details) {
    errorResponse.error.details = details;
  }
  if (event) {
    socket.emit(event, errorResponse);
  }
  Logger.error(event || 'error', message, details);
  return errorResponse;
}

// Simple lookup endpoint to help debug join-by-invite behavior from clients
app.get('/room/by-invite/:code', (req, res) => {
  try {
    const code = (req.params.code || '').toString().trim().toUpperCase();
    if (!code) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CODE',
          message: 'Invite code is required and cannot be empty',
        },
      });
    }

    for (const room of rooms.values()) {
      if (room.inviteCode && room.inviteCode.toUpperCase() === code) {
        return res.json({
          success: true,
          room: {
            roomId: room.roomId,
            roomName: room.roomName,
            creatorName: room.creatorName,
            memberCount: room.memberIds.length,
            maxMembers: room.maxMembers,
            status: room.status,
          },
        });
      }
    }
    return res.status(404).json({
      success: false,
      error: {
        code: 'ROOM_NOT_FOUND',
        message: 'Room with the specified invite code not found',
      },
    });
  } catch (err) {
    Logger.error('http', 'Error in /room/by-invite', err && err.message);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred while looking up the room',
      },
    });
  }
});

// ========== CONFIGURATION ==========
const CONFIG = {
  PORT: process.env.PORT || 8080,
  SERVER_IP: process.env.SERVER_IP || '10.140.140.221', // Legacy config key (used by some deploys)
  // Host/interface to bind the HTTP server to (defaults to all interfaces)
  SERVER_BIND: process.env.SERVER_BIND || '0.0.0.0',
  STALE_TIMEOUT: 5 * 60 * 1000, // 5 minutes
  CLEANUP_INTERVAL: 60 * 1000, // 60 seconds
  MAX_USERNAME_LENGTH: 50,
  // ✅ OPTIMIZE: Faster member list sync
  MEMBER_SYNC_INTERVAL: 500, // ms - how often to sync member list to room
  PRESENCE_BROADCAST_INTERVAL: 250, // ms - debounce status broadcasts
  // Optional TURN config via environment variables
  TURN_URL: process.env.TURN_URL || null,
  TURN_USERNAME: process.env.TURN_USERNAME || null,
  TURN_CREDENTIAL: process.env.TURN_CREDENTIAL || null,
  // Default ICE servers (will include TURN if provided via env)
  DEFAULT_ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  // Suggested media constraints clients can use to improve quality
  MEDIA_CONSTRAINTS: {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: true,
    // Suggested target bitrate in kbps for clients to try to apply via setParameters
    suggestedVideoBitrateKbps: 1000,
  },
};

// Room ID / Invite generation constants
const ROOM_CONSTS = {
  INVITE_CHARS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  INVITE_LENGTH: 6,
  ROOM_ID_CHARS: 'abcdefghijklmnopqrstuvwxyz0123456789',
  ROOM_ID_PREFIX: 'room_',
  ROOM_ID_LENGTH: 12,
  INVITE_LINK_PREFIX: 'omeglelol://join-room/',
  DEFAULT_MAX_MEMBERS: 100,
};

function generateInviteCode() {
  let code = '';
  for (let i = 0; i < ROOM_CONSTS.INVITE_LENGTH; i++) {
    code += ROOM_CONSTS.INVITE_CHARS.charAt(Math.floor(Math.random() * ROOM_CONSTS.INVITE_CHARS.length));
  }
  return code;
}

function generateRoomId() {
  let id = ROOM_CONSTS.ROOM_ID_PREFIX;
  for (let i = 0; i < ROOM_CONSTS.ROOM_ID_LENGTH; i++) {
    id += ROOM_CONSTS.ROOM_ID_CHARS.charAt(Math.floor(Math.random() * ROOM_CONSTS.ROOM_ID_CHARS.length));
  }
  return id;
}

function generateMatchId() {
  return `m_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function buildIceServers() {
  const list = Array.isArray(CONFIG.DEFAULT_ICE_SERVERS) ? [...CONFIG.DEFAULT_ICE_SERVERS] : [];
  if (CONFIG.TURN_URL && CONFIG.TURN_USERNAME && CONFIG.TURN_CREDENTIAL) {
    list.push({
      urls: CONFIG.TURN_URL,
      username: CONFIG.TURN_USERNAME,
      credential: CONFIG.TURN_CREDENTIAL,
    });
  }
  return list;
}

// In-memory rooms store: roomId -> room object
// room object fields: roomId, roomName, creatorId, creatorName, description,
// roomType ('public'|'private'), inviteCode, inviteLink, createdAt, memberIds (userIds), maxMembers, status
const rooms = new Map();

// ========== STATE MANAGEMENT ==========
const videoPairings = new Map(); // socket.id -> { peerId, userData }
const chatPairings = new Map();
const videoQueue = []; // Array of { socketId, userData, joinedAt }
const chatQueue = []; // Array of { socketId, userData, joinedAt }
const userSockets = new Map(); // userId -> socketId
const socketMetadata = new Map(); // socketId -> { userId, userName, joinedAt }
const socketQueues = new Map(); // socket.id -> 'video' | 'chat' (track which queue user is in)
const rateLimitMap = new Map(); // socketId -> { count, resetTime } for abuse prevention

// ========== RATE LIMITING ==========
const RATE_LIMIT_CONFIG = {
  maxRequestsPerMinute: 30,
  checkIntervalMs: 60000, // 1 minute
};

function checkRateLimit(socketId) {
  const now = Date.now();
  const limit = rateLimitMap.get(socketId);
  
  if (!limit || now > limit.resetTime) {
    rateLimitMap.set(socketId, { count: 1, resetTime: now + RATE_LIMIT_CONFIG.checkIntervalMs });
    return true;
  }
  
  if (limit.count >= RATE_LIMIT_CONFIG.maxRequestsPerMinute) {
    return false;
  }
  
  limit.count++;
  return true;
}

// ========== LOGGER UTILITY ==========
class Logger {
  static log(level, context, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] [${context}] ${message}`;
    const logFn = level === 'ERROR' ? console.error : console.log;
    logFn(logEntry, data || '');
  }

  static info(context, message, data) {
    this.log('INFO', context, message, data);
  }

  static warn(context, message, data) {
    this.log('WARN', context, message, data);
  }

  static error(context, message, data) {
    this.log('ERROR', context, message, data);
  }
}

// ========== HEALTH CHECK ENDPOINT ==========
app.get('/health', (req, res) => {
  try {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      videoQueueSize: videoQueue.length,
      chatQueueSize: chatQueue.length,
      activePairings: videoPairings.size + chatPairings.size,
      totalConnected: socketMetadata.size,
    });
  } catch (error) {
    Logger.error('health', 'Error generating health check', error.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// ========== VALIDATION & UTILITIES ==========
function validateUserData(userData) {
  if (!userData || typeof userData !== 'object') {
    return { valid: false, error: 'Invalid user data object' };
  }
  if (typeof userData.userId !== 'string' || userData.userId.length === 0) {
    return { valid: false, error: 'Invalid userId' };
  }
  if (typeof userData.userName !== 'string' || userData.userName.length === 0) {
    return { valid: false, error: 'Invalid userName' };
  }
  if (userData.userName.length > CONFIG.MAX_USERNAME_LENGTH) {
    return { valid: false, error: `userName exceeds ${CONFIG.MAX_USERNAME_LENGTH} characters` };
  }
  return { valid: true };
}

function isValidSocketId(socketId) {
  return typeof socketId === 'string' && socketId.length > 0;
}

// ========== ROOM MANAGEMENT ==========

function decomposeRoom(socketId, roomType = 'video') {
  if (!isValidSocketId(socketId)) {
    Logger.warn('decomposeRoom', 'Invalid socketId provided');
    return;
  }

  const pairings = roomType === 'video' ? videoPairings : chatPairings;
  const queue = roomType === 'video' ? videoQueue : chatQueue;

  Logger.info('decomposeRoom', `Decomposing ${roomType} room`, { socketId });

  try {
    if (pairings.has(socketId)) {
      const pairing = pairings.get(socketId);
      const peerId = pairing.peerId;

      if (!isValidSocketId(peerId)) {
        Logger.warn('decomposeRoom', 'Invalid peerId in pairing', { socketId, peerId });
        return;
      }

      // Notify peer
      io.to(peerId).emit('partner_left', {
        reason: 'partner_left',
        timestamp: Date.now(),
      });

      // Remove both sides
      pairings.delete(socketId);
      pairings.delete(peerId);
      socketQueues.delete(peerId);

      // Requeue peer
      queue.push({
        socketId: peerId,
        userData: socketMetadata.get(peerId) || {},
        joinedAt: Date.now(),
      });
      socketQueues.set(peerId, roomType);

      Logger.info('decomposeRoom', `Peer requeued`, { peerId, queueSize: queue.length });
    } else {
      // Remove from queue if present
      const queueIndex = queue.findIndex((item) => item.socketId === socketId);
      if (queueIndex !== -1) {
        queue.splice(queueIndex, 1);
        socketQueues.delete(socketId);
        Logger.info('decomposeRoom', `Removed from queue`, { socketId, queueSize: queue.length });
      }
    }
  } catch (error) {
    Logger.error('decomposeRoom', 'Error during room decomposition', error.message);
  }
}

function attemptMatch(roomType = 'video') {
  try {
    const pairings = roomType === 'video' ? videoPairings : chatPairings;
    const queue = roomType === 'video' ? videoQueue : chatQueue;

    Logger.info('attemptMatch', `Checking queue for ${roomType} pairing`, {
      queueSize: queue.length,
      currentPairings: pairings.size,
    });

    if (queue.length < 2) {
      Logger.warn('attemptMatch', `Not enough users in ${roomType} queue to match`, {
        needed: 2,
        available: queue.length,
      });
      return false;
    }

    const user1 = queue.shift();
    const user2 = queue.shift();

    if (!isValidSocketId(user1?.socketId) || !isValidSocketId(user2?.socketId)) {
      Logger.warn('attemptMatch', 'Invalid socket IDs in queue');
      return false;
    }

    Logger.info('attemptMatch', `Matched ${roomType} pair`, {
      user1Id: user1.socketId,
      user1Name: user1.userData?.userName,
      user2Id: user2.socketId,
      user2Name: user2.userData?.userName,
    });

    // Create pairing
    const matchId = generateMatchId();
    pairings.set(user1.socketId, {
      peerId: user2.socketId,
      userData: user2.userData,
      matchId,
    });
    pairings.set(user2.socketId, {
      peerId: user1.socketId,
      userData: user1.userData,
      matchId,
    });
    socketQueues.delete(user1.socketId);
    socketQueues.delete(user2.socketId);

    // Notify both users - send matched event with peers array
    const iceServers = buildIceServers();
    const matchedData1 = {
      peers: [user1.socketId, user2.socketId],
      remoteUser: user2.userData,
      matchId,
      iceServers,
      mediaConstraints: CONFIG.MEDIA_CONSTRAINTS,
      matchedAt: Date.now(),
    };
    const matchedData2 = {
      peers: [user1.socketId, user2.socketId],
      remoteUser: user1.userData,
      matchId,
      iceServers,
      mediaConstraints: CONFIG.MEDIA_CONSTRAINTS,
      matchedAt: Date.now(),
    };

    Logger.info('attemptMatch', 'Sending matched events', {
      user1: { socketId: user1.socketId, data: matchedData1 },
      user2: { socketId: user2.socketId, data: matchedData2 },
    });

    io.to(user1.socketId).emit('matched', matchedData1);
    io.to(user2.socketId).emit('matched', matchedData2);

    Logger.info('attemptMatch', `Successfully matched and notified ${roomType} pair`);
    return true;
  } catch (error) {
    Logger.error('attemptMatch', 'Error during matching', error.message);

    return false;
  }
}

function broadcastStats() {
  try {
    const stats = {
      videoQueueSize: videoQueue.length,
      chatQueueSize: chatQueue.length,
      videoPairings: videoPairings.size,
      chatPairings: chatPairings.size,
      totalPairings: videoPairings.size + chatPairings.size,
      totalOnline: socketMetadata.size,
    };

    io.emit('stats', stats);
    io.emit('online_count', stats.totalOnline);
  } catch (error) {
    Logger.error('broadcastStats', 'Error broadcasting stats', error.message);
  }
}

// ========== GROUP CHAT ROOMS ==========
const groupChatRooms = new Map(); // roomName -> Set of socketIds

// ========== SOCKET.IO CONNECTION HANDLER ==========
io.on('connection', (socket) => {
  Logger.info('connection', 'Client connected', { socketId: socket.id });

  socket.emit('SignallingClient', socket.id);

  // User registration
  socket.on('register_user', (userData, callback) => {
    try {
      const validation = validateUserData(userData);

      if (!validation.valid) {
        Logger.warn('register_user', `Validation failed: ${validation.error}`, { socketId: socket.id });
        // ✅ IMPROVED: Better error response with error code
        const errorResponse = {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: validation.error,
          },
        };
        socket.emit('error', errorResponse);
        if (typeof callback === 'function') callback(errorResponse);
        return;
      }

      // Store complete user data including avatar info
      // Normalize possible profile image keys from clients
      const profileImageCandidates = [
        'profileImagePath',
        'profile_image_path',
        'profileImage',
        'profile_pic',
        'photo',
        'avatarUrl',
        'img',
      ];
      let profileImagePath = null;
      for (const k of profileImageCandidates) {
        if (userData[k]) {
          profileImagePath = userData[k];
          break;
        }
      }

      socketMetadata.set(socket.id, {
        userId: userData.userId,
        userName: userData.userName,
        avatarColor: userData.avatarColor || '#128C7E',
        avatarLetter: userData.avatarLetter || userData.userName[0].toUpperCase(),
        profileImagePath: profileImagePath || null,
        joinedAt: Date.now(),
      });

      userSockets.set(userData.userId, socket.id);
      Logger.info('register_user', 'User registered', {
        socketId: socket.id,
        userId: userData.userId,
        userName: userData.userName,
      });
      broadcastStats();
      if (typeof callback === 'function') callback({ success: true });
    } catch (error) {
      Logger.error('register_user', 'Error registering user', error.message);
      socket.emit('error', { message: 'Registration failed' });
      if (typeof callback === 'function') callback({ success: false, error: 'Registration failed' });
    }
  });

  // Update user status (mic/camera) and notify room members
  socket.on('update_user_status', (data, callback) => {
    try {
      Logger.info('update_user_status', 'Received status update', { socketId: socket.id, data });
      const meta = socketMetadata.get(socket.id) || {};
      const userId = meta.userId;
      if (!userId) {
        if (callback) callback({ success: false, error: 'User not registered' });
        return;
      }

      const micOn = data && typeof data.micOn === 'boolean' ? data.micOn : true;
      const cameraOn = data && typeof data.cameraOn === 'boolean' ? data.cameraOn : true;

      // Persist status on socket metadata
      meta.status = { micOn, cameraOn };
      socketMetadata.set(socket.id, meta);

      // Find rooms where this user is present and notify members (including sender)
      for (const room of rooms.values()) {
        if (room.memberIds && room.memberIds.includes(userId) && room.status === 'active') {
          for (const memberId of room.memberIds) {
            const memberSocketId = userSockets.get(memberId);
            if (memberSocketId) {
              io.to(memberSocketId).emit('room_member_updated', {
                roomId: room.roomId,
                userId,
                status: { micOn, cameraOn },
              });
            }
          }
        }
      }

      if (callback) callback({ success: true });
    } catch (err) {
      Logger.error('update_user_status', 'Error updating user status', err && err.message);
      if (callback) callback({ success: false, error: 'Failed to update status' });
    }
  });

  // ========== GROUP ROOM EVENTS ==========
  // Create a new room (public/private)
  socket.on('create_room', (data, callback) => {
    try {
      let meta = socketMetadata.get(socket.id);
      // If socket not registered, allow auto-registration when client provides user info
      if (!meta) {
        const userPayload = data && (data.user || data.userId || data.userName) ? (data.user || {
          userId: data.userId,
          userName: data.userName,
          avatarColor: data.avatarColor,
          avatarLetter: data.avatarLetter,
          profileImagePath: data.profileImagePath,
        }) : null;

        if (userPayload) {
          const validation = validateUserData(userPayload);
          if (validation.valid) {
            socketMetadata.set(socket.id, {
              userId: userPayload.userId,
              userName: userPayload.userName,
              avatarColor: userPayload.avatarColor || '#128C7E',
              avatarLetter: userPayload.avatarLetter || (userPayload.userName ? userPayload.userName[0].toUpperCase() : 'U'),
              profileImagePath: userPayload.profileImagePath || null,
              joinedAt: Date.now(),
            });
            userSockets.set(userPayload.userId, socket.id);
            meta = socketMetadata.get(socket.id) || {};
            Logger.info('create_room', 'Auto-registered user from create_room payload', { socketId: socket.id, userId: userPayload.userId });
            broadcastStats();
          } else {
            if (callback) callback({ success: false, error: validation.error });
            return;
          }
        } else {
          const err = 'User not registered';
          if (callback) callback({ success: false, error: err });
          return;
        }
      }

      const roomName = (data && data.roomName) ? String(data.roomName).trim() : null;
      if (!roomName) {
        if (callback) callback({ success: false, error: 'Invalid room name' });
        return;
      }

      const roomType = (data && data.roomType) === 'public' ? 'public' : 'private';
      let maxMembers = (data && Number.isInteger(data.maxMembers) && data.maxMembers > 0) ? data.maxMembers : ROOM_CONSTS.DEFAULT_MAX_MEMBERS;
      if (maxMembers < 2) maxMembers = 2;
      if (maxMembers > 500) maxMembers = ROOM_CONSTS.DEFAULT_MAX_MEMBERS;

      const inviteCode = roomType === 'private' ? generateInviteCode() : null;
      const inviteLink = inviteCode ? ROOM_CONSTS.INVITE_LINK_PREFIX + inviteCode : null;
      const roomId = generateRoomId();

      const room = {
        roomId,
        roomName,
        creatorId: meta.userId,
        creatorName: meta.userName,
        description: (data && data.description) ? String(data.description).trim() : null,
        roomType,
        inviteCode,
        inviteLink,
        createdAt: new Date().toISOString(),
        memberIds: [meta.userId],
        maxMembers,
        status: 'active',
      };

      rooms.set(roomId, room);

      Logger.info('create_room', 'Room created', {
        roomId,
        roomName,
        roomType,
        inviteCode,
        creatorId: meta.userId,
        totalRooms: rooms.size,
      });

      // Inform caller
      if (callback) callback({ success: true, room });

      // Broadcast updated public rooms list
      if (roomType === 'public') {
        io.emit('rooms_updated', { type: 'public', rooms: Array.from(rooms.values()).filter(r => r.roomType === 'public' && r.status === 'active') });
      }
    } catch (error) {
      Logger.error('create_room', 'Error creating room', error.message);
      if (callback) callback({ success: false, error: 'Failed to create room' });
    }
  });

  // Join a room by invite code or roomId
  socket.on('join_room', (data, callback) => {
    try {
      const inviteCode = data && data.inviteCode ? String(data.inviteCode).trim() : null;
      const roomId = data && data.roomId ? String(data.roomId).trim() : null;
      
      Logger.info('join_room', 'Received join request', {
        socketId: socket.id,
        inviteCode,
        roomId,
      });

      let meta = socketMetadata.get(socket.id) || {};
      let userId = meta.userId;

      // If client included user info with the join request, auto-register the socket.
      if (!userId && data && (data.user || data.userId || data.userName)) {
        try {
          const userPayload = data.user || {
            userId: data.userId,
            userName: data.userName,
            avatarColor: data.avatarColor,
            avatarLetter: data.avatarLetter,
            profileImagePath: data.profileImagePath,
          };

          const validation = validateUserData(userPayload);
          if (validation.valid) {
            socketMetadata.set(socket.id, {
              userId: userPayload.userId,
              userName: userPayload.userName,
              avatarColor: userPayload.avatarColor || '#128C7E',
              avatarLetter: userPayload.avatarLetter || (userPayload.userName ? userPayload.userName[0].toUpperCase() : 'U'),
              profileImagePath: userPayload.profileImagePath || null,
              joinedAt: Date.now(),
            });
            userSockets.set(userPayload.userId, socket.id);
            meta = socketMetadata.get(socket.id) || {};
            userId = meta.userId;
            Logger.info('join_room', 'Auto-registered user from join payload', { socketId: socket.id, userId });
            broadcastStats();
          } else {
            Logger.warn('join_room', `Auto-registration failed validation: ${validation.error}`, { socketId: socket.id });
          }
        } catch (e) {
          Logger.error('join_room', 'Auto-registration error', e && e.message);
        }
      }

      if (!userId) {
        Logger.warn('join_room', 'User not registered for this socket', {
          socketId: socket.id,
          registeredUsers: Array.from(socketMetadata.keys()),
        });
        if (callback) callback({ success: false, error: 'User not registered' });
        return;
      }

      let room = null;
      if (inviteCode) {
        Logger.info('join_room', 'Searching for room by inviteCode', {
          searchCode: inviteCode.toUpperCase(),
          totalRooms: rooms.size,
          roomCodes: Array.from(rooms.values()).map(r => ({
            roomId: r.roomId,
            inviteCode: r.inviteCode,
            status: r.status,
          })),
        });

        for (const r of rooms.values()) {
          if (r.inviteCode && r.inviteCode.toUpperCase() === inviteCode.toUpperCase() && r.status === 'active') {
            room = r;
            Logger.info('join_room', 'Room found by inviteCode', {
              roomId: r.roomId,
              roomName: r.roomName,
            });
            break;
          }
        }

        if (!room) {
          Logger.warn('join_room', 'Room not found by inviteCode', {
            searchedCode: inviteCode.toUpperCase(),
            totalRooms: rooms.size,
          });
        }
      } else if (roomId) {
        room = rooms.get(roomId) || null;
        if (room && room.status !== 'active') room = null;
      }

      if (!room) {
        if (callback) callback({ success: false, error: 'Room not found' });
        return;
      }

      if (room.memberIds.includes(userId)) {
        if (callback) callback({ success: true, room });
        return;
      }

      if (room.memberIds.length >= room.maxMembers) {
        if (callback) callback({ success: false, error: 'Room is full' });
        return;
      }

      room.memberIds.push(userId);
      rooms.set(room.roomId, room);

      Logger.info('join_room', 'User joined room', { roomId: room.roomId, userId, totalMembers: room.memberIds.length });

      // ✅ OPTIMIZE: Build complete member details with caching
      const buildMemberDetails = () => {
        return room.memberIds.map(memberId => {
          const memberSocketId = userSockets.get(memberId);
          const memberMeta = memberSocketId ? socketMetadata.get(memberSocketId) : {};
          return {
            userId: memberId,
            userName: memberMeta.userName || `User ${memberId.substring(0, 6)}`,
            avatarColor: memberMeta.avatarColor || '#128C7E',
            avatarLetter: memberMeta.avatarLetter || 'U',
            profileImagePath: memberMeta.profileImagePath || null,
            status: memberMeta.status || { micOn: true, cameraOn: true },
          };
        });
      };

      const completeMemberDetails = buildMemberDetails();
      const totalMembers = room.memberIds.length;

      // ✅ OPTIMIZE: Send to new member immediately on same tick
      setImmediate(() => {
        try {
          io.to(socket.id).emit('room_member_list', {
            roomId: room.roomId,
            memberIds: room.memberIds,
            memberDetails: completeMemberDetails,
            timestamp: Date.now(),
          });
        } catch (err) {
          Logger.error('join_room', 'Error sending room_member_list to new member', err.message);
        }
      });

      // ✅ OPTIMIZE: Broadcast to others with reduced payload
      for (const memberId of room.memberIds) {
        if (memberId !== userId) { // Don't send duplicate to the new joiner
          const memberSocketId = userSockets.get(memberId);
          if (memberSocketId) {
            setImmediate(() => {
              try {
                io.to(memberSocketId).emit('room_member_list_updated', {
                  roomId: room.roomId,
                  memberIds: room.memberIds,
                  memberDetails: completeMemberDetails,
                  totalMembers: totalMembers,
                  newMemberId: userId,
                  newMemberName: meta.userName,
                  timestamp: Date.now(),
                });
              } catch (err) {
                Logger.error('join_room', 'Error sending room_member_list_updated to member', err.message);
              }
            });
          }
        }
      }

      if (callback) callback({ success: true, room, memberIds: room.memberIds });
    } catch (error) {
      Logger.error('join_room', 'Error joining room', error.message);
      if (callback) callback({ success: false, error: 'Failed to join room' });
    }
  });

  // List public rooms (simple discovery)
  socket.on('list_public_rooms', (data, callback) => {
    try {
      const publicRooms = Array.from(rooms.values()).filter(r => r.roomType === 'public' && r.status === 'active');
      if (callback) callback({ success: true, rooms: publicRooms });
    } catch (error) {
      Logger.error('list_public_rooms', 'Error listing public rooms', error.message);
      if (callback) callback({ success: false, error: 'Failed to list rooms' });
    }
  });

  // Find partner for video/chat
  socket.on('find_partner', (data) => {
    try {
      // Rate limiting check
      if (!checkRateLimit(socket.id)) {
        Logger.warn('find_partner', 'Rate limit exceeded', { socketId: socket.id });
        // ✅ IMPROVED: Better rate limit error response
        socket.emit('error', {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down.',
          retryAfter: 60,
        });
        return;
      }

      const roomType = (data && data.type) || 'video';
      const userData = socketMetadata.get(socket.id);

      Logger.info('find_partner', `User requesting ${roomType} partner`, {
        socketId: socket.id,
        userName: userData?.userName,
        timestamp: new Date().toISOString(),
      });

      if (!isValidSocketId(socket.id)) {
        Logger.warn('find_partner', 'Invalid socket ID', { socketId: socket.id });
        // ✅ IMPROVED: Clear error with code
        socket.emit('error', {
          code: 'INVALID_SOCKET',
          message: 'Invalid or missing socket ID. Please reconnect.',
        });
        return;
      }

      const queue = roomType === 'chat' ? chatQueue : videoQueue;
      const pairings = roomType === 'chat' ? chatPairings : videoPairings;

      // Check if already paired
      if (pairings.has(socket.id)) {
        Logger.info('find_partner', 'User already paired', { socketId: socket.id, roomType });
        socket.emit('already_paired', {
          message: 'You are already in a conversation. End it before starting a new one.',
        });
        return;
      }

      const queuedUser = {
        socketId: socket.id,
        userData: userData,
        joinedAt: Date.now(),
      };
      queue.push(queuedUser);
      socketQueues.set(socket.id, roomType);

      Logger.info('find_partner', 'User added to queue', {
        socketId: socket.id,
        roomType,
        queuePosition: queue.length,
        queueSize: queue.length,
      });

      socket.emit('queued', {
        queuePosition: queue.length,
        type: roomType,
      });

      Logger.info('find_partner', 'Attempting to match after queueing', {
        socketId: socket.id,
        roomType,
        queueSizeBeforeMatch: queue.length,
      });

      const matchResult = attemptMatch(roomType);

      Logger.info('find_partner', 'Match attempt completed', {
        socketId: socket.id,
        roomType,
        matched: matchResult,
        queueSizeAfterMatch: queue.length,
      });

      broadcastStats();
    } catch (error) {
      Logger.error('find_partner', 'Error finding partner', error.message);
      socket.emit('error', { message: 'Failed to find partner' });
    }
  });

  // Quick invite check (socket) - useful for clients to validate invite codes before joining
  socket.on('check_invite', (data, callback) => {
    try {
      const code = data && typeof data === 'string' ? data.toString().trim().toUpperCase() : (data && data.inviteCode ? String(data.inviteCode).trim().toUpperCase() : null);
      if (!code) {
        if (typeof callback === 'function') callback({ success: false, error: 'Invalid invite code' });
        return;
      }

      for (const r of rooms.values()) {
        if (r.inviteCode && r.inviteCode.toUpperCase() === code && r.status === 'active') {
          if (typeof callback === 'function') callback({ success: true, room: r });
          return;
        }
      }
      if (typeof callback === 'function') callback({ success: false, error: 'Room not found' });
    } catch (err) {
      Logger.error('check_invite', 'Error checking invite', err && err.message);
      if (typeof callback === 'function') callback({ success: false, error: 'Internal error' });
    }
  });

  // Handle 'next' button
  socket.on('next', () => {
    try {
      if (videoPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'video');
      } else if (chatPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'chat');
      }
    } catch (error) {
      Logger.error('next', 'Error processing next', error.message);
    }
  });

  // Room leave
  socket.on('room_leave', (data) => {
    try {
      const roomType = (data && data.type) || 'video';
      Logger.info('room_leave', `User leaving ${roomType} room`, { socketId: socket.id });
      decomposeRoom(socket.id, roomType);
      broadcastStats();
    } catch (error) {
      Logger.error('room_leave', 'Error leaving room', error.message);
    }
  });

  // Switch to chat
  socket.on('switch_to_chat', (data) => {
    try {
      Logger.info('switch_to_chat', 'User switching to chat', { socketId: socket.id });

      if (videoPairings.has(socket.id)) {
        const pairing = videoPairings.get(socket.id);
        const peerId = pairing.peerId;

        if (isValidSocketId(peerId)) {
          io.to(peerId).emit('partner_switched', {
            reason: 'partner_switched_to_chat',
            timestamp: Date.now(),
          });

          videoPairings.delete(socket.id);
          videoPairings.delete(peerId);
          socketQueues.delete(peerId);

          chatQueue.push({
            socketId: peerId,
            userData: socketMetadata.get(peerId) || {},
            joinedAt: Date.now(),
          });
          socketQueues.set(peerId, 'chat');
        }
      }

      chatQueue.push({
        socketId: socket.id,
        userData: socketMetadata.get(socket.id) || {},
        joinedAt: Date.now(),
      });
      socketQueues.set(socket.id, 'chat');

      socket.emit('queued', {
        type: 'chat',
        queuePosition: chatQueue.length,
      });

      attemptMatch('chat');
      broadcastStats();
    } catch (error) {
      Logger.error('switch_to_chat', 'Error switching to chat', error.message);
      socket.emit('error', { message: 'Failed to switch to chat' });
    }
  });

  // WebRTC - offer
  socket.on('offer', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      Logger.info('offer', 'Received offer from initiator', { socketId: socket.id, peerId, matchId: pairing?.matchId });
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('offer', 'Forwarding offer to peer', { socketId: socket.id, peerId });
        // Include sender id and matchId for easier routing/debugging on client
        const out = Object.assign({}, data || {}, { fromId: socket.id, matchId: pairing?.matchId, forwardedAt: Date.now() });
        io.to(peerId).emit('makeCall', out);
      } else {
        Logger.warn('offer', 'No valid peer found for offer', { socketId: socket.id, peerId });
      }
    } catch (error) {
      Logger.error('offer', 'Error sending offer', error.message);
    }
  });

  // WebRTC - answer
  socket.on('answer', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      Logger.info('answer', 'Received answer from responder', { socketId: socket.id, peerId, matchId: pairing?.matchId });
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('answer', 'Forwarding answer to peer', { socketId: socket.id, peerId });
        const out = Object.assign({}, data || {}, { fromId: socket.id, matchId: pairing?.matchId, forwardedAt: Date.now() });
        io.to(peerId).emit('callAnswered', out);
      } else {
        Logger.warn('answer', 'No valid peer found for answer', { socketId: socket.id, peerId });
      }
    } catch (error) {
      Logger.error('answer', 'Error sending answer', error.message);
    }
  });

  // WebRTC - ICE candidates
  socket.on('IceCandidate', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('IceCandidate', 'Forwarding ICE candidate', { socketId: socket.id, peerId, matchId: pairing?.matchId });
        const out = Object.assign({}, data || {}, { fromId: socket.id, matchId: pairing?.matchId, forwardedAt: Date.now() });
        io.to(peerId).emit('IceCandidate', out);
      }
    } catch (error) {
      Logger.error('IceCandidate', 'Error sending ICE candidate', error.message);
    }
  });

  // Chat message relay
  socket.on('message', (data) => {
    try {
      if (!data || !data.message) {
        Logger.warn('message', 'Empty message', { socketId: socket.id });
        return;
      }

      const peerId = chatPairings.get(socket.id)?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        io.to(peerId).emit('receiveMessage', {
          message: String(data.message).substring(0, 500), // Limit message length
          sender: socketMetadata.get(socket.id),
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      Logger.error('message', 'Error relaying message', error.message);
    }
  });

  // Disconnect
  socket.on('disconnect', (reason) => {
    try {
      Logger.info('disconnect', `Client disconnected: ${reason}`, { socketId: socket.id });

      // Decompose pairings
      if (videoPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'video');
      } else if (chatPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'chat');
      }

      // Remove from queues
      const videoIdx = videoQueue.findIndex((item) => item.socketId === socket.id);
      if (videoIdx !== -1) videoQueue.splice(videoIdx, 1);

      const chatIdx = chatQueue.findIndex((item) => item.socketId === socket.id);
      if (chatIdx !== -1) chatQueue.splice(chatIdx, 1);

      // Clean metadata
      const userData = socketMetadata.get(socket.id);
      if (userData) {
        userSockets.delete(userData.userId);
      }
      socketMetadata.delete(socket.id);
      socketQueues.delete(socket.id);

      broadcastStats();
    } catch (error) {
      Logger.error('disconnect', 'Error during disconnect cleanup', error.message);
    }
  });

  // ========== GROUP CHAT EVENTS ==========
  
  // Message deduplication: track recent messageIds to prevent duplicates
  const messageIdCache = new Map(); // groupName -> { ids: Set, timestamp }
  const MESSAGE_CACHE_TIMEOUT = 30000; // 30 seconds
  
  // Clean old message IDs from cache periodically
  setInterval(() => {
    const now = Date.now();
    for (const [groupName, cache] of messageIdCache.entries()) {
      if (cache.timestamp && now - cache.timestamp > MESSAGE_CACHE_TIMEOUT) {
        messageIdCache.delete(groupName);
      }
    }
  }, MESSAGE_CACHE_TIMEOUT);
  
  // User joins a group
  socket.on('join_group', (data, callback) => {
    try {
      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      if (!groupName) {
        Logger.warn('join_group', 'Invalid group name', { socketId: socket.id });
        if (callback) callback({ success: false, error: 'Invalid group name' });
        return;
      }

      // Get or create room
      if (!groupChatRooms.has(groupName)) {
        groupChatRooms.set(groupName, new Set());
      }

      const roomSet = groupChatRooms.get(groupName);
      const wasAlreadyMember = roomSet.has(socket.id);

      // Add user to room
      roomSet.add(socket.id);
      socket.join(`group_${groupName}`);

      const memberCount = roomSet.size;

      Logger.info('join_group', 'User joined group', {
        socketId: socket.id,
        userName: data?.userName,
        groupName,
        memberCount,
        wasAlreadyMember,
      });

      // Notify all users in group (including the new joiner)
      io.to(`group_${groupName}`).emit('user_joined_group', {
        groupName,
        groupIcon: data?.groupIcon || '💬',
        userId: data?.userId,
        userName: data?.userName || 'Unknown User',
        avatarColor: data?.avatarColor || '#128C7E',
        avatarLetter: data?.avatarLetter || 'U',
        memberCount,
        timestamp: new Date().toISOString(),
      });

      if (callback) {
        callback({
          success: true,
          groupName,
          memberCount,
          message: `Joined ${groupName}. Total members: ${memberCount}`,
        });
      }
    } catch (error) {
      Logger.error('join_group', 'Error joining group', error.message);
      if (callback) callback({ success: false, error: 'Failed to join group' });
    }
  });

  // User sends message to group
  socket.on('send_group_message', (data, callback) => {
    try {
      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      const message = data && data.message ? String(data.message).trim() : null;
      const clientMessageId = data && data.messageId ? String(data.messageId).trim() : null;

      if (!groupName || !message) {
        Logger.warn('send_group_message', 'Invalid message data', {
          socketId: socket.id,
          hasGroupName: !!groupName,
          hasMessage: !!message,
        });
        if (callback) callback({ success: false, error: 'Invalid message data' });
        return;
      }

      // Validate user is in group
      const roomSet = groupChatRooms.get(groupName);
      if (!roomSet || !roomSet.has(socket.id)) {
        Logger.warn('send_group_message', 'User not in group', {
          socketId: socket.id,
          groupName,
        });
        if (callback) callback({ success: false, error: 'Not in this group' });
        return;
      }

      // Use client messageId if provided (helps with deduplication), otherwise generate
      const serverMessageId = clientMessageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Initialize dedup cache for this group if needed
      if (!messageIdCache.has(groupName)) {
        messageIdCache.set(groupName, { ids: new Set(), timestamp: Date.now() });
      }
      
      const cache = messageIdCache.get(groupName);
      
      // Check if this message was already broadcast (deduplication)
      if (cache.ids.has(serverMessageId)) {
        Logger.warn('send_group_message', 'Duplicate message detected and skipped', {
          socketId: socket.id,
          groupName,
          messageId: serverMessageId,
        });
        if (callback) callback({ success: true, duplicate: true, messageId: serverMessageId });
        return;
      }
      
      // Add to dedup cache
      cache.ids.add(serverMessageId);
      cache.timestamp = Date.now();

      const messageData = {
        groupName,
        groupIcon: data?.groupIcon || '💬',
        userId: data?.userId || '',
        userName: (data?.userName || 'Unknown User').substring(0, 50),
        text: message.substring(0, 1000), // Increased limit and fixed field name
        message: message.substring(0, 1000), // Keep both for compatibility
        avatarColor: data?.avatarColor || '#128C7E',
        avatarLetter: (data?.avatarLetter || (data?.userName ? data.userName.charAt(0).toUpperCase() : 'U')).substring(0, 1),
        timestamp: Date.now(), // Use numeric timestamp
        messageId: serverMessageId,
        isOwn: false, // Backend doesn't know, frontend will determine
      };

      Logger.info('send_group_message', 'Broadcasting message to others (not sender)', {
        socketId: socket.id,
        groupName,
        userName: messageData.userName,
        messageId: serverMessageId,
        roomSize: roomSet.size,
      });

      // Broadcast to OTHER users in the group (NOT including sender - they use optimistic update)
      socket.to(`group_${groupName}`).emit('group_message', messageData);

      if (callback) {
        callback({
          success: true,
          messageId: serverMessageId,
          timestamp: messageData.timestamp,
          data: messageData,
        });
      }
    } catch (error) {
      Logger.error('send_group_message', 'Error sending message', error.message);
      if (callback) callback({ success: false, error: 'Failed to send message' });
    }
  });

  // User leaves group
  socket.on('leave_group', (data, callback) => {
    try {
      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      if (!groupName) {
        if (callback) callback({ success: false, error: 'Invalid group name' });
        return;
      }

      const roomSet = groupChatRooms.get(groupName);
      if (!roomSet) {
        if (callback) callback({ success: false, error: 'Group not found' });
        return;
      }

      const wasInGroup = roomSet.has(socket.id);
      roomSet.delete(socket.id);
      socket.leave(`group_${groupName}`);

      const memberCount = roomSet.size;

      Logger.info('leave_group', 'User left group', {
        socketId: socket.id,
        userName: (data?.userName || 'Unknown User').substring(0, 50),
        groupName,
        memberCount,
        wasInGroup,
      });

      // Notify remaining users in group
      if (memberCount > 0) {
        io.to(`group_${groupName}`).emit('user_left_group', {
          groupName,
          userId: data?.userId || '',
          userName: (data?.userName || 'Unknown User').substring(0, 50),
          memberCount,
          timestamp: Date.now(),
        });
      } else {
        // Clean up empty room and its dedup cache
        groupChatRooms.delete(groupName);
        messageIdCache.delete(groupName); // Clean up dedup cache for empty group
        Logger.info('leave_group', 'Removed empty group room and cleaned cache', { groupName });
      }

      if (callback) {
        callback({
          success: true,
          groupName,
          memberCount,
          message: `Left ${groupName}`,
        });
      }
    } catch (error) {
      Logger.error('leave_group', 'Error leaving group', error.message);
      if (callback) callback({ success: false, error: 'Failed to leave group' });
    }
  });

});

// ========== CLEANUP & MAINTENANCE ==========
setInterval(() => {
  try {
    const now = Date.now();

    // Clean video queue - with timeout notifications
    for (let i = videoQueue.length - 1; i >= 0; i--) {
      if (now - videoQueue[i].joinedAt > CONFIG.STALE_TIMEOUT) {
        const stalUser = videoQueue.splice(i, 1)[0];
        const waitedMs = now - stalUser.joinedAt;
        
        // Notify user of timeout
        if (io.sockets.sockets.get(stalUser.socketId)) {
          io.to(stalUser.socketId).emit('queue_timeout', {
            type: 'video',
            reason: 'No partner found - waited too long',
            waitedSeconds: Math.floor(waitedMs / 1000),
            maxWaitSeconds: Math.floor(CONFIG.STALE_TIMEOUT / 1000),
          });
        }
        
        socketQueues.delete(stalUser.socketId);
        Logger.info('cleanup', 'Removed stale video user', {
          socketId: stalUser.socketId,
          waitedSeconds: Math.floor(waitedMs / 1000),
        });
      }
    }

    // Clean chat queue - with timeout notifications
    for (let i = chatQueue.length - 1; i >= 0; i--) {
      if (now - chatQueue[i].joinedAt > CONFIG.STALE_TIMEOUT) {
        const stalUser = chatQueue.splice(i, 1)[0];
        const waitedMs = now - stalUser.joinedAt;
        
        // Notify user of timeout
        if (io.sockets.sockets.get(stalUser.socketId)) {
          io.to(stalUser.socketId).emit('queue_timeout', {
            type: 'chat',
            reason: 'No chat partner found - waited too long',
            waitedSeconds: Math.floor(waitedMs / 1000),
            maxWaitSeconds: Math.floor(CONFIG.STALE_TIMEOUT / 1000),
          });
        }
        
        socketQueues.delete(stalUser.socketId);
        Logger.info('cleanup', 'Removed stale chat user', {
          socketId: stalUser.socketId,
          waitedSeconds: Math.floor(waitedMs / 1000),
        });
      }
    }
    
    broadcastStats();
  } catch (error) {
    Logger.error('cleanup', 'Error during cleanup', error.message);
  }
}, CONFIG.CLEANUP_INTERVAL);

// ========== SERVER STARTUP ==========
server.listen(CONFIG.PORT, CONFIG.SERVER_BIND, () => {
  Logger.info('startup', `WebSocket server listening`, {
    bind: CONFIG.SERVER_BIND,
    advertisedIP: CONFIG.SERVER_IP,
    port: CONFIG.PORT,
  });
});

// ========== GRACEFUL SHUTDOWN ==========
process.on('SIGTERM', () => {
  Logger.info('shutdown', 'SIGTERM received, closing server...');
  server.close(() => {
    Logger.info('shutdown', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  Logger.info('shutdown', 'SIGINT received, closing server...');
  server.close(() => {
    Logger.info('shutdown', 'Server closed');
    process.exit(0);
  });
});

// ========== ERROR HANDLING ==========
process.on('uncaughtException', (error) => {
  Logger.error('uncaughtException', 'Uncaught exception', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('unhandledRejection', 'Unhandled rejection', String(reason));
});
