#!/usr/bin/env node
// Skin Manifest 自动生成器（阶段 1 迁移核心工具）：
// 皮肤配置 + 皮肤包 bundle → 提取 palette（亮/暗双模式）→ 自动修复规则
// → 组装 manifest → 校验器验证 → 输出。
//
// 自动化原则（商榷定稿）：提取/修正/验证全自动，不依赖人工校对——
// 提取忠实反映 bundle；修正规则固化已知修复（如 fg 重绑——市场侧兜底
// 的修复逻辑下沉到生成器）；不达标项由校验器 warn 暴露（人工只审 warn 报告）。
//
// 命名对齐原则（用户要求）：皮肤元数据（name/tagline/description/author/tags/
// accent/bodyAttr/package）必须与上游皮肤包 skin.json 原文一致，不得自造；
// order 取自 skin-center 映射表（展示顺序）；components/checks 为实测补充。
//
// 用法：node scripts/build-skin-manifest.mjs <skinId> <bundleDir>
//       node scripts/build-skin-manifest.mjs --all <bundleDir>   # 全部配置皮肤

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSkinPalette } from "./extract-skin-palette.mjs";
import { validateSkinManifest } from "../lib/skin-manifest.js";

export const SCHEMA_VERSION = 1;

/** 皮肤元数据配置（9 皮肤；bundlePath 相对部署 bundle 目录）。
 * 元数据与上游 skin.json 原文一致（author/tagline/description/tags 全量对齐）；
 * components/checks 为实测补充（skins-manifest-record.md 基线）。 */
