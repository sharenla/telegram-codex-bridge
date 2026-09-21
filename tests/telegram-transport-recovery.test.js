const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _test } = require("../index.js");

test("Telegram transport recovery switches away from the failed leaf and verifies the new route", async () => {
  const selected = [];
  const controller = {
    async getProxies() {
      return {
        proxies: {
          Telegram: {
            type: "Selector",
            now: "Proxies",
            all: ["Proxies", "Japan 04", "Hong Kong 01"],
          },
          Proxies: {
            type: "Selector",
            now: "Japan 04",
            all: ["Japan 04", "Hong Kong 01"],
          },
          "Japan 04": {
            type: "AnyTLS",
            alive: true,
            history: [{ delay: 20 }],
          },
          "Hong Kong 01": {
            type: "AnyTLS",
            alive: true,
            history: [{ delay: 25 }],
          },
        },
      };
    },
    async selectProxy(groupName, proxyName) {
      selected.push([groupName, proxyName]);
    },
  };

  const result = await _test.recoverTelegramTransport({
    controller,
    verifyTelegram: async () => ({ id: 42, username: "bridge_bot" }),
    groupName: "Telegram",
  });

  assert.deepEqual(selected, [["Telegram", "Hong Kong 01"]]);
  assert.deepEqual(result, {
    recovered: true,
    previousSelection: "Proxies",
    previousLeaf: "Japan 04",
    selectedProxy: "Hong Kong 01",
    attempted: ["Hong Kong 01"],
  });
});

test("Clash controller discovery reads the local Unix socket without exposing config details", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-clash-controller-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, "clash.yaml");
  fs.writeFileSync(configPath, [
    "mixed-port: 1082",
    "external-controller: ''",
    "external-controller-unix: /tmp/verge/test-mihomo.sock",
    "secret: 'controller-secret'",
  ].join("\n"));

  const result = _test.resolveClashControllerConfig({
    env: {},
    configCandidates: [configPath],
  });

  assert.deepEqual(result, {
    socketPath: "/tmp/verge/test-mihomo.sock",
    baseUrl: null,
    secret: "controller-secret",
    groupName: "Telegram",
    source: configPath,
  });
});

test("Clash controller reads proxy state and selects a route through its API boundary", async () => {
  const requests = [];
  const requestJson = async (request) => {
    requests.push(request);
    if (request.method === "GET") {
      return { proxies: { Telegram: { type: "Selector" } } };
    }
    return null;
  };

  const controller = _test.createClashController({
    socketPath: "/tmp/verge/test-mihomo.sock",
    baseUrl: null,
    secret: "local-controller-secret",
  }, { requestJson });
  const snapshot = await controller.getProxies();
  await controller.selectProxy("Telegram", "Hong Kong 01");

  assert.equal(snapshot.proxies.Telegram.type, "Selector");
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/proxies",
      body: null,
      socketPath: "/tmp/verge/test-mihomo.sock",
      baseUrl: null,
      secret: "local-controller-secret",
    },
    {
      method: "PUT",
      path: "/proxies/Telegram",
      body: { name: "Hong Kong 01" },
      socketPath: "/tmp/verge/test-mihomo.sock",
      baseUrl: null,
      secret: "local-controller-secret",
    },
  ]);
});

test("Telegram transport recovery keeps trying candidates until the Telegram probe succeeds", async () => {
  const selected = [];
  let probes = 0;
  const controller = {
    async getProxies() {
      return {
        proxies: {
          Telegram: { type: "Selector", now: "Japan 04", all: ["Japan 04", "Hong Kong 01", "Singapore 01"] },
          "Japan 04": { type: "AnyTLS", alive: true, history: [{ delay: 15 }] },
          "Hong Kong 01": { type: "AnyTLS", alive: true, history: [{ delay: 20 }] },
          "Singapore 01": { type: "AnyTLS", alive: true, history: [{ delay: 30 }] },
        },
      };
    },
    async selectProxy(groupName, proxyName) {
      selected.push([groupName, proxyName]);
    },
  };

  const result = await _test.recoverTelegramTransport({
    controller,
    verifyTelegram: async () => {
      probes += 1;
      if (probes === 1) throw new Error("Telegram TLS probe failed");
      return { id: 42 };
    },
    groupName: "Telegram",
  });

  assert.deepEqual(selected, [
    ["Telegram", "Hong Kong 01"],
    ["Telegram", "Singapore 01"],
  ]);
  assert.equal(result.recovered, true);
  assert.equal(result.selectedProxy, "Singapore 01");
  assert.deepEqual(result.attempted, ["Hong Kong 01", "Singapore 01"]);
});

