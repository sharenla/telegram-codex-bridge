const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { TelegramAckManager } } = require('../index');

function setup(t, now = 0) {
  const sent = [];
  const edits = [];
  const logs = [];
  const persisted = [];
  const manager = new TelegramAckManager({
    now: () => now,
    send: async (params) => { sent.push(params); return { message_id: 41 }; },
    edit: async (params) => { edits.push(params); return { ok: true }; },
    persist: async item => { persisted.push(item.ackMessageId); },
    logger: event => logs.push(event),
  });
  return { manager, sent, edits, logs, persisted, setNow: value => { now = value; } };
}

test('ack sends one notice and persists its message id', async t => {
  const { manager, sent, persisted } = setup(t);
  const item = { chatId: 7, ackMessageId: null };
  const ack = await manager.start({ chatId: 7, requestId: 'a1b2', item });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /已收到/);
  assert.equal(item.ackMessageId, 41);
  assert.deepEqual(persisted, [41]);
  assert.equal(ack.messageId, 41);
});

test('ack status edits reuse one message and throttle changes for three seconds', async t => {
  const { manager, edits, setNow } = setup(t);
  const ack = await manager.start({ chatId: 7, requestId: 'a1b2', item: { chatId: 7 } });
  setNow(1000);
  await manager.update(ack, 'processing');
  assert.equal(edits.length, 0);
  setNow(2999);
  await manager.flushDue();
  assert.equal(edits.length, 0);
  setNow(3000);
  await manager.flushDue();
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /正在处理/);
  setNow(6000);
  await manager.update(ack, 'completed');
  await manager.flushDue();
  assert.equal(edits.length, 2);
  assert.match(edits[1].text, /已完成/);
  assert.equal(edits[0].message_id, edits[1].message_id);
});

test('ack keeps only the latest pending state during throttle', async t => {
  const { manager, edits, setNow } = setup(t);
  const ack = await manager.start({ chatId: 7, requestId: 'a1b2', item: { chatId: 7 } });
  setNow(1000); await manager.update(ack, 'processing');
  setNow(1500); await manager.update(ack, 'completed');
  setNow(3000); await manager.flushDue();
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /已完成/);
});

test('replay edits an existing ack instead of sending a second one', async t => {
  const { manager, sent, edits } = setup(t);
  const item = { chatId: 7, ackMessageId: 99 };
  const ack = await manager.start({ chatId: 7, requestId: 'a1b2', item, isReplay: true });
  await manager.flushDue(true);
  assert.equal(sent.length, 0);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].message_id, 99);
  assert.match(edits[0].text, /服务重启后继续处理/);
  assert.equal(ack.messageId, 99);
});

test('edit failures are logged and never enter the outbox', async t => {
  const sent = [];
  const logs = [];
  const manager = new TelegramAckManager({
    send: async params => { sent.push(params); return { message_id: 41 }; },
    edit: async () => { throw Error('network edit failed'); },
    logger: event => logs.push(event),
  });
  const ack = await manager.start({ chatId: 7, requestId: 'a1b2', item: { chatId: 7 } });
  await manager.update(ack, 'processing', { force: true });
  await manager.flushDue(true);
  assert.equal(sent.length, 1);
  assert.equal(logs.find(event => event.errorClass)?.errorClass, 'telegram_ack_edit_failed');
});

test('message is not modified is treated as a successful edit', async t => {
  const logs = [];
  const manager = new TelegramAckManager({
    send: async () => ({ message_id: 41 }),
    edit: async () => { throw Error('Bad Request: message is not modified'); },
    logger: event => logs.push(event),
  });
  const ack = await manager.start({ chatId: 7, requestId: 'a1b2', item: { chatId: 7 } });
  await manager.update(ack, 'processing', { force: true });
  await manager.flushDue(true);
  assert.equal(logs.some(event => event.errorClass), false);
});

