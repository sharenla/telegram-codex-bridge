const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { _test: { Store, TelegramOutbox, TelegramInbox, TelegramAckManager,
  TelegramRecoveryNotices, recordRecoveryNoticeDelivered, installGracefulShutdown } } = require('../index.js');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function setup(t, { health = {}, allowlist = new Set([123, -456]), store } = {}) {
  if (!store) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store = new Store(path.join(dir, 'store.json'));
    Object.assign(store.data.telegram.health, health);
  }
  const clock = { now: 1000000 }, sent = [], logs = [];
  const outbox = new TelegramOutbox(store, { now: () => clock.now,
    send: async params => { sent.push(params); return { message_id: sent.length }; },
    onDelivered: item => recordRecoveryNoticeDelivered(store, item), logger: () => {} });
  const notices = new TelegramRecoveryNotices({ store, outbox, allowlist,
    getBotName: () => 'test_bot', now: () => clock.now, logger: e => logs.push(e) });
  return { store, clock, sent, logs, outbox, notices };
}

function network(f, duration) {
  f.notices.onPollSuccess([]); // Startup completed before network loss.
  Object.assign(f.store.data.telegram.health, { lastPollSuccessAt: f.clock.now,
    offlineSince: f.clock.now, lastPollError: 'curl: (28) Resolving timed out after 10000 milliseconds' });
  f.clock.now += duration;
  f.notices.onPollSuccess([]);
}

test('150s network outage sends one private notice with duration and Chinese last error', async t => {
  const f = setup(t);
  network(f, 150000);
  assert.equal(f.store.data.telegram.outbox[0].priority, 'notice');
  assert.equal(f.store.data.telegram.health.lastOutageNotifiedAt, undefined);
  await f.outbox.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].chat_id, 123);
  assert.match(f.sent[0].text, /test_bot.*2 分 30 秒（网络 DNS 解析失败）/);
  assert.doesNotMatch(f.sent[0].text, /curl|milliseconds/);
  assert.equal(f.store.data.telegram.health.lastOutageNotifiedAt, f.clock.now);
});

test('60s loss and a graceful deployment of a few seconds send no summary', async t => {
  const f = setup(t); network(f, 60000); await f.outbox.flush();
  assert.equal(f.sent.length, 0);
  const deploy = setup(t, { health: { lastPollSuccessAt: 995000,
    lastShutdown: { at: 996000, signal: 'SIGTERM', graceful: true } } });
  deploy.notices.onPollSuccess([]); await deploy.outbox.flush();
  assert.equal(deploy.sent.length, 0);
  assert.equal(deploy.store.data.telegram.health.lastShutdown, undefined);
});

test('10min downtime uses abnormal reason; 3min graceful stop uses normal reason', async t => {
  for (const graceful of [false, true]) {
    const start = graceful ? 820000 : 400000;
    const f = setup(t, { health: { lastPollSuccessAt: start,
      lastShutdown: { at: graceful ? start + 1 : start - 1, graceful: true } } });
    f.notices.onPollSuccess([]); await f.outbox.flush();
    assert.match(f.sent[0].text, graceful ? /3 分 0 秒（服务进程停止运行（正常关闭））/ : /10 分 0 秒（服务进程停止运行（异常退出或被强杀））/);
  }
});

test('outbox receipt prevents duplicate notices across restart before and after delivery', async t => {
  const f = setup(t); network(f, 150000);
  for (let pass = 0; pass < 2; pass++) {
    const disk = new Store(f.store.storePath); disk.load();
    const restarted = setup(t, { store: disk }); restarted.clock.now = f.clock.now + 1000;
    restarted.notices.onPollSuccess([]);
    await restarted.outbox.flush();
    assert.equal(restarted.sent.length, pass === 0 ? 1 : 0);
    assert.equal(disk.data.telegram.health.lastOutageNotifiedAt, f.clock.now);
  }
});

test('negative chat ids never receive recovery broadcasts', async t => {
  const f = setup(t, { allowlist: new Set([-123, -456]) });
  network(f, 150000); await f.outbox.flush();
  assert.equal(f.sent.length, 0);
});

test('delayed message date survives inbox reload and annotation stays on the same ack', async t => {
  const f = setup(t); network(f, 150000);
  const inbox = new TelegramInbox(f.store, { now: () => f.clock.now, dispatch: async () => {} });
  inbox.accept([{ update_id: 1, message: { message_id: 20, date: 1010,
    chat: { id: -456, type: 'supergroup' }, text: '@test_bot hello' } }]);
  const disk = new Store(f.store.storePath); disk.load();
  const item = disk.data.telegram.inbox[0];
  assert.equal(item.date, 1010);
  const sent = [], edited = [];
  const ack = new TelegramAckManager({ now: () => f.clock.now,
    send: async params => { sent.push(params); return { message_id: 99 }; },
    edit: async params => edited.push(params) });
  const state = await ack.start({ chatId: -456, requestId: 'same', item });
  assert.match(sent[0].text, /服务刚恢复，这条消息在 2 分钟前发出/);
  f.clock.now += 3000; await ack.update(state, 'completed');
  assert.equal(sent.length, 1); assert.equal(edited[0].message_id, 99);
  assert.match(edited[0].text, /已完成.*\n（服务刚恢复/);
  const restored = ack.restore({ requestId: 'same', chatId: -456, ackMessageId: 99, recoveryNote: item.recoveryNote });
  assert.match(ack._text(restored, 'interrupted'), /服务刚恢复/);
});

