// InstalledIndex（已安装索引）行为测试：
// 列表标注从「逐仓库五重探测」改为查索引（O(1)），语义必须与 detectInstalled 对齐。
// 通过 list / skills handler 的 installed 标注行为断言：
//   - 清单记录（installed.json）→ true
//   - 目录启发式（~/.dsh/skills/<slug>）→ true
//   - 本体识别（仓库命中本插件自身 repository）→ true
//   - 包名映射（profile node_modules 目录名 / pkg_name 索引字段）→ true
//   - 缓存克隆（marketplace/cache/<owner>__<slug> 为 script 类型）→ true
//   - 官方包排除（profile 里 @deepseek-ai/* 永远不算已安装）→ false
//   - 未安装 → false
// 以及内容指纹 fp：存在、稳定（相同列表两次响应一致）。
//
// 独立文件的原因：lib 模块在 import 时按 DSH_HOME 计算模块级常量（SKILLS_DIR 等），
// 必须在本文件内先构造临时 DSH_HOME 再动态 import；且独占控制 list-cache 目录状态
// （预置有效缓存避免网络）。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 必须在 import lib 之前设置临时 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-idx-test-")).replace(/\\/g, "/");
const home = process.env.DSH_HOME;
const marketRoot = join(home, "marketplace");
const cacheDir = join(marketRoot, "cache");
const listCacheDir = join(marketRoot, "list-cache");
const skillsDir = join(home, "skills");
const profileNm = join(home, "profiles", "web", "node_modules");

// ---- 环境构造：真相源（与 detectInstalled 五重判定一一对应）----
// ① 清单记录
mkdirSync(marketRoot, { recursive: true });
writeFileSync(join(marketRoot, "installed.json"), JSON.stringify({
  "t1/recorded": { type: "skill", name: "recorded", location: join(skillsDir, "recorded"), installedAt: 1 }
}), "utf8");
// ② 目录启发式
mkdirSync(join(skillsDir, "heuristic"), { recursive: true });
writeFileSync(join(skillsDir, "heuristic", "SKILL.md"), "# x", "utf8");
// ⑤ 缓存克隆（script 类型：存在 install.ps1）
mkdirSync(join(cacheDir, "t1__cacheclone"), { recursive: true });
writeFileSync(join(cacheDir, "t1__cacheclone", "install.ps1"), "# x", "utf8");
// ④ 包名映射：node_modules 目录名命中（无 package.json，目录名兜底）
mkdirSync(join(profileNm, "pkghit"), { recursive: true });
// ④ pkg_name 索引字段映射：目录名与仓库名不同，靠 registry 索引的 pkg_name 命中
mkdirSync(join(profileNm, "the-real-pkg"), { recursive: true });
// 官方包排除：@deepseek-ai 官方包永远不算用户安装的市场插件
mkdirSync(join(profileNm, "@deepseek-ai", "dsh-web"), { recursive: true });
writeFileSync(join(profileNm, "@deepseek-ai", "dsh-web", "package.json"),
  JSON.stringify({ name: "@deepseek-ai/dsh-web", version: "1.0.0" }), "utf8");
// ④ repository 撞名拦截：otherpkg 的 package.json 指向别的仓库 → 带该 pkg_name 的 repo 不判已安装
mkdirSync(join(profileNm, "otherpkg"), { recursive: true });
writeFileSync(join(profileNm, "otherpkg", "package.json"),
  JSON.stringify({ name: "otherpkg", version: "1.0.0", repository: { url: "https://github.com/other/real" } }), "utf8");
// 本体识别（③）：repo.full_name 命中本插件 package.json 的 repository
const ownPkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8"));
const OWN_REPO = String(ownPkg.repository?.url ?? "").replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");

// ---- mock 网络：registry/CDN/search 全失败 → fetchAllRepos 降级到磁盘缓存 ----
// 注意：磁盘缓存是降级链第 4 级（网络优先）——不 mock 时 handler 会拉真实数据，
// 测试断言全部落空。mock 后列表即预置缓存内容（t1/* 虚构仓库）。
const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" });

