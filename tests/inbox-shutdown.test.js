const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { _test: { Store, TelegramInbox, TelegramApi, terminateChild } } = require('../index');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(path.join(dir, 'store.json'));
}
function update(id) { return { update_id: id, message: { message_id: id, chat: { id: 1, type: 'private' }, from: { id: 2 }, text: 'hello', secret: 'not retained' } }; }
test('offset and minimal message are persisted together before dispatch and removed on success', async t => {
  const store = fixture(t);
  const inbox = new TelegramInbox(store, { dispatch: async item => {
    const disk = JSON.parse(fs.readFileSync(store.storePath));
    assert.equal(disk.telegram.offset, 11);
    assert.equal(disk.telegram.inbox[0].text, 'hello');
    assert.equal(item.isReplay, false);
    assert.equal(JSON.stringify(disk).includes('not retained'), false);
  }});
  const [item] = inbox.accept([update(10)]);
  await inbox.run(item);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.storePath)).telegram.inbox, []);
});
test('unfinished messages survive reload and replay in order with durable counters', async t => {
  const store = fixture(t);
  new TelegramInbox(store).accept([update(10), update(11)]);
  const fresh = new Store(store.storePath); fresh.load();
  const seen = [];
  await new TelegramInbox(fresh, { dispatch: async item => {
    seen.push(item.update_id);
    assert.equal(item.isReplay, true);
    assert.equal(item.replayCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(store.storePath)).telegram.inbox[0].replayCount, 1);
  }}).replay();
  assert.deepEqual(seen, [10, 11]);
});
test('failed handler stays durable and exhausted replay notifies once then removes', async t => {
  const store = fixture(t); const notices = [];
  const inbox = new TelegramInbox(store, { logger: () => {}, dispatch: async () => { throw Error('crash'); }, notify: async (...args) => notices.push(args) });
  inbox.accept([update(10)]);
  await inbox.replay(); await inbox.replay();
  assert.equal(store.data.telegram.inbox[0].replayCount, 2);
  await inbox.replay(); await inbox.replay();
  assert.equal(notices.length, 1); assert.match(notices[0][1], /已放弃，请重发/);
  assert.equal(store.data.telegram.inbox.length, 0);
});
test('expired entries are discarded and logged without dispatch', async t => {
  const store = fixture(t); let time = 1; const logs = [];
  const inbox = new TelegramInbox(store, { now: () => time, logger: event => logs.push(event), dispatch: () => assert.fail('expired') });
  inbox.accept([update(10)]); time += 86400001; await inbox.replay();
  assert.equal(logs[0].errorClass, 'bridge_inbox_expired');
  assert.equal(store.data.telegram.inbox.length, 0);
});
test('capacity and text limits do not acknowledge rejected entries', t => {
  const store = fixture(t); const logs = [];
  const inbox = new TelegramInbox(store, { logger: event => logs.push(event) });
  inbox.accept(Array.from({ length: 201 }, (_, i) => update(i + 1)));
  assert.equal(store.data.telegram.inbox.length, 200);
  assert.equal(store.data.telegram.offset, 201);
  assert.equal(logs[0].errorClass, 'bridge_inbox_full');
  store.data.telegram.inbox = [];
  const large = update(201); large.message.text = 'x'.repeat(16385);
  inbox.accept([large]); assert.equal(store.data.telegram.offset, 201);
  assert.equal(logs[1].errorClass, 'bridge_inbox_text_limit');
});
test('failed atomic save restores memory offset and inbox', t => {
  const store = fixture(t); const inbox = new TelegramInbox(store);
  store.save = () => { throw Error('disk'); };
  assert.throws(() => inbox.accept([update(10)]), /disk/);
  assert.equal(store.data.telegram.offset, 0);
  assert.equal(store.data.telegram.inbox.length, 0);
});
test('callback replay retains callback id and routing metadata', async t => {
  const store = fixture(t); let seen;
  const inbox = new TelegramInbox(store, { dispatch: async item => { seen = item; } });
  inbox.accept([{ update_id: 1, callback_query: { id: 'fake-callback', data: 'menu|help', from: { id: 2 }, message: update(1).message } }]);
  await inbox.replay(); assert.equal(seen.callbackId, 'fake-callback'); assert.equal(seen.text, 'menu|help'); assert.equal(seen.kind, 'callback_query');
});
test('SIGTERM flushes store and terminates tracked child before exiting', async t => {
  const store = fixture(t);
  const source = `const { _test: x } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
    const { spawn } = require('node:child_process');
    const store = new x.Store(${JSON.stringify(store.storePath)});
    store.data.telegram.offset=7; store.data.telegram.inbox=[{update_id:6,text:'pending'}];
    const telegram = new x.TelegramApi('fake');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
    const server=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
    telegram.children.add(child);
    x.installGracefulShutdown({store,telegram,getServer:()=>({stopAndWait:()=>x.terminateChild(server)})});
    process.send({pids:[child.pid,server.pid]}); setInterval(()=>{},1000);`;
  const proc = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => proc.kill('SIGKILL'));
  const [ready] = await once(proc, 'message');
  const closed = once(proc, 'exit'); proc.kill('SIGTERM');
  const [code] = await closed; assert.equal(code, 143);
  const disk = JSON.parse(fs.readFileSync(store.storePath));
  assert.equal(disk.telegram.offset, 7); assert.equal(disk.telegram.inbox[0].text, 'pending');
  for (const pid of ready.pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('startup polls new messages while a replay dispatch remains pending', async t => {
  const vm = require('node:vm');
  const store = fixture(t);
  new TelegramInbox(store).accept([update(10)]);
  const handled = [];
  const inbox = new TelegramInbox(store, { dispatch: async item => {
    handled.push(item.update_id);
    if (item.isReplay) await new Promise(() => {});
  }});
  // Execute the production startup tail, not a duplicated scheduling algorithm.
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const tail = source.slice(source.indexOf('  console.log(`Telegram Codex Bridge started.'));
  const startup = tail.slice(0, tail.indexOf('\n}\n\nmodule.exports'));
  let polled = false;
  const run = vm.runInNewContext(`(async () => { ${startup} })()`, {
    console: { log() {}, warn() {}, error() {} }, INDEX_CODE_SHA256: 'test', INDEX_CODE_VERSION: 'test',
    allowlist: null, storePath: store.storePath, sourceRegistry: {}, inbox,
    pollingLoop: async () => {
      polled = true;
      const [item] = inbox.accept([update(11)]);
      await inbox.run(item);
    },
  });
  const result = await Promise.race([run.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
  assert.equal(result, 'done', 'a pending replay must not block polling startup');
  assert.equal(polled, true);
  assert.deepEqual(handled, [10, 11]);
  assert.deepEqual(store.data.telegram.inbox.map(item => item.update_id), [10]);
});
