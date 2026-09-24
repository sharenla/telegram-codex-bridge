const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _test } = require('../index');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-server-exit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new _test.Store(path.join(dir, 'store.json'));
  const activeRequests = new _test.TelegramActiveRequests(store);
  const sent = [];
  const edits = [];
  const ackManager = new _test.TelegramAckManager({
    send: async params => { sent.push(params); return { message_id: 90 }; },
    edit: async params => { edits.push(params); },
  });
  return { activeRequests, ackManager, sent, edits };
}

test('unexpected app-server exit interrupts each running request on its existing ack', async t => {
  const { activeRequests, ackManager, sent, edits } = fixture(t);
  activeRequests.create({ requestId: 'crash01', chatId: 7, ackMessageId: 90, state: 'running', text: 'work', kind: 'user' });
  const runtimeByChat = new Map([[7, { activeTurnId: 'turn-1', pendingTasks: [] }]]);
  let cleared = 0;
  await _test.handleAppServerExitRequests({
    activeRequests, ackManager, runtimeByChat,
    clearTurnState: () => { cleared++; },
    restartQueued: async () => {},
  });
  assert.equal(activeRequests.list().length, 0);
  assert.equal(sent.length, 0);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].message_id, 90);
  assert.equal(edits[0].text, '⚠️ Codex 后端意外退出，这条任务已中断，请确认后重发（#crash01）');
  assert.equal(cleared, 1);
});

test('queued requests stay queued and request a backend restart', async t => {
  const { activeRequests, ackManager } = fixture(t);
  activeRequests.create({ requestId: 'queued01', chatId: 7, ackMessageId: 90, state: 'queued', text: 'later', kind: 'user' });
  const runtimeByChat = new Map([[7, { activeTurnId: null, pendingTasks: [{ ack: { requestId: 'queued01' } }] }]]);
  let restarts = 0;
  await _test.handleAppServerExitRequests({
    activeRequests, ackManager, runtimeByChat,
    clearTurnState: () => {}, restartQueued: async () => { restarts++; },
  });
  assert.equal(activeRequests.list()[0].requestId, 'queued01');
  assert.equal(restarts, 1);
});

test('expected exit leaves active requests untouched', async t => {
  const { activeRequests } = fixture(t);
  activeRequests.create({ requestId: 'expected01', chatId: 7, state: 'running', text: 'work', kind: 'user' });
  assert.equal(await _test.handleAppServerExitRequests({ expected: true, activeRequests }), undefined);
  assert.equal(activeRequests.list().length, 1);
});

test('auth failure exit removes running ledger entries for the auth recovery path', async t => {
  const { activeRequests, ackManager } = fixture(t);
  activeRequests.create({ requestId: 'auth01', chatId: 7, ackMessageId: 90, state: 'running', text: 'work', kind: 'user' });
  await _test.handleAppServerExitRequests({
    activeRequests, ackManager, runtimeByChat: new Map(), authFailure: true,
    clearTurnState: () => {}, restartQueued: async () => { throw new Error('must not restart'); },
  });
  assert.equal(activeRequests.list().length, 0);
});