// ---- 预置有效 list-cache（generated_at 新鲜），list handler 不碰网络 ----
const now = new Date().toISOString();
const mkRepo = (full_name, over = {}) => ({
  full_name, name: full_name.split("/")[1], description: "x", html_url: `https://github.com/${full_name}`,
  stargazers_count: 5, updated_at: "2026-01-01T00:00:00Z", default_branch: "main", topics: [],
  license: null, pkg_name: null, version: null, category: null, has_skill: null, has_install_script: null, ...over,
});
const dshRepos = [
  mkRepo("t1/recorded"),                                  // ① 清单 → true
  mkRepo("t1/heuristic"),                                 // ② 目录 → true
  mkRepo("t1/cacheclone"),                                // ⑤ 缓存克隆 → true
  mkRepo("t1/pkghit"),                                    // ④ 目录名 → true
  mkRepo("t1/pkgnamed", { pkg_name: "the-real-pkg" }),    // ④ pkg_name 索引 → true
  mkRepo(OWN_REPO),                                       // ③ 本体 → true
  mkRepo("t1/official", { pkg_name: "@deepseek-ai/dsh-web" }), // 官方排除 → false
  mkRepo("t1/trap", { pkg_name: "otherpkg" }),            // ④ repository 撞名 → false
  mkRepo("t1/manual"),                                    // 未安装（A2 手动安装场景用）
  mkRepo("t1/clean"),                                     // 未安装 → false
];
const skillsRepos = [
  mkRepo("t1/recorded", { has_skill: true }),             // 清单 → true
  mkRepo("t1/heuristic", { has_skill: true }),            // 目录 → true
  mkRepo("t1/clean", { has_skill: true }),                // 未安装 → false
  mkRepo("t1/hidden", { has_skill: false }),              // has_skill=false → 不进栏目
];
mkdirSync(listCacheDir, { recursive: true });
for (const [kind, repos] of [["dsh", dshRepos], ["skills", skillsRepos]]) {
  writeFileSync(join(listCacheDir, `${kind}.json`), JSON.stringify({
    saved_at: now, generated_at: now, kind, count: repos.length, repos,
  }), "utf8");
}

