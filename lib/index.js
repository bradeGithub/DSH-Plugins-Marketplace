import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, cp, readFile, writeFile, stat, readdir, rename } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

// ── 适配层：硬编码不规范项目（见仓库根 adaptor.json）──
// 场景：本体是独立软件却打了 dsh-plugin tag、真实插件藏在未打 tag 的子项目等。
// 列表时移除错误条目并补入真实插件条目，安装时把请求重定向到真实仓库。
let adaptorRedirects = [];
let adaptorFromMap = new Map();
try {
  const raw = requireFromHere("../adaptor.json");
  if (raw && Array.isArray(raw.redirects)) {
    adaptorRedirects = raw.redirects.filter((r) => r && typeof r.from === "string" && typeof r.to === "string");
    for (const r of adaptorRedirects) adaptorFromMap.set(r.from, r);
  }
} catch { /* adaptor.json 缺失/损坏：适配层空转 */ }

/** 查询适配层：fullName 命中重定向时返回真实仓库名，否则返回 null。 */
function adaptorRedirectRepo(fullName) {
  const entry = adaptorFromMap.get(String(fullName ?? ""));
  return entry ? entry.to : null;
}

/** 列表叠加适配层：移除被重定向的错误条目，并把真实插件条目补进列表（元数据来自 adaptor.json，零额外请求）。 */
function applyAdaptorList(repos) {
  if (adaptorRedirects.length === 0 || !Array.isArray(repos)) return repos;
  const out = repos.filter((r) => !adaptorFromMap.has(r.full_name));
  for (const entry of adaptorRedirects) {
    if (entry.meta && typeof entry.meta.full_name === "string" && !out.some((r) => r.full_name === entry.meta.full_name)) {
      out.push(normalizeRepo(entry.meta));
    }
  }
  return out;
}

export const name = "dsh-plugin-marketplace";
/** 声明依赖 webServer 服务：cordis 会先启动该服务再执行 apply()，
 *  避免 ctx.get("webServer") 同步取值为 undefined 导致插件树加载失败 */
export const inject = ["webServer"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const MARKET_ROOT = join(DSH_HOME, "marketplace");
const CACHE_DIR = join(MARKET_ROOT, "cache");
/** 列表索引磁盘缓存：网络源（api/CDN/raw）全挂时兜底用上次成功拉取的完整索引，
 *  避免回退搜索 API 的残缺结果（Search API 单 query 上限 1000 条，skills 兜底仅 266）。 */
const LIST_CACHE_DIR = join(MARKET_ROOT, "list-cache");
const listCacheFile = (kind) => join(LIST_CACHE_DIR, `${kind}.json`);
/** 最近一次列表拉取的数据源（registry / cache / search），随 getList 响应带给客户端。 */
const listSources = { dsh: "registry", skills: "registry" };
/** 克隆缓存复用时间窗（ms）：awaiting-input 回环内直接复用缓存，不重复克隆。 */
const CACHE_REUSE_MS = 15 * 60 * 1000;
const SKILLS_DIR = join(DSH_HOME, "skills");
const PRESETS_DIR = join(DSH_HOME, ".agent-presets");
const PROFILE_WEB_DIR = join(DSH_HOME, "profiles", "web");
const PROFILE_NM = join(PROFILE_WEB_DIR, "node_modules");
const PATCH_FILE = join(PROFILE_WEB_DIR, "cordis.patch.yml");

const SEARCH_QUERIES = {
  dsh: ["topic:dsh-plugin"],
  skills: ["topic:agent-skills", "topic:claude-skills"]
};
const PAGE_SIZE = 100;
/** 兜底搜索 API 最大翻页数。注意：Search API 对单 query 最多返回 1000 条（第 11 页起 422），
 *  带 token 也不能突破——兜底路径天然不全，全量列表以 registry.json（stars 分段构建）为准。 */
const MAX_PAGES = 50;
const CACHE_TTL_MS = 10 * 60 * 1000;
/** m6：外部网络请求超时——CDN / GitHub 挂起时快速失败并尝试下一数据源，避免列表服务长期阻塞。 */
const FETCH_TIMEOUT_MS = 15000;
/** 环境变量检测：覆盖全大写后缀与 camelCase 形态；_PASS 需要前文至少 3 个字符，避免误伤 BY_PASS 等词。
 *  KIMI 审阅 M4：camelCase 分支去掉裸 Key/Pass 后缀——"hotKey"/"passkey" 等英文普通词不再误报
 *  （apiKey/accessToken 等双段驼峰仍可命中）；UPPER_CASE 形态不受影响。 */
const ENV_PATTERN = /\b(?:[A-Z][A-Z0-9_]{1,}(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)|[A-Z][A-Z0-9_]{3,}_PASS|[a-z][A-Za-z0-9]*(?:ApiKey|Token|Secret|Password))\b/g;

/**
 * R2：敏感环境变量判定——第三方 npm 安装/脚本运行时不得携带这些变量
 * （TOKEN / KEY / SECRET / PASSWORD / PASS / CREDENTIAL，大小写不敏感），
 * 防止 GITHUB_TOKEN、各类 API Key 等被插件静默读取上传。
 */
function isSensitiveEnvKey(name) {
  // 注意不能用 \b 词边界：下划线是 \w 单词字符，GITHUB_TOKEN 中 TOKEN 前无边界。
  // 用 (?!...)/(?<!...) 字母数字感知边界：GITHUB_TOKEN / OPENAI_API_KEY / DB_PASSWORD
  // 都命中，而 KEYBOARD_LAYOUT（KEY 后是 B）不误伤。
  return /(?<![A-Za-z0-9])(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIALS?)(?![A-Za-z0-9])/i.test(String(name ?? ""));
}

/**
 * R2：script 类型的最小化 env 白名单——只给第三方安装脚本最基础的系统变量
 * （Windows / Unix 常见项），避免全量 process.env 泄露，也保证脚本能正常启动。
 */
const SCRIPT_ENV_KEYS = [
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "WINDIR", "COMSPEC", "SHELL",
  "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "PWD",
  "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData",
  "COMPUTERNAME", "NODE_ENV", "CI", "GITHUB_ACTIONS"
];

function buildMinimalEnv() {
  const env = {};
  for (const key of SCRIPT_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** R2：npm 安装用全量 env 但剔除敏感变量（npm 自身不需要它们，构建脚本也不该拿到）。 */
function buildFilteredEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isSensitiveEnvKey(key)) env[key] = value;
  }
  return env;
}
const INSTALLED_FILE = join(MARKET_ROOT, "installed.json");

// ── 安装反馈（feedback）：安装成功后登记，下次打开市场时弹窗确认，结果同步 GitHub issue ──
const FEEDBACK_FILE = join(MARKET_ROOT, "feedback.json");
let feedbackQueue = Promise.resolve();
/** pending: [{ repo, name, type, version, installedAt }]——待确认反馈队列（同 repo 只留最新）。 */
let pendingFeedback = [];
/** GitHub Token（可选）：配置后自动创建反馈 issue；未配置则返回预填链接让用户手动提交。 */
let feedbackToken = "";

/** 启动时加载反馈队列与 token（文件不存在时为空）。 */
async function loadFeedback() {
  try {
    const data = JSON.parse(await readFile(FEEDBACK_FILE, "utf8"));
    if (Array.isArray(data.pending)) pendingFeedback = data.pending;
    if (typeof data.token === "string") feedbackToken = data.token;
  } catch { /* 首次运行 */ }
}

// ── 环境变量编辑（issue #18）：已安装插件重新配置 API KEY 等 env ──
// 值存两处：envs.json（本市场本地存储，不随备份导出）+ ~/.dsh/.env（dsh user 层，
// 每次启动注入 process.env——重启 dsh 后生效）。安装时的 env 仍不持久化（保持
// 「备份不含密钥」承诺），只有用户主动点「编辑→保存」才落盘。
const ENVS_FILE = join(MARKET_ROOT, "envs.json");
const DOTENV_FILE = join(DSH_HOME, ".env");
let envsQueue = Promise.resolve();
/** repo -> { KEY: value }（仅用户编辑保存过的键） */
let envStore = {};

async function loadEnvStore() {
  try {
    const data = JSON.parse(await readFile(ENVS_FILE, "utf8"));
    if (data && typeof data === "object") envStore = data;
  } catch { /* 首次运行 */ }
}

async function saveEnvStore() {
  const task = (async () => {
    await mkdir(MARKET_ROOT, { recursive: true });
    await writeFile(ENVS_FILE, JSON.stringify(envStore, null, 2), "utf8");
  })();
  envsQueue = envsQueue.catch(() => {}).then(() => task);
  return envsQueue;
}

/** dsh bootstrap-only 键名（loadLayeredEnv 会拒绝 .env 设置它们，市场也不写）。 */
function isBootstrapOnlyEnvKey(name) {
  return /^DSH_[A-Z0-9_]+$/.test(String(name ?? ""));
}

/** env 键名格式校验：允许 UPPER_SNAKE 与驼峰（与 ENV_PATTERN 一致口径，拒绝 DSH_ 保留前缀）。 */
function isValidEnvKey(name) {
  if (typeof name !== "string" || !name || isBootstrapOnlyEnvKey(name)) return false;
  return /^[A-Z][A-Z0-9_]{1,}$/.test(name) || /^[a-z][A-Za-z0-9]*(?:ApiKey|Token|Secret|Password)$/.test(name);
}

/**
 * 合并写入 ~/.dsh/.env（dsh user 层）：
 * - 逐行解析现有内容（KEY=VALUE / 注释 / 空行），命中的键原位替换，新键追加；
 * - 不写 bootstrap-only 键；值含特殊字符时按 dotenv 惯例用双引号包裹。
 */
async function writeDotEnv(entries) {
  let lines = [];
  try {
    lines = (await readFile(DOTENV_FILE, "utf8")).split(/\r?\n/);
  } catch { /* 首次写入 */ }
  const keyPattern = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const seen = new Set();
  for (const [key, value] of Object.entries(entries)) {
    if (!isValidEnvKey(key)) continue;
    seen.add(key);
    const line = `${key}=${/[\s"'#]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value}`;
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const m = keyPattern.exec(lines[i]);
      if (m && m[1] === key) { lines[i] = line; replaced = true; break; }
    }
    if (!replaced) lines.push(line);
  }
  await mkdir(DSH_HOME, { recursive: true });
  await writeFile(DOTENV_FILE, lines.join("\n") + "\n", "utf8");
}

/**
 * 保存已安装插件的 env 编辑（issue #18）：
 * - 键名白名单：只允许安装记录里扫描过的 envKeys，外加格式合法的自定义键；
 * - 值仅存本市场 envs.json + ~/.dsh/.env，重启 dsh 后由 loadLayeredEnv 注入。
 * 返回 { applied: string[] }（实际写入的键）。
 */
async function applyEnvEdit(repo, values) {
  const record = getInstalledRecord(repo);
  const allowed = new Set(Array.isArray(record?.envKeys) ? record.envKeys : []);
  const current = { ...(envStore[repo] ?? {}) };
  const applied = [];
  for (const [key, rawValue] of Object.entries(values ?? {})) {
    if (typeof key !== "string" || !isValidEnvKey(key)) continue;
    if (allowed.size > 0 && !allowed.has(key)) continue; // 有白名单时严格限制
    const value = String(rawValue ?? "").trim().slice(0, 4000);
    if (value === "") {
      delete current[key];
    } else {
      current[key] = value;
    }
    applied.push(key);
  }
  if (applied.length === 0) return { applied: [] };
  envStore = { ...envStore, [repo]: current };
  await saveEnvStore();
  await writeDotEnv(current);
  return { applied };
}

/** 持久化反馈队列与 token（串行化读-改-写，防并发交错）。 */
async function saveFeedback() {
  const task = (async () => {
    await mkdir(MARKET_ROOT, { recursive: true });
    await writeFile(FEEDBACK_FILE, JSON.stringify({ pending: pendingFeedback, token: feedbackToken }, null, 2), "utf8");
  })();
  feedbackQueue = feedbackQueue.catch(() => {}).then(() => task);
  return feedbackQueue;
}

/** 安装成功后登记待确认反馈（同 repo 只保留最新一条）。 */
async function queueFeedback(entry) {
  pendingFeedback = pendingFeedback.filter((f) => f.repo !== entry.repo);
  pendingFeedback.push(entry);
  await saveFeedback();
}

/**
 * 把反馈同步到 GitHub issue（市场本体仓库）：
 * - 配置了 token → 自动创建 issue（label 不存在时 422 → 去掉 label 重试）；
 * - 未配置 token / 自动创建失败 → 回退预填 issue 新建链接（URL 编码，无需 token），
 *   前端打开让用户手动提交。返回 { issueUrl, manualUrl?, error? }：
 *   issueUrl = 已自动创建的 issue；manualUrl = 手动提交预填链接；error = 自动创建失败原因。
 */
async function submitFeedbackToGitHub(entry, ok, note) {
  const title = `[安装反馈] ${ok ? "✅ 正常" : "❌ 异常"}: ${entry.repo}`;
  const body = [
    `**插件**: ${entry.name ?? entry.repo}`,
    `**仓库**: ${entry.repo}`,
    `**类型**: ${entry.type ?? "unknown"}`,
    `**版本**: ${entry.version ?? "unknown"}`,
    `**安装时间**: ${new Date(entry.installedAt ?? Date.now()).toISOString()}`,
    `**反馈**: ${ok ? "✅ 正常安装并运行" : "❌ 安装/运行异常"}`,
    note ? `**备注**: ${note}` : null,
    "",
    "_(由 DSH 插件市场自动提交)_",
  ].filter(Boolean).join("\n");
  const manualUrl = `https://github.com/${SELF_UPDATE_REPO}/issues/new?${new URLSearchParams({ title, body }).toString()}`;
  if (!feedbackToken) return { manualUrl };
  const doCreate = async (withLabel) => {
    const payload = { title, body };
    if (withLabel) payload.labels = ["install-feedback"];
    return await fetch(`https://api.github.com/repos/${SELF_UPDATE_REPO}/issues`, {
      method: "POST",
      headers: {
        "User-Agent": "dsh-plugin-marketplace",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${feedbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  };
  try {
    let res = await doCreate(true);
    if (res.status === 422) res = await doCreate(false); // label 尚未创建 → 不带 label 重试
    if (!res.ok) return { manualUrl, error: `GitHub API ${res.status}` };
    const issue = await res.json();
    return { issueUrl: issue.html_url };
  } catch (error) {
    return { manualUrl, error: String(error?.message ?? error) };
  }
}

/**
 * DSH 官方插件清单（兜底基线）：运行时优先从 DSH 安装目录的 @deepseek-ai/* 自动枚举，
 * 枚举失败时回退到这份核心名单。官方插件由 DeepSeek Harness 随包发布，
 * 永远不属于「用户安装的市场插件」，扫描比对时必须排除。
 */
const OFFICIAL_FALLBACK = new Set([
  "@deepseek-ai/cordis", "@deepseek-ai/cosmokit", "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh", "@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-settings-file",
  "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-invariants", "@deepseek-ai/dsh-web"
]);

let officialPackagesCache = null;
/** 解析 DSH 官方插件集合（小写包名）：@deepseek-ai 目录枚举 + 兜底基线。 */
async function loadOfficialPackages() {
  if (officialPackagesCache) return officialPackagesCache;
  const set = new Set([...OFFICIAL_FALLBACK].map((n) => n.toLowerCase()));
  try {
    // 通过解析任一官方包定位 @deepseek-ai 目录，枚举其中的全部官方包
    const cordisPath = requireFromHere.resolve("@deepseek-ai/cordis");
    const scopeDir = join(dirname(cordisPath), "..");
    const entries = await readdir(scopeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) set.add(`@deepseek-ai/${entry.name}`.toLowerCase());
    }
  } catch { /* 解析失败则使用兜底基线 */ }
  officialPackagesCache = set;
  return set;
}

/** 判断包名是否为 DSH 官方插件。 */
async function isOfficialPackage(pkgName) {
  return (await loadOfficialPackages()).has(String(pkgName ?? "").toLowerCase());
}
/** 请求体大小上限（防内存耗尽型 DoS）。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 防 CSRF 的自定义头（跨站请求无法携带，强制 preflight）。 */
const CSRF_HEADER = "x-dsh-marketplace";
/** npm 包名白名单（npm 官方命名规则，含 scoped）。 */
const PKG_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** 全局安装互斥：同一时刻只允许一个安装任务（客户端按钮也会同步禁用），从源头杜绝并发安装竞态。 */
let installRunning = null;
/** patch 写队列：不同仓库并发安装时串行化读-改-写。 */
let patchQueue = Promise.resolve();
/** installed.json 写队列：m5——与 patch 同理串行化读-改-写，防止并发安装互相覆盖丢记录。 */
let installedQueue = Promise.resolve();

let listCaches = { dsh: { at: 0, repos: null }, skills: { at: 0, repos: null } };
let listFetchings = { dsh: null, skills: null };
/** full_name -> { type, name, location, installedAt } */
const installedMap = new Map();

/**
 * 安装记录的键统一为 normalizeRepoRef 后的规范化小写（GitHub full_name 保留原始大小写，
 * 例如 "Small-tailqwq/dsh-deep-whale" —— 卸载请求规范化后为小写，直接 get 会 miss，
 * 表现为「卸载完成」但什么都没删）。查询一律经此入口，大小写不敏感。
 */
function installedKey(fullName) {
  return normalizeRepoRef(fullName) ?? String(fullName ?? "");
}
function getInstalledRecord(fullName) {
  return installedMap.get(installedKey(fullName));
}
function hasInstalledRecord(fullName) {
  return installedMap.has(installedKey(fullName));
}

/** 启动时加载已安装清单（文件不存在时为空）。旧文件里的键可能是原始大小写，加载时统一规范化。 */
async function loadInstalled() {
  try {
    const text = await readFile(INSTALLED_FILE, "utf8");
    const data = JSON.parse(text);
    if (data && typeof data === "object") {
      for (const [key, value] of Object.entries(data)) installedMap.set(installedKey(key), value);
    }
  } catch { /* 首次运行：无清单文件 */ }
}

/**
 * 持久化一条安装记录（先写盘成功再入内存，避免持久化失败留下脏的已安装判定）。
 * 通过 installedQueue 串行化读-改-写，防止两个并发安装的「快照-写入」交错互相覆盖。
 */
async function saveInstalled(fullName, record) {
  fullName = installedKey(fullName); // 记录键规范化（小写），与卸载/查询入口一致
  const task = (async () => {
    const data = {};
    for (const [key, value] of installedMap) data[key] = value;
    data[fullName] = record;
    await mkdir(MARKET_ROOT, { recursive: true });
    await writeFile(INSTALLED_FILE, JSON.stringify(data, null, 2), "utf8");
    installedMap.set(fullName, record);
    profileScanCache = null; // 新安装会新增目录，下次扫描重新建立映射
  })();
  installedQueue = installedQueue.catch(() => {}).then(() => task);
  return installedQueue;
}

/**
 * 删除一条安装记录（卸载用）。与 saveInstalled 共用 installedQueue 串行化，
 * 防止与并发安装的「快照-写入」交错。
 */
async function removeInstalled(fullName) {
  fullName = installedKey(fullName);
  const task = (async () => {
    const data = {};
    for (const [key, value] of installedMap) {
      if (key !== fullName) data[key] = value;
    }
    await mkdir(MARKET_ROOT, { recursive: true });
    await writeFile(INSTALLED_FILE, JSON.stringify(data, null, 2), "utf8");
    installedMap.delete(fullName);
    profileScanCache = null; // 卸载会删除目录，下次扫描重新建立映射
  })();
  installedQueue = installedQueue.catch(() => {}).then(() => task);
  return installedQueue;
}

const pathExists = (p) => stat(p).then(() => true).catch(() => false);

/** 读取目录下 package.json 的 version 字段；文件缺失或解析失败返回 null。 */
async function readPackageVersion(dir) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 读取目录下 package.json 的 name 字段；文件缺失或解析失败返回 null。 */
async function readPackageName(dir) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    return typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : null;
  } catch {
    return null;
  }
}

/** 读取目录下 package.json 完整对象；文件缺失或解析失败返回 null。 */
async function readPackageJsonObject(dir) {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * DSH 插件资格判定（纯函数）：package.json 声明了 DSH 插件能力才算插件——
 * 1. 存在 `dsh` 字段（DSH 插件声明，client/server 形态）
 * 2. 依赖/peer 依赖 DSH 核心包（@deepseek-ai/cordis、@deepseek-ai/dsh 或 @deepseek-ai/dsh-*）
 * 返回 true（疑似插件）/ false（非插件，如聚合页、桌面应用、普通 npm 项目）/ null（无法判断）。
 * dsh-plugin topic 里混有大量非插件仓库（awesome-*、桌面端打包等），直接装进 web profile 只会得到坏包。
 */
export function looksLikeDshPlugin(pkg) {
  if (!pkg || typeof pkg !== "object") return null;
  if (pkg.dsh && typeof pkg.dsh === "object") return true;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  const names = Object.keys(deps);
  if (names.includes("@deepseek-ai/cordis") || names.includes("@deepseek-ai/dsh")) return true;
  return names.some((n) => n.startsWith("@deepseek-ai/dsh-")) ? true : false;
}

/**
 * 本插件自己的 GitHub 仓库（来自 package.json 的 repository 字段，小写）。
 * 仓库名与包名不一致时（如 DSH-Plugins-Marketplace → dsh-plugin-marketplace），
 * 目录启发式无法把本体识别为已安装，这里直接按 repository 字段命中。
 */
let ownRepo = null;
async function loadOwnRepo() {
  if (ownRepo !== null) return ownRepo;
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    ownRepo = typeof url === "string"
      ? url.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase() || null
      : null;
  } catch {
    ownRepo = null;
  }
  return ownRepo;
}

/**
 * 归一化 GitHub 仓库标识（repository 字段或 full_name）为小写 owner/repo。
 * 兼容 https://github.com/owner/repo(.git)、git+https://…、git@github.com:… 等写法。
 */
function normalizeRepoRef(url) {
  if (typeof url !== "string") return null;
  let s = url.trim()
    .replace(/^git\+/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .split("#")[0];
  return s.toLowerCase() || null;
}

/**
 * 从 profile 映射中按一组键查找匹配条目：
 * - 官方插件（DSH 自带包）永远不算「用户安装的市场插件」；
 * - 带 repository 的条目必须与目标仓库一致，否则视为「同名撞仓库」，返回 null。
 */
async function matchProfileEntry(profile, repo, keys) {
  const target = normalizeRepoRef(repo.full_name);
  const official = await loadOfficialPackages();
  for (const key of keys) {
    const hit = profile.get(String(key).toLowerCase());
    if (!hit) continue;
    if (hit.name && official.has(String(hit.name).toLowerCase())) continue; // 官方包，跳过
    if (hit.repository && target && hit.repository !== target) continue;
    return hit;
  }
  // 反向查找：已安装条目中 repository 与目标仓库一致即命中——覆盖 scoped 包
  // 与「包名/仓库名差异大」的预装插件（先装插件后装市场也能正确标为已安装）。
  if (target) {
    for (const hit of profile.values()) {
      if (!hit.repository || hit.repository !== target) continue;
      if (hit.name && official.has(String(hit.name).toLowerCase())) continue;
      return hit;
    }
  }
  return null;
}

/**
 * 读取目录的 package.json 摘要 { name, version, repository }；失败返回 null。
 */
async function readPackageSummary(dir) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    return {
      name: typeof pkg.name === "string" ? pkg.name : null,
      version: typeof pkg.version === "string" ? pkg.version : null,
      repository: normalizeRepoRef(repoUrl)
    };
  } catch { /* 缺失或损坏 */ }
  return null;
}

