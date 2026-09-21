const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const installScript = path.join(repoRoot, "scripts", "install-launch-agent.sh");
const uninstallScript = path.join(repoRoot, "scripts", "uninstall-launch-agent.sh");

test("specialist profiles auto-approve routine requests while keeping read-only defaults", () => {
  for (const instance of ["strategy-observation", "rv-prediction"]) {
    const envTemplate = fs.readFileSync(
      path.join(repoRoot, "config", "instances", `${instance}.env.example`),
      "utf8",
    );
    assert.match(envTemplate, /^CODEX_APPROVAL_POLICY=on-request$/m);
    assert.match(envTemplate, /^CODEX_SANDBOX=read-only$/m);
    assert.match(envTemplate, /^AUTO_APPROVE=1$/m);
  }
});

function specialistEnv(homeDir, envFile, roleFile) {
  return {
    ...process.env,
    HOME: homeDir,
    NODE_BIN: process.execPath,
    CODEX_BIN: process.execPath,
    BRIDGE_ENV_FILE: envFile,
    BRIDGE_ROLE_FILE: roleFile,
    BRIDGE_LAUNCH_AGENT_DRY_RUN: "1",
  };
}

test("named LaunchAgent install isolates service state and seeds its Codex role", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-instance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, "strategy.env");
  const roleFile = path.join(root, "AGENTS.md");
  fs.writeFileSync(envFile, [
    "TELEGRAM_BOT_TOKEN=123456789:test-token",
    "TELEGRAM_ALLOWLIST=123456789,-1001234567890",
    "CODEX_SANDBOX=read-only",
    "CODEX_CONTEXT_SYNC_AGENTS=0",
    "CODEX_CONTEXT_SYNC_MEMORIES=0",
    "",
  ].join("\n"));
  fs.writeFileSync(roleFile, "# Strategy Observation Researcher\n");

  const result = spawnSync("/bin/zsh", [installScript, "strategy-observation"], {
    env: specialistEnv(root, envFile, roleFile),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const serviceRoot = path.join(root, "Library", "Application Support", "telegram-codex-bridge-strategy-observation-service");
  const plistPath = path.join(root, "Library", "LaunchAgents", "com.sharenla.telegram-codex-bridge.strategy-observation.plist");
  const installedEnv = path.join(serviceRoot, ".env");
  const installedRole = path.join(serviceRoot, "data", "codex-home", "AGENTS.md");
  assert.equal(fs.readFileSync(installedEnv, "utf8"), fs.readFileSync(envFile, "utf8"));
  assert.equal(fs.statSync(installedEnv).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(installedRole, "utf8"), "# Strategy Observation Researcher\n");

  const plist = fs.readFileSync(plistPath, "utf8");
  assert.match(plist, /com\.sharenla\.telegram-codex-bridge\.strategy-observation/);
  assert.match(plist, /<key>BRIDGE_INSTANCE_ID<\/key>\s*<string>strategy-observation<\/string>/);
  assert.match(plist, /telegram-codex-bridge-strategy-observation-service\/data\/store\.json/);
  assert.match(plist, /telegram-codex-bridge-strategy-observation-service\/data\/codex-home/);
  assert.doesNotMatch(plist, /test-token/);
});

test("default LaunchAgent keeps its legacy label and service root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-default-instance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, "default.env");
  fs.writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=123456789:test-token\nTELEGRAM_ALLOWLIST=123456789\n");

  const result = spawnSync("/bin/zsh", [installScript, "default"], {
    env: {
      ...process.env,
      HOME: root,
      NODE_BIN: process.execPath,
      CODEX_BIN: process.execPath,
      BRIDGE_ENV_FILE: envFile,
      BRIDGE_LAUNCH_AGENT_DRY_RUN: "1",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const plistPath = path.join(root, "Library", "LaunchAgents", "com.sharenla.telegram-codex-bridge.plist");
  const plist = fs.readFileSync(plistPath, "utf8");
  assert.match(plist, /Application Support\/telegram-codex-bridge-service\/data\/store\.json/);
  assert.doesNotMatch(plist, /telegram-codex-bridge-default-service/);
});

test("named LaunchAgent install rejects incomplete credentials and invalid ids", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-instance-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, "invalid.env");
  const roleFile = path.join(root, "AGENTS.md");
  fs.writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=replace_me\nTELEGRAM_ALLOWLIST=123\n");
  fs.writeFileSync(roleFile, "# Role\n");

  const incomplete = spawnSync("/bin/zsh", [installScript, "rv-prediction"], {
    env: specialistEnv(root, envFile, roleFile),
    encoding: "utf8",
  });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /TELEGRAM_BOT_TOKEN is missing or still a placeholder/);

  const invalid = spawnSync("/bin/zsh", [installScript, "../bad"], {
    env: specialistEnv(root, envFile, roleFile),
    encoding: "utf8",
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /instance-id must match/);
});

test("named LaunchAgent uninstall resolves the matching label without deleting service data", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-uninstall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("/bin/zsh", [uninstallScript, "rv-prediction"], {
    env: {
      ...process.env,
      HOME: root,
      BRIDGE_LAUNCH_AGENT_DRY_RUN: "1",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /com\.sharenla\.telegram-codex-bridge\.rv-prediction/);
  assert.match(result.stdout, /telegram-codex-bridge-rv-prediction-service\/data/);
});
