// 亮色皮肤对比度契约测试——静态断言（不执行 client bundle）。
//
// 背景：cea8b27 的对比度修复曾因 rebase 丢失、用户实测「还是没解决」——契约固化防再丢。
// 根因：qq98/trading/xp/miku 皮肤亮色模式把 bg 层改浅（bg-layer-1/2 为 #eef1f5~#f2f7fc），
// 但 label-primary-foreground 仍是白色（dark-first 失效）→ 次要文本（label-tertiary）
// 在浅层上对比度仅 ~2.2-3.4:1 不可读。
//
// 契约：
//   1) 4 个问题皮肤（qq98/trading/xp/miku）的亮色模式下，.dshm-dim（次要文本 class）
//      提升为 label-secondary（实测 ≥4.6:1，过 WCAG AA）；
//   2) 覆盖仅作用于亮色模式（:not([data-ds-dark-theme])）——深色模式无需覆盖；
//   3) 次要文本元素（badge/meta/sub/tabBtn/loading/empty/count/disclaimer）统一带
//      .dshm-dim class——覆盖点缺失等于部分文字仍然不可读。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const client = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- 契约 1：4 皮肤亮色模式 .dshm-dim → label-secondary ----
const cssRule = /body\[data-dsh-qq98\]:not\(\[data-ds-dark-theme\]\) \.dshm-dim[\s\S]{0,60}body\[data-dsh-trading\][\s\S]{0,60}body\[data-dsh-xp\][\s\S]{0,60}body\[data-dsh-miku\]/;
check("对比度 CSS：4 皮肤选择器存在", cssRule.test(client), true);
check("对比度 CSS：.dshm-dim 提升为 label-secondary", /\.dshm-dim\{color:var\(--dsw-alias-label-secondary\)!important\}/.test(client), true);

// ---- 契约 2：仅亮色模式（深色不受影响）----
check("对比度 CSS：带亮色限定 :not([data-ds-dark-theme])",
  /body\[data-dsh-qq98\]:not\(\[data-ds-dark-theme\]\)/.test(client), true);

// ---- 契约 3：次要文本元素统一带 .dshm-dim ----
const dimUsage = (client.match(/className: "dshm-dim"/g) ?? []).length;
check("dshm-dim 使用点 ≥8（badge×3/meta×2/sub/loading×2/empty×3/count×2/tabBtn×2/disclaimer/btnInstalled）",
  dimUsage >= 8, true);
check("badge 带 dshm-dim", /className: "dshm-dim", style: s\.badge/.test(client), true);
check("meta 带 dshm-dim", /className: "dshm-dim", style: s\.meta/.test(client), true);
check("pageSub 带 dshm-dim", /className: "dshm-dim", style: s\.sub/.test(client), true);
check("tab 未选中带 dshm-dim", /className: activeTab === "plugins" \? "" : "dshm-dim"/.test(client), true);
check("disclaimer 带 dshm-dim", /className: "dshm-dim", style: \{ fontSize: 11, color: "var\(--dsw-alias-label-tertiary\)", marginTop: 16/.test(client), true);
check("已安装按钮带 dshm-dim", /className: "dshm-btn" \+ \(done \? " dshm-dim" : " dshm-btn-primary"\)/.test(client), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