export const SKIN_CONFIGS = [
  {
    id: "qq98",
    wiringId: "ui-skin-qq98",
    name: "QQ2008 Retro",
    author: "dsh-web-ui",
    tagline: "水晶蓝桌面 · 玻璃深蓝标题栏 · 戴围巾企鹅",
    description: "dsh web ui 家族收录的第一个皮肤：QQ2008 水晶蓝年代。深蓝渐变桌面、玻璃质感标题栏、浅蓝状态栏和圆角高光控件，配一只戴围巾的企鹅。",
    accent: "#2b7cd9",
    bodyAttr: "data-dsh-retro",
    package: "@linxin666/dsh-client-ui-skin-qq98",
    order: 1,
    tags: ["retro", "qq", "2008", "crystal-blue", "nostalgia"],
    bundlePath: "qq98/lib/client.js",
    components: {
      titlebar: {
        text: "#ffffff",
        background: "linear-gradient(90deg,#1a56a6 0%,#2b7cd9 55%,#4a9ae8 100%)",
        ratio: 4.5,
      },
      "sidebar-header": {
        text: "#ffffff",
        background: "linear-gradient(#1a56a6,#2b7cd9)",
        ratio: 7,
      },
    },
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
      { kind: "scoped-rule", selector: "body[data-dsh-retro] [data-pane=sidebar] > div > :first-child" },
    ],
  },
  {
    id: "ths",
    wiringId: "ui-skin-ths",
    name: "Tonghuashun Trading",
    author: "dsh-web-ui",
    tagline: "品牌红标题栏 · 实时行情状态栏 · 灰蓝数据终端",
    description: "同花顺风格炒股主题：品牌红标题栏带上证指数行情签，状态栏红涨绿跌，自选股风格的侧边栏和交易终端面板，写代码也像盯盘。",
    accent: "#e60012",
    bodyAttr: "data-dsh-ths",
    package: "@linxin666/dsh-client-ui-skin-ths",
    order: 2,
    tags: ["stock", "trading", "terminal", "red"],
    bundlePath: "ths/lib/client.js",
    components: {
      // 实测品牌红底白字 5.38:1（record）；纯色可被校验器解析自检
      titlebar: { text: "#ffffff", background: "#e60012", ratio: 4.5 },
      "sidebar-header": { text: "#ffffff", background: "#253348", ratio: 4.5 },
    },
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
      { kind: "scoped-rule", selector: "body[data-dsh-ths] [data-pane=sidebar] > div > :first-child" },
    ],
  },
  {
    id: "xp",
    wiringId: "ui-skin-xp",
    name: "Windows XP Luna",
    author: "dsh-web-ui",
    tagline: "Luna 蓝窗口条 · 绿色开始按钮 · Bliss 蓝天桌面",
    description: "Windows XP (Luna) 复古主题：蓝色渐变窗口条带窗口按钮、米色状态栏（大写/数字/滚动指示灯）、侧边栏任务栏上的绿色「开始」按钮、资源管理器风格树行和 Bliss 蓝天桌面，全局直角。",
    accent: "#316ac5",
    bodyAttr: "data-dsh-xp",
    package: "@linxin666/dsh-client-ui-skin-xp",
    order: 3,
    tags: ["retro", "xp", "luna", "windows", "start-button"],
    bundlePath: "xp/lib/client.js",
    components: {
      // 实测深蓝底白字 4.74:1（record）；sidebar-header 纯色近似 #2c66b8 为 5.68:1
      titlebar: { text: "#ffffff", background: "#1a6fd0", ratio: 4.5 },
      "sidebar-header": { text: "#ffffff", background: "#2c66b8", ratio: 4.5 },
    },
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
      { kind: "scoped-rule", selector: "body[data-dsh-xp] [data-pane=sidebar] > div > :first-child" },
    ],
  },
  {
    id: "miku",
    wiringId: "ui-skin-miku",
    name: "Hatsune Miku",
    author: "涂山苏苏",
    tagline: "蓝紫双马尾 · 01 编号 · 音符波形 · 电子歌姬主题",
    description: "以世界第一的虚拟歌姬初音未来为灵感的主题皮肤：蓝紫洋红渐变贯穿全局，音符与声波曲线点缀在半透明面板之间，标题栏与状态栏带有 01 编号徽标与音乐波形，半透明毛玻璃面板透出背景图——沉浸式电子歌姬氛围。",
    accent: "#2e9bff",
    bodyAttr: "data-dsh-miku",
    package: "@linxin666/dsh-client-ui-skin-miku",
    order: 9,
    tags: ["miku", "vocaloid", "blue", "music", "idol", "waveform"],
    bundlePath: "miku/lib/client.js",
    components: {
      // 修复后文字重绑 label-primary（record：标题栏/侧栏浅彩虹底）；渐变背景无法解析 → 自检跳过（warn 预期）
      titlebar: { text: "var(--dsw-alias-label-primary)", background: "linear-gradient(90deg,#2e9bff33 0%,#ff4da633 100%)", ratio: 4.5 },
      "sidebar-header": { text: "var(--dsw-alias-label-primary)", background: "linear-gradient(#2e9bff26,#ff4da626)", ratio: 4.5 },
    },
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
      { kind: "scoped-rule", selector: "body[data-dsh-miku] [data-pane=sidebar] > div > :first-child" },
    ],
  },
  {
    id: "blue-fantasy",
    wiringId: "ui-skin-blue-fantasy",
    name: "Blue Fantasy",
    author: "powerdog996（DreamSkin 社区）· dsh-web-ui 适配",
    tagline: "鲸鱼插画背景 · periwinkle 靛蓝调色板 · 半透明面板",
    description: "DreamSkin「DeepSeek-鲸鱼娘」Codex 桌面主题的 dsh 适配：鲸鱼插画背景垫在半透明面板之下，遮罩随亮/暗主题实时切换，periwinkle 靛蓝色调重映射到全部 dsh token。",
    accent: "#4a5fa8",
    bodyAttr: "data-dsh-blue-fantasy",
    package: "@linxin666/dsh-client-ui-skin-blue-fantasy",
    order: 4,
    tags: ["dreamskin", "whale", "indigo", "art", "translucent"],
    bundlePath: "blue-fantasy/lib/client.js",
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
    ],
  },
  {
    id: "dragon-heir",
    wiringId: "ui-skin-dragon-heir",
    name: "Dragon Heir",
    author: "dsh-web-ui",
    tagline: "不屈龙魂 · 万里长城双主题 · 朱砂龙印",
    description: "龙的传人 — 一面是不屈龙魂（墨龙穿云、朱砂印章、不屈锋芒），一面是万里长城（青黛山色、金晖镀墙、苍茫暮色）。亮暗主题各自配一幅画与一枚龙印 favicon，面板半透明磨砂，让画透出来。",
    accent: "#c3272b",
    bodyAttr: "data-dsh-dragon-heir",
    package: "@linxin666/dsh-client-ui-skin-dragon-heir",
    order: 5,
    tags: ["dragon", "loong", "chinese", "ink-wash", "great-wall", "dual-theme"],
    bundlePath: "dragon-heir/lib/client.js",
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
    ],
  },
  {
    id: "minecraft",
    wiringId: "ui-skin-minecraft",
    name: "Minecraft Voxel",
    author: "dsh-web-ui",
    tagline: "动态全景天空盒 · 方块按钮 · 告示牌输入框",
    description: "复刻《我的世界》主界面氛围的方块皮肤：程序化绘制的像素全景天空盒（方块山、像素云、方块树、草方块地面）在身后缓慢旋转，界面浮在石板上；按钮还原 MC 菜单按钮（灰石板、悬停变黄、按下下沉），输入框做成带钉子的木告示牌。",
    accent: "#7cbd4b",
    bodyAttr: "data-dsh-minecraft",
    package: "@linxin666/dsh-client-ui-skin-minecraft",
    order: 6,
    tags: ["minecraft", "voxel", "pixel", "game", "panorama", "skybox"],
    bundlePath: "minecraft/lib/client.js",
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
    ],
  },
  {
    id: "whale-song",
    wiringId: "ui-skin-whale-song",
    name: "Whale Song",
    author: "dsh-web-ui",
    tagline: "深海鲸语女神背景 · 冰蓝海洋调色板 · 金色细线点缀",
    description: "《鲸吟》— 深海鲸语女神主题：无文字纯氛围背景画（蓝发女神与鲸群居左、冰蓝星座网格与金线点缀、右侧大量留白）垫在半透明面板之下，遮罩随亮/暗主题实时切换，冰蓝/浅青/深海军蓝/钴蓝冷色体系重映射到全部 dsh token，暗色变体为深海夜航调。",
    accent: "#4d8fd4",
    bodyAttr: "data-dsh-whale-song",
    package: "@linxin666/dsh-client-ui-skin-whale-song",
    order: 7,
    tags: ["whale", "ocean", "ice-blue", "goddess", "art", "translucent"],
    bundlePath: "whale-song/lib/client.js",
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
    ],
  },
  {
    id: "harbor",
    wiringId: "ui-skin-harbor",
    name: "Harbor",
    author: "moeblack",
    tagline: "暮光蓝港 · 日落橙辉 · 半透明夜色面板",
    description: "《夕港》黄昏港口主题：动漫少女黄昏港口背景（暮光蓝天空渐入日落橙）垫在半透明面板之下，遮罩随亮/暗主题实时切换，深暮蓝 #141a2e 底与日落橙 #ff9d5c 主色重映射到 dsh token，亮色是薄暮纱、暗色是深海夜航纱，同一幅画两种读法。",
    accent: "#ff9d5c",
    bodyAttr: "data-dsh-harbor",
    package: "@linxin666/dsh-client-ui-skin-harbor",
    order: 3,
    tags: ["harbor", "dusk", "twilight", "sunset", "amber", "art", "translucent"],
    bundlePath: "harbor/lib/client.js",
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
    ],
  },
  {
    id: "trading",
    wiringId: "ui-skin-trading",
    name: "Trading Terminal",
    author: "dsh-web-ui",
    tagline: "实时行情跑马灯 · 长桥港美股行情 · 红涨绿跌交易终端",
    description: "结合 dsh-fun-ticker 行情跑马灯与 dsh-longbridge 港美股行情的炒股皮肤：顶栏滚动 A股/港股/美股/指数/加密/外汇报价（装 fun-ticker 后跟随你的自选列表），状态栏展示长桥行情快照与 A股/港股/美股交易时段，写代码也像盯盘。",
    accent: "#f23645",
    bodyAttr: "data-dsh-trading",
    package: "@linxin666/dsh-client-ui-skin-trading",
    order: 8,
    tags: ["stock", "trading", "ticker", "live", "terminal", "longbridge"],
    bundlePath: "trading/lib/client.js",
    components: {
      // 源码变量解析（--dsh-trd-*）：亮色 titlebar = 浅渐变 #fff→#f2f5f8 + 深字 #1b2431
      // （品牌红 #f23645 只是 accent 点缀非背景——曾误配白字红底，源码解析纠正）；
      // 纯色近似 #f2f5f8 可被校验器解析自检
      titlebar: { text: "#1b2431", background: "#f2f5f8", ratio: 4.5 },
    },
    checks: [
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" },
      { kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "dark" },
    ],
  },
];

