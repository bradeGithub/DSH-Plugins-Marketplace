#!/usr/bin/env node
// 真实 DSH 环境端到端（#198 增补）：启动本机 dsh web，经 HTTP 验证
// 跨 profile 状态机——profile 切换 → 列表标注/fp 随 profile 重算 → 白名单/目录校验。
// 这是唯一覆盖「真实 DSH 宿主加载（cosmokit）→ 端口 → 鉴权 → 注入」全链路的形态。
//
// 前置：dsh CLI 可用（缺失或 3080 已被实例占用 → SKIP，不打扰用户运行中的实例）。
// 运行：node scripts/tests/e2e/real-dsh.e2e.mjs

import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOST = "http://127.0.0.1:3080";
const HEADERS = { "x-dsh-marketplace": "1" };

// ---- 前置检查 ----
let dshAvailable = true;
try {
  if (process.platform === "win32") {
    execFileSync("cmd.exe", ["/c", "dsh", "--version"], { stdio: "pipe", windowsHide: true }); // .cmd 垫片 spawn EINVAL，经 cmd 包装（issue #46 同族）
  } else {
    execFileSync("dsh", ["--version"], { stdio: "pipe", windowsHide: true });
  }
} catch { dshAvailable = false; }
if (!dshAvailable) { console.log("SKIP: dsh CLI 不可用"); process.exit(0); }
try {
  const probe = await fetch(`${HOST}/api/marketplace/profile`, { headers: HEADERS, signal: AbortSignal.timeout(2000) });
  if (probe.ok) { console.log("SKIP: 3080 已有 dsh 实例在运行（请手动验证或关闭后重跑）"); process.exit(0); }
} catch { /* 无实例：继续 */ }

// ---- 启动 dsh web（Windows 经 cmd.exe /c：.cmd 垫片 spawn EINVAL，issue #46 同族）----
let child = null;
const cleanup = () => {
  if (child && child.pid) {
    try { execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }); } catch { try { child.kill(); } catch { /* 已退出 */ } }
    child = null;
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const isWin = process.platform === "win32";
child = isWin
  ? spawn("cmd.exe", ["/c", "dsh", "web", "--no-open"], { stdio: "ignore", windowsHide: true, detached: true })
  : spawn("dsh", ["web", "--no-open"], { stdio: "ignore", detached: true });

// ---- 等待就绪（市场插件随 profile bundles 加载，profile 路由可应答即就绪；轮询 60s）----
let ready = false;
for (let i = 0; i < 300 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 200));
  try {
    const r = await fetch(`${HOST}/api/marketplace/profile`, { headers: HEADERS, signal: AbortSignal.timeout(1500) });
    if (r.ok) ready = true;
  } catch { /* 未就绪 */ }
}
if (!ready) { console.log("FAIL: dsh web 60s 内未就绪（市场插件未加载？）"); cleanup(); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const api = async (path, opts = {}) => {
  const res = await fetch(HOST + path, {
    headers: { ...HEADERS, ...(opts.json ? { "Content-Type": "application/json" } : {}) },
    method: opts.method ?? "GET",
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    // list 首拉需全量标注（12 worker stat 千级 repo），放大到 120s
    signal: AbortSignal.timeout(opts.timeout ?? (path.startsWith("/api/marketplace/list") ? 120000 : 30000)),
  });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
};

try {
  // 1. profile GET 初始为 web
  const p0 = await api("/api/marketplace/profile");
  check("profile GET 初始为 web", [p0.status, p0.body?.profile], [200, "web"]);
  // 2. 非法名（路径穿越形态）拒绝
  const pBad = await api("/api/marketplace/profile", { method: "POST", json: true, body: { profile: "../evil" } });
  check("profile POST 非法名 400", pBad.status, 400);
  // 3. 不存在的 profile 拒绝（目录存在性校验）
  const pGhost = await api("/api/marketplace/profile", { method: "POST", json: true, body: { profile: "ghost" } });
  check("profile POST 不存在 400", pGhost.status, 400);
  // 4. 列表初始响应：repos>0 + fp 存在
  const l0 = await api("/api/marketplace/list?lang=zh-CN");
  check("list 正常（repos>0 带 fp）", [l0.status, (l0.body?.repos ?? []).length > 0, typeof l0.body?.fp === "string"], [200, true, true]);

  // 5-8. 切到备用 profile（除 web 外的真实目录）→ 列表 fp 必须变化（标注随 profile 重算）
  const profilesRoot = join(homedir(), ".dsh", "profiles");
  let altProfile = null;
  try { altProfile = readdirSync(profilesRoot).find((d) => d !== "web" && d !== "node_modules"); } catch { /* 目录不可读 */ }
  if (altProfile) {
    const p1 = await api("/api/marketplace/profile", { method: "POST", json: true, body: { profile: altProfile } });
    check(`profile POST → ${altProfile} 成功`, [p1.status, p1.body?.profile], [200, altProfile]);
    const p2 = await api("/api/marketplace/profile");
    check("profile GET 确认切换", p2.body?.profile, altProfile);
    const l1 = await api("/api/marketplace/list?lang=zh-CN");
    check("切换后列表 fp 变化（标注重算）", typeof l1.body?.fp === "string" && l1.body.fp !== l0.body?.fp, true);
    const p3 = await api("/api/marketplace/profile", { method: "POST", json: true, body: { profile: "web" } });
    check("切回 web", p3.body?.profile, "web");
  } else {
    console.log("SKIP: 无备用 profile，跳过切换断言");
  }
} finally {
  cleanup();
}

console.log(`\nreal-dsh e2e: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
