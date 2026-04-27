#!/usr/bin/env node
/* eslint-disable no-console */

const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { setTimeout: sleep } = require("node:timers/promises");

require("dotenv").config();

const argv = new Set(process.argv.slice(2));
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const VALID_EFFORTS = new Set(EFFORT_LEVELS);
const RECOMMENDED_MODELS = [
  { id: "gpt-5.2", aliases: ["5.2"], description: "stable coding default" },
  { id: "gpt-5.4", aliases: ["5.4"], description: "stronger general coding model" },
  { id: "gpt-5.5", aliases: ["5.5"], description: "newer/highest tier option" },
];
const QUICK_MODELS = RECOMMENDED_MODELS.map((model) => model.id);
const QUICK_EFFORTS = ["low", "medium", "high", "xhigh"];
const DEFAULT_CONTEXT_SOFT_RATIO = 0.70;
const DEFAULT_CONTEXT_HARD_RATIO = 0.82;
const DEFAULT_CONTEXT_EMERGENCY_RATIO = 0.90;
const COMPACTION_SUMMARY_FORMAT = "five-section-markdown";
const COMPACTION_SUMMARY_VERSION = 1;
const SOURCE_TRUTH_BOOTSTRAP_VERSION = 1;
const DEFAULT_BRIDGE_LAUNCH_AGENT = "com.sharenla.telegram-codex-bridge";
const COMPACTION_SECTION_TITLES = [
  "当前目标",
  "已完成进展",
  "关键约束",
  "关键文件/路径",
  "下一步待办",
];
const MENU_PAGES = {
  MAIN: "main",
  THREAD: "thread",
  WORKSPACE: "workspace",
  MODEL: "model",
  ACCOUNT: "account",
};
const VALID_MENU_PAGES = new Set(Object.values(MENU_PAGES));
const ACCOUNT_FAILOVER_PATTERNS = [
  /\b429\b/i,
  /rate.?limit/i,
  /too many requests/i,
  /quota/i,
  /usage limit/i,
  /usage cap/i,
  /limit reached/i,
  /insufficient quota/i,
  /capacity/i,
  /overloaded/i,
  /billing/i,
];
const CONTEXT_FAILURE_PATTERNS = [
  /\bcontext(?:ual)?\s+(?:window|length)\b/i,
  /\bmaximum context length\b/i,
  /\bconversation too long\b/i,
  /\bthread too long\b/i,
  /\btoo many tokens\b/i,
  /\btoken limit\b/i,
  /\binput .*too long\b/i,
  /\bprompt .*too long\b/i,
  /\brequest .*too large\b/i,
  /\bexceeds?.*(?:context|token)\b/i,
  /\bover(?:flow| limit).*(?:context|token)\b/i,
  /\bcontext .*full\b/i,
  /\bmodel_context_window\b/i,
  /\bmax[_ ]?input[_ ]?tokens\b/i,
];
const ACCOUNT_AUTH_FAILURE_PATTERNS = [
  /refresh_token_reused/i,
  /token_expired/i,
  /401\s+Unauthorized/i,
  /could not be refreshed/i,
  /failed to refresh token/i,
  /failed to load configuration/i,
  /cloudRequirements/i,
  /timed out waiting for cloud requirements/i,
];
const ACCOUNT_HEALTH_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ACCOUNT_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const ACCOUNT_ACCESS_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const TELEGRAM_POLLING_STALL_THRESHOLD_MS = 3 * 60 * 1000;
const TELEGRAM_POLLING_RESTART_ERROR_THRESHOLD = 6;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 5;
const TELEGRAM_RETRYABLE_METHODS = new Set([
  "getUpdates",
  "getMe",
  "sendChatAction",
  "editMessageText",
  "answerCallbackQuery",
]);
const AUTH_RECOVERY_HANDOFF = Symbol("AUTH_RECOVERY_HANDOFF");
const CLASH_CONFIG_CANDIDATES = [
  path.join(os.homedir(), "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml"),
  path.join(os.homedir(), ".config", "mihomo", "config.yaml"),
  path.join(os.homedir(), ".config", "clash", "config.yaml"),
];

function resolveUserPath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return inputPath;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function maskProxyUrl(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return String(proxyUrl).replace(/\/\/[^/@]+@/, "//***:***@");
  }
}

function redactTelegramBotToken(text) {
  if (!text) return text;
  return String(text).replace(
    /https:\/\/api\.telegram\.org\/bot[^/\s]+/g,
    "https://api.telegram.org/bot<redacted>",
  );
}

function shouldRetryTelegramMethod(method) {
  return TELEGRAM_RETRYABLE_METHODS.has(String(method || ""));
}

function formatCurlTransportError(error, stderr, { timeoutMs = 0 } = {}) {
  const stderrText = stderr ? String(stderr).trim() : "";
  if (stderrText) return stderrText;

  if (timeoutMs && error?.killed && error?.signal) {
    return `timed out after ${timeoutMs}ms`;
  }

  const parts = [];
  if (typeof error?.code === "number") parts.push(`exit ${error.code}`);
  else if (typeof error?.code === "string") parts.push(error.code);
  if (error?.signal) parts.push(`signal ${error.signal}`);
  if (error?.killed) parts.push("killed");

  if (parts.length) return `curl failed (${parts.join(", ")})`;
  return "curl failed";
}

function detectLocalTelegramProxy() {
  for (const candidate of CLASH_CONFIG_CANDIDATES) {
    const text = readTextFile(candidate);
    if (!text) continue;

    const mixedPort = text.match(/^\s*mixed-port:\s*(\d+)\s*$/m);
    if (mixedPort) {
      return {
        url: `http://127.0.0.1:${mixedPort[1]}`,
        source: `${candidate}#mixed-port`,
      };
    }

    const httpPort = text.match(/^\s*port:\s*(\d+)\s*$/m);
    if (httpPort) {
      return {
        url: `http://127.0.0.1:${httpPort[1]}`,
        source: `${candidate}#port`,
      };
    }

    const socksPort = text.match(/^\s*socks-port:\s*(\d+)\s*$/m);
    if (socksPort) {
      return {
        url: `socks5h://127.0.0.1:${socksPort[1]}`,
        source: `${candidate}#socks-port`,
      };
    }
  }

  return { url: null, source: null };
}

function resolveTelegramProxyConfig() {
  const explicit = String(process.env.TELEGRAM_PROXY_URL || "").trim();
  if (explicit) {
    if (["0", "false", "off", "none", "direct"].includes(explicit.toLowerCase())) {
      return { url: null, source: "TELEGRAM_PROXY_URL=direct" };
    }
    return {
      url: resolveUserPath(explicit),
      source: "TELEGRAM_PROXY_URL",
    };
  }

  const envProxy = String(
    process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || process.env.ALL_PROXY
      || process.env.all_proxy
      || "",
  ).trim();
  if (envProxy) {
    return {
      url: envProxy,
      source: "HTTPS_PROXY/HTTP_PROXY/ALL_PROXY",
    };
  }

  if (!parseBooleanEnv(process.env.TELEGRAM_PROXY_AUTO, true)) {
    return { url: null, source: null };
  }

  return detectLocalTelegramProxy();
}

function resolveCodexBin() {
  const fromEnv = resolveUserPath(process.env.CODEX_BIN || "");
  if (fromEnv) return fromEnv;

  const appBundleBin = "/Applications/Codex.app/Contents/Resources/codex";
  if (fs.existsSync(appBundleBin)) return appBundleBin;

  return "codex";
}

function safeBase64UrlDecode(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function parseJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const decoded = safeBase64UrlDecode(parts[1]);
  if (!decoded) return null;
  return safeJsonParse(decoded);
}

function getJwtExpiryMs(token) {
  const payload = parseJwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
}

function maxFinitePositive(values) {
  const finite = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return finite.length ? Math.max(...finite) : 0;
}

function isAccessExpiryExpired(expiresMs, nowMs = Date.now(), skewMs = ACCOUNT_ACCESS_EXPIRY_SKEW_MS) {
  const value = Number(expiresMs || 0);
  if (!Number.isFinite(value) || value <= 0) return false;
  const skew = Math.max(0, Number(skewMs || 0));
  return value <= nowMs + skew;
}

function getAccountProfileAccessExpiryMs(profile) {
  return maxFinitePositive([
    profile?.expires,
    getJwtExpiryMs(profile?.access),
  ]);
}

function isAccountProfileAccessExpired(profile, nowMs = Date.now(), skewMs = ACCOUNT_ACCESS_EXPIRY_SKEW_MS) {
  return isAccessExpiryExpired(getAccountProfileAccessExpiryMs(profile), nowMs, skewMs);
}

function truncateLabel(text, maxLen = 28) {
  if (!text) return "(unnamed)";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readCodexAuth(authPath) {
  const parsed = loadJsonFile(authPath);
  if (!parsed || typeof parsed !== "object") return null;
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") return null;
  return parsed;
}

function normalizeAccountSelectorList(value) {
  return normalizeStringList(value).map((item) => item.toLowerCase());
}

function profileMatchesAccountSelector(profile, selector) {
  const normalized = String(selector || "").trim().toLowerCase();
  if (!normalized || !profile) return false;
  return [
    profile.profileId,
    profile.accountId,
    profile.label,
    profile.shortLabel,
  ].some((candidate) => String(candidate || "").trim().toLowerCase() === normalized);
}

function isAccountProfileLastResort(profile, selectors = []) {
  return selectors.some((selector) => profileMatchesAccountSelector(profile, selector));
}

function sortAccountProfilesByPriority(profiles) {
  return [...(profiles || [])].sort((left, right) => {
    const lastResortOrder = Number(Boolean(left.lastResort)) - Number(Boolean(right.lastResort));
    if (lastResortOrder !== 0) return lastResortOrder;
    return String(left.label || left.profileId || "").localeCompare(String(right.label || right.profileId || ""));
  });
}

function prioritizeAccountProfiles(profiles) {
  const preferred = [];
  const lastResort = [];
  for (const profile of profiles || []) {
    if (profile?.lastResort) lastResort.push(profile);
    else preferred.push(profile);
  }
  return [...preferred, ...lastResort];
}

function loadCodexAccountProfiles(sourcePath, { lastResortAccounts = "" } = {}) {
  if (!sourcePath) return [];
  const resolved = resolveUserPath(sourcePath);
  const parsed = loadJsonFile(resolved);
  if (!parsed || typeof parsed !== "object") return [];
  const profileMap =
    parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : parsed;
  const items = [];
  const seen = new Set();
  const lastResortSelectors = normalizeAccountSelectorList(lastResortAccounts);

  for (const [profileId, profile] of Object.entries(profileMap)) {
    if (!profile || typeof profile !== "object") continue;
    if (profile.provider !== "openai-codex" || profile.type !== "oauth") continue;
    if (typeof profile.access !== "string" || typeof profile.refresh !== "string") continue;

    const jwt = parseJwtPayload(profile.access);
    const authInfo = jwt?.["https://api.openai.com/auth"] || {};
    const profileInfo = jwt?.["https://api.openai.com/profile"] || {};
    const accountId =
      (typeof profile.accountId === "string" && profile.accountId) ||
      (typeof authInfo.chatgpt_account_id === "string" && authInfo.chatgpt_account_id) ||
      null;
    const email =
      (typeof profileInfo.email === "string" && profileInfo.email) ||
      (typeof jwt?.email === "string" && jwt.email) ||
      null;
    const label = email || accountId || profileId;
    const shortLabel = truncateLabel(label, 24);

    const dedupeKey = `${accountId || "none"}:${profile.refresh.slice(-16)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const item = {
      profileId,
      accountId,
      label,
      shortLabel,
      access: profile.access,
      refresh: profile.refresh,
      expires: Number.isFinite(profile.expires) ? profile.expires : getJwtExpiryMs(profile.access),
      sourcePath: resolved,
    };
    item.lastResort = isAccountProfileLastResort(item, lastResortSelectors);
    items.push(item);
  }

  return sortAccountProfilesByPriority(items);
}

function parseCsvIds(value) {
  if (!value) return null;
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("-") ? Number(s) : Number(s)));
  const valid = ids.filter((n) => Number.isFinite(n));
  return valid.length ? new Set(valid) : null;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildTelegramInstanceLockPath(token) {
  const hash = crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `telegram-codex-bridge.${hash}.lock`);
}

function isPidRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function acquireInstanceLock(lockPath, { label = "instance" } = {}) {
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    label,
  }, null, 2);

  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;

    const existingText = readTextFile(lockPath);
    const existing = existingText ? safeJsonParse(existingText) : null;
    const existingPid = Number(existing?.pid || 0);

    if (existingPid && isPidRunning(existingPid)) {
      const startedAt = typeof existing?.startedAt === "string" ? existing.startedAt : null;
      const details = startedAt ? ` (started ${startedAt})` : "";
      const lockErr = new Error(
        `Another ${label} is already running (pid ${existingPid}${details}). Stop it before starting a second instance.\nLock: ${lockPath}`,
      );
      lockErr.code = "INSTANCE_LOCKED";
      throw lockErr;
    }

    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore stale lock cleanup errors
    }

    fs.writeFileSync(lockPath, payload, { flag: "wx" });
  }

  const cleanup = () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  };

  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  return { lockPath, cleanup };
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function truncateMiddle(text, maxLen) {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor((maxLen - 10) / 2);
  const tailLen = maxLen - 10 - headLen;
  return `${text.slice(0, headLen)}\n…(truncated)…\n${text.slice(-tailLen)}`;
}

function formatRelativeAge(ms) {
  const value = Number(ms || 0);
  if (!value) return "n/a";
  const delta = Math.max(0, Date.now() - value);
  if (delta < 1000) return "just now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(ms) {
  const value = Number(ms || 0);
  if (!value) return "(never)";
  try {
    return new Date(value).toISOString();
  } catch {
    return "(invalid)";
  }
}

function isGroupChat(chatId) {
  return Number(chatId) < 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeIncomingText(text, botUsername) {
  const source = String(text || "").trim();
  if (!source || !botUsername) return source;
  const mentionPattern = new RegExp(`@${escapeRegExp(botUsername)}\\b`, "ig");
  return source.replace(mentionPattern, "").replace(/\s{2,}/g, " ").trim();
}

function resolveAgentMessageTurnId({ explicitTurnId = null, existingTurnId = null, rt = null } = {}) {
  return existingTurnId || explicitTurnId || rt?.activeTurnId || null;
}

function isReplyToBot(message, botId) {
  return Number(message?.reply_to_message?.from?.id) === Number(botId);
}

function shouldHandleTelegramMessage(message, botIdentity) {
  const chatType = message?.chat?.type;
  if (!chatType || chatType === "private") return true;

  const text = String(message?.text || "").trim();
  if (!text) return false;

  if (botIdentity?.username && text.toLowerCase().includes(`@${botIdentity.username.toLowerCase()}`)) {
    return true;
  }

  if (botIdentity?.id && isReplyToBot(message, botIdentity.id)) {
    return true;
  }

  return false;
}

function summarizeGroupCommand(command) {
  const lowered = String(command || "").toLowerCase();
  if (/\b(rg|grep|find|ls|tree|cat|sed|awk|head|tail|stat|wc)\b/.test(lowered)) {
    return "正在查看项目文件和内容，具体命令已在群里隐藏。";
  }
  if (/\b(git|diff)\b/.test(lowered)) {
    return "正在检查仓库状态，具体命令已在群里隐藏。";
  }
  if (/\b(npm|pnpm|yarn|bun|node|python|pytest|jest|vitest|cargo|go test|make|uv)\b/.test(lowered)) {
    return "正在运行脚本或验证步骤，具体命令已在群里隐藏。";
  }
  return "正在执行一步命令，具体命令已在群里隐藏。";
}

function summarizeGroupFileChange(title) {
  const lowered = String(title || "").toLowerCase();
  if (/\b(readme|docs?|guide|manual)\b/.test(lowered)) {
    return "正在整理说明文档，具体文件名已在群里隐藏。";
  }
  return "正在整理文件改动，具体文件名已在群里隐藏。";
}

function sanitizeGroupAgentLine(line) {
  let value = String(line || "");
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(diff --git|index [0-9a-f]+\.\.[0-9a-f]+|@@|--- |\+\+\+ )/.test(trimmed)) return "";
  if (/^\$ /.test(trimmed)) return "正在执行命令，具体命令已在群里隐藏。";
  if (/^cwd:\s+/i.test(trimmed)) return "";

  value = value.replace(/`[^`\n]+`/g, "（代码或路径细节已隐藏）");
  value = value.replace(/(^|[\s(（\[])(?:~\/|\/)[^\s)）\],，；;]+/g, "$1（路径已隐藏）");
  value = value.replace(
    /\b(?:[A-Za-z]:\\|\.{0,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*\/?[\w.-]*\.(?:c|cc|cpp|cs|css|go|h|hpp|html|ini|java|js|json|kt|md|mjs|php|py|rb|rs|sh|sql|swift|toml|ts|tsx|txt|xml|yaml|yml)(?::\d+(?::\d+)?)?\b/gi,
    "（文件已隐藏）",
  );
  value = value.replace(/(?:（(?:代码或路径细节|路径|文件)已隐藏）\s*){2,}/g, "（细节已隐藏） ");
  value = value.replace(/\s+/g, " ").trim();

  if (!value) return "";
  const visibleChars = value
    .replace(/（(?:代码片段|代码或路径细节|路径|文件|细节)已隐藏）/g, "")
    .replace(/\s+/g, "");
  if (!visibleChars) return "";
  return value;
}

function sanitizeGroupAgentText(text) {
  const source = String(text || "");
  if (!source.trim()) return "";

  const normalized = source.replace(/```[\s\S]*?```/g, "\n（代码片段已隐藏）\n");
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => sanitizeGroupAgentLine(line))
    .filter(Boolean);

  const deduped = [];
  for (const line of lines) {
    if (line === deduped[deduped.length - 1] && line.includes("已隐藏")) continue;
    deduped.push(line);
  }

  const result = deduped.join("\n").trim();
  if (result) return result;
  return "正在继续处理，代码和路径细节已在群里隐藏。";
}

function shouldSuppressDuplicateGroupProgress(rt, text, bucket = "general") {
  if (!rt || !text) return false;
  if (!rt.lastGroupProgressByBucket) rt.lastGroupProgressByBucket = {};
  if (rt.lastGroupProgressByBucket[bucket] === text) return true;
  rt.lastGroupProgressByBucket[bucket] = text;
  return false;
}

function normalizeGroupVisibleText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function hasSeenGroupVisibleText(rt, text) {
  const normalized = normalizeGroupVisibleText(text);
  if (!rt || !normalized) return false;
  if (!rt.sentGroupVisibleTexts) rt.sentGroupVisibleTexts = new Set();
  return rt.sentGroupVisibleTexts.has(normalized);
}

function rememberGroupVisibleText(rt, text) {
  const normalized = normalizeGroupVisibleText(text);
  if (!rt || !normalized) return;
  if (!rt.sentGroupVisibleTexts) rt.sentGroupVisibleTexts = new Set();
  rt.sentGroupVisibleTexts.add(normalized);
}

class Store {
  constructor(storePath) {
    this.storePath = storePath;
    this.data = {
      telegram: {
        offset: 0,
        botIdentity: null,
        health: {
          lastPollSuccessAt: 0,
          lastPollErrorAt: 0,
          consecutivePollErrors: 0,
          lastPollError: null,
          restartRequestedAt: 0,
          restartReason: null,
        },
      },
      bridge: { currentAccountProfileId: null, lastGoodAccountProfileId: null, accountHealth: {} },
      sessions: {},
    };
    this._dirty = false;
    this._lastSaveMs = 0;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const parsedTelegram = parsed.telegram && typeof parsed.telegram === "object" ? parsed.telegram : {};
        const parsedTelegramHealth =
          parsedTelegram.health && typeof parsedTelegram.health === "object"
            ? parsedTelegram.health
            : {};
        this.data.telegram = {
          offset: 0,
          botIdentity: null,
          ...parsedTelegram,
          health: {
            lastPollSuccessAt: 0,
            lastPollErrorAt: 0,
            consecutivePollErrors: 0,
            lastPollError: null,
            restartRequestedAt: 0,
            restartReason: null,
            ...parsedTelegramHealth,
          },
        };
        this.data.bridge = {
          currentAccountProfileId: null,
          lastGoodAccountProfileId: null,
          accountHealth: {},
          ...(parsed.bridge || {}),
        };
        if (!this.data.bridge.accountHealth || typeof this.data.bridge.accountHealth !== "object") {
          this.data.bridge.accountHealth = {};
        }
        this.data.sessions = parsed.sessions || {};
      }
    } catch {
      // ignore
    }
  }

  markDirty() {
    this._dirty = true;
  }

  save({ force = false } = {}) {
    if (!this._dirty && !force) return;
    atomicWriteJson(this.storePath, this.data);
    this._dirty = false;
    this._lastSaveMs = Date.now();
  }

  saveThrottled() {
    const now = Date.now();
    if (now - this._lastSaveMs < 1000) return;
    this.save();
  }
}

class TelegramApi {
  constructor(token, { proxyUrl = null, proxySource = null } = {}) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.proxyUrl = proxyUrl || null;
    this.proxySource = proxySource || null;
    this.transportLabel = this.proxyUrl
      ? `proxy ${maskProxyUrl(this.proxyUrl)}`
      : "direct";
    this.writeQueue = Promise.resolve();
  }

  async call(method, params, { serialize = false } = {}) {
    if (!serialize) return this.callWithRetry(method, params);

    const task = this.writeQueue
      .catch(() => {})
      .then(() => this.callWithRetry(method, params));
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async callWithRetry(method, params) {
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.callOnce(method, params);
      } catch (error) {
        lastError = error;
        const message = error && error.message ? error.message : String(error);
        const isTransient =
          message.includes("transport failed") ||
          message.includes("SSL_ERROR_SYSCALL") ||
          message.includes("timed out") ||
          message.includes("Connect Timeout");
        const retryableMethod = shouldRetryTelegramMethod(method);
        if (!isTransient || !retryableMethod || attempt === 4) throw error;
        console.warn(`Telegram API ${method} retry ${attempt}/4 after transient error: ${message}`);
        await sleep(500 * attempt);
      }
    }
    throw lastError || new Error(`Telegram API ${method} failed`);
  }

  async callOnce(method, params) {
    const body = JSON.stringify(params ?? {});
    const longPollSeconds =
      method === "getUpdates"
        ? Math.max(0, Number(params?.timeout || 0))
        : 0;
    const curlMaxTimeSeconds = longPollSeconds > 0
      ? Math.max(45, longPollSeconds + 15)
      : 20;
    const childTimeoutMs = (curlMaxTimeSeconds + 10) * 1000;
    const curlArgs = [
      "-sS",
      "-4",
      "--http1.1",
      "--connect-timeout",
      "10",
      "--max-time",
      String(curlMaxTimeSeconds),
    ];
    if (this.proxyUrl) {
      curlArgs.push("--proxy", this.proxyUrl);
    }
    curlArgs.push(
      "-X",
      "POST",
      `${this.baseUrl}/${method}`,
      "-H",
      "content-type: application/json",
      "-d",
      body,
    );
    const stdout = await new Promise((resolve, reject) => {
      execFile("curl", curlArgs, {
        timeout: childTimeoutMs,
        maxBuffer: 1024 * 1024,
      }, (error, out, stderr) => {
        if (error) {
          const message = redactTelegramBotToken(formatCurlTransportError(error, stderr, { timeoutMs: childTimeoutMs }));
          reject(new Error(`Telegram API ${method} transport failed (${this.transportLabel}): ${message}`));
          return;
        }
        resolve(out);
      });
    });

    const parsed = safeJsonParse(stdout);
    if (!parsed || parsed.ok !== true) {
      const desc = parsed && parsed.description ? parsed.description : "invalid JSON response";
      const err = new Error(`Telegram API ${method} failed: ${desc}`);
      err.body = parsed;
      throw err;
    }
    return parsed.result;
  }

  getUpdates({ offset, timeout, allowed_updates }) {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates,
    });
  }

  getMe() {
    return this.call("getMe");
  }

  sendChatAction({ chat_id, action }) {
    return this.call("sendChatAction", {
      chat_id,
      action,
    }, { serialize: true });
  }

  sendMessage({ chat_id, text, reply_markup, parse_mode, disable_web_page_preview }) {
    return this.call("sendMessage", {
      chat_id,
      text,
      reply_markup,
      parse_mode,
      disable_web_page_preview,
    }, { serialize: true });
  }

  editMessageText({ chat_id, message_id, text, reply_markup, parse_mode, disable_web_page_preview }) {
    return this.call("editMessageText", {
      chat_id,
      message_id,
      text,
      reply_markup,
      parse_mode,
      disable_web_page_preview,
    }, { serialize: true });
  }

  answerCallbackQuery({ callback_query_id, text, show_alert }) {
    return this.call("answerCallbackQuery", { callback_query_id, text, show_alert }, { serialize: true });
  }
}

