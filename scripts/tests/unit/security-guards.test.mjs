// 安全守卫契约测试——静态断言（不执行 lib）。
//
// 响应大小上限：registry/CDN/search 响应无大小限制（缓解：来源可信）——
// 根本问题 = 资源上限缺失。Content-Length 超 MAX_RESPONSE_BYTES(32MB) 直接
// 拒绝（fetchJson 抛错 / fetchRegistryRepos 换下一源）。
// __proto__ 原型污染（理论）：JSON 数据的 __proto__ 键经 Object.assign 的
// [[Set]] 触发原型 setter。safeAssign 用 Object.keys 显式剔除危险键（Object.keys
// 只枚举 own enumerable，__proto__ 作 own data property 可被枚举——需显式剔除）。
// GitHub 字段固定实际不可达，但边界防御成本为零，理论污染面一并封死。

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// 契约匹配「lib 源码中存在某模式」——分层重构后函数分散到 lib/ 子目录，
// 递归读取全部 .js 拼接（路径无关；语义从「index.js 中存在」变为「lib 中存在」）。
const collectLib = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectLib(p));
    else if (e.name.endsWith(".js")) out.push(readFileSync(p, "utf8"));
  }
  return out;
};
const lib = collectLib(join(ROOT, "lib")).join("\n");
const indexLib = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
const registryCacheLib = readFileSync(join(ROOT, "lib", "infra", "registry-cache.js"), "utf8");
const profileScanLib = readFileSync(join(ROOT, "lib", "infra", "profile-scan.js"), "utf8");
const repositoryScanLib = readFileSync(join(ROOT, "lib", "infra", "repository-scan.js"), "utf8");
const classificationLib = readFileSync(join(ROOT, "lib", "app", "repository-classification.js"), "utf8");
const securityDomainLib = readFileSync(join(ROOT, "lib", "domain", "security-scan.js"), "utf8");
const securityScanLib = readFileSync(join(ROOT, "lib", "infra", "security-scan.js"), "utf8");
const legacyScanShimLib = readFileSync(join(ROOT, "lib", "domain", "scan.js"), "utf8");
const bundleRegisterLib = readFileSync(join(ROOT, "lib", "infra", "bundle-register.js"), "utf8");
const installExecLib = readFileSync(join(ROOT, "lib", "app", "install-exec.js"), "utf8");
const installedStateLib = readFileSync(join(ROOT, "lib", "app", "installed-state.js"), "utf8");
const installedIndexLib = readFileSync(join(ROOT, "lib", "domain", "installed-index.js"), "utf8");
const profileIndexLib = readFileSync(join(ROOT, "lib", "app", "profile-index.js"), "utf8");
const listRuntimeLib = readFileSync(join(ROOT, "lib", "app", "list-runtime.js"), "utf8");
const diagnosticsLib = readFileSync(join(ROOT, "lib", "app", "diagnostics.js"), "utf8");
const adaptorDomainLib = readFileSync(join(ROOT, "lib", "domain", "adaptor.js"), "utf8");
const adaptorInfraLib = readFileSync(join(ROOT, "lib", "infra", "adaptor.js"), "utf8");
const metadataInfraLib = readFileSync(join(ROOT, "lib", "infra", "marketplace-metadata.js"), "utf8");
const routesLib = readFileSync(join(ROOT, "lib", "http", "routes.js"), "utf8");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

check("profile scan 通过注入 fs", /fs: \{ readdir \}/.test(profileScanLib), true);
check("bundle register 通过注入 fs 与 resolver", /fs: \{ readFile, writeFile, rename, rm, realpath, exists \}/.test(bundleRegisterLib) && /resolvePackage/.test(bundleRegisterLib), true);
check("bundle register 无 IO/环境/入口反向依赖", !/(node:fs|node:path|process\.env|index\.js)/.test(bundleRegisterLib), true);
check("install executor 通过注入 fs/扫描/适配器", /fs: \{ mkdir, rm, cp, readFile, writeFile, readdir, exists \}/.test(installExecLib)
  && /scan: \{ findSkillRoots, findPluginRoots, findPresetRoots, readSkillManifest, needsPluginBuild \}/.test(installExecLib)
  && /adapters: \{ registerBundlePackage, appendPatchEntry \}/.test(installExecLib), true);
