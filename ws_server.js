const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(express.json());

// Separate queues and peer maps for video chat and text chat
const videoWaitingQueue = [];
const chatWaitingQueue = [];
const videoPeerMap = new Map(); // socketId -> partnerSocketId (video)
const chatPeerMap = new Map();  // socketId -> partnerSocketId (chat)
const userTypeMap = new Map();  // socketId -> 'video' or 'chat'

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

        io.to(room).emit('matched', { room, peers: [a, b], type: chatType });
        console.log(`Matched ${a} with ${b} in ${room} (${chatType})`);
    }
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
        const chatType = data.type || 'chat'; // default to 'chat' if not specified
        const waitingQueue = chatType === 'video' ? videoWaitingQueue : chatWaitingQueue;
        const peerMap = chatType === 'video' ? videoPeerMap : chatPeerMap;

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
        io.to(partnerId).emit('message', { from: socket.id, text: data });
    });

    socket.on('typing', (isTyping) => {
        let partnerId = videoPeerMap.get(socket.id) || chatPeerMap.get(socket.id);
        if (partnerId) io.to(partnerId).emit('typing', { from: socket.id, isTyping });
    });

    // WebRTC signalling relay (forward events to connected partner)
    socket.on('makeCall', (data) => {
        let partnerId = videoPeerMap.get(socket.id);
        if (partnerId) io.to(partnerId).emit('makeCall', data);
    });

    socket.on('answerCall', (data) => {
        let partnerId = videoPeerMap.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('answerCall', data);
        }
    });

    socket.on('IceCandidate', (data) => {
        let partnerId = videoPeerMap.get(socket.id);
        if (partnerId) io.to(partnerId).emit('IceCandidate', data);
    });

    // Client requests to leave current chat and optionally find a new partner
    socket.on('leave', (findNew = false) => {
        const userType = userTypeMap.get(socket.id);
        const peerMap = userType === 'video' ? videoPeerMap : chatPeerMap;
        const partnerId = peerMap.get(socket.id);
        
        if (partnerId) {
            io.to(partnerId).emit('partner_left');
            peerMap.delete(partnerId);
            
            // requeue partner so they can find a new match
            if (io.sockets.sockets.get(partnerId)) {
                const waitingQueue = userType === 'video' ? videoWaitingQueue : chatWaitingQueue;
                waitingQueue.push(partnerId);
            }
        }
        peerMap.delete(socket.id);
        socket.leaveAll();
        
        if (findNew && userType) {
            const waitingQueue = userType === 'video' ? videoWaitingQueue : chatWaitingQueue;
            if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
            socket.emit('left_and_searching');
            matchPeople(userType);
        }
    });

    socket.on('next', () => {
        const userType = userTypeMap.get(socket.id);
        const peerMap = userType === 'video' ? videoPeerMap : chatPeerMap;
        const waitingQueue = userType === 'video' ? videoWaitingQueue : chatWaitingQueue;
        const partnerId = peerMap.get(socket.id);
        
        if (partnerId) {
            // notify partner and requeue them
            io.to(partnerId).emit('partner_left');
            peerMap.delete(partnerId);
            if (io.sockets.sockets.get(partnerId)) {
                waitingQueue.push(partnerId);
            }
        }

        // remove current pairing and requeue this socket
        peerMap.delete(socket.id);
        socket.leaveAll();
        if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
        socket.emit('left_and_searching');
        matchPeople(userType);
    });

    socket.on('disconnect', (reason) => {
        console.log('disconnected:', socket.id, reason);
        
        const userType = userTypeMap.get(socket.id);
        
        // remove from both queues if present
        const videoQi = videoWaitingQueue.indexOf(socket.id);
        if (videoQi !== -1) videoWaitingQueue.splice(videoQi, 1);
        
        const chatQi = chatWaitingQueue.indexOf(socket.id);
        if (chatQi !== -1) chatWaitingQueue.splice(chatQi, 1);

        // Handle video chat disconnect
        if (videoPeerMap.has(socket.id)) {
            const partnerId = videoPeerMap.get(socket.id);
            videoPeerMap.delete(partnerId);
            videoPeerMap.delete(socket.id);
            io.to(partnerId).emit('partner_disconnected');
            if (io.sockets.sockets.get(partnerId)) {
                videoWaitingQueue.push(partnerId);
                matchPeople('video');
            }
        }
        
        // Handle chat disconnect
        if (chatPeerMap.has(socket.id)) {
            const partnerId = chatPeerMap.get(socket.id);
            chatPeerMap.delete(partnerId);
            chatPeerMap.delete(socket.id);
            io.to(partnerId).emit('partner_disconnected');
            if (io.sockets.sockets.get(partnerId)) {
                chatWaitingQueue.push(partnerId);
                matchPeople('chat');
            }
        }
        
        // Clean up user type
        userTypeMap.delete(socket.id);
        
        // broadcast updated online count after disconnect
        try {
            io.emit('online_count', io.engine.clientsCount || io.sockets.sockets.size);
        } catch (e) {
            console.warn('online_count emit failed on disconnect', e);
        }
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
});