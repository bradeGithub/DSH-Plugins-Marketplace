# Skin Manifest Schema（皮肤模板规范）v0.1

> 个性化资源中心的抽象基座：9 个皮肤统一走抽象模板 + 自定义功能（见 `skins-manifest-record.md` 的抽取基线、`skin-manifest-app-layer.md` 的应用层消费）。
> 本规范是**契约**：皮肤作者按此声明皮肤，校验器按此执行检查，自定义面板按此生成表单。

<!-- TOC -->
- [0. 设计原则（为什么这样设计）](#0-设计原则为什么这样设计)
- [1. 顶层结构](#1-顶层结构)
- [2. palette（语义 token 覆盖）——必填契约](#2-palette语义-token-覆盖必填契约)
- [3. components（组件声明）——选填](#3-components组件声明选填)
- [4. chrome（注入资源）——选填](#4-chrome注入资源选填)
- [5. 校验规则（校验器执行）](#5-校验规则校验器执行)
  - [5.1 必选检查（fail）](#51-必选检查fail)
  - [5.2 对比度自检（warn 或 fail，按 checks 声明）](#52-对比度自检warn-或-fail按-checks-声明)
  - [5.3 checks（皮肤作者声明式自检）](#53-checks皮肤作者声明式自检)
- [6. settings（自定义项）——选填](#6-settings自定义项选填)
- [7. 演进机制（后续扩充的操作手册）](#7-演进机制后续扩充的操作手册)
- [8. 应用层（manifest 消费流程）](#8-应用层manifest-消费流程)
  - [8.1 五层渲染管线](#81-五层渲染管线)
  - [8.2 注册流程（manifest 分发与注册）](#82-注册流程manifest-分发与注册)
  - [8.3 试穿/应用流程](#83-试穿应用流程)
  - [8.4 自定义面板（阶段 2）](#84-自定义面板阶段-2)
  - [8.5 入口定位](#85-入口定位)
  - [8.6 所有权与仓库结构](#86-所有权与仓库结构)
- [9. 文档状态](#9-文档状态)
- [附录 A：全量 token 目录（95 个，实测提取自 DSH 主题，2026-08-15）](#附录-a全量-token-目录95-个实测提取自-dsh-主题2026-08-15)
<!-- /TOC -->

## 0. 设计原则（为什么这样设计）

1. **token 分层消费，不发明新抽象**：DSH 已有语义 token 层 `--dsw-alias-*`（全局定义）。皮肤 manifest 只做三件事——覆盖语义 token、声明组件（可选）、声明 chrome 资源（可选）。**不创建第四个抽象面**。
2. **扁平不继承**：9 个皮肤共性只在 token 契约层（桌面/终端/系统/二次元/插画差异大于共性），继承树徒增耦合。`extends` 字段位预留但不实现——真需要时由 schemaVersion 机制引入。**模板复用 = 公共组件样式目录 + 皮肤按组件 id 引用**（按视觉家族共享 titlebar/statusbar 样式片段），不做结构继承。**official（官方默认）不是皮肤**——是主题基态，不参与 manifest schema（走"还原默认"逻辑）。
3. **演进靠机制不靠运气**：三个内建机制保证"后续扩充方便"：
   - **schemaVersion**：manifest 声明所遵循的 schema 版本；校验器按版本解释。加字段 = 升版本，旧皮肤（旧版本声明）不受影响。
   - **forward-compat**：校验器对未知字段 **warn 不 fail**；渲染器对未知 settings type **降级为 text 输入**。新字段/新类型不需要改核心。
   - **type 分发**：settings 渲染器按 `type` 字符串分发，新类型 = 新增一个渲染器注册。
4. **校验规则来自实战事故**：本 schema 的每条校验规则都对应一次真实事故（白字浅底、溢出染白、dark-first 失效），见 §5。

## 1. 顶层结构

```jsonc
{
  "schemaVersion": 1,          // 必填：本 manifest 遵循的 schema 版本
  "id": "qq98",                // 必填：唯一 id（skin-center 条目 id 一致）
  "name": "QQ2008 Retro",        // 必填：UI 显示名（皮肤中心显示原文——英文 nameEn，与上游一致）
  "author": "dsh-web-ui",      // 必填
  "tagline": { "zh": "...", "en": "..." },   // 选填
  "description": { "zh": "...", "en": "..." }, // 选填
  "accent": "#2b7cd9",         // 必填：品牌强调色（皮肤中心卡片/试穿预览用）
  "bodyAttr": "data-dsh-retro",// 必填：激活时 body 上挂的属性名
  "package": "@linxin666/dsh-client-ui-skin-qq98",  // 必填：bundle 包名
  "wiringId": "ui-skin-qq98",  // 选填：插件注册 id（skin.json wiring.id 原文）；注册层交叉校验 package↔wiringId 防映射错误
  "order": 1,                  // 选填：皮肤中心展示顺序
  "tags": ["retro", "qq"],     // 选填：搜索/分组
  "extends": null,             // 预留：模板继承（v0.1 不实现，schemaVersion 机制引入）
  "palette": { ... },          // 必填：语义 token 覆盖（§2）
  "components": { ... },       // 选填：组件声明（§3）
  "chrome": [ ... ],           // 选填：注入资源引用（§4）
  "settings": [ ... ],         // 选填：暴露给用户的自定义项（§6）
  "checks": [ ... ]            // 选填：额外自检声明（§5.3）
}
```

## 2. palette（语义 token 覆盖）——必填契约

键 = DSH 语义 token 名（`--dsw-alias-` 前缀省略，值 = 完整 CSS 值，可直接是 `var(--dsw-...)` 引用）。

**全量 token 目录（92 个，实测提取自 DSH 主题）**：见附录 A。皮肤只覆盖差异——**未声明的 token = DSH 主题默认值**（不硬编码默认值，跟随 DSH 主题演进）。全量目录防"增量麻烦"：加 token = 目录加一行，旧皮肤自动继承默认。

**核心必选 token 集**（校验器强制——缺一个即 fail；这 6 个是市场面板与 DSH 原生 UI 实际消费面，也是白字浅底类事故的高发面）：

| token | 含义 | 典型事故 |
|---|---|---|
| `bg-base` | 页面底色 | trading root #fff 白底 |
| `label-primary` | 主文字色 | 设置面板正文 |
| `label-primary-foreground` | 主文字前景（按钮/反色区） | **#fff 配浅 bg-layer → 白字浅底** |
| `label-secondary` | 次文字色 | .dshm-dim 提升目标 |
| `label-tertiary` | 弱文字色 | 小字不可读（2.2-3.4:1） |
| `brand-primary` | 品牌/强调色 | 按钮填充 |

**使用必声明**（校验器强制）：components/checks 中引用的 token 必须在 palette 中声明（防隐性覆盖——改了文字色但漏背景）。

**目录外 token**（校验器 warn 不 fail）：palette 出现目录外的键 = DSH 新增 token 或拼写错误——warn 提示（forward-compat）。

**模式完整性**（校验器强制）：light/dark 双模式 token 值都必须提供（`palette.light` / `palette.dark` 两组，或单组 + `modes: ["light","dark"]` 声明差异项）——防止 dark-first 失效类事故。

```jsonc
"palette": {
  "modes": ["light", "dark"],
  "light": {
    "bg-base": "#ffffff",
    "label-primary": "#17293c",
    "label-primary-foreground": "#17293c",
    "label-secondary": "#3d566e",
    "label-tertiary": "#5f7890",
    "brand-primary": "#2b7cd9"
  },
  "dark": { ... }
}
```

## 3. components（组件声明）——选填

**核心组件目录（预定义）**：`titlebar` / `sidebar-header` —— 享受对比度自检强约束（`ratio` 必填，缺失即 fail）。**扩展组件**：任意 kebab-case id（如 statusbar / explorer-header / start-button），`ratio` 选填。核心目录保证高发区域（标题栏/侧栏头部）必有自检，扩展组件保持自由。

```jsonc
"components": {
  "titlebar": {                    // 核心组件：ratio 必填
    "text": "#ffffff",
    "background": "linear-gradient(90deg,#1a56a6 0%,#2b7cd9 55%,#4a9ae8 100%)",
    "ratio": 4.5
  },
  "sidebar-header": {              // 核心组件：ratio 必填
    "text": "#ffffff",
    "background": "linear-gradient(#1a56a6,#2b7cd9)",
    "ratio": 7
  },
  "statusbar": {                   // 扩展组件：ratio 选填
    "text": "#8d9bad",
    "background": "#1a212c"
  }
}
```

**作用域约束**（校验器强制）：组件样式规则必须限定在 `body[data-dsh-<bodyAttr>]` 作用域内——**防溢出事故**（qq98/xp 的 `[data-pane=sidebar]>div>:first-child *{color:#fff}` 通配规则溢出染白设置面板 overlay，即违反此条）。组件值是声明式（无选择器文本），生成 CSS 时由生成器强制作用域；生成结果由 `checks` 的 `scoped-rule` 复核（§5.3）。

## 4. chrome（注入资源）——选填

皮肤包 bundle 导出的 DOM 资源（标题栏/状态栏/开始按钮等）。manifest 只声明**引用**，资源本体在 **bundle 内函数**（沿用现状试穿机制的 bundle 函数产出 DOM，不引入新分发管道）。

**分发协议（商榷定稿）**：皮肤 bundle 导出 `{ apply, manifest }`——manifest 是 **bundle 内静态常量**（非动态生成函数）：校验器/CLI/注册流程**无需执行 bundle 即可读**（静态 JSON 解析），不引入执行期风险。skin-center 现有 `loadBundleScript → import` 流程在 import 后读取 manifest 字段即可。

**注入器已落地**（`scripts/inject-skin-manifest.mjs`）：生成器（build-skin-manifest.mjs）是 manifest 唯一权威源，注入器把生成结果写入 bundle——`exports.manifest = <JSON 常量>;`，幂等（已存在整段替换）、括号配平回读、无锚点 bundle 拒绝动（返回 null）。协议 = `injectManifestIntoBundle(bundleSrc, manifestJson)` + `extractInjectedManifest(bundleSrc)`，CLI：`node scripts/inject-skin-manifest.mjs <bundle.js> <manifest.json>`。

```jsonc
"chrome": [
  { "id": "titlebar", "mode": "light" },
  { "id": "statusbar", "mode": "all" }
]
```

约束：chrome 元素样式同样必须 token 化（文字色引用 `label-on-accent` 类 token 或组件声明），禁止裸色值。

## 5. 校验规则（校验器执行）

### 5.1 必选检查（fail）
- 必选 token 集齐全（§2）
- light/dark 双模式齐全
- 组件样式作用域在 bodyAttr 内（§3）
- bodyAttr 唯一（与已注册皮肤冲突即 fail）

### 5.2 对比度自检（warn 或 fail，按 checks 声明）
- 每个 component 的 `ratio` 目标：校验器算 WCAG 对比度（text vs background）
- palette 内部自洽：`label-primary` vs `bg-base` ≥ 4.5（warn）

### 5.3 checks（皮肤作者声明式自检）

**kind 目录（v0.1）**：
- `contrast`：文字 vs 背景对比度（`ref:` 前缀引用 palette/component 字段，校验器解析后执行）
- `scoped-rule`：CSS 规则选择器必须在 `body[data-dsh-<bodyAttr>]` 作用域内——**溢出染白事故的机制级防线**（生成器产出的规则复核用）

```jsonc
"checks": [
  { "kind": "contrast", "text": "ref:label-primary", "background": "ref:bg-base", "minRatio": 4.5, "mode": "light" },
  { "kind": "contrast", "text": "ref:titlebar.text", "background": "ref:titlebar.background", "minRatio": 4.5 },
  { "kind": "scoped-rule", "selector": "body[data-dsh-retro] [data-pane=sidebar] > div > :first-child" }
]
```

未知 `kind` warn 跳过（forward-compat）。

## 6. settings（自定义项）——选填

暴露给用户的自定义项，由个性化中心解析生成表单（Style Settings 模式）。

```jsonc
"settings": [
  { "id": "accent", "type": "color", "label": "强调色", "default": "#2b7cd9",
    "target": "var(--dsw-alias-brand-primary)" },
  { "id": "titlebar-height", "type": "slider", "label": "标题栏高度", "min": 24, "max": 40, "step": 2, "default": 28,
    "target": "--dshm-titlebar-height" },
  { "id": "chrome", "type": "select", "label": "标题栏样式", "options": [{ "label": "玻璃", "value": "glass" }, { "label": "实色", "value": "solid" }], "default": "glass" },
  { "id": "show-statusbar", "type": "boolean", "label": "显示状态栏", "default": true },
  { "id": "bg-image", "type": "image", "label": "背景图", "default": null },
  { "id": "font-scale", "type": "slider", "label": "字号", "min": 0.9, "max": 1.2, "step": 0.05, "default": 1, "scope": "global" }
]
```

字段：`id`（皮肤内唯一）、`type`（字符串分发）、`label`、`default`、`target`（用户值写入目标，**双形态**）、`scope`（`skin` 默认 | `global` 跨皮肤）。

**target 双形态**（商榷定稿）：
```jsonc
// 形态 1：css 变量写入（简写为字符串 = 变量名，缺省 = --dshm-custom-<id>）
{ "id": "accent", "type": "color", "target": { "kind": "css", "var": "--dsw-alias-brand-primary" } }
{ "id": "accent", "type": "color", "target": "--dsw-alias-brand-primary" }        // 简写
// 形态 2：规则动作（布尔显隐等——纯变量表达不了）
{ "id": "show-statusbar", "type": "boolean", "default": true,
  "target": { "kind": "rule", "selector": "[class*=Statusbar]",
              "on": "display:flex", "off": "display:none" } }
// 形态 3：action（JS 回调）——阶段 2 再定
```

**type 枚举（v0.1）**：`color` / `slider` / `select` / `boolean` / `text` / `font` / `image`。未知 type 渲染器**降级为 text 输入**（forward-compat）；新 type = 注册新渲染器。

**覆盖层**：用户值持久化到 `config.json` 的 `userOverrides`（按 skinId 分组），应用时注入第④层 CSS（`body[data-dsh-xxx]{--dshm-custom-accent: <用户值>}`），皮肤通过 `target` 变量消费。

## 7. 演进机制（后续扩充的操作手册）

| 场景 | 操作 |
|---|---|
| 加一个 palette token | 可选：直接加键（旧校验器忽略）✓；必选：升 schemaVersion 并把该键加入必选集（旧皮肤需补） |
| 加一个 settings type | 注册新渲染器，不动 schema ✓ |
| 加一个组件 id | 文档补充组件清单，不动 schema ✓ |
| 模板继承/复合 | `extends` 字段启用 + schemaVersion 升级 |
| 非皮肤个性化（字体/布局/行为） | settings `scope: "global"` 先行；独立设定域后续由 schemaVersion 引入 |

**不可查问题清单**（唯一需要提前设计的风险面）：
- token 粒度错位：新皮肤需要的语义无法用现有 `--dsw-alias-*` 表达 → 需 DSH 侧加 token（协作项，不是皮肤侧问题）
- chrome 资源形态（HTML/函数/组件）未定型 → 阶段 1 迁移时以 bundle 内函数形态落地，manifest 只存引用

## 8. 应用层（manifest 消费流程）

### 8.1 五层渲染管线

```
① 基础 token 层（DSH 全局）   --dsw-* 原始色板/尺寸          [已有]
② 语义 token 层（DSH 全局）   --dsw-alias-*                  [已有，皮肤消费面]
③ 皮肤模板层（manifest 实例）  palette 覆盖 + 组件样式 + chrome [本规范]
④ 用户自定义层                userOverrides（config.json）    [阶段 2]
⑤ Chrome 资源层               bundle 内注入资源              [已有，声明化]
```

CSS 层叠顺序：`② < ③ < ④`，全部带皮肤作用域（`body[data-dsh-xxx]`）。

### 8.2 注册流程（manifest 分发与注册）

```
皮肤 bundle 加载（{ apply, manifest } 静态导出，spec §4）
  → 服务端 GET /api/skin-center/registry
      skinDirectories（skin.json 扫描）→ 读各 lib/client.js 静态提取 exports.manifest（零执行）
      → 校验器执行（spec §5）→ [{ id, package, manifest, validation }] 按 manifest.order 排序
      未注入 manifest 的皮肤不显示（严格一步到位，无 fallback 表）
  → 客户端 fetch registry 渲染卡片
      nameEn ← manifest.name（生成器 name = UI 显示英文名）
      tagline ← manifest.tagline.zh（fallback en）
      accent / bodyAttr / package / order / author / description / tags 直映射
```

**注册挡位（可配置）**：`registration` 配置项两挡——`lenient`（默认）：warn 项仍注册，卡片显示**告警角标**（validation.warn > 0）；`strict`：warn 项阻止注册（与 fail 同语义，用于 CI/发布门禁）。fail 项两挡都阻止。挡位只决定注册决策，不改变校验器输出。

### 8.3 试穿/应用流程

现有试穿机制（`loadBundleScript → import → apply(ctx)`，皮肤中心 try-on 引擎）不变；`apply(ctx)` 执行时挂 bodyAttr → 注入 ③ 层 CSS（palette 覆盖 + 组件样式）→ 挂载 chrome → 叠加 ④ 层用户覆盖。退出 = 现有 dispose 机制（还原捕获的激活皮肤视觉）。一键应用 = `dsh-skin use <id>`（服务端 /apply，热加载 + 页面重载）。

### 8.4 自定义面板（阶段 2）

```
皮肤详情 → settings 声明解析（spec §6）→ 渲染器按 type 分发生成表单
  → 用户改动 → 写入 config.json userOverrides[skinId][settingId]
  → 即时注入覆盖 CSS（body[data-dsh-xxx]{ <target>: <值> }）→ 实时预览
  → 试穿中改动不落盘，应用时才持久化
```

### 8.5 入口定位

- 设置面板内 = 全量/全局性管理（皮肤中心现状，manifest 数据驱动列表）
- 页面内快捷键 = 日常便捷性（远期单独定制化开发；单开侧边栏方案已否决）

### 8.6 所有权与仓库结构

- 基座独立于皮肤包：Schema + 校验器 + 渲染器 + 中心 UI 由市场仓库与 fork 维护，不属于皮肤包（linxin666）
- 市场仓库：`lib/skin-manifest.js`（校验器）+ `scripts/build-skin-manifest.mjs`（生成器）+ `scripts/inject-skin-manifest.mjs`（注入器）+ `scripts/extract-skin-palette.mjs`（提取器）
- fork（dsh-web-ui）：皮肤中心 registry 路由 + 客户端渲染（见 §8.2）；`packages/skins/manifests/` = 生成器产物入库
- 原生设置映射（远期）：token 层是 DSH 的，个性化中心改 token = 影响原生 UI（现有效应），原生字段级映射留余地

## 9. 文档状态

- v0.1：设计提案（2026-08-15），5 点商榷已定稿（palette 全量目录+默认值、settings target 双形态、components 核心目录、chrome bundle 内函数、checks scoped-rule）
- **阶段 0 校验器已落地**：`lib/skin-manifest.js`（纯函数，无 IO）+ `scripts/tests/unit/skin-manifest.test.mjs`（44 断言，含 qq98 实测基线样例），覆盖率 100%。校验项与本节一一对应
- **分发协议已落地**：`scripts/inject-skin-manifest.mjs`（注入器）——生成器输出静态注入 bundle（`exports.manifest = <常量>`，幂等），真实 bundle 演练通过；12 断言 + 覆盖率 185/185 保持 100%（2026-08-15）
- **注册流程接入已落地（fork 5883ac1，2026-08-15）**：皮肤中心（dsh-web-ui fork）——`GET /api/skin-center/registry` 服务端读各皮肤 bundle 静态提取 manifest + 校验器输出（validation）；客户端删 SKIN_CENTER_ENTRIES，fetch registry 渲染（warn 角标）；`scripts/skin-center-bundles` 改为批量注入器（manifests/ 目录 = 本仓库生成器产物）。上游测试 72/73（唯一失败为 Windows chmod 限制，与改造无关）
- **应用层定稿（§8）**：五层管线 + 注册流程（registry 静态提取 + 挡位）+ 试穿/应用 + 自定义面板（阶段 2）+ 入口定位 + 所有权——原独立应用层文档已并入本节
- **10 皮肤注册记录**：`skins-manifest-record.md`（2026-08-15 全量定稿，含 harbor；部署 0.1.10 缺 harbor 待上游发布）
- 关联：`skins-manifest-record.md`（实例注册文档）、`skin-center-fork-plan.md`（fork 改造内部设计，不提交）

## 附录 A：全量 token 目录（95 个，实测提取自 DSH 主题，2026-08-15）

> 键省略 `--dsw-alias-` 前缀。皮肤未声明的 token 继承 DSH 主题默认值。
> 提取方式：页面全部样式表 + body 计算值扫描（`--dsw-alias-*` 去重）。

**bg 系**：`bg-1` `bg-base` `bg-layer-1` `bg-layer-2` `bg-layer-3` `bg-mask-1` `bg-mask-2` `bg-mask-3` `bg-mask-drop` `bg-mask-photo` `bg-module-platform` `bg-multi-select` `bg-overlay` `bg-primary` `bg-skeleton`

**border 系**：`border-1` `border-inverted` `border-inverted2` `border-l1` `border-l2` `border-l2-darkmode-thin` `border-l3` `border-l4` `border-secondary`

**brand 系**：`brand-primary` `brand-primary-invert` `brand-primary-new-colorprimary-new-color` `brand-text`

**button 系**：`button-contrast-fill` `button-elevated-fill` `button-floating-fill` `button-floating-hover` `button-ghost-active-border` `button-ghost-active-fill` `button-ghost-active-hover` `button-info-fill` `button-info-hover` `button-primary-dimmed` `button-primary-fill` `button-primary-hover` `button-tool-bar-fill` `button-tool-bar-fill-invisible` `button-tool-bar-hover`

**fill/interactive 系**：`fill-l2` `fill-tsp-secondary` `interactive-bg-active` `interactive-bg-hover` `interactive-bg-hover-accent` `interactive-bg-hover-danger` `interactive-bg-hover-solid` `interactive-bg-primary`

**label 系**：`label-caption` `label-dimmed` `label-error` `label-inverse` `label-primary` `label-primary-bluish` `label-primary-dimmed` `label-primary-foreground` `label-primary-inverted` `label-quaternary` `label-secondary` `label-tertiary`

**line/separator 系**：`line-secondary` `separator-primary`

**markdown 系**：`markdown-citation` `markdown-code-block` `markdown-code-block-banner` `markdown-code-segment-selected` `markdown-code-segment-unselected` `markdown-inline-code` `markdown-placeholder` `markdown-tag`

**scrollbar 系**：`scrollbar-bg-l1` `scrollbar-bg-l2` `scrollbar-hover-l1` `scrollbar-hover-l2`

**state 系**：`state-business-primary` `state-business-tertiary` `state-error-primary` `state-error-secondary` `state-success-primary` `state-success-secondary` `state-success-tertiary` `state-warn-label` `state-warn-primary` `state-warn-secondary` `state-warn-tertiary`

**其他**：`text-1` `text-3` `toast-bg` `tooltip-bg` `tooltip-fg`
