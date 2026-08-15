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
const cssRule = /body\[data-dsh-retro\]:not\(\[data-ds-dark-theme\]\) \.dshm-dim[\s\S]{0,60}body\[data-dsh-trading\][\s\S]{0,60}body\[data-dsh-ths\][\s\S]{0,60}body\[data-dsh-xp\][\s\S]{0,60}body\[data-dsh-miku\]/;
check("对比度 CSS：5 皮肤选择器存在（含 ths）", cssRule.test(client), true);
check("对比度 CSS：.dshm-dim 提升为 label-secondary", /\.dshm-dim\{color:var\(--dsw-alias-label-secondary\)!important\}/.test(client), true);

// ---- 契约 2：仅亮色模式（深色不受影响）----
check("对比度 CSS：带亮色限定 :not([data-ds-dark-theme])",
  /body\[data-dsh-retro\]:not\(\[data-ds-dark-theme\]\)/.test(client), true);

// ---- 契约 4：皮肤包原生 UI 白字浅底修正（页面级变量覆盖）----
// 4 皮肤亮色模式 label-primary-foreground = #fff 配浅 bg-layer → 原生设置面板文字
// 不可读（皮肤包 bug）；页面级覆盖为 var(--dsw-alias-label-primary)（亮色下深色系）。
// 注意：data 属性名以皮肤包 CSS 实际声明为准（qq98 皮肤激活属性是 data-dsh-retro，
// 皮肤 id ui-skin-qq98 ≠ 属性名——曾因此选择器全失效、设置页完全无变化，实测暴露）；
// !important 防皮肤 CSS 晚于本注入时按加载顺序覆盖（变量层叠中 !important 稳定胜出）。
const pagePatch = /body\[data-dsh-retro\]:not\(\[data-ds-dark-theme\]\),body\[data-dsh-trading\]:not\(\[data-ds-dark-theme\]\),body\[data-dsh-ths\]:not\(\[data-ds-dark-theme\]\),body\[data-dsh-xp\]:not\(\[data-ds-dark-theme\]\),body\[data-dsh-miku\]:not\(\[data-ds-dark-theme\]\)\{--dsw-alias-label-primary-foreground:var\(--dsw-alias-label-primary\)!important\}/;
check("页面级覆盖：5 皮肤亮色 body 选择器（含 ths）", pagePatch.test(client), true);
check("页面级覆盖：foreground 重绑为 label-primary", /--dsw-alias-label-primary-foreground:var\(--dsw-alias-label-primary\)!important/.test(client), true);

// ---- 契约 6：miku 亮色 UI chrome 白字浅底（侧栏入口/文件树/标题栏）----
// 皮肤包规则 `[data-pane=sidebar]>div>:first-child *{color:#fff}` 染白侧栏入口文字，
// 但 miku 亮色下这些块是半透明浅彩虹渐变叠浅底（实测像素中灰 rgb(126,132,141)，
// 白字 ~3.7:1 不可读）；qq98/xp 同规则但背景为不透明深蓝渐变（白字可读）——
// 故只覆盖 miku + 仅亮色。标题栏 [class*="mikuTitlebar"] 同为半透明浅彩虹。
// ---- 契约 7：ths 皮肤映射修正（皮肤中心映射：id=ths → bodyAttr=data-dsh-ths，
// 与 id=trading → data-dsh-trading 是不同皮肤；曾因写 data-dsh-trading 而 ths 从未被覆盖，
// 亮色下 fg 仍 #fff、侧栏 2.87:1 不可读——实测暴露）----
check("ths 映射：fg 重绑含 data-dsh-ths（列表成员，非末尾）",
  /body\[data-dsh-ths\]:not\(\[data-ds-dark-theme\]\),body\[data-dsh-xp\]/.test(client), true);
check("ths 映射：.dshm-dim 规则含 data-dsh-ths",
  /body\[data-dsh-ths\]:not\(\[data-ds-dark-theme\]\) \.dshm-dim/.test(client), true);
check("ths chrome：侧栏 :first-child 重绑存在",
  /body\[data-dsh-ths\]:not\(\[data-ds-dark-theme\]\) \[data-pane=\\"sidebar\\"\] > div > :first-child \*/.test(client), true);

