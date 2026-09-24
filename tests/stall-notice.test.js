const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index');

function fixture() {
  let now = 0;
  const edits = [];
  const entries = [{ requestId: 'stall01', chatId: 7, state: 'running' }];
  const ackManager = new _test.TelegramAckManager({
    now: () => now,
    send: async () => ({ message_id: 41 }),
    edit: async params => { edits.push(params); },
  });
  const monitor = new _test.TelegramStallMonitor({
    activeRequests: { list: () => entries }, ackManager, now: () => now,
  });
  return { edits, entries, ackManager, monitor, setNow: value => { now = value; } };
}

test('running request shows a five-minute notice on its existing ack and updates at ten minutes', async () => {
  const { edits, ackManager, monitor, setNow } = fixture();
  const ack = await ackManager.start({ chatId: 7, requestId: 'stall01' });
  await ackManager.update(ack, 'processing');
  monitor.markRunning('stall01');
  setNow(5 * 60 * 1000);
  await monitor.tick();
  assert.equal(edits.at(-1).message_id, 41);
  assert.match(edits.at(-1).text, /已有 5 分钟没有新进展/);
  setNow(6 * 60 * 1000);
  await monitor.tick();
  assert.match(edits.at(-1).text, /已有 5 分钟没有新进展/);
  setNow(10 * 60 * 1000);
  await monitor.tick();
  assert.equal(edits.at(-1).message_id, 41);
  assert.match(edits.at(-1).text, /已有 10 分钟没有新进展/);
});

test('a delta clears the stall line; 4:59 and terminal requests never get it', async () => {
  const { edits, entries, ackManager, monitor, setNow } = fixture();
  const ack = await ackManager.start({ chatId: 7, requestId: 'stall01' });
  await ackManager.update(ack, 'processing');
  monitor.markRunning('stall01');
  setNow(299000);
  await monitor.tick();
  assert.equal(edits.some(item => /没有新进展/.test(item.text)), false);
  setNow(300000);
  await monitor.tick();
  assert.match(edits.at(-1).text, /没有新进展/);
  setNow(303000);
  await monitor.noteProgress(7);
  assert.doesNotMatch(edits.at(-1).text, /没有新进展/);
  await ackManager.update(ack, 'completed');
  entries[0].state = 'completed';
  const count = edits.length;
  setNow(20 * 60 * 1000);
  await monitor.tick();
  assert.equal(edits.length, count);
});

test('stall notice interval is configurable without changing the default', async () => {
  assert.equal(_test.resolveTelegramStallNoticeMs({}), 300000);
  assert.equal(_test.resolveTelegramStallNoticeMs({ TELEGRAM_STALL_NOTICE_MS: '60000' }), 60000);
  const { edits, ackManager, entries, setNow } = fixture();
  let now = 0;
  const monitor = new _test.TelegramStallMonitor({
    activeRequests: { list: () => entries }, ackManager, now: () => now, stallNoticeMs: 60000,
  });
  const ack = await ackManager.start({ chatId: 7, requestId: 'stall01' });
  await ackManager.update(ack, 'processing');
  monitor.markRunning('stall01');
  now = 60000;
  setNow(60000);
  await monitor.tick();
  assert.match(edits.at(-1).text, /已有 1 分钟没有新进展/);
});
