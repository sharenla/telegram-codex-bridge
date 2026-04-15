const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../index.js");

test("extractContextUsageSnapshotPayload supports snake_case payloads", () => {
  const snapshot = _test.extractContextUsageSnapshotPayload({
    last_token_usage: { total_tokens: 12345 },
    model_context_window: 200000,
  });

  assert.deepEqual(snapshot, {
    totalTokens: 12345,
    contextWindow: 200000,
  });
});

test("extractContextUsageSnapshotPayload supports camelCase payloads", () => {
  const snapshot = _test.extractContextUsageSnapshotPayload({
    lastTokenUsage: { totalTokens: 54321 },
    modelContextWindow: 128000,
  });

  assert.deepEqual(snapshot, {
    totalTokens: 54321,
    contextWindow: 128000,
  });
});

test("applyContextUsageSnapshot updates ratio and pending reason", () => {
  const session = {};
  const thresholds = {
    soft: _test.DEFAULT_CONTEXT_SOFT_RATIO,
    hard: _test.DEFAULT_CONTEXT_HARD_RATIO,
    emergency: _test.DEFAULT_CONTEXT_EMERGENCY_RATIO,
  };

  const changed = _test.applyContextUsageSnapshot(
    session,
    { totalTokens: 170000, contextWindow: 200000 },
    thresholds,
    "2026-04-14T00:00:00.000Z",
  );

  assert.equal(changed, true);
  assert.equal(session.lastTurnTokens, 170000);
  assert.equal(session.contextWindow, 200000);
  assert.equal(session.contextUsageRatio, 0.85);
  assert.equal(session.compactionPending, true);
  assert.equal(session.compactionPendingReason, "hard");
  assert.equal(session.lastTokenObservedAt, "2026-04-14T00:00:00.000Z");
});

test("shouldAutoCompactDecision only returns hard/emergency when enabled", () => {
  const session = {
    compactionPending: true,
    compactionPendingReason: "hard",
    pendingSummaryBootstrap: null,
  };
  const rt = {
    compactionInProgress: false,
    activeTurnId: null,
  };

  assert.equal(
    _test.shouldAutoCompactDecision({
      autoCompactEnabled: true,
      session,
      rt,
    }),
    "hard",
  );

  assert.equal(
    _test.shouldAutoCompactDecision({
      autoCompactEnabled: false,
      session,
      rt,
    }),
    null,
  );
});

test("shouldAutoCompactDecision defers when summary bootstrap is pending", () => {
  const session = {
    compactionPending: true,
    compactionPendingReason: "emergency",
    pendingSummaryBootstrap: { text: "summary" },
  };

  const result = _test.shouldAutoCompactDecision({
    autoCompactEnabled: true,
    session,
    rt: { compactionInProgress: false, activeTurnId: null },
  });

  assert.equal(result, null);
});

test("shouldTreatTextAsContextFailure matches explicit context errors", () => {
  assert.equal(
    _test.shouldTreatTextAsContextFailure("maximum context length exceeded", null),
    true,
  );
  assert.equal(
    _test.shouldTreatTextAsContextFailure("ENOENT: no such file or directory", null),
    false,
  );
});

test("shouldTreatTextAsContextFailure uses emergency heuristic for generic input failures", () => {
  assert.equal(
    _test.shouldTreatTextAsContextFailure("input payload rejected by upstream", "emergency"),
    true,
  );
  assert.equal(
    _test.shouldTreatTextAsContextFailure("input payload rejected by upstream", "hard"),
    false,
  );
});

test("buildCompactionBootstrapText keeps summary and user message", () => {
  const text = _test.buildCompactionBootstrapText(
    { text: "## 当前目标\n- 修复自动压缩" },
    "请继续下一步",
  );

  assert.match(text, /当前继续工作的唯一上下文基线/);
  assert.match(text, /## 当前目标/);
  assert.match(text, /用户新消息：请继续下一步/);
});

test("countQueuedTasks returns pending task length", () => {
  assert.equal(_test.countQueuedTasks({ pendingTasks: [{}, {}, {}] }), 3);
  assert.equal(_test.countQueuedTasks({ pendingTasks: null }), 0);
});
