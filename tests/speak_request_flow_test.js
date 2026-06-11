#!/usr/bin/env node
/**
 * Speak Request Flow Validation
 * Tests: request_speak → host receives → host approves → listener receives approval
 */

const io = require('socket.io-client');
const SERVER_URL = 'http://localhost:8080';

async function test() {
  console.log('\n📋 Testing Speak Request Flow\n');

  try {
    const host = io(SERVER_URL);
    const listener = io(SERVER_URL);

    // Wait for connections
    await Promise.all([
      new Promise((r) =>
        host.on('connect', () => {
          console.log(`✅ Host connected (${host.id})`);
          r();
        })
      ),
      new Promise((r) =>
        listener.on('connect', () => {
          console.log(`✅ Listener connected (${listener.id})`);
          r();
        })
      ),
    ]);

    // Create space
    console.log('\n📝 Creating space...');
    const space = await new Promise((r, j) => {
      host.emit('create_space', { name: 'Test', description: 'Test' });
      host.once('space_created', (d) => {
        console.log(`✅ Space created (${d.space.spaceId})`);
        r(d.space);
      });
      setTimeout(() => j(new Error('Timeout creating space')), 3000);
    });

    // Join space
    console.log('\n📝 Listener joining space...');
    await new Promise((r, j) => {
      listener.emit('join_space', { spaceId: space.spaceId });
      listener.once('space_joined', (d) => {
        console.log(`✅ Listener joined`);
        r();
      });
      setTimeout(() => j(new Error('Timeout joining space')), 3000);
    });

    // Request to speak
    console.log('\n📝 Testing request_speak event...');
    await new Promise((r, j) => {
      host.once('speak_request', (d) => {
        console.log(`✅ Host received speak_request`);
        console.log(`   From: ${d.userName}`);
        r(d);
      });

      listener.emit('request_speak', {
        spaceId: space.spaceId,
        userId: listener.id,
        userName: 'TestListener',
      });

      setTimeout(() => j(new Error('Timeout receiving speak_request')), 3000);
    });

    // Approve speak request
    console.log('\n📝 Testing approve_speak_request event...');
    await new Promise((r, j) => {
      listener.once('speak_request_approved', (d) => {
        console.log(`✅ Listener received speak_request_approved`);
        console.log(`   Speaker: ${d.userName}`);
        r(d);
      });

      host.emit('approve_speak_request', {
        spaceId: space.spaceId,
        userName: 'TestListener',
        userId: listener.id,
      });

      setTimeout(() => j(new Error('Timeout receiving approve_speak_request')), 3000);
    });

    // Test WebRTC offer
    console.log('\n📝 Testing space_webrtc_offer event...');
    await new Promise((r, j) => {
      host.once('space_webrtc_offer', (d) => {
        console.log(`✅ Host received space_webrtc_offer`);
        console.log(`   From: ${d.userName}`);
        r(d);
      });

      listener.emit('space_webrtc_offer', {
        spaceId: space.spaceId,
        userId: listener.id,
        userName: 'TestListener',
        fromUserId: listener.id,
        sdp: 'test-sdp',
        type: 'offer',
      });

      setTimeout(() => j(new Error('Timeout receiving space_webrtc_offer')), 3000);
    });

    // Test WebRTC answer
    console.log('\n📝 Testing space_webrtc_answer event...');
    await new Promise((r, j) => {
      listener.once('space_webrtc_answer', (d) => {
        console.log(`✅ Listener received space_webrtc_answer`);
        console.log(`   Type: ${d.type}`);
        r(d);
      });

      host.emit('space_webrtc_answer', {
        spaceId: space.spaceId,
        userId: host.id,
        targetUserId: listener.id,
        sdp: 'test-answer-sdp',
        type: 'answer',
      });

      setTimeout(() => j(new Error('Timeout receiving space_webrtc_answer')), 3000);
    });

    console.log('\n✅ ═══════════════════════════════════════════\n');
    console.log('   ALL TESTS PASSED! ✅');
    console.log('   Speak request flow and WebRTC routing work!\n');
    console.log('═══════════════════════════════════════════\n');

    host.close();
    listener.close();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    console.error('   Make sure backend is running on port 8080\n');
    process.exit(1);
  }
}

test();
