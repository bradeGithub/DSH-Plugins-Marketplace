import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, cp, readFile, writeFile, stat, readdir, rename } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

export const name = "dsh-plugin-marketplace";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const MARKET_ROOT = join(DSH_HOME, "marketplace");
const CACHE_DIR = join(MARKET_ROOT, "cache");
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
/** 环境变量检测：覆盖全大写后缀与 camelCase 形态；_PASS 需要前文至少 3 个字符，避免误伤 BY_PASS 等词。 */
const ENV_PATTERN = /\b(?:[A-Z][A-Z0-9_]{1,}(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)|[A-Z][A-Z0-9_]{3,}_PASS|[a-z][A-Za-z0-9]*(?:ApiKey|Key|Token|Secret|Password|Pass))\b/g;

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

/** 启动时加载已安装清单（文件不存在时为空）。 */
async function loadInstalled() {
  try {
    const text = await readFile(INSTALLED_FILE, "utf8");
    const data = JSON.parse(text);
    if (data && typeof data === "object") {
      for (const [key, value] of Object.entries(data)) installedMap.set(key, value);
    }
  } catch { /* 首次运行：无清单文件 */ }
}

/**
 * 持久化一条安装记录（先写盘成功再入内存，避免持久化失败留下脏的已安装判定）。
 * 通过 installedQueue 串行化读-改-写，防止两个并发安装的「快照-写入」交错互相覆盖。
 */
async function saveInstalled(fullName, record) {
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
  if (installedMap.has(repo.full_name)) return true;
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
  if (installedMap.has(repo.full_name)) return true;
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
  try { return JSON.parse(raw); } catch { return {}; }
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
  return [
    { url: `https://api.github.com/repos/bradeGithub/DSH-Plugins-Marketplace/contents/${file}`, acceptRaw: true },
    { url: `https://cdn.jsdelivr.net/gh/bradeGithub/DSH-Plugins-Marketplace@main/${file}`, checkFresh: true },
    { url: `https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/${file}` }
  ];
}
/** jsDelivr CDN 缓存可滞后数小时：超过该年龄的索引视为过期，改用下一数据源。 */
const REGISTRY_MAX_AGE_MS = 6 * 3600 * 1000;

/** 插件分类白名单（与 build-registry.mjs 的 CATEGORY_RULES id 及 client.js CATEGORY_KEYS 对齐）。 */
const CATEGORY_KEYS = new Set(["vision", "document", "memory", "model", "notify", "coding", "conversation", "web-ui", "agent", "tool", "resource", "other"]);

/** 归一化仓库元数据（兼容搜索 API 与 registry.json 两种字段形态）；html_url 只放行 https://github.com 链接。 */
function normalizeRepo(r) {
  let htmlUrl = null;
  try {
    const u = new URL(String(r.html_url ?? ""));
    if (u.protocol === "https:" && u.host === "github.com") htmlUrl = u.href;
  } catch { /* 非法 URL 置空，客户端不渲染链接 */ }
  return {
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
    // registry.json 的分类字段（搜索 API 兜底没有 → null，客户端按「其他」处理）
    category: typeof r.category === "string" && CATEGORY_KEYS.has(r.category) ? r.category : null,
    // skills 索引字段（skills.json 才有；registry.json / 搜索 API 没有则置 null 未知）
    has_skill: r.has_skill === true ? true : (r.has_skill === false ? false : null),
    has_install_script: r.has_install_script === true ? true : (r.has_install_script === false ? false : null)
  };
}

