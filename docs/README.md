# 文档中心（Documentation Index）

本文件是本仓库**文档索引与层级规范**的入口：所有规范文档的导航、层级规则、命名约定与维护流程。

<!-- TOC -->
- [按读者分流](#按读者分流)
- [文档层级](#文档层级)
- [层级规则](#层级规则)
- [文档命名约定](#文档命名约定)
- [双语镜像管理](#双语镜像管理)
- [维护流程](#维护流程)
<!-- /TOC -->

## 按读者分流

| 你是谁 | 先读 | 然后 |
|---|---|---|
| **使用者**（装市场/用市场） | 根 [README.md](../README.md) | [USAGE.md](USAGE.md)（功能细则与已知限制）、[SECURITY.md](SECURITY.md)（信任边界） |
| **插件作者**（想被收录） | [STANDARD.md](../STANDARD.md)（[English](../STANDARD.en.md)） | [USAGE.md](USAGE.md) §2-3（分类与徽章机制） |
| **贡献者**（改代码/文档） | [DEVELOPMENT.md](DEVELOPMENT.md) + [CONTRIBUTING.md](CONTRIBUTING.md) | [ARCHITECTURE.md](ARCHITECTURE.md)、[TESTING.md](TESTING.md)、[GIT_HOOKS.md](GIT_HOOKS.md) |
| **集成者/调试者**（调接口） | [HTTP-API.md](HTTP-API.md) | [ARCHITECTURE.md](ARCHITECTURE.md)（数据流） |

## 文档层级

```
docs/
├── README.md             ← 本索引（入口/导航/persona 分流）
├── USAGE.md              ← 使用指南：设置页操作/分类/徽章/Skills/反馈备份/已知限制全量
├── SECURITY.md           ← 安全模型：鉴权三层/确认门/env 边界/供应链/自更新链/env 注册表
├── HTTP-API.md           ← 接口参考：17 端点全表/鉴权矩阵/安装状态机
├── ARCHITECTURE.md       ← 架构与数据流：分层/索引构建算法/安装管线/判定/存储布局
├── DEVELOPMENT.md        ← 文档源规范（meta）：提交/代码/文档/测试/Changelog 总纲
├── CONTRIBUTING.md       ← 贡献指南：Fork/分支/提交/PR 流程/首次配置
├── GIT_HOOKS.md          ← Git Hook 规范：Hook 清单/分级机制/emoji 全覆盖/跨平台
├── RELEASE.md            ← 发布规范：版本号/签名 Tag/Release 正文/维护者签名 key 管理
├── CODING_STANDARDS.md   ← 代码规范：注释/命名/错误处理/多端兼容/安全
├── TESTING.md            ← 测试规范：金字塔架构/覆盖率/e2e 策略/workspace 陷阱
├── FEEDBACK.md           ← 安装反馈系统规范：模板/诊断字段/脱敏机制/隐私边界
├── CHANGELOG.md          ← 版本迭代记录（双语）
├── SKIN-MANIFEST-SPEC.md ← 皮肤清单格式规范（实现：lib/skin-manifest.js）
├── SKIN-MANIFEST-RECORD.md ← 皮肤清单维护记录（生成器输出/验证）
├── REFERENCE-PROJECTS.md ← 参考项目记录（平行生态/可借鉴的外部项目）
└── LIB-ISSUES.md         ← 测试发现的 lib API 问题（待商讨提交 upstream）
```

## 层级规则

| 层级 | 职责 | 文件 |
|---|---|---|
| **L0 索引** | 导航入口、persona 分流、层级说明、维护流程 | `docs/README.md` |
| **L1 源规范（meta）** | 全仓库行为总纲，冲突时最高优先 | `docs/DEVELOPMENT.md` |
| **L2 专项规范** | 单一领域的详细规则 | `docs/SECURITY.md`、`docs/HTTP-API.md`、`docs/ARCHITECTURE.md`、`docs/USAGE.md`、`docs/GIT_HOOKS.md`、`docs/CODING_STANDARDS.md`、`docs/TESTING.md`、`docs/FEEDBACK.md`、`docs/RELEASE.md`、`docs/SKIN-MANIFEST-SPEC.md` |
| **L3 执行层** | 纯函数实现（可测）、Hook、脚本 | `scripts/hooks/*.mjs`、`scripts/toc.mjs` |

**规范冲突解决**：L1 > L2 > 项目 README > 社区惯例。新增规范先在 L1 确立，再细化到 L2。

**单一事实源**：每个事实只在一个文档里展开；其他文档用链接指向，不复制段落（防止 README 瘦身后再长回第二份手册）。

## 文档命名约定

- `SCREAMING-KEBAB.md`（全大写 + 连字符：`HTTP-API.md`、`REFERENCE-PROJECTS.md`）——与既有文档保持一致
- 每文档必须包含 TOC（`<!-- TOC -->` 占位，由 `scripts/toc.mjs` 生成）
- 双语规范：需对外发布的文档提供 `.en.md` 镜像（见下节）

## 双语镜像管理

- **中文为唯一源**（source of truth），`.en.md` 为镜像：先写中文、内容定稿后再翻译
- **镜像范围**：用户向文档配镜像——根 `README.md`/`README.en.md`、`STANDARD.md`/`STANDARD.en.md`，以及新增文档中面向使用者的篇目（`USAGE.md`/`HTTP-API.md` 定稿后补 `.en`）；内部规范文档（TESTING/GIT_HOOKS/DEVELOPMENT 等）保持单语
- **一致性守卫**：配对文档的 `##` 节区结构与锚点由单测断言同构（见 `scripts/tests/unit/doc-mirror-parity.test.mjs`），防止双语漂移
- README 的摘要与折叠块只写结论；展开内容链接到对应 docs/ 文档，不在两处各写一份

## 维护流程

1. 新规范 → 先在 `docs/DEVELOPMENT.md` 确立（L1）
2. 细化 → 新建 `docs/` 专项文档（L2），更新本索引
3. 落地 → 实现为纯函数 + unit 断言 + Git Hook
4. 验证 → `node scripts/toc.mjs --check` + `node scripts/tests/run.mjs` + pre-commit hook
