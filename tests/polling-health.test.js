const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { _test: { Store } } = require('../index.js');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function setup(t, store) {
  if (!store) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-poll-health-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    store = new Store(path.join(dir, 'store.json'));
  }
  const clock = { now: 1000000 };
  const logs = [], sleeps = [];
  const shutdown = { closing: false };
  const telegram = { getUpdates: async () => [] };
  const healthCode = source.slice(source.indexOf('  function ensureTelegramHealthState()'), source.indexOf('  function ensureCodexBackendHealthState()'));
  const loopCode = source.slice(source.indexOf('  async function pollingLoop()'), source.indexOf('  console.log(`Telegram Codex Bridge started.'));
  const api = vm.runInNewContext(`(() => { ${healthCode}\n${loopCode}\nreturn { pollingLoop, recordTelegramPollError, recordTelegramPollSuccess, ensureTelegramHealthState }; })()`, {
    store, shutdown, telegram, telegramTransportRecovery: null,
    console: { log: line => logs.push(line), error() {} },
    Date: class extends Date { static now() { return clock.now; } },
    processStartedAt: clock.now, pollTimeoutSeconds: 5,
    TELEGRAM_POLLING_RESTART_ERROR_THRESHOLD: 6, TELEGRAM_POLLING_STALL_THRESHOLD_MS: 180000,
    requestSupervisorRestart: () => assert.fail('polling must not request a process restart'),
    process: { exit: () => assert.fail('polling must not exit') },
    sleep: async ms => { sleeps.push(ms); clock.now += ms; },
    truncateMiddle: text => text, reconcileTelegramTransportRecoveryHealth() {},
    outbox: { flush: async () => {} }, inbox: { accept: () => [] },
  });
  return { ...api, store, clock, logs, sleeps, shutdown, telegram };
}

test('production polling loop survives over 180 seconds and more than six failures', async t => {
  const f = setup(t);
  let attempts = 0;
  f.telegram.getUpdates = async () => {
    if (++attempts <= 8) {
      f.clock.now += 35000;
      throw new Error('network unavailable');
    }
    f.shutdown.closing = true;
    return [];
  };
  await f.pollingLoop();
  assert.equal(attempts, 9);
  assert.equal(f.store.data.telegram.health.consecutivePollErrors, 0);
});

test('poll health changes at 30 and 90 seconds and logs each transition only once', t => {
  const f = setup(t);
  const start = f.clock.now;
  const failAt = elapsed => { f.clock.now = start + elapsed; f.recordTelegramPollError(new Error('network unavailable')); };
  failAt(29999);
  assert.equal(f.ensureTelegramHealthState().state, 'ok');
  failAt(30000);
  assert.equal(f.ensureTelegramHealthState().state, 'degraded');
  assert.equal(f.ensureTelegramHealthState().offlineSince, start);
  failAt(89999);
  failAt(90000);
  failAt(190000);
  assert.equal(f.ensureTelegramHealthState().state, 'unreachable');
  const events = f.logs.map(JSON.parse);
  assert.deepEqual(events.map(e => e.errorClass), ['telegram_degraded', 'telegram_unreachable']);
  assert.deepEqual(events.map(e => e.ts), [new Date(start + 30000).toISOString(), new Date(start + 90000).toISOString()]);
});

test('successful polling persists the full outage duration and logs recovery once', t => {
  const f = setup(t);
  const start = f.clock.now;
  f.clock.now += 90000;
  f.recordTelegramPollError(new Error('offline'));
  f.clock.now += 10000;
  f.recordTelegramPollSuccess();
  const h = f.ensureTelegramHealthState();
  assert.equal(h.state, 'ok');
  assert.equal(h.offlineSince, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.lastOutage)), { startedAt: start, endedAt: start + 100000, durationMs: 100000 });
  f.recordTelegramPollSuccess();
  assert.equal(f.logs.length, 2);
  const event = JSON.parse(f.logs[1]);
  assert.equal(event.telegramState, 'ok');
  assert.equal(event.durationMs, 100000);
  assert.equal(event.ts, new Date(start + 100000).toISOString());
  const disk = new Store(f.store.storePath); disk.load();
  assert.equal(disk.data.telegram.health.offlineSince, 0);
  assert.equal(disk.data.telegram.health.lastOutage.durationMs, 100000);
});

test('poll retries back off 2/4/8/16/30/30 seconds and reset after success', async t => {
  const f = setup(t);
  let attempts = 0;
  f.telegram.getUpdates = async () => {
    attempts++;
    if (attempts === 7) return [];
    if (attempts === 9) { f.shutdown.closing = true; return []; }
    throw new Error('network unavailable');
  };
  await f.pollingLoop();
  assert.deepEqual(f.sleeps, [2000, 4000, 8000, 16000, 30000, 30000, 2000]);
});

test('offlineSince survives store reload and includes downtime in recovery duration', t => {
  const f = setup(t);
  const start = f.clock.now;
  f.clock.now += 30000;
  f.recordTelegramPollError(new Error('offline'));
  const disk = new Store(f.store.storePath); disk.load();
  assert.equal(disk.data.telegram.health.offlineSince, start);
  const restarted = setup(t, disk);
  restarted.clock.now = start + 180000;
  restarted.recordTelegramPollError(new Error('still offline'));
  assert.equal(restarted.ensureTelegramHealthState().state, 'unreachable');
  assert.equal(restarted.ensureTelegramHealthState().offlineSince, start);
  restarted.clock.now += 10000;
  restarted.recordTelegramPollSuccess();
  assert.equal(restarted.ensureTelegramHealthState().lastOutage.durationMs, 190000);
});

test('/status exposes Telegram state, offlineSince and lastOutage', t => {
  const f = setup(t);
  const fields = source.split('\n').filter(line => /^\s*`(?:telegramState|offlineSince|lastOutage):/.test(line));
  const render = () => Array.from(vm.runInNewContext(`[${fields.join('\n')}]`, {
    ensureTelegramHealthState: f.ensureTelegramHealthState,
  }));
  assert.deepEqual(render(), ['telegramState: ok', 'offlineSince: (none)', 'lastOutage: (none)']);
  f.clock.now += 30000;
  f.recordTelegramPollError(new Error('offline'));
  assert.equal(render()[0], 'telegramState: degraded');
  assert.equal(render()[1], 'offlineSince: 1000000');
  f.recordTelegramPollSuccess();
  assert.match(render()[2], /"durationMs":30000/);
});
