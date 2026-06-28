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

test("Deribit source profile requires main write-through deploy discipline", () => {
  const registryPath = path.join(__dirname, "..", "config", "source-registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const deribit = registry.projects.find((project) => project.id === "trading-deribit");
  const runtime = registry.projects.find((project) => project.id === "openclaw-deribit-stage6");

  assert.ok(deribit);
  assert.ok(runtime);
  assert.match(deribit.mustCheckBeforeAnswer.join("\n"), /push origin main/);
  assert.match(deribit.mustCheckBeforeAnswer.join("\n"), /deploy-release\.sh/);
  assert.match(deribit.mustCheckBeforeAnswer.join("\n"), /drift-check\.sh ok=drift_check_passed/);
  assert.match(deribit.neverAssume.join("\n"), /Do not edit \/srv\/deribit-options-seller\/current/);
  assert.match(runtime.mustCheckBeforeAnswer.join("\n"), /do not patch this runtime tree/);
  assert.match(runtime.neverAssume.join("\n"), /Do not treat openclaw-deribit-stage6 as the canonical source/);
});

test("Deribit strategy deploy workflow is injected for live strategy changes", () => {
  const session = {
    truthProfile: { id: "trading-deribit" },
  };

  assert.equal(
    _test.shouldInjectDeribitStrategyDeployWorkflow(session, "把 Deribit live 策略参数部署上线", "user"),
    true,
  );
  assert.equal(
    _test.shouldInjectDeribitStrategyDeployWorkflow(session, "把 Deribit live 策略参数部署上线", "autoCompaction"),
    false,
  );

  const text = _test.buildDeribitStrategyDeployWorkflowText("把风险阈值调一下");
  assert.match(text, /origin\/main/);
  assert.match(text, /strategy_approval_gate\.py/);
  assert.match(text, /--stage implementation/);
  assert.match(text, /--stage deploy --check-git/);
  assert.match(text, /validate-receipt/);
  assert.match(text, /deploy-release\.sh/);
  assert.match(text, /drift-check\.sh/);
  assert.match(text, /commit SHA and release stamp/);
  assert.match(text, /push `origin\/main`/);
});

test("Deribit deploy-release is blocked until deploy ticket gate passed", () => {
  const session = {
    truthProfile: { id: "trading-deribit" },
  };
  const deployCommand = "scripts/vps/deploy-release.sh deribit-stage6 --restart-main-services true";

  assert.match(
    _test.buildDeribitDeployGateBlockReason({ session, command: deployCommand }),
    /deploy approval gate/,
  );

  assert.equal(
    _test.observeDeribitApprovalGateOutput({
      session,
      command: "python3 scripts/strategy_approval_gate.py validate-ticket --ticket docs/strategy-iteration/approved/S10.ticket.json --stage deploy --check-git",
      output: "ok=ticket_valid ticketId=S10 stage=deploy",
    }) !== null,
    true,
  );
  assert.equal(_test.hasFreshDeribitApprovalGate(session, "deploy"), true);
  assert.equal(_test.buildDeribitDeployGateBlockReason({ session, command: deployCommand }), null);

  const inlineCommand = [
    "python3 scripts/strategy_approval_gate.py validate-ticket --ticket docs/strategy-iteration/approved/S10.ticket.json --stage deploy --check-git",
    "scripts/vps/deploy-release.sh deribit-stage6 --restart-main-services true",
  ].join(" && ");
  assert.equal(_test.buildDeribitDeployGateBlockReason({
    session: { truthProfile: { id: "trading-deribit" } },
    command: inlineCommand,
  }), null);
});

test("Deribit approval gate output records implementation and receipt gates", () => {
  const session = {
    truthProfile: { id: "trading-deribit" },
  };

  _test.observeDeribitApprovalGateOutput({
    session,
    command: "python3 scripts/strategy_approval_gate.py validate-ticket --ticket docs/strategy-iteration/approved/S10.ticket.json --stage implementation",
    output: "ok=ticket_valid ticketId=S10 stage=implementation",
  });
  _test.observeDeribitApprovalGateOutput({
    session,
    command: "python3 scripts/strategy_approval_gate.py validate-receipt --ticket docs/strategy-iteration/approved/S10.ticket.json --receipt docs/strategy-iteration/deploy-receipts/S10.receipt.json",
    output: "ok=receipt_valid ticketId=S10 releaseStamp=stamp",
  });

  assert.equal(_test.hasFreshDeribitApprovalGate(session, "implementation"), true);
  assert.equal(_test.hasFreshDeribitApprovalGate(session, "receipt"), true);
});

test("Deribit live hot patch blocker rejects current and shared writes", () => {
  const session = {
    truthProfile: { id: "trading-deribit" },
  };

  assert.match(
    _test.buildDeribitLiveHotPatchBlockReason({
      session,
      command: "ssh deribit-stage6 sudo cp /tmp/x /srv/deribit-options-seller/current/skills/deribit-options-seller/scripts/deribit_options_seller.mjs",
    }),
    /live hot patch/,
  );
  assert.match(
    _test.buildDeribitLiveHotPatchBlockReason({
      session,
      fileTitle: "/Users/wukong/openclaw-deribit-stage6/skills/deribit-options-seller/scripts/deribit_options_seller.mjs",
    }),
    /live hot patch/,
  );
  assert.match(
    _test.buildDeribitLiveHotPatchBlockReason({
      session,
      command: "ssh deribit-stage6 sudo tee /srv/deribit-options-seller/shared/config/deribit-options-seller.config.json",
    }),
    /shared config\/state\/env/,
  );
  assert.equal(
    _test.buildDeribitLiveHotPatchBlockReason({
      session,
      command: "scripts/vps/deploy-release.sh deribit-stage6 --restart-main-services true",
    }),
    null,
  );
  assert.equal(
    _test.buildDeribitLiveHotPatchBlockReason({
      session,
      command: "scripts/vps/drift-check.sh deribit-stage6",
    }),
    null,
  );
  assert.match(
    _test.buildDeribitLiveHotPatchBlockReason({
      session,
      command: "scripts/vps/deploy-release.sh deribit-stage6 --restart-main-services true && sudo rm /srv/deribit-options-seller/current/skills/deribit-options-seller/scripts/deribit_options_seller.mjs",
    }),
    /live hot patch/,
  );
  assert.match(
    _test.buildDeribitLiveHotPatchBlockReason({
      session,
      command: "scripts/vps/deploy-release.sh deribit-stage6 --restart-main-services true > /srv/deribit-options-seller/shared/config/override.json",
    }),
    /shared config\/state\/env/,
  );
});

test("Deribit trading service restarts require manual owner approval", () => {
  const session = {
    truthProfile: { id: "trading-deribit" },
  };

  assert.match(
    _test.buildDeribitRestartApprovalReason({
      session,
      command: "scripts/vps/deploy-release.sh deribit-stage6 --restart-main-services true",
    }),
    /manual owner approval/,
  );
  assert.match(
    _test.buildDeribitRestartApprovalReason({
      session,
      command: "ssh deribit-stage6 sudo systemctl restart com.wukong.deribit-options-seller.watch.service",
    }),
    /manual owner approval/,
  );
  assert.equal(
    _test.buildDeribitRestartApprovalReason({
      session,
      command: "scripts/vps/drift-check.sh deribit-stage6",
    }),
    null,
  );
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