test("Telegram transport recovery restores the previous selector when every candidate fails", async () => {
  const selected = [];
  const controller = {
    async getProxies() {
      return {
        proxies: {
          Telegram: { type: "Selector", now: "Proxies", all: ["Proxies", "Hong Kong 01", "Singapore 01"] },
          Proxies: { type: "Selector", now: "Japan 04", all: ["Japan 04"] },
          "Japan 04": { type: "AnyTLS", alive: true, history: [{ delay: 15 }] },
          "Hong Kong 01": { type: "AnyTLS", alive: true, history: [{ delay: 20 }] },
          "Singapore 01": { type: "AnyTLS", alive: true, history: [{ delay: 30 }] },
        },
      };
    },
    async selectProxy(groupName, proxyName) {
      selected.push([groupName, proxyName]);
    },
  };

  const result = await _test.recoverTelegramTransport({
    controller,
    verifyTelegram: async () => {
      throw new Error("Telegram TLS probe failed");
    },
    groupName: "Telegram",
  });

  assert.deepEqual(selected, [
    ["Telegram", "Hong Kong 01"],
    ["Telegram", "Singapore 01"],
    ["Telegram", "Proxies"],
  ]);
  assert.equal(result.recovered, false);
  assert.equal(result.restoredSelection, "Proxies");
  assert.equal(result.restoreError, null);
});

test("event-driven recovery only classifies Telegram transport failures as recoverable", () => {
  assert.equal(
    _test.isTelegramTransportRecoveryError(
      new Error("Telegram API getUpdates transport failed: curl: (35) SSL_ERROR_SYSCALL"),
    ),
    true,
  );
  assert.equal(
    _test.isTelegramTransportRecoveryError(
      new Error("Telegram API getUpdates failed: 409 Conflict: terminated by other getUpdates request"),
    ),
    false,
  );
  assert.equal(
    _test.isTelegramTransportRecoveryError(new Error("Telegram API getMe failed: 401 Unauthorized")),
    false,
  );
});

test("event-driven recovery waits for its error threshold and then verifies a switched route", async () => {
  const selected = [];
  let probeCount = 0;
  const controller = {
    async getProxies() {
      return {
        proxies: {
          Telegram: { type: "Selector", now: "Japan 04", all: ["Japan 04", "Hong Kong 01"] },
          "Japan 04": { type: "AnyTLS", alive: true, history: [{ delay: 15 }] },
          "Hong Kong 01": { type: "AnyTLS", alive: true, history: [{ delay: 20 }] },
        },
      };
    },
    async selectProxy(groupName, proxyName) {
      selected.push([groupName, proxyName]);
    },
  };
  const manager = _test.createTelegramTransportRecoveryManager({
    controller,
    telegram: {
      async probe() {
        probeCount += 1;
        return { id: 42 };
      },
    },
    groupName: "Telegram",
    errorThreshold: 3,
    cooldownMs: 0,
    logger: { info() {}, warn() {} },
  });
  const error = new Error("Telegram API getUpdates transport failed: curl: (35) SSL_ERROR_SYSCALL");

  const belowThreshold = await manager.maybeRecover({ error, consecutiveErrors: 2 });
  const recovered = await manager.maybeRecover({ error, consecutiveErrors: 3 });

  assert.deepEqual(belowThreshold, { attempted: false, recovered: false, reason: "below-threshold" });
  assert.equal(recovered.attempted, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.selectedProxy, "Hong Kong 01");
  assert.deepEqual(selected, [["Telegram", "Hong Kong 01"]]);
  assert.equal(probeCount, 1);
});

test("event-driven recovery advances past candidates that already failed in the same outage", async () => {
  const selected = [];
  const controller = {
    async getProxies() {
      return {
        proxies: {
          Telegram: { type: "Selector", now: "Current", all: ["Current", "Node 1", "Node 2", "Node 3", "Node 4"] },
          Current: { type: "AnyTLS", alive: true, history: [{ delay: 10 }] },
          "Node 1": { type: "AnyTLS", alive: true, history: [{ delay: 20 }] },
          "Node 2": { type: "AnyTLS", alive: true, history: [{ delay: 30 }] },
          "Node 3": { type: "AnyTLS", alive: true, history: [{ delay: 40 }] },
          "Node 4": { type: "AnyTLS", alive: true, history: [{ delay: 50 }] },
        },
      };
    },
    async getConfigVersion() {
      return "profile-v1";
    },
    async selectProxy(groupName, proxyName) {
      selected.push([groupName, proxyName]);
    },
  };
  const manager = _test.createTelegramTransportRecoveryManager({
    controller,
    telegram: {
      async probe() {
        throw new Error("Telegram TLS probe failed");
      },
    },
    groupName: "Telegram",
    errorThreshold: 1,
    maxCandidates: 2,
    cooldownMs: 0,
    logger: { info() {}, warn() {} },
  });
  const error = new Error("Telegram API getUpdates transport failed: curl: (35) SSL_ERROR_SYSCALL");

  const first = await manager.maybeRecover({ error, consecutiveErrors: 1 });
  const second = await manager.maybeRecover({ error, consecutiveErrors: 2 });

  assert.deepEqual(first.attemptedCandidates, ["Node 1", "Node 2"]);
  assert.deepEqual(second.attemptedCandidates, ["Node 3", "Node 4"]);
  assert.deepEqual(selected, [
    ["Telegram", "Node 1"],
    ["Telegram", "Node 2"],
    ["Telegram", "Current"],
    ["Telegram", "Node 3"],
    ["Telegram", "Node 4"],
    ["Telegram", "Current"],
  ]);
});