check("install executor 无 IO/环境/入口反向依赖", !/(node:fs|node:path|process\.env|from\s+["'][^"']*index\.js)/.test(installExecLib), true);
check("repository scan adapter 通过注入 fs/path/领域判定", /export function createRepositoryScanAdapter\(\{/.test(repositoryScanLib)
  && /fs: \{ readdir, readFile \}/.test(repositoryScanLib)
  && /path: \{ joinPath \}/.test(repositoryScanLib)
  && /\n  looksLikeDshPlugin,\n/.test(repositoryScanLib), true);
check("repository scan adapter 无 IO/环境/入口反向依赖", !/(node:fs|node:path|process\.env|index\.js)/.test(repositoryScanLib), true);
check("入口仅装配并转接 repository scan", /const repositoryScanAdapter = createRepositoryScanAdapter\(\{/.test(indexLib)
  && /const findSkillRoots = \(cacheDir, maxDepth = 5, limit = 200\) => repositoryScanAdapter\.findSkillRoots\(cacheDir, maxDepth, limit\);/.test(indexLib)
  && /const readLifecycleScripts = \(cacheDir\) => repositoryScanAdapter\.readLifecycleScripts\(cacheDir\);/.test(indexLib), true);
check("MAX_RESPONSE_BYTES = 32MB", /const MAX_RESPONSE_BYTES = 32 \* 1024 \* 1024;/.test(lib), true);
const sizeBody = lib.match(/function responseTooLarge\(res\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("responseTooLarge 存在", sizeBody.length > 0, true);
check("responseTooLarge 读 content-length", sizeBody.includes('res?.headers?.get?.("content-length")'), true);
check("responseTooLarge 恰好等于上限不算超限（> 非 >=）", /return len > MAX_RESPONSE_BYTES;/.test(sizeBody), true);
const fetchJsonBody = lib.match(/async function fetchJson\(url, extraHeaders = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("fetchJson 超限抛错", /if \(responseTooLarge\(res\)\) throw new Error\(`响应过大/.test(fetchJsonBody), true);
check("fetchRegistryRepos 超限换源", /if \(responseTooLarge\(res\)\) continue;/.test(registryCacheLib), true);

check("repository classification owner 提供工厂", /export function createRepositoryClassification\(\{/.test(classificationLib), true);
check("repository classification owner 无 IO/环境/入口反向依赖", !/(node:fs|node:path|process\.env|http\/|index\.js)/.test(classificationLib), true);
check("入口只装配并转接 repository classification", /const repositoryClassification = createRepositoryClassification\(\{/.test(indexLib)
  && /const detectTypeDetail = \(cacheDir\) => repositoryClassification\.detectTypeDetail\(cacheDir\);/.test(indexLib)
  && !/async function detectTypeDetail\(/.test(indexLib), true);

check("adaptor domain 无 IO/环境/入口反向依赖", /export function createAdaptorRules\(\{/.test(adaptorDomainLib)
  && !/(node:fs|node:path|node:http|process\.env|index\.js)/.test(adaptorDomainLib), true);
check("adaptor infra 通过注入配置并复用 domain", /export function createAdaptorAdapter\(\{/.test(adaptorInfraLib)
  && /loadConfig/.test(adaptorInfraLib)
  && /createAdaptorRules/.test(adaptorInfraLib), true);
check("adaptor infra 无全局 IO/环境/入口反向依赖", !/(node:fs|node:path|process\.env|globalThis\.fetch|index\.js)/.test(adaptorInfraLib), true);
check("metadata infra 通过注入 fs/path/resolver", /export function createMarketplaceMetadataAdapter\(\{/.test(metadataInfraLib)
  && /fs: \{ readFile, readdir \}/.test(metadataInfraLib)
  && /path: \{ dirnamePath, joinPath \}/.test(metadataInfraLib)
  && /resolveCorePackage/.test(metadataInfraLib), true);
check("metadata infra 持有两项缓存且不反向依赖入口", /let officialPackagesCache = null;/.test(metadataInfraLib)
  && /let ownRepo = null;/.test(metadataInfraLib)
  && !/(node:fs|node:path|process\.env|globalThis\.fetch|index\.js)/.test(metadataInfraLib), true);
check("入口装配 adaptor 与 metadata 且不重新声明缓存", /const adaptorAdapter = createAdaptorAdapter\(\{/.test(indexLib)
  && /const metadataAdapter = createMarketplaceMetadataAdapter\(\{/.test(indexLib)
  && !/(?:let|const) (?:officialPackagesCache|ownRepo)\s*=/.test(indexLib), true);
check("routes 不直接读取 adaptor 配置或 metadata 缓存", !/(adaptor\.json|officialPackagesCache|ownRepo)/.test(routesLib), true);

check("security domain 无 IO/HTTP/环境反向依赖", !/(node:fs|node:path|node:http|http\/|process\.env|index\.js)/.test(securityDomainLib), true);
check("legacy scan shim 不重新持有 IO", !/(node:fs|node:path|node:http|process\.env)/.test(legacyScanShimLib), true);
check("security adapter 提供工厂并注入 fs/path/network", /export function createSecurityScanAdapter\(\{/.test(securityScanLib)
  && /fs: \{ readFile, readdir, stat \}/.test(securityScanLib)
  && /path: \{ joinPath, relativePath \}/.test(securityScanLib)
  && /fetchImpl/.test(securityScanLib)
  && /readBodyLimited/.test(securityScanLib), true);
check("security adapter 不直接读取全局 fetch/环境", !/(node:fs|node:path|process\.env|globalThis\.fetch)/.test(securityScanLib), true);
check("入口只装配 security adapter 并转接扫描能力", /const securityScanAdapter = createSecurityScanAdapter\(\{/.test(indexLib)
  && /const \{[\s\S]*scanCacheVulnerabilities,[\s\S]*\} = securityScanAdapter;/.test(indexLib), true);

// ---- 执行边界：子进程输出上限（安装/自更新链）----
// execFile 默认 maxBuffer=1MB——npm/pnpm/dsh 安装输出超限即 ERR_CHILD_PROCESS_STDIO_MAXBUFFER
// 杀掉子进程（静默中断，实测 npm install 常见触发）。契约：proc 适配层统一
// maxBuffer=MAX_EXEC_BUFFER（32MB，与 MAX_RESPONSE_BYTES 同值对齐——统一的
// 「单次外部输入内存上限」语义），并强制隐藏窗口；具体平台分支由
// infra-proc.test.mjs 行为测试锁定。
check("MAX_EXEC_BUFFER = 32MB", /const MAX_EXEC_BUFFER = 32 \* 1024 \* 1024;/.test(lib), true);
check("MAX_BODY_BYTES = 1MB（突变测试 m11：唯一漏掉的上限常量）", /const MAX_BODY_BYTES = 1024 \* 1024;/.test(lib), true);
const safeOptionsBody = lib.match(/function safeOptions\(opts = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("proc 统一注入 maxBuffer 与 windowsHide", /return \{ \.\.\.opts, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true \};/.test(safeOptionsBody), true);

// ---- 解压边界：压缩炸弹（gz 源解压后膨胀）----
// readBodyLimited 限制的是压缩后字节——100MB 重复数据 gzip 后仅 ~100KB 全量放行，
// gunzipSync 解压出 100MB 内存膨胀（zip bomb）。zlib 的 maxOutputLength 选项在解压
// 过程中拦截（ERR_BUFFER_TOO_LARGE），超限弃源换下一级。契约：.gz 解压必须带
// maxOutputLength=MAX_RESPONSE_BYTES（解压后内存上限与原始字节上限同值对齐）。
// ---- 日志边界：单条日志截断与 owner 隔离 ----
// install/uninstall 失败时 err 直传 logLine，入口必须在 owner 内部先截断，且 routes 只能读取
// detached snapshot，避免响应持有可变的诊断数组。
check("LOG_LINE_MAX = 4096", /const LOG_LINE_MAX = 4096;/.test(lib), true);
check("diagnostics owner 工厂存在", /export function createDiagnosticsRuntime\(\{/.test(diagnosticsLib), true);
check("diagnostics owner 无 IO/HTTP/入口反向依赖", !/(node:fs|node:path|http\/|index\.js)/.test(diagnosticsLib), true);
check("diagnostics owner 持有环境缓存与日志环", /let envProfileCache = null;/.test(diagnosticsLib)
  && /let recentLogs = \[\];/.test(diagnosticsLib), true);
check("diagnostics pushLog 入口截断单条", /function pushLog\(line\) \{[\s\S]*?slice\(0, logLineMax\)/.test(diagnosticsLib), true);
check("diagnostics 日志环达到上限后淘汰头部", /recentLogs\.length > recentLogMax[\s\S]*?recentLogs\.splice\(0,/.test(diagnosticsLib), true);
check("diagnostics 日志读取返回 detached snapshot", /function getRecentLogs\(\) \{[\s\S]*?recentLogs\.slice\(\)/.test(diagnosticsLib), true);
check("入口不重新持有诊断状态", !/(envProfileCache|recentLogs)\s*=/.test(indexLib), true);
check("routes 不直接持有近期日志数组", !/recentLogs/.test(routesLib), true);

// ---- 磁盘缓存原子写（writeListCache）----
// e2e 竞态排查暴露：直接 writeFile 打开-截断-写入非原子——12MB bundled 写盘与后续
// 缓存写盘并发交错 → 文件半写损坏 → readListCache 解析失败静默降级 search（残缺结果）。
// 契约：tmp + rename 原子替换（与 saveInstalled/appendPatchEntry 同模式）。
check("writeListCache 原子写（tmp + rename）", /const tmp = path \+ "\.tmp";[\s\S]*?await rename\(tmp, path\);/.test(registryCacheLib), true);

// ---- profile 切换与安装互斥（issue #184）----
// 安装/卸载/自更新进行中切换 targetProfile：运行中安装路径读 PROFILE_NM/PATCH_FILE/
// PROFILE_NM 常量（registerBundlePackage/appendPatchEntry），切换落点突变 → 记录与
// 实体错位 / patch 写错 profile。契约：profile POST 在鉴权后、写配置前检查 installMutex。
check("profile POST 安装进行中拒绝切换（installMutex 互斥）", /path: "\/api\/marketplace\/profile"[\s\S]*?if \(installMutex\.isBusy\(\)\) return marketplaceJson\(res, 409, \{ error: t\(lang, "installBusy"\) \}\);/.test(lib), true);
check("profile POST 互斥检查位于配置写入之前", /path: "\/api\/marketplace\/profile"[\s\S]*?installMutex\.isBusy\(\)[\s\S]*?writeFile\(cfgPath, JSON\.stringify\(cfg, null, 2\), "utf8"\)/.test(lib), true);

// ---- 业务队列与安装互斥的层边界 ----
// patch manifest 的共享队列和 tmp+rename 由 infra-patch-manifest 行为契约直接锁定；
// installed state 的持久化队列由 owner 持有，profile/index 失效只在入口组合层订阅。
check("installed state 通过依赖注入队列", /queue,/.test(installedStateLib), true);
check("installed state 无 IO/环境/入口反向依赖", !/(node:fs|node:path|process\.env|from\s+[\"'][^\"']*index\.js)/.test(installedStateLib), true);
check("profile/index owner 通过注入订阅 installed 变更", /onInstalledChange: \(listener\) => installedState\.onChange\(listener\)/.test(indexLib), true);
check("profile/index owner 处理 installed 失效", /onInstalledChange\?\.\(invalidate\)/.test(profileIndexLib), true);
check("入口不再直接持有 installed Map/Queue", !/const installed(?:Map|Queue)\s*=/.test(indexLib), true);
check("安装互斥由 createMutex 工厂创建", /const installMutex = createMutex\(\);/.test(lib), true);

// ---- runtime owner 边界 ----
check("list runtime factory 存在", /export function createListRuntime\(\{/.test(listRuntimeLib), true);
check("list runtime 持有 TTL 缓存", /const listCaches = \{/.test(listRuntimeLib) && /ttlMs/.test(listRuntimeLib), true);
check("list runtime 持有列表单飞", /const listFetchings = \{/.test(listRuntimeLib) && /listFetchings\[kind\] == null/.test(listRuntimeLib), true);
check("list runtime 提供 detached metadata", /repos: Array\.isArray\(cache\.repos\)[\s\S]*?cache\.repos\.map\(\(repo\) =>/.test(listRuntimeLib), true);
check("list runtime 不导入 HTTP 或入口", !/(http\/|node:fs|node:path|index\.js)/.test(listRuntimeLib), true);
check("HTTP 不直接持有 list cache", !/listCaches/.test(readFileSync(join(ROOT, "lib", "http", "routes.js"), "utf8")), true);

// ---- CLI 安装记录带 profile 锚点提示----
// CLI 记录无包级 location（官方 CLI 自管落点），跨 profile 后卸载/检测更新无锚点
// 可依 → 回退当前 PROFILE_NM 落错 profile（孤儿态）。
// 行为断言：lib.test.mjs「锚点：CLI 记录 profile 提示定位到提示的 profile」等 8 处。
// 契约已随行为覆盖退役——不为此保留源码正则面。

// ---- 上游 v1.5.0 npm 等价回退（installNpmTargetToTemp）----
// npm 的平台启动形态由 infra/proc 的直接导入行为契约锁定；此处不再按 index.js
// 内部调用文本重复锁定，避免把适配层实现位置当成业务安全契约。

// 子进程平台包装、WSL 探测和参数数组由 infra-proc.test.mjs 直接导入行为测试锁定；
// 此处只保留 proc 适配层统一安全选项的静态契约。

// ---- issue #134：bundle 声明包必须走 profile bundles 层注册 ----
// bundle 包（dsh.bundle.patch）的实质在 patch 层；单条 insert 只挂载空壳入口
// （实测 @linxin666/dsh-web-ui-all：lib/index.js 空操作 shim + 15 个子插件行全在
// bundle patch）。
// 行为断言：lib.test.mjs「detectType bundle 声明 → bundle」「bundle 注册写入 profile
// dependencies」「bundle 卸载移除 profile dependencies」等 25+ 处覆盖检测/注册/回滚/
// 卸载/降级全链路。契约已随行为覆盖退役——不为此保留源码正则面。

// ---- 扫描边界：symlink 不跟随（扫描范围必须限于 cacheDir 内）----
// Dirent.isDirectory() 对 symlink 恒 false——若只有 isDirectory 分支判断，symlink 会落
// 进文件分支被 readFile 读取：恶意仓库可提交指向仓库外任意文件的 symlink（如
// install.sh → ~/.ssh/config），键名扫描就会读取仓库外内容。契约：扫描前显式跳过。
check("scanRequirements 显式跳过 symlink", /if \(entry\.isSymbolicLink\(\)\) continue;/.test(securityScanLib), true);

// ---- 消费侧路径注入防护：installed.json 可被篡改（readStateJson 只校验 JSON 合法性）----
// record.name / record.location 拼路径前必须校验（uninstall 已有 resolve 受管目录防线，
// check-update 与 env-keys 同样需要）：穿越段会读到/拼到任意目录。
check("check-update 包名形态校验（≤2 段 + 段字符集 + 排除 ./..）", /const parts = pkgName\.split\("\/"\);[\s\S]*?parts\.length > 2 \|\| parts\.some\(/.test(lib), true);
check("list handler cliNpmForm 分支同款校验（路径校验）",
  /const cliParts = cliTarget\.split\("\/"\);[\s\S]*?cliParts\.length > 2 \|\| cliParts\.some\(/.test(lib), true);
check("env-keys location 受管目录校验（扫描前；锚点按记录定位）", /const managed = \[resolveRecordNodeModules\(record\), SKILLS_DIR, PRESETS_DIR, CACHE_DIR\]\.some/.test(lib), true);

// ---- CLI 安装进程边界 ----
// CLI 的 Windows 包装、独立参数和窗口安全选项由 infra/proc 的 runDsh 直接导入行为测试锁定；
// index.js 只保留安装用例编排，不再按内部调用文本重复锁定。

// ---- 卸载 × 反馈队列交互：卸载后不得残留反馈询问 ----
// queueFeedback 在安装成功路径入队（同 repo 只留最新），但 uninstall 不清理队列——
// 卸载后下次打开市场仍弹「这个插件正常吗」（无意义询问，真实用户可见）。契约：
// 卸载成功路径必须 filter 掉该 repo 的 feedback 条目并持久化。
// 分层后 feedback 用例层持有 pending 状态与过滤逻辑；uninstall 通过注入的
// removePendingFeedback 与 saveFeedback 保持「有变化才持久化」的原子语义。
// 行为由 app-uninstall.test.mjs 与 app-feedback.test.mjs 锁定。
check("uninstall 清理 feedback 队列（≥2 处 filter：queueFeedback + uninstall）",
  (lib.match(/pendingFeedback = pendingFeedback\.filter/g) ?? []).length >= 2, true);
check("uninstall 清理后持久化 saveFeedback", /if \(removePendingFeedback\(repo\)\) await saveFeedback\(\);/.test(lib), true);

// ---- 本地状态文件边界：installed.json 损坏不得静默当空 ----
// 静默 catch 会把「文件损坏」与「文件不存在」混为一谈——损坏时所有已安装标注
// 消失、误判未安装导致重复安装（数据丢失不可恢复）。
// 行为断言：installed-load.test.mjs 场景 A（损坏 installed.json 备份 + 空清单）/
// 场景 B（无文件不备份）/ 场景 C（备份失败 WARN 兜底）/ 场景 D（feedback/envs 损坏
// 同款备份 + pending 以空恢复）。契约已随行为覆盖退役——不为此保留源码正则面。
// win32 下 script 型插件 install.sh 执行器：PATH 的 bash 可能是 WSL（吞反斜杠路径 →
// 127 全挂）——非 MSYS 时转 /mnt/<盘> POSIX（wslPosixPath 纯函数已由 lib-pure 行为覆盖）。
// install.sh 的 WSL/MSYS 探测与路径转换由 infra-proc.test.mjs 直接导入行为测试锁定。check("wslPosixPath 导出", /export \{[\s\S]*\bwslPosixPath\b/.test(lib), true);
check(".gz 解压带 maxOutputLength（防压缩炸弹）",
  /gunzip\(await readBodyLimited\(res\), \{ maxOutputLength: maxResponseBytes \}\)/.test(registryCacheLib), true);
check("WebDAV 恢复响应限流（同语义）", /if \(responseTooLarge\(response\)\) throw/.test(lib), true);

// ---- 读取一致性：全部 fetch 响应经 readBodyLimited（快路径除外）----
// 版本检查（checkSelfUpdate/doSelfUpdate）/npm 元数据（fetchNpmLatest）/feedback issue
// 创建/WebDAV 恢复——裸 res.json() 会把整个 body 读入内存（npm 大包元数据可达 MB 级）。
// 契约：res.json() 仅允许出现在 fetchJson 快路径（content-length 已知 ≤32MB 时）
// ——其余响应读取一律 readBodyLimited（32MB 上限 + chunked 流式计数）。
check("res.json() 仅剩 fetchJson 快路径 1 处", (lib.match(/await res(2)?\.json\(\)/g) ?? []).length, 1);
check("全部响应读取经 readBodyLimited（≥8 处）", (lib.match(/readBodyLimited\((?:res|response)(?:2)?\)/g) ?? []).length >= 8, true);

// ---- safeAssign 防原型污染 ----
// 行为断言：lib.test.mjs「safeAssign 剔除 __proto__ 键」「剔除 constructor/
// prototype（own 检查）」「保留正常字段」等 7 处覆盖执行行为。
// 契约已随行为覆盖退役——不为此保留源码正则面。

const PUBLIC_TEXT_RULES = [
  ["内部编号", /\b(?:P|Q|T|A|B|C|H|K|M)\d+(?:-[A-Za-z0-9]+)?\b/],
  ["轮次标记", /第[一二三四五六七八九十0-9]+(?:轮|阶段)|首批|本轮|本批次/],
  ["内部评审标记", /自审|内部审查|代码审查/],
  ["迁移过程标记", /迁移前|迁移状态/]
];

function collectPublicFiles(dir, extensions, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !["node_modules", ".git", "test-results"].includes(entry.name)) {
      collectPublicFiles(join(dir, entry.name), extensions, out);
    } else if (!entry.isDirectory() && extensions.some((extension) => entry.name.endsWith(extension))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function extractComments(source) {
  const comments = [];
  let state = "code";
  let current = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "'" || ch === '"' || ch === "`") state = ch;
      else if (ch === "/" && next === "/") {
        state = "line";
        current = "";
        i++;
      } else if (ch === "/" && next === "*") {
        state = "block";
        current = "";
        i++;
      }
    } else if (state === "line") {
      if (ch === "\n") {
        comments.push(current);
        current = "";
        state = "code";
      } else if (ch !== "\r") {
        current += ch;
      }
    } else if (state === "block") {
      if (ch === "*" && next === "/") {
        comments.push(current);
        current = "";
        state = "code";
        i++;
      } else {
        current += ch;
      }
    } else if (ch === "\\") {
      i++;
    } else if (ch === state) {
      state = "code";
    }
  }
  if (state === "line" || state === "block") comments.push(current);
  return comments.join("\n");
}

const publicTextFindings = [];
for (const file of collectPublicFiles(join(ROOT, "docs"), [".md"])) {
  const text = readFileSync(file, "utf8");
  for (const [label, pattern] of PUBLIC_TEXT_RULES) {
    if (pattern.test(text)) publicTextFindings.push(`${file}: ${label}`);
  }
}
for (const file of [
  ...collectPublicFiles(join(ROOT, "lib"), [".js"]),
  ...collectPublicFiles(join(ROOT, "scripts"), [".js", ".mjs"])
]) {
  const comments = extractComments(readFileSync(file, "utf8"));
  for (const [label, pattern] of PUBLIC_TEXT_RULES) {
    if (pattern.test(comments)) publicTextFindings.push(`${file}: ${label}`);
  }
}
check("公共文档与源码注释不含内部推进标识", publicTextFindings, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
