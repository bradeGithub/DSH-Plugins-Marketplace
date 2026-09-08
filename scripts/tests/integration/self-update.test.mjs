// self-update handler 测试：页面打开时的版本自检状态接口。
// 覆盖：GET 返回自检状态结构（installedVersion / latestVersion / updateAvailable / checkedAt）；
// 非 GET 405。handler 在 checkedAt 超时 30 分钟时顺带触发 checkSelfUpdate（fire-and-forget）：
// mock 网络全失败 → checkSelfUpdate 走 selfLatestFromCache（读启动预热缓存）→ find 回调触发
// （覆盖率：find/sort 回调只在数组非空/长度 >1 时被调用，见 coverage.mjs 豁免记录）。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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

// 运行时互斥：让自更新版本查询保持 pending，profile POST 必须在写配置前返回 409。
let releaseVersion;
const profileHandler = registered.find((h) => h.path === "/api/marketplace/profile")?.handler;
if (profileHandler) {
  const pendingVersion = new Promise((resolve) => { releaseVersion = resolve; });
  const origBusyFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/contents/package.json")) return await pendingVersion;
    return { ok: false, status: 403, text: async () => "" };
  };
  const updateRes = mkRes();
  const updatePromise = handler({
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    url: "/api/marketplace/self-update"
  }, updateRes.res);
  const profileRes = mkRes();
  await profileHandler({
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    url: "/api/marketplace/profile"
  }, profileRes.res);
  check("self-update 运行中 profile 切换拒绝 409", profileRes.status, 409);
  releaseVersion({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ version: "0.0.0" }),
    arrayBuffer: async () => Buffer.from(JSON.stringify({ version: "0.0.0" }))
  });
  await updatePromise;
  check("self-update 互斥释放后 no-update 完成", updateRes.status, 200);
  globalThis.fetch = origBusyFetch;
} else {
  check("profile handler 存在", false, true);
}

globalThis.fetch = origFetch;

// ---- 进程适配契约已移至 infra-proc.test.mjs ----
// 自更新编排已迁至 lib/app/update.js（createUpdateUseCase：check/run/closeState）；
// CLI 的平台路径、参数数组和安全选项由 proc 直接导入行为测试锁定。
// 此处继续锁定自更新状态闭合与版本判定语义（route 转接 + app 层源码形态）。
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const src = readFileSync(join(ROOT, "lib", "index.js"), "utf8").replace(/\r\n/g, "\n");
  const routeSrc = readFileSync(join(ROOT, "lib", "http", "routes.js"), "utf8").replace(/\r\n/g, "\n");
  const appSrc = readFileSync(join(ROOT, "lib", "app", "update.js"), "utf8").replace(/\r\n/g, "\n");
  check("self-update POST 成功分支闭合状态机（closeState）", /runUpdateUseCase\.closeState\(result\)/m.test(routeSrc), true);
  check("self-update POST 成功分支用新版本号（非旧 installedVersion）", /installedVersion: result\.installedVersion/m.test(routeSrc), true);
  // mutation findings m01/m02：updateAvailable 语义拼接必须经 shouldUpdate 纯函数（<0 判定锁定），
  // 不得回退为裸 compareVersions(...) < 0 字面拼三处（直连 + registry 回退）导致语义漂移。
  const closeBody = appSrc.match(/function closeState\(result\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  check("closeState 重置 updateAvailable 为 false", /updateAvailable: false/m.test(closeBody), true);
  check("closeState 用 result.installedVersion（非旧 installedVersion）", /installedVersion: result\.installedVersion/m.test(closeBody), true);
  const checkBody = appSrc.match(/async function check\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  check("check updateAvailable 用 shouldUpdate（非裸 compareVersions）",
    (checkBody.match(/updateAvailable: shouldUpdate\(/g) ?? []).length >= 2, true);
  check("check 无裸 compareVersions 留给 updateAvailable",
    !/updateAvailable: Boolean\([^)]*compareVersions\(/.test(checkBody), true);
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
