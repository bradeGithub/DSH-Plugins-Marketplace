# 开发规范（Development Guidelines）

本文件是本仓库的**文档源规范（meta）**：所有开发、提交、测试、文档行为以此为据。
新增规范请先在此商讨确立，再落地为 Git Hook 与测试。

## 1. 提交规范（Commit）

### 1.1 主题（subject）格式

```
<type>(<scope>): <描述>
```

- `type` 白名单：`feat / fix / chore / ci / docs / style / refactor / test / perf / assets / revert`
- `scope` 可选：小写字母 + 连字符，如 `fix(install)`
- 描述：中文为主，技术细节可用括号补充
- 全行无表情符号（emoji）

样例（来自仓库历史）：
```
feat: 通用 Skills 栏目前端 tab（步骤 5）
fix: getList 参数错位导致列表加载崩溃（undefined.length）
fix(install): 剥离 pnpm 专用 link:/workspace: 依赖后再 npm install
chore: update registry.json
```

### 1.2 正文（body）

- 空行分隔，`- ` 列表逐项说明
- 组件定位开头：`lib/index.js: ...` / `scripts/tests/unit/validate.test.mjs: ...`
- 结尾补充说明：`README/CHANGELOG 同步` / `需重启 DSH 生效`

### 1.3 禁止事项

- 主题与正文禁止 emoji（commit-msg hook 检查；等级按 `.hooksrc` 分级，当前 warn 仅提醒）
- 禁止无 type 的提交（commit-msg hook 强制）

## 2. 代码规范

- 语言：JavaScript（ESM），无构建步骤，纯 node 可跑
- 注释：**中文**，`/** */` 块注释解释"为什么"，行内注释补充边界条件
- 注释说明行为动机而非复述代码
- 函数：纯函数优先，便于 unit 测试覆盖
- 新增逻辑需同步补充 unit 断言

## 3. 测试规范

- **架构**：测试金字塔（unit → integration → e2e），完整规范见 [TESTING.md](TESTING.md)
- 统一运行器：`node scripts/tests/run.mjs`
- 覆盖率：`node scripts/coverage.mjs`（lib/index.js 非豁免 100%，口径见 TESTING.md §4；当前 303/303）
- 新增纯函数必须配套断言；hook 校验逻辑必须可测（放 validate.mjs）
- 日志脱敏（`lib/redact.js`）与安装反馈（`docs/FEEDBACK.md`）属正式能力：改脱敏规则须同步
  redact.test.mjs 泄漏/误报面断言（成对维护，见 TESTING.md §5.4）；workspace 吞依赖陷阱
  回归由 `scripts/tests/e2e/workspace-trap.e2e.mjs` 守护（见 TESTING.md §5）
- 真实安装验收（手动）：`scripts/tests/manual/real-install-verify.mjs`（不进自动金字塔，见 TESTING.md §5）
- CI：`node --check` 语法检查 + 金字塔测试同步执行（见 registry.yml）

## 4. 文档规范

### 4.1 文档源规范（本文件）

- 本仓库文档行为以此 meta 为准，冲突时以本文件为上级
- 新增文档须先在此确立规范

### 4.2 文档结构

- `README.md`（中文主文档）+ `README.en.md`（英文镜像）
- 中英文档标题、结构保持一致
- `CHANGELOG.md`：双语，`## vX.Y.Z (日期)` 条目，`- **标题** 中文 / English` 格式
- `docs/`：规范与深度文档，层级与索引见 [docs/README.md](README.md)（文档中心）
  - L0 索引 `docs/README.md` → L1 源规范 `DEVELOPMENT.md` → L2 专项（`GIT_HOOKS.md`/`CODING_STANDARDS.md`/`TESTING.md`/`FEEDBACK.md`）
  - `FEEDBACK.md`：安装反馈系统规范（模板/字段/脱敏机制/隐私边界），实现为 `lib/redact.js` + `lib/index.js` 反馈链路
- 新文档必须更新文档中心索引 + 生成 TOC

### 4.3 TOC

- README 需包含目录（TOC），由 `scripts/toc.mjs` 自动生成
- 默认深度：`h2 + h3`（`--depth 3` 可调）
- TOC 占位：`<!-- TOC -->
- [1. 提交规范（Commit）](#1-提交规范commit)
  - [1.1 主题（subject）格式](#11-主题subject格式)
  - [1.2 正文（body）](#12-正文body)
  - [1.3 禁止事项](#13-禁止事项)
- [2. 代码规范](#2-代码规范)
- [3. 测试规范](#3-测试规范)
- [4. 文档规范](#4-文档规范)
  - [4.1 文档源规范（本文件）](#41-文档源规范本文件)
  - [4.2 文档结构](#42-文档结构)
  - [4.3 TOC](#43-toc)
  - [4.4 禁止事项](#44-禁止事项)
  - [4.5 文档链接](#45-文档链接)
- [5. Changelog 规范](#5-changelog-规范)
- [6. Git Hook 体系](#6-git-hook-体系)
- [7. 新规范落地流程](#7-新规范落地流程)
<!-- /TOC -->`
- 标题带 emoji 时，TOC 锚点按 GitHub slug 规则去除 emoji
- pre-commit hook 检测：TOC 缺失或过期 → 按 `.hooksrc` 分级拦截（当前 warn 仅提醒；运行 `node scripts/toc.mjs --check`）

### 4.4 禁止事项

- 新增/修改内容禁止 emoji（含 README 标题、CHANGELOG 条目、commit）
- 历史内容暂不清理，后续优化迭代中逐步移除

### 4.5 文档链接

- 相对链接手动维护（暂未由 hook 强制，靠人工校验）

## 5. Changelog 规范

- 每条目：`## vX.Y.Z (日期)` + 双语说明
- 版本号语义化，v1.0.0 前 beta 不单独 tag
- 不强制 hook 检测，靠文档约定

## 6. Git Hook 体系

| Hook | 阶段 | 检查内容 |
|---|---|---|
| `pre-commit` | 提交前 | 语法检查、测试金字塔、TOC 检测、敏感密钥扫描、覆盖率 |
| `commit-msg` | 提交信息 | 主题格式、type 白名单、禁 emoji |

安装：`.\scripts\install-hooks.ps1`（Windows）或手动复制 `.git/hooks/`。
跳过（不推荐）：`git commit --no-verify`。

## 7. 新规范落地流程

1. 在本文件商讨确立规范（meta）
2. 实现为 `scripts/hooks/validate.mjs` 纯函数 + unit 断言
3. 接入 `scripts/hooks/check.mjs` 与对应 hook
4. 更新 install-hooks 与 CI（如需要）