/**
 * 扫描已安装目录（web profile 的 node_modules / skills / 预设），
 * 建立「目录名或包名(小写) -> { name, version, repository }」映射，用于识别
 * 仓库名与包名不一致的安装（如仓库 DSH-Plugins-Marketplace，包名 dsh-plugin-marketplace）。
 * scoped 包（@scope/name）会递归一层扫描。
 */
let profileScanCache = null;
async function scanProfilePackages() {
  if (profileScanCache) return profileScanCache;
  const map = new Map();
  const add = (key, name, version, repository) => {
    if (!key) return;
    const existing = map.get(key);
    if (!existing || (existing.version == null && version != null)) {
      map.set(key, { name: name ?? null, version: version ?? null, repository: repository ?? null });
    }
  };
  const scanDir = async (dir, readPkg, keyPrefix = "") => {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const key = keyPrefix + entry.name.toLowerCase();
      add(key, null, null);
      if (readPkg) {
        const summary = await readPackageSummary(join(dir, entry.name));
        if (summary) {
          add(String(summary.name ?? "").toLowerCase(), summary.name, summary.version, summary.repository);
        }
        // scoped 包：作用域目录自身没有 package.json，递归一层扫描 @scope/name
        if (entry.name.startsWith("@")) {
          await scanDir(join(dir, entry.name), readPkg, key + "/");
        }
      }
    }
  };
  await scanDir(PROFILE_NM, true);
  await scanDir(SKILLS_DIR, false);
  await scanDir(PRESETS_DIR, false);
  profileScanCache = map;
  return map;
}

/**
 * 检测仓库是否已安装，四重判定：
 * 1. 安装清单（installed.json，本插件安装过的）
 * 2. 目录启发式：skills / 预设 / 市场缓存克隆
 * 3. 包名映射：扫描已安装目录的 package.json 名称，与仓库名/缓存包名比对（repository 校验防撞名）
 * 4. 本体识别：仓库命中本插件自身 repository 字段
 */
async function detectInstalled(repo) {
  if (hasInstalledRecord(repo.full_name)) return true;
  const slug = slugify(repo.name);
  const owner = slugify(String(repo.full_name).split("/")[0] ?? "");
  const cacheDir = join(CACHE_DIR, `${owner}__${slug}`);
  const candidates = [
    join(SKILLS_DIR, slug),
    join(PRESETS_DIR, slug)
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return true;
  }
  const self = await loadOwnRepo();
  if (self && String(repo.full_name).toLowerCase() === self) return true;
  const profile = await scanProfilePackages();
  // 包名映射（repository 校验防撞名 + 官方包排除）：仓库名 / 原始仓库名 / 索引包名（pkg_name）
  const keys = [slug, repo.name];
  if (repo.pkg_name) keys.push(repo.pkg_name);
  if (await matchProfileEntry(profile, repo, keys)) return true;
  // 缓存克隆存在 ≠ 安装成功（失败的安装也会留下缓存）。
  // 仅脚本类插件以缓存目录作为安装成果（见 README 已知限制），其余类型按上面的真实安装目录判定。
  if (await pathExists(cacheDir)) {
    const cacheType = await detectType(cacheDir);
    if (cacheType === "script") return true;
  }
  const pkgName = await readPackageName(cacheDir);
  if (pkgName && await matchProfileEntry(profile, repo, [pkgName])) return true;
  return false;
}

/**
 * skills 栏目专用已安装判定（两重即可，cordis 的包名映射/repository 校验不适用）：
 * 1. 安装清单：installed.json 中 repo 匹配（本市场安装过，任何类型）
 * 2. 目录启发式：~/.dsh/skills/<slug> 目录存在（含先装后装市场的情况）
 */
async function detectSkillInstalled(repo) {
  if (hasInstalledRecord(repo.full_name)) return true;
  return await pathExists(join(SKILLS_DIR, slugify(repo.name)));
}

await loadInstalled();

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}

/** 服务端文案字典（zh / en）。 */
const MESSAGES = {
  zh: {
    "step1": "[1/5] 克隆 https://github.com/{repo} ...",
    "cloneDone": "克隆完成。",
    "submoduleDone": "检测到 git 子模块，已递归拉取。",
    "submoduleUnsafe": "子模块地址不安全（仅允许 https 或相对路径）: {urls}",
    "cliHint": "README 提供官方 CLI 安装指令：{cmd}（与市场安装等效，二选一即可）",
    "externalCliHint": "README 提供官方接入方式（由 {cli} 自己的 CLI 执行，需先装官方 dsh CLI）：{cmd}（市场无法代执行，请按 README 操作）",
    "cliExec": "检测到官方 CLI 安装指令，直接使用 README 提供的安装方式：{cmd}",
    "cliUpdateTo": "检测到已有安装，使用显式版本升级：{target}（npm 最新 {version}）",
    "cliDone": "官方 CLI 安装完成 ✔",
    "feedbackQueued": "安装完成 ✔ 下次打开插件市场时将确认该插件是否正常（可反馈给作者）。",
    "feedbackNotFound": "该反馈不存在或已提交。",
    "notInstalled": "该插件尚未安装（或安装记录缺失）。",
    "tooManyEnvKeys": "单次最多保存 16 个环境变量。",
    "badEnvKey": "非法的环境变量名：{key}（需为大写蛇形如 OPENAI_API_KEY，且不能是 DSH_ 保留前缀）。",
    "noEnvApplied": "没有可保存的环境变量（键不匹配安装记录或值为空）。",
    "cliFailFallback": "官方 CLI 安装失败（{err}），回退市场常规安装流程",
    "entryMissing": "⚠ {name} 已安装但未检测到可加载入口（main 文件缺失），可能未生效——请查看仓库构建说明",
    "logsExported": "已导出 {n} 条脱敏日志",
    "cacheReuse": "复用本地缓存（同一安装会话，无需重新克隆）。",
    "step2": "[2/5] 识别安装类型: {type}",
    "type.skill": "skill",
    "type.agent-preset": "agent 预设",
    "type.script": "安装脚本",
    "type.cordis-plugin": "cordis 插件",
    "type.instructions": "手动安装（README 说明）",
    "step3": "[3/5] 扫描所需环境变量: {list}",
    "none": "无",
    "awaiting": "需要用户提供材料，安装已暂停。",
    "qEnvHeader": "{repo} 需要 {v}",
    "qEnv": "该插件需要环境变量 {v}（通常是 API Key 等密钥）。请提供其值以继续安装（空值可跳过）：",
    "scriptDetected": "检测到安装脚本，需要用户确认。",
    "qScriptHeader": "确认执行第三方脚本",
    "qScript": "仓库 {repo} 包含安装脚本（install.sh / install.ps1），安装将执行该脚本。下载并运行第三方代码存在安全风险，是否继续？",
    "optContinue": "继续安装",
    "optContinueDesc": "信任该仓库并执行其安装脚本",
    "optCancel": "取消安装",
    "optCancelDesc": "不执行任何脚本",
    "scriptCancelled": "用户取消安装脚本执行。",
    "step4": "[4/5] 开始安装 ...",
    "step5": "[5/5] 完成。",
    "fail": "安装失败: {err}",
    "skillInstalled": "Skill「{name}」已安装到 {dest}，技能注册器将自动热加载。",
    "presetInstalled": "agent 预设「{name}」已安装到 {dest}。",
    "runPs1": "正在执行 install.ps1 ...",
    "runSh": "正在执行 install.sh (bash) ...",
    "scriptDone": "安装脚本执行完成。仓库保留在 {dir}",
    "noScript": "仓库被识别为脚本型（install.ps1 / install.sh），但当前平台没有可执行的脚本文件",
    "deps": "正在安装依赖 (npm install --omit=dev)，共 {n} 项 ...",
    "depsDone": "依赖安装完成。",
    "npmFallbackPeers": "常规安装遇 peer 冲突，已改用 --legacy-peer-deps 重试（peer 依赖由 DSH 宿主提供）。",
    "npmFallbackScripts": "依赖安装脚本不可用，已改用 --ignore-scripts 重试（使用仓库已提交的构建产物）。",
    "npmScriptsDetected": "检测到第三方 npm 生命周期脚本（{scripts}），需要确认。",
    "qNpmScriptsHeader": "确认执行第三方 npm 脚本",
    "qNpmScripts": "仓库 {repo} 的 package.json 包含生命周期脚本：{scripts}。npm 安装依赖时会执行这些脚本，即运行第三方代码。是否允许执行？选择「不允许」将取消安装并清理所有痕迹。",
    "optAllow": "允许执行",
    "optAllowDesc": "信任该仓库，安装时执行其 npm 生命周期脚本",
    "optDeny": "不允许（取消安装）",
    "optDenyDesc": "不执行任何脚本，取消安装并清理痕迹",
    "npmScriptsDenied": "用户不允许执行第三方 npm 脚本，安装已取消，已清理全部痕迹。",
    "npmScriptsAllowed": "已允许执行第三方 npm 生命周期脚本。",
    "buildDetected": "该插件只提交了源码（构建产物缺失），需要先构建再安装。",
    "qBuildHeader": "确认执行构建",
    "qBuild": "仓库 {repo} 的 package.json 声明了 build 脚本，但加载入口（main / client bundle）在仓库中缺失——不构建直接安装会导致 DSH 无法启动。构建会安装依赖并执行第三方构建脚本，是否允许？",
    "optAllowBuild": "允许构建",
    "optAllowBuildDesc": "信任该仓库，安装其构建依赖并执行构建脚本",
    "optDenyBuild": "不允许（取消安装）",
    "optDenyBuildDesc": "不执行任何构建，取消安装并清理痕迹",
    "buildDenied": "用户不允许执行构建脚本，安装已取消，已清理全部痕迹。",
    "buildInstall": "正在安装构建依赖 ({bin}) ...",
    "buildRun": "正在执行构建 ({bin} run build) ...",
    "buildDone": "构建完成。",
    "npmLocalDeps": "检测到 {n} 个 pnpm 本地链接依赖（{names}），npm 无法安装，已从安装清单中移除（运行时由 DSH 宿主提供）。",
    "copied": "插件包已复制到 {dest}",
    "patchExists": "profile 补丁中已存在该插件条目，跳过注册。",
    "patchDone": "已注册到 web profile 补丁 (id: {id})。加载器热重载后生效；若未生效请重启 dsh web 并刷新页面。",
    "instructions": "该仓库不含可自动安装的 SKILL.md / agent 预设 / 安装脚本 / 插件清单，请按 README 手动安装：",
    "noReadme": "（无 README）",
    "badRepo": "repo 参数格式应为 owner/name",
    "methodNotAllowed": "method not allowed",
    "listFail": "拉取失败: {err}",
    "forbidden": "请求被拒绝：来源不可信（缺少 X-DSH-Marketplace 头，或 Host 不在白名单内）",
    "bodyTooLarge": "请求体过大（上限 1 MB）",
    "badRequest": "请求格式错误",
    "installBusy": "另一个安装正在进行中，请等待其完成后再试。",
    "notInstalled": "该插件没有安装记录，无法检测更新。",
    "checkUpdateNotNpm": "该插件由 GitHub 仓库安装，版本自动检测，无需手动检查。",
    "checkUpdateNoPkg": "未找到已安装的包目录（无法读取版本）。",
    "checkUpdateNpmFail": "npm 版本查询失败（网络或镜像不可用），请稍后重试。",
    "selfUpdateBusy": "另一个安装或市场更新正在进行中，请等待其完成后再试。",
    "selfUpdateNone": "当前已是最新版本（v{v}），无需更新。",
    "selfUpdateFail": "市场更新失败：{err}",
    "selfUpdateVersionFail": "版本校验失败：拉取到的版本（v{got}）不高于当前版本（v{cur}），已中止更新。",
    "selfUpdateCopied": "市场本体已更新到 v{new}，重启 DSH 后生效。",
    "uninstalling": "正在卸载 {repo} ...",
    "uninstalled": "卸载完成 ✔",
    "uninstallNone": "未找到安装记录，无需卸载。",
    "uninstallNoTargets": "无法定位安装的包目录（旧版记录），已仅移除安装记录。",
    "uninstallScriptNote": "脚本型插件的自身效果无法自动回滚，已移除安装记录与克隆缓存。",
    "adaptorRedirected": "适配层重定向：实际安装的是 {to}（{from} 经硬编码重定向）",
    "backupDone": "已导出 {n} 条安装记录",
    "backupEmpty": "没有可备份的安装记录",
    "restoreDiff": "备份中有 {n} 个未安装、{m} 个已安装（跳过）",
    "restoreDiffNone": "备份中的插件当前全部已安装",
    "badBackup": "备份文件格式不正确（缺少 repos 数组或 repo 字段）",
    "webdavBadUrl": "WebDAV 地址必须是 http(s):// 开头",
    "webdavPushOk": "已备份到 WebDAV",
    "webdavFail": "WebDAV 操作失败: {err}",
    "uninstallFail": "卸载失败: {err}",
    "nonPluginDetected": "检测到该仓库未声明 DSH 插件能力，需要确认。",
    "qNonPluginHeader": "该项目可能不是 DSH 插件",
    "qNonPlugin": "仓库 {repo} 的 package.json 未声明 DSH 插件能力（无 dsh 字段，也未依赖 DSH 核心包）。它可能是聚合页 / 桌面应用 / 普通 npm 项目，一键安装到 DSH 很可能无效。建议前往仓库自行安装：{url}",
    "optNonPluginContinue": "仍然尝试安装",
    "optNonPluginContinueDesc": "信任该仓库，强制按插件安装",
    "optNonPluginCancel": "取消，去仓库自行安装",
    "optNonPluginCancelDesc": "不安装，打开仓库自行处理",
    "nonPluginCancelled": "已取消安装（非插件仓库），缓存已清理。",
    "manualDetected": "该仓库不包含可自动安装的插件内容，需要确认。",
    "qManualHeader": "该项目不包含可自动安装的内容",
    "qManual": "仓库 {repo} 中未找到 SKILL.md / agent 预设 / 安装脚本 / DSH 插件清单，无法一键安装。\n\nREADME 摘要：\n{readme}\n\n仓库地址：{url}",
    "optManualCancel": "知道了，返回列表",
    "optManualCancelDesc": "不执行任何操作",
    "manualCancelled": "已取消（无可自动安装的内容），缓存已清理。"
  },
  en: {
    "step1": "[1/5] Cloning https://github.com/{repo} ...",
    "cloneDone": "Clone complete.",
    "submoduleDone": "Git submodules detected — initialized recursively.",
    "submoduleUnsafe": "Unsafe submodule URLs (only https or relative paths allowed): {urls}",
    "cliHint": "README offers the official CLI install command: {cmd} (equivalent to marketplace install — pick one)",
    "externalCliHint": "README documents the official integration (run via {cli}'s own CLI; install the official dsh CLI first): {cmd} (the marketplace cannot run it — follow the README)",
    "cliExec": "Official CLI install command found — using the README's install method: {cmd}",
    "cliUpdateTo": "Existing install detected — upgrading with an explicit version: {target} (npm latest {version})",
    "cliDone": "Official CLI install complete ✔",
    "feedbackQueued": "Install complete ✔ Next time you open the marketplace you'll be asked whether this plugin works (feedback goes to the author).",
    "feedbackNotFound": "That feedback does not exist or was already submitted.",
    "notInstalled": "This plugin is not installed (or its install record is missing).",
    "tooManyEnvKeys": "At most 16 environment variables can be saved at once.",
    "badEnvKey": "Invalid environment variable name: {key} (use UPPER_SNAKE like OPENAI_API_KEY; DSH_ prefix is reserved).",
    "noEnvApplied": "Nothing to save (keys don't match the install record or values are empty).",
    "cliFailFallback": "Official CLI install failed ({err}) — falling back to the marketplace flow",
    "entryMissing": "⚠ {name} installed but no loadable entry found (main file missing) — it may not take effect; check the repo's build instructions",
    "logsExported": "Exported {n} sanitized log lines",
    "cacheReuse": "Reusing the local cache (same install session, no re-clone).",
    "step2": "[2/5] Install type: {type}",
    "type.skill": "skill",
    "type.agent-preset": "agent preset",
    "type.script": "install script",
    "type.cordis-plugin": "cordis plugin",
    "type.instructions": "manual install (README instructions)",
    "step3": "[3/5] Required env vars: {list}",
    "none": "none",
    "awaiting": "Input required — install paused.",
    "qEnvHeader": "{repo} requires {v}",
    "qEnv": "This plugin needs env var {v} (usually an API key or secret). Provide its value to continue (leave empty to skip):",
    "scriptDetected": "Install script detected — confirmation required.",
    "qScriptHeader": "Confirm running a third-party script",
    "qScript": "Repo {repo} contains an install script (install.sh / install.ps1) that will be executed. Downloading and running third-party code is risky. Continue?",
    "optContinue": "Continue install",
    "optContinueDesc": "Trust this repo and run its install script",
    "optCancel": "Cancel install",
    "optCancelDesc": "Do not run any script",
    "scriptCancelled": "Script execution cancelled by user.",
    "step4": "[4/5] Installing ...",
    "step5": "[5/5] Done.",
    "fail": "Install failed: {err}",
    "skillInstalled": "Skill \"{name}\" installed to {dest}; the skill registry will hot-reload it.",
    "presetInstalled": "Agent preset \"{name}\" installed to {dest}.",
    "runPs1": "Running install.ps1 ...",
    "runSh": "Running install.sh (bash) ...",
    "scriptDone": "Install script finished. Repo kept at {dir}",
    "noScript": "Repo is script-type (install.ps1 / install.sh) but no executable script exists for this platform",
    "deps": "Installing dependencies (npm install --omit=dev), {n} packages ...",
    "depsDone": "Dependencies installed.",
    "npmFallbackPeers": "Peer conflict on plain install — retrying with --legacy-peer-deps (peers are provided by the DSH host).",
    "npmFallbackScripts": "Install scripts unavailable — retrying with --ignore-scripts (using the build artifacts committed in the repo).",
    "npmScriptsDetected": "Third-party npm lifecycle scripts detected ({scripts}) — confirmation required.",
    "qNpmScriptsHeader": "Confirm running third-party npm scripts",
    "qNpmScripts": "Repo {repo} has lifecycle scripts in package.json: {scripts}. npm will run these scripts while installing dependencies — that executes third-party code. Allow it? Choosing «No» cancels the install and cleans up all traces.",
    "optAllow": "Allow",
    "optAllowDesc": "Trust this repo and run its npm lifecycle scripts during install",
    "optDeny": "Deny (cancel install)",
    "optDenyDesc": "Do not run any scripts; cancel the install and clean up",
    "npmScriptsDenied": "User denied third-party npm scripts — install cancelled, all traces cleaned up.",
    "npmScriptsAllowed": "Third-party npm lifecycle scripts allowed.",
    "buildDetected": "This plugin ships source only (build output missing) and must be built before install.",
    "qBuildHeader": "Confirm running the build",
    "qBuild": "Repo {repo} declares a build script in package.json, but its load entries (main / client bundle) are missing from the repo — installing without building will make DSH fail to start. Building installs dependencies and runs third-party build scripts. Allow it?",
    "optAllowBuild": "Allow build",
    "optAllowBuildDesc": "Trust this repo, install its build dependencies and run the build script",
    "optDenyBuild": "Deny (cancel install)",
    "optDenyBuildDesc": "Run no build; cancel the install and clean up",
    "buildDenied": "User denied the build — install cancelled, all traces cleaned up.",
    "buildInstall": "Installing build dependencies ({bin}) ...",
    "buildRun": "Running build ({bin} run build) ...",
    "buildDone": "Build complete.",
    "npmLocalDeps": "Detected {n} pnpm local-link dependencies ({names}) that npm cannot install — removed from the install manifest (runtime resolution is provided by the DSH host).",
    "copied": "Plugin package copied to {dest}",
    "patchExists": "Profile patch already has this plugin entry — skipping registration.",
    "patchDone": "Registered in the web profile patch (id: {id}). Takes effect after the loader hot-reloads; otherwise restart dsh web and refresh the page.",
    "instructions": "This repo has no auto-installable SKILL.md / agent preset / install script / plugin manifest. Install manually per its README:",
    "noReadme": "(no README)",
    "badRepo": "repo must be in owner/name format",
    "methodNotAllowed": "method not allowed",
    "listFail": "Fetch failed: {err}",
    "forbidden": "Request rejected: untrusted origin (missing X-DSH-Marketplace header, or Host not in allowlist)",
    "bodyTooLarge": "Request body too large (1 MB limit)",
    "badRequest": "Bad request",
    "installBusy": "Another install is in progress — please wait for it to finish.",
    "notInstalled": "No install record for this plugin — cannot check for updates.",
    "checkUpdateNotNpm": "Installed from a GitHub repo; version detection is automatic.",
    "checkUpdateNoPkg": "Installed package directory not found (cannot read version).",
    "checkUpdateNpmFail": "Failed to query npm for the latest version; try again later.",
    "selfUpdateBusy": "Another install or marketplace update is in progress — please wait.",
    "selfUpdateNone": "Already up to date (v{v}).",
    "selfUpdateFail": "Marketplace update failed: {err}",
    "selfUpdateVersionFail": "Version check failed: fetched version (v{got}) is not newer than the installed one (v{cur}); update aborted.",
    "selfUpdateCopied": "Marketplace updated to v{new} — restart DSH to apply.",
    "uninstalling": "Uninstalling {repo}...",
    "uninstalled": "Uninstall complete ✔",
    "uninstallNone": "No install record found — nothing to uninstall.",
    "uninstallNoTargets": "Could not locate the installed package directories (legacy record) — install record removed only.",
    "uninstallScriptNote": "Script-type plugins cannot be auto-reverted; install record and clone cache removed.",
    "adaptorRedirected": "Adaptor redirect: actually installing {to} ({from} redirected)",
    "backupDone": "Exported {n} install records",
    "backupEmpty": "Nothing to back up — no install records",
    "restoreDiff": "{n} missing (to install) and {m} already installed (skipped) in the backup",
    "restoreDiffNone": "All plugins in the backup are already installed",
    "badBackup": "Invalid backup file (repos array or repo field missing)",
    "webdavBadUrl": "WebDAV URL must start with http(s)://",
    "webdavPushOk": "Backup pushed to WebDAV",
    "webdavFail": "WebDAV operation failed: {err}",
    "uninstallFail": "Uninstall failed: {err}",
    "nonPluginDetected": "This repo does not declare DSH plugin capability — confirmation required.",
    "qNonPluginHeader": "This repo may not be a DSH plugin",
    "qNonPlugin": "Repo {repo} has a package.json that does not declare DSH plugin capability (no `dsh` field, no DSH core dependency). It may be a curated list / desktop app / plain npm project, and installing it into DSH will likely not work. Consider installing it manually: {url}",
    "optNonPluginContinue": "Try anyway",
    "optNonPluginContinueDesc": "Trust this repo and force-install it as a plugin",
    "optNonPluginCancel": "Cancel — install manually",
    "optNonPluginCancelDesc": "Do not install; handle it at the repo",
    "nonPluginCancelled": "Install cancelled (non-plugin repo). Cache cleaned up.",
    "manualDetected": "No auto-installable plugin content found — confirmation required.",
    "qManualHeader": "No auto-installable content in this repo",
    "qManual": "Repo {repo} contains no SKILL.md / agent preset / install script / DSH plugin manifest, so it cannot be installed with one click.\n\nREADME excerpt:\n{readme}\n\nRepo URL: {url}",
    "optManualCancel": "Got it — back to list",
    "optManualCancelDesc": "Do nothing",
    "manualCancelled": "Cancelled (no auto-installable content). Cache cleaned up."
  }
};

