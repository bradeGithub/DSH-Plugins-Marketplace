# Contributing / 贡献指南

感谢参与贡献。请先阅读 [开发规范](DEVELOPMENT.md)（本仓库的文档源规范），关键要求：

- **提交规范**：`<type>(<scope>): <描述>`，禁止 emoji（commit-msg hook 检查，见 docs/GIT_HOOKS.md 分级）
- **测试**：新增纯函数须配套 `scripts/smoke-tests.mjs` 断言
- **文档**：中英双语；README 需维护 TOC；禁止新增 emoji
- **Git Hook**：先运行 `.\scripts\install-hooks.ps1` 安装本地检查

流程：Fork → 分支（`fix/`、`feat/`、`docs/` 前缀）→ 提交 → PR。

## 发布 / Release

版本发布走独立规范，见 [RELEASE.md](RELEASE.md)（版本号规则、Tag 命名、Release 正文结构、发布流程）。要点：

- **版本号**：SemVer。新特性/架构升 minor，破坏性变更升 major，修复升 patch。
- **发布分支**：基于最新 `upstream/main` 建 `release/vX.Y.Z`，升 `package.json` 版本并把 CHANGELOG「未发布」区定版。
- **Tag / Release**：合并后打 annotated tag + `gh release create`，正文按 RELEASE.md §3 分段。

<!-- TOC -->
- [发布 / Release](#发布-release)
<!-- /TOC -->
