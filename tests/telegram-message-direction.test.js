const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../index.js");

test("group mention is directed to bot", () => {
  const decision = _test.evaluateTelegramMessageDirection(
    {
      chat: { type: "group", id: -1001001 },
      message_id: 21,
      text: "请看这个 @Codex_Bz01_bot",
    },
    { id: 42, username: "Codex_Bz01_bot" },
  );

  assert.equal(decision.shouldHandle, true);
  assert.equal(decision.reason, "group_text_mention");
  assert.equal(
    _test.shouldHandleTelegramMessage(
      {
        chat: { type: "group", id: -1001001 },
        message_id: 21,
        text: "请看这个 @Codex_Bz01_bot",
      },
      { id: 42, username: "Codex_Bz01_bot" },
    ),
    true,
  );
});

test("reply_to_current_bot remains directed without @ mention", () => {
  const message = {
    chat: { type: "supergroup", id: -1002002 },
    message_id: 22,
    text: "继续",
    reply_to_message: {
      message_id: 10,
      from: { id: 42, username: "Codex_Bz01_bot" },
    },
  };
  const decision = _test.evaluateTelegramMessageDirection(message, { id: 42, username: "Codex_Bz01_bot" });

  assert.equal(decision.shouldHandle, true);
  assert.equal(decision.reason, "reply_to_current_bot");
});

test("ignored group reply diagnostics keep only metadata", () => {
  const message = {
    chat: { type: "supergroup", id: -1003003 },
    message_id: 23,
    text: "收到",
    reply_to_message: {
      message_id: 11,
      from: { id: 99, username: "someone_else" },
      sender_chat: { id: -1009988 },
    },
  };
  const botIdentity = { id: 42, username: "Codex_Bz01_bot" };
  const decision = _test.evaluateTelegramMessageDirection(message, botIdentity);

  assert.equal(decision.shouldHandle, false);
  assert.equal(decision.reason, "group_text_not_directed");
  assert.equal(_test.shouldLogIgnoredGroupReplyDiagnostic(message, decision), true);

  const meta = _test.buildIgnoredGroupReplyDiagnosticMeta({
    message,
    botIdentity,
    reason: decision.reason,
  });

  assert.deepEqual(meta, {
    chatId: -1003003,
    messageId: 23,
    textLength: 2,
    replyFromId: 99,
    replyFromUsername: "someone_else",
    replySenderChatId: -1009988,
    replyMessageId: 11,
    botId: 42,
    botUsername: "Codex_Bz01_bot",
    reason: "group_text_not_directed",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(meta, "text"), false);
});

test("ignored non-reply group text does not emit ignored-group-reply diagnostic", () => {
  const message = {
    chat: { type: "supergroup", id: -1004004 },
    message_id: 24,
    text: "普通群聊",
  };
  const decision = _test.evaluateTelegramMessageDirection(message, { id: 42, username: "Codex_Bz01_bot" });

  assert.equal(decision.shouldHandle, false);
  assert.equal(_test.shouldLogIgnoredGroupReplyDiagnostic(message, decision), false);
});