/** 按语言取文案并做 {var} 插值；未知键回退中文再回退键名。 */
function t(lang, key, vars) {
  const dict = lang === "en" ? MESSAGES.en : MESSAGES.zh;
  let s = dict[key] ?? MESSAGES.zh[key] ?? key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
  }
  return s;
}

/** 解析请求语言：优先 body.lang，其次 Accept-Language 头；仅区分 zh / en，未知默认 zh。 */
function langOf(req, body) {
  const raw = (body && typeof body.lang === "string" && body.lang)
    || (req?.headers?.["accept-language"]) || "";
  const primary = String(raw).split(",")[0].trim().toLowerCase().split("-")[0];
  return primary === "en" ? "en" : "zh";
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req) {
  // n4：收集 Buffer 后一次性解码——逐 chunk 字符串拼接会按分片独立解码，
  // 多字节 UTF-8 跨 TCP 分片时产生替换字符，导致合法 JSON 解析失败。
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch {
    // KIMI 审阅 M3：非法 JSON 静默吞成空对象会让上层报错指向 badRepo（误导排障）→ 明确抛 400
    const error = new Error("invalid JSON body");
    error.status = 400;
    throw error;
  }
}

/**
 * R1：Host 是否属于可信白名单——
 * - 本机回环：localhost / 127.0.0.1 / [::1]（DNS rebinding 攻击者域名永远不在其中）；
 * - 局域网私有网段：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16（保留 README 承诺的局域网访问体验）；
 * - 环境变量 DSH_MARKETPLACE_ALLOWED_HOSTS（逗号分隔）可显式追加信任的主机名 / IP。
 */
function isTrustedHost(rawHost) {
  const host = String(rawHost ?? "").trim().toLowerCase();
  if (!host) return false;
  // 去掉端口部分（IPv6 形如 [::1]:3080，直接取括号内整体）
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1") return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  const extra = (process.env.DSH_MARKETPLACE_ALLOWED_HOSTS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return extra.includes(hostname);
}

/**
 * 防 CSRF / DNS rebinding：
 * - 要求自定义头 X-DSH-Marketplace: 1（跨站简单请求无法携带，会强制 preflight 被 CORS 拦下）；
 * - Host 必须在可信白名单内（本机回环 / 局域网 / 显式配置），攻击者域名（含 DNS rebinding
 *   解析到 127.0.0.1 的域名）一律拒绝——不再依赖「Origin===Host」这种可被 rebinding 绕过的校验；
 * - 若带 Origin 头，其 host 必须与请求自身的 Host 完全一致（含端口）。
 */
function isTrustedRequest(req) {
  if (req.headers[CSRF_HEADER] !== "1") return false;
  if (!isTrustedHost(req.headers["host"])) return false;
  const origin = req.headers["origin"];
  if (!origin) return true; // 无 Origin 的非浏览器调用方（本地脚本/curl）放行
  try {
    return new URL(origin).host === String(req.headers["host"] ?? "");
  } catch {
    return false;
  }
}

/** patch 中是否已有该包名的注册条目（行级精确匹配，避免前缀子串误判）。
 *  scoped 包名（@scope/name）以 @ 开头，YAML plain scalar 不允许，写入时加了引号，
 *  因此同时接受带单/双引号与不带引号的 name 行（兼容历史无引号条目）。 */
function hasPatchEntry(patchText, pkgName) {
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^\\s*name:\\s*(?:\"|')?" + escaped + "(?:\"|')?\\s*$", "m");
  return pattern.test(patchText);
}

/**
 * 原子追加注册条目到 cordis.patch.yml：读-改-写串行化 + 临时文件 rename。
 * 返回 true 表示本次写入了新条目，false 表示已存在。
 * scoped 包名（@scope/name）以 @ 开头（YAML 保留字符），plain scalar 非法，
 * 必须加引号写入，否则 loader 解析 cordis.patch.yml 直接失败、DSH 无法启动。
 */
async function appendPatchEntry(entryId, pkgName) {
  let taskError = null;
  const task = (async () => {
    const patch = await readFile(PATCH_FILE, "utf8").catch(() => "");
    if (hasPatchEntry(patch, pkgName)) return false;
    const trimmed = patch.trim();
    const quoted = /^[@!&*#?|>'"%`]/.test(pkgName) ? `"${pkgName}"` : pkgName;
    const row = `    - id: ${entryId}\n      name: ${quoted}\n`;
    const next = trimmed === "" || trimmed === "[]"
      ? `# dsh-plugin-marketplace 自动注册的插件条目\n- insert:\n${row}`
      : patch.endsWith("\n") ? patch + "- insert:\n" + row : patch + "\n- insert:\n" + row;
    const tmp = PATCH_FILE + ".tmp";
    await writeFile(tmp, next, "utf8");
    await rename(tmp, PATCH_FILE);
    return true;
  })();
  // m4：catch 仅用于防止队列断链；真实错误记录后重新抛出，
  // 让安装流程如实报错——不再静默失败并误显示「已存在条目，跳过注册」。
  patchQueue = task.catch((error) => { taskError = error; });
  const result = await patchQueue;
  if (taskError) throw taskError;
  return result;
}

/**
 * 从 cordis.patch.yml 移除指定包的注册条目（卸载用）：删除该包所在的整个
 * `- insert:` 块（含 id/name 子行）。与 appendPatchEntry 共用 patchQueue 串行化。
 * 返回 true 表示实际移除了条目，false 表示本来就没有。
 * L1（KIMI 审阅）：行级块解析只保证处理本插件写入的格式（`- insert:` + 缩进 id/name）；
 * 带行内注释/多行值的手写条目可能整块保留，不做「部分删除」的承诺。
 */
async function removePatchEntry(pkgName) {
  let taskError = null;
  const task = (async () => {
    const patch = await readFile(PATCH_FILE, "utf8").catch(() => "");
    if (!hasPatchEntry(patch, pkgName)) return false;
    const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp("^\\s*name:\\s*(?:\"|')?" + escaped + "(?:\"|')?\\s*$", "m");
    // 逐行扫描：顶层 `- insert:` 开启一个块，块内为缩进的 id/name 子行；
    // 命中目标 name 的块整体丢弃，其余块与非块内容保留。
    const lines = patch.split("\n");
    const out = [];
    let inBlock = false;
    let blockLines = [];
    let blockHasTarget = false;
    const flushBlock = () => {
      if (inBlock && !blockHasTarget) out.push(...blockLines);
      inBlock = false;
      blockLines = [];
      blockHasTarget = false;
    };
    for (const line of lines) {
      if (/^- insert:\s*$/.test(line)) {
        flushBlock();
        inBlock = true;
        blockLines = [line];
      } else if (inBlock) {
        if (/^[^ \t]/.test(line) && line.trim() !== "") {
          // 缩进外的非 insert 顶层内容（注释/其他条目）：当前块结束
          flushBlock();
          out.push(line);
        } else {
          blockLines.push(line);
          if (namePattern.test(line)) blockHasTarget = true;
        }
      } else {
        out.push(line);
      }
    }
    flushBlock();
    let next = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
    // 条目删空后回落为合法空文档，避免 loader 解析失败
    if (!/^- insert:/m.test(next)) next = "[]\n";
    const tmp = PATCH_FILE + ".tmp";
    await writeFile(tmp, next, "utf8");
    await rename(tmp, PATCH_FILE);
    return true;
  })();
  patchQueue = task.catch((error) => { taskError = error; });
  const result = await patchQueue;
  if (taskError) throw taskError;
  return result;
}

/**
 * 轻量语义版本比较：v1.2.3-rc.1 < v1.2.3；返回 -1/0/1；无法解析时回退字符串比较。
 * n3：预发布标识按「.」分段逐段比较（数字段按数值，rc.10 > rc.9）；
 * 支持两位/一位版本号（1.0、1 视为 1.0.0）；整串不匹配（如 1.2.3.4）视为无法解析。
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v).trim().replace(/^v/i, "");
    const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
    if (!m || m[0] !== s) return null;
    return {
      major: +m[1],
      minor: m[2] === undefined ? 0 : +m[2],
      patch: m[3] === undefined ? 0 : +m[3],
      pre: m[4] ?? null
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** n3：预发布标识比较——无 pre > 有 pre；数字段按数值、数字标识 > 字母数字标识（semver 规则）。 */
function comparePre(a, b) {
  if (a === b) return 0;
  if (!a) return 1; // 正式版 > 预发布
  if (!b) return -1;
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum) return 1; // 数字标识 > 字母数字标识
    if (yNum) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 复制过滤器：排除 .git 与目录边界精确的 node_modules（避免误伤 node_modules_backup 之类）。 */
function copyFilter(cacheDir, excludeNodeModules) {
  const nm = join(cacheDir, "node_modules");
  return (src) => {
    if (src === join(cacheDir, ".git") || src.startsWith(join(cacheDir, ".git") + sep)) return false;
    if (excludeNodeModules && (src === nm || src.startsWith(nm + sep))) return false;
    return true;
  };
}

async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "dsh-plugin-marketplace", "Accept": "application/vnd.github+json", ...extraHeaders },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}${(await res.text().catch(() => "")).slice(0, 200)}`);
  return await res.json();
}

/**
 * 硬编码排除名单：deepseek-harness 是 DSH 本体仓库，不属于插件。
 * 按仓库名精确排除（含同名 fork），避免把 Harness 自身当成可安装插件。
 */
const EXCLUDED_REPO_NAMES = new Set(["deepseek-harness"]);

/**
 * 静态索引（registry.json / skills.json）的候选源（按序尝试，全部失败才回退搜索 API）：
 * 1. api.github.com raw——永远最新、国内可达（未认证限流 60 次/小时，个人使用绰绰有余）；
 * 2. jsDelivr CDN——快，但缓存可能滞后，超过 REGISTRY_MAX_AGE_MS 的旧索引直接弃用；
 * 3. raw.githubusercontent——永远最新，适合 api 被限流/屏蔽的网络。
 */
function registrySources(kind) {
  const file = kind === "skills" ? "skills.json" : "registry.json";
  // #14：全部源优先取 .json.gz 压缩产物（12MB 索引 gzip 后约 1.5MB；registry.json.gz 回落到
  // 1MB 以内，GitHub Contents API 的 >1MB 拒绝限制对 api 源也不再是问题）。下载后由
  // fetchRegistryRepos 解压解析；末尾保留无 gz 的原始 JSON 兜底（旧部署/镜像）。
  const sources = [
    { url: `https://api.github.com/repos/bradeGithub/DSH-Plugins-Marketplace/contents/${file}.gz`, acceptRaw: true },
    { url: `https://cdn.jsdelivr.net/gh/bradeGithub/DSH-Plugins-Marketplace@main/${file}.gz`, checkFresh: true },
    { url: `https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/${file}.gz` },
    { url: `https://cdn.jsdelivr.net/gh/bradeGithub/DSH-Plugins-Marketplace@main/${file}`, checkFresh: true },
    { url: `https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/${file}` }
  ];
  return sources;
}
/** jsDelivr CDN 缓存可滞后数小时：超过该年龄的索引视为过期，改用下一数据源。 */
const REGISTRY_MAX_AGE_MS = 6 * 3600 * 1000;

/** 插件分类白名单（与 build-registry.mjs 的 CATEGORY_RULES id 及 client.js CATEGORY_KEYS 对齐）。 */
const CATEGORY_KEYS = new Set(["vision", "document", "memory", "model", "notify", "coding", "conversation", "web-ui", "agent", "tool", "resource", "other"]);

/** 归一化仓库元数据（兼容搜索 API 与 registry.json 两种字段形态）；html_url 只放行 https://github.com 链接。
 *  kind="skills" 时才保留 has_skill/has_install_script 三态（true/false/null 未知）；
 *  其他来源（插件市场 registry / 搜索兜底）没有探测字段——不写该字段（undefined），
 *  避免前端把「无探测数据」误判成「未验证」显示满屏徽章。 */
