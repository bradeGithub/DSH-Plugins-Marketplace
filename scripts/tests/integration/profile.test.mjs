// 目标 profile 配置（issue #184）行为测试：
// - setTargetProfile 白名单校验（非法名回退 web，不抛）
// - 路径注入拒绝：../ 等穿越段不得进入路径常量
// - readTargetProfile：config.json 缺失/非法/目录不存在 → 回退 web
// - profile 路由：GET 读当前值；POST 保存（非法名 400 / 不存在目录 400 / 合法 200）
// - 写操作鉴权：POST 需 isWriteAllowed（LAN 无 token → 403）
//
// 独立文件的原因：profile 路径常量是模块级 let（import 时按 DSH_HOME 计算），
// 且 setTargetProfile 会重算它们——必须独立进程隔离。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 必须在 import lib 之前设置临时 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-profile-test-")).replace(/\\/g, "/");
const home = process.env.DSH_HOME;
const marketRoot = join(home, "marketplace");
mkdirSync(marketRoot, { recursive: true });
// 建 web + desktop 两个 profile（desktop 模拟 hermes 客户端场景）
mkdirSync(join(home, "profiles", "web"), { recursive: true });
mkdirSync(join(home, "profiles", "desktop"), { recursive: true });
const configFile = join(marketRoot, "config.json");

const lib = await import("../../../lib/index.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- setTargetProfile 白名单 ----
check("setTargetProfile 合法名生效", lib.setTargetProfile("desktop"), "desktop");
// 路径常量已重算（desktop）——Windows 分隔符兼容
check("setTargetProfile 后 PROFILE_NM 指向 desktop", lib.getProfileNodeModules().includes(join("profiles", "desktop", "node_modules")), true);
check("setTargetProfile 非法名回退 web", lib.setTargetProfile("../evil"), "web");
check("setTargetProfile 空串回退 web", lib.setTargetProfile(""), "web");
check("setTargetProfile 含点回退 web", lib.setTargetProfile("web.profile"), "web");
// 恢复 web（后续测试用）
lib.setTargetProfile("web");

// ---- readTargetProfile：config.json 缺失 → web（fromConfig=false，启动回调不覆盖显式设置）----
check("readTargetProfile 无配置回退 web", await lib.readTargetProfile(), { profile: "web", fromConfig: false });

// ---- readTargetProfile：非法名 → web ----
writeFileSync(configFile, JSON.stringify({ targetProfile: "../evil" }), "utf8");
check("readTargetProfile 非法名回退 web", await lib.readTargetProfile(), { profile: "web", fromConfig: false });

// ---- readTargetProfile：目录不存在 → web ----
writeFileSync(configFile, JSON.stringify({ targetProfile: "ghost" }), "utf8");
check("readTargetProfile 目录不存在回退 web", await lib.readTargetProfile(), { profile: "web", fromConfig: false });

// ---- readTargetProfile：合法 + 目录存在 → 生效（fromConfig=true）----
writeFileSync(configFile, JSON.stringify({ targetProfile: "desktop" }), "utf8");
check("readTargetProfile 合法配置生效", await lib.readTargetProfile(), { profile: "desktop", fromConfig: true });

// ---- readTargetProfile：损坏 JSON → web ----
writeFileSync(configFile, "{ broken", "utf8");
check("readTargetProfile 损坏 JSON 回退 web", await lib.readTargetProfile(), { profile: "web", fromConfig: false });

// ---- profile 路由 ----
let registered = [];
const fakeCtx = {
  get: (s) => (s === "webServer" ? { register: (r) => registered.push(r) } : undefined),
  logger: { warn: () => {}, info: () => {} },
};
lib.apply(fakeCtx);
const profileHandler = registered.find((h) => h.path === "/api/marketplace/profile")?.handler;
check("profile 路由已注册", !!profileHandler, true);

// 恢复合法配置（路由测试用）
writeFileSync(configFile, JSON.stringify({ targetProfile: "desktop" }), "utf8");
// apply 的 readTargetProfile 是异步的——路由测试前手动应用，模拟启动完成态
lib.setTargetProfile("desktop");

const mkReq = (method, body, host = "127.0.0.1") => {
  const bodyStr = body ? JSON.stringify(body) : "";
  return {
    method,
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    socket: { remoteAddress: host },
    url: "/api/marketplace/profile",
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: async () => {
          if (!sent) { sent = true; return { value: Buffer.from(bodyStr), done: false }; }
          return { value: undefined, done: true };
        },
      };
    },
  };
};
const mkRes = () => {
  const out = { status: 0, body: null };
  return {
    writeHead: (s) => { out.status = s; },
    end: (b) => { try { out.body = JSON.parse(b); } catch { out.body = b; } },
    out,
  };
};

// GET：读当前值（desktop）
{
  const res = mkRes();
  await profileHandler(mkReq("GET"), res);
  check("profile GET 返回当前值", res.out.body?.profile, "desktop");
}
// POST 非法名 → 400
{
  const res = mkRes();
  await profileHandler(mkReq("POST", { profile: "../evil" }), res);
  check("profile POST 非法名 400", res.out.status, 400);
}
// POST 不存在目录 → 400
{
  const res = mkRes();
  await profileHandler(mkReq("POST", { profile: "ghost" }), res);
  check("profile POST 不存在目录 400", res.out.status, 400);
}
// POST 合法 → 200 + 即时生效
{
  const res = mkRes();
  await profileHandler(mkReq("POST", { profile: "desktop" }), res);
  check("profile POST 合法 200", res.out.status, 200);
  check("profile POST 返回新值", res.out.body?.profile, "desktop");
  check("profile POST 后 config.json 已写", JSON.parse(readFileSync(configFile, "utf8")).targetProfile, "desktop");
}
// POST 空值 → 400（必须显式给合法名）
{
  const res = mkRes();
  await profileHandler(mkReq("POST", { profile: "" }), res);
  check("profile POST 空值 400", res.out.status, 400);
}

// ---- 写操作鉴权：LAN Host 无 token → 403 ----
{
  const res = mkRes();
  await profileHandler(mkReq("POST", { profile: "desktop" }, "192.168.1.5"), res);
  check("profile POST LAN 无 token 403", res.out.status, 403);
}

// ---- 清理 ----
rmSync(home, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
