const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { _test: { Store, TelegramInbox, TelegramOutbox, TelegramApi, getOutboxStatus } } = require('../index');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(path.join(dir, 'store.json'));
}
const params = { chat_id: 1, text: '测试回复', reply_markup: { inline_keyboard: [] } };
test('failed send persists, fresh process store reload delivers and removes', async t => {
  const store = fixture(t);
  const outbox = new TelegramOutbox(store, { now: () => 1000, send: async () => { throw Error('offline'); } });
  await assert.rejects(outbox.sendMessage(params), /offline/);
  const fresh = new Store(store.storePath); fresh.load();
  assert.equal(fresh.data.telegram.outbox.length, 1);
  const delivered = [];
  await new TelegramOutbox(fresh, { now: () => 100000, send: async p => { delivered.push(p); return { message_id: 12 }; } }).flush();
  assert.deepEqual(delivered, [params]);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.storePath)).telegram.outbox, []);
});
test('sendMessage preserves Telegram result and concurrent flush does not duplicate send', async t => {
  const store = fixture(t); let release; let count = 0;
  const api = new TelegramApi('fake');
  api.outbox = new TelegramOutbox(store, { send: async () => { count++; return new Promise(r => { release = r; }); } });
  const sending = api.sendMessage(params);
  await Promise.resolve();
  const flushing = api.outbox.flush();
  release({ message_id: 5 });
  assert.deepEqual(await sending, { message_id: 5 }); await flushing;
  assert.equal(count, 1); assert.equal(store.data.telegram.outbox.length, 0);
});
test('exhausted inbox notification is durable when transport fails', async t => {
  const store = fixture(t);
  const outbox = new TelegramOutbox(store, { send: async () => { throw Error('offline'); } });
  const inbox = new TelegramInbox(store, { outbox, logger: () => {}, dispatch: () => assert.fail() });
  const [item] = inbox.accept([{ update_id: 1, message: { chat: { id: 1 }, message_id: 1, text: 'hello' } }]);
  item.replayCount = 2;
  await inbox.replay();
  const disk = JSON.parse(fs.readFileSync(store.storePath));
  assert.equal(disk.telegram.inbox.length, 0);
  assert.match(disk.telegram.outbox[0].params.text, /已放弃，请重发/);
});
test('full inbox sends Chinese notice with a minimum interval and leaves offset unchanged', async t => {
  const store = fixture(t); let time = 1000;
  const outbox = new TelegramOutbox(store, { now: () => time, send: async () => { throw Error('offline'); } });
  const inbox = new TelegramInbox(store, { outbox, now: () => time, logger: () => {} });
  inbox.accept(Array.from({ length: 200 }, (_, i) => ({ update_id: i + 1, message: { chat: { id: 1 }, text: 'x' } })));
  const update = { update_id: 201, message: { chat: { id: 1 }, text: 'new' } };
  inbox.accept([update]); inbox.accept([update]);
  assert.equal(store.data.telegram.outbox.length, 1);
  assert.match(store.data.telegram.outbox[0].params.text, /当前积压已满/);
  time += 60000; inbox.accept([update]);
  assert.equal(store.data.telegram.outbox.length, 2);
  assert.equal(store.data.telegram.offset, 201);
  await outbox.flush();
});
test('enqueue disk failure never sends and failed sends respect retry deadline', async t => {
  const store = fixture(t); let sends = 0; let time = 1;
  const outbox = new TelegramOutbox(store, { now: () => time, logger: () => {}, send: async () => { sends++; throw Error('offline'); } });
  const save = store.save.bind(store); store.save = () => { throw Error('disk'); };
  assert.throws(() => outbox.sendMessage(params), /disk/);
  assert.equal(sends, 0); assert.equal(store.data.telegram.outbox.length, 0);
  store.save = save;
  await assert.rejects(outbox.sendMessage(params)); await outbox.flush(); assert.equal(sends, 1);
  time += 30000; await outbox.flush(); assert.equal(sends, 2);
});
test('killed process pending outbox automatically replays on a fresh process startup', async t => {
  const store = fixture(t);
  const modulePath = JSON.stringify(path.resolve(__dirname, '../index.js'));
  const file = JSON.stringify(store.storePath);
  const child = spawn(process.execPath, ['-e', `
    const {_test:x}=require(${modulePath}); const store=new x.Store(${file});
    const box=new x.TelegramOutbox(store,{send:async()=>new Promise(()=>{})});
    box.sendMessage({chat_id:1,text:'pending'}); process.send('persisted'); setInterval(()=>{},1000);
  `], { stdio: ['ignore','ignore','ignore','ipc'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'message'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const recovery = spawn(process.execPath, ['-e', `
    const {_test:x}=require(${modulePath});const store=new x.Store(${file});store.load();
    const box=new x.TelegramOutbox(store,{send:async p=>{if(p.text!=='pending')process.exit(2);return {message_id:9};}});
    box.flush().then(()=>process.exit(store.data.telegram.outbox.length?3:0));
  `], { stdio: 'ignore' });
  assert.equal((await once(recovery, 'exit'))[0], 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.storePath)).telegram.outbox, []);
});

test('outbox overflow keeps notices and drops oldest normal entries', t => {
  const store = fixture(t); const logs = [];
  const outbox = new TelegramOutbox(store, { logger: event => logs.push(event) });
  for (let i = 0; i < 500; i++) outbox.enqueue({ chat_id: 1, text: `normal-${i}` });
  outbox.enqueue({ chat_id: 1, text: 'notice' }, { priority: 'notice' });
  outbox.enqueue({ chat_id: 1, text: 'new-normal' });
  assert.equal(store.data.telegram.outbox.length, 500);
  assert.equal(store.data.telegram.outbox.some(item => item.params.text === 'notice'), true);
  assert.equal(store.data.telegram.outbox.some(item => item.params.text === 'normal-0'), false);
  assert.equal(store.data.telegram.outboxStats.discardedTotal, 2);
  assert.equal(logs.filter(event => event.errorClass === 'bridge_outbox_overflow').length, 2);
});
test('outbox expires old entries without sending and records discard', async t => {
  const store = fixture(t); let sends = 0; const logs = [];
  const outbox = new TelegramOutbox(store, { now: () => 86400001, logger: event => logs.push(event), send: async () => { sends++; } });
  outbox.enqueue({ chat_id: 1, text: 'old' });
  store.data.telegram.outbox[0].receivedAt = 0;
  await outbox.flush();
  assert.equal(sends, 0); assert.equal(store.data.telegram.outbox.length, 0);
  assert.equal(logs[0].errorClass, 'bridge_outbox_expired');
});
test('permanent Telegram rejects leave outbox immediately without retry', async t => {
  const store = fixture(t); let sends = 0; const logs = [];
  const outbox = new TelegramOutbox(store, { logger: event => logs.push(event), send: async () => { sends++; const e = Error('Telegram API sendMessage failed: Bad Request: chat not found'); e.body = { error_code: 400 }; throw e; } });
  await assert.rejects(outbox.sendMessage(params), /chat not found/);
  assert.equal(sends, 1); assert.equal(store.data.telegram.outbox.length, 0);
  assert.equal(logs[0].errorClass, 'telegram_permanent_reject');
});
test('retryable outbox errors give up on the tenth failure', async t => {
  const store = fixture(t); let sends = 0; const logs = [];
  const outbox = new TelegramOutbox(store, { logger: event => logs.push(event), send: async () => { sends++; throw Error('transport failed'); } });
  for (let i = 0; i < 10; i++) {
    const item = i === 0 ? outbox.enqueue(params) : store.data.telegram.outbox[0];
    await assert.rejects(outbox.deliver(item));
    item.nextAttemptAt = 0;
  }
  assert.equal(sends, 10); assert.equal(store.data.telegram.outbox.length, 0);
  assert.equal(logs.at(-1).errorClass, 'bridge_outbox_giveup');
});
test('outbox status exposes queued and cumulative discarded counts', t => {
  const store = fixture(t); const outbox = new TelegramOutbox(store, { send: async () => ({}) });
  outbox.enqueue(params); store.data.telegram.outboxStats.discardedTotal = 7;
  assert.deepEqual(getOutboxStatus(store), { queued: 1, discarded: 7 });
});
test('send failure state-save error does not replace original send error', async t => {
  const store = fixture(t); const outbox = new TelegramOutbox(store, { send: async () => { throw Error('original-send-error'); }, logger: () => {} });
  const save = store.save.bind(store); let calls = 0; store.save = (...args) => { if (++calls > 1) throw Error('disk-full'); return save(...args); };
  await assert.rejects(outbox.sendMessage(params), /original-send-error/);
});

test('T2.4b 429 description mentioning retry after 403 remains retryable', async t => {
  const store = fixture(t); const logs = []; let sends = 0;
  const outbox = new TelegramOutbox(store, {
    logger: event => logs.push(event),
    send: async () => {
      sends++;
      const error = Error('Telegram API sendMessage failed: Too Many Requests: retry after 403');
      error.body = { error_code: 429, description: 'Too Many Requests: retry after 403' };
      throw error;
    }
  });
  await assert.rejects(outbox.sendMessage(params), /retry after 403/);
  assert.equal(sends, 1);
  assert.equal(store.data.telegram.outbox.length, 1);
  assert.equal(logs.some(event => event.errorClass === 'telegram_permanent_reject'), false);
});

test('T2.4b transport text mentioning 403 remains retryable without a body', async t => {
  const store = fixture(t); const logs = []; let sends = 0;
  const outbox = new TelegramOutbox(store, {
    logger: event => logs.push(event),
    send: async () => { sends++; throw Error('curl: (28) Operation timed out after 403 milliseconds'); }
  });
  await assert.rejects(outbox.sendMessage(params), /after 403 milliseconds/);
  assert.equal(sends, 1);
  assert.equal(store.data.telegram.outbox.length, 1);
  assert.equal(logs.some(event => event.errorClass === 'telegram_permanent_reject'), false);
});

test('T2.4b structured 403 is permanent and discarded', async t => {
  const store = fixture(t); const logs = []; let sends = 0;
  const outbox = new TelegramOutbox(store, {
    logger: event => logs.push(event),
    send: async () => {
      sends++;
      const error = Error('Telegram API sendMessage failed');
      error.body = { error_code: 403, description: 'Forbidden' };
      throw error;
    }
  });
  await assert.rejects(outbox.sendMessage(params));
  assert.equal(sends, 1);
  assert.equal(store.data.telegram.outbox.length, 0);
  assert.equal(logs[0].errorClass, 'telegram_permanent_reject');
});

test('T2.4b structured blocked description is permanent', async t => {
  const store = fixture(t); const logs = []; let sends = 0;
  const outbox = new TelegramOutbox(store, {
    logger: event => logs.push(event),
    send: async () => {
      sends++;
      const error = Error('Telegram API sendMessage failed');
      error.body = { error_code: 400, description: 'Forbidden: bot was blocked by the user' };
      throw error;
    }
  });
  await assert.rejects(outbox.sendMessage(params));
  assert.equal(sends, 1);
  assert.equal(store.data.telegram.outbox.length, 0);
  assert.equal(logs[0].errorClass, 'telegram_permanent_reject');
});
