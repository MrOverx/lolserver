const io = require('socket.io-client');

const SERVER = process.env.SERVER_URL || 'http://localhost:8080';
const SPACE_ID = 'space_test_001';

function connectClient(userId, userName) {
  const socket = io(SERVER, {
    transports: ['websocket'],
    query: { userId },
    reconnectionAttempts: 3,
    timeout: 5000,
  });

  socket.on('connect', () => {
    console.log(`[${userName}] connected: ${socket.id}`);
    socket.emit('register_user', { userId, userName, avatarLetter: (userName||'U')[0] }, (res) => {
      console.log(`[${userName}] register_user callback`, res);
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${userName}] disconnected: ${reason}`);
  });

  socket.on('error', (err) => {
    console.error(`[${userName}] socket error`, err);
  });

  return socket;
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('Starting signaling test. Server:', SERVER);

  const host = connectClient('host_1', 'HostOne');
  const listener = connectClient('listener_1', 'ListenerOne');

  host.on('speak_request', (data) => {
    console.log('[HostOne] speak_request received ->', data);
  });

  host.on('webrtc_offer', (data) => {
    console.log('[HostOne] webrtc_offer received ->', data);
    // Simulate host answering the offer and sending an ICE candidate back to the listener
    host.emit('webrtc_answer', {
      spaceId: SPACE_ID,
      userId: 'host_1',
      fromUserId: 'host_1',
      targetUserId: 'listener_1',
      sdp: 'v=0\n...answer...',
      type: 'answer',
    });
    host.emit('webrtc_ice_candidate', {
      spaceId: SPACE_ID,
      userId: 'host_1',
      targetUserId: 'listener_1',
      candidate: {
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.2 3478 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
  });

  listener.on('webrtc_answer', (data) => {
    console.log('[ListenerOne] webrtc_answer received ->', data);
  });

  host.on('webrtc_ice_candidate', (data) => {
    console.log('[HostOne] webrtc_ice_candidate received ->', data);
  });

  listener.on('webrtc_ice_candidate', (data) => {
    console.log('[ListenerOne] webrtc_ice_candidate received ->', data);
  });

  listener.on('speak_request_approved', (data) => {
    console.log('[ListenerOne] speak_request_approved ->', data);
  });

  listener.on('speak_request_declined', (data) => {
    console.log('[ListenerOne] speak_request_declined ->', data);
  });

  // Wait for both to connect
  await delay(1000);

  console.log('Host creating space...');
  host.emit('create_space', {
    spaceId: SPACE_ID,
    name: 'Test Space',
    description: 'Integration test space',
    isPrivate: true,
    speakerLimit: 3,
  }, (res) => {
    console.log('[HostOne] create_space callback', res);
  });

  await delay(500);

  console.log('Listener joining space...');
  listener.emit('join_space', { spaceId: SPACE_ID, userId: 'listener_1', userName: 'ListenerOne' }, (res) => {
    console.log('[ListenerOne] join_space callback', res);
  });

  await delay(500);

  console.log('Listener requesting to speak...');
  listener.emit('request_speak', { spaceId: SPACE_ID, userId: 'listener_1', userName: 'ListenerOne' });

  // Wait for host to get event and approve
  await delay(800);

  console.log('Host approving speak request...');
  host.emit('approve_speak_request', { spaceId: SPACE_ID, userName: 'ListenerOne' });

  await delay(800);

  console.log('Listener sending fake webrtc offer to host (forwarding test)...');
  listener.emit('webrtc_offer', {
    spaceId: SPACE_ID,
    userId: 'listener_1',
    userName: 'ListenerOne',
    fromUserId: 'listener_1',
    targetUserId: 'host_1',
    sdp: 'v=0\n...',
    type: 'offer'
  });

  listener.emit('webrtc_ice_candidate', {
    spaceId: SPACE_ID,
    userId: 'listener_1',
    targetUserId: 'host_1',
    candidate: {
      candidate: 'candidate:2 1 UDP 2122252542 192.168.1.3 3478 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  });

  await delay(1000);

  console.log('Test complete. Closing sockets.');
  host.disconnect();
  listener.disconnect();

  process.exit(0);
})();
