// list 磁盘缓存（list-cache）修复测试（L1）：
// 1. fetchAllRepos 全失败走 search 兜底时**不写盘**——残缺结果（单 query 上限 1000 条）
//    只作当次响应，绝不落盘污染磁盘缓存；
// 2. readListCache 读取时校验——generated_at 缺失（旧格式）/过期/坏条目 → 视为无效
//    返回 null 走下一级（search）；有效缓存 → 正常返回且 full_name 非字符串的坏条目被丢弃。
//
// 独立文件的原因：lib 模块在 import 时按 DSH_HOME 计算模块级常量（LIST_CACHE_DIR 等），
// 必须在本文件内先构造临时 DSH_HOME 再动态 import；且本文件独占控制 list-cache 目录
// 状态（构造/清空/断言），避免与其他测试的缓存写入互相干扰。

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// 必须在 import lib 之前设置临时 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-listcache-")).replace(/\\/g, "/");
const home = process.env.DSH_HOME;
const listCacheDir = join(home, "marketplace", "list-cache");
const cacheFile = (kind) => join(listCacheDir, `${kind}.json`);
const listCacheFiles = () => { try { return readdirSync(listCacheDir); } catch { return null; } }; // null = 目录不存在

const lib = await import("../../../lib/index.js");

// bundled 源（readBundledIndex）读仓库根 registry.json——固定路径、不走 fetch、不可被
// DSH_HOME 隔离。registry mock 失败时 bundled 会兜底成功并写盘，破坏本文件全部
// 「registry 失败 → search/缓存」场景的断言（上游 1.4.0 #14 新增）。统一临时替换为
// 坏 JSON 使 bundled 失败，测试结束恢复。
const bundledPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "registry.json");
const bundledBackup = existsSync(bundledPath) ? readFileSync(bundledPath) : null;
writeFileSync(bundledPath, "{broken", "utf8");

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
  // headers.get 返回 null：lib 的 L6 响应上限检查（responseTooLarge）只读
  // content-length——null 视为未声明长度，通过检查（真实响应必有 headers 对象）。
  // arrayBuffer：registry 多源含 .gz 源（上游 #14），fetchRegistryRepos 对 .gz URL
  // 调 res.arrayBuffer() 解压——缺它该源 TypeError 后整链失败。
  const mockRes = (payload, ok) => ({
    ok, status: ok ? 200 : 403, json: async () => payload, headers: { get: () => null },
    // text/arrayBuffer 都返回 payload 的 JSON 文本：registry 多源里非 gz 源走 text() 解析
    // （返回空串会 JSON.parse 抛错）、gz 源走 arrayBuffer() 解压（返回未压缩数据同样抛错）——
    // 上游 1.4.0 的 registry 成功路径需要两者都可用。
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/search/repositories")) return mockRes(searchPayload, searchPayload !== null);
    return mockRes(registryPayload, registryPayload !== null);
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

// 场景 A：list-cache 目录不存在 → registry 全挂 + search 成功 → 返回 search 结果，且目录不被创建
// 注：search payload 给 2 条——V8 覆盖率里 sort 比较回调只在数组长度 >1 时被调用，
// 单条数组 sort 回调 count=0（覆盖率伪未覆盖，见 coverage.mjs 审计记录）。
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
  const orig = mockFetch(null, searchItems(["s2/skill-b", "s2/skill-c"]));
  const list = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig;
  check("过期缓存 + search 兜底返回 search 结果", list.map((r) => r.full_name), ["s2/skill-b", "s2/skill-c"]);
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

// 恢复 bundled 源（exit 钩子：断言失败 process.exit 与未捕获异常都走这里，不留坏文件）
process.on("exit", () => {
  if (bundledBackup !== null) writeFileSync(bundledPath, bundledBackup, "utf8");
  else rmSync(bundledPath, { force: true });
});
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
