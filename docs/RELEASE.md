# 发布规范（Release Standards）

本文件定义本仓库的**版本号规则、Tag 命名、Release 正文结构与发布流程**。与 [CHANGELOG.md](CHANGELOG.md)（变更记录）、[CONTRIBUTING.md](CONTRIBUTING.md)（贡献流程）区分：本文件只回答「怎么发一个版本」。
执行规范见 [GIT_HOOKS.md](GIT_HOOKS.md)，代码规范见 [CODING_STANDARDS.md](CODING_STANDARDS.md)。

<!-- TOC -->
- [1. 版本号（SemVer）](#1-版本号semver)
- [2. Tag 命名](#2-tag-命名)
- [3. Release 正文结构](#3-release-正文结构)
- [4. 发布流程](#4-发布流程)
<!-- /TOC -->

## 1. 版本号（SemVer）

格式 `major.minor.patch`，按 [semver.org](https://semver.org)：

| 变更类型 | 段位 | 示例 |
|---|---|---|
| 破坏性变更（接口/字段/状态不兼容） | 升 major | `2.0.0` |
| 新特性 / 架构重构 | 升 minor | `1.5.5` → `1.6.0` |
| 修复（无新特性） | 升 patch | `1.6.0` → `1.6.1` |

- 破坏性 HTTP payload 字段/状态变更必须升 major（见 [TESTING.md §5.5 响应契约](TESTING.md)），新增可选字段仍可留在 minor。
- 发布前确认 `package.json` 的 `version` 与最新 Tag 一致、并已升到目标版本。

## 2. Tag 命名

- 格式：`v` + SemVer（`v1.6.0`），**annotated tag**（`git tag -a`），含一句主题。
- Tag 主题短标题：`vX.Y.Z — <一句主题> / <English subtitle>`。
- 只给已合并进上游 main 的提交打 Tag，不打分支上未发布的中间态。

## 3. Release 正文结构

按主题分段，**无内容的段落省略**。段落标题不带 emoji（仓库全局禁 emoji，GitHub Release 同样遵循）。

结构为：`#` 标题行 → 各 `##` 主题段（按 §1 顺序，空段省略）→ `## 更新方式 / How to update`。主题段：

| 段落 | 内容 |
|---|---|
| `## 新增 / New` | 新特性，一行一条，注明 PR/issue 编号 |
| `## 修复 / Fix` | 修复，注明触发场景与 issue/PR 编号 |
| `## 重构 / Refactor` | 无行为变化的内部/架构调整 |
| `## 安全 / Security` | 安全加固（如有 CWE/外部贡献者致谢） |
| `## 工程 / Engineering` | 测试/CI/构建/基础设施（无用户可见变更时合并到本段） |
| `## 质量门 / Quality gate` | coverage、mutation、property、smoke、browser/install E2E 当前通过数 |
| `## 更新方式 / How to update` | 市场设置页检查更新并重启 dsh web；或 dsh CLI 重装 |

- 每项一行精要，**技术规范优先**（机制、后果、验证），非散文。
- 条目与 CHANGELOG 对应版本段**同源**（同一份事实，不在两处手抄不同措辞——CHANGELOG 为第一事实源，Release 正文由它凝练）。
- 外部贡献致谢：明确注明 `@handle（组织/项目）` 与该 PR 编号。

## 4. 发布流程

1. 基于最新 `upstream/main` 建 `release/vX.Y.Z` 分支。
2. 升 `package.json` 版本；把 CHANGELOG「未发布」区标题改为 `## vX.Y.Z — <日期>（<主题> / <English>）`，内容下移定版。
3. 规范批次提交（version bump / CHANGELOG 各一个 commit，见 [CONTRIBUTING.md](CONTRIBUTING.md)），推到 fork，建 PR 合入上游。
4. 合并后打 annotated tag：`git tag -a vX.Y.Z -m "<主题>"`，推上游。
5. `gh release create vX.Y.Z --notes "<正文>"`（正文按 §3 结构），标记为 Latest（若非旧版热修复）。
