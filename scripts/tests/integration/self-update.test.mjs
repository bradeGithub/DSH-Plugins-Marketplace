// self-update handler 测试：页面打开时的版本自检状态接口。
// 覆盖：GET 返回自检状态结构（installedVersion / latestVersion / updateAvailable / checkedAt）；
// 非 GET 405。handler 在 checkedAt 超时 30 分钟时顺带触发 checkSelfUpdate（fire-and-forget）：
// mock 网络全失败 → checkSelfUpdate 走 selfLatestFromCache（读启动预热缓存）→ find 回调触发
// （覆盖率：find/sort 回调只在数组非空/长度 >1 时被调用，见 coverage.mjs 审计记录）。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 必须在 import lib 之前设置临时 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-selfupdate-")).replace(/\\/g, "/");
const home = process.env.DSH_HOME;

// mock 网络：registry/search 全失败 → list 走磁盘缓存、checkSelfUpdate 走自检缓存兜底
const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" });

// 预置 list-cache（1 条非本体仓库）：list 预热后 listCaches.dsh.repos 为非空数组
const listCacheDir = join(home, "marketplace", "list-cache");
mkdirSync(listCacheDir, { recursive: true });
const now = new Date().toISOString();
writeFileSync(join(listCacheDir, "dsh.json"), JSON.stringify({
  saved_at: now, generated_at: now, kind: "dsh", count: 1,
  repos: [{
    full_name: "other/plugin", name: "plugin", description: "x", html_url: "https://github.com/other/plugin",
    stargazers_count: 5, updated_at: "2026-01-01T00:00:00Z", default_branch: "main", topics: [],
    license: null, pkg_name: null, version: "1.0.0", category: null, has_skill: null, has_install_script: null,
  }],
}), "utf8");

const lib = await import("../../../lib/index.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

let registered = [];
const fakeCtx = {
  get: (s) => (s === "webServer" ? { register: (r) => registered.push(r) } : undefined),
  logger: { warn: () => {} },
};
lib.apply(fakeCtx);
const handler = registered.find((h) => h.path === "/api/marketplace/self-update")?.handler;
check("self-update 路由已注册", !!handler, true);

const mkRes = () => {
  let status = 0;
  let body = null;
  return {
    res: { writeHead: (s) => { status = s; }, end: (b) => { try { body = JSON.parse(b); } catch { body = null; } } },
    get status() { return status; },
    get body() { return body; },
  };
};

if (handler) {
  // 先 list 预热：listCaches.dsh.repos = 非空数组（selfLatestFromCache 的 find 回调需要）
  const listHandler = registered.find((h) => h.path === "/api/marketplace/list")?.handler;
  if (listHandler) {
    const lr = mkRes();
    // v1.4.x：self-update/list 等 handler 增加 isTrustedRequest（CSRF 头 + 本地 host）校验
    await listHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/list" }, lr.res);

    check("self-update 前置：list 预热成功", lr.status, 200);
  }

  // GET：返回自检状态结构（字段存在；版本可能为 null——测试环境无安装记录）。
  // checkedAt 初始为 0 → 触发 checkSelfUpdate（mock 网络失败 → selfLatestFromCache → find 回调）
  const r = mkRes();
  await handler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/self-update" }, r.res);

  check("self-update GET 状态", r.status, 200);
  check("self-update 响应含 installedVersion 字段", Object.hasOwn(r.body ?? {}, "installedVersion"), true);
  check("self-update 响应含 latestVersion 字段", Object.hasOwn(r.body ?? {}, "latestVersion"), true);
  check("self-update 响应含 updateAvailable 字段", Object.hasOwn(r.body ?? {}, "updateAvailable"), true);
  check("self-update 响应含 checkedAt 字段", Object.hasOwn(r.body ?? {}, "checkedAt"), true);

  // v1.4.7：POST 改为「执行更新」（真实克隆 + 原子替换本体——测试环境不触发，
  // 避免污染工作区文件）；其余非 GET 方法仍 405。
  const r2 = mkRes();
  await handler({ method: "PUT", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/self-update" }, r2.res);
  check("self-update PUT → 405", r2.status, 405);

}

// 等 checkSelfUpdate 异步完成（mock fetch 立即失败 → catch → selfLatestFromCache 同步调用）
await new Promise((r) => setTimeout(r, 100));
globalThis.fetch = origFetch;
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
