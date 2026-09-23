const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const x = require('../index.js')._test;
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}
function setup(t, { replayCount = 0, tools = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-terminal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new x.Store(path.join(dir, 'store.json'));
  const activeRequests = new x.TelegramActiveRequests(store);
  activeRequests.create({ requestId: 'req', chatId: -7, state: 'running', text: 'work', ackMessageId: 42 });
  const edits = [], sent = [];
  const ackManager = new x.TelegramAckManager({ edit: async p => edits.push(p), send: async () => ({message_id:42}) });
  const ack = ackManager.restore(activeRequests.list()[0]);
  const meta = { text: 'work', authReplayCount: replayCount, acks: [ack] };
  const rt = { activeTurnId: null, turnInputMetaByTurnId: { turn: meta },
    turnToolActivityByTurnId: { turn: tools }, pendingTasks: [], authRecoveryReplayTask: null };
  const outbox = new x.TelegramOutbox(store, { send: async p => { sent.push(p); return {message_id:1}; } });
  let recoveries = 0;
  const context = { ...x, store, activeRequests, ackManager, outbox, allowlist: new Set([7,-7]),
    botIdentity: { current: { username:'test_bot' } }, runtimeByChat: new Map([[-7,rt]]),
    isAccountAuthFailureTurn: () => true, isCompactionTurnKind: () => false,
    extractTurnErrorText: () => 'refresh token was revoked',
    telegram: { sendMessage: async p => sent.push(p) },
    ensureCodexBackendRecovered: async () => { recoveries++; return false; },
    recordCodexBackendFailure() {}, ensureCodexBackendHealthState: () => store.data.bridge.codexBackend ||= {},
    console: { log() {}, error() {} }, stopTyping() {},
  };
  const names = ['notifyAuthRecoveryFailure','finishAuthRecoveryRequest','getTurnInputMeta','queueAuthRecoveryReplayTask','retryTurnAfterAuthFailure'];
  const api = vm.runInNewContext(`${names.map(fn).join('\n')}\n({retryTurnAfterAuthFailure})`, context);
  return { ...api, context, rt, meta, store, activeRequests, ackManager, outbox, edits, sent, get recoveries() {return recoveries;} };
}
test('all account recovery fails: terminal ack, empty ledger and no queued replay', async t => {
  const f = setup(t);
  await f.retryTurnAfterAuthFailure({chatId:-7,rt:f.rt,turn:{id:'turn'}});
  await f.ackManager.flushDue(true);
  assert.match(f.edits.at(-1)?.text || '', /处理失败.*Codex 账号登录已失效，需要维护者重新登录/);
  assert.equal(f.activeRequests.list().length,0);
  assert.equal(f.rt.authRecoveryReplayTask,null);
});
test('second auth failure and a turn with tool activity never enter recovery or replay', async t => {
  for (const options of [{replayCount:1}, {tools:true}]) {
    const f = setup(t, options);
    await f.retryTurnAfterAuthFailure({chatId:-7,rt:f.rt,turn:{id:'turn'}});
    await f.ackManager.flushDue(true);
    assert.equal(f.recoveries,0);
    assert.equal(f.rt.authRecoveryReplayTask,null);
    assert.equal(f.activeRequests.list().length,0);
    assert.match(f.edits.at(-1).text, options.tools ? /可能已部分执行/ : /需要维护者重新登录/);
  }
});
test('auth failure stays auth_failing through server initialization and resets only on successful turn', () => {
  const store = {data:{bridge:{}},markDirty(){},saveThrottled(){}};
  const names = ['ensureCodexBackendHealthState','recordCodexBackendHealthy','recordCodexBackendFailure','markCodexBackendRecovering','markCodexBackendRecoveryFailed'];
  const api = vm.runInNewContext(`${names.map(fn).join('\n')}\n({recordCodexBackendHealthy,recordCodexBackendFailure,markCodexBackendRecovering,markCodexBackendRecoveryFailed})`, {store,truncateMiddle:s=>s});
  api.recordCodexBackendFailure('Failed to refresh token: HTTP 401',{auth:true});
  assert.equal(store.data.bridge.codexBackend.state,'auth_failing');
  api.recordCodexBackendHealthy();
  assert.equal(store.data.bridge.codexBackend.state,'auth_failing');
  api.markCodexBackendRecovering('retry');
  api.markCodexBackendRecoveryFailed('all accounts failed');
  assert.equal(store.data.bridge.codexBackend.state,'auth_failing');
  api.recordCodexBackendHealthy({successfulTurn:true});
  assert.equal(store.data.bridge.codexBackend.state,'ok');
});
test('repeated stderr auth failures remain observable after one-shot watchdog has fired', async () => {
  const server = new x.CodexAppServer({codexLbEnabled:false});
  let observed = 0, watchdog = 0;
  server.onAuthFailure(() => observed++);
  server.onAuthWatchdog(() => watchdog++);
  const log = console.error; console.error = () => {};
  try {
    server._handleStderrLine('Failed to refresh token: HTTP 401 Unauthorized');
    server._handleStderrLine('Failed to refresh token: HTTP 401 Unauthorized');
  } finally { console.error = log; }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed,2); assert.equal(watchdog,1);
});
function watchdogRecovery(f, { succeeds = false, onReplay = () => {} } = {}) {
  let replays = 0, switches = 0;
  const names = ['notifyAuthRecoveryFailure','finishAuthRecoveryRequest','getReplayableAuthRecoveryTask',
    'queueAuthRecoveryReplayTask','clearInterruptedTurnState','captureInterruptedTurnsForRecovery',
    'clearAllQueuedAuthRecoveryTasks','notifyInterruptedTurns','replayInterruptedTurnsAfterRecovery',
    'recoverCodexBackendFromAuthFailure'];
  const context = {...f.context,
    codexBackendRecoveryBypassDepth:0, autoAccountFailover:true, accountProfiles:[{profileId:'a'},{profileId:'b'}],
    reloadAccountProfiles(){}, findAccountProfile:()=>({profileId:'a'}), getCurrentAccountProfile:()=>({profileId:'a'}),
    markProfileForRecoveryError(){}, markCodexBackendRecovering(){}, markCodexBackendRecoveryFailed(){},
    listFallbackProfiles:()=>[{profileId:'b'}], isAccountAuthFailureText:()=>true,
    switchAccountProfile:async()=>{switches++;if(!succeeds)throw new Error('HTTP 401 Unauthorized');},
    recordCodexBackendHealthy(){}, extractCodexErrorText:e=>e.message,isAccountAuthFailure:()=>true,
    setGlobalFailoverState(){}, getOrCreateSession:()=>({}), clearTimeout,
    startOrSteerTurn:async p=>{replays++;assert.equal(p.ack?.requestId,'req');assert.equal(p.authReplayCount,1);onReplay(p);},
  };
  const api=vm.runInNewContext(`${names.map(fn).join('\n')}\n({recoverCodexBackendFromAuthFailure})`,context);
  return {...api,get replays(){return replays;},get switches(){return switches;}};
}
test('stderr watchdog recovery exhaustion closes the captured request, including its original ack', async t => {
  const f=setup(t);f.rt.activeTurnId='turn';
  const w=watchdogRecovery(f);
  assert.equal(await w.recoverCodexBackendFromAuthFailure({reason:'revoked'}),false);
  await f.ackManager.flushDue(true);
  assert.equal(f.activeRequests.list().length,0);
  assert.match(f.edits.at(-1)?.text||'',/需要维护者重新登录/);
  assert.equal(f.rt.authRecoveryReplayTask,null);
});
test('watchdog capture cannot replay a tool-active or already replayed request after a healthy switch', async t => {
  for (const options of [{tools:true},{replayCount:1}]) {
    const f=setup(t,options);f.rt.activeTurnId='turn';
    const w=watchdogRecovery(f,{succeeds:true});
    await w.recoverCodexBackendFromAuthFailure({reason:'revoked'});
    await f.ackManager.flushDue(true);
    assert.equal(w.replays,0);
    assert.equal(f.activeRequests.list().length,0);
    assert.match(f.edits.at(-1)?.text||'',options.tools?/可能已部分执行/:/需要维护者重新登录/);
  }
});
test('terminal auth failure enqueues one notice per allowlisted private chat for the same fault', async t => {
  const f=setup(t);
  for(let i=0;i<2;i++)await f.retryTurnAfterAuthFailure({chatId:-7,rt:f.rt,turn:{id:'turn'}});
  await f.outbox.flush();
  const notices=f.sent.filter(p=>/所有备用账号也无法恢复/.test(p.text));
  assert.equal(notices.length,1);assert.equal(notices[0].chat_id,7);
  const disk=new x.Store(f.store.storePath);disk.load();
  assert.deepEqual(disk.data.bridge.codexBackend.authFailureNoticeRecipients,[7]);
});
test('revoked refresh-token error is an authentication failure even without a 401 prefix',()=>{
 assert.equal(x.isAccountAuthFailureText('Your refresh token was revoked'),true);
});
test('auth failure during replay turn/start does not wait on its own recovery promise',async t=>{
 const f=setup(t,{replayCount:1});f.rt.pendingInputMeta=f.meta;
 let recoveries=0;
 const names=['notifyAuthRecoveryFailure','finishAuthRecoveryRequest','requestWithAccountFailover'];
 const api=vm.runInNewContext(`${names.map(fn).join('\n')}\n({requestWithAccountFailover})`,{...f.context,
  waitForCodexBackendRecovery:async()=>{},getRuntime:()=>f.rt,
  isAccountAuthFailure:()=>true,shouldHandoffAuthRecoveryToReplay:()=>false,
  ensureCodexBackendRecovered:async()=>{recoveries++;return false;},extractCodexErrorText:e=>e.message,
 });
 await assert.rejects(api.requestWithAccountFailover({chatId:-7,run:async()=>{throw Error('HTTP 401 Unauthorized');}}));
 await f.ackManager.flushDue(true);
 assert.equal(recoveries,0);assert.equal(f.activeRequests.list().length,0);
 assert.match(f.edits.at(-1)?.text||'',/需要维护者重新登录/);
});
test('recovery replay retains all request acks and its second auth failure closes all of them',async t=>{
 const f=setup(t);f.rt.activeTurnId='turn';
 const entry=f.activeRequests.create({requestId:'steer',chatId:-7,state:'running',text:'more',ackMessageId:43});
 f.meta.acks.push(f.ackManager.restore(entry));
 const w=watchdogRecovery(f,{succeeds:true,onReplay:p=>{
  assert.equal(p.acks?.length,2);
  f.rt.turnInputMetaByTurnId.next={text:p.text,authReplayCount:p.authReplayCount,acks:p.acks};
 }});
 await w.recoverCodexBackendFromAuthFailure({reason:'revoked'});
 await f.retryTurnAfterAuthFailure({chatId:-7,rt:f.rt,turn:{id:'next'}});
 await f.ackManager.flushDue(true);
 assert.equal(w.replays,1);assert.equal(f.recoveries,0);
 assert.equal(f.activeRequests.list().length,0);
 assert.deepEqual(new Set(f.edits.map(p=>p.message_id)),new Set([42,43]));
});
