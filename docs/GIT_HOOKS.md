# Git Hook 规范（Git Hooks）

本文件定义本仓库 Git Hook 体系的完整规范：Hook 清单、检查内容、安装方式、跳过策略、测试要求与跨平台兼容性约束。

## 1. Hook 清单

| Hook | 阶段 | 检查内容 | 拦截条件 |
|---|---|---|---|

<!-- TOC -->
- [1. Hook 清单](#1-hook-清单)
  - [1.1 pre-commit 检查项](#11-pre-commit-检查项)
  - [1.2 TOC 自动扫描](#12-toc-自动扫描)
  - [1.2 commit-msg 检查项](#12-commit-msg-检查项)
- [2. Hook 分级机制（.hooksrc）](#2-hook-分级机制hooksrc)
  - [2.1 配置项](#21-配置项)
  - [2.2 等级语义](#22-等级语义)
  - [2.3 分级策略](#23-分级策略)
  - [2.4 配置加载](#24-配置加载)
- [3. emoji 检测全覆盖定义](#3-emoji-检测全覆盖定义)
- [4. 安装](#4-安装)
- [5. 跳过策略](#5-跳过策略)
- [6. 测试要求](#6-测试要求)
- [7. 跨平台兼容约束](#7-跨平台兼容约束)
- [8. 新增 Hook 检查项流程](#8-新增-hook-检查项流程)
<!-- /TOC -->
| `pre-commit` | 提交前 | 语法检查、测试金字塔、TOC 检测、敏感密钥扫描、覆盖率 | 语法/测试/密钥/覆盖为 error 级；TOC 按 `.hooksrc` 分级（当前 warn） |
| `commit-msg` | 提交信息 | 主题格式、type 白名单、禁 emoji | 主题格式/type 恒为 error；emoji 按 `.hooksrc` 分级（当前 warn） |

### 1.1 pre-commit 检查项

1. **语法检查**：对 `lib/index.js`、`lib/client.js`、`scripts/*.mjs`、`scripts/hooks/*.mjs` 执行 `node --check`
2. **测试金字塔**：执行 `node scripts/tests/run.mjs`（unit / integration / e2e；精确数量以 run.mjs 输出为准），失败即拒绝
3. **TOC 检测**：执行 `node scripts/toc.mjs --check`（按 `.hooksrc` 的 `tocLevel` 分级，当前 warn 仅提醒）
4. **敏感密钥扫描**：检测暂存文件中的高危密钥格式（sk-/ghp_/AKIA 等），默认 error 拦截
5. **覆盖率**：执行 `node scripts/coverage.mjs`（lib/index.js 非豁免 100%，口径见 TESTING.md §4），未达目标即拒绝

### 1.2 TOC 自动扫描

TOC 维护采用**自动发现**而非手动注册：

- `discoverMarkdownFiles(root)` 自动扫描仓库根与 `docs/` 下所有 `*.md`
- 默认排除：`node_modules/`、`.git/`、`dist/`、`CHANGELOG.md`（changelog 不参与导航）
- 新文档加入仓库后**自动纳入** TOC 检查，无需改 toc.mjs
- 追加排除：`.hooksrc` 的 `tocExclude`（逗号分隔路径片段）
- 结果按路径排序（跨平台稳定），无 h2 标题的文档不要求 TOC

### 1.2 commit-msg 检查项

1. **主题格式**：`<type>(<scope>): <描述>`（正则 `^(feat|fix|...)(\([a-z][a-z0-9-]*\))?: .+`）——**恒为 error，不可降级**
2. **type 白名单**：`feat / fix / chore / ci / docs / style / refactor / test / perf / assets / revert`
3. **禁 emoji**：按 `.hooksrc` 配置的 `emojiLevel` 分级（见第 3 节），仓库当前配置 warn（仅提醒）

## 2. Hook 分级机制（.hooksrc）

Hook 检查并非全部绝对禁止——通过仓库根 `.hooksrc` 文件配置检查等级，实现"绝对拦截"与"警告提示"之间的弹性。

### 2.1 配置项

```ini
# .hooksrc — Git Hook 分级配置（示例，key=value，# 注释）
emojiLevel=error        # error | warn | off（默认 error；本仓库当前 warn）
requireCommitMsg=true   # 是否强制提交信息（默认 true）
```
本仓库当前 `.hooksrc` 实际配置：`secretLevel=error`、`emojiLevel=warn`、`tocLevel=warn`。

### 2.2 等级语义

| 等级 | 行为 |
|---|---|
| `error` | 命中即拒绝提交（默认，严格模式） |
| `warn` | 仅打印警告，不阻断提交（宽松模式） |
| `off` | 完全跳过该项检查 |

### 2.3 分级策略

- **格式类检查（主题格式、type 白名单）**：恒为 error，不可降级——保证提交记录可读性
- **emoji 检查**：可分级。默认 error；协作仓库若允许 emoji 装饰，设 `emojiLevel=warn` 提示即可
- **注意**：文档规范类文档（README/CHANGELOG/docs）自身常含 emoji 图示，分级机制正是为此类场景提供弹性

### 2.4 配置加载

- 文件位置：仓库根 `.hooksrc`（不存在则用默认 error 严格模式）
- 纯函数 `parseHookConfig(text)` 解析，unit 测试全覆盖
- 仓库级配置随代码提交，团队一致

## 3. emoji 检测全覆盖定义

`hasEmoji(text)` 采用 **Unicode Emoji 属性完整模式**（内联 emoji-regex-xs 同款，零依赖），覆盖：

| 形态 | 示例 | 覆盖方式 |
|---|---|---|
| 主流 emoji | 😀 ✨ 🚀 | `\p{Emoji}` |
| 变体选择符 | ❤️ ➡️ | `\u{FE0F}` |
| 肤色修饰符 | 👍🏽 | `\u{1F3FB}-\u{1F3FF}` |
| 区域指示符（旗帜） | 🇨🇳 | `\p{RI}{2}` |
| ZWJ 组合序列 | 👨‍👩‍👧‍👦 | `\u{200D}` 连接 |
| 数字 emoji | 1️⃣ | keycap `\u{20E3}` |
| 文本表示符号 | ©️ ™️ | Emoji 属性（含文本呈现类） |

**不误杀**：`✓ ✗ → ★ ☆`（文本 Dingbats）、CJK 汉字、全角标点、数学符号、ASCII。

**行为基准**：与 `emoji-regex` / `emoji-regex-xs`（Unicode 标准）逐样本对齐（23 样本 0 差异）。

测试要求：`scripts/tests/unit/validate.test.mjs` 每类形态至少 1 正向 + 1 负向断言（当前 29 项 emoji/分级断言）。

## 4. 安装

```powershell
# Windows
.\scripts\install-hooks.ps1

# Linux / macOS
bash scripts/install-hooks.sh
```

安装脚本将 `scripts/hooks/` 下的 hook 复制到 `.git/hooks/`。

## 5. 跳过策略

- 不推荐：`git commit --no-verify`（跳过全部 hook）
- 例外场景：紧急修复、CI 自动提交（registry.json 更新）、hook 自身迭代调试
- 跳过时请在提交信息中注明原因（如 `ci: update registry.json (--no-verify 自动提交)`）

## 6. 测试要求

- 所有 hook 校验逻辑必须是**纯函数**（放 `scripts/hooks/validate.mjs` / `scripts/toc.mjs`），可被 unit 测试覆盖
- 新增 hook 检查项必须配套断言（目标：校验逻辑 100% 覆盖）
- Hook 编排（`check.mjs`）不直接测试，但调用链在 CI 中完整执行

## 7. 跨平台兼容约束

| 项 | 约束 |
|---|---|
| 换行符 | 比较前统一 `normalizeEol`（CRLF/LF 兼容） |
| 路径 | 使用 `pathToFileURL` + basename fallback（Windows 反斜杠/盘符大小写） |
| 主模块判断 | `isMain()` 大小写不敏感 + `endsWith` fallback |
| 输出 | 检查结果走 stdout，错误走 stderr，exit code 0/1 |
| 安装 | 同时提供 `.ps1`（Windows）与 `.sh`（Unix） |

## 8. 新增 Hook 检查项流程

1. 在 `docs/DEVELOPMENT.md` 更新对应规范（meta）
2. 实现为纯函数（`validate.mjs` 或独立模块）
3. 在 `scripts/tests/unit/` 增加对应断言（validate/toc 100% 覆盖目标）
4. 接入 `scripts/hooks/check.mjs` 对应阶段
5. 更新本文件 Hook 清单
6. 重装 hook（`install-hooks.ps1` / `.sh`）验证
