# 文档中心（Documentation Index）

本文件是本仓库**文档索引与层级规范**的入口：所有规范文档的导航、层级规则、命名约定与维护流程。

<!-- TOC -->
- [文档层级](#文档层级)
- [层级规则](#层级规则)
- [文档命名约定](#文档命名约定)
- [维护流程](#维护流程)
<!-- /TOC -->

## 文档层级

```
docs/
├── README.md            ← 本索引（入口/导航）
├── DEVELOPMENT.md       ← 文档源规范（meta）：提交/代码/文档/测试/Changelog 总纲
├── GIT_HOOKS.md         ← Git Hook 规范：Hook 清单/分级机制/emoji 全覆盖/跨平台
├── CODING_STANDARDS.md  ← 代码规范：注释/命名/错误处理/多端兼容/安全
├── TESTING.md           ← 测试规范：金字塔架构/覆盖率/e2e 策略
└── LIB-ISSUES.md        ← 测试发现的 lib API 问题（待商讨提交 upstream）
```

## 层级规则

| 层级 | 职责 | 文件 |
|---|---|---|
| **L0 索引** | 导航入口、层级说明、维护流程 | `docs/README.md` |
| **L1 源规范（meta）** | 全仓库行为总纲，冲突时最高优先 | `docs/DEVELOPMENT.md` |
| **L2 专项规范** | 单一领域的详细规则 | `docs/GIT_HOOKS.md`、`docs/CODING_STANDARDS.md` |
| **L3 执行层** | 纯函数实现（可测）、Hook、脚本 | `scripts/hooks/*.mjs`、`scripts/toc.mjs` |

**规范冲突解决**：L1 > L2 > 项目 README > 社区惯例。新增规范先在 L1 确立，再细化到 L2。

## 文档命名约定

- kebab-case（`GIT_HOOKS.md` 为既有名，新文档用 `CODING-STANDARDS.md` 风格）
- 每文档必须包含 TOC（`<!-- TOC -->` 占位，由 `scripts/toc.mjs` 生成）
- 双语规范：需对外发布的文档提供 `.en.md` 镜像

## 维护流程

1. 新规范 → 先在 `docs/DEVELOPMENT.md` 确立（L1）
2. 细化 → 新建 `docs/` 专项文档（L2），更新本索引
3. 落地 → 实现为纯函数 + unit 断言 + Git Hook
4. 验证 → `node scripts/toc.mjs --check` + `node scripts/tests/run.mjs` + pre-commit hook
