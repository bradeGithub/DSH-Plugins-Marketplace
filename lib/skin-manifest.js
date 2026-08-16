// Skin Manifest 校验器（阶段 0 基座）。
//
// 规范：docs/skin-manifest-spec.md v0.1。
// 个性化资源中心的抽象上级：9 皮肤统一走 manifest 模板 + 自定义功能。
// 本模块是纯函数（无 IO），供注册流程/测试/CLI 复用。
//
// 设计要点（spec §0）：
// - 校验规则全部来自实战事故：必选 token 集（白字浅底）、双模式完整性
//   （dark-first 失效）、组件作用域约束（溢出染白）、对比度自检（小字不可读）。
// - forward-compat：未知字段/未知 settings type/未知 check kind 一律 warn 不 fail，
//   保证 schema 演进不需要改核心。

export const SCHEMA_VERSION = 1;

export const REQUIRED_TOKENS = [
  "bg-base",
  "label-primary",
  "label-primary-foreground",
  "label-secondary",
  "label-tertiary",
  "brand-primary",
];

// 全量 token 目录（92 个，实测提取自 DSH 主题——spec 附录 A）。
// 皮肤未声明的 token 继承 DSH 主题默认值；目录外键 warn（DSH 新增或拼写错误）。
export const TOKEN_DIRECTORY = new Set([
  // bg
  "bg-1", "bg-base", "bg-layer-1", "bg-layer-2", "bg-layer-3", "bg-mask-1", "bg-mask-2", "bg-mask-3",
  "bg-mask-drop", "bg-mask-photo", "bg-module-platform", "bg-multi-select", "bg-overlay", "bg-primary", "bg-skeleton",
  // border
  "border-1", "border-inverted", "border-inverted2", "border-l1", "border-l2", "border-l2-darkmode-thin",
  "border-l3", "border-l4", "border-secondary",
  // brand
  "brand-primary", "brand-primary-invert", "brand-primary-new-colorprimary-new-color", "brand-text",
  // button
  "button-contrast-fill", "button-elevated-fill", "button-floating-fill", "button-floating-hover",
  "button-ghost-active-border", "button-ghost-active-fill", "button-ghost-active-hover", "button-info-fill",
  "button-info-hover", "button-primary-dimmed", "button-primary-fill", "button-primary-hover",
  "button-tool-bar-fill", "button-tool-bar-fill-invisible", "button-tool-bar-hover",
  // fill / interactive
  "fill-l2", "fill-tsp-secondary", "interactive-bg-active", "interactive-bg-hover", "interactive-bg-hover-accent",
  "interactive-bg-hover-danger", "interactive-bg-hover-solid", "interactive-bg-primary",
  // label
  "label-caption", "label-dimmed", "label-error", "label-inverse", "label-primary", "label-primary-bluish",
  "label-primary-dimmed", "label-primary-foreground", "label-primary-inverted", "label-quaternary",
  "label-secondary", "label-tertiary",
  // line / separator
  "line-secondary", "separator-primary",
  // markdown
  "markdown-citation", "markdown-code-block", "markdown-code-block-banner", "markdown-code-segment-selected",
  "markdown-code-segment-unselected", "markdown-inline-code", "markdown-placeholder", "markdown-tag",
  // scrollbar
  "scrollbar-bg-l1", "scrollbar-bg-l2", "scrollbar-hover-l1", "scrollbar-hover-l2",
  // state
  "state-business-primary", "state-business-subtle", "state-business-tertiary", "state-error-primary",
  "state-error-secondary", "state-success-primary", "state-success-secondary", "state-success-tertiary",
  "state-warn-label", "state-warn-primary", "state-warn-secondary", "state-warn-tertiary", "state-warning-primary",
  // 其他
  "text-1", "text-3", "toast-bg", "tooltip-bg", "tooltip-fg",
]);

// 核心组件目录：预定义组件，对比度自检强约束（ratio 必填）。
export const CORE_COMPONENTS = new Set(["titlebar", "sidebar-header"]);