class CodexAppServer {
  constructor({ codexBin = "codex", env = process.env } = {}) {
    this.codexBin = codexBin;
    this.env = env;
    this.proc = null;
    this._stdoutRl = null;
    this._stderrRl = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve,reject}
    this._onNotification = () => {};
    this._onServerRequest = async () => ({ ok: false, error: { code: -32601, message: "Method not found" } });
    this._onAuthWatchdog = async () => {};
    this._onProcessExit = async () => {};
    this._expectedStop = false;
    this._latestAuthFailure = null;
    this._watchdogNotified = false;
  }

  onNotification(handler) {
    this._onNotification = handler;
  }

  onServerRequest(handler) {
    this._onServerRequest = handler;
  }

  onAuthWatchdog(handler) {
    this._onAuthWatchdog = handler;
  }

  onProcessExit(handler) {
    this._onProcessExit = handler;
  }

  async start() {
    if (this.proc) return;
    this._expectedStop = false;
    this._latestAuthFailure = null;
    this._watchdogNotified = false;
    this.proc = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    });

    this._stdoutRl = readline.createInterface({ input: this.proc.stdout });
    this._stdoutRl.on("line", (line) => this._handleLine(line));
    this._stderrRl = readline.createInterface({ input: this.proc.stderr });
    this._stderrRl.on("line", (line) => this._handleStderrLine(line));

    this.proc.on("exit", (code, signal) => {
      console.error(`codex app-server exited (code=${code}, signal=${signal})`);
      const exitAuthFailure = this._latestAuthFailure;
      const expectedStop = this._expectedStop;
      this._closePipes();
      this.proc = null;
      this._expectedStop = false;
      if (!expectedStop && exitAuthFailure) {
        this._emitAuthWatchdog({
          source: "exit",
          reason: exitAuthFailure.reason,
          matchedText: exitAuthFailure.matchedText,
          code,
          signal,
        });
      }
      Promise.resolve(this._onProcessExit({
        code,
        signal,
        expected: expectedStop,
        authFailure: exitAuthFailure,
      })).catch((err) => {
        console.error("Failed handling app-server exit:", err);
      });
      const exitMessage = exitAuthFailure?.reason || "codex app-server exited";
      for (const { reject } of this._pending.values()) {
        const error = new Error(exitMessage);
        if (exitAuthFailure) error.authWatchdog = exitAuthFailure;
        reject(error);
      }
      this._pending.clear();
    });
  }

  stop({ expected = true } = {}) {
    if (!this.proc) return;
    this._expectedStop = expected;
    this.proc.kill("SIGTERM");
  }

  _send(msg) {
    if (!this.proc) throw new Error("codex app-server not running");
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  _handleLine(line) {
    const msg = safeJsonParse(line);
    if (!msg) return;

    // Response from server to our request
    if (Object.prototype.hasOwnProperty.call(msg, "id") && (Object.prototype.hasOwnProperty.call(msg, "result") || Object.prototype.hasOwnProperty.call(msg, "error")) && !msg.method) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || "JSON-RPC error"), { rpcError: msg.error }));
      else pending.resolve(msg.result);
      return;
    }

    // Server-initiated request
    if (Object.prototype.hasOwnProperty.call(msg, "id") && msg.method) {
      this._handleServerRequest(msg).catch((err) => {
        console.error("Failed handling server request:", err);
      });
      return;
    }

    // Notification
    if (msg.method && !Object.prototype.hasOwnProperty.call(msg, "id")) {
      Promise.resolve(this._onNotification(msg)).catch((err) => {
        console.error("Failed handling notification:", err);
      });
    }
  }

  _closePipes() {
    if (this._stdoutRl) {
      this._stdoutRl.close();
      this._stdoutRl = null;
    }
    if (this._stderrRl) {
      this._stderrRl.close();
      this._stderrRl = null;
    }
  }

  _handleStderrLine(line) {
    const text = String(line || "").trim();
    if (!text) return;
    console.error(`[codex app-server stderr] ${text}`);
    if (!isAccountAuthFailureText(text)) return;
    this._latestAuthFailure = {
      reason: text,
      matchedText: text,
      observedAt: Date.now(),
    };
    this._emitAuthWatchdog({
      source: "stderr",
      reason: text,
      matchedText: text,
    });
  }

  _emitAuthWatchdog(event) {
    if (this._expectedStop || this._watchdogNotified) return;
    this._watchdogNotified = true;
    Promise.resolve(this._onAuthWatchdog(event)).catch((err) => {
      console.error("Failed handling auth watchdog event:", err);
    });
  }

  async _handleServerRequest(req) {
    let result;
    try {
      const handled = await this._onServerRequest(req);
      if (handled && handled.ok) {
        result = handled.result;
      } else if (handled && handled.error) {
        this._send({ id: req.id, error: handled.error });
        return;
      } else {
        this._send({ id: req.id, error: { code: -32601, message: "Method not handled" } });
        return;
      }
    } catch (err) {
      this._send({ id: req.id, error: { code: -32000, message: err.message || "Unhandled error" } });
      return;
    }
    this._send({ id: req.id, result });
  }

  request(method, params) {
    const id = this._nextId++;
    this._send({ id, method, params });
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });
  }

  notify(method, params) {
    this._send({ method, params });
  }

  async initialize() {
    const initResult = await this.request("initialize", {
      clientInfo: { name: "telegram_codex_bridge", title: "Telegram Codex Bridge", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return initResult;
  }
}

function makeToken() {
  return crypto.randomBytes(8).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseRatioEnv(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value))];
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((item) => String(item || "").trim()).filter(Boolean));
  }
  if (typeof value === "string" && value.trim()) {
    return uniqueStrings(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean));
  }
  return [];
}

function normalizeAbsolutePath(inputPath) {
  const resolved = resolveUserPath(String(inputPath || "").trim());
  if (!resolved) return null;
  return path.resolve(resolved);
}

function normalizePathList(value) {
  return uniqueStrings(normalizeStringList(value).map(normalizeAbsolutePath).filter(Boolean));
}

function isPathWithin(parentPath, candidatePath) {
  const parent = normalizeAbsolutePath(parentPath);
  const candidate = normalizeAbsolutePath(candidatePath);
  if (!parent || !candidate) return false;
  if (parent === candidate) return true;
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function firstExistingPath(paths) {
  return (paths || []).find((candidate) => candidate && fs.existsSync(candidate)) || (paths || [])[0] || null;
}

function countQueuedTasks(rt) {
  return Array.isArray(rt?.pendingTasks) ? rt.pendingTasks.length : 0;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeModelId(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  const recommended = RECOMMENDED_MODELS.find((model) => (
    model.id.toLowerCase() === lowered ||
    model.aliases.some((alias) => alias.toLowerCase() === lowered)
  ));
  return recommended?.id || trimmed;
}

function normalizeEffortLevel(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/_/g, "-");
  const aliases = {
    min: "minimal",
    minimum: "minimal",
    med: "medium",
    mid: "medium",
    "x-high": "xhigh",
    "extra-high": "xhigh",
    max: "xhigh",
    maximum: "xhigh",
    off: "none",
    no: "none",
  };
  const canonical = aliases[normalized] || normalized;
  return VALID_EFFORTS.has(canonical) ? canonical : null;
}

function parseModelCommandArgs(rawArgs) {
  const parts = String(rawArgs || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { model: null, effort: null, error: null };
  }
  if (parts.length > 2) {
    return {
      model: null,
      effort: null,
      error: "Usage: /model <5.2|5.4|5.5|model-id> [effort]",
    };
  }

  const model = normalizeModelId(parts[0]);
  const effort = parts[1] ? normalizeEffortLevel(parts[1]) : null;
  if (parts[1] && !effort) {
    return {
      model: null,
      effort: null,
      error: `Invalid effort. Use one of: ${EFFORT_LEVELS.join(", ")}`,
    };
  }

  return { model, effort, error: null };
}

function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return "(unknown)";
  return `${(ratio * 100).toFixed(1)}%`;
}

function classifyContextUsageRatio(ratio, thresholds) {
  if (!Number.isFinite(ratio)) return null;
  if (ratio >= thresholds.emergency) return "emergency";
  if (ratio >= thresholds.hard) return "hard";
  if (ratio >= thresholds.soft) return "soft";
  return null;
}

function extractContextUsageSnapshotPayload(params) {
  if (!params || typeof params !== "object") return null;
  const info = params?.info || params?.token_count?.info || params?.tokenCount?.info || {};
  const contextTokenCandidates = [
    info?.total_token_usage?.total_tokens,
    info?.totalTokenUsage?.totalTokens,
    params?.total_token_usage?.total_tokens,
    params?.totalTokenUsage?.totalTokens,
    params?.token_count?.total_token_usage?.total_tokens,
    params?.tokenCount?.totalTokenUsage?.totalTokens,
    params?.context_tokens,
    params?.contextTokens,
    params?.total_tokens,
    params?.totalTokens,
  ];
  const lastTurnCandidates = [
    info?.last_token_usage?.total_tokens,
    info?.lastTokenUsage?.totalTokens,
    params?.last_token_usage?.total_tokens,
    params?.lastTokenUsage?.totalTokens,
    params?.token_count?.last_token_usage?.total_tokens,
    params?.tokenCount?.lastTokenUsage?.totalTokens,
  ];
  const windowCandidates = [
    info?.model_context_window,
    info?.modelContextWindow,
    info?.context_window,
    info?.contextWindow,
    params?.model_context_window,
    params?.modelContextWindow,
    params?.context_window,
    params?.contextWindow,
    params?.token_count?.model_context_window,
    params?.tokenCount?.modelContextWindow,
    params?.token_count?.context_window,
    params?.tokenCount?.contextWindow,
  ];
  const contextTokens = contextTokenCandidates.find((value) => Number.isFinite(Number(value)));
  const lastTurnTokens = lastTurnCandidates.find((value) => Number.isFinite(Number(value)));
  const contextWindow = windowCandidates.find((value) => Number.isFinite(Number(value)));
  if (
    !Number.isFinite(Number(contextTokens))
    && !Number.isFinite(Number(lastTurnTokens))
    && !Number.isFinite(Number(contextWindow))
  ) return null;
  return {
    contextTokens: Number.isFinite(Number(contextTokens)) ? Number(contextTokens) : null,
    lastTurnTokens: Number.isFinite(Number(lastTurnTokens)) ? Number(lastTurnTokens) : null,
    contextWindow: Number.isFinite(Number(contextWindow)) ? Number(contextWindow) : null,
  };
}

function applyContextUsageSnapshot(session, snapshot, thresholds, observedAt = nowIso()) {
  if (!session || typeof session !== "object" || !snapshot) return false;
  const contextTokens = Number.isFinite(Number(snapshot.contextTokens))
    ? Number(snapshot.contextTokens)
    : Number.isFinite(Number(snapshot.totalTokens))
      ? Number(snapshot.totalTokens)
      : null;
  const lastTurnTokens = Number.isFinite(Number(snapshot.lastTurnTokens))
    ? Number(snapshot.lastTurnTokens)
    : Number.isFinite(Number(snapshot.totalTokens))
      ? Number(snapshot.totalTokens)
      : null;
  if (Number.isFinite(contextTokens)) {
    session.contextTokens = contextTokens;
  }
  if (Number.isFinite(lastTurnTokens)) {
    session.lastTurnTokens = lastTurnTokens;
  }
  if (Number.isFinite(snapshot.contextWindow) && snapshot.contextWindow > 0) {
    session.contextWindow = snapshot.contextWindow;
  }
  const usageTokens = Number.isFinite(session.contextTokens)
    ? session.contextTokens
    : session.lastTurnTokens;
  if (Number.isFinite(usageTokens) && Number.isFinite(session.contextWindow) && session.contextWindow > 0) {
    session.contextUsageRatio = usageTokens / session.contextWindow;
  } else {
    session.contextUsageRatio = null;
  }
  session.lastTokenObservedAt = observedAt;
  const pendingReason = classifyContextUsageRatio(session.contextUsageRatio, thresholds);
  session.compactionPending = Boolean(pendingReason);
  session.compactionPendingReason = pendingReason;
  return true;
}

function extractTelemetryThreadId(params) {
  return params?.threadId
    || params?.thread_id
    || params?.thread?.id
    || params?.thread?.threadId
    || params?.thread?.thread_id
    || params?.context?.threadId
    || params?.context?.thread_id
    || null;
}

function shouldAutoCompactDecision({ autoCompactEnabled, session, rt, allowDuringIdle = true } = {}) {
  if (!autoCompactEnabled) return null;
  if (!session?.compactionPending) return null;
  if (!["hard", "emergency"].includes(session.compactionPendingReason || "")) return null;
  if (rt?.compactionInProgress) return null;
  if (session?.pendingSummaryBootstrap?.text) return null;
  if (!allowDuringIdle && !rt?.activeTurnId) return null;
  return session.compactionPendingReason;
}

function isContextFailurePatternMatch(text) {
  if (!text) return false;
  return CONTEXT_FAILURE_PATTERNS.some((pattern) => pattern.test(String(text)));
}

function shouldTreatTextAsContextFailure(text, compactionPendingReason = null) {
  if (isContextFailurePatternMatch(text)) return true;
  if (compactionPendingReason === "emergency" && text && /input|request|prompt/i.test(String(text))) {
    return true;
  }
  return false;
}

function isAccountAuthFailureText(text) {
  if (!text) return false;
  return ACCOUNT_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(String(text)));
}

function isRemoteCompactTransportFailureText(text) {
  if (!text) return false;
  const normalized = String(text);
  if (!/codex\/responses\/compact/i.test(normalized)) return false;
  return /stream disconnected|error sending request|connection|timed out|timeout|eof/i.test(normalized);
}

function buildRemoteCompactFailureHint({ hasSpareAccounts = false } = {}) {
  const actions = [];
  actions.push("`/authsync`");
  if (hasSpareAccounts) actions.push("`/accounts` 后用 `/account` 切号");
  actions.push("重启 bridge");
  actions.push("给 Codex 配 `HTTPS_PROXY`/`ALL_PROXY`");
  return `提示：这看起来是 Codex 远端 compact 请求断流。可尝试：${actions.join("；")}。`;
}

function buildAuthRecoveryReplayTask(inputMeta, source = "auth_failure", createdAt = nowIso()) {
  if (!inputMeta?.text) return null;
  const authReplayCount = Number(inputMeta.authReplayCount || 0);
  if (authReplayCount >= 1) return null;
  return {
    text: inputMeta.text,
    attemptedProfileIds: inputMeta.attemptedProfileIds || [],
    kind: inputMeta.kind || "user",
    silent: Boolean(inputMeta.silent),
    contextRetryCount: Number(inputMeta.contextRetryCount || 0),
    authReplayCount: authReplayCount + 1,
    source,
    createdAt,
  };
}

function getReplayableAuthRecoveryTaskFromRuntime(rt) {
  if (!rt) return null;
  if (rt.authRecoveryReplayTask?.text) {
    return rt.authRecoveryReplayTask;
  }
  if (rt.activeTurnId) {
    return buildAuthRecoveryReplayTask(rt.turnInputMetaByTurnId?.[rt.activeTurnId], "active_turn");
  }
  if (rt.pendingInputMeta?.text) {
    return buildAuthRecoveryReplayTask(rt.pendingInputMeta, "pending_request");
  }
  return null;
}

function summarizeCodexBackendHealth(health) {
  const parts = [health?.state || "starting"];
  if (health?.lastOkAt) {
    parts.push(`last ok ${formatRelativeAge(health.lastOkAt)}`);
  }
  if (health?.lastErrorAt) {
    parts.push(`last err ${formatRelativeAge(health.lastErrorAt)}`);
  }
  if (health?.recoveryInProgress && health?.recoveryReason) {
    parts.push(`recovering: ${health.recoveryReason}`);
  } else if (health?.lastError) {
    parts.push(health.lastError);
  }
  return parts.join(", ");
}

function normalizeSourceProfile(rawProfile, fallbackId = "profile") {
  if (!rawProfile || typeof rawProfile !== "object") return null;
  const rawSources = rawProfile.sources && typeof rawProfile.sources === "object"
    ? rawProfile.sources
    : {};
  const root = normalizeAbsolutePath(
    rawProfile.root
      || rawProfile.projectRoot
      || rawProfile.canonicalRepo
      || rawSources.canonicalRepo
      || rawSources.repo,
  );
  if (!root) return null;

  const id = String(rawProfile.id || fallbackId || root).trim();
  const name = String(rawProfile.name || rawProfile.label || path.basename(root) || root).trim();
  const canonicalRepo = normalizeAbsolutePath(
    rawSources.canonicalRepo
      || rawSources.repo
      || rawProfile.canonicalRepo
      || root,
  );
  const installedServiceCopy = normalizeAbsolutePath(
    rawSources.installedServiceCopy
      || rawProfile.installedServiceCopy
      || "",
  );
  const liveRuntime = normalizePathList(rawSources.liveRuntime || rawProfile.liveRuntime || rawProfile.liveRuntimePaths);
  const stateFiles = normalizePathList(rawSources.stateFiles || rawProfile.stateFiles);
  const logs = normalizePathList(rawSources.logs || rawProfile.logs);
  const aliases = normalizePathList(rawProfile.aliases);
  const codexHomes = normalizePathList(rawSources.codexHomes || rawProfile.codexHomes);
  const matchPaths = uniqueStrings([
    root,
    canonicalRepo,
    installedServiceCopy,
    ...liveRuntime,
    ...aliases,
  ].filter(Boolean));

  return {
    id,
    name,
    root,
    aliases,
    matchPaths,
    sources: {
      canonicalRepo,
      liveRuntime,
      installedServiceCopy,
      stateFiles,
      logs,
      remoteHosts: normalizeStringList(rawSources.remoteHosts || rawProfile.remoteHosts),
      launchAgents: normalizeStringList(rawSources.launchAgents || rawProfile.launchAgents),
      codexHomes,
    },
    mustCheckBeforeAnswer: normalizeStringList(rawProfile.mustCheckBeforeAnswer || rawProfile.mustCheck),
    neverAssume: normalizeStringList(rawProfile.neverAssume || rawProfile.doNotAssume),
  };
}

function buildBuiltinSourceProfiles({
  codexHome,
  desktopCodexHome,
  bridgeRoot,
  serviceRoot,
  storePath,
} = {}) {
  const homeDir = os.homedir();
  const workspaceBridgeRoot = firstExistingPath([
    normalizeAbsolutePath(process.env.BRIDGE_WORKSPACE_ROOT || ""),
    path.join(homeDir, "Documents", "Playground", "telegram-codex-bridge"),
    bridgeRoot,
  ]);
  const resolvedServiceRoot = normalizeAbsolutePath(
    serviceRoot
      || process.env.BRIDGE_ROOT
      || path.join(homeDir, "Library", "Application Support", "telegram-codex-bridge-service"),
  );
  const resolvedStorePath = normalizeAbsolutePath(
    storePath || path.join(resolvedServiceRoot, "data", "store.json"),
  );
  const logDir = path.join(resolvedServiceRoot, "data", "logs");

  return [
    normalizeSourceProfile({
      id: "telegram-codex-bridge",
      name: "Telegram Codex Bridge",
      root: workspaceBridgeRoot,
      aliases: uniqueStrings([bridgeRoot, resolvedServiceRoot].filter(Boolean)),
      sources: {
        canonicalRepo: workspaceBridgeRoot,
        installedServiceCopy: resolvedServiceRoot,
        stateFiles: [resolvedStorePath],
        logs: [logDir],
        launchAgents: [DEFAULT_BRIDGE_LAUNCH_AGENT],
        codexHomes: uniqueStrings([codexHome, desktopCodexHome].filter(Boolean)),
      },
      mustCheckBeforeAnswer: [
        "For bridge behavior, verify the launchd-installed service copy, store.json, logs, and LaunchAgent before trusting the workspace checkout.",
        "For Codex capability drift, compare bridge CODEX_HOME with the desktop Codex home.",
      ],
      neverAssume: [
        "Do not assume workspace edits are live until the installed service copy is synced or checked.",
        "Do not treat Telegram transport health as Codex backend health.",
      ],
    }, "telegram-codex-bridge"),
    normalizeSourceProfile({
      id: "home-workspace",
      name: "Home Workspace",
      root: homeDir,
      sources: {
        canonicalRepo: homeDir,
        codexHomes: uniqueStrings([codexHome, desktopCodexHome].filter(Boolean)),
      },
      mustCheckBeforeAnswer: [
        "Resolve the concrete repo or runtime boundary before answering project-specific current-state questions.",
      ],
      neverAssume: [
        "Do not treat the home directory itself as the business repo truth.",
      ],
    }, "home-workspace"),
  ].filter(Boolean);
}

function loadSourceRegistryFromPath(registryPath) {
  const resolvedPath = normalizeAbsolutePath(registryPath || "");
  if (!resolvedPath) return { registryPath: null, profiles: [], error: null };
  const text = readTextFile(resolvedPath);
  if (!text) {
    return { registryPath: resolvedPath, profiles: [], error: `cannot read ${resolvedPath}` };
  }
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object") {
    return { registryPath: resolvedPath, profiles: [], error: `invalid JSON in ${resolvedPath}` };
  }
  const rawProfiles = Array.isArray(parsed.projects)
    ? parsed.projects
    : Array.isArray(parsed.profiles)
      ? parsed.profiles
      : [];
  const profiles = rawProfiles
    .map((profile, index) => normalizeSourceProfile(profile, `external-${index + 1}`))
    .filter(Boolean);
  return { registryPath: resolvedPath, profiles, error: null };
}

function buildSourceRegistry({
  registryPath = null,
  codexHome = null,
  desktopCodexHome = path.join(os.homedir(), ".codex"),
  bridgeRoot = __dirname,
  serviceRoot = null,
  storePath = null,
  loadedAt = nowIso(),
} = {}) {
  const external = loadSourceRegistryFromPath(registryPath);
  const builtins = buildBuiltinSourceProfiles({
    codexHome,
    desktopCodexHome,
    bridgeRoot: normalizeAbsolutePath(bridgeRoot),
    serviceRoot,
    storePath,
  });
  const profilesById = new Map();
  for (const profile of [...builtins, ...external.profiles]) {
    profilesById.set(profile.id, profile);
  }
  return {
    version: 1,
    registryPath: external.registryPath,
    registryError: external.error,
    loadedAt,
    bridgeRoot: normalizeAbsolutePath(bridgeRoot),
    codexHome: normalizeAbsolutePath(codexHome || ""),
    desktopCodexHome: normalizeAbsolutePath(desktopCodexHome || ""),
    profiles: [...profilesById.values()],
  };
}

