const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _test } = require("../index.js");

test("cached bot identity allows app-server spawn while getMe never settles", async () => {
  const cached = { id: 42, username: "old_bot" };
  const identity = await _test.resolveStartupBotIdentity({
    cached,
    getMe: () => new Promise(() => {}),
  });
  let appServerSpawned = false;
  if (identity.current) appServerSpawned = true;
  assert.equal(appServerSpawned, true);
  assert.deepEqual(identity.current, cached);
});

test("background getMe refreshes stored identity and group direction uses refreshed value", async () => {
  let finishGetMe;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-identity-"));
  const storePath = path.join(dir, "store.json");
  const store = new _test.Store(storePath);
  store.data.telegram.botIdentity = { id: 42, username: "old_bot" };
  store.save({ force: true });
  const identity = await _test.resolveStartupBotIdentity({
    cached: store.data.telegram.botIdentity,
    getMe: () => new Promise(resolve => { finishGetMe = resolve; }),
    onIdentity: next => {
      store.data.telegram.botIdentity = next;
      store.markDirty();
      store.save({ force: true });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  finishGetMe({ id: 43, username: "new_bot" });
  await new Promise(resolve => setImmediate(resolve));
  const reloaded = new _test.Store(storePath);
  reloaded.load();
  assert.deepEqual(reloaded.data.telegram.botIdentity, { id: 43, username: "new_bot" });
  assert.equal(_test.evaluateTelegramMessageDirection(
    { chat: { type: "group", id: -1001 }, text: "hi @new_bot" }, identity.current,
  ).shouldHandle, true);
  assert.equal(_test.evaluateTelegramMessageDirection(
    { chat: { type: "group", id: -1001 }, text: "hi @old_bot" }, identity.current,
  ).shouldHandle, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("without a cached bot identity startup waits for getMe", async () => {
  let finishGetMe;
  let settled = false;
  const startup = _test.resolveStartupBotIdentity({
    cached: null,
    getMe: () => new Promise(resolve => { finishGetMe = resolve; }),
  }).then(identity => { settled = true; return identity; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finishGetMe({ id: 44, username: "first_bot" });
  assert.deepEqual((await startup).current, { id: 44, username: "first_bot" });
});
