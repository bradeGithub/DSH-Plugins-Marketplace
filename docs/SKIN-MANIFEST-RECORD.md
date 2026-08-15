# 皮肤 Manifest 实例注册文档（10 皮肤记录）

> 实例注册文档：仓库内已有皮肤的 manifest 注册数据（最终状态，2026-08-15 全量定稿）。
> 设计源文档见 `skin-manifest-spec.md`（Schema v0.1）；本表与生成器产物（`scripts/tests/fixtures/<id>.manifest.json`）一一对应，契约测试固化。
> 数据标注：`实测` = js-reverse/CDP 像素验证；`源码` = 皮肤包 CSS 规则 / skin.json；`修复` = 生成器 applyFixups 规则处理后的值（防白字浅底类事故）。

<!-- TOC -->
- [1. qq98（QQ2008 Retro）](#1-qq98qq2008-retro)
- [2. ths（Tonghuashun Trading）](#2-thstonghuashun-trading)
- [3. xp（Windows XP Luna）](#3-xpwindows-xp-luna)
- [4. miku（Hatsune Miku）](#4-mikuhatsune-miku)
- [5. blue-fantasy（Blue Fantasy）](#5-blue-fantasyblue-fantasy)
- [6. whale-song（Whale Song）](#6-whale-songwhale-song)
- [7. dragon-heir（Dragon Heir）](#7-dragon-heirdragon-heir)
- [8. minecraft（Minecraft Voxel）](#8-minecraftminecraft-voxel)
- [9. trading（Trading Terminal）](#9-tradingtrading-terminal)
- [10. harbor（Harbor）](#10-harborharbor)
- [注册状态](#注册状态)
<!-- /TOC -->

## 1. qq98（QQ2008 Retro）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `qq98` / `ui-skin-qq98` / `data-dsh-retro` / `@linxin666/dsh-client-ui-skin-qq98` | 源码 |
| name / tagline | `QQ2008 Retro` / 水晶蓝桌面 · 玻璃深蓝标题栏 · 戴围巾企鹅 | 源码 |
| author / accent / order | `dsh-web-ui` / `#2b7cd9` / 1 | 源码 |
| palette 亮色 | bg-base `#fff` · label-primary `#17293c` · label-primary-foreground `#17293c`（修复：原 #fff 配浅底） · brand `#2b7cd9` | 修复 |
| palette 暗色 | bg-base `#101c2b` · label-primary `#d8e6f4` · label-primary-foreground `#fff` | 源码 |
| 组件 | `titlebar`（深蓝渐变 #1a56a6→#2b7cd9→#4a9ae8 白字 3.88:1，渐变跳过自检 warn）+ `sidebar-header`（ratio 4.5） | 实测 |
| chrome | titlebar（Btn/Icon/Title）+ statusbar（Cell/Spacer） | 源码 |
| checks | label-primary vs bg-base（双模式）+ titlebar 对比度 + 作用域规则 | 生成器 |

## 2. ths（Tonghuashun Trading）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `ths` / `ui-skin-ths` / `data-dsh-ths` / `@linxin666/dsh-client-ui-skin-ths` | 源码 |
| name / tagline | `Tonghuashun Trading` / 品牌红标题栏 · 实时行情状态栏 · 灰蓝数据终端 | 源码 |
| author / accent / order | `dsh-web-ui` / `#e60012` / 2 | 源码 |
| palette 亮色 | bg-base `#fff` · label-primary `#1f2733` · label-primary-foreground `#1f2733`（修复：原 #fff 配浅底） · brand `#e60012` | 修复 |
| palette 暗色 | bg-base `#141a22` · label-primary `#e2e9f2` · label-primary-foreground `#fff` | 源码 |
| 组件 | `titlebar`（品牌红 rgb(214,5,21) 白字 5.38:1 达标）+ `sidebar-header` | 实测 |
| chrome | titlebar（**Ticker 行情标签**/Btn/Icon）+ statusbar（Cell/Spacer） | 源码 |
| checks | label-primary vs bg-base（双模式）+ titlebar 对比度 + 作用域规则 | 生成器 |

## 3. xp（Windows XP Luna）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `xp` / `ui-skin-xp` / `data-dsh-xp` / `@linxin666/dsh-client-ui-skin-xp` | 源码 |
| name / tagline | `Windows XP Luna` / Luna 蓝窗口条 · 绿色开始按钮 · Bliss 蓝天桌面 | 源码 |
| author / accent / order | `dsh-web-ui` / `#316ac5` / 3 | 源码 |
| palette 亮色 | bg-base `#fff` · label-primary `#000` · label-primary-foreground `#000`（修复） · brand `#316ac5` | 修复 |
| palette 暗色 | bg-base `#0d0f12` · label-primary `#e8eaed` · label-primary-foreground `#fff` | 源码 |
| 组件 | `titlebar`（#0a5bc4→#1a6fd0→#3a8fe0 白字 4.74:1）+ `sidebar-header` | 实测 |
| chrome | titlebar + **taskbar（Start 开始按钮）** + statusbar（Cell/Key/Spacer） | 源码 |
| 实测备注 | body 蓝天渐变 + 深字可读；侧栏深蓝底白字 7.6~10:1；设置面板溢出染白已由市场侧 panel 类重绑兜底 | 实测 |

## 4. miku（Hatsune Miku）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `miku` / `ui-skin-miku` / `data-dsh-miku` / `@linxin666/dsh-client-ui-skin-miku` | 源码 |
| name / tagline | `Hatsune Miku` / 蓝紫双马尾 · 01 编号 · 音符波形 · 电子歌姬主题 | 源码 |
| author / accent / order | `涂山苏苏` / `#2e9bff` / 9 | 源码 |
| palette 亮色 | bg-base `#fff` · label-primary `#17302c` · label-primary-foreground `#17302c`（修复） · brand `#2e9bff` | 修复 |
| palette 暗色 | bg-base `#0d1a3a` · label-primary `#d6f1ec` · label-primary-foreground `#fff` | 源码 |
| 组件 | `titlebar` + `sidebar-header`（浅彩虹渐变底，文字重绑 label-primary；渐变跳过自检 warn） | 修复 |
| chrome | titlebar（Badge/Btn/Icon）+ statusbar（Cell/Spacer/**Wave 波形**） | 源码 |
| 实测备注 | 侧栏/标题栏/explorer-col 白字浅底已修复（重绑 label-primary/explorer-col 覆盖） | 修复 |

## 5. blue-fantasy（Blue Fantasy）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `blue-fantasy` / `ui-skin-blue-fantasy` / `data-dsh-blue-fantasy` / `@linxin666/dsh-client-ui-skin-blue-fantasy` | 源码 |
| name / tagline | `Blue Fantasy` / 鲸鱼插画背景 · periwinkle 靛蓝调色板 · 半透明面板 | 源码 |
| author / accent / order | `powerdog996（DreamSkin 社区）· dsh-web-ui 适配` / `#4a5fa8` / 4 | 源码 |
| palette 亮色 | bg-base `#ffffff73`（8 位 hex 半透明）· label-primary `#1d2539` · label-primary-foreground `#fff`（配深 bg-layer，保持白字） · brand `#4a5fa8` | 源码 |
| palette 暗色 | bg-base `#10162a80` · label-primary `#dbe2f2` · label-primary-foreground `#fff` | 源码 |
| 组件 / chrome | 无（插画类：纯背景 + token 覆盖；BACKDROP_SKIN_IDS 内） | 源码 |
| checks | label-primary vs bg-base（双模式） | 生成器 |

## 6. whale-song（Whale Song）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `whale-song` / `ui-skin-whale-song` / `data-dsh-whale-song` / `@linxin666/dsh-client-ui-skin-whale-song` | 源码 |
| name / tagline | `Whale Song` / 深海鲸语女神背景 · 冰蓝海洋调色板 · 金色细线点缀 | 源码 |
| author / accent / order | `dsh-web-ui` / `#4d8fd4` / 7 | 源码 |
| palette 亮色 | bg-base `#ffffff6b` · label-primary `#0a1e4a` · label-primary-foreground `#fff` · brand `#4d8fd4` | 源码 |
| palette 暗色 | bg-base `#08143480` · label-primary `#d8e5f5` · label-primary-foreground `#fff` | 源码 |
| 组件 / chrome | 无（插画类；BACKDROP_SKIN_IDS 内） | 源码 |
| checks | label-primary vs bg-base（双模式） | 生成器 |

## 7. dragon-heir（Dragon Heir）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `dragon-heir` / `ui-skin-dragon-heir` / `data-dsh-dragon-heir` / `@linxin666/dsh-client-ui-skin-dragon-heir` | 源码 |
| name / tagline | `Dragon Heir` / 不屈龙魂 · 万里长城双主题 · 朱砂龙印 | 源码 |
| author / accent / order | `dsh-web-ui` / `#c3272b` / 5 | 源码 |
| palette 亮色 | bg-base `#faf7f057` · label-primary `#262319` · label-primary-foreground `#fff` · brand `#c3272b` | 源码 |
| palette 暗色 | bg-base `#12161f57` · label-primary `#eef1f6` · label-primary-foreground `#fff` | 源码 |
| 组件 / chrome | 无（插画类：墨龙穿云 / 万里长城双主题画，favicon 龙印） | 源码 |
| checks | label-primary vs bg-base（双模式） | 生成器 |

## 8. minecraft（Minecraft Voxel）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `minecraft` / `ui-skin-minecraft` / `data-dsh-minecraft` / `@linxin666/dsh-client-ui-skin-minecraft` | 源码 |
| name / tagline | `Minecraft Voxel` / 动态全景天空盒 · 方块按钮 · 告示牌输入框 | 源码 |
| author / accent / order | `dsh-web-ui` / `#7cbd4b` / 6 | 源码 |
| palette | **单模式 `["light"]`**：bg-base `#18221b`（深底）· label-primary `#e7ead7` · label-primary-foreground `#eef4fb` · brand `#83c94e`——亮色即深色面板，无白字浅底风险 | 源码 |
| 暗色行为 | 暗色走皮肤自有 `--aion-*` 层（面板变量），**不覆盖 `--dsw-alias-*` 语义层**——alias 继承 DSH 默认（已实测确认，与单模式声明一致） | 实测 |
| 组件 / chrome | 无 | 源码 |
| checks | label-primary vs bg-base（light）+ dark-first warn（单模式已知项） | 生成器 |

## 9. trading（Trading Terminal）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `trading` / `ui-skin-trading` / `data-dsh-trading` / `@linxin666/dsh-client-ui-skin-trading` | 源码 |
| name / tagline | `Trading Terminal` / 实时行情跑马灯 · 长桥港美股行情 · 红涨绿跌交易终端 | 源码 |
| author / accent / order | `dsh-web-ui` / `#f23645` / 8 | 源码 |
| palette 亮色 | bg-base `#fff` · label-primary `#1b2431` · label-primary-foreground `#1b2431`（修复） · brand `#e02e3d` | 修复 |
| palette 暗色 | bg-base `#10151d` · label-primary `#dbe2ec` · label-primary-foreground `#fff` | 源码 |
| 组件 | `titlebar`：**浅底深字设计**（--dsh-trd-titlebar-bg 亮 = #fff→#f2f5f8 渐变 + --dsh-trd-text = #1b2431；暗 = #161d27→#10151d + #dbe2ec）——纯色近似 #f2f5f8 自检 0 warn | 源码 |
| 实测补测 | titlebar 双模式对比度全达标：亮 #1b2431 vs #fff = **15.63:1**、vs #f2f5f8 = **14.29:1**；暗 #fff vs #161d27 = **16.95:1**、vs #10151d = **18.31:1**（2026-08-15） | 实测 |
| chrome | titlebar（Chip/Btn）+ statusbar（Cell/Group/**LbLabel**/Spacer） | 源码 |
| 自定义变量 | `--dsh-trd-*`（皮肤 bundle 内部实现，不属于 --dsw-alias-* 提取范围；components 声明必须用解析后的实际值） | 源码 |

## 10. harbor（Harbor）

| 字段 | 值 | 来源 |
|---|---|---|
| id / wiringId / bodyAttr / package | `harbor` / `ui-skin-harbor` / `data-dsh-harbor` / `@linxin666/dsh-client-ui-skin-harbor` | 源码 |
| name / tagline | `Harbor` / 暮光蓝港 · 日落橙辉 · 半透明夜色面板 | 源码 |
| author / accent / order | `moeblack` / `#ff9d5c` / 3 | 源码 |
| palette | **亮暗同值双模式**（共用选择器块 `body[data-dsh-harbor],body[data-dsh-harbor][data-ds-dark-theme]`，69 tokens）：bg-base `#141a2eb3` · label-primary `#fff5ec` · label-primary-foreground `#141a2e` · brand `#ff9d5c` | 源码 |
| 组件 / chrome | 无（插画类：黄昏港口背景 + scrim 遮罩，亮色薄暮纱 / 暗色深海夜航纱） | 源码 |
| checks | label-primary vs bg-base（双模式，浅字深底 0 warn） | 生成器 |

## 注册状态

- **10 皮肤 manifest 全部生成 + 校验通过**（`build-skin-manifest.mjs --all` → fixtures；harbor 为上游 main 新增，部署 0.1.10 尚缺，fork 已就绪）
- **部署 registry 实测**（2026-08-15，DSH 重启后）：9 皮肤全列出（0.1.10 部署）、order 1-9、元数据正确、fail 全 0；warn 角标预期：qq98（渐变 2）、minecraft（dark-first 1）、miku（渐变 2）
- 双模式 9 个 + minecraft 单模式（权威声明）；插画类 5 个无组件无 chrome（纯 palette）
- 修复规则（applyFixups）最终态：4 皮肤亮色 label-primary-foreground 重绑为深色（qq98/ths/xp/miku/trading）——防白字浅底；皮肤中心按钮文字走 `label-primary-inverted`（反色语义，50f3512）
- 契约测试：每皮肤数据驱动断言（fixtures + UI_NAMES 基准 10 条，~150 断言），新增皮肤 = fixture + UI_NAMES 一行
