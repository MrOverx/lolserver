#!/usr/bin/env node
/**
 * Multi-User WebRTC Flow Test
 * Tests: Host creates space → Listeners join → Request speak → Host approves → WebRTC peer connects
 */

const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:8080';
let testsPassed = 0;
let testsFailed = 0;

// Mock user profiles
const users = {
  host: { userId: 'user-host-001', userName: 'Alice (Host)', avatarColor: '#FF5733' },
  listener1: { userId: 'user-list-001', userName: 'Bob', avatarColor: '#33FF57' },
  listener2: { userId: 'user-list-002', userName: 'Charlie', avatarColor: '#3357FF' },
};

let testSpace = null;

async function createClient(user) {
  return new Promise((resolve) => {
    const socket = io(SERVER_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    socket.on('connect', () => {
      console.log(`✅ [${user.userName}] Connected. Socket ID: ${socket.id}`);
      resolve(socket);
    });

    socket.on('error', (err) => {
      console.error(`❌ [${user.userName}] Connection error:`, err);
    });
  });
}

async function testHostCreatesSpace(hostSocket, host) {
  return new Promise((resolve, reject) => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📍 Test 1: Host creates voice space');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    hostSocket.emit('create_space', {
      name: 'Multi-User WebRTC Test Space',
      description: 'Testing multi-user peer connections',
      isPrivate: false,
      speakerLimit: 5,
    });

    hostSocket.once('space_created', (data) => {
      try {
        if (data && data.success && data.space) {
          testSpace = data.space;
          console.log(`✅ Space created: ${testSpace.spaceId}`);
          console.log(`   Host: ${testSpace.hostName}`);
          console.log(`   Participants: ${testSpace.participants.length}`);
          testsPassed++;
          resolve();
        } else {
          throw new Error('Invalid response from create_space');
        }
      } catch (err) {
        console.error(`❌ Error:`, err.message);
        testsFailed++;
        reject(err);
      }
    });

    setTimeout(() => {
      console.error('❌ Timeout: space_created event not received');
      testsFailed++;
      reject(new Error('Timeout'));
    }, 5000);
  });
}

async function testListenerJoins(listenerSocket, listener) {
  return new Promise((resolve, reject) => {
    console.log(`\n📍 Test 2.${listener.userId.endsWith('001') ? '1' : '2'}: Listener joins space`);

    const onSpaceJoined = (data) => {
      try {
        if (data && data.spaceId === testSpace.spaceId) {
          console.log(`✅ [${listener.userName}] Joined space`);
          console.log(`   Current speakers: ${data.currentSpeakers || 0}`);
          console.log(`   Current listeners: ${data.currentListeners || 0}`);
          testsPassed++;
          listenerSocket.off('space_joined', onSpaceJoined);
          resolve();
        }
      } catch (err) {
        console.error(`❌ Error:`, err.message);
        testsFailed++;
        listenerSocket.off('space_joined', onSpaceJoined);
        reject(err);
      }
    };

    listenerSocket.on('space_joined', onSpaceJoined);

    listenerSocket.emit('join_space', {
      spaceId: testSpace.spaceId,
    });

    setTimeout(() => {
      console.error(
        `❌ Timeout: space_joined event not received for ${listener.userName}`
      );
      testsFailed++;
      listenerSocket.off('space_joined', onSpaceJoined);
      reject(new Error('Timeout'));
    }, 5000);
  });
}

async function testListenerRequestsToSpeak(listenerSocket, listener) {
  return new Promise((resolve, reject) => {
    console.log(`\n📍 Test 3.${listener.userId.endsWith('001') ? '1' : '2'}: Listener requests to speak`);

    listenerSocket.emit('request_speak', {
      spaceId: testSpace.spaceId,
      userId: listener.userId,
      userName: listener.userName,
    });

    console.log(`✅ [${listener.userName}] Sent speak request`);
    testsPassed++;
    resolve();
  });
}

async function testHostReceivesSpeakRequest(hostSocket) {
  return new Promise((resolve, reject) => {
    console.log('\n📍 Test 4: Host receives speak request');

    const onSpeakRequest = (data) => {
      try {
        console.log(`✅ Host received speak request from: ${data.userName}`);
        console.log(`   User ID: ${data.userId}`);
        hostSocket.off('speak_request', onSpeakRequest);
        testsPassed++;
        resolve(data);
      } catch (err) {
        console.error(`❌ Error:`, err.message);
        testsFailed++;
        hostSocket.off('speak_request', onSpeakRequest);
        reject(err);
      }
    };

    hostSocket.on('speak_request', onSpeakRequest);

    setTimeout(() => {
      console.error('❌ Timeout: speak_request event not received');
      testsFailed++;
      hostSocket.off('speak_request', onSpeakRequest);
      reject(new Error('Timeout'));
    }, 5000);
  });
}

async function testHostApprovesSpeak(hostSocket, speakerData) {
  return new Promise((resolve, reject) => {
    console.log(`\n📍 Test 5: Host approves ${speakerData.userName}'s speak request`);

    hostSocket.emit('approve_speak_request', {
      spaceId: testSpace.spaceId,
      userName: speakerData.userName,
      userId: speakerData.userId,
    });

    console.log(`✅ Host approved speak request`);
    testsPassed++;
    resolve();
  });
}