function findSourceProfileForPath(registry, cwd) {
  const resolvedCwd = normalizeAbsolutePath(cwd);
  if (!resolvedCwd) return null;
  const matches = (registry?.profiles || [])
    .map((profile) => {
      const matchPath = (profile.matchPaths || []).find((candidate) => isPathWithin(candidate, resolvedCwd));
      return matchPath ? { profile, matchPath, score: matchPath.length } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  return matches[0] || null;
}

function buildGenericSourceProfile(cwd, registry = {}) {
  const root = normalizeAbsolutePath(cwd) || os.homedir();
  return normalizeSourceProfile({
    id: "cwd-only",
    name: "CWD only",
    root,
    sources: {
      canonicalRepo: root,
      codexHomes: uniqueStrings([registry.codexHome, registry.desktopCodexHome].filter(Boolean)),
    },
    mustCheckBeforeAnswer: [
      "Only cwd is known. Verify repo, live runtime, state files, and logs before making current-state claims.",
    ],
    neverAssume: [
      "Do not infer live runtime truth from cwd alone.",
    ],
  }, "cwd-only");
}

function resolveSessionTruth(session, registry) {
  const match = findSourceProfileForPath(registry, session?.cwd);
  const profile = match?.profile || buildGenericSourceProfile(session?.cwd, registry);
  return {
    profile,
    matchPath: match?.matchPath || profile.root,
    registryPath: registry?.registryPath || null,
    registryError: registry?.registryError || null,
    registryLoadedAt: registry?.loadedAt || null,
  };
}

function refreshSessionTruthProfile(session, registry, {
  reason = "refresh",
  bootstrapPending = true,
  refreshedAt = nowIso(),
} = {}) {
  if (!session || typeof session !== "object") return null;
  const resolved = resolveSessionTruth(session, registry);
  const profile = resolved.profile;
  session.truthProfile = {
    id: profile.id,
    name: profile.name,
    projectRoot: profile.root,
    matchPath: resolved.matchPath,
    registryPath: resolved.registryPath,
    registryError: resolved.registryError,
    lastRefreshedAt: refreshedAt,
    lastBootstrapAt: session.truthProfile?.lastBootstrapAt || null,
    refreshReason: reason,
    bootstrapPending: Boolean(bootstrapPending),
    bootstrapVersion: SOURCE_TRUTH_BOOTSTRAP_VERSION,
  };
  return resolved;
}

function normalizeTruthProfileState(session, defaults = {}) {
  if (!session || typeof session !== "object") return null;
  const truth = session.truthProfile && typeof session.truthProfile === "object"
    ? session.truthProfile
    : null;
  if (!truth) {
    session.truthProfile = null;
    return null;
  }
  session.truthProfile = {
    id: typeof truth.id === "string" ? truth.id : null,
    name: typeof truth.name === "string" ? truth.name : null,
    projectRoot: typeof truth.projectRoot === "string" ? truth.projectRoot : null,
    matchPath: typeof truth.matchPath === "string" ? truth.matchPath : null,
    registryPath: typeof truth.registryPath === "string" ? truth.registryPath : null,
    registryError: typeof truth.registryError === "string" ? truth.registryError : null,
    lastRefreshedAt: typeof truth.lastRefreshedAt === "string" ? truth.lastRefreshedAt : null,
    lastBootstrapAt: typeof truth.lastBootstrapAt === "string" ? truth.lastBootstrapAt : null,
    refreshReason: typeof truth.refreshReason === "string" ? truth.refreshReason : null,
    bootstrapPending: Boolean(truth.bootstrapPending),
    bootstrapVersion: Number.isFinite(Number(truth.bootstrapVersion))
      ? Number(truth.bootstrapVersion)
      : defaults.bootstrapVersion || SOURCE_TRUTH_BOOTSTRAP_VERSION,
  };
  return session.truthProfile;
}

function describeLocalSourcePath(sourcePath) {
  const resolved = normalizeAbsolutePath(sourcePath);
  if (!resolved) return null;
  try {
    const stat = fs.statSync(resolved);
    const kind = stat.isDirectory() ? "dir" : "file";
    return `${resolved} (${kind}, mtime ${stat.mtime.toISOString()})`;
  } catch {
    return `${resolved} (missing)`;
  }
}

function formatTruthProfileText(session, registry, { maxItems = 6 } = {}) {
  const resolved = resolveSessionTruth(session, registry);
  const profile = resolved.profile;
  const truthState = session?.truthProfile || {};
  const sourceLines = [];
  const addPathList = (label, values) => {
    const normalized = normalizePathList(values).slice(0, maxItems);
    if (!normalized.length) return;
    sourceLines.push(`${label}:`);
    for (const item of normalized) sourceLines.push(`- ${describeLocalSourcePath(item)}`);
  };
  const addStringList = (label, values) => {
    const normalized = normalizeStringList(values).slice(0, maxItems);
    if (!normalized.length) return;
    sourceLines.push(`${label}:`);
    for (const item of normalized) sourceLines.push(`- ${item}`);
  };

  addPathList("canonicalRepo", [profile.sources.canonicalRepo]);
  addPathList("liveRuntime", profile.sources.liveRuntime);
  addPathList("installedServiceCopy", [profile.sources.installedServiceCopy].filter(Boolean));
  addPathList("stateFiles", profile.sources.stateFiles);
  addPathList("logs", profile.sources.logs);
  addStringList("launchAgents", profile.sources.launchAgents);
  addStringList("remoteHosts", profile.sources.remoteHosts);
  addPathList("codexHomes", profile.sources.codexHomes);

  return [
    "Source truth profile",
    `cwd: ${session?.cwd || "(unknown)"}`,
    `profile: ${profile.name} (${profile.id})`,
    `projectRoot: ${profile.root}`,
    `matchedBy: ${resolved.matchPath}`,
    `registry: ${resolved.registryPath || "(builtin)"}`,
    resolved.registryError ? `registryError: ${resolved.registryError}` : null,
    `lastRefreshedAt: ${truthState.lastRefreshedAt || "(never)"}`,
    `lastBootstrapAt: ${truthState.lastBootstrapAt || "(never)"}`,
    `bootstrapPending: ${truthState.bootstrapPending ? "yes" : "no"}`,
    "",
    "Sources",
    ...(sourceLines.length ? sourceLines : ["- cwd only; no richer source profile matched"]),
    "",
    "Must check before answer",
    ...(profile.mustCheckBeforeAnswer.length ? profile.mustCheckBeforeAnswer.map((item) => `- ${item}`) : ["- Verify the relevant source before making current-state claims."]),
    "",
    "Never assume",
    ...(profile.neverAssume.length ? profile.neverAssume.map((item) => `- ${item}`) : ["- Do not infer live/runtime truth from repo files alone."]),
  ].filter((line) => line !== null).join("\n");
}

function buildTruthBootstrapText(resolvedTruth, userText) {
  const profile = resolvedTruth?.profile;
  if (!profile) return userText;
  const lines = [
    "Bridge source-of-truth bootstrap:",
    "Telegram is only the transport. Before final conclusions, choose evidence from the source profile below.",
    `Active profile: ${profile.name} (${profile.id})`,
    `Project root: ${profile.root}`,
    `Canonical repo: ${profile.sources.canonicalRepo || "(unknown)"}`,
  ];
  if (profile.sources.installedServiceCopy) lines.push(`Installed service copy: ${profile.sources.installedServiceCopy}`);
  if (profile.sources.stateFiles.length) lines.push(`State files: ${profile.sources.stateFiles.slice(0, 4).join(", ")}`);
  if (profile.sources.logs.length) lines.push(`Logs: ${profile.sources.logs.slice(0, 4).join(", ")}`);
  if (profile.sources.launchAgents.length) lines.push(`LaunchAgents: ${profile.sources.launchAgents.join(", ")}`);
  if (profile.sources.remoteHosts.length) lines.push(`Remote hosts: ${profile.sources.remoteHosts.join(", ")}`);
  if (profile.mustCheckBeforeAnswer.length) {
    lines.push("Must check before answer:");
    for (const item of profile.mustCheckBeforeAnswer.slice(0, 5)) lines.push(`- ${item}`);
  }
  if (profile.neverAssume.length) {
    lines.push("Never assume:");
    for (const item of profile.neverAssume.slice(0, 5)) lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push(`User message: ${userText}`);
  return lines.join("\n");
}

function filterDesktopCodexConfigToml(text) {
  const dropRootKeys = new Set(["approval_policy", "sandbox_mode", "notify"]);
  let inRoot = true;
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^\[/.test(trimmed)) inRoot = false;
      if (!inRoot) return true;
      const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
      return !(match && dropRootKeys.has(match[1]));
    })
    .join("\n")
    .replace(/\n*$/, "\n");
}

function pathsReferToSameLocation(leftPath, rightPath) {
  const left = normalizeAbsolutePath(leftPath);
  const right = normalizeAbsolutePath(rightPath);
  return Boolean(left && right && left === right);
}

function copyDirectoryReplacingDestination(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) return false;
  ensureDir(path.dirname(destinationDir));
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, destinationDir, { recursive: true, dereference: false });
  return true;
}

function copyFileIfPresent(sourceFile, destinationFile, transform = null) {
  if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) return false;
  ensureDir(path.dirname(destinationFile));
  if (transform) {
    fs.writeFileSync(destinationFile, transform(fs.readFileSync(sourceFile, "utf8")));
  } else {
    fs.copyFileSync(sourceFile, destinationFile);
  }
  return true;
}

function syncDesktopCodexContext({
  codexHome,
  desktopCodexHome = path.join(os.homedir(), ".codex"),
  enabled = true,
  logger = null,
} = {}) {
  const runtimeHome = normalizeAbsolutePath(codexHome);
  const desktopHome = normalizeAbsolutePath(desktopCodexHome);
  const report = {
    enabled: Boolean(enabled),
    skippedReason: null,
    desktopCodexHome: desktopHome,
    codexHome: runtimeHome,
    synced: [],
  };
  if (!enabled) {
    report.skippedReason = "disabled";
    return report;
  }
  if (!runtimeHome || !desktopHome) {
    report.skippedReason = "missing path";
    return report;
  }
  if (pathsReferToSameLocation(runtimeHome, desktopHome)) {
    report.skippedReason = "same CODEX_HOME";
    return report;
  }
  if (!fs.existsSync(desktopHome) || !fs.statSync(desktopHome).isDirectory()) {
    report.skippedReason = "desktop CODEX_HOME missing";
    return report;
  }
  ensureDir(runtimeHome);

  const syncDirs = ["memories", "skills", "plugins", "rules", "vendor_imports"];
  for (const dirName of syncDirs) {
    const copied = copyDirectoryReplacingDestination(
      path.join(desktopHome, dirName),
      path.join(runtimeHome, dirName),
    );
    if (copied) report.synced.push(dirName);
  }

  if (copyFileIfPresent(path.join(desktopHome, "AGENTS.md"), path.join(runtimeHome, "AGENTS.md"))) {
    report.synced.push("AGENTS.md");
  }
  if (copyFileIfPresent(
    path.join(desktopHome, "config.toml"),
    path.join(runtimeHome, "config.toml"),
    filterDesktopCodexConfigToml,
  )) {
    report.synced.push("config.toml");
  }

  if (logger && report.synced.length) {
    logger(`Synced desktop Codex context from ${desktopHome}: ${report.synced.join(", ")}`);
  }
  return report;
}

function normalizeSessionState(session, defaults) {
  if (!session || typeof session !== "object") return session;
  session.threadId = session.threadId || null;
  session.cwd = session.cwd || defaults.cwd;
  session.model = session.model || defaults.model;
  session.effort = session.effort || defaults.effort;
  session.summary = session.summary || defaults.summary;
  session.personality = session.personality || defaults.personality;
  session.approvalPolicy = session.approvalPolicy || defaults.approvalPolicy;
  session.sandboxMode = session.sandboxMode || defaults.sandboxMode;
  session.updatedAt = session.updatedAt || nowIso();
  session.contextWindow = Number.isFinite(Number(session.contextWindow)) && Number(session.contextWindow) > 0
    ? Number(session.contextWindow)
    : null;
  session.contextTokens = Number.isFinite(Number(session.contextTokens))
    ? Number(session.contextTokens)
    : null;
  session.lastTurnTokens = Number.isFinite(Number(session.lastTurnTokens))
    ? Number(session.lastTurnTokens)
    : null;
  session.lastTokenObservedAt = typeof session.lastTokenObservedAt === "string"
    ? session.lastTokenObservedAt
    : null;
  session.contextUsageRatio = Number.isFinite(Number(session.contextUsageRatio))
    ? Number(session.contextUsageRatio)
    : null;
  session.compactionPending = Boolean(session.compactionPending);
  session.compactionPendingReason = typeof session.compactionPendingReason === "string"
    ? session.compactionPendingReason
    : null;
  session.lastCompactionAt = typeof session.lastCompactionAt === "string"
    ? session.lastCompactionAt
    : null;
  session.compactionGeneration = Number.isFinite(Number(session.compactionGeneration))
    ? Number(session.compactionGeneration)
    : 0;
  session.compactionSummary = session.compactionSummary && typeof session.compactionSummary === "object"
    ? session.compactionSummary
    : null;
  session.preCompactionThreadId = typeof session.preCompactionThreadId === "string"
    ? session.preCompactionThreadId
    : null;
  session.pendingSummaryBootstrap = session.pendingSummaryBootstrap && typeof session.pendingSummaryBootstrap === "object"
    ? session.pendingSummaryBootstrap
    : null;
  normalizeTruthProfileState(session);
  return session;
}

function clearSessionContextTracking(session, {
  clearSummary = true,
  clearHistory = false,
} = {}) {
  if (!session || typeof session !== "object") return;
  session.contextWindow = null;
  session.contextTokens = null;
  session.lastTurnTokens = null;
  session.lastTokenObservedAt = null;
  session.contextUsageRatio = null;
  session.compactionPending = false;
  session.compactionPendingReason = null;
  if (clearSummary) {
    session.compactionSummary = null;
    session.pendingSummaryBootstrap = null;
    session.preCompactionThreadId = null;
  }
  if (clearHistory) {
    session.lastCompactionAt = null;
    session.compactionGeneration = 0;
  }
}

function formatContextUsageLine(session) {
  const usageTokens = Number.isFinite(session?.contextTokens)
    ? session.contextTokens
    : session?.lastTurnTokens;
  if (!Number.isFinite(usageTokens) || !Number.isFinite(session?.contextWindow) || session.contextWindow <= 0) {
    return "(unknown)";
  }
  const ratio = Number.isFinite(session?.contextUsageRatio)
    ? `, ${formatPercent(session.contextUsageRatio)}`
    : "";
  return `${usageTokens}/${session.contextWindow}${ratio}`;
}

function buildCompactionPrompt() {
  return [
    "请把当前 thread 的工作上下文压缩成严格固定的 5 段 Markdown 摘要。",
    "",
    "输出要求：",
    "- 只输出以下 5 个二级标题，顺序必须完全一致：",
    ...COMPACTION_SECTION_TITLES.map((title) => `- ${title}`),
    "- 每段只写 1 到 5 条要点。",
    "- 总长度控制在 1200 到 1800 个中文字符以内。",
    "- 不要寒暄，不要代码块，不要补充额外章节。",
    "- 保留主线任务、已经完成的工作、重要约束、关键路径与下一步。",
    "",
    "如果某段信息很少，也必须保留该标题，并写出最关键的一条。",
  ].join("\n");
}

function buildCompactionBootstrapText(bootstrap, userText) {
  const summaryText = String(bootstrap?.text || "").trim();
  return [
    "以下是上一个 thread 的压缩摘要。请把它视为当前继续工作的唯一上下文基线。",
    "",
    summaryText,
    "",
    `用户新消息：${userText}`,
  ].join("\n");
}

function isCompactionTurnKind(kind) {
  return kind === "manualCompaction" || kind === "autoCompaction";
}

function buildHelpText() {
  return [
    "Telegram Codex Bridge commands:",
    "/new - start a new Codex thread",
    "/compact - compact the current thread into a fresh thread",
    "/authsync - resync Codex auth & restart backend",
    "/status - show current thread/turn",
    "/truth - show current source-of-truth profile",
    "/refresh - reload the source-of-truth binding for this chat",
    "/cwd <path> - set working dir for this chat",
    "/project <path> - set project truth profile and start a fresh thread",
    "/model <5.2|5.4|5.5|id> [effort] - set model, optionally with reasoning effort",
    "/effort <none|minimal|low|medium|high|xhigh> - set reasoning effort",
    "/think <none|minimal|low|medium|high|xhigh> - alias for /effort",
    "/models - show recommended model ids and aliases",
    "/efforts - show reasoning effort options",
    "/accounts - show available Codex accounts",
    "/account <id|index> - switch Codex account without dropping the thread",
    "/menu - open the quick settings panel",
    "/stop - interrupt current turn (and clear queued group tasks)",
    "",
    "群聊里只有 @bot 或直接回复 bot 的消息才会触发；私聊不受影响。",
    "群聊中如果当前任务还在跑，新任务会排队，不会直接改写当前任务。",
    "如果你想临时改方向，先发 /stop，再发新任务。",
    "群聊会自动隐藏代码、路径、命令输出和 diff，只保留进度描述；私聊保持完整。",
    "",
    "Tip: just send plain text to talk to Codex.",
  ].join("\n");
}

function buildModelsText() {
  const lines = [
    "Recommended models:",
    ...RECOMMENDED_MODELS.map((model) => {
      const aliasText = model.aliases.length ? ` (alias: ${model.aliases.join(", ")})` : "";
      return `${model.id}${aliasText} - ${model.description}`;
    }),
    "",
    "Custom model IDs are still accepted.",
    "Use: /model <id> [effort]",
    "Examples:",
    "/model 5.4",
    "/model 5.5 xhigh",
  ];
  return lines.join("\n");
}

function buildEffortsText() {
  return [
    "Reasoning effort options:",
    EFFORT_LEVELS.join(", "),
    "",
    "Use: /effort <level> or /think <level>",
    "Examples:",
    "/effort xhigh",
    "/think medium",
  ].join("\n");
}

function buildAccountsText(accountProfiles, currentProfileId) {
  if (!accountProfiles.length) {
    return [
      "No Codex account pool is configured.",
      "Set CODEX_ACCOUNTS_SOURCE to an auth-profiles.json file with openai-codex oauth profiles.",
    ].join("\n");
  }

  const lines = ["Available Codex accounts:"];
  for (const [index, profile] of accountProfiles.entries()) {
    const marker = profile.profileId === currentProfileId ? "*" : " ";
    const detailParts = [];
    if (profile.accountId) detailParts.push(profile.accountId.slice(0, 8));
    if (profile.lastResort) detailParts.push("last resort");
    const detail = detailParts.length ? ` (${detailParts.join(", ")})` : "";
    lines.push(`${marker} ${index + 1}. ${profile.label}${detail}`);
  }
  lines.push("");
  lines.push("Use: /account <index>");
  lines.push("Example: /account 2");
  return lines.join("\n");
}

function getMenuPage(rt) {
  return VALID_MENU_PAGES.has(rt?.menuPage) ? rt.menuPage : MENU_PAGES.MAIN;
}

function buildMenuText(session, rt, page = MENU_PAGES.MAIN, meta = {}) {
  const accountLine = meta.accountLabel ? `account: ${meta.accountLabel}` : "account: (default)";
  const header = [
    "Codex 控制面板",
    `cwd: ${session.cwd}`,
    `truth: ${session.truthProfile?.name || "(unbound)"}`,
    `model: ${session.model}`,
    `effort: ${session.effort}`,
    accountLine,
    `thread: ${session.threadId || "(none)"}`,
    `turn: ${rt.activeTurnId || "(none)"}`,
    `queued: ${countQueuedTasks(rt)}`,
    `context: ${formatContextUsageLine(session)}`,
    `compact: ${session.compactionPending ? `pending${session.compactionPendingReason ? ` (${session.compactionPendingReason})` : ""}` : "idle"}`,
    `auto: ${meta.autoCompact ? "on" : "off"}`,
    "",
  ];

  if (page === MENU_PAGES.THREAD) {
    return header.concat([
      "线程管理",
      "- New Thread：清掉当前上下文，重新开一个 thread",
      "- Compact：提炼当前上下文摘要，切到一个带摘要包的新 thread",
      "- Stop Turn：中断当前正在运行的 turn，并清空群聊待排队任务",
      "",
      "想保留上下文的话，不要点 New Thread。",
    ]).join("\n");
  }

  if (page === MENU_PAGES.WORKSPACE) {
    return header.concat([
      "工作目录",
      "- 这里放常用目录快捷切换",
      "- 自定义目录继续用 /cwd /绝对路径",
      "- 想切项目并清空旧上下文，用 /project /绝对路径",
    ]).join("\n");
  }

  if (page === MENU_PAGES.MODEL) {
    return header.concat([
      "模型与思考级别",
      "- 快捷模型：5.2 / 5.4 / 5.5",
      "- 自定义模型继续用 /model <id>",
      "- 可用 /model 5.4 xhigh 同时切模型和思考等级",
      "- 自定义 effort 继续用 /effort <level> 或 /think <level>",
    ]).join("\n");
  }

  if (page === MENU_PAGES.ACCOUNT) {
    const accountLines = meta.accountProfiles?.length
      ? meta.accountProfiles.map((profile, index) => {
          const marker = profile.profileId === meta.currentAccountProfileId ? "*" : " ";
          return `${marker} ${index + 1}. ${profile.shortLabel}`;
        })
      : ["- 还没有配置账号池"];
    return header.concat([
      "账号电池",
      "- 切账号不会改 threadId，只会换底层认证",
      ...accountLines,
      "",
      "也可以直接用 /account <index>。",
    ]).join("\n");
  }

  return header.concat([
    "主页",
    "常用操作现在分成三组：线程、目录、模型。",
    "点下面按钮进入对应分组。",
  ]).join("\n");
}

function buildMenuKeyboard(page = MENU_PAGES.MAIN, meta = {}) {
  if (page === MENU_PAGES.THREAD) {
    return {
      inline_keyboard: [
        [
          { text: "New Thread", callback_data: "menu|new" },
          { text: "Compact", callback_data: "menu|compact" },
        ],
        [
          { text: "Stop Turn", callback_data: "menu|stop" },
        ],
        [
          { text: "Back", callback_data: `menu|open|${MENU_PAGES.MAIN}` },
          { text: "Refresh", callback_data: "menu|refresh" },
        ],
      ],
    };
  }

  if (page === MENU_PAGES.WORKSPACE) {
    const homeDir = os.homedir();
    const quickProjectCandidates = [
      path.join(homeDir, "Documents", "Playground"),
      path.join(homeDir, "Playground"),
    ];
    const quickProjectDir = quickProjectCandidates.find((candidate) => fs.existsSync(candidate));
    return {
      inline_keyboard: [
        [
          { text: "Use Home", callback_data: `menu|cwd|${homeDir}` },
        ],
        ...(quickProjectDir ? [[
          { text: `Use ${path.basename(quickProjectDir)}`, callback_data: `menu|cwd|${quickProjectDir}` },
        ]] : []),
        [
          { text: "Back", callback_data: `menu|open|${MENU_PAGES.MAIN}` },
          { text: "Refresh", callback_data: "menu|refresh" },
        ],
      ],
    };
  }

  if (page === MENU_PAGES.MODEL) {
    const modelButtons = QUICK_MODELS.map((model) => ({
      text: `Model ${model.replace(/^gpt-/, "")}`,
      callback_data: `menu|model|${model}`,
    }));
    const effortButtons = QUICK_EFFORTS.map((effort) => ({
      text: `Effort ${effort}`,
      callback_data: `menu|effort|${effort}`,
    }));
    return {
      inline_keyboard: [
        modelButtons,
        ...chunkArray(effortButtons, 2),
        [
          { text: "Back", callback_data: `menu|open|${MENU_PAGES.MAIN}` },
          { text: "Refresh", callback_data: "menu|refresh" },
        ],
      ],
    };
  }

  if (page === MENU_PAGES.ACCOUNT) {
    const accountRows = (meta.accountProfiles || []).slice(0, 8).map((profile, index) => ([
      {
        text: `${profile.profileId === meta.currentAccountProfileId ? "●" : "○"} ${index + 1}. ${profile.shortLabel}`,
        callback_data: `menu|account|${profile.profileId}`,
      },
    ]));
    return {
      inline_keyboard: [
        ...accountRows,
        [
          { text: "Back", callback_data: `menu|open|${MENU_PAGES.MAIN}` },
          { text: "Refresh", callback_data: "menu|refresh" },
        ],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        { text: "Status", callback_data: "menu|refresh" },
        { text: "Truth", callback_data: "menu|truth" },
        { text: "Help", callback_data: "menu|help" },
      ],
      [
        { text: "Thread", callback_data: `menu|open|${MENU_PAGES.THREAD}` },
        { text: "Workspace", callback_data: `menu|open|${MENU_PAGES.WORKSPACE}` },
      ],
      [
        { text: "Model & Effort", callback_data: `menu|open|${MENU_PAGES.MODEL}` },
        { text: "Accounts", callback_data: `menu|open|${MENU_PAGES.ACCOUNT}` },
      ],
    ],
  };
}

function formatChatLabel(chat) {
  if (!chat) return "(unknown chat)";
  if (chat.type === "private") {
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
    const username = chat.username ? ` @${chat.username}` : "";
    return `${name || "(private chat)"}${username}`;
  }
  const title = chat.title || chat.username || "(group chat)";
  return `${title} [${chat.type}]`;
}

async function discoverChatIds(telegram) {
  const me = await telegram.getMe();
  console.log(`Connected to bot: @${me.username || me.id}`);
  console.log("Waiting for a Telegram message. Send /start or any text to the bot now.");

  let announcedWait = false;
  for (;;) {
    const updates = await telegram.getUpdates({
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    });

    const chats = new Map();
    for (const update of updates) {
      const chat =
        update?.message?.chat ||
        update?.callback_query?.message?.chat ||
        null;
      if (chat && typeof chat.id === "number") chats.set(chat.id, chat);
    }

    if (chats.size > 0) {
      console.log("");
      console.log("Discovered chat ids:");
      for (const [chatId, chat] of chats.entries()) {
        console.log(`- ${chatId}  ${formatChatLabel(chat)}`);
      }
      console.log("");
      console.log(`Put this into .env: TELEGRAM_ALLOWLIST=${Array.from(chats.keys()).join(",")}`);
      return;
    }

    if (!announcedWait) {
      console.log("No pending updates yet. Keeping the connection open and waiting...");
      announcedWait = true;
    }
  }
}

