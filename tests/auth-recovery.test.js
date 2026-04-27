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

test("getReplayableAuthRecoveryTaskFromRuntime refuses second replay handoff", () => {
  const task = _test.getReplayableAuthRecoveryTaskFromRuntime({
    pendingInputMeta: {
      text: "刚才 replay 过一次的输入",
      authReplayCount: 1,
    },
  });

  assert.equal(task, null);
});

test("getReplayableAuthRecoveryTaskFromRuntime builds first pending replay task", () => {
  const task = _test.getReplayableAuthRecoveryTaskFromRuntime({
    pendingInputMeta: {
      text: "第一次可以续跑",
      authReplayCount: 0,
    },
  });

  assert.equal(task.text, "第一次可以续跑");
  assert.equal(task.source, "pending_request");
  assert.equal(task.authReplayCount, 1);
});

test("isAccountProfileAccessExpired respects access-token expiry skew", () => {
  const nowMs = Date.parse("2026-04-25T00:00:00.000Z");
  assert.equal(
    _test.isAccountProfileAccessExpired({ expires: nowMs + 4 * 60 * 1000 }, nowMs, 5 * 60 * 1000),
    true,
  );
  assert.equal(
    _test.isAccountProfileAccessExpired({ expires: nowMs + 6 * 60 * 1000 }, nowMs, 5 * 60 * 1000),
    false,
  );
  assert.equal(_test.isAccountProfileAccessExpired({ expires: 0 }, nowMs), false);
});

test("account priority keeps configured last-resort profiles at the end", () => {
  const selectors = _test.normalizeAccountSelectorList("zheng_zhonghuai@163.com, openai-codex:backup");
  const profiles = [
    { profileId: "openai-codex:backup", label: "backup@example.com" },
    { profileId: "openai-codex:alpha", label: "alpha@example.com" },
    { profileId: "openai-codex:163", label: "zheng_zhonghuai@163.com" },
  ].map((profile) => ({
    ...profile,
    lastResort: _test.isAccountProfileLastResort(profile, selectors),
  }));

  assert.deepEqual(
    _test.sortAccountProfilesByPriority(profiles).map((profile) => profile.profileId),
    ["openai-codex:alpha", "openai-codex:backup", "openai-codex:163"],
  );
  assert.deepEqual(
    _test.prioritizeAccountProfiles([
      profiles[2],
      profiles[1],
      profiles[0],
    ]).map((profile) => profile.profileId),
    ["openai-codex:alpha", "openai-codex:163", "openai-codex:backup"],
  );
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