export const SETTINGS_TYPES = new Set([
  "color", "slider", "select", "boolean", "text", "font", "image",
]);

const REQUIRED_TOP_LEVEL = [
  "schemaVersion", "id", "name", "author", "accent", "bodyAttr", "package", "palette",
];

const KNOWN_FIELDS = new Set([
  ...REQUIRED_TOP_LEVEL,
  "tagline", "description", "order", "tags", "extends", "wiringId",
  "components", "chrome", "settings", "checks",
]);

const MODES = ["light", "dark"];

/** 解析颜色：hex(#rgb/#rgba/#rrggbb/#rrggbbaa) / rgb() / rgba()；
 * 渐变与 var() 引用返回 null（跳过对比度自检）。带 alpha 的 hex 取 RGB 部分
 * （对比度按不透明底近似——插画类皮肤的 #ffffff73 等 8 位值实测暴露）。 */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    if (hex.length < 6) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null; // 渐变/var()/未知格式——无法计算对比度
}

/** WCAG 相对亮度（0-1）。 */
export function relativeLuminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度（1-21）。 */
export function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 解析 ref: 引用（ref:label-primary → palette 当前模式 token；ref:titlebar.text → 组件字段）。 */
function resolveRef(ref, manifest, mode) {
  if (typeof ref !== "string" || !ref.startsWith("ref:")) return null;
  const path = ref.slice(4).split(".");
  const first = path[0];
  if (manifest.palette?.[mode]?.[first] !== undefined) return parseColor(manifest.palette[mode][first]);
  if (manifest.palette?.[first] !== undefined) return parseColor(manifest.palette[first]);
  if (manifest.components?.[first] !== undefined && path[1]) {
    return parseColor(manifest.components[first][path[1]]);
  }
  return null;
}