async function main() {
  const processStartedAt = Date.now();
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exitCode = 1;
    return;
  }

  try {
    const lockPath = resolveUserPath(process.env.TELEGRAM_INSTANCE_LOCK_PATH || "") || buildTelegramInstanceLockPath(BOT_TOKEN);
    acquireInstanceLock(lockPath, { label: "telegram-codex-bridge instance" });
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
    return;
  }

  const telegramProxy = resolveTelegramProxyConfig();
  const telegram = new TelegramApi(BOT_TOKEN, {
    proxyUrl: telegramProxy.url,
    proxySource: telegramProxy.source,
  });
  if (argv.has("--discover-chat-id") || argv.has("discover-chat-id")) {
    await discoverChatIds(telegram);
    return;
  }

  const storePath =
    process.env.STORE_PATH || path.join(__dirname, "data", "store.json");
  const store = new Store(storePath);
  store.load();

  async function resolveBotIdentity() {
    const cached = store.data.telegram?.botIdentity;
    try {
      const me = await telegram.getMe();
      const identity = {
        id: me?.id || null,
        username: typeof me?.username === "string" ? me.username : null,
      };
      store.data.telegram.botIdentity = identity;
      store.markDirty();
      store.saveThrottled();
      return identity;
    } catch (err) {
      if (cached?.id && cached?.username) {
        console.warn(`Telegram getMe failed at startup, falling back to cached bot identity: ${err.message}`);
        return cached;
      }
      throw err;
    }
  }

  const botIdentity = await resolveBotIdentity();

  const allowlist = parseCsvIds(process.env.TELEGRAM_ALLOWLIST);
  if (!allowlist) {
    console.error("Missing TELEGRAM_ALLOWLIST (comma-separated chat ids). Refusing to start for safety.");
    console.error("Run this instead:");
    console.error("npm run discover-chat");
    process.exitCode = 1;
    return;
  }

  function ensureTelegramHealthState() {
    if (!store.data.telegram || typeof store.data.telegram !== "object") {
      store.data.telegram = { offset: 0 };
    }
    if (!store.data.telegram.health || typeof store.data.telegram.health !== "object") {
      store.data.telegram.health = {
        lastPollSuccessAt: 0,
        lastPollErrorAt: 0,
        consecutivePollErrors: 0,
        lastPollError: null,
        restartRequestedAt: 0,
        restartReason: null,
      };
    }
    return store.data.telegram.health;
  }

  function recordTelegramPollSuccess() {
    const health = ensureTelegramHealthState();
    health.lastPollSuccessAt = Date.now();
    health.lastPollErrorAt = 0;
    health.consecutivePollErrors = 0;
    health.lastPollError = null;
    health.restartRequestedAt = 0;
    health.restartReason = null;
    store.markDirty();
    store.saveThrottled();
  }

  function recordTelegramPollError(error) {
    const health = ensureTelegramHealthState();
    health.lastPollErrorAt = Date.now();
    health.consecutivePollErrors = Number(health.consecutivePollErrors || 0) + 1;
    health.lastPollError = truncateMiddle(error?.message || String(error), 220);
    store.markDirty();
    store.saveThrottled();
    return health;
  }

  function buildPollingStatusLine() {
    const health = ensureTelegramHealthState();
    const state = health.consecutivePollErrors > 0 ? "degraded" : "ok";
    const parts = [state, `last ok ${formatRelativeAge(health.lastPollSuccessAt)}`];
    if (health.consecutivePollErrors) {
      parts.push(`${health.consecutivePollErrors} consecutive errors`);
    }
    if (health.lastPollErrorAt) {
      parts.push(`last err ${formatRelativeAge(health.lastPollErrorAt)}`);
    }
    return parts.join(", ");
  }

  const initialTelegramHealth = ensureTelegramHealthState();
  if (!initialTelegramHealth.lastPollSuccessAt) {
    initialTelegramHealth.lastPollSuccessAt = Date.now();
    store.markDirty();
    store.saveThrottled();
  }

  function ensureCodexBackendHealthState() {
    if (!store.data.bridge || typeof store.data.bridge !== "object") {
      store.data.bridge = { currentAccountProfileId: null, lastGoodAccountProfileId: null, accountHealth: {} };
    }
    if (!store.data.bridge.codexBackend || typeof store.data.bridge.codexBackend !== "object") {
      store.data.bridge.codexBackend = {
        state: "starting",
        lastOkAt: 0,
        lastErrorAt: 0,
        lastError: null,
        lastAuthFailureAt: 0,
        lastAuthFailure: null,
        lastExitAt: 0,
        lastExitCode: null,
        lastExitSignal: null,
        recoveryInProgress: false,
        recoveryReason: null,
        lastRecoveryStartedAt: 0,
        lastRecoverySucceededAt: 0,
        lastRecoveryFailedAt: 0,
        lastRecoveryResult: null,
        lastRecoveredProfileId: null,
      };
    }
    return store.data.bridge.codexBackend;
  }

  function recordCodexBackendHealthy({ recoveredProfileId = null } = {}) {
    const health = ensureCodexBackendHealthState();
    health.state = "ok";
    health.lastOkAt = Date.now();
    health.recoveryInProgress = false;
    health.recoveryReason = null;
    if (recoveredProfileId) {
      health.lastRecoveredProfileId = recoveredProfileId;
      health.lastRecoverySucceededAt = Date.now();
      health.lastRecoveryResult = `success:${recoveredProfileId}`;
    }
    store.markDirty();
    store.saveThrottled();
    return health;
  }

  function recordCodexBackendFailure(reason, {
    auth = false,
    code = null,
    signal = null,
    state = null,
  } = {}) {
    const health = ensureCodexBackendHealthState();
    const normalizedReason = truncateMiddle(String(reason || "unknown backend error"), 400);
    health.state = state || (health.recoveryInProgress ? "recovering" : "unhealthy");
    health.lastErrorAt = Date.now();
    health.lastError = normalizedReason;
    if (auth) {
      health.lastAuthFailureAt = Date.now();
      health.lastAuthFailure = normalizedReason;
    }
    if (code !== null || signal !== null) {
      health.lastExitAt = Date.now();
      health.lastExitCode = code;
      health.lastExitSignal = signal;
    }
    store.markDirty();
    store.saveThrottled();
    return health;
  }

  function markCodexBackendRecovering(reason) {
    const health = ensureCodexBackendHealthState();
    health.state = "recovering";
    health.recoveryInProgress = true;
    health.recoveryReason = truncateMiddle(String(reason || "backend recovery"), 220);
    health.lastRecoveryStartedAt = Date.now();
    health.lastRecoveryResult = "in_progress";
    store.markDirty();
    store.saveThrottled();
    return health;
  }

  function markCodexBackendRecoveryFailed(reason) {
    const health = ensureCodexBackendHealthState();
    health.state = "unhealthy";
    health.recoveryInProgress = false;
    health.recoveryReason = truncateMiddle(String(reason || "backend recovery failed"), 220);
    health.lastRecoveryFailedAt = Date.now();
    health.lastRecoveryResult = `failed:${health.recoveryReason}`;
    health.lastErrorAt = Date.now();
    health.lastError = health.recoveryReason;
    store.markDirty();
    store.saveThrottled();
    return health;
  }

  function buildCodexBackendStatusLine() {
    return summarizeCodexBackendHealth(ensureCodexBackendHealthState());
  }

  const codexHome = resolveUserPath(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  );
  ensureDir(codexHome);
  const desktopCodexHome = process.env.DESKTOP_CODEX_HOME || path.join(os.homedir(), ".codex");
  const contextSyncReport = syncDesktopCodexContext({
    codexHome,
    desktopCodexHome,
    enabled: parseBooleanEnv(process.env.CODEX_CONTEXT_SYNC, true),
    logger: (line) => console.log(line),
  });
  if (contextSyncReport.skippedReason) {
    console.log(`Desktop Codex context sync skipped: ${contextSyncReport.skippedReason}`);
  }
  const defaultSourceRegistryPath = path.join(__dirname, "config", "source-registry.json");
  const sourceRegistryPath = process.env.SOURCE_REGISTRY_PATH
    || process.env.TRUTH_SOURCE_REGISTRY
    || (fs.existsSync(defaultSourceRegistryPath) ? defaultSourceRegistryPath : "");
  const sourceRegistryOptions = {
    registryPath: sourceRegistryPath,
    codexHome,
    desktopCodexHome,
    bridgeRoot: __dirname,
    serviceRoot: process.env.BRIDGE_ROOT || null,
    storePath,
  };
  let sourceRegistry = buildSourceRegistry(sourceRegistryOptions);
  function reloadSourceRegistry({ reason = "reload", silent = false } = {}) {
    const next = buildSourceRegistry(sourceRegistryOptions);
    sourceRegistry = next;
    if (!silent) {
      console.log(`Reloaded source registry [${reason}]: ${next.registryPath || "(builtin)"}`);
      if (next.registryError) console.warn(`Source registry warning: ${next.registryError}`);
    }
    return sourceRegistry;
  }
  const fallbackAuthPath = path.join(os.homedir(), ".codex", "auth.json");
  const runtimeAuthPath = path.join(codexHome, "auth.json");
  const authTemplate = readCodexAuth(runtimeAuthPath) || readCodexAuth(fallbackAuthPath);
  const accountsSourceDefault = path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  const accountsSource = process.env.CODEX_ACCOUNTS_SOURCE || (fs.existsSync(accountsSourceDefault) ? accountsSourceDefault : "");
  const lastResortAccounts = process.env.CODEX_LAST_RESORT_ACCOUNTS || "";
  let accountProfiles = loadCodexAccountProfiles(accountsSource, { lastResortAccounts });
  let autoAccountFailover = accountProfiles.length > 1
    && parseBooleanEnv(process.env.CODEX_AUTO_ACCOUNT_FAILOVER, true);

  function reloadAccountProfiles({ reason = "reload", silent = false } = {}) {
    const previous = accountProfiles;
    const next = loadCodexAccountProfiles(accountsSource, { lastResortAccounts });
    accountProfiles = next;
    autoAccountFailover = accountProfiles.length > 1
      && parseBooleanEnv(process.env.CODEX_AUTO_ACCOUNT_FAILOVER, true);

    if (!silent) {
      const prevCount = previous?.length || 0;
      const nextCount = next?.length || 0;
      const summary = prevCount === nextCount ? `${nextCount}` : `${prevCount} -> ${nextCount}`;
      console.log(`Reloaded Codex account profiles (${summary}) [${reason}].`);
    }

    return accountProfiles;
  }

  const defaults = {
    cwd: process.env.CODEX_CWD || process.cwd(),
    model: process.env.CODEX_MODEL || "gpt-5.4",
    effort: process.env.CODEX_EFFORT || "xhigh",
    summary: process.env.CODEX_SUMMARY || "concise",
    personality: process.env.CODEX_PERSONALITY || "friendly",
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY || "untrusted",
    sandboxMode: process.env.CODEX_SANDBOX || "workspace-write",
    autoApprove: process.env.AUTO_APPROVE === "1" || process.env.AUTO_APPROVE === "true",
  };
  const contextThresholds = {
    soft: parseRatioEnv(process.env.CONTEXT_SOFT_RATIO, DEFAULT_CONTEXT_SOFT_RATIO),
    hard: parseRatioEnv(process.env.CONTEXT_HARD_RATIO, DEFAULT_CONTEXT_HARD_RATIO),
    emergency: parseRatioEnv(process.env.CONTEXT_EMERGENCY_RATIO, DEFAULT_CONTEXT_EMERGENCY_RATIO),
  };
  const autoCompact = parseBooleanEnv(process.env.AUTO_COMPACT, false);
  for (const session of Object.values(store.data.sessions || {})) {
    normalizeSessionState(session, defaults);
    if (!session.truthProfile) {
      refreshSessionTruthProfile(session, sourceRegistry, {
        reason: "startup",
        bootstrapPending: true,
      });
      store.markDirty();
    }
  }
  store.saveThrottled();
  const pollTimeoutSeconds = Math.max(
    1,
    Math.min(
      30,
      Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || TELEGRAM_POLL_TIMEOUT_SECONDS) || TELEGRAM_POLL_TIMEOUT_SECONDS,
    ),
  );
  console.log(
    `Telegram transport: ${telegram.transportLabel}${telegram.proxySource ? ` (${telegram.proxySource})` : ""}; poll timeout ${pollTimeoutSeconds}s`,
  );

  function getAccountHealthMap() {
    if (!store.data.bridge || typeof store.data.bridge !== "object") {
      store.data.bridge = { currentAccountProfileId: null, lastGoodAccountProfileId: null, accountHealth: {} };
    }
    if (!store.data.bridge.accountHealth || typeof store.data.bridge.accountHealth !== "object") {
      store.data.bridge.accountHealth = {};
    }
    return store.data.bridge.accountHealth;
  }

  function clearExpiredAccountHealth() {
    const map = getAccountHealthMap();
    const now = Date.now();
    let changed = false;
    for (const [profileId, health] of Object.entries(map)) {
      if (!health || typeof health !== "object" || (health.badUntil && health.badUntil <= now)) {
        delete map[profileId];
        changed = true;
      }
    }
    if (changed) {
      store.markDirty();
      store.saveThrottled();
    }
  }

  function getAccountHealth(profileId) {
    if (!profileId) return null;
    clearExpiredAccountHealth();
    return getAccountHealthMap()[profileId] || null;
  }

  function markAccountProfileHealthy(profile) {
    if (!profile?.profileId) return;
    const map = getAccountHealthMap();
    if (map[profile.profileId]) delete map[profile.profileId];
    store.data.bridge.lastGoodAccountProfileId = profile.profileId;
    store.markDirty();
    store.saveThrottled();
  }

  function markAccountProfileUnhealthy(profile, reason, cooldownMs = ACCOUNT_HEALTH_COOLDOWN_MS) {
    if (!profile?.profileId) return;
    const map = getAccountHealthMap();
    map[profile.profileId] = {
      reason: reason || "unknown",
      lastFailedAt: nowIso(),
      badUntil: Date.now() + cooldownMs,
    };
    store.markDirty();
    store.saveThrottled();
  }

  function isAccountProfileTemporarilyBlocked(profile) {
    const health = getAccountHealth(profile?.profileId);
    return Boolean(health?.badUntil && health.badUntil > Date.now());
  }

  function saveAccountProfileSnapshot(profile, auth) {
    if (!profile?.sourcePath || !profile?.profileId || !auth?.tokens) return;
    const parsed = loadJsonFile(profile.sourcePath);
    if (!parsed || typeof parsed !== "object") return;
    const profileMap =
      parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : parsed;
    if (!profileMap || typeof profileMap !== "object") return;
    const existing = profileMap[profile.profileId];
    if (!existing || typeof existing !== "object") return;
    profileMap[profile.profileId] = {
      ...existing,
      type: "oauth",
      provider: "openai-codex",
      access: auth.tokens.access_token,
      refresh: auth.tokens.refresh_token,
      expires: getJwtExpiryMs(auth.tokens.access_token),
      accountId: auth.tokens.account_id || profile.accountId || "",
    };
    atomicWriteJson(profile.sourcePath, parsed);
    profile.access = auth.tokens.access_token;
    profile.refresh = auth.tokens.refresh_token;
    profile.accountId = auth.tokens.account_id || profile.accountId || null;
    profile.expires = getJwtExpiryMs(auth.tokens.access_token);
  }

  function selectFreshAuthForProfile(profile) {
    const candidates = [readCodexAuth(runtimeAuthPath), readCodexAuth(fallbackAuthPath)]
      .filter((auth) => auth?.tokens?.account_id && auth.tokens.account_id === profile.accountId);
    if (!candidates.length) return null;
    return candidates
      .sort((left, right) => getJwtExpiryMs(right.tokens?.access_token) - getJwtExpiryMs(left.tokens?.access_token))[0];
  }

  function getBestAccountAccessExpiryMs(profile) {
    const freshestAuth = selectFreshAuthForProfile(profile);
    return maxFinitePositive([
      profile?.expires,
      getJwtExpiryMs(profile?.access),
      getJwtExpiryMs(freshestAuth?.tokens?.access_token),
    ]);
  }

  function isAccountProfileExpiredForSelection(profile) {
    return isAccessExpiryExpired(getBestAccountAccessExpiryMs(profile));
  }

  function isAccountProfileSelectable(profile, { attemptedProfileIds = new Set(), allowBlocked = false } = {}) {
    if (!profile?.profileId) return false;
    if (attemptedProfileIds?.has?.(profile.profileId)) return false;
    if (isAccountProfileExpiredForSelection(profile)) return false;
    if (!allowBlocked && isAccountProfileTemporarilyBlocked(profile)) return false;
    return true;
  }

  function readRuntimeAccountId() {
    const auth = readCodexAuth(runtimeAuthPath);
    const accountId = auth?.tokens?.account_id;
    return typeof accountId === "string" && accountId ? accountId : null;
  }

  function extractAuthRuntimeIdentity(auth) {
    if (!auth?.tokens) return null;
    const payload = parseJwtPayload(auth.tokens.access_token) || {};
    const authInfo = payload?.["https://api.openai.com/auth"] || {};
    const profileInfo = payload?.["https://api.openai.com/profile"] || {};
    const accountId =
      (typeof auth.tokens.account_id === "string" && auth.tokens.account_id) ||
      (typeof authInfo.chatgpt_account_id === "string" && authInfo.chatgpt_account_id) ||
      null;
    const email =
      (typeof profileInfo.email === "string" && profileInfo.email) ||
      (typeof payload.email === "string" && payload.email) ||
      null;
    const refreshToken =
      typeof auth.tokens.refresh_token === "string" && auth.tokens.refresh_token
        ? auth.tokens.refresh_token
        : null;
    return {
      accountId,
      email,
      refreshToken,
    };
  }

  function findAccountProfileForRuntimeIdentity(identity) {
    if (!identity) return null;
    if (identity.refreshToken) {
      const directRefreshMatch = accountProfiles.find((profile) => profile.refresh === identity.refreshToken);
      if (directRefreshMatch) return directRefreshMatch;
    }
    if (identity.accountId) {
      const directAccountMatch = accountProfiles.find((profile) => profile.accountId === identity.accountId);
      if (directAccountMatch) return directAccountMatch;
    }
    return null;
  }

  function getRuntimeAccountBinding() {
    const auth = readCodexAuth(runtimeAuthPath);
    const identity = extractAuthRuntimeIdentity(auth);
    const matchedProfile = findAccountProfileForRuntimeIdentity(identity);
    return {
      auth,
      accountId: identity?.accountId || null,
      email: identity?.email || null,
      profileId: matchedProfile?.profileId || null,
      profileLabel: matchedProfile?.label || null,
    };
  }

  function reconcileRuntimeAccountBinding({ expectedProfile = null, strict = false } = {}) {
    const runtime = getRuntimeAccountBinding();
    const actualProfile = runtime.profileId ? findAccountProfile(runtime.profileId) : null;
    if (actualProfile?.profileId && store.data.bridge.currentAccountProfileId !== actualProfile.profileId) {
      store.data.bridge.currentAccountProfileId = actualProfile.profileId;
      store.markDirty();
      store.saveThrottled();
    }
    if (!strict || !expectedProfile) return runtime;

    const mismatchReasons = [];
    if (expectedProfile.accountId && runtime.accountId && expectedProfile.accountId !== runtime.accountId) {
      mismatchReasons.push(`runtime accountId=${runtime.accountId}, expected=${expectedProfile.accountId}`);
    }
    if (actualProfile?.profileId && actualProfile.profileId !== expectedProfile.profileId) {
      mismatchReasons.push(`runtime profileId=${actualProfile.profileId}, expected=${expectedProfile.profileId}`);
    }
    if (!runtime.accountId && !actualProfile?.profileId) {
      mismatchReasons.push("runtime auth identity could not be resolved");
    }
    if (mismatchReasons.length) {
      const err = new Error(`Runtime account drift detected after switch: ${mismatchReasons.join("; ")}`);
      err.runtimeBinding = runtime;
      throw err;
    }
    return runtime;
  }

  function findAccountProfile(selector) {
    if (!selector) return null;
    const normalized = String(selector).trim();
    if (!normalized) return null;
    const direct = accountProfiles.find((profile) => (
      profile.profileId === normalized ||
      profile.accountId === normalized ||
      profile.label === normalized
    ));
    if (direct) return direct;

    const asIndex = Number(normalized);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= accountProfiles.length) {
      return accountProfiles[asIndex - 1];
    }

    const lowered = normalized.toLowerCase();
    return accountProfiles.find((profile) => (
      profile.profileId.toLowerCase() === lowered ||
      (profile.accountId && profile.accountId.toLowerCase() === lowered) ||
      profile.label.toLowerCase() === lowered
    )) || null;
  }

  function resolveInitialAccountProfile() {
    const selectable = (profile) => (
      profile && isAccountProfileSelectable(profile, { allowBlocked: false })
    );
    const nonExpired = (profile) => profile && !isAccountProfileExpiredForSelection(profile);
    const hasPreferredSelectable = accountProfiles.some((profile) => !profile.lastResort && selectable(profile));
    const canUseCandidate = (profile) => profile && (!profile.lastResort || !hasPreferredSelectable);

    const stored = store.data.bridge?.currentAccountProfileId;
    if (stored) {
      const found = findAccountProfile(stored);
      if (selectable(found) && canUseCandidate(found)) return found;
    }

    const lastGood = store.data.bridge?.lastGoodAccountProfileId;
    if (lastGood) {
      const found = findAccountProfile(lastGood);
      if (selectable(found) && canUseCandidate(found)) return found;
    }

    const runtimeAccountId = readRuntimeAccountId();
    if (runtimeAccountId) {
      const found = accountProfiles.find((profile) => profile.accountId === runtimeAccountId);
      if (selectable(found) && canUseCandidate(found)) return found;
    }

    const priorityProfiles = prioritizeAccountProfiles(accountProfiles);
    return priorityProfiles.find((profile) => selectable(profile))
      || priorityProfiles.find((profile) => nonExpired(profile))
      || priorityProfiles[0]
      || null;
  }

  function writeAuthForProfile(profile) {
    if (!profile) throw new Error("No account profile selected");
    if (!authTemplate) {
      throw new Error("No auth template available. Seed CODEX_HOME with a working Codex auth.json first.");
    }
    const freshestAuth = selectFreshAuthForProfile(profile);
    const next = {
      auth_mode: freshestAuth?.auth_mode || authTemplate.auth_mode || "chatgpt",
      OPENAI_API_KEY: freshestAuth?.OPENAI_API_KEY ?? authTemplate.OPENAI_API_KEY ?? null,
      tokens: {
        id_token: freshestAuth?.tokens?.id_token || authTemplate.tokens?.id_token || "",
        access_token: freshestAuth?.tokens?.access_token || profile.access,
        refresh_token: freshestAuth?.tokens?.refresh_token || profile.refresh,
        account_id: freshestAuth?.tokens?.account_id || profile.accountId || "",
      },
      last_refresh: new Date().toISOString(),
    };
    fs.writeFileSync(runtimeAuthPath, JSON.stringify(next, null, 2));
    saveAccountProfileSnapshot(profile, next);
  }

  function buildAccountMeta() {
    const currentProfileId = store.data.bridge?.currentAccountProfileId || null;
    const currentProfile = findAccountProfile(currentProfileId) || resolveInitialAccountProfile();
    const runtime = reconcileRuntimeAccountBinding();
    return {
      currentAccountProfileId: currentProfile?.profileId || null,
      currentAccountLabel: currentProfile?.label || null,
      runtimeAccountProfileId: runtime.profileId || null,
      runtimeAccountLabel: runtime.profileLabel || null,
      runtimeAccountEmail: runtime.email || null,
      runtimeAccountId: runtime.accountId || null,
      accountSourcePath: accountsSource || null,
      accountProfiles,
      autoAccountFailover,
    };
  }

  function accountNumber(profile) {
    if (!profile) return null;
    const index = accountProfiles.findIndex((item) => item.profileId === profile.profileId);
    return index >= 0 ? index + 1 : null;
  }

  function getCurrentAccountProfile() {
    return findAccountProfile(store.data.bridge?.currentAccountProfileId)
      || resolveInitialAccountProfile()
      || null;
  }

  function extractCodexErrorText(err) {
    const parts = [];
    if (err?.message) parts.push(String(err.message));
    if (err?.rpcError?.message) parts.push(String(err.rpcError.message));
    if (err?.rpcError?.code !== undefined && err?.rpcError?.code !== null) {
      parts.push(String(err.rpcError.code));
    }
    const data = err?.rpcError?.data;
    if (typeof data === "string") {
      parts.push(data);
    } else if (data !== undefined) {
      try {
        parts.push(JSON.stringify(data));
      } catch {
        parts.push(String(data));
      }
    }
    return parts.filter(Boolean).join(" | ");
  }

  function isAccountFailoverError(err) {
    if (!autoAccountFailover || accountProfiles.length < 2) return false;
    const text = extractCodexErrorText(err);
    if (!text) return false;
    return ACCOUNT_FAILOVER_PATTERNS.some((pattern) => pattern.test(text));
  }

  function isAccountAuthFailure(err) {
    const text = extractCodexErrorText(err);
    return isAccountAuthFailureText(text);
  }

  function isRuntimeAccountDriftError(err) {
    const text = extractCodexErrorText(err) || err?.message || "";
    return /runtime account drift detected/i.test(String(text));
  }

  function isAccountRecoveryError(err) {
    return isAccountFailoverError(err) || isAccountAuthFailure(err) || isRuntimeAccountDriftError(err);
  }

  function markProfileForRecoveryError(profile, err) {
    if (!profile) return;
    const cooldownMs = (isAccountAuthFailure(err) || isRuntimeAccountDriftError(err))
      ? ACCOUNT_HEALTH_COOLDOWN_MS
      : ACCOUNT_LIMIT_COOLDOWN_MS;
    markAccountProfileUnhealthy(profile, extractCodexErrorText(err), cooldownMs);
  }

  function extractTurnErrorText(turn) {
    const parts = [];
    if (turn?.error?.message) parts.push(String(turn.error.message));
    if (turn?.error?.codexErrorInfo) parts.push(String(turn.error.codexErrorInfo));
    if (turn?.error?.additionalDetails) parts.push(String(turn.error.additionalDetails));
    return parts.filter(Boolean).join(" | ");
  }

  function isAccountAuthFailureTurn(turn) {
    const codexErrorInfo = turn?.error?.codexErrorInfo;
    if (typeof codexErrorInfo === "string" && /unauthorized|auth/i.test(codexErrorInfo)) {
      return true;
    }
    return isAccountAuthFailureText(extractTurnErrorText(turn));
  }

  function isUsageLimitTurn(turn) {
    if (!autoAccountFailover || accountProfiles.length < 2) return false;
    const codexErrorInfo = turn?.error?.codexErrorInfo;
    if (typeof codexErrorInfo === "string" && codexErrorInfo === "usageLimitExceeded") return true;
    const text = extractTurnErrorText(turn);
    if (!text) return false;
    return ACCOUNT_FAILOVER_PATTERNS.some((pattern) => pattern.test(text));
  }

  function isLikelyContextTurnFailure(turn, session) {
    const text = extractTurnErrorText(turn);
    return shouldTreatTextAsContextFailure(text, session?.compactionPendingReason || null);
  }

  function isLikelyContextRequestError(err, session) {
    const text = extractCodexErrorText(err);
    return shouldTreatTextAsContextFailure(text, session?.compactionPendingReason || null);
  }

  function listFallbackProfiles(currentProfileId, attemptedProfileIds = new Set()) {
    const startIndex = accountProfiles.findIndex((profile) => profile.profileId === currentProfileId);
    const filterProfiles = (profiles) => profiles.filter((profile) => !attemptedProfileIds.has(profile.profileId));
    const skipExpired = (profiles) => profiles.filter((profile) => !isAccountProfileExpiredForSelection(profile));
    const skipBlocked = (profiles) => profiles.filter((profile) => !isAccountProfileTemporarilyBlocked(profile));
    if (startIndex < 0) {
      const fresh = skipExpired(filterProfiles(accountProfiles));
      const available = skipBlocked(fresh);
      return available.length ? prioritizeAccountProfiles(available) : prioritizeAccountProfiles(fresh);
    }
    const rotated = [
      ...accountProfiles.slice(startIndex + 1),
      ...accountProfiles.slice(0, startIndex),
    ];
    const fresh = skipExpired(filterProfiles(prioritizeAccountProfiles(rotated)));
    const available = skipBlocked(fresh);
    return available.length ? available : fresh;
  }

  async function verifySwitchedAccount(profile) {
    const started = await codex.request("thread/start", {
      cwd: defaults.cwd,
      model: defaults.model,
      personality: defaults.personality,
      approvalPolicy: defaults.approvalPolicy,
      sandbox: defaults.sandboxMode,
    });
    const threadId = started?.thread?.id || started?.threadId || started?.thread?.threadId;
    if (!threadId) throw new Error(`thread/start did not return a thread id for account ${profile?.profileId || "unknown"}`);
    return threadId;
  }

  async function requestWithAccountFailover({
    chatId,
    run,
    failureLabel = "request",
    authRecoveryAttempted = false,
    allowAuthReplayHandoff = true,
  }) {
    await waitForCodexBackendRecovery();
    try {
      return await run();
    } catch (err) {
      if (isAccountAuthFailure(err)) {
        if (authRecoveryAttempted) throw err;
        const replayHandoff = allowAuthReplayHandoff && shouldHandoffAuthRecoveryToReplay(chatId);
        const recovered = await ensureCodexBackendRecovered({
          source: "request_failure",
          chatId,
          reason: extractCodexErrorText(err),
          failureLabel,
        });
        if (!recovered) {
          if (chatId && !replayHandoff) {
            await telegram.sendMessage({
              chat_id: chatId,
              text: "Codex backend auth recovery failed after trying every spare account once.",
            });
          }
          throw err;
        }
        if (replayHandoff) {
          return AUTH_RECOVERY_HANDOFF;
        }
        return requestWithAccountFailover({
          chatId,
          run,
          failureLabel,
          authRecoveryAttempted: true,
          allowAuthReplayHandoff,
        });
      }
      if (codexBackendRecoveryPromise && isAccountRecoveryError(err)) {
        await waitForCodexBackendRecovery();
        return requestWithAccountFailover({
          chatId,
          run,
          failureLabel,
          authRecoveryAttempted,
          allowAuthReplayHandoff,
        });
      }
      if (!isAccountFailoverError(err)) throw err;

      let lastError = err;
      let currentProfile = getCurrentAccountProfile();
      markProfileForRecoveryError(currentProfile, err);
      const attempted = new Set(currentProfile ? [currentProfile.profileId] : []);
      const fallbackProfiles = listFallbackProfiles(currentProfile?.profileId, attempted);

      if (!fallbackProfiles.length) {
        await telegram.sendMessage({
          chat_id: chatId,
          text: "Current account hit a limit, and there is no spare Codex account to retry with.",
        });
        throw err;
      }

      for (const nextProfile of fallbackProfiles) {
        const nextNumber = accountNumber(nextProfile);
        const numberLabel = nextNumber ? `#${nextNumber}` : "next";
        await telegram.sendMessage({
          chat_id: chatId,
          text: `Detected an account problem during ${failureLabel}. Switching to account ${numberLabel} and retrying…`,
        });

        try {
          await switchAccountProfile(nextProfile);
        } catch (switchErr) {
          lastError = switchErr;
          attempted.add(nextProfile.profileId);
          await telegram.sendMessage({
            chat_id: chatId,
            text: `Account ${numberLabel} failed its health check. Trying the next spare account…`,
          });
          continue;
        }
        currentProfile = nextProfile;
        startTyping(chatId);

        try {
          return await run();
        } catch (retryErr) {
          if (!isAccountRecoveryError(retryErr)) throw retryErr;
          lastError = retryErr;
          markProfileForRecoveryError(currentProfile, retryErr);
        }
      }

      await telegram.sendMessage({
        chat_id: chatId,
        text: "All configured Codex accounts appear to be limited right now. I stopped after trying each one once.",
      });
      throw lastError;
    }
  }

  let codex = null;
  let restartRequested = false;
  let codexBackendRecoveryPromise = null;
  let codexBackendRecoveryBypassDepth = 0;
  let codexBackendTransitionDepth = 0;
  const codexEnv = { ...process.env, CODEX_HOME: codexHome };

  const codexBin = resolveCodexBin();

  async function requestSupervisorRestart(reason) {
    if (restartRequested) return;
    restartRequested = true;

    const health = ensureTelegramHealthState();
    health.restartRequestedAt = Date.now();
    health.restartReason = truncateMiddle(reason, 220);
    store.markDirty();
    store.save({ force: true });

    console.error(`Bridge self-recovery restart requested: ${reason}`);
    stopTypingForAllChats();
    if (codex) codex.stop({ expected: true });
    await sleep(100);
    process.exit(1);
  }

  async function retryTurnAfterUsageLimit({ chatId, session, rt, turn }) {
    if (!isUsageLimitTurn(turn) || rt.failoverInProgress) return false;

    const inputMeta = rt.turnInputMetaByTurnId?.[turn?.id];
    if (!inputMeta?.text) return false;

    const currentProfile = getCurrentAccountProfile();
    markProfileForRecoveryError(currentProfile, { message: extractTurnErrorText(turn) || "usage limit" });
    const attempted = new Set(uniqueStrings([
      ...(inputMeta.attemptedProfileIds || []),
      currentProfile?.profileId || null,
    ]));
    const fallbackProfiles = listFallbackProfiles(currentProfile?.profileId, attempted);
    if (!fallbackProfiles.length) return false;

    rt.failoverInProgress = true;
    delete rt.turnInputMetaByTurnId[turn.id];

    try {
      for (const nextProfile of fallbackProfiles) {
        const nextNumber = accountNumber(nextProfile);
        const numberLabel = nextNumber ? `#${nextNumber}` : "next";
        await telegram.sendMessage({
          chat_id: chatId,
          text: `Current account hit a usage limit during the turn. Switching to account ${numberLabel} and retrying…`,
        });

        try {
          await switchAccountProfile(nextProfile);
        } catch (switchErr) {
          attempted.add(nextProfile.profileId);
          await telegram.sendMessage({
            chat_id: chatId,
            text: `Account ${numberLabel} failed its health check. Trying the next spare account…`,
          });
          continue;
        }

        startTyping(chatId);
        await startOrSteerTurn({
          chatId,
          session,
          text: inputMeta.text,
          kind: inputMeta.kind || "user",
          silent: Boolean(inputMeta.silent),
          contextRetryCount: Number(inputMeta.contextRetryCount || 0),
          attemptedProfileIds: uniqueStrings([
            ...attempted,
            nextProfile.profileId,
          ]),
        });
        return true;
      }
      return false;
    } finally {
      rt.failoverInProgress = false;
    }
  }

  async function retryTurnAfterAuthFailure({ chatId, rt, turn }) {
    if (rt.failoverInProgress) return false;
    if (!isAccountAuthFailureTurn(turn)) return false;

    const turnMeta = getTurnInputMeta(rt, turn?.id);
    const replayTask = buildAuthRecoveryReplayTask(
      turnMeta,
      isCompactionTurnKind(turnMeta?.kind) ? "compaction_auth_failure" : "turn_auth_failure",
    );
    if (replayTask) {
      queueAuthRecoveryReplayTask(rt, replayTask);
    }

    const recovered = await ensureCodexBackendRecovered({
      source: "turn_failure",
      chatId,
      reason: extractTurnErrorText(turn) || "Codex backend auth failure",
      turnId: turn?.id || null,
    });
    if (!recovered && !replayTask && chatId) {
      await telegram.sendMessage({
        chat_id: chatId,
        text: "Codex backend auth recovery failed after trying every spare account once.",
      });
    }
    return true;
  }

  async function retryTurnAfterContextFailure({ chatId, session, rt, turn }) {
    if (rt.failoverInProgress || rt.compactionInProgress) return false;
    if (!isLikelyContextTurnFailure(turn, session)) return false;

    const inputMeta = rt.turnInputMetaByTurnId?.[turn?.id];
    if (!inputMeta?.text) return false;
    if (Number(inputMeta.contextRetryCount || 0) >= 1) return false;

    delete rt.turnInputMetaByTurnId[turn.id];
    return retryAfterContextCompaction({
      chatId,
      session,
      rt,
      text: inputMeta.text,
      attemptedProfileIds: inputMeta.attemptedProfileIds || [],
      contextRetryCount: Number(inputMeta.contextRetryCount || 0),
      source: "turn_failure",
      detail: extractTurnErrorText(turn),
    });
  }

  async function ensureHealthyStartupAccount() {
    if (!autoAccountFailover || accountProfiles.length < 2) return;
    const currentProfile = getCurrentAccountProfile();
    if (!currentProfile) return;

    try {
      await verifySwitchedAccount(currentProfile);
      reconcileRuntimeAccountBinding({ expectedProfile: currentProfile, strict: true });
      store.data.bridge.currentAccountProfileId = currentProfile.profileId;
      markAccountProfileHealthy(currentProfile);
      store.markDirty();
      store.saveThrottled();
      return;
    } catch (err) {
      if (!isAccountRecoveryError(err)) {
        console.warn("Initial account health check failed, but not with a recognized account error:", err.message);
        return;
      }
      markProfileForRecoveryError(currentProfile, err);
      console.warn(`Initial account ${currentProfile.profileId} failed health check:`, err.message);
    }

    const attempted = new Set(currentProfile?.profileId ? [currentProfile.profileId] : []);
    const fallbackProfiles = listFallbackProfiles(currentProfile?.profileId, attempted);
    for (const nextProfile of fallbackProfiles) {
      try {
        await switchAccountProfile(nextProfile);
        console.warn(`Recovered bridge startup onto ${nextProfile.profileId}`);
        return;
      } catch (err) {
        markProfileForRecoveryError(nextProfile, err);
        console.warn(`Fallback startup account ${nextProfile.profileId} failed health check:`, err.message);
      }
    }
  }

  function recordContextUsageForSession(session, params) {
    const snapshot = extractContextUsageSnapshotPayload(params);
    if (!applyContextUsageSnapshot(session, snapshot, contextThresholds, nowIso())) return false;
    session.updatedAt = nowIso();
    store.markDirty();
    store.saveThrottled();
    return true;
  }

  function getCompactionBlockReason(session, rt, { allowQueuedTasks = false } = {}) {
    if (!session.threadId) return "No existing thread to compact yet.";
    if (rt.activeTurnId) return "A turn is still running. Wait for it to finish or use /stop first.";
    if (rt.failoverInProgress) return "Account failover is in progress. Try again after it settles.";
    if (rt.compactionInProgress) return "Context compaction is already in progress.";
    if (!allowQueuedTasks && getQueuedTaskCount(rt) > 0) {
      return "There are queued tasks. Clear them first with /stop, then compact.";
    }
    return null;
  }

  function shouldAutoCompact(session, rt, { allowDuringIdle = true } = {}) {
    return shouldAutoCompactDecision({
      autoCompactEnabled: autoCompact,
      session,
      rt,
      allowDuringIdle,
    });
  }

  async function finishCompaction({ chatId, session, rt, turnId, mode = "manual" }) {
    const summaryText = extractFinalTurnAgentText(rt, turnId);
    if (!summaryText) {
      rt.compactionInProgress = false;
      rt.postCompactionRetryTask = null;
      await telegram.sendMessage({
        chat_id: chatId,
        text: mode === "auto"
          ? "自动压缩未生成可用摘要，仍停留在当前 thread。"
          : "Context compaction finished without a usable summary. Staying on the current thread.",
      });
      return false;
    }

    const oldThreadId = session.threadId;
    const nextGeneration = Number(session.compactionGeneration || 0) + 1;
    const generatedAt = nowIso();
    const summary = {
      version: COMPACTION_SUMMARY_VERSION,
      format: COMPACTION_SUMMARY_FORMAT,
      text: summaryText,
      sourceThreadId: oldThreadId,
      generatedAt,
    };

    try {
      await startFreshThread(session, chatId, { announceText: null });
    } catch (err) {
      rt.compactionInProgress = false;
      rt.postCompactionRetryTask = null;
      await telegram.sendMessage({
        chat_id: chatId,
        text: mode === "auto"
          ? `自动压缩已生成摘要，但创建新 thread 失败：${truncateMiddle(err.message || String(err), 800)}`
          : `Context summary was generated, but creating a fresh thread failed: ${truncateMiddle(err.message || String(err), 800)}`,
      });
      return false;
    }

    const newThreadId = session.threadId;
    session.compactionSummary = summary;
    session.pendingSummaryBootstrap = {
      text: summaryText,
      sourceThreadId: oldThreadId,
      generation: nextGeneration,
      generatedAt,
    };
    session.preCompactionThreadId = oldThreadId;
    session.lastCompactionAt = generatedAt;
    session.compactionGeneration = nextGeneration;
    session.compactionPending = false;
    session.compactionPendingReason = null;
    session.updatedAt = generatedAt;
    store.markDirty();
    store.saveThrottled();
    rt.compactionInProgress = false;

    const text = isGroupChat(chatId)
      ? mode === "auto"
        ? "上下文已自动压缩并切到新 thread。"
        : "上下文已压缩并切到新 thread。"
      : [
          mode === "auto" ? "Context auto-compacted into a fresh thread." : "Context compacted into a fresh thread.",
          `oldThreadId: ${oldThreadId}`,
          `newThreadId: ${newThreadId}`,
          `generation: ${nextGeneration}`,
        ].join("\n");
    await telegram.sendMessage({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
    if (rt.postCompactionRetryTask) {
      const retryTask = rt.postCompactionRetryTask;
      rt.postCompactionRetryTask = null;
      try {
        await startOrSteerTurn({
          chatId,
          session,
          text: retryTask.text,
          attemptedProfileIds: retryTask.attemptedProfileIds || null,
          kind: retryTask.kind || "user",
          silent: Boolean(retryTask.silent),
          contextRetryCount: Number(retryTask.contextRetryCount || 0),
        });
      } catch (err) {
        await telegram.sendMessage({
          chat_id: chatId,
          text: `压缩后的自动重试失败：${truncateMiddle(err.message || String(err), 1200)}`,
        });
      }
    } else if (mode === "auto" && getQueuedTaskCount(rt) > 0) {
      await maybeStartQueuedTask({ chatId, session });
    }
    return true;
  }

  async function retryAfterContextCompaction({
    chatId,
    session,
    rt,
    text,
    attemptedProfileIds = null,
    contextRetryCount = 0,
    source = "turn",
    detail = "",
  }) {
    if (!text || contextRetryCount >= 1 || rt.compactionInProgress) return false;
    rt.postCompactionRetryTask = {
      text,
      attemptedProfileIds: attemptedProfileIds || [],
      kind: "user",
      silent: false,
      contextRetryCount: contextRetryCount + 1,
      source,
      createdAt: nowIso(),
    };
    const started = await startCompaction({
      chatId,
      session,
      mode: "auto",
      reason: "context_failure_retry",
      allowQueuedTasks: true,
    });
    if (!started) {
      rt.postCompactionRetryTask = null;
      return true;
    }
    const retryText = isGroupChat(chatId)
      ? "检测到上下文相关失败，正在压缩后自动重试一次。"
      : detail
        ? `Detected a context-related failure. Compacting the thread and retrying once.\n\n${truncateMiddle(detail, 600)}`
        : "Detected a context-related failure. Compacting the thread and retrying once.";
    await telegram.sendMessage({ chat_id: chatId, text: retryText });
    return true;
  }

  async function startCompaction({
    chatId,
    session,
    mode = "manual",
    reason = null,
    allowQueuedTasks = false,
  }) {
    const rt = getRuntime(chatId);
    const blockedReason = getCompactionBlockReason(session, rt, { allowQueuedTasks });
    if (blockedReason) {
      if (mode === "manual") {
        await telegram.sendMessage({ chat_id: chatId, text: blockedReason });
      }
      return false;
    }

    try {
      await requestWithAccountFailover({
        chatId,
        failureLabel: "thread resume for compaction",
        run: async () => codex.request("thread/resume", {
          threadId: session.threadId,
          cwd: session.cwd,
          model: session.model,
          personality: session.personality,
          approvalPolicy: session.approvalPolicy,
          sandbox: session.sandboxMode,
        }),
      });
    } catch (err) {
      const text = mode === "auto"
        ? `自动压缩无法恢复当前 thread：${truncateMiddle(err.message || String(err), 800)}`
        : `Failed to resume the current thread for compaction: ${truncateMiddle(err.message || String(err), 800)}`;
      await telegram.sendMessage({ chat_id: chatId, text });
      return false;
    }

    rt.compactionInProgress = true;
    const startText = mode === "auto"
      ? isGroupChat(chatId)
        ? "上下文接近窗口上限，正在自动压缩…"
        : `当前上下文占用已到 ${formatPercent(session.contextUsageRatio)}，正在自动压缩当前 thread…`
      : "正在压缩当前上下文，请稍候…";
    await telegram.sendMessage({
      chat_id: chatId,
      text: startText,
    });

    try {
      await startOrSteerTurn({
        chatId,
        session,
        text: buildCompactionPrompt(),
        kind: mode === "auto" ? "autoCompaction" : "manualCompaction",
        silent: true,
      });
      return true;
    } catch (err) {
      rt.compactionInProgress = false;
      throw err;
    }
  }

  async function startManualCompaction({ chatId, session }) {
    return startCompaction({ chatId, session, mode: "manual" });
  }

  async function startCodexServer() {
    const server = new CodexAppServer({ codexBin, env: codexEnv });
    server.onAuthWatchdog((event) => {
      queueCodexBackendRecovery(event);
    });
    server.onProcessExit(({ code, signal, expected, authFailure }) => {
      if (expected) return;
      const reason = authFailure?.reason || `codex app-server exited (code=${code}, signal=${signal})`;
      recordCodexBackendFailure(reason, {
        auth: Boolean(authFailure),
        code,
        signal,
      });
    });
    server.onNotification(async (msg) => {
      const { method, params } = msg;
      if (!method || !params) return;

      if (method === "token_count") {
        const chatId = chatIdForTelemetry(params);
        if (!chatId) return;
        const session = getOrCreateSession(chatId);
        const recorded = recordContextUsageForSession(session, params);
        if (!recorded) return;
        const rt = getRuntime(chatId);
        const autoReason = shouldAutoCompact(session, rt);
        if (autoReason && !rt.activeTurnId) {
          await startCompaction({
            chatId,
            session,
            mode: "auto",
            reason: autoReason,
            allowQueuedTasks: true,
          });
        }
        return;
      }

      if (method === "contextCompaction") {
        const chatId = chatIdForTelemetry(params);
        if (!chatId) return;
        console.log(`Observed contextCompaction for chat ${chatId}`);
        return;
      }

      if (method === "turn/started") {
        const { threadId, turn } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId) return;
        const rt = getRuntime(chatId);
        rt.activeTurnId = turn?.id || null;
        rt.lastGroupProgressByBucket = {};
        rt.sentGroupVisibleTexts = new Set();
        if (turn?.id && rt.pendingInputMeta) {
          rt.turnInputMetaByTurnId[turn.id] = { ...rt.pendingInputMeta };
          rt.pendingInputMeta = null;
        }
        return;
      }

      if (method === "turn/completed") {
        const { threadId, turn } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId) return;
        const session = getOrCreateSession(chatId);
        const rt = getRuntime(chatId);
        const turnMeta = getTurnInputMeta(rt, turn?.id);
        const silentTurn = Boolean(turnMeta?.silent);
        const compactionTurnKind = isCompactionTurnKind(turnMeta?.kind) ? turnMeta.kind : null;
        const status = turn?.status || "completed";
        rt.activeTurnId = null;
        stopTyping(chatId);
        await flushBufferedAgentMessages(chatId, rt);

        if (!silentTurn && isGroupChat(chatId) && status === "completed") {
          await revealFinalGroupAgentMessage(chatId, rt, turn?.id);
        }

        if (status !== "completed") {
          const authRetried = await retryTurnAfterAuthFailure({ chatId, rt, turn });
          const retried = authRetried
            ? false
            : await retryTurnAfterUsageLimit({ chatId, session, rt, turn });
          const contextRetried = authRetried || retried
            ? false
            : await retryTurnAfterContextFailure({ chatId, session, rt, turn });
          if (!authRetried && !retried && !contextRetried) {
            if (compactionTurnKind) {
              rt.compactionInProgress = false;
              rt.postCompactionRetryTask = null;
              const rawDetail = extractTurnErrorText(turn);
              const detail = rawDetail ? truncateMiddle(rawDetail, 1200) : null;
              const text = status === "interrupted" || status === "cancelled"
                ? "Context compaction cancelled. Staying on the current thread."
                : detail
                  ? `Context compaction ${status}: ${detail}`
                  : `Context compaction ${status}. Staying on the current thread.`;
              await telegram.sendMessage({ chat_id: chatId, text });
            } else if (!silentTurn) {
              const rawDetail = extractTurnErrorText(turn);
              const detail = isGroupChat(chatId) ? sanitizeGroupAgentText(rawDetail) : rawDetail;
              const hint = isRemoteCompactTransportFailureText(rawDetail)
                ? buildRemoteCompactFailureHint({ hasSpareAccounts: autoAccountFailover && accountProfiles.length > 1 })
                : null;
              const maxDetailLen = hint ? 900 : 1200;
              const text = detail
                ? `Turn ${status}: ${truncateMiddle(detail, maxDetailLen)}${hint ? `\n\n${hint}` : ""}`
                : `Turn ${status}.${hint ? `\n\n${hint}` : ""}`;
              if (!(isGroupChat(chatId) && hasSeenGroupVisibleText(rt, text))) {
                await telegram.sendMessage({ chat_id: chatId, text });
                if (isGroupChat(chatId)) rememberGroupVisibleText(rt, text);
              }
            }
          }
        }

        const diff = rt.turnDiffByTurnId?.[turn?.id];
        if (!silentTurn && diff && typeof diff === "string" && diff.trim()) {
          const text = isGroupChat(chatId)
            ? "本轮包含代码改动，具体 diff 已在群里隐藏。"
            : `Turn diff (preview):\n\n${truncateMiddle(diff, 3500)}`;
          if (!(isGroupChat(chatId) && hasSeenGroupVisibleText(rt, text))) {
            await telegram.sendMessage({ chat_id: chatId, text });
            if (isGroupChat(chatId)) rememberGroupVisibleText(rt, text);
          }
        }

        if (status === "completed" && compactionTurnKind) {
          const finished = await finishCompaction({
            chatId,
            session,
            rt,
            turnId: turn?.id,
            mode: compactionTurnKind === "autoCompaction" ? "auto" : "manual",
          });
          if (!finished && compactionTurnKind === "autoCompaction") {
            await maybeStartQueuedTask({ chatId, session });
          }
        } else if (status === "completed") {
          const autoReason = shouldAutoCompact(session, rt, { allowDuringIdle: true });
          if (autoReason) {
            const started = await startCompaction({
              chatId,
              session,
              mode: "auto",
              reason: autoReason,
              allowQueuedTasks: true,
            });
            if (!started) {
              await maybeStartQueuedTask({ chatId, session });
            }
          } else {
            await maybeStartQueuedTask({ chatId, session });
          }
        }

        if (turn?.id) {
          delete rt.turnInputMetaByTurnId[turn.id];
          delete rt.lastAgentMessageIdByTurnId[turn.id];
          delete rt.groupAgentMessageByTurnId[turn.id];
          delete rt.groupAgentMessagePendingByTurnId[turn.id];
        }
        return;
      }

      if (method === "turn/diff/updated") {
        const { threadId, turnId, diff } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId) return;
        const rt = getRuntime(chatId);
        rt.turnDiffByTurnId[turnId] = diff;
        return;
      }

      if (method === "item/started") {
        const { threadId, turnId, item } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId) return;
        const session = getOrCreateSession(chatId);
        const rt = getRuntime(chatId);
        if (!item || !item.id) return;
        const effectiveTurnId = resolveAgentMessageTurnId({ explicitTurnId: turnId, rt });
        const silentTurn = isSilentTurn(rt, effectiveTurnId);

        if (item.type === "commandExecution") {
          if (silentTurn) {
            rt.items[item.id] = {
              kind: "command",
              messageId: null,
              header: "",
              buffer: "",
              redacted: true,
              silent: true,
            };
            return;
          }
          const redacted = isGroupChat(chatId);
          const header = item.command ? `$ ${item.command}` : "[commandExecution]";
          const cwdLine = item.cwd ? `cwd: ${item.cwd}` : session.cwd ? `cwd: ${session.cwd}` : null;
          const text = redacted
            ? summarizeGroupCommand(item.command)
            : [header, cwdLine].filter(Boolean).join("\n");
          if (redacted && shouldSuppressDuplicateGroupProgress(rt, text, "command")) {
            rt.items[item.id] = { kind: "command", messageId: null, header: text, buffer: "", redacted, suppressedDuplicate: true };
            return;
          }
          if (redacted && hasSeenGroupVisibleText(rt, text)) {
            rt.items[item.id] = { kind: "command", messageId: null, header: text, buffer: "", redacted, suppressedDuplicate: true };
            return;
          }
          const sent = await telegram.sendMessage({ chat_id: chatId, text });
          if (redacted) rememberGroupVisibleText(rt, text);
          rt.items[item.id] = { kind: "command", messageId: sent.message_id, header: text, buffer: "", redacted };
          return;
        }

        if (item.type === "fileChange") {
          if (silentTurn) {
            rt.items[item.id] = {
              kind: "fileChange",
              messageId: null,
              header: "",
              buffer: "",
              redacted: true,
              silent: true,
            };
            return;
          }
          const title = item.title || "[fileChange]";
          const redacted = isGroupChat(chatId);
          const text = redacted ? summarizeGroupFileChange(title) : title;
          if (redacted && shouldSuppressDuplicateGroupProgress(rt, text, "fileChange")) {
            rt.items[item.id] = { kind: "fileChange", messageId: null, header: text, buffer: "", redacted, suppressedDuplicate: true };
            return;
          }
          if (redacted && hasSeenGroupVisibleText(rt, text)) {
            rt.items[item.id] = { kind: "fileChange", messageId: null, header: text, buffer: "", redacted, suppressedDuplicate: true };
            return;
          }
          const sent = await telegram.sendMessage({ chat_id: chatId, text });
          if (redacted) rememberGroupVisibleText(rt, text);
          rt.items[item.id] = { kind: "fileChange", messageId: sent.message_id, header: text, buffer: "", redacted };
          return;
        }

        if (item.type === "agentMessage") {
          if (effectiveTurnId) rt.lastAgentMessageIdByTurnId[effectiveTurnId] = item.id;
          if (silentTurn) {
            rt.items[item.id] = {
              kind: "agentMessage",
              messageId: null,
              buffer: item.text || "",
              renderedBuffer: item.text || "",
              turnId: effectiveTurnId,
              silent: true,
            };
            return;
          }
          if (!rt.items[item.id]) {
            rt.items[item.id] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId: effectiveTurnId };
          } else {
            rt.items[item.id].turnId = effectiveTurnId || rt.items[item.id].turnId || null;
          }
          if (item.text && item.text.trim()) {
            await upsertAgentMessage({ chatId, item, rt });
          } else {
            rt.items[item.id] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId: effectiveTurnId };
          }
          return;
        }
      }

      if (method === "item/completed") {
        const { threadId, turnId, item } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId || !item || !item.id) return;
        const rt = getRuntime(chatId);
        const effectiveTurnId = resolveAgentMessageTurnId({ explicitTurnId: turnId, rt });
        const silentTurn = isSilentTurn(rt, effectiveTurnId);

        if (item.type === "agentMessage") {
          if (effectiveTurnId) rt.lastAgentMessageIdByTurnId[effectiveTurnId] = item.id;
          if (silentTurn) {
            if (!rt.items[item.id]) {
              rt.items[item.id] = {
                kind: "agentMessage",
                messageId: null,
                buffer: item.text || "",
                renderedBuffer: item.text || "",
                turnId: effectiveTurnId,
                silent: true,
              };
            } else if (typeof item.text === "string" && item.text.trim()) {
              rt.items[item.id].buffer = item.text;
              rt.items[item.id].renderedBuffer = item.text;
              rt.items[item.id].silent = true;
            }
            return;
          }
          if (!rt.items[item.id]) {
            rt.items[item.id] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId: effectiveTurnId };
          } else {
            rt.items[item.id].turnId = effectiveTurnId || rt.items[item.id].turnId || null;
          }
          await upsertAgentMessage({ chatId, item, rt });
        }
        return;
      }

      if (method === "item/agentMessage/delta") {
        const { threadId, turnId, itemId, delta } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId) return;
        const rt = getRuntime(chatId);
        const effectiveTurnId = resolveAgentMessageTurnId({ explicitTurnId: turnId, rt });
        const silentTurn = isSilentTurn(rt, effectiveTurnId);
        if (!rt.items?.[itemId]) {
          rt.items[itemId] = {
            kind: "agentMessage",
            messageId: null,
            buffer: "",
            renderedBuffer: "",
            turnId: effectiveTurnId,
            silent: silentTurn,
          };
        }
        if (effectiveTurnId) {
          rt.items[itemId].turnId = effectiveTurnId;
          rt.lastAgentMessageIdByTurnId[effectiveTurnId] = itemId;
        }
        if (silentTurn) rt.items[itemId].silent = true;
        rt.items[itemId].buffer += delta;
        return;
      }

      if (method === "item/commandExecution/outputDelta") {
        const { threadId, itemId, delta } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId) return;
        const rt = getRuntime(chatId);
        const entry = rt.items?.[itemId];
        if (!entry) return;
        if (entry.redacted) return;
        entry.buffer += delta;
        scheduleEdit({
          chatId,
          messageId: entry.messageId,
          rt,
          itemId,
          getText: () => {
            const body = truncateMiddle(entry.buffer || "", 3500) || "(no output yet)";
            return entry.header ? `${entry.header}\n\n${body}` : body;
          },
        });
        return;
      }

      if (method === "item/fileChange/outputDelta") {
        const { threadId, itemId, delta } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId) return;
        const rt = getRuntime(chatId);
        const entry = rt.items?.[itemId];
        if (!entry) return;
        if (entry.redacted) return;
        entry.buffer += delta;
        scheduleEdit({
          chatId,
          messageId: entry.messageId,
          rt,
          itemId,
          getText: () => {
            const body = truncateMiddle(entry.buffer || "", 3500) || "(no diff yet)";
            return entry.header ? `${entry.header}\n\n${body}` : body;
          },
        });
      }
    });

    server.onServerRequest(async (req) => {
      const { method, params } = req;
      if (!method) return { ok: false };

      const threadId = params?.threadId;
      const chatId = threadId ? chatIdForThread(threadId) : null;
      const session = chatId ? getOrCreateSession(chatId) : null;
      const autoApprove = defaults.autoApprove;

      if (method === "item/commandExecution/requestApproval") {
        if (autoApprove) return { ok: true, result: { decision: "acceptForSession" } };
        if (!chatId) return { ok: true, result: { decision: "decline" } };
        stopTyping(chatId);

        const cmd = params?.command || "(unknown command)";
        const reason = params?.reason ? `\nReason: ${params.reason}` : "";
        const { token, promise } = waitForTelegramAction({ kind: "approval", chatId });
        await telegram.sendMessage({
          chat_id: chatId,
          text: `Approve command?\n\n$ ${cmd}${reason}`,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Accept", callback_data: `appr|${token}|accept` },
                { text: "Accept (session)", callback_data: `appr|${token}|acceptForSession` },
                { text: "Deny", callback_data: `appr|${token}|decline` },
              ],
            ],
          },
        });
        const choice = await promise;
        startTyping(chatId);
        return { ok: true, result: { decision: choice || "decline" } };
      }

      if (method === "item/fileChange/requestApproval") {
        if (autoApprove) return { ok: true, result: { decision: "acceptForSession" } };
        if (!chatId) return { ok: true, result: { decision: "decline" } };
        stopTyping(chatId);

        const title = params?.title || "File changes";
        const reason = params?.reason ? `\nReason: ${params.reason}` : "";
        const { token, promise } = waitForTelegramAction({ kind: "approval", chatId });
        await telegram.sendMessage({
          chat_id: chatId,
          text: `Approve file change?\n\n${title}${reason}`,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Accept", callback_data: `appr|${token}|accept` },
                { text: "Accept (session)", callback_data: `appr|${token}|acceptForSession` },
                { text: "Deny", callback_data: `appr|${token}|decline` },
              ],
            ],
          },
        });
        const choice = await promise;
        startTyping(chatId);
        return { ok: true, result: { decision: choice || "decline" } };
      }

      if (method === "item/permissions/requestApproval") {
        if (autoApprove) {
          return { ok: true, result: { permissions: params.permissions, scope: "session" } };
        }
        return { ok: true, result: { permissions: params.permissions, scope: "turn" } };
      }

      if (method === "item/tool/requestUserInput") {
        if (!chatId) return { ok: false, error: { code: -32000, message: "No chat bound to threadId" } };
        stopTyping(chatId);
        const questions = params?.questions || [];
        if (questions.length !== 1) {
          await telegram.sendMessage({
            chat_id: chatId,
            text: "request_user_input with multiple questions is not supported yet.",
          });
          return { ok: true, result: { answers: {} } };
        }

        const q = questions[0];
        const questionId = q?.id || "q";
        if (Array.isArray(q.options) && q.options.length) {
          const { token, promise } = waitForTelegramAction({ kind: "userInputOption", chatId });
          const keyboard = q.options.slice(0, 8).map((opt, index) => ([
            { text: opt.label, callback_data: `ui|${token}|${index}` },
          ]));
          await telegram.sendMessage({
            chat_id: chatId,
            text: `${q.header}\n${q.question}`,
            reply_markup: { inline_keyboard: keyboard },
          });
          const selectedIdx = await promise;
          if (selectedIdx === null || selectedIdx === undefined) return { ok: true, result: { answers: {} } };
          const answer = q.options[Number(selectedIdx)]?.label || "";
          return { ok: true, result: { answers: { [questionId]: { answers: [answer] } } } };
        }

        const { token, promise } = waitForTelegramAction({ kind: "userInputText", chatId });
        await telegram.sendMessage({
          chat_id: chatId,
          text: `${q.header}\n${q.question}\n\nReply with:\n/answer ${token} <your answer>`,
        });
        const answer = await promise;
        if (!answer) return { ok: true, result: { answers: {} } };
        return { ok: true, result: { answers: { [questionId]: { answers: [String(answer)] } } } };
      }

      if (method === "item/tool/call") {
        return {
          ok: true,
          result: {
            success: false,
            contentItems: [{ type: "inputText", text: "Dynamic tools are not implemented in this bridge." }],
          },
        };
      }

      if (method === "input/request") {
        if (!chatId) return { ok: false, error: { code: -32001, message: "Chat not found for input request" } };
        stopTyping(chatId);

        const prompt = params?.prompt || "Codex needs more input.";
        const options = Array.isArray(params?.options) ? params.options : null;

        if (options && options.length > 0) {
          const { token, promise } = waitForTelegramAction({ kind: "userInputOption", chatId });
          await telegram.sendMessage({
            chat_id: chatId,
            text: prompt,
            reply_markup: {
              inline_keyboard: options.slice(0, 8).map((option) => ([
                {
                  text: option.label || option.value || "Option",
                  callback_data: `ui|${token}|${option.value ?? option.label ?? ""}`,
                },
              ])),
            },
          });
          const selected = await promise;
          startTyping(chatId);
          return { ok: true, result: { text: selected || "" } };
        }

        const { token, promise } = waitForTelegramAction({ kind: "userInputText", chatId });
        await telegram.sendMessage({
          chat_id: chatId,
          text: `${prompt}\n\nReply with:\n/answer ${token} your text`,
        });
        const typed = await promise;
        startTyping(chatId);
        return { ok: true, result: { text: typed || "" } };
      }

      if (method === "session/update") {
        if (!session) return { ok: true, result: {} };
        if (typeof params?.cwd === "string" && params.cwd.trim()) {
          setSessionCwdWithTruth(session, params.cwd.trim(), {
            reason: "session/update",
            bootstrapPending: true,
          });
        }
        if (typeof params?.model === "string" && params.model.trim()) session.model = params.model.trim();
        session.updatedAt = nowIso();
        store.markDirty();
        store.saveThrottled();
        return { ok: true, result: {} };
      }

      return { ok: false, error: { code: -32601, message: `Unhandled method: ${method}` } };
    });

    await server.start();
    await server.initialize();
    codex = server;
    recordCodexBackendHealthy();
  }

  /** @type {Map<string, any>} */
  const pendingActions = new Map(); // token -> { kind, chatId, resolve, ... }
  const unauthorizedNotified = new Set();

  /** @type {Map<number, { activeTurnId: string|null, items: Record<string, any>, turnDiffByTurnId: Record<string, string>, editTimers: Map<string, any> }>} */
  const runtimeByChat = new Map();

  function getRuntime(chatId) {
    const existing = runtimeByChat.get(chatId);
    if (existing) return existing;
    const created = {
      activeTurnId: null,
      pendingInputMeta: null,
      pendingTasks: [],
      queuedTaskSeq: 1,
      turnInputMetaByTurnId: {},
      lastAgentMessageIdByTurnId: {},
      groupAgentMessageByTurnId: {},
      groupAgentMessagePendingByTurnId: {},
      items: {},
      turnDiffByTurnId: {},
      postCompactionRetryTask: null,
      authRecoveryReplayTask: null,
      lastGroupProgressByBucket: {},
      sentGroupVisibleTexts: new Set(),
      editTimers: new Map(),
      failoverInProgress: false,
      compactionInProgress: false,
      typingTimer: null,
      menuPage: MENU_PAGES.MAIN,
    };
    runtimeByChat.set(chatId, created);
    return created;
  }

  function isChatBusy(rt) {
    return Boolean(rt?.activeTurnId || rt?.failoverInProgress || rt?.compactionInProgress);
  }

  function getQueuedTaskCount(rt) {
    return countQueuedTasks(rt);
  }

  function enqueuePendingTask(rt, text) {
    if (!Array.isArray(rt.pendingTasks)) rt.pendingTasks = [];
    if (!Number.isFinite(rt.queuedTaskSeq)) rt.queuedTaskSeq = 1;
    const task = {
      id: rt.queuedTaskSeq,
      text,
      createdAt: nowIso(),
    };
    rt.queuedTaskSeq += 1;
    rt.pendingTasks.push(task);
    return { task, position: rt.pendingTasks.length };
  }

  function shiftPendingTask(rt) {
    if (!Array.isArray(rt?.pendingTasks) || rt.pendingTasks.length === 0) return null;
    const next = rt.pendingTasks.shift() || null;
    if (!rt.pendingTasks.length) rt.queuedTaskSeq = 1;
    return next;
  }

  function clearPendingTasks(rt) {
    const count = getQueuedTaskCount(rt);
    rt.pendingTasks = [];
    rt.queuedTaskSeq = 1;
    return count;
  }

  function startTyping(chatId) {
    const rt = getRuntime(chatId);
    if (rt.typingTimer) return;

    const sendTyping = () => {
      telegram.sendChatAction({ chat_id: chatId, action: "typing" }).catch((err) => {
        console.warn(`sendChatAction failed for ${chatId}:`, err.message);
      });
    };

    sendTyping();
    rt.typingTimer = setInterval(sendTyping, 4000);
  }

  function stopTyping(chatId) {
    const rt = getRuntime(chatId);
    if (!rt.typingTimer) return;
    clearInterval(rt.typingTimer);
    rt.typingTimer = null;
  }

  function getOrCreateSession(chatId) {
    const key = String(chatId);
    const existing = store.data.sessions[key];
    if (existing && typeof existing === "object") {
      const session = normalizeSessionState(existing, defaults);
      ensureSessionTruthProfile(session, { reason: "session", bootstrapPending: false });
      return session;
    }
    const created = normalizeSessionState({
      threadId: null,
      cwd: defaults.cwd,
      model: defaults.model,
      effort: defaults.effort,
      summary: defaults.summary,
      personality: defaults.personality,
      approvalPolicy: defaults.approvalPolicy,
      sandboxMode: defaults.sandboxMode,
      updatedAt: nowIso(),
    }, defaults);
    refreshSessionTruthProfile(created, sourceRegistry, {
      reason: "new-session",
      bootstrapPending: true,
    });
    store.data.sessions[key] = created;
    store.markDirty();
    store.saveThrottled();
    return created;
  }

  function ensureSessionTruthProfile(session, {
    reason = "refresh",
    bootstrapPending = false,
  } = {}) {
    const resolved = resolveSessionTruth(session, sourceRegistry);
    const current = session.truthProfile;
    const needsRefresh = !current
      || current.id !== resolved.profile.id
      || current.projectRoot !== resolved.profile.root
      || current.matchPath !== resolved.matchPath;
    if (!needsRefresh) return resolved;
    refreshSessionTruthProfile(session, sourceRegistry, {
      reason,
      bootstrapPending,
    });
    store.markDirty();
    store.saveThrottled();
    return resolved;
  }

  function setSessionCwdWithTruth(session, cwd, {
    reason = "cwd",
    bootstrapPending = true,
  } = {}) {
    const nextCwd = normalizeAbsolutePath(cwd);
    if (!nextCwd) {
      throw new Error("A valid absolute project/cwd path is required.");
    }
    session.cwd = nextCwd;
    refreshSessionTruthProfile(session, sourceRegistry, {
      reason,
      bootstrapPending,
    });
    session.updatedAt = nowIso();
    store.markDirty();
    store.saveThrottled();
    return resolveSessionTruth(session, sourceRegistry);
  }

  function getTurnInputMeta(rt, turnId) {
    if (!rt || !turnId) return null;
    return rt.turnInputMetaByTurnId?.[turnId] || null;
  }

  function getReplayableAuthRecoveryTask(rt) {
    return getReplayableAuthRecoveryTaskFromRuntime(rt);
  }

  function queueAuthRecoveryReplayTask(rt, task) {
    if (!rt || !task?.text) return false;
    if (rt.authRecoveryReplayTask?.text) return true;
    rt.authRecoveryReplayTask = task;
    return true;
  }

  function shouldHandoffAuthRecoveryToReplay(chatId) {
    if (chatId === null || chatId === undefined) return false;
    const rt = getRuntime(chatId);
    return Boolean(getReplayableAuthRecoveryTask(rt));
  }

  function isSilentTurn(rt, turnId) {
    return Boolean(getTurnInputMeta(rt, turnId)?.silent);
  }

  async function ensureGroupAgentTurnMessage({ chatId, rt, turnId, text }) {
    if (!rt || !turnId) return null;
    if (!rt.groupAgentMessageByTurnId) rt.groupAgentMessageByTurnId = {};
    if (!rt.groupAgentMessagePendingByTurnId) rt.groupAgentMessagePendingByTurnId = {};

    const existingMessageId = rt.groupAgentMessageByTurnId[turnId] || null;
    if (existingMessageId) return existingMessageId;

    if (!rt.groupAgentMessagePendingByTurnId[turnId]) {
      rt.groupAgentMessagePendingByTurnId[turnId] = telegram
        .sendMessage({ chat_id: chatId, text })
        .then((sent) => {
          const messageId = sent?.message_id || null;
          if (messageId) {
            rt.groupAgentMessageByTurnId[turnId] = messageId;
            rememberGroupVisibleText(rt, text);
          }
          return messageId;
        })
        .finally(() => {
          delete rt.groupAgentMessagePendingByTurnId[turnId];
        });
    }

    return rt.groupAgentMessagePendingByTurnId[turnId];
  }

  async function ensureAgentItemMessage({ chatId, rt, itemId, entry, text }) {
    if (!entry) return null;
    if (entry.messageId) return entry.messageId;

    const pendingText = entry.pendingMessageText || text;
    if (!entry.pendingMessagePromise) {
      entry.pendingMessageText = text;
      entry.pendingMessagePromise = telegram
        .sendMessage({ chat_id: chatId, text })
        .then((sent) => {
          const messageId = sent?.message_id || null;
          if (messageId) entry.messageId = messageId;
          return messageId;
        })
        .finally(() => {
          delete entry.pendingMessagePromise;
          delete entry.pendingMessageText;
        });
    }

    const messageId = await entry.pendingMessagePromise;
    if (
      messageId
      && itemId
      && truncateMiddle(entry.renderedBuffer || "", 3900) !== pendingText
    ) {
      scheduleEdit({
        chatId,
        messageId,
        rt,
        itemId,
        getText: () => truncateMiddle(entry.renderedBuffer || "", 3900),
      });
    }
    return messageId;
  }

  function extractFinalTurnAgentText(rt, turnId) {
    if (!rt || !turnId) return "";
    const itemId = rt.lastAgentMessageIdByTurnId?.[turnId];
    if (!itemId) return "";
    const entry = rt.items?.[itemId];
    if (!entry) return "";
    return String(entry.buffer || entry.renderedBuffer || "").trim();
  }

  function chatIdForThread(threadId) {
    for (const [chatId, session] of Object.entries(store.data.sessions)) {
      if (session && session.threadId === threadId) return Number(chatId);
    }
    return null;
  }

  function chatIdForTelemetry(params) {
    const threadId = extractTelemetryThreadId(params);
    if (threadId) return chatIdForThread(threadId);
    const activeChats = [...runtimeByChat.entries()]
      .filter(([, rt]) => rt?.activeTurnId)
      .map(([chatId]) => Number(chatId));
    return activeChats.length === 1 ? activeChats[0] : null;
  }

  async function resetSessionThread(chatId, session, { clearCompactionHistory = true } = {}) {
    session.threadId = null;
    const rt = getRuntime(chatId);
    rt.activeTurnId = null;
    rt.pendingInputMeta = null;
    rt.compactionInProgress = false;
    rt.postCompactionRetryTask = null;
    rt.authRecoveryReplayTask = null;
    clearPendingTasks(rt);
    rt.turnInputMetaByTurnId = {};
    rt.items = {};
    rt.turnDiffByTurnId = {};
    rt.lastAgentMessageIdByTurnId = {};
    rt.groupAgentMessageByTurnId = {};
    rt.groupAgentMessagePendingByTurnId = {};
    rt.lastGroupProgressByBucket = {};
    rt.sentGroupVisibleTexts = new Set();
    stopTyping(chatId);
    clearSessionContextTracking(session, { clearSummary: true, clearHistory: clearCompactionHistory });
    session.updatedAt = nowIso();
    store.markDirty();
    store.saveThrottled();
  }

  function hasActiveTurns() {
    for (const rt of runtimeByChat.values()) {
      if (rt.activeTurnId) return true;
    }
    return false;
  }

  async function waitForCodexBackendRecovery() {
    if (codexBackendRecoveryBypassDepth > 0) return;
    if (!codexBackendRecoveryPromise) return;
    await codexBackendRecoveryPromise.catch(() => {});
    if (!codex) {
      throw new Error("Codex backend is unavailable after the automatic recovery attempt.");
    }
  }

  function setGlobalFailoverState(inProgress) {
    for (const rt of runtimeByChat.values()) {
      rt.failoverInProgress = inProgress;
    }
  }

  function clearInterruptedTurnState(chatId, rt) {
    if (!rt) return;
    for (const pending of rt.editTimers?.values() || []) {
      clearTimeout(pending.timer);
    }
    if (rt.editTimers) rt.editTimers.clear();
    rt.activeTurnId = null;
    rt.pendingInputMeta = null;
    rt.items = {};
    rt.turnDiffByTurnId = {};
    rt.lastAgentMessageIdByTurnId = {};
    rt.groupAgentMessageByTurnId = {};
    rt.groupAgentMessagePendingByTurnId = {};
    rt.lastGroupProgressByBucket = {};
    rt.sentGroupVisibleTexts = new Set();
    stopTyping(chatId);
  }

  function captureInterruptedTurnsForRecovery() {
    const captured = [];
    for (const [chatId, rt] of runtimeByChat.entries()) {
      const replayTask = getReplayableAuthRecoveryTask(rt);
      if (!replayTask && !rt.activeTurnId && !rt.pendingInputMeta) continue;
      if (replayTask) queueAuthRecoveryReplayTask(rt, replayTask);
      captured.push({ chatId, task: rt.authRecoveryReplayTask || replayTask || null });
      clearInterruptedTurnState(chatId, rt);
    }
    return captured;
  }

  function clearAllQueuedAuthRecoveryTasks() {
    for (const rt of runtimeByChat.values()) {
      if (isCompactionTurnKind(rt.authRecoveryReplayTask?.kind)) {
        rt.compactionInProgress = false;
      }
      rt.authRecoveryReplayTask = null;
    }
  }

  async function notifyInterruptedTurns(captured, textBuilder) {
    for (const { chatId, task } of captured) {
      const text = textBuilder(task);
      if (!text) continue;
      await telegram.sendMessage({ chat_id: chatId, text });
    }
  }

  async function replayInterruptedTurnsAfterRecovery() {
    codexBackendRecoveryBypassDepth += 1;
    try {
      for (const [chatId, rt] of runtimeByChat.entries()) {
        const replayTask = rt.authRecoveryReplayTask;
        if (!replayTask) continue;
        rt.authRecoveryReplayTask = null;
        const session = getOrCreateSession(chatId);
        const replayNotice = isCompactionTurnKind(replayTask.kind)
          ? "认证恢复完成，继续刚才被中断的上下文压缩。"
          : "认证恢复完成，正在自动重试刚才被中断的输入。";
        await telegram.sendMessage({ chat_id: chatId, text: replayNotice });
        try {
          await startOrSteerTurn({
            chatId,
            session,
            text: replayTask.text,
            attemptedProfileIds: replayTask.attemptedProfileIds || null,
            kind: replayTask.kind || "user",
            silent: Boolean(replayTask.silent),
            contextRetryCount: Number(replayTask.contextRetryCount || 0),
            authReplayCount: Number(replayTask.authReplayCount || 0),
            skipBackendRecoveryWait: true,
          });
        } catch (err) {
          await telegram.sendMessage({
            chat_id: chatId,
            text: `自动续跑失败：${truncateMiddle(err.message || String(err), 1200)}`,
          });
        }
      }
    } finally {
      codexBackendRecoveryBypassDepth = Math.max(0, codexBackendRecoveryBypassDepth - 1);
    }
  }

  async function recoverCodexBackendFromAuthFailure(event) {
    const reason = event?.reason || "Codex backend auth failure";
    reloadAccountProfiles({ reason: "auth_failure", silent: true });
    const currentProfile = findAccountProfile(store.data.bridge?.currentAccountProfileId)
      || getCurrentAccountProfile();
    if (currentProfile) {
      markProfileForRecoveryError(currentProfile, { message: reason });
    }
    markCodexBackendRecovering(reason);
    const captured = captureInterruptedTurnsForRecovery();
    const attempted = new Set(currentProfile?.profileId ? [currentProfile.profileId] : []);
    const fallbackProfiles = autoAccountFailover && accountProfiles.length >= 2
      ? listFallbackProfiles(currentProfile?.profileId, attempted)
      : [];
    const shouldRetryCurrent = currentProfile
      && !isAccountProfileExpiredForSelection(currentProfile)
      && (!isAccountAuthFailureText(reason) || fallbackProfiles.length === 0);

    if (shouldRetryCurrent) {
      try {
        await switchAccountProfile(currentProfile, {
          allowActiveTurns: true,
          revertOnFailure: false,
        });
        recordCodexBackendHealthy({ recoveredProfileId: currentProfile.profileId });
        await replayInterruptedTurnsAfterRecovery();
        return true;
      } catch (err) {
        recordCodexBackendFailure(extractCodexErrorText(err), {
          auth: isAccountAuthFailure(err),
          state: "recovering",
        });
      }
    }

    if (!autoAccountFailover || accountProfiles.length < 2) {
      markCodexBackendRecoveryFailed("Auth watchdog fired, but no spare Codex account is configured.");
      clearAllQueuedAuthRecoveryTasks();
      await notifyInterruptedTurns(
        captured,
        () => "当前 Codex 账号认证已失效，但没有可切换的备用账号；刚才中断的输入没有自动续跑。",
      );
      return false;
    }

    if (!fallbackProfiles.length) {
      markCodexBackendRecoveryFailed("Auth watchdog fired, but every spare account is expired or temporarily blocked.");
      clearAllQueuedAuthRecoveryTasks();
      await notifyInterruptedTurns(
        captured,
        () => "当前 Codex 账号认证已失效，且暂时没有可用的备用账号；刚才中断的输入没有自动续跑。",
      );
      return false;
    }

    if (captured.some(({ task }) => task?.text)) {
      await notifyInterruptedTurns(
        captured,
        (task) => (task?.text
          ? "检测到当前 Codex 账号后台认证已失效，正在自动切到下一号，并在恢复后把刚才中断的输入续跑一次。"
          : null),
      );
    }

    setGlobalFailoverState(true);
    try {
      for (const nextProfile of fallbackProfiles) {
        try {
          await switchAccountProfile(nextProfile, {
            allowActiveTurns: true,
            revertOnFailure: false,
          });
          recordCodexBackendHealthy({ recoveredProfileId: nextProfile.profileId });
          await replayInterruptedTurnsAfterRecovery();
          return true;
        } catch (err) {
          recordCodexBackendFailure(extractCodexErrorText(err), {
            auth: isAccountAuthFailure(err),
            state: "recovering",
          });
        }
      }
    } finally {
      setGlobalFailoverState(false);
    }

    markCodexBackendRecoveryFailed("Every spare Codex account failed its recovery health check.");
    clearAllQueuedAuthRecoveryTasks();
    await notifyInterruptedTurns(
      captured,
      () => "当前 Codex 账号认证已失效，备用账号也没能通过恢复健康检查；刚才中断的输入没有自动续跑。",
    );
    return false;
  }

  function queueCodexBackendRecovery(event) {
    const reason = event?.reason || "Codex backend auth failure";
    recordCodexBackendFailure(reason, {
      auth: true,
      code: event?.code ?? null,
      signal: event?.signal ?? null,
      state: codexBackendRecoveryPromise ? "recovering" : "unhealthy",
    });
    if (codexBackendTransitionDepth > 0) return codexBackendRecoveryPromise;
    if (codexBackendRecoveryPromise) return codexBackendRecoveryPromise;
    codexBackendRecoveryPromise = recoverCodexBackendFromAuthFailure(event)
      .catch((err) => {
        markCodexBackendRecoveryFailed(err.message || String(err));
        console.error("Codex backend auth recovery failed:", err);
        return false;
      })
      .finally(() => {
        codexBackendRecoveryPromise = null;
      });
    return codexBackendRecoveryPromise;
  }

  async function ensureCodexBackendRecovered(event) {
    const promise = queueCodexBackendRecovery(event);
    if (!promise) {
      await waitForCodexBackendRecovery();
      return Boolean(codex);
    }
    const recovered = await promise.catch(() => false);
    return Boolean(recovered && codex);
  }

  async function switchAccountProfile(profile, {
    allowActiveTurns = false,
    revertOnFailure = true,
  } = {}) {
    if (!profile) throw new Error("Unknown account profile");
    if (!allowActiveTurns && hasActiveTurns()) {
      throw new Error("A turn is still running. Wait for it to finish or use /stop first.");
    }

    reloadAccountProfiles({ reason: "switchAccountProfile", silent: true });
    const resolvedProfile = profile?.profileId ? findAccountProfile(profile.profileId) : null;
    const effectiveProfile = resolvedProfile || profile;
    if (isAccountProfileExpiredForSelection(effectiveProfile)) {
      throw new Error(`Codex account ${effectiveProfile.profileId || "unknown"} has an expired access token. Run /authsync or sign in again before selecting it.`);
    }

    stopTypingForAllChats();
    const previousProfile = getCurrentAccountProfile();
    const previousAuth = readCodexAuth(runtimeAuthPath);
    codexBackendTransitionDepth += 1;
    try {
      writeAuthForProfile(effectiveProfile);
      if (codex) codex.stop({ expected: true });
      await startCodexServer();
      await verifySwitchedAccount(effectiveProfile);
      reconcileRuntimeAccountBinding({ expectedProfile: effectiveProfile, strict: true });
      store.data.bridge.currentAccountProfileId = effectiveProfile.profileId;
      markAccountProfileHealthy(effectiveProfile);
      recordCodexBackendHealthy();
      store.markDirty();
      store.save();
      return effectiveProfile;
    } catch (err) {
      const authFailure = isAccountAuthFailure(err);
      if (authFailure) {
        markAccountProfileUnhealthy(effectiveProfile, extractCodexErrorText(err));
      }
      recordCodexBackendFailure(extractCodexErrorText(err), {
        auth: authFailure,
        state: revertOnFailure ? "recovering" : "unhealthy",
      });
      if (revertOnFailure && previousAuth) {
        fs.writeFileSync(runtimeAuthPath, JSON.stringify(previousAuth, null, 2));
        if (codex) codex.stop({ expected: true });
        try {
          await startCodexServer();
          recordCodexBackendHealthy();
        } catch (restoreErr) {
          codex = null;
          recordCodexBackendFailure(restoreErr.message || String(restoreErr), {
            auth: isAccountAuthFailure(restoreErr),
          });
        }
        if (previousProfile?.profileId) {
          store.data.bridge.currentAccountProfileId = previousProfile.profileId;
        }
      } else {
        if (codex) codex.stop({ expected: true });
        codex = null;
      }
      store.markDirty();
      store.saveThrottled();
      throw err;
    } finally {
      codexBackendTransitionDepth = Math.max(0, codexBackendTransitionDepth - 1);
    }
  }

  function stopTypingForAllChats() {
    for (const chatId of runtimeByChat.keys()) {
      stopTyping(chatId);
    }
  }

  function buildMenuPayload(session, rt) {
    const page = getMenuPage(rt);
    const meta = { ...buildAccountMeta(), autoCompact };
    return {
      text: buildMenuText(session, rt, page, meta),
      reply_markup: buildMenuKeyboard(page, meta),
    };
  }

  async function renderMenuMessage(chatId, messageId) {
    const session = getOrCreateSession(chatId);
    const rt = getRuntime(chatId);
    await telegram.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      ...buildMenuPayload(session, rt),
    });
  }

  async function sendMenu(chatId, page = MENU_PAGES.MAIN) {
    const session = getOrCreateSession(chatId);
    const rt = getRuntime(chatId);
    rt.menuPage = VALID_MENU_PAGES.has(page) ? page : MENU_PAGES.MAIN;
    await telegram.sendMessage({
      chat_id: chatId,
      ...buildMenuPayload(session, rt),
    });
  }

  async function startFreshThread(session, chatId, {
    announceText = (threadId) => `Started new thread: ${threadId}`,
    useFailover = true,
  } = {}) {
    const run = async () => {
        const started = await codex.request("thread/start", {
          cwd: session.cwd,
          model: session.model,
          personality: session.personality,
          approvalPolicy: session.approvalPolicy,
          sandbox: session.sandboxMode,
        });
        const threadId = started?.thread?.id || started?.threadId || started?.thread?.threadId;
        if (!threadId) throw new Error("thread/start did not return a thread id");
        session.threadId = threadId;
        clearSessionContextTracking(session, { clearSummary: false, clearHistory: false });
        const rt = getRuntime(chatId);
        rt.activeTurnId = null;
        rt.pendingInputMeta = null;
        rt.turnInputMetaByTurnId = {};
        rt.items = {};
        rt.turnDiffByTurnId = {};
        rt.lastAgentMessageIdByTurnId = {};
        rt.groupAgentMessageByTurnId = {};
        rt.groupAgentMessagePendingByTurnId = {};
        rt.lastGroupProgressByBucket = {};
        rt.sentGroupVisibleTexts = new Set();
        session.updatedAt = nowIso();
        store.markDirty();
        store.saveThrottled();

        if (announceText) {
          await telegram.sendMessage({
            chat_id: chatId,
            text: announceText(threadId),
            disable_web_page_preview: true,
          });
        }

        return threadId;
      };
    if (!useFailover) return run();
    return requestWithAccountFailover({
      chatId,
      failureLabel: "thread setup",
      run,
    });
  }

  const initialAccountProfile = resolveInitialAccountProfile();
  if (initialAccountProfile) {
    writeAuthForProfile(initialAccountProfile);
    if (store.data.bridge.currentAccountProfileId !== initialAccountProfile.profileId) {
      store.data.bridge.currentAccountProfileId = initialAccountProfile.profileId;
      store.markDirty();
      store.saveThrottled();
    }
  }

  await startCodexServer();
  await ensureHealthyStartupAccount();

  async function notifyUnauthorizedChat(chatId) {
    if (unauthorizedNotified.has(chatId)) return;
    unauthorizedNotified.add(chatId);
    console.warn(`Rejected unauthorized chat: ${chatId}`);
    await telegram.sendMessage({
      chat_id: chatId,
      text: [
        "This chat is not in TELEGRAM_ALLOWLIST.",
        `Your chat_id is: ${chatId}`,
        "Add it to .env, then restart the bridge.",
      ].join("\n"),
    }).catch((err) => {
      console.warn(`Failed to notify unauthorized chat ${chatId}:`, err.message);
    });
  }

  async function ensureThread(session, chatId) {
    if (session.threadId) {
      return requestWithAccountFailover({
        chatId,
        failureLabel: "thread setup",
        run: async () => {
          try {
            await codex.request("thread/resume", {
              threadId: session.threadId,
              cwd: session.cwd,
              model: session.model,
              personality: session.personality,
              approvalPolicy: session.approvalPolicy,
              sandbox: session.sandboxMode,
            });
            return session.threadId;
          } catch (err) {
            if (isAccountFailoverError(err)) throw err;
            if (isLikelyContextRequestError(err, session)) {
              throw err;
            }
            console.warn("thread/resume failed, starting new thread:", err.message);
            session.threadId = null;
          }
          return startFreshThread(session, chatId, { useFailover: false });
        },
      });
    }
    return startFreshThread(session, chatId);
  }

  async function maybeStartQueuedTask({ chatId, session }) {
    const rt = getRuntime(chatId);
    if (isChatBusy(rt)) return false;
    const nextTask = shiftPendingTask(rt);
    if (!nextTask) return false;

    const remaining = getQueuedTaskCount(rt);
    const suffix = remaining > 0 ? `，后面还剩 ${remaining} 条` : "";
    await telegram.sendMessage({
      chat_id: chatId,
      text: `开始处理排队中的下一条任务${suffix}。`,
    });
    await startOrSteerTurn({ chatId, session, text: nextTask.text });
    return true;
  }

  async function startOrSteerTurn({
    chatId,
    session,
    text,
    attemptedProfileIds = null,
    kind = "user",
    silent = false,
    contextRetryCount = 0,
    authReplayCount = 0,
    skipBackendRecoveryWait = false,
  }) {
    if (!skipBackendRecoveryWait) {
      await waitForCodexBackendRecovery();
    }
    const rt = getRuntime(chatId);
    const currentProfile = getCurrentAccountProfile();
    rt.pendingInputMeta = {
      text,
      attemptedProfileIds: uniqueStrings([
        ...(attemptedProfileIds || []),
        currentProfile?.profileId || null,
      ]),
      kind,
      silent,
      contextRetryCount,
      authReplayCount,
    };

    try {
      if (rt.compactionInProgress && !isCompactionTurnKind(kind)) {
        rt.pendingInputMeta = null;
        await telegram.sendMessage({
          chat_id: chatId,
          text: "正在压缩上下文，请稍后再发这条消息。",
        });
        return;
      }

      const autoReason = kind === "user" ? shouldAutoCompact(session, rt) : null;
      if (kind === "user" && autoReason === "emergency" && rt.activeTurnId) {
        rt.pendingInputMeta = null;
        await telegram.sendMessage({
          chat_id: chatId,
          text: isGroupChat(chatId)
            ? "上下文已接近窗口上限，本轮结束后会先自动压缩，暂不接收新任务。"
            : "当前上下文已接近窗口上限，本轮结束后会优先自动压缩，请稍后再发消息。",
        });
        return;
      }

      if (kind === "user" && autoReason && !rt.activeTurnId) {
        rt.pendingInputMeta = null;
        const started = await startCompaction({
          chatId,
          session,
          mode: "auto",
          reason: autoReason,
          allowQueuedTasks: true,
        });
        if (!started) {
          await telegram.sendMessage({
            chat_id: chatId,
            text: "自动压缩没有成功启动，请稍后重试 /compact 或直接再发一次消息。",
          });
        }
        return;
      }

      if (isGroupChat(chatId) && isChatBusy(rt) && !isCompactionTurnKind(kind)) {
        const { position } = enqueuePendingTask(rt, text);
        rt.pendingInputMeta = null;
        await telegram.sendMessage({
          chat_id: chatId,
          text: position === 1
            ? "当前任务还在进行中，新任务已进入队列（第 1 条待处理）。如果你想改方向，请先发 /stop，再发新任务。"
            : `当前任务还在进行中，新任务已进入队列（第 ${position} 条待处理）。如果你想改方向，请先发 /stop，再发新任务。`,
        });
        return;
      }

      const threadId = await ensureThread(session, chatId);
      if (threadId === AUTH_RECOVERY_HANDOFF) {
        return;
      }
      startTyping(chatId);

      if (rt.activeTurnId) {
        rt.turnInputMetaByTurnId[rt.activeTurnId] = { ...rt.pendingInputMeta };
        rt.pendingInputMeta = null;

        const steerResult = await requestWithAccountFailover({
          chatId,
          failureLabel: "turn steer",
          run: async () => codex.request("turn/steer", {
            threadId,
            expectedTurnId: rt.activeTurnId,
            input: [{ type: "text", text }],
          }),
        });
        if (steerResult === AUTH_RECOVERY_HANDOFF) {
          return;
        }
        await telegram.sendMessage({ chat_id: chatId, text: "Steering active turn…" });
        return;
      }

      let inputText = text;
      let appliedTruthBootstrap = false;
      const truthResolved = kind === "user"
        ? ensureSessionTruthProfile(session, {
            reason: "turn-start",
            bootstrapPending: true,
          })
        : null;
      let appliedSummaryBootstrap = false;
      if (kind === "user" && session.pendingSummaryBootstrap?.text) {
        inputText = buildCompactionBootstrapText(session.pendingSummaryBootstrap, text);
        appliedSummaryBootstrap = true;
      }
      if (kind === "user" && session.truthProfile?.bootstrapPending && truthResolved?.profile) {
        inputText = buildTruthBootstrapText(truthResolved, inputText);
        appliedTruthBootstrap = true;
      }

      rt.items = {};
      rt.turnDiffByTurnId = {};
      session.updatedAt = nowIso();
      store.markDirty();
      store.saveThrottled();

      const startResult = await requestWithAccountFailover({
        chatId,
        failureLabel: "turn start",
        run: async () => {
          const result = await codex.request("turn/start", {
            threadId,
            input: [{ type: "text", text: inputText }],
            cwd: session.cwd,
            model: session.model,
            effort: session.effort,
            summary: session.summary,
            personality: session.personality,
            approvalPolicy: session.approvalPolicy,
            sandboxPolicy:
              session.sandboxMode === "danger-full-access"
                ? { type: "dangerFullAccess" }
                : session.sandboxMode === "read-only"
                  ? { type: "readOnly" }
                  : { type: "workspaceWrite" },
          });
          if (appliedSummaryBootstrap) {
            session.pendingSummaryBootstrap = null;
            session.updatedAt = nowIso();
            store.markDirty();
            store.saveThrottled();
          }
          if (appliedTruthBootstrap && session.truthProfile) {
            session.truthProfile.bootstrapPending = false;
            session.truthProfile.lastBootstrapAt = nowIso();
            session.updatedAt = nowIso();
            store.markDirty();
            store.saveThrottled();
          }
          return result;
        },
      });
      if (startResult === AUTH_RECOVERY_HANDOFF) {
        return;
      }
    } catch (err) {
      const pendingMeta = rt.pendingInputMeta?.text === text ? rt.pendingInputMeta : null;
      if (
        kind === "user"
        && !rt.activeTurnId
        && isLikelyContextRequestError(err, session)
        && Number(pendingMeta?.contextRetryCount || contextRetryCount || 0) < 1
      ) {
        rt.pendingInputMeta = null;
        const handled = await retryAfterContextCompaction({
          chatId,
          session,
          rt,
          text,
          attemptedProfileIds: pendingMeta?.attemptedProfileIds || attemptedProfileIds || [],
          contextRetryCount: Number(pendingMeta?.contextRetryCount || contextRetryCount || 0),
          source: "request_failure",
          detail: extractCodexErrorText(err),
        });
        if (handled) return;
      }
      if (pendingMeta) {
        rt.pendingInputMeta = null;
      }
      throw err;
    }
  }

  async function interruptTurn({ chatId, session }) {
    const rt = getRuntime(chatId);
    const clearedCount = clearPendingTasks(rt);
    if (rt.compactionInProgress && !rt.activeTurnId) {
      rt.compactionInProgress = false;
      rt.postCompactionRetryTask = null;
      const text = clearedCount
        ? `Compaction was pending. Cleared ${clearedCount} queued task(s).`
        : "Compaction was pending and is now cancelled.";
      await telegram.sendMessage({ chat_id: chatId, text });
      return;
    }
    if (!session.threadId || !rt.activeTurnId) {
      const text = clearedCount
        ? `No active turn. Cleared ${clearedCount} queued task(s).`
        : "No active turn.";
      await telegram.sendMessage({ chat_id: chatId, text });
      return;
    }
    await requestWithAccountFailover({
      chatId,
      failureLabel: "turn interrupt",
      allowAuthReplayHandoff: false,
      run: async () => codex.request("turn/interrupt", {
        threadId: session.threadId,
        turnId: rt.activeTurnId,
      }),
    });
    const text = clearedCount
      ? `Interrupt requested. Cleared ${clearedCount} queued task(s).`
      : "Interrupt requested.";
    await telegram.sendMessage({ chat_id: chatId, text });
  }

  function scheduleEdit({ chatId, messageId, getText, rt, itemId }) {
    const key = `${chatId}:${messageId}`;
    const existing = rt.editTimers.get(key);
    if (existing) {
      existing.getText = getText;
      existing.itemId = itemId;
      return;
    }
    const timer = setTimeout(async () => {
      const pending = rt.editTimers.get(key);
      rt.editTimers.delete(key);
      if (!pending) return;
      const text = pending.getText();
      try {
        await telegram.editMessageText({ chat_id: chatId, message_id: messageId, text });
      } catch (err) {
        // Ignore "message is not modified" and transient rate limits.
        const desc = err && err.message ? err.message : String(err);
        if (!desc.includes("message is not modified")) {
          console.warn(`editMessageText failed (item=${pending.itemId}):`, desc);
        }
      }
    }, 800);
    rt.editTimers.set(key, { timer, getText, itemId });
  }

  function cancelPendingEdit({ chatId, messageId, rt }) {
    const key = `${chatId}:${messageId}`;
    const pending = rt.editTimers.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    rt.editTimers.delete(key);
  }

  async function upsertAgentMessage({ chatId, item, rt }) {
    const existing = item?.id ? rt.items?.[item.id] : null;
    const buffer = typeof item?.text === "string" ? item.text : existing?.buffer || "";
    const groupChat = isGroupChat(chatId);
    const renderedBuffer = groupChat ? sanitizeGroupAgentText(buffer) : buffer;
    const turnId = resolveAgentMessageTurnId({
      explicitTurnId: item?.turnId,
      existingTurnId: existing?.turnId,
      rt,
    });
    const silent = Boolean(existing?.silent || item?.silent);
    if (turnId && item?.id) {
      rt.lastAgentMessageIdByTurnId[turnId] = item.id;
    }

    if (!renderedBuffer.trim()) {
      if (item?.id && !existing) {
        rt.items[item.id] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId, silent };
      }
      return;
    }

    if (silent) {
      if (item?.id) {
        rt.items[item.id] = {
          ...(existing || {}),
          kind: "agentMessage",
          messageId: existing?.messageId || null,
          buffer,
          renderedBuffer,
          turnId,
          silent: true,
        };
      }
      return;
    }

    const text = truncateMiddle(renderedBuffer, 3900);

    if (groupChat && turnId) {
      let entry = existing;
      if (!entry && item?.id) {
        entry = {
          kind: "agentMessage",
          messageId: null,
          buffer,
          renderedBuffer,
          turnId,
        };
        rt.items[item.id] = entry;
      }
      if (!entry) return;

      entry.buffer = buffer;
      entry.renderedBuffer = renderedBuffer;
      entry.turnId = turnId;

      const sharedMessageId = rt.groupAgentMessageByTurnId?.[turnId] || entry.messageId || null;
      if (sharedMessageId) {
        entry.messageId = sharedMessageId;
        rt.groupAgentMessageByTurnId[turnId] = sharedMessageId;
        scheduleEdit({
          chatId,
          messageId: sharedMessageId,
          rt,
          itemId: item.id,
          getText: () => truncateMiddle(entry.renderedBuffer || "", 3900),
        });
      } else {
        const ensuredMessageId = await ensureGroupAgentTurnMessage({ chatId, rt, turnId, text });
        entry.messageId = ensuredMessageId;
        if (ensuredMessageId) {
          rt.groupAgentMessageByTurnId[turnId] = ensuredMessageId;
          scheduleEdit({
            chatId,
            messageId: ensuredMessageId,
            rt,
            itemId: item.id,
            getText: () => truncateMiddle(entry.renderedBuffer || "", 3900),
          });
        }
      }
      rt.lastGroupProgressByBucket.agentMessage = text;
      return;
    }

    if (!existing) {
      if (groupChat && shouldSuppressDuplicateGroupProgress(rt, text, "agentMessage")) {
        if (item?.id) {
          rt.items[item.id] = {
            kind: "agentMessage",
            messageId: null,
            buffer,
            renderedBuffer,
            suppressedDuplicate: true,
          };
        }
        return;
      }
      if (groupChat && hasSeenGroupVisibleText(rt, text)) {
        if (item?.id) {
          rt.items[item.id] = {
            kind: "agentMessage",
            messageId: null,
            buffer,
            renderedBuffer,
            suppressedDuplicate: true,
          };
        }
        return;
      }
      const sent = await telegram.sendMessage({ chat_id: chatId, text });
      if (groupChat) rememberGroupVisibleText(rt, text);
      if (item?.id) {
        rt.items[item.id] = { kind: "agentMessage", messageId: sent.message_id, buffer, renderedBuffer };
      }
      return;
    }

    existing.buffer = buffer;
    existing.renderedBuffer = renderedBuffer;
    if (!existing.messageId) {
      if (groupChat && shouldSuppressDuplicateGroupProgress(rt, text, "agentMessage")) {
        existing.suppressedDuplicate = true;
        return;
      }
      if (groupChat && hasSeenGroupVisibleText(rt, text)) {
        existing.suppressedDuplicate = true;
        return;
      }
      const ensuredMessageId = await ensureAgentItemMessage({
        chatId,
        rt,
        itemId: item?.id || null,
        entry: existing,
        text,
      });
      existing.messageId = ensuredMessageId;
      existing.suppressedDuplicate = false;
      if (groupChat && ensuredMessageId) rememberGroupVisibleText(rt, text);
      return;
    }
    scheduleEdit({
      chatId,
      messageId: existing.messageId,
      rt,
      itemId: item.id,
      getText: () => truncateMiddle(existing.renderedBuffer || "", 3900),
    });
    if (groupChat) rememberGroupVisibleText(rt, text);
    if (groupChat) {
      rt.lastGroupProgressByBucket.agentMessage = text;
    }
  }

  async function flushBufferedAgentMessages(chatId, rt) {
    const pending = Object.entries(rt.items || {}).filter(([, entry]) => (
      entry &&
      entry.kind === "agentMessage" &&
      !entry.silent &&
      entry.buffer &&
      entry.buffer.trim()
    ));

    for (const [itemId, entry] of pending) {
      await upsertAgentMessage({
        chatId,
        item: { id: itemId, text: entry.buffer },
        rt,
      });
    }
  }

  async function revealFinalGroupAgentMessage(chatId, rt, turnId) {
    if (!isGroupChat(chatId) || !turnId) return;
    const itemId = rt.lastAgentMessageIdByTurnId?.[turnId];
    if (!itemId) return;
    const entry = rt.items?.[itemId];
    if (!entry || entry.kind !== "agentMessage") return;
    if (entry.silent) return;

    const rawText = truncateMiddle(entry.buffer || "", 3900);
    if (!rawText.trim()) return;

    if (entry.messageId) {
      cancelPendingEdit({ chatId, messageId: entry.messageId, rt });
      try {
        await telegram.editMessageText({ chat_id: chatId, message_id: entry.messageId, text: rawText });
      } catch (err) {
        const desc = err && err.message ? err.message : String(err);
        if (!desc.includes("message is not modified")) {
          console.warn(`revealFinalGroupAgentMessage edit failed (item=${itemId}):`, desc);
        }
      }
      entry.renderedBuffer = entry.buffer || rawText;
      rememberGroupVisibleText(rt, rawText);
      return;
    }

    if (hasSeenGroupVisibleText(rt, rawText)) return;

    const sent = await telegram.sendMessage({ chat_id: chatId, text: rawText });
    entry.messageId = sent.message_id;
    entry.renderedBuffer = entry.buffer || rawText;
    rememberGroupVisibleText(rt, rawText);
  }

  function waitForTelegramAction({ kind, chatId, timeoutMs = 10 * 60 * 1000 }) {
    const token = makeToken();
    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const timeout = setTimeout(() => {
      pendingActions.delete(token);
      resolvePromise(null);
    }, timeoutMs);
    if (timeout.unref) timeout.unref();

    pendingActions.set(token, {
      kind,
      chatId,
      resolve: (value) => {
        clearTimeout(timeout);
        pendingActions.delete(token);
        resolvePromise(value);
      },
    });

    return { token, promise };
  }

  async function handleMessage({ chatId, text, message }) {
    if (allowlist && !allowlist.has(chatId)) {
      await notifyUnauthorizedChat(chatId);
      return;
    }

    if (!shouldHandleTelegramMessage(message, botIdentity)) {
      return;
    }

    const session = getOrCreateSession(chatId);
    const normalizedText = message?.chat?.type === "private"
      ? text
      : normalizeIncomingText(text, botIdentity.username);
    const trimmed = (normalizedText || "").trim();
    if (!trimmed) return;

    if (trimmed === "/start" || trimmed === "/help") {
      await telegram.sendMessage({ chat_id: chatId, text: buildHelpText() });
      return;
    }

    if (trimmed === "/new") {
      await resetSessionThread(chatId, session);
      await ensureThread(session, chatId);
      return;
    }

    if (trimmed.startsWith("/cwd ")) {
      const resolved = setSessionCwdWithTruth(session, trimmed.slice("/cwd ".length).trim(), {
        reason: "/cwd",
        bootstrapPending: true,
      });
      await telegram.sendMessage({
        chat_id: chatId,
        text: [
          `cwd set to: ${session.cwd}`,
          `truth profile: ${resolved.profile.name} (${resolved.profile.id})`,
          "Next user turn will include a source-of-truth bootstrap.",
        ].join("\n"),
      });
      return;
    }

    if (trimmed.startsWith("/project ")) {
      const resolved = setSessionCwdWithTruth(session, trimmed.slice("/project ".length).trim(), {
        reason: "/project",
        bootstrapPending: true,
      });
      await resetSessionThread(chatId, session);
      session.truthProfile.bootstrapPending = true;
      store.markDirty();
      store.saveThrottled();
      await telegram.sendMessage({
        chat_id: chatId,
        text: [
          `project switched to: ${session.cwd}`,
          `truth profile: ${resolved.profile.name} (${resolved.profile.id})`,
          "Started with a fresh thread next time you message.",
        ].join("\n"),
      });
      return;
    }

    if (trimmed === "/model") {
      await telegram.sendMessage({
        chat_id: chatId,
        text: [`current model: ${session.model}`, "", buildModelsText()].join("\n"),
      });
      return;
    }

    if (trimmed.startsWith("/model ")) {
      const parsed = parseModelCommandArgs(trimmed.slice("/model ".length));
      if (parsed.error || !parsed.model) {
        await telegram.sendMessage({
          chat_id: chatId,
          text: parsed.error || "Usage: /model <5.2|5.4|5.5|model-id> [effort]",
        });
        return;
      }
      session.model = parsed.model;
      if (parsed.effort) session.effort = parsed.effort;
      session.updatedAt = nowIso();
      store.markDirty();
      store.saveThrottled();
      const effortLine = parsed.effort ? `\neffort set to: ${session.effort}` : "";
      await telegram.sendMessage({ chat_id: chatId, text: `model set to: ${session.model}${effortLine}` });
      return;
    }

    if (trimmed === "/effort" || trimmed === "/think" || trimmed === "/thinking") {
      await telegram.sendMessage({
        chat_id: chatId,
        text: [`current effort: ${session.effort}`, "", buildEffortsText()].join("\n"),
      });
      return;
    }

    const effortCommand = ["/effort ", "/think ", "/thinking "].find((prefix) => trimmed.startsWith(prefix));
    if (effortCommand) {
      const nextEffort = normalizeEffortLevel(trimmed.slice(effortCommand.length));
      if (!nextEffort) {
        await telegram.sendMessage({
          chat_id: chatId,
          text: `Invalid effort. Use one of: ${EFFORT_LEVELS.join(", ")}`,
        });
        return;
      }
      session.effort = nextEffort;
      session.updatedAt = nowIso();
      store.markDirty();
      store.saveThrottled();
      await telegram.sendMessage({ chat_id: chatId, text: `effort set to: ${session.effort}` });
      return;
    }

    if (trimmed === "/models") {
      await telegram.sendMessage({ chat_id: chatId, text: buildModelsText() });
      return;
    }

    if (trimmed === "/efforts") {
      await telegram.sendMessage({ chat_id: chatId, text: buildEffortsText() });
      return;
    }

    if (trimmed === "/accounts") {
      const meta = buildAccountMeta();
      await telegram.sendMessage({
        chat_id: chatId,
        text: buildAccountsText(meta.accountProfiles, meta.currentAccountProfileId),
      });
      return;
    }

    if (trimmed.startsWith("/account ")) {
      const selector = trimmed.slice("/account ".length).trim();
      const profile = findAccountProfile(selector);
      if (!profile) {
        await telegram.sendMessage({
          chat_id: chatId,
          text: "Unknown account. Use /accounts to see available options.",
        });
        return;
      }
      const switched = await switchAccountProfile(profile);
      await telegram.sendMessage({
        chat_id: chatId,
        text: `account switched to: ${switched.label}`,
      });
      return;
    }

    if (trimmed === "/menu") {
      await sendMenu(chatId);
      return;
    }

    if (trimmed === "/compact") {
      await startManualCompaction({ chatId, session });
      return;
    }

    if (trimmed === "/truth") {
      ensureSessionTruthProfile(session, { reason: "/truth", bootstrapPending: false });
      await telegram.sendMessage({
        chat_id: chatId,
        text: truncateMiddle(formatTruthProfileText(session, sourceRegistry), 3900),
      });
      return;
    }

    if (trimmed === "/refresh") {
      reloadSourceRegistry({ reason: "/refresh" });
      refreshSessionTruthProfile(session, sourceRegistry, {
        reason: "/refresh",
        bootstrapPending: true,
      });
      session.updatedAt = nowIso();
      store.markDirty();
      store.saveThrottled();
      await telegram.sendMessage({
        chat_id: chatId,
        text: [
          "Source truth profile refreshed.",
          `profile: ${session.truthProfile?.name || "(unknown)"} (${session.truthProfile?.id || "unknown"})`,
          `projectRoot: ${session.truthProfile?.projectRoot || "(unknown)"}`,
          "Next user turn will include a source-of-truth bootstrap.",
        ].join("\n"),
      });
      return;
    }

    if (trimmed === "/authsync") {
      reloadAccountProfiles({ reason: "/authsync" });
      const profile = getCurrentAccountProfile();
      if (!profile) {
        await telegram.sendMessage({
          chat_id: chatId,
          text: "No Codex account profile is available. Check CODEX_ACCOUNTS_SOURCE, or run `codex login` to seed CODEX_HOME/auth.json.",
        });
        return;
      }
      await telegram.sendMessage({
        chat_id: chatId,
        text: `Resyncing Codex auth for: ${profile.shortLabel}…`,
      });
      try {
        await switchAccountProfile(profile);
        await telegram.sendMessage({
          chat_id: chatId,
          text: "Codex auth resynced and backend restarted.",
        });
      } catch (err) {
        await telegram.sendMessage({
          chat_id: chatId,
          text: `Auth resync failed: ${truncateMiddle(err.message || String(err), 1200)}`,
        });
      }
      return;
    }

    if (trimmed === "/status") {
      const rt = getRuntime(chatId);
      const meta = buildAccountMeta();
      const backendHealth = ensureCodexBackendHealthState();
      await telegram.sendMessage({
        chat_id: chatId,
        text: [
          `threadId: ${session.threadId || "(none)"}`,
          `activeTurnId: ${rt.activeTurnId || "(none)"}`,
          `queuedTasks: ${getQueuedTaskCount(rt)}`,
          `contextUsage: ${formatContextUsageLine(session)}`,
          `contextTokens: ${session.contextTokens || "(unknown)"}`,
          `contextWindow: ${session.contextWindow || "(unknown)"}`,
          `lastTurnTokens: ${session.lastTurnTokens || "(unknown)"}`,
          `compactionPending: ${session.compactionPending ? `yes${session.compactionPendingReason ? ` (${session.compactionPendingReason})` : ""}` : "no"}`,
          `compactionInProgress: ${rt.compactionInProgress ? "yes" : "no"}`,
          `lastCompactionAt: ${session.lastCompactionAt || "(never)"}`,
          `compactionGeneration: ${session.compactionGeneration || 0}`,
          `cwd: ${session.cwd}`,
          `truthProfile: ${session.truthProfile?.name || "(unbound)"} (${session.truthProfile?.id || "none"})`,
          `truthRoot: ${session.truthProfile?.projectRoot || "(unknown)"}`,
          `truthRefreshedAt: ${session.truthProfile?.lastRefreshedAt || "(never)"}`,
          `truthBootstrapPending: ${session.truthProfile?.bootstrapPending ? "yes" : "no"}`,
          `model: ${session.model}`,
          `effort: ${session.effort}`,
          `account: ${meta.currentAccountLabel || "(default)"}`,
          `accountFailover: ${meta.autoAccountFailover ? "on" : "off"}`,
          `runtimeAccountProfileId: ${meta.runtimeAccountProfileId || "(unknown)"}`,
          `runtimeAccountEmail: ${meta.runtimeAccountEmail || "(unknown)"}`,
          `runtimeAccountId: ${meta.runtimeAccountId || "(unknown)"}`,
          `backendRecoveryState: ${backendHealth.state || "starting"}`,
          `lastBackendAuthError: ${backendHealth.lastAuthFailure || "(none)"}`,
          `lastRecoveryAttemptAt: ${formatTimestamp(backendHealth.lastRecoveryStartedAt)}`,
          `lastRecoveryResult: ${backendHealth.lastRecoveryResult || "(none)"}`,
          `replayQueued: ${rt.authRecoveryReplayTask?.text ? "yes" : "no"}`,
          `autoCompact: ${autoCompact ? "on" : "off"} (soft ${formatPercent(contextThresholds.soft)}, hard ${formatPercent(contextThresholds.hard)}, emergency ${formatPercent(contextThresholds.emergency)})`,
          `telegramPolling: ${buildPollingStatusLine()}`,
          `codexBackend: ${buildCodexBackendStatusLine()}`,
          `telegramTransport: ${telegram.transportLabel}`,
          `accountSource: ${meta.accountSourcePath || "(none)"}`,
          `sandbox: ${session.sandboxMode}`,
          `approvalPolicy: ${session.approvalPolicy}`,
          `codexHome: ${codexHome}`,
        ].join("\n"),
      });
      return;
    }

    if (trimmed === "/stop") {
      await interruptTurn({ chatId, session });
      return;
    }

    if (trimmed.startsWith("/answer ")) {
      const rest = trimmed.slice("/answer ".length);
      const [token, ...answerParts] = rest.split(" ");
      const answer = answerParts.join(" ").trim();
      const action = pendingActions.get(token);
      if (!action || action.kind !== "userInputText" || action.chatId !== chatId) {
        await telegram.sendMessage({ chat_id: chatId, text: "Unknown /answer token." });
        return;
      }
      action.resolve(answer);
      await telegram.sendMessage({ chat_id: chatId, text: "Answer submitted." });
      return;
    }

    try {
      await startOrSteerTurn({ chatId, session, text: trimmed });
    } catch (err) {
      stopTyping(chatId);
      throw err;
    }
  }

  async function handleCallbackQuery(cbq) {
    const chatId = cbq?.message?.chat?.id;
    if (!chatId) return;
    if (allowlist && !allowlist.has(chatId)) {
      await notifyUnauthorizedChat(chatId);
      return;
    }
    const data = cbq.data || "";
    const [kind, token, ...rest] = data.split("|");
    const arg = rest.join("|");
    const action = token ? pendingActions.get(token) : null;

    try {
      if (kind === "appr" && action && action.kind === "approval" && action.chatId === chatId) {
        action.resolve(arg);
        await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: `Sent: ${arg}`, show_alert: false });
        return;
      }

      if (kind === "ui" && action && action.kind === "userInputOption" && action.chatId === chatId) {
        action.resolve(arg);
        await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Answer submitted", show_alert: false });
        return;
      }

      if (kind === "menu") {
        const session = getOrCreateSession(chatId);
        const rt = getRuntime(chatId);
        const actionType = token;
        const value = arg;

        if (actionType === "open" && value) {
          rt.menuPage = VALID_MENU_PAGES.has(value) ? value : MENU_PAGES.MAIN;
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Refreshed", show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "status" || actionType === "refresh") {
          if (actionType === "refresh") {
            reloadSourceRegistry({ reason: "menu-refresh", silent: true });
            ensureSessionTruthProfile(session, { reason: "menu-refresh", bootstrapPending: false });
          }
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Refreshed", show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "truth") {
          ensureSessionTruthProfile(session, { reason: "menu-truth", bootstrapPending: false });
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Truth profile", show_alert: false });
          await telegram.sendMessage({
            chat_id: chatId,
            text: truncateMiddle(formatTruthProfileText(session, sourceRegistry), 3900),
          });
          return;
        }

        if (actionType === "new") {
          await resetSessionThread(chatId, session);
          await ensureThread(session, chatId);
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "New thread started", show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "stop") {
          await interruptTurn({ chatId, session });
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Interrupt requested", show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "compact") {
          const started = await startManualCompaction({ chatId, session });
          await telegram.answerCallbackQuery({
            callback_query_id: cbq.id,
            text: started ? "Compaction started" : "Compaction unavailable",
            show_alert: false,
          });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "cwd" && value) {
          const resolved = setSessionCwdWithTruth(session, value, {
            reason: "menu-cwd",
            bootstrapPending: true,
          });
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: `cwd => ${value}`, show_alert: false });
          await telegram.sendMessage({
            chat_id: chatId,
            text: `truth profile: ${resolved.profile.name} (${resolved.profile.id})`,
          });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "model" && value) {
          session.model = normalizeModelId(value);
          session.updatedAt = nowIso();
          store.markDirty();
          store.saveThrottled();
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: `model => ${session.model}`, show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "effort" && value) {
          const nextEffort = normalizeEffortLevel(value);
          if (!nextEffort) {
            await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Invalid effort", show_alert: true });
            return;
          }
          session.effort = nextEffort;
          session.updatedAt = nowIso();
          store.markDirty();
          store.saveThrottled();
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: `effort => ${session.effort}`, show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "account" && value) {
          const profile = findAccountProfile(value);
          if (!profile) {
            await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Unknown account", show_alert: false });
            return;
          }
          await switchAccountProfile(profile);
          await telegram.answerCallbackQuery({
            callback_query_id: cbq.id,
            text: `account => ${profile.shortLabel}`,
            show_alert: false,
          });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "help") {
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Opened help", show_alert: false });
          await telegram.sendMessage({ chat_id: chatId, text: buildHelpText() });
          return;
        }
      }

      await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Unknown action", show_alert: false });
    } catch (err) {
      console.warn("callback handler failed:", err.message);
      try {
        await telegram.answerCallbackQuery({
          callback_query_id: cbq.id,
          text: err.message || "Action failed",
          show_alert: true,
        });
      } catch {
        // ignore secondary callback failures
      }
    }
  }

  async function pollingLoop() {
    let offset = Number(store.data.telegram?.offset || 0);
    const allowed_updates = ["message", "callback_query"];

    for (;;) {
      try {
        const updates = await telegram.getUpdates({ offset, timeout: pollTimeoutSeconds, allowed_updates });
        recordTelegramPollSuccess();
        for (const u of updates) {
          offset = u.update_id + 1;
          store.data.telegram.offset = offset;
          store.markDirty();
          store.saveThrottled();

          if (u.message && u.message.text) {
            Promise.resolve(handleMessage({
              chatId: u.message.chat.id,
              text: u.message.text,
              message: u.message,
            })).catch((err) => {
              console.error("handleMessage failed:", err);
            });
          } else if (u.callback_query) {
            Promise.resolve(handleCallbackQuery(u.callback_query)).catch((err) => {
              console.error("handleCallbackQuery failed:", err);
            });
          }
        }
      } catch (err) {
        const health = recordTelegramPollError(err);
        console.error("Polling error:", err.message);
        const stallBaselineMs = Math.max(
          Number(health.lastPollSuccessAt || 0),
          processStartedAt,
        );
        const stalledMs = Math.max(0, Date.now() - stallBaselineMs);
        if (
          health.consecutivePollErrors >= TELEGRAM_POLLING_RESTART_ERROR_THRESHOLD
          && stalledMs >= TELEGRAM_POLLING_STALL_THRESHOLD_MS
        ) {
          await requestSupervisorRestart(
            `Telegram polling stalled for ${Math.round(stalledMs / 1000)}s after ${health.consecutivePollErrors} consecutive errors`,
          );
          return;
        }
        await sleep(2000);
      }
    }
  }

  console.log("Telegram Codex Bridge started.");
  if (allowlist) console.log(`Allowlist enabled (${allowlist.size} chat ids).`);
  console.log(`Store: ${storePath}`);
  console.log(`Source registry: ${sourceRegistry.registryPath || "(builtin)"}`);
  if (sourceRegistry.registryError) console.warn(`Source registry warning: ${sourceRegistry.registryError}`);

  await pollingLoop();
}

