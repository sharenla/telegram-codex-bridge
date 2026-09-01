const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const zlib = require("node:zlib");

const repoRoot = path.resolve(__dirname, "..");
const rotationScript = path.join(repoRoot, "scripts", "rotate-bridge-logs.sh");

function runRotation(logDir, overrides = {}) {
  execFileSync("/bin/zsh", [rotationScript], {
    env: {
      ...process.env,
      BRIDGE_LOG_DIR: logDir,
      BRIDGE_STDERR_MAX_BYTES: "128",
      BRIDGE_STDOUT_MAX_BYTES: "128",
      BRIDGE_LOG_RETAIN_FILES: "7",
      BRIDGE_LOG_MAX_AGE_DAYS: "14",
      BRIDGE_LOG_TOTAL_MAX_BYTES: "4096",
      ...overrides,
    },
    stdio: "pipe",
  });
}

function checkRotationNeeded(logDir, overrides = {}) {
  return spawnSync("/bin/zsh", [rotationScript, "--needs-rotation"], {
    env: {
      ...process.env,
      BRIDGE_LOG_DIR: logDir,
      BRIDGE_STDERR_MAX_BYTES: "128",
      BRIDGE_STDOUT_MAX_BYTES: "128",
      ...overrides,
    },
    stdio: "pipe",
  });
}

test("needs-rotation mode reports whether an active log crossed its threshold", (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-log-check-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(logDir, "bridge.stderr.log"), "healthy\n");
  fs.writeFileSync(path.join(logDir, "bridge.stdout.log"), "healthy\n");
  assert.equal(checkRotationNeeded(logDir).status, 1);

  fs.appendFileSync(path.join(logDir, "bridge.stderr.log"), "x".repeat(256));
  assert.equal(checkRotationNeeded(logDir).status, 0);
});

test("oversized logs rotate compressed and redact credentials", (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-log-rotation-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  const stderrPath = path.join(logDir, "bridge.stderr.log");
  const stdoutPath = path.join(logDir, "bridge.stdout.log");
  const secretToken = "123456789:secret-bot-token";
  fs.writeFileSync(stderrPath, [
    `Command failed: curl https://api.telegram.org/bot${secretToken}/getUpdates`,
    "Authorization: Bearer secret-access-token",
    "OPENAI_API_KEY=secret-api-key",
    "x".repeat(256),
  ].join("\n"));
  fs.writeFileSync(stdoutPath, "healthy\n");

  runRotation(logDir);

  assert.equal(fs.statSync(stderrPath).size, 0);
  assert.equal(fs.readFileSync(stdoutPath, "utf8"), "healthy\n");
  const archives = fs.readdirSync(logDir).filter((name) => name.startsWith("bridge.stderr.log.") && name.endsWith(".gz"));
  assert.equal(archives.length, 1);
  const archivedText = zlib.gunzipSync(fs.readFileSync(path.join(logDir, archives[0]))).toString("utf8");
  assert.doesNotMatch(archivedText, /secret-bot-token|secret-access-token|secret-api-key/);
  assert.match(archivedText, /bot<redacted>\/getUpdates/);
  assert.match(archivedText, /Authorization: Bearer <redacted>/);
  assert.match(archivedText, /OPENAI_API_KEY=<redacted>/);
});

test("retention count and total cap remove oldest archives first", (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-bridge-log-retention-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(logDir, "bridge.stderr.log"), "");
  fs.writeFileSync(path.join(logDir, "bridge.stdout.log"), "");
  for (const stamp of ["20260820-000000", "20260821-000000", "20260822-000000"]) {
    fs.writeFileSync(path.join(logDir, `bridge.stderr.log.${stamp}.1.gz`), Buffer.alloc(100, stamp));
  }

  runRotation(logDir, {
    BRIDGE_LOG_RETAIN_FILES: "2",
    BRIDGE_LOG_TOTAL_MAX_BYTES: "150",
  });

  const archives = fs.readdirSync(logDir)
    .filter((name) => name.endsWith(".gz"))
    .sort();
  assert.deepEqual(archives, ["bridge.stderr.log.20260822-000000.1.gz"]);
});
