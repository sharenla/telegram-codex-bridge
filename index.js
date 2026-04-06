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
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const QUICK_MODELS = ["gpt-5.4", "gpt-5.4-mini"];
const QUICK_EFFORTS = ["high", "xhigh"];
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

function resolveUserPath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return inputPath;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
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

function loadCodexAccountProfiles(sourcePath) {
  if (!sourcePath) return [];
  const resolved = resolveUserPath(sourcePath);
  const parsed = loadJsonFile(resolved);
  if (!parsed || typeof parsed !== "object") return [];
  const profileMap =
    parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : parsed;
  const items = [];
  const seen = new Set();

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

    const dedupeKey = `${accountId || "none"}:${profile.refresh.slice(-16)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    items.push({
      profileId,
      accountId,
      label: email || accountId || profileId,
      shortLabel: truncateLabel(email || accountId || profileId, 24),
      access: profile.access,
      refresh: profile.refresh,
      sourcePath: resolved,
    });
  }

  items.sort((left, right) => left.label.localeCompare(right.label));
  return items;
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
      telegram: { offset: 0 },
      bridge: { currentAccountProfileId: null },
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
        this.data.telegram = parsed.telegram || { offset: 0 };
        this.data.bridge = parsed.bridge || { currentAccountProfileId: null };
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
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
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
        if (!isTransient || attempt === 4) throw error;
        console.warn(`Telegram API ${method} retry ${attempt}/4 after transient error: ${message}`);
        await sleep(500 * attempt);
      }
    }
    throw lastError || new Error(`Telegram API ${method} failed`);
  }

  async callOnce(method, params) {
    const body = JSON.stringify(params ?? {});
    const stdout = await new Promise((resolve, reject) => {
      execFile("curl", [
        "-sS",
        "-4",
        "--http1.1",
        "--connect-timeout",
        "10",
        "--max-time",
        "45",
        "-X",
        "POST",
        `${this.baseUrl}/${method}`,
        "-H",
        "content-type: application/json",
        "-d",
        body,
      ], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      }, (error, out, stderr) => {
        if (error) {
          const message = stderr ? String(stderr).trim() : error.message;
          reject(new Error(`Telegram API ${method} transport failed: ${message}`));
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
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve,reject}
    this._onNotification = () => {};
    this._onServerRequest = async () => ({ ok: false, error: { code: -32601, message: "Method not found" } });
  }

  onNotification(handler) {
    this._onNotification = handler;
  }

  onServerRequest(handler) {
    this._onServerRequest = handler;
  }

  async start() {
    if (this.proc) return;
    this.proc = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: this.env,
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this._handleLine(line));

    this.proc.on("exit", (code, signal) => {
      console.error(`codex app-server exited (code=${code}, signal=${signal})`);
      this.proc = null;
      for (const { reject } of this._pending.values()) {
        reject(new Error("codex app-server exited"));
      }
      this._pending.clear();
    });
  }

  stop() {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
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

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value))];
}

function buildHelpText() {
  return [
    "Telegram Codex Bridge commands:",
    "/new - start a new Codex thread",
    "/status - show current thread/turn",
    "/cwd <path> - set working dir for this chat",
    "/project <path> - set cwd and start a fresh thread",
    "/model <id> - set model for this chat",
    "/effort <none|minimal|low|medium|high|xhigh> - set reasoning effort",
    "/models - show recommended model ids",
    "/efforts - show reasoning effort options",
    "/accounts - show available Codex accounts",
    "/account <id|index> - switch Codex account without dropping the thread",
    "/menu - open the quick settings panel",
    "/stop - interrupt current turn",
    "",
    "群聊里只有 @bot 或直接回复 bot 的消息才会触发；私聊不受影响。",
    "群聊会自动隐藏代码、路径、命令输出和 diff，只保留进度描述；私聊保持完整。",
    "",
    "Tip: just send plain text to talk to Codex.",
  ].join("\n");
}

function buildModelsText() {
  return [
    "Recommended models:",
    "gpt-5.4 - strongest general coding model",
    "gpt-5.4-mini - lighter/faster, cheaper",
    "",
    "Use: /model <id>",
    "Example: /model gpt-5.4-mini",
  ].join("\n");
}

function buildEffortsText() {
  return [
    "Reasoning effort options:",
    "none, minimal, low, medium, high, xhigh",
    "",
    "Use: /effort <level>",
    "Example: /effort xhigh",
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
    const detail = profile.accountId ? ` (${profile.accountId.slice(0, 8)})` : "";
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
    `model: ${session.model}`,
    `effort: ${session.effort}`,
    accountLine,
    `thread: ${session.threadId || "(none)"}`,
    `turn: ${rt.activeTurnId || "(none)"}`,
    "",
  ];

  if (page === MENU_PAGES.THREAD) {
    return header.concat([
      "线程管理",
      "- New Thread：清掉当前上下文，重新开一个 thread",
      "- Stop Turn：中断当前正在运行的 turn",
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
      "- 模型和 effort 放在同一层",
      "- 自定义模型继续用 /model <id>",
      "- 自定义 effort 继续用 /effort <level>",
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
    return {
      inline_keyboard: [
        QUICK_MODELS.map((model) => ({ text: `Model ${model}`, callback_data: `menu|model|${model}` })),
        QUICK_EFFORTS.map((effort) => ({ text: `Effort ${effort}`, callback_data: `menu|effort|${effort}` })),
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
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exitCode = 1;
    return;
  }

  const telegram = new TelegramApi(BOT_TOKEN);
  if (argv.has("--discover-chat-id") || argv.has("discover-chat-id")) {
    await discoverChatIds(telegram);
    return;
  }

  const me = await telegram.getMe();
  const botIdentity = {
    id: me?.id || null,
    username: typeof me?.username === "string" ? me.username : null,
  };

  const allowlist = parseCsvIds(process.env.TELEGRAM_ALLOWLIST);
  if (!allowlist) {
    console.error("Missing TELEGRAM_ALLOWLIST (comma-separated chat ids). Refusing to start for safety.");
    console.error("Run this instead:");
    console.error("npm run discover-chat");
    process.exitCode = 1;
    return;
  }

  const storePath =
    process.env.STORE_PATH || path.join(__dirname, "data", "store.json");
  const store = new Store(storePath);
  store.load();

  const codexHome = resolveUserPath(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  );
  ensureDir(codexHome);
  const fallbackAuthPath = path.join(os.homedir(), ".codex", "auth.json");
  const runtimeAuthPath = path.join(codexHome, "auth.json");
  const authTemplate = readCodexAuth(runtimeAuthPath) || readCodexAuth(fallbackAuthPath);
  const accountsSourceDefault = path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  const accountsSource = process.env.CODEX_ACCOUNTS_SOURCE || (fs.existsSync(accountsSourceDefault) ? accountsSourceDefault : "");
  const accountProfiles = loadCodexAccountProfiles(accountsSource);

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
  const autoAccountFailover = accountProfiles.length > 1
    && parseBooleanEnv(process.env.CODEX_AUTO_ACCOUNT_FAILOVER, true);

  function readRuntimeAccountId() {
    const auth = readCodexAuth(runtimeAuthPath);
    const accountId = auth?.tokens?.account_id;
    return typeof accountId === "string" && accountId ? accountId : null;
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
    const stored = store.data.bridge?.currentAccountProfileId;
    if (stored) {
      const found = findAccountProfile(stored);
      if (found) return found;
    }

    const runtimeAccountId = readRuntimeAccountId();
    if (runtimeAccountId) {
      const found = accountProfiles.find((profile) => profile.accountId === runtimeAccountId);
      if (found) return found;
    }

    return accountProfiles[0] || null;
  }

  function writeAuthForProfile(profile) {
    if (!profile) throw new Error("No account profile selected");
    if (!authTemplate) {
      throw new Error("No auth template available. Seed CODEX_HOME with a working Codex auth.json first.");
    }
    const next = {
      auth_mode: authTemplate.auth_mode || "chatgpt",
      OPENAI_API_KEY: authTemplate.OPENAI_API_KEY ?? null,
      tokens: {
        id_token: authTemplate.tokens?.id_token || "",
        access_token: profile.access,
        refresh_token: profile.refresh,
        account_id: profile.accountId || "",
      },
      last_refresh: new Date().toISOString(),
    };
    fs.writeFileSync(runtimeAuthPath, JSON.stringify(next, null, 2));
  }

  function buildAccountMeta() {
    const currentProfileId = store.data.bridge?.currentAccountProfileId || null;
    const currentProfile = findAccountProfile(currentProfileId) || resolveInitialAccountProfile();
    return {
      currentAccountProfileId: currentProfile?.profileId || null,
      currentAccountLabel: currentProfile?.label || null,
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

  function extractTurnErrorText(turn) {
    const parts = [];
    if (turn?.error?.message) parts.push(String(turn.error.message));
    if (turn?.error?.codexErrorInfo) parts.push(String(turn.error.codexErrorInfo));
    if (turn?.error?.additionalDetails) parts.push(String(turn.error.additionalDetails));
    return parts.filter(Boolean).join(" | ");
  }

  function isUsageLimitTurn(turn) {
    if (!autoAccountFailover || accountProfiles.length < 2) return false;
    const codexErrorInfo = turn?.error?.codexErrorInfo;
    if (typeof codexErrorInfo === "string" && codexErrorInfo === "usageLimitExceeded") return true;
    const text = extractTurnErrorText(turn);
    if (!text) return false;
    return ACCOUNT_FAILOVER_PATTERNS.some((pattern) => pattern.test(text));
  }

  function listFallbackProfiles(currentProfileId, attemptedProfileIds = new Set()) {
    const startIndex = accountProfiles.findIndex((profile) => profile.profileId === currentProfileId);
    if (startIndex < 0) {
      return accountProfiles.filter((profile) => !attemptedProfileIds.has(profile.profileId));
    }
    const rotated = [
      ...accountProfiles.slice(startIndex + 1),
      ...accountProfiles.slice(0, startIndex),
    ];
    return rotated.filter((profile) => !attemptedProfileIds.has(profile.profileId));
  }

  async function requestWithAccountFailover({ chatId, run, failureLabel = "request" }) {
    try {
      return await run();
    } catch (err) {
      if (!isAccountFailoverError(err)) throw err;

      let lastError = err;
      let currentProfile = getCurrentAccountProfile();
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
          text: `Detected a quota/rate limit during ${failureLabel}. Switching to account ${numberLabel} and retrying…`,
        });

        await switchAccountProfile(nextProfile);
        currentProfile = nextProfile;
        startTyping(chatId);

        try {
          return await run();
        } catch (retryErr) {
          if (!isAccountFailoverError(retryErr)) throw retryErr;
          lastError = retryErr;
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
  const codexEnv = { ...process.env, CODEX_HOME: codexHome };

  const codexBin = resolveCodexBin();

  async function retryTurnAfterUsageLimit({ chatId, session, rt, turn }) {
    if (!isUsageLimitTurn(turn) || rt.failoverInProgress) return false;

    const inputMeta = rt.turnInputMetaByTurnId?.[turn?.id];
    if (!inputMeta?.text) return false;

    const currentProfile = getCurrentAccountProfile();
    const attempted = new Set(uniqueStrings([
      ...(inputMeta.attemptedProfileIds || []),
      currentProfile?.profileId || null,
    ]));
    const nextProfile = listFallbackProfiles(currentProfile?.profileId, attempted)[0] || null;
    if (!nextProfile) return false;

    rt.failoverInProgress = true;
    delete rt.turnInputMetaByTurnId[turn.id];

    try {
      const nextNumber = accountNumber(nextProfile);
      const numberLabel = nextNumber ? `#${nextNumber}` : "next";
      await telegram.sendMessage({
        chat_id: chatId,
        text: `Current account hit a usage limit during the turn. Switching to account ${numberLabel} and retrying…`,
      });

      await switchAccountProfile(nextProfile);
      startTyping(chatId);
      await startOrSteerTurn({
        chatId,
        session,
        text: inputMeta.text,
        attemptedProfileIds: uniqueStrings([
          ...attempted,
          nextProfile.profileId,
        ]),
      });
      return true;
    } finally {
      rt.failoverInProgress = false;
    }
  }

  async function startCodexServer() {
    const server = new CodexAppServer({ codexBin, env: codexEnv });
    server.onNotification(async (msg) => {
      const { method, params } = msg;
      if (!method || !params) return;

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
        rt.activeTurnId = null;
        stopTyping(chatId);
        await flushBufferedAgentMessages(chatId, rt);

        if (isGroupChat(chatId) && turn?.status === "completed") {
          await revealFinalGroupAgentMessage(chatId, rt, turn?.id);
        }

        const status = turn?.status || "completed";
        if (status !== "completed") {
          const retried = await retryTurnAfterUsageLimit({ chatId, session, rt, turn });
          if (!retried) {
            const rawDetail = extractTurnErrorText(turn);
            const detail = isGroupChat(chatId) ? sanitizeGroupAgentText(rawDetail) : rawDetail;
            const text = detail
              ? `Turn ${status}: ${truncateMiddle(detail, 1200)}`
              : `Turn ${status}.`;
            if (!(isGroupChat(chatId) && hasSeenGroupVisibleText(rt, text))) {
              await telegram.sendMessage({ chat_id: chatId, text });
              if (isGroupChat(chatId)) rememberGroupVisibleText(rt, text);
            }
          }
        }

        if (turn?.id) {
          delete rt.turnInputMetaByTurnId[turn.id];
          delete rt.lastAgentMessageIdByTurnId[turn.id];
          delete rt.groupAgentMessageByTurnId[turn.id];
        }

        const diff = rt.turnDiffByTurnId?.[turn?.id];
        if (diff && typeof diff === "string" && diff.trim()) {
          const text = isGroupChat(chatId)
            ? "本轮包含代码改动，具体 diff 已在群里隐藏。"
            : `Turn diff (preview):\n\n${truncateMiddle(diff, 3500)}`;
          if (!(isGroupChat(chatId) && hasSeenGroupVisibleText(rt, text))) {
            await telegram.sendMessage({ chat_id: chatId, text });
            if (isGroupChat(chatId)) rememberGroupVisibleText(rt, text);
          }
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

        if (item.type === "commandExecution") {
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
          if (turnId) rt.lastAgentMessageIdByTurnId[turnId] = item.id;
          if (!rt.items[item.id]) {
            rt.items[item.id] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId: turnId || null };
          } else {
            rt.items[item.id].turnId = turnId || rt.items[item.id].turnId || null;
          }
          if (item.text && item.text.trim()) {
            await upsertAgentMessage({ chatId, item, rt });
          } else {
            rt.items[item.id] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId: turnId || null };
          }
          return;
        }
      }

      if (method === "item/completed") {
        const { threadId, turnId, item } = params;
        const chatId = chatIdForThread(threadId);
        if (!chatId || !item || !item.id) return;
        const rt = getRuntime(chatId);

        if (item.type === "agentMessage") {
          if (turnId) rt.lastAgentMessageIdByTurnId[turnId] = item.id;
          if (!rt.items[item.id]) {
            rt.items[item.id] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId: turnId || null };
          } else {
            rt.items[item.id].turnId = turnId || rt.items[item.id].turnId || null;
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
        if (!rt.items?.[itemId]) {
          rt.items[itemId] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId: turnId || null };
        }
        if (turnId) {
          rt.items[itemId].turnId = turnId;
          rt.lastAgentMessageIdByTurnId[turnId] = itemId;
        }
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
        if (typeof params?.cwd === "string" && params.cwd.trim()) session.cwd = params.cwd.trim();
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
      turnInputMetaByTurnId: {},
      lastAgentMessageIdByTurnId: {},
      groupAgentMessageByTurnId: {},
      items: {},
      turnDiffByTurnId: {},
      lastGroupProgressByBucket: {},
      sentGroupVisibleTexts: new Set(),
      editTimers: new Map(),
      failoverInProgress: false,
      typingTimer: null,
      menuPage: MENU_PAGES.MAIN,
    };
    runtimeByChat.set(chatId, created);
    return created;
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
    if (existing && typeof existing === "object") return existing;
    const created = {
      threadId: null,
      cwd: defaults.cwd,
      model: defaults.model,
      effort: defaults.effort,
      summary: defaults.summary,
      personality: defaults.personality,
      approvalPolicy: defaults.approvalPolicy,
      sandboxMode: defaults.sandboxMode,
      updatedAt: nowIso(),
    };
    store.data.sessions[key] = created;
    store.markDirty();
    store.saveThrottled();
    return created;
  }

  function chatIdForThread(threadId) {
    for (const [chatId, session] of Object.entries(store.data.sessions)) {
      if (session && session.threadId === threadId) return Number(chatId);
    }
    return null;
  }

  async function resetSessionThread(chatId, session) {
    session.threadId = null;
    const rt = getRuntime(chatId);
    rt.activeTurnId = null;
    rt.items = {};
    rt.turnDiffByTurnId = {};
    rt.lastAgentMessageIdByTurnId = {};
    rt.groupAgentMessageByTurnId = {};
    rt.lastGroupProgressByBucket = {};
    rt.sentGroupVisibleTexts = new Set();
    stopTyping(chatId);
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

  async function switchAccountProfile(profile) {
    if (!profile) throw new Error("Unknown account profile");
    if (hasActiveTurns()) {
      throw new Error("A turn is still running. Wait for it to finish or use /stop first.");
    }

    stopTypingForAllChats();
    writeAuthForProfile(profile);
    store.data.bridge.currentAccountProfileId = profile.profileId;
    store.markDirty();
    store.save();

    if (codex) codex.stop();
    await startCodexServer();
    return profile;
  }

  function stopTypingForAllChats() {
    for (const chatId of runtimeByChat.keys()) {
      stopTyping(chatId);
    }
  }

  function buildMenuPayload(session, rt) {
    const page = getMenuPage(rt);
    const meta = buildAccountMeta();
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
    return requestWithAccountFailover({
      chatId,
      failureLabel: "thread setup",
      run: async () => {
        if (session.threadId) {
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
            console.warn("thread/resume failed, starting new thread:", err.message);
            session.threadId = null;
          }
        }

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
        const rt = getRuntime(chatId);
        rt.activeTurnId = null;
        rt.items = {};
        rt.turnDiffByTurnId = {};
        session.updatedAt = nowIso();
        store.markDirty();
        store.saveThrottled();

        await telegram.sendMessage({
          chat_id: chatId,
          text: `Started new thread: ${threadId}`,
          disable_web_page_preview: true,
        });

        return threadId;
      },
    });
  }

  async function startOrSteerTurn({ chatId, session, text, attemptedProfileIds = null }) {
    const rt = getRuntime(chatId);
    const currentProfile = getCurrentAccountProfile();
    rt.pendingInputMeta = {
      text,
      attemptedProfileIds: uniqueStrings([
        ...(attemptedProfileIds || []),
        currentProfile?.profileId || null,
      ]),
    };

    try {
      const threadId = await ensureThread(session, chatId);
      startTyping(chatId);

      if (rt.activeTurnId) {
        rt.turnInputMetaByTurnId[rt.activeTurnId] = { ...rt.pendingInputMeta };
        rt.pendingInputMeta = null;

        await codex.request("turn/steer", {
          threadId,
          expectedTurnId: rt.activeTurnId,
          input: [{ type: "text", text }],
        });
        await telegram.sendMessage({ chat_id: chatId, text: "Steering active turn…" });
        return;
      }

      rt.items = {};
      rt.turnDiffByTurnId = {};
      session.updatedAt = nowIso();
      store.markDirty();
      store.saveThrottled();

      await requestWithAccountFailover({
        chatId,
        failureLabel: "turn start",
        run: async () => codex.request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
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
        }),
      });
    } catch (err) {
      if (rt.pendingInputMeta?.text === text) {
        rt.pendingInputMeta = null;
      }
      throw err;
    }
  }

  async function interruptTurn({ chatId, session }) {
    const rt = getRuntime(chatId);
    if (!session.threadId || !rt.activeTurnId) {
      await telegram.sendMessage({ chat_id: chatId, text: "No active turn." });
      return;
    }
    await codex.request("turn/interrupt", { threadId: session.threadId, turnId: rt.activeTurnId });
    await telegram.sendMessage({ chat_id: chatId, text: "Interrupt requested." });
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
    const buffer = item?.text || rt.items?.[item?.id]?.buffer || "";
    const existing = item?.id ? rt.items?.[item.id] : null;
    const groupChat = isGroupChat(chatId);
    const renderedBuffer = groupChat ? sanitizeGroupAgentText(buffer) : buffer;
    const turnId = existing?.turnId || item?.turnId || null;

    if (!renderedBuffer.trim()) {
      if (item?.id && !existing) {
        rt.items[item.id] = { kind: "agentMessage", messageId: null, buffer: "", renderedBuffer: "", turnId };
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
        const sent = await telegram.sendMessage({ chat_id: chatId, text });
        entry.messageId = sent.message_id;
        rt.groupAgentMessageByTurnId[turnId] = sent.message_id;
        rememberGroupVisibleText(rt, text);
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
      const sent = await telegram.sendMessage({ chat_id: chatId, text });
      existing.messageId = sent.message_id;
      existing.suppressedDuplicate = false;
      if (groupChat) rememberGroupVisibleText(rt, text);
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
      session.cwd = trimmed.slice("/cwd ".length).trim();
      session.updatedAt = nowIso();
      store.markDirty();
      store.saveThrottled();
      await telegram.sendMessage({ chat_id: chatId, text: `cwd set to: ${session.cwd}` });
      return;
    }

    if (trimmed.startsWith("/project ")) {
      session.cwd = trimmed.slice("/project ".length).trim();
      await resetSessionThread(chatId, session);
      await telegram.sendMessage({
        chat_id: chatId,
        text: `project switched to: ${session.cwd}\nStarted with a fresh thread next time you message.`,
      });
      return;
    }

    if (trimmed.startsWith("/model ")) {
      session.model = trimmed.slice("/model ".length).trim();
      session.updatedAt = nowIso();
      store.markDirty();
      store.saveThrottled();
      await telegram.sendMessage({ chat_id: chatId, text: `model set to: ${session.model}` });
      return;
    }

    if (trimmed.startsWith("/effort ")) {
      const nextEffort = trimmed.slice("/effort ".length).trim();
      if (!VALID_EFFORTS.has(nextEffort)) {
        await telegram.sendMessage({
          chat_id: chatId,
          text: "Invalid effort. Use one of: none, minimal, low, medium, high, xhigh",
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

    if (trimmed === "/status") {
      const rt = getRuntime(chatId);
      const meta = buildAccountMeta();
      await telegram.sendMessage({
        chat_id: chatId,
        text: [
          `threadId: ${session.threadId || "(none)"}`,
          `activeTurnId: ${rt.activeTurnId || "(none)"}`,
          `cwd: ${session.cwd}`,
          `model: ${session.model}`,
          `effort: ${session.effort}`,
          `account: ${meta.currentAccountLabel || "(default)"}`,
          `accountFailover: ${meta.autoAccountFailover ? "on" : "off"}`,
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
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: "Refreshed", show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
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

        if (actionType === "cwd" && value) {
          session.cwd = value;
          session.updatedAt = nowIso();
          store.markDirty();
          store.saveThrottled();
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: `cwd => ${value}`, show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "model" && value) {
          session.model = value;
          session.updatedAt = nowIso();
          store.markDirty();
          store.saveThrottled();
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: `model => ${value}`, show_alert: false });
          await renderMenuMessage(chatId, cbq.message.message_id);
          return;
        }

        if (actionType === "effort" && value && VALID_EFFORTS.has(value)) {
          session.effort = value;
          session.updatedAt = nowIso();
          store.markDirty();
          store.saveThrottled();
          await telegram.answerCallbackQuery({ callback_query_id: cbq.id, text: `effort => ${value}`, show_alert: false });
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
        const updates = await telegram.getUpdates({ offset, timeout: 30, allowed_updates });
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
        console.error("Polling error:", err.message);
        await sleep(2000);
      }
    }
  }

  console.log("Telegram Codex Bridge started.");
  if (allowlist) console.log(`Allowlist enabled (${allowlist.size} chat ids).`);
  console.log(`Store: ${storePath}`);

  await pollingLoop();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
