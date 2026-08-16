// Skin Manifest 校验器单元测试（阶段 0 基座）。
// 规范：docs/skin-manifest-spec.md v0.1；样例数据来自 docs/skins-manifest-record.md
// （qq98 实测基线——亮色 label-primary #17293c vs bg-base #ffffff 对比度应达标）。

import { validateSkinManifest, parseColor, contrastRatio, SCHEMA_VERSION, REQUIRED_TOKENS } from "../../../lib/skin-manifest.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// ---- qq98 真实样例（skins-manifest-record.md 基线数据）----
const qq98 = {
  schemaVersion: SCHEMA_VERSION,
  id: "qq98",
  name: { zh: "QQ2008 怀旧版", en: "QQ2008 Retro" },
  author: "dsh-web-ui",
  accent: "#2b7cd9",
  bodyAttr: "data-dsh-retro",
  package: "@linxin666/dsh-client-ui-skin-qq98",
  order: 1,
  tags: ["retro", "qq"],
  palette: {
    modes: ["light", "dark"],
    light: {
      "bg-base": "#ffffff",
      "label-primary": "#17293c",
      "label-primary-foreground": "#17293c",
      "label-secondary": "#3d566e",
      "label-tertiary": "#5f7890",
      "brand-primary": "#2b7cd9",
    },
    dark: {
      "bg-base": "#0e2f5e",
      "label-primary": "#dcebfa",
      "label-primary-foreground": "#dcebfa",
      "label-secondary": "#b8cfe4",
      "label-tertiary": "#94afc9",
      "brand-primary": "#4a9ae8",
    },
  },
  components: {
    titlebar: { text: "#ffffff", background: "linear-gradient(90deg,#1a56a6 0%,#2b7cd9 55%,#4a9ae8 100%)", ratio: 4.5 },
    "sidebar-header": { text: "#ffffff", background: "linear-gradient(#1a56a6,#2b7cd9)", ratio: 7 },
  },
  checks: [
    { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
  ],
};

// ---- 颜色/对比度纯函数 ----
check("parseColor #rgb", parseColor("#fff"), [255, 255, 255]);
check("parseColor #rrggbb", parseColor("#17293c"), [0x17, 0x29, 0x3c]);
check("parseColor rgb()", parseColor("rgb(23, 41, 60)"), [23, 41, 60]);
check("parseColor rgba()", parseColor("rgba(23, 41, 60, 0.5)"), [23, 41, 60]);
check("parseColor 渐变 null", parseColor("linear-gradient(#fff,#000)"), null);
check("parseColor var() null", parseColor("var(--dsw-alias-label-primary)"), null);
check("parseColor 非字符串 null", parseColor(42), null);
check("parseColor 空 null", parseColor(""), null);
check("对比度 白/黑", contrastRatio([255, 255, 255], [0, 0, 0]), 21);
check("对比度 白/白", contrastRatio([255, 255, 255], [255, 255, 255]), 1);
check("REQUIRED_TOKENS 6 个", REQUIRED_TOKENS.length, 6);

// ---- 有效 manifest ----
const r0 = validateSkinManifest(qq98);
check("qq98 有效 ok", r0.ok, true);
check("qq98 无 errors", r0.errors.length, 0);
// 渐变组件无法解析 → warn（titlebar/sidebar-header 两个渐变）
check("qq98 warnings 只含渐变跳过", r0.warnings.filter((w) => !w.includes("跳过对比度自检")).length, 0);
check("qq98 渐变跳过 warn 数", r0.warnings.length, 2);

// ---- 缺必选顶层字段 ----
const r1 = validateSkinManifest({ schemaVersion: SCHEMA_VERSION });
check("缺顶层字段 fail", r1.ok, false);
check("缺顶层字段列出", r1.errors.some((e) => e.includes("bodyAttr")), true);

// ---- schemaVersion 不符 ----
const r2 = validateSkinManifest({ ...qq98, schemaVersion: 99 });
check("schemaVersion 不符 fail", r2.ok, false);
check("schemaVersion 错误信息", r2.errors.some((e) => e.includes("schemaVersion 应为 1")), true);

// ---- bodyAttr 非法 + 冲突 ----
const r3 = validateSkinManifest({ ...qq98, bodyAttr: "data-dsh_retro" });
check("bodyAttr 格式非法 fail", r3.ok, false);
const r4 = validateSkinManifest(qq98, { registeredBodyAttrs: ["data-dsh-retro"] });
check("bodyAttr 冲突 fail", r4.ok, false);
check("bodyAttr 冲突信息", r4.errors.some((e) => e.includes("已注册")), true);

// ---- palette：缺必选 token ----
const r5 = validateSkinManifest({
  ...qq98,
  palette: { ...qq98.palette, light: { ...qq98.palette.light, "label-primary": undefined } },
});
check("palette 缺必选 token fail", r5.ok, false);
check("palette 缺 token 信息", r5.errors.some((e) => e.includes("label-primary")), true);

// ---- palette：无 modes（单组）→ 必选 token 检查 + dark 缺失 warn ----
const r6 = validateSkinManifest({ ...qq98, palette: { "bg-base": "#fff", "label-primary": "#111", "label-primary-foreground": "#111", "label-secondary": "#333", "label-tertiary": "#555", "brand-primary": "#2b7cd9" } });
check("palette 无 modes 必选 token 通过", r6.errors.filter((e) => e.includes("必选 token")).length, 0);
check("palette 无 modes warn dark-first", r6.warnings.some((w) => w.includes("dark-first")), true);

// ---- 单模式皮肤（modes 权威声明，如 minecraft 无暗色覆盖）----
const r35 = validateSkinManifest({
  ...qq98,
  palette: { modes: ["light"], light: qq98.palette.light },
  checks: [{ kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" }],
});
check("单模式（modes:light）合法", r35.ok, true);
check("单模式 dark-first warn", r35.warnings.some((w) => w.includes("仅声明亮色模式")), true);
const r36 = validateSkinManifest({ ...qq98, palette: { modes: ["light", "dark"], light: qq98.palette.light } });
check("声明双模式缺 dark 组 fail", r36.ok, false);
check("声明双模式缺 dark 组信息", r36.errors.some((e) => e.includes("缺 dark 组")), true);
const r37 = validateSkinManifest({ ...qq98, palette: { modes: ["sepia"], light: qq98.palette.light } });
check("modes 未知模式 fail", r37.ok, false);

// ---- components：id 非法 / ratio 非数字 / 选择器文本混入 ----
const r7 = validateSkinManifest({ ...qq98, components: { "Bad_Id": { text: "#fff", ratio: 4.5 } } });
check("组件 id 非法 fail", r7.ok, false);
const r8 = validateSkinManifest({ ...qq98, components: { titlebar: { text: "#fff", background: "#111", ratio: "4.5" } } });
check("组件 ratio 非数字 fail", r8.ok, false);
const r9 = validateSkinManifest({ ...qq98, components: { titlebar: { text: "body[data-dsh-retro]{color:#fff}" } } });
check("组件含选择器文本 fail（作用域约束）", r9.ok, false);

// ---- 组件对比度自检（可解析颜色）----
const r10 = validateSkinManifest({
  ...qq98,
  components: { badge: { text: "#ffffff", background: "#e8e8e8", ratio: 4.5 } },
});
check("组件对比度不达标 warn", r10.warnings.some((w) => w.includes("badge 对比度")), true);
const r11 = validateSkinManifest({
  ...qq98,
  components: { badge: { text: "#ffffff", background: "#111111", ratio: 4.5 } },
});
check("组件对比度达标无 warn", r11.warnings.some((w) => w.includes("badge 对比度")), false);

// ---- settings：未知 type 降级 warn；缺 id/type fail ----
const r12 = validateSkinManifest({ ...qq98, settings: [{ id: "glow", type: "glow-effect", label: "辉光" }] });
check("settings 未知 type warn 不 fail", r12.ok, true);
check("settings 未知 type warn 信息", r12.warnings.some((w) => w.includes("glow-effect")), true);
const r13 = validateSkinManifest({ ...qq98, settings: [{ type: "color" }] });
check("settings 缺 id fail", r13.ok, false);
const r14 = validateSkinManifest({ ...qq98, settings: [{ id: "x" }] });
check("settings 缺 type fail", r14.ok, false);

// ---- settings target 双形态（spec §6 商榷定稿）----
const r23 = validateSkinManifest({ ...qq98, settings: [{ id: "a", type: "color", target: "--dsw-alias-brand-primary" }] });
check("target 字符串简写 OK", r23.ok, true);
const r24 = validateSkinManifest({ ...qq98, settings: [{ id: "a", type: "color", target: { kind: "css", var: "--dsw-alias-brand-primary" } }] });
check("target kind=css OK", r24.ok, true);
const r25 = validateSkinManifest({ ...qq98, settings: [{ id: "a", type: "color", target: { kind: "css" } }] });
check("target kind=css 缺 var fail", r25.ok, false);
const r26 = validateSkinManifest({
  ...qq98,
  settings: [{ id: "show-statusbar", type: "boolean", target: { kind: "rule", selector: "[class*=Statusbar]", on: "display:flex", off: "display:none" } }],
});
check("target kind=rule 完整 OK", r26.ok, true);
const r27 = validateSkinManifest({ ...qq98, settings: [{ id: "x", type: "boolean", target: { kind: "rule", selector: "[a]" } }] });
check("target kind=rule 缺 on/off fail", r27.ok, false);
const r28 = validateSkinManifest({ ...qq98, settings: [{ id: "x", type: "color", target: { kind: "action" } }] });
check("target 未知 kind warn 不 fail", r28.ok, true);
check("target 未知 kind warn 信息", r28.warnings.some((w) => w.includes("action")), true);

// ---- checks：未知 kind warn；contrast 不达标 warn；ref 无法解析 warn；scoped-rule ----
const r15 = validateSkinManifest({ ...qq98, checks: [{ kind: "palette-sync" }] });
check("checks 未知 kind warn 不 fail", r15.ok, true);
const r16 = validateSkinManifest({
  ...qq98,
  checks: [{ kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 99, mode: "light" }],
});
check("checks 对比度不达标 warn", r16.warnings.some((w) => w.includes("check") && w.includes("99")), true);
const r17 = validateSkinManifest({
  ...qq98,
  checks: [{ kind: "contrast", text: "ref:nonexistent", background: "ref:bg-base", minRatio: 4.5 }],
});
check("checks ref 无法解析 warn", r17.warnings.some((w) => w.includes("无法解析")), true);
const r29 = validateSkinManifest({ ...qq98, checks: [{ kind: "scoped-rule", selector: "body[data-dsh-retro] [data-pane=sidebar] > div > :first-child" }] });
check("scoped-rule 作用域内 OK", r29.ok, true);
const r30 = validateSkinManifest({ ...qq98, checks: [{ kind: "scoped-rule", selector: "[data-pane=sidebar] > div > :first-child" }] });
check("scoped-rule 作用域外 warn", r30.warnings.some((w) => w.includes("不在 bodyAttr 作用域内")), true);
const r31 = validateSkinManifest({ ...qq98, checks: [{ kind: "scoped-rule" }] });
check("scoped-rule 缺 selector fail", r31.ok, false);

// ---- 全量 token 目录：目录外键 warn；核心组件 ratio 必填；扩展组件选填 ----
const r32 = validateSkinManifest({
  ...qq98,
  palette: { ...qq98.palette, light: { ...qq98.palette.light, "future-token": "#123456" } },
});
check("palette 目录外 token warn 不 fail", r32.ok, true);
check("palette 目录外 token warn 信息", r32.warnings.some((w) => w.includes("future-token")), true);
const r33 = validateSkinManifest({ ...qq98, components: { titlebar: { text: "#fff", background: "#111" } } });
check("核心组件 titlebar 缺 ratio fail", r33.ok, false);
const r34 = validateSkinManifest({ ...qq98, components: { ...qq98.components, statusbar: { text: "#8d9bad", background: "#1a212c" } } });
check("扩展组件 statusbar 无 ratio OK", r34.ok, true);

// ---- forward-compat：未知顶层字段 warn 不 fail ----
const r18 = validateSkinManifest({ ...qq98, futureField: { x: 1 } });
check("未知顶层字段 warn 不 fail", r18.ok, true);
check("未知顶层字段 warn 信息", r18.warnings.some((w) => w.includes("futureField")), true);

// ---- wiringId（皮肤插件注册 id，交叉校验）----
const r38 = validateSkinManifest({ ...qq98, wiringId: "ui-skin-qq98" });
check("wiringId 合法 OK", r38.ok, true);
const r39 = validateSkinManifest({ ...qq98, wiringId: "ui-skin-wrong" });
check("wiringId 与 id 不对应 fail", r39.ok, false);
const r40 = validateSkinManifest({ ...qq98, wiringId: "skin-qq98" });
check("wiringId 格式非法 fail", r40.ok, false);
const r41 = validateSkinManifest(qq98);
check("wiringId 可选（缺省 OK）", r41.ok, true);

// ---- 边界：null/数组 ----
const r19 = validateSkinManifest(null);
check("manifest null fail", r19.ok, false);
const r20 = validateSkinManifest([1, 2]);
check("manifest 数组 fail", r20.ok, false);
const r21 = validateSkinManifest({ ...qq98, settings: "not-array" });
check("settings 非数组 fail", r21.ok, false);
const r22 = validateSkinManifest({ ...qq98, components: [] });
check("components 数组 fail", r22.ok, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