async function testListenerReceivesApproval(listenerSocket, listener) {
  return new Promise((resolve, reject) => {
    console.log(`\n📍 Test 6: Listener receives approval`);

    const onApproved = (data) => {
      try {
        if (data && data.userName === listener.userName) {
          console.log(`✅ [${listener.userName}] Received approval to speak`);
          console.log(`   Can now start WebRTC peer connection`);
          listenerSocket.off('speak_request_approved', onApproved);
          testsPassed++;
          resolve();
        }
      } catch (err) {
        console.error(`❌ Error:`, err.message);
        testsFailed++;
        listenerSocket.off('speak_request_approved', onApproved);
        reject(err);
      }
    };

    listenerSocket.on('speak_request_approved', onApproved);

    setTimeout(() => {
      console.error('❌ Timeout: speak_request_approved event not received');
      testsFailed++;
      listenerSocket.off('speak_request_approved', onApproved);
      reject(new Error('Timeout'));
    }, 5000);
  });
}

async function testSpeakerEmitsOffer(listenerSocket, listener) {
  return new Promise((resolve, reject) => {
    console.log(`\n📍 Test 7: Speaker emits WebRTC offer`);

    // Simulate speaker emitting offer
    listenerSocket.emit('space_webrtc_offer', {
      spaceId: testSpace.spaceId,
      userId: listener.userId,
      userName: listener.userName,
      fromUserId: listener.userId,
      sdp: 'fake-offer-sdp-for-testing',
      type: 'offer',
    });

    console.log(`✅ [${listener.userName}] Emitted WebRTC offer`);
    testsPassed++;
    resolve();
  });
}

async function testHostReceivesOfferAndAnswers(hostSocket, listener) {
  return new Promise((resolve, reject) => {
    console.log(`\n📍 Test 8: Host receives offer and sends answer`);

    const onOffer = (data) => {
      try {
        if (data && data.userId === listener.userId) {
          console.log(`✅ Host received offer from: ${data.userName}`);
          console.log(`   Offer SDP: ${data.sdp.substring(0, 30)}...`);

          // Simulate host sending answer
          hostSocket.emit('space_webrtc_answer', {
            spaceId: testSpace.spaceId,
            userId: hostSocket.id,
            targetUserId: listener.userId,
            sdp: 'fake-answer-sdp-for-testing',
            type: 'answer',
          });

          console.log(`✅ Host sent WebRTC answer back to speaker`);

          hostSocket.off('space_webrtc_offer', onOffer);
          testsPassed++;
          resolve();
        }
      } catch (err) {
        console.error(`❌ Error:`, err.message);
        testsFailed++;
        hostSocket.off('space_webrtc_offer', onOffer);
        reject(err);
      }
    };

    hostSocket.on('space_webrtc_offer', onOffer);

    setTimeout(() => {
      console.error('❌ Timeout: space_webrtc_offer event not received');
      testsFailed++;
      hostSocket.off('space_webrtc_offer', onOffer);
      reject(new Error('Timeout'));
    }, 5000);
  });
}

async function testSpeakerReceivesAnswer(listenerSocket, listener) {
  return new Promise((resolve, reject) => {
    console.log(`\n📍 Test 9: Speaker receives answer from host`);

    const onAnswer = (data) => {
      try {
        if (data && data.targetUserId === listener.userId) {
          console.log(`✅ Speaker received answer from host`);
          console.log(`   Answer SDP: ${data.sdp.substring(0, 30)}...`);
          console.log(`   🎉 Peer connection flow complete!`);

          listenerSocket.off('space_webrtc_answer', onAnswer);
          testsPassed++;
          resolve();
        }
      } catch (err) {
        console.error(`❌ Error:`, err.message);
        testsFailed++;
        listenerSocket.off('space_webrtc_answer', onAnswer);
        reject(err);
      }
    };

    listenerSocket.on('space_webrtc_answer', onAnswer);

    setTimeout(() => {
      console.error('❌ Timeout: space_webrtc_answer event not received');
      testsFailed++;
      listenerSocket.off('space_webrtc_answer', onAnswer);
      reject(new Error('Timeout'));
    }, 5000);
  });
}

async function runAllTests() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║        Multi-User WebRTC Flow - Comprehensive Test              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  try {
    // Create clients
    console.log('\n🔌 Connecting clients...');
    const hostSocket = await createClient(users.host);
    const listener1Socket = await createClient(users.listener1);
    const listener2Socket = await createClient(users.listener2);

    // Wait for all connections to settle
    await new Promise((r) => setTimeout(r, 1000));

    // Test sequence
    await testHostCreatesSpace(hostSocket, users.host);
    await new Promise((r) => setTimeout(r, 500));

    await testListenerJoins(listener1Socket, users.listener1);
    await testListenerJoins(listener2Socket, users.listener2);
    await new Promise((r) => setTimeout(r, 500));

    await testListenerRequestsToSpeak(listener1Socket, users.listener1);
    await new Promise((r) => setTimeout(r, 500));

    const speakerData = await testHostReceivesSpeakRequest(hostSocket);
    await new Promise((r) => setTimeout(r, 500));

    await testHostApprovesSpeak(hostSocket, speakerData);
    await new Promise((r) => setTimeout(r, 500));

    await testListenerReceivesApproval(listener1Socket, users.listener1);
    await new Promise((r) => setTimeout(r, 500));

    await testSpeakerEmitsOffer(listener1Socket, users.listener1);
    await new Promise((r) => setTimeout(r, 500));

    await testHostReceivesOfferAndAnswers(hostSocket, users.listener1);
    await new Promise((r) => setTimeout(r, 500));

    await testSpeakerReceivesAnswer(listener1Socket, users.listener1);

    // Cleanup
    hostSocket.close();
    listener1Socket.close();
    listener2Socket.close();

    // Results
    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║                        Test Results                             ║');
    console.log('╠════════════════════════════════════════════════════════════════╣');
    console.log(`║ ✅ Passed: ${testsPassed}                                                      ║`);
    console.log(
      `║ ❌ Failed: ${testsFailed}                                                      ║`
    );
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n❌ Fatal test error:', err.message);
    process.exit(1);
  }
}

runAllTests();