function normalizeRepo(r, kind = "dsh") {
  let htmlUrl = null;
  try {
    const u = new URL(String(r.html_url ?? ""));
    if (u.protocol === "https:" && u.host === "github.com") htmlUrl = u.href;
  } catch { /* 非法 URL 置空，客户端不渲染链接 */ }
  const out = {
    full_name: r.full_name,
    name: r.name,
    description: r.description,
    html_url: htmlUrl,
    stargazers_count: r.stargazers_count,
    updated_at: r.updated_at,
    default_branch: r.default_branch ?? "main",
    topics: r.topics ?? [],
    license: typeof r.license === "string" ? r.license : (r.license?.spdx_id ?? null),
    pkg_name: typeof r.pkg_name === "string" && r.pkg_name.length > 0 ? r.pkg_name : null,
    // registry.json 的版本号字段（构建期从仓库 package.json 抓取，供「更新」检测；
    // 搜索 API 兜底 / 无 package.json 的仓库没有 → null）
    version: typeof r.version === "string" && r.version.length > 0 ? r.version : null,
    // v1.4.11（issue #26）：npm 发布版本与真实包名——npm 型 cli 的升级提示数据源
    // （monorepo / npm 发布型插件根 package.json version 常年不 bump，以 npm dist-tags 为准）
    npm_version: typeof r.npm_version === "string" && r.npm_version.length > 0 ? r.npm_version : null,
    npm_pkg_name: typeof r.npm_pkg_name === "string" && r.npm_pkg_name.length > 0 ? r.npm_pkg_name : null,
    // registry.json 的分类字段（搜索 API 兜底没有 → null，客户端按「其他」处理）
    category: typeof r.category === "string" && CATEGORY_KEYS.has(r.category) ? r.category : null,
    // 构建期盖章字段必须透传：market_tags（人工验证徽章）与 installable（手动/非插件提示）
    market_tags: Array.isArray(r.market_tags) && r.market_tags.length > 0 ? [...r.market_tags] : undefined,
    installable: r.installable === "manual" || r.installable === "non-plugin" ? r.installable : undefined
  };
  // skills 索引字段（仅 skills 模式；registry / 搜索兜底不写，前端不显示「未验证」）
  if (kind === "skills") {
    out.has_skill = r.has_skill === true ? true : (r.has_skill === false ? false : null);
    out.has_install_script = r.has_install_script === true ? true : (r.has_install_script === false ? false : null);
  }
  return out;
}

/** 从 registry 索引拉取仓库列表；全部源失败时返回 null（调用方回退搜索 API）。 */
async function fetchRegistryRepos(kind = "dsh") {
  for (const source of registrySources(kind)) {
    try {
      const headers = { "User-Agent": "dsh-plugin-marketplace" };
      if (source.acceptRaw) headers["Accept"] = "application/vnd.github.raw";
      // api 源有 token 时带认证（60 次/小时 → 5000 次/小时）
      if (source.acceptRaw && (process.env.GITHUB_TOKEN || process.env.GH_TOKEN)) {
        headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN}`;
      }
      const res = await fetch(source.url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      // .gz 源：先解压再解析（gzipSync/gunzipSync 均为同步，开销可接受）
      let text;
      if (source.url.endsWith(".gz")) {
        const buf = Buffer.from(await res.arrayBuffer());
        text = gunzipSync(buf).toString("utf8");
      } else {
        text = await res.text();
      }
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.repos)) continue;
      // CDN 源做新鲜度校验：索引生成时间过旧说明缓存滞后，弃用并尝试下一源
      if (source.checkFresh) {
        const age = Date.now() - Date.parse(data.generated_at ?? "");
        if (Number.isNaN(age) || age > REGISTRY_MAX_AGE_MS) continue;
      }
      const seen = new Set();
      const collected = [];
      for (const r of data.repos) {
        if (!r || typeof r.full_name !== "string") continue;
        if (seen.has(r.full_name)) continue;
        seen.add(r.full_name);
        if (EXCLUDED_REPO_NAMES.has(r.name)) continue;
        collected.push(normalizeRepo(r, kind));
      }
      if (collected.length > 0) return collected;
    } catch { /* 尝试下一个源 */ }
  }
  return null;
}

/** 搜索 API 兜底路径：按 kind 的 query 列表逐 query 分页翻到底（跨 query 去重），
 *  最多 MAX_PAGES 页/query；存在 GH_TOKEN/GITHUB_TOKEN 时带认证提升限流。
 *  skills 兜底无探测数据，has_skill 一律 null（未知），由前端弱化显示。
 *  单 query 失败（限流/网络）时使用已收集的部分数据降级返回，不再让整个列表 500。 */
async function fetchSearchRepos(kind = "dsh") {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const collected = [];
  const seen = new Set();
  for (const query of SEARCH_QUERIES[kind] ?? SEARCH_QUERIES.dsh) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let data;
      try {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${PAGE_SIZE}&page=${page}`;
        data = await fetchJson(url, token ? { Authorization: `Bearer ${token}` } : {});
      } catch (error) {
        console.warn(`[dsh-plugin-marketplace] 搜索 API 失败（${query} 第 ${page} 页）：${error?.message ?? error}，使用已收集的部分数据`);
        break;
      }
      const items = data.items ?? [];
      for (const r of items) {
        if (seen.has(r.full_name)) continue;
        seen.add(r.full_name);
        if (EXCLUDED_REPO_NAMES.has(r.name)) continue;
        collected.push(r);
      }
      if (items.length < PAGE_SIZE) break;
    }
  }
  return collected.map(normalizeRepo);
}

/**
 * 运行时 pkg_name 冲突消解（纯函数）：同一 pkg_name 只保留一个条目——
 * 已安装（isInstalled 命中）优先，其次 Star 高者；无 pkg_name 的条目按 full_name 天然唯一。
 * 返回消解后的列表，被隐藏的 full_name 记入日志。
 * 必须在 detectInstalled 标注之后调用（isInstalled 传 r.installed === true），
 * 否则手动安装的低 Star 仓库会被隐藏。
 */
function dedupeReposByPkgName(repos, isInstalled = (r) => hasInstalledRecord(r.full_name)) {
  const rank = (r) => (isInstalled(r) ? 1e12 + (r.stargazers_count ?? 0) : (r.stargazers_count ?? 0));
  const byKey = new Map();
  const dropped = [];
  for (const r of repos) {
    const key = r.pkg_name ? `pkg:${r.pkg_name}` : `repo:${r.full_name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    if (rank(r) > rank(prev)) {
      dropped.push(prev.full_name);
      byKey.set(key, r);
    } else {
      dropped.push(r.full_name);
    }
  }
  if (dropped.length > 0) {
    console.warn(`[dsh-plugin-marketplace] pkg_name 冲突，列表已隐藏：${dropped.join(", ")}（同名 npm 包只能安装一个，请原作者改名）`);
  }
  // L4（KIMI 审阅）：dropped 一并返回，列表接口透传给前端提示用户（同名包隐藏不再是静默行为）
  return { repos: [...byKey.values()], dropped };
}

/**
 * 读磁盘缓存（上次成功拉取的完整索引）；无缓存/损坏/缺 generated_at/过期/坏条目返回 null。
 * 与 writeListCache 配套（L1 修复）：search 兜底不再落盘后，磁盘缓存只可能是
 * registry 成功时写入的完整索引（带 generated_at）——逐项校验才能保证
 * registry 全挂时兜底用的缓存是新鲜且结构完整的。
 */
async function readListCache(kind) {
  try {
    const data = JSON.parse(await readFile(listCacheFile(kind), "utf8"));
    if (data && typeof data === "object" && Array.isArray(data.repos) && data.repos.length > 0) {
      // 新鲜度校验：generated_at 缺失（旧格式/被篡改）或超过 REGISTRY_MAX_AGE_MS 视为无效，
      // 返回 null 走下一级数据源——过期的旧索引不再被长期兜底使用。
      const age = Date.now() - Date.parse(data.generated_at ?? "");
      if (Number.isNaN(age) || age > REGISTRY_MAX_AGE_MS) return null;
      // 条目基础校验：full_name 非字符串的坏条目丢弃（文件被篡改/半写时的残渣）。
      // 缓存里的是 registry 成功写入的已归一化条目，直接采用。
      const valid = [];
      for (const r of data.repos) {
        if (r && typeof r === "object" && typeof r.full_name === "string" && r.full_name.length > 0) valid.push(r);
      }
      if (valid.length > 0) return valid;
    }
  } catch { /* 无缓存或损坏 */ }
  return null;
}

/**
 * 写磁盘缓存。只在完整索引（registry / bundled）成功时调用——搜索兜底结果天然
 * 残缺（Search API 单 query 上限 1000 条），落盘会把好缓存降级成残缺索引（#12）。
 * generated_at 记写入时刻（紧跟 registry 成功拉取，与索引拉取时刻同一量级），
 * readListCache 按 REGISTRY_MAX_AGE_MS 校验其新鲜度。
 */
async function writeListCache(kind, repos) {
  try {
    await mkdir(LIST_CACHE_DIR, { recursive: true });
    const generatedAt = new Date().toISOString();
    await writeFile(listCacheFile(kind), JSON.stringify({ saved_at: generatedAt, generated_at: generatedAt, kind, count: repos.length, repos }, null, 2), "utf8");
  } catch { /* 缓存写失败不阻断主流程 */ }
}

/**
 * 插件包内置索引（registry.json / skills.json 随包分发）：无网络依赖的可靠兜底（#12）。
 * skills.json 已超 12MB（12000+ 仓库），慢网/代理环境常撞 FETCH_TIMEOUT_MS 硬超时，
 * 回退搜索 API 只剩残缺结果。内置索引秒读且全量；「刷新」仍走网络源获取最新。
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
async function readBundledIndex(kind) {
  try {
    const data = JSON.parse(await readFile(join(MODULE_DIR, "..", kind === "skills" ? "skills.json" : "registry.json"), "utf8"));
    if (!data || !Array.isArray(data.repos)) return null;
    const seen = new Set();
    const collected = [];
    for (const r of data.repos) {
      if (!r || typeof r.full_name !== "string") continue;
      if (seen.has(r.full_name)) continue;
      seen.add(r.full_name);
      if (EXCLUDED_REPO_NAMES.has(r.name)) continue;
      collected.push(normalizeRepo(r, kind));
    }
    return collected.length > 0 ? collected : null;
  } catch { /* 内置文件缺失/损坏（如手动裁剪安装） */ }
  return null;
}

/**
 * 拉取 kind 的全部仓库（dsh：topic:dsh-plugin；skills：agent-skills ∪ claude-skills）：
 * - skills 默认直读随包内置索引（秒开、离线可用，#12），force（点「刷新」）才先走网络源；
 * - dsh 与 force 刷新：registry 索引优先（api/raw/CDN 多源），失败 → 内置索引 →
 *   磁盘缓存（上次成功的完整索引）→ 搜索 API（天然不全，仅应急，且不再落盘污染缓存）。
 * 去重并排除 DSH 本体后按 Star 数从高到低排序。
 * 注意：pkg_name 冲突消解不在数据层做——「已安装优先」必须等 detectInstalled
 * （含 profile/repository 匹配）跑完才能判定，提前去重会隐藏用户手动安装的
 * 低 Star 仓库（见列表处理器里的 dedupeReposByPkgName）。
 */
async function fetchAllRepos(kind = "dsh", force = false) {
  if (force || kind !== "skills") {
    const fromRegistry = await fetchRegistryRepos(kind);
    if (fromRegistry) {
      listSources[kind] = "registry";
      writeListCache(kind, fromRegistry); // 不 await：落盘失败不影响响应
      fromRegistry.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
      return fromRegistry;
    }
  }
  const fromBundled = await readBundledIndex(kind);
  if (fromBundled) {
    listSources[kind] = "bundled";
    writeListCache(kind, fromBundled); // 让磁盘缓存也持有完整索引
    fromBundled.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
    return fromBundled;
  }
  const fromDisk = await readListCache(kind);
  if (fromDisk) {
    listSources[kind] = "cache";
    console.warn(`[dsh-plugin-marketplace] 索引网络源与内置索引均不可用，使用本地磁盘缓存（${kind}，${fromDisk.length} 条）`);
    fromDisk.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
    return fromDisk;
  }
  // #12：搜索兜底结果不写磁盘缓存——残缺结果会把上次成功的完整索引降级。
  const fromSearch = await fetchSearchRepos(kind);
  // search 兜底不写盘（L1 修复）：Search API 单 query 上限 1000 条（skills 兜底仅 266），
  // 残缺结果只作当次响应，绝不落盘——否则 registry 全挂时磁盘缓存长期提供残缺数据。
  // 磁盘缓存从此只在 registry 成功时写入（带 generated_at，见 writeListCache）。
  listSources[kind] = "search";
  fromSearch.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
  return fromSearch;
}

/** 获取列表：缓存有效期内直接返回；并发请求共享同一次拉取；force 时忽略缓存强制刷新。kind 各自独立缓存。 */
async function getList(kind = "dsh", force = false) {
  const cache = listCaches[kind] ?? (listCaches[kind] = { at: 0, repos: null });
  if (!force && cache.repos !== null && Date.now() - cache.at <= CACHE_TTL_MS) return cache.repos;
  // 用 == null（null 或 undefined）：listCaches/listFetchings 是 { dsh, skills } 字面量，
  // 不存在的键是 undefined 而非 null，=== null 会误判「无进行中的拉取」，直接返回 undefined
  // 导致调用方读 .length 崩溃（用户线上报错即此）。
  if (listFetchings[kind] == null) {
    listFetchings[kind] = fetchAllRepos(kind, force)
      .then((repos) => {
        listCaches[kind] = { at: Date.now(), repos, source: listSources[kind] ?? "registry" };
        return repos;
      })
      .finally(() => {
        listFetchings[kind] = null;
      });
  }
  return await listFetchings[kind];
}

const exists = (p) => stat(p).then(() => true).catch(() => false);

/**
 * 启动 npm（跨平台）：
 * - Windows 上 execFile 无法启动 npm 的 .cmd 批处理（spawn npm ENOENT / spawn npm.cmd EINVAL），
 *   直接用 node.exe 运行 npm-cli.js（不依赖 PATH，最稳）；cli 缺失时回退 npm.cmd。
 * - 其他平台直接 npm。
 */
async function runNpm(args, opts) {
  if (process.platform === "win32") {
    const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (await exists(cli)) {
      return await execFileAsync(process.execPath, [cli, ...args], opts);
    }
    return await execFileAsync("npm.cmd", args, opts);
  }
  return await execFileAsync("npm", args, opts);
}

/**
 * 启动 pnpm（跨平台）。Windows 上 Node 的 execFile 无法直接启动 .cmd 批处理
 * （即使 pnpm 已安装也无条件抛 spawn EINVAL），需经 cmd.exe 解析 PATH 中的 pnpm 启动；
 * 非 Windows 直接调用 pnpm。
 */
async function runPnpm(args, opts) {
  if (process.platform === "win32") {
    return await execFileAsync("cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], opts);
  }
  return await execFileAsync("pnpm", args, opts);
}

/** 递归收集 exports 子树中的全部字符串入口（覆盖 default/import/require/browser 等条件与嵌套对象）。 */
function collectExportTargets(node, out) {
  if (typeof node === "string") {
    if (node.length > 0) out.push(node);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const value of Object.values(node)) collectExportTargets(value, out);
}

/**
 * 判断仓库是否需要先构建才能安装（纯逻辑 + 文件探测）：
 * package.json 声明了 build 脚本，且加载入口（main / exports 的 "." 与 "./client"）在仓库中缺失。
 * exports 的 "./client" 常见 conditional exports 形态（{ import | require | browser | default }），
 * 递归收集全部字符串入口，避免漏判只提交源码的插件——直接复制进 profile 会导致 DSH 启动失败
 * （MODULE_NOT_FOUND / client bundle 缺失）。
 */
async function needsPluginBuild(cacheDir) {
  try {
    const pkg = JSON.parse(await readFile(join(cacheDir, "package.json"), "utf8"));
    if (!pkg || typeof pkg.scripts?.build !== "string" || !pkg.scripts.build.trim()) return false;
    const targets = [];
    if (typeof pkg.main === "string" && pkg.main.length > 0) targets.push(pkg.main);
    if (pkg.exports && typeof pkg.exports === "object") {
      for (const sub of [".", "./client"]) {
        if (Object.prototype.hasOwnProperty.call(pkg.exports, sub)) {
          collectExportTargets(pkg.exports[sub], targets);
        }
      }
    }
    if (targets.length === 0) return false;
    for (const target of targets) {
      if (!(await exists(join(cacheDir, target)))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 构建源码型插件（用户已确认）：pnpm-lock 存在用 pnpm（支持 link:/workspace: 协议），
 * 否则 npm；均安装完整依赖（含 devDependencies）后执行 build 脚本。
 * 用户已在弹窗确认「安装依赖并执行第三方构建脚本」，此路径不再二次询问。
 * 失败抛错由安装流程统一清理。
 */
async function buildPluginPackage(cacheDir, env, logLine, lang) {
  const usePnpm = await exists(join(cacheDir, "pnpm-lock.yaml"));
  const bin = usePnpm ? "pnpm" : "npm";
  logLine(t(lang, "buildInstall", { bin }));
  if (usePnpm) {
    await runPnpm(["install", "--no-frozen-lockfile"], { cwd: cacheDir, env, timeout: 600000 });
  } else {
    await runNpm(["install", "--no-audit", "--no-fund"], { cwd: cacheDir, env, timeout: 600000 });
  }
  logLine(t(lang, "buildRun", { bin }));
  if (usePnpm) {
    await runPnpm(["run", "build"], { cwd: cacheDir, env, timeout: 600000 });
  } else {
    await runNpm(["run", "build"], { cwd: cacheDir, env, timeout: 600000 });
  }
  return true;
}

/**
 * npm install 回退链：
 * - allowScripts=false（默认，安全）：一律 --ignore-scripts，第三方 npm 脚本不执行；
 *   失败时加 --legacy-peer-deps（peer 由 DSH 宿主提供）。
 * - allowScripts=true（用户确认后）：先不带 --ignore-scripts 执行（脚本按用户授权运行）；
 *   若因脚本/peer 失败，依次回退 --legacy-peer-deps → 最终 --ignore-scripts（使用仓库已提交的构建产物）。
 */
async function npmInstallWithFallback(cacheDir, env, logLine, lang, allowScripts = false) {
  const base = ["install", "--omit=dev", "--no-audit", "--no-fund"];
  const attempts = allowScripts
    ? [
        { args: base },
        { args: [...base, "--legacy-peer-deps"] },
        { args: [...base, "--legacy-peer-deps", "--ignore-scripts"], noteKey: "npmFallbackScripts" }
      ]
    : [
        { args: [...base, "--ignore-scripts"] },
        { args: [...base, "--legacy-peer-deps", "--ignore-scripts"], noteKey: "npmFallbackPeers" }
      ];
  let lastError;
  for (const attempt of attempts) {
    try {
      await runNpm(attempt.args, { cwd: cacheDir, env, timeout: 180000 });
      if (attempt.noteKey) logLine(t(lang, attempt.noteKey));
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function scanRequirements(cacheDir) {
  const names = new Set();
  const files = [];
  // KIMI 审阅 M4：原实现只 readdir 根目录一层，多包/子目录插件的 README/.env 扫不到 →
  // 递归两层（跳过点目录/node_modules/dist/build），文件数上限 40 保持成本可控。
  const walk = async (dir, depth) => {
    if (depth > 2 || files.length >= 40) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".") || ["node_modules", "dist", "build"].includes(ent.name)) continue;
        await walk(p, depth + 1);
      } else if (/(readme|install|\.env|package\.json|\.ya?ml$|\.md$)/i.test(ent.name)) {
        files.push(p);
      }
    }
  };
  await walk(cacheDir, 0);
  for (const file of files.slice(0, 40)) {
    try {
      const text = await readFile(file, "utf8");
      for (const m of text.matchAll(ENV_PATTERN)) names.add(m[0]);
    } catch { /* binary or unreadable */ }
  }
  return [...names].slice(0, 8);
}

/**
 * 安装失败分类提示（纯函数）：把 npm/pnpm 常见错误签名翻译成可读的排查建议，
 * 避免用户面对一墙英文堆栈。识别不到返回 null。
 */
function classifyInstallFailure(text, lang = "zh") {
  const t2 = (zh, en) => (lang === "zh" ? zh : en);
  const s = String(text ?? "");
  const rules = [
    [/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|premature close|network request failed/i,
      () => t2("网络错误：无法连接 npm registry / GitHub，请检查网络或代理后重试。", "Network error: cannot reach the npm registry / GitHub. Check your connection or proxy and retry.")],
    // git clone 网络失败（issue #21）：错误形如 `unable to access 'https://github.com/...': Failed to
    // connect to github.com port 443 ... Couldn't connect to server`——必须在「Command failed」之前命中，
    // 否则被笼统归类为构建失败，误导用户排查方向。
    [/unable to access|Failed to connect|Couldn't connect to server|Connection (?:timed out|refused)|Could not resolve host/i,
      () => t2("无法连接 GitHub（网络/代理问题）：git clone 直连 github.com 失败。请检查网络，或为 git 配置代理后重试（Windows 示例: git config --global http.proxy http://127.0.0.1:7890）。", "Cannot reach GitHub (network/proxy issue): git clone to github.com failed. Check your network, or configure a git proxy and retry (Windows: git config --global http.proxy http://127.0.0.1:7890).")],
    [/EINTEGRITY|integrity checksum failed/i,
      () => t2("依赖完整性校验失败（常见于网络缓存损坏）：删除依赖目录后重试，或清 npm 缓存（npm cache clean --force）。", "Dependency integrity check failed (often a corrupted network cache): remove the dependency dir and retry, or run `npm cache clean --force`.")],
    [/ETARGET|No matching version|404 Not Found|E404|ENOVERSIONS/i,
      () => t2("依赖版本不存在：某个依赖或其版本在 registry 找不到（私有包、版本号错误或未发布）。", "A dependency version does not exist in the registry (private package, wrong version, or not published).")],
    [/gyp ERR|node-gyp|python(3)?(\s|\.exe)? not found|not found: python/i,
      () => t2("原生模块编译失败：node-gyp 需要 Python 与 C++ 构建工具链，请先安装（Windows: Visual Studio Build Tools）。", "Native module build failed: node-gyp needs Python and a C++ toolchain (Windows: Visual Studio Build Tools).")],
    [/MODULE_NOT_FOUND|Cannot find module/i,
      () => t2("缺少模块：包或依赖不完整——可能是源码型仓库未构建，或本地链接（link:/workspace:）依赖被剥离后仍被引用。", "Missing module: the package or its deps are incomplete — possibly a source-only repo that was not built, or a stripped link:/workspace: dependency still being referenced.")],
    [/ERR_PNPM|Command failed/i,
      () => t2("构建/包管理命令失败：请查看上方日志输出定位具体步骤。", "Build/package-manager command failed: check the log above for the failing step.")],
    [/EACCES|EPERM|EBUSY/i,
      () => t2("权限/占用错误：目标目录被占用或没有写入权限（Windows 常见：杀毒软件锁文件）。", "Permission/lock error: the target directory is busy or not writable (on Windows, antivirus may lock files).")]
  ];
  for (const [re, hint] of rules) {
    if (re.test(s)) return hint();
  }
  return null;
}