module.exports = {
  _test: {
    DEFAULT_CONTEXT_SOFT_RATIO,
    DEFAULT_CONTEXT_HARD_RATIO,
    DEFAULT_CONTEXT_EMERGENCY_RATIO,
    classifyContextUsageRatio,
    extractContextUsageSnapshotPayload,
    applyContextUsageSnapshot,
    shouldAutoCompactDecision,
    isContextFailurePatternMatch,
    shouldTreatTextAsContextFailure,
    extractTelemetryThreadId,
    isAccountAuthFailureText,
    isAccessExpiryExpired,
    isAccountProfileAccessExpired,
    normalizeAccountSelectorList,
    isAccountProfileLastResort,
    sortAccountProfilesByPriority,
    prioritizeAccountProfiles,
    buildAuthRecoveryReplayTask,
    getReplayableAuthRecoveryTaskFromRuntime,
    summarizeCodexBackendHealth,
    buildCompactionBootstrapText,
    countQueuedTasks,
    normalizeSessionState,
    normalizeModelId,
    normalizeEffortLevel,
    parseModelCommandArgs,
    buildSourceRegistry,
    normalizeSourceProfile,
    findSourceProfileForPath,
    refreshSessionTruthProfile,
    formatTruthProfileText,
    buildTruthBootstrapText,
    filterDesktopCodexConfigToml,
    syncDesktopCodexContext,
    resolveAgentMessageTurnId,
    shouldRetryTelegramMethod,
  },
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    // Exit immediately so the supervisor can start a fresh bridge process.
    process.exit(1);
  });
}
