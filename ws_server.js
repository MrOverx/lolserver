const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const port = process.env.PORT || 8080;
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(express.json());

// Configuration constants
const CONFIG = {
    CONNECTION_TIMEOUT: 30000,       // 30 seconds
    MAX_USERNAME_LENGTH: 50,
    MAX_REQUESTS_PER_MINUTE: 30,
    CLEANUP_INTERVAL: 60000          // 1 minute cleanup
};

// Separate queues and peer maps for video chat and text chat
const videoWaitingQueue = [];
const chatWaitingQueue = [];
const videoPeerMap = new Map(); // socketId -> partnerSocketId (video)
const chatPeerMap = new Map();  // socketId -> partnerSocketId (chat)
const userTypeMap = new Map();  // socketId -> 'video' or 'chat'
const userDataMap = new Map();  // socketId -> { userName, avatarColor, avatarLetter }
const requestRateLimitMap = new Map(); // socketId -> { count, resetTime }

// Validate user data before storing
function validateUserData(userData) {
    if (!userData || typeof userData !== 'object') return false;
    const { userName } = userData;
    if (!userName || typeof userName !== 'string' || userName.length > CONFIG.MAX_USERNAME_LENGTH) {
        return false;
    }
    return true;
}

// Check rate limiting per socket
function checkRateLimit(socketId) {
    const now = Date.now();
    const limitData = requestRateLimitMap.get(socketId) || { count: 0, resetTime: now + 60000 };
    
    if (now > limitData.resetTime) {
        limitData.count = 1;
        limitData.resetTime = now + 60000;
    } else {
        limitData.count++;
    }
    
    requestRateLimitMap.set(socketId, limitData);
    return limitData.count <= CONFIG.MAX_REQUESTS_PER_MINUTE;
}

// Periodic cleanup of orphaned socket entries
function cleanupOrphanedSockets() {
    // Clean video queue
    const validVideoQueue = videoWaitingQueue.filter(id => io.sockets.sockets.get(id));
    videoWaitingQueue.length = 0;
    videoWaitingQueue.push(...validVideoQueue);
    
    // Clean chat queue
    const validChatQueue = chatWaitingQueue.filter(id => io.sockets.sockets.get(id));
    chatWaitingQueue.length = 0;
    chatWaitingQueue.push(...validChatQueue);
    
    // Clean video peer map
    for (const [socketId] of videoPeerMap) {
        if (!io.sockets.sockets.get(socketId)) {
            const partnerId = videoPeerMap.get(socketId);
            videoPeerMap.delete(socketId);
            if (partnerId) videoPeerMap.delete(partnerId);
        }
    }
    
    // Clean chat peer map
    for (const [socketId] of chatPeerMap) {
        if (!io.sockets.sockets.get(socketId)) {
            const partnerId = chatPeerMap.get(socketId);
            chatPeerMap.delete(socketId);
            if (partnerId) chatPeerMap.delete(partnerId);
        }
    }
}

// Start cleanup timer
setInterval(cleanupOrphanedSockets, CONFIG.CLEANUP_INTERVAL);

function matchPeople(chatType) {
    const waitingQueue = chatType === 'video' ? videoWaitingQueue : chatWaitingQueue;
    const peerMap = chatType === 'video' ? videoPeerMap : chatPeerMap;
    
    while (waitingQueue.length >= 2) {
        const a = waitingQueue.shift();
        // skip sockets that disconnected
        if (!io.sockets.sockets.get(a)) continue;
        
        const b = waitingQueue.shift();
        if (!io.sockets.sockets.get(b)) {
            // put a back if b disconnected
            waitingQueue.unshift(a);
            continue;
        }

        // Verify both users are the same type
        if (userTypeMap.get(a) !== chatType || userTypeMap.get(b) !== chatType) {
            waitingQueue.unshift(a);
            waitingQueue.unshift(b);
            continue;
        }

        const room = `room_${chatType}_${a}_${b}`;
        peerMap.set(a, b);
        peerMap.set(b, a);

        io.sockets.sockets.get(a).join(room);
        io.sockets.sockets.get(b).join(room);

        // Get user data for both peers
        const userAData = userDataMap.get(a);
        const userBData = userDataMap.get(b);

        // Send matched event with remote user info to both peers
        io.to(a).emit('matched', { 
            room, 
            peers: [a, b], 
            type: chatType,
            remoteUser: userBData || { userName: 'Guest', avatarColor: '#FF9800', avatarLetter: 'G' }
        });
        io.to(b).emit('matched', { 
            room, 
            peers: [a, b], 
            type: chatType,
            remoteUser: userAData || { userName: 'Guest', avatarColor: '#FF9800', avatarLetter: 'G' }
        });
        
        console.log(`Matched ${a} with ${b} in ${room} (${chatType})`);
    }
}

