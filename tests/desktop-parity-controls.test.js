const test = require("node:test");
const assert = require("node:assert/strict");
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
