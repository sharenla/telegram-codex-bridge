const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _test } = require("../index.js");

test("structured Telegram 409 is a poll conflict and incidental text is ignored", () => {
  assert.equal(_test.isTelegramPollConflictError({ body: { error_code: 409 } }), true);
  assert.equal(_test.isTelegramPollConflictError({ body: { error_code: 400 }, message: "409 Conflict" }), false);
  assert.equal(_test.isTelegramPollConflictError({ message: "409 Conflict" }), false);
});

test("three conflicts in five minutes enter conflict and queue one private notice", () => {
  const health = { state: "ok" };
  const queued = [];
  const allowlist = new Set([123, -456]);
  const error = { body: { error_code: 409 }, message: "Conflict" };
  _test.recordTelegramPollConflict(health, error, { now: 1_000 });
  _test.recordTelegramPollConflict(health, error, { now: 60_000 });
  const result = _test.recordTelegramPollConflict(health, error, {
    now: 120_000,
    onEnter: () => _test.queueTelegramConflictNotice({
      health,
      allowlist,
      botName: "CodexBot",
      outbox: { enqueue: item => queued.push(item) },
      now: 120_000,
    }),
  });
  assert.equal(result.entered, true);
  assert.equal(health.state, "conflict");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].chat_id, 123);
  assert.match(queued[0].text, /CodexBot/);
});

test("conflict notice is rate limited and conflict recovers after ten quiet minutes", () => {
  const health = { state: "conflict", conflictEvents: [1_000, 60_000, 120_000], lastConflictNoticeAt: 120_000 };
  const queued = [];
  const queue = now => _test.queueTelegramConflictNotice({
    health,
    allowlist: new Set([123]),
    botName: "CodexBot",
    outbox: { enqueue: item => queued.push(item) },
    now,
  });
  assert.equal(queue(600_000), false);
  assert.equal(queued.length, 0);
  assert.equal(_test.refreshTelegramConflictState(health, 720_001), true);
  assert.equal(health.state, "ok");
});