/** 日志脱敏（纯函数）：隐藏用户主目录路径与密钥形态串，供导出排查日志用。 */
function sanitizeLog(text) {
  return String(text ?? "")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"]+/g, "~\\<user>")
    .replace(/\$HOME\/[^\s"]+|\/home\/[^\s"\/]+\/[^\s"]+/g, "~/<user>")
    .replace(/\b(sk-[A-Za-z0-9]{6})[A-Za-z0-9]+/g, "$1…")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{6})[A-Za-z0-9]+/g, "$1…")
    .replace(/\b(AKIA[A-Za-z0-9]{6})[A-Za-z0-9]+/g, "$1…");
}

/** 近期操作日志环形缓冲（内存态，导出排查用；不落盘）。 */
const RECENT_LOG_MAX = 400;
let recentLogs = [];
function pushLog(line) {
  recentLogs.push(`[${new Date().toISOString()}] ${line}`);
  if (recentLogs.length > RECENT_LOG_MAX) recentLogs.splice(0, recentLogs.length - RECENT_LOG_MAX);
}

/**
 * vendored 目录惯例命名（小写）：git submodule / 第三方源码常见目录。
 * findSkillRoots 跳过这些目录——其中的 SKILL.md 是上游项目的内容，不是本仓库分发的技能。
 */
const VENDORED_DIR_NAMES = new Set(["upstream", "vendor", "vendored", "third_party", "third-party", "external", "deps"]);

/** Find root and nested Agent Skills without following symlinks or dependency caches. */
async function findSkillRoots(cacheDir, maxDepth = 5, limit = 200) {
  const roots = [];
  const walk = async (dir, depth) => {
    if (roots.length >= limit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md")) {
      roots.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      // 跳过点目录（.git/.codex/.opencode/.claude 等）：那是仓库自身 agent 工具链配置，
      // 里面的 SKILL.md 是项目开发流程技能，不是给用户安装的 DSH 技能（如 iPolloWork 误装案例）。
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      // #11：跳过 vendored 目录（git submodule / 第三方源码惯例命名，如 oh-dsh 的
      // upstream/DSH-better-sidebar）——其中的 SKILL.md 属于上游项目自带内容，
      // 不是本仓库要向用户分发的技能，扫到会把插件仓库误判为 skill。
      if (VENDORED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
      await walk(join(dir, entry.name), depth + 1);
      if (roots.length >= limit) return;
    }
  };
  await walk(cacheDir, 0);
  return roots;
}

async function readSkillManifest(skillRoot) {
  const entries = await readdir(skillRoot).catch(() => []);
  const manifest = entries.find((name) => name.toLowerCase() === "skill.md") ?? "SKILL.md";
  return readFile(join(skillRoot, manifest), "utf8");
}

/**
 * 查找仓库根目录与子目录中的全部 DSH cordis 插件清单（package.json 且声明插件能力）。
 * 皮肤/多包仓库（如 dsh-deep-whale：根目录只有 README，皮肤包在子目录）靠它被识别为
 * cordis-plugin 而非「手动安装」。只收 looksLikeDshPlugin 为 true 的清单，
 * 普通 npm 子包（依赖目录、示例项目等）不会被误装。
 */
async function findPluginRoots(cacheDir, maxDepth = 3, limit = 50) {
  const roots = [];
  const walk = async (dir, depth) => {
    if (roots.length >= limit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        if (looksLikeDshPlugin(pkg) === true) {
          roots.push(dir);
          return; // 该目录已是插件根，不再深入其子目录
        }
      } catch { /* 坏 JSON：忽略该目录，继续找其他根 */ }
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await walk(join(dir, entry.name), depth + 1);
      if (roots.length >= limit) return;
    }
  };
  await walk(cacheDir, 0);
  return roots;
}

/**
 * 查找仓库根目录与子目录中的 agent preset 根（同时含 preset.yml + agent.cordis.yml）。
 * 处理「预设目录在子目录」的仓库（如 dsh-anchored-standard 的 preset/）：根目录无 preset
 * 文件但子目录有完整预设时，市场也能一键安装到 ~/.dsh/.agent-presets/。
 * 与 findPluginRoots 同款遍历约束（跳过点目录/node_modules，深度 3，上限 50）。
 */
async function findPresetRoots(cacheDir, maxDepth = 3, limit = 50) {
  const roots = [];
  const walk = async (dir, depth) => {
    if (roots.length >= limit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.isFile() && entry.name === "preset.yml")
        && entries.some((entry) => entry.isFile() && entry.name === "agent.cordis.yml")) {
      roots.push(dir);
      return; // 该目录已是 preset 根，不再深入其子目录
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await walk(join(dir, entry.name), depth + 1);
      if (roots.length >= limit) return;
    }
  };
  await walk(cacheDir, 0);
  return roots;
}

/**
 * 安装类型识别（#11 分层判定，勿简单地把某一类提为全局最高优先）：
 * 1. agent 预设 / 安装脚本：特征文件明确，最优先；
 * 2. 嵌套 agent 预设（预设目录在子目录，如 dsh-anchored-standard 的 preset/）→ agent-preset；
 * 3. 根 package.json 声明 DSH 插件能力 → cordis-plugin——插件仓库附带的技能
 *    （含子模块里的上游技能，如 oh-dsh 的 upstream/* 下的 skills/*）不应让整个
 *    仓库被误判为 skill 而漏装插件本体；
 * 4. 根目录 SKILL.md → skill——仓库本体就是技能；带工具链 package.json（未声明
 *    DSH 能力）的纯 skill 仓库在此归位，不会被误判为插件；
 * 5. 嵌套插件根（皮肤/多包仓库）→ cordis-plugin；
 * 6. 嵌套技能根（技能集合仓库）→ skill；
 * 7. 其余 → instructions（手动安装弹窗）。
 */
async function detectType(cacheDir) {
  const has = (p) => exists(join(cacheDir, p));
  if ((await has("preset.yml")) && (await has("agent.cordis.yml"))) return "agent-preset";
  if (await has("install.ps1")) return "script";
  if (await has("install.sh")) return "script";
  // 嵌套 agent 预设：根目录无 preset 文件但子目录有完整预设（如 dsh-anchored-standard 的 preset/）
  if ((await findPresetRoots(cacheDir)).length > 0) return "agent-preset";
  if (await has("package.json")) {
    if ((await looksLikeDshPlugin(await readPackageJsonObject(cacheDir))) === true) return "cordis-plugin";
    // maxDepth=0：仅根目录的技能清单（大小写不敏感，复用 findSkillRoots 的判定）
    if ((await findSkillRoots(cacheDir, 0, 1)).length > 0) return "skill";
    // 非插件 package.json（聚合页/桌面应用/普通 npm 项目）：仍按 cordis-plugin 走，
    // 安装流程里的「非插件确认」弹窗会拦下盲装（原行为保留）。
    return "cordis-plugin";
  }
  if ((await findSkillRoots(cacheDir, 0, 1)).length > 0) return "skill";
  // 皮肤/多包仓库：根目录无清单但子目录含插件 → 同样按 cordis-plugin 安装（逐个安装子包）
  if ((await findPluginRoots(cacheDir)).length > 0) return "cordis-plugin";
  if ((await findSkillRoots(cacheDir, 5, 1)).length > 0) return "skill";
  return "instructions";
}

/** 读取仓库 package.json 中 npm 会执行的生命周期脚本名（存在才返回）。 */
async function readLifecycleScripts(cacheDir) {
  try {
    const pkg = JSON.parse(await readFile(join(cacheDir, "package.json"), "utf8"));
    const scripts = pkg?.scripts ?? {};
    return ["preinstall", "install", "postinstall", "prepare"]
      .filter((name) => typeof scripts[name] === "string" && scripts[name].length > 0);
  } catch { /* 无 package.json 或解析失败 */ }
  return [];
}

/**
 * 解析 .gitmodules 中的全部子模块 url（纯函数），并做安全校验（#10）：
 * 只放行 https:// 与相对路径（./ ../，相对 origin 解析）；含 scheme 分隔符 ":"
 * 的非 https 地址（file://、git@、git://、ssh:// 等）一律拒绝——file:// 子模块可
 * 读取宿主机任意路径并纳入构建，属于本地文件泄露入口。
 * 返回 { urls, unsafe }：urls 为全部地址，unsafe 为被拒绝的地址（为空才允许拉取）。
 */
function parseGitmodulesUrls(text) {
  const urls = [];
  for (const m of String(text ?? "").matchAll(/^\s*url\s*=\s*(\S+)\s*$/gm)) urls.push(m[1]);
  const unsafe = urls.filter((u) => u.includes(":") && !u.startsWith("https://"));
  return { urls, unsafe };
}

/**
 * 扫描克隆缓存中的 README，提取全部 `dsh plugin … install/add <target>` 指令。
 * 兼容三种写法（dsh-market 实测反馈）：
 *   - `dsh plugin install owner/repo`            （仓库名）
 *   - `dsh plugin --profile web add dshmarket`   （flags 在动词前 + npm 包名）
 *   - `dsh plugin add owner/repo`
 * 拒绝相对路径 / 本地绝对路径目标（`../`、`./`、盘符、`/` 开头）——这类指令
 * 依赖执行环境的 cwd（如 dsh-deep-whale 的 `add ../dsh-deep-whale/maid-atelier`
 * 是作者本地开发用法），市场代执行只会装出死链接；一律跳过。
 * 返回 [{ command, verb, target }]，按 README 中出现顺序排列；无指令返回 []。
 */