/**
 * 校验一个皮肤 manifest。
 * @param {object} manifest - 皮肤 manifest（spec §1 顶层结构）。
 * @param {object} [opts] - { registeredBodyAttrs: string[] } 已注册皮肤 bodyAttr 列表。
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateSkinManifest(manifest, opts = {}) {
  const errors = [];
  const warnings = [];

  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest 必须是非数组对象"], warnings: [] };
  }

  // ---- 顶层必填字段 ----
  for (const f of REQUIRED_TOP_LEVEL) {
    if (manifest[f] == null || manifest[f] === "") errors.push(`必填字段缺失: ${f}`);
  }

  // ---- schemaVersion ----
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 应为 ${SCHEMA_VERSION}（当前 ${manifest.schemaVersion}）`);
  }

  // ---- bodyAttr 规范与唯一性 ----
  if (manifest.bodyAttr) {
    if (!/^data-dsh-[a-z0-9-]+$/.test(manifest.bodyAttr)) {
      errors.push(`bodyAttr 格式非法: ${manifest.bodyAttr}（应为 data-dsh-<slug>）`);
    }
    if (opts.registeredBodyAttrs?.includes(manifest.bodyAttr)) {
      errors.push(`bodyAttr 冲突（已注册）: ${manifest.bodyAttr}`);
    }
  }

  // ---- wiringId（插件注册 id，skin.json wiring.id 原文；交叉校验用）----
  if (manifest.wiringId != null) {
    if (typeof manifest.wiringId !== "string" || !/^ui-skin-[a-z0-9-]+$/.test(manifest.wiringId)) {
      errors.push(`wiringId 格式非法: ${manifest.wiringId}（应为 ui-skin-<id>）`);
    }
    if (manifest.id && manifest.wiringId !== `ui-skin-${manifest.id}`) {
      errors.push(`wiringId 与 id 不对应: ${manifest.wiringId}（应为 ui-skin-${manifest.id}）`);
    }
  }

  // ---- palette：必选 token 集 + 模式完整性 ----
  // modes 数组是权威声明：声明了哪些模式就检查哪些（单模式皮肤合法——
  // minecraft 等无暗色覆盖的皮肤用 modes:["light"] 诚实表达，避免硬凑 dark 组）。
  const palette = manifest.palette;
  if (palette && typeof palette === "object") {
    if (Array.isArray(palette.modes)) {
      for (const mode of palette.modes) {
        if (!MODES.includes(mode)) errors.push(`palette.modes 含未知模式: ${mode}`);
      }
      for (const mode of palette.modes) {
        if (palette[mode] == null || typeof palette[mode] !== "object") {
          errors.push(`palette 声明 modes 但缺 ${mode} 组`);
          continue;
        }
        for (const token of REQUIRED_TOKENS) {
          if (palette[mode][token] == null) {
            errors.push(`palette.${mode} 缺必选 token: ${token}`);
          }
        }
        // 目录外键 warn（DSH 新增 token 或拼写错误；forward-compat）
        for (const key of Object.keys(palette[mode])) {
          if (!TOKEN_DIRECTORY.has(key)) warnings.push(`palette.${mode} 含目录外 token: ${key}（DSH 新增或拼写错误？）`);
        }
      }
      // 声明了 modes 但只覆盖部分模式时，未声明模式的暗色继承 DSH 默认——提示（dark-first 风险）
      if (palette.modes.length === 1 && palette.modes[0] === "light") {
        warnings.push("palette 仅声明亮色模式——暗色继承 DSH 默认，dark-first 失效风险需人工确认");
      }
    } else {
      for (const token of REQUIRED_TOKENS) {
        if (palette[token] == null) errors.push(`palette 缺必选 token: ${token}`);
      }
      for (const key of Object.keys(palette)) {
        if (key !== "modes" && !TOKEN_DIRECTORY.has(key)) {
          warnings.push(`palette 含目录外 token: ${key}（DSH 新增或拼写错误？）`);
        }
      }
      warnings.push("palette 未声明 modes——按亮色单组解释；dark 缺失可能 dark-first 失效");
    }
  } else if (!errors.includes("必填字段缺失: palette")) {
    errors.push("palette 必须是非数组对象");
  }

  // ---- components：id 规范 + ratio 数值 + 对比度自检 ----
  if (manifest.components) {
    if (typeof manifest.components !== "object" || Array.isArray(manifest.components)) {
      errors.push("components 必须是非数组对象");
    } else {
      for (const [id, comp] of Object.entries(manifest.components)) {
        if (!/^[a-z0-9-]+$/.test(id)) errors.push(`组件 id 非法: ${id}（应为 kebab-case）`);
        if (comp == null || typeof comp !== "object") {
          errors.push(`组件 ${id} 必须是非数组对象`);
          continue;
        }
        // 核心组件：ratio 必填（强约束自检）
        if (CORE_COMPONENTS.has(id) && comp.ratio == null) {
          errors.push(`核心组件 ${id} 缺 ratio（必填——对比度自检强约束）`);
        }
        if (comp.ratio != null && typeof comp.ratio !== "number") {
          errors.push(`组件 ${id} 的 ratio 必须是数字`);
        }
        // 作用域约束（spec §3）：组件样式是声明式值（禁止选择器文本混入）
        for (const [key, value] of Object.entries(comp)) {
          if (typeof value === "string" && /[{}]/.test(value)) {
            errors.push(`组件 ${id} 的 ${key} 含选择器/声明块文本——样式必须为简单 CSS 值（作用域由生成器限定在 bodyAttr 内）`);
          }
        }
        // 对比度自检
        const text = parseColor(comp.text);
        const bg = parseColor(comp.background);
        if (text && bg) {
          const ratio = contrastRatio(text, bg);
          if (comp.ratio != null && ratio < comp.ratio) {
            warnings.push(`组件 ${id} 对比度 ${ratio.toFixed(2)}:1 < 声明目标 ${comp.ratio}:1`);
          }
        } else if (comp.ratio != null) {
          warnings.push(`组件 ${id} 颜色无法解析（渐变/var()），跳过对比度自检`);
        }
      }
    }
  }

  // ---- settings：id/type + 未知 type 降级（forward-compat）----
  if (manifest.settings) {
    if (!Array.isArray(manifest.settings)) {
      errors.push("settings 必须是数组");
    } else {
      for (const s of manifest.settings) {
        if (s == null || typeof s !== "object") {
          errors.push("settings 项必须是非数组对象");
          continue;
        }
        if (!s.id || typeof s.id !== "string") errors.push("settings 项缺 id");
        if (!s.type || typeof s.type !== "string") errors.push(`settings ${s.id ?? "?"} 缺 type`);
        else if (!SETTINGS_TYPES.has(s.type)) {
          warnings.push(`settings ${s.id} type=${s.type} 未知——渲染器降级为 text 输入（forward-compat）`);
        }
        // target 双形态（spec §6）：css 变量（字符串简写或 {kind:"css",var}）/
        // rule 动作（{kind:"rule",selector,on,off}）；未知形态 warn 降级
        if (s.target != null) {
          if (typeof s.target === "string") {
            // 简写 = CSS 变量名
          } else if (s.target && typeof s.target === "object" && !Array.isArray(s.target)) {
            if (s.target.kind === "css") {
              if (!s.target.var || typeof s.target.var !== "string") {
                errors.push(`settings ${s.id} target.kind=css 缺 var`);
              }
            } else if (s.target.kind === "rule") {
              if (!s.target.selector || !s.target.on || !s.target.off) {
                errors.push(`settings ${s.id} target.kind=rule 缺 selector/on/off`);
              }
            } else {
              warnings.push(`settings ${s.id} target.kind=${s.target.kind} 未知——按 css 变量处理（forward-compat）`);
            }
          } else {
            errors.push(`settings ${s.id} target 必须是非数组对象或字符串`);
          }
        }
      }
    }
  }

  // ---- checks：声明式自检，未知 kind warn 跳过 ----
  if (manifest.checks) {
    if (!Array.isArray(manifest.checks)) {
      errors.push("checks 必须是数组");
    } else {
      for (const c of manifest.checks) {
        if (c == null || typeof c !== "object") {
          errors.push("checks 项必须是非数组对象");
          continue;
        }
        if (!c.kind) {
          errors.push("check 缺 kind");
          continue;
        }
        if (c.kind === "contrast") {
          const mode = c.mode && MODES.includes(c.mode) ? c.mode : "light";
          const text = resolveRef(c.text, manifest, mode);
          const bg = resolveRef(c.background, manifest, mode);
          if (text && bg) {
            const ratio = contrastRatio(text, bg);
            if (c.minRatio != null && ratio < c.minRatio) {
              warnings.push(`check ${c.text} vs ${c.background}（${mode}）对比度 ${ratio.toFixed(2)}:1 < ${c.minRatio}:1`);
            }
          } else {
            warnings.push(`check ${c.text} vs ${c.background} 无法解析——跳过`);
          }
        } else if (c.kind === "scoped-rule") {
          // 机制级防溢出：CSS 规则选择器必须在 body[data-dsh-<bodyAttr>] 作用域内
          if (!c.selector || typeof c.selector !== "string") {
            errors.push("scoped-rule check 缺 selector");
          } else if (manifest.bodyAttr && !c.selector.includes(`body[data-dsh-${manifest.bodyAttr.replace(/^data-dsh-/, "")}]`) && !c.selector.includes(manifest.bodyAttr)) {
            warnings.push(`scoped-rule check 选择器不在 bodyAttr 作用域内: ${c.selector}`);
          }
        } else {
          warnings.push(`check kind=${c.kind} 未知——跳过（forward-compat）`);
        }
      }
    }
  }

  // ---- forward-compat：未知顶层字段 warn ----
  for (const key of Object.keys(manifest)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`未知字段 ${key}——忽略（forward-compat）`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
