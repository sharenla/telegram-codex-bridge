const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _test } = require("../index.js");

test("source registry resolves the most specific project profile", () => {
  const root = path.join(os.tmpdir(), "bridge-truth-root");
  const nested = path.join(root, "repo", "subdir");
  const registry = _test.buildSourceRegistry({
    codexHome: path.join(root, "bridge-codex-home"),
    desktopCodexHome: path.join(root, "desktop-codex-home"),
    bridgeRoot: path.join(root, "bridge"),
    serviceRoot: path.join(root, "service"),
    storePath: path.join(root, "service", "data", "store.json"),
  });
  registry.profiles.push(_test.normalizeSourceProfile({
    id: "test-repo",
    name: "Test Repo",
    root: path.join(root, "repo"),
    sources: {
      canonicalRepo: path.join(root, "repo"),
      stateFiles: [path.join(root, "state.json")],
    },
  }));

  const match = _test.findSourceProfileForPath(registry, nested);

  assert.equal(match.profile.id, "test-repo");
  assert.equal(match.matchPath, path.join(root, "repo"));
});

test("bundled source registry is valid and covers local business projects", () => {
  const registryPath = path.join(__dirname, "..", "config", "source-registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const ids = new Set((registry.projects || []).map((project) => project.id));

  for (const id of [
    "telegram-codex-bridge",
    "openclaw-gateway",
    "hermes-agent",
    "agent-team",
    "trading-binance",
    "openclaw-binance-runtime",
    "trading-deribit",
    "openclaw-deribit-stage6",
    "trading-stack",
  ]) {
    assert.equal(ids.has(id), true, `missing source registry project: ${id}`);
  }
});

test("refreshSessionTruthProfile stores a pending bootstrap binding", () => {
  const root = path.join(os.tmpdir(), "bridge-truth-session");
  const registry = {
    registryPath: null,
    registryError: null,
    loadedAt: "2026-04-25T00:00:00.000Z",
    codexHome: path.join(root, "bridge-codex-home"),
    desktopCodexHome: path.join(root, "desktop-codex-home"),
    profiles: [
      _test.normalizeSourceProfile({
        id: "session-repo",
        name: "Session Repo",
        root,
        sources: { canonicalRepo: root },
      }),
    ],
  };
  const session = { cwd: path.join(root, "work") };

  const resolved = _test.refreshSessionTruthProfile(session, registry, {
    reason: "test",
    bootstrapPending: true,
    refreshedAt: "2026-04-25T01:00:00.000Z",
  });

  assert.equal(resolved.profile.id, "session-repo");
  assert.equal(session.truthProfile.id, "session-repo");
  assert.equal(session.truthProfile.bootstrapPending, true);
  assert.equal(session.truthProfile.lastRefreshedAt, "2026-04-25T01:00:00.000Z");
});

test("truth bootstrap includes source rules and user message", () => {
  const root = path.join(os.tmpdir(), "bridge-truth-bootstrap");
  const profile = _test.normalizeSourceProfile({
    id: "bootstrap-repo",
    name: "Bootstrap Repo",
    root,
    sources: {
      canonicalRepo: root,
      logs: [path.join(root, "logs")],
      launchAgents: ["com.example.agent"],
    },
    mustCheckBeforeAnswer: ["Check runtime logs before current-state claims."],
    neverAssume: ["Do not trust repo files as live truth."],
  });

  const text = _test.buildTruthBootstrapText({ profile }, "Why is the bot silent?");

  assert.match(text, /Bridge source-of-truth bootstrap/);
  assert.match(text, /Check runtime logs/);
  assert.match(text, /Do not trust repo files/);
  assert.match(text, /User message: Why is the bot silent\?/);
});

test("desktop context sync preserves auth while copying memories and safe config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-context-sync-"));
  const desktopHome = path.join(root, "desktop");
  const codexHome = path.join(root, "bridge");
  fs.mkdirSync(path.join(desktopHome, "memories"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(desktopHome, "memories", "MEMORY.md"), "desktop memory\n");
  fs.writeFileSync(path.join(desktopHome, "auth.json"), "{\"desktop\":true}\n");
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{\"bridge\":true}\n");
  fs.writeFileSync(path.join(desktopHome, "config.toml"), [
    "model = \"gpt-5.5\"",
    "approval_policy = \"never\"",
    "sandbox_mode = \"danger-full-access\"",
    "notify = [\"turn-ended\"]",
    "",
    "[features]",
    "memories = true",
    "",
  ].join("\n"));

  const report = _test.syncDesktopCodexContext({
    codexHome,
    desktopCodexHome: desktopHome,
    enabled: true,
  });

  assert.deepEqual(report.synced.sort(), ["config.toml", "memories"].sort());
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), "{\"bridge\":true}\n");
  assert.equal(fs.readFileSync(path.join(codexHome, "memories", "MEMORY.md"), "utf8"), "desktop memory\n");
  const syncedConfig = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.match(syncedConfig, /model = "gpt-5\.5"/);
  assert.match(syncedConfig, /\[features\]/);
  assert.doesNotMatch(syncedConfig, /approval_policy/);
  assert.doesNotMatch(syncedConfig, /sandbox_mode/);
  assert.doesNotMatch(syncedConfig, /notify/);
});
