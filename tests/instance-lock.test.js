const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const { _test } = require("../index.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function lockPayload({ pid, serviceRoot, indexPath }) {
  return {
    pid,
    startedAt: new Date().toISOString(),
    nonce: "test-lock-nonce",
    serviceRoot,
    indexPath,
  };
}

test("instance lock uses the persistent Application Support directory and mode 700", (t) => {
  const root = fixture(t);
  const lockDir = path.join(root, "telegram-codex-bridge-locks");
  const lockPath = _test.buildTelegramInstanceLockPath("123456789:test-token", { lockDir });
  assert.match(lockPath, /telegram-codex-bridge\.[a-f0-9]{12}\.lock$/);
  assert.equal(path.dirname(lockPath), lockDir);
  _test.ensureInstanceLockDirectory(lockDir);
  assert.equal(fs.statSync(lockDir).mode & 0o777, 0o700);
  assert.match(_test.buildTelegramInstanceLockPath("token"), /Library\/Application Support\/telegram-codex-bridge-locks/);
});

test("live PID belonging to an unrelated process is treated as a stale lock", async (t) => {
  const root = fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => child.kill("SIGKILL"));
  await once(child, "spawn");
  const serviceRoot = path.join(root, "service");
  const lockPath = path.join(root, "locks", "token.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lockPayload({
    pid: child.pid,
    serviceRoot,
    indexPath: path.join(serviceRoot, "index.js"),
  })));
  const acquired = _test.acquireInstanceLock(lockPath, { serviceRoot });
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  acquired.cleanup();
});

test("a live bridge with the same service root keeps the lock", async (t) => {
  const root = fixture(t);
  const serviceRoot = path.join(root, "service");
  const indexPath = path.join(serviceRoot, "index.js");
  const child = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000); console.log(${JSON.stringify(indexPath)})`]);
  t.after(() => child.kill("SIGKILL"));
  await once(child, "spawn");
  const lockPath = path.join(root, "locks", "token.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lockPayload({ pid: child.pid, serviceRoot, indexPath })));
  assert.throws(
    () => _test.acquireInstanceLock(lockPath, { serviceRoot }),
    (error) => error.code === "INSTANCE_LOCKED"
      && /另一个实例正在用同一个 bot token/.test(error.message)
      && error.message.includes(String(child.pid))
      && error.message.includes(serviceRoot),
  );
});

test("a live bridge in another service root keeps the lock from a workspace contender", async (t) => {
  const root = fixture(t);
  const holderRoot = path.join(root, "installed-service");
  const contenderRoot = path.join(root, "workspace");
  const indexPath = path.join(holderRoot, "index.js");
  const child = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000); console.log(${JSON.stringify(indexPath)})`]);
  t.after(() => child.kill("SIGKILL"));
  await once(child, "spawn");
  const lockPath = path.join(root, "locks", "token.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify(lockPayload({ pid: child.pid, serviceRoot: holderRoot, indexPath }));
  fs.writeFileSync(lockPath, payload);
  assert.throws(
    () => _test.acquireInstanceLock(lockPath, { serviceRoot: contenderRoot }),
    (error) => error.code === "INSTANCE_LOCKED"
      && error.message.includes(String(child.pid))
      && error.message.includes(holderRoot),
  );
  assert.equal(fs.readFileSync(lockPath, "utf8"), payload);
});

test("a lock whose holder exited is taken over", (t) => {
  const root = fixture(t);
  const serviceRoot = path.join(root, "service");
  const lockPath = path.join(root, "locks", "token.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lockPayload({
    pid: 999999,
    serviceRoot,
    indexPath: path.join(serviceRoot, "index.js"),
  })));
  const acquired = _test.acquireInstanceLock(lockPath, { serviceRoot });
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  acquired.cleanup();
});