async function scanCliCommands(cacheDir) {
  const files = ["README.md", "readme.md", "README.en.md", "README_zh.md", "README.zh-CN.md"];
  const out = [];
  for (const file of files) {
    let text;
    try { text = await readFile(join(cacheDir, file), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/\b(?:install|add)\s+([^\s`"'<>）)\]，。]+)/gi)) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (!/\bdsh\s+plugin\b/i.test(before)) continue;
      const start = before.search(/\bdsh\s+plugin\b/i);
      const command = (before.slice(start) + m[0]).split(/[`"'\n]/)[0].trim();
      const raw = String(m[1] ?? "").toLowerCase()
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/^git@github\.com:/i, "")
        .replace(/\.git$/i, "");
      // 相对/本地路径目标不可代执行（依赖 cwd）：跳过
      if (/^(?:\.{1,2}\/|\.{2}|[a-z]:[\\/]|\/)/.test(raw) || raw.includes("..")) continue;
      out.push({ command, verb: m[0].trim().split(/\s+/)[0].toLowerCase(), target: raw });
    }
  }
  return out;
}

/**
 * 解析 README 官方 CLI 安装目标（安装流程执行用）：
 * - tier-1：指令目标 == 仓库全名 / 仓库名 / 本仓库 package.json 的 name → 直接采用（首选）；
 * - tier-2：README 提供了 dsh plugin 指令但目标不是本仓库包（如 dsh-web-ui 推荐聚合包
 *   `@linxin666/dsh-web-ui-all`）→ 采用首条指令（README 是仓库作者自己的安装说明，可信）。
 * 返回 { command, verb, target } 或 null（README 无任何 dsh plugin 指令）。
 */
async function findCliInstall(cacheDir, repo) {
  const commands = await scanCliCommands(cacheDir);
  if (commands.length === 0) return null;
  const target = String(repo ?? "").toLowerCase();
  const nameOnly = target.split("/")[1] ?? "";
  const candidates = new Set([target, nameOnly, `github.com/${target}`]);
  try {
    const pkg = JSON.parse(await readFile(join(cacheDir, "package.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name.length > 0) candidates.add(pkg.name.toLowerCase());
  } catch { /* 无清单（纯 skill 仓库） */ }
  const match = commands.find((c) => candidates.has(c.target)) ?? commands[0];
  return match;
}

/**
 * 扫描 README 中的「第三方 CLI 官方 DSH 接入指令」（展示型提示，不执行）：
 * 形如 `od agent setup deepseek-harness` —— 由该工具自己的 CLI（如 Open Design 的 od）
 * 把其连接组件装进用户已有的官方 dsh 安装，README 通常要求先装官方 dsh CLI。
 * 市场无法代执行（需要对方 daemon/应用在运行，且命令语义是「接入 dsh」而非
 * 「把本仓库装成 dsh 插件」），仅作提示展示给用户。
 * 返回 { cli, command } 或 null。
 */
async function scanExternalCliHint(cacheDir) {
  const files = ["README.md", "readme.md", "README.en.md", "README_zh.md", "README.zh-CN.md"];
  for (const file of files) {
    let text;
    try { text = await readFile(join(cacheDir, file), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/\b([a-z][a-z0-9-]*)\s+agent\s+setup\s+deepseek-harness\b/gi)) {
      const cli = m[1].toLowerCase();
      if (!cli || cli === "dsh") continue; // dsh 自身指令由 scanCliCommands 处理
      const command = text.slice(m.index).split(/[\r\n`]/)[0].trim();
      if (command) return { cli, command };
    }
  }
  return null;
}

/**
 * 扫描 README 并返回「指向当前仓库」的官方 CLI 指令（展示提示用，tier-1 语义不变）。
 * 找不到返回 null。
 */
async function scanCliInstallHint(cacheDir, repo) {
  const commands = await scanCliCommands(cacheDir);
  if (commands.length === 0) return null;
  const target = String(repo ?? "").toLowerCase();
  const nameOnly = target.split("/")[1] ?? "";
  const candidates = new Set([target, nameOnly, `github.com/${target}`]);
  try {
    const pkg = JSON.parse(await readFile(join(cacheDir, "package.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name.length > 0) candidates.add(pkg.name.toLowerCase());
  } catch { /* 无清单 */ }
  const hit = commands.find((c) => candidates.has(c.target));
  return hit ? hit.command : null;
}

/** 判断依赖值是否为 pnpm 专用本地链接协议（npm 无法解析，会报 EUNSUPPORTEDPROTOCOL）。 */
function isPnpmLocalDependency(value) {
  return /^(link|workspace):/.test(String(value ?? ""));
}

/**
 * 移除 manifest 中 pnpm 专用协议（link:/workspace:）的依赖，返回被移除的 (section:name) 列表。
 * 此类依赖只在作者本地 pnpm 工作区存在，npm 安装必然失败；其运行时依赖由 DSH 宿主提供。
 */
function sanitizeManifest(pkg) {
  const removed = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const map = pkg[section];
    if (!map || typeof map !== "object") continue;
    for (const name of Object.keys(map)) {
      if (isPnpmLocalDependency(map[name])) {
        delete map[name];
        removed.push(`${section}:${name}`);
      }
    }
  }
  return removed;
}

// ── 自更新检测（小优待）：DSH 启动时直链 GitHub 查询市场本体最新版本 ──
const SELF_UPDATE_REPO = "bradeGithub/DSH-Plugins-Marketplace";
let selfUpdateState = { installedVersion: null, latestVersion: null, updateAvailable: false, checkedAt: 0, error: null };

/** 读市场本体（本插件）安装目录的 package.json 版本号。 */
function readOwnVersion() {
  try {
    const pkg = requireFromHere("../package.json");
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 兜底：GitHub 直连失败时读启动预热拉取的 registry 索引（市场本体条目的 version 字段）。 */
function selfLatestFromCache() {
  try {
    const repos = listCaches.dsh?.repos;
    if (!Array.isArray(repos)) return null;
    const self = repos.find((r) => r.full_name === SELF_UPDATE_REPO);
    return self && typeof self.version === "string" && self.version.length > 0 ? self.version : null;
  } catch {
    return null;
  }
}

/** 直链 GitHub（contents API，实时不过 CDN 缓存）查市场本体最新版本，与已装版本对比。 */
async function checkSelfUpdate() {
  try {
    const installedVersion = readOwnVersion();
    const res = await fetch(`https://api.github.com/repos/${SELF_UPDATE_REPO}/contents/package.json`, {
      headers: { "User-Agent": "dsh-plugin-marketplace", "Accept": "application/vnd.github.raw" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const pkg = await res.json();
    const latestVersion = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
    selfUpdateState = {
      installedVersion,
      latestVersion,
      updateAvailable: Boolean(installedVersion && latestVersion && compareVersions(installedVersion, latestVersion) < 0),
      checkedAt: Date.now(),
      error: null
    };
  } catch (error) {
    // 直连失败：回退 registry 索引里的版本号；都没有则保留上次状态并记录错误
    const fallback = selfLatestFromCache();
    if (fallback) {
      const installedVersion = readOwnVersion();
      selfUpdateState = {
        installedVersion,
        latestVersion: fallback,
        updateAvailable: Boolean(installedVersion && fallback && compareVersions(installedVersion, fallback) < 0),
        checkedAt: Date.now(),
        error: null
      };
    } else {
      selfUpdateState = { ...selfUpdateState, checkedAt: Date.now(), error: String(error?.message ?? error) };
    }
  }
}

/** 更新市场本体（v1.4.7）：克隆最新仓库 → 校验版本 → staging 复制 → 原子替换本体目录。
 *  - 最新版本优先实时直连 GitHub（与 checkSelfUpdate 同源），失败回退 registry 索引；
 *  - staging 校验通过（package.json 可读且 version 更新、核心文件齐全）才替换，避免半成品覆盖；
 *  - 替换用 rename（同文件系统原子操作）：destRoot → backup，staging → destRoot，失败回滚；
 *  - 无更新返回 { status: "no-update" }，成功返回 { status: "done", installedVersion }。
 *  调用方（路由）负责 installRunning 互斥。 */
async function doSelfUpdate() {
  const installedVersion = readOwnVersion();
  let latestVersion = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${SELF_UPDATE_REPO}/contents/package.json`, {
      headers: { "User-Agent": "dsh-plugin-marketplace", "Accept": "application/vnd.github.raw" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (res.ok) {
      const pkg = await res.json();
      latestVersion = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
    }
  } catch {
    // v1.4.10：执行更新时直连失败直接报错，不再回退索引版本——索引 version 是构建期抓的，
    // 可能滞后（实测曾停在旧版本），fallback 会误判「已是最新」让用户以为更新成功；
    // 直连都失败时 git clone 大概率也失败，明确报错比误导更诚实。
    throw new Error("unable to reach GitHub to check the latest version");
  }
  if (!latestVersion) throw new Error("unable to read the latest version from GitHub");
  if (!installedVersion || !latestVersion || compareVersions(installedVersion, latestVersion) >= 0) {
    return { status: "no-update", installedVersion, latestVersion };
  }
  // v1.4.11：改走官方 CLI 安装（dsh plugin install）——pnpm workspace profile 下本体以
  // github: 依赖安装并锁定在 pnpm-lock.yaml，仅替换目录文件会在下一次 pnpm install 时
  // 被按 lock 还原（实测：更新 pi2dsh 触发 pnpm install 后本体被还原成 lock 锁定的旧版）。
  // 官方 CLI 会同步更新 package.json 与 pnpm-lock.yaml，才是完整、可持久的更新。
  // dsh CLI 优先用 %APPDATA%\npm\dsh.cmd（start-dsh.bat 同款路径），缺失时回退 PATH 里的 dsh。
  const dshCli = join(process.env.APPDATA ?? "", "npm", "dsh.cmd");
  const dshArgs = ["plugin", "--profile", "web", "install", SELF_UPDATE_REPO];
  if (await exists(dshCli)) {
    await execFileAsync(dshCli, dshArgs, { timeout: 600000 });
  } else {
    await execFileAsync("cmd", ["/c", "dsh", ...dshArgs], { timeout: 600000 });
  }
  // 安装后验证：本体版本必须真的更新了（官方 CLI 可能静默失败/装旧版）
  const newVersion = readOwnVersion();
  if (!newVersion || compareVersions(newVersion, installedVersion) <= 0) {
    throw new Error(`self-update verification failed: still v${newVersion ?? "?"}`);
  }
  return { status: "done", installedVersion: newVersion };
}

/** 查 npm registry 最新版（npmmirror 优先，npmjs 兜底）；失败返回 null。 */
async function fetchNpmLatest(pkgName) {
  for (const base of ["https://registry.npmmirror.com", "https://registry.npmjs.org"]) {
    try {
      const res = await fetch(`${base}/${encodeURIComponent(pkgName)}`, {
        headers: { "User-Agent": "dsh-plugin-marketplace" },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) continue;
      const d = await res.json();
      if (d && typeof d["dist-tags"]?.latest === "string" && d["dist-tags"].latest.length > 0) {
        return d["dist-tags"].latest;
      }
    } catch { /* 尝试下一源 */ }
  }
  return null;
}

function apply(ctx) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) throw new Error("dsh-plugin-marketplace: webServer service unavailable");

  // 每次 DSH 启动时自动拉取全部插件并按 Star 排序（失败静默，打开页面时会自动重试）
  getList().catch((error) => {
    ctx.logger?.warn?.(`dsh-plugin-marketplace: 启动预热拉取失败 ${error}`);
  });

  // 小优待：每次 DSH 启动直链 GitHub 查市场本体是否有新版本（失败静默，页面打开时会重查）
  checkSelfUpdate().catch((error) => {
    ctx.logger?.warn?.(`dsh-plugin-marketplace: 自更新检测失败 ${error}`);
  });

  // 加载安装反馈队列与 GitHub Token（安装成功路径会追加 pending，前端打开市场时弹窗确认）
  loadFeedback().catch((error) => {
    ctx.logger?.warn?.(`dsh-plugin-marketplace: 反馈队列加载失败 ${error}`);
  });

  // 加载环境变量编辑存储（issue #18：已安装插件重新配置 API KEY 等）
  loadEnvStore().catch((error) => {
    ctx.logger?.warn?.(`dsh-plugin-marketplace: env 存储加载失败 ${error}`);
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/self-update",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      // GET：检测（页面打开即视为一次「打开 DSH」：超过 30 分钟未检查就顺带重查一次）
      if (req.method === "GET") {
        if (Date.now() - selfUpdateState.checkedAt > 30 * 60 * 1000) {
          checkSelfUpdate().catch(() => {});
        }
        return json(res, 200, selfUpdateState);
      }
      // POST：执行更新（v1.4.7）——克隆最新仓库并原子替换本体，重启 DSH 生效
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      if (installRunning !== null) return json(res, 409, { error: t(lang, "selfUpdateBusy") });
      installRunning = { self: true }; // 借用全局互斥：更新与安装都会写 profile node_modules
      try {
        const result = await doSelfUpdate();
        if (result.status === "no-update") {
          return json(res, 200, { status: "no-update", latestVersion: result.latestVersion, error: t(lang, "selfUpdateNone", { v: result.latestVersion ?? "?" }) });
        }
        pushLog(`self-update: 已更新到 v${result.installedVersion}`);
        return json(res, 200, { status: "done", installedVersion: result.installedVersion, message: t(lang, "selfUpdateCopied", { new: result.installedVersion }) });
      } catch (error) {
        const msg = String(error?.message ?? error);
        const versionFail = /staged package incomplete|Version check failed/i.test(msg);
        pushLog(`self-update: 失败 ${msg}`);
        return json(res, 500, { status: "failed", error: t(lang, versionFail ? "selfUpdateVersionFail" : "selfUpdateFail", versionFail ? { got: "?", cur: readOwnVersion() ?? "?" } : { err: msg }) });
      } finally {
        installRunning = null;
      }
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/list",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: new URL(req.url, "http://x").searchParams.get("lang") });
      if (req.method !== "GET") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      try {
        const force = new URL(req.url, "http://x").searchParams.get("refresh") === "1";
        // 适配层：移除打错 tag 的条目、补入真实插件（见 adaptor.json）
        const repos = applyAdaptorList(await getList("dsh", force));
        const profile = await scanProfilePackages();
        // 并行标注（并发上限 12），避免几百个仓库串行 stat 拖慢首屏
        // m1：按索引写入而非 push——12 个 worker 并发完成顺序不定，
        // push 会打乱 repos 原有的 Star 排序；索引写入保持原顺序。
        const flagged = new Array(repos.length);
        const workers = Math.min(12, repos.length);
        let cursor = 0;
        const worker = async () => {
          while (cursor < repos.length) {
            const idx = cursor++;
            const repo = repos[idx];
            const record = getInstalledRecord(repo.full_name);
            const slug = slugify(repo.name);
            const owner = slugify(String(repo.full_name).split("/")[0] ?? "");
            // v1.4.11：cli 类型按指令目标区分——
            //   owner/repo 形态（dsh plugin install <repo>）= 本质仓库安装 → 参与自动版本检测；
            //   npm 包名形态（dsh plugin add <pkg> / @scope/pkg）= npm 生态，版本对比无意义
            //   （实测 pi2dsh：npm 0.3.5 vs 仓库 0.10.0 永远错位）→ 不做自动检测，
            //   标记 cliNpm 由前端提供「检测更新」手动按钮（查 npm registry）。
            const cliTarget = record && record.type === "cli" ? String(record.name ?? "") : null;
            const cliNpmForm = cliTarget !== null && !/^[\w.-]+\/[\w.-]+$/.test(cliTarget);
            const versionedType = !cliNpmForm;
            let installedVersion = versionedType && record && record.version ? record.version : null;
            if (versionedType && !installedVersion) {
              // 目录名可能来自包名而非仓库名（如 dsh-plugin-marketplace vs DSH-Plugins-Marketplace），
              // 用包名映射表按仓库名/原始仓库名/索引包名查找已装版本（repository 校验防撞名）。
              const versionKeys = [slug, repo.name];
              if (repo.pkg_name) versionKeys.push(repo.pkg_name);
              if (repo.npm_pkg_name) versionKeys.push(repo.npm_pkg_name);
              const hit = await matchProfileEntry(profile, repo, versionKeys);
              installedVersion = hit && hit.version ? hit.version : null;
            }
            // v1.4.11（issue #26）：npm 型 cli 的自动升级提示以 npm 生态同源对比——
            // 已装版本读 node_modules/<npm 包>/package.json，最新版本用索引 npm_version
            // （构建期查 npm dist-tags.latest）；npm_version 缺失时留给「检测更新」手动按钮。
            if (cliNpmForm) {
              installedVersion = await readPackageVersion(join(PROFILE_NM, ...cliTarget.split("/")));
            }
            // m2：仅已装版本严格低于最新版本才提示「更新」（仓库回滚/降级不再误报）。
            // v1.3.4：latestVersion 优先取 registry 索引里的版本号（CI 每 2 小时刷新，
            // 真实反映仓库最新版）；旧实现只读本地安装缓存——缓存只在安装动作时重建，
            // 导致手动安装的插件永远不提示更新、正常安装的插件也发现不了新版本。
            const latestVersion = cliNpmForm
              ? (repo.npm_version ?? null)
              : (repo.version ?? (await readPackageVersion(join(CACHE_DIR, `${owner}__${slug}`))));
            // m2：仅已装版本严格低于最新版本才提示「更新」（仓库回滚/降级不再误报）
            const updateAvailable = Boolean(installedVersion && latestVersion && compareVersions(installedVersion, latestVersion) < 0);
            flagged[idx] = Object.assign({}, repo, {
              installed: await detectInstalled(repo),
              installedVersion,
              latestVersion,
              updateAvailable,
              // npm 型 cli 已安装 → 前端显示「检测更新」手动按钮（v1.4.11）
              cliNpm: cliNpmForm
            });
          }
        };
        await Promise.all(Array.from({ length: workers }, () => worker()));
        // pkg_name 冲突消解放到已安装识别之后：同一 pkg_name 在 node_modules 的安装目标互斥
        // （同目录互相覆盖），列表只保留一个——已安装的优先（含用户手动安装的低 Star 仓库，
        // detectInstalled 已按 profile/repository 匹配标记），否则保留 Star 高者。
        const { repos: deduped, dropped } = dedupeReposByPkgName(flagged, (r) => r.installed === true);
        // 排序：已安装置顶，其余按 Star 数从高到低
        deduped.sort((a, b) => {
          if (a.installed !== b.installed) return a.installed ? -1 : 1;
          return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
        });
        json(res, 200, { repos: deduped, cached_at: listCaches.dsh.at, total: deduped.length, dropped: dropped.length, source: listCaches.dsh.source ?? "registry" });
      } catch (error) {
        json(res, 500, { error: t(lang, "listFail", { err: String(error?.message ?? error) }) });
      }
    }
  });

  // 通用 Skills 栏目：数据来自 skills.json（CI 全量索引，含 has_skill / has_install_script 探测）。
  // 安装复用 /api/marketplace/install（skill 类型分支），本路由只做列表 + 已安装标注。
  // #14：支持服务端分页与搜索下推——?page=&pageSize=&q= 时返回单页（仅标注当前页）；
  // 不带参数时保持全量返回（旧客户端兼容）。
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/skills",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: new URL(req.url, "http://x").searchParams.get("lang") });
      if (req.method !== "GET") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      try {
        const params = new URL(req.url, "http://x").searchParams;
        const force = params.get("refresh") === "1";
        const q = (params.get("q") ?? "").trim().toLowerCase();
        const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
        const pageSize = Math.min(200, Math.max(1, Number(params.get("pageSize") ?? "100") || 100));
        const paged = params.has("page") || params.has("pageSize") || params.has("q");
        const repos = await getList("skills", force);
        // 过滤：has_skill !== false 才进栏目（true 与 null 都显示，null 由前端弱化「未验证」）
        let list = repos.filter((r) => r.has_skill !== false);
        // #14：搜索下推服务端（名称/全名/标签/简介）
        if (q) {
          list = list.filter((r) =>
            (r.name + " " + r.full_name + " " + (r.topics || []).join(" ") + " " + (r.description || "")).toLowerCase().includes(q)
          );
        }
        if (!paged) {
          // 全量模式：已安装标注（并发池）+ 已安装置顶（旧行为）
          const flagged = new Array(list.length);
          const workers = Math.min(12, list.length);
          let cursor = 0;
          const flagWorker = async () => {
            while (cursor < list.length) {
              const idx = cursor++;
              const repo = list[idx];
              const record = getInstalledRecord(repo.full_name);
              flagged[idx] = Object.assign({}, repo, {
                installed: await detectSkillInstalled(repo),
                installedAt: record && record.installedAt ? record.installedAt : null
              });
            }
          };
          await Promise.all(Array.from({ length: workers }, () => flagWorker()));
          const { repos: deduped, dropped } = dedupeReposByPkgName(flagged, (r) => r.installed === true);
          deduped.sort((a, b) => {
            if (a.installed !== b.installed) return a.installed ? -1 : 1;
            return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
          });
          json(res, 200, { repos: deduped, cached_at: listCaches.skills.at, total: deduped.length, filtered: list.length, dropped: dropped.length, source: listCaches.skills.source ?? "registry" });
          return;
        }
        // 分页模式：去重 + Star 降序后切片，仅标注当前页（≤200 项）
        const { repos: deduped, dropped } = dedupeReposByPkgName(list);
        deduped.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
        const total = deduped.length;
        const start = (page - 1) * pageSize;
        const slice = deduped.slice(start, start + pageSize);
        const flagged = [];
        const workers = Math.min(12, slice.length);
        let cursor = 0;
        const flagWorker = async () => {
          while (cursor < slice.length) {
            const idx = cursor++;
            const repo = slice[idx];
            const record = getInstalledRecord(repo.full_name);
            flagged[idx] = Object.assign({}, repo, {
              installed: await detectSkillInstalled(repo),
              installedAt: record && record.installedAt ? record.installedAt : null
            });
          }
        };
        await Promise.all(Array.from({ length: workers }, () => flagWorker()));
        json(res, 200, {
          repos: flagged, cached_at: listCaches.skills.at,
          total, page, pageSize, filtered: list.length,
          dropped: dropped.length, source: listCaches.skills.source ?? "registry"
        });
      } catch (error) {
        json(res, 500, { error: t(lang, "listFail", { err: String(error?.message ?? error) }) });
      }
    }
  });

  // ── 备份 / 恢复（#15）──
  // 备份内容 = installed.json 的完整安装记录（repo/type/names/version）。
  // 环境变量材料从不持久化（安装时仅作为子进程 env 传入），因此备份天然不含密钥。
  // 恢复 = 客户端拿「未安装清单」走正常安装流程（材料确认/构建确认照常弹出）。
  // WebDAV 仅支持 http(s) 地址（PUT/GET + 可选 Basic 认证）；URL 协议校验防 SSRF。
  const buildBackup = () => {
    const repos = [...installedMap.entries()]
      .map(([key, r]) => ({
        repo: installedKey(key),
        type: r.type ?? null,
        name: r.name ?? null,
        names: Array.isArray(r.names) && r.names.length > 0 ? r.names : null,
        version: r.version ?? null,
        installedAt: r.installedAt ?? null
      }))
      .filter((r) => typeof r.repo === "string" && r.repo.length > 0)
      .sort((a, b) => (a.installedAt ?? 0) - (b.installedAt ?? 0));
    return { app: "dsh-plugin-marketplace", appVersion: readOwnVersion(), exportedAt: new Date().toISOString(), repos };
  };
  const isValidBackup = (b) => b && typeof b === "object" && Array.isArray(b.repos)
    && b.repos.every((r) => r && typeof r.repo === "string");
  const diffBackup = (backup) => {
    const missing = [];
    const already = [];
    for (const rec of backup.repos) {
      (hasInstalledRecord(rec.repo) ? already : missing).push(rec);
    }
    return { missing, already };
  };
  const safeWebdavUrl = (url) => /^https?:\/\//i.test(String(url ?? "").trim());

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/backup",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "GET") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      const backup = buildBackup();
      if (backup.repos.length === 0) return json(res, 200, { status: "done", backup, log: [t(lang, "backupEmpty")] });
      return json(res, 200, { status: "done", backup, log: [t(lang, "backupDone", { n: backup.repos.length })] });
    }
  });

  // 恢复差异：给定备份，返回未安装（需走安装流程）与已安装（跳过）清单。
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/restore/diff",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      let body;
      try { body = await readJsonBody(req); } catch (error) { return json(res, error.status ?? 400, { error: error.message }); }
      if (!isValidBackup(body?.backup)) return json(res, 400, { error: t(lang, "badBackup") });
      const { missing, already } = diffBackup(body.backup);
      const log = missing.length === 0
        ? [t(lang, "restoreDiffNone")]
        : [t(lang, "restoreDiff", { n: missing.length, m: already.length })];
      return json(res, 200, { status: "done", missing: missing.map((r) => r.repo), already: already.map((r) => r.repo), log });
    }
  });

  // 备份推送到 WebDAV（PUT JSON；Basic 认证可选）。
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/backup/webdav",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      let body;
      try { body = await readJsonBody(req); } catch (error) { return json(res, error.status ?? 400, { error: error.message }); }
      const url = String(body?.url ?? "").trim();
      if (!safeWebdavUrl(url)) return json(res, 400, { error: t(lang, "webdavBadUrl") });
      const backup = isValidBackup(body?.backup) ? body.backup : buildBackup();
      try {
        const headers = { "Content-Type": "application/json", "User-Agent": "dsh-plugin-marketplace" };
        if (body?.username) {
          headers["Authorization"] = "Basic " + Buffer.from(`${body.username}:${body.password ?? ""}`).toString("base64");
        }
        const res2 = await fetch(url, { method: "PUT", headers, body: JSON.stringify(backup), signal: AbortSignal.timeout(30000) });
        if (!res2.ok && res2.status !== 201 && res2.status !== 204) throw new Error(`HTTP ${res2.status}`);
        return json(res, 200, { status: "done", count: backup.repos.length, log: [t(lang, "webdavPushOk")] });
      } catch (error) {
        return json(res, 200, { status: "failed", error: String(error?.message ?? error), log: [t(lang, "webdavFail", { err: String(error?.message ?? error) })] });
      }
    }
  });

  // 从 WebDAV 拉取备份并返回恢复差异。
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/restore/webdav",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      let body;
      try { body = await readJsonBody(req); } catch (error) { return json(res, error.status ?? 400, { error: error.message }); }
      const url = String(body?.url ?? "").trim();
      if (!safeWebdavUrl(url)) return json(res, 400, { error: t(lang, "webdavBadUrl") });
      try {
        const headers = { "User-Agent": "dsh-plugin-marketplace", Accept: "application/json" };
        if (body?.username) {
          headers["Authorization"] = "Basic " + Buffer.from(`${body.username}:${body.password ?? ""}`).toString("base64");
        }
        const res2 = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30000) });
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
        const backup = await res2.json();
        if (!isValidBackup(backup)) return json(res, 400, { error: t(lang, "badBackup") });
        const { missing, already } = diffBackup(backup);
        const log = missing.length === 0
          ? [t(lang, "restoreDiffNone")]
          : [t(lang, "restoreDiff", { n: missing.length, m: already.length })];
        return json(res, 200, { status: "done", missing: missing.map((r) => r.repo), already: already.map((r) => r.repo), log });
      } catch (error) {
        return json(res, 200, { status: "failed", error: String(error?.message ?? error), log: [t(lang, "webdavFail", { err: String(error?.message ?? error) })] });
      }
    }
  });

  // 导出脱敏日志（排查问题用）：只含本插件近期操作记录，主目录路径与密钥形态已打码。
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/logs",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "GET") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      const lines = sanitizeLog(recentLogs.join("\n"));
      return json(res, 200, { status: "done", text: lines, count: recentLogs.length, log: [t(lang, "logsExported", { n: recentLogs.length })] });
    }
  });

  // ── 安装反馈：待确认队列（打开市场时前端拉取，弹窗询问「是否正常安装并运行」）──
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/feedback/pending",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "GET") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      return json(res, 200, { status: "done", pending: pendingFeedback });
    }
  });

  // ── 安装反馈：提交（正常/异常 + 备注）→ 同步 GitHub issue；无论结果如何都移出队列 ──
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/feedback",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return json(res, error.status === 413 ? 413 : 400, {
          error: t(lang, error.status === 413 ? "bodyTooLarge" : "badRequest")
        });
      }
      const repo = typeof body.repo === "string" ? body.repo.trim() : "";
      const ok = body.ok === true;
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
      if (!repo) return json(res, 400, { error: t(lang, "badRepo") });
      const idx = pendingFeedback.findIndex((f) => f.repo === repo);
      if (idx === -1) return json(res, 200, { status: "done", issueUrl: null, error: t(lang, "feedbackNotFound") });
      const [entry] = pendingFeedback.splice(idx, 1);
      await saveFeedback();
      const sync = await submitFeedbackToGitHub(entry, ok, note);
      // 同步失败也返回 200：反馈已本地记录（issueUrl 为 null 时前端提示用户手动处理）
      return json(res, 200, { status: "done", ...sync });
    }
  });

  // ── 安装反馈：GitHub Token 配置（可选；配置后自动创建 issue，否则预填链接手动提交）──
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/feedback/token",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      if (req.method === "GET") return json(res, 200, { status: "done", hasToken: Boolean(feedbackToken) });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return json(res, error.status === 413 ? 413 : 400, {
          error: t(lang, error.status === 413 ? "bodyTooLarge" : "badRequest")
        });
      }
      const token = typeof body.token === "string" ? body.token.trim() : "";
      feedbackToken = token;
      await saveFeedback();
      return json(res, 200, { status: "done", hasToken: Boolean(token) });
    }
  });

  // ── 已安装插件 env 编辑（issue #18）：读取可配置的键名（值不回显）──
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/env-keys",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "GET") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      const params = new URL(req.url, "http://x").searchParams;
      const repo = String(params.get("repo") ?? "").trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(res, 400, { error: t(lang, "badRepo") });
      const record = getInstalledRecord(repo);
      if (!record) return json(res, 200, { status: "done", repo, envKeys: [], configured: {} });
      let keys = Array.isArray(record.envKeys) ? record.envKeys : [];
      // 老安装记录（v1.4.3 之前）没有 envKeys 字段：从已安装的包目录重新扫描
      // （README/package.json/.env 里的 API KEY 形态键名），避免「编辑」空手而归。
      if (keys.length === 0 && typeof record.location === "string" && record.location.length > 0) {
        try {
          keys = await scanRequirements(record.location);
        } catch { /* 目录不可读：保持空 */ }
      }
      const stored = envStore[repo] ?? {};
      const configured = {};
      for (const k of keys) configured[k] = Boolean(stored[k]);
      return json(res, 200, { status: "done", repo, envKeys: keys, configured });
    }
  });

  // ── npm 型 cli 插件手动版本检测（v1.4.11）：查 npm registry 最新版对比已装版本 ──
  // 适用：安装记录 type=cli 且指令目标是 npm 包名（非 owner/repo）——npm 生态版本与
  // GitHub 仓库 version 无同步保证，自动检测必然误报（pi2dsh 案例），改由用户手动触发。
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/check-update",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return json(res, 400, { error: t(lang, "badRequest") });
      }
      const repo = typeof body.repo === "string" ? body.repo.trim() : "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(res, 400, { error: t(lang, "badRepo") });
      const record = getInstalledRecord(repo);
      if (!record || record.type !== "cli") return json(res, 404, { error: t(lang, "notInstalled") });
      const pkgName = String(record.name ?? "");
      if (/^[\w.-]+\/[\w.-]+$/.test(pkgName)) return json(res, 400, { error: t(lang, "checkUpdateNotNpm") });
      // 已装版本：node_modules/<pkgName>/package.json（scoped 包按 @scope/name 拆目录）
      const pkgDir = join(PROFILE_NM, ...String(pkgName).split("/"));
      const installedVersion = await readPackageVersion(pkgDir);
      if (!installedVersion) {
        return json(res, 200, { status: "done", installedVersion: null, latestVersion: null, updateAvailable: false, error: t(lang, "checkUpdateNoPkg") });
      }
      // 最新版本：npm registry（npmmirror 优先，npmjs 兜底）
      const latestVersion = await fetchNpmLatest(pkgName);
      if (!latestVersion) {
        return json(res, 200, { status: "done", installedVersion, latestVersion: null, updateAvailable: false, error: t(lang, "checkUpdateNpmFail") });
      }
      pushLog(`check-update ${repo}: 已装 ${installedVersion} / npm latest ${latestVersion}`);
      return json(res, 200, {
        status: "done",
        repo,
        installedVersion,
        latestVersion,
        updateAvailable: compareVersions(installedVersion, latestVersion) < 0
      });
    }
  });

  // ── 已安装插件 env 编辑：保存值 → envs.json + ~/.dsh/.env（重启生效）──
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/env-edit",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return json(res, error.status === 413 ? 413 : 400, {
          error: t(lang, error.status === 413 ? "bodyTooLarge" : "badRequest")
        });
      }
      const repo = typeof body.repo === "string" ? body.repo.trim() : "";
      const values = body.values && typeof body.values === "object" ? body.values : {};
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(res, 400, { error: t(lang, "badRepo") });
      const record = getInstalledRecord(repo);
      if (!record) return json(res, 404, { error: t(lang, "notInstalled") });
      const keys = Object.keys(values);
      if (keys.length > 16) return json(res, 400, { error: t(lang, "tooManyEnvKeys") });
      const bad = keys.filter((k) => !isValidEnvKey(k));
      if (bad.length > 0) return json(res, 400, { error: t(lang, "badEnvKey", { key: bad[0] }) });
      try {
        const { applied } = await applyEnvEdit(repo, values);
        if (applied.length === 0) return json(res, 400, { error: t(lang, "noEnvApplied") });
        return json(res, 200, { status: "done", applied, restartRequired: true });
      } catch (error) {
        return json(res, 500, { error: String(error?.message ?? error) });
      }
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/install",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      // CSRF / DNS rebinding 防护：跨站请求无法携带自定义头；Host 必须在白名单内
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return json(res, error.status === 413 ? 413 : 400, {
          error: t(lang, error.status === 413 ? "bodyTooLarge" : "badRequest")
        });
      }
      const langFull = langOf(req, body);
      const repo0 = typeof body.repo === "string" ? body.repo.trim() : "";
      const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo0)) return json(res, 400, { error: t(langFull, "badRepo") });
      // 适配层：命中硬编码重定向（打错 tag 的独立软件等）→ 安装真实插件仓库，避免崩溃。
      // M5（KIMI 审阅）：重定向必须在安装日志中明示，避免用户以为装的是点击的那个仓库。
      const redirected = adaptorRedirectRepo(repo0);
      const repo = redirected ?? repo0;
      // 全局互斥：任何安装进行中时拒绝新的安装请求（客户端按钮也会同步禁用，这里是最终防线）
      if (installRunning !== null) return json(res, 409, { error: t(langFull, "installBusy") });
      const task = (async () => {
        const log = [];
        const logLine = (line) => { log.push(line); pushLog(`install ${repo}: ${line}`); };
        let cacheDir = null;
        try {
          if (redirected) logLine(t(langFull, "adaptorRedirected", { from: repo0, to: redirected }));
          const [owner, repoName] = repo.split("/");
          cacheDir = join(CACHE_DIR, `${slugify(owner)}__${slugify(repoName)}`);
          logLine(t(langFull, "step1", { repo }));
          await mkdir(CACHE_DIR, { recursive: true });
          // 克隆缓存复用：awaiting-input 回环（提交材料/确认，秒级间隔）不重复克隆——
          // 此前每次提交确认都会 rm + 重新克隆，二次网络克隆耗时可能很长，
          // 期间客户端面板停留在「运行中」且无关闭按钮（表现为卡死的安装对话框）。
          // 缓存存在且新鲜（≤15 分钟）直接复用；失败/中止/过期缓存仍会重建。
          let cacheReuse = false;
          try {
            const st = await stat(cacheDir);
            cacheReuse = st.isDirectory() && Date.now() - st.mtimeMs < CACHE_REUSE_MS;
          } catch { /* 缓存不存在：正常克隆 */ }
          if (cacheReuse) {
            logLine(t(langFull, "cacheReuse"));
          } else {
            await rm(cacheDir, { recursive: true, force: true });
            await execFileAsync("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, cacheDir], { timeout: 180000 });
            logLine(t(langFull, "cloneDone"));
            // #10：含 git submodule 的仓库（如 oh-dsh 的 upstream/*）克隆后子模块是空目录，
            // 构建引用子模块源码（upstream/<pkg>/src/index.ts）必然失败——递归拉取。
            // 仅当 .gitmodules 存在时执行（99% 的仓库无子模块，省一次进程开销）；
            // 地址先过安全校验（仅 https / 相对路径），并显式禁止 file 协议兜底。
            if (await exists(join(cacheDir, ".gitmodules"))) {
              const gm = await readFile(join(cacheDir, ".gitmodules"), "utf8").catch(() => "");
              const { unsafe } = parseGitmodulesUrls(gm);
              if (unsafe.length > 0) throw new Error(t(langFull, "submoduleUnsafe", { urls: unsafe.join(", ") }));
              await execFileAsync("git", ["-c", "protocol.file.allow=never", "submodule", "update", "--init", "--recursive", "--depth", "1"], { cwd: cacheDir, timeout: 180000 });
              logLine(t(langFull, "submoduleDone"));
            }
          }

          // README 官方 CLI 安装指令：README 提供了 `dsh plugin install/add` 指令时
          // 直接使用官方安装方式（dsh CLI），失败自动回退市场常规流程。
          const cliCommand = await scanCliInstallHint(cacheDir, repo);
          const externalCliHint = cliCommand ? null : await scanExternalCliHint(cacheDir);
          const cliInstall = await findCliInstall(cacheDir, repo);
          if (cliCommand) logLine(t(langFull, "cliHint", { cmd: cliCommand }));
          if (externalCliHint) logLine(t(langFull, "externalCliHint", { cli: externalCliHint.cli, cmd: externalCliHint.command }));
          if (cliInstall) {
            logLine(t(langFull, "cliExec", { cmd: cliInstall.command }));
            try {
              const cliEnv = buildFilteredEnv();
              // v1.4.11：更新场景（已有安装记录）且目标是 npm 包名——用显式 @latest 升级：
              // `dsh plugin add <pkg>` 不会升级 profile/package.json 已锁定的版本范围
              // （实测 ^0.3.5 锁死后重装仍装 0.3.5），必须带显式版本号才真正升级。
              let target = cliInstall.target;
              if (getInstalledRecord(repo) && !/^[\w.-]+\/[\w.-]+$/.test(target)) {
                const npmLatest = await fetchNpmLatest(target);
                if (npmLatest) {
                  target = `${target}@${npmLatest}`;
                  logLine(t(langFull, "cliUpdateTo", { target, version: npmLatest }));
                }
              }
              const args = ["plugin", "--profile", "web", cliInstall.verb === "add" ? "add" : "install", target];
              if (process.platform === "win32") {
                // dsh 是 .cmd 垫片：execFile 无法直接启动，走 cmd.exe（与 runPnpm 同款处理）
                const cmdLine = "dsh " + args.map((a) => /[^\w@/.\-]/.test(a) ? '"' + a + '"' : a).join(" ");
                await execFileAsync("cmd.exe", ["/d", "/s", "/c", cmdLine], { cwd: cacheDir, env: cliEnv, timeout: 600000 });
              } else {
                await execFileAsync("dsh", args, { cwd: cacheDir, env: cliEnv, timeout: 600000 });
              }
              logLine(t(langFull, "cliDone"));
              await saveInstalled(repo, { type: "cli", name: cliInstall.target, names: null, location: null, version: null, installedAt: Date.now(), envKeys: null });
              await queueFeedback({ repo, name: cliInstall.target, type: "cli", version: null, installedAt: Date.now() }).catch(() => {});
              logLine(t(langFull, "feedbackQueued"));
              if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
              return json(res, 200, { status: "done", repo, installed: true, type: "cli", name: cliInstall.target, cliCommand: cliInstall.command, latestVersion: null, log });
            } catch (error) {
              logLine(t(langFull, "cliFailFallback", { err: String(error?.message ?? error).slice(0, 200) }));
              // 回退：继续走市场常规安装流程（克隆缓存仍在，detectType 照常执行）
            }
          }

          const type = await detectType(cacheDir);
          logLine(t(langFull, "step2", { type: t(langFull, `type.${type}`) }));

          // 多插件根（皮肤/多包仓库）：cordis-plugin 时找出全部插件清单所在目录；
          // 无子包根（含根目录清单本身就是插件的情况）→ 只装根目录一个（原行为）。
          const pluginRoots = type === "cordis-plugin" ? await findPluginRoots(cacheDir) : [];
          const pkgDirs = pluginRoots.length > 0 ? pluginRoots : [cacheDir];

          // R3：键存在即视为「已提供（空值=跳过）」，未提供的键才继续要材料；
          // scannedVars 是完整扫描列表，后续作为 env 注入的白名单（不能只传过滤后的缺失项，
          // 否则用户已提交的键反而不在 allowedAnswers 里，插件拿不到密钥）。
          // Skills and presets only copy files. README examples are not install-time API requirements.
          const scannedVars = ["script", "cordis-plugin"].includes(type)
            ? [...new Set((await Promise.all(pkgDirs.map((d) => scanRequirements(d)))).flat())].slice(0, 8)
            : [];
          const required = scannedVars.filter((v) => !(v in answers));
          logLine(t(langFull, "step3", { list: required.length === 0 ? t(langFull, "none") : required.join(", ") }));
          if (required.length > 0) {
            logLine(t(langFull, "awaiting"));
            return json(res, 200, {
              status: "awaiting-input",
              repo, type,
              questions: required.map((v) => ({
                id: v,
                header: t(langFull, "qEnvHeader", { repo, v }),
                question: t(langFull, "qEnv", { v })
              })),
              log
            });
          }

          if (type === "script" && answers.__confirm_script__ === void 0) {
            logLine(t(langFull, "scriptDetected"));
            return json(res, 200, {
              status: "awaiting-input",
              repo, type,
              questions: [{
                id: "__confirm_script__",
                header: t(langFull, "qScriptHeader"),
                question: t(langFull, "qScript", { repo }),
                options: [
                  { value: "continue", label: t(langFull, "optContinue"), description: t(langFull, "optContinueDesc") },
                  { value: "cancel", label: t(langFull, "optCancel"), description: t(langFull, "optCancelDesc") }
                ]
              }],
              log
            });
          }
          if (type === "script" && String(answers.__confirm_script__) !== "continue") {
            logLine(t(langFull, "scriptCancelled"));
            return json(res, 200, { status: "aborted", repo, type, log });
          }

          // npm 生命周期脚本确认：cordis 插件若含 prepare/install/postinstall 等脚本，
          // 执行前必须征求用户同意（拒绝则取消安装并清空全部痕迹）。多插件根逐个汇总。
          if (type === "cordis-plugin" && answers.__confirm_npm_scripts__ === void 0) {
            const scripts = [...new Set((await Promise.all(pkgDirs.map((d) => readLifecycleScripts(d)))).flat())];
            if (scripts.length > 0) {
              logLine(t(langFull, "npmScriptsDetected", { scripts: scripts.join(", ") }));
              return json(res, 200, {
                status: "awaiting-input",
                repo, type,
                questions: [{
                  id: "__confirm_npm_scripts__",
                  header: t(langFull, "qNpmScriptsHeader"),
                  question: t(langFull, "qNpmScripts", { repo, scripts: scripts.join(", ") }),
                  options: [
                    { value: "allow", label: t(langFull, "optAllow"), description: t(langFull, "optAllowDesc") },
                    { value: "deny", label: t(langFull, "optDeny"), description: t(langFull, "optDenyDesc") }
                  ]
                }],
                log
              });
            }
          }
          if (type === "cordis-plugin" && String(answers.__confirm_npm_scripts__) === "deny") {
            // 用户拒绝执行第三方 npm 脚本：清理克隆缓存等全部痕迹后取消
            if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
            logLine(t(langFull, "npmScriptsDenied"));
            return json(res, 200, { status: "aborted", repo, type, log });
          }

          // 非插件仓库确认：有 package.json 但未声明 DSH 插件能力（无 dsh 字段、未依赖 DSH 核心包）。
          // dsh-plugin topic 里混有聚合页 / 桌面应用 / 普通 npm 项目（如 awesome-*、iPolloWork），
          // 直接装进 web profile 只会得到坏包——弹窗告知可自行安装，防止盲装。
          // 多插件根（皮肤仓库）已逐个校验清单，跳过本确认。
          if (type === "cordis-plugin" && pluginRoots.length === 0 && answers.__confirm_non_plugin__ === void 0) {
            const looksLike = await looksLikeDshPlugin(await readPackageJsonObject(cacheDir));
            if (looksLike === false) {
              logLine(t(langFull, "nonPluginDetected"));
              return json(res, 200, {
                status: "awaiting-input",
                repo, type,
                questions: [{
                  id: "__confirm_non_plugin__",
                  header: t(langFull, "qNonPluginHeader"),
                  question: t(langFull, "qNonPlugin", { repo, url: `https://github.com/${repo}` }),
                  options: [
                    { value: "continue", label: t(langFull, "optNonPluginContinue"), description: t(langFull, "optNonPluginContinueDesc") },
                    { value: "cancel", label: t(langFull, "optNonPluginCancel"), description: t(langFull, "optNonPluginCancelDesc") }
                  ]
                }],
                log
              });
            }
          }
          if (type === "cordis-plugin" && String(answers.__confirm_non_plugin__) === "cancel") {
            if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
            logLine(t(langFull, "nonPluginCancelled"));
            return json(res, 200, { status: "aborted", repo, type, log });
          }

          // 源码型插件确认：只提交源码（main / client bundle 缺失）的仓库必须先构建才能加载，
          // 否则装完 DSH 直接无法启动（MODULE_NOT_FOUND / client bundle 缺失）。
          // 构建会安装依赖并执行第三方构建脚本，执行前必须征求用户同意（拒绝则取消并清理）。
          // 多插件根：任一子包需要构建即触发确认（构建在 installRepo 中按需执行）。
          if (type === "cordis-plugin" && answers.__confirm_build__ === void 0) {
            const needBuild = (await Promise.all(pkgDirs.map((d) => needsPluginBuild(d)))).some(Boolean);
            if (needBuild) {
              logLine(t(langFull, "buildDetected"));
              return json(res, 200, {
                status: "awaiting-input",
                repo, type,
                questions: [{
                  id: "__confirm_build__",
                  header: t(langFull, "qBuildHeader"),
                  question: t(langFull, "qBuild", { repo }),
                  options: [
                    { value: "allow", label: t(langFull, "optAllowBuild"), description: t(langFull, "optAllowBuildDesc") },
                    { value: "deny", label: t(langFull, "optDenyBuild"), description: t(langFull, "optDenyBuildDesc") }
                  ]
                }],
                log
              });
            }
          }
          if (type === "cordis-plugin" && String(answers.__confirm_build__) === "deny") {
            if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
            logLine(t(langFull, "buildDenied"));
            return json(res, 200, { status: "aborted", repo, type, log });
          }

          // 手动安装确认：仓库不含 SKILL.md / agent 预设 / 安装脚本 / 插件清单（如 awesome 聚合页），
          // 无法一键安装——弹窗展示 README 摘要与仓库链接，由用户自行处理。
          if (type === "instructions" && answers.__confirm_manual__ === void 0) {
            const readme = await readFile(join(cacheDir, "README.md"), "utf8").catch(() => "");
            logLine(t(langFull, "manualDetected"));
            return json(res, 200, {
              status: "awaiting-input",
              repo, type,
              questions: [{
                id: "__confirm_manual__",
                header: t(langFull, "qManualHeader"),
                question: t(langFull, "qManual", {
                  repo,
                  url: `https://github.com/${repo}`,
                  readme: (readme || t(langFull, "noReadme")).slice(0, 800)
                }),
                options: [{ value: "cancel", label: t(langFull, "optManualCancel"), description: t(langFull, "optManualCancelDesc") }]
              }],
              log
            });
          }
          if (type === "instructions" && String(answers.__confirm_manual__) === "cancel") {
            if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
            logLine(t(langFull, "manualCancelled"));
            return json(res, 200, { status: "aborted", repo, type, log });
          }

        logLine(t(langFull, "step4"));
        const result = await installRepo({ type, cacheDir, repo, log, answers, logLine, lang: langFull, envAllowList: scannedVars });
        logLine(t(langFull, "step5"));
        let installed = false;
        if (result && ["skill", "agent-preset", "cordis-plugin", "script"].includes(result.type)) {
          await saveInstalled(repo, {
            type: result.type,
            name: result.name ?? null,
            names: Array.isArray(result.names) && result.names.length > 0 ? result.names : null,
            location: result.location ?? null,
            version: result.version ?? null,
            installedAt: Date.now(),
            envKeys: scannedVars.length > 0 ? scannedVars : null
          });
          await queueFeedback({ repo, name: result.name ?? repo, type: result.type, version: result.version ?? null, installedAt: Date.now() }).catch(() => {});
          logLine(t(langFull, "feedbackQueued"));
          installed = true;
        }
        const latestVersion = await readPackageVersion(cacheDir);
        // instructions（无可自动安装内容，如 awesome 聚合页）绝不伪装成「安装完成」：
        // 返回专用状态 manual，客户端明确提示无法一键安装、请自行处理；清理克隆缓存
        //（instructions 类型不会用于版本检测，留着只会占空间）。
        if (result && result.type === "instructions") {
          if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
          return json(res, 200, {
            status: "manual", repo, type: "instructions",
            url: `https://github.com/${repo}`,
            ...(cliCommand ? { cliCommand } : {}),
            log
          });
        }
        return json(res, 200, { status: "done", repo, installed, latestVersion, ...result, ...(cliCommand ? { cliCommand } : {}), log });
      } catch (error) {
        // 清理失败安装留下的缓存克隆，避免残留目录导致「已安装」误判
        if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
        const errText = [error?.message, error?.stderr].filter(Boolean).join("\n");
        const hint = classifyInstallFailure(errText, langFull);
        logLine(t(langFull, "fail", { err: String(error?.message ?? error) }));
        if (hint) logLine(hint);
        return json(res, 200, { status: "failed", repo, log, error: hint ? `${String(error?.message ?? error)}\n\n${hint}` : String(error?.message ?? error) });
      }
      })();
      installRunning = task;
      try {
        return await task;
      } finally {
        installRunning = null;
      }
    }
  });

  // 卸载：删除已安装的文件与写入的配置（skill/agent 预设直接删目录；
  // cordis 插件删包目录 + cordis.patch.yml 注册条目；多插件仓库按记录的子包名逐个删除）。
  // 与安装共用全局互斥：卸载进行中拒绝新的安装/卸载请求。
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/uninstall",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return json(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return json(res, error.status ?? 400, { error: error.message });
      }
      const repo = normalizeRepoRef(String(body?.repo ?? ""));
      if (!repo) return json(res, 400, { error: t(lang, "badRepo") });
      if (installRunning !== null) return json(res, 409, { error: t(lang, "installBusy") });
      const task = (async () => {
        const log = [];
        const logLine = (line) => { log.push(line); pushLog(`uninstall ${repo}: ${line}`); };
        const record = getInstalledRecord(repo);
        if (!record) {
          logLine(t(lang, "uninstallNone"));
          return json(res, 200, { status: "done", repo, removed: 0, log });
        }
        logLine(t(lang, "uninstalling", { repo }));
        let removed = 0;
        try {
          if (record.type === "skill" || record.type === "agent-preset") {
            // skill / agent 预设：直接删除安装目录（location 即目标目录，且必须在受管目录内）。
            // 多预设记录（嵌套预设仓库）location 是 PRESETS_DIR 本身——必须按 names 逐个删，
            // 绝不能整体删除（会误删其他预设）。
            if (record.type === "agent-preset" && Array.isArray(record.names) && record.names.length > 0) {
              for (const presetName of record.names) {
                const target = join(PRESETS_DIR, presetName);
                if (resolve(target).startsWith(resolve(PRESETS_DIR) + sep)) {
                  await rm(target, { recursive: true, force: true }).catch(() => {});
                  removed++;
                }
              }
            } else {
              // L1 修复：多 skill / 多预设仓库安装时 location 记为 SKILLS_DIR / PRESETS_DIR 本身
              //（无尾分隔符，见 installRepo 多根分支）——此前仅前缀校验恒 false，rm 被跳过、
              // 目录残留而记录已删；精确相等（=== 目录本身）同样放行，仍受受管目录约束，无越界。
              const location = String(record.location ?? "");
              const skillsDir = resolve(SKILLS_DIR);
              const presetsDir = resolve(PRESETS_DIR);
              const loc = resolve(location);
              const insideManaged = loc === skillsDir || loc === presetsDir
                || loc.startsWith(skillsDir + sep) || loc.startsWith(presetsDir + sep);
              if (location && insideManaged) {
                await rm(location, { recursive: true, force: true }).catch(() => {});
                removed++;
              }
            }
          } else if (record.type === "cordis-plugin" || record.type === "cli") {
            // 多插件仓库按记录的子包名逐个删除；单插件用 name（包名）；旧记录退化为 location 推断。
            // cli 类型（官方 CLI 安装，如 `dsh plugin add dshmarket`）同样按包目录 + patch 条目清理。
            // L5（KIMI 审阅）：`!/-plugins$/` 是防呆——个别仓库把 record.name 存成了
            // "xxx-plugins"（仓库目录名而非包名，如聚合型仓库），直接当包目录删会误删 node_modules
            // 下不存在的路径；真实插件包名不会以 -plugins 结尾，命中则放弃该 name 走 location 推断。
            let targets = [];
            if (Array.isArray(record.names) && record.names.length > 0) {
              targets = record.names;
            } else if (typeof record.name === "string" && record.name && !/-plugins$/.test(record.name)) {
              targets = [record.name];
            }
            if (targets.length === 0 && typeof record.location === "string"
                && record.location !== PROFILE_NM
                && resolve(record.location).startsWith(resolve(PROFILE_NM) + sep)) {
              targets = [record.location.split(sep).at(-1)];
            }
            if (targets.length > 0) {
              for (const pkgName of targets) {
                const dest = join(PROFILE_NM, pkgName);
                if (resolve(dest).startsWith(resolve(PROFILE_NM) + sep)) {
                  await rm(dest, { recursive: true, force: true }).catch(() => {});
                  removed++;
                }
                await removePatchEntry(pkgName).catch(() => {});
              }
            } else {
              logLine(t(lang, "uninstallNoTargets"));
            }
          } else if (record.type === "script") {
            // 脚本型插件：自身效果无法回滚，仅移除安装记录与克隆缓存
            if (record.location) await rm(record.location, { recursive: true, force: true }).catch(() => {});
            logLine(t(lang, "uninstallScriptNote"));
          }
          await removeInstalled(repo);
          logLine(t(lang, "uninstalled"));
          return json(res, 200, { status: "done", repo, removed, log });
        } catch (error) {
          logLine(t(lang, "uninstallFail", { err: String(error?.message ?? error) }));
          return json(res, 200, { status: "failed", repo, log, error: String(error?.message ?? error) });
        }
      })();
      installRunning = task;
      try {
        return await task;
      } finally {
        installRunning = null;
      }
    }
  });
}

