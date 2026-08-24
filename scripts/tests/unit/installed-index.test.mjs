// InstalledIndex（已安装索引）契约测试——静态断言（不执行 lib）。
//
// 设计：以少映射多——列表标注从「逐仓库五重探测」（O(仓库) 文件系统 IO）改为查索引（O(1)）。
// 索引是派生态：真相源 = installed.json + profile node_modules，事件增量失效（懒重建）。
//
// 固化的契约：
//   1) annotateInstalled 判真分支集合与 detectInstalled 五重语义一一对应
//      （清单 / 目录启发式 / 本体识别 / 包名映射+repository 反向 / 缓存克隆+包名预读）——
//      防「索引漏掉某重判定导致误报未安装」回归；
//   2) annotateSkillInstalled 两重（清单 + skills 目录），与 detectSkillInstalled 对齐；
//   3) saveInstalled / removeInstalled 必须同步失效索引（installedIndex = null，
//      与 profileScanCache 同置）——新安装/卸载后下次列表请求懒重建；
//   4) 索引构建单飞（ensureInstalledIndex）——list handler 12 并发 worker 首次请求
//      只构建一次，防重复文件系统扫描；
//   5) 列表内容指纹：服务端 list/skills 响应带 fp（full_name 序列哈希）；
//      client.js fingerprintOf 优先用 data.fp（cached_at 每次 refresh 都变，
//      用它门控会永远不跳过重渲染）。
//
// 静态断言跨平台、零依赖、秒级；行为验证见 integration/installed-index.test.mjs。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lib = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
const client = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- 契约 1：annotateInstalled 五重判定与 detectInstalled 语义对齐 ----
// 提取 annotateInstalled 函数体（到下一个顶层函数/注释前）
const annBody = lib.match(/async function annotateInstalled\(repo\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("annotateInstalled 存在", annBody.length > 0, true);
check("① 清单判定 hasInstalledRecord", annBody.includes("hasInstalledRecord(repo.full_name)"), true);
check("② 目录启发式 idx.dirs.has(slug)", annBody.includes("idx.dirs.has(slug)"), true);
check("③ 本体识别 idx.ownRepo", annBody.includes("idx.ownRepo &&"), true);
check("④ 包名映射 profileHit(idx, repo, keys)", annBody.includes("if (profileHit(idx, repo, keys)) return true;"), true);
check("⑤ 缓存克隆 cacheScripts.has(cacheKey)", annBody.includes("idx.cacheScripts.has(cacheKey)"), true);
check("⑤ 包名预读 cachePkgNames.get(cacheKey)", annBody.includes("idx.cachePkgNames.get(cacheKey)"), true);
// 与 detectInstalled 的对应（防索引漏判定）：detectInstalled 体内出现相同五重语义锚点
const detBody = lib.match(/async function detectInstalled\(repo\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("detectInstalled 存在", detBody.length > 0, true);
check("detectInstalled 含清单判定", detBody.includes("hasInstalledRecord(repo.full_name)"), true);
check("detectInstalled 含目录启发式", detBody.includes("join(SKILLS_DIR, slug)"), true);
check("detectInstalled 含本体识别", detBody.includes("loadOwnRepo()"), true);
check("detectInstalled 含包名映射", detBody.includes("matchProfileEntry(profile, repo, keys)"), true);
check("detectInstalled 含缓存克隆", detBody.includes('cacheType === "script"'), true);

// ---- 契约 2：annotateSkillInstalled 两重（清单 + skills 目录）----
const annSkillBody = lib.match(/async function annotateSkillInstalled\(repo\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("annotateSkillInstalled 存在", annSkillBody.length > 0, true);
check("skills 清单判定", annSkillBody.includes("hasInstalledRecord(repo.full_name)"), true);
check("skills 目录启发式", annSkillBody.includes("installedIndex.dirs.has(slugify(repo.name))"), true);

// ---- 契约 3：saveInstalled / removeInstalled 同步失效索引 ----
check("saveInstalled 失效索引", /installedIndex = null; \/\/ 已安装索引同步失效/.test(lib), true);
check("removeInstalled 失效索引", /installedIndex = null; \/\/ 已安装索引同步失效/.test(lib), true);
// 失效点必须在 profileScanCache = null 同置（两处，分别属于 save/remove）
const invalidations = lib.match(/profileScanCache = null; \/\/ 新安装会新增目录[^\n]*\n(\s*)installedIndex = null;/g) ?? [];
const removeInvalidations = lib.match(/profileScanCache = null; \/\/ 卸载会删除目录[^\n]*\n(\s*)installedIndex = null;/g) ?? [];
check("save 中 profileScanCache 与 installedIndex 同置", invalidations.length, 1);
check("remove 中 profileScanCache 与 installedIndex 同置", removeInvalidations.length, 1);

// ---- 契约 4：索引构建单飞（防并发 worker 重复构建）----
const ensureBody = lib.match(/async function ensureInstalledIndex\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("ensureInstalledIndex 存在", ensureBody.length > 0, true);
check("单飞：空索引才开构建", ensureBody.includes("if (!installedIndexBuild) {"), true);
check("单飞：失败置回 null 抛错", ensureBody.includes("installedIndex = null; throw err;"), true);
check("单飞：finally 复位", ensureBody.includes(".finally(() => { installedIndexBuild = null; })"), true);
check("annotateInstalled 走 ensure 入口", /annotateInstalled[\s\S]{0,200}await ensureInstalledIndex\(\)/.test(annBody), true);
check("annotateSkillInstalled 走 ensure 入口", /await ensureInstalledIndex\(\)/.test(annSkillBody), true);

// ---- 契约 5：内容指纹 fp ----
const fpCount = (lib.match(/fp: listFingerprint\(deduped\)/g) ?? []).length;
// 上游 1.4.0（#14）skills 改服务端分页后响应不再带 fp——指纹门控被 fetchPage seq 竞态
// 保护替代（client.js skillsFetchSeq）；仅插件列表（全量返回）保留 fp。
check("插件列表响应带 fp（skills 分页化后仅一处）", fpCount, 1);
check("listFingerprint 实现存在", /function listFingerprint\(repos\) \{[\s\S]*?\n\}/.test(lib), true);
check("client.js fingerprintOf 优先 data.fp", /if \(typeof data\.fp === "string"\) return data\.fp;/.test(client), true);
// SkillsTab 是独立顶层函数，refreshing 必须在自身作用域声明（二轮审查：
// 引用 PluginTab 内的 refreshing → 渲染即 ReferenceError；且 doRefresh 需 finally 复位）
check("SkillsTab 独立声明 refreshing state", /function SkillsTab\(props\) \{[\s\S]{0,1200}var state9 = useState\(false\); var refreshing = state9\[0\]; var setRefreshing = state9\[1\];/.test(client), true);
check("SkillsTab doRefresh finally 复位", /fetchPage\(1, query, true\)\.finally\(function \(\) \{ setRefreshing\(false\); \}\)/.test(client), true);

// 回退必须含 cached_at（见 A3：只按 source+total 门控会在内容一进一出时漏更新）——A3 断言同一契约

// ---- A1：构建中事件失效的竞态保护（代际计数）----
// 单飞构建在飞时 save/remove 把 installedIndex 置 null，构建完成会无条件写回旧快照
// （构建开始时扫描的目录/记录）→ 新安装/卸载在下次事件前标注 miss（静默陈旧）。
// 契约：save/remove 递增代际计数；构建完成写入前校验代际，变了则丢弃结果（保持 null）。
check("A1 save/remove/切 profile 递增代际计数（≥3 处）", (lib.match(/installedIndexGen\+\+/g) ?? []).length, 3);
check("A1 构建完成写入前校验代际", /installedIndexGen !== buildGen/.test(lib), true);

// ---- A3：无 fp 回退必须含 cached_at（防漏更新）----
// 旧服务端（无 fp）下回退 [source, total]：内容一进一出时两者不变 → 门控错误跳过
// → 列表漏更新。契约：无 fp 时回退串含 cached_at（退化到旧行为：每次重渲染）。
check("A3 无 fp 回退串含 cached_at", /return JSON\.stringify\(\[data\.source \|\| "", data\.cached_at \|\| "", data\.total \|\| 0\]\);/.test(client), true);

// ---- A4：指纹必须含列表长度（防 32 位哈希碰撞静默漏更新）----
// FNV-1a 32 位对 ~2262 条列表内容变化碰撞概率约 0.06%；碰撞后果 = 内容变了但 fp
// 相同 → 客户端跳过重渲染 → 列表不更新（静默）。契约：fp 串附带 repos.length。
check("A4 listFingerprint 串含列表长度", /function listFingerprint\(repos\) \{[\s\S]{0,400}repos\.length/.test(lib), true);

// ---- A5：指纹必须含 installed 标志（切 profile/装/卸后标注变化仍触发重渲染）----
// 标注随请求时状态计算（annotateInstalled），full_name 序列不变但 installed 位翻转
// 时旧指纹不感知 → 客户端 fp===lastFp 跳过重渲染 → 列表停留在旧 profile 标注。
// 契约：installed 标志混入哈希。
check("A5 listFingerprint 混入 installed 标志", /function listFingerprint\(repos\) \{[\s\S]{0,400}installed === true/.test(lib), true);

// ---- C1：pkg_name 冲突日志须汇总计数（不拼接全量明细刷屏）----
// 每次列表请求 console.warn 一长串被隐藏仓库名（几十个），dsh+skills 双列表请求
// 时刷屏（用户实测日志可见）。契约：冲突日志改为计数汇总，明细不拼进 warn 消息。
check("C1 冲突日志不再拼接全量 dropped 明细", !/pkg_name 冲突，列表已隐藏：\$\{dropped\.join/.test(lib), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
