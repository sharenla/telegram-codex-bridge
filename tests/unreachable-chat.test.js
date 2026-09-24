const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { _test } = require('../index');
const GROUP_CHAT_ID = -(1000000000 + 2345);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-unreachable-'));
  const store = new _test.Store(path.join(dir, 'store.json'));
  const notices = [];
  const logs = [];
  const notifier = new _test.TelegramUnreachableChatNotifier({
    store,
    allowlist: new Set([123456789]),
    getBotName: () => 'TestBot',
    outbox: { enqueue: (params, options) => { notices.push({ params, options }); return {}; } },
    logger: event => logs.push(event),
    now: () => fixture.now,
  });
  return { dir, store, notifier, notices, logs };
}
fixture.now = 0;

test('group permanent reject records and privately notifies without exposing full chat id', async t => {
  const { dir, store, notifier, notices, logs } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fixture.now = 1;
  await notifier.handlePermanentReject({ chatId: GROUP_CHAT_ID }, { body: { error_code: 403, description: 'Forbidden: bot was kicked' } });
  assert.equal(notices.length, 1);
  assert.match(notices[0].params.text, /TestBot/);
  assert.match(notices[0].params.text, /bot 已被移出群或无发言权限/);
  assert.match(notices[0].params.text, /已有 1 条回复未送达/);
  assert.doesNotMatch(notices[0].params.text, /1001234567890/);
  assert.equal(Object.keys(store.data.telegram.unreachableChats).length, 1);
  assert.equal(logs.some(line => JSON.stringify(line).includes('1001234567890')), false);
});

test('same chat is rate limited for 24 hours and clears after a successful delivery', async t => {
  const { dir, notifier, notices } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fixture.now = 1;
  await notifier.handlePermanentReject({ chatId: GROUP_CHAT_ID }, { body: { description: 'chat not found' } });
  fixture.now = 2;
  await notifier.handlePermanentReject({ chatId: GROUP_CHAT_ID }, { body: { description: 'chat not found' } });
  assert.equal(notices.length, 1);
  assert.equal(notifier.store.data.telegram.unreachableChats[String(GROUP_CHAT_ID)].dropped, 2);
  await notifier.onDelivered({ chatId: GROUP_CHAT_ID });
  assert.equal(Object.keys(notifier.store.data.telegram.unreachableChats).length, 0);
});

test('permanent reject on maintainer private chat does not create a notification loop', async t => {
  const { dir, notifier, notices } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await notifier.handlePermanentReject({ chatId: 123456789 }, { body: { error_code: 403, description: 'bot was blocked' } });
  assert.equal(notices.length, 0);
});

test('status count reports unreachable chats separately from outbox counters', () => {
  const store = { data: { telegram: { unreachableChats: { [String(GROUP_CHAT_ID)]: {}, [String(GROUP_CHAT_ID - 1)]: {} } } } };
  assert.equal(_test.getUnreachableChatCount(store), 2);
});

test('outbox permanent reject invokes the maintainer notifier hook', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-unreachable-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new _test.Store(path.join(dir, 'store.json'));
  const sent = [];
  let notifier;
  const outbox = new _test.TelegramOutbox(store, {
    send: async params => { sent.push(params); if (params.chat_id === GROUP_CHAT_ID) throw Object.assign(new Error('forbidden'), { body: { error_code: 403 } }); return { message_id: 1 }; },
    onPermanentReject: (item, error) => notifier.handlePermanentReject(item, error),
  });
  notifier = new _test.TelegramUnreachableChatNotifier({
    store, outbox, allowlist: new Set([123456789]), getBotName: () => 'TestBot', now: () => 1,
  });
  const item = outbox.enqueue({ chat_id: GROUP_CHAT_ID, text: 'reply' });
  await assert.rejects(outbox.deliver(item));
  assert.equal(sent.some(params => params.chat_id === 123456789), true);
});
