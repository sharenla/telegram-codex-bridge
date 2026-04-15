const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../index.js");

test("isAccountAuthFailureText matches stderr auth watchdog patterns", () => {
  assert.equal(_test.isAccountAuthFailureText("refresh_token_reused"), true);
  assert.equal(_test.isAccountAuthFailureText("token_expired while refreshing"), true);
  assert.equal(_test.isAccountAuthFailureText("HTTP 401 Unauthorized"), true);
  assert.equal(_test.isAccountAuthFailureText("429 rate limit exceeded"), false);
});

test("buildAuthRecoveryReplayTask preserves turn metadata and increments replay count once", () => {
  const task = _test.buildAuthRecoveryReplayTask({
    text: "继续修这个 bug",
    attemptedProfileIds: ["acct-a"],
    kind: "user",
    silent: false,
    contextRetryCount: 1,
    authReplayCount: 0,
  }, "active_turn", "2026-04-15T00:00:00.000Z");

  assert.deepEqual(task, {
    text: "继续修这个 bug",
    attemptedProfileIds: ["acct-a"],
    kind: "user",
    silent: false,
    contextRetryCount: 1,
    authReplayCount: 1,
    source: "active_turn",
    createdAt: "2026-04-15T00:00:00.000Z",
  });
});

test("buildAuthRecoveryReplayTask stops after one automatic replay", () => {
  const task = _test.buildAuthRecoveryReplayTask({
    text: "这次不该再自动续跑了",
    authReplayCount: 1,
  });

  assert.equal(task, null);
});

test("summarizeCodexBackendHealth highlights recovery and last error", () => {
  const summary = _test.summarizeCodexBackendHealth({
    state: "recovering",
    recoveryInProgress: true,
    recoveryReason: "refresh_token_reused",
    lastOkAt: Date.now() - 30_000,
    lastErrorAt: Date.now() - 5_000,
    lastError: "refresh_token_reused",
  });

  assert.match(summary, /^recovering,/);
  assert.match(summary, /last ok/);
  assert.match(summary, /last err/);
  assert.match(summary, /recovering: refresh_token_reused/);
});
