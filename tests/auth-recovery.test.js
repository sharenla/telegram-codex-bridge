const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _test } = require("../index.js");

function makeJwt({ email, accountId, exp = Math.floor(Date.now() / 1000) + 3600 }) {
  const payload = {
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
    "https://api.openai.com/profile": {
      email,
    },
  };
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

test("isAccountAuthFailureText matches stderr auth watchdog patterns", () => {
  assert.equal(_test.isAccountAuthFailureText("refresh_token_reused"), true);
  assert.equal(_test.isAccountAuthFailureText("token_expired while refreshing"), true);
  assert.equal(_test.isAccountAuthFailureText("HTTP 401 Unauthorized"), true);
  assert.equal(_test.isAccountAuthFailureText("429 rate limit exceeded"), false);
});

test("buildAuthRecoveryReplayTask preserves turn metadata and increments replay count once", () => {
  const task = _test.buildAuthRecoveryReplayTask({
    text: "继续修这个 bug",
    attemptedProfileIds: ["acct-a"],
    kind: "user",
    silent: false,
    contextRetryCount: 1,
    authReplayCount: 0,
  }, "active_turn", "2026-04-15T00:00:00.000Z");

  assert.deepEqual(task, {
    text: "继续修这个 bug",
    attemptedProfileIds: ["acct-a"],
    kind: "user",
    silent: false,
    contextRetryCount: 1,
    authReplayCount: 1,
    source: "active_turn",
    createdAt: "2026-04-15T00:00:00.000Z",
  });
});

test("buildAuthRecoveryReplayTask stops after one automatic replay", () => {
  const task = _test.buildAuthRecoveryReplayTask({
    text: "这次不该再自动续跑了",
    authReplayCount: 1,
  });

  assert.equal(task, null);
});

test("buildAuthRecoveryReplayTask preserves stale-thread retry count when present", () => {
  const task = _test.buildAuthRecoveryReplayTask({
    text: "刚才 thread 失效后还在恢复认证",
    threadRetryCount: 1,
  }, "auth_failure", "2026-04-15T00:00:00.000Z");

  assert.equal(task.threadRetryCount, 1);
});

test("getReplayableAuthRecoveryTaskFromRuntime refuses second replay handoff", () => {
  const task = _test.getReplayableAuthRecoveryTaskFromRuntime({
    pendingInputMeta: {
      text: "刚才 replay 过一次的输入",
      authReplayCount: 1,
    },
  });

  assert.equal(task, null);
});

test("getReplayableAuthRecoveryTaskFromRuntime builds first pending replay task", () => {
  const task = _test.getReplayableAuthRecoveryTaskFromRuntime({
    pendingInputMeta: {
      text: "第一次可以续跑",
      authReplayCount: 0,
    },
  });

  assert.equal(task.text, "第一次可以续跑");
  assert.equal(task.source, "pending_request");
  assert.equal(task.authReplayCount, 1);
});

test("isAccountProfileAccessExpired respects access-token expiry skew", () => {
  const nowMs = Date.parse("2026-04-25T00:00:00.000Z");
  assert.equal(
    _test.isAccountProfileAccessExpired({ expires: nowMs + 4 * 60 * 1000 }, nowMs, 5 * 60 * 1000),
    true,
  );
  assert.equal(
    _test.isAccountProfileAccessExpired({ expires: nowMs + 6 * 60 * 1000 }, nowMs, 5 * 60 * 1000),
    false,
  );
  assert.equal(_test.isAccountProfileAccessExpired({ expires: 0 }, nowMs), false);
});

test("isMissingThreadRequestError matches stale app-server thread errors only", () => {
  assert.equal(
    _test.isMissingThreadRequestError(Object.assign(new Error("thread not found: 019da5a0"), {
      rpcError: { code: -32600, message: "thread not found: 019da5a0" },
    })),
    true,
  );
  assert.equal(_test.isMissingThreadRequestError(new Error("401 Unauthorized")), false);
});

test("account priority keeps configured last-resort profiles at the end", () => {
  const selectors = _test.normalizeAccountSelectorList("zheng_zhonghuai@163.com, openai-codex:backup");
  const profiles = [
    { profileId: "openai-codex:backup", label: "backup@example.com" },
    { profileId: "openai-codex:alpha", label: "alpha@example.com" },
    { profileId: "openai-codex:163", label: "zheng_zhonghuai@163.com" },
  ].map((profile) => ({
    ...profile,
    lastResort: _test.isAccountProfileLastResort(profile, selectors),
  }));

  assert.deepEqual(
    _test.sortAccountProfilesByPriority(profiles).map((profile) => profile.profileId),
    ["openai-codex:alpha", "openai-codex:backup", "openai-codex:163"],
  );
  assert.deepEqual(
    _test.prioritizeAccountProfiles([
      profiles[2],
      profiles[1],
      profiles[0],
    ]).map((profile) => profile.profileId),
    ["openai-codex:alpha", "openai-codex:163", "openai-codex:backup"],
  );
});

test("account failover keeps priority order and tries stale access before last-resort", () => {
  const profiles = [
    { profileId: "openai-codex:qq", label: "76970041@qq.com", expires: 1 },
    { profileId: "openai-codex:gmail", label: "cooopus@gmail.com", expires: 4 },
    { profileId: "openai-codex:126", label: "zane1004@126.com", expires: 2 },
    { profileId: "openai-codex:outlook", label: "zane1004@outlook.com", expires: 5 },
    { profileId: "openai-codex:163", label: "zheng_zhonghuai@163.com", expires: 6, lastResort: true },
  ];

  assert.deepEqual(
    _test.orderAccountProfilesForFailover(profiles, {
      attemptedProfileIds: new Set(["openai-codex:gmail"]),
    }).map((profile) => profile.profileId),
    [
      "openai-codex:qq",
      "openai-codex:126",
      "openai-codex:outlook",
      "openai-codex:163",
    ],
  );
});

test("loadCodexAccountProfiles merges multiple pools and keeps freshest account token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-auth-pools-"));
  const poolA = path.join(root, "pool-a", "auth-profiles.json");
  const poolB = path.join(root, "pool-b", "auth-profiles.json");
  fs.mkdirSync(path.dirname(poolA), { recursive: true });
  fs.mkdirSync(path.dirname(poolB), { recursive: true });

  fs.writeFileSync(poolA, JSON.stringify({
    profiles: {
      "openai-codex:shared": {
        type: "oauth",
        provider: "openai-codex",
        accountId: "acct-shared",
        access: makeJwt({ email: "shared@example.com", accountId: "acct-shared", exp: 1000 }),
        refresh: "refresh-shared-old",
        expires: 1000_000,
      },
      "openai-codex:codex-cli": {
        type: "oauth",
        provider: "openai-codex",
        accountId: "acct-163",
        access: makeJwt({ email: "zheng_zhonghuai@163.com", accountId: "acct-163", exp: 2000 }),
        refresh: "refresh-163",
        expires: 2000_000,
      },
    },
  }));
  fs.writeFileSync(poolB, JSON.stringify({
    profiles: {
      "openai-codex:shared": {
        type: "oauth",
        provider: "openai-codex",
        accountId: "acct-shared",
        access: makeJwt({ email: "shared@example.com", accountId: "acct-shared", exp: 3000 }),
        refresh: "refresh-shared-new",
        expires: 3000_000,
      },
      "openai-codex:codex-cli": {
        type: "oauth",
        provider: "openai-codex",
        accountId: "acct-gmail",
        access: makeJwt({ email: "cooopus@gmail.com", accountId: "acct-gmail", exp: 4000 }),
        refresh: "refresh-gmail",
        expires: 4000_000,
      },
    },
  }));

  const profiles = _test.loadCodexAccountProfiles(`${poolA},${poolB}`, {
    lastResortAccounts: "zheng_zhonghuai@163.com",
  });
  const shared = profiles.find((profile) => profile.accountId === "acct-shared");
  const gmail = profiles.find((profile) => profile.accountId === "acct-gmail");
  const lastResort = profiles.find((profile) => profile.accountId === "acct-163");

  assert.equal(shared.expires, 3000_000);
  assert.equal(gmail.label, "cooopus@gmail.com");
  assert.match(gmail.profileId, /^openai-codex:codex-cli@/);
  assert.equal(lastResort.lastResort, true);
  assert.equal(profiles.at(-1).accountId, "acct-163");
});

