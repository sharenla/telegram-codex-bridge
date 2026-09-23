const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _test } = require("../index.js");

test("runtime Clash config is preferred over the legacy Verge settings file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-clash-priority-"));
  const runtime = path.join(dir, "config.yaml");
  const legacy = path.join(dir, "clash-verge.yaml");
  fs.writeFileSync(runtime, "external-controller: 127.0.0.1:9097\nsecret: runtime-secret\n");
  fs.writeFileSync(legacy, "external-controller-unix: /tmp/legacy.sock\nsecret: legacy-secret\n");
  try {
    const result = _test.resolveClashControllerConfig({ env: {}, configCandidates: [runtime, legacy] });
    assert.equal(result.baseUrl, "http://127.0.0.1:9097");
    assert.equal(result.source, runtime);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unreachable Clash socket reports a Chinese reason without the secret", async () => {
  const config = { socketPath: "/tmp/does-not-exist.sock", baseUrl: null, secret: "super-secret", source: "runtime-config" };
  const result = await _test.probeClashControllerAvailability(config, {
    requestJson: async () => { throw Object.assign(new Error("connect ENOENT /tmp/does-not-exist.sock"), { code: "ENOENT" }); },
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /找不到 Clash 控制器/);
  assert.doesNotMatch(JSON.stringify(result), /super-secret/);
});

test("reachable TCP Clash controller is available and status never exposes secret", async () => {
  const config = { socketPath: null, baseUrl: "http://127.0.0.1:9097", secret: "super-secret", source: "runtime-config" };
  const result = await _test.probeClashControllerAvailability(config, { requestJson: async () => ({ version: "1" }) });
  assert.deepEqual(result, { available: true, source: "runtime-config" });
  assert.doesNotMatch(_test.formatClashFailoverStatus(result), /super-secret/);
});

test("unavailable Clash status is logged only once when failover is skipped", () => {
  const health = {};
  const logs = [];
  assert.equal(_test.markClashFailoverUnavailable(health, new Error("ENOENT"), { logger: line => logs.push(line) }), true);
  assert.equal(_test.markClashFailoverUnavailable(health, new Error("ENOENT"), { logger: line => logs.push(line) }), false);
  assert.equal(logs.length, 1);
  assert.match(_test.formatClashFailoverStatus(health.clashFailover), /unavailable/);
});
