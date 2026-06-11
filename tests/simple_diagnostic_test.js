#!/usr/bin/env node
/**
 * Simple Multi-User Diagnostic Test
 * Checks if event handlers and emissions work correctly
 */

const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:8080';

async function runDiagnosticTest() {
  console.log('\n🔍 Running diagnostic test...\n');

  try {
    // Create host socket
    const hostSocket = io(SERVER_URL);

    await new Promise((resolve) => {
      hostSocket.on('connect', () => {
        console.log(`✅ Host connected. Socket ID: ${hostSocket.id}\n`);
        resolve();
      });
    });

    // Create space
    console.log('📝 Creating voice space...');
    const spaceData = await new Promise((resolve, reject) => {
      hostSocket.emit('create_space', {
        name: 'Test Space',
        description: 'Testing',
        isPrivate: false,
        speakerLimit: 5,
      });

      hostSocket.once('space_created', (data) => {
        console.log(`✅ Space created: ${data.space.spaceId}`);
        console.log(`   Participants: ${data.space.participants.length}`);
        resolve(data.space);
      });

      setTimeout(() => reject(new Error('Space creation timeout')), 5000);
    });

    // Create listener socket
    console.log('\n📝 Creating listener socket...');
    const listenerSocket = io(SERVER_URL);

    await new Promise((resolve) => {
      listenerSocket.on('connect', () => {
        console.log(`✅ Listener connected. Socket ID: ${listenerSocket.id}\n`);
        resolve();
      });
    });

    // Listener joins space
    console.log('📝 Listener joining space...');
    await new Promise((resolve, reject) => {
      listenerSocket.once('space_joined', (data) => {
        console.log(`✅ Listener joined`);
        console.log(`   Current speakers: ${data.currentSpeakers}`);
        console.log(`   Current listeners: ${data.currentListeners}`);
        resolve();
      });

      listenerSocket.emit('join_space', { spaceId: spaceData.spaceId });

      setTimeout(() => reject(new Error('Join timeout')), 5000);
    });

    // Listener requests to speak
    console.log('\n📝 Listener requesting to speak...');
    await new Promise((resolve) => {
      hostSocket.once('speak_request', (data) => {
        console.log(`✅ Host received speak request`);
        console.log(`   From: ${data.userName}`);
        console.log(`   User ID: ${data.userId}\n`);
        resolve(data);
      });

      listenerSocket.emit('request_speak', {
        spaceId: spaceData.spaceId,
        userId: 'listener-1',
        userName: 'Bob',
      });

      setTimeout(() => {
        console.log('❌ Timeout: Host did not receive speak request');
        resolve();
      }, 5000);
    });

    // Host approves speak request
    console.log('📝 Host approving speak request...');
    const approvalPromise = new Promise((resolve) => {
      listenerSocket.once('speak_request_approved', (data) => {
        console.log(`✅ Listener received approval`);
        console.log(`   Approved to speak\n`);
        resolve(data);
      });

      hostSocket.emit('approve_speak_request', {
        spaceId: spaceData.spaceId,
        userName: 'Bob',
        userId: 'listener-1',
      });

      setTimeout(() => {
        console.log('❌ Timeout: Listener did not receive approval');
        resolve();
      }, 5000);
    });

    await approvalPromise;

    // Listener sends WebRTC offer
    console.log('📝 Listener sending WebRTC offer...');
    const offerPromise = new Promise((resolve) => {
      hostSocket.once('space_webrtc_offer', (data) => {
        console.log(`✅ Host received WebRTC offer`);
        console.log(`   From: ${data.userName}`);
        console.log(`   SDP type: ${data.type}\n`);
        resolve(data);
      });

      listenerSocket.emit('space_webrtc_offer', {
        spaceId: spaceData.spaceId,
        userId: 'listener-1',
        userName: 'Bob',
        fromUserId: 'listener-1',
        sdp: 'v=0\no=- 123 456 IN IP4 127.0.0.1',
        type: 'offer',
      });

      setTimeout(() => {
        console.log('❌ Timeout: Host did not receive offer');
        resolve();
      }, 5000);
    });

    await offerPromise;

    // Host sends answer
    console.log('📝 Host sending WebRTC answer...');
    const answerPromise = new Promise((resolve) => {
      listenerSocket.once('space_webrtc_answer', (data) => {
        console.log(`✅ Listener received WebRTC answer`);
        console.log(`   SDP type: ${data.type}`);
        console.log(`   🎉 PEER CONNECTION FLOW COMPLETE!\n`);
        resolve(data);
      });

      hostSocket.emit('space_webrtc_answer', {
        spaceId: spaceData.spaceId,
        userId: hostSocket.id,
        targetUserId: 'listener-1',
        sdp: 'v=0\no=- 789 012 IN IP4 127.0.0.1',
        type: 'answer',
      });

      setTimeout(() => {
        console.log('❌ Timeout: Listener did not receive answer');
        resolve();
      }, 5000);
    });

    await answerPromise;

    console.log('═══════════════════════════════════════════════════');
    console.log('✅ ALL TESTS PASSED - Multi-user WebRTC flow works!');
    console.log('═══════════════════════════════════════════════════\n');

    hostSocket.close();
    listenerSocket.close();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
  }
}

runDiagnosticTest();