/** 从 registry 索引拉取仓库列表；全部源失败时返回 null（调用方回退搜索 API）。 */
async function fetchRegistryRepos(kind = "dsh") {
  for (const source of registrySources(kind)) {
    try {
      const headers = { "User-Agent": "dsh-plugin-marketplace" };
      if (source.acceptRaw) headers["Accept"] = "application/vnd.github.raw";
      const res = await fetch(source.url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      const data = await res.json();
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
        collected.push(normalizeRepo(r));
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
function dedupeReposByPkgName(repos, isInstalled = (r) => installedMap.has(r.full_name)) {
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
  return [...byKey.values()];
}

/**
 * 拉取 kind 的全部仓库（dsh：topic:dsh-plugin；skills：agent-skills ∪ claude-skills）：
 * registry 索引优先（CDN，零限流），失败回退搜索 API，
 * 去重并排除 DSH 本体后按 Star 数从高到低排序。
 * 注意：pkg_name 冲突消解不在数据层做——「已安装优先」必须等 detectInstalled
 * （含 profile/repository 匹配）跑完才能判定，提前去重会隐藏用户手动安装的
 * 低 Star 仓库（见列表处理器里的 dedupeReposByPkgName）。
 */
async function fetchAllRepos(kind = "dsh") {
  const collected = (await fetchRegistryRepos(kind)) ?? (await fetchSearchRepos(kind));
  collected.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
  return collected;
}

/** 获取列表：缓存有效期内直接返回；并发请求共享同一次拉取；force 时忽略缓存强制刷新。kind 各自独立缓存。 */
async function getList(kind = "dsh", force = false) {
  const cache = listCaches[kind] ?? (listCaches[kind] = { at: 0, repos: null });
  if (!force && cache.repos !== null && Date.now() - cache.at <= CACHE_TTL_MS) return cache.repos;
  // 用 == null（null 或 undefined）：listCaches/listFetchings 是 { dsh, skills } 字面量，
  // 不存在的键是 undefined 而非 null，=== null 会误判「无进行中的拉取」，直接返回 undefined
  // 导致调用方读 .length 崩溃（用户线上报错即此）。
  if (listFetchings[kind] == null) {
    listFetchings[kind] = fetchAllRepos(kind)
      .then((repos) => {
        listCaches[kind] = { at: Date.now(), repos };
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
  try { files.push(...(await readdir(cacheDir)).map((f) => join(cacheDir, f))); } catch { /* ignore */ }
  const interesting = files.filter((f) => {
    const base = f.toLowerCase();
    return /(readme|install|\.env|package\.json|\.ya?ml$|\.md$)/.test(base) && !/node_modules/.test(base);
  });
  for (const file of interesting.slice(0, 40)) {
    try {
      const text = await readFile(file, "utf8");
      for (const m of text.matchAll(ENV_PATTERN)) names.add(m[0]);
    } catch { /* binary or unreadable */ }
  }
  return [...names].slice(0, 8);
}

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
      if (!entry.isDirectory() || [".git", "node_modules"].includes(entry.name)) continue;
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

async function detectType(cacheDir) {
  const has = (p) => exists(join(cacheDir, p));
  if ((await findSkillRoots(cacheDir, 5, 1)).length > 0) return "skill";
  if ((await has("preset.yml")) && (await has("agent.cordis.yml"))) return "agent-preset";
  if (await has("install.ps1")) return "script";
  if (await has("install.sh")) return "script";
  if (await has("package.json")) return "cordis-plugin";
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

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/self-update",
    handler: async (req, res) => {
      if (req.method !== "GET") return json(res, 405, { error: t(langOf(req, { lang: "" }), "methodNotAllowed") });
      // 页面打开即视为一次「打开 DSH」：超过 30 分钟未检查就顺带重查一次（直链 GitHub，单请求）
      if (Date.now() - selfUpdateState.checkedAt > 30 * 60 * 1000) {
        checkSelfUpdate().catch(() => {});
      }
      json(res, 200, selfUpdateState);
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
        const repos = await getList("dsh", force);
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
            const record = installedMap.get(repo.full_name);
            const slug = slugify(repo.name);
            const owner = slugify(String(repo.full_name).split("/")[0] ?? "");
            let installedVersion = record && record.version ? record.version : null;
            if (!installedVersion) {
              // 目录名可能来自包名而非仓库名（如 dsh-plugin-marketplace vs DSH-Plugins-Marketplace），
              // 用包名映射表按仓库名/原始仓库名/索引包名查找已装版本（repository 校验防撞名）。
              const versionKeys = [slug, repo.name];
              if (repo.pkg_name) versionKeys.push(repo.pkg_name);
              const hit = await matchProfileEntry(profile, repo, versionKeys);
              installedVersion = hit && hit.version ? hit.version : null;
            }
            // m2：仅已装版本严格低于最新版本才提示「更新」（仓库回滚/降级不再误报）。
            // v1.3.4：latestVersion 优先取 registry 索引里的版本号（CI 每 2 小时刷新，
            // 真实反映仓库最新版）；旧实现只读本地安装缓存——缓存只在安装动作时重建，
            // 导致手动安装的插件永远不提示更新、正常安装的插件也发现不了新版本。
            const latestVersion = repo.version ?? (await readPackageVersion(join(CACHE_DIR, `${owner}__${slug}`)));
            // m2：仅已装版本严格低于最新版本才提示「更新」（仓库回滚/降级不再误报）
            const updateAvailable = Boolean(installedVersion && latestVersion && compareVersions(installedVersion, latestVersion) < 0);
            flagged[idx] = Object.assign({}, repo, {
              installed: await detectInstalled(repo),
              installedVersion,
              latestVersion,
              updateAvailable
            });
          }
        };
        await Promise.all(Array.from({ length: workers }, () => worker()));
        // pkg_name 冲突消解放到已安装识别之后：同一 pkg_name 在 node_modules 的安装目标互斥
        // （同目录互相覆盖），列表只保留一个——已安装的优先（含用户手动安装的低 Star 仓库，
        // detectInstalled 已按 profile/repository 匹配标记），否则保留 Star 高者。
        const deduped = dedupeReposByPkgName(flagged, (r) => r.installed === true);
        // 排序：已安装置顶，其余按 Star 数从高到低
        deduped.sort((a, b) => {
          if (a.installed !== b.installed) return a.installed ? -1 : 1;
          return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
        });
        json(res, 200, { repos: deduped, cached_at: listCaches.dsh.at, total: deduped.length });
      } catch (error) {
        json(res, 500, { error: t(lang, "listFail", { err: String(error?.message ?? error) }) });
      }
    }
  });

  // 通用 Skills 栏目：数据来自 skills.json（CI 全量索引，含 has_skill / has_install_script 探测）。
  // 安装复用 /api/marketplace/install（skill 类型分支），本路由只做列表 + 已安装标注。
  webServer.register({
    kind: "exact",
    path: "/api/marketplace/skills",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: new URL(req.url, "http://x").searchParams.get("lang") });
      if (req.method !== "GET") return json(res, 405, { error: t(lang, "methodNotAllowed") });
      try {
        const force = new URL(req.url, "http://x").searchParams.get("refresh") === "1";
        const repos = await getList("skills", force);
        // 过滤：has_skill !== false 才进栏目（true 与 null 都显示，null 由前端弱化「未验证」）
        const list = repos.filter((r) => r.has_skill !== false);
        // 已安装标注（两重判定）+ 排序：已安装置顶，其余按 Star 降序
        const flagged = await Promise.all(list.map(async (repo) => {
          const record = installedMap.get(repo.full_name);
          return Object.assign({}, repo, {
            installed: await detectSkillInstalled(repo),
            installedAt: record && record.installedAt ? record.installedAt : null
          });
        }));
        // 与插件列表一致：pkg_name 冲突消解放在已安装识别之后（已安装优先，其次 Star 高者）
        const deduped = dedupeReposByPkgName(flagged, (r) => r.installed === true);
        deduped.sort((a, b) => {
          if (a.installed !== b.installed) return a.installed ? -1 : 1;
          return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
        });
        json(res, 200, { repos: deduped, cached_at: listCaches.skills.at, total: deduped.length, filtered: list.length });
      } catch (error) {
        json(res, 500, { error: t(lang, "listFail", { err: String(error?.message ?? error) }) });
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
      const repo = typeof body.repo === "string" ? body.repo.trim() : "";
      const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(res, 400, { error: t(langFull, "badRepo") });
      // 全局互斥：任何安装进行中时拒绝新的安装请求（客户端按钮也会同步禁用，这里是最终防线）
      if (installRunning !== null) return json(res, 409, { error: t(langFull, "installBusy") });
      const task = (async () => {
        const log = [];
        const logLine = (line) => log.push(line);
        let cacheDir = null;
        try {
          const [owner, repoName] = repo.split("/");
          cacheDir = join(CACHE_DIR, `${slugify(owner)}__${slugify(repoName)}`);
          logLine(t(langFull, "step1", { repo }));
          await mkdir(CACHE_DIR, { recursive: true });
          await rm(cacheDir, { recursive: true, force: true });
          await execFileAsync("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, cacheDir], { timeout: 180000 });
          logLine(t(langFull, "cloneDone"));

          const type = await detectType(cacheDir);
          logLine(t(langFull, "step2", { type: t(langFull, `type.${type}`) }));

          // R3：键存在即视为「已提供（空值=跳过）」，未提供的键才继续要材料；
          // scannedVars 是完整扫描列表，后续作为 env 注入的白名单（不能只传过滤后的缺失项，
          // 否则用户已提交的键反而不在 allowedAnswers 里，插件拿不到密钥）。
          // Skills and presets only copy files. README examples are not install-time API requirements.
          const scannedVars = ["script", "cordis-plugin"].includes(type) ? await scanRequirements(cacheDir) : [];
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
          // 执行前必须征求用户同意（拒绝则取消安装并清空全部痕迹）
          if (type === "cordis-plugin" && answers.__confirm_npm_scripts__ === void 0) {
            const scripts = await readLifecycleScripts(cacheDir);
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
          if (type === "cordis-plugin" && answers.__confirm_non_plugin__ === void 0) {
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
          if (type === "cordis-plugin" && answers.__confirm_build__ === void 0) {
            const needBuild = await needsPluginBuild(cacheDir);
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
            location: result.location ?? null,
            version: result.version ?? null,
            installedAt: Date.now()
          });
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
            log
          });
        }
        return json(res, 200, { status: "done", repo, installed, latestVersion, ...result, log });
      } catch (error) {
        // 清理失败安装留下的缓存克隆，避免残留目录导致「已安装」误判
        if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
        logLine(t(langFull, "fail", { err: String(error?.message ?? error) }));
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
    const presetId = slugify(repo.split("/")[1]);
    const dest = join(PRESETS_DIR, presetId);
    await mkdir(PRESETS_DIR, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(cacheDir, dest, { recursive: true, filter: copyFilter(cacheDir, true) });
    logLine(t(lang, "presetInstalled", { name: presetId, dest }));
    return { type, name: presetId, location: dest };
  }
  if (type === "script") {
    if (await exists(join(cacheDir, "install.ps1"))) {
      logLine(t(lang, "runPs1"));
      await execFileAsync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(cacheDir, "install.ps1")], { cwd: cacheDir, env, timeout: 600000 });
    } else {
      logLine(t(lang, "runSh"));
      await execFileAsync("bash", [join(cacheDir, "install.sh")], { cwd: cacheDir, env, timeout: 600000 });
    }
    logLine(t(lang, "scriptDone", { dir: cacheDir }));
    return { type, location: cacheDir };
  }
  if (type === "cordis-plugin") {
    let pkgName = slugify(repo.split("/")[1]);
    let deps = {};
    // 源码型插件（用户已确认构建）：构建先行——完整安装依赖（含 devDependencies）并执行
    // build 脚本，产物随复制一并进入 profile；构建流程已覆盖运行时依赖，跳过单独安装。
    const shouldBuild = String(answers.__confirm_build__) === "allow";
    try {
      const pkg = JSON.parse(await readFile(join(cacheDir, "package.json"), "utf8"));
      if (typeof pkg.name === "string" && pkg.name.length > 0) pkgName = pkg.name;
      // 仅非构建路径清洗 pnpm 专用本地链接依赖（link:/workspace:）——npm 解析 manifest
      // 会报 EUNSUPPORTEDPROTOCOL；构建路径保留原样，由 pnpm 原生支持 link:/workspace:
      // （见 buildPluginPackage）。提前清洗会误删 monorepo 源码插件的构建依赖
      // （devDependencies 里的 link:/workspace:），导致 pnpm install + build 失败或产物不完整。
      if (!shouldBuild) {
        const removed = sanitizeManifest(pkg);
        if (removed.length > 0) {
          logLine(t(lang, "npmLocalDeps", { n: removed.length, names: removed.join(", ") }));
          await writeFile(join(cacheDir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
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
    if (shouldBuild) {
      await buildPluginPackage(cacheDir, env, logLine, lang);
      logLine(t(lang, "buildDone"));
    }
    if (!shouldBuild && Object.keys(deps).length > 0) {
      logLine(t(lang, "deps", { n: Object.keys(deps).length }));
      const allowScripts = String(answers.__confirm_npm_scripts__) === "allow";
      if (allowScripts) logLine(t(lang, "npmScriptsAllowed"));
      await npmInstallWithFallback(cacheDir, env, logLine, lang, allowScripts);
      logLine(t(lang, "depsDone"));
    }
    await mkdir(PROFILE_NM, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    // cordis 插件保留 node_modules（dependencies 需要随包复制），只排除 .git
    await cp(cacheDir, dest, { recursive: true, filter: copyFilter(cacheDir, false) });
    logLine(t(lang, "copied", { dest }));
    const entryId = slugify(pkgName);
    const appended = await appendPatchEntry(entryId, pkgName);
    logLine(appended ? t(lang, "patchDone", { id: entryId }) : t(lang, "patchExists"));
    const installedVersion = await readPackageVersion(dest);
    return { type, name: pkgName, location: dest, version: installedVersion };
  }
  const readme = await readFile(join(cacheDir, "README.md"), "utf8").catch(() => "");
  logLine(t(lang, "instructions"));
  logLine((readme || t(lang, "noReadme")).slice(0, 3000));
  return { type, instructions: true };
}

export { apply, detectInstalled, detectSkillInstalled, loadOwnRepo, scanProfilePackages, langOf, t, fetchAllRepos, fetchRegistryRepos, getList, isTrustedRequest, isTrustedHost, isSensitiveEnvKey, buildMinimalEnv, buildFilteredEnv, compareVersions, hasPatchEntry, normalizeRepo, appendPatchEntry, readLifecycleScripts, sanitizeManifest, isPnpmLocalDependency, matchProfileEntry, normalizeRepoRef, loadOfficialPackages, isOfficialPackage, readPackageSummary, findSkillRoots, detectType, dedupeReposByPkgName, needsPluginBuild };
