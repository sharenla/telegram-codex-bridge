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