const lib = await import("../../../lib/index.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// mock ctx 捕获路由注册
let registered = [];
const fakeCtx = {
  get: (s) => (s === "webServer" ? { register: (r) => registered.push(r) } : undefined),
  logger: { warn: () => {} },
};
lib.apply(fakeCtx);
const listHandler = registered.find((h) => h.path === "/api/marketplace/list")?.handler;
const skillsHandler = registered.find((h) => h.path === "/api/marketplace/skills")?.handler;
const uninstallHandler = registered.find((h) => h.path === "/api/marketplace/uninstall")?.handler;
check("list 路由已注册", !!listHandler, true);
check("skills 路由已注册", !!skillsHandler, true);
check("uninstall 路由已注册", !!uninstallHandler, true);

const mkReq = (url) => ({ method: "GET", url });
const mkRes = () => {
  let status = 0;
  let body = null;
  return {
    res: { writeHead: (s) => { status = s; }, end: (b) => { try { body = JSON.parse(b); } catch { body = null; } } },
    get status() { return status; },
    get body() { return body; },
  };
};
const installedMapOf = (body) => Object.fromEntries((body?.repos ?? []).map((r) => [r.full_name, r.installed]));
const fpOf = (body) => body?.fp;

// ==================== list handler：installed 标注 + fp ====================
{
  const r = mkRes();
  await listHandler(mkReq("/api/marketplace/list"), r.res);
  const map = installedMapOf(r.body);
  check("list ① 清单记录 → installed", map["t1/recorded"], true);
  check("list ② 目录启发式 → installed", map["t1/heuristic"], true);
  check("list ⑤ 缓存克隆（script）→ installed", map["t1/cacheclone"], true);
  check("list ④ node_modules 目录名 → installed", map["t1/pkghit"], true);
  check("list ④ pkg_name 索引 → installed", map["t1/pkgnamed"], true);
  check("list ③ 本体识别 → installed", map[OWN_REPO], true);
  check("list 官方包排除 → 未安装", map["t1/official"], false);
  check("list 未安装 → false", map["t1/clean"], false);
  // 适配层会补入 adaptor.json 中不在列表里的 to 端仓库——8 条预置全部在且都被标注即可
  check("list 预置仓库全部在列表中", dshRepos.every((r) => Object.hasOwn(map, r.full_name)), true);
  check("list 条数不因适配层补入而丢失", r.body?.repos?.length >= dshRepos.length, true);

  // fp：存在、字符串、两次响应一致（getList 内存缓存 + 内容未变）
  const r2 = mkRes();
  await listHandler(mkReq("/api/marketplace/list"), r2.res);
  check("list fp 存在且为字符串", typeof fpOf(r.body), "string");
  check("list fp 非空", String(fpOf(r.body)).length > 0, true);
  check("list fp 两次响应一致", fpOf(r2.body), fpOf(r.body));
}

// ==================== B1 验证：索引侧 repository 撞名拦截 ====================
// profileNm/otherpkg 的 package.json repository 指向 other/real → 带 pkg_name "otherpkg"
// 的仓库 t1/trap 不应判已安装（同探测路径 matchProfileEntry 语义）。
{
  const r = mkRes();
  await listHandler(mkReq("/api/marketplace/list"), r.res);
  check("B1 repository 撞名 → 不判已安装", installedMapOf(r.body)["t1/trap"], false);
}

// ==================== A2 复现：force refresh（refresh=1）不失效索引 ====================
// 用户手动装了 skill（直接建目录，不经过市场安装流程）后点「刷新」——
// 列表重拉了但 InstalledIndex 仍用旧快照 → 目录启发式 miss → 标注陈旧。
{
  const r = mkRes();
  await listHandler(mkReq("/api/marketplace/list"), r.res);
  check("A2 前置：t1/manual 初始未安装", installedMapOf(r.body)["t1/manual"], false);
  // 手动安装：直接在 skills 目录建 skill（索引构建于首次 list，dirs 集合不含 manual）
  mkdirSync(join(skillsDir, "manual"), { recursive: true });
  writeFileSync(join(skillsDir, "manual", "SKILL.md"), "# x", "utf8");
  const r2 = mkRes();
  await listHandler(mkReq("/api/marketplace/list?refresh=1"), r2.res);
  // 期望：目录启发式应命中（manual 目录已存在）→ 标注 true；当前实现 refresh 不失效索引 → 仍是 false
  check("A2 force refresh 后目录启发式命中（索引已失效重建）", installedMapOf(r2.body)["t1/manual"], true);
}

// ==================== skills handler：两重标注 + fp ====================
{
  const r = mkRes();
  await skillsHandler(mkReq("/api/marketplace/skills"), r.res);
  const map = installedMapOf(r.body);
  check("skills ① 清单记录 → installed", map["t1/recorded"], true);
  check("skills ② 目录启发式 → installed", map["t1/heuristic"], true);
  check("skills 未安装 → false", map["t1/clean"], false);
  check("skills has_skill=false 被过滤", map["t1/hidden"], undefined);
  check("skills 过滤后进栏目 3 条", r.body?.repos?.length, 3);
  check("skills fp 存在且为字符串", typeof fpOf(r.body), "string");
}

// ==================== B2 验证：卸载事件失效 → 普通 list 懒重建 ====================
// uninstall handler → removeInstalled（删记录 + installedIndex=null + 删目录）→
// 下次 list 懒重建 → 标注翻转为未安装。A2 与 B2 的差别：B2 走事件失效，A2 只重拉列表。
// 放在 skills 场景之后：B2 删除 skillsDir/recorded，不影响前面的 recorded 断言。
{
  const mkUninstallReq = (repo) => ({
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    [Symbol.asyncIterator]: function* () { yield Buffer.from(JSON.stringify({ repo })); },
  });
  const r = mkRes();
  await listHandler(mkReq("/api/marketplace/list"), r.res);
  check("B2 前置：t1/recorded 已安装", installedMapOf(r.body)["t1/recorded"], true);
  const ur = mkRes();
  await uninstallHandler(mkUninstallReq("t1/recorded"), ur.res);
  check("B2 卸载成功", ur.status, 200);
  const r2 = mkRes();
  await listHandler(mkReq("/api/marketplace/list"), r2.res);
  check("B2 卸载后列表标注翻转为未安装（事件失效→懒重建）", installedMapOf(r2.body)["t1/recorded"], false);
}

globalThis.fetch = origFetch;
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
