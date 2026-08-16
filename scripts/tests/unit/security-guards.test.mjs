// L6/L7 安全守卫契约测试——静态断言（不执行 lib）。
//
// L6 响应大小上限：registry/CDN/search 响应无大小限制（缓解：来源可信）——
// 根本问题 = 资源上限缺失。Content-Length 超 MAX_RESPONSE_BYTES(32MB) 直接
// 拒绝（fetchJson 抛错 / fetchRegistryRepos 换下一源）。
// L7 __proto__ 原型污染（理论）：JSON 数据的 __proto__ 键经 Object.assign 的
// [[Set]] 触发原型 setter。safeAssign 用 Object.keys 显式剔除危险键（Object.keys
// 只枚举 own enumerable，__proto__ 作 own data property 可被枚举——需显式剔除）。
// GitHub 字段固定实际不可达，但边界防御成本为零，理论污染面一并封死。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lib = readFileSync(join(ROOT, "lib", "index.js"), "utf8");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- L6：响应大小上限 ----
check("MAX_RESPONSE_BYTES = 32MB", /const MAX_RESPONSE_BYTES = 32 \* 1024 \* 1024;/.test(lib), true);
const sizeBody = lib.match(/function responseTooLarge\(res\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("responseTooLarge 存在", sizeBody.length > 0, true);
check("responseTooLarge 读 content-length", sizeBody.includes('res?.headers?.get?.("content-length")'), true);
const fetchJsonBody = lib.match(/async function fetchJson\(url, extraHeaders = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("fetchJson 超限抛错", /if \(responseTooLarge\(res\)\) throw new Error\(`响应过大/.test(fetchJsonBody), true);
check("fetchRegistryRepos 超限换源", /if \(responseTooLarge\(res\)\) continue; \/\/ L6/.test(lib), true);

// ---- 执行边界：子进程输出上限（安装/自更新链）----
// execFile 默认 maxBuffer=1MB——npm/pnpm/dsh 安装输出超限即 ERR_CHILD_PROCESS_STDIO_MAXBUFFER
// 杀掉子进程（静默中断，实测 npm install 常见触发）。契约：安装类调用统一
// maxBuffer=MAX_EXEC_BUFFER（32MB，与 MAX_RESPONSE_BYTES 同值对齐——统一的
// 「单次外部输入内存上限」语义）。实现：runNpm/runPnpm 经 execOpts 变量（定义 1 处
// 各 + 传递 4 处），doSelfUpdate 三分支字面量（3 处）——字面量共 5 处。
check("MAX_EXEC_BUFFER = 32MB", /const MAX_EXEC_BUFFER = 32 \* 1024 \* 1024;/.test(lib), true);
check("MAX_BODY_BYTES = 1MB（突变测试 m11：唯一漏掉的上限常量）", /const MAX_BODY_BYTES = 1024 \* 1024;/.test(lib), true);
check("安装/更新调用 maxBuffer 覆盖（字面量 ≥5）", (lib.match(/maxBuffer: MAX_EXEC_BUFFER/g) ?? []).length >= 5, true);
check("runNpm/runPnpm 经 execOpts 实际传入（≥4 处）", (lib.match(/execFileAsync\([^)]*execOpts\)/g) ?? []).length >= 4, true);

// ---- 解压边界：压缩炸弹（gz 源解压后膨胀）----
// readBodyLimited 限制的是压缩后字节——100MB 重复数据 gzip 后仅 ~100KB 全量放行，
// gunzipSync 解压出 100MB 内存膨胀（zip bomb）。zlib 的 maxOutputLength 选项在解压
// 过程中拦截（ERR_BUFFER_TOO_LARGE），超限弃源换下一级。契约：.gz 解压必须带
// maxOutputLength=MAX_RESPONSE_BYTES（解压后内存上限与原始字节上限同值对齐）。
// ---- 日志边界：单条日志截断 ----
// install/uninstall 失败时 err 直传 logLine（3239/3354 无 slice），error.message 来自
// execFile stderr（maxBuffer 32MB 上限）→ 单条 32MB × 400 条 = 12.8GB 内存峰值，
// 且 install 响应体 log 数组同源（出站响应同样撑爆）。契约：pushLog 入口截断
// （所有调用点自动受保护）+ logLine 定义处截断（保护响应体 log 数组）。
check("LOG_LINE_MAX = 4096", /const LOG_LINE_MAX = 4096;/.test(lib), true);
check("pushLog 入口截断单条", /function pushLog\(line\) \{[\s\S]*?slice\(0, LOG_LINE_MAX\)/.test(lib), true);
check("logLine 定义处截断（≥2 处，保护响应体 log 数组）", (lib.match(/const logLine = \(line\) => \{[\s\S]*?slice\(0, LOG_LINE_MAX\)[\s\S]*?\};/g) ?? []).length >= 2, true);

// ---- 磁盘缓存原子写（writeListCache）----
// e2e 竞态排查暴露：直接 writeFile 打开-截断-写入非原子——12MB bundled 写盘与后续
// 缓存写盘并发交错 → 文件半写损坏 → readListCache 解析失败静默降级 search（残缺结果）。
// 契约：tmp + rename 原子替换（与 saveInstalled/appendPatchEntry 同模式）。
check("writeListCache 原子写（tmp + rename）", /const tmp = listCacheFile\(kind\) \+ "\.tmp";[\s\S]*?await rename\(tmp, listCacheFile\(kind\)\);/.test(lib), true);

// ---- 上游 v1.5.0 npm 等价回退（installNpmTargetToTemp）：cmd 包装契约 ----
// 深集成豁免（真实 npm 二进制）——但存在性必须被测试感知：win32 经 cmd.exe 启动 npm
//（.cmd 垫片 execFile 直接启动会 EINVAL，issue #46 同族），不直接 execFile npm.cmd。
check("installNpmTargetToTemp win32 经 cmd.exe 包装", /async function installNpmTargetToTemp[\s\S]*?execFileAsync\("cmd\.exe", \["\/d", "\/s", "\/c", "npm", \.\.\.args\]/.test(lib), true);
check("installNpmTargetToTemp 非 win32 直接 npm", /async function installNpmTargetToTemp[\s\S]*?execFileAsync\("npm", args, \{ cwd: tmp, timeout: 300000 \}\)/.test(lib), true);

// ---- 扫描边界：symlink 不跟随（扫描范围必须限于 cacheDir 内）----
// Dirent.isDirectory() 对 symlink 恒 false——若只有 isDirectory 分支判断，symlink 会落
// 进文件分支被 readFile 读取：恶意仓库可提交指向仓库外任意文件的 symlink（如
// install.sh → ~/.ssh/config），键名扫描就会读取仓库外内容。契约：扫描前显式跳过。
check("scanRequirements 显式跳过 symlink", /if \(ent\.isSymbolicLink\(\)\) continue;/.test(lib), true);

// ---- 消费侧路径注入防护：installed.json 可被篡改（readStateJson 只校验 JSON 合法性）----
// record.name / record.location 拼路径前必须校验（uninstall 已有 resolve 受管目录防线，
// check-update 与 env-keys 曾缺同款）：穿越段会读到/拼到任意目录。
check("check-update 包名形态校验（≤2 段 + 段字符集 + 排除 ./..）", /const parts = pkgName\.split\("\/"\);[\s\S]*?parts\.length > 2 \|\| parts\.some\(/.test(lib), true);
check("list handler cliNpmForm 分支同款校验（2539 漏网点）",
  /const cliParts = cliTarget\.split\("\/"\);[\s\S]*?cliParts\.length > 2 \|\| cliParts\.some\(/.test(lib), true);
check("env-keys location 受管目录校验（扫描前）", /const managed = \[PROFILE_NM, SKILLS_DIR, PRESETS_DIR, CACHE_DIR\]\.some/.test(lib), true);

// ---- CLI 安装分支：无字符串拼接命令（注入面）----
// win32 的 dsh .cmd 垫片经 cmd.exe /c 启动——若用「拼接 cmdLine + /d /s /c」：
// target 来自仓库扫描内容（恶意仓库可控），cmd 引号规则边缘（& / | / % 展开 / 引号
// 配对错乱）可逃逸成任意命令执行；且 /s 引号剥离破坏含空格路径（#46 同模式漏网）。
// 契约：与 doSelfUpdate 形态一致——独立参数形式（Node 自动引用），无拼接字符串。
check("CLI 安装无 /d /s /c 拼接（注入面清零）", /\["\/d", "\/s", "\/c", cmdLine\]/.test(lib), false);
check("CLI 安装独立参数 cmd /c dsh ...args", /execFileAsync\("cmd\.exe", \["\/c", "dsh", \.\.\.args\]/.test(lib), true);

// ---- 卸载 × 反馈队列交互：卸载后不得残留反馈询问 ----
// queueFeedback 在安装成功路径入队（同 repo 只留最新），但 uninstall 不清理队列——
// 卸载后下次打开市场仍弹「这个插件正常吗」（无意义询问，真实用户可见）。契约：
// 卸载成功路径必须 filter 掉该 repo 的 feedback 条目并持久化。
check("uninstall 清理 feedback 队列（≥2 处 filter：queueFeedback + uninstall）",
  (lib.match(/pendingFeedback = pendingFeedback\.filter/g) ?? []).length >= 2, true);
check("uninstall 清理后持久化 saveFeedback", /pendingFeedback\.length !== fbBefore\) await saveFeedback\(\);/.test(lib), true);

// ---- 本地状态文件边界：installed.json 损坏不得静默当空 ----
// 静默 catch 会把「文件损坏」与「文件不存在」混为一谈——损坏时所有已安装标注
// 消失、误判未安装导致重复安装（数据丢失不可恢复）。契约：必须区分 ENOENT
// （首次运行正常）与解析失败（WARN + 备份 .corrupt-<ts> 原文件供人工恢复）。
check("readStateJson 区分 ENOENT 与损坏（不静默）", /error\?\.code !== "ENOENT"/.test(lib), true);
check("readStateJson 损坏时备份 .corrupt-<ts>", /`\$\{file\}\.corrupt-\$\{Date\.now\(\)\}`/.test(lib), true);
check("readStateJson 存在（三个状态文件共用）", /async function readStateJson\(file\)/.test(lib), true);
// win32 下 script 型插件 install.sh 执行器：PATH 的 bash 可能是 WSL（吞反斜杠路径 →
// 127 全挂）——非 MSYS 时转 /mnt/<盘> POSIX（wslPosixPath 纯函数已由 lib-pure 行为覆盖）。
check("script 型 install.sh 探测 WSL bash", /spawnSync\("bash", \["--version"\]/.test(lib), true);
check("wslPosixPath 导出", /export \{[\s\S]*\bwslPosixPath\b/.test(lib), true);
check("loadInstalled 经 readStateJson", /const data = await readStateJson\(INSTALLED_FILE\);/.test(lib), true);
check("loadFeedback 经 readStateJson（损坏不丢反馈队列与 token）", /const data = await readStateJson\(FEEDBACK_FILE\);/.test(lib), true);
check("loadEnvStore 经 readStateJson（损坏不丢已保存键）", /const data = await readStateJson\(ENVS_FILE\);/.test(lib), true);
check(".gz 解压带 maxOutputLength（防压缩炸弹）",
  /gunzipSync\(await readBodyLimited\(res\), \{ maxOutputLength: MAX_RESPONSE_BYTES \}\)/g.test(lib), true);
check("WebDAV 恢复 GET 响应限流（L6 同语义）", /if \(responseTooLarge\(res2\)\) throw/.test(lib), true);

// ---- 读取一致性：全部 fetch 响应经 readBodyLimited（快路径除外）----
// 版本检查（checkSelfUpdate/doSelfUpdate）/npm 元数据（fetchNpmLatest）/feedback issue
// 创建/WebDAV 恢复——裸 res.json() 会把整个 body 读入内存（npm 大包元数据可达 MB 级）。
// 契约：res.json() 仅允许出现在 fetchJson 快路径（content-length 已知 ≤32MB 时）
// ——其余响应读取一律 readBodyLimited（32MB 上限 + chunked 流式计数）。
check("res.json() 仅剩 fetchJson 快路径 1 处", (lib.match(/await res(2)?\.json\(\)/g) ?? []).length, 1);
check("全部响应读取经 readBodyLimited（≥8 处）", (lib.match(/readBodyLimited\(res(2)?\)/g) ?? []).length >= 8, true);

// ---- L7：safeAssign 防原型污染 ----
const safeBody = lib.match(/function safeAssign\(target, \.\.\.sources\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("safeAssign 存在", safeBody.length > 0, true);
check("剔除 __proto__", safeBody.includes('k === "__proto__"'), true);
check("剔除 constructor", safeBody.includes('k === "constructor"'), true);
check("剔除 prototype", safeBody.includes('k === "prototype"'), true);
check("用 Object.keys 枚举（own enumerable）", safeBody.includes("Object.keys(s)"), true);
check("list handler 用 safeAssign（替换 Object.assign）", (lib.match(/flagged\[idx\] = safeAssign\(\{\}, repo, \{/g) ?? []).length >= 3, true);
check("safeAssign 已全量替换（无 Object.assign 标注残留）", (lib.match(/flagged\[idx\] = Object\.assign/g) ?? []).length, 0);
check("导出含 safeAssign", /export \{[\s\S]*\bsafeAssign\b/.test(lib), true);
check("导出含 hasInstalledRecord（installed-load 测试用）", /export \{[\s\S]*\bhasInstalledRecord\b/.test(lib), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