async function installRepo({ type, cacheDir, repo, log, answers, logLine, lang, envAllowList = [] }) {
  // R2 + M1：env 双保险——
  // 1) 只给基础系统变量（script 白名单）或剔除敏感键（npm 过滤），全量 process.env 不再外泄；
  // 2) answers 键只放行扫描确认过的环境变量名（`__` 内部键一律不进环境），
  //    防止 PATH/HOME 等任意键注入劫持子进程。
  const allowedAnswers = new Set(envAllowList);
  const env = type === "script" ? buildMinimalEnv() : buildFilteredEnv();
  for (const key of Object.keys(answers)) {
    if (key.startsWith("__")) continue;
    if (allowedAnswers.has(key)) env[key] = answers[key];
  }
  if (type === "skill") {
    const roots = await findSkillRoots(cacheDir);
    if (roots.length === 0) throw new Error("No SKILL.md was found after cloning the repository.");
    const installed = [];
    await mkdir(SKILLS_DIR, { recursive: true });
    for (const root of roots) {
      let skillName = slugify(roots.length === 1 ? repo.split("/")[1] : root.split(sep).at(-1));
      try {
        const text = await readSkillManifest(root);
        const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const m = fm && fm[1].match(/^name:\s*"?([a-z0-9][a-z0-9-]*)"?$/m);
        if (m) skillName = m[1];
      } catch { /* keep path-derived name */ }
      const dest = join(SKILLS_DIR, skillName);
      await rm(dest, { recursive: true, force: true });
      await cp(root, dest, { recursive: true, filter: copyFilter(root, true) });
      installed.push({ name: skillName, location: dest });
      logLine(t(lang, "skillInstalled", { name: skillName, dest }));
    }
    return {
      type,
      name: installed.length === 1 ? installed[0].name : `${installed.length}-skills`,
      names: installed.map((item) => item.name),
      count: installed.length,
      location: installed.length === 1 ? installed[0].location : SKILLS_DIR
    };
  }
  if (type === "agent-preset") {
    // 支持嵌套预设（预设目录在子目录，如 dsh-anchored-standard 的 preset/ + 变体目录）：
    // 逐个拷贝到 ~/.dsh/.agent-presets/<id>；id 用目录名，惯例目录名 "preset" 退化为仓库名。
    // 根目录本身是预设时 findPresetRoots 不会命中 cacheDir（detectType 已走根预设分支），
    // 此处只处理嵌套场景；两分支统一走 roots 数组。
    const repoName = repo.split("/")[1] ?? "preset";
    const roots = (await findPresetRoots(cacheDir));
    const installRoots = roots.length > 0 ? roots : [cacheDir];
    const installed = [];
    await mkdir(PRESETS_DIR, { recursive: true });
    for (const root of installRoots) {
      const base = root === cacheDir ? "" : root.split(sep).at(-1) ?? "";
      const presetId = base === "preset" || base === "" ? slugify(repoName) : slugify(base);
      const dest = join(PRESETS_DIR, presetId);
      await rm(dest, { recursive: true, force: true });
      await cp(root, dest, { recursive: true, filter: copyFilter(root, true) });
      installed.push({ name: presetId, location: dest });
      logLine(t(lang, "presetInstalled", { name: presetId, dest }));
    }
    return {
      type,
      name: installed.length === 1 ? installed[0].name : `${installed.length}-presets`,
      names: installed.map((item) => item.name),
      count: installed.length,
      location: installed.length === 1 ? installed[0].location : PRESETS_DIR
    };
  }
  if (type === "script") {
    // 按运行平台选择脚本（KIMI 审阅 H2）：Windows 优先 ps1（pwsh），其他平台优先 sh（bash），
    // 首选缺失时回退到另一种；两者都缺时给出明确报错而不是 spawn 失败。
    const isWin = process.platform === "win32";
    const hasPs1 = await exists(join(cacheDir, "install.ps1"));
    const hasSh = await exists(join(cacheDir, "install.sh"));
    const usePs1 = hasPs1 && (!hasSh || isWin);
    if (usePs1) {
      logLine(t(lang, "runPs1"));
      await execFileAsync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(cacheDir, "install.ps1")], { cwd: cacheDir, env, timeout: 600000 });
    } else if (hasSh) {
      logLine(t(lang, "runSh"));
      await execFileAsync("bash", [join(cacheDir, "install.sh")], { cwd: cacheDir, env, timeout: 600000 });
    } else {
      throw new Error(t(lang, "noScript", { repo }));
    }
    logLine(t(lang, "scriptDone", { dir: cacheDir }));
    return { type, location: cacheDir };
  }
  if (type === "cordis-plugin") {
    // 多插件根（皮肤/多包仓库）：逐个安装子目录中的插件清单；
    // 无子包根 → 只装根目录一个（原行为，含非插件确认后的强制安装路径）。
    const roots = await findPluginRoots(cacheDir);
    const scanRoots = roots.length > 0 ? roots : [cacheDir];
    const shouldBuild = String(answers.__confirm_build__) === "allow";
    const installed = [];
    const entryWarnings = [];
    for (const root of scanRoots) {
      let pkgName = slugify(root === cacheDir ? repo.split("/")[1] : root.split(sep).at(-1));
      let deps = {};
      // 源码型插件（用户已确认构建）：构建先行——完整安装依赖（含 devDependencies）并执行
      // build 脚本，产物随复制一并进入 profile；构建流程已覆盖运行时依赖，跳过单独安装。
      try {
        const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        if (typeof pkg.name === "string" && pkg.name.length > 0) pkgName = pkg.name;
        // 仅非构建路径清洗 pnpm 专用本地链接依赖（link:/workspace:）——npm 解析 manifest
        // 会报 EUNSUPPORTEDPROTOCOL；构建路径保留原样，由 pnpm 原生支持 link:/workspace:
        // （见 buildPluginPackage）。提前清洗会误删 monorepo 源码插件的构建依赖
        // （devDependencies 里的 link:/workspace:），导致 pnpm install + build 失败或产物不完整。
        if (!shouldBuild) {
          const removed = sanitizeManifest(pkg);
          if (removed.length > 0) {
            logLine(t(lang, "npmLocalDeps", { n: removed.length, names: removed.join(", ") }));
            await writeFile(join(root, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
          }
        }
        deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
      } catch { /* keep defaults */ }
      // C2：包名白名单校验（npm 命名规则），杜绝路径穿越 / 任意目录删除 / YAML 注入
      if (!PKG_NAME_PATTERN.test(pkgName)) {
        throw new Error(`非法包名: ${JSON.stringify(pkgName)}（拒绝安装）`);
      }
      const dest = join(PROFILE_NM, pkgName);
      // 双保险：解析后的目标路径必须仍在 profile node_modules 之内
      if (!resolve(dest).startsWith(resolve(PROFILE_NM) + sep)) {
        throw new Error(`目标路径越界: ${dest}（拒绝安装）`);
      }
      // 源码型插件（用户已确认构建）：构建先行——完整安装依赖（含 devDependencies）并执行
      // build 脚本，产物随复制一并进入 profile；构建流程已覆盖运行时依赖，跳过单独安装。
      if (shouldBuild && (await needsPluginBuild(root))) {
        await buildPluginPackage(root, env, logLine, lang);
        logLine(t(lang, "buildDone"));
      }
      if (!shouldBuild && Object.keys(deps).length > 0) {
        logLine(t(lang, "deps", { n: Object.keys(deps).length }));
        const allowScripts = String(answers.__confirm_npm_scripts__) === "allow";
        if (allowScripts) logLine(t(lang, "npmScriptsAllowed"));
        await npmInstallWithFallback(root, env, logLine, lang, allowScripts);
        logLine(t(lang, "depsDone"));
      }
      await mkdir(PROFILE_NM, { recursive: true });
      await rm(dest, { recursive: true, force: true });
      // cordis 插件保留 node_modules（dependencies 需要随包复制），只排除 .git
      await cp(root, dest, { recursive: true, filter: copyFilter(root, false) });
      logLine(t(lang, "copied", { dest }));
      // 安装后有效性验证：包目录需含可加载入口（main 指向的文件 / lib/index.js /
      // 任意顶层 JS / 纯 client 清单插件）。源码型仓库构建产物缺失会被明示，避免「装完没生效」。
      let entryOk = false;
      try {
        const pkgCheck = JSON.parse(await readFile(join(dest, "package.json"), "utf8"));
        const mainFile = typeof pkgCheck.main === "string" && pkgCheck.main.length > 0 ? pkgCheck.main : null;
        entryOk = Boolean(mainFile && await exists(join(dest, mainFile)))
          || (!mainFile && await exists(join(dest, "lib", "index.js")))
          || Boolean(pkgCheck.dsh && (pkgCheck.dsh.client || pkgCheck.dsh.bundle))
          || (await readdir(dest).catch(() => [])).some((f) => /\.(js|cjs|mjs)$/.test(f));
      } catch { /* 校验异常视为未知，不阻断 */ }
      if (!entryOk) {
        logLine(t(lang, "entryMissing", { name: pkgName }));
        entryWarnings.push(pkgName);
      }
      const entryId = slugify(pkgName);
      const appended = await appendPatchEntry(entryId, pkgName);
      logLine(appended ? t(lang, "patchDone", { id: entryId }) : t(lang, "patchExists"));
      const installedVersion = await readPackageVersion(dest);
      installed.push({ name: pkgName, location: dest, version: installedVersion });
    }
    return {
      type,
      name: installed.length === 1 ? installed[0].name : `${installed.length}-plugins`,
      names: installed.map((item) => item.name),
      count: installed.length,
      location: installed.length === 1 ? installed[0].location : PROFILE_NM,
      version: installed.length === 1 ? installed[0].version : null,
      ...(entryWarnings.length > 0 ? { warnings: entryWarnings } : {})
    };
  }
  const readme = await readFile(join(cacheDir, "README.md"), "utf8").catch(() => "");
  logLine(t(lang, "instructions"));
  logLine((readme || t(lang, "noReadme")).slice(0, 3000));
  return { type, instructions: true };
}

export { apply, detectInstalled, detectSkillInstalled, loadOwnRepo, scanProfilePackages, langOf, t, fetchAllRepos, fetchRegistryRepos, getList, isTrustedRequest, isTrustedHost, isSensitiveEnvKey, buildMinimalEnv, buildFilteredEnv, compareVersions, hasPatchEntry, normalizeRepo, appendPatchEntry, removePatchEntry, readLifecycleScripts, sanitizeManifest, isPnpmLocalDependency, matchProfileEntry, normalizeRepoRef, loadOfficialPackages, isOfficialPackage, readPackageSummary, findSkillRoots, findPluginRoots, findPresetRoots, detectType, parseGitmodulesUrls, scanCliInstallHint, scanExternalCliHint, findCliInstall, classifyInstallFailure, sanitizeLog, readBundledIndex, dedupeReposByPkgName, needsPluginBuild, adaptorRedirectRepo, applyAdaptorList };
