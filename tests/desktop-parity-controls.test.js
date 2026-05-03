const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _test } = require("../index.js");

test("project selector resolves source profiles by index, id, and path fallback", () => {
  const root = path.join(os.tmpdir(), "bridge-project-picker");
  const registry = {
    profiles: [
      _test.normalizeSourceProfile({
        id: "home-workspace",
        name: "Home",
        root,
      }),
      _test.normalizeSourceProfile({
        id: "agent-team",
        name: "Agent Team",
        root: path.join(root, "agent-team"),
        aliases: [path.join(root, ".hermes", "profiles", "agent-team-orchestrator")],
      }),
      _test.normalizeSourceProfile({
        id: "telegram-codex-bridge",
        name: "Telegram Codex Bridge",
        root: path.join(root, "telegram-codex-bridge"),
      }),
    ],
  };

  assert.equal(_test.listSelectableSourceProfiles(registry).length, 2);
  assert.equal(_test.resolveProjectSelector(registry, "1").profile.id, "agent-team");
  assert.equal(_test.resolveProjectSelector(registry, "telegram-codex-bridge").profile.id, "telegram-codex-bridge");
  assert.equal(
    _test.resolveProjectSelector(registry, path.join(root, ".hermes", "profiles", "agent-team-orchestrator")).profile.id,
    "agent-team",
  );
  assert.deepEqual(
    _test.resolveProjectSelector(registry, "/tmp/unknown"),
    { type: "path", path: "/tmp/unknown", selector: "/tmp/unknown" },
  );
});

test("project list marks selectable profiles and explains switch command", () => {
  const root = path.join(os.tmpdir(), "bridge-project-list");
  const registry = {
    registryPath: "/tmp/source-registry.json",
    profiles: [
      _test.normalizeSourceProfile({
        id: "openclaw-binance-runtime",
        name: "OpenClaw Binance Runtime",
        root: path.join(root, "openclaw-binance"),
        sources: {
          liveRuntime: [path.join(root, "openclaw-binance", "binance-control-plane")],
          logs: [path.join(root, "openclaw-binance", "logs")],
        },
      }),
    ],
  };

  const text = _test.formatProjectListText(registry, {
    currentCwd: path.join(root, "openclaw-binance", "binance-control-plane"),
  });

  assert.match(text, /Projects \(1\)/);
  assert.match(text, /\*1\. openclaw-binance-runtime/);
  assert.match(text, /\[runtime, logs\]/);
  assert.match(text, /\/project <index\|id\|path>/);
});

test("thread list and handback command support CLI handoff", () => {
  const text = _test.formatThreadListText({
    data: [
      { id: "thr_1", status: "loaded", preview: "Fix bridge project picker" },
      { thread: { id: "thr_2", preview: "Older session" } },
    ],
  }, {
    currentThreadId: "thr_1",
    currentCwd: "/Users/wukong/Documents/Playground/telegram-codex-bridge",
  });

  assert.match(text, /\*1\. thr_1 \[loaded\] - Fix bridge project picker/);
  assert.match(text, / 2\. thr_2 - Older session/);
  assert.equal(
    _test.buildHandbackCommand({
      cwd: "/tmp/has ' quote",
      threadId: "thr_1",
    }),
    "cd '/tmp/has '\\'' quote' && codex resume 'thr_1'",
  );
});

test("project thread state preserves per-project thread ids", () => {
  const session = {
    cwd: "/repo/a",
    threadId: "thread-a",
    truthProfile: {
      id: "repo-a",
      name: "Repo A",
      projectRoot: "/repo/a",
    },
    contextTokens: 123,
    projectThreads: {},
  };

  const saved = _test.rememberProjectThreadState(session, { observedAt: "2026-05-03T00:00:00.000Z" });
  assert.equal(saved.key, "profile:repo-a");

  session.cwd = "/repo/b";
  session.threadId = "thread-b";
  session.truthProfile = {
    id: "repo-b",
    name: "Repo B",
    projectRoot: "/repo/b",
  };
  _test.rememberProjectThreadState(session, { observedAt: "2026-05-03T00:00:01.000Z" });

  session.cwd = "/repo/a";
  session.threadId = null;
  session.contextTokens = null;
  session.truthProfile = {
    id: "repo-a",
    name: "Repo A",
    projectRoot: "/repo/a",
  };

  const restored = _test.restoreProjectThreadState(session);
  assert.equal(restored.key, "profile:repo-a");
  assert.equal(session.threadId, "thread-a");
  assert.equal(session.contextTokens, 123);
});

test("workspace root conflict detects nested active workspaces", () => {
  assert.equal(_test.workspaceRootsConflict("/repo", "/repo/subdir"), true);
  assert.equal(_test.workspaceRootsConflict("/repo/a", "/repo/b"), false);
  assert.equal(
    _test.workspaceLockRootForSession({
      cwd: "/repo/subdir",
      truthProfile: { projectRoot: "/repo" },
    }),
    "/repo",
  );
});

test("detectTestCommand finds package test script only", () => {
  assert.equal(_test.detectTestCommand(""), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-command-"));
  assert.equal(_test.detectTestCommand(root), null);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: { test: "node --test" },
  }));
  assert.deepEqual(_test.detectTestCommand(root), {
    command: "npm",
    args: ["test"],
    label: "npm test",
  });
});

test("help text is localized for Telegram users", () => {
  const text = _test.buildHelpText();
  assert.match(text, /Telegram Codex Bridge 命令/);
  assert.match(text, /直接发送普通文字/);
  assert.match(text, /\/review - 让 Codex review 当前工作树 diff，只审查不改文件/);
  assert.doesNotMatch(text, /Tip: just send plain text/);
  assert.doesNotMatch(text, /start a new Codex thread/);
});
