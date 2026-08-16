// M1 写操作访问控制行为测试：
// - 回环 Host → 写操作放行（默认模式，无需 token）
// - LAN Host → 403（默认：未开启 lanWrite）
// - LAN Host + lanWrite: true + 无 token → 403
// - LAN Host + lanWrite: true + 正确 token → 200（token 从 tapIndex 注入的 HTML 解析）
// - LAN Host + lanWrite: true + 错误 token → 403
// - token 长度不同 → 403（不泄露）
//
// 独立文件的原因：lib 模块在 import 时按 DSH_HOME 计算模块级常量，
// 且 writeToken 为模块级状态（进程生命周期），必须独立进程隔离。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 必须在 import lib 之前设置临时 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-write-test-")).replace(/\\/g, "/");
const home = process.env.DSH_HOME;
const marketRoot = join(home, "marketplace");
const cacheDir = join(marketRoot, "cache");
const insideDir = join(cacheDir, "w__inside");
mkdirSync(insideDir, { recursive: true });
writeFileSync(join(insideDir, "x.txt"), "x", "utf8");
writeFileSync(join(marketRoot, "installed.json"), JSON.stringify({
  "w/inside": { type: "script", name: "inside", location: insideDir, installedAt: 1 }
}), "utf8");
const configFile = join(marketRoot, "config.json");

const lib = await import("../../../lib/index.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// fakeCtx 捕获路由 + tapIndex 变换（token 注入通道）
let registered = [];
let taps = [];
const fakeCtx = {
  get: (s) => (s === "webServer" ? {
    register: (r) => registered.push(r),
    tapIndex: (t) => taps.push(t),
  } : undefined),
  logger: { warn: () => {} },
};
lib.apply(fakeCtx);
const uninstallHandler = registered.find((h) => h.path === "/api/marketplace/uninstall")?.handler;
check("uninstall 路由已注册", !!uninstallHandler, true);
check("tapIndex 已注册", taps.length, 1);

// 从 tapIndex 注入的 HTML 解析 token（模拟页面加载后 window.__DSH_MP_TOKEN__）
const injected = taps[0]("<html><head></head></html>");
const tokenMatch = /__DSH_MP_TOKEN__="([0-9a-f]{64})"/.exec(injected);
check("注入脚本含 64 位 hex token", !!tokenMatch, true);
const token = tokenMatch ? tokenMatch[1] : "";

// socketAddr 模拟连接层远端地址（回环判定依据，不可伪造）：默认 LAN 地址，
// 回环场景显式传 127.0.0.1；Host 头与 socket 地址分离——验证 Host 伪造不再放行。
const mkReq = (host, extraHeaders, socketAddr = "192.168.1.50") => ({
  method: "POST",
  headers: { "x-dsh-marketplace": "1", host, ...(extraHeaders ?? {}) },
  socket: { remoteAddress: socketAddr },
  [Symbol.asyncIterator]: function* () { yield Buffer.from(JSON.stringify({ repo: "w/inside" })); },
});
const mkRes = () => {
  let status = 0;
  let body = null;
  return {
    res: { writeHead: (s) => { status = s; }, end: (b) => { try { body = JSON.parse(b); } catch { body = null; } } },
    get status() { return status; },
    get body() { return body; },
  };
};

if (uninstallHandler) {
  // 注意顺序：installedMap 是模块内存态（import 时从 installed.json 加载一次）——
  // 卸载会移除内存记录，故「卸载生效」类断言只能出现一次（放最后），后续场景
  // 的文件重建不更新内存记录（校验路径：回环 403 场景不需要记录）。

  // 场景 1：LAN Host → 403（默认未开启 lanWrite）
  const r1 = mkRes();
  await uninstallHandler(mkReq("192.168.1.50:3080"), r1.res);
  check("LAN Host 默认模式 → 403", r1.status, 403);
  check("LAN Host 拒绝后目录保留", existsSync(insideDir), true);

  // 场景 2：lanWrite: true + LAN Host + 无 token → 403
  writeFileSync(configFile, JSON.stringify({ lanWrite: true }), "utf8");
  const r2 = mkRes();
  await uninstallHandler(mkReq("192.168.1.50:3080"), r2.res);
  check("LAN 模式缺 token → 403", r2.status, 403);

  // 场景 3：lanWrite: true + LAN Host + 正确 token → 200 + 卸载生效
  const r3 = mkRes();
  await uninstallHandler(mkReq("192.168.1.50:3080", { "x-dsh-marketplace-token": token }), r3.res);
  check("LAN 模式 + 正确 token → 200", r3.status, 200);
  check("LAN 模式卸载生效", existsSync(insideDir), false);

  // 场景 4：lanWrite: true + LAN Host + 错误 token → 403
  const r4 = mkRes();
  await uninstallHandler(mkReq("192.168.1.50:3080", { "x-dsh-marketplace-token": "f".repeat(64) }), r4.res);
  check("LAN 模式 + 错误 token → 403", r4.status, 403);

  // 场景 5：token 长度不同（63 hex）→ 403（长度检查防泄露）
  const r5 = mkRes();
  await uninstallHandler(mkReq("192.168.1.50:3080", { "x-dsh-marketplace-token": "a".repeat(63) }), r5.res);
  check("LAN 模式 + 长度不符 token → 403", r5.status, 403);

  // 场景 6：回环 socket → 放行（默认模式，无 token；无记录时卸载提示无记录但 200）
  const r6 = mkRes();
  await uninstallHandler(mkReq("127.0.0.1:3080", undefined, "127.0.0.1"), r6.res);
  check("回环 socket 写操作 → 200", r6.status, 200);

  // 场景 7：LAN socket 自报回环 Host → 仍 403（Host 头可伪造，不得绕过 token）
  const r7 = mkRes();
  await uninstallHandler(mkReq("127.0.0.1:3080"), r7.res);
  check("LAN socket + 伪回环 Host → 403", r7.status, 403);
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