test("event-driven recovery realigns when the active Clash profile changes", async () => {
  const selected = [];
  let profileVersion = "profile-v1";
  const controller = {
    async getProxies() {
      return {
        proxies: {
          Telegram: { type: "Selector", now: "Current", all: ["Current", "Node 1", "Node 2"] },
          Current: { type: "AnyTLS", alive: true, history: [{ delay: 10 }] },
          "Node 1": { type: "AnyTLS", alive: true, history: [{ delay: 20 }] },
          "Node 2": { type: "AnyTLS", alive: true, history: [{ delay: 30 }] },
        },
      };
    },
    async getConfigVersion() {
      return profileVersion;
    },
    async selectProxy(groupName, proxyName) {
      selected.push([groupName, proxyName]);
    },
  };
  const manager = _test.createTelegramTransportRecoveryManager({
    controller,
    telegram: { async probe() { throw new Error("Telegram TLS probe failed"); } },
    groupName: "Telegram",
    errorThreshold: 1,
    maxCandidates: 1,
    cooldownMs: 0,
    logger: { info() {}, warn() {} },
  });
  const error = new Error("Telegram API getUpdates transport failed: curl: (35) SSL_ERROR_SYSCALL");

  await manager.maybeRecover({ error, consecutiveErrors: 1 });
  profileVersion = "profile-v2";
  const afterProfileChange = await manager.maybeRecover({ error, consecutiveErrors: 2 });

  assert.deepEqual(afterProfileChange.attemptedCandidates, ["Node 1"]);
  assert.deepEqual(selected, [
    ["Telegram", "Node 1"],
    ["Telegram", "Current"],
    ["Telegram", "Node 1"],
    ["Telegram", "Current"],
  ]);
});

test("event-driven recovery forgets the failed range after polling becomes healthy", async () => {
  const selected = [];
  const controller = {
    async getProxies() {
      return {
        proxies: {
          Telegram: { type: "Selector", now: "Current", all: ["Current", "Node 1", "Node 2"] },
          Current: { type: "AnyTLS", alive: true, history: [{ delay: 10 }] },
          "Node 1": { type: "AnyTLS", alive: true, history: [{ delay: 20 }] },
          "Node 2": { type: "AnyTLS", alive: true, history: [{ delay: 30 }] },
        },
      };
    },
    async selectProxy(groupName, proxyName) {
      selected.push([groupName, proxyName]);
    },
  };
  const manager = _test.createTelegramTransportRecoveryManager({
    controller,
    telegram: { async probe() { throw new Error("Telegram TLS probe failed"); } },
    groupName: "Telegram",
    errorThreshold: 1,
    maxCandidates: 1,
    cooldownMs: 0,
    logger: { info() {}, warn() {} },
  });
  const error = new Error("Telegram API getUpdates transport failed: curl: (35) SSL_ERROR_SYSCALL");

  await manager.maybeRecover({ error, consecutiveErrors: 1 });
  manager.markHealthy();
  const nextOutage = await manager.maybeRecover({ error, consecutiveErrors: 1 });

  assert.deepEqual(nextOutage.attemptedCandidates, ["Node 1"]);
  assert.deepEqual(selected, [
    ["Telegram", "Node 1"],
    ["Telegram", "Current"],
    ["Telegram", "Node 1"],
    ["Telegram", "Current"],
  ]);
});

test("polling recovery clears stale failed candidates after an external Clash change", () => {
  const health = {
    lastPollSuccessAt: 200,
    lastTransportRecoveryAttemptAt: 100,
    lastTransportRecoveryStatus: "candidates-exhausted",
    lastTransportRecoveryCandidates: ["Old Node 1", "Old Node 2"],
  };

  const changed = _test.reconcileTelegramTransportRecoveryHealth(health);

  assert.equal(changed, true);
  assert.equal(health.lastTransportRecoveryStatus, "polling-recovered-after-external-change");
  assert.deepEqual(health.lastTransportRecoveryCandidates, []);
  assert.equal(health.lastTransportRecoveryObservedRecoveryAt, 200);
});
