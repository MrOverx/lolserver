const io = require('socket.io-client');

function waitForEvent(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const onEvent = (data) => {
      clearTimeout(t);
      resolve(data);
    };
    socket.once(event, onEvent);
    const t = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error('timeout waiting for ' + event));
    }, timeout);
  });
}

async function run() {
  const serverUrl = process.env.SERVER_URL || 'http://localhost:8080';

  console.log('Connecting host...');
  const host = io(serverUrl, { transports: ['websocket'] });
  await waitForEvent(host, 'connect', 5000).catch(() => {});
  console.log('Host connected:', host.id);

  await new Promise(res => host.emit('register_user', { userId: 'host_test', userName: 'HostTest' }, res));
  console.log('Host registered');

  console.log('Creating space...');
  const hostCreatedEvent = waitForEvent(host, 'space_created', 5000).catch(() => null);
  const hostSpaceUpdatedEvent = waitForEvent(host, 'space_updated', 5000).catch(() => null);

  const spaceResp = await new Promise((resolve) => {
    host.emit('create_space', { userId: 'host_test', spaceName: 'SmokeTestSpace' }, (r) => resolve(r));
  });

  if (!spaceResp || !spaceResp.success) {
    console.error('Create space failed', spaceResp);
    process.exit(1);
  }
  const space = spaceResp.space;
  console.log('Space created:', space.spaceId);

  const createdEvent = await hostCreatedEvent;
  if (!createdEvent || !createdEvent.success) {
    console.error('Host did not receive space_created event', createdEvent);
    process.exit(1);
  }
  console.log('Host received space_created event');

  const updatedEvent = await hostSpaceUpdatedEvent;
  if (!updatedEvent || updatedEvent.spaceId !== space.spaceId) {
    console.error('Host did not receive expected space_updated event', updatedEvent);
    process.exit(1);
  }
  console.log('Host received space_updated event');

  console.log('Connecting participant...');
  const part = io(serverUrl, { transports: ['websocket'] });
  await waitForEvent(part, 'connect', 5000).catch(() => {});
  console.log('Participant connected:', part.id);

  await new Promise(res => part.emit('register_user', { userId: 'part_test', userName: 'PartTest' }, res));
  console.log('Participant registered');

  const partJoinedEvent = waitForEvent(part, 'space_joined', 5000).catch(() => null);
  const partSpaceUpdatedEvent = waitForEvent(part, 'space_updated', 5000).catch(() => null);

  const joinResp = await new Promise((resolve) => {
    part.emit('join_space', { userId: 'part_test', spaceId: space.spaceId }, (r) => resolve(r));
  });
  console.log('Join response:', joinResp);

  const joinedEvent = await partJoinedEvent;
  if (!joinedEvent || !joinedEvent.success) {
    console.error('Participant did not receive space_joined event', joinedEvent);
    process.exit(1);
  }
  console.log('Participant received space_joined event');

  const participantUpdated = await partSpaceUpdatedEvent;
  if (!participantUpdated || participantUpdated.spaceId !== space.spaceId) {
    console.error('Participant did not receive expected space_updated event', participantUpdated);
    process.exit(1);
  }
  console.log('Participant received space_updated event');

  // leave
  const leaveResp = await new Promise((resolve) => {
    part.emit('leave_space', { userId: 'part_test', spaceId: space.spaceId }, (r) => resolve(r));
  });
  console.log('Leave response:', leaveResp);

  // Re-join to test host leave cleanup
  const joinResp2 = await new Promise((resolve) => {
    part.emit('join_space', { userId: 'part_test', spaceId: space.spaceId }, (r) => resolve(r));
  });
  console.log('Re-join response:', joinResp2);

  // Host leaves the space to trigger room closure
  console.log('Host leaving space to trigger space close...');
  const closedByHostPromise = waitForEvent(part, 'space_closed_by_host', 5000).catch(() => null);
  const hostLeaveResp = await new Promise((resolve) => {
    host.emit('leave_space', { userId: 'host_test', spaceId: space.spaceId }, (r) => resolve(r));
  });
  console.log('Host leave response:', hostLeaveResp);

  if (!hostLeaveResp || !hostLeaveResp.success) {
    console.error('Host leave failed', hostLeaveResp);
    process.exit(1);
  }

  const closedByHost = await closedByHostPromise;
  if (!closedByHost || closedByHost.spaceId !== space.spaceId || closedByHost.reason !== 'host_disconnected') {
    console.error('Participant did not receive expected space_closed_by_host on host leave', closedByHost);
    process.exit(1);
  }
  console.log('Participant received space_closed_by_host on host leave');

  host.disconnect();
  part.disconnect();
  console.log('Test complete');
  process.exit(0);
}

run().catch(err => {
  console.error('Smoke test error', err);
  process.exit(1);
});
