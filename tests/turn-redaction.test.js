const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../index.js");

test("shouldRedactCodexTurnOutput enables redaction for both group and private chats", () => {
  assert.equal(_test.shouldRedactCodexTurnOutput(-1001234567890), true);
  assert.equal(_test.shouldRedactCodexTurnOutput(123456789), true);
  assert.equal(_test.shouldRedactCodexTurnOutput(0), false);
});

test("sanitizeGroupAgentText hides code blocks, paths, file names, and diff lines", () => {
  const raw = [
    "正在处理变更：",
    "```js",
    "const risky = true;",
    "```",
    "$ npm test",
    "cwd: /Users/wukong/Documents/Playground/telegram-codex-bridge",
    "updated /Users/wukong/Documents/Playground/telegram-codex-bridge/index.js:42",
    "also touched docs/COMMANDS.md",
    "diff --git a/index.js b/index.js",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
  ].join("\n");

  const text = _test.sanitizeGroupAgentText(raw);
  assert.match(text, /已隐藏/);
  assert.doesNotMatch(text, /```/);
  assert.doesNotMatch(text, /diff --git/);
  assert.doesNotMatch(text, /@@ -1,2 \+1,2 @@/);
  assert.doesNotMatch(text, /\/Users\/wukong\/Documents\/Playground\/telegram-codex-bridge/);
  assert.doesNotMatch(text, /docs\/COMMANDS\.md/);
  assert.doesNotMatch(text, /\$ npm test/);
});

test("private chat turn command/file/diff messages are summarized", () => {
  const privateChatId = 123456789;
  const commandText = _test.buildTurnCommandExecutionHeader({
    chatId: privateChatId,
    command: "git status",
    cwd: "/tmp/work",
    sessionCwd: "/tmp/work",
  });
  const fileText = _test.buildTurnFileChangeHeader({
    chatId: privateChatId,
    title: "Update index.js",
  });
  const diffText = _test.buildTurnDiffPreviewText(privateChatId, "diff --git a/a.js b/a.js\n+line");

  assert.match(commandText, /已隐藏/);
  assert.doesNotMatch(commandText, /\$ git status/);
  assert.doesNotMatch(commandText, /cwd:/);
  assert.match(fileText, /已隐藏/);
  assert.equal(diffText, "本轮包含代码改动，具体 diff 已隐藏。");
});

test("group chat turn redaction behavior stays redacted", () => {
  const groupChatId = -1001234567890;
  const commandText = _test.buildTurnCommandExecutionHeader({
    chatId: groupChatId,
    command: "rg -n secret index.js",
    cwd: "/tmp/work",
    sessionCwd: "/tmp/work",
  });
  const diffText = _test.buildTurnDiffPreviewText(groupChatId, "diff --git a/a.js b/a.js\n+line");
  const fallbackText = _test.buildTurnDiffPreviewText(0, "diff --git a/a.js b/a.js\n+line");

  assert.match(commandText, /已隐藏/);
  assert.equal(diffText, "本轮包含代码改动，具体 diff 已隐藏。");
  assert.match(fallbackText, /^Turn diff \(preview\):/);
});
