# Contributing / 贡献指南

感谢参与贡献。请先阅读 [开发规范](DEVELOPMENT.md)（本仓库的文档源规范），关键要求：

- **提交规范**：`<type>(<scope>): <描述>`，禁止 emoji（commit-msg hook 检查，见 docs/GIT_HOOKS.md 分级）
- **测试**：新增纯函数须配套 `scripts/smoke-tests.mjs` 断言
- **文档**：中英双语；README 需维护 TOC；禁止新增 emoji
- **Git Hook**：先运行 `.\scripts\install-hooks.ps1` 安装本地检查

流程：Fork → 分支（`fix/`、`feat/`、`docs/` 前缀）→ 提交 → PR。

<!-- TOC -->

<!-- /TOC -->
