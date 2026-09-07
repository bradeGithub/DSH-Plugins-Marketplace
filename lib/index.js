import {
  extractEnvNames,
  findHostShadowDeps,
  classifyScriptHazards,
  lifecycleScriptTargets,
  classifyLifecycleHazards,
  parseLockfileVersions,
  readVulnScanDeps,
  filterVulnerabilityHits,
  isSecretScanFile,
  isSecretScanSkipDir,
  SECRET_SCAN_MAX_FILES,
  SECRET_SCAN_MAX_FILE_BYTES,
  CVE_MAX_QUERIES,
} from "./domain/security-scan.js";
import { createSecurityScanAdapter } from "./infra/security-scan.js";
import { json, readJsonBody, responseTooLarge, readBodyLimited, MAX_BODY_BYTES, MAX_RESPONSE_BYTES } from "./http/request.js";
import { createAuth } from "./http/auth.js";
import { isSensitiveEnvKey, isBootstrapOnlyEnvKey, isValidEnvKey, isTrustedHost, hasPatchEntry, hasDshPluginDeclaration, isBundlePackage, compareVersions, comparePre, shouldUpdate, isPnpmLocalDependency, safeAssign } from "./domain/validation.js";
import { slugify, normalizeRepoRef, normalizeRepo, wslPosixPath } from "./domain/normalize.js";
import { t, langOf } from "./domain/i18n.js";
import { PROFILE_NAME_RE, profileName, profileDir, profileNodeModules, profilePatchFile, profilePackageFile, onProfileChange, readTargetProfile, setTargetProfile, getProfileNodeModules, resolveRecordNodeModules } from "./domain/profile.js";
import { dedupeReposByPkgName } from "./domain/list.js";
import { readStateJson } from "./infra/store.js";
import { MAX_EXEC_BUFFER, probe as probeProc, runDsh as runDshProc, runGit as runGitProc, runNpm as runNpmProc, runPnpm as runPnpmProc, runScript as runScriptProc } from "./infra/proc.js";
import { createMutex, createQueue } from "./infra/queue.js";
import { createPatchManifestAdapter } from "./infra/patch-manifest.js";
import { createBundleRegisterAdapter } from "./infra/bundle-register.js";
import { createRegistryCacheAdapter } from "./infra/registry-cache.js";
import { createProfileScanAdapter } from "./infra/profile-scan.js";
import { createRepositoryScanAdapter } from "./infra/repository-scan.js";
import { createAdaptorAdapter } from "./infra/adaptor.js";
import { createMarketplaceMetadataAdapter } from "./infra/marketplace-metadata.js";
import { createInstallCliFlow, createInstallPreparation, createInstallPreflight, createInstallUseCase } from "./app/install.js";
import { createRepositoryClassification } from "./app/repository-classification.js";
import { createInstallExecutor } from "./app/install-exec.js";
import { createDiagnosticsRuntime } from "./app/diagnostics.js";
import { createInstalledState } from "./app/installed-state.js";
import { createProfileIndexRuntime } from "./app/profile-index.js";
import { createListRuntime } from "./app/list-runtime.js";
import { createUninstallUseCase } from "./app/uninstall.js";
import { createUpdateUseCase } from "./app/update.js";
import { createFeedbackUseCase } from "./app/feedback.js";
import { createBackupUseCase } from "./app/backup.js";
import { createEnvEditUseCase } from "./app/env-edit.js";
import { registerRoutes } from "./http/routes.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, cp, readFile, writeFile, stat, readdir, rename, mkdtemp, realpath } from "node:fs/promises";
import { join, dirname, resolve, relative, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { redactLog, findSecrets } from "./redact.js";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);

const adaptorAdapter = createAdaptorAdapter({
  loadConfig: () => requireFromHere("../adaptor.json"),
  normalizeRepo,
});
const { adaptorRedirectRepo, applyAdaptorList } = adaptorAdapter;

const metadataAdapter = createMarketplaceMetadataAdapter({
  fs: { readFile, readdir },
  path: { dirnamePath: dirname, joinPath: join },
  resolveCorePackage: (name) => requireFromHere.resolve(name),
  ownPackagePath: new URL("../package.json", import.meta.url),
  officialFallback: [
    "@deepseek-ai/cordis", "@deepseek-ai/cosmokit", "@deepseek-ai/schemastery",
    "@deepseek-ai/dsh", "@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-settings-file",
    "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-connection",
    "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-invariants", "@deepseek-ai/dsh-web",
  ],
});
const { loadOfficialPackages, isOfficialPackage, loadOwnRepo } = metadataAdapter;

export const name = "dsh-plugin-marketplace";
/** 声明依赖 webServer 服务：cordis 会先启动该服务再执行 apply()，
 *  避免 ctx.get("webServer") 同步取值为 undefined 导致插件树加载失败 */
export const inject = ["webServer"];

/** 市场本体仓库全名（反馈建 issue / 自更新 / 安装自己时跳过 patch 注册共用）。 */
const SELF_UPDATE_REPO = "bradeGithub/DSH-Plugins-Marketplace";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const MARKET_ROOT = join(DSH_HOME, "marketplace");
const CACHE_DIR = join(MARKET_ROOT, "cache");
/** 列表索引磁盘缓存：网络源（api/CDN/raw）全挂时兜底用上次成功拉取的完整索引，
 *  避免回退搜索 API 的残缺结果（Search API 单 query 上限 1000 条，skills 兜底仅 266）。 */
