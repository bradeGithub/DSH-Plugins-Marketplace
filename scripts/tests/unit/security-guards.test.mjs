// L6/L7 安全守卫契约测试——静态断言（不执行 lib）。
//
// L6 响应大小上限：registry/CDN/search 响应无大小限制（缓解：来源可信）——
// 根本问题 = 资源上限缺失。Content-Length 超 MAX_RESPONSE_BYTES(32MB) 直接
// 拒绝（fetchJson 抛错 / fetchRegistryRepos 换下一源）。
// L7 __proto__ 原型污染（理论）：JSON 数据的 __proto__ 键经 Object.assign 的
// [[Set]] 触发原型 setter。safeAssign 用 Object.keys 显式剔除危险键（Object.keys
// 只枚举 own enumerable，__proto__ 作 own data property 可被枚举——需显式剔除）。
// GitHub 字段固定实际不可达，但边界防御成本为零，理论污染面一并封死。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lib = readFileSync(join(ROOT, "lib", "index.js"), "utf8");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- L6：响应大小上限 ----
check("MAX_RESPONSE_BYTES = 32MB", /const MAX_RESPONSE_BYTES = 32 \* 1024 \* 1024;/.test(lib), true);
const sizeBody = lib.match(/function responseTooLarge\(res\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("responseTooLarge 存在", sizeBody.length > 0, true);
check("responseTooLarge 读 content-length", sizeBody.includes('res?.headers?.get?.("content-length")'), true);
const fetchJsonBody = lib.match(/async function fetchJson\(url, extraHeaders = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("fetchJson 超限抛错", /if \(responseTooLarge\(res\)\) throw new Error\(`响应过大/.test(fetchJsonBody), true);
check("fetchRegistryRepos 超限换源", /if \(responseTooLarge\(res\)\) continue; \/\/ L6/.test(lib), true);

// ---- L7：safeAssign 防原型污染 ----
const safeBody = lib.match(/function safeAssign\(target, \.\.\.sources\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check("safeAssign 存在", safeBody.length > 0, true);
check("剔除 __proto__", safeBody.includes('k === "__proto__"'), true);
check("剔除 constructor", safeBody.includes('k === "constructor"'), true);
check("剔除 prototype", safeBody.includes('k === "prototype"'), true);
check("用 Object.keys 枚举（own enumerable）", safeBody.includes("Object.keys(s)"), true);
check("list handler 用 safeAssign（替换 Object.assign）", (lib.match(/flagged\[idx\] = safeAssign\(\{\}, repo, \{/g) ?? []).length, 2);
check("导出含 safeAssign", /export \{[\s\S]*safeAssign \}/.test(lib), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