test("configureCodexLbProvider writes isolated Codex CLI provider block", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codex-lb-"));
  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(configPath, [
    "model = \"gpt-5.4\"",
    "",
    "[features]",
    "memories = true",
    "",
  ].join("\n"));

  const result = _test.configureCodexLbProvider({
    codexHome,
    enabled: true,
    baseUrl: "http://127.0.0.1:2455/backend-api/codex",
    envKey: "CODEX_LB_API_KEY",
  });

  const text = fs.readFileSync(configPath, "utf8");
  assert.equal(result.configured, true);
  assert.match(text, /model = "gpt-5.4"/);
  assert.match(text, /model_provider = "codex-lb"/);
  assert.ok(text.indexOf('model_provider = "codex-lb"') < text.indexOf("[features]"));
  assert.ok(text.indexOf("[model_providers.codex-lb]") > text.indexOf("[features]"));
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:2455\/backend-api\/codex"/);
  assert.match(text, /wire_api = "responses"/);
  assert.match(text, /env_key = "CODEX_LB_API_KEY"/);
  assert.match(text, /requires_openai_auth = true/);
});

test("applyCodexBackendSessionBoundary resets saved threads when enabling codex-lb", () => {
  const storeData = {
    bridge: {},
    sessions: {
      "123": {
        threadId: "old-openai-thread",
        contextTokens: 100,
        compactionPending: true,
        compactionSummary: { text: "keep summary" },
      },
      "456": {
        threadId: null,
      },
    },
  };

  const result = _test.applyCodexBackendSessionBoundary(storeData, {
    enabled: true,
    provider: "codex-lb",
    baseUrl: "http://127.0.0.1:2455/backend-api/codex",
  });

  assert.equal(result.changed, true);
  assert.equal(result.resetCount, 1);
  assert.equal(storeData.sessions["123"].threadId, null);
  assert.equal(storeData.sessions["123"].contextTokens, null);
  assert.equal(storeData.sessions["123"].compactionPending, false);
  assert.deepEqual(storeData.sessions["123"].compactionSummary, { text: "keep summary" });
  assert.equal(storeData.bridge.codexBackendConfig.mode, "codex-lb");
  assert.equal(storeData.bridge.codexBackendConfig.configVersion, 2);
});

