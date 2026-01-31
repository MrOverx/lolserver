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
  transports: ['websocket'],
  pingInterval: 25000,
  pingTimeout: 60000,
});

app.use(cors());
app.use(express.json());

// ========== CONFIGURATION ==========
const CONFIG = {
  PORT: process.env.PORT || 8080,
  SERVER_IP: process.env.SERVER_IP || '0.0.0.0',
  STALE_TIMEOUT: 5 * 60 * 1000, // 5 minutes
  CLEANUP_INTERVAL: 60 * 1000, // 60 seconds
  MAX_USERNAME_LENGTH: 50,
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

    if (queue.length < 2) return false;

    const user1 = queue.shift();
    const user2 = queue.shift();

    if (!isValidSocketId(user1?.socketId) || !isValidSocketId(user2?.socketId)) {
      Logger.warn('attemptMatch', 'Invalid socket IDs in queue');
      return false;
    }

    Logger.info('attemptMatch', `Matched ${roomType} pair`, {
      user1: user1.socketId,
      user2: user2.socketId,
    });

    // Create pairing
    pairings.set(user1.socketId, {
      peerId: user2.socketId,
      userData: user2.userData,
    });
    pairings.set(user2.socketId, {
      peerId: user1.socketId,
      userData: user1.userData,
    });
    socketQueues.delete(user1.socketId);
    socketQueues.delete(user2.socketId);

    // Notify both users
    io.to(user1.socketId).emit('matched', {
      peers: [user1.socketId, user2.socketId],
      remoteUser: user2.userData,
    });

    io.to(user2.socketId).emit('matched', {
      peers: [user1.socketId, user2.socketId],
      remoteUser: user1.userData,
    });

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

// ========== SOCKET.IO CONNECTION HANDLER ==========
io.on('connection', (socket) => {
  Logger.info('connection', 'Client connected', { socketId: socket.id });

  socket.emit('SignallingClient', socket.id);

  // User registration
  socket.on('register_user', (userData) => {
    try {
      const validation = validateUserData(userData);

      if (!validation.valid) {
        Logger.warn('register_user', `Validation failed: ${validation.error}`, { socketId: socket.id });
        socket.emit('error', { message: validation.error });
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
    } catch (error) {
      Logger.error('register_user', 'Error registering user', error.message);
      socket.emit('error', { message: 'Registration failed' });
    }
  });

  // ========== GROUP ROOM EVENTS ==========
  // Create a new room (public/private)
  socket.on('create_room', (data, callback) => {
    try {
      const meta = socketMetadata.get(socket.id);
      if (!meta) {
        const err = 'User not registered';
        if (callback) callback({ success: false, error: err });
        return;
      }

      const roomName = (data && data.roomName) ? String(data.roomName).trim() : null;
      if (!roomName) {
        if (callback) callback({ success: false, error: 'Invalid room name' });
        return;
      }

      const roomType = (data && data.roomType) === 'public' ? 'public' : 'private';
      const maxMembers = (data && Number.isInteger(data.maxMembers) && data.maxMembers > 0) ? data.maxMembers : ROOM_CONSTS.DEFAULT_MAX_MEMBERS;

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

      const meta = socketMetadata.get(socket.id) || {};
      const userId = meta.userId;
      
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

      Logger.info('join_room', 'User joined room', { roomId: room.roomId, userId });

      // Notify all room members (including the new member) of the update
      const newMemberName = meta.userName;
      const totalMembers = room.memberIds.length;
      
      for (const memberId of room.memberIds) {
        const memberSocketId = userSockets.get(memberId);
        if (memberSocketId) {
          io.to(memberSocketId).emit('room_member_joined', { 
            roomId: room.roomId, 
            newMemberId: userId,
            newMemberName: newMemberName,
            totalMembers: totalMembers
          });
        }
      }

      if (callback) callback({ success: true, room });
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
      const roomType = (data && data.type) || 'video';

      if (!isValidSocketId(socket.id)) {
        Logger.warn('find_partner', 'Invalid socket ID', { socketId: socket.id });
        return;
      }

      const queue = roomType === 'chat' ? chatQueue : videoQueue;
      const pairings = roomType === 'chat' ? chatPairings : videoPairings;

      // Check if already paired
      if (pairings.has(socket.id)) {
        Logger.info('find_partner', 'Already paired', { socketId: socket.id, roomType });
        socket.emit('already_paired', {});
        return;
      }

      const userData = socketMetadata.get(socket.id) || {};
      queue.push({
        socketId: socket.id,
        userData: userData,
        joinedAt: Date.now(),
      });
      socketQueues.set(socket.id, roomType);

      socket.emit('queued', {
        queuePosition: queue.length,
        type: roomType,
      });

      Logger.info('find_partner', 'User queued', {
        socketId: socket.id,
        roomType,
        queueSize: queue.length,
      });

      attemptMatch(roomType);
      broadcastStats();
    } catch (error) {
      Logger.error('find_partner', 'Error finding partner', error.message);
      socket.emit('error', { message: 'Failed to find partner' });
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
      const peerId = videoPairings.get(socket.id)?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        io.to(peerId).emit('makeCall', {
          sdpOffer: data,
          fromId: socket.id,
        });
      }
    } catch (error) {
      Logger.error('offer', 'Error sending offer', error.message);
    }
  });

  // WebRTC - answer
  socket.on('answer', (data) => {
    try {
      const peerId = videoPairings.get(socket.id)?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        io.to(peerId).emit('callAnswered', {
          sdpAnswer: data,
          fromId: socket.id,
        });
      }
    } catch (error) {
      Logger.error('answer', 'Error sending answer', error.message);
    }
  });

  // WebRTC - ICE candidates
  socket.on('IceCandidate', (data) => {
    try {
      const peerId = videoPairings.get(socket.id)?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        io.to(peerId).emit('IceCandidate', {
          iceCandidate: data,
          fromId: socket.id,
        });
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
});

// ========== CLEANUP & MAINTENANCE ==========
setInterval(() => {
  try {
    const now = Date.now();

    // Clean video queue
    for (let i = videoQueue.length - 1; i >= 0; i--) {
      if (now - videoQueue[i].joinedAt > CONFIG.STALE_TIMEOUT) {
        const socketId = videoQueue[i].socketId;
        videoQueue.splice(i, 1);
        socketQueues.delete(socketId);
        Logger.info('cleanup', 'Removed stale video queue entry', { socketId });
      }
    }

    // Clean chat queue
    for (let i = chatQueue.length - 1; i >= 0; i--) {
      if (now - chatQueue[i].joinedAt > CONFIG.STALE_TIMEOUT) {
        const socketId = chatQueue[i].socketId;
        chatQueue.splice(i, 1);
        socketQueues.delete(socketId);
        Logger.info('cleanup', 'Removed stale chat queue entry', { socketId });
      }
    }
  } catch (error) {
    Logger.error('cleanup', 'Error during cleanup', error.message);
  }
}, CONFIG.CLEANUP_INTERVAL);

// ========== SERVER STARTUP ==========
server.listen(CONFIG.PORT, CONFIG.SERVER_IP, () => {
  Logger.info('startup', `WebSocket server listening`, {
    host: CONFIG.SERVER_IP,
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
