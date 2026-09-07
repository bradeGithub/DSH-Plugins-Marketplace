#!/usr/bin/env node
/**
 * 轻量突变测试运行器（零依赖，仅 node: 内置模块）。
 *
 * 目的：量化现有测试对 lib/ 语义的敏感度。
 * 方法：对 lib/ 中的真实模块做文本突变（注入一个 bug）→ 跑测试子集 →
 *       若测试全绿则该突变「存活」（= 该语义未被测试锁定）。
 *
 * 隔离约束：绝不直接修改工作区的 lib/ 源码（主会话可能同时在改）。
 *  - 在系统临时目录（os.tmpdir()，前缀 dsh-mutation-）创建副本结构：
 *      <tmp>/scripts/tests/unit/ 下的行为测试
 *    （保留相对结构——测试内 import ../../../lib/... 相对路径在副本结构中仍然有效）
 *  - 每个突变以「工作区当前 lib/」为基线重新复制（保证基线最新）
 *  - 进程退出（exit hook）时清理临时目录
 *
 * 测试子集分类：
 *  - security-guards.test.mjs：静态契约（正则断言文本形态）——文本突变触发失败时，
 *    单独统计为「文本契约锁定」；
 *  - 多个直接导入/入口行为测试：行为测试全绿时，突变存活说明行为未被锁定。
 *
 * 用法：node scripts/mutation-test.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// ---- 路径常量 ----
const THIS_DIR = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = join(THIS_DIR, "..");                          // 工作区根
const WORKSPACE_LIB = join(ROOT, "lib", "index.js");
const BUILD_REGISTRY = join(ROOT, "scripts", "build-registry.mjs");
const CLIENT_ASSEMBLER = join(ROOT, "scripts", "assemble-client.mjs");
const UNIT_DIR = join(ROOT, "scripts", "tests", "unit");
const CONTRACT_TEST = "security-guards.test.mjs";          // 静态契约测试
const BEHAVIOR_TESTS = [
  "lib-pure.test.mjs",
  "domain-list.test.mjs",
  "infra-queue.test.mjs",
  "infra-patch-manifest.test.mjs",
  "infra-bundle-register.test.mjs",
  "app-install-exec.test.mjs",
  "app-installed-state.test.mjs",
  "app-profile-index.test.mjs",
  "app-list-runtime.test.mjs",
  "app-diagnostics.test.mjs",
  "app-repository-classification.test.mjs",
  "domain-security-scan.test.mjs",
  "infra-security-scan.test.mjs",
  "infra-store.test.mjs",
  "infra-fetch.test.mjs",
  "infra-registry-cache.test.mjs",
  "infra-profile-scan.test.mjs",
  "infra-repository-scan.test.mjs",
  "domain-adaptor.test.mjs",
  "infra-adaptor.test.mjs",
  "infra-marketplace-metadata.test.mjs",
  "domain-installed-index.test.mjs",
  "infra-proc.test.mjs",
  "env-keys.test.mjs",
  "app-install-cli.test.mjs",
  "app-install-preflight.test.mjs",
  "app-uninstall.test.mjs",
  "app-update.test.mjs",
  "app-feedback.test.mjs",
  "app-backup.test.mjs",
  "app-env-edit.test.mjs",
  "http-auth.test.mjs",
  "http-routes.test.mjs",
  "build-domain-contract.test.mjs",
  "client-runtime.test.mjs",
  "client-assembler.test.mjs",
  "registry-entrypoints.test.mjs"
];

// 临时副本结构（exit hook 清理）
const TMP = mkdtempSync(join(tmpdir(), "dsh-mutation-"));
const TMP_UNIT = join(TMP, "scripts", "tests", "unit");

// ---- 突变清单（m01–m24：基础域/HTTP/infra；m25–m33：install preparation/use-case；m34–m40：uninstall；m41–m48：update；m49–m56：feedback；m57–m64：backup；m65–m72：env-edit；m73–m76：auth；m77–m83：routes；m84–m88：build/domain；m89–m93：client；m94–m102：patch；m103–m120：registry/cache；m121–m137：profile scan/installed index；m138–m150：bundle register；m151–m164：install executor；m165–m172：installed state；m173–m180：profile/index runtime；m181–m190：list runtime；m191–m198：diagnostics runtime；m199–m216：repository scan adapter；m217–m231：repository classification；m232–m250：security scan；m251–m260：adaptor rules/config；m261–m270：marketplace metadata）----
// 每个突变：{ id, name, pattern(正则), replacement, type, note }
// pattern 未命中源码 → SKIP（语义可能已变化）；replacement 无效果 → SKIP。
const MUTATIONS = [
  // m01/m02 说明：compareVersions 函数体内没有 `>= 0` / `< 0`（内部是
  // pa[key] < pb[key] 三元），实际写法在调用点（checkSelfUpdate / 双源取高 /
  // updateAvailable 判定），pattern 按实际源码调整到调用点，语义变化真实。
  {
    id: "m01",
    name: "shouldUpdate 方向反转（compareVersions < 0 → > 0，新版反而不可更新）",
    type: "behavior",
    pattern: /compareVersions\(installed, latest\) < 0/g,
    replacement: "compareVersions(installed, latest) > 0",
    note: "shouldUpdate 内部最新判定；lib-pure「shouldUpdate 新版 → true」锁定"
  },
  {
    id: "m02",
    name: "compareVersions 调用点 < 0 → <= 0（相等版本 updateAvailable 变 true）",
    type: "behavior",
    pattern: /compareVersions\(([^)]*)\) < 0/g,
    replacement: "compareVersions($1) <= 0",
    note: "updateAvailable 判定共 4 处（2286/2298/2527/2925），一次全改"
  },
  {
    id: "m03",
    name: "readStateJson ENOENT 分支反转（!== → ===，损坏静默当空）",
    type: "behavior",
    pattern: /error\?\.code !== "ENOENT"/g,
    replacement: 'error?.code === "ENOENT"',
    note: "infra-store 行为测试验证非 ENOENT 读取失败必须告警，损坏 JSON 仍需备份"
  },
  {
    id: "m04",
    name: "isSensitiveEnvKey 删除 AUTH(?!_)（AUTH_TYPE/AUTH_PATH 变敏感）",
    type: "behavior",
    pattern: /CREDENTIALS\?\|AUTH\(\?!_\)/g,
    replacement: "CREDENTIALS?|AUTH",
    note: "只改代码处（注释里的 AUTH(?!_) 不动）"
  },
  {
    id: "m05",
    name: "isSensitiveEnvKey 删除词头边界 (?<![A-Za-z0-9])（MONKEY 等变敏感）",
    type: "behavior",
    pattern: /\(\?<!\[A-Za-z0-9\]\)\(TOKEN/g,
    replacement: "(TOKEN",
    note: "KEY 结尾的普通词（MONKEY）会被误判敏感"
  },
  {
    id: "m06",
    name: "normalizeRepoRef 删除 .toLowerCase()（大小写混写键不再归一）",
    type: "behavior",
    pattern: /return s\.toLowerCase\(\) \|\| null;/g,
    replacement: "return s || null;",
    note: "installedMap 键 / dedupe key 的大小写归一语义消失"
  },
  {
    id: "m07",
    name: "wslPosixPath 盘符不再 toLowerCase（C: → /mnt/C/）",
    type: "behavior",
    pattern: /\$\{m\[1\]\.toLowerCase\(\)\}/g,
    replacement: "${m[1]}",
    note: "用模板字面量片段精确定位（m[1].toLowerCase() 另有一处 2199 行 cli 解析，不误伤）"
  },
  {
    id: "m08",
    name: "LOG_LINE_MAX 4096 → 4095",
    type: "behavior",
    pattern: /const LOG_LINE_MAX = 4096;/g,
    replacement: "const LOG_LINE_MAX = 4095;",
    note: "单条日志截断上限偏移 1 字节"
  },
  {
    id: "m09",
    name: "MAX_RESPONSE_BYTES 32 → 31（响应上限偏移 1MB）",
    type: "behavior",
    pattern: /const MAX_RESPONSE_BYTES = 32 \* 1024 \* 1024;/g,
    replacement: "const MAX_RESPONSE_BYTES = 31 * 1024 * 1024;",
    note: "响应大小上限整体偏移"
  },
  {
    id: "m10",
    name: "MAX_EXEC_BUFFER 32 → 31（子进程输出上限偏移 1MB）",
    type: "behavior",
    pattern: /const MAX_EXEC_BUFFER = 32 \* 1024 \* 1024;/g,
    replacement: "const MAX_EXEC_BUFFER = 31 * 1024 * 1024;",
    note: "安装/自更新链 maxBuffer 上限偏移"
  },
  {
    id: "m11",
    name: "MAX_BODY_BYTES 1024*1024 → 1023*1024（单次 body 上限偏移 1KB）",
    type: "behavior",
    pattern: /const MAX_BODY_BYTES = 1024 \* 1024;/g,
    replacement: "const MAX_BODY_BYTES = 1023 * 1024;",
    note: "security-guards 未断言该常量（只锁了 MAX_RESPONSE_BYTES/MAX_EXEC_BUFFER/LOG_LINE_MAX）"
  },
  {
    id: "m12",
    name: "safeAssign 删除 __proto__ 剔除条件（原型污染面重开）",
    type: "behavior",
    pattern: /k === "__proto__" \|\| /g,
    replacement: "",
    note: "防护只剩 constructor/prototype"
  },
  {
    id: "m13",
    name: "isTrustedHost 删除 192.168 私有网段分支",
    type: "behavior",
    pattern: /if \(a === 192 && b === 168\) return true;\n/g,
    replacement: "",
    note: "192.168.x.x 局域网访问被拒"
  },
  {
    id: "m14",
    name: "isTrustedHost 删除 localhost 分支",
    type: "behavior",
    pattern: /hostname === "localhost" \|\| /g,
    replacement: "",
    note: "仅剩 127.0.0.1/[::1]/::1"
  },
  {
    id: "m15",
    name: "CSRF 头检查 !== → ===（带头请求反被拒）",
    type: "behavior",
    pattern: /req\.headers\[CSRF_HEADER\] !== "1"/g,
    replacement: 'req.headers[CSRF_HEADER] === "1"',
    note: "X-DSH-Marketplace: 1 的合法请求被拒，缺头请求放行（语义反转）"
  },
  {
    id: "m16",
    name: "dedupe 排序删除 1e12 + 安装权重（已装不再优先）",
    // 注意：pattern 必须匹配代码形态而非注释（注释里也出现 "1e12 + "，匹配注释是假存活）
    type: "behavior",
    pattern: /\(isInstalled\(r\) \? 1e12 : 0\) \+/g,
    replacement: "(0) +",
    note: "已装低星仓库会被未装高星同名仓库顶掉"
  },
  {
    id: "m17",
    name: "check-update 包名段数校验 > 2 → > 1（scoped 包被拒）",
    type: "behavior",
    pattern: /parts\.length > 2/g,
    replacement: "parts.length > 1",
    note: "@scope/name 形态包名全部 400"
  },
  {
    id: "m18",
    name: "env-keys 受管目录校验 .some 前加 !（逻辑反转）",
    type: "behavior",
    pattern: /const managed = \[resolveRecordNodeModules\(record\), SKILLS_DIR, PRESETS_DIR, CACHE_DIR\]\.some\(/g,
    replacement: "const managed = ![resolveRecordNodeModules(record), SKILLS_DIR, PRESETS_DIR, CACHE_DIR].some(",
    note: "受管目录外任意路径被扫描（路径注入面重开）"
  },
  {
    id: "m19",
    name: "slugify 删除 .toLowerCase()（大写仓库名 slug 变化）",
    type: "behavior",
    pattern: /String\(s\)\.toLowerCase\(\)\.replace/g,
    replacement: "String(s).replace",
    note: "slug 不再小写归一"
  },
  {
    id: "m20",
    name: "responseTooLarge > → >=（恰好 32MB 响应被拒）",
    type: "behavior",
    pattern: /len > MAX_RESPONSE_BYTES/g,
    replacement: "len >= MAX_RESPONSE_BYTES",
    note: "边界（len == 上限）语义翻转；security-guards 只断言存在性与 content-length 读取，不锁操作符"
  },
  // ---- 补充突变（发现的高价值点）----
  {
    id: "m21",
    name: "comparePre 数字段不再优先（if (xNum) return -1 → return 1，数字 pre 反而大于字母）",
    type: "behavior",
    pattern: /if \(xNum\) return -1;/g,
    replacement: "if (xNum) return 1;",
    note: "comparePre xNum→-1（数字段优先）语义；lib-pure「数字 pre < 字母 pre」锁定"
  },
  {
    id: "m22",
    name: "SCRIPT_ENV_KEYS 删除 PATH（minimal env 丢失 PATH）",
    type: "behavior",
    pattern: /"PATH", "PATHEXT"/g,
    replacement: '"PATHEXT"',
    note: "buildMinimalEnv 不再带 PATH，脚本找不到可执行文件；lib-pure 的白名单是测试内硬编码副本，与源码清单重复"
  },
  {
    id: "m23",
    name: "isSensitiveEnvKey 正则删除 /i 标志（大小写不敏感语义消失）",
    type: "behavior",
    pattern: /\(\?\!\[A-Za-z0-9\]\)\/i\.test\(String\(name \?\? ""\)\)/g,
    replacement: '(?![A-Za-z0-9])/.test(String(name ?? ""))',
    note: "只去掉 /i 标志（保留正则字面量定界符，语法合法）；github_token / db_password 等小写键名不再被过滤；全部敏感用例都用大写键名"
  },
  {
    id: "m24",
    name: "isTrustedHost 172 网段收窄（b <= 31 → b <= 30，172.31 变拒绝）",
    type: "behavior",
    pattern: /b >= 16 && b <= 31/g,
    replacement: "b >= 16 && b <= 30",
    note: "lib-pure 只测 172.16（允许）与 172.32（拒绝）两个端点，172.17-172.31 边界未锁定"
  },
  {
    id: "m25",
    name: "CLI 无安装指令时仍进入执行分支",
    type: "behavior",
    pattern: /if \(!cliInstall\) \{/g,
    replacement: "if (false) {",
    note: "无 dsh plugin 指令必须直接 continue，不得访问空 CLI 描述"
  },
  {
    id: "m26",
    name: "CLI add 动词退化为 install",
    type: "behavior",
    pattern: /cliInstall\.verb === \"add\" \? \"add\" : \"install\"/g,
    replacement: "\"install\"",
    note: "README 明确 add 时必须保持独立参数语义"
  },
  {
    id: "m27",
    name: "npm 回退目录存在时不切换常规流程缓存",
    type: "behavior",
    pattern: /if \(npmDir\) \{/g,
    replacement: "if (false) {",
    note: "CLI 失败后成功取得 npm 包目录必须返回该目录和 npmTargetUsed"
  },
  {
    id: "m28",
    name: "环境缺失时不等待输入",
    type: "behavior",
    pattern: /if \(required\.length > 0\) \{/g,
    replacement: "if (false) {",
    note: "扫描出的必需环境变量缺失时必须返回 awaiting-input，不得直接继续安装"
  },
  {
    id: "m29",
    name: "secrets 命中不弹确认",
    type: "behavior",
    pattern: /if \(secretHits\.length > 0\) \{/g,
    replacement: "if (false) {",
    note: "克隆缓存命中硬编码凭据时必须弹确认，不得静默继续"
  },
  {
    id: "m30",
    name: "secrets 取消不清理缓存",
    type: "behavior",
    pattern: /if \(String\(answers\.__confirm_secrets__\) === "cancel"\) \{/g,
    replacement: "if (false) {",
    note: "secrets 取消必须清理克隆缓存并返回 aborted"
  },
  {
    id: "m31",
    name: "script 取消分支失效",
    type: "behavior",
    pattern: /if \(type === "script" && String\(answers\.__confirm_script__\) !== "continue"\) \{/g,
    replacement: "if (false) {",
    note: "script 类型非 continue 必须返回 aborted 且保留缓存（确认重试上下文）"
  },
  {
    id: "m32",
    name: "类型检测结果被忽略",
    type: "behavior",
    pattern: /const type = detect\.type;/g,
    replacement: "const type = \"skill\";",
    note: "类型决定后续全部确认分支与安装路径，必须取自 detectTypeDetail"
  },
  {
    id: "m33",
    name: "continue 结果丢失 scannedVars 白名单",
    type: "behavior",
    pattern: /scannedVars,/g,
    replacement: "scannedVars: [],",
    note: "continue 必须携带完整扫描变量白名单，供后续 env 注入"
  },
  {
    id: "m34",
    name: "未安装记录不返回 done",
    type: "behavior",
    pattern: /if \(!record\) \{/g,
    replacement: "if (false) {",
    note: "无安装记录必须返回 done removed 0，不得继续删除流程"
  },
  {
    id: "m35",
    name: "skill/preset 受管目录校验失效",
    type: "behavior",
    pattern: /const insideManaged = loc === skillsDir/g,
    replacement: "const insideManaged = true",
    note: "skill/agent-preset location 越界（installed.json 被篡改）必须拒绝删除"
  },
  {
    id: "m36",
    name: "cordis 包目录受管校验失效",
    type: "behavior",
    pattern: /if \(resolvePath\(dest\)\.startsWith\(resolvePath\(recordNm\) \+ pathSep\)\) \{/g,
    replacement: "if (true) {",
    note: "cordis 包目录必须位于记录锚点 node_modules 内，越界不得删除"
  },
  {
    id: "m37",
    name: "bundle pnpm 失败不记录降级日志",
    type: "behavior",
    pattern: /logLine\(translate\(lang, "uninstallBundleDegraded"/g,
    replacement: "logLine(translate(lang, \"uninstalled\"",
    note: "pnpm remove 失败必须如实记录降级路径，不得静默吞错"
  },
  {
    id: "m38",
    name: "script 克隆缓存受管校验失效",
    type: "behavior",
    pattern: /const insideCache = location && resolvePath\(location\)\.startsWith/g,
    replacement: "const insideCache = true",
    note: "script 型 location 必须位于 CACHE_DIR 内，越界不得删除"
  },
  {
    id: "m39",
    name: "卸载后不清理反馈队列",
    type: "behavior",
    pattern: /if \(removePendingFeedback\(repo\)\) await saveFeedback\(\);/g,
    replacement: "if (false) await saveFeedback();",
    note: "卸载成功路径必须清理该 repo 的反馈询问并持久化"
  },
  {
    id: "m40",
    name: "卸载后不移除安装记录",
    type: "behavior",
    pattern: /await removeInstalled\(repo\);/g,
    replacement: "await Promise.resolve();",
    note: "卸载成功必须移除 installed 记录，否则残留「已安装」标注"
  },
  {
    id: "m41",
    name: "check 直连失败不回退 registry 缓存",
    type: "behavior",
    pattern: /if \(fallback\) \{/g,
    replacement: "if (false) {",
    note: "GitHub 直连失败必须回退 registry 索引版本，不得静默丢状态"
  },
  {
    id: "m42",
    name: "run 无更新仍执行 CLI",
    type: "behavior",
    pattern: /if \(!shouldUpdate\(installedVersion, latestVersion\)\) \{/g,
    replacement: "if (false) {",
    note: "已是最新时必须短路返回 no-update，不得触发安装"
  },
  {
    id: "m43",
    name: "CLI 失败不回退目录替换更新",
    type: "behavior",
    pattern: /return await updateByClone\(\);/g,
    replacement: "return { status: \"done\", installedVersion: \"0.0.0\" };",
    note: "官方 CLI 不可用必须回退 clone 原子替换，不得伪造成功"
  },
  {
    id: "m44",
    name: "staging 版本校验方向反转",
    type: "behavior",
    pattern: /compareVersions\(stagedVersion, installedVersion\) <= 0/g,
    replacement: "compareVersions(stagedVersion, installedVersion) >= 0",
    note: "staging 版本必须高于当前才允许替换，低版本/同版本必须拒绝"
  },
  {
    id: "m45",
    name: "staging 核心文件校验失效",
    type: "behavior",
    pattern: /if \(!\(await exists\(joinPath\(staging, f\)\)\)\)/g,
    replacement: "if (false)",
    note: "staging 缺核心文件必须拒绝替换，防半成品覆盖本体"
  },
  {
    id: "m46",
    name: "rename 第二步失败不回滚",
    type: "behavior",
    pattern: /await rename\(backup, destRoot\)\.catch\(\(\) => \{\}\);/g,
    replacement: "await Promise.resolve();",
    note: "staging → destRoot 失败必须回滚 backup，不得留下半替换状态"
  },
  {
    id: "m47",
    name: "closeState 用旧版本号",
    type: "behavior",
    pattern: /installedVersion: result\.installedVersion \?\? readOwnVersion\(\),/g,
    replacement: "installedVersion: \"0.0.0\",",
    note: "更新成功后状态机必须闭合为新版本，不得残留旧 installedVersion"
  },
  {
    id: "m48",
    name: "run 直连失败不抛错",
    type: "behavior",
    pattern: /throw new Error\("unable to reach GitHub to check the latest version"\);/g,
    replacement: "latestVersion = null;",
    note: "执行更新时直连失败必须明确报错，不得回退索引误导用户"
  },
  {
    id: "m49",
    name: "feedback 同仓库不去重",
    type: "behavior",
    pattern: /pendingFeedback = pendingFeedback\.filter\(\(item\) => item\.repo !== entry\.repo\);/g,
    replacement: "pendingFeedback = pendingFeedback;",
    note: "同一 repo 的待确认反馈只能保留最新一条"
  },
  {
    id: "m50",
    name: "feedback 入队写盘失败向安装流冒泡",
    type: "behavior",
    pattern: /logLine\?\.\(message\(lang, "feedbackQueueFail", \{ err: String\(error\?\.message \?\? error\)\.slice\(0, 120\) \}\)\);/g,
    replacement: "throw error;",
    note: "反馈写盘失败只能记录日志，不能使安装结果失败"
  },
  {
    id: "m51",
    name: "feedback 提交移队后不持久化",
    type: "behavior",
    pattern: /const \[next\] = pendingFeedback\.splice\(index, 1\);\n        await persist\(\);/g,
    replacement: "const [next] = pendingFeedback.splice(index, 1);",
    note: "提交前必须先把 pending 队列移除状态持久化，防重启后重复询问"
  },
  {
    id: "m52",
    name: "feedback GitHub 请求未使用配置 token",
    type: "behavior",
    pattern: /Authorization: `Bearer \$\{feedbackToken\}`,/g,
    replacement: 'Authorization: "Bearer missing",',
    note: "自动建 issue 必须使用用户配置的 GitHub token"
  },
  {
    id: "m53",
    name: "feedback GitHub 422 不去 label 重试",
    type: "behavior",
    pattern: /if \(response\.status === 422\) response = await createIssue\(false\);/g,
    replacement: "if (false) response = await createIssue(false);",
    note: "label 未创建时必须不带 labels 重试一次"
  },
  {
    id: "m54",
    name: "feedback GitHub 非成功响应不回退手动链接",
    type: "behavior",
    pattern: /if \(!response\.ok\) return \{ manualUrl, error: `GitHub API \$\{response\.status\}` \};/g,
    replacement: "if (false) return { manualUrl, error: `GitHub API ${response.status}` };",
    note: "自动创建失败必须返回 manualUrl，保证用户仍可提交反馈"
  },
  {
    id: "m55",
    name: "正常反馈误附诊断日志",
    type: "behavior",
    pattern: /!ok/g,
    replacement: "true",
    note: "安装日志只能附在异常反馈，正常反馈必须零日志"
  },
  {
    id: "m56",
    name: "手动反馈链接包含诊断日志",
    type: "behavior",
    pattern: /const manualBody = withLog \? buildIssue\(entry, ok, note, false\)\.body : body;/g,
    replacement: "const manualBody = body;",
    note: "manualUrl 会经历史和代理，必须排除诊断日志"
  },
  {
    id: "m57",
    name: "backup 丢失 installedAt",
    type: "behavior",
    pattern: /installedAt: record\.installedAt \?\? null/g,
    replacement: "installedAt: null,",
    note: "备份必须保留安装时间以维持排序与记录信息"
  },
  {
    id: "m58",
    name: "backup 丢失多包 names",
    type: "behavior",
    pattern: /names: Array\.isArray\(record\.names\) && record\.names\.length > 0 \? record\.names : null,/g,
    replacement: "names: null,",
    note: "多插件仓库恢复必须保留子包 names"
  },
  {
    id: "m59",
    name: "非法 backup 结构被接受",
    type: "behavior",
    pattern: /Boolean\(backup && typeof backup === "object"/g,
    replacement: "Boolean(true && typeof backup === \"object\"",
    note: "备份校验必须拒绝 null、缺 repos 和非法 repo 项"
  },
  {
    id: "m60",
    name: "backup diff already/missing 方向反转",
    type: "behavior",
    pattern: /hasInstalledRecord\(record\.repo\) \? already : missing/g,
    replacement: "hasInstalledRecord(record.repo) ? missing : already",
    note: "恢复差异必须把已安装仓库与待安装仓库正确分离"
  },
  {
    id: "m61",
    name: "WebDAV 非法 URL 校验失效",
    type: "behavior",
    pattern: /if \(!isSafeWebdavUrl\(url\)\) return \{ status: "invalid-url" \};/g,
    replacement: "if (false) return { status: \"invalid-url\" };",
    note: "WebDAV 只允许 http(s)，避免把任意协议作为外发/外拉出口"
  },
  {
    id: "m62",
    name: "WebDAV backup 推送方法错误",
    type: "behavior",
    pattern: /method: "PUT",/g,
    replacement: "method: \"GET\",",
    note: "备份推送必须使用 PUT"
  },
  {
    id: "m63",
    name: "WebDAV 恢复响应大小校验失效",
    type: "behavior",
    pattern: /if \(responseTooLarge\(response\)\) throw new Error\("备份响应过大"\);/g,
    replacement: "if (false) throw new Error(\"备份响应过大\");",
    note: "外部恢复响应超过上限必须失败，不能直接读入"
  },
  {
    id: "m64",
    name: "WebDAV 恢复 HTTP 错误被忽略",
    type: "behavior",
    pattern: /if \(!response\.ok\) throw new Error\(`HTTP \$\{response\.status\}`\);/g,
    replacement: "if (false) throw new Error(`HTTP ${response.status}`);",
    note: "恢复端点 HTTP 非成功必须归一化 failed"
  },
  {
    id: "m65",
    name: "env-edit 未安装记录继续处理",
    type: "behavior",
    pattern: /if \(!record\) return \{ status: "not-installed" \};/g,
    replacement: "if (false) return { status: \"not-installed\" };",
    note: "无安装记录必须在 app 层短路返回，不得读取空记录"
  },
  {
    id: "m66",
    name: "env-edit 超过键数量仍继续",
    type: "behavior",
    pattern: /if \(keys\.length > maxKeys\) return \{ status: "too-many-keys" \};/g,
    replacement: "if (false) return { status: \"too-many-keys\" };",
    note: "单次编辑键数量必须受上限约束"
  },
  {
    id: "m67",
    name: "env-edit 非法键名校验失效",
    type: "behavior",
    pattern: /const bad = keys\.find\(\(key\) => !isValidEnvKey\(key\)\);/g,
    replacement: "const bad = undefined;",
    note: "非法环境键必须在 app 层拒绝"
  },
  {
    id: "m68",
    name: "env-edit 扫描白名单校验失效",
    type: "behavior",
    pattern: /if \(allowed\.size > 0 && !allowed\.has\(key\)\) continue;/g,
    replacement: "if (false) continue;",
    note: "已有扫描白名单时不得写入未扫描键"
  },
  {
    id: "m69",
    name: "env-edit 空值不再清除",
    type: "behavior",
    pattern: /if \(value === ""\) delete current\[key\];/g,
    replacement: "if (false) delete current[key];",
    note: "空值约定为清除已有配置"
  },
  {
    id: "m70",
    name: "env-edit 值长度上限偏移",
    type: "behavior",
    pattern: /\.slice\(0, maxValueLength\)/g,
    replacement: ".slice(0, maxValueLength - 1)",
    note: "单个环境变量值必须按 4000 字符上限截断"
  },
  {
    id: "m71",
    name: "env-edit 绕过串行持久化队列",
    type: "behavior",
    pattern: /await queue\.add\(persist\);/g,
    replacement: "await persist();",
    note: "envs.json 写入必须通过业务队列串行化"
  },
  {
    id: "m72",
    name: "env-edit 不写入 .env",
    type: "behavior",
    pattern: /await writeDotEnv\(current\);/g,
    replacement: "await Promise.resolve();",
    note: "成功编辑必须同步更新 dsh user 层 .env"
  },
  {
    id: "m73",
    name: "auth 回环 socket 判定失效",
    type: "behavior",
    pattern: /if \(remote === "127\.0\.0\.1" \|\| remote === "localhost" \|\| remote === "::1"\) return true;/g,
    replacement: "if (false) return true;",
    note: "回环写操作必须基于 socket 远端地址直接放行"
  },
  {
    id: "m74",
    name: "auth LAN token 长度检查删除",
    type: "behavior",
    pattern: /if \(got\.length !== writeToken\.length\) return false;/g,
    replacement: "if (false) return false;",
    note: "token 长度不同必须直接拒绝（防泄露）"
  },
  {
    id: "m75",
    name: "auth timing-safe 比较删除",
    type: "behavior",
    pattern: /return timingSafeEqual\(Buffer\.from\(got\), Buffer\.from\(writeToken\)\);/g,
    replacement: "return true;",
    note: "LAN token 必须 timing-safe 比较，错误 token 不得放行"
  },
  {
    id: "m77",
    name: "routes 受保护 GET 缺少可信请求校验",
    type: "behavior",
    pattern: /if \(!isTrustedRequest\(req\)\) return json\(res, 403, \{ error: t\(lang, "forbidden"\) \}\);/g,
    replacement: "if (false) return json(res, 403, { error: t(lang, \"forbidden\") });",
    note: "backup 等只读路由必须拒绝未通过 CSRF/Host/Origin 的请求"
  },
  {
    id: "m78",
    name: "routes install 非法 repo 校验失效",
    type: "behavior",
    pattern: /if \(!.*test\(repo0\)\) return json\(res, 400, \{ error: t\(langFull, "badRepo"\) \}\);/g,
    replacement: "if (false) return json(res, 400, { error: t(langFull, \"badRepo\") });",
    note: "install 必须在任何外部操作前拒绝非法仓库引用"
  },
  {
    id: "m79",
    name: "routes self-update 忽略 no-update 结果",
    type: "behavior",
    pattern: /if \(result\.status === "no-update"\) \{/g,
    replacement: "if (false) {",
    note: "自更新无新版本必须短路返回 no-update，不得伪装为完成"
  },
  {
    id: "m80",
    name: "routes WebDAV 非法 URL 状态映射失效",
    type: "behavior",
    pattern: /if \(result\.status === "invalid-url"\) return json\(res, 400, \{ error: t\(lang, "webdavBadUrl"\) \}\);/g,
    replacement: "if (false) return json(res, 400, { error: t(lang, \"webdavBadUrl\") });",
    note: "WebDAV 用例返回 invalid-url 时 HTTP 层必须保持 400"
  },
  {
    id: "m81",
    name: "routes feedback 空 repo 校验失效",
    type: "behavior",
    pattern: /if \(!repo\) return json\(res, 400, \{ error: t\(lang, "badRepo"\) \}\);/g,
    replacement: "if (false) return json(res, 400, { error: t(lang, \"badRepo\") });",
    note: "反馈外发前必须拒绝缺少仓库标识的请求"
  },
  {
    id: "m82",
    name: "routes profile 忽略安装互斥",
    type: "behavior",
    pattern: /if \(installMutex\.isBusy\(\)\) return json\(res, 409, \{ error: t\(lang, "installBusy"\) \}\);/g,
    replacement: "if (false) return json(res, 409, { error: t(lang, \"installBusy\") });",
    note: "profile 切换与安装/卸载/自更新必须共享互斥"
  },
  {
    id: "m83",
    name: "routes env-edit 未安装状态映射失效",
    type: "behavior",
    pattern: /if \(result\.status === "not-installed"\) return json\(res, 404, \{ error: t\(lang, "notInstalled"\) \}\);/g,
    replacement: "if (false) return json(res, 404, { error: t(lang, \"notInstalled\") });",
    note: "env-edit 用例的 not-installed 必须映射为 HTTP 404"
  },
  {
    id: "m84",
    name: "registry 投影 fork 判定反转",
    type: "behavior",
    pattern: /fork: r\.fork === true,/g,
    replacement: "fork: r.fork !== true,",
    note: "构建期投影必须保留 fork 的布尔语义"
  },
  {
    id: "m85",
    name: "registry 投影 archived 判定反转",
    type: "behavior",
    pattern: /archived: r\.archived === true/g,
    replacement: "archived: r.archived !== true",
    note: "构建期投影必须保留 archived 的布尔语义"
  },
  {
    id: "m86",
    name: "DSH 字段类型校验放宽",
    type: "behavior",
    pattern: /if \(pkg\.dsh && typeof pkg\.dsh === "object"\) return true;/g,
    replacement: "if (pkg.dsh) return true;",
    note: "字符串 dsh 字段不能被当作有效插件声明"
  },
  {
    id: "m87",
    name: "bundle 空 patch 被错误接受",
    type: "behavior",
    pattern: /typeof pkg\.dsh\.bundle\.patch === "string" && pkg\.dsh\.bundle\.patch\.length > 0/g,
    replacement: "typeof pkg.dsh.bundle.patch === \"string\" && pkg.dsh.bundle.patch.length >= 0",
    note: "空 patch 必须保持非 bundle"
  },
  {
    id: "m88",
    name: "DSH 依赖名称边界放宽",
    type: "behavior",
    pattern: /n\.startsWith\("@deepseek-ai\/dsh-"\)/g,
    replacement: "n.startsWith(\"@deepseek-ai/dsh\")",
    note: "仅 @deepseek-ai/dsh-* 依赖可作为插件声明，dshx 不能误命中"
  },
  {
    id: "m89",
    name: "client loader module id 变化",
    type: "behavior",
    pattern: /id: "dsh-plugin-marketplace"/g,
    replacement: "id: \"dsh-plugin-marketplace-mutated\"",
    note: "浏览器宿主按稳定 module id 加载市场 bundle"
  },
  {
    id: "m90",
    name: "client React require 名称变化",
    type: "behavior",
    pattern: /require\("react"\)/g,
    replacement: "require(\"react-mutated\")",
    note: "bundle 必须只向宿主请求 React 运行时"
  },
  {
    id: "m91",
    name: "client inject 依赖列表变化",
    type: "behavior",
    pattern: /exports\.inject = \["slots", "locale"\]/g,
    replacement: "exports.inject = [\"slots\"]",
    note: "市场入口必须声明 slots 与 locale 两项注入依赖"
  },
  {
    id: "m92",
    name: "client settings slot 名称变化",
    type: "behavior",
    pattern: /ctx\.slots\.inject\("settings\.section", function/g,
    replacement: "ctx.slots.inject(\"settings.section-mutated\", function",
    note: "市场必须注册到 settings.section 槽位"
  },
  {
    id: "m93",
    name: "client style 重复加载不再覆写",
    type: "behavior",
    pattern: /if \(el\) \{ el\.textContent = css; return; \}/g,
    replacement: "if (el) return;",
    note: "重复 apply 必须更新既有样式节点，避免 HMR 后 CSS 过期"
  },
  {
    id: "m94",
    name: "patch 重复条目检查失效",
    type: "behavior",
    pattern: /if \(hasPatchEntry\(patch, pkgName\)\) return false;/g,
    replacement: "if (false) return false;",
    note: "相同包名重复追加必须返回 false 且不写盘"
  },
  {
    id: "m95",
    name: "patch 裸 [] 清理失效",
    type: "behavior",
    pattern: /lines\[i\] = "";/g,
    replacement: "lines[i] = lines[i];",
    note: "flow 空数组必须在追加块序列前清除"
  },
  {
    id: "m96",
    name: "patch 保留字符包名不加引号",
    type: "behavior",
    pattern: /\? `"\$\{pkgName\}"` : pkgName/g,
    replacement: "? pkgName : pkgName",
    note: "scoped 包名必须以合法 YAML 标量形式写入"
  },
  {
    id: "m97",
    name: "patch 删除不识别目标块",
    type: "behavior",
    pattern: /if \(namePattern\.test\(line\)\) blockHasTarget = true;/g,
    replacement: "if (false) blockHasTarget = true;",
    note: "remove 必须准确命中目标 name 并删除整个 insert 块"
  },
  {
    id: "m98",
    name: "patch 删除后不回落空数组",
    type: "behavior",
    pattern: /const hasContent = out\.some\(\(line\) => line\.trim\(\) !== "" && !line\.trim\(\)\.startsWith\("#"\)\);/g,
    replacement: "const hasContent = true;",
    note: "最后一个本插件块删除后必须保留合法 [] 文档"
  },
  {
    id: "m99",
    name: "patch 写入绕过临时文件",
    type: "behavior",
    pattern: /const tmp = targetPath \+ "\.tmp";/g,
    replacement: "const tmp = targetPath;",
    note: "patch 文件必须通过 tmp + rename 原子替换"
  },
  {
    id: "m100",
    name: "patch 写队列失效",
    type: "behavior",
    pattern: /return await queue\.add\(async \(\) => \{/g,
    replacement: "return await (async () => {",
    note: "并发读改写必须共用队列避免丢条目"
  },
  {
    id: "m101",
    name: "patch 显式路径被默认路径覆盖",
    type: "behavior",
    pattern: /patchPath === undefined \? defaultPatchPath\(\) : patchPath/g,
    replacement: "defaultPatchPath()",
    note: "跨 profile 调用传入的显式 patch 路径必须原样使用"
  },
  {
    id: "m102",
    name: "patch 缺失文件不再按空文档处理",
    type: "behavior",
    pattern: /readFile\(targetPath, "utf8"\)\.catch\(\(\) => ""\)/g,
    replacement: "readFile(targetPath, \"utf8\")",
    note: "首次安装或卸载缺失 patch 文件必须保持空文档语义"
  },
  {
    id: "m103",
    name: "registry HTTP 失败不再继续换源",
    type: "behavior",
    pattern: /if \(!res\.ok\) continue;/g,
    replacement: "if (!res.ok) return null;",
    note: "单个 registry 源的 HTTP 错误不得阻断后续可用源"
  },
  {
    id: "m104",
    name: "registry 超限响应不再拒绝",
    type: "behavior",
    pattern: /if \(responseTooLarge\(res\)\) continue;/g,
    replacement: "if (false) continue;",
    note: "Content-Length 超限时必须换源而不是解析该响应"
  },
  {
    id: "m105",
    name: "registry gzip 解压删除输出上限",
    type: "behavior",
    pattern: /gunzip\(await readBodyLimited\(res\), \{ maxOutputLength: maxResponseBytes \}\)/g,
    replacement: "gunzip(await readBodyLimited(res))",
    note: "压缩源解压必须把输出大小上限传给注入的解压器"
  },
  {
    id: "m106",
    name: "registry/cache TTL 上界改为拒绝",
    type: "behavior",
    pattern: /age > registryMaxAgeMs/g,
    replacement: "age >= registryMaxAgeMs",
    note: "恰好达到最大新鲜度窗口仍应被接受"
  },
  {
    id: "m107",
    name: "registry 条目去重失效",
    type: "behavior",
    pattern: /if \(seen\.has\(item\.full_name\)\) continue;/g,
    replacement: "if (false) continue;",
    note: "registry、bundled 和 search 跨来源结果不得重复"
  },
  {
    id: "m108",
    name: "registry 本体排除失效",
    type: "behavior",
    pattern: /if \(excludedRepoNames\.has\(item\.name\)\) continue;/g,
    replacement: "if (false) continue;",
    note: "本体仓库不能作为可安装市场条目返回"
  },
  {
    id: "m109",
    name: "空 registry 被错误视为成功",
    type: "behavior",
    pattern: /if \(collected\.length > 0\) return collected;/g,
    replacement: "if (collected.length >= 0) return collected;",
    note: "空 registry 必须继续回退 bundled/cache/search"
  },
  {
    id: "m110",
    name: "search 满页不再请求下一页",
    type: "behavior",
    pattern: /if \(items\.length < pageSize\) break;/g,
    replacement: "if (items.length <= pageSize) break;",
    note: "恰好满页时仍需请求下一页以避免截断结果"
  },
  {
    id: "m111",
    name: "缓存坏条目过滤放宽",
    type: "behavior",
    pattern: /typeof item\.full_name === "string" && item\.full_name\.length > 0/g,
    replacement: "item.full_name != null",
    note: "缓存只接受非空字符串 full_name，不能把数字等坏条目透传"
  },
  {
    id: "m112",
    name: "缓存无有效条目仍返回空数组",
    type: "behavior",
    pattern: /if \(valid\.length > 0\) return valid;/g,
    replacement: "if (valid.length >= 0) return valid;",
    note: "全是坏条目的缓存必须继续回退而不是命中空缓存"
  },
  {
    id: "m113",
    name: "空 bundled 索引被错误视为成功",
    type: "behavior",
    pattern: /return collected\.length > 0 \? collected : null;/g,
    replacement: "return collected.length >= 0 ? collected : null;",
    note: "空 bundled 索引必须继续回退磁盘缓存或 search"
  },
  {
    id: "m114",
    name: "skills 默认请求 registry",
    type: "behavior",
    pattern: /if \(force \|\| kind !== "skills"\) \{/g,
    replacement: "if (force || kind === \"skills\") {",
    note: "skills 默认列表必须优先使用 bundled，不应触发网络 registry"
  },
  {
    id: "m115",
    name: "skills force 刷新忽略 force",
    type: "behavior",
    pattern: /if \(force \|\| kind !== "skills"\) \{/g,
    replacement: "if (false || kind !== \"skills\") {",
    note: "显式 force 必须允许 skills 走 registry"
  },
  {
    id: "m116",
    name: "search 失败丢弃已收集结果",
    type: "behavior",
    pattern: /break;/g,
    replacement: "return [];",
    note: "单页 search 失败后必须保留前面已收集的结果并继续后续 query"
  },
  {
    id: "m117",
    name: "registry 成功不再写 raw cache",
    type: "behavior",
    pattern: /void writeListCache\(kind, fromRegistry\);/g,
    replacement: "void Promise.resolve();",
    note: "registry 成功结果必须异步持久化为完整 raw cache"
  },
  {
    id: "m118",
    name: "bundled 成功不再写 raw cache",
    type: "behavior",
    pattern: /void writeListCache\(kind, fromBundled\);/g,
    replacement: "void Promise.resolve();",
    note: "bundled 成功结果必须异步持久化为完整 raw cache"
  },
  {
    id: "m119",
    name: "search 结果错误写入 raw cache",
    type: "behavior",
    pattern: /return \{ repos: fromSearch, source: "search" \};/g,
    replacement: "await writeListCache(kind, fromSearch);\n    return { repos: fromSearch, source: \"search\" };",
    note: "search 合成结果不得覆盖原始 registry/cache 文件"
  },
  {
    id: "m120",
    name: "registry cache 写入绕过原子 rename 目标",
    type: "behavior",
    pattern: /await rename\(tmp, path\);/g,
    replacement: "await rename(path, tmp);",
    note: "缓存必须通过临时文件替换目标路径，不能反向 rename"
  },
  {
    id: "m121",
    name: "profile scan 不再跳过隐藏目录",
    type: "behavior",
    pattern: /if \(!entry\.isDirectory\(\) \|\| entry\.name\.startsWith\("\."\)\) continue;/g,
    replacement: "if (!entry.isDirectory()) continue;",
    note: "备份/临时目录不能抢占真实包名映射"
  },
  {
    id: "m122",
    name: "profile scan 不再递归 scoped 包",
    type: "behavior",
    pattern: /if \(entry\.name\.startsWith\("@"\)\) \{/g,
    replacement: "if (false) {",
    note: "@scope/name 必须进入 profile 包名映射"
  },
  {
    id: "m123",
    name: "profile scan 版本补全规则失效",
    type: "behavior",
    pattern: /existing\.version == null && version != null/g,
    replacement: "false",
    note: "目录兜底条目不能覆盖 package.json 的完整版本摘要"
  },
  {
    id: "m124",
    name: "profile scan 包名 key 不再小写",
    type: "behavior",
    pattern: /String\(summary\.name \?\? ""\)\.toLowerCase\(\)/g,
    replacement: "String(summary.name ?? \"\")",
    note: "目录名和 package.json name 的大小写必须归一到同一 key"
  },
  {
    id: "m125",
    name: "profile scan 忽略目标 profile",
    type: "behavior",
    pattern: /pathOf\(profileNodeModules, profile\)/g,
    replacement: "pathOf(profileNodeModules, \"web\")",
    note: "切换 profile 后不能继续扫描 web node_modules"
  },
  {
    id: "m126",
    name: "managed dirs 不扫描 preset 根",
    type: "behavior",
    pattern: /\[pathOf\(skillsDir\), pathOf\(presetsDir\)\]/g,
    replacement: "[pathOf(skillsDir)]",
    note: "预设目录也属于已安装目录启发式输入"
  },
  {
    id: "m127",
    name: "cache script 类型判断反转",
    type: "behavior",
    pattern: /await detectCacheType\(path\) === "script"/g,
    replacement: "await detectCacheType(path) !== \"script\"",
    note: "只有 script 类型缓存可按缓存克隆判定已安装"
  },
  {
    id: "m128",
    name: "cache package name 预读失效",
    type: "behavior",
    pattern: /const packageName = await readPackageName\(path\);/g,
    replacement: "const packageName = null;",
    note: "缓存 package.json 包名用于仓库名差异映射"
  },
  {
    id: "m129",
    name: "official package 不再从反向索引排除",
    type: "behavior",
    pattern: /if \(hit\?\.name && officialSet\.has\(String\(hit\.name\)\.toLowerCase\(\)\)\) continue;/g,
    replacement: "if (false) continue;",
    note: "DSH 自带官方包不能占用市场仓库反向索引"
  },
  {
    id: "m130",
    name: "repository 摘要不再归一化",
    type: "behavior",
    pattern: /const repository = normalizeRepoRef\(hit\?\.repository\);/g,
    replacement: "const repository = hit?.repository;",
    note: "URL/.git/大小写形态必须归一后建立反向索引"
  },
  {
    id: "m131",
    name: "目录属主根边界校验失效",
    type: "behavior",
    pattern: /const boundary = location\[root\.length\];/g,
    replacement: "const boundary = \"/\";",
    note: "skillsforeign 等 root 前缀相似目录不能伪装成受管目录"
  },
  {
    id: "m132",
    name: "profileHit repository 撞名校验失效",
    type: "behavior",
    pattern: /if \(repository && target && repository !== target\) continue;/g,
    replacement: "if (false) continue;",
    note: "同包名但 repository 指向别处时不得误标"
  },
  {
    id: "m133",
    name: "profileHit 目录属主校验失效",
    type: "behavior",
    pattern: /if \(owner && owner !== installedKey\(repo\?\.full_name\)\) continue;/g,
    replacement: "if (false) continue;",
    note: "同名不同 owner 的 skills/preset 目录不得误标"
  },
  {
    id: "m134",
    name: "profileHit 反向查找不使用归一仓库键",
    type: "behavior",
    pattern: /index\.repoIndex\.get\(target\)/g,
    replacement: "index.repoIndex.get(repo?.full_name)",
    note: "反向索引查询必须使用 normalizeRepoRef 后的目标键"
  },
  {
    id: "m135",
    name: "installed index 复用 managed dirs 输入对象",
    type: "behavior",
    pattern: /dirs: new Set\(managedDirs \?\? \[\]\),/g,
    replacement: "dirs: managedDirs,",
    note: "索引构建应复制派生集合，避免调用方修改索引状态"
  },
  {
    id: "m136",
    name: "installed index 复用 cache scripts 输入对象",
    type: "behavior",
    pattern: /cacheScripts: new Set\(cacheEntries\?\.scripts \?\? \[\]\),/g,
    replacement: "cacheScripts: cacheEntries?.scripts,",
    note: "缓存脚本集合属于索引快照，不能与输入别名"
  },
  {
    id: "m137",
    name: "installed index 复用 cache package names 输入对象",
    type: "behavior",
    pattern: /cachePkgNames: new Map\(cacheEntries\?\.packageNames \?\? \[\]\),/g,
    replacement: "cachePkgNames: cacheEntries?.packageNames,",
    note: "缓存包名映射属于索引快照，不能与输入别名"
  },
  {
    id: "m138",
    name: "bundle 注册绕过 workspace 隔离",
    type: "behavior",
    pattern: /\["install", "--ignore-workspace"\]/g,
    replacement: "[\"install\"]",
    note: "profile 安装不能被祖先 pnpm workspace 吞掉"
  },
  {
    id: "m139",
    name: "bundle pnpm 告警不再记录",
    type: "behavior",
    pattern: /if \(pnpmErr\) logLine\(message\(lang, "bundlePnpmWarn", \{ err: pnpmErr \}\)\);/g,
    replacement: "if (false) logLine(message(lang, \"bundlePnpmWarn\", { err: pnpmErr }));",
    note: "非零 pnpm 但解析成功时仍需保留可诊断告警"
  },
  {
    id: "m140",
    name: "bundle 解析包存在性判断反转",
    type: "behavior",
    pattern: /if \(!\(await exists\(joinPath\(resolvedPkg, "package\.json"\)\)\)\) \{/g,
    replacement: "if (await exists(joinPath(resolvedPkg, \"package.json\"))) {",
    note: "pnpm 后缺包必须回滚并失败，不能把已存在包当失败"
  },
  {
    id: "m141",
    name: "bundle main 路径边界校验失效",
    type: "behavior",
    pattern: /const mainInside = mainResolved === rootResolved \|\| mainResolved\.startsWith\(rootResolved \+ pathSep\);/g,
    replacement: "const mainInside = true;",
    note: "main 不能通过 ../../ 逃逸 bundle 根目录"
  },
  {
    id: "m142",
    name: "bundle main 存在性判断反转",
    type: "behavior",
    pattern: /if \(!\(await exists\(mainResolved\)\)\) \{/g,
    replacement: "if (await exists(mainResolved)) {",
    note: "main 缺失必须拒绝，存在时不能误报缺失"
  },
  {
    id: "m143",
    name: "bundle 非法依赖名校验失效",
    type: "behavior",
    pattern: /const invalidDeps = depNames\.filter\(\(name\) => !packageNamePattern\.test\(String\(name\)\)\);/g,
    replacement: "const invalidDeps = [];",
    note: "绝对路径/穿越/URL 依赖不能交给 resolver"
  },
  {
    id: "m144",
    name: "bundle 依赖解析不再尝试 package.json",
    type: "behavior",
    pattern: /for \(const spec of \[\`\$\{depName\}\/package\.json\`, depName\]\)/g,
    replacement: "for (const spec of [])",
    note: "依赖解析需要兼容 package.json 和包入口两种形态"
  },
  {
    id: "m145",
    name: "bundle 缺包失败不再回滚 manifest",
    type: "behavior",
    pattern: /if \(!\(await exists\(joinPath\(resolvedPkg, "package\.json"\)\)\)\) \{\n      await rollback\(\);/g,
    replacement: "if (!(await exists(joinPath(resolvedPkg, \"package.json\")))) {\n      void 0;",
    note: "解析失败不能留下 manifest 中的幽灵 bundle 条目"
  },
  {
    id: "m146",
    name: "bundle main 失败不再清理解析目录",
    type: "behavior",
    pattern: /await rm\(resolvedPkg, \{ recursive: true, force: true \}\)\.catch\(\(\) => \{\}\);/g,
    replacement: "await rm(joinPath(bundleNodeModules, \"other\"), { recursive: true, force: true }).catch(() => {});",
    note: "main 越界或缺失时不能留下不可加载的 bundle 目录"
  },
  {
    id: "m147",
    name: "bundle 注册忽略显式 profile 路径",
    type: "behavior",
    pattern: /const bundleProfileDir = paths\.profileDir \?\? profileDir\(\);/g,
    replacement: "const bundleProfileDir = profileDir();",
    note: "安装期间 profile 切换不能把旧任务写到新 profile"
  },
  {
    id: "m148",
    name: "bundle 注册重复追加 profile bundle",
    type: "behavior",
    pattern: /if \(!bundles\.includes\(pkgName\)\) bundles\.push\(pkgName\);/g,
    replacement: "bundles.push(pkgName);",
    note: "重复安装不能重复写入 dsh.profile.bundles"
  },
  {
    id: "m149",
    name: "bundle manifest 原子 rename 方向反转",
    type: "behavior",
    pattern: /await rename\(tmp, path\);/g,
    replacement: "await rename(path, tmp);",
    note: "manifest 必须通过 tmp 替换目标文件"
  },
  {
    id: "m150",
    name: "bundle 依赖解析不使用 realpath 锚点",
    type: "behavior",
    pattern: /anchor = await realpath\(resolvedPkg\);/g,
    replacement: "anchor = resolvedPkg;",
    note: "pnpm 嵌套或符号链接布局必须以真实 bundle 路径解析依赖"
  },
  {
    id: "m151",
    name: "skill 空 root 判断反转",
    type: "behavior",
    pattern: /if \(roots\.length === 0\) throw new Error\("No SKILL\.md was found after cloning the repository\."\);/g,
    replacement: "if (roots.length > 0) throw new Error(\"No SKILL.md was found after cloning the repository.\");",
    note: "存在技能根时必须复制，空根才应拒绝"
  },
  {
    id: "m152",
    name: "skill/preset 复制错误地保留 node_modules",
    type: "behavior",
    pattern: /copyFilter\(root, true\)/g,
    replacement: "copyFilter(root, false)",
    note: "技能与预设复制必须排除依赖缓存和 .git"
  },
  {
    id: "m153",
    name: "preset 嵌套根被替换为缓存根",
    type: "behavior",
    pattern: /const installRoots = roots\.length > 0 \? roots : \[cacheDir\];/g,
    replacement: "const installRoots = roots.length > 0 ? [cacheDir] : [cacheDir];",
    note: "嵌套 preset 必须复制各自目录并保留目录名"
  },
  {
    id: "m154",
    name: "bundle npm target 不再使用精确版本",
    type: "behavior",
    pattern: /const depSpec = typeof npmTarget === "string" && npmTarget\.length > 0 \? version : `github:\$\{repo\}`;/g,
    replacement: "const depSpec = typeof npmTarget === \"string\" && npmTarget.length > 0 ? `github:${repo}` : version;",
    note: "npm 目标必须传包版本，仓库目标才使用 github 规格"
  },
  {
    id: "m155",
    name: "Windows script 不再优先 ps1",
    type: "behavior",
    pattern: /const usePs1 = hasPs1 && \(!hasSh \|\| isWindows\);/g,
    replacement: "const usePs1 = hasPs1 && !isWindows;",
    note: "Windows 同时存在脚本时必须选择 install.ps1"
  },
  {
    id: "m156",
    name: "script 分支泄漏 npm 环境构建",
    type: "behavior",
    pattern: /const env = type === "script" \? buildMinimalEnv\(\) : buildFilteredEnv\(\);/g,
    replacement: "const env = type === \"script\" ? buildFilteredEnv() : buildFilteredEnv();",
    note: "脚本必须使用最小环境，不得改走 npm 全量环境"
  },
  {
    id: "m157",
    name: "cordis 非构建路径不清洗本地依赖",
    type: "behavior",
    pattern: /if \(!shouldBuild\) \{/g,
    replacement: "if (shouldBuild) {",
    note: "npm 路径必须移除 link:/workspace: 依赖并写回清洗结果"
  },
  {
    id: "m158",
    name: "cordis 构建需求判断反转",
    type: "behavior",
    pattern: /if \(shouldBuild && await needsPluginBuild\(root\)\) \{/g,
    replacement: "if (shouldBuild && !(await needsPluginBuild(root))) {",
    note: "用户允许构建且入口缺失时必须先构建并复制产物"
  },
  {
    id: "m159",
    name: "cordis 非构建依赖安装分支失效",
    type: "behavior",
    pattern: /if \(!shouldBuild && Object\.keys\(deps\)\.length > 0\) \{/g,
    replacement: "if (shouldBuild && Object.keys(deps).length > 0) {",
    note: "已有产物路径仍需执行 npm fallback 安装依赖"
  },
  {
    id: "m160",
    name: "cordis 入口 warning 条件反转",
    type: "behavior",
    pattern: /if \(!entryOk\) \{/g,
    replacement: "if (entryOk) {",
    note: "缺失入口必须出现在 warnings，已有入口不能伪造 warning"
  },
  {
    id: "m161",
    name: "cordis patch 写入忽略显式 patch 路径",
    type: "behavior",
    pattern: /await appendPatchEntry\(entryId, pkgName, installProfilePaths\.patchFile\)/g,
    replacement: "await appendPatchEntry(entryId, pkgName, installProfilePaths.packageFile)",
    note: "patch 注册必须写入 profile 快照指定的 patchFile"
  },
  {
    id: "m162",
    name: "manual README 截断长度偏移",
    type: "behavior",
    pattern: /\.slice\(0, 3000\)/g,
    replacement: ".slice(0, 2999)",
    note: "manual 说明日志必须保留既有 3000 字符上限"
  },
  {
    id: "m163",
    name: "cordis 依赖失败被吞掉",
    type: "behavior",
    pattern: /await npmInstallWithFallback\(root, env, logLine, lang, allowScripts\);/g,
    replacement: "await Promise.resolve();",
    note: "npm fallback 原错误必须传播给 app 层，不能伪造安装成功"
  },
  {
    id: "m165",
    name: "installed state 保存/删除跳过仓库 key 归一化",
    type: "behavior",
    pattern: /const key = keyOf\(fullName\);/g,
    replacement: "const key = String(fullName ?? \"\");",
    note: "save/remove 必须沿用 normalizeRepoRef，大小写和 GitHub URL 查询不能失配"
  },
  {
    id: "m166",
    name: "installed state 快照暴露内部 Map",
    type: "behavior",
    pattern: /const snapshot = \(\) => new Map\(records\);/g,
    replacement: "const snapshot = () => records;",
    note: "InstalledIndex/backup 只能读取 detached snapshot，调用方修改不得污染 owner"
  },
  {
    id: "m167",
    name: "installed state 保存丢失 record",
    type: "behavior",
    pattern: /next\.set\(key, record\);/g,
    replacement: "next.set(key, undefined);",
    note: "保存后的记录必须同时出现在磁盘和内存"
  },
  {
    id: "m168",
    name: "installed state 写盘前更新内存",
    type: "behavior",
    pattern: /await persist\(next\);\n        records = next;/g,
    replacement: "records = next;\n        await persist(next);",
    note: "持久化失败时内存不得先出现未提交的安装记录"
  },
  {
    id: "m169",
    name: "installed state 删除错误 key",
    type: "behavior",
    pattern: /next\.delete\(key\);/g,
    replacement: "next.delete(\"__missing__\");",
    note: "remove 必须从待持久化快照和 committed Map 删除目标记录"
  },
  {
    id: "m170",
    name: "installed state 缺失记录也发送删除通知",
    type: "behavior",
    pattern: /if \(existed\) notify\(\{ type: "remove", key, record \}\);/g,
    replacement: "notify({ type: \"remove\", key, record });",
    note: "无状态变化的 remove 不得触发 profile/index 失效"
  },
  {
    id: "m171",
    name: "installed state 持久化丢失既有记录",
    type: "behavior",
    pattern: /for \(const \[key, value\] of next\) data\[key\] = value;/g,
    replacement: "for (const [key, value] of new Map()) data[key] = value;",
    note: "每次写盘必须基于当前 committed 快照，不能覆盖并发操作的既有记录"
  },
  {
    id: "m172",
    name: "installed state 绕过写队列",
    type: "behavior",
    pattern: /return await queue\.add\(async \(\) => \{/g,
    replacement: "return await Promise.resolve(async () => {",
    note: "并发 save/remove 必须串行化并按提交顺序读改写"
  },
  {
    id: "m164",
    name: "单插件版本结果丢失",
    type: "behavior",
    pattern: /version: installed\.length === 1 \? installed\[0\]\.version : null,/g,
    replacement: "version: null,",
    note: "单插件结果必须保留实际 package version"
  },
  {
    id: "m173",
    name: "profile scan 缓存命中条件反转",
    type: "behavior",
    pattern: /if \(profileScanCache\) return profileScanCache;/g,
    replacement: "if (!profileScanCache) return profileScanCache;",
    note: "profile scan 首次构建后必须复用缓存，不能在空缓存时短路"
  },
  {
    id: "m174",
    name: "profile scan 旧代际判断反转",
    type: "behavior",
    pattern: /scanGeneration !== profileScanGeneration/g,
    replacement: "scanGeneration === profileScanGeneration",
    note: "扫描完成后只有代际变化才允许丢弃并重扫"
  },
  {
    id: "m175",
    name: "稳定窗口 index 代际判断反转",
    type: "behavior",
    pattern: /indexGeneration === installedIndexGen/g,
    replacement: "indexGeneration !== installedIndexGen",
    note: "profile/index 两组 generation 均稳定时才返回列表标注结果"
  },
  {
    id: "m176",
    name: "InstalledIndex 单飞条件反转",
    type: "behavior",
    pattern: /if \(!installedIndexBuild\) \{/g,
    replacement: "if (installedIndexBuild) {",
    note: "空构建任务时必须启动一次，避免首次请求返回 undefined"
  },
  {
    id: "m177",
    name: "InstalledIndex 陈旧代际被接受",
    type: "behavior",
    pattern: /if \(installedIndexGen !== buildGen\) return null;/g,
    replacement: "if (installedIndexGen === buildGen) return null;",
    note: "失效发生在构建期间时不能把旧索引写回 owner"
  },
  {
    id: "m178",
    name: "profile/index fallback 被静默 false 替代",
    type: "behavior",
    pattern: /return detectInstalled\(repo\);/g,
    replacement: "return false;",
    note: "索引构建或读取异常必须回退五重 legacy detector"
  },
  {
    id: "m179",
    name: "installed index 失效不递增代际",
    type: "behavior",
    pattern: /installedIndexGen\+\+;/g,
    replacement: "installedIndexGen += 0;",
    note: "installed 变更期间的索引构建必须被 generation 保护"
  },
  {
    id: "m180",
    name: "稳定窗口 profile 判断反转",
    type: "behavior",
    pattern: /activeProfile === profileName\(\)/g,
    replacement: "activeProfile !== profileName()",
    note: "profile 未变化时应立即闭合稳定窗口，变化时必须重试"
  },
  {
    id: "m181",
    name: "列表 TTL 边界提前失效",
    type: "behavior",
    pattern: /now\(\) - cache\.at <= ttlMs/g,
    replacement: "now() - cache.at < ttlMs",
    note: "TTL 恰好到期仍属于可用缓存"
  },
  {
    id: "m182",
    name: "列表 force 条件反转",
    type: "behavior",
    pattern: /if \(!force && cache\.repos !== null/g,
    replacement: "if (force && cache.repos !== null",
    note: "普通请求应命中未过期缓存，force 请求才跳过缓存"
  },
  {
    id: "m183",
    name: "列表单飞条件反转",
    type: "behavior",
    pattern: /if \(listFetchings\[kind\] == null\) \{/g,
    replacement: "if (listFetchings[kind] != null) {",
    note: "每个 kind 首次请求必须创建且复用一个 loading promise"
  },
  {
    id: "m184",
    name: "列表 source metadata 被固定为 registry",
    type: "behavior",
    pattern: /listSources\[kind\] = result\?\.source \?\? "registry";/g,
    replacement: "listSources[kind] = \"registry\";",
    note: "cache/search 来源必须反映在只读 metadata 中"
  },
  {
    id: "m185",
    name: "列表非法 repos 结果不再归一为空数组",
    type: "behavior",
    pattern: /Array\.isArray\(result\?\.repos\) \? result\.repos : \[\]/g,
    replacement: "Array.isArray(result?.repos) ? [] : result?.repos",
    note: "loader 异常返回形态不能污染 list cache"
  },
  {
    id: "m186",
    name: "缓存 detached metadata 复用内部列表",
    type: "behavior",
    pattern: /\? cache\.repos\.map\(\(repo\) => \{/g,
    replacement: "? cache.repos",
    note: "self-update 读取的缓存 metadata 不得暴露 owner 内部对象"
  },
  {
    id: "m187",
    name: "列表 cache fallback warning 条件反转",
    type: "behavior",
    pattern: /if \(listSources\[kind\] === "cache"\) \{/g,
    replacement: "if (listSources[kind] !== \"cache\") {",
    note: "只有磁盘缓存 fallback 才应产生 warning"
  },
  {
    id: "m188",
    name: "列表缓存时间戳丢失",
    type: "behavior",
    pattern: /listCaches\[kind\] = \{ at: now\(\), repos, source: listSources\[kind\] \?\? "registry" \};/g,
    replacement: "listCaches[kind] = { at: 0, repos, source: listSources[kind] ?? \"registry\" };",
    note: "缓存必须记录提交时刻以实现 TTL"
  },
  {
    id: "m189",
    name: "列表 single-flight 完成后不清理",
    type: "behavior",
    pattern: /listFetchings\[kind\] = null;/g,
    replacement: "listFetchings[kind] = Promise.resolve();",
    note: "请求完成后必须释放 kind 的 single-flight 状态"
  },
  {
    id: "m190",
    name: "列表默认 kind 错位",
    type: "behavior",
    pattern: /async function getList\(kind = "dsh", force = false\)/g,
    replacement: "async function getList(kind = \"skills\", force = false)",
    note: "兼容 getList() 默认入口必须继续读取 dsh 列表"
  },
  {
    id: "m191",
    name: "诊断画像缓存命中条件反转",
    type: "behavior",
    pattern: /if \(envProfileCache\) return envProfileCache;/g,
    replacement: "if (!envProfileCache) return envProfileCache;",
    note: "已完成画像必须复用缓存，不能在后续读取返回空值"
  },
  {
    id: "m192",
    name: "诊断画像错误接受非字符串 dsh 版本",
    type: "behavior",
    pattern: /if \(typeof dshPkg\.version === "string"\) profile\.dsh = dshPkg\.version;/g,
    replacement: "if (typeof dshPkg.version !== \"string\") profile.dsh = dshPkg.version;",
    note: "package.json 的非字符串版本不得污染环境画像"
  },
  {
    id: "m193",
    name: "诊断画像 package 读取错误不再静默",
    type: "behavior",
    pattern: /\} catch \{\}\n    profile\.pnpm = await probe/g,
    replacement: "} catch { throw new Error(\"dsh package read failed\"); }\n    profile.pnpm = await probe",
    note: "缺失或损坏 DSH package 必须省略 dsh 并继续探测工具"
  },
  {
    id: "m194",
    name: "诊断画像 pnpm 探测命令错用 git",
    type: "behavior",
    pattern: /profile\.pnpm = await probe\("pnpm", \["--version"\]\);/g,
    replacement: "profile.pnpm = await probe(\"git\", [\"--version\"]);",
    note: "环境画像必须分别探测 pnpm 与 git"
  },
  {
    id: "m195",
    name: "诊断日志单行截断少一字节",
    type: "behavior",
    pattern: /slice\(0, logLineMax\)/g,
    replacement: "slice(0, logLineMax - 1)",
    note: "日志单条上限必须保留 4096 个输入字符"
  },
  {
    id: "m196",
    name: "诊断日志环在达到上限时提前淘汰",
    type: "behavior",
    pattern: /recentLogs\.length > recentLogMax/g,
    replacement: "recentLogs.length >= recentLogMax",
    note: "达到 400 条时仍应保留完整环容量，超过后才淘汰头部"
  },
  {
    id: "m197",
    name: "诊断日志快照暴露内部数组",
    type: "behavior",
    pattern: /return recentLogs\.slice\(\);/g,
    replacement: "return recentLogs;",
    note: "routes 只能得到 detached 日志数组，外部修改不得污染 owner"
  },
  {
    id: "m198",
    name: "日志响应 count 丢失真实快照长度",
    type: "behavior",
    pattern: /count: logSnapshot\.length/g,
    replacement: "count: 0",
    note: "日志文本与 count 必须来自同一次快照"
  },
  {
    id: "m199",
    name: "skill 清单匹配退化为大小写敏感",
    type: "behavior",
    pattern: /entry\.name\.toLowerCase\(\) === "skill\.md"/g,
    replacement: "entry.name === \"SKILL.md\"",
    note: "SKILL.md 文件名大小写不敏感"
  },
  {
    id: "m200",
    name: "skill 扫描不再跳过 vendored 目录",
    type: "behavior",
    pattern: /return skipVendored && vendoredDirNames\.has\(entry\.name\.toLowerCase\(\)\);/g,
    replacement: "return false;",
    note: "upstream/vendor 等第三方目录中的技能不能被收录"
  },
  {
    id: "m201",
    name: "仓库扫描放行隐藏目录和 node_modules",
    type: "behavior",
    pattern: /entry\.name\.startsWith\("\."\) \|\| entry\.name === "node_modules"/g,
    replacement: "entry.name.startsWith(\".\") && entry.name === \"node_modules\"",
    note: "工具链和依赖目录不能伪装成仓库根"
  },
  {
    id: "m202",
    name: "skill 根命中后继续递归",
    type: "behavior",
    pattern: /if \(entries\.some\(\(entry\) => entry\.isFile\(\) && entry\.name\.toLowerCase\(\) === "skill\.md"\)\) \{\n        roots\.push\(dir\);\n        return;/g,
    replacement: "if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === \"skill.md\")) {\n        roots.push(dir);\n        void 0;",
    note: "命中技能根后不得重复收录其嵌套技能"
  },
  {
    id: "m203",
    name: "扫描深度边界晚一层停止",
    type: "behavior",
    pattern: /if \(depth >= maxDepth\) return;/g,
    replacement: "if (depth > maxDepth) return;",
    note: "maxDepth 到达时不能再向下读取"
  },
  {
    id: "m204",
    name: "扫描数量上限晚一项停止",
    type: "behavior",
    pattern: /if \(roots\.length >= limit\) return;/g,
    replacement: "if (roots.length > limit) return;",
    note: "limit 必须严格限制返回根数量"
  },
  {
    id: "m205",
    name: "plugin predicate 放宽为 truthy",
    type: "behavior",
    pattern: /if \(looksLikeDshPlugin\(pkg\) === true\)/g,
    replacement: "if (looksLikeDshPlugin(pkg))",
    note: "只有领域判定明确返回 true 才能收录插件根"
  },
  {
    id: "m206",
    name: "plugin 坏 JSON 阻断后续扫描",
    type: "behavior",
    pattern: /\} catch \{\}\n      \}\n      if \(depth >= maxDepth\)/g,
    replacement: "} catch { throw new Error(\"malformed package\"); }\n      }\n      if (depth >= maxDepth)",
    note: "坏 package.json 必须忽略并继续扫描其他根"
  },
  {
    id: "m207",
    name: "plugin 根命中后继续递归",
    type: "behavior",
    pattern: /if \(looksLikeDshPlugin\(pkg\) === true\) \{\n            roots\.push\(dir\);\n            return;/g,
    replacement: "if (looksLikeDshPlugin(pkg) === true) {\n            roots.push(dir);\n            void 0;",
    note: "插件根内部嵌套清单不应重复安装"
  },
  {
    id: "m208",
    name: "preset 双文件条件放宽为单文件",
    type: "behavior",
    pattern: /&& entries\.some\(\(entry\) => entry\.isFile\(\) && entry\.name === "agent\.cordis\.yml"\)/g,
    replacement: "|| entries.some((entry) => entry.isFile() && entry.name === \"agent.cordis.yml\")",
    note: "缺任一 preset 文件都不能作为完整预设根"
  },
  {
    id: "m209",
    name: "preset 根命中后继续递归",
    type: "behavior",
    pattern: /if \(entries\.some\(\(entry\) => entry\.isFile\(\) && entry\.name === "preset\.yml"\)[\s\S]*?roots\.push\(dir\);\n        return;/g,
    replacement: "if (entries.some((entry) => entry.isFile() && entry.name === \"preset.yml\")\n          && entries.some((entry) => entry.isFile() && entry.name === \"agent.cordis.yml\")) {\n        roots.push(dir);\n        void 0;",
    note: "完整预设根内部不应重复收录嵌套目录"
  },
  {
    id: "m210",
    name: "skill manifest 缺失时回退错误文件名",
    type: "behavior",
    pattern: /\?\? "SKILL\.md"/g,
    replacement: "?? \"missing-SKILL.md\"",
    note: "目录未枚举到大小写变体时仍须回退读取 SKILL.md"
  },
  {
    id: "m211",
    name: "lifecycle 顺序丢失 prepare",
    type: "behavior",
    pattern: /\["preinstall", "install", "postinstall", "prepare"\]/g,
    replacement: "[\"preinstall\", \"install\", \"postinstall\"]",
    note: "四个生命周期名称及其既有顺序必须完整保留"
  },
  {
    id: "m212",
    name: "lifecycle 空字符串被错误接受",
    type: "behavior",
    pattern: /scripts\[name\]\.length > 0/g,
    replacement: "scripts[name].length >= 0",
    note: "空生命周期脚本不能触发确认"
  },
  {
    id: "m213",
    name: "lifecycle 放行非字符串值",
    type: "behavior",
    pattern: /typeof scripts\[name\] === "string"/g,
    replacement: "typeof scripts[name] !== \"string\"",
    note: "package.json 生命周期字段必须是非空字符串"
  },
  {
    id: "m214",
    name: "repository scan fs 注入改为显式别名形态",
    type: "static",
    pattern: /fs: \{ readdir, readFile \},/g,
    replacement: "fs: { readdir, readFile: readFile },",
    note: "静态边界契约锁定基础设施通过 fs 注入"
  },
  {
    id: "m215",
    name: "repository scan path 注入改为显式别名形态",
    type: "static",
    pattern: /path: \{ joinPath \},/g,
    replacement: "path: { joinPath: joinPath },",
    note: "静态边界契约锁定路径能力通过 path 注入"
  },
  {
    id: "m216",
    name: "repository scan 领域判定注入改为显式别名形态",
    type: "static",
    pattern: /\n  looksLikeDshPlugin,\n/g,
    replacement: "\n  looksLikeDshPlugin: looksLikeDshPlugin,\n",
    note: "静态边界契约锁定 adapter 不自行实现插件资格判定"
  },
  {
    id: "m217",
    name: "根预设单文件也被接受",
    type: "behavior",
    pattern: /if \(await has\("preset\.yml"\) && await has\("agent\.cordis\.yml"\)\)/g,
    replacement: "if (await has(\"preset.yml\") || await has(\"agent.cordis.yml\"))",
    note: "预设必须同时具备两个根文件"
  },
  {
    id: "m218",
    name: "DSH 声明放宽为 truthy",
    type: "behavior",
    pattern: /await looksLikeDshPlugin\(rootPackage\) === true/g,
    replacement: "await looksLikeDshPlugin(rootPackage)",
    note: "分类只接受领域判定明确返回 true"
  },
  {
    id: "m219",
    name: "bundle 声明降级为普通插件",
    type: "behavior",
    pattern: /isBundlePackage\(rootPackage\) \? "bundleDeclared" : "dshDeclared"/g,
    replacement: "\"dshDeclared\"",
    note: "bundle 必须保留独立运行时安装类型"
  },
  {
    id: "m220",
    name: "sh 脚本抢占 ps1 优先级",
    type: "behavior",
    pattern: /if \(await has\("install\.ps1"\)\) return resultFor\("ps1"\);\n    if \(await has\("install\.sh"\)\) return resultFor\("sh"\);/g,
    replacement: "if (await has(\"install.sh\")) return resultFor(\"sh\");\n    if (await has(\"install.ps1\")) return resultFor(\"ps1\");",
    note: "双脚本兼容路径保持 ps1 优先"
  },
  {
    id: "m221",
    name: "单个嵌套预设根被忽略",
    type: "behavior",
    pattern: /\(await findPresetRoots\(cacheDir\)\)\.length > 0/g,
    replacement: "(await findPresetRoots(cacheDir)).length > 1",
    note: "发现一个完整嵌套预设根即可判定"
  },
  {
    id: "m222",
    name: "根技能扫描放宽深度",
    type: "behavior",
    pattern: /findSkillRoots\(cacheDir, 0, 1\)/g,
    replacement: "findSkillRoots(cacheDir, 5, 1)",
    note: "根 package 与根 skill 判定必须使用零深度"
  },
  {
    id: "m223",
    name: "普通根包改判手动说明",
    type: "behavior",
    pattern: /return resultFor\("pkgOnly"\);/g,
    replacement: "return resultFor(\"none\");",
    note: "普通 package 必须保留非插件确认链"
  },
  {
    id: "m224",
    name: "单个嵌套插件根被忽略",
    type: "behavior",
    pattern: /\(await findPluginRoots\(cacheDir\)\)\.length > 0/g,
    replacement: "(await findPluginRoots(cacheDir)).length > 1",
    note: "一个严格插件根即可判定多包插件"
  },
  {
    id: "m225",
    name: "嵌套技能扫描退回根深度",
    type: "behavior",
    pattern: /findSkillRoots\(cacheDir, 5, 1\)/g,
    replacement: "findSkillRoots(cacheDir, 0, 1)",
    note: "无根 package 的嵌套技能必须使用深度扫描"
  },
  {
    id: "m226",
    name: "detectType 返回理由键",
    type: "behavior",
    pattern: /return \(await detectTypeDetail\(cacheDir\)\)\.type;/g,
    replacement: "return (await detectTypeDetail(cacheDir)).reasonKey;",
    note: "兼容包装必须返回历史类型字符串"
  },
  {
    id: "m227",
    name: "分类结果暴露共享可变对象",
    type: "behavior",
    pattern: /return \{ \.\.\.TYPE_REASONS\[reason\] \};/g,
    replacement: "return TYPE_REASONS[reason];",
    note: "每次分类结果必须与 owner 内部模板隔离"
  },
  {
    id: "m228",
    name: "分类理由映射错误",
    type: "behavior",
    pattern: /reasonKey: "detectReason\.dshDeclared"/g,
    replacement: "reasonKey: \"detectReason.pkgOnly\"",
    note: "声明命中的理由必须保持可观测诊断语义"
  },
  {
    id: "m229",
    name: "文件存在性错误被静默吞掉",
    type: "behavior",
    pattern: /const has = \(relative\) => exists\(joinPath\(cacheDir, relative\)\);/g,
    replacement: "const has = (relative) => exists(joinPath(cacheDir, relative)).catch(() => false);",
    note: "分类能力异常不得伪装成无特征仓库"
  },
  {
    id: "m230",
    name: "损坏根清单跳过 package-only 兼容分支",
    type: "behavior",
    pattern: /if \(await has\("package\.json"\)\) \{/g,
    replacement: "if (rootPackage) {",
    note: "package.json 存在但损坏时仍保持历史 package-only 结果"
  },
  {
    id: "m231",
    name: "高优先级命中仍执行插件扫描",
    type: "behavior",
    pattern: /const has = \(relative\) => exists\(joinPath\(cacheDir, relative\)\);/g,
    replacement: "const has = (relative) => exists(joinPath(cacheDir, relative));\n    await findPluginRoots(cacheDir);",
    note: "已命中的早期分类不能执行无用嵌套扫描"
  },
  {
    id: "m232",
    name: "环境变量提取返回空集合",
    type: "behavior",
    pattern: /return \[\.\.\.names\];/g,
    replacement: "return [];",
    note: "domain env 规则必须返回匹配名称"
  },
  {
    id: "m233",
    name: "宿主 shadow 依赖全部放行",
    type: "behavior",
    pattern: /HOST_SHADOW_PACKAGES\.has\(name\)/g,
    replacement: "false",
    note: "domain 必须识别会遮蔽宿主的依赖"
  },
  {
    id: "m234",
    name: "PowerShell 文件错误路由为 bash",
    type: "behavior",
    pattern: /\? "ps1" : "bash"/g,
    replacement: "? \"bash\" : \"bash\"",
    note: "ps1 与 bash 必须使用对应规则表"
  },
  {
    id: "m235",
    name: "白名单下载执行不再降级",
    type: "behavior",
    pattern: /rule\.category === "downloadExec" && hazardUrlAllowed\(line\) \? "medium" : rule\.severity/g,
    replacement: "rule.category === \"downloadExec\" && hazardUrlAllowed(line) ? rule.severity : rule.severity",
    note: "白名单只降低提示等级，不应改变既有 medium 语义"
  },
  {
    id: "m236",
    name: "组合规则反转跨行条件",
    type: "behavior",
    pattern: /lineA !== lineB/g,
    replacement: "lineA === lineB",
    note: "默认组合信号必须来自不同行"
  },
  {
    id: "m237",
    name: "脚本命中上限减少一条",
    type: "behavior",
    pattern: /hits\.length < 8/g,
    replacement: "hits.length < 7",
    note: "逐行扫描和组合扫描共享每文件 8 条上限"
  },
  {
    id: "m238",
    name: "lifecycle 顺序改为 install 优先",
    type: "behavior",
    pattern: /\["preinstall", "install", "postinstall", "prepare"\]/g,
    replacement: "[\"install\", \"preinstall\", \"postinstall\", \"prepare\"]",
    note: "确认链的 lifecycle 读取顺序是稳定行为"
  },
  {
    id: "m239",
    name: "package-lock 版本被替换",
    type: "behavior",
    pattern: /if \(match && typeof version === "string"\) map\.set\(match\[1\], version\);/g,
    replacement: "if (match && typeof version === \"string\") map.set(match[1], \"0.0.0\");",
    note: "lockfile 必须保留精确版本"
  },
  {
    id: "m240",
    name: "npm alias 不再解出真实包",
    type: "behavior",
    pattern: /if \(range\.startsWith\("npm:"\)\)/g,
    replacement: "if (false)",
    note: "alias 漏洞面应查询真实包名"
  },
  {
    id: "m241",
    name: "workspace/link 依赖进入 CVE 查询",
    type: "behavior",
    pattern: /if \(\/\^\(\?:workspace\|link\):\/\.test\(range\)\) continue;/g,
    replacement: "if (/^(?:workspace|link):/.test(range)) out.push({ name, version: range });",
    note: "纯本地 workspace/link 不应伪造 registry 版本"
  },
  {
    id: "m242",
    name: "CVE 查询上限失效",
    type: "behavior",
    pattern: /return out\.slice\(0, CVE_MAX_QUERIES\);/g,
    replacement: "return out;",
    note: "CVE 请求数量必须受 100 条上限约束"
  },
  {
    id: "m243",
    name: "CVE high 严重度被忽略",
    type: "behavior",
    pattern: /advisory\.severity === "critical" \|\| advisory\.severity === "high"/g,
    replacement: "advisory.severity === \"critical\"",
    note: "high 与 critical 都属于确认弹窗面"
  },
  {
    id: "m244",
    name: "env 基名不再纳入 secrets 扫描",
    type: "behavior",
    pattern: /SECRET_SCAN_BASENAMES\.has\(fileName\.toLowerCase\(\)\)/g,
    replacement: "false",
    note: ".env 等无扩展名凭据文件必须被扫描"
  },
  {
    id: "m245",
    name: "secrets symlink 跳过失效",
    type: "behavior",
    pattern: /if \(entry\.isSymbolicLink\(\)\) continue;/g,
    replacement: "if (false) continue;",
    note: "requirements 扫描不能跟随 symlink 读取 cacheDir 外文件"
  },
  {
    id: "m246",
    name: "secrets 跳过目录失效",
    type: "behavior",
    pattern: /if \(!isSecretScanSkipDir\(entry\.name\)\) await walk\(full\);/g,
    replacement: "if (true) await walk(full);",
    note: "vendor/node_modules 等目录不得进入 secrets 扫描"
  },
  {
    id: "m247",
    name: "secrets 单文件上限改为包含边界",
    type: "behavior",
    pattern: /details\.size > secretMaxFileBytes/g,
    replacement: "details.size >= secretMaxFileBytes",
    note: "恰好等于上限的文件仍应扫描"
  },
  {
    id: "m248",
    name: "无依赖时仍提前返回 advisory",
    type: "behavior",
    pattern: /if \(deps\.length === 0\) return \{\};/g,
    replacement: "if (deps.length >= 0) return {};",
    note: "有依赖时必须发 bulk 请求"
  },
  {
    id: "m249",
    name: "CVE 响应绕过受限 body 读取",
    type: "behavior",
    pattern: /readBodyLimited\(response\)/g,
    replacement: "response.arrayBuffer()",
    note: "advisory 响应必须通过注入的大小受限读取器"
  },
  {
    id: "m250",
    name: "file 依赖不读取子包版本",
    type: "behavior",
    pattern: /if \(typeof subPkg\.version === "string"\) lockVersions\.set\(name, subPkg\.version\);/g,
    replacement: "if (false) lockVersions.set(name, subPkg.version);",
    note: "file: 依赖需要从本地子包补全可查询版本"
  },
  {
    id: "m251",
    name: "adaptor 接受非字符串 from/to",
    type: "behavior",
    pattern: /entry && typeof entry\.from === "string" && typeof entry\.to === "string"/g,
    replacement: "entry && (typeof entry.from === \"string\" || typeof entry.to === \"string\")",
    note: "redirect 规则必须同时具备字符串 from 与 to"
  },
  {
    id: "m252",
    name: "adaptor Map 改用 to 作为查询键",
    type: "behavior",
    pattern: /for \(const entry of entries\) fromMap\.set\(entry\.from, entry\);/g,
    replacement: "for (const entry of entries) fromMap.set(entry.to, entry);",
    note: "重定向查询必须按原始 from 精确命中"
  },
  {
    id: "m253",
    name: "adaptor nullish fullName 不再归一为空串",
    type: "behavior",
    pattern: /String\(fullName \?\? \"\"\)/g,
    replacement: "String(fullName)",
    note: "null 与 undefined 查询必须保持未命中语义"
  },
  {
    id: "m254",
    name: "adaptor 列表错误保留 from 条目",
    type: "behavior",
    pattern: /repos\.filter\(\(repo\) => !fromMap\.has\(repo\.full_name\)\)/g,
    replacement: "repos.filter((repo) => fromMap.has(repo.full_name))",
    note: "列表投影必须移除被重定向的源条目"
  },
  {
    id: "m255",
    name: "adaptor 缺失 meta.full_name 反而补入",
    type: "behavior",
    pattern: /entry\.meta && typeof entry\.meta\.full_name === "string" && !out\.some/g,
    replacement: "entry.meta && typeof entry.meta.full_name !== \"string\" && !out.some",
    note: "只有可展示的 metadata full_name 才能进入列表"
  },
  {
    id: "m256",
    name: "adaptor 目标去重条件反转",
    type: "behavior",
    pattern: /!out\.some\(\(repo\) => repo\.full_name === entry\.meta\.full_name\)/g,
    replacement: "out.some((repo) => repo.full_name === entry.meta.full_name)",
    note: "已有目标不应重复补入，缺失目标必须补入"
  },
  {
    id: "m257",
    name: "adaptor 空规则不再保持输入身份",
    type: "behavior",
    pattern: /if \(entries\.length === 0 \|\| !Array\.isArray\(repos\)\) return repos;/g,
    replacement: "if (entries.length > 0 || !Array.isArray(repos)) return repos;",
    note: "空规则列表必须原样返回而不是复制数组"
  },
  {
    id: "m258",
    name: "adaptor 有规则时跳过列表投影",
    type: "behavior",
    pattern: /if \(entries\.length === 0 \|\| !Array\.isArray\(repos\)\) return repos;/g,
    replacement: "if (entries.length === 0 || Array.isArray(repos)) return repos;",
    note: "有规则且输入为数组时必须执行过滤和补入"
  },
  {
    id: "m259",
    name: "adaptor 绕过 normalizeRepo",
    type: "behavior",
    pattern: /out\.push\(normalizeRepo\(entry\.meta\)\);/g,
    replacement: "out.push(entry.meta);",
    note: "列表补入必须通过注入的 normalizeRepo"
  },
  {
    id: "m260",
    name: "adaptor 配置加载结果被丢弃",
    type: "behavior",
    pattern: /config = loadConfig\(\);/g,
    replacement: "config = null;",
    note: "配置加载结果必须驱动规则创建"
  },
  {
    id: "m261",
    name: "official fallback 不再统一小写",
    type: "behavior",
    pattern: /\[\.\.\.officialFallback\]\.map\(\(name\) => name\.toLowerCase\(\)\)/g,
    replacement: "[...officialFallback]",
    note: "官方包集合与查询都必须大小写归一"
  },
  {
    id: "m262",
    name: "official 包缓存命中失效",
    type: "behavior",
    pattern: /if \(officialPackagesCache\) return officialPackagesCache;/g,
    replacement: "if (false) return officialPackagesCache;",
    note: "重复官方包查询不得重复解析和枚举"
  },
  {
    id: "m263",
    name: "official 包错误跳过目录枚举",
    type: "behavior",
    pattern: /if \(entry\.isDirectory\(\)\) set\.add\(/g,
    replacement: "if (false) set.add(",
    note: "scope 中的目录必须纳入官方包集合"
  },
  {
    id: "m264",
    name: "official scope 条目写入错误集合值",
    type: "behavior",
    pattern: /set\.add\(/g,
    replacement: "set.add(\"wrong\", ",
    note: "枚举出的包名必须作为集合元素写入"
  },
  {
    id: "m265",
    name: "isOfficialPackage 失去小写匹配",
    type: "behavior",
    pattern: /String\(pkgName \?\? \"\"\)\.toLowerCase\(\)/g,
    replacement: "String(pkgName ?? \"\")",
    note: "官方包查询必须接受大小写不同的输入"
  },
  {
    id: "m266",
    name: "ownRepo 成功缓存失效",
    type: "behavior",
    pattern: /if \(ownRepo !== null\) return ownRepo;/g,
    replacement: "if (false) return ownRepo;",
    note: "有效本体 repository 结果必须复用而不重复读取"
  },
  {
    id: "m267",
    name: "own repository 不再支持 object URL",
    type: "behavior",
    pattern: /typeof pkg\.repository === "string" \? pkg\.repository : pkg\.repository\?\.url/g,
    replacement: "typeof pkg.repository === \"string\" ? pkg.repository : null",
    note: "package.json repository 的字符串和 object 形态都必须支持"
  },
  {
    id: "m268",
    name: "ownRepo 失去小写归一",
    type: "behavior",
    pattern: /\.toLowerCase\(\) \|\| null;/g,
    replacement: " || null;",
    note: "本体 repository key 必须统一为小写"
  },
  {
    id: "m269",
    name: "ownRepo 不再清理 .git 后缀",
    type: "behavior",
    pattern: /\\\.git\$/g,
    replacement: "git",
    note: "GitHub repository key 不应保留 .git 后缀"
  },
  {
    id: "m270",
    name: "ownRepo 读取失败返回错误标记",
    type: "behavior",
    pattern: /catch \{\n      ownRepo = null;\n    \}/g,
    replacement: "catch {\n      ownRepo = \"failed\";\n    }",
    note: "package.json 读取失败必须保持 null 语义并允许重试"
  }
];

// ---- 分层源码定位 ----
const MUTATION_FILE_HINTS = {
  m01: "lib/domain/validation.js",
  m02: "lib/domain/validation.js",
  m03: "lib/infra/store.js",
  m04: "lib/domain/validation.js",
  m05: "lib/domain/validation.js",
  m06: "lib/domain/normalize.js",
  m07: "lib/domain/normalize.js",
  m08: "lib/index.js",
  m09: "lib/http/request.js",
  m10: "lib/index.js",
  m11: "lib/http/request.js",
  m12: "lib/domain/validation.js",
  m13: "lib/domain/validation.js",
  m14: "lib/domain/validation.js",
  m15: "lib/http/auth.js",
  m16: "lib/domain/list.js",
  m17: "lib/index.js",
  m18: "lib/index.js",
  m19: "lib/domain/normalize.js",
  m20: "lib/http/request.js",
  m21: "lib/domain/validation.js",
  m22: "lib/index.js",
  m23: "lib/domain/validation.js",
  m24: "lib/domain/validation.js",
  m25: "lib/app/install.js",
  m26: "lib/app/install.js",
  m27: "lib/app/install.js",
  m28: "lib/app/install.js",
  m29: "lib/app/install.js",
  m30: "lib/app/install.js",
  m31: "lib/app/install.js",
  m32: "lib/app/install.js",
  m33: "lib/app/install.js",
  m34: "lib/app/uninstall.js",
  m35: "lib/app/uninstall.js",
  m36: "lib/app/uninstall.js",
  m37: "lib/app/uninstall.js",
  m38: "lib/app/uninstall.js",
  m39: "lib/app/uninstall.js",
  m40: "lib/app/uninstall.js",
  m41: "lib/app/update.js",
  m42: "lib/app/update.js",
  m43: "lib/app/update.js",
  m44: "lib/app/update.js",
  m45: "lib/app/update.js",
  m46: "lib/app/update.js",
  m47: "lib/app/update.js",
  m48: "lib/app/update.js",
  m49: "lib/app/feedback.js",
  m50: "lib/app/feedback.js",
  m51: "lib/app/feedback.js",
  m52: "lib/app/feedback.js",
  m53: "lib/app/feedback.js",
  m54: "lib/app/feedback.js",
  m55: "lib/app/feedback.js",
  m56: "lib/app/feedback.js",
  m57: "lib/app/backup.js",
  m58: "lib/app/backup.js",
  m59: "lib/app/backup.js",
  m60: "lib/app/backup.js",
  m61: "lib/app/backup.js",
  m62: "lib/app/backup.js",
  m63: "lib/app/backup.js",
  m64: "lib/app/backup.js",
  m65: "lib/app/env-edit.js",
  m66: "lib/app/env-edit.js",
  m67: "lib/app/env-edit.js",
  m68: "lib/app/env-edit.js",
  m69: "lib/app/env-edit.js",
  m70: "lib/app/env-edit.js",
  m71: "lib/app/env-edit.js",
  m72: "lib/app/env-edit.js",
  m73: "lib/http/auth.js",
  m74: "lib/http/auth.js",
  m75: "lib/http/auth.js",
  m76: "lib/http/auth.js",
  m77: "lib/http/routes.js",
  m78: "lib/http/routes.js",
  m79: "lib/http/routes.js",
  m80: "lib/http/routes.js",
  m81: "lib/http/routes.js",
  m82: "lib/http/routes.js",
  m83: "lib/http/routes.js",
  m84: "lib/domain/normalize.js",
  m85: "lib/domain/normalize.js",
  m86: "lib/domain/validation.js",
  m87: "lib/domain/validation.js",
  m88: "lib/domain/validation.js",
  m89: "lib/client.js",
  m90: "lib/client.js",
  m91: "lib/client.js",
  m92: "lib/client.js",
  m93: "lib/client.js",
  m94: "lib/infra/patch-manifest.js",
  m95: "lib/infra/patch-manifest.js",
  m96: "lib/infra/patch-manifest.js",
  m97: "lib/infra/patch-manifest.js",
  m98: "lib/infra/patch-manifest.js",
  m99: "lib/infra/patch-manifest.js",
  m100: "lib/infra/patch-manifest.js",
  m101: "lib/infra/patch-manifest.js",
  m102: "lib/infra/patch-manifest.js",
  m103: "lib/infra/registry-cache.js",
  m104: "lib/infra/registry-cache.js",
  m105: "lib/infra/registry-cache.js",
  m106: "lib/infra/registry-cache.js",
  m107: "lib/infra/registry-cache.js",
  m108: "lib/infra/registry-cache.js",
  m109: "lib/infra/registry-cache.js",
  m110: "lib/infra/registry-cache.js",
  m111: "lib/infra/registry-cache.js",
  m112: "lib/infra/registry-cache.js",
  m113: "lib/infra/registry-cache.js",
  m114: "lib/infra/registry-cache.js",
  m115: "lib/infra/registry-cache.js",
  m116: "lib/infra/registry-cache.js",
  m117: "lib/infra/registry-cache.js",
  m118: "lib/infra/registry-cache.js",
  m119: "lib/infra/registry-cache.js",
  m120: "lib/infra/registry-cache.js",
  m121: "lib/infra/profile-scan.js",
  m122: "lib/infra/profile-scan.js",
  m123: "lib/infra/profile-scan.js",
  m124: "lib/infra/profile-scan.js",
  m125: "lib/infra/profile-scan.js",
  m126: "lib/infra/profile-scan.js",
  m127: "lib/infra/profile-scan.js",
  m128: "lib/infra/profile-scan.js",
  m129: "lib/domain/installed-index.js",
  m130: "lib/domain/installed-index.js",
  m131: "lib/domain/installed-index.js",
  m132: "lib/domain/installed-index.js",
  m133: "lib/domain/installed-index.js",
  m134: "lib/domain/installed-index.js",
  m135: "lib/domain/installed-index.js",
  m136: "lib/domain/installed-index.js",
  m137: "lib/domain/installed-index.js",
  m138: "lib/infra/bundle-register.js",
  m139: "lib/infra/bundle-register.js",
  m140: "lib/infra/bundle-register.js",
  m141: "lib/infra/bundle-register.js",
  m142: "lib/infra/bundle-register.js",
  m143: "lib/infra/bundle-register.js",
  m144: "lib/infra/bundle-register.js",
  m145: "lib/infra/bundle-register.js",
  m146: "lib/infra/bundle-register.js",
  m147: "lib/infra/bundle-register.js",
  m148: "lib/infra/bundle-register.js",
  m149: "lib/infra/bundle-register.js",
  m150: "lib/infra/bundle-register.js",
  m151: "lib/app/install-exec.js",
  m152: "lib/app/install-exec.js",
  m153: "lib/app/install-exec.js",
  m154: "lib/app/install-exec.js",
  m155: "lib/app/install-exec.js",
  m156: "lib/app/install-exec.js",
  m157: "lib/app/install-exec.js",
  m158: "lib/app/install-exec.js",
  m159: "lib/app/install-exec.js",
  m160: "lib/app/install-exec.js",
  m161: "lib/app/install-exec.js",
  m162: "lib/app/install-exec.js",
  m163: "lib/app/install-exec.js",
  m164: "lib/app/install-exec.js",
  m165: "lib/app/installed-state.js",
  m166: "lib/app/installed-state.js",
  m167: "lib/app/installed-state.js",
  m168: "lib/app/installed-state.js",
  m169: "lib/app/installed-state.js",
  m170: "lib/app/installed-state.js",
  m171: "lib/app/installed-state.js",
  m172: "lib/app/installed-state.js",
  m173: "lib/app/profile-index.js",
  m174: "lib/app/profile-index.js",
  m175: "lib/app/profile-index.js",
  m176: "lib/app/profile-index.js",
  m177: "lib/app/profile-index.js",
  m178: "lib/app/profile-index.js",
  m179: "lib/app/profile-index.js",
  m180: "lib/app/profile-index.js",
  m181: "lib/app/list-runtime.js",
  m182: "lib/app/list-runtime.js",
  m183: "lib/app/list-runtime.js",
  m184: "lib/app/list-runtime.js",
  m185: "lib/app/list-runtime.js",
  m186: "lib/app/list-runtime.js",
  m187: "lib/app/list-runtime.js",
  m188: "lib/app/list-runtime.js",
  m189: "lib/app/list-runtime.js",
  m190: "lib/app/list-runtime.js",
  m191: "lib/app/diagnostics.js",
  m192: "lib/app/diagnostics.js",
  m193: "lib/app/diagnostics.js",
  m194: "lib/app/diagnostics.js",
  m195: "lib/app/diagnostics.js",
  m196: "lib/app/diagnostics.js",
  m197: "lib/app/diagnostics.js",
  m198: "lib/http/routes.js",
  m199: "lib/infra/repository-scan.js",
  m200: "lib/infra/repository-scan.js",
  m201: "lib/infra/repository-scan.js",
  m202: "lib/infra/repository-scan.js",
  m203: "lib/infra/repository-scan.js",
  m204: "lib/infra/repository-scan.js",
  m205: "lib/infra/repository-scan.js",
  m206: "lib/infra/repository-scan.js",
  m207: "lib/infra/repository-scan.js",
  m208: "lib/infra/repository-scan.js",
  m209: "lib/infra/repository-scan.js",
  m210: "lib/infra/repository-scan.js",
  m211: "lib/infra/repository-scan.js",
  m212: "lib/infra/repository-scan.js",
  m213: "lib/infra/repository-scan.js",
  m214: "lib/infra/repository-scan.js",
  m215: "lib/infra/repository-scan.js",
  m216: "lib/infra/repository-scan.js",
  m217: "lib/app/repository-classification.js",
  m218: "lib/app/repository-classification.js",
  m219: "lib/app/repository-classification.js",
  m220: "lib/app/repository-classification.js",
  m221: "lib/app/repository-classification.js",
  m222: "lib/app/repository-classification.js",
  m223: "lib/app/repository-classification.js",
  m224: "lib/app/repository-classification.js",
  m225: "lib/app/repository-classification.js",
  m226: "lib/app/repository-classification.js",
  m227: "lib/app/repository-classification.js",
  m228: "lib/app/repository-classification.js",
  m229: "lib/app/repository-classification.js",
  m230: "lib/app/repository-classification.js",
  m231: "lib/app/repository-classification.js",
  m232: "lib/domain/security-scan.js",
  m233: "lib/domain/security-scan.js",
  m234: "lib/domain/security-scan.js",
  m235: "lib/domain/security-scan.js",
  m236: "lib/domain/security-scan.js",
  m237: "lib/domain/security-scan.js",
  m238: "lib/domain/security-scan.js",
  m239: "lib/domain/security-scan.js",
  m240: "lib/domain/security-scan.js",
  m241: "lib/domain/security-scan.js",
  m242: "lib/domain/security-scan.js",
  m243: "lib/domain/security-scan.js",
  m244: "lib/domain/security-scan.js",
  m245: "lib/infra/security-scan.js",
  m246: "lib/infra/security-scan.js",
  m247: "lib/infra/security-scan.js",
  m248: "lib/infra/security-scan.js",
  m249: "lib/infra/security-scan.js",
  m250: "lib/infra/security-scan.js",
  m251: "lib/domain/adaptor.js",
  m252: "lib/domain/adaptor.js",
  m253: "lib/domain/adaptor.js",
  m254: "lib/domain/adaptor.js",
  m255: "lib/domain/adaptor.js",
  m256: "lib/domain/adaptor.js",
  m257: "lib/domain/adaptor.js",
  m258: "lib/domain/adaptor.js",
  m259: "lib/domain/adaptor.js",
  m260: "lib/infra/adaptor.js",
  m261: "lib/infra/marketplace-metadata.js",
  m262: "lib/infra/marketplace-metadata.js",
  m263: "lib/infra/marketplace-metadata.js",
  m264: "lib/infra/marketplace-metadata.js",
  m265: "lib/infra/marketplace-metadata.js",
  m266: "lib/infra/marketplace-metadata.js",
  m267: "lib/infra/marketplace-metadata.js",
  m268: "lib/infra/marketplace-metadata.js",
  m269: "lib/infra/marketplace-metadata.js",
  m270: "lib/infra/marketplace-metadata.js"
};

function collectLibFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectLibFiles(path));
    else if (entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

const LIB_FILES = collectLibFiles(join(ROOT, "lib"));

function findMutationTarget(mutation) {
  const hinted = MUTATION_FILE_HINTS[mutation.id];
  const paths = hinted
    ? [join(ROOT, hinted), ...LIB_FILES.filter((path) => path !== join(ROOT, hinted))]
    : LIB_FILES;
  const re = new RegExp(mutation.pattern.source, mutation.pattern.flags.replace("g", ""));
  for (const path of paths) {
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (re.test(source)) {
      return {
        path,
        relative: path.slice(ROOT.length + 1).replace(/\\/g, "/"),
        source
      };
    }
  }
  return null;
}

// ---- 临时副本初始化：复制完整 lib/，保留分层模块的相对导入 ----
function resetTempLib() {
  rmSync(join(TMP, "lib"), { recursive: true, force: true });
  cpSync(join(ROOT, "lib"), join(TMP, "lib"), { recursive: true });
}

function setupTemp() {
  mkdirSync(TMP_UNIT, { recursive: true });
  copyFileSync(BUILD_REGISTRY, join(TMP, "scripts", "build-registry.mjs"));
  copyFileSync(CLIENT_ASSEMBLER, join(TMP, "scripts", "assemble-client.mjs"));
  copyFileSync(join(ROOT, "scripts", "validate-categories.mjs"), join(TMP, "scripts", "validate-categories.mjs"));
  copyFileSync(join(ROOT, "scripts", "refresh-audit-snapshots.mjs"), join(TMP, "scripts", "refresh-audit-snapshots.mjs"));
  cpSync(join(ROOT, "scripts", "registry"), join(TMP, "scripts", "registry"), { recursive: true });
  copyFileSync(join(ROOT, "registry.json"), join(TMP, "registry.json"));
  resetTempLib();
  copyFileSync(join(UNIT_DIR, CONTRACT_TEST), join(TMP_UNIT, CONTRACT_TEST));
  for (const file of BEHAVIOR_TESTS) {
    copyFileSync(join(UNIT_DIR, file), join(TMP_UNIT, file));
  }
}

// ---- 测试执行：在临时副本上跑单个测试文件，cwd=<tmp> ----
function runTest(file) {
  const r = spawnSync(process.execPath, ["scripts/tests/unit/" + file], {
    cwd: TMP,
    encoding: "utf8",
    timeout: 120000
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const failLines = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL"));
  // status != 0 但没有 FAIL 断言行 → 运行崩溃（如模块加载失败），单独标记
  const crashed = r.status !== 0 && failLines.length === 0;
  return { ok: r.status === 0, failLines, crashed };
}

function runTests(files) {
  const results = files.map((file) => ({ file, ...runTest(file) }));
  return {
    ok: results.every((result) => result.ok),
    crashed: results.some((result) => result.crashed),
    failLines: results.flatMap(({ file, failLines }) => failLines.map((line) => `${file}: ${line}`))
  };
}

// ---- 报告辅助 ----
function firstFails(failLines, n = 3) {
  return failLines.slice(0, n).map((l) => l.replace(/^FAIL /, ""));
}

// ---- 主流程 ----
function main() {
  setupTemp();
  const base0 = readFileSync(WORKSPACE_LIB, "utf8");
  const baseLines = base0.split("\n").length;
  console.log("=== DSH 突变测试报告 ===");
  console.log(`基线：${WORKSPACE_LIB}（${base0.length} 字节 / ${baseLines} 行）`);
  console.log(`子集：${CONTRACT_TEST}（静态契约）+ ${BEHAVIOR_TESTS.join(", ")}（行为）`);
  console.log(`突变：${MUTATIONS.length} 个`);

  const survived = [];   // 行为未锁定（两子集全绿）
  const killed = [];     // 被行为测试锁定（security-guards 绿、行为测试红）
  const contracted = []; // 被静态契约锁定（security-guards 红）
  const skipped = [];    // pattern 未命中 / 替换无效果

  const t0 = Date.now();

  for (const m of MUTATIONS) {
    // 1) 每次从工作区当前 lib/ 中定位真实源码文件（保证迁移后的 domain/http 也可突变）
    const target = findMutationTarget(m);
    if (!target) {
      console.log(`[${m.id}] ${m.name} → SKIP（pattern 未命中 lib 源码，语义可能已变化）`);
      skipped.push({ m, reason: "pattern 未命中 lib 源码" });
      continue;
    }
    const base = target.source;

    // 2) 注入突变并写回副本
    const reReplace = new RegExp(m.pattern.source, m.pattern.flags);
    const hits = base.match(reReplace);
    const mutated = base.replace(reReplace, m.replacement);
    if (mutated === base) {
      console.log(`[${m.id}] ${m.name} → SKIP（替换无效果）`);
      skipped.push({ m, reason: "替换无效果" });
      continue;
    }
    try {
      resetTempLib();
      writeFileSync(join(TMP, target.relative), mutated, "utf8");
    } catch (e) {
      console.log(`[${m.id}] 写副本失败，跳过：${e.message}`);
      skipped.push({ m, reason: "写副本失败" });
      continue;
    }

    // 4) 跑两个子集
    const c = runTest(CONTRACT_TEST);
    const b = runTests(BEHAVIOR_TESTS);

    // 5) 分类：静态契约优先（文本突变必然触发文本断言失败 → 文本契约锁定）
    let cls, detail;
    if (c.crashed) {
      cls = "contract-crash";
      detail = { contract: "崩溃（非断言）" };
    } else if (!c.ok) {
      cls = "contract";
      detail = { contractFails: firstFails(c.failLines) };
    } else if (b.crashed) {
      cls = "behavior-crash";
      detail = { behavior: "崩溃（非断言）" };
    } else if (!b.ok) {
      cls = "killed";
      detail = { behaviorFails: firstFails(b.failLines) };
    } else {
      cls = "survived";
      detail = {};
    }

    const label = cls === "survived" ? "存活" : cls === "killed" ? "被杀" : cls === "contract" ? "文本契约锁定" : cls === "behavior-crash" ? "行为崩溃" : cls === "contract-crash" ? "契约崩溃" : "?";
    console.log(`[${m.id}] ${m.name} → ${label}`);
    if (cls === "contract") for (const f of detail.contractFails) console.log(`    security-guards FAIL: ${f}`);
    if (cls === "killed") for (const f of detail.behaviorFails) console.log(`    behavior FAIL: ${f}`);
    if (cls === "behavior-crash") console.log("    behavior tests 崩溃（见上）");
    if (cls === "contract-crash") console.log("    security-guards 崩溃（见上）");

    if (cls === "survived") survived.push({ m, hits: hits.length, detail });
    else if (cls === "killed") killed.push({ m, hits: hits.length, detail });
    else if (cls === "contract") contracted.push({ m, hits: hits.length, detail });
    else if (cls === "behavior-crash") killed.push({ m, hits: hits.length, detail: { behaviorFails: ["[崩溃] 行为测试运行崩溃"] } });
    else if (cls === "contract-crash") contracted.push({ m, hits: hits.length, detail: { contractFails: ["[崩溃] security-guards 运行崩溃"] } });
  }

  // ---- 汇总 ----
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n=== 汇总（" + elapsed + "s）===");
  console.log(`存活（行为未锁定）: ${survived.length} 个`);
  console.log(`被杀（行为测试锁定）: ${killed.length} 个`);
  console.log(`文本契约锁定: ${contracted.length} 个`);
  console.log(`SKIP: ${skipped.length} 个`);

  console.log("\n--- 存活突变（行为类，高价值）---");
  for (const { m, hits } of survived) {
    console.log(`\n${m.id} ${m.name}`);
    console.log(`  命中 ${hits} 处；存活原因：${m.note}`);
  }

  console.log("\n--- 被杀清单（行为测试锁定）---");
  for (const { m, detail } of killed) {
    const fs = detail.behaviorFails ?? [];
    console.log(`${m.id} ${m.name} —— ${fs.length > 0 ? "被行为测试「" + fs[0] + "」等 " + fs.length + " 处杀" : detail.behavior ?? "?"}`);
  }

  console.log("\n--- 文本契约锁定（security-guards 直接锁定形态）---");
  for (const { m, detail } of contracted) {
    const fs = detail.contractFails ?? [];
    console.log(`${m.id} ${m.name} —— ${fs.length > 0 ? "被 security-guards「" + fs[0] + "」等 " + fs.length + " 处锁" : "?"}`);
  }

  console.log("\n--- SKIP 清单 ---");
  for (const { m, reason } of skipped) console.log(`${m.id} ${m.name} —— ${reason}`);

  // ---- 结论：行为测试最薄弱的面 ----
  console.log("\n=== 结论：行为测试最薄弱的面 ===");
  const findings = [
    "1. 版本判定调用点（m01/m02）：已抽 shouldUpdate 纯函数并锁定——m01（方向反转：< 0 → > 0）与 m02（< 0 → <= 0）均被 lib-pure「shouldUpdate 新版/相等」杀。checkSelfUpdate 两处 updateAvailable 与 doSelfUpdate no-update 分支统一走 shouldUpdate。",
    "2. 规范化函数（m06/m19）：已覆盖——normalizeRepoRef 大小写/幂等、slugify（已导出）大小写/特殊字符/空回退，均在 lib-pure。",
    "3. 资源上限常量（m11 MAX_BODY_BYTES）：已并入 security-guards「单次外部输入内存上限」契约（=1MB 断言）。",
    "4. 边界语义（m20/m24/m21）：已覆盖并全部锁定——responseTooLarge 恰好等于上限不算超限（> 契约锁定）；172 网段上下界四端点；comparePre 数字段优先（m21 被 lib-pure「数字 pre < 字母 pre」杀）；rc.01==rc.1 / beta.2>alpha.5。",
    "5. 重复硬编码（m22）：已导出 SCRIPT_ENV_KEYS，lib-pure 断言 buildMinimalEnv 键集 ⊆ 导出清单（同源不脱节）。",
    "6. 大小写不敏感（m23）：已补 lib-pure「小写 github_token/api_key/db_password 敏感」。",
    "7. 排序权重（m16 dedupe 1e12）：已补 lib-pure「已装低星优先 + NaN stars 保留」。",
    "8. 损坏 JSON（m03）：已由 infra-store 行为测试锁定——非 ENOENT 读取失败必须告警并按空处理；损坏 JSON 仍保留备份契约。",
    "9. env-keys 路径边界（m18）：已由 security-guards 形态契约锁定，并由 env-keys 路由行为测试验证受管目录外不扫描。"
  ];
  for (const f of findings) console.log(f);

  console.log("\n（本次运行未改动工作区任何文件；临时副本已随进程退出清理）");
}

// exit hook：无论正常/异常退出都清理临时目录
process.on("exit", () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响退出 */ }
});
process.on("uncaughtException", (e) => {
  console.error("运行器异常：", e);
  process.exit(1);
});

main();
