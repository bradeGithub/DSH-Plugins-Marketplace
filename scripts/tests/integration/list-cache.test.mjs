// list 磁盘缓存（list-cache）修复测试（L1）：
// 1. fetchAllRepos 全失败走 search 兜底时**不写盘**——残缺结果（单 query 上限 1000 条）
//    只作当次响应，绝不落盘污染磁盘缓存；
// 2. readListCache 读取时校验——generated_at 缺失（旧格式）/过期/坏条目 → 视为无效
//    返回 null 走下一级（search）；有效缓存 → 正常返回且 full_name 非字符串的坏条目被丢弃。
//
// 独立文件的原因：lib 模块在 import 时按 DSH_HOME 计算模块级常量（LIST_CACHE_DIR 等），
// 必须在本文件内先构造临时 DSH_HOME 再动态 import；且本文件独占控制 list-cache 目录
// 状态（构造/清空/断言），避免与其他测试的缓存写入互相干扰。

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";


// 必须在 import lib 之前设置临时 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-listcache-")).replace(/\\/g, "/");
const home = process.env.DSH_HOME;
const listCacheDir = join(home, "marketplace", "list-cache");
const cacheFile = (kind) => join(listCacheDir, `${kind}.json`);
const listCacheFiles = () => { try { return readdirSync(listCacheDir); } catch { return null; } }; // null = 目录不存在

const lib = await import("../../../lib/index.js");