const LIST_CACHE_DIR = join(MARKET_ROOT, "list-cache");
const listCacheFile = (kind) => join(LIST_CACHE_DIR, `${kind}.json`);
/** 克隆缓存复用时间窗（ms）：awaiting-input 回环内直接复用缓存，不重复克隆。 */
const CACHE_REUSE_MS = 15 * 60 * 1000;
const SKILLS_DIR = join(DSH_HOME, "skills");
const PRESETS_DIR = join(DSH_HOME, ".agent-presets");

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

function warnDroppedPackageConflicts(dropped) {
  if (!Array.isArray(dropped) || dropped.length === 0) return;
  const samples = dropped.slice(0, 3).join(", ");
  console.warn(`[dsh-plugin-marketplace] pkg_name 冲突：隐藏 ${dropped.length} 个同名包（如 ${samples}…，同名 npm 包只能安装一个，请原作者改名）`);
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
let feedbackUseCase;

/** 启动时加载反馈队列与 token（文件不存在时为空；损坏处理见 readStateJson）。 */
async function loadFeedback() {
  return await feedbackUseCase.load();
}

// ── 环境变量编辑（issue #18）：已安装插件重新配置 API KEY 等 env ──
const ENVS_FILE = join(MARKET_ROOT, "envs.json");
const DOTENV_FILE = join(DSH_HOME, ".env");
let envEditUseCase;

async function loadEnvStore() {
  return await envEditUseCase.load();
}



/** 持久化反馈队列与 token（串行化读-改-写，防并发交错）。 */
async function saveFeedback() {
  return await feedbackUseCase.saveFeedback();
}

/** 安装成功后登记待确认反馈（同 repo 只保留最新一条）。 */
async function queueFeedback(entry) {
  return await feedbackUseCase.queueFeedback(entry);
}

/** queueFeedback 容错包装：反馈入队失败（磁盘满/权限）不得影响安装结果——吞错记日志。
 *  安装流两处调用点共用（cli 路径 / 常规路径），失败容错语义集中一处。 */
async function queueFeedbackSafe(entry, logLine, lang) {
  return await feedbackUseCase.queueFeedbackSafe(entry, logLine, lang);
}

/** npm 包名白名单（npm 官方命名规则，含 scoped）。 */
const PKG_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** 全局安装互斥：同一时刻只允许一个安装任务（客户端按钮也会同步禁用），从源头杜绝并发安装竞态。 */
const installMutex = createMutex();
/** patch 写队列：不同仓库并发安装时串行化读-改-写。 */
const patchQueue = createQueue();
const { appendPatchEntry, removePatchEntry } = createPatchManifestAdapter({
  fs: { readFile, writeFile, rename },
  hasPatchEntry,
  queue: patchQueue,
  defaultPatchPath: profilePatchFile
});
/** installed state：安装记录、持久化与成功变更通知由独立 owner 持有。 */
function installedKey(fullName) {
  return normalizeRepoRef(fullName) ?? String(fullName ?? "");
}
const installedState = createInstalledState({
  file: INSTALLED_FILE,
  marketRoot: MARKET_ROOT,
  readStateJson,
  mkdir,
  writeFile,
  queue: createQueue(),
  normalizeRepoRef: installedKey,
});

function getInstalledRecord(fullName) {
  return installedState.get(fullName);
}
function hasInstalledRecord(fullName) {
  return installedState.has(fullName);
}

async function saveInstalled(fullName, record) {
  return await installedState.save(fullName, record);
}

async function removeInstalled(fullName) {
  return await installedState.remove(fullName);
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


/** 读 profile 的 package.json；缺失/损坏返回 null（绝不凭空创建——会破坏 harness 的模板归一化）。
 *  pkgPath 缺省用当前 profilePackageFile()；跨 profile 卸载传旧 profile 的清单路径。 */
async function readProfileManifest(pkgPath = profilePackageFile()) {
  try {
    const data = JSON.parse(await readFile(pkgPath, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** profile package.json 原子写（tmp + rename，与 writeListCache/appendPatchEntry 同模式）。 */
async function writeProfileManifest(data, pkgPath = profilePackageFile()) {
  const tmp = pkgPath + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, pkgPath);
}

/** bundle 注册兼容转接：实现由 infra adapter 承接，保留原有参数和导出。 */
async function registerBundlePackage(pkgName, depSpec, env, logLine, lang, paths = {}) {
  return bundleRegisterAdapter.registerBundlePackage(pkgName, depSpec, env, logLine, lang, paths);
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
  return hasDshPluginDeclaration(pkg);
}

const repositoryScanAdapter = createRepositoryScanAdapter({
  fs: { readdir, readFile },
  path: { joinPath: join },
  looksLikeDshPlugin,
});

const findSkillRoots = (cacheDir, maxDepth = 5, limit = 200) => repositoryScanAdapter.findSkillRoots(cacheDir, maxDepth, limit);
const findPluginRoots = (cacheDir, maxDepth = 3, limit = 50) => repositoryScanAdapter.findPluginRoots(cacheDir, maxDepth, limit);
const findPresetRoots = (cacheDir, maxDepth = 3, limit = 50) => repositoryScanAdapter.findPresetRoots(cacheDir, maxDepth, limit);
const readSkillManifest = (skillRoot) => repositoryScanAdapter.readSkillManifest(skillRoot);
const readLifecycleScripts = (cacheDir) => repositoryScanAdapter.readLifecycleScripts(cacheDir);

const repositoryClassification = createRepositoryClassification({
  exists: pathExists,
  joinPath: join,
  readPackageJsonObject,
  findPresetRoots,
  findSkillRoots,
  findPluginRoots,
  looksLikeDshPlugin,
  isBundlePackage,
});

const detectTypeDetail = (cacheDir) => repositoryClassification.detectTypeDetail(cacheDir);
const detectType = (cacheDir) => repositoryClassification.detectType(cacheDir);

const securityScanAdapter = createSecurityScanAdapter({
  fs: { readFile, readdir, stat },
  path: { joinPath: join, relativePath: relative },
  findSecrets,
  fetchImpl: (...args) => fetch(...args),
  readBodyLimited,
  timeoutSignal: () => AbortSignal.timeout(FETCH_TIMEOUT_MS),
  domain: {
    extractEnvNames,
    findHostShadowDeps,
    classifyScriptHazards,
    lifecycleScriptTargets,
    classifyLifecycleHazards,
    parseLockfileVersions,
    readVulnScanDeps,
    filterVulnerabilityHits,
    isSecretScanFile,
    isSecretScanSkipDir,
  },
  limits: {
    secretMaxFiles: SECRET_SCAN_MAX_FILES,
    secretMaxFileBytes: SECRET_SCAN_MAX_FILE_BYTES,
    cveMaxQueries: CVE_MAX_QUERIES,
  },
});

const {
  scanRequirements,
  scanHostShadowDeps,
  scanLifecycleHazards,
  scanScriptHazards,
  scanCacheSecrets,
  readLockfileVersions,
  fetchBulkAdvisories,
  scanCacheVulnerabilities,
} = securityScanAdapter;


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
 * 扫描已安装目录（当前 profile 的 node_modules / skills / 预设），
 * 建立「目录名或包名(小写) -> { name, version, repository }」映射，用于识别
 * 仓库名与包名不一致的安装（如仓库 DSH-Plugins-Marketplace，包名 dsh-plugin-marketplace）。
 * scoped 包（@scope/name）会递归一层扫描。
 */
const profileScanAdapter = createProfileScanAdapter({
  fs: { readdir },
  paths: {
    profileNodeModules,
    skillsDir: SKILLS_DIR,
    presetsDir: PRESETS_DIR,
    cacheDir: CACHE_DIR,
  },
  readPackageSummary,
  detectCacheType: detectType,
  readPackageName,
});

const profileIndexRuntime = createProfileIndexRuntime({
  profileName,
  profileScanAdapter,
  installedSnapshot: () => installedState.snapshot(),
  hasInstalledRecord,
  installedKey,
  loadOfficialPackages,
  loadOwnRepo,
  detectType,
  readPackageName,
  pathExists,
  joinPath: join,
  slugify,
  skillsDir: SKILLS_DIR,
  presetsDir: PRESETS_DIR,
  cacheDir: CACHE_DIR,
  managedRoots: [SKILLS_DIR, PRESETS_DIR],
  onProfileChange,
  onInstalledChange: (listener) => installedState.onChange(listener),
});

// Compatibility wrappers keep the historical exports stable while the runtime
// owner remains the only holder of profile/index lifecycle state.
const scanProfilePackages = (...args) => profileIndexRuntime.scanProfilePackages(...args);
const matchProfileEntry = (...args) => profileIndexRuntime.matchProfileEntry(...args);
const invalidateProfileCaches = (...args) => profileIndexRuntime.invalidate(...args);
const withStableProfileState = (...args) => profileIndexRuntime.withStableProfileState(...args);
const ensureInstalledIndex = (...args) => profileIndexRuntime.ensureInstalledIndex(...args);
const annotateInstalled = (...args) => profileIndexRuntime.annotateInstalled(...args);
const annotateSkillInstalled = (...args) => profileIndexRuntime.annotateSkillInstalled(...args);
const detectInstalled = (...args) => profileIndexRuntime.detectInstalled(...args);
const detectSkillInstalled = (...args) => profileIndexRuntime.detectSkillInstalled(...args);

/** 列表内容指纹（full_name 序列 FNV 轻量哈希）：随响应带给客户端，刷新对照用——
 *  内容未变时客户端跳过重渲染（不闪烁、保留分页位置）。
 *  纳入 installed 标志：安装/卸载/切 profile 会改变「已安装」标注而不改 full_name
 *  序列（标注随请求时状态计算）——不含它会漏掉重渲染，列表停留在旧标注。 */
function listFingerprint(repos) {
  let h = 2166136261;
  for (const r of repos) {
    const s = String(r?.full_name ?? "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x3b;
    // installed 标志位（0/1）混入：安装状态变化 → 指纹变化 → 客户端重渲染
    h ^= r?.installed === true ? 0x5f : 0;
  }
  // 附带列表长度：内容一进一出（长度变）时指纹必不同，消除 32 位 FNV 的同长度碰撞面
  return `${h >>> 0}-${repos.length}`;
}

await installedState.load();


/** 服务端文案字典（zh / en）。 */




/** 鉴权实例（http 层）：CSRF / Host / Origin / LAN 写访问控制与会话 token。 */
const auth = createAuth({
  isTrustedHost,
  readConfig: async () => {
    try {
      return JSON.parse(await readFile(join(MARKET_ROOT, "config.json"), "utf8"));
    } catch {
      return null;
    }
  },
  randomHex: () => randomBytes(32).toString("hex"),
  timingSafeEqual
});

/** 兼容导出：鉴权判定转发到 http/auth 实例（路由层拆分后由注入提供）。 */
function isTrustedRequest(req) {
  return auth.isTrustedRequest(req);
}

async function isWriteAllowed(req) {
  return await auth.isWriteAllowed(req);
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




/** 防原型污染的安全对象合并：JSON 数据中的 __proto__/constructor/prototype
 *  键经 Object.assign 的 [[Set]] 会触发原型 setter（registry/search 响应是半可信输入——
 *  GitHub 字段固定、实际不可达，但边界防御成本为零，理论污染面一并封死）。 */


async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "dsh-plugin-marketplace", "Accept": "application/vnd.github+json", ...extraHeaders },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}${(await res.text().catch(() => "")).slice(0, 200)}`);
  if (responseTooLarge(res)) throw new Error(`响应过大（Content-Length ${res.headers.get("content-length")}）`);
  // content-length 已知且未超限：快路径（与旧行为一致）；缺失（chunked）→ 流式计数兜底
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > 0 && len <= MAX_RESPONSE_BYTES) return await res.json();
  return JSON.parse((await readBodyLimited(res)).toString("utf8"));
}

/**
 * 静态索引（registry.json / skills.json）的候选源（按序尝试，全部失败才回退搜索 API）：
 * 1. api.github.com raw——永远最新、国内可达（未认证限流 60 次/小时，个人使用绰绰有余）；
 * 2. jsDelivr CDN——快，但缓存可能滞后，超过 REGISTRY_MAX_AGE_MS 的旧索引直接弃用；
 * 3. raw.githubusercontent——永远最新，适合 api 被限流/屏蔽的网络。
 */
/** jsDelivr CDN 缓存可滞后数小时：超过该年龄的索引视为过期，改用下一数据源。 */



/** 从 registry 索引拉取仓库列表；全部源失败时返回 null（调用方回退搜索 API）。 */

/** 搜索 API 兜底路径：按 kind 的 query 列表逐 query 分页翻到底（跨 query 去重），
 *  最多 MAX_PAGES 页/query；存在 GH_TOKEN/GITHUB_TOKEN 时带认证提升限流。
 *  skills 兜底无探测数据，has_skill 一律 null（未知），由前端弱化显示。
 *  单 query 失败（限流/网络）时使用已收集的部分数据降级返回，不再让整个列表 500。 */


/**
 * 读磁盘缓存（上次成功拉取的完整索引）；无缓存/损坏/缺 generated_at/过期/坏条目返回 null。
 * 与 writeListCache 配套（缓存一致性约束）：search 兜底不再落盘后，磁盘缓存只可能是
 * registry 成功时写入的完整索引（带 generated_at）——逐项校验才能保证
 * registry 全挂时兜底用的缓存是新鲜且结构完整的。
 */

/**
 * 写磁盘缓存。只在完整索引（registry / bundled）成功时调用——搜索兜底结果天然
 * 残缺（Search API 单 query 上限 1000 条），落盘会把好缓存降级成残缺索引（#12）。
 * generated_at 记写入时刻（紧跟 registry 成功拉取，与索引拉取时刻同一量级），
 * readListCache 按 REGISTRY_MAX_AGE_MS 校验其新鲜度。
 */

/**
 * 插件包内置索引（registry.json / skills.json 随包分发）：无网络依赖的可靠兜底（#12）。
 * skills.json 已超 12MB（12000+ 仓库），慢网/代理环境常撞 FETCH_TIMEOUT_MS 硬超时，
 * 回退搜索 API 只剩残缺结果。内置索引秒读且全量；「刷新」仍走网络源获取最新。
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const registryCache = createRegistryCacheAdapter({
  fetchImpl: (...args) => fetch(...args),
  fetchJson,
  readBodyLimited,
  responseTooLarge,
  gunzip: gunzipSync,
  timeoutSignal: () => AbortSignal.timeout(FETCH_TIMEOUT_MS),
  fs: { readFile, mkdir, writeFile, rename },
  clock: { now: () => Date.now() },
  limits: {
    maxResponseBytes: MAX_RESPONSE_BYTES,
    registryMaxAgeMs: 6 * 3600 * 1000,
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
  },
  paths: {
    cacheFile: listCacheFile,
    cacheDir: LIST_CACHE_DIR,
    bundledFile: (kind) => join(MODULE_DIR, "..", kind === "skills" ? "skills.json" : "registry.json"),
  },
  normalizeRepo,
  excludedRepoNames: new Set(["deepseek-harness"]),
  registrySources: (kind) => {
    const file = kind === "skills" ? "skills.json" : "registry.json";
    return [
      { url: `https://api.github.com/repos/bradeGithub/DSH-Plugins-Marketplace/contents/${file}.gz`, acceptRaw: true },
      { url: `https://cdn.jsdelivr.net/gh/bradeGithub/DSH-Plugins-Marketplace@main/${file}.gz`, checkFresh: true },
      { url: `https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/${file}.gz` },
      { url: `https://cdn.jsdelivr.net/gh/bradeGithub/DSH-Plugins-Marketplace@main/${file}`, checkFresh: true },
      { url: `https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/${file}` }
    ];
  },
  searchQueries: {
    dsh: ["topic:dsh-plugin"],
    skills: ["topic:agent-skills", "topic:claude-skills"]
  },
  getGithubToken: () => process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ""
});
const {
  fetchRegistryRepos,
  fetchSearchRepos,
  readListCache,
  writeListCache,
  readBundledIndex,
  load: loadRegistryRepos
} = registryCache;

const listRuntime = createListRuntime({
  loadRegistryRepos,
  now: () => Date.now(),
  ttlMs: CACHE_TTL_MS,
  warn: (message) => console.warn(message),
});

// Compatibility wrappers keep the historical list exports stable.
const fetchAllRepos = (...args) => listRuntime.fetchAllRepos(...args);
const getList = (...args) => listRuntime.getList(...args);
const getListCacheState = (...args) => listRuntime.getCacheState(...args);

const exists = (p) => stat(p).then(() => true).catch(() => false);

const runNpm = runNpmProc;
const runPnpm = runPnpmProc;
const bundleRegisterAdapter = createBundleRegisterAdapter({
  fs: { readFile, writeFile, rename, rm, realpath, exists },
  profilePaths: {
    profileDir,
    nodeModules: profileNodeModules,
    packageFile: profilePackageFile,
  },
  runPnpm,
  resolvePackage: async (anchor, spec) => {
    const bundleRequire = createRequire(join(anchor, "noop.js"));
    try {
      bundleRequire.resolve(spec);
      return true;
    } catch {
      return false;
    }
  },
  joinPath: join,
  resolvePath: resolve,
  pathSep: sep,
  packageNamePattern: PKG_NAME_PATTERN,
  translate: t,
});

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
    // --ignore-workspace：同 registerBundlePackage——cacheDir 在 ~/.dsh 下，向上
    // 会被主目录常驻的 pnpm-workspace.yaml 吞进 workspace，依赖装错位置。
    await runPnpm(["install", "--ignore-workspace", "--no-frozen-lockfile"], { cwd: cacheDir, env, timeout: 600000 });
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

/** 日志脱敏（纯函数）：隐藏用户主目录路径与密钥形态串，供导出排查日志与安装反馈诊断用。
 * 性质测试观察项：\b 词边界在黏连形态（"xsk-<token>"，sk- 前接字母）不命中 → 完整密钥
 * 原样泄漏——去 \b 允许前置任意字符（sk- 前缀本身就是密钥形态候选，脱敏宁可过激）；
 * Windows 路径正则加 /i（真实文件系统大小写不敏感，c:\users\... 同样必须脱敏）。
 * 路径脱敏覆盖用户目录下任意深度（AppData/Temp 等）：只保留首段目录名（如 ~\AppData\...），
 * 用户名与机器特定层级全部隐藏——反馈 issue 是公开仓库，路径可推断用户身份。 */
function sanitizeLog(text) {
  return String(text ?? "")
    .replace(/[A-Za-z]:\\Users\\[^\\]+((?:\\[^\s"\\:|;,)]+)*)/gi, (_m, rest) => `~\\<user>${rest}`)
    .replace(/\$HOME\/[^\s"]+|\/home\/[^/\s"$]+((?:\/[^\s"/:$();|,]+)*)/g, (_m, rest) => `~/<user>${rest}`)
    .replace(/(sk-[A-Za-z0-9]{6})[A-Za-z0-9]+/g, "$1…")
    .replace(/(gh[pousr]_[A-Za-z0-9]{6})[A-Za-z0-9]+/g, "$1…")
    .replace(/(AKIA[A-Za-z0-9]{6})[A-Za-z0-9]+/g, "$1…");
}

/** 日志条目单条上限：install/uninstall 失败时 err 直传（npm/git stderr 洪流可达
 * maxBuffer 32MB）——不截断则单条 32MB × 400 条 = 12.8GB 内存峰值。入口截断，
 * 所有调用点自动受保护。 */
const LOG_LINE_MAX = 4096;
/** 安装反馈诊断快照上限：日志尾行数与总字符数——issue 是公开仓库，快照必须
 * 过 sanitizeLog 且限幅（防 issue 膨胀 + 防 32MB stderr 洪流直通 GitHub）。 */
const FEEDBACK_LOG_TAIL = 40;
const FEEDBACK_LOG_MAX_CHARS = 2000;

/** 安装反馈诊断快照（纯函数）：类型判定锚点行 + 日志尾部，脱敏后限幅。
 * 锚点行（[2/5] 识别类型/判定报告）在头部，纯尾部会漏「判定错误但尾部只见果」场景。 */
function buildFeedbackLogSnapshot(log) {
  const lines = (Array.isArray(log) ? log : []).map((l) => String(l ?? ""));
  const anchors = lines.filter((l) => /\[2\/5\]|判定报告/.test(l));
  const tail = lines.slice(-FEEDBACK_LOG_TAIL);
  const merged = [...new Set([...anchors, ...tail])].slice(-FEEDBACK_LOG_TAIL + anchors.length);
  const text = merged.join("\n");
  // 多层脱敏（lib/redact.js）：已知密钥 + 上下文邻近 + allowlist + 注入净化。
  // sanitizeLog（路径 + 3 密钥前缀）作为最后一遍兜底（双保险，两套规则集互补）。
  return sanitizeLog(redactLog(text.length > FEEDBACK_LOG_MAX_CHARS ? `…(前段截断)…\n${text.slice(-FEEDBACK_LOG_MAX_CHARS)}` : text));
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

/**
 * npm 目标形态判定（纯函数）：dsh CLI 失败时的 npm 等价回退只适用于 npm 包名
 * （@scope/name 或裸 name，可带 @version）；GitHub 仓库/URL 形态目标不适用。
 */
export function isNpmCliTarget(target) {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[^@\s/]+)?$/i.test(String(target ?? "").trim());
}

/** 从 npm 目标剥离版本号得到包名（@scope/name@1.2.3 → @scope/name）。 */
export function npmTargetName(target) {
  const t = String(target ?? "").trim();
  if (t.startsWith("@")) {
    const m = t.match(/^(@[^/]+\/[^@]+)(@.+)?$/);
    return m ? m[1] : t;
  }
  return t.split("@")[0];
}

/**
 * 用 npm 把官方包装进独立临时目录并返回包内容目录（dsh CLI 失败时的等价回退）：
 * 官方 npm 分发的仓库（issue #54 archify 案例：@tt-a1i/archify-dsh 的 skills 内容
 * 只存在于发布 tarball——files 白名单 + prepublish pack 流程，仓库目录直装会缺件）
 * 应以其 tarball 内容继续常规安装流程。
 * npm install --ignore-scripts 不执行任何生命周期脚本；失败返回 null（调用方走原回退）。
 */
async function installNpmTargetToTemp(target) {
  const tmp = await mkdtemp(join(tmpdir(), "dsh-npm-fallback-"));
  try {
    // --prefix 显式指定安装根（npm 对「无 package.json 的 cwd」处理随版本有差异，
    // 实测 cwd 方式出现「up to date」却不落盘——prefix 是脚本化安装的稳定形态）。
    const args = ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", tmp, target];
    await runNpm(args, { cwd: tmp, timeout: 300000 });
    const name = npmTargetName(target);
    const nm = join(tmp, "node_modules");
    if (name.startsWith("@")) {
      const [scope, bare] = name.split("/");
      const inner = await readdir(join(nm, scope), { withFileTypes: true }).catch(() => []);
      const pkg = inner.find((e) => e.isDirectory() && e.name === bare);
      return pkg ? join(nm, scope, pkg.name) : null;
    }
    const direct = await readdir(nm, { withFileTypes: true }).catch(() => []);
    const pkg = direct.find((e) => e.isDirectory() && e.name === name);
    return pkg ? join(nm, pkg.name) : null;
  } catch {
    return null;
  }
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

/** 读市场本体（本插件）安装目录的 package.json 版本号。 */
function readOwnVersion() {
  try {
    const pkg = requireFromHere("../package.json");
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

const diagnosticsRuntime = createDiagnosticsRuntime({
  platform: process.platform,
  nodeVersion: process.version,
  readOwnVersion,
  readFile,
  joinPath: join,
  profileNodeModules,
  probe: probeProc,
  logLineMax: LOG_LINE_MAX
});
const buildEnvProfileAsync = diagnosticsRuntime.buildEnvProfileAsync;
const buildEnvProfile = diagnosticsRuntime.buildEnvProfile;
const pushLog = diagnosticsRuntime.pushLog;
const getRecentLogs = diagnosticsRuntime.getRecentLogs;
const pushEvent = diagnosticsRuntime.pushEvent;

/** 查 npm registry 最新版（npmmirror 优先，npmjs 兜底）；失败返回 null。 */
async function fetchNpmLatest(pkgName) {
  // 双源并行：npmmirror 同步滞后（常规 ~10 分钟，大包被 80MB 同步限制
  // 卡住会无限滞后）——「镜像优先」会漏报新版本，误导「检测更新」。npmjs.org 永远
  // 是真相源，镜像仅作国内可达性兜底。官方成功直接返回官方值（不比较——
  // 官方值优先：dist-tags.latest 可能是非 semver 畸形 tag，compareVersions 取 max
  // 会退化为字符串比较误判）；官方失败取镜像；全失败返回 null。
  const [official, mirror] = await Promise.allSettled(
    ["https://registry.npmjs.org", "https://registry.npmmirror.com"].map(async (base) => {
      try {
        const res = await fetch(`${base}/${encodeURIComponent(pkgName)}`, {
          headers: { "User-Agent": "dsh-plugin-marketplace" },
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) return null;
        const d = JSON.parse((await readBodyLimited(res)).toString("utf8"));
        return d && typeof d["dist-tags"]?.latest === "string" && d["dist-tags"].latest.length > 0
          ? d["dist-tags"].latest : null;
      } catch { return null; }
    })
  );
  const pick = (r) => (r.status === "fulfilled" && r.value ? r.value : null);
  return pick(official) ?? pick(mirror);
}

const prepareInstallCache = createInstallPreparation({
  cacheRoot: CACHE_DIR,
  mkdir,
  stat,
  rm,
  exists,
  readFile,
  runGit: runGitProc,
  parseGitmodulesUrls,
  cacheReuseMs: CACHE_REUSE_MS,
  joinPath: join,
  translate: t
});

const cleanupInstallCache = async (cacheDir) => {
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
};

const runInstallCliFlow = createInstallCliFlow({
  scanCliInstallHint,
  scanExternalCliHint,
  findCliInstall,
  buildFilteredEnv,
  getInstalledRecord,
  fetchNpmLatest,
  runDsh: runDshProc,
  installNpmTargetToTemp,
  isNpmCliTarget,
  saveInstalled,
  queueFeedbackSafe,
  buildEnvProfile: buildEnvProfileAsync,
  buildFeedbackLogSnapshot,
  cleanupCache: cleanupInstallCache,
  translate: t
});

const runInstallPreflight = createInstallPreflight({
  detectTypeDetail,
  findPluginRoots,
  scanRequirements,
  scanCacheSecrets,
  scanCacheVulnerabilities,
  scanScriptHazards,
  scanLifecycleHazards,
  readLifecycleScripts,
  scanHostShadowDeps,
  needsPluginBuild,
  readPackageJsonObject,
  looksLikeDshPlugin,
  exists,
  readFile,
  joinPath: join,
  cleanupCache: cleanupInstallCache,
  redactLog,
  translate: t
});

const runInstallExecutor = createInstallExecutor({
  fs: { mkdir, rm, cp, readFile, writeFile, readdir, exists },
  path: { joinPath: join, resolvePath: resolve, pathSep: sep },
  proc: { runScript: runScriptProc },
  scan: { findSkillRoots, findPluginRoots, findPresetRoots, readSkillManifest, needsPluginBuild },
  package: {
    sanitizeManifest,
    isBundlePackage,
    packageNamePattern: PKG_NAME_PATTERN,
    copyFilter,
    readPackageVersion
  },
  adapters: { registerBundlePackage, appendPatchEntry },
  env: { buildMinimalEnv, buildFilteredEnv },
  managedDirs: { skillsDir: SKILLS_DIR, presetsDir: PRESETS_DIR },
  selfUpdateRepo: SELF_UPDATE_REPO,
  platform: process.platform,
  slugify,
  buildPluginPackage,
  npmInstallWithFallback,
  translate: t
});

const runInstallUseCase = createInstallUseCase({
  installRepo,
  saveInstalled,
  queueFeedbackSafe,
  getInstalledRecord,
  buildEnvProfile: buildEnvProfileAsync,
  buildFeedbackLogSnapshot,
  readPackageVersion,
  classifyInstallFailure,
  cleanupCache: cleanupInstallCache,
  translate: t
});

const runUninstallUseCase = createUninstallUseCase({
  getInstalledRecord,
  removeInstalled,
  resolveRecordNodeModules,
  profileNodeModules,
  profileDir,
  profilePatchFile,
  profilePackageFile,
  joinPath: join,
  resolvePath: resolve,
  dirnamePath: dirname,
  pathSep: sep,
  rm,
  runPnpm: runPnpmProc,
  buildFilteredEnv,
  readProfileManifest,
  writeProfileManifest,
  removePatchEntry,
  managedDirs: { skillsDir: SKILLS_DIR, presetsDir: PRESETS_DIR, cacheDir: CACHE_DIR },
  removePendingFeedback: (repo) => feedbackUseCase.removePendingFeedback(repo),
  saveFeedback,
  translate: t
});

const runUpdateUseCase = createUpdateUseCase({
  readOwnVersion,
  fetchLatestVersion: async () => {
    const res = await fetch(`https://api.github.com/repos/${SELF_UPDATE_REPO}/contents/package.json`, {
      headers: { "User-Agent": "dsh-plugin-marketplace", "Accept": "application/vnd.github.raw" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const pkg = JSON.parse((await readBodyLimited(res)).toString("utf8"));
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
  },
  fetchLatestFromCache: () => {
    try {
      const repos = getListCacheState("dsh").repos;
      if (!Array.isArray(repos)) return null;
      const self = repos.find((r) => r.full_name === SELF_UPDATE_REPO);
      return self && typeof self.version === "string" && self.version.length > 0 ? self.version : null;
    } catch {
      return null;
    }
  },
  shouldUpdate,
  compareVersions,
  runDsh: runDshProc,
  runGit: runGitProc,
  readFile,
  exists,
  rename,
  rm,
  joinPath: join,
  dirnamePath: dirname,
  randomHex: () => randomBytes(4).toString("hex"),
  selfUpdateRepo: SELF_UPDATE_REPO,
  destRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  pushLog
});

feedbackUseCase = createFeedbackUseCase({
  feedbackFile: FEEDBACK_FILE,
  marketRoot: MARKET_ROOT,
  readStateJson,
  mkdir,
  writeFile,
  queue: createQueue(),
  fetchImpl: (...args) => fetch(...args),
  readBodyLimited,
  timeoutSignal: () => AbortSignal.timeout(FETCH_TIMEOUT_MS),
  selfUpdateRepo: SELF_UPDATE_REPO,
  feedbackLogTail: FEEDBACK_LOG_TAIL,
  translate: t
});

const runBackupUseCase = createBackupUseCase({
  getInstalledEntries: () => installedState.entries(),
  readOwnVersion,
  installedKey,
  hasInstalledRecord,
  fetchImpl: (...args) => fetch(...args),
  readBodyLimited,
  responseTooLarge,
  timeoutSignal: () => AbortSignal.timeout(30000),
  isSafeWebdavUrl: (url) => /^https?:\/\//i.test(String(url ?? "").trim()),
  translate: t
});

envEditUseCase = createEnvEditUseCase({
  envsFile: ENVS_FILE,
  marketRoot: MARKET_ROOT,
  dotenvFile: DOTENV_FILE,
  dshHome: DSH_HOME,
  readStateJson,
  mkdir,
  readFile,
  writeFile,
  queue: createQueue(),
  getInstalledRecord,
  isValidEnvKey
});

function apply(ctx) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) throw new Error("dsh-plugin-marketplace: webServer service unavailable");

  // 写操作会话 token 注入页面（LAN 模式校验用；回环模式注入无害）。
  // tapIndex 是 webserver 的 HTML 变换通道（fallback owner 每次 index 响应都调用）；
  // 低版本 DSH 无此 API 时跳过——LAN 写操作会因拿不到 token 而拒绝（fail-closed）。
  if (typeof webServer.tapIndex === "function") {
    webServer.tapIndex((html) => html.replace("</head>", `<script>window.__DSH_MP_TOKEN__="${auth.getToken()}"</script></head>`));
  }

  // 每次 DSH 启动时自动拉取全部插件并按 Star 排序（失败静默，打开页面时会自动重试）
  getList().catch((error) => {
    ctx.logger?.warn?.(`dsh-plugin-marketplace: 启动预热拉取失败 ${error}`);
  });

  // 目标 profile 配置（issue #184）：启动时从 config.json 读取并应用。
  // 仅当配置真实存在且合法（fromConfig）才覆盖——显式 setTargetProfile（面板保存）
  // 不被无配置的默认值冲掉；面板保存经 API 即时重算，无需重启。
  readTargetProfile().then(({ profile, fromConfig }) => {
    if (!fromConfig) return;
    setTargetProfile(profile);
    ctx.logger?.info?.(`dsh-plugin-marketplace: 目标 profile = ${profileName()}`);
  }).catch(() => {});

  // 小优待：每次 DSH 启动直链 GitHub 查市场本体是否有新版本（失败静默，页面打开时会重查）
  runUpdateUseCase.check().catch((error) => {
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

  // v1.4.12（issue #39）：自愈——若 cordis.patch.yml 残留市场本体条目（历史版本的市场安装
  // 管线 / install 脚本误注册导致），与 profile bundles 双加载会引发 webserver 重复路由崩溃。
  // 启动时自动移除（本体的正确加载途径是 bundles，patch 条目永远不该存在）。
  (async () => {
    try {
      const patchText = await readFile(profilePatchFile(), "utf8").catch(() => "");
      if (patchText && hasPatchEntry(patchText, "dsh-plugin-marketplace")) {
        await removePatchEntry("dsh-plugin-marketplace");
        ctx.logger?.warn?.("dsh-plugin-marketplace: 已自动清理 cordis.patch.yml 中的本体残留条目（issue #39 双加载自愈）");
      }
    } catch { /* 自愈失败不阻断启动 */ }
  })();
  registerRoutes({
    webServer,
    logger: ctx.logger,
    http: { json, readJsonBody },
    i18n: { t, langOf },
    auth: { isTrustedRequest, isWriteAllowed },
    state: {
      installMutex,
      getRecentLogs,
      MARKET_ROOT,
      DSH_HOME,
      CACHE_DIR,
      SKILLS_DIR,
      PRESETS_DIR
    },
    profile: {
      PROFILE_NAME_RE,
      profileName,
      profileDir,
      profileNodeModules,
      profilePatchFile,
      profilePackageFile,
      setTargetProfile,
      resolveRecordNodeModules
    },
    installed: { getInstalledRecord, hasInstalledRecord },
    list: {
      getList,
      getListCacheState,
      invalidateProfileCaches,
      applyAdaptorList,
      withStableProfileState,
      scanProfilePackages,
      matchProfileEntry,
      annotateInstalled,
      annotateSkillInstalled,
      detectSkillInstalled,
      dedupeReposByPkgName,
      warnDroppedPackageConflicts,
      listFingerprint
    },
    useCases: {
      update: runUpdateUseCase,
      backup: runBackupUseCase,
      feedback: feedbackUseCase,
      envEdit: envEditUseCase,
      prepareInstall: prepareInstallCache,
      installCli: runInstallCliFlow,
      preflight: runInstallPreflight,
      install: runInstallUseCase,
      uninstall: runUninstallUseCase
    },
    helpers: {
      adaptorRedirectRepo,
      slugify,
      normalizeRepoRef,
      readPackageVersion,
      readOwnVersion,
      compareVersions,
      fetchNpmLatest,
      scanRequirements,
      sanitizeLog,
      classifyInstallFailure,
      pushLog,
      pushEvent,
      safeAssign
    },
    fs: { stat, readFile, writeFile, rm, join, resolve, sep },
    constants: { LOG_LINE_MAX }
  });
}

async function installRepo({ type, cacheDir, repo, log, answers, logLine, lang, envAllowList = [], npmTarget = null, profilePaths = null }) {
  const installProfilePaths = profilePaths ?? {
    profileDir: profileDir(),
    nodeModules: profileNodeModules(),
    patchFile: profilePatchFile(),
    packageFile: profilePackageFile()
  };
  return await runInstallExecutor({
    type,
    cacheDir,
    repo,
    log,
    answers,
    logLine,
    lang,
    envAllowList,
    npmTarget,
    profilePaths: installProfilePaths
  });
}

export { apply, detectInstalled, detectSkillInstalled, loadOwnRepo, scanProfilePackages, langOf, t, fetchAllRepos, fetchRegistryRepos, getList, isTrustedRequest, isTrustedHost, isSensitiveEnvKey, buildMinimalEnv, buildFilteredEnv, compareVersions, shouldUpdate, hasPatchEntry, normalizeRepo, appendPatchEntry, removePatchEntry, readLifecycleScripts, sanitizeManifest, isPnpmLocalDependency, matchProfileEntry, normalizeRepoRef, loadOfficialPackages, isOfficialPackage, readPackageSummary, findSkillRoots, findPluginRoots, findPresetRoots, detectType, detectTypeDetail, parseGitmodulesUrls, scanCliInstallHint, scanExternalCliHint, findCliInstall, installNpmTargetToTemp, installRepo, saveInstalled, scanScriptHazards, classifyInstallFailure, sanitizeLog, buildFeedbackLogSnapshot, buildEnvProfile, queueFeedback, queueFeedbackSafe, readBundledIndex, dedupeReposByPkgName, needsPluginBuild, adaptorRedirectRepo, applyAdaptorList, ensureInstalledIndex, annotateInstalled, annotateSkillInstalled, safeAssign, hasInstalledRecord, wslPosixPath, slugify, SCRIPT_ENV_KEYS, scanLifecycleHazards, scanCacheSecrets, scanCacheVulnerabilities, readVulnScanDeps, setTargetProfile, readTargetProfile, getProfileNodeModules, resolveRecordNodeModules };