test("applyCodexBackendSessionBoundary leaves threads alone when backend signature is unchanged", () => {
  const storeData = {
    bridge: {
      codexBackendConfig: {
        mode: "codex-lb",
        provider: "codex-lb",
        baseUrl: "http://127.0.0.1:2455/backend-api/codex",
        configVersion: 2,
      },
    },
    sessions: {
      "123": {
        threadId: "current-thread",
      },
    },
  };

  const result = _test.applyCodexBackendSessionBoundary(storeData, {
    enabled: true,
    provider: "codex-lb",
    baseUrl: "http://127.0.0.1:2455/backend-api/codex",
  });

  assert.equal(result.changed, false);
  assert.equal(result.resetCount, 0);
  assert.equal(storeData.sessions["123"].threadId, "current-thread");
});

test("summarizeCodexBackendHealth highlights recovery and last error", () => {
  const summary = _test.summarizeCodexBackendHealth({
    state: "recovering",
    recoveryInProgress: true,
    recoveryReason: "refresh_token_reused",
    lastOkAt: Date.now() - 30_000,
    lastErrorAt: Date.now() - 5_000,
    lastError: "refresh_token_reused",
  });

  assert.match(summary, /^recovering,/);
  assert.match(summary, /last ok/);
  assert.match(summary, /last err/);
  assert.match(summary, /recovering: refresh_token_reused/);
});