// Decompose room: Clean up peer pairing and notify partner
function decomposeRoom(socketId, roomType, skipRequeue = false) {
    console.log(`[decomposeRoom] Decomposing ${roomType} room for socket ${socketId}`);
    
    if (!socketId || !roomType) {
        console.warn('[decomposeRoom] Invalid socketId or roomType');
        return;
    }

    const peerMap = roomType === 'video' ? videoPeerMap : chatPeerMap;
    const waitingQueue = roomType === 'video' ? videoWaitingQueue : chatWaitingQueue;
    const partnerId = peerMap.get(socketId);

    // Notify partner if exists
    if (partnerId && io.sockets.sockets.get(partnerId)) {
        try {
            io.to(partnerId).emit('partner_left');
            console.log(`[decomposeRoom] Notified partner ${partnerId} that ${socketId} left`);
        } catch (e) {
            console.error(`[decomposeRoom] Error notifying partner: ${e}`);
        }

        // Requeue partner to find new connection (unless this is a disconnect scenario)
        if (!skipRequeue) {
            if (io.sockets.sockets.get(partnerId) && !waitingQueue.includes(partnerId)) {
                waitingQueue.push(partnerId);
                console.log(`[decomposeRoom] Requeued partner ${partnerId} to find new match`);
                matchPeople(roomType);
            }
        }
    }

    // Remove both peers from peer map
    peerMap.delete(socketId);
    if (partnerId) {
        peerMap.delete(partnerId);
    }

    // Remove from room
    try {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.leaveAll();
            console.log(`[decomposeRoom] Socket ${socketId} left all rooms`);
        }
    } catch (e) {
        console.error(`[decomposeRoom] Error leaving rooms: ${e}`);
    }

    console.log(`[decomposeRoom] Room decomposed for ${socketId} (type: ${roomType})`);
}

