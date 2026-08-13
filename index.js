"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const node_os = require("node:os");
const node_path = require("node:path");
const node_fs = require("node:fs");
const Database = require("better-sqlite3");
const node_child_process = require("node:child_process");
const node_crypto = require("node:crypto");
const promises = require("node:fs/promises");
const node_module = require("node:module");
const node_util = require("node:util");
const pty = require("node-pty");
const child_process = require("child_process");
const util = require("util");
const crypto = require("crypto");
const os = require("os");
const node_net = require("node:net");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
const APP_DISPLAY_NAME = "Atelier";
if (!electron.app.isReady()) {
  electron.app.setName(APP_DISPLAY_NAME);
}
process.title = APP_DISPLAY_NAME;
function resolveAppIconPath() {
  const candidates = [
    node_path.join(__dirname, "../renderer/icon.png"),
    node_path.join(__dirname, "../../build/icon.png"),
    node_path.join(electron.app.getAppPath(), "build/icon.png"),
    node_path.join(electron.app.getAppPath(), "src/renderer/public/icon.png")
  ];
  for (const p of candidates) {
    if (node_fs.existsSync(p)) return p;
  }
  return void 0;
}
function resolveDockIconPath() {
  const candidates = [
    node_path.join(__dirname, "../renderer/icon-dock.png"),
    node_path.join(__dirname, "../../build/icon-dock.png"),
    node_path.join(electron.app.getAppPath(), "build/icon-dock.png"),
    node_path.join(electron.app.getAppPath(), "src/renderer/public/icon-dock.png")
  ];
  for (const p of candidates) {
    if (node_fs.existsSync(p)) return p;
  }
  return resolveAppIconPath();
}
function applyDockIconWhenReady() {
  if (process.platform !== "darwin" || !electron.app.dock) return;
  const iconPath = resolveDockIconPath();
  if (!iconPath) return;
  const image = electron.nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) electron.app.dock.setIcon(image);
}
const DEFAULT_TERMINAL_TOOLBOX_COMMANDS = [
  { id: "default-git-status", label: "git status", command: "git status" },
  { id: "default-npm-build", label: "npm run build", command: "npm run build" }
];
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
function defaultClaudeModelFromConfig(config) {
  const trimmed = config.defaultClaudeModel?.trim();
  return trimmed || DEFAULT_CLAUDE_MODEL;
}
const DEFAULT_CLAUDE_EFFORT = "high";
function defaultClaudeEffortFromConfig(config) {
  return config.defaultClaudeEffort ?? DEFAULT_CLAUDE_EFFORT;
}
const DEFAULT_CONFIG = {
  onboardingCompleted: false,
  theme: "dark",
  sidebarCollapsed: false,
  defaultClaudeModel: DEFAULT_CLAUDE_MODEL,
  defaultClaudeEffort: DEFAULT_CLAUDE_EFFORT,
  fontSizes: {
    terminal: 14,
    interface: 14,
    agentMessage: 15.5
  },
  gitIdentity: {
    name: "",
    email: ""
  },
  vault: {
    root: "",
    dailyNotesFolder: "01.dailynotes",
    notePathPattern: "{yyyy}/{MMM}/{ww}/{date}.md",
    templatePath: "92.templates/Daily Note Template.md"
  },
  worktreeRoot: "~/.atelier/worktrees",
  terminalToolbox: {
    commands: [...DEFAULT_TERMINAL_TOOLBOX_COMMANDS]
  }
};
let stream;
let logFilePath;
function getStream() {
  if (!stream) {
    let logsDir;
    try {
      logsDir = node_path.join(electron.app.getPath("userData"), "logs");
    } catch {
      logsDir = node_path.join(node_os.tmpdir(), "atelier-standalone-logs");
    }
    node_fs.mkdirSync(logsDir, { recursive: true });
    logFilePath = node_path.join(logsDir, "main.log");
    stream = node_fs.createWriteStream(logFilePath, { flags: "a" });
  }
  return stream;
}
function getLogFilePath() {
  if (!logFilePath) {
    getStream();
  }
  return logFilePath;
}
function write(entry) {
  const line = JSON.stringify(entry);
  getStream().write(line + "\n");
  console.log(line);
}
function makeLogger(processName) {
  return {
    debug: (msg, extra) => write({ ts: (/* @__PURE__ */ new Date()).toISOString(), level: "debug", process: processName, msg, ...extra }),
    info: (msg, extra) => write({ ts: (/* @__PURE__ */ new Date()).toISOString(), level: "info", process: processName, msg, ...extra }),
    warn: (msg, extra) => write({ ts: (/* @__PURE__ */ new Date()).toISOString(), level: "warn", process: processName, msg, ...extra }),
    error: (msg, extra) => write({ ts: (/* @__PURE__ */ new Date()).toISOString(), level: "error", process: processName, msg, ...extra })
  };
}
const logger = makeLogger("main");
const rendererLogger = makeLogger("renderer");
let cached;
let configPath;
function getConfigPath() {
  if (!configPath) {
    const dataDir = node_path.join(electron.app.getPath("userData"), "data");
    node_fs.mkdirSync(dataDir, { recursive: true });
    configPath = node_path.join(dataDir, "config.json");
  }
  return configPath;
}
function mergeConfig(base, partial) {
  return {
    ...base,
    ...partial,
    fontSizes: { ...base.fontSizes, ...partial.fontSizes ?? {} },
    gitIdentity: { ...base.gitIdentity, ...partial.gitIdentity ?? {} },
    vault: { ...base.vault, ...partial.vault ?? {} },
    terminalToolbox: partial.terminalToolbox ? { commands: partial.terminalToolbox.commands ?? base.terminalToolbox.commands } : base.terminalToolbox
  };
}
function loadConfig() {
  if (cached) return cached;
  const path = getConfigPath();
  if (node_fs.existsSync(path)) {
    try {
      const raw = JSON.parse(node_fs.readFileSync(path, "utf-8"));
      cached = mergeConfig(DEFAULT_CONFIG, raw);
    } catch (err) {
      logger.warn("failed to parse config.json, falling back to defaults", {
        error: err instanceof Error ? err.message : String(err)
      });
      cached = { ...DEFAULT_CONFIG };
    }
  } else {
    cached = { ...DEFAULT_CONFIG };
  }
  return cached;
}
function saveConfig(partial) {
  const current = loadConfig();
  cached = mergeConfig(current, partial);
  node_fs.writeFileSync(getConfigPath(), JSON.stringify(cached, null, 2));
  logger.info("config saved", { config: cached });
  return cached;
}
const GARDENIA_TO_ATELIER_WORKTREE_MIGRATION = "0010_gardenia_to_atelier_worktrees";
const MIN_LEGACY_DB_BYTES = 512e3;
const LEGACY_WORKTREE_SEGMENT = "/.gardenia/worktrees/";
const NEW_WORKTREE_SEGMENT = "/.atelier/worktrees/";
const SSH_GIT_OPTS$1 = [
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=/tmp/atelier-ssh-%C",
  "-o",
  "ControlPersist=300",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new"
];
function migrateLegacyUserDataFromGardeniaProfiles() {
  if (electron.app.commandLine.hasSwitch("user-data-dir")) {
    return;
  }
  const currentRoot = electron.app.getPath("userData");
  const currentData = node_path.join(currentRoot, "data");
  const atelierDb = node_path.join(currentData, "atelier.sqlite");
  const atelierLooksEmpty = () => {
    if (!node_fs.existsSync(atelierDb)) return true;
    return node_fs.statSync(atelierDb).size < MIN_LEGACY_DB_BYTES;
  };
  if (!atelierLooksEmpty()) {
    return;
  }
  const appData = electron.app.getPath("appData");
  let currentReal;
  try {
    currentReal = node_fs.realpathSync(currentRoot);
  } catch {
    currentReal = currentRoot;
  }
  let best = null;
  for (const name of ["Gardenia", "gardenia", "Electron"]) {
    const root = node_path.join(appData, name);
    let rootReal;
    try {
      rootReal = node_fs.realpathSync(root);
    } catch {
      continue;
    }
    if (rootReal === currentReal) continue;
    const dbPath = node_path.join(root, "data", "gardenia.sqlite");
    if (!node_fs.existsSync(dbPath)) continue;
    const size = node_fs.statSync(dbPath).size;
    if (size < MIN_LEGACY_DB_BYTES) continue;
    if (!best || size > best.size) {
      best = { root, dbPath, size };
    }
  }
  if (!best) return;
  node_fs.mkdirSync(currentData, { recursive: true });
  for (const name of ["atelier.sqlite", "atelier.sqlite-wal", "atelier.sqlite-shm"]) {
    const p = node_path.join(currentData, name);
    if (node_fs.existsSync(p)) node_fs.rmSync(p);
  }
  node_fs.copyFileSync(best.dbPath, node_path.join(currentData, "gardenia.sqlite"));
  const legacyConfig = node_path.join(best.root, "data", "config.json");
  const currentConfig = node_path.join(currentData, "config.json");
  if (node_fs.existsSync(legacyConfig)) {
    node_fs.copyFileSync(legacyConfig, currentConfig);
  }
  logger.info("imported legacy Gardenia user-data into Atelier profile", {
    fromUserData: best.root,
    toUserData: currentRoot,
    legacyDbBytes: best.size
  });
}
function migrateLegacyGardeniaDatabaseFile(dataDir) {
  const legacyPath = node_path.join(dataDir, "gardenia.sqlite");
  const nextPath = node_path.join(dataDir, "atelier.sqlite");
  if (!node_fs.existsSync(nextPath) && node_fs.existsSync(legacyPath)) {
    node_fs.renameSync(legacyPath, nextPath);
    logger.info("migrated legacy SQLite database filename", { from: legacyPath, to: nextPath });
  }
}
function toAtelierWorktreePath(legacyPath) {
  if (!legacyPath.includes(LEGACY_WORKTREE_SEGMENT)) return legacyPath;
  return legacyPath.replaceAll(LEGACY_WORKTREE_SEGMENT, NEW_WORKTREE_SEGMENT);
}
function branchNames(sessionId) {
  const prefix = sessionId.slice(0, 8);
  return { legacy: `gardenia-${prefix}`, next: `atelier-${prefix}` };
}
function renameBranch(projectPath, sessionId, hostname) {
  const { legacy, next } = branchNames(sessionId);
  if (hostname) {
    try {
      node_child_process.execFileSync(
        "ssh",
        [...SSH_GIT_OPTS$1, hostname, "git", "-C", projectPath, "show-ref", "--verify", "--quiet", `refs/heads/${legacy}`],
        { stdio: "ignore" }
      );
      node_child_process.execFileSync("ssh", [...SSH_GIT_OPTS$1, hostname, "git", "-C", projectPath, "branch", "-m", legacy, next], {
        encoding: "utf8",
        timeout: 6e4
      });
    } catch {
    }
    return;
  }
  try {
    node_child_process.execFileSync("git", ["-C", projectPath, "show-ref", "--verify", "--quiet", `refs/heads/${legacy}`], {
      stdio: "ignore"
    });
    node_child_process.execFileSync("git", ["-C", projectPath, "branch", "-m", legacy, next], { encoding: "utf8" });
  } catch {
  }
}
function moveWorktree(projectPath, legacyPath, nextPath, hostname) {
  node_fs.mkdirSync(node_path.dirname(nextPath), { recursive: true });
  if (hostname) {
    node_child_process.execFileSync(
      "ssh",
      [...SSH_GIT_OPTS$1, hostname, "git", "-C", projectPath, "worktree", "move", legacyPath, nextPath],
      { encoding: "utf8", timeout: 5 * 6e4 }
    );
    return;
  }
  if (!node_fs.existsSync(legacyPath)) {
    logger.info("legacy worktree path missing on disk, updating DB only", { legacyPath, nextPath });
    return;
  }
  node_child_process.execFileSync("git", ["-C", projectPath, "worktree", "move", legacyPath, nextPath], { encoding: "utf8" });
}
function runGardeniaToAtelierWorktreeMigration(db2) {
  const alreadyApplied = db2.prepare("SELECT 1 FROM migrations WHERE name = ?").get(GARDENIA_TO_ATELIER_WORKTREE_MIGRATION);
  if (alreadyApplied) return;
  const rows = db2.prepare(
    `SELECT id, project_path, worktree_path, hostname
       FROM sessions
       WHERE worktree_path IS NOT NULL
         AND worktree_path LIKE '%' || ? || '%'
         AND deleted_at IS NULL`
  ).all(LEGACY_WORKTREE_SEGMENT);
  const updateWorktreePath = db2.prepare("UPDATE sessions SET worktree_path = ? WHERE id = ?");
  for (const row of rows) {
    const nextPath = toAtelierWorktreePath(row.worktree_path);
    try {
      moveWorktree(row.project_path, row.worktree_path, nextPath, row.hostname);
      renameBranch(row.project_path, row.id, row.hostname);
      updateWorktreePath.run(nextPath, row.id);
      logger.info("migrated session worktree path", {
        sessionId: row.id,
        from: row.worktree_path,
        to: nextPath,
        hostname: row.hostname
      });
    } catch (err) {
      logger.warn("session worktree migration failed; will retry on next launch", {
        sessionId: row.id,
        worktreePath: row.worktree_path,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
  }
  db2.prepare(
    `UPDATE project_path_history
     SET path = replace(path, ?, ?)
     WHERE path LIKE '%' || ? || '%'`
  ).run(LEGACY_WORKTREE_SEGMENT, NEW_WORKTREE_SEGMENT, LEGACY_WORKTREE_SEGMENT);
  db2.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
    GARDENIA_TO_ATELIER_WORKTREE_MIGRATION,
    (/* @__PURE__ */ new Date()).toISOString()
  );
  logger.info("gardenia → atelier worktree migration applied", { sessionsUpdated: rows.length });
}
const MIGRATION_NAME = "0006_historical_cost_recompute_from_jsonl";
const MODEL_RATES_PER_MTOK = {
  "claude-opus-4": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-3": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-3": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-4": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-haiku-3": { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
  "claude-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 }
};
const DEFAULT_RATES_PER_MTOK = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
const RATE_KEYS = Object.keys(MODEL_RATES_PER_MTOK).sort((a, b) => b.length - a.length);
function getModelRates(model) {
  if (model) {
    for (const key of RATE_KEYS) {
      if (model.startsWith(key)) return MODEL_RATES_PER_MTOK[key];
    }
  }
  return DEFAULT_RATES_PER_MTOK;
}
function computeCostFromJsonl(content) {
  const totals = /* @__PURE__ */ new Map();
  let pending = null;
  const commit = (p) => {
    if (!p) return;
    let bucket = totals.get(p.model);
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      totals.set(p.model, bucket);
    }
    bucket.input += p.usage.input_tokens ?? 0;
    bucket.output += p.usage.output_tokens ?? 0;
    const cc = p.usage.cache_creation;
    const cacheWrite = cc ? (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0) : 0;
    bucket.cacheWrite += cacheWrite || (p.usage.cache_creation_input_tokens ?? 0);
    bucket.cacheRead += p.usage.cache_read_input_tokens ?? 0;
  };
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" && pending) {
      commit(pending);
      pending = null;
    }
    if (entry.type === "assistant" && entry.message?.usage) {
      pending = { model: entry.message.model ?? "", usage: entry.message.usage };
    }
  }
  commit(pending);
  let total = 0;
  for (const [model, bucket] of totals) {
    const rates = getModelRates(model);
    total += (bucket.input * rates.input + bucket.output * rates.output + bucket.cacheWrite * rates.cacheWrite + bucket.cacheRead * rates.cacheRead) / 1e6;
  }
  return total;
}
function expandTilde(path) {
  if (path === "~") return node_os.homedir();
  if (path.startsWith("~/")) return node_path.join(node_os.homedir(), path.slice(2));
  return path;
}
function encodeProjectDir(absPath) {
  return absPath.replace(/[/.]/g, "-");
}
function localJsonlPath(projectPath, sessionId) {
  const abs = expandTilde(projectPath);
  return node_path.join(node_os.homedir(), ".claude", "projects", encodeProjectDir(abs), `${sessionId}.jsonl`);
}
function readTranscript(session) {
  if (!session.hostname) {
    const path = localJsonlPath(session.projectPath, session.id);
    if (!node_fs.existsSync(path)) return null;
    try {
      return node_fs.readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }
  const remoteScript = 'proj="$1"; case "$proj" in "~"*) proj="$HOME${proj#\\~}";; esac; enc=$(printf "%s" "$proj" | sed "s/[\\/.]/-/g"); cat "$HOME/.claude/projects/$enc/$2.jsonl" 2>/dev/null';
  const result = node_child_process.spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", session.hostname, "--", "sh", "-c", remoteScript, "_", session.projectPath, session.id],
    { encoding: "utf-8", timeout: 8e3, maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout;
}
function runHistoricalCostBackfill(database) {
  const already = database.prepare("SELECT 1 FROM migrations WHERE name = ?").get(MIGRATION_NAME);
  if (already) return { recomputed: 0, resetToZero: 0 };
  const sessions = database.prepare("SELECT id, project_path, hostname, total_cost_usd FROM sessions WHERE total_cost_usd != 0").all();
  const update = database.prepare("UPDATE sessions SET total_cost_usd = ? WHERE id = ?");
  let recomputed = 0;
  let resetToZero = 0;
  for (const session of sessions) {
    let transcript = null;
    try {
      transcript = readTranscript({ id: session.id, projectPath: session.project_path, hostname: session.hostname });
    } catch (err) {
      logger.warn("historical cost backfill: failed reading transcript", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    if (transcript) {
      const newTotal = computeCostFromJsonl(transcript);
      update.run(newTotal, session.id);
      recomputed++;
      logger.info("historical cost recomputed from JSONL transcript", {
        sessionId: session.id,
        oldTotalCostUsd: session.total_cost_usd,
        newTotalCostUsd: newTotal
      });
    } else {
      update.run(0, session.id);
      resetToZero++;
      logger.info("historical cost transcript not found; reset to 0", {
        sessionId: session.id,
        oldTotalCostUsd: session.total_cost_usd
      });
    }
  }
  database.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(MIGRATION_NAME, (/* @__PURE__ */ new Date()).toISOString());
  logger.info("historical cost backfill complete", { recomputed, resetToZero });
  return { recomputed, resetToZero };
}
const STRUCTURED_KINDS = /* @__PURE__ */ new Set([
  "tool_call",
  "thinking_block",
  "todo_update",
  "compaction",
  "permission_request",
  "ask_user_question",
  "plan_proposed",
  "image_attachment",
  "local_command_output",
  "transcript_notice"
]);
function parseStructuredContent(content) {
  if (!content || content[0] !== "{") return null;
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj === "object" && "kind" in obj && STRUCTURED_KINDS.has(obj.kind)) {
      return obj;
    }
  } catch {
    return null;
  }
  return null;
}
function extractSearchableText(role, content) {
  if (role !== "user" && role !== "assistant") return null;
  if (parseStructuredContent(content) !== null) return null;
  return content.trim().length > 0 ? content : null;
}
const FTS_SNIPPET_START = String.fromCharCode(57344);
const FTS_SNIPPET_END = String.fromCharCode(57345);
function toFtsMatchQuery(raw) {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}
function toGroupRecord(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    collapsed: row.collapsed === 1,
    createdAt: row.created_at
  };
}
function toSessionRecord(row, tags = []) {
  return {
    id: row.id,
    name: row.name,
    nameLockedByUser: row.name_locked_by_user === 1,
    projectPath: row.project_path,
    mode: row.mode,
    hostname: row.hostname,
    groupId: row.group_id,
    pinned: row.pinned === 1,
    color: row.color,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    tags,
    notes: row.notes,
    sortOrder: row.sort_order,
    totalCostUsd: row.total_cost_usd,
    // fix-no-conversation-found-remote-resume: whether the underlying
    // harness/CLI has ever actually confirmed a real conversation for this
    // session id — see db.ts's '0006_session_ever_connected' migration doc
    // comment and SessionManager.markEverConnected's call site for the full
    // rationale.
    everConnected: row.ever_connected === 1,
    // restore-mode-and-model-on-resume: read from the DB column (populated
    // by SessionStore.setPermissionMode, written whenever the in-memory
    // permissionModes Map changes). SessionManager's `decorate()` overlays
    // its own in-memory value (if present) on top of this, but for sessions
    // first loaded after a relaunch the DB column IS the right value.
    permissionMode: row.permission_mode,
    // restore-mode-and-model-on-resume: read from DB columns; null if never set.
    modelSelection: row.model_id ? { model: row.model_id, effort: row.effort } : null,
    // use-worktree: absolute path to the session's isolated git worktree, or
    // null for sessions not created with the "Use worktree" toggle.
    worktreePath: row.worktree_path ?? null,
    lastActiveAt: row.last_active_at || row.created_at,
    linkedDailyTaskGid: row.linked_daily_task_gid ?? null,
    linkedDailyNoteDate: row.linked_daily_note_date ?? null
  };
}
function toMessageRecord(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    rawEvent: row.raw_event ? JSON.parse(row.raw_event) : null,
    createdAt: row.created_at
  };
}
class SessionStore {
  constructor(db2) {
    this.db = db2;
  }
  /** Batches session_tags lookups for a set of session ids into one query. */
  tagsFor(sessionIds) {
    const map = /* @__PURE__ */ new Map();
    if (sessionIds.length === 0) return map;
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT session_id, tag FROM session_tags WHERE session_id IN (${placeholders}) ORDER BY tag ASC`).all(...sessionIds);
    for (const row of rows) {
      const list = map.get(row.session_id) ?? [];
      list.push(row.tag);
      map.set(row.session_id, list);
    }
    return map;
  }
  hydrate(rows) {
    const tagsBySession = this.tagsFor(rows.map((r) => r.id));
    return rows.map((row) => toSessionRecord(row, tagsBySession.get(row.id) ?? []));
  }
  createSession(input) {
    const id = input.id ?? node_crypto.randomUUID();
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare(
      `INSERT INTO sessions (id, name, name_locked_by_user, project_path, mode, hostname, group_id, pinned, color, created_at, closed_at, deleted_at, sort_order, worktree_path, last_active_at)
         VALUES (@id, @name, 0, @projectPath, @mode, @hostname, @groupId, @pinned, @color, @createdAt, NULL, NULL, @sortOrder, @worktreePath, @lastActiveAt)`
    ).run({
      id,
      name: input.name,
      projectPath: input.projectPath,
      mode: input.mode,
      hostname: input.hostname,
      groupId: input.groupId ?? null,
      pinned: input.pinned ? 1 : 0,
      color: input.color ?? null,
      createdAt,
      sortOrder: input.sortOrder ?? Date.now(),
      worktreePath: input.worktreePath ?? null,
      lastActiveAt: createdAt
    });
    return this.getSession(id);
  }
  getSession(id) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) return void 0;
    return this.hydrate([row])[0];
  }
  /** Active sessions: not closed. Used for the Pinned/grouped sidebar view. */
  listActiveSessions() {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY sort_order ASC, created_at ASC").all();
    return this.hydrate(rows);
  }
  /** Closed sessions: still resumable, shown under History. */
  listHistorySessions() {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE closed_at IS NOT NULL ORDER BY closed_at DESC").all();
    return this.hydrate(rows);
  }
  listAllSessions() {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC").all();
    return this.hydrate(rows);
  }
  /** Manual rename: locks the name so auto-naming can never revert it (Bug #93 regression guard). */
  renameSession(id, name) {
    this.db.prepare("UPDATE sessions SET name = ?, name_locked_by_user = 1 WHERE id = ?").run(name, id);
    return this.getSession(id);
  }
  /**
   * Auto-naming summarizer's write path: only ever takes effect if the user
   * has NOT manually renamed the session. This guard lives here (not just in
   * the caller) so it's structurally impossible to bypass.
   */
  setAutoName(id, name) {
    const session = this.getSession(id);
    if (!session || session.nameLockedByUser) return session;
    this.db.prepare("UPDATE sessions SET name = ? WHERE id = ? AND name_locked_by_user = 0").run(name, id);
    return this.getSession(id);
  }
  setPinned(id, pinned) {
    this.db.prepare("UPDATE sessions SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
    return this.getSession(id);
  }
  setColor(id, color) {
    this.db.prepare("UPDATE sessions SET color = ? WHERE id = ?").run(color, id);
    return this.getSession(id);
  }
  setNotes(id, notes) {
    this.db.prepare("UPDATE sessions SET notes = ? WHERE id = ?").run(notes, id);
    return this.getSession(id);
  }
  setWorktreePath(id, worktreePath) {
    this.db.prepare("UPDATE sessions SET worktree_path = ? WHERE id = ?").run(worktreePath, id);
    return this.getSession(id);
  }
  /** Bumps persisted last-active time (session-startup-idle). */
  touchLastActive(id, at = (/* @__PURE__ */ new Date()).toISOString()) {
    this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(at, id);
  }
  /**
   * Adds `deltaUsd` to the session's running cost total (10a-enrichment-
   * cost-tracking). The caller (`SessionManager`'s `case 'result'`) is
   * responsible for computing `deltaUsd` as the NEW spend since this is not
   * simply the harness's own `totalCostUsd` — that field is cumulative for
   * the whole live SDK connection (verified for real against the SDK: see
   * `LiveStream.connectionCostUsd` in `manager.ts`), not a per-turn delta.
   * Passing the raw SDK value straight through here would double (or worse)
   * count every turn after the first on a multi-turn connection
   * (fix-session-cost-total-overcounted).
   */
  addCost(id, deltaUsd) {
    this.db.prepare("UPDATE sessions SET total_cost_usd = total_cost_usd + ? WHERE id = ?").run(deltaUsd, id);
    return this.getSession(id);
  }
  /**
   * Marks a session as having had at least one real, backend-confirmed
   * connection (fix-no-conversation-found-remote-resume) — called exactly
   * once the harness's `session_started` event (the SDK's own `system`/
   * `init` handshake) has actually fired for this session id, i.e. the
   * underlying CLI has genuinely acknowledged/created this conversation.
   * Idempotent (plain `= 1`, not a toggle) so repeat calls across multiple
   * turns are harmless.
   */
  markEverConnected(id) {
    this.db.prepare("UPDATE sessions SET ever_connected = 1 WHERE id = ?").run(id);
  }
  /** Marks that the next resume should show {@link TURN_INTERRUPTED_NOTICE} once (fix-app-quit-interrupted-turn-notice). */
  setPendingTurnInterruptedNotice(id) {
    this.db.prepare("UPDATE sessions SET pending_turn_interrupted_notice = 1 WHERE id = ?").run(id);
  }
  /**
   * Returns true if a pending interrupted-turn notice was set, and clears the
   * flag atomically so the notice is only ever delivered once per interrupt.
   */
  consumePendingTurnInterruptedNotice(id) {
    const row = this.db.prepare("SELECT pending_turn_interrupted_notice FROM sessions WHERE id = ?").get(id);
    if (!row || row.pending_turn_interrupted_notice !== 1) return false;
    this.db.prepare("UPDATE sessions SET pending_turn_interrupted_notice = 0 WHERE id = ?").run(id);
    return true;
  }
  /** Persists the session's current SDK permission mode (restore-mode-and-model-on-resume). Called at every site that updates the in-memory permissionModes Map. */
  setPermissionMode(id, mode) {
    this.db.prepare("UPDATE sessions SET permission_mode = ? WHERE id = ?").run(mode, id);
  }
  /** Persists the session's model/effort selection (restore-mode-and-model-on-resume). Null clears both columns. Called at every site that updates the in-memory modelSelections Map. */
  setModelSelection(id, selection) {
    this.db.prepare("UPDATE sessions SET model_id = ?, effort = ? WHERE id = ?").run(selection?.model ?? null, selection?.effort ?? null, id);
  }
  // ── Tags (06-session-organization) ───────────────────────────────────
  addTag(sessionId, tag) {
    const trimmed = tag.trim();
    if (trimmed) {
      this.db.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)").run(sessionId, trimmed);
    }
    return this.getSession(sessionId);
  }
  removeTag(sessionId, tag) {
    this.db.prepare("DELETE FROM session_tags WHERE session_id = ? AND tag = ?").run(sessionId, tag);
    return this.getSession(sessionId);
  }
  /** All distinct tags in use, for filter-suggestion UI. */
  listAllTags() {
    const rows = this.db.prepare("SELECT DISTINCT tag FROM session_tags ORDER BY tag ASC").all();
    return rows.map((r) => r.tag);
  }
  // ── Groups (06-session-organization) ─────────────────────────────────
  listGroups() {
    const rows = this.db.prepare("SELECT * FROM session_groups ORDER BY sort_order ASC, created_at ASC").all();
    return rows.map(toGroupRecord);
  }
  createGroup(name, id) {
    const groupId = id ?? node_crypto.randomUUID();
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const maxOrder = this.db.prepare("SELECT MAX(sort_order) as m FROM session_groups").get();
    this.db.prepare("INSERT INTO session_groups (id, name, sort_order, collapsed, created_at) VALUES (?, ?, ?, 0, ?)").run(groupId, name, (maxOrder.m ?? 0) + 1, createdAt);
    return toGroupRecord(
      this.db.prepare("SELECT * FROM session_groups WHERE id = ?").get(groupId)
    );
  }
  renameGroup(id, name) {
    this.db.prepare("UPDATE session_groups SET name = ? WHERE id = ?").run(name, id);
    const row = this.db.prepare("SELECT * FROM session_groups WHERE id = ?").get(id);
    return row ? toGroupRecord(row) : void 0;
  }
  setGroupCollapsed(id, collapsed) {
    this.db.prepare("UPDATE session_groups SET collapsed = ? WHERE id = ?").run(collapsed ? 1 : 0, id);
    const row = this.db.prepare("SELECT * FROM session_groups WHERE id = ?").get(id);
    return row ? toGroupRecord(row) : void 0;
  }
  /** Deletes a group and un-groups its member sessions (they fall back to "Ungrouped"), never deletes the sessions themselves. */
  deleteGroup(id) {
    const del = this.db.transaction(() => {
      this.db.prepare("UPDATE sessions SET group_id = NULL WHERE group_id = ?").run(id);
      this.db.prepare("DELETE FROM session_groups WHERE id = ?").run(id);
    });
    del();
  }
  reorderGroups(orderedIds) {
    const reorder = this.db.transaction(() => {
      orderedIds.forEach((id, index) => {
        this.db.prepare("UPDATE session_groups SET sort_order = ? WHERE id = ?").run(index, id);
      });
    });
    reorder();
    return this.listGroups();
  }
  setSessionGroup(sessionId, groupId) {
    this.db.prepare("UPDATE sessions SET group_id = ? WHERE id = ?").run(groupId, sessionId);
    return this.getSession(sessionId);
  }
  /**
   * Persists manual drag-drop order (06-session-organization) for a section
   * — pinned (groupId undefined), a specific group, or ungrouped (groupId
   * null) — by writing sequential `sort_order` values for the given ordered
   * id list. Also moves each session into `groupId` if it isn't already
   * there, so dragging a row into a different group's body both re-parents
   * and re-orders in one persisted write.
   */
  reorderSessions(groupId, orderedIds) {
    const reorder = this.db.transaction(() => {
      orderedIds.forEach((id, index) => {
        if (groupId !== void 0) {
          this.db.prepare("UPDATE sessions SET group_id = ?, sort_order = ? WHERE id = ?").run(groupId, index, id);
        } else {
          this.db.prepare("UPDATE sessions SET sort_order = ? WHERE id = ?").run(index, id);
        }
      });
    });
    reorder();
    return orderedIds.map((id) => this.getSession(id)).filter((s) => !!s);
  }
  /** Close: disappears from active/pinned view, auto-unpins, transcript stays for later resume. */
  closeSession(id) {
    this.db.prepare("UPDATE sessions SET closed_at = ?, pinned = 0 WHERE id = ?").run((/* @__PURE__ */ new Date()).toISOString(), id);
    return this.getSession(id);
  }
  setLinkedDailyTask(sessionId, taskGid, noteDate) {
    this.db.prepare(
      "UPDATE sessions SET linked_daily_task_gid = ?, linked_daily_note_date = ? WHERE id = ?"
    ).run(taskGid, noteDate, sessionId);
    return this.getSession(sessionId);
  }
  clearLinkedDailyTask(sessionId) {
    this.db.prepare("UPDATE sessions SET linked_daily_task_gid = NULL, linked_daily_note_date = NULL WHERE id = ?").run(sessionId);
    return this.getSession(sessionId);
  }
  /** Resume: clears closed_at so the session reappears in the active view. */
  reopenSession(id) {
    this.db.prepare("UPDATE sessions SET closed_at = NULL WHERE id = ?").run(id);
    return this.getSession(id);
  }
  /** Delete: hard-removes the session row AND all its message rows (distinct from Close). */
  deleteSession(id) {
    const del = this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)").run(id);
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
    del();
  }
  /** Fork/duplicate: copies full message history under a new id, same group. */
  forkSession(sourceId, opts) {
    const source = this.getSession(sourceId);
    if (!source) return void 0;
    const newId = opts?.id ?? node_crypto.randomUUID();
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const fork = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO sessions (id, name, name_locked_by_user, project_path, mode, hostname, group_id, pinned, color, created_at, closed_at, deleted_at, sort_order)
           VALUES (@id, @name, 0, @projectPath, @mode, @hostname, @groupId, 0, @color, @createdAt, NULL, NULL, @sortOrder)`
      ).run({
        id: newId,
        name: opts?.name ?? source.name,
        projectPath: source.projectPath,
        mode: source.mode,
        hostname: source.hostname,
        groupId: source.groupId,
        color: source.color,
        createdAt,
        sortOrder: Date.now()
      });
      const insertTag = this.db.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)");
      for (const tag of source.tags) insertTag.run(newId, tag);
      const messages = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC").all(sourceId);
      const insertMessage = this.db.prepare(
        `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, ?, ?, ?, ?)`
      );
      for (const m of messages) {
        const result = insertMessage.run(newId, m.role, m.content, m.raw_event, m.created_at);
        this.indexMessageForSearch({
          id: Number(result.lastInsertRowid),
          sessionId: newId,
          role: m.role,
          content: m.content
        });
      }
      this.db.prepare(
        `INSERT INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
           SELECT ?, path, first_touched_at, last_pending_at FROM session_touched_paths WHERE session_id = ?`
      ).run(newId, sourceId);
      this.db.prepare(
        `INSERT INTO session_cap_commits (session_id, hash, subject, committed_at, sort_order)
           SELECT ?, hash, subject, committed_at, sort_order FROM session_cap_commits WHERE session_id = ?`
      ).run(newId, sourceId);
      const srcCursor = this.db.prepare("SELECT last_head, baseline_head FROM session_git_cursor WHERE session_id = ?").get(sourceId);
      if (srcCursor) {
        this.db.prepare(
          `INSERT INTO session_git_cursor (session_id, last_head, baseline_head) VALUES (?, ?, ?)`
        ).run(newId, srcCursor.last_head, srcCursor.baseline_head);
      }
    });
    fork();
    return this.getSession(newId);
  }
  /**
   * Keeps `messages_fts` (10b-enrichment-full-text-search) in sync with one
   * message row: always deletes any prior indexed text for this id first
   * (simplest correct thing for both a first-time insert and an in-place
   * `updateMessage` edit — FTS5 doesn't support `INSERT OR REPLACE` on an
   * explicit rowid the way ordinary tables do), then re-inserts only if
   * `extractSearchableText` says this message has plain prose worth indexing
   * (plain user/assistant text — never tool-call JSON, todo/compaction
   * banners, prompt cards, or system rows).
   */
  indexMessageForSearch(message) {
    this.db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(message.id);
    const text = extractSearchableText(message.role, message.content);
    if (text === null) return;
    this.db.prepare("INSERT INTO messages_fts (rowid, text, session_id) VALUES (?, ?, ?)").run(message.id, text, message.sessionId);
  }
  addMessage(input) {
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const result = this.db.prepare(
      `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(
      input.sessionId,
      input.role,
      input.content,
      input.rawEvent !== void 0 ? JSON.stringify(input.rawEvent) : null,
      createdAt
    );
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(result.lastInsertRowid);
    const record = toMessageRecord(row);
    this.indexMessageForSearch(record);
    return record;
  }
  /**
   * In-place update of an existing message row (03-chat-surface-core): used
   * to (a) commit a streamed assistant text segment's final content once it
   * ends, and (b) flip a tool-call message's JSON content from `running` to
   * `completed`/`error` when its `tool_call_end` arrives — both cases keep
   * the "one row per message" model (no extra row for the terminal state).
   */
  updateMessage(id, input) {
    const existing = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    if (!existing) return void 0;
    const content = input.content !== void 0 ? input.content : existing.content;
    const rawEvent = input.rawEvent !== void 0 ? JSON.stringify(input.rawEvent) : existing.raw_event;
    this.db.prepare("UPDATE messages SET content = ?, raw_event = ? WHERE id = ?").run(content, rawEvent, id);
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    const record = toMessageRecord(row);
    this.indexMessageForSearch(record);
    return record;
  }
  listMessages(sessionId) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC").all(sessionId);
    return rows.map(toMessageRecord);
  }
  countMessages(sessionId) {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId);
    return row.c;
  }
  /**
   * Cross-session content search (10b-enrichment-full-text-search): matches
   * `query` against every indexed message's plain text via the `messages_fts`
   * FTS5 table, newest-relevance-first (`rank`), then hydrates each hit with
   * the surrounding session/message context the command palette needs to
   * render a result row and jump to it. Returns `[]` for a query with no
   * indexable tokens (see `toFtsMatchQuery`) rather than matching everything.
   *
   * Deliberately two queries, not one JOINed query: FTS5's `snippet()` aux
   * function requires its first argument to be the literal FTS5 table
   * reference for the row it's snippeting — verified live that this breaks
   * ("no such column: mf") the moment `messages_fts` is JOINed under an
   * alias, even though `rank`/`MATCH` against that same alias work fine. A
   * plain, unaliased, JOIN-free `messages_fts` query for the snippet, then a
   * second ordinary query for session/message metadata, sidesteps that
   * entirely.
   */
  searchMessages(query, limit = 20) {
    const match = toFtsMatchQuery(query);
    if (match === null) return [];
    const ftsRows = this.db.prepare(
      `SELECT rowid AS message_id, session_id, snippet(messages_fts, 0, ?, ?, '…', 10) AS snippet
         FROM messages_fts
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
    ).all(FTS_SNIPPET_START, FTS_SNIPPET_END, match, limit);
    if (ftsRows.length === 0) return [];
    const messageIds = ftsRows.map((r) => r.message_id);
    const placeholders = messageIds.map(() => "?").join(",");
    const metaRows = this.db.prepare(
      `SELECT msg.id AS message_id, msg.created_at AS created_at, s.name AS session_name
         FROM messages msg
         JOIN sessions s ON s.id = msg.session_id
         WHERE msg.id IN (${placeholders})`
    ).all(...messageIds);
    const metaByMessageId = new Map(metaRows.map((r) => [r.message_id, r]));
    return ftsRows.map((row) => {
      const meta = metaByMessageId.get(row.message_id);
      if (!meta) return null;
      return {
        sessionId: row.session_id,
        sessionName: meta.session_name,
        messageId: row.message_id,
        snippet: row.snippet,
        createdAt: meta.created_at
      };
    }).filter((hit) => hit !== null);
  }
  // ── Project path history (fix-bug-triage-jul31 / bug #49) ────────────
  /**
   * Records that `path` was just used to create a session on `hostId`
   * ('local' or a RemoteHostOption.id) — upserts so re-using an existing
   * path just bumps its `used_at` rather than creating a duplicate entry,
   * then prunes to the 10 most-recently-used paths for that host so the
   * table can't grow unbounded across a long-lived install.
   */
  recordProjectPathUsage(hostId, path) {
    const usedAt = (/* @__PURE__ */ new Date()).toISOString();
    const record = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO project_path_history (host_id, path, used_at) VALUES (?, ?, ?)
           ON CONFLICT (host_id, path) DO UPDATE SET used_at = excluded.used_at`
      ).run(hostId, path, usedAt);
      this.db.prepare(
        `DELETE FROM project_path_history
           WHERE host_id = ?
             AND path NOT IN (
               SELECT path FROM project_path_history
               WHERE host_id = ?
               ORDER BY used_at DESC
               LIMIT 10
             )`
      ).run(hostId, hostId);
    });
    record();
  }
  /** Most-recently-used project paths for `hostId`, newest first — capped at 10 by `recordProjectPathUsage`'s pruning. */
  listRecentProjectPaths(hostId) {
    const rows = this.db.prepare("SELECT path FROM project_path_history WHERE host_id = ? ORDER BY used_at DESC LIMIT 10").all(hostId);
    return rows.map((r) => r.path);
  }
  // ── Session changes cap (touched paths, commits, git cursor) ───────────
  registerSessionTouchedPath(sessionId, path, touchedAt) {
    this.db.prepare(
      `INSERT INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id, path) DO NOTHING`
    ).run(sessionId, path, touchedAt, touchedAt);
  }
  listSessionTouchedPaths(sessionId) {
    const rows = this.db.prepare(
      `SELECT path, first_touched_at, last_pending_at FROM session_touched_paths
         WHERE session_id = ? ORDER BY path ASC`
    ).all(sessionId);
    return rows.map((r) => ({
      path: r.path,
      firstTouchedAt: r.first_touched_at,
      lastPendingAt: r.last_pending_at
    }));
  }
  updateSessionTouchedPathPendingAt(sessionId, path, pendingAt) {
    this.db.prepare(`UPDATE session_touched_paths SET last_pending_at = ? WHERE session_id = ? AND path = ?`).run(pendingAt, sessionId, path);
  }
  getSessionGitCursor(sessionId) {
    const row = this.db.prepare("SELECT last_head, baseline_head FROM session_git_cursor WHERE session_id = ?").get(sessionId);
    if (!row) return null;
    return { lastHead: row.last_head, baselineHead: row.baseline_head };
  }
  upsertSessionGitCursor(sessionId, lastHead, baselineHead) {
    this.db.prepare(
      `INSERT INTO session_git_cursor (session_id, last_head, baseline_head) VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET last_head = excluded.last_head,
           baseline_head = COALESCE(session_git_cursor.baseline_head, excluded.baseline_head)`
    ).run(sessionId, lastHead, baselineHead);
  }
  insertSessionCapCommit(sessionId, hash, subject, committedAt, sortOrder) {
    this.db.prepare(
      `INSERT OR IGNORE INTO session_cap_commits (session_id, hash, subject, committed_at, sort_order)
         VALUES (?, ?, ?, ?, ?)`
    ).run(sessionId, hash, subject, committedAt, sortOrder);
  }
  listSessionCapCommits(sessionId) {
    const rows = this.db.prepare(
      `SELECT hash, subject, committed_at, sort_order FROM session_cap_commits
         WHERE session_id = ? ORDER BY sort_order DESC`
    ).all(sessionId);
    return rows.map((r) => ({
      hash: r.hash,
      subject: r.subject,
      committedAt: r.committed_at,
      sortOrder: r.sort_order
    }));
  }
  /** @deprecated v1 cap — use listSessionTouchedPaths + buildSessionChangesCap */
  listSessionFileEdits(sessionId) {
    return [];
  }
}
function shQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function shDoubleQuoteEscape(value) {
  return value.replace(/[\\"$`]/g, "\\$&");
}
function remoteCdTarget(cwd) {
  if (cwd === "~") {
    return '"$HOME"';
  }
  if (cwd.startsWith("~/")) {
    const rest = cwd.slice(2);
    return `"$HOME/${shDoubleQuoteEscape(rest)}"`;
  }
  return shQuote(cwd);
}
const SSH_MUX_OPTS = [
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=/tmp/atelier-ssh-%C",
  "-o",
  "ControlPersist=300"
];
const SSH_REMOTE_OPTS = [
  ...SSH_MUX_OPTS,
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new"
];
function sshExec(sshHost, remoteCmd, maxBuffer = 1024 * 1024 * 32) {
  return new Promise((resolve) => {
    node_child_process.execFile("ssh", [...SSH_REMOTE_OPTS, sshHost, "--", remoteCmd], { maxBuffer }, (err, stdout, stderr) => {
      const code = err?.code;
      resolve({ stdout, stderr, code: typeof code === "number" ? code : err ? 1 : 0 });
    });
  });
}
async function warmSshMux(sshHost) {
  const res = await sshExec(sshHost, "true");
  if (res.code !== 0) {
    logger.warn("ssh mux warm failed", { sshHost, stderr: res.stderr.trim().slice(0, 200) });
  }
}
const ALWAYS_IGNORED = /* @__PURE__ */ new Set([".git", "node_modules", ".DS_Store", ".claude"]);
const MAX_ENTRIES = 3e3;
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const HTML_EXTENSIONS = /* @__PURE__ */ new Set(["html", "htm"]);
const BINARY_EXTENSIONS = /* @__PURE__ */ new Set(["pdf", "zip", "gz", "tar", "exe", "dll", "so", "dylib", "woff", "woff2", "ttf", "mp4", "mp3", "wasm"]);
const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon"
};
function loadIgnoreMatchers(root) {
  const gitignorePath = node_path.join(root, ".gitignore");
  if (!node_fs.existsSync(gitignorePath)) return [];
  const lines = node_fs.readFileSync(gitignorePath, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.map((pattern) => {
    const dirOnly = pattern.endsWith("/");
    const clean = dirOnly ? pattern.slice(0, -1) : pattern;
    if (clean.startsWith("*.")) {
      const ext = clean.slice(2);
      return (relPath, isDir) => !isDir && relPath.split("/").pop()?.endsWith(`.${ext}`) === true;
    }
    return (relPath, isDir) => {
      const segments = relPath.split("/");
      const matches = segments.includes(clean);
      return dirOnly ? matches && isDir : matches;
    };
  });
}
function isIgnored(name, relPath, isDir, matchers) {
  if (ALWAYS_IGNORED.has(name)) return true;
  return matchers.some((m) => m(relPath, isDir));
}
function walkLocalDir(root, dir, matchers) {
  let entries;
  try {
    entries = node_fs.readdirSync(dir);
  } catch {
    return [];
  }
  const nodes = [];
  for (const name of entries.sort()) {
    const full = node_path.join(dir, name);
    const rel = node_path.relative(root, full);
    let stat;
    try {
      stat = node_fs.statSync(full);
    } catch {
      continue;
    }
    const isDir = stat.isDirectory();
    if (isIgnored(name, rel, isDir, matchers)) continue;
    nodes.push(
      isDir ? { name, path: full, relativePath: rel, type: "dir" } : { name, path: full, relativePath: rel, type: "file" }
    );
  }
  return nodes.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
}
function walkLocal(root) {
  const matchers = loadIgnoreMatchers(root);
  return walkLocalDir(root, root, matchers);
}
function walkLocalChildren(root, dir) {
  const matchers = loadIgnoreMatchers(root);
  return walkLocalDir(root, dir, matchers);
}
function collectLocalFiles(root, dir, matchers, out, count) {
  if (count.n >= MAX_ENTRIES) return;
  const nodes = walkLocalDir(root, dir, matchers);
  for (const node of nodes) {
    if (count.n >= MAX_ENTRIES) break;
    if (node.type === "file") {
      out.push({ name: node.name, path: node.path, relativePath: node.relativePath });
      count.n++;
    } else {
      collectLocalFiles(root, node.path, matchers, out, count);
    }
  }
}
function normalizeUnderWorkspace(workspaceRoot, underDir) {
  const root = workspaceRoot.replace(/\/$/, "");
  const dir = underDir.replace(/\/$/, "") || root;
  if (dir === "/") return "/";
  if (dir === root) return root;
  if (dir.startsWith(`${root}/`)) return dir;
  if (root.startsWith(`${dir}/`)) return dir;
  return root;
}
function listLocalWorkspaceFiles(workspaceRoot, underDir) {
  const root = workspaceRoot.replace(/\/$/, "");
  const startDir = normalizeUnderWorkspace(root, underDir ?? root);
  if (!node_fs.existsSync(startDir)) return [];
  const matchers = loadIgnoreMatchers(root);
  const out = [];
  collectLocalFiles(root, startDir, matchers, out, { n: 0 });
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}
function buildRemoteTree(root, findOutput) {
  const lines = findOutput.split("\n").filter((l) => l.length > 2);
  const nodeMap = /* @__PURE__ */ new Map();
  const childMap = /* @__PURE__ */ new Map();
  let count = 0;
  for (const line of lines) {
    if (count >= MAX_ENTRIES) break;
    const typeChar = line[0];
    const relPath = line.slice(2);
    if (!relPath) continue;
    const segments = relPath.split("/");
    const name = segments[segments.length - 1];
    if (ALWAYS_IGNORED.has(name)) continue;
    const absPath = `${root}/${relPath}`;
    const isDir = typeChar === "d";
    const node = {
      name,
      path: absPath,
      relativePath: relPath,
      type: isDir ? "dir" : "file",
      children: isDir ? [] : void 0
    };
    nodeMap.set(absPath, node);
    const parentRelPath = segments.slice(0, -1).join("/");
    const parentAbs = parentRelPath ? `${root}/${parentRelPath}` : root;
    if (!childMap.has(parentAbs)) childMap.set(parentAbs, []);
    childMap.get(parentAbs).push(node);
    count++;
  }
  for (const [parentAbs, kids] of childMap) {
    const parent = nodeMap.get(parentAbs);
    if (parent?.type === "dir") {
      parent.children = kids.sort(
        (a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
      );
    }
  }
  return (childMap.get(root) ?? []).sort(
    (a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
  );
}
async function walkRemote(root, sshHost) {
  const ignoredNames = [...ALWAYS_IGNORED].map((n) => `-name ${shQuote(n)}`).join(" -o ");
  const cmd = `cd ${remoteCdTarget(root)} && find . -maxdepth 1 \\( ${ignoredNames} \\) -prune -o -printf '%y %P\\n' 2>/dev/null`;
  const { stdout, code } = await sshExec(sshHost, cmd);
  logger.info("files:tree:remote:done", { root, sshHost, code, lines: stdout.split("\n").length });
  return buildRemoteTree(root, stdout);
}
async function walkRemoteChildren(root, dir, sshHost) {
  const ignoredNames = [...ALWAYS_IGNORED].map((n) => `-name ${shQuote(n)}`).join(" -o ");
  const cmd = `cd ${remoteCdTarget(dir)} && find . -maxdepth 1 \\( ${ignoredNames} \\) -prune -o -printf '%y %P\\n' 2>/dev/null`;
  const { stdout, code } = await sshExec(sshHost, cmd);
  logger.info("files:dir:remote:done", { root, dir, sshHost, code });
  return buildRemoteTree(dir, stdout);
}
async function listRemoteWorkspaceFiles(workspaceRoot, sshHost, underDir) {
  const root = workspaceRoot.replace(/\/$/, "");
  const startDir = normalizeUnderWorkspace(root, underDir ?? root);
  const ignoredNames = [...ALWAYS_IGNORED].map((n) => `-name ${shQuote(n)}`).join(" -o ");
  const cmd = `cd ${remoteCdTarget(startDir)} && find . \\( ${ignoredNames} \\) -prune -o -type f -print 2>/dev/null | head -n ${MAX_ENTRIES}`;
  const { stdout, code } = await sshExec(sshHost, cmd);
  logger.info("files:list:remote:done", { root, startDir, sshHost, code, lines: stdout.split("\n").length });
  const out = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ".") continue;
    const relFromStart = trimmed.replace(/^\.\//, "");
    if (!relFromStart) continue;
    const absPath = `${startDir}/${relFromStart}`;
    const relativePath = node_path.relative(root, absPath);
    const name = node_path.basename(relFromStart);
    out.push({ name, path: absPath, relativePath });
  }
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}
function walkFileTree(root, sshHost) {
  logger.info("files:tree", { root, remote: Boolean(sshHost) });
  if (sshHost) return walkRemote(root, sshHost);
  const result = walkLocal(root);
  logger.info("files:tree:done", { root, count: result.length });
  return result;
}
function walkDirChildren(root, dir, sshHost) {
  logger.info("files:dir", { root, dir, remote: Boolean(sshHost) });
  if (sshHost) return walkRemoteChildren(root, dir, sshHost);
  return walkLocalChildren(root, dir);
}
function listWorkspaceFiles(workspaceRoot, sshHost, underDir) {
  logger.info("files:list", { workspaceRoot, underDir, remote: Boolean(sshHost) });
  if (sshHost) return listRemoteWorkspaceFiles(workspaceRoot, sshHost, underDir ?? void 0);
  const result = listLocalWorkspaceFiles(workspaceRoot, underDir ?? void 0);
  logger.info("files:list:done", { workspaceRoot, underDir, count: result.length });
  return result;
}
async function readFileForPreview(path, sshHost) {
  const ext = node_path.extname(path).slice(1).toLowerCase();
  if (sshHost) {
    if (BINARY_EXTENSIONS.has(ext)) {
      return { kind: "binary", content: "", extension: ext };
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      const { stdout: stdout2 } = await sshExec(sshHost, `base64 ${shQuote(path)}`);
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
      return { kind: "image", content: `data:${mime};base64,${stdout2.replace(/\s/g, "")}`, extension: ext };
    }
    const { stdout } = await sshExec(sshHost, `cat ${shQuote(path)}`);
    if (HTML_EXTENSIONS.has(ext)) {
      return { kind: "html", content: stdout, extension: ext };
    }
    return { kind: "text", content: stdout, extension: ext || node_path.basename(path) };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    const buf = node_fs.readFileSync(path);
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    return { kind: "image", content: `data:${mime};base64,${buf.toString("base64")}`, extension: ext };
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    return { kind: "binary", content: "", extension: ext };
  }
  const text = node_fs.readFileSync(path, "utf-8");
  if (HTML_EXTENSIONS.has(ext)) {
    return { kind: "html", content: text, extension: ext };
  }
  return { kind: "text", content: text, extension: ext || node_path.basename(path) };
}
async function writeFileContent(path, content, sshHost) {
  if (sshHost) {
    return new Promise((resolve) => {
      const proc = node_child_process.spawn("ssh", [...SSH_MUX_OPTS, sshHost, "--", `cat > ${shQuote(path)}`]);
      proc.stdin.write(content, "utf8");
      proc.stdin.end();
      proc.on("close", (code) => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: `SSH write failed with exit code ${code}` });
      });
      proc.on("error", (err) => resolve({ ok: false, error: err.message }));
    });
  }
  try {
    node_fs.writeFileSync(path, content, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
function runGit(cwd, args, sshHost) {
  if (sshHost) {
    return (async () => {
      await warmSshMux(sshHost);
      const remote = `cd ${remoteCdTarget(cwd)} && git ${args.map(shQuote).join(" ")}`;
      return sshExec(sshHost, remote);
    })();
  }
  return new Promise((resolve) => {
    node_child_process.execFile("git", args, { cwd, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      const code = err?.code;
      resolve({ stdout, stderr, code: typeof code === "number" ? code : err ? 1 : 0 });
    });
  });
}
function normalizeDiffPath(raw) {
  let p = raw.trim();
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  const tab = p.indexOf("	");
  if (tab !== -1) p = p.slice(0, tab);
  return p;
}
const GIT_PATCH_CONFIG_ARGS = ["-c", "diff.external=", "-c", "core.quotepath=false"];
const GIT_NO_EXTERNAL_DIFF = ["--no-ext-diff", "--no-textconv"];
const repoRootCache = /* @__PURE__ */ new Map();
function repoRootCacheKey(projectPath, sshHost) {
  return `${sshHost ?? "local"}\0${projectPath}`;
}
async function resolveGitRepoRoot(projectPath, sshHost) {
  const key = repoRootCacheKey(projectPath, sshHost);
  const hit = repoRootCache.get(key);
  if (hit) return hit;
  const res = await runGit(projectPath, ["rev-parse", "--show-toplevel"], sshHost);
  const root = res.code === 0 && res.stdout.trim() ? res.stdout.trim() : projectPath;
  repoRootCache.set(key, root);
  return root;
}
function clearGitRepoRootCache(projectPath, sshHost) {
  repoRootCache.delete(repoRootCacheKey(projectPath, sshHost));
}
async function runGitAtRepoRoot(projectPath, args, sshHost) {
  const root = await resolveGitRepoRoot(projectPath, sshHost);
  return runGit(projectPath, ["-C", root, ...args], sshHost);
}
async function runGitDiffPatch(projectPath, args, sshHost) {
  return runGitAtRepoRoot(
    projectPath,
    [...GIT_PATCH_CONFIG_ARGS, "diff", ...GIT_NO_EXTERNAL_DIFF, ...args],
    sshHost
  );
}
async function runGitShowPatch(projectPath, args, sshHost) {
  return runGitAtRepoRoot(
    projectPath,
    [...GIT_PATCH_CONFIG_ARGS, "show", ...GIT_NO_EXTERNAL_DIFF, ...args],
    sshHost
  );
}
function gitPatchOutputUsable(code, stdout) {
  if (code === 2 || code > 2) return false;
  const t = stdout.trim();
  return t.length > 0 && (t.includes("diff --git") || t.includes("@@"));
}
function pickParsedDiffFile(parsed, filePath, gitPath) {
  const matchesPath = (f) => f.path === filePath || f.path === gitPath || f.oldPath === filePath || f.oldPath === gitPath || gitPath.length > 0 && (f.path.endsWith(`/${gitPath}`) || gitPath.endsWith(`/${f.path}`));
  const direct = parsed.find(matchesPath);
  if (direct?.hunks.length) return direct;
  const withHunks = parsed.filter((f) => f.hunks.length > 0);
  if (withHunks.length === 1) {
    const sole = withHunks[0];
    return { ...sole, path: filePath || gitPath || sole.path };
  }
  const hunksMatch = withHunks.find(matchesPath);
  if (hunksMatch) return { ...hunksMatch, path: filePath || gitPath || hunksMatch.path };
  return direct;
}
function numstatPathForGit(path) {
  const arrow = path.indexOf(" => ");
  return arrow === -1 ? path : path.slice(arrow + 4).trim();
}
function pickDefaultCommitFile(files) {
  const withStats = files.find((f) => f.additions > 0 || f.deletions > 0);
  return withStats?.path ?? files[0]?.path ?? null;
}
function parseNumstatLines(lines) {
  const files = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("	");
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...pathParts] = parts;
    const rawPath = pathParts.join("	");
    const path = numstatPathForGit(rawPath);
    const additions = addRaw === "-" ? 0 : parseInt(addRaw, 10) || 0;
    const deletions = delRaw === "-" ? 0 : parseInt(delRaw, 10) || 0;
    let status = "modified";
    if (additions > 0 && deletions === 0) status = "added";
    else if (additions === 0 && deletions > 0) status = "deleted";
    files.push({ path, status, additions, deletions, hunks: [] });
  }
  return files;
}
function parseUnifiedDiff(patch) {
  const files = [];
  const lines = patch.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git")) {
      i++;
      continue;
    }
    i++;
    let oldPath = "";
    let newPath = "";
    let status = "modified";
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git")) {
      const line = lines[i];
      if (line.startsWith("--- ")) oldPath = normalizeDiffPath(line.slice(4));
      else if (line.startsWith("+++ ")) newPath = normalizeDiffPath(line.slice(4));
      else if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename to ")) {
        status = "renamed";
        newPath = line.slice("rename to ".length);
      } else if (line.startsWith("rename from ")) {
        oldPath = line.slice("rename from ".length);
      }
      i++;
    }
    const path = newPath === "/dev/null" ? oldPath : newPath || oldPath;
    if (status === "modified" && oldPath && newPath && oldPath !== newPath) status = "renamed";
    if (newPath === "/dev/null") status = "deleted";
    if (oldPath === "/dev/null") status = "added";
    const hunks = [];
    let additions = 0;
    let deletions = 0;
    while (i < lines.length && lines[i].startsWith("@@")) {
      const header = lines[i];
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
      let oldLine = match ? parseInt(match[1], 10) : 0;
      let newLine = match ? parseInt(match[2], 10) : 0;
      i++;
      const hunkLines = [];
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git")) {
        const raw = lines[i];
        if (raw.startsWith("\\ No newline")) {
          i++;
          continue;
        }
        if (raw === "") {
          i++;
          continue;
        }
        if (raw.startsWith("+")) {
          hunkLines.push({ kind: "add", oldLine: null, newLine, content: raw.slice(1) });
          newLine++;
          additions++;
        } else if (raw.startsWith("-")) {
          hunkLines.push({ kind: "del", oldLine, newLine: null, content: raw.slice(1) });
          oldLine++;
          deletions++;
        } else {
          hunkLines.push({ kind: "context", oldLine, newLine, content: raw.slice(1) });
          oldLine++;
          newLine++;
        }
        i++;
      }
      hunks.push({ header, lines: hunkLines });
    }
    files.push({ path, oldPath: oldPath !== path ? oldPath : void 0, status, additions, deletions, hunks });
  }
  return files;
}
const EMPTY_TREE = "4b825dc642cb6eb6a060e54bf8d69288fbee4904";
const COMMIT_OPEN_FULL_PATCH_MAX_FILES = 40;
function repoKey(projectPath, sshHost) {
  return `${sshHost ?? "local"}\0${projectPath}`;
}
async function fetchWorkingTreeChanges(projectPath, sshHost) {
  const inside = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"], sshHost);
  if (inside.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, hasHead: false, files: [] };
  }
  const branchRes = await runGitAtRepoRoot(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"], sshHost);
  const branchRaw = branchRes.stdout.trim();
  const branch = branchRaw === "HEAD" || !branchRaw ? null : branchRaw;
  const hasHead = (await runGitAtRepoRoot(projectPath, ["rev-parse", "--verify", "HEAD"], sshHost)).code === 0;
  const diffTarget = hasHead ? "HEAD" : EMPTY_TREE;
  const numstat = await runGitAtRepoRoot(projectPath, ["diff", "--no-color", "--numstat", diffTarget], sshHost);
  const files = parseNumstatLines(numstat.stdout.split("\n"));
  const seen = new Set(files.map((f) => f.path));
  const untracked = await runGitAtRepoRoot(
    projectPath,
    ["ls-files", "--others", "--exclude-standard"],
    sshHost
  );
  for (const line of untracked.stdout.split("\n")) {
    const path = line.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push({ path, status: "added", additions: 0, deletions: 0, hunks: [] });
  }
  return { isRepo: true, branch, hasHead, files };
}
class GitRepositoryManager {
  cache = /* @__PURE__ */ new Map();
  inFlight = /* @__PURE__ */ new Map();
  commitDiffCache = /* @__PURE__ */ new Map();
  commitFileDiffCache = /* @__PURE__ */ new Map();
  commitCachePrefix(projectPath, sshHost) {
    return `${repoKey(projectPath, sshHost)}\0`;
  }
  dropCommitCachesForRepo(projectPath, sshHost) {
    const prefix = this.commitCachePrefix(projectPath, sshHost);
    for (const k of this.commitDiffCache.keys()) {
      if (k.startsWith(prefix)) this.commitDiffCache.delete(k);
    }
    for (const k of this.commitFileDiffCache.keys()) {
      if (k.startsWith(prefix)) this.commitFileDiffCache.delete(k);
    }
  }
  invalidate(projectPath, sshHost) {
    clearGitRepoRootCache(projectPath, sshHost);
    this.cache.delete(repoKey(projectPath, sshHost));
    this.dropCommitCachesForRepo(projectPath, sshHost);
  }
  async warmRemote(sshHost) {
    await warmSshMux(sshHost);
  }
  /** Cached repo membership — avoids running the full working-tree status script for commit history. */
  async ensureIsRepo(projectPath, sshHost) {
    const key = repoKey(projectPath, sshHost);
    const entry = this.cache.get(key);
    if (entry) return entry.summary.isRepo;
    const inside = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"], sshHost);
    return inside.code === 0 && inside.stdout.trim() === "true";
  }
  seedCommitOpenCaches(projectPath, commit, sshHost, parsed, firstPath) {
    const listFiles = parsed.map((f) => f.path === firstPath ? f : { ...f, hunks: [] });
    const listSummary = { isRepo: true, branch: null, files: listFiles.map((f) => ({ ...f, hunks: [] })) };
    const cacheKey = `${this.commitCachePrefix(projectPath, sshHost)}${commit}`;
    this.commitDiffCache.set(cacheKey, listSummary);
    const prefix = this.commitCachePrefix(projectPath, sshHost);
    for (const f of parsed) {
      this.commitFileDiffCache.set(`${prefix}${commit}\0${f.path}`, f);
    }
    return { isRepo: true, branch: null, files: listFiles };
  }
  /**
   * Open a commit in Diff › Commits: file list + first file hunks when cheap.
   * Skips working-tree refresh; small commits use a single `git show -U3`.
   */
  async loadCommitPanelOpen(projectPath, commit, sshHost) {
    const cacheKey = `${this.commitCachePrefix(projectPath, sshHost)}${commit}`;
    const cachedList = this.commitDiffCache.get(cacheKey);
    if (cachedList) {
      const firstPath2 = pickDefaultCommitFile(cachedList.files);
      if (!firstPath2) return cachedList;
      const file2 = await this.loadCommitFileDiff(projectPath, commit, firstPath2, sshHost);
      if (!file2) return cachedList;
      return {
        ...cachedList,
        files: cachedList.files.map((f) => f.path === firstPath2 ? file2 : f)
      };
    }
    if (!await this.ensureIsRepo(projectPath, sshHost)) {
      return { isRepo: false, branch: null, files: [] };
    }
    const res = await runGitAtRepoRoot(
      projectPath,
      ["show", "-m", "--first-parent", "--no-color", "--numstat", "--format=", commit],
      sshHost
    );
    if (res.code !== 0) return { isRepo: true, branch: null, files: [] };
    const files = parseNumstatLines(res.stdout.split("\n")).map((f) => ({ ...f, hunks: [] }));
    if (files.length === 0) {
      const empty = { isRepo: true, branch: null, files: [] };
      this.commitDiffCache.set(cacheKey, empty);
      return empty;
    }
    if (files.length <= COMMIT_OPEN_FULL_PATCH_MAX_FILES) {
      const full = await runGitShowPatch(
        projectPath,
        ["-m", "--first-parent", "--no-color", "-U3", "--format=", commit],
        sshHost
      );
      if (gitPatchOutputUsable(full.code, full.stdout)) {
        const parsed = parseUnifiedDiff(full.stdout);
        if (parsed.length > 0) {
          const firstPath2 = pickDefaultCommitFile(parsed);
          return this.seedCommitOpenCaches(projectPath, commit, sshHost, parsed, firstPath2);
        }
      }
    }
    const listSummary = { isRepo: true, branch: null, files };
    this.commitDiffCache.set(cacheKey, listSummary);
    const firstPath = pickDefaultCommitFile(files);
    if (!firstPath) return listSummary;
    const file = await this.loadCommitFileDiff(projectPath, commit, firstPath, sshHost);
    if (!file) return listSummary;
    return {
      ...listSummary,
      files: files.map((f) => f.path === firstPath ? file : f)
    };
  }
  async refreshChanges(projectPath, sshHost, force = false) {
    const key = repoKey(projectPath, sshHost);
    const cached2 = this.cache.get(key);
    if (!force && cached2 && Date.now() - cached2.fetchedAt < 2500) {
      return cached2.summary;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const work = (async () => {
      const parsed = await fetchWorkingTreeChanges(projectPath, sshHost);
      if (!parsed.isRepo) {
        const summary2 = { isRepo: false, branch: null, files: [] };
        this.cache.set(key, { summary: summary2, hasHead: false, commits: null, worktrees: null, fetchedAt: Date.now() });
        return summary2;
      }
      const summary = {
        isRepo: true,
        branch: parsed.branch,
        files: parsed.files.map((f) => ({ ...f, hunks: [] }))
      };
      this.cache.set(key, {
        summary,
        hasHead: parsed.hasHead,
        commits: cached2?.commits ?? null,
        worktrees: cached2?.worktrees ?? null,
        fetchedAt: Date.now()
      });
      return summary;
    })();
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }
  /** File list for a single commit (numstat; empty hunks until loadCommitFileDiff). */
  async loadCommitDiff(projectPath, commit, sshHost) {
    const cacheKey = `${this.commitCachePrefix(projectPath, sshHost)}${commit}`;
    const cached2 = this.commitDiffCache.get(cacheKey);
    if (cached2) return cached2;
    if (!await this.ensureIsRepo(projectPath, sshHost)) {
      return { isRepo: false, branch: null, files: [] };
    }
    const res = await runGitAtRepoRoot(
      projectPath,
      ["show", "-m", "--first-parent", "--no-color", "--numstat", "--format=", commit],
      sshHost
    );
    if (res.code !== 0) return { isRepo: true, branch: null, files: [] };
    const files = parseNumstatLines(res.stdout.split("\n")).map((f) => ({ ...f, hunks: [] }));
    const result = { isRepo: true, branch: null, files };
    this.commitDiffCache.set(cacheKey, result);
    return result;
  }
  mergeCommitFileStub(stub, parsed) {
    return {
      ...stub,
      ...parsed,
      path: stub.path,
      status: stub.status,
      additions: stub.additions || parsed.additions,
      deletions: stub.deletions || parsed.deletions,
      hunks: parsed.hunks
    };
  }
  async commitDiffParentBase(projectPath, commit, sshHost) {
    const parentRev = await runGit(projectPath, ["rev-parse", `${commit}^`], sshHost);
    return parentRev.code === 0 && parentRev.stdout.trim() ? `${commit}^` : EMPTY_TREE;
  }
  async loadCommitFileDiff(projectPath, commit, filePath, sshHost) {
    const cacheKey = `${this.commitCachePrefix(projectPath, sshHost)}${commit}\0${filePath}`;
    const cached2 = this.commitFileDiffCache.get(cacheKey);
    if (cached2) return cached2;
    const list = await this.loadCommitDiff(projectPath, commit, sshHost);
    const stub = list.files.find((f) => f.path === filePath);
    const gitPath = numstatPathForGit(filePath);
    const parseForFile = (stdout) => {
      const parsed2 = parseUnifiedDiff(stdout);
      return pickParsedDiffFile(parsed2, filePath, gitPath);
    };
    let parsed;
    const parentRev = await runGit(projectPath, ["rev-parse", `${commit}^`], sshHost);
    if (parentRev.code === 0 && parentRev.stdout.trim()) {
      const blobDiff = await runGitDiffPatch(
        projectPath,
        ["--no-color", "-U3", `${commit}^:${gitPath}`, `${commit}:${gitPath}`],
        sshHost
      );
      if (gitPatchOutputUsable(blobDiff.code, blobDiff.stdout)) {
        parsed = parseForFile(blobDiff.stdout);
      }
    }
    const base = await this.commitDiffParentBase(projectPath, commit, sshHost);
    if (!parsed?.hunks.length) {
      const diffRes = await runGitDiffPatch(
        projectPath,
        ["--no-color", "-U3", base, commit, "--", gitPath],
        sshHost
      );
      if (gitPatchOutputUsable(diffRes.code, diffRes.stdout)) {
        parsed = parseForFile(diffRes.stdout) ?? parsed;
      }
    }
    if (!parsed?.hunks.length) {
      const show = await runGitShowPatch(
        projectPath,
        ["-m", "--first-parent", "--no-color", "-U3", "--format=", commit, "--", gitPath],
        sshHost
      );
      if (gitPatchOutputUsable(show.code, show.stdout)) {
        parsed = parseForFile(show.stdout) ?? parsed;
      }
    }
    if (!parsed?.hunks.length) {
      const showPlain = await runGitShowPatch(
        projectPath,
        ["--no-color", "-U3", "--format=", commit, "--", gitPath],
        sshHost
      );
      if (gitPatchOutputUsable(showPlain.code, showPlain.stdout)) {
        parsed = parseForFile(showPlain.stdout) ?? parsed;
      }
    }
    let result;
    if (parsed?.hunks.length) {
      result = stub ? this.mergeCommitFileStub(stub, parsed) : parsed;
    } else {
      result = stub ? { ...stub, hunks: [] } : null;
    }
    if (result) this.commitFileDiffCache.set(cacheKey, result);
    return result;
  }
  async loadFileDiff(projectPath, filePath, sshHost) {
    const key = repoKey(projectPath, sshHost);
    const entry = this.cache.get(key);
    const hasHead = entry?.hasHead ?? (await runGitAtRepoRoot(projectPath, ["rev-parse", "--verify", "HEAD"], sshHost)).code === 0;
    const target = hasHead ? "HEAD" : EMPTY_TREE;
    const tracked = await runGitAtRepoRoot(projectPath, ["ls-files", "--error-unmatch", "--", filePath], sshHost);
    let diff = await runGitDiffPatch(projectPath, ["--no-color", "-U3", target, "--", filePath], sshHost);
    if (!gitPatchOutputUsable(diff.code, diff.stdout) && tracked.code !== 0) {
      diff = await runGitDiffPatch(projectPath, ["--no-color", "-U3", "--no-index", "/dev/null", filePath], sshHost);
    }
    if (!gitPatchOutputUsable(diff.code, diff.stdout)) {
      const stub = entry?.summary.files.find((f) => f.path === filePath);
      return stub ? { ...stub, hunks: [] } : null;
    }
    const parsed = parseUnifiedDiff(diff.stdout);
    const file = parsed[0];
    if (!file) {
      const stub = entry?.summary.files.find((f) => f.path === filePath);
      return stub ? { ...stub, hunks: [] } : null;
    }
    if (entry) {
      entry.summary = {
        ...entry.summary,
        files: entry.summary.files.map((f) => f.path === filePath ? { ...file, hunks: file.hunks } : f)
      };
    }
    return file;
  }
  async listCommits(projectPath, limit, sshHost, force = false) {
    const key = repoKey(projectPath, sshHost);
    const entry = this.cache.get(key);
    if (!force && entry?.commits) return entry.commits;
    const summary = entry?.summary ?? await this.refreshChanges(projectPath, sshHost);
    if (!summary.isRepo) return [];
    const head = entry?.hasHead ?? (await runGit(projectPath, ["rev-parse", "--verify", "HEAD"], sshHost)).code === 0;
    if (!head) return [];
    const res = await runGit(
      projectPath,
      ["log", `-n${limit}`, "--date=relative", "--pretty=format:%H%x1f%an%x1f%ad%x1f%s"],
      sshHost
    );
    if (res.code !== 0 || !res.stdout.trim()) return [];
    const commits = res.stdout.trim().split("\n").map((line) => {
      const [hash, author, date, message] = line.split("");
      return { hash, author, date, message };
    });
    if (entry) entry.commits = commits;
    return commits;
  }
  async listWorktrees(projectPath, sshHost, force = false) {
    const key = repoKey(projectPath, sshHost);
    const entry = this.cache.get(key);
    if (!force && entry?.worktrees) return entry.worktrees;
    const summary = entry?.summary ?? await this.refreshChanges(projectPath, sshHost);
    if (!summary.isRepo) return [];
    const res = await runGit(projectPath, ["worktree", "list", "--porcelain"], sshHost);
    if (res.code !== 0) return [];
    const worktrees = [];
    let current = null;
    for (const line of res.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current?.path) worktrees.push(current);
        current = { path: line.slice("worktree ".length), branch: "", head: "", isMain: worktrees.length === 0 && !current };
      } else if (line.startsWith("HEAD ")) {
        if (current) current.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        if (current) current.branch = line.slice("branch ".length).replace("refs/heads/", "");
      }
    }
    if (current?.path) worktrees.push(current);
    const list = worktrees.map((w, idx) => ({ ...w, isMain: idx === 0 }));
    if (entry) entry.worktrees = list;
    return list;
  }
  onMutatingGitOp(projectPath, sshHost) {
    this.invalidate(projectPath, sshHost);
  }
  async repoHasHead(projectPath, sshHost) {
    const key = repoKey(projectPath, sshHost);
    const entry = this.cache.get(key);
    if (entry != null) return entry.hasHead;
    return (await runGit(projectPath, ["rev-parse", "--verify", "HEAD"], sshHost)).code === 0;
  }
  /** Working tree vs HEAD (or empty tree) — for Diff › Expand file. */
  async loadWorkingTreeFilePair(projectPath, filePath, status, sshHost) {
    let original = "";
    if (status !== "added") {
      const hasHead = await this.repoHasHead(projectPath, sshHost);
      const ref = hasHead ? "HEAD" : EMPTY_TREE;
      const res = await runGit(projectPath, ["show", `${ref}:${filePath}`], sshHost);
      if (res.code === 0) original = res.stdout;
    }
    let modified = "";
    if (status !== "deleted") {
      const root = await resolveGitRepoRoot(projectPath, sshHost);
      const abs = node_path.join(root, filePath);
      const read = await readFileForPreview(abs, sshHost);
      if (read.kind !== "text" && read.kind !== "html") return null;
      modified = read.content;
    }
    return { original, modified };
  }
  /** Parent commit vs commit — for Diff › Commits › Expand file. */
  async loadCommitFilePair(projectPath, commit, filePath, status, sshHost) {
    const gitPath = numstatPathForGit(filePath);
    let original = "";
    const parent = await runGit(projectPath, ["show", `${commit}^:${gitPath}`], sshHost);
    if (parent.code === 0) original = parent.stdout;
    let modified = "";
    if (status !== "deleted") {
      const atCommit = await runGit(projectPath, ["show", `${commit}:${gitPath}`], sshHost);
      if (atCommit.code === 0) modified = atCommit.stdout;
      else return null;
    }
    if (status === "added" && !modified) return null;
    if (original.includes("\0") || modified.includes("\0")) return null;
    return { original, modified };
  }
}
const gitRepositories = new GitRepositoryManager();
async function getDiffSummary(projectPath, sshHost, force = false) {
  return gitRepositories.refreshChanges(projectPath, sshHost, force);
}
async function getFileDiff(projectPath, filePath, sshHost) {
  return gitRepositories.loadFileDiff(projectPath, filePath, sshHost);
}
async function getCommitDiff(projectPath, commit, sshHost) {
  return gitRepositories.loadCommitDiff(projectPath, commit, sshHost);
}
async function getCommitPanelOpen(projectPath, commit, sshHost) {
  return gitRepositories.loadCommitPanelOpen(projectPath, commit, sshHost);
}
async function getCommitFileDiff(projectPath, commit, filePath, sshHost) {
  return gitRepositories.loadCommitFileDiff(projectPath, commit, filePath, sshHost);
}
async function getWorkingTreeFilePair(projectPath, filePath, status, sshHost) {
  return gitRepositories.loadWorkingTreeFilePair(projectPath, filePath, status, sshHost);
}
async function getCommitFilePair(projectPath, commit, filePath, status, sshHost) {
  return gitRepositories.loadCommitFilePair(projectPath, commit, filePath, status, sshHost);
}
async function listCommits(projectPath, limit = 50, sshHost, force = false) {
  return gitRepositories.listCommits(projectPath, limit, sshHost, force);
}
async function listWorktrees(projectPath, sshHost, force = false) {
  return gitRepositories.listWorktrees(projectPath, sshHost, force);
}
async function addWorktree(projectPath, worktreePath, branch, sshHost) {
  const res = await runGit(projectPath, ["worktree", "add", "-b", branch, worktreePath], sshHost);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git worktree add failed");
  gitRepositories.onMutatingGitOp(projectPath, sshHost);
}
async function removeWorktree$1(projectPath, worktreePath, sshHost) {
  const res = await runGit(projectPath, ["worktree", "remove", worktreePath, "--force"], sshHost);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git worktree remove failed");
  gitRepositories.onMutatingGitOp(projectPath, sshHost);
}
async function mergeWorktreeBranch(projectPath, branch, sshHost) {
  const res = await runGit(projectPath, ["merge", "--no-edit", branch], sshHost);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git merge failed");
  gitRepositories.onMutatingGitOp(projectPath, sshHost);
}
async function warmRemoteGitHost(sshHost) {
  await gitRepositories.warmRemote(sshHost);
}
async function getGitBranch(projectPath, sshHost) {
  const verify = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"], sshHost);
  if (verify.code !== 0 || verify.stdout.trim() !== "true") return null;
  const r = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"], sshHost);
  if (r.code !== 0) return null;
  const name = r.stdout.trim();
  if (!name || name === "HEAD") return null;
  return name;
}
async function resolveHead(projectPath, sshHost) {
  const verify = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"], sshHost);
  if (verify.code !== 0 || verify.stdout.trim() !== "true") return null;
  const r = await runGit(projectPath, ["rev-parse", "HEAD"], sshHost);
  if (r.code !== 0) return null;
  const hash = r.stdout.trim();
  return hash || null;
}
async function getPathWorkingTreeNumstat(projectPath, filePath, sshHost) {
  const hasHead = (await runGit(projectPath, ["rev-parse", "--verify", "HEAD"], sshHost)).code === 0;
  const target = hasHead ? "HEAD" : EMPTY_TREE;
  let additions = 0;
  let deletions = 0;
  for (const args of [
    ["diff", "--no-color", "--numstat", target, "--", filePath],
    ["diff", "--no-color", "--numstat", "--cached", "--", filePath]
  ]) {
    const r = await runGit(projectPath, args, sshHost);
    if (r.code !== 0) continue;
    for (const f of parseNumstatLines(r.stdout.split("\n"))) {
      additions += f.additions;
      deletions += f.deletions;
    }
  }
  if (additions === 0 && deletions === 0) return null;
  return { additions, deletions };
}
async function listCommitsInRange(projectPath, oldHead, newHead, sshHost) {
  const r = await runGit(
    projectPath,
    ["log", "--format=%H%x09%s%x09%ct", `${oldHead}..${newHead}`],
    sshHost
  );
  if (r.code !== 0) return [];
  const out = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [hash, subject, ct] = line.split("	");
    if (!hash || !subject) continue;
    const sec = parseInt(ct ?? "0", 10);
    out.push({
      hash,
      subject,
      committedAt: Number.isFinite(sec) ? new Date(sec * 1e3).toISOString() : (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  return out;
}
async function listCommitChangedPaths(projectPath, commit, sshHost) {
  const r = await runGit(projectPath, ["show", "--name-only", "--pretty=format:", commit], sshHost);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((p) => p.trim()).filter(Boolean);
}
async function latestReflogSubject(projectPath, sshHost) {
  const r = await runGit(projectPath, ["reflog", "-1", "--format=%gs"], sshHost);
  return r.stdout.trim();
}
const FILE_EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function isSessionFileEditTool(name) {
  return FILE_EDIT_TOOLS.has(name);
}
function asRecord$1(value) {
  return value && typeof value === "object" ? value : {};
}
function filePathsForFileEditTool(name, input) {
  if (!isSessionFileEditTool(name)) return [];
  const obj = asRecord$1(input);
  const filePath = obj.file_path;
  if (typeof filePath === "string" && filePath.length > 0) return [filePath];
  return [];
}
function normalizeToRepoRelativePath(filePath, workspaceRoot) {
  const root = node_path.resolve(workspaceRoot);
  const normalized = filePath.replace(/\\/g, "/");
  if (!node_path.isAbsolute(normalized)) {
    const rel = normalized.replace(/^\.\//, "");
    const abs2 = node_path.resolve(root, rel);
    const fromRoot = node_path.relative(root, abs2);
    if (fromRoot.startsWith("..") || fromRoot === "") return null;
    return fromRoot.split(/\\/g).join("/");
  }
  const abs = node_path.resolve(normalized);
  if (abs === root || abs.startsWith(root + "/")) {
    return node_path.relative(root, abs).split(/\\/g).join("/");
  }
  const stripLead = normalized.replace(/^\//, "");
  if (stripLead && !stripLead.includes("..")) {
    const underRoot = node_path.resolve(root, stripLead);
    if (underRoot === root || underRoot.startsWith(root + "/")) {
      return node_path.relative(root, underRoot).split(/\\/g).join("/");
    }
  }
  return null;
}
function isPullLikeReflog(subject) {
  const s = subject.toLowerCase();
  if (s.includes("pull")) return true;
  if (s.includes("fetch") && (s.includes("merge") || s.includes("fast-forward"))) return true;
  return false;
}
function registerTouchedPathFromToolCall(store2, sessionId, workspaceRoot, toolName, input) {
  if (!isSessionFileEditTool(toolName)) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const rawPath of filePathsForFileEditTool(toolName, input)) {
    const path = normalizeToRepoRelativePath(rawPath, workspaceRoot);
    if (!path) continue;
    store2.registerSessionTouchedPath(sessionId, path, now);
  }
}
async function syncSessionGitCursor(store2, sessionId, workspacePath, hostname) {
  const head = await resolveHead(workspacePath, hostname);
  if (!head) return;
  const cursor = store2.getSessionGitCursor(sessionId);
  if (!cursor?.baselineHead) {
    store2.upsertSessionGitCursor(sessionId, head, head);
    return;
  }
  if (!cursor.lastHead) {
    store2.upsertSessionGitCursor(sessionId, head, cursor.baselineHead);
  }
}
async function processHeadAdvanceIfNeeded(store2, sessionId, workspacePath, hostname) {
  const newHead = await resolveHead(workspacePath, hostname);
  if (!newHead) return;
  let cursor = store2.getSessionGitCursor(sessionId);
  if (!cursor) {
    store2.upsertSessionGitCursor(sessionId, newHead, newHead);
    return;
  }
  const oldHead = cursor.lastHead ?? cursor.baselineHead;
  if (!oldHead || oldHead === newHead) {
    if (cursor.lastHead !== newHead) store2.upsertSessionGitCursor(sessionId, newHead, cursor.baselineHead ?? newHead);
    return;
  }
  const reflog = await latestReflogSubject(workspacePath, hostname);
  if (!isPullLikeReflog(reflog)) {
    const touched = new Set(store2.listSessionTouchedPaths(sessionId).map((r) => r.path));
    if (touched.size > 0) {
      const commits = await listCommitsInRange(workspacePath, oldHead, newHead, hostname);
      let order = Date.now();
      for (const c of commits) {
        const files = await listCommitChangedPaths(workspacePath, c.hash, hostname);
        const hits = files.some((f) => touched.has(f));
        if (!hits) continue;
        store2.insertSessionCapCommit(sessionId, c.hash, c.subject, c.committedAt, order);
        order += 1;
      }
    }
  }
  store2.upsertSessionGitCursor(sessionId, newHead, cursor.baselineHead ?? oldHead);
}
async function buildSessionChangesCap(store2, sessionId, workspacePath, hostname) {
  const paths = store2.listSessionTouchedPaths(sessionId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const fileItems = [];
  for (const row of paths) {
    const stats = await getPathWorkingTreeNumstat(workspacePath, row.path, hostname);
    if (!stats) continue;
    const sortAt = now;
    store2.updateSessionTouchedPathPendingAt(sessionId, row.path, sortAt);
    fileItems.push({
      kind: "file",
      path: row.path,
      additions: stats.additions,
      deletions: stats.deletions,
      sortAt
    });
  }
  const commitRows = store2.listSessionCapCommits(sessionId);
  const commitItems = commitRows.map((c) => ({
    kind: "commit",
    hash: c.hash,
    subject: c.subject,
    sortAt: c.committedAt
  }));
  const items = [...fileItems, ...commitItems].sort((a, b) => {
    if (a.sortAt === b.sortAt) return a.kind === "file" ? -1 : 1;
    return a.sortAt > b.sortAt ? -1 : 1;
  });
  return { items };
}
async function refreshSessionChangesCap(store2, sessionId, workspacePath, hostname, opts) {
  await syncSessionGitCursor(store2, sessionId, workspacePath, hostname);
  if (opts?.processHead !== false) {
    await processHeadAdvanceIfNeeded(store2, sessionId, workspacePath, hostname);
  }
  return buildSessionChangesCap(store2, sessionId, workspacePath, hostname);
}
async function handleFileEditToolCompleted(store2, sessionId, workspaceRoot, workspacePath, hostname, toolName, input) {
  registerTouchedPathFromToolCall(store2, sessionId, workspaceRoot, toolName, input);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const rawPath of filePathsForFileEditTool(toolName, input)) {
    const path = normalizeToRepoRelativePath(rawPath, workspaceRoot);
    if (!path) continue;
    store2.updateSessionTouchedPathPendingAt(sessionId, path, now);
  }
  return refreshSessionChangesCap(store2, sessionId, workspacePath, hostname, { processHead: false });
}
function rebuildSessionTouchedPathsFromMessages(store2, sessionId, workspaceRoot) {
  const messages = store2.listMessages(sessionId);
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const structured = parseStructuredContent(message.content);
    if (structured?.kind !== "tool_call") continue;
    const content = structured;
    if (content.status !== "completed") continue;
    registerTouchedPathFromToolCall(store2, sessionId, workspaceRoot, content.name, content.input);
  }
}
let db;
function tableHasColumn(database, table, column) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
const MIGRATIONS = [
  {
    name: "0001_sessions_and_messages",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_locked_by_user INTEGER NOT NULL DEFAULT 0,
        project_path TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('terminal', 'claude-code')),
        hostname TEXT,
        group_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_event TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_closed_at ON sessions(closed_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id);
    `
  },
  {
    // 06-session-organization: tags (free-form, many-to-many via join table),
    // notes (freeform text per session), a real `session_groups` table
    // (group_id on `sessions` previously held an arbitrary caller-chosen
    // string used directly as the display label — now it's a foreign id into
    // this table, with its own name/order/collapsed state), and a
    // `sort_order` column on `sessions` for manual drag-drop ordering within
    // a group (or within the ungrouped/pinned sections).
    name: "0002_tags_notes_groups_ordering",
    sql: `
      ALTER TABLE sessions ADD COLUMN notes TEXT;
      ALTER TABLE sessions ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (session_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    // 10a-enrichment-cost-tracking: running per-session dollar total, sourced
    // exclusively from the SDK's own `result` event's `totalCostUsd` (see
    // HarnessEvent's 'result' variant) — persisted so it survives relaunch.
    name: "0003_session_cost_tracking",
    sql: `
      ALTER TABLE sessions ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0;
    `
  },
  {
    // 10b-enrichment-full-text-search: an FTS5 virtual table over each
    // message's plain searchable text (see shared/chat-content.ts's
    // `extractSearchableText` — user/assistant plain text only, never raw
    // tool-call JSON or other structured-content rows). NOT an "external
    // content" FTS5 table: rows are inserted/updated/deleted explicitly by
    // `SessionStore` (using `rowid = messages.id`) exactly when a message is
    // written, rather than via SQL triggers mirroring `messages` verbatim —
    // that's the only way to apply `extractSearchableText`'s JS-side
    // filtering (skip system rows, skip structured JSON) before indexing.
    // Used by `SessionStore.searchMessages` for the cross-session content
    // search surfaced in the command palette's "Session" results.
    name: "0004_message_full_text_search",
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        session_id UNINDEXED,
        tokenize = 'unicode61'
      );
    `
  },
  {
    // fix-bug-triage-jul31 / bug #49: remembers recently-used project paths
    // per host so the New Session modal can offer them again on reopen,
    // instead of NewSessionModal's `isOpen` effect unconditionally wiping
    // `projectPath` back to null every time it opens. Keyed on (host_id,
    // path) so re-using an existing path is an upsert (bumps `used_at`,
    // never duplicates) rather than growing unbounded — pruning to the 10
    // most recent per host happens in SessionStore.recordProjectPathUsage.
    name: "0005_project_path_history",
    sql: `
      CREATE TABLE IF NOT EXISTS project_path_history (
        host_id TEXT NOT NULL,
        path TEXT NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (host_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_project_path_history_host_used ON project_path_history(host_id, used_at);
    `
  },
  {
    // fix-no-conversation-found-remote-resume: persisted, cross-relaunch
    // record of whether the underlying harness/CLI has EVER actually
    // confirmed a real conversation for this session id (i.e. its `system`/
    // `init` handshake — HarnessEvent's `session_started` — has actually
    // fired at least once; see SessionStore.markEverConnected). A session
    // created via `harness.start()` with no initial prompt sits in
    // `SessionManager.sessions` looking "live" (`harness.isActive()` is
    // true) but the underlying CLI never emits `session_started` until it
    // actually receives its first real input — so `everConnected` can be
    // `false` even for a session with an open, active harness connection.
    // Verified for real: reconnect()/sendUserMessage() previously called
    // `harness.resume()` (a `--resume <id>` reconnect) unconditionally for
    // ANY session with no currently-active in-memory harness entry,
    // including one that had never gotten this far — the underlying `claude`
    // CLI has no record of a session id it was never actually asked to
    // start, and rejects the resume with "No conversation found with session
    // ID: <id>" (root cause of the recurring "Claude Code process exited
    // with code 255" bug, both locally and on remote/SSH hosts). Defaults to
    // 0 (false) for both new and pre-existing rows — a pre-existing row from
    // before this migration necessarily already has real transcript history
    // (it could only exist by having gone through a real turn under the
    // pre-fix code), so `everConnected` is backfilled to 1 for any session
    // with at least one persisted message, since resuming those is safe and
    // was already working.
    name: "0006_session_ever_connected",
    sql: `
      ALTER TABLE sessions ADD COLUMN ever_connected INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET ever_connected = 1
        WHERE id IN (SELECT DISTINCT session_id FROM messages);
    `
  },
  {
    // restore-mode-and-model-on-resume: persists the session's current SDK
    // permission mode and model/effort selection to SQLite so both survive
    // an app relaunch and are restored when the user resumes a session.
    // `permission_mode` mirrors the in-memory `permissionModes` Map and
    // defaults to 'default' (the SDK's own default) for pre-existing rows.
    // `model_id` and `effort` mirror the in-memory `modelSelections` Map;
    // both are nullable since a session that was never sent a message has
    // no stored model override.
    name: "0007_session_mode_model",
    sql: `
      ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE sessions ADD COLUMN model_id TEXT;
      ALTER TABLE sessions ADD COLUMN effort TEXT;
    `
  },
  {
    // use-worktree: optional isolated git worktree per session. When the
    // user enables "Use worktree" in the New Session modal for a local
    // claude-code session, Atelier creates a git worktree at
    // `<worktreeRoot>/<session-id>` (config, default `~/.atelier/worktrees`) on a new branch
    // `atelier-<session-id-prefix>`, runs Claude Code inside that
    // worktree path instead of the original project path, and removes both
    // the worktree directory and its branch when the session is deleted.
    // Null for sessions that were not created with useWorktree, or for
    // remote/terminal sessions where worktrees are out of scope.
    name: "0008_session_worktree",
    sql: `
      ALTER TABLE sessions ADD COLUMN worktree_path TEXT;
    `
  },
  {
    // fix-app-quit-interrupted-turn-notice: set when Atelier closes or quits
    // while a turn is in flight (`live.busy`); consumed once on the next
    // resume/relaunch transcript load to insert a plain-language system
    // notice (not a raw SDK "process exited" error).
    name: "0009_pending_turn_interrupted_notice",
    sql: `
      ALTER TABLE sessions ADD COLUMN pending_turn_interrupted_notice INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    name: "0010_app_notes",
    sql: `
      CREATE TABLE IF NOT EXISTS app_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_app_notes_sort ON app_notes(sort_order);
    `
  },
  {
    // session-startup-idle: when the user last interacted with a session
    // (select or send). Backfilled from the latest message timestamp, else
    // `created_at`, so existing rows are usable immediately after migrate.
    name: "0011_session_last_active_at",
    run(database) {
      if (!tableHasColumn(database, "sessions", "last_active_at")) {
        database.exec(`ALTER TABLE sessions ADD COLUMN last_active_at TEXT;`);
      }
      database.exec(`
        UPDATE sessions SET last_active_at = COALESCE(
          (SELECT MAX(created_at) FROM messages WHERE messages.session_id = sessions.id),
          created_at
        )
        WHERE last_active_at IS NULL;
      `);
    }
  },
  {
    name: "0012_session_linked_daily_task",
    run(database) {
      if (!tableHasColumn(database, "sessions", "linked_daily_task_gid")) {
        database.exec(`ALTER TABLE sessions ADD COLUMN linked_daily_task_gid TEXT;`);
      }
      if (!tableHasColumn(database, "sessions", "linked_daily_note_date")) {
        database.exec(`ALTER TABLE sessions ADD COLUMN linked_daily_note_date TEXT;`);
      }
    }
  },
  {
    // chat changes cap: persisted rollups of Edit/Write/MultiEdit/NotebookEdit
    // tool calls per session (survives reconnect/relaunch); superseded by 0014.
    name: "0013_session_file_edits",
    sql: `
      CREATE TABLE IF NOT EXISTS session_file_edits (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_session_file_edits_session ON session_file_edits(session_id);
    `
  },
  {
    name: "0014_session_changes_cap_v2",
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS session_touched_paths (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          first_touched_at TEXT NOT NULL,
          last_pending_at TEXT,
          PRIMARY KEY (session_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_session_touched_paths_session ON session_touched_paths(session_id);

        CREATE TABLE IF NOT EXISTS session_cap_commits (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          hash TEXT NOT NULL,
          subject TEXT NOT NULL,
          committed_at TEXT NOT NULL,
          sort_order REAL NOT NULL,
          PRIMARY KEY (session_id, hash)
        );
        CREATE INDEX IF NOT EXISTS idx_session_cap_commits_session ON session_cap_commits(session_id);

        CREATE TABLE IF NOT EXISTS session_git_cursor (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          last_head TEXT,
          baseline_head TEXT
        );

        INSERT OR IGNORE INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
          SELECT session_id, path, updated_at, updated_at FROM session_file_edits;

        DROP TABLE IF EXISTS session_file_edits;
      `);
      const store2 = new SessionStore(database);
      const sessions = database.prepare("SELECT id, project_path, worktree_path FROM sessions").all();
      for (const session of sessions) {
        const workspace = session.worktree_path ?? session.project_path;
        rebuildSessionTouchedPathsFromMessages(store2, session.id, workspace);
      }
    }
  },
  {
    name: "0015_weekly_plan_drafts",
    sql: `
      CREATE TABLE IF NOT EXISTS weekly_plan_drafts (
        iso_week TEXT PRIMARY KEY,
        step INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  }
];
function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    database.prepare("SELECT name FROM migrations").all().map((row) => row.name)
  );
  const insertMigration = database.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)");
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const runOne = database.transaction(() => {
      if (migration.run) migration.run(database);
      else if (migration.sql) database.exec(migration.sql);
      else throw new Error(`migration ${migration.name} has no sql or run`);
      insertMigration.run(migration.name, (/* @__PURE__ */ new Date()).toISOString());
    });
    runOne();
    logger.info("database migration applied", { name: migration.name });
  }
}
function openDatabase() {
  if (db) return db;
  const dataDir = node_path.join(electron.app.getPath("userData"), "data");
  node_fs.mkdirSync(dataDir, { recursive: true });
  migrateLegacyGardeniaDatabaseFile(dataDir);
  const dbPath = node_path.join(dataDir, "atelier.sqlite");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  runGardeniaToAtelierWorktreeMigration(db);
  runHistoricalCostBackfill(db);
  logger.info("database opened", { dbPath });
  return db;
}
function closeDatabase() {
  if (db) {
    db.close();
    db = void 0;
  }
}
function mintTaskId() {
  return globalThis.crypto.randomUUID();
}
function getTaskIds(note) {
  return new Set(note.tasks.map((t) => t.id));
}
const STATUS_CHAR_TO_STATUS = {
  " ": "open",
  x: "done",
  ">": "forwarded",
  "/": "in-progress",
  "-": "cancelled"
};
const STATUS_TO_CHAR = {
  open: " ",
  done: "x",
  forwarded: ">",
  "in-progress": "/",
  cancelled: "-"
};
const TASK_RE = /^(\s*)- \[(.)\]\s+(.*)$/;
const PLAIN_BULLET_RE = /^(\s*)-\s+(.+)$/;
function parseBulletLine(line, sectionHint, isDelegatedSection, allowPlainBullet) {
  const taskMatch = line.match(TASK_RE);
  let rest;
  let status = "open";
  let isNote = false;
  if (taskMatch) {
    status = STATUS_CHAR_TO_STATUS[taskMatch[2]] ?? "open";
    rest = taskMatch[3];
  } else {
    const plainMatch = line.match(PLAIN_BULLET_RE);
    if (!plainMatch || !plainMatch[2].trim()) return null;
    rest = plainMatch[2];
    isNote = true;
  }
  let remaining = rest;
  let timeBlock;
  const timeMatch = remaining.match(/^(\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2})\s+/);
  if (timeMatch) {
    timeBlock = timeMatch[1].replace(/\s+/g, "");
    remaining = remaining.slice(timeMatch[0].length);
  }
  const metadata = {};
  remaining = remaining.replace(/\[(\w+)::\s*([^\]]*)\]/g, (_m, key, value) => {
    metadata[key] = value.trim();
    return "";
  });
  const externalLinks = [];
  remaining = remaining.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_m, label, url) => {
      externalLinks.push({ label, url });
      return "";
    }
  );
  const tags = [];
  remaining = remaining.replace(/#[\w/]+/g, (tag) => {
    tags.push(tag);
    return "";
  });
  let delegatedTo;
  const delegatedMatch = remaining.match(/\s+—\s+(\S.*)$/);
  if (delegatedMatch) {
    delegatedTo = delegatedMatch[1].trim();
    remaining = remaining.slice(0, delegatedMatch.index);
  }
  if (isDelegatedSection && !tags.includes("#delegated")) {
    tags.push("#delegated");
  }
  const text = remaining.trim();
  const isTracker = sectionHint === "tracker" || tags.includes("#tracker");
  const section = sectionHint;
  const hadGid = metadata.gid !== void 0 && metadata.gid.length > 0;
  const gid = hadGid ? metadata.gid : mintTaskId();
  return {
    task: {
      id: gid,
      gid,
      text,
      status,
      section,
      tags,
      scheduled: metadata.scheduled,
      completion: metadata.completion,
      due: metadata.due,
      timeBlock,
      externalLinks,
      delegatedTo,
      isTracker,
      isNote,
      linkedSessionId: metadata.session,
      priority: metadata.priority
    },
    mintedGid: !hadGid
  };
}
function detectSection(line) {
  const trimmed = line.trim();
  if (/^##\s+.*(Big\s*Three|Day\s*Plan)/i.test(trimmed)) return "big-three";
  if (/^##\s+.*Tasks/i.test(trimmed)) return "tasks";
  if (/^###\s+.*Backlog/i.test(trimmed)) return "backlog";
  if (/^###\s+.*Delegated/i.test(trimmed)) return "delegated";
  if (/^##\s+.*(Retro|Claude\s*Log|Notes)/i.test(trimmed)) return "after-tasks";
  if (/>\s*\[!invisible]\s*Trackers/i.test(trimmed)) return "trackers";
  return null;
}
const NOTES_SECTION_HEADING_RE = /^##\s+.*Notes/i;
const DEFAULT_NOTES_SECTION_HEADING = "## 📝 Notes";
function extractNotesBodyFromAfterTasks(afterTasks) {
  const idx = afterTasks.findIndex((line) => NOTES_SECTION_HEADING_RE.test(line.trim()));
  if (idx === -1) {
    return { prefixBeforeNotes: [...afterTasks], notesBody: "", notesHeadingLine: null };
  }
  const notesHeadingLine = afterTasks[idx].trimEnd();
  const rest = afterTasks.slice(idx + 1);
  let start = 0;
  while (start < rest.length && rest[start].trim() === "") start++;
  const notesBody = rest.slice(start).join("\n").replace(/\n$/, "");
  return { prefixBeforeNotes: afterTasks.slice(0, idx), notesBody, notesHeadingLine };
}
function mergeNotesBodyIntoAfterTasks(afterTasks, notesBody) {
  const { prefixBeforeNotes, notesHeadingLine } = extractNotesBodyFromAfterTasks(afterTasks);
  const prefix = [...prefixBeforeNotes];
  while (prefix.length > 0 && prefix[prefix.length - 1].trim() === "") prefix.pop();
  const heading = notesHeadingLine ?? DEFAULT_NOTES_SECTION_HEADING;
  const block = [heading, ""];
  const normalized = notesBody.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (normalized) block.push(...normalized.split("\n"));
  if (prefix.length === 0) return block;
  return [...prefix, "", ...block, ""];
}
function parseDailyNote(content, date) {
  const lines = content.split("\n");
  const tasks = [];
  const mintedIds = [];
  const bigThreeItems = [];
  const raw = { frontmatter: [], beforeTasks: [], afterTasks: [] };
  let currentSection = "frontmatter";
  let inFrontmatter = false;
  let frontmatterDone = false;
  let dayOfWeek = "";
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const dayMatch = fmMatch[1].match(/day:\s*(.+)/);
    if (dayMatch) dayOfWeek = dayMatch[1].trim();
  }
  for (const line of lines) {
    if (line.trim() === "---" && !frontmatterDone) {
      raw.frontmatter.push(line);
      if (!inFrontmatter) {
        inFrontmatter = true;
      } else {
        inFrontmatter = false;
        frontmatterDone = true;
      }
      continue;
    }
    if (inFrontmatter) {
      raw.frontmatter.push(line);
      continue;
    }
    const detected = detectSection(line);
    if (detected !== null) currentSection = detected;
    switch (currentSection) {
      case "frontmatter":
        break;
      case "before-tasks":
        if (detected !== "tasks") raw.beforeTasks.push(line);
        break;
      case "tasks":
        if (detected !== "tasks") {
          const parsed = parseBulletLine(line, "day-plan", false);
          if (parsed) {
            tasks.push(parsed.task);
            if (parsed.mintedGid) mintedIds.push(parsed.task.id);
          }
        }
        break;
      case "backlog":
        if (detected !== "backlog") {
          const parsed = parseBulletLine(line, "unscheduled", false);
          if (parsed) {
            tasks.push(parsed.task);
            if (parsed.mintedGid) mintedIds.push(parsed.task.id);
          }
        }
        break;
      case "delegated":
        if (detected !== "delegated") {
          const parsed = parseBulletLine(line, "unscheduled", true);
          if (parsed) {
            tasks.push(parsed.task);
            if (parsed.mintedGid) mintedIds.push(parsed.task.id);
          }
        }
        break;
      case "trackers": {
        const stripped = line.replace(/^>\s?/, "");
        const parsed = parseBulletLine(stripped, "tracker", false);
        if (parsed) {
          tasks.push(parsed.task);
          if (parsed.mintedGid) mintedIds.push(parsed.task.id);
        }
        break;
      }
      case "after-tasks":
        if (detected === "trackers") break;
        raw.afterTasks.push(line);
        break;
      case "big-three": {
        if (detected === "big-three") break;
        const bulletMatch = line.match(/^\s*\*\s+(.+)$/);
        if (bulletMatch) bigThreeItems.push(bulletMatch[1].trim());
        break;
      }
    }
  }
  return { note: { date, dayOfWeek, tasks, bigThree: bigThreeItems }, raw, mintedIds };
}
function serializeTaskLine(task) {
  const parts = [];
  if (task.timeBlock) parts.push(task.timeBlock);
  if (task.text) parts.push(task.text);
  const visibleTags = task.tags.filter((t) => t !== "#delegated");
  if (visibleTags.length > 0) parts.push(visibleTags.join(" "));
  for (const link of task.externalLinks) parts.push(`[${link.label}](${link.url})`);
  if (task.delegatedTo) parts.push(`— ${task.delegatedTo}`);
  const metaParts = [];
  if (task.scheduled) metaParts.push(`[scheduled:: ${task.scheduled}]`);
  if (task.completion) metaParts.push(`[completion:: ${task.completion}]`);
  if (task.due) metaParts.push(`[due:: ${task.due}]`);
  if (task.linkedSessionId) metaParts.push(`[session:: ${task.linkedSessionId}]`);
  if (task.priority) metaParts.push(`[priority:: ${task.priority}]`);
  metaParts.push(`[gid:: ${task.gid}]`);
  if (metaParts.length > 0) parts.push(metaParts.join(" "));
  const prefix = task.isNote ? "-" : `- [${STATUS_TO_CHAR[task.status] ?? " "}]`;
  return `${prefix} ${parts.join(" ").replace(/[ \t]+/g, " ").trim()}`;
}
function serializeDailyNote(note, raw) {
  const sections = [];
  if (raw.frontmatter.length > 0) sections.push(raw.frontmatter.join("\n"));
  if (raw.beforeTasks.length > 0) {
    sections.push("");
    sections.push(...raw.beforeTasks);
  }
  if (note.bigThree.length > 0) {
    sections.push("");
    sections.push("## 🗓️ Daily Big Three");
    sections.push("");
    for (const item of note.bigThree) sections.push(`* ${item}`);
  }
  sections.push("");
  sections.push("## 📋 Tasks");
  sections.push("");
  for (const task of note.tasks.filter((t) => t.section === "day-plan")) {
    sections.push(serializeTaskLine(task));
  }
  sections.push("");
  sections.push("### ⚪ Backlog");
  const backlog = note.tasks.filter((t) => t.section === "unscheduled" && !t.tags.includes("#delegated"));
  if (backlog.length > 0) for (const task of backlog) sections.push(serializeTaskLine(task));
  else sections.push("- ");
  sections.push("");
  sections.push("### 🤝 Delegated");
  const delegated = note.tasks.filter((t) => t.section === "unscheduled" && t.tags.includes("#delegated"));
  if (delegated.length > 0) for (const task of delegated) sections.push(serializeTaskLine(task));
  else sections.push("- ");
  if (raw.afterTasks.length > 0) {
    sections.push("");
    sections.push(raw.afterTasks.join("\n"));
  }
  const trackers = note.tasks.filter((t) => t.section === "tracker");
  if (trackers.length > 0) {
    sections.push("> [!invisible] Trackers");
    for (const task of trackers) sections.push(`> ${serializeTaskLine(task)}`);
  }
  return `${sections.join("\n")}
`;
}
const MONTH_ABBREVS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function getISOWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
}
function getISOWeekYear(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  return date.getUTCFullYear();
}
function resolveNotePath(date, vaultRoot, dailyNotesFolder = "01.dailynotes", notePathPattern = "{yyyy}/{MMM}/{ww}/{date}.md") {
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00`);
  const yyyy = d.getFullYear().toString();
  const mmm = MONTH_ABBREVS[d.getMonth()];
  const ww = String(getISOWeek(d)).padStart(2, "0");
  const resolved = notePathPattern.replace("{yyyy}", yyyy).replace("{MMM}", mmm).replace("{ww}", ww).replace("{date}", date);
  return `${vaultRoot}/${dailyNotesFolder}/${resolved}`;
}
function getDayOfWeek(date) {
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00`);
  return DAY_NAMES[d.getDay()];
}
function fillDateTokens(template, date) {
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00`);
  const tokenValues = {
    "YYYY-MM-DD": date,
    dddd: getDayOfWeek(date),
    gggg: String(getISOWeekYear(d)),
    WW: String(getISOWeek(d)).padStart(2, "0")
  };
  return template.replace(/\{\{date:([^}]+)\}\}/g, (match, token) => tokenValues[token] ?? match);
}
function fillDailyNoteTemplate(template, date, carriedTasks = []) {
  const filled = fillDateTokens(template, date);
  const lines = filled.split("\n");
  const tasksHeaderIdx = lines.findIndex((l) => /^##\s+.*Tasks/i.test(l));
  if (tasksHeaderIdx === -1 || carriedTasks.length === 0) return filled;
  lines.splice(tasksHeaderIdx + 1, 0, ...carriedTasks.map((task) => serializeTaskLine(task)));
  return lines.join("\n");
}
function generateNewNote(date, carriedTasks = [], template = null) {
  if (template !== null) return fillDailyNoteTemplate(template, date, carriedTasks);
  const dayName = getDayOfWeek(date);
  const lines = [
    "---",
    `date: ${date}`,
    `day: ${dayName}`,
    "type: daily",
    "---",
    "",
    "## 📋 Tasks",
    "",
    ...carriedTasks.map((task) => serializeTaskLine(task)),
    ...carriedTasks.length > 0 ? [""] : [],
    "### ⚪ Backlog",
    "- ",
    "",
    "### 🤝 Delegated",
    "- ",
    "",
    "> [!invisible] Trackers",
    ""
  ];
  return lines.join("\n");
}
const WATCH_DEBOUNCE_MS = 300;
const CARRY_OVER_LOOKBACK_DAYS = 14;
function subtractDays(date, n) {
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() - n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function findMostRecentNoteDate(date, settings) {
  for (let n = 1; n <= CARRY_OVER_LOOKBACK_DAYS; n++) {
    const candidateDate = subtractDays(date, n);
    const candidatePath = resolveNotePath(candidateDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
    if (node_fs.existsSync(candidatePath)) return candidateDate;
  }
  return null;
}
function collectCarryOverTasks(note) {
  return note.tasks.filter((t) => (t.status === "open" || t.status === "in-progress") && !t.isTracker && t.section !== "tracker").map((t) => ({ ...t, status: "open", completion: void 0 }));
}
const everKnownIds = /* @__PURE__ */ new Map();
function recordKnownIds(path, ids) {
  const existing = everKnownIds.get(path);
  if (!existing) {
    everKnownIds.set(path, new Set(ids));
    return;
  }
  for (const id of ids) existing.add(id);
}
const lastWrittenContent = /* @__PURE__ */ new Map();
function recordWrittenContent(path, content) {
  lastWrittenContent.set(path, content);
}
function recordWrittenContentForPath(path, content) {
  recordWrittenContent(path, content);
}
function recordKnownIdsForPath(path, ids) {
  recordKnownIds(path, ids);
}
function readVaultSettings() {
  return resolveVaultSettings();
}
function notifyDailyNoteChanged(getMainWindow, note) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("daily-note:changed", note);
  }
}
function persistMintedGids(path, note, raw, mintedIds) {
  if (mintedIds.length === 0) return;
  const serialized = serializeDailyNote(note, raw);
  node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  node_fs.writeFileSync(tmpPath, serialized, "utf-8");
  node_fs.renameSync(tmpPath, path);
  recordWrittenContent(path, serialized);
  recordKnownIds(path, getTaskIds(note));
  logger.info("daily-note: persisted newly-minted gid(s) for previously untagged task(s)", {
    path,
    mintedIds
  });
}
let activeWatcher = null;
let debounceTimer = null;
let watchedPath = null;
let pendingTestWriteDelayMs = null;
const TEMPLATE_RELATIVE_PATH = "92.templates/Daily Note Template.md";
function loadNoteTemplate(vaultRoot, templatePath = TEMPLATE_RELATIVE_PATH) {
  const fullPath = `${vaultRoot}/${templatePath}`;
  if (!node_fs.existsSync(fullPath)) return null;
  return node_fs.readFileSync(fullPath, "utf-8");
}
function resolveVaultRoot$1() {
  const envRoot = process.env.ATELIER_TEST_VAULT_ROOT ?? process.env.ATELIER_VAULT_ROOT ?? null;
  if (envRoot) return envRoot;
  const root = loadConfig().vault.root;
  return root || null;
}
function resolveVaultSettings() {
  const root = resolveVaultRoot$1();
  if (!root) return null;
  const cfg = loadConfig().vault;
  return {
    root,
    dailyNotesFolder: cfg.dailyNotesFolder,
    notePathPattern: cfg.notePathPattern,
    templatePath: cfg.templatePath
  };
}
function resolveDefaultDate$1() {
  if (process.env.ATELIER_TEST_DATE) return process.env.ATELIER_TEST_DATE;
  const now = /* @__PURE__ */ new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function ensureNoteExists(date, settings, options) {
  const carryOver = options?.carryOver ?? true;
  const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
  if (node_fs.existsSync(path)) {
    const content2 = await promises.readFile(path, "utf-8");
    const { note: note2, raw: raw2, mintedIds } = parseDailyNote(content2, date);
    persistMintedGids(path, note2, raw2, mintedIds);
    recordKnownIds(path, getTaskIds(note2));
    return { note: note2, raw: raw2, path, created: false };
  }
  let carriedTasks = [];
  if (carryOver) {
    const priorDate = findMostRecentNoteDate(date, settings);
    if (priorDate) {
      const priorPath = resolveNotePath(priorDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
      const priorContent = await promises.readFile(priorPath, "utf-8");
      const { note: priorNote, raw: priorRaw, mintedIds: priorMintedIds } = parseDailyNote(priorContent, priorDate);
      persistMintedGids(priorPath, priorNote, priorRaw, priorMintedIds);
      carriedTasks = collectCarryOverTasks(priorNote);
      logger.info("daily-note create: carrying tasks forward", {
        path,
        priorDate,
        priorPath,
        carriedIds: carriedTasks.map((t) => t.id)
      });
    }
  }
  const content = generateNewNote(date, carriedTasks, loadNoteTemplate(settings.root, settings.templatePath));
  node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
  node_fs.writeFileSync(path, content, "utf-8");
  recordWrittenContent(path, content);
  const { note, raw } = parseDailyNote(content, date);
  recordKnownIds(path, getTaskIds(note));
  logger.info("daily-note created", { path, carryOver });
  return { note, raw, path, created: true };
}
function vaultRelativePath(absPath, vaultRoot) {
  const root = vaultRoot.replace(/\/$/, "");
  if (absPath.startsWith(`${root}/`)) return absPath.slice(root.length + 1);
  if (absPath.startsWith(root)) return absPath.slice(root.length).replace(/^\//, "");
  return absPath;
}
async function readNotesSliceForDate(date, settings, createIfMissing) {
  const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
  const rel = vaultRelativePath(path, settings.root);
  let created = false;
  if (!node_fs.existsSync(path)) {
    if (!createIfMissing) {
      return { exists: false, notesBody: "", vaultRelativePath: rel, created: false, notesSectionHeading: DEFAULT_NOTES_SECTION_HEADING };
    }
    await ensureNoteExists(date, settings);
    created = true;
  }
  const content = await promises.readFile(path, "utf-8");
  const { note, raw, mintedIds } = parseDailyNote(content, date);
  persistMintedGids(path, note, raw, mintedIds);
  recordKnownIds(path, getTaskIds(note));
  const { notesBody, notesHeadingLine } = extractNotesBodyFromAfterTasks(raw.afterTasks);
  logger.info("daily-note read notes slice", { path, created, bodyLength: notesBody.length });
  return {
    exists: true,
    notesBody,
    vaultRelativePath: rel,
    created,
    notesSectionHeading: notesHeadingLine ?? DEFAULT_NOTES_SECTION_HEADING
  };
}
function registerDailyNoteHandlers(getMainWindow) {
  const isTestMode = process.env.ATELIER_TEST_VAULT_ROOT !== void 0;
  electron.ipcMain.handle("daily-note:getVaultRoot", () => resolveVaultRoot$1());
  electron.ipcMain.handle(
    "daily-note:isVaultRootFromEnv",
    () => Boolean(process.env.ATELIER_TEST_VAULT_ROOT ?? process.env.ATELIER_VAULT_ROOT)
  );
  electron.ipcMain.handle("daily-note:getDefaultDate", () => resolveDefaultDate$1());
  electron.ipcMain.handle("daily-note:pickVaultRoot", async () => {
    const win = getMainWindow();
    const options = { properties: ["openDirectory", "createDirectory"] };
    const result = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle("daily-note:read", async (_event, date) => {
    const settings = resolveVaultSettings();
    if (!settings) return { note: null, raw: null, exists: false };
    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
    if (!node_fs.existsSync(path)) return { note: null, raw: null, exists: false };
    const content = await promises.readFile(path, "utf-8");
    const { note, raw, mintedIds } = parseDailyNote(content, date);
    persistMintedGids(path, note, raw, mintedIds);
    recordKnownIds(path, getTaskIds(note));
    logger.info("daily-note read", { path, taskCount: note.tasks.length });
    return { note, raw, exists: true };
  });
  electron.ipcMain.handle("daily-note:read-notes-slice", async (_event, date, createIfMissing) => {
    const settings = resolveVaultSettings();
    if (!settings) throw new Error("no vault root configured (ATELIER_VAULT_ROOT / Settings → Vault)");
    return readNotesSliceForDate(date, settings, Boolean(createIfMissing));
  });
  electron.ipcMain.handle("daily-note:write-notes-slice", async (_event, date, notesBody) => {
    const settings = resolveVaultSettings();
    if (!settings) throw new Error("no vault root configured");
    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
    if (!node_fs.existsSync(path)) throw new Error(`daily note not found for ${date}`);
    const freshContent = await promises.readFile(path, "utf-8");
    const parsed = parseDailyNote(freshContent, date);
    persistMintedGids(path, parsed.note, parsed.raw, parsed.mintedIds);
    recordKnownIds(path, getTaskIds(parsed.note));
    const mergedAfter = mergeNotesBodyIntoAfterTasks(parsed.raw.afterTasks, notesBody);
    const newRaw = { ...parsed.raw, afterTasks: mergedAfter };
    const serialized = serializeDailyNote(parsed.note, newRaw);
    const tmpPath = `${path}.tmp`;
    node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
    node_fs.writeFileSync(tmpPath, serialized, "utf-8");
    node_fs.renameSync(tmpPath, path);
    recordWrittenContent(path, serialized);
    recordKnownIds(path, getTaskIds(parsed.note));
    logger.info("daily-note write notes slice committed", { path, bodyLength: notesBody.length });
    return { ok: true };
  });
  electron.ipcMain.handle("daily-note:create", async (_event, date) => {
    const settings = resolveVaultSettings();
    if (!settings) throw new Error("no vault root configured (ATELIER_VAULT_ROOT / ATELIER_TEST_VAULT_ROOT / Settings → Vault)");
    const { note, raw } = await ensureNoteExists(date, settings);
    return { note, raw, exists: true };
  });
  electron.ipcMain.handle(
    "daily-note:move-task",
    async (_event, sourceDate, taskId, targetDate) => {
      const settings = resolveVaultSettings();
      if (!settings) throw new Error("no vault root configured");
      const sourcePath = resolveNotePath(sourceDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
      const targetPath = resolveNotePath(targetDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
      if (!node_fs.existsSync(sourcePath)) throw new Error(`source note not found: ${sourcePath}`);
      const sourceContent = await promises.readFile(sourcePath, "utf-8");
      const { note: sourceNote, raw: sourceRaw, mintedIds: sourceMintedIds } = parseDailyNote(sourceContent, sourceDate);
      persistMintedGids(sourcePath, sourceNote, sourceRaw, sourceMintedIds);
      const task = sourceNote.tasks.find((t) => t.id === taskId);
      if (!task) {
        logger.info("daily-note move-task: task not found in source note", {
          sourcePath,
          taskId,
          sourceDate,
          targetDate,
          freshIds: sourceNote.tasks.map((t) => t.id)
        });
        throw new Error(`task not found in source note: ${taskId}`);
      }
      if (sourcePath === targetPath) {
        logger.info("daily-note move-task: source/target resolve to the same file, no-op", {
          sourcePath,
          taskId
        });
        return { sourceNote, targetNote: sourceNote };
      }
      const updatedSourceNote = {
        ...sourceNote,
        tasks: sourceNote.tasks.filter((t) => t.id !== taskId)
      };
      const sourceSerialized = serializeDailyNote(updatedSourceNote, sourceRaw);
      node_fs.mkdirSync(node_path.dirname(sourcePath), { recursive: true });
      const sourceTmp = `${sourcePath}.tmp`;
      node_fs.writeFileSync(sourceTmp, sourceSerialized, "utf-8");
      node_fs.renameSync(sourceTmp, sourcePath);
      recordWrittenContent(sourcePath, sourceSerialized);
      recordKnownIds(sourcePath, getTaskIds(updatedSourceNote));
      const { note: targetNoteBefore, raw: targetRaw } = await ensureNoteExists(targetDate, settings, {
        carryOver: false
      });
      const movedTask = { ...task, section: "unscheduled", timeBlock: void 0 };
      const updatedTargetNote = {
        ...targetNoteBefore,
        tasks: [...targetNoteBefore.tasks, movedTask]
      };
      const targetSerialized = serializeDailyNote(updatedTargetNote, targetRaw);
      node_fs.mkdirSync(node_path.dirname(targetPath), { recursive: true });
      const targetTmp = `${targetPath}.tmp`;
      node_fs.writeFileSync(targetTmp, targetSerialized, "utf-8");
      node_fs.renameSync(targetTmp, targetPath);
      recordWrittenContent(targetPath, targetSerialized);
      recordKnownIds(targetPath, getTaskIds(updatedTargetNote));
      logger.info("daily-note move-task committed", {
        sourcePath,
        targetPath,
        taskId,
        sourceDate,
        targetDate
      });
      return { sourceNote: updatedSourceNote, targetNote: updatedTargetNote };
    }
  );
  electron.ipcMain.handle("daily-note:write", async (_event, date, incoming) => {
    const settings = resolveVaultSettings();
    if (!settings) throw new Error("no vault root configured");
    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
    const incomingIds = getTaskIds(incoming);
    if (pendingTestWriteDelayMs !== null) {
      const delay2 = pendingTestWriteDelayMs;
      pendingTestWriteDelayMs = null;
      logger.info("daily-note write delayed (test hook)", { path, delayMs: delay2, incomingIds: [...incomingIds] });
      await sleep(delay2);
    }
    let freshNote;
    let rawSections;
    if (node_fs.existsSync(path)) {
      const freshContent = await promises.readFile(path, "utf-8");
      const parsed = parseDailyNote(freshContent, date);
      freshNote = parsed.note;
      rawSections = parsed.raw;
    } else {
      freshNote = { date, dayOfWeek: "", tasks: [], bigThree: [] };
      rawSections = { frontmatter: [], beforeTasks: [], afterTasks: [] };
    }
    const freshIds = getTaskIds(freshNote);
    recordKnownIds(path, freshIds);
    const everKnown = everKnownIds.get(path) ?? freshIds;
    const tombstoned = [...everKnown].filter((id) => !freshIds.has(id));
    const tombstonedSet = new Set(tombstoned);
    const survivingTasks = incoming.tasks.filter((t) => !tombstonedSet.has(t.id));
    if (tombstoned.length > 0) {
      logger.info("daily-note tombstone diff: dropping externally-deleted tasks", {
        path,
        tombstoned,
        incomingIds: [...incomingIds],
        freshIds: [...freshIds]
      });
    }
    const toWrite = { ...incoming, tasks: survivingTasks };
    const serialized = serializeDailyNote(toWrite, rawSections);
    const tmpPath = `${path}.tmp`;
    node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
    node_fs.writeFileSync(tmpPath, serialized, "utf-8");
    node_fs.renameSync(tmpPath, path);
    recordWrittenContent(path, serialized);
    for (const id of tombstoned) everKnown.delete(id);
    recordKnownIds(path, getTaskIds(toWrite));
    logger.info("daily-note write committed", { path, taskCount: toWrite.tasks.length });
    return { note: toWrite };
  });
  electron.ipcMain.handle("daily-note:watch", (_event, date) => {
    const settings = resolveVaultSettings();
    if (!settings) return;
    if (activeWatcher) {
      activeWatcher.close();
      activeWatcher = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
    watchedPath = path;
    if (!node_fs.existsSync(path)) return;
    const dir = node_path.dirname(path);
    const targetName = node_path.basename(path);
    const notifyChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          if (!node_fs.existsSync(path)) return;
          const content = node_fs.readFileSync(path, "utf-8");
          if (lastWrittenContent.get(path) === content) {
            logger.info("daily-note watcher: suppressed self-write echo", { path });
            return;
          }
          const { note, raw, mintedIds } = parseDailyNote(content, date);
          persistMintedGids(path, note, raw, mintedIds);
          recordKnownIds(path, getTaskIds(note));
          logger.info("daily-note watcher: reparsed after change", { path, taskCount: note.tasks.length });
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send("daily-note:changed", note);
          }
        } catch {
        }
      }, WATCH_DEBOUNCE_MS);
    };
    const watcher = node_fs.watch(dir, (_eventType, filename) => {
      if (filename && filename !== targetName) return;
      logger.info("daily-note watcher: fs event", { path, filename });
      notifyChange();
    });
    watcher.unref();
    activeWatcher = watcher;
    logger.info("daily-note watcher: started", { path, dir });
  });
  electron.ipcMain.handle("daily-note:unwatch", () => {
    if (activeWatcher) {
      activeWatcher.close();
      activeWatcher = null;
      logger.info("daily-note watcher: stopped", { path: watchedPath });
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watchedPath = null;
  });
  if (isTestMode) {
    electron.ipcMain.handle("daily-note:testDelayNextWrite", (_event, ms) => {
      pendingTestWriteDelayMs = ms;
    });
  }
}
class WeeklyPlanDraftStore {
  constructor(db2) {
    this.db = db2;
  }
  get(isoWeek) {
    const row = this.db.prepare("SELECT step, data_json FROM weekly_plan_drafts WHERE iso_week = ?").get(isoWeek);
    if (!row) return null;
    try {
      return { step: row.step, data: JSON.parse(row.data_json) };
    } catch {
      return null;
    }
  }
  save(isoWeek, step, data) {
    const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare(
      `INSERT INTO weekly_plan_drafts (iso_week, step, data_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(iso_week) DO UPDATE SET
           step = excluded.step,
           data_json = excluded.data_json,
           updated_at = excluded.updated_at`
    ).run(isoWeek, step, JSON.stringify(data), updatedAt);
  }
  clear(isoWeek) {
    this.db.prepare("DELETE FROM weekly_plan_drafts WHERE iso_week = ?").run(isoWeek);
  }
}
let store$1 = null;
function getWeeklyPlanDraftStore(db2) {
  if (!store$1) store$1 = new WeeklyPlanDraftStore(db2);
  return store$1;
}
function taskKey(text) {
  return text.trim().toLowerCase();
}
function dedupeContextLines(lines) {
  const byKey = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const key = taskKey(line.text);
    if (!key) continue;
    const datePart = line.source.replace(/\s+daily\s*$/i, "").trim();
    const cur = byKey.get(key);
    if (cur) {
      if (datePart && !cur.dates.includes(datePart)) cur.dates.push(datePart);
    } else {
      byKey.set(key, { text: line.text, dates: datePart ? [datePart] : [] });
    }
  }
  return [...byKey.values()].map(({ text, dates }) => ({
    text,
    source: dates.length === 0 ? "daily" : dates.length === 1 ? `${dates[0]} daily` : `${dates.join(", ")} daily`
  }));
}
function dedupeCarrySuggestions(items) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  let idx = 0;
  for (const item of items) {
    const key = taskKey(item.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `carry_${idx++}`, text: item.text, source: item.source });
  }
  return out;
}
function isWeeklyPlanInstructionLine(text) {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("%%")) return true;
  if (/^\d+\.\s*\[\s*[ xX]?\s*\]\s*\.?\s*$/.test(t)) return true;
  if (/^\[Completion:\s*%?\]\s*$/i.test(t)) return true;
  if (/^At least ONE must/i.test(t)) return true;
  return false;
}
function isDailyNoteActionTask(task) {
  if (task.isNote) return false;
  if (task.section === "tracker") return false;
  return task.section === "day-plan" || task.section === "unscheduled";
}
function isDailyNoteNoteLine(task) {
  if (!task.isNote) return false;
  if (task.section === "tracker") return false;
  return task.section === "day-plan" || task.section === "unscheduled";
}
const WEEKLY_NOTES_FOLDER = "02.weeklynotes";
const WEEKLY_TEMPLATE_REL = "92.templates/Weekly Notes Template.md";
const DEFAULT_WEEKLY_TEMPLATE = `---
week: {{date:gggg-[W]WW}}
type: weekly
---

# Retro
---
## AFTER ACTION REVIEW  <sub> List 3-5 of your biggest wins from the week </sub>
> [!letter]
> 1. 
> 2. 
> 3.

## Last Week's Big Three
> [!letter]
> 1. [Completion: %]
> 2. [Completion: %]
> 3. [Completion: %]

## What worked? What didn't? Why? How would you change
> [!letter]
> (write something)

# Plan
---
## REJUVENATION
> [!multi-column]
>> [!lined-container]
>> 1.
>> [!lined-container]
>> 1.
>> [!lined-container]
>> 1.

## Ideas
> [!multi-column]
>> [!letter]
>> 1 
>> 3 
>> 5 
>> [!letter]
>> 2 
>> 4 
>> 6 

## WEEKLY BIG THREE
1. [ ]
2. [ ]
3. [ ]
`;
function formatIsoWeekKey(date) {
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00`);
  return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, "0")}`;
}
function parseIsoWeekKey(key) {
  const m = key.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`invalid iso week key: ${key}`);
  return { year: parseInt(m[1], 10), week: parseInt(m[2], 10) };
}
function mondayOfIsoWeek(year, week) {
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setDate(jan4.getDate() - dayOfWeek + 1);
  const monday = new Date(mondayWeek1);
  monday.setDate(mondayWeek1.getDate() + (week - 1) * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function dateKeyFromLocal(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function datesInIsoWeek(isoWeek) {
  const { year, week } = parseIsoWeekKey(isoWeek);
  const monday = mondayOfIsoWeek(year, week);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    out.push(dateKeyFromLocal(d));
  }
  return out;
}
function prevIsoWeekKey(isoWeek) {
  const { year, week } = parseIsoWeekKey(isoWeek);
  const monday = mondayOfIsoWeek(year, week);
  monday.setDate(monday.getDate() - 7);
  return formatIsoWeekKey(dateKeyFromLocal(monday));
}
function resolveWeeklyNotePath(vaultRoot, isoWeek) {
  return node_path.join(vaultRoot, WEEKLY_NOTES_FOLDER, `${isoWeek}.md`);
}
function weeklyStatusForDate(vaultRoot, date) {
  const isoWeek = formatIsoWeekKey(date);
  const relativePath = `${WEEKLY_NOTES_FOLDER}/${isoWeek}.md`;
  const fileExists = vaultRoot ? node_fs.existsSync(resolveWeeklyNotePath(vaultRoot, isoWeek)) : false;
  return {
    isoWeek,
    prevWeek: prevIsoWeekKey(isoWeek),
    relativePath,
    fileExists
  };
}
function fillWeeklyTemplateTokens(template, isoWeek) {
  const { year, week } = parseIsoWeekKey(isoWeek);
  const monday = mondayOfIsoWeek(year, week);
  const date = dateKeyFromLocal(monday);
  return template.replace(/\{\{date:gggg-\[W\]WW\}\}/g, isoWeek).replace(/\{\{date:gggg\}\}/g, String(year)).replace(/\{\{date:\[W\]WW\}\}/g, String(week).padStart(2, "0")).replace(/\{\{date:YYYY-MM-DD\}\}/g, date);
}
async function loadWeeklyTemplate(vaultRoot) {
  const path = node_path.join(vaultRoot, WEEKLY_TEMPLATE_REL);
  if (!node_fs.existsSync(path)) return DEFAULT_WEEKLY_TEMPLATE;
  return promises.readFile(path, "utf-8");
}
const LAST_WEEK_BIG_THREE_HEADING = /^Last Week'?s Big Three|^Last week Big Three/i;
const WEEKLY_BIG_THREE_HEADING = /^WEEKLY BIG THREE|^Weekly Big Three/i;
function extractWeeklySectionByHeadingPattern(content, headingPattern) {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*(?:<|$)/);
    if (!m) continue;
    const title = m[1].trim();
    if (headingPattern.test(title)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}
function normalizeWeeklyNoteLine(raw) {
  let line = raw.trim();
  if (!line || line.startsWith("%%")) return "";
  while (line.startsWith(">")) {
    line = line.replace(/^>\s*/, "").trim();
  }
  line = line.replace(/^\[!?\w+\]\s*/, "").trim();
  const numbered = line.match(/^\d+\.\s*(.+)$/);
  if (numbered) line = numbered[1].trim();
  line = line.replace(/^\[\s*[ xX]?\s*\]\s*/, "").trim();
  line = line.replace(/^-\s+/, "").trim();
  return line;
}
function parseRetroLine(line) {
  const normalized = normalizeWeeklyNoteLine(line);
  if (!normalized) return null;
  const completionBracket = normalized.match(/^\[Completion:\s*(n\/a|\d+%?)\]\s*(.*)$/i);
  if (completionBracket) {
    const raw = completionBracket[1].toLowerCase();
    if (raw === "n/a") return null;
    const pct = String(parseInt(raw, 10) || 0);
    let text = completionBracket[2].trim();
    text = text.replace(/^[—–-]\s*/, "").trim();
    if (!text || isWeeklyPlanInstructionLine(text)) return null;
    return { text, pct };
  }
  const pctMatch = normalized.match(/(?:—|–|-)\s*completion:\s*(n\/a|\d+%?)\s*$/i);
  if (pctMatch) {
    const text = normalized.slice(0, pctMatch.index).trim();
    if (!text || isWeeklyPlanInstructionLine(text)) return null;
    const raw = pctMatch[1].toLowerCase();
    const pct = raw === "n/a" ? "n/a" : String(parseInt(raw, 10) || 0);
    return { text, pct };
  }
  if (isWeeklyPlanInstructionLine(normalized)) return null;
  return { text: normalized, pct: "0" };
}
function parseWeeklyBigThreeLines(section) {
  const lines = [];
  for (const raw of section.split("\n")) {
    const text = normalizeWeeklyNoteLine(raw);
    if (!text || isWeeklyPlanInstructionLine(text)) continue;
    lines.push(text);
  }
  while (lines.length < 3) lines.push("");
  return lines.slice(0, 3);
}
function extractWeeklySectionBody(content, heading) {
  const re = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*)`, "im");
  const m = content.match(re);
  if (!m) return "";
  const rest = m[1];
  const nextHeading = rest.search(/^## /m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}
function sectionRange(lines, headingPattern) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*(?:<|$)/);
    if (!m) continue;
    if (headingPattern.test(m[1].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [start, end];
}
function usesVaultWeeklyTemplateFormat(template) {
  return /> \[!letter\]/i.test(template) || /> \[!multi-column\]/i.test(template) || /^#\s+Retro/m.test(template);
}
const AFTER_ACTION_HEADING = /^AFTER ACTION REVIEW/i;
const LAST_WEEK_B3_HEADING = /^Last Week'?s Big Three|^Last week Big Three/i;
const REFLECTION_HEADING = /^What worked|^Reflection/i;
const REJUVENATION_HEADING = /^REJUVENATION/i;
const IDEAS_HEADING = /^Ideas/i;
function fillLetterNumberedLines(lines, start, end, values, maxSlot, formatLine) {
  for (let i = start; i < end; i++) {
    const m = lines[i].match(/^>\s*(\d+)\.\s*(.*)$/);
    if (!m) continue;
    const slot = parseInt(m[1], 10);
    if (slot < 1 || slot > maxSlot) continue;
    const text = values[slot - 1]?.trim() ?? "";
    lines[i] = formatLine(slot, text);
  }
}
function fillLastWeekBigThreeLines(lines, start, end, rows) {
  fillLetterNumberedLines(lines, start, end, rows.map((r) => r.text), 3, (slot, text) => {
    const row = rows[slot - 1];
    const pctRaw = String(row.pct).trim().toLowerCase();
    const pct = pctRaw === "n/a" ? "n/a" : `${parseInt(row.pct, 10) || 0}%`;
    const body = text.trim();
    if (!body) return `> ${slot}. [Completion: ${pct}]`;
    return `> ${slot}. [Completion: ${pct}] ${body}`;
  });
}
function fillReflectionCallout(lines, start, end, reflect) {
  const trimmed = reflect.trim();
  for (let i = start; i < end; i++) {
    if (!lines[i].startsWith(">")) continue;
    if (/^>\s*\[!/.test(lines[i])) continue;
    if (!/\(write something\)/i.test(lines[i]) && !trimmed) continue;
    if (!trimmed) {
      lines[i] = "> (write something)";
      return;
    }
    const parts = trimmed.split("\n");
    lines[i] = `> ${parts[0]}`;
    if (parts.length > 1) {
      lines.splice(i + 1, 0, ...parts.slice(1).map((p) => `> ${p}`));
    }
    return;
  }
}
function fillRejuvenationLines(lines, start, end, values) {
  let idx = 0;
  for (let i = start; i < end && idx < values.length; i++) {
    const m = lines[i].match(/^>>\s*(\d+)\.\s*(.*)$/);
    if (!m || m[1] !== "1") continue;
    const text = values[idx]?.trim() ?? "";
    lines[i] = text ? `>> 1. ${text}` : ">> 1.";
    idx++;
  }
}
function fillIdeasLines(lines, start, end, ideas) {
  const slots = [];
  for (let i = start; i < end; i++) {
    const m = lines[i].match(/^>>\s*(\d+)\s*(.*)$/);
    if (m) slots.push({ line: i, num: parseInt(m[1], 10) });
  }
  slots.sort((a, b) => a.num - b.num);
  for (let i = 0; i < slots.length && i < ideas.length; i++) {
    const text = ideas[i]?.trim() ?? "";
    const { line, num } = slots[i];
    lines[line] = text ? `>> ${num} ${text}` : `>> ${num} `;
  }
}
function fillWeeklyBigThreeCheckboxes(lines, start, end, values) {
  for (let i = start; i < end; i++) {
    const m = lines[i].match(/^(\d+)\.\s*\[\s*\]\s*(.*)$/);
    if (!m) continue;
    const slot = parseInt(m[1], 10);
    if (slot < 1 || slot > 3) continue;
    const text = values[slot - 1]?.trim() ?? "";
    lines[i] = text ? `${slot}. [ ] ${text}` : `${slot}. [ ]`;
  }
}
function fillVaultWeeklyTemplate(body, data) {
  const lines = body.split("\n");
  const winsRange = sectionRange(lines, AFTER_ACTION_HEADING);
  if (winsRange) {
    fillLetterNumberedLines(
      lines,
      winsRange[0],
      winsRange[1],
      data.wins,
      5,
      (slot, text) => text ? `> ${slot}. ${text}` : `> ${slot}. `
    );
  }
  const retroRange = sectionRange(lines, LAST_WEEK_B3_HEADING);
  if (retroRange) fillLastWeekBigThreeLines(lines, retroRange[0], retroRange[1], data.lastBigThree);
  const reflectRange = sectionRange(lines, REFLECTION_HEADING);
  if (reflectRange) fillReflectionCallout(lines, reflectRange[0], reflectRange[1], data.retroReflect);
  const rejRange = sectionRange(lines, REJUVENATION_HEADING);
  if (rejRange) fillRejuvenationLines(lines, rejRange[0], rejRange[1], data.rejuvenation);
  const ideasRange = sectionRange(lines, IDEAS_HEADING);
  if (ideasRange) fillIdeasLines(lines, ideasRange[0], ideasRange[1], data.ideas);
  const b3Range = sectionRange(lines, WEEKLY_BIG_THREE_HEADING);
  if (b3Range) fillWeeklyBigThreeCheckboxes(lines, b3Range[0], b3Range[1], data.bigThree);
  return lines.join("\n");
}
function replaceSectionByPattern(body, headingPattern, content) {
  const lines = body.split("\n");
  const range = sectionRange(lines, headingPattern);
  if (!range) return body;
  const [start, end] = range;
  const insert = content.trimEnd() ? content.trimEnd().split("\n") : ["- "];
  const next = [...lines.slice(0, start), ...insert, "", ...lines.slice(end)];
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}
function fillLegacyWeeklyTemplate(body, data) {
  let out = body;
  out = replaceSectionByPattern(out, AFTER_ACTION_HEADING, bulletLines(data.wins));
  out = replaceSectionByPattern(out, LAST_WEEK_B3_HEADING, formatLastBigThreeRetro(data.lastBigThree));
  out = replaceSectionByPattern(
    out,
    REFLECTION_HEADING,
    data.retroReflect.trim() ? `${data.retroReflect.trim()}
` : "- \n"
  );
  out = replaceSectionByPattern(out, REJUVENATION_HEADING, bulletLines(data.rejuvenation));
  out = replaceSectionByPattern(out, IDEAS_HEADING, bulletLines(data.ideas));
  out = replaceSectionByPattern(out, WEEKLY_BIG_THREE_HEADING, bulletLines(data.bigThree));
  return out;
}
function bulletLines(lines) {
  const trimmed = lines.map((l) => l.trim()).filter(Boolean);
  if (!trimmed.length) return "- \n";
  return trimmed.map((l) => `- ${l}`).join("\n") + "\n";
}
function formatLastBigThreeRetro(rows) {
  if (!rows.length) return "- \n";
  return rows.map((r, i) => {
    const text = r.text.trim() || `Big Three #${i + 1}`;
    const pct = String(r.pct).trim().toLowerCase() === "n/a" ? "n/a" : `${parseInt(r.pct, 10) || 0}%`;
    return `- ${text} — completion: ${pct}`;
  }).join("\n") + "\n";
}
function buildWeeklyNoteMarkdown(template, isoWeek, data) {
  const filled = fillWeeklyTemplateTokens(template, isoWeek);
  const body = usesVaultWeeklyTemplateFormat(template) ? fillVaultWeeklyTemplate(filled, data) : fillLegacyWeeklyTemplate(filled, data);
  return body.endsWith("\n") ? body : `${body}
`;
}
function parseWeeklyBigThreeFromMarkdown(content) {
  const section = extractWeeklySectionByHeadingPattern(content, WEEKLY_BIG_THREE_HEADING) || extractWeeklySectionBody(content, "Weekly Big Three");
  if (!section.trim()) return ["", "", ""];
  return parseWeeklyBigThreeLines(section);
}
function parseLastBigThreeRetroFromMarkdown(content) {
  const section = extractWeeklySectionByHeadingPattern(content, LAST_WEEK_BIG_THREE_HEADING) || extractWeeklySectionBody(content, "Last week Big Three");
  if (!section.trim()) {
    return [
      { text: "", pct: "0" },
      { text: "", pct: "0" },
      { text: "", pct: "0" }
    ];
  }
  const rows = [];
  for (const line of section.split("\n")) {
    const row = parseRetroLine(line);
    if (row) rows.push(row);
  }
  while (rows.length < 3) rows.push({ text: "", pct: "0" });
  return rows.slice(0, 3);
}
async function scanDailyNotesInWeek(isoWeek, settings) {
  const completed = [];
  const open = [];
  const carry = [];
  let carryIdx = 0;
  for (const date of datesInIsoWeek(isoWeek)) {
    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
    if (!node_fs.existsSync(path)) continue;
    const content = await promises.readFile(path, "utf-8");
    const { note } = parseDailyNote(content, date);
    for (const task of note.tasks) {
      const text = task.text.trim();
      if (!text) continue;
      const source = `${date} daily`;
      if (isDailyNoteActionTask(task)) {
        if (task.status === "done") {
          completed.push({ text, source });
        } else if (task.status === "open" || task.status === "in-progress") {
          open.push({ text, source });
        }
      } else if (isDailyNoteNoteLine(task)) {
        carry.push({
          id: `carry_${carryIdx++}`,
          text,
          source
        });
      }
    }
  }
  return { completed, open, carry };
}
async function findLatestWeeklyBigThreeOutcomes(vaultRoot, startWeek) {
  let week = startWeek;
  for (let i = 0; i < 52; i++) {
    const path = resolveWeeklyNotePath(vaultRoot, week);
    if (node_fs.existsSync(path)) {
      const content = await promises.readFile(path, "utf-8");
      const parsed = parseWeeklyBigThreeFromMarkdown(content);
      const outcomes = parsed.filter((t) => t.trim() && !isWeeklyPlanInstructionLine(t));
      if (outcomes.length) {
        while (outcomes.length < 3) outcomes.push("");
        return { isoWeek: week, outcomes: outcomes.slice(0, 3) };
      }
    }
    week = prevIsoWeekKey(week);
  }
  return null;
}
async function loadWeeklyPlanWizardContext(vaultRoot, date, vaultScan) {
  const status = weeklyStatusForDate(vaultRoot, date);
  const prevPath = resolveWeeklyNotePath(vaultRoot, status.prevWeek);
  let lastWeekWeeklyBigThree = ["", "", ""];
  let bigThreeSuggestionWeek = status.prevWeek;
  let lastBigThree = [
    { text: "", pct: "0" },
    { text: "", pct: "0" },
    { text: "", pct: "0" }
  ];
  if (node_fs.existsSync(prevPath)) {
    const prevContent = await promises.readFile(prevPath, "utf-8");
    lastWeekWeeklyBigThree = parseWeeklyBigThreeFromMarkdown(prevContent);
    lastBigThree = lastWeekWeeklyBigThree.map((text) => ({ text, pct: "0" }));
    const retro = parseLastBigThreeRetroFromMarkdown(prevContent).filter(
      (r) => !isWeeklyPlanInstructionLine(r.text)
    );
    if (retro.some((r) => r.text.trim())) lastBigThree = retro;
  }
  if (!lastWeekWeeklyBigThree.some((t) => t.trim())) {
    const found = await findLatestWeeklyBigThreeOutcomes(vaultRoot, status.prevWeek);
    if (found) {
      lastWeekWeeklyBigThree = found.outcomes;
      bigThreeSuggestionWeek = found.isoWeek;
    }
  }
  lastBigThree = lastBigThree.filter((r) => !isWeeklyPlanInstructionLine(r.text));
  while (lastBigThree.length < 3) lastBigThree.push({ text: "", pct: "0" });
  if (lastBigThree.length > 3) lastBigThree = lastBigThree.slice(0, 3);
  const { completed, open, carry } = await scanDailyNotesInWeek(status.prevWeek, vaultScan);
  const context = {
    ...status,
    carrySuggestions: dedupeCarrySuggestions(carry),
    lastWeekCompleted: dedupeContextLines(completed),
    lastWeekOpen: dedupeContextLines(open),
    lastWeekWeeklyBigThree,
    bigThreeSuggestionWeek,
    draftStep: 0
  };
  return {
    ...context,
    initialData: defaultWizardData(lastBigThree)
  };
}
function defaultWizardData(lastBigThree) {
  return {
    wins: ["", "", ""],
    lastBigThree,
    retroReflect: "",
    rejuvenation: ["", "", ""],
    ideas: ["", "", "", "", "", ""],
    bigThree: ["", "", ""],
    scheduleEntries: []
  };
}
function assertCreatePayload(payload) {
  if (!payload.isoWeek.match(/^\d{4}-W\d{2}$/)) {
    throw new Error("invalid isoWeek");
  }
}
const WP_WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAILY_TEMPLATE_REL = "92.templates/Daily Note Template.md";
function loadDailyTemplate(vaultRoot, templatePath) {
  const fullPath = `${vaultRoot}/${templatePath}`;
  if (!node_fs.existsSync(fullPath)) return null;
  return node_fs.readFileSync(fullPath, "utf-8");
}
function dayAbbrevToDate(isoWeek, day) {
  const idx = WP_WEEK_DAYS.indexOf(day);
  if (idx < 0) return null;
  return datesInIsoWeek(isoWeek)[idx] ?? null;
}
function scheduleEntryTargetsDaily(entry) {
  return Boolean(entry.text.trim() && String(entry.day).trim());
}
function taskDedupeKey(task) {
  const slot = task.timeBlock ?? "";
  return `${task.scheduled ?? ""}|${slot}|${task.text.trim().toLowerCase()}`;
}
function entryToDailyTask(text, date, slot) {
  const gid = mintTaskId();
  const timeBlock = slot.trim() ? slot.replace(/\s+/g, "") : void 0;
  return {
    id: gid,
    gid,
    text: text.trim(),
    status: "open",
    section: timeBlock ? "day-plan" : "unscheduled",
    tags: [],
    scheduled: date,
    timeBlock,
    externalLinks: [],
    isTracker: false,
    isNote: false
  };
}
async function ensureDailyNote(date, settings) {
  const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
  if (node_fs.existsSync(path)) {
    const content2 = await promises.readFile(path, "utf-8");
    const parsed2 = parseDailyNote(content2, date);
    return { note: parsed2.note, raw: parsed2.raw, path };
  }
  const templatePath = settings.templatePath ?? DAILY_TEMPLATE_REL;
  const template = loadDailyTemplate(settings.root, templatePath);
  const content = generateNewNote(date, [], template);
  node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
  node_fs.writeFileSync(path, content, "utf-8");
  const parsed = parseDailyNote(content, date);
  logger.info("weekly-plan daily sync: created daily note", { path, date });
  return { note: parsed.note, raw: parsed.raw, path };
}
function writeDailyNote(path, note, raw) {
  const serialized = serializeDailyNote(note, raw);
  node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  node_fs.writeFileSync(tmp, serialized, "utf-8");
  node_fs.renameSync(tmp, path);
}
async function applyWeeklyScheduleToDailyNotes(isoWeek, entries, settings) {
  const byDate = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!scheduleEntryTargetsDaily(entry)) continue;
    const date = dayAbbrevToDate(isoWeek, entry.day);
    if (!date) continue;
    const list = byDate.get(date) ?? [];
    list.push(entry);
    byDate.set(date, list);
  }
  const datesUpdated = [];
  for (const [date, dayEntries] of byDate) {
    const { note, raw, path } = await ensureDailyNote(date, settings);
    const existing = new Set(note.tasks.map(taskDedupeKey));
    const toAdd = [];
    for (const entry of dayEntries) {
      const candidate = entryToDailyTask(entry.text, date, entry.slot);
      const key = taskDedupeKey(candidate);
      if (existing.has(key)) continue;
      existing.add(key);
      toAdd.push(candidate);
    }
    if (!toAdd.length) continue;
    const updated = { ...note, tasks: [...note.tasks, ...toAdd] };
    writeDailyNote(path, updated, raw);
    getTaskIds(updated);
    datesUpdated.push(date);
    logger.info("weekly-plan daily sync: appended scheduled tasks", {
      path,
      date,
      count: toAdd.length,
      taskIds: toAdd.map((t) => t.id)
    });
  }
  return { datesUpdated };
}
function normalizeSectionHeading(raw) {
  return raw.replace(/<sub>[\s\S]*?<\/sub>/gi, "").trim();
}
function splitMarkdownSections(content) {
  const lines = content.split("\n");
  const out = [];
  let currentHeading = "";
  let body = [];
  const flush = () => {
    if (!currentHeading) return;
    out.push({ heading: currentHeading, body: body.join("\n") });
  };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      flush();
      currentHeading = normalizeSectionHeading(h[1].trim());
      body = [];
      continue;
    }
    if (currentHeading) body.push(line);
  }
  flush();
  return out;
}
function sectionScore(body) {
  let score = 0;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("%%")) continue;
    if (/^>\s*\[!/.test(t)) continue;
    if (/^\d+\.\s*\[\s*\]\s*$/.test(t)) continue;
    if (/^\d+\.\s*\[Completion:\s*%?\]\s*$/i.test(t.replace(/^>\s*/, ""))) continue;
    if (t === "-" || t === "- [ ]") continue;
    score++;
  }
  return score;
}
function pickBestSection(sections, headingPattern) {
  const matches = sections.filter((s) => headingPattern.test(s.heading));
  if (!matches.length) return "";
  matches.sort((a, b) => sectionScore(b.body) - sectionScore(a.body));
  return matches[0].body;
}
function pickBestBulletSection(sections, headingPattern) {
  const matches = sections.filter((s) => headingPattern.test(s.heading));
  if (!matches.length) return "";
  matches.sort((a, b) => {
    const bulletsA = bulletTexts(a.body).length;
    const bulletsB = bulletTexts(b.body).length;
    if (bulletsB !== bulletsA) return bulletsB - bulletsA;
    return sectionScore(b.body) - sectionScore(a.body);
  });
  return matches[0].body;
}
function bulletTexts(body) {
  const out = [];
  for (const line of body.split("\n")) {
    let t = line.trim();
    if (!t) continue;
    while (t.startsWith(">")) t = t.replace(/^>\s*/, "").trim();
    const task = t.match(/^-\s*\[\s*\]\s*(.+)$/);
    if (task) {
      const text = task[1].trim();
      if (text && !isWeeklyPlanInstructionLine(text)) out.push(text);
      continue;
    }
    const plain = t.match(/^-\s+(.+)$/);
    if (plain) {
      const text = plain[1].trim();
      if (text && !isWeeklyPlanInstructionLine(text)) out.push(text);
      continue;
    }
    const numbered = t.match(/^\d+\.\s*(.+)$/);
    if (numbered) {
      let text = numbered[1].trim();
      text = text.replace(/^\[\s*\]\s*/, "").trim();
      if (text && !isWeeklyPlanInstructionLine(text)) out.push(text);
    }
  }
  return out;
}
function parseRetroSection(body) {
  const rows = [];
  for (const line of body.split("\n")) {
    let t = line.trim();
    if (!t) continue;
    while (t.startsWith(">")) t = t.replace(/^>\s*/, "").trim();
    const numbered = t.match(/^(\d+)\.\s*(.+)$/);
    if (numbered) t = numbered[2].trim();
    const completionBracket = t.match(/^\[Completion:\s*(n\/a|\d+%?)\]\s*(.*)$/i);
    if (completionBracket) {
      const raw = completionBracket[1].toLowerCase();
      const pct = raw === "n/a" ? "n/a" : String(parseInt(raw, 10) || 0);
      const text = completionBracket[2].trim();
      if (text && !isWeeklyPlanInstructionLine(text)) rows.push({ text, pct });
      continue;
    }
    const pctMatch = t.match(/^(.+?)\s*(?:—|–|-)\s*completion:\s*(n\/a|\d+%?)\s*$/i);
    if (pctMatch) {
      const text = pctMatch[1].trim();
      if (!text || isWeeklyPlanInstructionLine(text)) continue;
      const raw = pctMatch[2].toLowerCase();
      const pct = raw === "n/a" ? "n/a" : String(parseInt(raw, 10) || 0);
      rows.push({ text, pct });
    }
  }
  while (rows.length < 3) rows.push({ text: "", pct: "0" });
  return rows.slice(0, 3);
}
function parseReflection(body) {
  const parts = [];
  for (const line of body.split("\n")) {
    let t = line.trim();
    if (!t) continue;
    while (t.startsWith(">")) t = t.replace(/^>\s*/, "").trim();
    if (/^\[!/.test(t)) continue;
    if (/\(write something\)/i.test(t)) continue;
    if (t.startsWith("-")) {
      const m = t.match(/^-\s+(.+)$/);
      if (m?.[1]?.trim()) parts.push(m[1].trim());
      continue;
    }
    const numbered = t.match(/^\d+\.\s*(.+)$/);
    if (numbered?.[1]?.trim()) {
      parts.push(numbered[1].trim());
      continue;
    }
    parts.push(t);
  }
  return parts.join("\n").trim();
}
function padSlots(values, count) {
  const out = [...values];
  while (out.length < count) out.push("");
  return out.slice(0, count);
}
function scheduleItems(data) {
  const items = [];
  data.rejuvenation.forEach((t, i) => {
    const text = t.trim();
    if (text) items.push({ key: `rej_${i}`, text, kind: "Rejuvenation" });
  });
  data.bigThree.forEach((t, i) => {
    const text = t.trim();
    if (text) items.push({ key: `b3_${i}`, text, kind: "Big Three" });
  });
  data.ideas.forEach((t, i) => {
    const text = t.trim();
    if (text) items.push({ key: `idea_${i}`, text, kind: "Idea" });
  });
  return items;
}
function syncScheduleEntries(data) {
  const entries = [...data.scheduleEntries ?? []];
  scheduleItems(data).forEach((it) => {
    const primaryId = `ent_${it.key}`;
    let primary = entries.find((x) => x.id === primaryId);
    if (!primary) {
      entries.push({
        id: primaryId,
        sourceKey: it.key,
        text: it.text,
        kind: it.kind,
        day: "",
        slot: ""
      });
    } else {
      primary.text = it.text;
      primary.kind = it.kind;
    }
  });
  return entries;
}
function normalizeMatchText(s) {
  return s.toLowerCase().replace(/\s+\(\d+\)$/, "").replace(/\s*-\s*make plan\s*$/i, "").trim();
}
function matchScheduleToEntry(text, entries) {
  const norm = normalizeMatchText(text);
  for (const e of entries) {
    const base = normalizeMatchText(e.text);
    if (norm === base || norm.includes(base) || base.includes(norm)) return e;
  }
  for (const e of entries) {
    const base = normalizeMatchText(e.text);
    const firstWord = norm.split(/\s+/)[0];
    if (firstWord && firstWord.length > 4 && base.startsWith(firstWord)) return e;
  }
  return null;
}
function parseScheduleLines(body) {
  const out = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    const m = t.match(/^-\s*\[\s*\]\s*(\d{1,2}:\d{2}[–-]\d{1,2}:\d{2})\s+(.+)$/);
    if (m) out.push({ slot: m[1].replace(/\s+/g, ""), text: m[2].trim() });
  }
  return out;
}
function attachImportedSchedule(data, scheduleBody) {
  const lines = parseScheduleLines(scheduleBody);
  if (!lines.length) return { ...data, scheduleEntries: syncScheduleEntries(data) };
  let entries = syncScheduleEntries(data);
  for (const { slot, text } of lines) {
    let entry = matchScheduleToEntry(text, entries);
    if (!entry) {
      const ideas = [...data.ideas];
      const ideaIndex = ideas.length;
      ideas.push(text);
      data = { ...data, ideas: padSlots(ideas, 6).slice(0, Math.max(6, ideas.length)) };
      entries = syncScheduleEntries(data);
      entry = entries.find((e) => e.sourceKey === `idea_${ideaIndex}`) ?? null;
    }
    if (entry) {
      entry.text = text;
      entry.slot = slot;
      entry.day = "";
    }
  }
  return { ...data, scheduleEntries: entries };
}
function parseWeeklyPlanWizardDataFromMarkdown(content) {
  const sections = splitMarkdownSections(content);
  const winsBody = pickBestBulletSection(sections, /^AFTER ACTION REVIEW/i);
  const wins = padSlots(bulletTexts(winsBody), 3);
  const retroBody = pickBestSection(sections, /^Last Week'?s Big Three|^Last week Big Three/i);
  const lastBigThree = parseRetroSection(retroBody);
  const reflectBody = pickBestSection(sections, /^Reflection|^What worked/i);
  const retroReflect = parseReflection(reflectBody);
  const rejBody = pickBestSection(sections, /^REJUVENATION/i);
  const rejuvenation = padSlots(bulletTexts(rejBody), 3);
  const ideasBody = pickBestSection(sections, /^Ideas/i);
  const ideas = padSlots(bulletTexts(ideasBody), 6);
  const b3Body = pickBestSection(sections, /^WEEKLY BIG THREE|^Weekly Big Three/i);
  const bigThree = padSlots(bulletTexts(b3Body), 3);
  let data = {
    wins,
    lastBigThree,
    retroReflect,
    rejuvenation,
    ideas,
    bigThree,
    scheduleEntries: []
  };
  const scheduleBody = pickBestSection(sections, /^Schedule/i);
  data = attachImportedSchedule(data, scheduleBody);
  for (const e of data.scheduleEntries) {
    if (!e.id) e.id = `ent_import_${globalThis.crypto.randomUUID()}`;
  }
  return data;
}
function resolveVaultRoot() {
  const envRoot = process.env.ATELIER_TEST_VAULT_ROOT ?? process.env.ATELIER_VAULT_ROOT ?? null;
  if (envRoot) return envRoot;
  const root = loadConfig().vault.root;
  return root || null;
}
function resolveDefaultDate() {
  if (process.env.ATELIER_TEST_DATE) return process.env.ATELIER_TEST_DATE;
  const now = /* @__PURE__ */ new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function resolveVaultScan() {
  const root = resolveVaultRoot();
  if (!root) return null;
  const cfg = loadConfig().vault;
  return {
    root,
    dailyNotesFolder: cfg.dailyNotesFolder,
    notePathPattern: cfg.notePathPattern
  };
}
function registerWeeklyPlanHandlers() {
  electron.ipcMain.handle("weekly-plan:getStatus", () => {
    const date = resolveDefaultDate();
    return weeklyStatusForDate(resolveVaultRoot(), date);
  });
  electron.ipcMain.handle("weekly-plan:readNote", async (_event, isoWeekArg) => {
    const root = resolveVaultRoot();
    if (!root) throw new Error("no vault root configured");
    const date = resolveDefaultDate();
    const isoWeek = typeof isoWeekArg === "string" && isoWeekArg.trim() || formatIsoWeekKey(date);
    const path = resolveWeeklyNotePath(root, isoWeek);
    if (!node_fs.existsSync(path)) throw new Error(`weekly note not found: ${isoWeek}`);
    const markdown = await promises.readFile(path, "utf-8");
    return {
      isoWeek,
      relativePath: `02.weeklynotes/${isoWeek}.md`,
      markdown
    };
  });
  electron.ipcMain.handle(
    "weekly-plan:writeNote",
    async (_event, payload) => {
      const root = resolveVaultRoot();
      if (!root) throw new Error("no vault root configured");
      const isoWeek = payload.isoWeek?.trim();
      if (!isoWeek) throw new Error("isoWeek required");
      const path = resolveWeeklyNotePath(root, isoWeek);
      if (!node_fs.existsSync(path)) throw new Error(`weekly note not found: ${isoWeek}`);
      await promises.writeFile(path, payload.markdown, "utf-8");
      return { ok: true };
    }
  );
  electron.ipcMain.handle("weekly-plan:loadContext", async () => {
    const scan = resolveVaultScan();
    if (!scan) throw new Error("no vault root configured");
    const date = resolveDefaultDate();
    const ctx = await loadWeeklyPlanWizardContext(scan.root, date, scan);
    const draft = getWeeklyPlanDraftStore(openDatabase()).get(ctx.isoWeek);
    if (draft) {
      return {
        ...ctx,
        initialData: draft.data,
        draftStep: draft.step
      };
    }
    return { ...ctx, draftStep: 0 };
  });
  electron.ipcMain.handle("weekly-plan:saveDraft", (_event, payload) => {
    if (!payload?.isoWeek || typeof payload.step !== "number" || !payload.data) {
      throw new Error("invalid weekly plan draft payload");
    }
    getWeeklyPlanDraftStore(openDatabase()).save(payload.isoWeek, payload.step, payload.data);
    return { ok: true };
  });
  electron.ipcMain.handle("weekly-plan:clearDraft", (_event, isoWeek) => {
    if (!isoWeek) throw new Error("isoWeek required");
    getWeeklyPlanDraftStore(openDatabase()).clear(isoWeek);
    return { ok: true };
  });
  electron.ipcMain.handle(
    "weekly-plan:importDraftFromFile",
    async (_event, payload) => {
      if (!payload?.filePath?.trim()) throw new Error("filePath required");
      const scan = resolveVaultScan();
      if (!scan) throw new Error("no vault root configured");
      const { readFile: readFile2 } = await import("node:fs/promises");
      const content = await readFile2(payload.filePath, "utf-8");
      const data = parseWeeklyPlanWizardDataFromMarkdown(content);
      const date = resolveDefaultDate();
      const isoWeek = payload.isoWeek?.trim() || formatIsoWeekKey(date);
      const step = typeof payload.step === "number" ? payload.step : 0;
      getWeeklyPlanDraftStore(openDatabase()).save(isoWeek, step, data);
      logger.info("weekly-plan draft imported from file", { filePath: payload.filePath, isoWeek, step });
      return { ok: true, isoWeek, step };
    }
  );
  electron.ipcMain.handle("weekly-plan:create", async (_event, payload) => {
    assertCreatePayload(payload);
    const scan = resolveVaultScan();
    if (!scan) throw new Error("no vault root configured");
    const path = resolveWeeklyNotePath(scan.root, payload.isoWeek);
    const template = await loadWeeklyTemplate(scan.root);
    const markdown = buildWeeklyNoteMarkdown(template, payload.isoWeek, payload.data);
    await promises.mkdir(node_path.dirname(path), { recursive: true });
    await promises.writeFile(path, markdown, "utf-8");
    const cfg = loadConfig().vault;
    await applyWeeklyScheduleToDailyNotes(payload.isoWeek, payload.data.scheduleEntries, {
      root: scan.root,
      dailyNotesFolder: cfg.dailyNotesFolder,
      notePathPattern: cfg.notePathPattern,
      templatePath: cfg.templatePath
    });
    getWeeklyPlanDraftStore(openDatabase()).clear(payload.isoWeek);
    logger.info("weekly-plan created", { path, isoWeek: payload.isoWeek });
    return { path, relativePath: `02.weeklynotes/${payload.isoWeek}.md` };
  });
}
function rewriteNativePathOutOfAsar(filePath) {
  if (!filePath.includes("app.asar")) return filePath;
  if (filePath.includes("app.asar.unpacked")) {
    return filePath.replace(/app\.asar\.unpacked\.unpacked/g, "app.asar.unpacked");
  }
  return filePath.replace("app.asar", "app.asar.unpacked").replace("node_modules.asar", "node_modules.asar.unpacked");
}
function claudeNativePackageName() {
  const base = "@anthropic-ai/claude-agent-sdk";
  const { platform, arch } = process;
  if (platform === "linux") return `${base}-linux-${arch}`;
  if (platform === "win32") return `${base}-win32-${arch}`;
  if (platform === "darwin") return `${base}-darwin-${arch}`;
  return `${base}-${platform}-${arch}`;
}
function claudeExeName() {
  return process.platform === "win32" ? "claude.exe" : "claude";
}
function resolveClaudeCodeExecutable() {
  const pkg = claudeNativePackageName();
  const exe = claudeExeName();
  const candidates = [];
  if (electron.app.isPackaged) {
    candidates.push(node_path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", pkg, exe));
  }
  candidates.push(node_path.join(__dirname, "..", "..", "node_modules", pkg, exe));
  try {
    const req = node_module.createRequire(node_path.join(__dirname, "index.js"));
    candidates.push(req.resolve(`${pkg}/${exe}`));
  } catch {
  }
  for (const candidate of candidates) {
    const path = rewriteNativePathOutOfAsar(candidate);
    if (path.includes("/app.asar/") || path.includes("\\app.asar\\")) continue;
    if (node_fs.existsSync(path)) {
      logger.info("resolved claude code executable", { path });
      return path;
    }
  }
  logger.error("claude code executable not found", { pkg, candidates: candidates.map(rewriteNativePathOutOfAsar) });
  return void 0;
}
function resolveDefaultModel() {
  return defaultClaudeModelFromConfig(loadConfig());
}
function makeRemoteSpawner(host, remoteCwd) {
  return (opts) => {
    const claudePath = host.remoteExecutablePath ?? "claude";
    const remoteCommand = `cd ${remoteCdTarget(remoteCwd)} && exec ${shQuote(claudePath)} ${opts.args.map(shQuote).join(" ")}`;
    logger.info("spawning remote harness process over ssh", { sshHost: host.sshHost, remoteCwd });
    const child = node_child_process.spawn("ssh", ["-o", "BatchMode=yes", host.sshHost, "--", remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stderr?.on("data", (chunk) => {
      logger.debug("remote harness stderr", { sshHost: host.sshHost, chunk: chunk.toString("utf-8").slice(0, 2e3) });
    });
    return child;
  };
}
let sdkModulePromise;
function loadSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import("@anthropic-ai/claude-agent-sdk");
  }
  return sdkModulePromise;
}
class UserMessageQueue {
  buffered = [];
  waiters = [];
  closed = false;
  push(message) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
    } else {
      this.buffered.push(message);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()({ value: void 0, done: true });
    }
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const next = this.buffered.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: void 0, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}
function userMessage(text, image) {
  if (!image) {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null
    };
  }
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        ...text ? [{ type: "text", text }] : [],
        { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }
      ]
    },
    parent_tool_use_id: null
  };
}
class PushQueue {
  buffered = [];
  waiters = [];
  closed = false;
  push(value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffered.push(value);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()({ value: void 0, done: true });
    }
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const next = this.buffered.shift();
        if (next !== void 0) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: void 0, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}
function extractOutputText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => block && typeof block === "object" && "text" in block ? String(block.text) : "").join("\n");
  }
  return "";
}
function streamEventsFromPartial(sessionId, timestamp, parentToolUseId, rawEvent, active) {
  const event = rawEvent;
  const out = [];
  if (event.type === "content_block_start" && event.content_block) {
    const idx = event.index ?? 0;
    const block = event.content_block;
    active.streamBlocks.set(idx, {
      blockType: block.type,
      toolUseId: block.type === "tool_use" ? block.id : void 0,
      toolName: block.type === "tool_use" ? block.name : void 0
    });
    if (block.type === "thinking") {
      out.push({ type: "thinking_block_start", sessionId, timestamp, parentToolUseId });
    } else if (block.type === "tool_use" && block.id && block.name) {
      active.toolInputAcc.set(block.id, "");
      out.push({
        type: "tool_call_start",
        sessionId,
        timestamp,
        toolUseId: block.id,
        name: block.name,
        input: {},
        parentToolUseId
      });
    }
  }
  if (event.type === "content_block_delta" && event.delta) {
    if (event.delta.type === "text_delta" && event.delta.text) {
      out.push({ type: "text_delta", sessionId, timestamp, text: event.delta.text, parentToolUseId });
    }
    if (event.delta.type === "thinking_delta") {
      const chunk = event.delta.thinking;
      if (typeof chunk === "string" && chunk.length > 0) {
        out.push({ type: "thinking_delta", sessionId, timestamp, text: chunk, parentToolUseId });
      }
    }
    if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
      const meta = event.index != null ? active.streamBlocks.get(event.index) : void 0;
      const toolUseId = meta?.toolUseId;
      if (toolUseId) {
        const next = (active.toolInputAcc.get(toolUseId) ?? "") + event.delta.partial_json;
        active.toolInputAcc.set(toolUseId, next);
        out.push({
          type: "tool_input_delta",
          sessionId,
          timestamp,
          toolUseId,
          partialJson: next,
          parentToolUseId
        });
      }
    }
  }
  if (event.type === "content_block_stop") {
    const meta = event.index != null ? active.streamBlocks.get(event.index) : void 0;
    if (meta?.blockType === "thinking") {
      out.push({ type: "thinking_block_end", sessionId, timestamp, parentToolUseId });
    }
    if (event.index != null) active.streamBlocks.delete(event.index);
  }
  return out;
}
class ClaudeAgentSdkHarness {
  sessions = /* @__PURE__ */ new Map();
  async start(prompt, opts) {
    return this.launch(prompt, opts, { mode: "fresh" });
  }
  async startWithId(sessionId, prompt, opts) {
    return this.launch(prompt, opts, { mode: "fresh-with-id", sessionId });
  }
  async resume(sessionId, opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    return this.launch("", { ...opts, cwd }, { mode: "resume", sessionId });
  }
  async interrupt(sessionId) {
    const active = this.sessions.get(sessionId);
    if (!active) return;
    logger.info("harness.interrupt() called", { sessionId });
    active.interruptRequested = true;
    await active.query.interrupt().catch(() => void 0);
    active.queue.close();
    logger.info("harness.interrupt(): input queue closed", { sessionId });
  }
  /**
   * Validates a `/model <id>` slash command against the SDK's own live
   * acceptance logic, by calling the real `Query.setModel()` mutator on the
   * connected session and reporting whether it threw — rather than checking
   * against any static/curated list. Verified for real: `setModel()`
   * succeeds for both curated ids (`claude-sonnet-5`) and deliberately
   * uncurated-but-real ones (`claude-sonnet-4-6[1m]`, see Composer.tsx's
   * `MODEL_OPTIONS` comment for why that family isn't in the small picker),
   * and rejects genuine typos with the SDK's own error text (e.g. `Model
   * "aaa" is restricted by your organization's settings. Using
   * claude-sonnet-5 instead.`) — this is the only ground truth for "is this
   * a real model", since the backend otherwise silently substitutes the
   * default model for a bad id instead of erroring on it. `error: 'not
   * connected'` when the session has no live query to call this on yet.
   * The mutation itself is harmless even on success: Atelier's own
   * model/effort-change flow (see `manager.ts`'s "model/effort selection
   * changed, applying from next turn") always forces a fresh reconnect on
   * the next real turn regardless, discarding this query, so a validation
   * call here never leaks into a turn the user didn't actually confirm.
   */
  async validateModel(sessionId, model) {
    const active = this.sessions.get(sessionId);
    if (!active) return { ok: true };
    try {
      await active.query.setModel(model);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  /**
   * Settings / global-default validation when no user session is connected.
   * Spins a short-lived local probe session, runs the same `setModel()` check
   * as `validateModel`, then tears the probe down.
   */
  async validateClaudeModel(model) {
    const probe = await this.start("", { cwd: process.cwd(), keepAlive: true });
    try {
      return await this.validateModel(probe.sessionId, model);
    } finally {
      await this.interrupt(probe.sessionId);
    }
  }
  async streamInput(sessionId, message, image) {
    const active = this.sessions.get(sessionId);
    if (!active) return;
    const sdkMessage = userMessage(message, image);
    const contentBlockTypes = Array.isArray(sdkMessage.message.content) ? sdkMessage.message.content.map((block) => block.type) : ["text"];
    logger.info("harness.streamInput() called", {
      sessionId,
      textLength: message.length,
      hasImage: Boolean(image),
      imageMimeType: image?.mimeType,
      contentBlockTypes
    });
    active.queue.push(sdkMessage);
  }
  isActive(sessionId) {
    return this.sessions.has(sessionId);
  }
  async respondToPrompt(sessionId, requestId, response) {
    const active = this.sessions.get(sessionId);
    if (!active) {
      logger.warn("respondToPrompt: no active session", { sessionId, requestId, knownSessions: [...this.sessions.keys()] });
      return;
    }
    const resolve = active.pendingPrompts.get(requestId);
    if (!resolve) {
      logger.warn("respondToPrompt: no pending prompt for requestId", { sessionId, requestId });
      return;
    }
    active.pendingPrompts.delete(requestId);
    resolve(response);
    logger.info("respondToPrompt: resolved", { sessionId, requestId, kind: response.kind });
  }
  /**
   * 11-composer-mode-indicator: same `query.setPermissionMode()` call this
   * file already makes after an accepted `ExitPlanMode` (see `makeCanUseTool`
   * below), now exposed as a reusable driver method for the composer's
   * Shift+Tab cycle. A no-op when the session has no live connection right
   * now (e.g. cycled while idle/disconnected) — `SessionManager.cycleMode`
   * still records the new mode in its own tracked map either way, so it's
   * re-passed as `permissionMode` on this session's next `resume()`.
   */
  async setPermissionMode(sessionId, mode) {
    const active = this.sessions.get(sessionId);
    if (!active) {
      logger.info("setPermissionMode: no live session, mode will apply on next resume", { sessionId, mode });
      return;
    }
    await active.query.setPermissionMode(mode).catch((err) => {
      logger.warn("setPermissionMode: SDK call failed", { sessionId, mode, error: err instanceof Error ? err.message : String(err) });
    });
    logger.info("setPermissionMode: applied to live session", { sessionId, mode });
  }
  /**
   * Returns the current context usage for a live session, pulled directly
   * from the SDK's own context-usage query (token-usage-indicator). Use this
   * after a `result` harness event to get accurate token counts and the
   * auto-compact threshold (the real cap before compaction kicks in, which is
   * smaller than the model's total context window).
   * Returns `null` if the session is not live (no query object available).
   */
  async getContextUsage(sessionId) {
    const active = this.sessions.get(sessionId);
    if (!active) return null;
    try {
      const usage = await active.query.getContextUsage();
      return { totalTokens: usage.totalTokens, autoCompactThreshold: usage.autoCompactThreshold };
    } catch {
      return null;
    }
  }
  async launch(prompt, opts, spec) {
    const sdk = await loadSdk();
    const sessionId = spec.mode === "fresh" ? node_crypto.randomUUID() : spec.sessionId;
    const queue = new UserMessageQueue();
    if (prompt) queue.push(userMessage(prompt));
    const active = {
      // `query` is assigned right after `sdk.query(...)` below — TypeScript
      // can't see that from inside this object literal, so it's patched on
      // immediately afterward (still before anything can observe `active`).
      query: void 0,
      queue,
      interruptRequested: false,
      keepAlive: opts.keepAlive ?? false,
      eventQueue: new PushQueue(),
      pendingPrompts: /* @__PURE__ */ new Map(),
      taskItems: /* @__PURE__ */ new Map(),
      pendingTaskCalls: /* @__PURE__ */ new Map(),
      streamBlocks: /* @__PURE__ */ new Map(),
      toolInputAcc: /* @__PURE__ */ new Map()
    };
    const claudeExecutable = resolveClaudeCodeExecutable();
    if (!claudeExecutable) {
      throw new Error("Bundled Claude Code binary not found in this Atelier install.");
    }
    const options = {
      cwd: opts.cwd,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: claudeExecutable,
      ...spec.mode === "resume" ? { resume: sessionId } : { sessionId },
      model: opts.model ?? resolveDefaultModel(),
      ...opts.effort ? { effort: opts.effort } : {},
      ...opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {},
      ...opts.allowedTools ? { allowedTools: opts.allowedTools } : {},
      // Deliberately omitted when opts.env is undefined: per the SDK's
      // contract this makes the subprocess inherit process.env verbatim,
      // which is the auth-inheritance behavior this task must prove.
      ...opts.env ? { env: opts.env } : {},
      // Remote/devpod sessions: swap the local spawn for one that tunnels
      // over SSH. `cwd` above is still required by the SDK's types but is
      // meaningless to the (never-invoked) local spawn path in this case —
      // the real working directory is applied inside the ssh command itself.
      ...opts.host ? { spawnClaudeCodeProcess: makeRemoteSpawner(opts.host, opts.cwd) } : {},
      ...opts.permissionMode ? { permissionMode: opts.permissionMode } : {},
      promptSuggestions: true,
      // 05-interactive-prompts: every permission prompt, AskUserQuestion,
      // and ExitPlanMode call is gated through this one callback — see the
      // doc comment on ActiveSession.pendingPrompts and makeCanUseTool below.
      canUseTool: makeCanUseTool(sessionId, active)
    };
    const query = sdk.query({ prompt: queue, options });
    active.query = query;
    this.sessions.set(sessionId, active);
    void this.pump(sessionId, query, active);
    void query.initializationResult().then((initResult) => {
      active.eventQueue.push({
        type: "commands_updated",
        sessionId,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        commands: initResult.commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases
        }))
      });
    }).catch((err) => {
      logger.warn("initializationResult() failed; live slash-command list unavailable for this session", {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
    return { sessionId, events: this.drain(active) };
  }
  /** Pulls SDKMessages off `query`, normalizes them, and pushes the results onto `active.eventQueue` — see PushQueue's doc comment for why this can't just be a plain yielding generator anymore. */
  async pump(sessionId, query, active) {
    try {
      for await (const message of query) {
        for (const event of toHarnessEvents(sessionId, message, active)) {
          active.eventQueue.push(event);
        }
        if (message.type === "result") {
          if (active.interruptRequested) {
            active.eventQueue.push({ type: "interrupted", sessionId, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
            return;
          }
          if (!active.keepAlive) {
            return;
          }
          continue;
        }
      }
    } catch (err) {
      if (!active.interruptRequested) {
        active.eventQueue.push({
          type: "error",
          sessionId,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          message: err instanceof Error ? err.message : String(err)
        });
        void active.query.interrupt().catch(() => void 0);
      } else {
        active.eventQueue.push({ type: "interrupted", sessionId, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      }
    } finally {
      active.queue.close();
      active.eventQueue.close();
      if (this.sessions.get(sessionId) === active) {
        this.sessions.delete(sessionId);
      }
    }
  }
  async *drain(active) {
    for await (const event of active.eventQueue) {
      yield event;
    }
  }
}
function makeCanUseTool(sessionId, active) {
  function waitForResponse(requestId, emit) {
    return new Promise((resolve) => {
      active.pendingPrompts.set(requestId, resolve);
      const event = emit();
      logger.info("canUseTool: awaiting prompt response", { sessionId, requestId, eventType: event.type });
      active.eventQueue.push(event);
    });
  }
  return async (toolName, input, opts) => {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const requestId = opts.toolUseID;
    if (toolName === "AskUserQuestion") {
      const questions = input.questions ?? [];
      const response2 = await waitForResponse(requestId, () => ({
        type: "ask_user_question",
        sessionId,
        timestamp,
        requestId,
        toolUseId: requestId,
        questions
      }));
      if (response2.kind !== "ask_user_question") {
        return { behavior: "deny", message: "Internal error: mismatched prompt response" };
      }
      const updatedInput = { questions };
      if (response2.freeText) {
        updatedInput.response = response2.freeText;
      } else {
        updatedInput.answers = response2.answers;
      }
      return { behavior: "allow", updatedInput };
    }
    if (toolName === "ExitPlanMode") {
      const planInput = input;
      const response2 = await waitForResponse(requestId, () => ({
        type: "plan_proposed",
        sessionId,
        timestamp,
        requestId,
        toolUseId: requestId,
        plan: planInput.plan ?? "",
        planFilePath: planInput.planFilePath
      }));
      if (response2.kind !== "plan") {
        return { behavior: "deny", message: "Internal error: mismatched prompt response" };
      }
      if (response2.decision === "accept") {
        await active.query.setPermissionMode("default").catch(() => void 0);
        return { behavior: "allow", updatedInput: input };
      }
      const message = response2.feedback || (response2.decision === "keep_planning" ? "The user wants to keep exploring/refining the plan — do not exit plan mode yet." : "The user rejected this plan. Ask what they would like changed before proposing another.");
      return { behavior: "deny", message };
    }
    const addRulesSuggestion = opts.suggestions?.find(
      (s) => s.type === "addRules"
    );
    const suggestedPattern = addRulesSuggestion?.rules[0]?.ruleContent;
    const response = await waitForResponse(requestId, () => ({
      type: "permission_request",
      sessionId,
      timestamp,
      requestId,
      toolUseId: requestId,
      toolName,
      input,
      title: opts.title,
      description: opts.description,
      suggestedPattern
    }));
    if (response.kind !== "permission") {
      return { behavior: "deny", message: "Internal error: mismatched prompt response" };
    }
    if (response.decision === "deny") {
      return { behavior: "deny", message: "User denied this action" };
    }
    if (response.alwaysAllow && addRulesSuggestion) {
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: [{ ...addRulesSuggestion, destination: "session" }]
      };
    }
    return { behavior: "allow", updatedInput: input };
  };
}
function toHarnessEvents(sessionId, message, active) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  if (message.type === "system" && message.subtype === "init") {
    return [
      {
        type: "session_started",
        sessionId,
        timestamp,
        model: message.model,
        cwd: message.cwd,
        apiKeySource: message.apiKeySource
      }
    ];
  }
  if (message.type === "system" && message.subtype === "commands_changed") {
    return [
      {
        type: "commands_updated",
        sessionId,
        timestamp,
        commands: message.commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases
        }))
      }
    ];
  }
  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [
      {
        type: "compaction",
        sessionId,
        timestamp,
        trigger: message.compact_metadata.trigger,
        preTokens: message.compact_metadata.pre_tokens,
        postTokens: message.compact_metadata.post_tokens
      }
    ];
  }
  if (message.type === "system" && message.subtype === "thinking_tokens") {
    return [
      {
        type: "thinking_tokens",
        sessionId,
        timestamp,
        estimatedTokens: message.estimated_tokens,
        estimatedTokensDelta: message.estimated_tokens_delta
      }
    ];
  }
  if (message.type === "stream_event") {
    return streamEventsFromPartial(sessionId, timestamp, message.parent_tool_use_id, message.event, active);
  }
  if (message.type === "assistant") {
    const events = [];
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use") {
          events.push({
            type: "tool_call_start",
            sessionId,
            timestamp,
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            parentToolUseId: message.parent_tool_use_id
          });
          if (block.name === "TodoWrite") {
            const todos = block.input?.todos;
            if (Array.isArray(todos)) {
              events.push({ type: "todo_update", sessionId, timestamp, todos });
            }
          }
          if (block.name === "TaskCreate" || block.name === "TaskUpdate") {
            active.pendingTaskCalls.set(block.id, { name: block.name, input: block.input ?? {} });
          }
        }
      }
    }
    return events;
  }
  if (message.type === "user") {
    const events = [];
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          events.push({
            type: "tool_call_end",
            sessionId,
            timestamp,
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            output: block.content,
            parentToolUseId: message.parent_tool_use_id
          });
          const pendingTask = active.pendingTaskCalls.get(block.tool_use_id);
          if (pendingTask) {
            active.pendingTaskCalls.delete(block.tool_use_id);
            const outputText = extractOutputText(block.content);
            if (pendingTask.name === "TaskCreate") {
              const idMatch = outputText.match(/#(\d+)/);
              const taskId = idMatch?.[1] ?? block.tool_use_id;
              const subject = pendingTask.input.subject ?? pendingTask.input.description ?? "Task";
              active.taskItems.set(taskId, { content: subject, status: "pending" });
            } else {
              const taskId = String(pendingTask.input.taskId ?? block.tool_use_id);
              const existing = active.taskItems.get(taskId);
              const status = pendingTask.input.status ?? existing?.status ?? "pending";
              active.taskItems.set(taskId, { content: existing?.content ?? "Task", status });
            }
            events.push({ type: "todo_update", sessionId, timestamp, todos: [...active.taskItems.values()] });
          }
        }
      }
    }
    return events;
  }
  if (message.type === "tool_progress") {
    return [
      {
        type: "tool_progress",
        sessionId,
        timestamp,
        toolUseId: message.tool_use_id,
        toolName: message.tool_name,
        parentToolUseId: message.parent_tool_use_id,
        elapsedTimeSeconds: message.elapsed_time_seconds,
        ...message.task_id ? { taskId: message.task_id } : {}
      }
    ];
  }
  if (message.type === "prompt_suggestion") {
    return [
      {
        type: "prompt_suggestion",
        sessionId,
        timestamp,
        suggestion: message.suggestion
      }
    ];
  }
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    return [
      {
        type: "background_tasks_changed",
        sessionId,
        timestamp,
        tasks: message.tasks.map((t) => ({
          taskId: t.task_id,
          taskType: t.task_type,
          description: t.description
        }))
      }
    ];
  }
  if (message.type === "system" && message.subtype === "task_started") {
    return [
      {
        type: "task_started",
        sessionId,
        timestamp,
        taskId: message.task_id,
        description: message.description,
        taskType: message.task_type,
        subagentType: message.subagent_type,
        workflowName: message.workflow_name,
        skipTranscript: message.skip_transcript
      }
    ];
  }
  if (message.type === "system" && message.subtype === "task_updated") {
    return [
      {
        type: "task_updated",
        sessionId,
        timestamp,
        taskId: message.task_id,
        patch: {
          status: message.patch.status,
          description: message.patch.description,
          error: message.patch.error,
          isBackgrounded: message.patch.is_backgrounded
        }
      }
    ];
  }
  if (message.type === "system" && message.subtype === "task_progress") {
    return [
      {
        type: "task_progress",
        sessionId,
        timestamp,
        taskId: message.task_id,
        description: message.description,
        lastToolName: message.last_tool_name,
        summary: message.summary,
        usage: message.usage
      }
    ];
  }
  if (message.type === "system" && message.subtype === "task_notification") {
    return [
      {
        type: "task_notification",
        sessionId,
        timestamp,
        taskId: message.task_id,
        status: message.status,
        summary: message.summary
      }
    ];
  }
  if (message.type === "system" && message.subtype === "notification") {
    return [
      {
        type: "sdk_notification",
        sessionId,
        timestamp,
        key: message.key,
        text: message.text,
        priority: message.priority
      }
    ];
  }
  if (message.type === "system" && message.subtype === "permission_denied") {
    return [
      {
        type: "permission_denied",
        sessionId,
        timestamp,
        toolUseId: message.tool_use_id,
        toolName: message.tool_name,
        message: message.message
      }
    ];
  }
  if (message.type === "system" && message.subtype === "model_refusal_fallback") {
    return [
      {
        type: "model_refusal_fallback",
        sessionId,
        timestamp,
        fallbackModel: message.fallback_model,
        content: message.content
      }
    ];
  }
  if (message.type === "system" && message.subtype === "model_refusal_no_fallback") {
    return [
      {
        type: "model_refusal_no_fallback",
        sessionId,
        timestamp,
        content: message.content
      }
    ];
  }
  if (message.type === "system" && message.subtype === "status") {
    return [
      {
        type: "sdk_status",
        sessionId,
        timestamp,
        status: message.status,
        permissionMode: message.permissionMode,
        compactResult: message.compact_result,
        compactError: message.compact_error
      }
    ];
  }
  if (message.type === "system" && message.subtype === "api_retry") {
    return [
      {
        type: "api_retry",
        sessionId,
        timestamp,
        attempt: message.attempt,
        maxRetries: message.max_retries
      }
    ];
  }
  if (message.type === "rate_limit_event") {
    const info = message.rate_limit_info;
    return [
      {
        type: "rate_limit_event",
        sessionId,
        timestamp,
        status: info.status,
        resetsAt: info.resetsAt,
        utilization: info.utilization
      }
    ];
  }
  if (message.type === "system" && message.subtype === "local_command_output") {
    return [
      {
        type: "local_command_output",
        sessionId,
        timestamp,
        content: message.content
      }
    ];
  }
  if (message.type === "auth_status") {
    return [
      {
        type: "auth_status",
        sessionId,
        timestamp,
        isAuthenticating: message.isAuthenticating,
        error: message.error,
        output: message.output
      }
    ];
  }
  if (message.type === "system" && message.subtype === "hook_started") {
    return [
      {
        type: "hook_started",
        sessionId,
        timestamp,
        hookName: message.hook_name,
        hookEvent: message.hook_event
      }
    ];
  }
  if (message.type === "system" && message.subtype === "hook_progress") {
    const line = message.output || message.stdout || message.stderr;
    return [
      {
        type: "hook_progress",
        sessionId,
        timestamp,
        hookName: message.hook_name,
        hookEvent: message.hook_event,
        line
      }
    ];
  }
  if (message.type === "system" && message.subtype === "hook_response") {
    return [
      {
        type: "hook_response",
        sessionId,
        timestamp,
        hookName: message.hook_name,
        hookEvent: message.hook_event,
        outcome: message.outcome,
        exitCode: message.exit_code
      }
    ];
  }
  if (message.type === "system" && message.subtype === "worker_shutting_down") {
    return [
      {
        type: "worker_shutting_down",
        sessionId,
        timestamp,
        agentId: message.reason
      }
    ];
  }
  if (message.type === "result") {
    return [
      {
        type: "result",
        sessionId,
        timestamp,
        isError: message.is_error,
        subtype: message.subtype,
        result: message.subtype === "success" ? message.result : void 0,
        numTurns: message.num_turns,
        durationMs: message.duration_ms,
        totalCostUsd: message.total_cost_usd,
        usage: message.usage,
        // token-usage-indicator: per-model cumulative totals for this connection.
        // `ModelUsage` (sdk.d.ts:1234) has `inputTokens` and `contextWindow`
        // alongside cost/cache fields — cast to the minimal shape we need.
        modelUsage: message.modelUsage
      }
    ];
  }
  return [];
}
const TURN_INTERRUPTED_NOTICE = `The previous turn was stopped because ${APP_DISPLAY_NAME} closed while the assistant was still working. You can continue from the transcript below.`;
function normalizePath(p) {
  return p.replace(/\/$/, "");
}
const REMOTE_SESSION_HOME = "/home/user";
function expandTildePath(input, homeDir) {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) {
    const rest = trimmed.slice(2).replace(/\/+$/, "");
    return rest ? normalizePath(`${homeDir}/${rest}`) : homeDir;
  }
  if (trimmed.startsWith("/")) {
    const n = normalizePath(trimmed);
    return n || "/";
  }
  return normalizePath(`${homeDir}/${trimmed.replace(/\/+$/, "")}`);
}
function formatPathForDisplay(absPath, homeDir) {
  const n = normalizePath(absPath);
  if (n === homeDir) return "~";
  if (n.startsWith(`${homeDir}/`)) return `~${n.slice(homeDir.length)}`;
  return n;
}
function resolveProjectPathListContext(query, homeDir) {
  const trimmed = query;
  if (!trimmed) {
    return { listDir: homeDir, segmentFilter: "", pathPrefix: "" };
  }
  if (trimmed.endsWith("/")) {
    const without = trimmed.replace(/\/+$/, "");
    const listDir2 = without ? expandTildePath(without, homeDir) : homeDir;
    const pathPrefix2 = trimmed;
    return { listDir: listDir2, segmentFilter: "", pathPrefix: pathPrefix2 };
  }
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) {
    if (trimmed.startsWith("~")) {
      const expanded = expandTildePath(trimmed, homeDir);
      const innerSlash = expanded.lastIndexOf("/");
      if (innerSlash <= 0) {
        return { listDir: homeDir, segmentFilter: trimmed.slice(1), pathPrefix: "~/" };
      }
      const listDir2 = expanded.slice(0, innerSlash) || homeDir;
      const segmentFilter2 = expanded.slice(innerSlash + 1);
      const pathPrefix2 = trimmed.slice(0, trimmed.length - segmentFilter2.length);
      return { listDir: expandTildePath(listDir2, homeDir), segmentFilter: segmentFilter2, pathPrefix: pathPrefix2 };
    }
    return { listDir: homeDir, segmentFilter: trimmed, pathPrefix: "" };
  }
  const parentPart = trimmed.slice(0, lastSlash);
  const segmentFilter = trimmed.slice(lastSlash + 1);
  const listDir = parentPart ? expandTildePath(parentPart, homeDir) : homeDir;
  const pathPrefix = `${parentPart}/`;
  return { listDir, segmentFilter, pathPrefix };
}
function historyMatchesQuery(path, query) {
  if (!query.trim()) return true;
  return path.toLowerCase().includes(query.trim().toLowerCase());
}
function buildDirectorySuggestionValue(dirName, pathPrefix, absDirPath, homeDir) {
  if (pathPrefix) return `${pathPrefix}${dirName}/`;
  return `${formatPathForDisplay(absDirPath, homeDir)}/`;
}
function sessionHomeDir(hostId) {
  return hostId === "local" ? node_os.homedir() : REMOTE_SESSION_HOME;
}
async function suggestProjectPaths(hostId, query, store2, hosts) {
  const homeDir = sessionHomeDir(hostId);
  const history = store2.listRecentProjectPaths(hostId);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const path of history) {
    if (!historyMatchesQuery(path, query)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ kind: "history", value: path, label: path });
  }
  const { listDir, segmentFilter, pathPrefix } = resolveProjectPathListContext(query, homeDir);
  if (hostId === "local" && !node_fs.existsSync(listDir)) {
    return out.slice(0, 15);
  }
  const sshHost = hostId === "local" ? null : hosts.resolve(hostId)?.sshHost ?? null;
  try {
    const children = await walkDirChildren(listDir, listDir, sshHost);
    const lower = segmentFilter.toLowerCase();
    const dirs = children.filter((n) => n.type === "dir" && n.name.toLowerCase().startsWith(lower)).slice(0, 12);
    for (const node of dirs) {
      const value = buildDirectorySuggestionValue(node.name, pathPrefix, node.path, homeDir);
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ kind: "directory", value, label: `${node.name}/` });
    }
  } catch {
  }
  return out.slice(0, 15);
}
const DEFAULT_WORKTREE_ROOT = "~/.atelier/worktrees";
function worktreeRootFromConfig(config) {
  const trimmed = config.worktreeRoot?.trim();
  return trimmed || DEFAULT_WORKTREE_ROOT;
}
function sessionWorktreePath(worktreeRoot, sessionId, homeDir) {
  const root = expandTildePath(worktreeRoot, homeDir).replace(/\/$/, "");
  return `${root}/${sessionId}`;
}
function homeDirForWorktreeHost(hostId) {
  return hostId === "local" ? node_os.homedir() : REMOTE_SESSION_HOME;
}
const execFile = node_util.promisify(node_child_process.execFile);
const SSH_GIT_OPTS = SSH_REMOTE_OPTS;
const SSH_EXEC_TIMEOUT_MS = 5 * 6e4;
function parseGitProgress(text) {
  const m = text.match(/(?:Updating|Checking out) files:\s+(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
}
function spawnWithProgress(cmd, args, onProgress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = node_child_process.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let lastPct = -1;
    const handleChunk = (chunk) => {
      const text = chunk.toString("utf-8");
      output += text;
      if (onProgress) {
        for (const part of text.split(/[\r\n]/)) {
          const pct = parseGitProgress(part);
          if (pct !== null && pct !== lastPct) {
            lastPct = pct;
            onProgress(pct);
          }
        }
      }
    };
    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Command failed (exit ${code}): ${cmd} ${args.slice(-6).join(" ")}
${output.slice(-500)}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
async function ensureWorktreeRootExists(worktreeRoot, homeDir, hostname) {
  const absRoot = expandTildePath(worktreeRoot, homeDir);
  if (hostname) {
    await execFile("ssh", [...SSH_GIT_OPTS, hostname, "mkdir", "-p", absRoot], {
      encoding: "utf8",
      timeout: SSH_EXEC_TIMEOUT_MS
    });
  } else {
    node_fs.mkdirSync(absRoot, { recursive: true });
  }
}
async function createWorktree(projectPath, sessionId, worktreeRoot, homeDir, hostname, onProgress) {
  await ensureWorktreeRootExists(worktreeRoot, homeDir, hostname);
  const worktreePath = sessionWorktreePath(worktreeRoot, sessionId, homeDir);
  const branch = `atelier-${sessionId.slice(0, 8)}`;
  logger.info("worktree: creating", { projectPath, worktreePath, branch, worktreeRoot, hostname });
  if (hostname) {
    await spawnWithProgress(
      "ssh",
      [...SSH_GIT_OPTS, hostname, "git", "-C", projectPath, "worktree", "add", worktreePath, "-b", branch],
      onProgress,
      SSH_EXEC_TIMEOUT_MS
    );
    const { stdout } = await execFile(
      "ssh",
      [...SSH_GIT_OPTS, hostname, "realpath", worktreePath],
      { encoding: "utf8", timeout: SSH_EXEC_TIMEOUT_MS }
    );
    const resolved = stdout.trim();
    logger.info("worktree: created", { worktreePath: resolved, branch });
    return resolved;
  } else {
    node_fs.mkdirSync(node_path.dirname(worktreePath), { recursive: true });
    await spawnWithProgress(
      "git",
      ["-C", projectPath, "worktree", "add", worktreePath, "-b", branch],
      onProgress,
      SSH_EXEC_TIMEOUT_MS
    );
    logger.info("worktree: created", { worktreePath, branch });
    return worktreePath;
  }
}
async function removeWorktree(worktreePath, sessionId, projectPath, hostname) {
  if (!hostname && !node_fs.existsSync(worktreePath)) {
    logger.info("worktree: path does not exist, skipping removal", { worktreePath });
    return;
  }
  const branch = `atelier-${sessionId.slice(0, 8)}`;
  logger.info("worktree: removing", { worktreePath, projectPath, branch, hostname });
  if (hostname) {
    try {
      await execFile("ssh", [...SSH_GIT_OPTS, hostname, "git", "worktree", "remove", worktreePath, "--force"], {
        encoding: "utf8",
        timeout: SSH_EXEC_TIMEOUT_MS
      });
    } catch (err) {
      logger.warn("worktree: remote git worktree remove failed (ignored)", {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    try {
      await execFile("ssh", [...SSH_GIT_OPTS, hostname, "git", "-C", projectPath, "branch", "-D", branch], {
        encoding: "utf8",
        timeout: SSH_EXEC_TIMEOUT_MS
      });
    } catch (err) {
      logger.warn("worktree: remote git branch -D failed (ignored)", {
        branch,
        projectPath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } else {
    try {
      await execFile("git", ["worktree", "remove", worktreePath, "--force"], { encoding: "utf8" });
    } catch (err) {
      logger.warn("worktree: git worktree remove failed (ignored)", {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    try {
      await execFile("git", ["-C", projectPath, "branch", "-D", branch], { encoding: "utf8" });
    } catch (err) {
      logger.warn("worktree: git branch -D failed (ignored)", {
        branch,
        projectPath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  logger.info("worktree: removal complete", { worktreePath, branch });
}
function applyBashCdCommands(cwd, command) {
  let next = cwd;
  for (const segment of command.split(/(?:&&|\|\||;|\n)/)) {
    const part = segment.trim();
    const match = part.match(/^cd(?:\s+(.+?))?(?:\s|$)/);
    if (!match) continue;
    const arg = match[1]?.trim();
    if (arg === void 0 || arg === "") continue;
    if (arg === "-") continue;
    if (arg.startsWith("/")) next = node_path.normalize(arg);
    else if (arg.startsWith("~")) next = arg;
    else next = node_path.normalize(node_path.resolve(next, arg));
  }
  return next;
}
function formatRateLimitLabel(status, resetsAt, utilization) {
  const sendBlocked = status === "rejected";
  if (status === "allowed" && utilization == null) {
    return { warnLabel: null, sendBlocked: false };
  }
  const parts = [];
  if (status === "allowed_warning" || status === "rejected") {
    parts.push("Rate limit");
  }
  if (utilization != null) {
    parts.push(`${Math.round(utilization * 100)}%`);
  }
  if (resetsAt != null) {
    parts.push(
      `resets ${new Date(resetsAt * 1e3).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    );
  }
  return { warnLabel: parts.length ? parts.join(" · ") : null, sendBlocked };
}
function taskSubtitleFromProgress(event) {
  const parts = [];
  if (event.lastToolName) parts.push(`last: ${event.lastToolName}`);
  if (event.usage) {
    parts.push(`${event.usage.tool_uses} tool uses`);
    const sec = Math.round(event.usage.duration_ms / 1e3);
    if (sec >= 60) parts.push(`${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`);
    else if (sec > 0) parts.push(`${sec}s`);
  } else if (event.summary) {
    parts.push(event.summary);
  }
  return parts.join(" · ");
}
class SessionHarnessUiState {
  taskRows = /* @__PURE__ */ new Map();
  /**
   * After reset/reconnect, only task ids present in the latest
   * `background_tasks_changed` payload may exist in the rail. Replayed
   * `task_started` events from an old turn must not recreate dead jobs.
   */
  sdkChrome = /* @__PURE__ */ new Map();
  rateLimit = /* @__PURE__ */ new Map();
  auth = { message: null, isAuthenticating: false };
  resetSession(sessionId) {
    this.taskRows.set(sessionId, /* @__PURE__ */ new Map());
    this.sdkChrome.delete(sessionId);
    this.rateLimit.delete(sessionId);
  }
  taskAllowed(sessionId, taskId) {
    const map = this.taskRows.get(sessionId);
    return Boolean(map?.has(taskId));
  }
  getTasks(sessionId) {
    return [...this.taskRows.get(sessionId)?.values() ?? []];
  }
  getSdkChrome(sessionId) {
    return this.sdkChrome.get(sessionId) ?? null;
  }
  getRateLimit(sessionId) {
    return this.rateLimit.get(sessionId) ?? null;
  }
  getAuth() {
    return this.auth;
  }
  /** Clear ephemeral requesting/compacting chrome when the SDK omits `status: null`. */
  clearInFlightStatus(sessionId) {
    const cur = this.sdkChrome.get(sessionId);
    if (!cur) return;
    if (cur.compactFailed) {
      if (cur.apiRetryText) {
        this.sdkChrome.set(sessionId, { ...cur, apiRetryText: null });
      }
      return;
    }
    if (cur.status == null && !cur.apiRetryText) return;
    this.sdkChrome.set(sessionId, {
      status: null,
      permissionMode: void 0,
      compactFailed: false,
      compactError: void 0,
      apiRetryText: null
    });
  }
  apply(event) {
    const sid = event.sessionId;
    const side = {};
    switch (event.type) {
      case "background_tasks_changed": {
        const prev = this.taskRows.get(sid) ?? /* @__PURE__ */ new Map();
        const next = /* @__PURE__ */ new Map();
        for (const t of event.tasks) {
          const old = prev.get(t.taskId);
          next.set(t.taskId, {
            taskId: t.taskId,
            taskType: t.taskType,
            description: t.description,
            status: old?.status ?? "pending",
            subtitle: old?.subtitle,
            error: old?.error,
            done: old?.done
          });
        }
        this.taskRows.set(sid, next);
        break;
      }
      case "task_started": {
        const map = this.taskRows.get(sid);
        if (!map) break;
        const row = map.get(event.taskId);
        if (!row) break;
        const meta = [];
        if (event.subagentType) meta.push(event.subagentType);
        if (event.workflowName) meta.push(event.workflowName);
        row.taskType = event.taskType ?? row.taskType;
        row.description = event.description;
        row.status = "running";
        if (meta.length) row.subtitle = meta.join(" · ");
        break;
      }
      case "task_updated": {
        const map = this.taskRows.get(sid);
        if (!map) break;
        const row = map.get(event.taskId);
        if (!row) break;
        if (event.patch.status) {
          row.status = event.patch.status;
          if (event.patch.status === "pending" && !row.subtitle?.includes("last:")) {
            row.subtitle = void 0;
          }
        }
        if (event.patch.description) row.description = event.patch.description;
        if (event.patch.error) {
          row.error = event.patch.error;
          row.subtitle = `failed · ${event.patch.error}`;
        }
        if (event.patch.status === "completed" || event.patch.status === "failed" || event.patch.status === "killed") {
          row.done = true;
        }
        break;
      }
      case "task_progress": {
        if (!this.taskAllowed(sid, event.taskId)) break;
        const map = this.taskRows.get(sid);
        const row = map?.get(event.taskId);
        if (row) row.subtitle = taskSubtitleFromProgress(event);
        break;
      }
      case "task_notification": {
        if (!this.taskAllowed(sid, event.taskId)) break;
        const map = this.taskRows.get(sid);
        const row = map?.get(event.taskId);
        if (row) {
          row.done = true;
          row.status = event.status === "completed" ? "completed" : "failed";
          if (event.summary) row.description = event.summary;
        }
        break;
      }
      case "sdk_notification":
        if (event.priority === "immediate" || event.priority === "high") {
          side.toast = { key: event.key, text: event.text, priority: event.priority };
        }
        break;
      case "sdk_status": {
        if (event.status == null) {
          this.sdkChrome.set(sid, {
            status: null,
            apiRetryText: this.sdkChrome.get(sid)?.apiRetryText ?? null
          });
        } else if (event.compactResult === "failed") {
          this.sdkChrome.set(sid, {
            status: null,
            compactFailed: true,
            compactError: event.compactError,
            permissionMode: event.permissionMode,
            apiRetryText: null
          });
        } else {
          this.sdkChrome.set(sid, {
            status: event.status,
            permissionMode: event.permissionMode,
            compactFailed: false,
            compactError: void 0,
            apiRetryText: this.sdkChrome.get(sid)?.apiRetryText ?? null
          });
        }
        break;
      }
      case "api_retry": {
        const prev = this.sdkChrome.get(sid) ?? { status: null, apiRetryText: null };
        prev.apiRetryText = "Retrying API…";
        this.sdkChrome.set(sid, prev);
        break;
      }
      case "rate_limit_event":
        this.rateLimit.set(sid, formatRateLimitLabel(event.status, event.resetsAt, event.utilization));
        break;
      case "auth_status": {
        const msg = event.error ?? event.output.join(" ").trim();
        this.auth = {
          isAuthenticating: event.isAuthenticating,
          message: msg || (event.isAuthenticating ? "Signing in…" : null)
        };
        break;
      }
      case "hook_started":
        side.logHook = `hook ${event.hookEvent} · ${event.hookName}`;
        break;
      case "hook_progress":
        side.logHook = `hook ${event.hookEvent} · ${event.line}`;
        break;
      case "hook_response":
        side.logHook = `hook ${event.hookEvent} · ${event.outcome}${event.exitCode != null ? ` · ${event.exitCode}` : ""}`;
        break;
      case "worker_shutting_down":
        side.logHook = `worker subagent worker shutting down (${event.agentId ?? "unknown"})`;
        break;
    }
    return side;
  }
}
async function writeNoteAtPath(path, date, note, raw) {
  const serialized = serializeDailyNote(note, raw);
  node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await promises.writeFile(tmp, serialized, "utf-8");
  node_fs.renameSync(tmp, path);
  recordWrittenContentForPath(path, serialized);
  recordKnownIdsForPath(path, getTaskIds(note));
  logger.info("daily-note session-link write", { path, taskCount: note.tasks.length });
}
async function linkDailyTaskToSession(store2, getMainWindow, sessionId, noteDate, taskGid) {
  const settings = readVaultSettings();
  if (!settings) throw new Error("no vault root configured");
  const path = resolveNotePath(noteDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
  if (!node_fs.existsSync(path)) throw new Error(`daily note not found: ${noteDate}`);
  const content = await promises.readFile(path, "utf-8");
  const { note, raw, mintedIds } = parseDailyNote(content, noteDate);
  persistMintedGids(path, note, raw, mintedIds);
  const task = note.tasks.find((t) => t.id === taskGid);
  if (!task) throw new Error(`task not found: ${taskGid}`);
  const previousSessionId = task.linkedSessionId;
  if (previousSessionId && previousSessionId !== sessionId) {
    store2.clearLinkedDailyTask(previousSessionId);
  }
  const updatedTasks = note.tasks.map(
    (t) => t.id === taskGid ? { ...t, linkedSessionId: sessionId } : t
  );
  const updatedNote = { ...note, tasks: updatedTasks };
  await writeNoteAtPath(path, noteDate, updatedNote, raw);
  store2.setLinkedDailyTask(sessionId, taskGid, noteDate);
  notifyDailyNoteChanged(getMainWindow, updatedNote);
  return updatedNote;
}
async function completeLinkedDailyTask(store2, getMainWindow, sessionId) {
  const session = store2.getSession(sessionId);
  if (!session?.linkedDailyTaskGid || !session.linkedDailyNoteDate) return null;
  const settings = readVaultSettings();
  if (!settings) throw new Error("no vault root configured");
  const noteDate = session.linkedDailyNoteDate;
  const taskGid = session.linkedDailyTaskGid;
  const path = resolveNotePath(noteDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern);
  if (!node_fs.existsSync(path)) return null;
  const content = await promises.readFile(path, "utf-8");
  const { note, raw, mintedIds } = parseDailyNote(content, noteDate);
  persistMintedGids(path, note, raw, mintedIds);
  const updatedTasks = note.tasks.map((t) => {
    if (t.id !== taskGid) return t;
    return { ...t, status: "done", completion: noteDate };
  });
  const updatedNote = { ...note, tasks: updatedTasks };
  await writeNoteAtPath(path, noteDate, updatedNote, raw);
  notifyDailyNoteChanged(getMainWindow, updatedNote);
  return updatedNote;
}
const AUTO_NAME_STARTING_FROM_TURN = 2;
const AUTO_NAME_PROMPT = "Summarize this conversation topic in under 6 words. Reply with ONLY the title, no punctuation, no quotes.";
const SESSION_STARTUP_IDLE_MS = 60 * 60 * 1e3;
const MODE_CYCLE = ["default", "plan", "acceptEdits", "auto"];
function isConversationLostError(message) {
  return /no conversation found/i.test(message);
}
function isSessionLockRaceError(message) {
  return /is already in use/i.test(message);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function newLiveStream(turnCount = 0) {
  return {
    buffer: "",
    bufferMessageId: null,
    turnCount,
    connectionCostUsd: 0,
    pendingTools: /* @__PURE__ */ new Map(),
    busy: false,
    pendingPrompts: /* @__PURE__ */ new Map(),
    harnessCwd: null,
    thinkingMessageId: null,
    thinkingText: "",
    thinkingParentToolUseId: null
  };
}
class SessionManager {
  constructor(store2, harness, hosts, getWindow) {
    this.store = store2;
    this.harness = harness;
    this.hosts = hosts;
    this.getWindow = getWindow;
  }
  live = /* @__PURE__ */ new Map();
  /** Sessions currently between a triggered `reconnect()` and the live harness connection actually being (re)established — see `getStatus()`'s 'connecting' case (fix-session-resume-stale-sigterm-and-no-connect-indicator). */
  connecting = /* @__PURE__ */ new Set();
  /** Sessions currently being set up with an async worktree creation — see `getStatus()`'s 'creating-worktree' case. */
  creatingWorktree = /* @__PURE__ */ new Set();
  /** Open claude-code sessions left disconnected on launch due to 1h+ inactivity (session-startup-idle). */
  startupIdle = /* @__PURE__ */ new Set();
  /** After reconnect(), the first harness event triggers panel preload in the renderer. */
  pendingPanelPreload = /* @__PURE__ */ new Set();
  /** startupReconnect() paths — must not bump last_active_at when the harness connects. */
  startupAutoReconnect = /* @__PURE__ */ new Set();
  /**
   * Tracks the current SDK permission mode for a session (05-interactive-
   * prompts; generalized from plan-only to all 4 `MODE_CYCLE` values in
   * 11-composer-mode-indicator), across `resume()` reconnects. The SDK's
   * `permissionMode` is per-`query()` call, NOT restored automatically from a
   * `--resume`d session's history — verified live: without re-passing
   * `permissionMode: 'plan'` on every `harness.resume()` call while a plan is
   * still un-approved, a follow-up composer message reconnects in the SDK's
   * default mode, and a REJECTED plan's `ExitPlanMode` retry then fails
   * outright ("I'm no longer in plan mode") because the CLI itself
   * short-circuits the tool before `canUseTool` is ever invoked. Populated
   * for sessions started with `planMode: true` (-> `'plan'`) and any session
   * whose composer has cycled its mode at least once; absent (treated as
   * `'default'` via `decorate()` below) for every other session, unchanged
   * from before this task. Flips to `'default'` the moment a plan is
   * genuinely accepted (see `respondToPrompt` below), mirroring the real
   * SDK-side state transition — a cycle initiated after that starts counting
   * from `'default'` again, same as a session that was never in plan mode.
   */
  permissionModes = /* @__PURE__ */ new Map();
  /**
   * Tracks the model/effort override currently applied to a session's live
   * harness connection (10f-enrichment-model-effort-picker), across
   * `resume()` reconnects — same "sticky, re-passed on every reconnect"
   * pattern as `permissionModes` above. Populated the first time
   * `sendUserMessage` is called with an explicit override; absent entirely
   * for a session whose composer never touched the model/effort picker (in
   * which case every `resume()`/`start()` call omits `model`/`effort`
   * altogether, preserving the harness's own default — unchanged from every
   * caller that predates this task).
   */
  modelSelections = /* @__PURE__ */ new Map();
  harnessUi = new SessionHarnessUiState();
  workspace = null;
  setWorkspaceService(workspace) {
    this.workspace = workspace;
  }
  getWorkspaceService() {
    return this.workspace;
  }
  /**
   * Overlays the tracked-in-memory `permissionModes` entry (or `'default'`)
   * onto a DB-sourced `SessionRecord` (11-composer-mode-indicator) — mode is
   * NOT a DB column (same non-persisted-across-a-real-app-relaunch tradeoff
   * the pre-existing plan-mode tracking already made; see `permissionModes`'
   * doc comment), so every read path that hands a `SessionRecord` to the
   * renderer must go through this rather than returning the store's row
   * as-is.
   */
  decorate(session) {
    return {
      ...session,
      permissionMode: this.permissionModes.get(session.id) ?? session.permissionMode,
      modelSelection: this.modelSelections.get(session.id) ?? session.modelSelection ?? null
    };
  }
  listActive() {
    return this.store.listActiveSessions().map((s) => this.decorate(s));
  }
  listHistory() {
    return this.store.listHistorySessions().map((s) => this.decorate(s));
  }
  listMessages(sessionId) {
    return this.store.listMessages(sessionId);
  }
  listSessionFileEdits(sessionId) {
    return this.store.listSessionFileEdits(sessionId);
  }
  /** Looks up a single session record by id (10c-enrichment-export-conversation), undefined if it doesn't exist. */
  getSession(sessionId) {
    const session = this.store.getSession(sessionId);
    return session ? this.decorate(session) : void 0;
  }
  getSessionWorkspaceSnapshot(sessionId) {
    return this.workspace?.getCached(sessionId) ?? null;
  }
  async refreshSessionWorkspace(sessionId, force) {
    const session = this.getSession(sessionId);
    if (!session || session.mode !== "claude-code" || !this.workspace) return null;
    return this.workspace.refreshWorkspace(session, force);
  }
  /** Cross-session content search (10b-enrichment-full-text-search), backing the command palette's extended "Session" results. */
  searchMessages(query) {
    return this.store.searchMessages(query);
  }
  listHosts() {
    return this.hosts.list();
  }
  /** Recently-used project paths for `hostId` ('local' or a RemoteHostOption.id), newest first (fix-bug-triage-jul31 / bug #49). */
  listRecentProjectPaths(hostId) {
    return this.store.listRecentProjectPaths(hostId);
  }
  suggestProjectPaths(hostId, query) {
    return suggestProjectPaths(hostId, query, this.store, this.hosts);
  }
  sendLifecycle(event) {
    logger.info("session lifecycle event", {
      event: event.type,
      sessionId: "session" in event ? event.session.id : event.sessionId,
      // Full record on rename/close/resume/fork so e2e can grep e.g.
      // `"event":"session.renamed"` alongside `"nameLockedByUser":true` on
      // the SAME line, per e2e-test-plan.md's proof-artifact expectations.
      session: "session" in event ? event.session : void 0,
      sourceId: "sourceId" in event ? event.sourceId : void 0
    });
    this.getWindow()?.webContents.send("session:lifecycle", event);
  }
  sendMessage(sessionId, message) {
    this.getWindow()?.webContents.send("session:message", { sessionId, message });
  }
  /** Live, unpersisted token-level push for the in-progress assistant text message `messageId` — see `SessionStreamDeltaEvent`. */
  sendStreamDelta(sessionId, messageId, text) {
    this.getWindow()?.webContents.send("session:streamDelta", { sessionId, messageId, text });
  }
  // ── Live status (06-session-organization) ────────────────────────────
  //
  // See SessionStatus's doc comment (shared/session-types.ts) for the exact
  // definitions. Pushed to EVERY sidebar row in real time — not just the
  // currently-viewed session — via `session:status`, independent of which
  // session (if any) is focused in the renderer.
  /** 'creating-worktree' while the async worktree setup is in flight; 'connecting' while `reconnect()` is in flight; 'startup-idle' when launch skipped auto reconnect due to 1h+ inactivity; 'working'/'waiting' for any session with a live entry this app run; 'idle' otherwise. */
  getStatus(sessionId) {
    if (this.creatingWorktree.has(sessionId)) return "creating-worktree";
    if (this.connecting.has(sessionId)) return "connecting";
    if (!this.live.has(sessionId) && this.isSessionStartupIdle(sessionId)) return "startup-idle";
    const live = this.live.get(sessionId);
    if (!live) return "idle";
    return live.busy ? "working" : "waiting";
  }
  /** Snapshot of every open session's live/startup status for the renderer's initial paint. */
  listStatuses() {
    const result = {};
    for (const session of this.store.listActiveSessions()) {
      result[session.id] = this.getStatus(session.id);
    }
    return result;
  }
  /**
   * Classifies 1h+ inactive claude-code sessions before the renderer can
   * select them (session-startup-idle). Must run synchronously at launch,
   * not inside the delayed startupReconnect() window.
   *
   * idle-session-auto-history: eligible sessions are auto-closed into History
   * instead of staying in the active sidebar as startup-idle.
   */
  markStartupIdleSessions() {
    for (const session of this.store.listActiveSessions()) {
      if (session.mode !== "claude-code") continue;
      if (!this.sessionIsStartupIdleEligible(session)) continue;
      this.closeSession(session.id);
    }
  }
  touchLastActive(sessionId) {
    this.store.touchLastActive(sessionId);
  }
  /** Restores auto-naming turn bookkeeping after a harness reconnect (session-startup-idle). */
  initialTurnCountForReconnect(sessionId) {
    return this.store.listMessages(sessionId).filter((m) => m.role === "user").length;
  }
  sessionIsStartupIdleEligible(session) {
    const last = Date.parse(session.lastActiveAt);
    if (Number.isNaN(last)) return false;
    return Date.now() - last > SESSION_STARTUP_IDLE_MS;
  }
  sendReconnectComplete(sessionId) {
    this.getWindow()?.webContents.send("session:reconnectComplete", { sessionId });
  }
  /** Records user focus on a session (sidebar select) for startup-idle eligibility. */
  touchSessionActive(sessionId) {
    if (!this.store.getSession(sessionId)) return;
    if (this.isSessionStartupIdle(sessionId)) return;
    this.touchLastActive(sessionId);
  }
  /** Open claude-code session left disconnected on launch (session-startup-idle). */
  isSessionStartupIdle(sessionId) {
    if (this.live.has(sessionId) || this.connecting.has(sessionId)) return false;
    if (this.startupIdle.has(sessionId)) return true;
    const session = this.store.getSession(sessionId);
    if (!session || session.mode !== "claude-code" || session.closedAt) return false;
    return this.sessionIsStartupIdleEligible(session);
  }
  /**
   * idle-session-auto-history: long-inactive disconnected claude-code sessions
   * (`startup-idle`) are closed into History automatically. Plain `idle`
   * (e.g. right after a failed reconnect) is left in the active list so errors
   * stay visible until the user closes manually.
   */
  maybeAutoCloseIdleSessionToHistory(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session || session.closedAt || session.mode !== "claude-code") return false;
    if (this.live.has(sessionId) || this.connecting.has(sessionId) || this.creatingWorktree.has(sessionId) || this.startupAutoReconnect.has(sessionId)) {
      return false;
    }
    if (this.getStatus(sessionId) !== "startup-idle") return false;
    this.closeSession(sessionId);
    return true;
  }
  sendStatus(sessionId) {
    if (this.maybeAutoCloseIdleSessionToHistory(sessionId)) return;
    this.getWindow()?.webContents.send("session:status", { sessionId, status: this.getStatus(sessionId) });
  }
  /**
   * Pushes the composer's Send/Stop toggle state (04-composer-core). `true`
   * from the moment a turn is kicked off (initial prompt, a follow-up via
   * `sendUserMessage`, or streamed live into an in-flight turn) until its
   * terminal harness event (`result`/`interrupted`/`error`) is applied —
   * independent of `HarnessDriver.isActive`, which now (see `normalize()`'s
   * fix in this task) stays true across idle gaps between turns too and so
   * can no longer be used as a busy signal on its own.
   */
  sendTurnState(sessionId, busy) {
    this.getWindow()?.webContents.send("session:turnState", { sessionId, busy });
    if (!busy) this.clearInFlightSdkChrome(sessionId);
  }
  /**
   * Live slash-command registry push (bug #56) — see `SessionCommandsEvent`'s
   * doc comment (shared/session-types.ts). Fired once shortly after
   * start/resume (from the harness's `commands_updated` event, itself
   * sourced from the SDK's `query.initializationResult()`) and again on any
   * mid-session `commands_changed` push from the SDK. Always the FULL
   * replacement list — never a delta.
   */
  sendWorktreeProgress(sessionId, percent) {
    this.getWindow()?.webContents.send("session:worktreeProgress", { sessionId, percent });
  }
  sendTokenUsage(sessionId, inputTokens, contextWindow) {
    this.getWindow()?.webContents.send("session:tokenUsage", { sessionId, inputTokens, contextWindow });
  }
  sendPromptSuggestion(sessionId, suggestion) {
    this.getWindow()?.webContents.send("session:promptSuggestion", { sessionId, suggestion });
  }
  sendBackgroundTasks(sessionId) {
    const payload = {
      sessionId,
      tasks: this.harnessUi.getTasks(sessionId)
    };
    this.getWindow()?.webContents.send("session:backgroundTasks", payload);
  }
  sendSdkChrome(sessionId) {
    const chrome = this.harnessUi.getSdkChrome(sessionId);
    const payload = {
      sessionId,
      status: chrome?.compactFailed ? null : chrome?.status ?? null,
      permissionMode: chrome?.permissionMode,
      compactFailed: chrome?.compactFailed,
      compactError: chrome?.compactError,
      apiRetryText: chrome?.apiRetryText ?? null
    };
    this.getWindow()?.webContents.send("session:sdkChrome", payload);
  }
  clearInFlightSdkChrome(sessionId) {
    this.harnessUi.clearInFlightStatus(sessionId);
    this.sendSdkChrome(sessionId);
  }
  sendRateLimitChrome(sessionId) {
    const rl = this.harnessUi.getRateLimit(sessionId);
    const payload = {
      sessionId,
      warnLabel: rl?.warnLabel ?? null,
      sendBlocked: rl?.sendBlocked ?? false
    };
    this.getWindow()?.webContents.send("session:rateLimit", payload);
  }
  sendSdkToast(sessionId, toast) {
    this.getWindow()?.webContents.send("session:sdkToast", toast);
  }
  sendAuthStatus() {
    const auth = this.harnessUi.getAuth();
    const payload = {
      message: auth.message,
      isAuthenticating: auth.isAuthenticating
    };
    this.getWindow()?.webContents.send("session:authStatus", payload);
  }
  resetHarnessUiForSession(sessionId) {
    this.harnessUi.resetSession(sessionId);
    this.sendBackgroundTasks(sessionId);
    this.sendSdkChrome(sessionId);
    this.sendRateLimitChrome(sessionId);
  }
  applyHarnessUiSideEffects(sessionId, event) {
    const uiTypes = /* @__PURE__ */ new Set([
      "background_tasks_changed",
      "task_started",
      "task_updated",
      "task_progress",
      "task_notification",
      "sdk_notification",
      "sdk_status",
      "api_retry",
      "rate_limit_event",
      "auth_status",
      "hook_started",
      "hook_progress",
      "hook_response",
      "worker_shutting_down"
    ]);
    if (!uiTypes.has(event.type)) return;
    const side = this.harnessUi.apply(event);
    this.sendBackgroundTasks(sessionId);
    this.sendSdkChrome(sessionId);
    this.sendRateLimitChrome(sessionId);
    if (event.type === "auth_status") this.sendAuthStatus();
    if (side.toast) {
      this.sendSdkToast(sessionId, { sessionId, ...side.toast });
    }
    if (side.logHook) {
      logger.info("harness hook", { sessionId, line: side.logHook });
      this.getWindow()?.webContents.send("session:hookLog", { sessionId, line: side.logHook });
    }
  }
  sendCommands(sessionId, commands) {
    this.getWindow()?.webContents.send("session:commands", { sessionId, commands });
  }
  sendHarnessCwd(sessionId, cwd) {
    this.getWindow()?.webContents.send("session:harnessCwd", { sessionId, cwd });
  }
  resolveHost(hostId) {
    if (hostId === "local") return void 0;
    const host = this.hosts.resolve(hostId);
    if (!host) throw new Error(`Unknown host id: ${hostId}`);
    return { sshHost: host.sshHost, remoteExecutablePath: host.remoteExecutablePath };
  }
  /**
   * Re-derives a RemoteHost (including remoteExecutablePath) from a stored
   * session's `hostname` column alone. Sessions only persist the SSH
   * hostname string, not the full host-option record, so resume/reconnect/
   * auto-naming all have to look it back up by hostname rather than reusing
   * a stale `{ sshHost }`-only object (which previously dropped
   * remoteExecutablePath on every path except the initial create, breaking
   * remote sessions with a bare, unresolvable `claude` on PATH after the
   * first turn).
   */
  resolveHostFromSession(hostname) {
    if (!hostname) return void 0;
    const host = this.hosts.resolveByHostname(hostname);
    return { sshHost: hostname, remoteExecutablePath: host?.remoteExecutablePath };
  }
  // ── Create ──────────────────────────────────────────────────────────
  defaultModelSelection() {
    const cfg = loadConfig();
    return {
      model: defaultClaudeModelFromConfig(cfg),
      effort: defaultClaudeEffortFromConfig(cfg)
    };
  }
  defaultHarnessModelOpts() {
    const { model, effort } = this.defaultModelSelection();
    return { model, effort };
  }
  seedDefaultModelSelection(sessionId) {
    const selection = this.defaultModelSelection();
    this.modelSelections.set(sessionId, selection);
    this.store.setModelSelection(sessionId, selection);
  }
  async createSession(opts) {
    const host = this.resolveHost(opts.hostId);
    const hostOption = opts.hostId === "local" ? void 0 : this.hosts.resolve(opts.hostId);
    const defaultName = deriveDefaultName(opts.projectPath, opts.prompt);
    this.store.recordProjectPathUsage(opts.hostId, opts.projectPath);
    if (opts.mode === "terminal") {
      const session2 = this.store.createSession({
        name: opts.suggestedName?.trim() || deriveDefaultName(opts.projectPath, opts.prompt),
        projectPath: opts.projectPath,
        mode: "terminal",
        hostname: hostOption?.sshHost ?? null,
        groupId: opts.groupId ?? null
      });
      this.sendLifecycle({ type: "session.created", session: session2 });
      if (session2.hostname) void warmRemoteGitHost(session2.hostname);
      return session2;
    }
    let effectiveCwd = opts.projectPath;
    const wantWorktree = !!opts.useWorktree;
    const hostname = hostOption?.sshHost;
    if (wantWorktree) {
      const { randomUUID } = await import("node:crypto");
      const allocatedId = randomUUID();
      const session2 = this.decorate(
        this.store.createSession({
          id: allocatedId,
          name: defaultName,
          projectPath: opts.projectPath,
          mode: "claude-code",
          hostname: hostOption?.sshHost ?? null,
          groupId: opts.groupId ?? null,
          worktreePath: null
        })
      );
      this.sendLifecycle({ type: "session.created", session: session2 });
      if (session2.hostname) void warmRemoteGitHost(session2.hostname);
      this.seedDefaultModelSelection(allocatedId);
      this.creatingWorktree.add(allocatedId);
      this.sendStatus(allocatedId);
      void this.setupWorktreeAsync(allocatedId, opts, host, hostOption, hostname);
      return session2;
    }
    const harnessSession = await this.harness.start(opts.prompt ?? "", {
      cwd: effectiveCwd,
      host,
      // Real interactive chat session: stays connected past its first turn
      // so a later `sendUserMessage` can inject live via `streamInput()`
      // instead of always reconnecting — see `HarnessStartOptions.keepAlive`.
      keepAlive: true,
      ...this.defaultHarnessModelOpts(),
      ...opts.planMode ? { permissionMode: "plan" } : {}
    });
    if (opts.planMode) {
      this.permissionModes.set(harnessSession.sessionId, "plan");
      this.store.setPermissionMode(harnessSession.sessionId, "plan");
    }
    const session = this.decorate(
      this.store.createSession({
        id: harnessSession.sessionId,
        name: defaultName,
        projectPath: opts.projectPath,
        mode: "claude-code",
        hostname: hostOption?.sshHost ?? null,
        groupId: opts.groupId ?? null,
        worktreePath: null
      })
    );
    if (opts.prompt) {
      const userMessage2 = this.store.addMessage({ sessionId: session.id, role: "user", content: opts.prompt });
      this.sendMessage(session.id, userMessage2);
    }
    this.sendLifecycle({ type: "session.created", session });
    if (session.hostname) void warmRemoteGitHost(session.hostname);
    this.seedDefaultModelSelection(session.id);
    this.live.set(session.id, newLiveStream());
    this.resetHarnessUiForSession(session.id);
    this.pendingPanelPreload.add(session.id);
    if (opts.prompt) {
      this.live.get(session.id).busy = true;
      this.sendStatus(session.id);
      this.sendTurnState(session.id, true);
    }
    void this.consume(session.id, harnessSession.events);
    return session;
  }
  // ── Resume ──────────────────────────────────────────────────────────
  /**
   * Async worktree setup for `createSession` (use-worktree): runs after the
   * session record has already been created and `session:created` has been
   * broadcast so the sidebar row is visible in the 'creating-worktree' state.
   * On success: persists the worktree path, removes the 'creating-worktree'
   * flag, starts the harness, and transitions the row to its live status.
   * On failure: cleans up the creatingWorktree flag, deletes the session row,
   * and broadcasts `session:deleted` so the row disappears from the sidebar.
   */
  async setupWorktreeAsync(sessionId, opts, host, hostOption, hostname) {
    try {
      const cfg = loadConfig();
      const worktreeRoot = worktreeRootFromConfig(cfg);
      const homeDir = homeDirForWorktreeHost(opts.hostId);
      const worktreePath = await createWorktree(
        opts.projectPath,
        sessionId,
        worktreeRoot,
        homeDir,
        hostname,
        (pct) => {
          this.sendWorktreeProgress(sessionId, pct);
        }
      );
      logger.info("setupWorktreeAsync: worktree created", { sessionId, worktreePath });
      this.store.setWorktreePath(sessionId, worktreePath);
      const harnessOpts = {
        cwd: worktreePath,
        host,
        keepAlive: true,
        ...this.defaultHarnessModelOpts(),
        ...opts.planMode ? { permissionMode: "plan" } : {}
      };
      const harnessSession = await this.harness.startWithId(sessionId, opts.prompt ?? "", harnessOpts);
      if (opts.planMode) {
        this.permissionModes.set(harnessSession.sessionId, "plan");
        this.store.setPermissionMode(harnessSession.sessionId, "plan");
      }
      if (opts.prompt) {
        const userMessage2 = this.store.addMessage({ sessionId, role: "user", content: opts.prompt });
        this.sendMessage(sessionId, userMessage2);
      }
      this.creatingWorktree.delete(sessionId);
      this.live.set(sessionId, newLiveStream());
      this.resetHarnessUiForSession(sessionId);
      this.pendingPanelPreload.add(sessionId);
      if (opts.prompt) {
        this.live.get(sessionId).busy = true;
      }
      this.sendStatus(sessionId);
      if (opts.prompt) this.sendTurnState(sessionId, true);
      void this.consume(sessionId, harnessSession.events);
    } catch (err) {
      logger.warn("setupWorktreeAsync: failed, removing session", {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      });
      this.creatingWorktree.delete(sessionId);
      const stored = this.store.getSession(sessionId);
      if (stored?.worktreePath) {
        void removeWorktree(stored.worktreePath, sessionId, stored.projectPath, hostname).catch(() => void 0);
      }
      this.store.deleteSession(sessionId);
      this.sendLifecycle({ type: "session.deleted", sessionId });
    }
  }
  /** Reopens a closed session and returns it + its full stored transcript synchronously (renderer renders this BEFORE the live reconnect below happens). */
  resumeSnapshot(sessionId) {
    const existing = this.store.getSession(sessionId);
    if (!existing) throw new Error(`Unknown session: ${sessionId}`);
    const session = this.decorate(this.store.reopenSession(sessionId) ?? existing);
    this.finalizeStaleRunningToolCalls(sessionId);
    this.deliverPendingTurnInterruptedNotice(sessionId);
    const messages = this.store.listMessages(sessionId);
    this.sendLifecycle({ type: "session.resumed", session });
    return { session, messages };
  }
  /**
   * Shared reconnect dispatch (fix-no-conversation-found-remote-resume):
   * every call site that used to unconditionally call `harness.resume()`
   * (`reconnect()`'s explicit resume-button path, and `sendUserMessage()`'s
   * "no live harness session" fallback) funnels through here now. A
   * `--resume <id>` reconnect is only valid for a session id the underlying
   * CLI has ACTUALLY recorded a real conversation for — `SessionRecord.
   * everConnected` (persisted, set the moment this session's very first
   * `session_started` harness event ever fired) is the ground truth for
   * that, not merely "does `SessionManager` have local state that looks
   * active." A session that's never gotten that far (e.g. created with no
   * initial prompt, then closed/interrupted, or whose earlier attempts all
   * failed before ever completing the CLI's init handshake) gets routed
   * through `harness.startWithId()` instead — a genuinely fresh conversation
   * as far as the CLI is concerned, just one that reuses the id Atelier
   * already fixed in its own SQLite row, so the rest of the app (transcript,
   * IPC, etc.) never needs to know the id changed, because it doesn't.
   */
  async reconnectHarness(session, opts) {
    const host = this.resolveHostFromSession(session.hostname);
    const startOpts = {
      cwd: session.worktreePath ?? session.projectPath,
      host,
      keepAlive: true,
      ...opts.permissionMode ? { permissionMode: opts.permissionMode } : {},
      ...opts.model ? { model: opts.model } : {},
      ...opts.effort ? { effort: opts.effort } : {}
    };
    if (!session.everConnected) {
      logger.info("reconnectHarness: session never had a real connection, starting fresh (not resume())", {
        sessionId: session.id
      });
      return {
        sessionId: session.id,
        events: this.startFreshWithRetry(session, startOpts, opts.initialPrompt)
      };
    }
    const harnessSession = await this.harness.resume(session.id, startOpts);
    return {
      sessionId: harnessSession.sessionId,
      events: this.withConversationLostFallback(session, startOpts, harnessSession.events)
    };
  }
  /**
   * fix-remote-resume-conversation-lost-fallback: a session with
   * `everConnected === true` genuinely did connect once, but the CLI backend
   * (local or remote/devpod) can still have since lost ALL record of that
   * conversation — a devpod restart/disk-clear pruning its own history, or
   * (verified locally as a faithful reproduction, same error text and exit
   * code) the session's own transcript file having been deleted. `resume()`
   * against that fails with "No conversation found with session ID: ..." on
   * EVERY future attempt forever — there is no local flag that can predict
   * this in advance, so it can only be detected by actually trying `resume()`
   * and watching for this specific failure in the harness's own event
   * stream (see claude-agent-sdk-harness.ts's `launch()`/`pump()`: a lost
   * conversation first yields a `result` event with `isError: true` — handled
   * silently by `applyEvent`'s `case 'result':`, nothing to intercept there —
   * then the very next `query.next()` throws, which `pump()`'s `catch` turns
   * into a `type: 'error'` event with this exact message).
   *
   * On seeing that specific error (and ONLY on the first occurrence for this
   * reconnect attempt — this generator returns right after, so there is no
   * loop), this swallows the raw/confusing CLI error, persists a plain-
   * language system message explaining what happened, and falls back ONCE to
   * `startWithId()` — a genuinely fresh conversation reusing the same session
   * id (same mechanism `!session.everConnected` already uses above) — then
   * re-yields THAT session's events for the remainder of this generator's
   * life. If the fallback itself throws, no further retry is attempted: a
   * distinct `error` event is yielded instead, which `applyEvent`'s existing
   * `case 'error':` persists as a normal visible system error — so the user
   * always reaches a clear terminal state.
   *
   * Any OTHER `error` event (bad cwd, auth failure, network — anything not
   * matching this specific message) passes through completely unchanged,
   * preserving the "a genuine reconnect failure still surfaces an error"
   * behavior already covered by `session-lifecycle.spec.ts`'s "bug repro
   * safety net" test.
   */
  async *withConversationLostFallback(session, startOpts, events) {
    for await (const event of events) {
      if (event.type === "error" && isConversationLostError(event.message)) {
        logger.warn("reconnectHarness: resume() failed because the CLI has lost this conversation server-side; falling back once to a fresh session reusing the same id", {
          sessionId: session.id,
          error: event.message
        });
        const notice = this.store.addMessage({
          sessionId: session.id,
          role: "system",
          content: "Reconnecting lost the server-side conversation history for this session (likely due to a remote restart or history being cleared). Starting fresh with the same session — prior messages are still visible above, but the assistant will not have that context anymore."
        });
        this.sendMessage(session.id, notice);
        try {
          yield* this.startFreshWithRetry(session, startOpts);
        } catch (err) {
          yield {
            type: "error",
            sessionId: session.id,
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            message: `Fallback to a fresh session also failed: ${err instanceof Error ? err.message : String(err)}`
          };
        }
        return;
      }
      yield event;
    }
  }
  /**
   * Starts a fresh `startWithId()` conversation, with a SHORT, BOUNDED
   * exponential-backoff retry (max 4 total attempts, ~1.5s/3s/5s delays —
   * never unbounded/forever) if — and only if — the CLI reports the exact
   * `"Session ID ... is already in use"` conflict. Verified for real
   * (SDK-level probe, driven through the same persistent streaming-input
   * `query()` shape `claude-agent-sdk-harness.ts` actually uses — a plain
   * sequential one-shot `-p` CLI probe never reproduced this at all) that
   * this is a genuine, narrow race, not a design flaw in falling back at
   * all: `SessionManager`'s live sessions use a persistent streaming-input
   * queue (`keepAlive: true`), so the FAILED resume's underlying `query()`
   * still held session-level state that the SDK itself hadn't released yet
   * at the exact moment the fallback's new `startWithId()` call tries to
   * reuse that same id — `pump()`'s catch (claude-agent-sdk-harness.ts) now
   * also calls `query.interrupt()` on a genuine (non-self-inflicted) failure
   * specifically to release that state sooner, but the backoff here remains
   * as a bounded safety net since that call is fire-and-forget (not awaited
   * before the fallback's own retry loop proceeds). Any OTHER error, or the
   * SAME conflict still happening after all attempts are exhausted, is
   * surfaced normally (via the plain `'error'`/`'result'` events
   * `fresh.events` naturally yields) — this loop is capped, so it still
   * can't retry forever.
   */
  async *startFreshWithRetry(session, startOpts, initialPrompt) {
    const MAX_ATTEMPTS = 4;
    const RETRY_DELAYS_MS = [1500, 3e3, 5e3];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const fresh = await this.harness.startWithId(session.id, initialPrompt ?? "", startOpts);
      const iterator = fresh.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) return;
      const canRetry = attempt < MAX_ATTEMPTS;
      if (canRetry && first.value.type === "error" && isSessionLockRaceError(first.value.message)) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1];
        logger.warn("startFreshWithRetry: hit a transient session-id lock race right after the failed resume; retrying after a short delay", {
          sessionId: session.id,
          attempt,
          delayMs,
          error: first.value.message
        });
        await delay(delayMs);
        continue;
      }
      yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    }
  }
  /** Reconnects the live harness session on top of the already-rendered transcript. No-op for terminal sessions. */
  async reconnect(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session || session.mode !== "claude-code") return;
    if (this.creatingWorktree.has(sessionId)) return;
    if (this.live.has(sessionId)) {
      this.sendBackgroundTasks(sessionId);
      this.sendSdkChrome(sessionId);
      this.sendRateLimitChrome(sessionId);
      return;
    }
    this.startupIdle.delete(sessionId);
    this.touchLastActive(sessionId);
    this.pendingPanelPreload.add(sessionId);
    this.connecting.add(sessionId);
    this.sendStatus(sessionId);
    try {
      this.finalizeStaleRunningToolCalls(sessionId);
      const permissionMode = this.permissionModes.get(sessionId) ?? session.permissionMode;
      const modelSelection = this.modelSelections.get(sessionId) ?? session.modelSelection ?? void 0;
      const harnessSession = await this.reconnectHarness(session, {
        permissionMode,
        model: modelSelection?.model,
        effort: modelSelection?.effort
      });
      this.live.set(sessionId, newLiveStream(this.initialTurnCountForReconnect(sessionId)));
      this.resetHarnessUiForSession(sessionId);
      this.sendStatus(sessionId);
      void this.consume(sessionId, harnessSession.events);
    } catch (err) {
      this.connecting.delete(sessionId);
      this.pendingPanelPreload.delete(sessionId);
      this.reportHarnessFailure(sessionId, "reconnect", err);
      throw err;
    }
  }
  // ── Send message into a live (or reconnected) session ──────────────
  /**
   * Sends a follow-up user message.
   *
   * `ClaudeAgentSdkHarness.normalize()` used to complete its event generator
   * after every turn's terminal `result`, which tore down that turn's
   * internal session entry — so a bare `streamInput()` call would silently
   * no-op for any message after the first turn, and every follow-up here
   * had to go through `resume()` (a fresh `--resume <id>` reconnect) even
   * when the previous turn's process was still sitting right there. Fixed
   * in this task (04-composer-core) after verifying against the real SDK
   * (see `normalize()`'s comment) that the same `query()`/subprocess
   * happily accepts further turns pushed into its still-open input queue
   * with no reconnect — including a message pushed WHILE the current turn
   * is still streaming, which the SDK simply folds into that turn's own
   * response instead of queuing it for later.
   *
   * So: if the harness reports this session `isActive` (its generator
   * hasn't returned — covers both "mid-turn, still streaming" and "idle,
   * connected, between turns"), this pushes straight into the live queue
   * via `streamInput()` and returns — the ALREADY-RUNNING `consume()` loop
   * from whenever this session last started/reconnected keeps delivering
   * this turn's events, live, with no new subprocess. Only a session with
   * no live harness entry at all (freshly reopened after being properly
   * closed/interrupted, or after an app relaunch) falls back to the
   * `resume()` reconnect path. Turn-count bookkeeping (for auto-naming) is
   * preserved across a `resume()` reconnect — it only resets on session
   * close or a real app relaunch.
   */
  async sendUserMessage(sessionId, text, override, image) {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const content = image ? JSON.stringify({ kind: "image_attachment", mimeType: image.mimeType, data: image.data, text }) : text;
    const userMessage2 = this.store.addMessage({ sessionId, role: "user", content });
    this.touchLastActive(sessionId);
    this.sendPromptSuggestion(sessionId, null);
    this.sendMessage(sessionId, userMessage2);
    if (session.mode !== "claude-code") return;
    this.sendTurnState(sessionId, true);
    try {
      const previousSelection = this.modelSelections.get(sessionId);
      const selectionChanged = override !== void 0 && !modelSelectionsEqual(override, previousSelection);
      if (selectionChanged) {
        logger.info("sendUserMessage: model/effort selection changed, applying from next turn", {
          sessionId,
          previous: previousSelection,
          next: override
        });
        this.modelSelections.set(sessionId, override);
        this.store.setModelSelection(sessionId, override);
        if (this.harness.isActive(sessionId)) {
          await this.harness.interrupt(sessionId);
        }
      }
      if (!selectionChanged && this.harness.isActive(sessionId)) {
        logger.info("sendUserMessage: live injection (streamInput, no resume)", { sessionId });
        await this.harness.streamInput(sessionId, text, image);
        const liveEntry = this.live.get(sessionId);
        if (liveEntry) {
          liveEntry.busy = true;
          this.sendStatus(sessionId);
        }
        return;
      }
      logger.info("sendUserMessage: no live harness session, reconnecting via resume()", { sessionId });
      const permissionMode = this.permissionModes.get(sessionId) ?? session.permissionMode;
      const modelSelection = this.modelSelections.get(sessionId) ?? session.modelSelection ?? void 0;
      const needsInitialPrompt = !session.everConnected;
      const harnessSession = await this.reconnectHarness(session, {
        permissionMode,
        model: modelSelection?.model,
        effort: modelSelection?.effort,
        ...needsInitialPrompt ? { initialPrompt: text } : {}
      });
      if (!needsInitialPrompt) {
        await this.harness.streamInput(sessionId, text, image);
      }
      const previousTurnCount = this.live.get(sessionId)?.turnCount ?? 0;
      const previousLive = this.live.get(sessionId);
      this.finalizeStaleRunningToolCalls(sessionId, previousLive);
      this.live.set(sessionId, newLiveStream(previousTurnCount));
      this.resetHarnessUiForSession(sessionId);
      this.live.get(sessionId).busy = true;
      this.sendStatus(sessionId);
      void this.consume(sessionId, harnessSession.events);
    } catch (err) {
      this.sendTurnState(sessionId, false);
      this.reportHarnessFailure(sessionId, "sendUserMessage", err);
      throw err;
    }
  }
  async interrupt(sessionId) {
    await this.harness.interrupt(sessionId);
  }
  /** `/model <id>` validation against the live SDK — see `HarnessDriver.validateModel`. */
  async validateModel(sessionId, model) {
    return this.harness.validateModel(sessionId, model);
  }
  /** Settings default-model validation — see `HarnessDriver.validateClaudeModel`. */
  async validateClaudeModel(model) {
    return this.harness.validateClaudeModel(model);
  }
  // ── Interactive prompts (05-interactive-prompts) ─────────────────────
  /**
   * Resolves a pending permission/AskUserQuestion/plan card: updates the
   * persisted message row to its resolved state (same "mutate in place"
   * pattern as `tool_call_end`) and unblocks the harness's `canUseTool`
   * call. Throws if `requestId` doesn't match a currently-pending prompt for
   * this session (e.g. a stale double-click after the harness already
   * resolved/moved on) so the renderer's IPC call surfaces the mismatch
   * instead of silently doing nothing.
   */
  async respondToPrompt(sessionId, requestId, decision) {
    const live = this.live.get(sessionId);
    const pending = live?.pendingPrompts.get(requestId);
    if (!live || !pending) throw new Error(`Unknown or already-resolved prompt: ${requestId}`);
    const resolvedContent = applyDecision(pending.content, decision);
    const updated = this.store.updateMessage(pending.messageId, { content: JSON.stringify(resolvedContent) });
    if (updated) this.sendMessage(sessionId, updated);
    live.pendingPrompts.delete(requestId);
    if (decision.kind === "plan" && decision.decision === "accept") {
      this.permissionModes.set(sessionId, "default");
      this.store.setPermissionMode(sessionId, "default");
      const session = this.store.getSession(sessionId);
      if (session) this.sendLifecycle({ type: "session.updated", session: this.decorate(session) });
    }
    live.busy = true;
    this.sendStatus(sessionId);
    this.sendTurnState(sessionId, true);
    logger.info("respondToPrompt: dispatching to harness", { sessionId, requestId, kind: decision.kind });
    await this.harness.respondToPrompt(sessionId, requestId, toHarnessPromptResponse(decision));
  }
  // ── Mode cycling (11-composer-mode-indicator) ─────────────────────────
  /**
   * Persists a model/effort selection for a session without sending a message
   * (fix-model-persist-on-slash-model): called immediately when the renderer's
   * `/model <id>` slash command fires so the selection survives a relaunch
   * even if no subsequent message is sent. Mirrors the same Map+store write
   * that `sendUserMessage` does when it detects a changed selection.
   */
  persistModelSelection(sessionId, selection) {
    this.store.setModelSelection(sessionId, selection);
  }
  /**
   * Cycles a session's SDK permission mode through `MODE_CYCLE`
   * (default -> plan -> acceptEdits -> auto -> default), triggered by the
   * composer's Shift+Tab handler or a click on the mode pill. Updates the
   * tracked mode immediately (so it's re-passed on the session's next
   * `resume()`/follow-up, exactly like the pre-existing plan-mode tracking)
   * and, if the session has a live harness connection right now, also flips
   * it on that connection immediately via `harness.setPermissionMode()` —
   * the same real `query.setPermissionMode()` call already used after an
   * accepted `ExitPlanMode` — so the change takes effect for the CURRENT
   * turn/session, not just the next reconnect.
   */
  async cycleMode(sessionId) {
    const existing = this.store.getSession(sessionId);
    if (!existing) throw new Error(`Unknown session: ${sessionId}`);
    const current = this.permissionModes.get(sessionId) ?? existing.permissionMode;
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length];
    this.permissionModes.set(sessionId, next);
    this.store.setPermissionMode(sessionId, next);
    logger.info("cycleMode: mode changed", { sessionId, from: current, to: next });
    if (existing.mode === "claude-code") {
      await this.harness.setPermissionMode(sessionId, next);
    }
    const session = this.decorate(existing);
    this.sendLifecycle({ type: "session.updated", session });
    return session;
  }
  /**
   * A thrown error from a harness call (resume/streamInput/start) used to
   * disappear silently: the IPC promise would reject, but nothing logged it
   * in the main process and the renderer's `handleSend`/`resumeSession`
   * callers don't currently catch or surface a rejected
   * `session:sendMessage`/`session:resume` call (confirmed by inspection —
   * see App.tsx's `handleSend` and useSessions.ts's `resumeSession`, neither
   * of which wraps its `await` in try/catch). So in addition to logging,
   * this turns the failure into the same kind of visible system-role
   * transcript message that `applyEvent`'s `case 'error':` produces for an
   * in-stream harness error event — the user always sees SOMETHING in the
   * chat, regardless of whether the renderer ever handles the rejection.
   */
  reportHarnessFailure(sessionId, context, err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("harness call failed", { sessionId, context, error: errorMessage });
    const message = this.store.addMessage({
      sessionId,
      role: "system",
      content: `Error: ${errorMessage}`
    });
    this.sendMessage(sessionId, message);
    const live = this.live.get(sessionId);
    if (live) live.busy = false;
    this.sendStatus(sessionId);
  }
  // ── Fork / Restart ──────────────────────────────────────────────────
  forkSession(sourceId) {
    const forked = this.store.forkSession(sourceId);
    if (!forked) throw new Error(`Unknown session: ${sourceId}`);
    this.sendLifecycle({ type: "session.forked", session: forked, sourceId });
    return forked;
  }
  restartSession(sourceId) {
    const forked = this.forkSession(sourceId);
    this.closeSession(sourceId);
    return forked;
  }
  // ── Close / Delete / Rename / Pin ────────────────────────────────────
  closeSession(sessionId) {
    this.markInterruptedTurnNoticeIfBusy(sessionId);
    void this.harness.interrupt(sessionId).catch(() => void 0);
    const live = this.live.get(sessionId);
    this.finalizeStaleRunningToolCalls(sessionId, live);
    this.live.delete(sessionId);
    this.connecting.delete(sessionId);
    this.creatingWorktree.delete(sessionId);
    this.pendingPanelPreload.delete(sessionId);
    this.workspace?.evictSession(sessionId);
    this.sendTurnState(sessionId, false);
    this.resetHarnessUiForSession(sessionId);
    const session = this.store.closeSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sendStatus(sessionId);
    this.sendLifecycle({ type: "session.closed", session });
    return session;
  }
  async linkDailyTask(sessionId, noteDate, taskGid) {
    await linkDailyTaskToSession(this.store, this.getWindow, sessionId, noteDate, taskGid);
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const decorated = this.decorate(session);
    this.sendLifecycle({ type: "session.updated", session: decorated });
    return decorated;
  }
  async completeLinkedDailyTask(sessionId) {
    await completeLinkedDailyTask(this.store, this.getWindow, sessionId);
  }
  deleteSession(sessionId) {
    const session = this.store.getSession(sessionId);
    if (session?.worktreePath) {
      const hostname = session.hostname ? this.hosts.resolveByHostname(session.hostname)?.sshHost : void 0;
      void removeWorktree(session.worktreePath, sessionId, session.projectPath, hostname).catch((err) => {
        logger.warn("deleteSession: worktree removal failed (ignored)", {
          sessionId,
          worktreePath: session.worktreePath,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }
    this.live.delete(sessionId);
    this.connecting.delete(sessionId);
    this.creatingWorktree.delete(sessionId);
    this.workspace?.evictSession(sessionId);
    this.store.deleteSession(sessionId);
    this.sendLifecycle({ type: "session.deleted", sessionId });
  }
  renameSession(sessionId, name) {
    const session = this.store.renameSession(sessionId, name);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sendLifecycle({ type: "session.renamed", session });
    return session;
  }
  setPinned(sessionId, pinned) {
    const session = this.store.setPinned(sessionId, pinned);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sendLifecycle({ type: "session.updated", session });
    return session;
  }
  setColor(sessionId, color) {
    const session = this.store.setColor(sessionId, color);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sendLifecycle({ type: "session.updated", session });
    return session;
  }
  setNotes(sessionId, notes) {
    const session = this.store.setNotes(sessionId, notes);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sendLifecycle({ type: "session.updated", session });
    return session;
  }
  addTag(sessionId, tag) {
    const session = this.store.addTag(sessionId, tag);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sendLifecycle({ type: "session.updated", session });
    return session;
  }
  removeTag(sessionId, tag) {
    const session = this.store.removeTag(sessionId, tag);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sendLifecycle({ type: "session.updated", session });
    return session;
  }
  listAllTags() {
    return this.store.listAllTags();
  }
  // ── Groups (06-session-organization) ─────────────────────────────────
  listGroups() {
    return this.store.listGroups();
  }
  sendGroupEvent(event) {
    this.getWindow()?.webContents.send("group:changed", event);
  }
  createGroup(name) {
    const group = this.store.createGroup(name);
    this.sendGroupEvent({ type: "group.created", group });
    return group;
  }
  renameGroup(groupId, name) {
    const group = this.store.renameGroup(groupId, name);
    if (!group) throw new Error(`Unknown group: ${groupId}`);
    this.sendGroupEvent({ type: "group.renamed", group });
    return group;
  }
  setGroupCollapsed(groupId, collapsed) {
    const group = this.store.setGroupCollapsed(groupId, collapsed);
    if (!group) throw new Error(`Unknown group: ${groupId}`);
    this.sendGroupEvent({ type: "group.updated", group });
    return group;
  }
  deleteGroup(groupId) {
    this.store.deleteGroup(groupId);
    this.sendGroupEvent({ type: "group.deleted", groupId });
    for (const session of this.store.listActiveSessions()) {
      if (session.groupId === null) this.sendLifecycle({ type: "session.updated", session });
    }
  }
  reorderGroups(orderedIds) {
    const groups = this.store.reorderGroups(orderedIds);
    this.sendGroupEvent({ type: "group.reordered", groups });
    return groups;
  }
  setSessionGroup(sessionId, groupId) {
    const session = this.store.setSessionGroup(sessionId, groupId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sendLifecycle({ type: "session.updated", session });
    return session;
  }
  /** Persists a manual drag-drop re-order (and possible re-parent) for a section: pinned (groupId undefined), a specific group id, or ungrouped (groupId null). */
  reorderSessions(groupId, orderedIds) {
    const sessions = this.store.reorderSessions(groupId, orderedIds);
    for (const session of sessions) this.sendLifecycle({ type: "session.updated", session });
    return sessions;
  }
  // ── Event stream consumption ─────────────────────────────────────────
  async consume(sessionId, events) {
    for await (const event of events) {
      this.applyEvent(sessionId, event);
    }
  }
  markInterruptedTurnNoticeIfBusy(sessionId) {
    const live = this.live.get(sessionId);
    if (!live) return;
    const turnInFlight = live.busy || live.bufferMessageId != null || live.pendingTools.size > 0;
    if (turnInFlight) {
      this.store.setPendingTurnInterruptedNotice(sessionId);
    }
  }
  /** Inserts {@link TURN_INTERRUPTED_NOTICE} at most once per pending flag. */
  deliverPendingTurnInterruptedNotice(sessionId) {
    if (!this.store.consumePendingTurnInterruptedNotice(sessionId)) return;
    const message = this.store.addMessage({
      sessionId,
      role: "system",
      content: TURN_INTERRUPTED_NOTICE
    });
    this.sendMessage(sessionId, message);
  }
  applyEvent(sessionId, event) {
    const live = this.live.get(sessionId) ?? newLiveStream();
    this.live.set(sessionId, live);
    if (this.connecting.has(sessionId)) {
      this.connecting.delete(sessionId);
      this.sendStatus(sessionId);
    }
    const needsWorkspacePreload = this.pendingPanelPreload.delete(sessionId);
    if (needsWorkspacePreload) {
      this.startupAutoReconnect.delete(sessionId);
      const row = this.store.getSession(sessionId);
      if (this.workspace && row?.mode === "claude-code") {
        this.connecting.add(sessionId);
        this.sendStatus(sessionId);
        void this.workspace.completeSessionOpen(this.decorate(row)).finally(() => {
          this.connecting.delete(sessionId);
          this.sendStatus(sessionId);
          this.sendReconnectComplete(sessionId);
        });
      } else {
        this.sendReconnectComplete(sessionId);
      }
    }
    switch (event.type) {
      case "thinking_block_start": {
        this.finishThinkingBlock(sessionId, live, "completed");
        const content = {
          kind: "thinking_block",
          status: "running",
          text: "",
          parentToolUseId: event.parentToolUseId
        };
        const message = this.store.addMessage({
          sessionId,
          role: "assistant",
          content: JSON.stringify(content),
          rawEvent: event
        });
        live.thinkingMessageId = message.id;
        live.thinkingText = "";
        live.thinkingParentToolUseId = event.parentToolUseId;
        this.sendMessage(sessionId, message);
        return;
      }
      case "thinking_delta": {
        if (live.thinkingMessageId == null) return;
        live.thinkingText += event.text;
        const content = {
          kind: "thinking_block",
          status: "running",
          text: live.thinkingText,
          parentToolUseId: event.parentToolUseId,
          ...live.thinkingEstimatedTokens != null ? { estimatedTokens: live.thinkingEstimatedTokens } : {}
        };
        const updated = this.store.updateMessage(live.thinkingMessageId, {
          content: JSON.stringify(content),
          rawEvent: event
        });
        if (updated) this.sendMessage(sessionId, updated);
        return;
      }
      case "thinking_block_end": {
        this.finishThinkingBlock(sessionId, live, "completed");
        return;
      }
      case "thinking_tokens": {
        if (live.thinkingMessageId == null) return;
        const content = {
          kind: "thinking_block",
          status: "running",
          text: live.thinkingText,
          estimatedTokens: event.estimatedTokens,
          parentToolUseId: live.thinkingParentToolUseId
        };
        live.thinkingEstimatedTokens = event.estimatedTokens;
        const updated = this.store.updateMessage(live.thinkingMessageId, {
          content: JSON.stringify(content),
          rawEvent: event
        });
        if (updated) this.sendMessage(sessionId, updated);
        return;
      }
      case "tool_input_delta": {
        const pending = live.pendingTools.get(event.toolUseId);
        if (!pending) return;
        const content = {
          ...pending.content,
          inputStreamJson: event.partialJson
        };
        pending.content = content;
        const updated = this.store.updateMessage(pending.messageId, {
          content: JSON.stringify(content),
          rawEvent: event
        });
        if (updated) this.sendMessage(sessionId, updated);
        return;
      }
      case "text_delta": {
        this.finishThinkingBlock(sessionId, live, "completed");
        if (live.bufferMessageId == null) {
          const placeholder = this.store.addMessage({ sessionId, role: "assistant", content: "" });
          live.bufferMessageId = placeholder.id;
          this.sendMessage(sessionId, placeholder);
        }
        live.buffer += event.text;
        this.sendStreamDelta(sessionId, live.bufferMessageId, live.buffer);
        return;
      }
      case "tool_call_start": {
        this.flushBuffer(sessionId, live);
        this.finishThinkingBlock(sessionId, live, "completed");
        const existing = live.pendingTools.get(event.toolUseId);
        if (existing) {
          const content2 = {
            ...existing.content,
            name: event.name,
            input: event.input,
            inputStreamJson: void 0,
            parentToolUseId: event.parentToolUseId
          };
          existing.content = content2;
          const updated = this.store.updateMessage(existing.messageId, {
            content: JSON.stringify(content2),
            rawEvent: event
          });
          if (updated) this.sendMessage(sessionId, updated);
          if (event.name === "Bash") {
            const command = event.input?.command;
            const row = this.store.getSession(sessionId);
            const base = live.harnessCwd ?? (row ? row.worktreePath ?? row.projectPath : null);
            if (command && base) {
              const next = applyBashCdCommands(base, command);
              if (next !== base) {
                live.harnessCwd = next;
                this.sendHarnessCwd(sessionId, next);
              }
            }
          }
          return;
        }
        if (event.name === "Bash") {
          const command = event.input?.command;
          const row = this.store.getSession(sessionId);
          const base = live.harnessCwd ?? (row ? row.worktreePath ?? row.projectPath : null);
          if (command && base) {
            const next = applyBashCdCommands(base, command);
            if (next !== base) {
              live.harnessCwd = next;
              this.sendHarnessCwd(sessionId, next);
            }
          }
        }
        const content = {
          kind: "tool_call",
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          status: "running",
          parentToolUseId: event.parentToolUseId
        };
        const message = this.store.addMessage({
          sessionId,
          role: "assistant",
          content: JSON.stringify(content),
          rawEvent: event
        });
        live.pendingTools.set(event.toolUseId, { messageId: message.id, content });
        this.sendMessage(sessionId, message);
        return;
      }
      case "tool_call_end": {
        const pending = live.pendingTools.get(event.toolUseId);
        if (!pending) return;
        const content = {
          ...pending.content,
          status: event.isError ? "error" : "completed",
          output: event.output
        };
        const updated = this.store.updateMessage(pending.messageId, { content: JSON.stringify(content), rawEvent: event });
        if (updated) this.sendMessage(sessionId, updated);
        live.pendingTools.delete(event.toolUseId);
        if (!event.isError) {
          const session = this.getSession(sessionId);
          if (session) {
            const workspaceRoot = session.worktreePath ?? session.projectPath;
            const workspacePath = workspaceRoot;
            void handleFileEditToolCompleted(
              this.store,
              sessionId,
              workspaceRoot,
              workspacePath,
              session.hostname,
              pending.content.name,
              pending.content.input
            ).then((cap) => {
              this.workspace?.patchSessionChangesCap(sessionId, cap);
            });
          }
        }
        return;
      }
      case "tool_progress": {
        const pending = live.pendingTools.get(event.toolUseId);
        if (!pending) return;
        const content = {
          ...pending.content,
          elapsedTimeSeconds: event.elapsedTimeSeconds
        };
        pending.content = content;
        const updated = this.store.updateMessage(pending.messageId, { content: JSON.stringify(content), rawEvent: event });
        if (updated) this.sendMessage(sessionId, updated);
        return;
      }
      case "todo_update": {
        const content = { kind: "todo_update", todos: event.todos };
        const message = this.store.addMessage({ sessionId, role: "system", content: JSON.stringify(content), rawEvent: event });
        this.sendMessage(sessionId, message);
        return;
      }
      case "compaction": {
        this.flushBuffer(sessionId, live);
        const content = { kind: "compaction", trigger: event.trigger, preTokens: event.preTokens, postTokens: event.postTokens };
        const message = this.store.addMessage({ sessionId, role: "system", content: JSON.stringify(content), rawEvent: event });
        this.sendMessage(sessionId, message);
        return;
      }
      case "session_started":
        live.harnessCwd = event.cwd;
        this.sendHarnessCwd(sessionId, event.cwd);
        logger.info("harness event: session_started", {
          sessionId,
          model: event.model,
          apiKeySource: event.apiKeySource,
          cwd: event.cwd
        });
        this.store.markEverConnected(sessionId);
        return;
      case "commands_updated":
        logger.info("harness event: commands_updated", { sessionId, commandNames: event.commands.map((c) => c.name) });
        this.sendCommands(sessionId, event.commands);
        return;
      case "prompt_suggestion":
        logger.info("harness event: prompt_suggestion", { sessionId, length: event.suggestion.length });
        this.sendPromptSuggestion(sessionId, event.suggestion);
        return;
      case "permission_request": {
        this.flushBuffer(sessionId, live);
        const content = {
          kind: "permission_request",
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          title: event.title,
          description: event.description,
          suggestedPattern: event.suggestedPattern,
          status: "pending"
        };
        const message = this.store.addMessage({ sessionId, role: "assistant", content: JSON.stringify(content), rawEvent: event });
        live.pendingPrompts.set(event.requestId, { messageId: message.id, content });
        this.sendMessage(sessionId, message);
        return;
      }
      case "ask_user_question": {
        this.flushBuffer(sessionId, live);
        const content = {
          kind: "ask_user_question",
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          questions: event.questions,
          status: "pending"
        };
        const message = this.store.addMessage({ sessionId, role: "assistant", content: JSON.stringify(content), rawEvent: event });
        live.pendingPrompts.set(event.requestId, { messageId: message.id, content });
        this.sendMessage(sessionId, message);
        return;
      }
      case "plan_proposed": {
        this.flushBuffer(sessionId, live);
        const content = {
          kind: "plan_proposed",
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          plan: event.plan,
          planFilePath: event.planFilePath,
          status: "pending"
        };
        const message = this.store.addMessage({ sessionId, role: "assistant", content: JSON.stringify(content), rawEvent: event });
        live.pendingPrompts.set(event.requestId, { messageId: message.id, content });
        this.sendMessage(sessionId, message);
        return;
      }
      case "error": {
        this.flushBuffer(sessionId, live);
        const message = this.store.addMessage({
          sessionId,
          role: "system",
          content: `Error: ${event.message}`,
          rawEvent: event
        });
        this.sendMessage(sessionId, message);
        live.busy = false;
        this.sendStatus(sessionId);
        this.sendTurnState(sessionId, false);
        return;
      }
      case "interrupted":
        this.flushBuffer(sessionId, live);
        this.finalizeStaleRunningToolCalls(sessionId, live);
        live.busy = false;
        this.sendStatus(sessionId);
        logger.info("harness event: interrupted (terminal)", { sessionId });
        this.sendTurnState(sessionId, false);
        return;
      case "result": {
        this.flushBuffer(sessionId, live);
        live.turnCount += 1;
        live.busy = false;
        this.sendPromptSuggestion(sessionId, null);
        this.sendStatus(sessionId);
        logger.info("harness event: result (turn complete)", { sessionId, turnCount: live.turnCount, isError: event.isError });
        const rawTotalCostUsd = event.totalCostUsd ?? 0;
        const deltaUsd = Math.max(0, rawTotalCostUsd - live.connectionCostUsd);
        live.connectionCostUsd = rawTotalCostUsd;
        const costUpdated = this.store.addCost(sessionId, deltaUsd);
        if (costUpdated) {
          logger.info("session cost updated", {
            sessionId,
            deltaUsd,
            rawTotalCostUsd,
            totalCostUsd: costUpdated.totalCostUsd,
            usage: event.usage
          });
          this.sendLifecycle({ type: "session.updated", session: costUpdated });
        }
        this.sendTurnState(sessionId, false);
        void this.harness.getContextUsage(sessionId).then((ctx) => {
          if (ctx && ctx.autoCompactThreshold) {
            this.sendTokenUsage(sessionId, ctx.totalTokens, ctx.autoCompactThreshold);
          } else if (event.modelUsage) {
            const entries = Object.values(event.modelUsage);
            if (entries.length > 0) {
              const inputTokens = entries.reduce(
                (sum, m) => sum + m.inputTokens + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0),
                0
              );
              const contextWindow = Math.max(...entries.map((m) => m.contextWindow));
              if (contextWindow > 0) this.sendTokenUsage(sessionId, inputTokens, contextWindow);
            }
          }
        });
        if (event.isError) this.expirePendingPrompts(sessionId, live);
        if (live.turnCount >= AUTO_NAME_STARTING_FROM_TURN) {
          void this.maybeAutoName(sessionId).catch(
            (err) => logger.warn("auto-naming failed", { sessionId, error: err instanceof Error ? err.message : String(err) })
          );
        }
        return;
      }
      case "permission_denied": {
        const pending = live.pendingTools.get(event.toolUseId);
        if (pending) {
          const content = {
            ...pending.content,
            status: "denied",
            output: event.message
          };
          const updated = this.store.updateMessage(pending.messageId, {
            content: JSON.stringify(content),
            rawEvent: event
          });
          if (updated) this.sendMessage(sessionId, updated);
          live.pendingTools.delete(event.toolUseId);
        }
        return;
      }
      case "model_refusal_fallback": {
        this.flushBuffer(sessionId, live);
        const content = {
          kind: "transcript_notice",
          level: "warning",
          label: "Model",
          text: event.content || `Request refused; retrying on ${event.fallbackModel}.`
        };
        const message = this.store.addMessage({
          sessionId,
          role: "system",
          content: JSON.stringify(content),
          rawEvent: event
        });
        this.sendMessage(sessionId, message);
        return;
      }
      case "model_refusal_no_fallback": {
        this.flushBuffer(sessionId, live);
        const content = {
          kind: "transcript_notice",
          level: "danger",
          label: "Refused",
          text: event.content || "Model declined this request. Edit your message and try again."
        };
        const message = this.store.addMessage({
          sessionId,
          role: "system",
          content: JSON.stringify(content),
          rawEvent: event
        });
        this.sendMessage(sessionId, message);
        return;
      }
      case "local_command_output": {
        const content = {
          kind: "local_command_output",
          text: event.content
        };
        const message = this.store.addMessage({
          sessionId,
          role: "assistant",
          content: JSON.stringify(content),
          rawEvent: event
        });
        this.sendMessage(sessionId, message);
        return;
      }
    }
    this.applyHarnessUiSideEffects(sessionId, event);
  }
  /**
   * A turn can end in error (`result` event, `isError: true`) while a
   * permission/AskUserQuestion/plan prompt is still awaiting a response —
   * confirmed live (see `respondToPrompt`'s doc comment): the harness never
   * resolves `canUseTool` itself in this case, so without this cleanup the
   * card stays rendered as `pending` forever, and a later click on it throws
   * "Unknown or already-resolved prompt" (bug: silently swallowed by the
   * renderer). Mark each abandoned prompt `expired` so the card reflects
   * reality and stops offering dead buttons.
   */
  expirePendingPrompts(sessionId, live) {
    if (live.pendingPrompts.size === 0) return;
    for (const [requestId, pending] of live.pendingPrompts) {
      const expiredContent = { ...pending.content, status: "expired" };
      const updated = this.store.updateMessage(pending.messageId, { content: JSON.stringify(expiredContent) });
      if (updated) this.sendMessage(sessionId, updated);
      logger.info("expired pending prompt after errored turn", { sessionId, requestId });
    }
    live.pendingPrompts.clear();
  }
  /**
   * Tool calls persisted as `running` cannot finish once the harness
   * connection is torn down (close, reconnect, interrupt) — `tool_call_end`
   * never arrives. Flip them to a terminal state so resume/reconnect does
   * not show a forever-spinning action chip.
   */
  finalizeStaleRunningToolCalls(sessionId, live) {
    const disconnectedNote = "(Session disconnected before this tool finished.)";
    for (const message of this.store.listMessages(sessionId)) {
      const structured = parseStructuredContent(message.content);
      if (structured?.kind !== "tool_call" || structured.status !== "running") continue;
      const content = {
        ...structured,
        status: "interrupted",
        output: structured.output ?? disconnectedNote
      };
      const updated = this.store.updateMessage(message.id, { content: JSON.stringify(content) });
      if (updated) this.sendMessage(sessionId, updated);
    }
    live?.pendingTools.clear();
  }
  finishThinkingBlock(sessionId, live, status) {
    if (live.thinkingMessageId == null) return;
    const content = {
      kind: "thinking_block",
      status,
      text: live.thinkingText,
      parentToolUseId: live.thinkingParentToolUseId,
      ...live.thinkingEstimatedTokens != null ? { estimatedTokens: live.thinkingEstimatedTokens } : {}
    };
    const updated = this.store.updateMessage(live.thinkingMessageId, { content: JSON.stringify(content) });
    if (updated) this.sendMessage(sessionId, updated);
    live.thinkingMessageId = null;
    live.thinkingText = "";
    live.thinkingParentToolUseId = null;
    live.thinkingEstimatedTokens = void 0;
  }
  flushBuffer(sessionId, live) {
    if (live.bufferMessageId == null) return;
    const updated = this.store.updateMessage(live.bufferMessageId, { content: live.buffer });
    if (updated) this.sendMessage(sessionId, updated);
    live.buffer = "";
    live.bufferMessageId = null;
  }
  // ── Auto-naming (background summarizer, Bug #93 regression guard) ────
  /**
   * Always actually runs the summarizer harness call when there's a
   * transcript, regardless of `name_locked_by_user` — the lock is enforced
   * exclusively at the write path (`SessionStore.setAutoName`), not by
   * skipping the call here. This mirrors Playground's real Bug #93 exactly
   * (the summarizer DID run after a manual rename; the missing piece was a
   * guard on the write) and makes the regression test meaningful: it proves
   * the guard holds under an actual attempted overwrite, not just that the
   * summarizer happened not to be invoked.
   */
  async maybeAutoName(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const early = this.store.listMessages(sessionId).slice(0, 6);
    const transcript = early.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 2e3);
    if (!transcript) return;
    const host = this.resolveHostFromSession(session.hostname);
    const namingSession = await this.harness.start(`${AUTO_NAME_PROMPT}

Conversation:
${transcript}`, {
      cwd: session.projectPath,
      host
    });
    let title = "";
    for await (const event of namingSession.events) {
      if (event.type === "result" && !event.isError && event.result) {
        title = event.result.trim().replace(/^["'“”]+|["'“”]+$/g, "");
      }
    }
    if (!title) return;
    const updated = this.store.setAutoName(sessionId, title);
    if (session.nameLockedByUser) {
      logger.info("auto-naming attempted but blocked: name is locked by user", { sessionId, attemptedTitle: title });
      return;
    }
    if (updated && updated.name === title) {
      this.sendLifecycle({ type: "session.updated", session: updated });
    }
  }
  /**
   * Gracefully interrupts every live claude-code session on app quit so SDK
   * teardown surfaces `interrupted` (not `error`) and mid-turn sessions get
   * {@link TURN_INTERRUPTED_NOTICE} on the next resume.
   */
  async shutdownAllHarnessSessionsForAppQuit() {
    for (const [sessionId, liveStream] of this.live.entries()) {
      const turnInFlight = liveStream.busy || liveStream.bufferMessageId != null || liveStream.pendingTools.size > 0;
      if (turnInFlight) {
        this.store.setPendingTurnInterruptedNotice(sessionId);
      }
    }
    const sessionIds = this.store.listActiveSessions().filter((s) => s.mode === "claude-code").map((s) => s.id);
    await Promise.all(sessionIds.map((id) => this.harness.interrupt(id).catch(() => void 0)));
    await delay(750);
    for (const sessionId of sessionIds) {
      this.live.delete(sessionId);
      this.connecting.delete(sessionId);
      this.sendTurnState(sessionId, false);
    }
  }
  /**
   * Attempts to reconnect all active sessions on startup, concurrently and
   * without blocking the caller. During reconnect each session shows as
   * 'connecting' (blinking grey). On success it transitions to 'waiting'
   * (purple). On failure it is pushed to 'session:stale' (steady grey) with
   * no error written to the transcript — startup failures are silent.
   * Terminal-mode sessions can't auto-reconnect (they need a pty attach), so
   * they are probed via `tmux has-session` instead and marked stale if dead.
   */
  startupReconnect() {
    const execFileAsync2 = node_util.promisify(node_child_process.execFile);
    const SSH_MUX_OPTS2 = ["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/atelier-ssh-%C", "-o", "ControlPersist=300"];
    const TMUX_TIMEOUT_MS = 8e3;
    const markStale = (sessionId) => {
      this.getWindow()?.webContents.send("session:stale", { sessionId, stale: true });
    };
    const tmuxName = (s) => `atelier-${s.id.replace(/[^a-zA-Z0-9-]/g, "-")}`.slice(0, 50);
    for (const session of this.store.listActiveSessions()) {
      if (session.mode === "terminal") {
        const name = tmuxName(session);
        const check = session.hostname ? execFileAsync2("ssh", [...SSH_MUX_OPTS2, session.hostname, "tmux", "has-session", "-t", name], { timeout: TMUX_TIMEOUT_MS }) : execFileAsync2("tmux", ["has-session", "-t", name], { timeout: TMUX_TIMEOUT_MS });
        check.catch(() => markStale(session.id));
        continue;
      }
      if (this.sessionIsStartupIdleEligible(session)) {
        if (!session.closedAt) {
          this.closeSession(session.id);
        }
        logger.info("startupReconnect: skipping auto reconnect (session startup-idle)", {
          sessionId: session.id,
          lastActiveAt: session.lastActiveAt
        });
        continue;
      }
      const sessionId = session.id;
      this.startupAutoReconnect.add(sessionId);
      this.pendingPanelPreload.add(sessionId);
      this.connecting.add(sessionId);
      this.sendStatus(sessionId);
      const permissionMode = this.permissionModes.get(sessionId) ?? session.permissionMode;
      const modelSelection = this.modelSelections.get(sessionId) ?? session.modelSelection ?? void 0;
      this.reconnectHarness(session, {
        permissionMode,
        model: modelSelection?.model,
        effort: modelSelection?.effort
      }).then((harnessSession) => {
        this.finalizeStaleRunningToolCalls(sessionId);
        this.live.set(sessionId, newLiveStream(this.initialTurnCountForReconnect(sessionId)));
        this.resetHarnessUiForSession(sessionId);
        this.sendStatus(sessionId);
        void this.consume(sessionId, harnessSession.events);
      }).catch(() => {
        this.pendingPanelPreload.delete(sessionId);
        this.startupAutoReconnect.delete(sessionId);
        this.connecting.delete(sessionId);
        this.sendStatus(sessionId);
      });
    }
  }
}
function deriveDefaultName(projectPath, prompt) {
  if (prompt && prompt.trim()) {
    const words = prompt.trim().split(/\s+/).slice(0, 6).join(" ");
    return words.length < prompt.trim().length ? `${words}…` : words;
  }
  const base = projectPath.split("/").filter(Boolean).pop() ?? projectPath;
  return base;
}
function applyDecision(content, decision) {
  if (content.kind === "permission_request" && decision.kind === "permission") {
    return { ...content, status: decision.decision === "allow" ? "allowed" : "denied", alwaysAllowed: decision.alwaysAllow };
  }
  if (content.kind === "ask_user_question" && decision.kind === "ask_user_question") {
    return { ...content, status: "answered", answers: decision.answers, freeText: decision.freeText };
  }
  if (content.kind === "plan_proposed" && decision.kind === "plan") {
    const status = decision.decision === "accept" ? "accepted" : decision.decision === "reject" ? "rejected" : "keep_planning";
    return { ...content, status };
  }
  throw new Error(`Prompt decision kind "${decision.kind}" does not match pending prompt kind "${content.kind}"`);
}
function toHarnessPromptResponse(decision) {
  return decision;
}
function modelSelectionsEqual(a, b) {
  return (a?.model ?? void 0) === (b?.model ?? void 0) && (a?.effort ?? void 0) === (b?.effort ?? void 0);
}
function sessionChangesCapSignature(cap) {
  return cap.items.map(
    (i) => i.kind === "file" ? `f:${i.path}:${i.additions}:${i.deletions}:${i.sortAt}` : `c:${i.hash}:${i.subject}:${i.sortAt}`
  ).join("|");
}
const DEVPOD_GIT_POLL_MS = 15e3;
const LOCAL_GIT_DEBOUNCE_MS = 400;
const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;
function workspacePathFor(session) {
  return session.worktreePath ?? session.projectPath;
}
function diffListSignature(diff) {
  if (!diff.isRepo) return "not-repo";
  const branch = diff.branch ?? "";
  const files = diff.files.map((f) => `${f.path}:${f.additions}:${f.deletions}:${f.status}`).join("|");
  return `${branch}|${files}`;
}
class WorkspaceService {
  constructor(getWindow, buildSessionChangesCap2) {
    this.getWindow = getWindow;
    this.buildSessionChangesCap = buildSessionChangesCap2;
  }
  cache = /* @__PURE__ */ new Map();
  monitors = /* @__PURE__ */ new Map();
  ptyManager = null;
  setPtyManager(pty2) {
    this.ptyManager = pty2;
  }
  getCached(sessionId) {
    return this.cache.get(sessionId) ?? null;
  }
  sendOpenReady(payload) {
    this.cache.set(payload.sessionId, payload);
    this.getWindow()?.webContents.send("session:openReady", {
      sessionId: payload.sessionId,
      workspace: payload
    });
    logger.info("session:openReady", {
      sessionId: payload.sessionId,
      diffFiles: payload.diff.files?.length ?? 0,
      capItems: payload.sessionChangesCap.items.length,
      treeEntries: payload.filesTree.length
    });
  }
  sendUpdated(payload) {
    this.cache.set(payload.sessionId, payload);
    this.getWindow()?.webContents.send("session:workspaceUpdated", {
      sessionId: payload.sessionId,
      workspace: payload
    });
  }
  async preloadSession(session) {
    const workspacePath = workspacePathFor(session);
    const hostname = session.hostname;
    const tabTerminalPtyId = `${session.id}:tab-terminal`;
    const pty2 = this.ptyManager;
    if (pty2) {
      try {
        await pty2.spawn(tabTerminalPtyId, {
          cwd: workspacePath,
          hostname,
          cols: DEFAULT_PTY_COLS,
          rows: DEFAULT_PTY_ROWS
        });
      } catch (err) {
        logger.warn("workspace preload: tab terminal spawn failed", {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const [diff, filesTree, filesList, sessionChangesCap] = await Promise.all([
      getDiffSummary(workspacePath, hostname, false),
      Promise.resolve(walkFileTree(workspacePath, hostname)).then((r) => Array.isArray(r) ? r : []),
      Promise.resolve(listWorkspaceFiles(workspacePath, hostname)).then((r) => Array.isArray(r) ? r : []),
      this.buildSessionChangesCap(session.id, { processHead: true })
    ]);
    const payload = {
      sessionId: session.id,
      workspacePath,
      hostname,
      diff,
      sessionChangesCap,
      filesTree,
      filesList,
      tabTerminalPtyId,
      loadedAt: Date.now()
    };
    return payload;
  }
  /** After harness is live: preload, notify renderer, start background monitor. */
  async completeSessionOpen(session) {
    const payload = await this.preloadSession(session);
    this.sendOpenReady(payload);
    this.startMonitor(session);
  }
  async refreshWorkspace(session, force) {
    const workspacePath = workspacePathFor(session);
    const prev = this.cache.get(session.id);
    const [diff, filesTree, filesList, sessionChangesCap] = await Promise.all([
      getDiffSummary(workspacePath, session.hostname, force),
      Promise.resolve(walkFileTree(workspacePath, session.hostname)).then(
        (r) => Array.isArray(r) ? r : []
      ),
      Promise.resolve(listWorkspaceFiles(workspacePath, session.hostname)).then(
        (r) => Array.isArray(r) ? r : []
      ),
      this.buildSessionChangesCap(session.id, { processHead: true })
    ]);
    const payload = {
      sessionId: session.id,
      workspacePath,
      hostname: session.hostname,
      diff,
      sessionChangesCap,
      filesTree,
      filesList,
      tabTerminalPtyId: prev?.tabTerminalPtyId ?? `${session.id}:tab-terminal`,
      loadedAt: Date.now()
    };
    const prevDiffSig = prev ? diffListSignature(prev.diff) : "";
    const nextDiffSig = diffListSignature(diff);
    const treeChanged = JSON.stringify(prev?.filesTree) !== JSON.stringify(filesTree);
    const capChanged = sessionChangesCapSignature(prev?.sessionChangesCap ?? { items: [] }) !== sessionChangesCapSignature(sessionChangesCap);
    if (prevDiffSig !== nextDiffSig || treeChanged || capChanged || force) {
      this.sendUpdated(payload);
    } else {
      this.cache.set(session.id, payload);
    }
    return payload;
  }
  patchSessionChangesCap(sessionId, cap) {
    const prev = this.cache.get(sessionId);
    if (!prev) return;
    const nextSig = sessionChangesCapSignature(cap);
    const prevSig = sessionChangesCapSignature(prev.sessionChangesCap);
    if (nextSig === prevSig) {
      this.cache.set(sessionId, { ...prev, sessionChangesCap: cap });
      return;
    }
    const payload = {
      ...prev,
      sessionChangesCap: cap,
      loadedAt: Date.now()
    };
    this.sendUpdated(payload);
  }
  stopMonitor(sessionId) {
    this.monitors.get(sessionId)?.stop();
    this.monitors.delete(sessionId);
  }
  evictSession(sessionId) {
    this.stopMonitor(sessionId);
    this.cache.delete(sessionId);
  }
  startMonitor(session) {
    this.monitors.get(session.id)?.stop();
    this.monitors.delete(session.id);
    const workspacePath = workspacePathFor(session);
    if (session.hostname) {
      const timer = setInterval(() => {
        void this.refreshWorkspace(session, false).catch(
          (err) => logger.warn("devpod workspace poll failed", {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err)
          })
        );
      }, DEVPOD_GIT_POLL_MS);
      this.monitors.set(session.id, {
        stop: () => clearInterval(timer)
      });
      return;
    }
    void (async () => {
      const gitDir = node_path.join(await resolveGitRepoRoot(workspacePath, null), ".git");
      let debounce;
      const watchers = [];
      const schedule = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          void this.refreshWorkspace(session, false).catch(() => void 0);
        }, LOCAL_GIT_DEBOUNCE_MS);
      };
      for (const rel of ["index", "HEAD"]) {
        try {
          watchers.push(node_fs.watch(node_path.join(gitDir, rel), schedule));
        } catch {
        }
      }
      this.monitors.set(session.id, {
        stop: () => {
          if (debounce) clearTimeout(debounce);
          for (const w of watchers) w.close();
        }
      });
    })();
  }
}
const STATIC_HOSTS = [
  {
    id: "devpod-us-or",
    sshHost: "qingqin-go.devpod-us-or",
    label: "devpod-us-or",
    status: "running",
    // Confirmed via `ssh qingqin-go.devpod-us-or -- 'ls -la ~/.local/bin'`:
    // aifx symlinks the real claude install here, but non-interactive SSH
    // commands don't get ~/.local/bin on PATH (bare `claude` -> exit 127),
    // while the full path works identically to an interactive shell.
    remoteExecutablePath: "/home/user/.local/bin/claude"
  }
];
function createStaticHostResolver() {
  return {
    list: () => STATIC_HOSTS,
    resolve: (hostId) => STATIC_HOSTS.find((h) => h.id === hostId),
    resolveByHostname: (sshHost) => STATIC_HOSTS.find((h) => h.sshHost === sshHost)
  };
}
function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}
function toolHeadline(name, input) {
  const obj = asRecord(input);
  switch (name) {
    case "Bash":
      return typeof obj.command === "string" ? obj.command : name;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
    case "MultiEdit":
      return typeof obj.file_path === "string" ? obj.file_path : name;
    case "Grep":
      return typeof obj.pattern === "string" ? `grep ${obj.pattern}` : name;
    case "Glob":
      return typeof obj.pattern === "string" ? String(obj.pattern) : name;
    case "Task":
    case "Agent":
      return typeof obj.description === "string" ? obj.description : typeof obj.subagent_type === "string" ? String(obj.subagent_type) : "Task";
    case "WebFetch":
      return typeof obj.url === "string" ? obj.url : name;
    case "WebSearch":
      return typeof obj.query === "string" ? obj.query : name;
    default:
      return name;
  }
}
function roleLabel(role) {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return "System";
}
function formatStructuredMarkdown(structured) {
  switch (structured.kind) {
    case "tool_call": {
      const headline = toolHeadline(structured.name, structured.input);
      const statusLabel = structured.status === "error" ? "error" : structured.status === "running" ? "running" : structured.status === "interrupted" ? "interrupted" : "completed";
      return `- 🔧 **${structured.name}** — \`${headline}\` (${statusLabel})`;
    }
    case "todo_update": {
      const lines = structured.todos.map(
        (t) => `  - [${t.status === "completed" ? "x" : " "}] ${t.content}`
      );
      return `**Todo list update:**
${lines.join("\n")}`;
    }
    case "compaction":
      return `> Conversation compacted (${structured.trigger} trigger): ${structured.preTokens} → ${structured.postTokens ?? "?"} tokens`;
    case "permission_request":
      return `> Permission request for **${structured.toolName}** — ${structured.status}`;
    case "ask_user_question": {
      const answered = structured.answers && Object.keys(structured.answers).length > 0 ? `: ${Object.values(structured.answers).join(", ")}` : structured.freeText ? `: ${structured.freeText}` : "";
      return `> Question asked — ${structured.status}${answered}`;
    }
    case "plan_proposed":
      return `> Plan proposed — ${structured.status}`;
    default:
      return "";
  }
}
function formatMessageMarkdown(message) {
  const structured = parseStructuredContent(message.content);
  if (!structured) {
    if (!message.content.trim()) return "";
    return `### ${roleLabel(message.role)}

${message.content}
`;
  }
  return `${formatStructuredMarkdown(structured)}
`;
}
function formatTranscriptMarkdown(session, messages) {
  const header = [
    `# ${session.name}`,
    "",
    `_Project: ${session.projectPath}_`,
    `_Created: ${session.createdAt}${session.closedAt ? ` · Closed: ${session.closedAt}` : ""}_`,
    ""
  ].join("\n");
  const body = messages.map(formatMessageMarkdown).filter((block) => block.length > 0).join("\n");
  return `${header}
${body}
`;
}
function formatTranscriptJson(session, messages) {
  return {
    session: {
      id: session.id,
      name: session.name,
      projectPath: session.projectPath,
      mode: session.mode,
      hostname: session.hostname,
      createdAt: session.createdAt,
      closedAt: session.closedAt
    },
    messages: messages.map((m) => {
      const structured = parseStructuredContent(m.content);
      return {
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        content: structured ?? m.content
      };
    })
  };
}
function registerSessionHandlers(manager, getWindow) {
  electron.ipcMain.handle("session:pickProjectFolder", async () => {
    const win = getWindow();
    const options = { properties: ["openDirectory", "createDirectory"] };
    const result = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle("debug:queryDb", (_event, sql, params = []) => {
    return openDatabase().prepare(sql).all(...params);
  });
  electron.ipcMain.handle("debug:execDb", (_event, sql, params = []) => {
    return openDatabase().prepare(sql).run(...params);
  });
  electron.ipcMain.handle("session:listHosts", () => manager.listHosts());
  electron.ipcMain.handle("session:listRecentProjectPaths", (_event, hostId) => manager.listRecentProjectPaths(hostId));
  electron.ipcMain.handle(
    "session:suggestProjectPaths",
    (_event, hostId, query) => manager.suggestProjectPaths(hostId, query)
  );
  electron.ipcMain.handle("session:listActive", () => manager.listActive());
  electron.ipcMain.handle("session:listHistory", () => manager.listHistory());
  electron.ipcMain.handle("session:listMessages", (_event, sessionId) => manager.listMessages(sessionId));
  electron.ipcMain.handle("session:searchMessages", (_event, query) => manager.searchMessages(query));
  electron.ipcMain.handle("session:create", async (_event, opts) => {
    logger.info("session:create invoked", { projectPath: opts.projectPath, mode: opts.mode, hostId: opts.hostId });
    return manager.createSession(opts);
  });
  electron.ipcMain.handle("session:resume", (_event, sessionId) => {
    const snapshot = manager.resumeSnapshot(sessionId);
    void manager.reconnect(sessionId).catch(
      (err) => logger.error("session reconnect failed", { sessionId, error: err instanceof Error ? err.message : String(err) })
    );
    return snapshot;
  });
  electron.ipcMain.handle("session:reconnect", async (_event, sessionId) => {
    await manager.reconnect(sessionId);
  });
  electron.ipcMain.handle("session:touchActive", (_event, sessionId) => {
    manager.touchSessionActive(sessionId);
  });
  electron.ipcMain.handle("session:isStartupIdle", (_event, sessionId) => manager.isSessionStartupIdle(sessionId));
  electron.ipcMain.handle("session:sendMessage", (_event, sessionId, text, modelSelection, image) => {
    logger.info("session:sendMessage invoked", { sessionId, textLength: text.length, modelSelection, hasImage: Boolean(image) });
    return manager.sendUserMessage(sessionId, text, modelSelection, image);
  });
  electron.ipcMain.handle("session:interrupt", (_event, sessionId) => manager.interrupt(sessionId));
  electron.ipcMain.handle("session:validateModel", (_event, sessionId, model) => manager.validateModel(sessionId, model));
  electron.ipcMain.handle("session:fork", (_event, sessionId) => manager.forkSession(sessionId));
  electron.ipcMain.handle("session:restart", (_event, sessionId) => manager.restartSession(sessionId));
  electron.ipcMain.handle("session:close", (_event, sessionId) => manager.closeSession(sessionId));
  electron.ipcMain.handle(
    "session:linkDailyTask",
    async (_event, sessionId, noteDate, taskGid) => manager.linkDailyTask(sessionId, noteDate, taskGid)
  );
  electron.ipcMain.handle("session:completeLinkedDailyTask", async (_event, sessionId) => {
    await manager.completeLinkedDailyTask(sessionId);
  });
  electron.ipcMain.handle("session:delete", (_event, sessionId) => manager.deleteSession(sessionId));
  electron.ipcMain.handle("session:rename", (_event, sessionId, name) => manager.renameSession(sessionId, name));
  electron.ipcMain.handle("session:setPinned", (_event, sessionId, pinned) => manager.setPinned(sessionId, pinned));
  electron.ipcMain.handle(
    "session:setModelSelection",
    (_event, sessionId, selection) => manager.persistModelSelection(sessionId, selection)
  );
  electron.ipcMain.handle("session:setColor", (_event, sessionId, color) => manager.setColor(sessionId, color));
  electron.ipcMain.handle("session:setNotes", (_event, sessionId, notes) => manager.setNotes(sessionId, notes));
  electron.ipcMain.handle("session:addTag", (_event, sessionId, tag) => manager.addTag(sessionId, tag));
  electron.ipcMain.handle("session:removeTag", (_event, sessionId, tag) => manager.removeTag(sessionId, tag));
  electron.ipcMain.handle("session:listAllTags", () => manager.listAllTags());
  electron.ipcMain.handle("session:listStatuses", () => manager.listStatuses());
  electron.ipcMain.handle(
    "session:setGroup",
    (_event, sessionId, groupId) => manager.setSessionGroup(sessionId, groupId)
  );
  electron.ipcMain.handle(
    "session:reorder",
    (_event, groupId, orderedIds) => manager.reorderSessions(groupId, orderedIds)
  );
  electron.ipcMain.handle("group:list", () => manager.listGroups());
  electron.ipcMain.handle("group:create", (_event, name) => manager.createGroup(name));
  electron.ipcMain.handle("group:rename", (_event, groupId, name) => manager.renameGroup(groupId, name));
  electron.ipcMain.handle(
    "group:setCollapsed",
    (_event, groupId, collapsed) => manager.setGroupCollapsed(groupId, collapsed)
  );
  electron.ipcMain.handle("group:delete", (_event, groupId) => manager.deleteGroup(groupId));
  electron.ipcMain.handle("group:reorder", (_event, orderedIds) => manager.reorderGroups(orderedIds));
  electron.ipcMain.handle(
    "session:respondToPrompt",
    (_event, sessionId, requestId, decision) => manager.respondToPrompt(sessionId, requestId, decision)
  );
  electron.ipcMain.handle("session:cycleMode", (_event, sessionId) => manager.cycleMode(sessionId));
  electron.ipcMain.handle("session:exportTranscript", async (_event, sessionId, format) => {
    const session = manager.getSession(sessionId);
    if (!session) return null;
    const messages = manager.listMessages(sessionId);
    const isMarkdown = format === "markdown";
    const defaultExt = isMarkdown ? "md" : "json";
    const win = getWindow();
    const options = {
      defaultPath: `${session.name}.${defaultExt}`,
      filters: isMarkdown ? [{ name: "Markdown", extensions: ["md"] }] : [{ name: "JSON", extensions: ["json"] }]
    };
    const result = win ? await electron.dialog.showSaveDialog(win, options) : await electron.dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const contents = isMarkdown ? formatTranscriptMarkdown(session, messages) : JSON.stringify(formatTranscriptJson(session, messages), null, 2);
    await promises.writeFile(result.filePath, contents, "utf8");
    logger.info("session:exportTranscript wrote file", { sessionId, format, filePath: result.filePath });
    return result.filePath;
  });
  electron.ipcMain.handle(
    "session:getWorkspaceSnapshot",
    (_event, sessionId) => manager.getSessionWorkspaceSnapshot(sessionId)
  );
  electron.ipcMain.handle(
    "session:refreshWorkspace",
    async (_event, sessionId, force) => manager.refreshSessionWorkspace(sessionId, force)
  );
}
function rowToRecord(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortOrder: row.sort_order
  };
}
class AppNotesStore {
  constructor(db2) {
    this.db = db2;
  }
  list() {
    const rows = this.db.prepare("SELECT * FROM app_notes ORDER BY sort_order ASC, updated_at DESC").all();
    return rows.map(rowToRecord);
  }
  create(title = "Untitled note") {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const id = node_crypto.randomUUID();
    const maxOrder = this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM app_notes").get();
    const sortOrder = maxOrder.m + 1;
    this.db.prepare(
      "INSERT INTO app_notes (id, title, content, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, title, "", now, now, sortOrder);
    return rowToRecord(this.db.prepare("SELECT * FROM app_notes WHERE id = ?").get(id));
  }
  update(id, patch) {
    const existing = this.db.prepare("SELECT * FROM app_notes WHERE id = ?").get(id);
    if (!existing) return void 0;
    const title = patch.title !== void 0 ? patch.title : existing.title;
    const content = patch.content !== void 0 ? patch.content : existing.content;
    const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare("UPDATE app_notes SET title = ?, content = ?, updated_at = ? WHERE id = ?").run(title, content, updatedAt, id);
    return rowToRecord(this.db.prepare("SELECT * FROM app_notes WHERE id = ?").get(id));
  }
  delete(id) {
    return this.db.prepare("DELETE FROM app_notes WHERE id = ?").run(id).changes > 0;
  }
}
let store;
function notesStore() {
  if (!store) store = new AppNotesStore(openDatabase());
  return store;
}
function registerAppNotesHandlers() {
  electron.ipcMain.handle("app-note:list", () => notesStore().list());
  electron.ipcMain.handle("app-note:create", (_event, title) => {
    const note = notesStore().create(title);
    logger.info("app-note created", { id: note.id });
    return note;
  });
  electron.ipcMain.handle("app-note:update", (_event, id, patch) => {
    const note = notesStore().update(id, patch);
    if (!note) throw new Error(`app note not found: ${id}`);
    return note;
  });
  electron.ipcMain.handle("app-note:delete", (_event, id) => {
    if (!notesStore().delete(id)) throw new Error(`app note not found: ${id}`);
    logger.info("app-note deleted", { id });
  });
}
const execFileAsync$1 = util.promisify(child_process.execFile);
const POOL_SIZE = 2;
const POOL_PREFIX = "atelier-pool-";
class ShellPoolManager {
  constructor(tmuxBin2) {
    this.tmuxBin = tmuxBin2;
    this.replenish();
  }
  shells = [];
  replenishing = false;
  /**
   * Claim a pre-warmed session. Returns the tmux session name, or null if the
   * pool is empty (caller must fall back to tmux new-session).
   */
  claim() {
    const idx = this.shells.findIndex((s) => s.status === "ready");
    if (idx === -1) return null;
    const shell = this.shells[idx];
    this.shells.splice(idx, 1);
    logger.info("shell-pool: claimed", { name: shell.name, remaining: this.shells.filter((s) => s.status === "ready").length });
    return shell.name;
  }
  /**
   * Rename a claimed pool session to the real session name.
   * Call this immediately after claim() before attaching the pty.
   */
  async rename(poolName, realName) {
    await execFileAsync$1(this.tmuxBin, ["rename-session", "-t", poolName, realName]);
  }
  /**
   * Refill the pool up to POOL_SIZE. Fire-and-forget — never blocks the caller.
   * Deduplicates: only one replenish runs at a time.
   */
  replenish() {
    if (this.replenishing) return;
    const readyCount = this.shells.filter((s) => s.status === "ready").length;
    const warmingCount = this.shells.filter((s) => s.status === "warming").length;
    if (readyCount + warmingCount >= POOL_SIZE) return;
    this.replenishing = true;
    const deficit = POOL_SIZE - readyCount - warmingCount;
    Promise.all(Array.from({ length: deficit }, () => this.warmOne())).catch((err) => logger.warn("shell-pool: replenish failed", { error: String(err) })).finally(() => {
      this.replenishing = false;
    });
  }
  async warmOne() {
    const id = crypto.randomBytes(4).toString("hex");
    const name = `${POOL_PREFIX}${id}`;
    const shell = { name, status: "warming" };
    this.shells.push(shell);
    try {
      await execFileAsync$1(this.tmuxBin, ["new-session", "-d", "-s", name, "-c", os.homedir()]);
      shell.status = "ready";
      logger.info("shell-pool: warm shell ready", { name });
    } catch (err) {
      this.shells = this.shells.filter((s) => s !== shell);
      execFileAsync$1(this.tmuxBin, ["kill-session", "-t", name]).catch(() => {
      });
      logger.warn("shell-pool: warm-up failed", { name, error: String(err) });
    }
  }
  /** Kill all pool sessions. Called on app shutdown. */
  cleanup() {
    for (const shell of this.shells) {
      try {
        child_process.execFileSync(this.tmuxBin, ["kill-session", "-t", shell.name], { stdio: "ignore" });
      } catch {
      }
    }
    this.shells = [];
  }
}
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b[@-_]/g, "");
}
function parseSshHostFromShellLine(line) {
  const trimmed = stripAnsi(line).trim();
  const sshIdx = trimmed.search(/\bssh(?:\s|$)/);
  if (sshIdx < 0) return null;
  const rest = trimmed.slice(sshIdx).replace(/^ssh\s+/, "");
  if (!rest) return null;
  const tokens = rest.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const opt = tokens[i];
    const takesArg = /* @__PURE__ */ new Set(["-o", "-b", "-c", "-i", "-F", "-J", "-l", "-p", "-t", "-W", "-w"]);
    if (takesArg.has(opt) && i + 1 < tokens.length) i += 2;
    else i += 1;
  }
  const target = tokens[i];
  if (!target) return null;
  const at = target.lastIndexOf("@");
  return at >= 0 ? target.slice(at + 1) : target;
}
function parsePromptHostFromLine(line) {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed || /^[%$#>]$/.test(trimmed)) return null;
  const parenHost = trimmed.match(/@[\w.-]+\(([\w.-]+)\)/);
  if (parenHost) return parenHost[1];
  const sameLine = trimmed.match(/([\w.-]+)@([\w.-]+)(?:\s|:|\[)?(?:[^\n[%$#>]*)?\s*[%$#>]\s*$/);
  if (sameLine) return sameLine[2];
  const tildePrompt = trimmed.match(/^([\w.-]+)@([\w.-]+)(?:\([^)]+\))?\s+~(?:\s|$)/);
  if (tildePrompt) return tildePrompt[2];
  return null;
}
function parseSshConnectionClosed(data) {
  return /Connection to .+ closed\.?/i.test(stripAnsi(data));
}
function localMachineHostLabels(machineHostname) {
  const full = machineHostname.trim();
  const short = full.split(".")[0] ?? full;
  return [...new Set([full, short].filter(Boolean))];
}
function isLocalMachineHost(host, localLabels) {
  const h = host.trim().toLowerCase();
  return localLabels.some((l) => l.toLowerCase() === h);
}
function hostFromPromptLine(line) {
  return parsePromptHostFromLine(line);
}
function inferShellHostFromPtyTail(outputTail, localLabels) {
  const stripped = stripAnsi(outputTail);
  const lines = stripped.split(/\r?\n/);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 16); i--) {
    const line = lines[i]?.trim() ?? "";
    let host = hostFromPromptLine(line);
    if (!host && /^[%$#>]$/.test(line) && i > 0) {
      host = hostFromPromptLine(lines[i - 1] ?? "");
    }
    if (!host) continue;
    if (isLocalMachineHost(host, localLabels)) return null;
    return host;
  }
  return void 0;
}
const execFileAsync = util.promisify(child_process.execFile);
let tmuxBin = null;
let shellPool = null;
try {
  tmuxBin = child_process.execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  shellPool = new ShellPoolManager(tmuxBin);
  logger.info("tmux available", { path: tmuxBin });
} catch {
  logger.warn("tmux not found — terminals will use a plain shell (no session persistence across restarts)");
}
function tmuxSessionName(id) {
  const sanitized = id.replace(/[^a-zA-Z0-9-]/g, "-");
  return `atelier-${sanitized}`.slice(0, 50);
}
function resolveLocalPtyCwd(cwd) {
  const expanded = cwd.trim().replace(/^~(?=\/|$)/, node_os.homedir());
  const abs = node_path.resolve(expanded || node_os.homedir());
  if (node_fs.existsSync(abs)) return abs;
  const fallback = node_path.resolve(process.cwd());
  if (node_fs.existsSync(fallback)) {
    logger.warn("pty cwd missing, using fallback", { requested: cwd, abs, fallback });
    return fallback;
  }
  return node_os.homedir();
}
class PtyManager {
  constructor(getWindow) {
    this.getWindow = getWindow;
  }
  ptys = /* @__PURE__ */ new Map();
  genCounter = 0;
  emitShellContext(id, remoteHost) {
    this.getWindow()?.webContents.send("pty:shellContext", { id, remoteHost });
  }
  setShellContext(entry, id, remoteHost) {
    if (entry.shellRemoteHost === remoteHost) return;
    entry.shellRemoteHost = remoteHost;
    this.emitShellContext(id, remoteHost);
  }
  applyInferredShellHost(entry, id) {
    const inferred = inferShellHostFromPtyTail(entry.outputTail, entry.localHostLabels);
    if (inferred === void 0) return;
    if (inferred !== entry.shellRemoteHost) {
      this.setShellContext(entry, id, inferred);
    }
  }
  appendInputChars(entry, id, data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1B" && i + 1 < data.length && data[i + 1] === "[") {
        i += 2;
        while (i < data.length && !/[A-Za-z~]/.test(data[i])) i++;
        if (i < data.length) i++;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const host = parseSshHostFromShellLine(entry.inputLineBuffer);
        entry.inputLineBuffer = "";
        if (host) this.setShellContext(entry, id, host);
      } else if (ch === "" || ch === "\b") {
        entry.inputLineBuffer = entry.inputLineBuffer.slice(0, -1);
      } else if (ch >= " " || ch === "	") {
        entry.inputLineBuffer += ch;
        if (entry.inputLineBuffer.length > 512) {
          entry.inputLineBuffer = entry.inputLineBuffer.slice(-512);
        }
      }
      i++;
    }
  }
  async spawn(id, opts) {
    this.kill(id);
    const t0 = Date.now();
    const elapsed = () => Date.now() - t0;
    const isRemote = Boolean(opts.hostname);
    const useTmux = !isRemote && tmuxBin !== null;
    const localCwd = isRemote ? opts.cwd : resolveLocalPtyCwd(opts.cwd);
    let shell;
    let args;
    let entryTmuxName;
    let entryHostname;
    let claimedFromPool = false;
    logger.info("pty spawn: start", { id, isRemote, useTmux, cwd: opts.cwd });
    if (useTmux) {
      const name = tmuxSessionName(id);
      logger.info("pty spawn: tmux has-session check", { id, name, elapsedMs: elapsed() });
      try {
        await execFileAsync(tmuxBin, ["has-session", "-t", name]);
        logger.info("pty spawn: tmux session exists, attaching", { id, name, elapsedMs: elapsed() });
      } catch {
        const poolName = shellPool?.claim() ?? null;
        if (poolName !== null) {
          logger.info("pty spawn: claiming from pool", { id, name, poolName, elapsedMs: elapsed() });
          await execFileAsync(tmuxBin, ["rename-session", "-t", poolName, name]);
          claimedFromPool = true;
          shellPool.replenish();
          logger.info("pty spawn: pool claim complete", { id, name, elapsedMs: elapsed() });
        } else {
          logger.info("pty spawn: tmux session not found, creating", { id, name, elapsedMs: elapsed() });
          await execFileAsync(tmuxBin, [
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            String(Math.max(opts.cols || 80, 2)),
            "-y",
            String(Math.max(opts.rows || 24, 2)),
            "-c",
            localCwd
          ]);
          logger.info("pty spawn: tmux session created", { id, name, elapsedMs: elapsed() });
        }
      }
      shell = tmuxBin;
      args = ["attach-session", "-t", name];
      entryTmuxName = name;
    } else if (isRemote) {
      const hostname = opts.hostname;
      const name = tmuxSessionName(id);
      logger.info("pty spawn: remote tmux has-session check", { id, hostname, name, elapsedMs: elapsed() });
      const SSH_TIMEOUT = 1e4;
      try {
        try {
          await execFileAsync("ssh", [...SSH_MUX_OPTS, hostname, "tmux", "has-session", "-t", name], { timeout: SSH_TIMEOUT });
          logger.info("pty spawn: remote tmux session exists, attaching", { id, hostname, name, elapsedMs: elapsed() });
        } catch {
          logger.info("pty spawn: remote tmux session not found, creating", { id, hostname, name, elapsedMs: elapsed() });
          await execFileAsync("ssh", [
            ...SSH_MUX_OPTS,
            hostname,
            "tmux",
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            String(Math.max(opts.cols || 80, 2)),
            "-y",
            String(Math.max(opts.rows || 24, 2)),
            "-c",
            opts.cwd ?? "$HOME"
          ], { timeout: SSH_TIMEOUT });
          logger.info("pty spawn: remote tmux session created", { id, hostname, name, elapsedMs: elapsed() });
        }
        shell = "ssh";
        args = [...SSH_MUX_OPTS, hostname, "-t", "tmux", "attach-session", "-t", name];
        entryTmuxName = name;
        entryHostname = hostname;
        logger.info("pty spawn: remote tmux ready", { hostname, name, elapsedMs: elapsed() });
      } catch (err) {
        logger.warn("remote tmux not available — falling back to plain ssh", { hostname, error: String(err) });
        shell = "ssh";
        args = [...SSH_MUX_OPTS, hostname];
      }
    } else {
      shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
      args = [];
    }
    const gen = ++this.genCounter;
    logger.info("pty spawn: node-pty.spawn starting", { id, shell, elapsedMs: elapsed() });
    const proc = pty__namespace.spawn(shell, args, {
      name: "xterm-color",
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: isRemote ? void 0 : localCwd,
      env: process.env
    });
    const initialShellHost = isRemote ? opts.hostname : null;
    const entry = {
      proc,
      gen,
      tmuxName: entryTmuxName,
      hostname: entryHostname,
      shellRemoteHost: initialShellHost,
      inputLineBuffer: "",
      outputTail: "",
      localHostLabels: isRemote ? [] : localMachineHostLabels(node_os.hostname())
    };
    this.ptys.set(id, entry);
    this.emitShellContext(id, initialShellHost);
    proc.onData((data) => {
      const current = this.ptys.get(id);
      if (current?.proc !== proc) {
        logger.info("pty stale-data dropped", { id, gen, currentGen: current?.gen ?? null, bytes: data.length });
        return;
      }
      this.getWindow()?.webContents.send("pty:data", { id, data });
      if (current.hostname) return;
      current.outputTail = (current.outputTail + data).slice(-8192);
      if (parseSshConnectionClosed(data)) {
        this.setShellContext(current, id, null);
      } else {
        this.applyInferredShellHost(current, id);
      }
    });
    proc.onExit(({ exitCode }) => {
      if (this.ptys.get(id)?.proc !== proc) return;
      logger.info("pty exited", { id, exitCode, gen });
      this.getWindow()?.webContents.send("pty:exit", { id, exitCode });
      this.ptys.delete(id);
    });
    if (!isRemote && !useTmux) {
      proc.write(`cd ${JSON.stringify(localCwd)} && clear\r`);
    } else if (claimedFromPool) {
      proc.write(`cd ${JSON.stringify(localCwd)} && clear\r`);
    }
    logger.info("pty spawned", { id, shell, remote: isRemote, tmux: Boolean(entryTmuxName), cwd: opts.cwd, gen, totalElapsedMs: elapsed() });
    if (!isRemote) {
      setTimeout(() => {
        const live = this.ptys.get(id);
        if (live?.proc !== proc) return;
        this.applyInferredShellHost(live, id);
      }, 400);
    }
  }
  write(id, data) {
    const entry = this.ptys.get(id);
    if (!entry) return;
    entry.proc.write(data);
    if (entry.hostname) return;
    this.appendInputChars(entry, id, data);
  }
  resize(id, cols, rows) {
    try {
      this.ptys.get(id)?.proc.resize(Math.max(cols, 2), Math.max(rows, 2));
    } catch {
    }
  }
  kill(id) {
    const entry = this.ptys.get(id);
    if (!entry) return;
    this.ptys.delete(id);
    if (entry.tmuxName) {
      if (entry.hostname) {
        try {
          child_process.execFileSync("ssh", [...SSH_MUX_OPTS, entry.hostname, "tmux", "detach-client", "-s", entry.tmuxName], { stdio: "ignore" });
        } catch {
        }
      } else if (tmuxBin) {
        try {
          child_process.execFileSync(tmuxBin, ["detach-client", "-s", entry.tmuxName], { stdio: "ignore" });
        } catch {
        }
      }
    }
    try {
      entry.proc.kill();
    } catch {
    }
  }
  /**
   * Kill the backing tmux server session for this pty id.
   * Call this when the Atelier session is permanently deleted — not merely
   * when the app closes. No-op if tmux is not installed or if the session
   * never existed (tmux exit code is ignored).
   */
  killTmuxSession(id) {
    if (!tmuxBin) return;
    const name = tmuxSessionName(id);
    try {
      child_process.execFileSync(tmuxBin, ["kill-session", "-t", name], { stdio: "ignore" });
      logger.info("tmux session killed", { id, name });
    } catch {
    }
  }
  isAlive(id) {
    return this.ptys.has(id);
  }
  /** Kills every live pty — called on app shutdown so real shell child processes never keep the app process alive (they hold ref'd libuv handles otherwise). */
  killAll() {
    for (const id of [...this.ptys.keys()]) this.kill(id);
    shellPool?.cleanup();
  }
}
function probeLocalPortOnce(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = node_net.connect({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
async function waitForLocalPort(port, overallTimeoutMs) {
  const deadline = Date.now() + overallTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeLocalPortOnce(port, 500)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
class PortForwardManager {
  constructor(getWindow) {
    this.getWindow = getWindow;
  }
  forwards = /* @__PURE__ */ new Map();
  notify() {
    this.getWindow()?.webContents.send("ports:updated", this.list());
  }
  list(sessionId) {
    const all = [...this.forwards.values()].map((e) => e.config);
    return sessionId ? all.filter((f) => f.sessionId === sessionId) : all;
  }
  async add(sessionId, sshHost, localPort, remoteHost, remotePort) {
    const id = `${sessionId}:${localPort}:${remoteHost}:${remotePort}:${Date.now()}`;
    const config = { id, sessionId, localPort, remoteHost, remotePort, status: "connecting" };
    const proc = node_child_process.spawn(
      "ssh",
      ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-L", `${localPort}:${remoteHost}:${remotePort}`, sshHost],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.forwards.set(id, { config, proc });
    logger.info("port forward starting", { id, sshHost, localPort, remoteHost, remotePort });
    proc.stdout?.on("data", (chunk) => {
      logger.info("ssh port-forward stdout", { id, line: chunk.toString().trim() });
    });
    proc.stderr?.on("data", (chunk) => {
      logger.warn("ssh port-forward stderr", { id, line: chunk.toString().trim() });
    });
    proc.on("exit", (code) => {
      const entry2 = this.forwards.get(id);
      if (entry2) {
        entry2.config.status = "error";
        entry2.config.error = `ssh exited (code ${code})`;
        this.notify();
      }
      logger.info("port forward process exited", { id, code });
    });
    const confirmed = await waitForLocalPort(localPort, 12e3);
    const entry = this.forwards.get(id);
    if (entry && entry.proc.exitCode === null) {
      entry.config.status = confirmed ? "active" : "error";
      if (!confirmed) entry.config.error = "forward did not become reachable within timeout";
      this.notify();
    }
    return this.forwards.get(id)?.config ?? config;
  }
  remove(id) {
    const entry = this.forwards.get(id);
    if (!entry) return;
    entry.proc.kill();
    this.forwards.delete(id);
    this.notify();
  }
  removeAllForSession(sessionId) {
    for (const [id, entry] of this.forwards) {
      if (entry.config.sessionId === sessionId) {
        entry.proc.kill();
        this.forwards.delete(id);
      }
    }
  }
  /** Kills every real ssh forward process — called on app shutdown for the same reason as PtyManager.killAll. */
  killAll() {
    for (const [id, entry] of this.forwards) {
      entry.proc.kill();
      this.forwards.delete(id);
    }
  }
}
function registerPanelHandlers(getWindow) {
  const ptyManager2 = new PtyManager(getWindow);
  const portManager2 = new PortForwardManager(getWindow);
  electron.ipcMain.handle(
    "panel:git:diff",
    (_e, projectPath, hostname, force) => getDiffSummary(projectPath, hostname, force)
  );
  electron.ipcMain.handle(
    "panel:git:fileDiff",
    (_e, projectPath, filePath, hostname) => getFileDiff(projectPath, filePath, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:commitDiff",
    (_e, projectPath, commit, hostname) => getCommitDiff(projectPath, commit, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:commitOpen",
    (_e, projectPath, commit, hostname) => getCommitPanelOpen(projectPath, commit, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:commitFileDiff",
    (_e, projectPath, commit, filePath, hostname) => getCommitFileDiff(projectPath, commit, filePath, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:workingTreeFilePair",
    (_e, projectPath, filePath, status, hostname) => getWorkingTreeFilePair(projectPath, filePath, status, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:commitFilePair",
    (_e, projectPath, commit, filePath, status, hostname) => getCommitFilePair(projectPath, commit, filePath, status, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:commits",
    (_e, projectPath, hostname, force) => listCommits(projectPath, 50, hostname, force)
  );
  electron.ipcMain.handle(
    "panel:git:worktrees",
    (_e, projectPath, hostname, force) => listWorktrees(projectPath, hostname, force)
  );
  electron.ipcMain.handle("panel:git:warmRemote", (_e, hostname) => warmRemoteGitHost(hostname));
  electron.ipcMain.handle(
    "panel:git:branch",
    (_e, projectPath, hostname) => getGitBranch(projectPath, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:worktreeAdd",
    (_e, projectPath, worktreePath, branch, hostname) => addWorktree(projectPath, worktreePath, branch, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:worktreeRemove",
    (_e, projectPath, worktreePath, hostname) => removeWorktree$1(projectPath, worktreePath, hostname)
  );
  electron.ipcMain.handle(
    "panel:git:worktreeMerge",
    (_e, projectPath, branch, hostname) => mergeWorktreeBranch(projectPath, branch, hostname)
  );
  electron.ipcMain.handle("panel:files:tree", (_e, projectPath, hostname) => walkFileTree(projectPath, hostname));
  electron.ipcMain.handle("panel:files:dir", (_e, root, dir, hostname) => walkDirChildren(root, dir, hostname));
  electron.ipcMain.handle(
    "panel:files:list",
    (_e, workspaceRoot, underDir, hostname) => listWorkspaceFiles(workspaceRoot, hostname, underDir)
  );
  electron.ipcMain.handle("panel:files:read", (_e, path, hostname) => readFileForPreview(path, hostname));
  electron.ipcMain.handle("panel:files:write", (_e, path, content, hostname) => writeFileContent(path, content, hostname));
  electron.ipcMain.handle("panel:pty:spawn", async (_e, opts) => {
    await ptyManager2.spawn(opts.id, opts);
    return true;
  });
  electron.ipcMain.handle("panel:pty:write", (_e, id, data) => ptyManager2.write(id, data));
  electron.ipcMain.handle("panel:pty:resize", (_e, id, cols, rows) => ptyManager2.resize(id, cols, rows));
  electron.ipcMain.handle("panel:pty:kill", (_e, id) => ptyManager2.kill(id));
  electron.ipcMain.handle("panel:pty:killTmuxSession", (_e, id) => ptyManager2.killTmuxSession(id));
  electron.ipcMain.handle(
    "panel:ports:add",
    (_e, sessionId, sshHost, localPort, remoteHost, remotePort) => portManager2.add(sessionId, sshHost, localPort, remoteHost, remotePort)
  );
  electron.ipcMain.handle("panel:ports:remove", (_e, id) => portManager2.remove(id));
  electron.ipcMain.handle("panel:ports:list", (_e, sessionId) => portManager2.list(sessionId));
  electron.ipcMain.handle("shell:openExternal", (_e, url) => {
    logger.info("opening external URL", { url });
    return electron.shell.openExternal(url);
  });
  return { ptyManager: ptyManager2, portManager: portManager2 };
}
const UBER_EMAIL_SUFFIX = "@uber.com";
const USSO_CANDIDATES = ["/opt/uber/bin/usso", "/opt/homebrew/bin/usso", "/usr/local/bin/usso"];
const SPEND_STATUS_BASE_URL = "https://genai-api.uberinternal.com/v1/spendstatus/harness-pool";
const SPEND_STATUS_TIMEOUT_MS = 15e3;
const SPENT_KEYS = [
  "spent",
  "spend",
  "spendusd",
  "amountspent",
  "currentspend",
  "current",
  "used",
  "usage",
  "usageusd",
  "totalspend",
  "totalspent",
  "total"
];
const CAP_KEYS = [
  "cap",
  "limit",
  "budget",
  "quota",
  "capusd",
  "limitusd",
  "budgetusd",
  "spendcap",
  "spendingcap",
  "hardcap",
  "softcap"
];
const HARNESS_KEYS = ["harness", "harnessid", "name", "id", "pool", "provider", "type"];
const BREAKDOWN_KEYS = [
  "harnesses",
  "harnessspend",
  "harnessbreakdown",
  "breakdown",
  "byharness",
  "usagebyharness",
  "spendbyharness",
  "tools",
  "pools"
];
function getCurrentLdap() {
  const rawUser = process.env.USER || node_os.userInfo().username;
  const trimmed = rawUser.trim();
  const ldap = trimmed.endsWith(UBER_EMAIL_SUFFIX) ? trimmed.slice(0, -UBER_EMAIL_SUFFIX.length) : trimmed;
  if (!/^[A-Za-z0-9._-]+$/.test(ldap)) {
    throw new Error(`Invalid current user LDAP: ${rawUser}`);
  }
  return ldap;
}
function getCurrentUberEmail() {
  return `${getCurrentLdap()}${UBER_EMAIL_SUFFIX}`;
}
function findUsso() {
  for (const candidate of USSO_CANDIDATES) {
    if (node_fs.existsSync(candidate)) return candidate;
  }
  return "usso";
}
function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseMoney(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}
function getValueByKeys(source, keys) {
  const wanted = new Set(keys);
  for (const [key, value] of Object.entries(source)) {
    if (wanted.has(normalizeKey(key))) return value;
  }
  return void 0;
}
function getNumberByKeys(source, keys) {
  return parseMoney(getValueByKeys(source, keys));
}
function getStringByKeys(source, keys) {
  const value = getValueByKeys(source, keys);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function unwrapPayload(raw) {
  let current = raw;
  for (let i = 0; i < 3; i++) {
    if (!isObject(current)) return current;
    const next = current.data ?? current.result ?? current.payload ?? current.spendStatus ?? current.spend_status;
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}
function parseHarnessEntry(nameHint, value) {
  if (typeof value === "number" || typeof value === "string") {
    const spent2 = parseMoney(value);
    if (!nameHint || spent2 == null) return null;
    return { harness: nameHint, spent: spent2 };
  }
  if (!isObject(value)) return null;
  const harness = getStringByKeys(value, HARNESS_KEYS) ?? nameHint;
  const spent = getNumberByKeys(value, SPENT_KEYS);
  if (!harness || spent == null) return null;
  return {
    harness,
    spent,
    cap: getNumberByKeys(value, CAP_KEYS)
  };
}
function parseHarnessBreakdown(payload) {
  const breakdownValue = getValueByKeys(payload, BREAKDOWN_KEYS);
  const entries = [];
  if (Array.isArray(breakdownValue)) {
    for (const item of breakdownValue) {
      const parsed = parseHarnessEntry(null, item);
      if (parsed) entries.push(parsed);
    }
  } else if (isObject(breakdownValue)) {
    for (const [key, value] of Object.entries(breakdownValue)) {
      const parsed = parseHarnessEntry(key, value);
      if (parsed) entries.push(parsed);
    }
  }
  return entries.sort((a, b) => b.spent - a.spent);
}
function parseSpendStatusResponse(raw, email) {
  const payload = unwrapPayload(raw);
  if (!isObject(payload)) {
    throw new Error("spendstatus response was not an object");
  }
  const harnesses = parseHarnessBreakdown(payload);
  const spent = getNumberByKeys(payload, SPENT_KEYS) ?? harnesses.reduce((sum, item) => sum + item.spent, 0);
  const cap = getNumberByKeys(payload, CAP_KEYS);
  return {
    email,
    spent,
    cap,
    currency: "USD",
    updatedAt: Date.now(),
    harnesses
  };
}
let cachedToken;
async function getGenAiToken(forceRefresh = false) {
  if (cachedToken && !forceRefresh) return cachedToken.raw;
  const args = ["-fetch", "genai-api", "-print"];
  if (forceRefresh) args.push("-force");
  const stdout = await new Promise((resolve, reject) => {
    node_child_process.execFile(findUsso(), args, { encoding: "utf-8", timeout: 1e4, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
  const token = stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean).pop();
  if (!token) throw new Error("usso returned an empty genai-api token");
  cachedToken = { raw: token, cachedAt: Date.now() };
  return token;
}
async function fetchSpendStatus(email, forceRefresh = false) {
  const token = await getGenAiToken(forceRefresh);
  return fetch(`${SPEND_STATUS_BASE_URL}/${encodeURIComponent(email)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(SPEND_STATUS_TIMEOUT_MS)
  });
}
async function getSpendStatus() {
  if (process.env.ATELIER_DISABLE_SPEND_STATUS === "1") {
    throw new Error("Spend status is disabled for this process");
  }
  const email = getCurrentUberEmail();
  let response = await fetchSpendStatus(email);
  if (response.status === 401) {
    cachedToken = void 0;
    response = await fetchSpendStatus(email, true);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`spendstatus exited ${response.status}: ${body.slice(0, 200)}`);
  }
  return parseSpendStatusResponse(await response.json(), email);
}
function registerSpendStatusHandlers() {
  electron.ipcMain.handle("spendStatus:get", async () => {
    try {
      return await getSpendStatus();
    } catch (err) {
      logger.warn("spend status unavailable", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  });
}
const isDev = !electron.app.isPackaged;
let mainWindow = null;
let ptyManager = null;
let portManager = null;
let sessionManager = null;
let workspaceService = null;
let appQuitHarnessShutdownDone = false;
function createWindow() {
  const iconPath = resolveAppIconPath();
  const icon = iconPath ? electron.nativeImage.createFromPath(iconPath) : void 0;
  const win = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    title: "Atelier",
    icon: icon && !icon.isEmpty() ? icon : void 0,
    // Match --bg-app so the window is not pure black while the renderer loads.
    backgroundColor: "#1c1a16",
    // Native title bar — desktop-only, no custom chrome.
    titleBarStyle: "default",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.on("ready-to-show", () => {
    win.show();
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logger.error("renderer failed to load", { errorCode, errorDescription, validatedURL });
  });
  const rendererDevUrl = process.env["ELECTRON_RENDERER_URL"];
  if (isDev && rendererDevUrl) {
    logger.info("loading dev renderer", { url: rendererDevUrl });
    void win.loadURL(rendererDevUrl);
  } else {
    const rendererFile = node_path.join(__dirname, "../renderer/index.html");
    if (isDev) {
      logger.warn(
        "ELECTRON_RENDERER_URL unset in dev; loading built renderer from disk — use npm run dev (electron-vite) so Vite serves the UI",
        { path: rendererFile }
      );
    }
    void win.loadFile(rendererFile);
  }
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}
function registerIpcHandlers(sessionManager2) {
  electron.ipcMain.handle("app:getVersion", () => {
    const version = electron.app.getVersion();
    logger.info("ipc app:getVersion invoked", { version });
    return version;
  });
  electron.ipcMain.handle("app:getLogFilePath", () => {
    return getLogFilePath();
  });
  electron.ipcMain.handle("app:getHomedir", () => node_os.homedir());
  electron.ipcMain.on("renderer:log", (_event, payload) => {
    const { level, msg, extra } = payload;
    const fn = level === "error" ? rendererLogger.error : level === "warn" ? rendererLogger.warn : level === "debug" ? rendererLogger.debug : rendererLogger.info;
    fn(msg, extra);
  });
  electron.ipcMain.handle("config:get", () => loadConfig());
  electron.ipcMain.handle("config:set", (_event, partial) => saveConfig(partial));
  electron.ipcMain.handle("config:validateClaudeModel", (_event, model) => sessionManager2.validateClaudeModel(model));
  electron.ipcMain.handle("notification:debugTrigger", (_event, payload) => {
    const { title, body } = payload;
    if (!electron.Notification.isSupported()) {
      logger.warn("desktop notifications not supported on this platform", { title, body });
      return false;
    }
    const notification = new electron.Notification({ title, body });
    notification.show();
    logger.info("notification shown", { title, body });
    return true;
  });
  registerDailyNoteHandlers(() => mainWindow);
  registerWeeklyPlanHandlers();
  registerAppNotesHandlers();
  registerSessionHandlers(sessionManager2, () => mainWindow);
  registerSpendStatusHandlers();
  const panelManagers = registerPanelHandlers(() => mainWindow);
  ptyManager = panelManagers.ptyManager;
  portManager = panelManagers.portManager;
  workspaceService?.setPtyManager(panelManagers.ptyManager);
}
electron.app.whenReady().then(() => {
  migrateLegacyUserDataFromGardeniaProfiles();
  const db2 = openDatabase();
  const sessionStore = new SessionStore(db2);
  const harness = new ClaudeAgentSdkHarness();
  sessionManager = new SessionManager(sessionStore, harness, createStaticHostResolver(), () => mainWindow);
  workspaceService = new WorkspaceService(() => mainWindow, async (sessionId, opts) => {
    const session = sessionStore.getSession(sessionId);
    if (!session) return { items: [] };
    const workspacePath = session.worktreePath ?? session.projectPath;
    return refreshSessionChangesCap(sessionStore, sessionId, workspacePath, session.hostname, opts);
  });
  sessionManager.setWorkspaceService(workspaceService);
  const manager = sessionManager;
  manager.markStartupIdleSessions();
  registerIpcHandlers(manager);
  logger.info("app ready", { version: electron.app.getVersion(), platform: process.platform });
  mainWindow = createWindow();
  applyDockIconWhenReady();
  setTimeout(() => manager.startupReconnect(), 1500);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}).catch((err) => {
  logger.error("app startup failed", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : void 0
  });
  electron.app.quit();
});
electron.app.on("window-all-closed", () => {
  ptyManager?.killAll();
  portManager?.killAll();
  if (process.platform !== "darwin") {
    closeDatabase();
    electron.app.quit();
  }
});
electron.app.on("before-quit", (event) => {
  if (appQuitHarnessShutdownDone) {
    ptyManager?.killAll();
    portManager?.killAll();
    closeDatabase();
    return;
  }
  if (!sessionManager) {
    ptyManager?.killAll();
    portManager?.killAll();
    closeDatabase();
    return;
  }
  event.preventDefault();
  void sessionManager.shutdownAllHarnessSessionsForAppQuit().catch((err) => {
    logger.error("app quit harness shutdown failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }).finally(() => {
    appQuitHarnessShutdownDone = true;
    ptyManager?.killAll();
    portManager?.killAll();
    closeDatabase();
    electron.app.quit();
  });
});
