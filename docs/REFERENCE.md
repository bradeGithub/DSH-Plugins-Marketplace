# 参考项目记录（Reference Projects）

本文件记录与本插件市场**平行生态/可借鉴**的外部项目，供设计参考，不构成依赖或合作承诺。

<!-- TOC -->
- [GoRaven](#goraven)
<!-- /TOC -->

## GoRaven

- **仓库**：https://github.com/8treenet/goraven
- **定位**：开源、自部署、团队向的 AI Agent 平台（"AI Harness"）——Agent 不只聊天，能读写文件、跑代码、调 API、检索知识库、产出报告
- **技术栈**：Go 1.25+ 后端 + React 18 / TypeScript / Tailwind 前端，Docker 就绪，Apache-2.0
- **规模（2026-09-08 核查）**：637 star、11 fork、8 open issues，2026-06-15 创建（<3 个月），活跃更新中
- **与 DSH 插件市场的关系**：平行生态/同类竞品，非上下游依赖。它也有 **Skill Marketplace**（prompts/scripts/workflows 打包成 skills，一键安装、集中维护、团队共享），理念与 DSH 的 skills 索引 + 一键安装高度重合，但实现是独立 Go 平台，与 DSH 的 Node/零依赖插件无技术关联
- **可借鉴点**：若未来 DSH 插件市场要做「团队共享/集中维护」能力，可参考其技能市场设计
- **How to apply**：不主动参与其生态、不深挖；仅作设计参考