test('integration: request lifecycle keeps one ack and clears terminal ledger', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { Store, TelegramActiveRequests } = require('../index')._test;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ack-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'store.json'));
  const ledger = new TelegramActiveRequests(store);
  const sent = []; const edits = [];
  const manager = new TelegramAckManager({
    send: async params => { sent.push(params); return { message_id: 55 }; },
    edit: async params => { edits.push(params); },
  });
  const entry = ledger.create({ requestId: 'req01', chatId: 7, state: 'running', text: 'work', kind: 'user' });
  const ack = await manager.start({ chatId: 7, requestId: entry.requestId, item: entry });
  await manager.update(ack, 'processing');
  await manager.flushDue(true);
  await manager.update(ack, 'completed');
  await manager.flushDue(true);
  ledger.remove(entry.requestId);
  assert.equal(sent.length, 1);
  assert.equal(new Set(edits.map(edit => edit.message_id)).size, 1);
  assert.equal(ledger.list().length, 0);
});

test('integration: running request recovery interrupts without rerunning', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { Store, TelegramActiveRequests } = require('../index')._test;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ack-running-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'store.json'));
  const ledger = new TelegramActiveRequests(store);
  const edits = []; let starts = 0;
  const manager = new TelegramAckManager({
    send: async () => { starts++; return { message_id: 55 }; },
    edit: async params => { edits.push(params); },
  });
  const entry = ledger.create({ requestId: 'req02', chatId: 7, ackMessageId: 55, state: 'running', text: 'work', kind: 'user' });
  const ack = manager.restore(entry);
  await manager.interrupt(ack);
  ledger.remove(entry.requestId);
  assert.equal(starts, 0);
  assert.match(edits[0].text, /服务重启.*中断/);
  assert.equal(ledger.list().length, 0);
});

test('integration: queued request recovery reuses request and can execute once', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { Store, TelegramActiveRequests } = require('../index')._test;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ack-queued-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'store.json'));
  const ledger = new TelegramActiveRequests(store);
  const manager = new TelegramAckManager({ send: async () => ({ message_id: 55 }), edit: async () => {} });
  const entry = ledger.create({ requestId: 'req03', chatId: 7, ackMessageId: 55, state: 'queued', text: 'work', kind: 'user' });
  const ack = manager.restore(entry);
  ledger.update(entry.requestId, { state: 'running', replayCount: 1 });
  await manager.update(ack, 'processing');
  ledger.remove(entry.requestId);
  assert.equal(ack.requestId, 'req03');
  assert.equal(ledger.list().length, 0);
});

test('integration: internal retry keeps the same ack and request id', async t => {
  const { manager, sent, edits } = setup(t);
  const ack = await manager.start({ chatId: 7, requestId: 'req04', item: { chatId: 7 } });
  await manager.update(ack, 'processing');
  await manager.flushDue(true);
  await manager.update(ack, 'processing');
  await manager.flushDue(true);
  assert.equal(sent.length, 1);
  assert.equal(new Set(edits.map(edit => edit.message_id)).size, 1);
  assert.equal(ack.requestId, 'req04');
});

test('integration: steer ack follows the owning turn terminal state', async t => {
  const { manager, edits } = setup(t);
  const primary = await manager.start({ chatId: 7, requestId: 'req05', item: { chatId: 7 } });
  const steer = await manager.start({ chatId: 7, requestId: 'req06', item: { chatId: 7 }, initialStatus: 'steer' });
  await manager.update(primary, 'processing');
  await manager.update(steer, 'processing');
  await manager.flushDue(true);
  await manager.update(primary, 'completed');
  await manager.update(steer, 'completed');
  await manager.flushDue(true);
  assert.equal(edits.filter(edit => /已完成/.test(edit.text)).length, 2);
});

test('integration: delayed outbox ack delivery backfills the active request message id', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { Store, TelegramOutbox, TelegramActiveRequests } = require('../index')._test;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ack-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'store.json'));
  const ledger = new TelegramActiveRequests(store);
  const entry = ledger.create({ requestId: 'req07', chatId: 7, state: 'running', text: 'work', kind: 'user' });
  const delivered = [];
  const outbox = new TelegramOutbox(store, {
    send: async () => ({ message_id: 77 }),
    onDelivered: async (item, result) => {
      delivered.push({ requestId: item.requestId, messageId: result.message_id });
      ledger.update(item.requestId, { ackMessageId: result.message_id });
    },
  });
  const queued = outbox.enqueue({ chat_id: 7, text: '已收到' }, { priority: 'notice', requestId: entry.requestId });
  await outbox.deliver(queued);
  assert.deepEqual(delivered, [{ requestId: 'req07', messageId: 77 }]);
  assert.equal(ledger.list()[0].ackMessageId, 77);
});
