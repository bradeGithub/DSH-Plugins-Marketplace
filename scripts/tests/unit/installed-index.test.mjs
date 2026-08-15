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
check("list + skills 两处响应都带 fp", fpCount, 2);
check("listFingerprint 实现存在", /function listFingerprint\(repos\) \{[\s\S]*?\n\}/.test(lib), true);
check("client.js fingerprintOf 优先 data.fp", /if \(typeof data\.fp === "string"\) return data\.fp;/.test(client), true);
check("client.js 回退 source+total", /return JSON\.stringify\(\[data\.source \|\| "", data\.total \|\| 0\]\);/.test(client), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
