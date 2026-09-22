const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { _test: { Store, TelegramInbox, TelegramOutbox, TelegramApi } } = require('../index');
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
