// install.ps1 / install.sh 安装脚本注册幂等契约——静态断言（不执行脚本）。
//
// 契约（与 README 及真实环境 cordis.patch.yml 一致）：
//   1) 追加条目的 id 必须是 dsh-plugin-marketplace（与包名一致，dsh 统一开头；
//      历史不一致：README 曾写 plugin-marketplace，本机环境也曾用该 id）
//   2) 追加条目的 name 必须是 dsh-plugin-marketplace（包名）
//   3) 注册检测正则必须缩进感知（真实 patch 条目嵌套在 `- insert:` 下，
//      `      name: ...` 前导空格；行首锚定 `^name:` 永远匹配不到 → 每次运行追加重复块）
//   4) 两个脚本行为必须一致（sh 用 POSIX [[:space:]] 保 macOS BSD grep 兼容）
//
// 静态断言跨平台、零依赖、秒级——固化防回归；行为验证见 integration/install-scripts.test.mjs。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
const ps1 = readFileSync(join(ROOT, "install.ps1"), "utf8");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- 契约 1：追加条目 id 与包名一致（dsh-plugin-marketplace）----
// 注意：`- id: plugin-marketplace` 是 `- id: dsh-plugin-marketplace` 的子串，
// 必须用负向断言（后不跟 `-` 或词字符）区分，防止子串误判。
check("sh 追加条目 id 为 dsh-plugin-marketplace", /- id: dsh-plugin-marketplace/.test(sh), true);
check("sh 追加条目 id 非独立 plugin-marketplace", !/- id: plugin-marketplace(?![-\w])/.test(sh), true);
check("ps1 追加条目 id 为 dsh-plugin-marketplace", /- id: dsh-plugin-marketplace/.test(ps1), true);
check("ps1 追加条目 id 非独立 plugin-marketplace", !/- id: plugin-marketplace(?![-\w])/.test(ps1), true);

// ---- 契约 2：追加 name 为包名 ----
check("sh 追加 name 为 dsh-plugin-marketplace", /name: dsh-plugin-marketplace/.test(sh), true);
check("ps1 追加 name 为 dsh-plugin-marketplace", /name: dsh-plugin-marketplace/.test(ps1), true);

// ---- 契约 3：检测正则缩进感知 ----
check("sh 检测正则允许前导空白 ([[:space:]]*)", /\^\[\[:space:\]\]\*name:/.test(sh), true);
check("ps1 检测正则允许前导空白 (\\s*)", /\^\\s\*name:/.test(ps1), true);
// 防回归：行首锚定（^name:）会漏匹配嵌套缩进条目 → 每次运行追加重复块
check("sh 无行首锚定回归", !/\^name:\[\[:space:\]\]/.test(sh) && !grepShLineAnchor(), true);
check("ps1 无行首锚定回归", !/\^name:/.test(ps1.replace(/\^\\s\*name:/g, "")), true);

function grepShLineAnchor() {
  // sh 侧若出现 `grep ... '^name:` 或 `"^name:` 形式即视为回归
  return /grep[^;]*['"]\^name:/.test(sh);
}

// ---- 契约 4：两脚本条目语义一致（id + name 序列相同）----
const shEntry = /printf\s+'([^']*dsh-plugin-marketplace[^']*)'/.exec(sh);
const ps1Entry = /\$entry = "([^"]*dsh-plugin-marketplace[^"]*)"/.exec(ps1);
check("sh 条目含 insert 块", shEntry ? shEntry[1].includes("- insert:") : false, true);
check("ps1 条目含 insert 块", ps1Entry ? ps1Entry[1].includes("- insert:") : false, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