test('graceful shutdown records signal and timestamp before the forced save', async () => {
  const handlers = {}, saved = [];
  const store = { data: { telegram: {} }, save: () => saved.push(JSON.parse(JSON.stringify(store.data))) };
  let exit;
  installGracefulShutdown({ store, telegram: { close: async () => {} },
    processRef: { on: (signal, handler) => handlers[signal] = handler, exit: code => exit = code } });
  const before = Date.now(); handlers.SIGTERM(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved[0].telegram.health.lastShutdown.signal, 'SIGTERM');
  assert.equal(saved[0].telegram.health.lastShutdown.graceful, true);
  assert.ok(saved[0].telegram.health.lastShutdown.at >= before);
  assert.equal(exit, 143);
});

test('production poll loop captures last network error before clearing it and counts affected messages', async t => {
  const f = setup(t);
  f.notices.onPollSuccess([]);
  Object.assign(f.store.data.telegram.health, { lastPollSuccessAt: f.clock.now,
    offlineSince: f.clock.now, lastPollError: 'SSL connection reset http://127.0.0.1:2455' });
  f.clock.now += 150000;
  const shutdown = { closing: false };
  const telegram = { recoveryNotices: f.notices, getUpdates: async () => {
    shutdown.closing = true;
    return [{ update_id: 1, message: { date: 1010, chat: { id: 123 }, text: 'hello' } }];
  } };
  const healthCode = source.slice(source.indexOf('  function ensureTelegramHealthState()'), source.indexOf('  function ensureCodexBackendHealthState()'));
  const loopCode = source.slice(source.indexOf('  async function pollingLoop()'), source.indexOf('  console.log(`Telegram Codex Bridge started.'));
  const loop = vm.runInNewContext(`(() => { ${healthCode}\n${loopCode}\nreturn pollingLoop; })()`, {
    store: f.store, shutdown, telegram, telegramTransportRecovery: null,
    console: { log() {}, error() {} }, Date: class extends Date { static now() { return f.clock.now; } },
    pollTimeoutSeconds: 5, reconcileTelegramTransportRecoveryHealth() {},
    outbox: f.outbox, inbox: { accept: () => [] },
    sleep: async () => assert.fail('successful recovery must not sleep'),
  });
  await loop(); await f.outbox.flush();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /代理或网络连接中断/);
  assert.match(f.sent[0].text, /期间收到的 1 条消息/);
  assert.doesNotMatch(f.sent[0].text, /http|SSL/);
  assert.equal(f.store.data.telegram.health.lastPollError, null);
});

test('pending private-recipient preparation survives restart without duplicating the first enqueue', async t => {
  const f = setup(t, { allowlist: new Set([123, 456, -789]) });
  const enqueue = f.outbox.enqueue.bind(f.outbox);
  f.outbox.enqueue = (params, options) => {
    if (params.chat_id === 456) throw new Error('simulated persistence failure');
    return enqueue(params, options);
  };
  assert.throws(() => network(f, 150000), /persistence failure/);
  await f.outbox.flush();
  const disk = new Store(f.store.storePath); disk.load();
  const restarted = setup(t, { store: disk, allowlist: new Set([123, 456, -789]) });
  restarted.clock.now = f.clock.now + 1000;
  restarted.notices.onPollSuccess([]); await restarted.outbox.flush();
  assert.deepEqual(f.sent.map(p => p.chat_id), [123]);
  assert.deepEqual(restarted.sent.map(p => p.chat_id), [456]);
});

test('recovery reasons cover DNS, TLS, connect timeout and Telegram 502/503 without bare-number matches', () => {
  const { recoveryNetworkReason } = require('../index.js')._test;
  for (const [error, expected] of [
    ['Could not resolve host', '网络 DNS 解析失败'],
    ['TLS handshake failed', '代理或网络连接中断'],
    ['Connection timed out', '网络连接超时'],
    ['HTTP status 503', 'Telegram 服务端暂时不可用'],
    ['HTTP/1.1 502 Bad Gateway', 'Telegram 服务端暂时不可用'],
    ['request id 503 failed', '网络异常'],
  ]) assert.equal(recoveryNetworkReason(error), expected);
});

test('first install sends no downtime summary and messages outside the outage get no annotation', async t => {
  const f = setup(t); f.notices.onPollSuccess([]); await f.outbox.flush();
  assert.equal(f.sent.length, 0);
  network(f, 150000);
  const inbox = new TelegramInbox(f.store, { now: () => f.clock.now });
  const messages = [999, 1000, 1150, 1151].map((date, i) => ({ update_id: i + 1,
    message: { date, chat: { id: 123, type: 'private' }, text: 'hello' } }));
  const items = inbox.accept(messages);
  assert.deepEqual(items.map(item => item.recoveryNote), ['', '', '', '']);
});

test('a persisted delivery receipt suppresses resend if the process dies before outbox removal', async t => {
  const f = setup(t); network(f, 150000);
  const item = f.store.data.telegram.outbox[0];
  recordRecoveryNoticeDelivered(f.store, item); // Telegram succeeded, then process stopped before _remove.
  const disk = new Store(f.store.storePath); disk.load();
  const restarted = setup(t, { store: disk }); restarted.clock.now = f.clock.now + 1000;
  await restarted.outbox.flush();
  assert.equal(restarted.sent.length, 0);
  assert.equal(disk.data.telegram.outbox.length, 0);
});
