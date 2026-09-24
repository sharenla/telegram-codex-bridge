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

test('T4.9a ruling limits one crash to three total starts', async () => {
  const delays = [];
  let starts = 0;
  const budget = _test.createCodexRestartBudget({ now: () => 0 });
  const result = await _test.retryCodexServerStart(async () => {
    starts++;
    throw new Error('failed');
  }, { budget, wait: async ms => delays.push(ms) });
  assert.equal(result, false);
  assert.equal(starts, 3);
  assert.deepEqual(delays, [1000, 5000]);
});

test('restart budget is shared across crashes and renews after five minutes', async () => {
  let now = 0;
  const budget = _test.createCodexRestartBudget({ now: () => now });
  let starts = 0;
  const start = async () => { starts++; return true; };
  assert.equal(await _test.retryCodexServerStart(start, { budget }), true);
  assert.equal(starts, 1);
  const delays = [];
  assert.equal(await _test.retryCodexServerStart(async () => {
    starts++;
    throw new Error('failed');
  }, { budget, wait: async ms => { delays.push(ms); now += ms; } }), false);
  assert.equal(starts, 3);
  assert.deepEqual(delays, [1000]);
  assert.equal(await _test.retryCodexServerStart(start, { budget }), false);
  assert.equal(starts, 3);
  now = 300001;
  assert.equal(budget.remaining(), 3);
  assert.equal(await _test.retryCodexServerStart(start, { budget }), true);
  assert.equal(starts, 4);
});

test('exhausted cross-crash budget reports a usable failure without starting again', async () => {
  const budget = _test.createCodexRestartBudget({ now: () => 0 });
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(budget.consume(), true);
  let starts = 0;
  let failure = null;
  assert.equal(await _test.retryCodexServerStart(async () => { starts++; }, {
    budget,
    onExhausted: async error => { failure = error; },
  }), false);
  assert.equal(starts, 0);
  assert.match(failure?.message || '', /restart budget/i);
});

test('auth-failure exit does not use the self-restart budget', async () => {
  const budget = _test.createCodexRestartBudget({ now: () => 0 });
  let starts = 0;
  await _test.handleAppServerExitRequests({
    activeRequests: { list: () => [], remove: () => {} },
    ackManager: { byRequestId: new Map(), restore: () => null, update: async () => {} },
    authFailure: true,
    restartBackend: async () => {
      starts++;
      await _test.retryCodexServerStart(async () => {}, { budget });
    },
  });
  assert.equal(starts, 0);
  assert.equal(budget.remaining(), 3);
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
