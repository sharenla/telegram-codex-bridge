const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index');

test('unexpected exit restarts the backend even when there is no queued request', async () => {
  const activeRequests = { list: () => [], remove: () => {} };
  let restarts = 0;
  await _test.handleAppServerExitRequests({
    activeRequests,
    ackManager: { byRequestId: new Map(), restore: () => null, update: async () => {} },
    runtimeByChat: new Map(),
    restartBackend: async () => { restarts++; },
  });
  assert.equal(restarts, 1);
});

test('backend restart retries use one, five, and thirty second backoff', () => {
  assert.deepEqual([
    _test.getCodexRestartDelayMs(0),
    _test.getCodexRestartDelayMs(1),
    _test.getCodexRestartDelayMs(2),
  ], [1000, 5000, 30000]);
});

test('backend restart stops after the third retry and reports the three delays', async () => {
  const delays = [];
  let starts = 0;
  let exhausted = 0;
  const result = await _test.retryCodexServerStart(
    async () => { starts++; throw new Error('still unavailable'); },
    {
      wait: async delay => { delays.push(delay); },
      onExhausted: async () => { exhausted++; },
    },
  );
  assert.equal(result, false);
  assert.equal(starts, 4);
  assert.deepEqual(delays, [1000, 5000, 30000]);
  assert.equal(exhausted, 1);
});

test('ack reports that the backend is restarting while a request waits', async () => {
  const edits = [];
  const manager = new _test.TelegramAckManager({
    send: async () => ({ message_id: 42 }),
    edit: async params => { edits.push(params); },
  });
  const ack = await manager.start({ chatId: 7, requestId: 'restart01', item: { chatId: 7 } });
  await manager.update(ack, 'backendRestarting');
  await manager.flushDue(true);
  assert.match(edits[0].text, /后端正在重启，稍后自动处理/);
});