io.on('connection', (socket) => {
    console.log('connected:', socket.id);

    // broadcast updated online count to all clients
    try {
        io.emit('online_count', io.engine.clientsCount || io.sockets.sockets.size);
    } catch (e) {
        console.warn('online_count emit failed', e);
    }

    // Client asks to find a partner (specify type: 'video' or 'chat')
    socket.on('find_partner', (data = {}) => {
        // Check rate limit to prevent spam
        if (!checkRateLimit(socket.id)) {
            socket.emit('error', { message: 'Too many requests. Please wait.' });
            console.warn(`[RateLimit] Blocked ${socket.id}`);
            return;
        }
        
        const chatType = data.type || 'chat'; // default to 'chat' if not specified
        const waitingQueue = chatType === 'video' ? videoWaitingQueue : chatWaitingQueue;
        const peerMap = chatType === 'video' ? videoPeerMap : chatPeerMap;

        // Store user data if provided and valid
        if (data.user) {
            if (!validateUserData(data.user)) {
                socket.emit('error', { message: 'Invalid user data' });
                console.warn(`[Validation] Invalid user data from ${socket.id}`);
                return;
            }
            const userData = {
                userName: data.user.userName.substring(0, CONFIG.MAX_USERNAME_LENGTH),
                userId: data.user.userId,
                avatarColor: data.user.avatarColor || '#FF9800',
                avatarLetter: data.user.avatarLetter || data.user.userName.charAt(0).toUpperCase()
            };
            userDataMap.set(socket.id, userData);
        }

        // Clean up any existing pairings in the opposite type
        if (chatType === 'video' && chatPeerMap.has(socket.id)) {
            const oldPartnerId = chatPeerMap.get(socket.id);
            chatPeerMap.delete(socket.id);
            chatPeerMap.delete(oldPartnerId);
            io.to(oldPartnerId).emit('partner_left');
        } else if (chatType === 'chat' && videoPeerMap.has(socket.id)) {
            const oldPartnerId = videoPeerMap.get(socket.id);
            videoPeerMap.delete(socket.id);
            videoPeerMap.delete(oldPartnerId);
            io.to(oldPartnerId).emit('partner_left');
        }

        // Remove from opposite queue if present
        if (chatType === 'video') {
            const chatQi = chatWaitingQueue.indexOf(socket.id);
            if (chatQi !== -1) chatWaitingQueue.splice(chatQi, 1);
        } else {
            const videoQi = videoWaitingQueue.indexOf(socket.id);
            if (videoQi !== -1) videoWaitingQueue.splice(videoQi, 1);
        }

        // Check if already paired in the same type
        if (peerMap.has(socket.id)) {
            socket.emit('already_paired');
            return;
        }

        // Register user type
        userTypeMap.set(socket.id, chatType);

        // Add to appropriate queue if not already there
        if (!waitingQueue.includes(socket.id)) {
            waitingQueue.push(socket.id);
            socket.emit('queued');
            console.log(`${socket.id} queued for ${chatType} pairing`);
        }

        matchPeople(chatType);
    });

    // Send chat message to partner
    socket.on('message', (data) => {
        // Check both peer maps
        let partnerId = videoPeerMap.get(socket.id) || chatPeerMap.get(socket.id);
        if (!partnerId) {
            socket.emit('error', { message: 'No partner connected' });
            return;
        }
        
        // Get sender's user data
        const senderData = userDataMap.get(socket.id) || { userName: 'Anonymous', avatarColor: '#FF9800', avatarLetter: 'A' };
        
        // Relay message with sender info
        if (typeof data === 'string') {
            // Old format: just text
            io.to(partnerId).emit('message', { 
                text: data,
                userName: senderData.userName,
                avatarColor: senderData.avatarColor,
                avatarLetter: senderData.avatarLetter
            });
        } else if (typeof data === 'object' && data.text) {
            // New format: object with text and optional user info
            io.to(partnerId).emit('message', { 
                text: data.text,
                userName: data.userName || senderData.userName,
                userId: data.userId,
                avatarColor: data.avatarColor || senderData.avatarColor,
                avatarLetter: data.avatarLetter || senderData.avatarLetter
            });
        }
    });

    socket.on('typing', (isTyping) => {
        let partnerId = videoPeerMap.get(socket.id) || chatPeerMap.get(socket.id);
        if (partnerId) io.to(partnerId).emit('typing', { from: socket.id, isTyping });
    });

    // WebRTC signalling relay (forward events to connected partner)
    socket.on('makeCall', (data) => {
        let partnerId = videoPeerMap.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('makeCall', data);
            console.log(`[WebRTC] Call initiated: ${socket.id} -> ${partnerId}`);
        } else {
            socket.emit('error', { message: 'No partner for call' });
            console.warn(`[WebRTC] No partner for makeCall from ${socket.id}`);
        }
    });

    socket.on('answerCall', (data) => {
        let partnerId = videoPeerMap.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('answerCall', data);
            console.log(`[WebRTC] Call answered: ${socket.id} -> ${partnerId}`);
        } else {
            socket.emit('error', { message: 'No partner for answer' });
            console.warn(`[WebRTC] No partner for answerCall from ${socket.id}`);
        }
    });

    socket.on('IceCandidate', (data) => {
        let partnerId = videoPeerMap.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('IceCandidate', data);
        } else {
            console.warn(`[WebRTC] No partner for ICE candidate from ${socket.id}`);
        }
    });

    // Explicit room leave event handler - triggered when user navigates away from room
    socket.on('room_leave', (data) => {
        const socketId = socket.id;
        const roomType = data?.type || userTypeMap.get(socketId);
        
        console.log(`[room_leave] Socket ${socketId} leaving ${roomType} room`);
        
        decomposeRoom(socketId, roomType, true);
    });

    // Handle switching from video chat to text chat with same partner
    socket.on('switch_to_chat', (data) => {
        const socketId = socket.id;
        const videoPeer = videoPeerMap.get(socketId);
        
        console.log(`[switch_to_chat] Socket ${socketId} switching from video to text chat`);
        
        if (videoPeer && io.sockets.sockets.get(videoPeer)) {
            // Notify partner about the switch
            try {
                io.to(videoPeer).emit('partner_switching_to_chat', {
                    message: 'Partner switched to text chat',
                });
                console.log(`[switch_to_chat] Notified partner ${videoPeer} about switch`);
            } catch (e) {
                console.error(`[switch_to_chat] Error notifying partner: ${e}`);
            }
        }
        
        // Move the user from video to text chat with same partner
        if (videoPeer) {
            // Remove from video pairing
            videoPeerMap.delete(socketId);
            videoPeerMap.delete(videoPeer);
            
            // Create chat pairing with same partner
            chatPeerMap.set(socketId, videoPeer);
            chatPeerMap.set(videoPeer, socketId);
            
            // Update user type to chat for this socket
            userTypeMap.set(socketId, 'chat');
            userTypeMap.set(videoPeer, 'chat');
            
            // Join chat rooms
            const chatRoom = `room_chat_${socketId}_${videoPeer}`;
            socket.join(chatRoom);
            io.sockets.sockets.get(videoPeer)?.join(chatRoom);
            
            // Notify both users that they're now in chat
            io.to(socketId).emit('switched_to_chat', {
                room: chatRoom,
                message: 'Switched to text chat',
            });
            io.to(videoPeer).emit('switched_to_chat', {
                room: chatRoom,
                message: 'Partner switched to text chat',
            });
            
            console.log(`[switch_to_chat] Successfully switched ${socketId} and ${videoPeer} to text chat in ${chatRoom}`);
        } else {
            console.log(`[switch_to_chat] No video partner found for ${socketId}`);
            socket.emit('error', { message: 'No partner connected for switching to chat' });
        }
    });

    // Client requests to leave current chat and optionally find a new partner
    socket.on('leave', (data) => {
        // Handle both old (boolean) and new (object with type) formats
        let findNew = false;
        let userType = userTypeMap.get(socket.id);
        
        if (typeof data === 'boolean') {
            findNew = data;
        } else if (typeof data === 'object' && data && data.type) {
            // New format with room type
            userType = data.type;
        }
        
        console.log(`[leave] Socket ${socket.id} leaving ${userType} room (findNew: ${findNew})`);
        
        const waitingQueue = userType === 'video' ? videoWaitingQueue : chatWaitingQueue;
        
        // Decompose current room
        decomposeRoom(socket.id, userType, true);
        
        // If requested, requeue to find new partner
        if (findNew && userType) {
            if (!waitingQueue.includes(socket.id)) {
                waitingQueue.push(socket.id);
                console.log(`[leave] Requeued ${socket.id} to find new ${userType} partner`);
            }
            socket.emit('left_and_searching');
            matchPeople(userType);
        }
    });

    socket.on('next', () => {
        const userType = userTypeMap.get(socket.id);
        console.log(`[next] Socket ${socket.id} requesting next ${userType} partner`);
        
        const waitingQueue = userType === 'video' ? videoWaitingQueue : chatWaitingQueue;
        
        // Decompose current room
        decomposeRoom(socket.id, userType, true);

        // Requeue this socket
        if (!waitingQueue.includes(socket.id)) {
            waitingQueue.push(socket.id);
            console.log(`[next] Requeued ${socket.id} to find next ${userType} partner`);
        }
        socket.emit('left_and_searching');
        matchPeople(userType);
    });

    socket.on('disconnect', (reason) => {
        console.log(`[disconnect] Socket ${socket.id} disconnected: ${reason}`);
        
        const userType = userTypeMap.get(socket.id);
        
        // Remove from both queues if present
        const videoQi = videoWaitingQueue.indexOf(socket.id);
        if (videoQi !== -1) {
            videoWaitingQueue.splice(videoQi, 1);
            console.log(`[disconnect] Removed ${socket.id} from video queue`);
        }
        
        const chatQi = chatWaitingQueue.indexOf(socket.id);
        if (chatQi !== -1) {
            chatWaitingQueue.splice(chatQi, 1);
            console.log(`[disconnect] Removed ${socket.id} from chat queue`);
        }

        // Decompose video room if exists
        if (videoPeerMap.has(socket.id)) {
            console.log(`[disconnect] Decomposing video room for ${socket.id}`);
            decomposeRoom(socket.id, 'video', false);
        }
        
        // Decompose chat room if exists
        if (chatPeerMap.has(socket.id)) {
            console.log(`[disconnect] Decomposing chat room for ${socket.id}`);
            decomposeRoom(socket.id, 'chat', false);
        }
        
        // Clean up user metadata
        userTypeMap.delete(socket.id);
        userDataMap.delete(socket.id);
        requestRateLimitMap.delete(socket.id);
        console.log(`[disconnect] Cleaned up metadata for ${socket.id}`);
        
        // Broadcast updated online count after disconnect
        try {
            io.emit('online_count', io.engine.clientsCount || io.sockets.sockets.size);
        } catch (e) {
            console.warn('[disconnect] online_count emit failed', e);
        }
    });
});

server.listen(port, '192.168.170.221', () => {
    console.log(`Server running on port ${port}`);
});