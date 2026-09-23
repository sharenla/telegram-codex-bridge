const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const script = path.resolve(__dirname, "../scripts/codex-launch-supervisor.sh");

async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-supervisor-test-"));
  const codex = path.join(root, "fake-codex");
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.exit(0);\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "index.js"), `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    fs.appendFileSync(${JSON.stringify(path.join(root, "starts"))}, JSON.stringify({pid:process.pid, at:Date.now()})+'\\n');
    let child;
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(path.join(root, "healthy"))}) && !child) {
        child = spawn(${JSON.stringify(codex)}, ['app-server', '--listen', 'stdio://']);
      } else if (!fs.existsSync(${JSON.stringify(path.join(root, "healthy"))}) && child) {
        child.kill(); child = null;
      }
    }, 20);
    process.on('SIGTERM', () => { if(child) child.kill(); process.exit(0); });
  `);
  const child = spawn('/bin/zsh', [script], {
    cwd: root, detached: true, stdio: 'ignore',
    env: { PATH: process.env.PATH, BRIDGE_ROOT: root, NODE_BIN: process.execPath,
      CODEX_BIN: codex, POLL_INTERVAL: '0.05', APP_SERVER_MISS_LIMIT: '3',
      START_GRACE_SECONDS: '0.4', ...overrides },
  });
  t.after(async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await delay(150);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await delay(50);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const read = file => { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; } };
  const logs = () => read('data/logs/bridge.stdout.log') + read('data/logs/bridge.stderr.log');
  const wait = async (predicate, timeout = 10000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (predicate()) return;
      if (child.exitCode !== null) assert.fail(`supervisor exited: ${logs()}`);
      await delay(30);
    }
    assert.fail(`timed out: ${logs()}`);
  };
  await wait(() => read('starts').trim());
  return { root, logs, wait, starts: () => read('starts').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('supervisor skips missing app-server during startup grace', { timeout: 15000 }, async t => {
  const f = await fixture(t, { START_GRACE_SECONDS: '2' });
  await delay(700);
  assert.equal(f.starts().length, 1);
  assert.match(f.logs(), /\[\d{4}-.*\] .*grace.*skip/i);
  assert.doesNotMatch(f.logs(), /unhealthy.*restarting/);
});

test('supervisor restarts only after grace and consecutive misses', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.wait(() => f.starts().length >= 2);
  const log = f.logs();
  assert.match(log, /app-server miss=1\/3/);
  assert.match(log, /app-server miss=2\/3/);
  assert.match(log, /app-server miss=3\/3/);
  assert.ok(f.starts()[1].at - f.starts()[0].at >= 400);
});

test('consecutive unhealthy starts use three grace levels and remain running at the cap', { timeout: 20000 }, async t => {
  const f = await fixture(t, { START_GRACE_SECONDS: '0.2' });
  await f.wait(() => f.starts().length >= 5);
  const restarts = [...f.logs().matchAll(/restarting; consecutive=(\d+); next_grace=([\d.]+)/g)];
  assert.deepEqual(restarts.slice(0, 4).map(m => [Number(m[1]), Number(m[2])]),
    [[1, 0.4], [2, 1], [3, 1], [4, 1]]);
  const starts = f.starts();
  assert.ok(starts[2].at - starts[1].at >= 400);
  assert.ok(starts[3].at - starts[2].at >= 1000);
  assert.ok(starts[4].at - starts[3].at >= 1000);
  process.kill(starts.at(-1).pid, 0);
});

test('a live app-server child resets misses and the grace escalation immediately', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.wait(() => f.starts().length >= 3);
  fs.writeFileSync(path.join(f.root, 'healthy'), 'yes');
  await f.wait(() => /healthy; reset.*consecutive=0; start_grace=0.4/.test(f.logs()));
  fs.unlinkSync(path.join(f.root, 'healthy'));
  await f.wait(() => f.starts().length >= 4);
  const restarts = [...f.logs().matchAll(/restarting; consecutive=(\d+); next_grace=([\d.]+)/g)];
  assert.deepEqual(restarts.slice(0, 3).map(m => [Number(m[1]), Number(m[2])]),
    [[1, 0.8], [2, 2], [1, 0.8]]);
});
