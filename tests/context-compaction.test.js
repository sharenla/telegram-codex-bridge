const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../index.js");

test("extractContextUsageSnapshotPayload supports snake_case payloads", () => {
  const snapshot = _test.extractContextUsageSnapshotPayload({
    last_token_usage: { total_tokens: 12345 },
    model_context_window: 200000,
  });

  assert.deepEqual(snapshot, {
    contextTokens: null,
    lastTurnTokens: 12345,
    contextWindow: 200000,
  });
});

test("extractContextUsageSnapshotPayload supports camelCase payloads", () => {
  const snapshot = _test.extractContextUsageSnapshotPayload({
    lastTokenUsage: { totalTokens: 54321 },
    modelContextWindow: 128000,
  });

  assert.deepEqual(snapshot, {
    contextTokens: null,
    lastTurnTokens: 54321,
    contextWindow: 128000,
  });
});

test("extractContextUsageSnapshotPayload prefers total usage for context occupancy", () => {
  const snapshot = _test.extractContextUsageSnapshotPayload({
    info: {
      total_token_usage: { total_tokens: 170000 },
      last_token_usage: { total_tokens: 12345 },
      model_context_window: 200000,
    },
  });

  assert.deepEqual(snapshot, {
    contextTokens: 170000,
    lastTurnTokens: 12345,
    contextWindow: 200000,
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
    { contextTokens: 170000, lastTurnTokens: 12345, contextWindow: 200000 },
    thresholds,
    "2026-04-14T00:00:00.000Z",
  );

  assert.equal(changed, true);
  assert.equal(session.contextTokens, 170000);
  assert.equal(session.lastTurnTokens, 12345);
  assert.equal(session.contextWindow, 200000);
  assert.equal(session.contextUsageRatio, 0.85);
  assert.equal(session.compactionPending, true);
  assert.equal(session.compactionPendingReason, "hard");
  assert.equal(session.lastTokenObservedAt, "2026-04-14T00:00:00.000Z");
});

test("normalizeSessionState treats zero context windows as unknown", () => {
  const session = {
    contextWindow: 0,
    contextTokens: 1000,
    lastTurnTokens: 100,
  };

  _test.normalizeSessionState(session, {});

  assert.equal(session.contextWindow, null);
});

test("extractTelemetryThreadId accepts snake_case thread ids", () => {
  assert.equal(_test.extractTelemetryThreadId({ thread_id: "thread-a" }), "thread-a");
  assert.equal(_test.extractTelemetryThreadId({ context: { thread_id: "thread-b" } }), "thread-b");
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

test("normalizeModelId maps short GPT 5 aliases to Codex model ids", () => {
  assert.equal(_test.normalizeModelId("5.2"), "gpt-5.2");
  assert.equal(_test.normalizeModelId("5.4"), "gpt-5.4");
  assert.equal(_test.normalizeModelId("5.5"), "gpt-5.5");
  assert.equal(_test.normalizeModelId("custom-model"), "custom-model");
});

test("normalizeEffortLevel accepts canonical levels and common aliases", () => {
  assert.equal(_test.normalizeEffortLevel("medium"), "medium");
  assert.equal(_test.normalizeEffortLevel("x-high"), "xhigh");
  assert.equal(_test.normalizeEffortLevel("max"), "xhigh");
  assert.equal(_test.normalizeEffortLevel("invalid"), null);
});

test("parseModelCommandArgs can set model and effort together", () => {
  assert.deepEqual(_test.parseModelCommandArgs("5.4 xhigh"), {
    model: "gpt-5.4",
    effort: "xhigh",
    error: null,
  });
});

test("parseModelCommandArgs rejects invalid effort", () => {
  const parsed = _test.parseModelCommandArgs("5.5 impossible");
  assert.equal(parsed.model, null);
  assert.equal(parsed.effort, null);
  assert.match(parsed.error, /Invalid effort/);
});

test("resolveAgentMessageTurnId falls back to active turn when event turnId is missing", () => {
  assert.equal(
    _test.resolveAgentMessageTurnId({
      explicitTurnId: null,
      existingTurnId: null,
      rt: { activeTurnId: "turn-active" },
    }),
    "turn-active",
  );
});

test("resolveAgentMessageTurnId keeps existing turn binding over active turn", () => {
  assert.equal(
    _test.resolveAgentMessageTurnId({
      explicitTurnId: null,
      existingTurnId: "turn-existing",
      rt: { activeTurnId: "turn-active" },
    }),
    "turn-existing",
  );
});

test("shouldRetryTelegramMethod keeps sendMessage at-most-once", () => {
  assert.equal(_test.shouldRetryTelegramMethod("sendMessage"), false);
});

test("shouldRetryTelegramMethod still retries getUpdates", () => {
  assert.equal(_test.shouldRetryTelegramMethod("getUpdates"), true);
});