/** 颜色亮度（0-1，WCAG 相对亮度）。 */
function luminanceOf(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const [r, g, b] = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * 自动修复规则（固化市场侧兜底修复，商榷定稿：修复逻辑下沉到生成器）：
 * - fg 重绑：亮色模式下 label-primary-foreground 为 #fff 且 bg-base 是浅色
 *   （亮度 > 0.8）→ 修正为 label-primary（白字浅底 bug 的机制级修复）。
 *   暗色模式 fg=#fff 配深底是正常设计，不修。
 */
export function applyFixups(palette) {
  const light = { ...palette.light };
  const dark = { ...palette.dark };
  const lightBgLum = luminanceOf(light["bg-base"]);
  if (
    light["label-primary-foreground"]?.trim().toLowerCase() === "#fff" &&
    lightBgLum !== null && lightBgLum > 0.8 &&
    light["label-primary"] != null
  ) {
    light["label-primary-foreground"] = light["label-primary"];
  }
  return { light, dark };
}

/** 组装 manifest（提取 + 修复 + 结构组装）。
 * 暗色提取为空（皮肤无暗色覆盖规则——如 minecraft）→ 只声明亮色模式
 * （modes 权威声明，校验器不再硬凑 dark 组）且剔除 mode:"dark" 的 checks；
 * 暗色有覆盖 → 双模式。 */
export function buildManifest(skinConfig, bundleSrc) {
  const raw = extractSkinPalette(bundleSrc, skinConfig.bodyAttr);
  const palette = applyFixups(raw);
  const hasDark = Object.keys(palette.dark).length > 0;
  const checks = hasDark
    ? skinConfig.checks
    : (skinConfig.checks ?? []).filter((c) => !(c.kind === "contrast" && c.mode === "dark"));
  return {
    schemaVersion: SCHEMA_VERSION,
    id: skinConfig.id,
    wiringId: skinConfig.wiringId,
    name: skinConfig.name,
    author: skinConfig.author,
    tagline: skinConfig.tagline,
    description: skinConfig.description,
    accent: skinConfig.accent,
    bodyAttr: skinConfig.bodyAttr,
    package: skinConfig.package,
    order: skinConfig.order,
    tags: skinConfig.tags,
    palette: hasDark
      ? { modes: ["light", "dark"], light: palette.light, dark: palette.dark }
      : { modes: ["light"], light: palette.light },
    components: skinConfig.components,
    checks,
  };
}

/** 生成 + 校验。返回 { manifest, result }。 */
export function buildAndValidate(skinConfig, bundleSrc) {
  const manifest = buildManifest(skinConfig, bundleSrc);
  return { manifest, result: validateSkinManifest(manifest) };
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href.replace(/^file:\/\/\//, "file:///")) {
  const [mode, arg] = process.argv.slice(2);
  if (!mode || !arg) {
    console.error("用法: node scripts/build-skin-manifest.mjs <skinId> <bundleDir>");
    console.error("      node scripts/build-skin-manifest.mjs --all <bundleDir>");
    process.exit(2);
  }
  const run = (config, bundleDir) => {
    const path = join(bundleDir, config.bundlePath);
    if (!existsSync(path)) {
      console.error(`[skip] ${config.id}: bundle 不存在 ${path}`);
      return null;
    }
    const { manifest, result } = buildAndValidate(config, readFileSync(path, "utf8"));
    const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "tests", "fixtures");
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `${config.id}.manifest.json`);
    writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
    if (!result.ok) {
      console.error(`[FAIL] ${config.id}: ${result.errors.length} errors`);
      for (const e of result.errors) console.error(`  [FAIL] ${e}`);
    } else {
      console.log(`[OK] ${config.id} -> ${out}（${result.warnings.length} warnings）`);
    }
    for (const w of result.warnings) console.warn(`  [warn] ${w}`);
    return result.ok;
  };

  if (mode === "--all") {
    let allOk = true;
    for (const config of SKIN_CONFIGS) {
      const ok = run(config, arg);
      if (ok === false) allOk = false;
    }
    process.exit(allOk ? 0 : 1);
  } else {
    const config = SKIN_CONFIGS.find((c) => c.id === mode);
    if (!config) {
      console.error(`未知皮肤 id: ${mode}`);
      process.exit(2);
    }
    const ok = run(config, arg);
    process.exit(ok ? 0 : 1);
  }
}