// ---- 隔离：内置索引（随包 registry.json / skills.json，readBundledIndex 直接读仓库根）----
// mockFetch 只拦网络 fetch，而 bundled 索引是本地文件读取——不隔离的话 registry 全挂时
// 兜底链命中真实内置索引（数千条），永远走不到 search/磁盘缓存分支，断言必然失败。
// 测试期间把两个 bundled 文件临时移出仓库根（同名备份到临时目录），exit 时恢复。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bundledBackupDir = mkdtempSync(join(tmpdir(), "dsh-listcache-bundled-"));
const bundledMoved = []; // [原路径, 备份路径]
for (const name of ["registry.json", "skills.json"]) {
  const src = join(repoRoot, name);
  if (existsSync(src)) {
    const dst = join(bundledBackupDir, name);
    copyFileSync(src, dst); // 跨盘（仓库 D: vs tmp C:）不能用 renameSync，复制后删原
    unlinkSync(src);
    bundledMoved.push([src, dst]);
  }
}
process.on("exit", () => {
  for (const [src, dst] of bundledMoved) {
    try { if (existsSync(dst)) copyFileSync(dst, src); } catch { /* 尽力恢复 */ }
  }
  try { rmSync(bundledBackupDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});


let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// ---- mock：按 URL 分派——registry 源 vs 搜索 API；payload 传 null 表示该路失败（403）----
function mockFetch(registryPayload, searchPayload) {
  const orig = globalThis.fetch;
  const respond = (payload) => (payload === null
    ? { ok: false, status: 403, json: async () => ({}), text: async () => "" }
    : {
        ok: true, status: 200,
        json: async () => payload,
        // fetchRegistryRepos 非 .gz 源走 res.text()（JSON.parse(text)）——必须返回序列化内容
        text: async () => JSON.stringify(payload),
        // .gz 源走 res.arrayBuffer()：mock 下返回非 gzip 数据 → gunzipSync 抛错 → 尝试下一源，
        // 恰好验证「gz 源坏 → json 源兜底成功」的源链；不需要真实 gzip 产物。
        arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
      });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/search/repositories")) return respond(searchPayload);
    return respond(registryPayload);

  };
  return orig;
}

/** 轮询等待条件成立（registry 分支的写盘是 fire-and-forget，不 await，需轮询）。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

const searchItems = (fullNames) => ({
  items: fullNames.map((fn) => ({ full_name: fn, name: fn.split("/")[1], stargazers_count: 1, updated_at: "2026-01-01T00:00:00Z", description: "x", html_url: `https://github.com/${fn}` })),
  total_count: fullNames.length,
});
const cacheRepo = (full_name, over = {}) => ({
  full_name, name: full_name.split("/")[1], description: "cached", html_url: `https://github.com/${full_name}`,
  stargazers_count: 5, updated_at: "2026-01-01T00:00:00Z", default_branch: "main", topics: [],
  license: null, pkg_name: null, version: null, category: null, has_skill: null, has_install_script: null, ...over,
});
const OLD = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(); // 7 天前 → 过期

// ==================== 修复 1：search 兜底不写盘 ====================

// 场景 A：list-cache 目录不存在 → registry 全挂 + search 成功 → 返回 search 结果，且目录不被创建。
// 两条结果（≥2 元素触发 fetchAllRepos 的 sort 回调，覆盖 search 路径的排序分支）。

{
  const orig = mockFetch(null, searchItems(["s1/skill-a", "s1/skill-b"]));
  const list = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("search 兜底返回当次结果", list.map((r) => r.full_name), ["s1/skill-a", "s1/skill-b"]);
  check("search 兜底不创建 list-cache 目录", listCacheFiles(), null);
}

// 场景 B：已有过期缓存文件 → search 兜底后文件不变（不覆盖、不新增）
{
  const staleContent = JSON.stringify({ saved_at: OLD, generated_at: OLD, kind: "dsh", count: 1, repos: [cacheRepo("c1/stale")] }, null, 2);
  mkdirSync(listCacheDir, { recursive: true });
  writeFileSync(cacheFile("dsh"), staleContent, "utf8");
  const orig = mockFetch(null, searchItems(["s2/skill-b"]));
  const list = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("过期缓存 + search 兜底返回 search 结果", list.map((r) => r.full_name), ["s2/skill-b"]);

  check("search 兜底不改写缓存文件", readFileSync(cacheFile("dsh"), "utf8"), staleContent);
  check("search 兜底不新增缓存文件", listCacheFiles(), ["dsh.json"]);
}

// ==================== 修复 2：readListCache 校验 ====================

// 场景 C：有效缓存（generated_at 新鲜）+ search 也可用 → 缓存优先（不会退化到 search），
//         且坏条目（full_name 非字符串/缺失/空串）被丢弃
{
  const validContent = JSON.stringify({
    saved_at: new Date().toISOString(), generated_at: new Date().toISOString(), kind: "dsh", count: 4,
    repos: [
      cacheRepo("c2/good"),
      { name: "no-full-name", stargazers_count: 9 },                       // 缺 full_name
      { full_name: 123, stargazers_count: 9 },                             // full_name 非字符串
      { full_name: "", stargazers_count: 9 },                              // full_name 空串
    ],
  }, null, 2);
  writeFileSync(cacheFile("dsh"), validContent, "utf8");
  const orig = mockFetch(null, searchItems(["s3/skill-c"]));
  const list = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("有效缓存优先于 search 且坏条目丢弃", list.map((r) => r.full_name), ["c2/good"]);
}

// 场景 D：generated_at 过期 → 视为无效，走 search
{
  writeFileSync(cacheFile("dsh"), JSON.stringify({ saved_at: OLD, generated_at: OLD, kind: "dsh", count: 1, repos: [cacheRepo("c3/old")] }), "utf8");
  const orig = mockFetch(null, searchItems(["s4/skill-d"]));
  const list = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("generated_at 过期缓存被拒绝走 search", list.map((r) => r.full_name), ["s4/skill-d"]);
}

// 场景 E：generated_at 缺失（旧格式 saved_at-only）→ 视为无效，走 search
{
  writeFileSync(cacheFile("dsh"), JSON.stringify({ saved_at: new Date().toISOString(), kind: "dsh", count: 1, repos: [cacheRepo("c4/oldfmt")] }), "utf8");
  const orig = mockFetch(null, searchItems(["s5/skill-e"]));
  const list = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("旧格式缓存（无 generated_at）被拒绝走 search", list.map((r) => r.full_name), ["s5/skill-e"]);
}

// 场景 F：repos 为空数组 → 视为无效，走 search
{
  writeFileSync(cacheFile("dsh"), JSON.stringify({ saved_at: new Date().toISOString(), generated_at: new Date().toISOString(), kind: "dsh", count: 0, repos: [] }), "utf8");
  const orig = mockFetch(null, searchItems(["s6/skill-f"]));
  const list = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("空 repos 缓存被拒绝走 search", list.map((r) => r.full_name), ["s6/skill-f"]);
}

// ==================== 正向对照：registry 成功才写盘，且写出的格式可被再次读取 ====================

// 场景 G：registry 成功 → 落盘（带 generated_at）；随后 registry/search 全挂 → 缓存兜底生效
{
  rmSync(listCacheDir, { recursive: true, force: true });
  const registryPayload = { repos: [cacheRepo("r1/good", { has_skill: true })], generated_at: new Date().toISOString() };
  let orig = mockFetch(registryPayload, searchItems(["s7/skill-g"]));
  const fromRegistry = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("registry 成功返回 registry 数据", fromRegistry.map((r) => r.full_name), ["r1/good"]);
  // registry 分支的 writeListCache 是 fire-and-forget（不 await），轮询等落盘完成
  check("registry 成功写入缓存文件", await waitFor(() => {
    try { return typeof JSON.parse(readFileSync(cacheFile("dsh"), "utf8")).generated_at === "string"; } catch { return false; }
  }), true);
  const written = JSON.parse(readFileSync(cacheFile("dsh"), "utf8"));
  check("缓存带 count", written.count, 1);
  check("缓存内容为完整索引", written.repos.map((r) => r.full_name), ["r1/good"]);
  // 全挂 → 新鲜缓存兜底
  orig = mockFetch(null, null);
  const fromDisk = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("全挂时新鲜缓存兜底生效", fromDisk.map((r) => r.full_name), ["r1/good"]);
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
