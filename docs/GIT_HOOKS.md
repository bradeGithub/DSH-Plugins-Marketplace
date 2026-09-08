# Git Hook 规范（Git Hooks）

本文件定义本仓库 Git Hook 体系的完整规范：Hook 清单、检查内容、安装方式、跳过策略、测试要求与跨平台兼容性约束。

## 1. Hook 清单

| Hook | 执行时机 | 检查内容 | 拦截条件 |
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
- [5.1 CI 增量模式（环境变量）](#51-ci-增量模式环境变量)
- [5.2 提交内容感知的 pre-commit 运行分级](#52-提交内容感知的-pre-commit-运行分级)
  - [5.2.1 改动区域判定与运行集](#521-改动区域判定与运行集)
  - [5.2.2 判定与执行规则](#522-判定与执行规则)
  - [5.2.3 实现与测试](#523-实现与测试)
- [6. 测试要求](#6-测试要求)
- [7. 跨平台兼容约束](#7-跨平台兼容约束)
- [8. 新增 Hook 检查项流程](#8-新增-hook-检查项流程)
<!-- /TOC -->
| `pre-commit` | 提交前 | 语法检查、unit+integration、TOC 检测、敏感密钥扫描 | 语法/测试/密钥为 error 级；TOC 按 `.hooksrc` 分级（当前 error）；完整 E2E、coverage 和 mutation 使用显式质量门 |
| `commit-msg` | 提交信息 | 主题格式、type 白名单、禁 emoji | 主题格式/type 恒为 error；emoji 按 `.hooksrc` 分级（当前 error） |

### 1.1 pre-commit 检查项

1. **语法检查**：按 `scripts/hooks/validate.mjs` 的 `SYNTAX_CHECK_FILES` 清单执行 `node --check`，包含 `lib/client.js`、`scripts/assemble-client.mjs` 和 `scripts/registry/` 新入口
2. **Bundle 漂移**：执行 `node scripts/assemble-client.mjs`，source fragments 与受版本控制的 `lib/client.js` 不一致即拒绝
3. **快速测试门**：默认执行 `node scripts/tests/run.mjs --level=unit,integration`，失败即拒绝；完整 Node E2E 使用 `node scripts/hooks/check.mjs --only=e2e`，浏览器 E2E 使用 `node scripts/tests/frontend-e2e.mjs` 单独执行。按改动内容分级（docs/tests 白名单走快路径、核心改动全量）见 [§5.2 提交内容感知的 pre-commit 运行分级](#52-提交内容感知的-pre-commit-运行分级)
4. **TOC 检测**：执行 `node scripts/toc.mjs --check`（按 `.hooksrc` 的 `tocLevel` 分级，当前 error 命中即阻断）
5. **敏感密钥扫描**：检测暂存文件中的高危密钥格式（sk-/ghp_/AKIA 等），默认 error 拦截
6. **覆盖率**：由 `node scripts/hooks/check.mjs --only=coverage` 或 CI 显式执行（lib 与 Node 脚本非豁免函数 100%；client bundle 由 VM 运行时契约与 assembler 契约守护），未达目标即拒绝

### 1.2 TOC 自动扫描

TOC 维护采用**自动发现**而非手动注册：

- `discoverMarkdownFiles(root)` 自动扫描仓库根与 `docs/` 下所有 `*.md`
- 默认排除：`node_modules/`、`.git/`、`dist/`、`CHANGELOG.md`（changelog 不参与导航）
- 新文档加入仓库后**自动纳入** TOC 检查，无需改 toc.mjs
- 追加排除：`.hooksrc` 的 `tocExclude`（逗号分隔路径片段）
- 结果按路径排序（跨平台稳定），无 h2 标题的文档不要求 TOC

### 1.2 commit-msg 检查项

1. **主题格式**：`<type>(<scope>): <描述>`（正则 `^(feat|fix|...)(\([a-z][a-z0-9-]*\))?: .+`）——**恒为 error，不可降级**
2. **type 白名单**：`feat / fix / chore / ci / docs / style / refactor / test / perf / assets / revert / merge`
3. **禁 emoji**：按 `.hooksrc` 配置的 `emojiLevel` 分级（见第 3 节），仓库当前配置 error（命中即阻断）

## 2. Hook 分级机制（.hooksrc）

Hook 检查并非全部绝对禁止——通过仓库根 `.hooksrc` 文件配置检查等级，实现"绝对拦截"与"警告提示"之间的弹性。

### 2.1 配置项

```ini
# .hooksrc — Git Hook 分级配置（示例，key=value，# 注释）
emojiLevel=error        # error | warn | off（默认 error；本仓库当前 error）
requireCommitMsg=true   # 是否强制提交信息（默认 true）
precommitStrategy=auto  # auto | full（默认 auto；见 §5.2 提交内容感知分级；full 恒跑全量快速门）
```
本仓库当前 `.hooksrc` 实际配置：`secretLevel=error`、`emojiLevel=error`、`tocLevel=error`。

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
- **底线在 CI**：`.github/workflows/lint.yml` 对每次 push/PR 重跑语法/单元/集成/TOC/密钥扫描——本地 `--no-verify` 绕不过 PR 门禁

## 5.1 CI 增量模式（环境变量）

check.mjs 支持两个环境变量（测试与 CI 用，本地无需设置）：

| 变量 | 作用 |
|---|---|
| `CHECK_WORKTREE` | git 命令与暂存文件读取的目标工作树（默认仓库根）——hook-check.test.mjs 用临时仓库隔离 |
| `CHECK_DIFF_BASE` | 设置后密钥扫描改用 `git diff --name-only <base>...HEAD` 扫相对基线的增量（CI checkout 无 staged 概念；lint.yml 传 PR base.sha 或 HEAD~1） |
| `DSH_REQUIRE_E2E` | 设为 `1` 时，真实 E2E 缺少 git/npm/pnpm/DSH CLI 等前置工具即失败；`--only=e2e` 自动设置该值 |

## 5.2 提交内容感知的 pre-commit 运行分级

**背景 / 问题**：默认 pre-commit 恒跑 `unit+integration`（实测墙 ~48s，主要被 `installed-load.test.mjs`、`lib.test.mjs`、`install-scripts.test.mjs` 三个真实 DSH_HOME / 真实 pnpm/git 子进程的集成测试占据），且**不区分改动内容**——无论改一行 `docs/*.md`、一个纯函数，还是核心 `lib/*` 安装管线，都等同样的全量快速门。对以文档/测试/纯函数为主的提交，这是明显浪费。

**方案**：按 `git diff --cached --name-only` 的改动区域决定 pre-commit 跑哪套检查，让「低成本区域（文档/测试）」的提交从 ~48s 降到秒级；核心逻辑改动仍全量快速门。核心原则是 **fail-safe 偏保守**：无法可靠判断改动类型、或改动命中 hook 自身时回退全量，绝不因降级漏检。

### 5.2.1 改动区域判定与运行集

改动判定是纯函数 `classifyPrecommitTier(fileList, cfg)`（`scripts/hooks/validate.mjs`，可单测），返回 `{ runTests, tier }`。`runTests` 值为 `run.mjs --level` 的合法参数（逗号分隔多层级）。

| 改动区域（staged 文件列表全部命中） | `runTests` | pre-commit 运行项 | 耗时 |
|---|---|---|---|
| 仅 `docs/*` 或 `*.md` | `none` | syntax + toc + secret（跳过测试） | ~1s |
| 仅 `registry.json` / `skills.json` / `*.gzip` | `none` | syntax + toc + secret（跳过测试；属 CI 自动提交路径） | ~1s |
| 仅 `scripts/tests/**` 或 `*.test.mjs` / `*.spec.*` / `*.e2e.mjs` | `unit` | syntax + secret + unit 快层 | ~5s |
| `docs` + `tests` 混合（无 lib/scripts 核心） | `unit` | syntax + secret + unit 快层 | ~5s |
| 含任意 `lib/**` | `unit,integration` | syntax + unit+integration + toc + secret（全量快速门） | ~55s |
| 含任意 `scripts/**`（非测试） | `unit,integration` | 全量快速门 | ~55s |
| 含 `scripts/hooks/*` / `install-hooks.*` / `.hooksrc` | `unit,integration` | 全量快速门（hook 自改最可能破坏门） | ~55s |
| **无法判定 / 改动集为空** | `unit,integration` | **回退全量快速门**（fail-safe） | ~55s |

### 5.2.2 判定与执行规则

1. **低成本路径只在改动明确且保守时可降级**：只有全部文件落入白名单区域（docs / generated / tests，或 docs+tests 混合）才跳过 unit+integration 慢层；任何文件命中核心（lib、非测试 scripts、hook 自身）或无法判定即全量快速门。
2. **tests-only 跑单元快层**：改动测试文件本身时跑 `run.mjs --level=unit`（秒级，覆盖纯函数/适配器契约），不跑 integration 慢层——测试自身语法与单元契约即可被快速守护。
3. **CI 不降级**：`CHECK_DIFF_BASE` 或 `CI=true` 时强制全量快速门；`--only=tests` 显式请求也恒全量。本分级仅本地 pre-commit 生效，CI 的 `lint.yml` 每次 push/PR 仍全量重跑（见 §5.1 底线）——分级只省本地等待，不减 CI 完整性。
4. **分级日志**：pre-commit 输出 `[tier] <标签> → run.mjs --level=<runTests>`（如 `[tier] docs-only → run.mjs --level=none`），便于确认降级合理性；staged 读取失败时警告并回退全量。
5. **`.hooksrc` 配置项**：`precommitStrategy=auto|full`，默认 `auto`（按改动集分级）；设 `full` 则恒全量快速门，供偏好严格或无法依赖 git diff（如非 git 工作树）的环境使用。

### 5.2.3 实现与测试

- 判定纯函数 `classifyPrecommitTier` 在 `scripts/hooks/validate.mjs`；编排（`resolveTestRun` / 强制全量 / 分级日志）在 `scripts/hooks/check.mjs` 的 `checkTests()` 前。
- 配套断言：`scripts/tests/unit/validate.test.mjs` 覆盖分级判定矩阵（docs/tests/generated/核心/unknown/empty/full 策略）；`scripts/tests/unit/hook-check.test.mjs` 覆盖 CI 强制全量、`--only=tests` 不走分级、分级日志存在。

## 6. 测试要求

- 所有 hook 校验逻辑必须是**纯函数**（放 `scripts/hooks/validate.mjs` / `scripts/toc.mjs`），可被 unit 测试覆盖
- 新增 hook 检查项必须配套断言（目标：校验逻辑 100% 覆盖）
- Hook 编排（`check.mjs`）由 `scripts/tests/unit/hook-check.test.mjs` 行为测试覆盖（spawn 子进程：本地 staged 扫描 / CI 增量 / 未知 --only / --help / secretExclusions / E2E 严格分派）；调用链在 CI 中完整执行
- 默认 pre-commit 保持快速的 unit+integration 门（并按 §5.2 按改动内容分级，docs/tests 白名单走快路径）；推送前或 CI 需额外执行 `node scripts/hooks/check.mjs --only=e2e`、`node scripts/coverage.mjs` 和 `node scripts/mutation-test.mjs`。E2E 缺少声明前置工具时，严格模式必须失败而不是计为通过

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
4. 接入 `scripts/hooks/check.mjs` 对应执行时机
5. 更新本文件 Hook 清单
6. 重装 hook（`install-hooks.ps1` / `.sh`）验证
