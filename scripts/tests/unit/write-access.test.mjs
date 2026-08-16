// M1 写操作访问控制契约测试——静态断言（不执行 lib）。
//
// 设计：默认仅回环 Host 可写（install/uninstall）——LAN 扫描器无法无凭据触发脚本执行；
// LAN 模式 = config.json 显式开启 lanWrite: true（业界惯例：LAN 免密视为显式降级，
// 参考 Home Assistant trusted_networks），此时 LAN Host 放行但必须携带会话 token：
// 启动 randomBytes(32) 生成 → tapIndex 注入页面 → 请求头 x-dsh-marketplace-token →
// timing-safe 比较（防时序侧信道）。读操作不校验 token（LAN 可浏览，无害）。
//
// 契约：
//   1) 写操作判定 isWriteAllowed = isTrustedRequest + 回环放行 / LAN 需配置+token；
//   2) token 每次启动随机生成（randomBytes 32 → hex 64 字符），timing-safe 比较；
//   3) lanWrite 配置缺失/损坏 = 未开启（默认安全，fail-closed）；
//   4) tapIndex 注入页面（低版本 DSH 无此 API 时跳过——LAN 写因拿不到 token 而拒绝）；
//   5) install / uninstall 两个写 handler 都走 isWriteAllowed；
//   6) 客户端写操作请求带 token 头（从 window.__DSH_MP_TOKEN__ 读）。

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

// ---- 契约 1：isWriteAllowed 结构（isTrustedRequest + 回环/LAN 分支）----
const fnBody = lib.match(/async function isWriteAllowed\(req\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("isWriteAllowed 存在", fnBody.length > 0, true);
check("先过 isTrustedRequest（CSRF+Host+Origin）", fnBody.includes("if (!isTrustedRequest(req)) return false;"), true);
check("回环 socket 地址直接放行（不可伪造）", fnBody.includes('remote === "127.0.0.1" || remote === "localhost" || remote === "::1"'), true);
check("回环判定用 socket 而非 Host 头", fnBody.includes("req.socket?.remoteAddress"), true);
check("IPv4-mapped IPv6 归一", fnBody.includes("::ffff:"), true);
check("LAN 需 lanWrite 配置", fnBody.includes("if (!(await isLanWriteEnabled())) return false;"), true);
check("token 长度不同先拒绝（防泄露）", fnBody.includes("if (got.length !== writeToken.length) return false;"), true);
check("timing-safe 比较", fnBody.includes("timingSafeEqual(Buffer.from(got), Buffer.from(writeToken))"), true);

// ---- 契约 2：token 生成 ----
check("token 启动随机生成（randomBytes 32 → hex）", /const writeToken = randomBytes\(32\)\.toString\("hex"\);/.test(lib), true);
check("token 头名 x-dsh-marketplace-token", /const WRITE_TOKEN_HEADER = "x-dsh-marketplace-token";/.test(lib), true);

// ---- 契约 3：lanWrite 配置 fail-closed ----
const lanBody = lib.match(/async function isLanWriteEnabled\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("isLanWriteEnabled 存在", lanBody.length > 0, true);
check("lanWrite === true 才开启", lanBody.includes('cfg.lanWrite === true'), true);
check("读取失败视为未开启（默认安全）", lanBody.includes("} catch {\n    return false;"), true);

// ---- 契约 4：tapIndex 注入（防御性 typeof 检查）----
check("tapIndex 注入存在", /typeof webServer\.tapIndex === "function"/.test(lib), true);
check("注入 __DSH_MP_TOKEN__ 脚本", /window\.__DSH_MP_TOKEN__="\$\{writeToken\}"/.test(lib), true);

// ---- 契约 5：两个写 handler 都走 isWriteAllowed ----
check("install 走 isWriteAllowed", (lib.match(/await isWriteAllowed\(req\)\)\) return json\(res, 403/g) ?? []).length, 2);

// ---- 契约 6：客户端写操作带 token 头 ----
check("client mpHeaders 存在", /function mpHeaders\(extra\) \{[\s\S]{0,200}window\.__DSH_MP_TOKEN__/.test(client), true);
check("install fetch 用 mpHeaders", /headers: mpHeaders\(\{ "Content-Type": "application\/json" \}\)/.test(client), true);
check("uninstall fetch 用 mpHeaders", /headers: mpHeaders\(\{ "Content-Type": "application\/json" \}\)/.test(client), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