// ---- 契约 8：qq98 body 根色重绑（皮肤包 body[data-dsh-retro]{color:#dcebfa} 浅蓝白，
// body 自身深蓝渐变底可读，但主区域容器覆盖浅底后继承文字不可读——实测 ~1.5:1 暴露）----
check("qq98 body 根色重绑存在（亮色）",
  /body\[data-dsh-retro\]:not\(\[data-ds-dark-theme\]\)\{color:var\(--dsw-alias-label-primary\)!important\}/.test(client), true);

// ---- 契约 9：qq98/xp 设置面板溢出染白（皮肤包 `[data-pane=sidebar]>div>:first-child *`
// 通配规则命中侧栏 :first-child DOM 内的设置面板 overlay（浅底 rgb(232,241,250)），
// 文字被溢出染白——qq98 实测白字浅底、xp 同款 rgb(255,255,255)，用户实测暴露；
// 面板级重绑修复；ths/miku 侧栏通配覆盖已含 * 无需此规则。----
check("qq98 设置面板重绑存在（panel 类 + 通配）",
  /body\[data-dsh-retro\]:not\(\[data-ds-dark-theme\]\) \[class\*=\\"panel\\"\] \*/.test(client), true);
check("xp 设置面板重绑存在（panel 类 + 通配）",
  /body\[data-dsh-xp\]:not\(\[data-ds-dark-theme\]\) \[class\*=\\"panel\\"\] \*\{color:var\(--dsw-alias-label-primary\)!important\}/.test(client), true);
// 防误伤：qq98 详情面板（explorer-col）为深蓝渐变底 + 白字可读（实测 8.68:1），
// 曾误加覆盖导致深字深底不可读（实测暴露）——不得覆盖。
check("防误伤：qq98 explorer-col 不被覆盖（深蓝底白字可读）",
  !/body\[data-dsh-retro\]:not\(\[data-ds-dark-theme\]\) \[data-aionui-explorer-col\]/.test(client), true);
// 防误伤：ths explorer-col 无染白规则，无需覆盖
check("防误伤：ths explorer-col 不被覆盖",
  !/body\[data-dsh-ths\]:not\(\[data-ds-dark-theme\]\) \[data-aionui-explorer-col\]/.test(client), true);

// ---- 契约 6：miku 亮色 UI chrome（侧栏入口/文件树/标题栏）----
check("miku chrome：侧栏 :first-child 重绑存在",
  /body\[data-dsh-miku\]:not\(\[data-ds-dark-theme\]\) \[data-pane=\\"sidebar\\"\] > div > :first-child/.test(client), true);
check("miku chrome：侧栏 :first-child 通配重绑存在",
  /body\[data-dsh-miku\]:not\(\[data-ds-dark-theme\]\) \[data-pane=\\"sidebar\\"\] > div > :first-child \*/.test(client), true);
check("miku chrome：explorer-col :first-child 通配重绑存在",
  /body\[data-dsh-miku\]:not\(\[data-ds-dark-theme\]\) \[data-aionui-explorer-col\] > div > :first-child \*/.test(client), true);
check("miku chrome：标题栏重绑存在",
  /body\[data-dsh-miku\]:not\(\[data-ds-dark-theme\]\) \[class\*=\\"mikuTitlebar\\"\] \*\{color:var\(--dsw-alias-label-primary\)!important\}/.test(client), true);
check("miku chrome：仅亮色限定", /body\[data-dsh-miku\]:not\(\[data-ds-dark-theme\]\)/.test(client), true);
check("防误伤：qq98 侧栏不被覆盖（深蓝底白字 7:1 可读）",
  !/body\[data-dsh-retro\]:not\(\[data-ds-dark-theme\]\) \[data-pane="sidebar"\]/.test(client), true);
check("防误伤：xp 侧栏不被覆盖（深蓝底白字 9:1 可读）",
  !/body\[data-dsh-xp\]:not\(\[data-ds-dark-theme\]\) \[data-pane="sidebar"\]/.test(client), true);

// ---- 契约 5：injectStyles 幂等必须覆写（防 HMR/重复加载后新 CSS 不生效）----
// 旧实现 `if (document.getElementById("dshm-styles")) return;` —— 页面已有旧 style
// 标签时新 bundle 的 CSS 永不注入（bundle 更新后修复不生效，实测暴露）。
check("injectStyles 覆写式（标签存在时更新内容）", /if \(el\) \{ el\.textContent = css; return; \}/.test(client), true);
check("injectStyles 无 return 跳过旧逻辑", !/document\.getElementById\("dshm-styles"\)\) return;/.test(client), true);

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
