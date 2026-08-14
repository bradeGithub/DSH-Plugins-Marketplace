# 更新日志 / Changelog

本仓库的版本迭代记录。**v1.0.0 之前的版本均为 beta 系列**（开发期迭代，未单独打 tag）。/ Version history of this repository. **All versions before v1.0.0 are part of the beta series** (development iterations, not individually tagged).

---

## v1.3.4 — 2026-08-14（更新检测修复 + 启动自检 / Update detection fix & startup self-check）

- **更新检测改用 registry 版本号**：`latestVersion` 不再只依赖本地安装缓存（缓存只在安装动作时重建——手动安装的插件永远不提示更新、正常安装的插件也发现不了新版本）；构建期从各仓库 `package.json` 抓取 `version` 写入索引（CI 每 2 小时刷新），列表直接对比真实最新版 / update detection now uses registry versions: `latestVersion` no longer relies solely on the local install cache (which is only refreshed during installs — manually installed plugins never got update hints, and normally installed ones missed new releases); the build captures each repo's `version` from its `package.json` into the index (refreshed by CI every 2h), and the list compares against the real latest version
- **启动自检市场本体更新（小优待）**：每次 DSH 启动直链 GitHub 查询插件市场本体最新版本（contents API 实时读取，不过 CDN 缓存），有更新时在市场页顶部显示「插件市场有可用更新：v{old} → v{new}」提示条；打开页面超过 30 分钟未检查会顺带重查 / startup self-check (perk): every DSH launch queries GitHub directly for a newer marketplace version (contents API, no CDN cache); when available, a banner at the top of the marketplace page shows «Marketplace update available: v{old} → v{new}»; opening the page re-checks when the last check was over 30 minutes ago

## v1.3.3 — 2026-08-14（插件分类上线 + 安装健壮性修复 / Categories & install robustness fixes）

- **插件分类**：registry 构建时按 description + name + 过滤后的 topics 做关键词规则分类（零额外 API，无需读 README），输出 `category` 字段（vision / document / memory / model / notify / coding / conversation / web-ui / agent / tool / resource / other）——生态泛标签（ai-agent/llm/deepseek 等）不参与分类，规则按优先级匹配，无法分类的归「其他」/ plugin categories: built into the registry at build time from description + name + filtered topics (zero extra API calls, no README reading) — `category` field (vision/document/memory/model/notify/coding/conversation/web-ui/agent/tool/resource/other); ecosystem-wide tags (ai-agent/llm/deepseek…) are excluded, rules match by priority, unmatched repos go to «other»
- **前端分类筛选**：DSH 插件 tab 新增分类 chips（全部 + 12 类），点击筛选，可与搜索词联合过滤；卡片名称旁显示分类徽章 / category filter chips added to the plugins tab (All + 12 categories), combinable with the search box; cards show a category badge
- **修复分类筛选全部匹配 0**：服务端 `normalizeRepo` 未透传 registry.json 的 `category` 字段，导致客户端每个插件都按「其他」处理——点击任一具体分类均显示「匹配 0 个」，卡片分类徽章也全部消失；现已透传并做 12 类白名单校验 / category filter matched 0 for every category: the server's `normalizeRepo` dropped the `category` field from registry.json, so every plugin fell back to «other» — every category chip matched nothing and card badges vanished; the field now passes through with a 12-key whitelist check
- **分类空态文案**：仅按分类筛选（搜索框为空）时显示「该分类下暂无插件」，不再出现「没有匹配「」的插件」/ category-only empty state now shows «No plugins in this category» instead of a message with empty quotes
- **包名冲突与源码型插件修复**（漏洞发现与修复方案由 **bubble-w8** 提供，见 PR #3；修复经评审并结合进本仓库）：/ pkg-name conflicts & source-only plugins fixed (vulnerability report and fix design by **bubble-w8**, PR #3; merged after review):
  - **pkg_name 冲突消解**：同名 npm 包在 node_modules 安装目标互斥——列表只保留一个（已安装优先，其次 Star 高者），索引构建期同步去重（40+ 组冲突实测归零）；「已安装」识别之后再去重，避免隐藏手动安装的低 Star 仓库 / pkg_name conflict resolution: same-name npm packages share one node_modules target — only one entry is kept (installed first, then higher stars), dedup also applied at index build time (40+ conflict groups measured to zero); dedup runs after installed-detection so manually installed low-star repos stay visible
  - **源码型插件构建**：只提交源码（main / client bundle 缺失，含 conditional exports 形态）的插件安装前弹窗确认，允许则 pnpm/npm 装依赖并执行 build；构建路径不清洗 `link:`/`workspace:` 依赖（pnpm 原生支持，清洗会破坏 monorepo 构建）/ source-only plugin builds: plugins shipping source only (missing main / client bundle, including conditional-exports shapes) ask for confirmation and run `install && build`; the build path keeps `link:`/`workspace:` deps intact (pnpm-native, stripping them breaks monorepo builds)
  - **scoped 包 YAML 引号**：`@scope/name` 包名注册到 cordis.patch.yml 时自动加引号（plain scalar 非法），`hasPatchEntry` 兼容引号形式防重复注册 / scoped-package YAML quoting: `@scope/name` entries are quoted when registered into cordis.patch.yml (plain scalars are invalid); `hasPatchEntry` accepts quoted forms to avoid duplicate registrations

## v1.3.2 — 2026-08-14（安装体验升级 + 第三方生态 / Guided installs & third-party ecosystem）

- **多 Skill 仓库一键安装**：自动发现仓库根目录与子目录中的全部 `SKILL.md` 并逐个安装（`anthropics/skills` 等合集仓库不再只装一个或误判为文档）；完成时显示「已安装 N 个 Skills」/ multi-Skill install: every `SKILL.md` in the repo root or subdirectories is discovered and installed one by one (collection repos like `anthropics/skills` are no longer misjudged); completion shows «N Skills installed»
- **安装面板居中弹层**：安装进度改为固定居中浮层 + 动画进度条，不再把页面滚到顶部；运行中隐藏「返回列表」按钮 / the install panel became a fixed centered overlay with an animated progress bar (no scroll-to-top); the back button is hidden while running
- **确认式安装**：Skill / Agent 预设不再误扫 README 示例索要 API Key——只有真正执行脚本或安装插件时才检查环境变量；「提交材料」改为「安装前确认」，纯选项问题点击选项即提交 / confirm-before-install: skills and presets no longer scan README examples for API keys — env checks run only for scripts/plugins; «submit materials» became «confirm before install», option questions submit on click
- **第三方生态条目**：README 新增「第三方生态」小节（Harness Desktop——社区 Windows 桌面版，稳定版内置本市场；作者关联与官方无关性均已披露），由作者提交 PR 经评审合并 / README gained a «Third-party ecosystem» section (Harness Desktop — community Windows desktop app whose stable release embeds this marketplace; affiliation disclosed), submitted by the author and merged after review
- **测试接入 CI**：guided-install 冒烟测试并入 CI 语法检查步骤 / guided-install smoke tests wired into the CI syntax-check step

---

## v1.3.1 — 2026-08-14（插件列表全量修复 + 插件分类 / Full plugin registry fix & categories）

- **插件列表突破 1000 条上限**：`registry.json` 从 999 条扩展至 **1500+ 条**（实测 1552）——dsh 模式此前沿用单 query 分页，被 GitHub Search API 单 query 1000 条硬上限截断（且把截断误判为「完整」）；v1.3.1 起 dsh / skills 模式统一使用「stars 分段 + 时间窗口二分」全量抓取，插件市场与 GitHub 实况对齐 / plugin list now exceeds 1000: `registry.json` grew from 999 to **1500+ repos** (1552 measured) — the dsh build previously used single-query pagination, silently truncated by the Search API 1000/query cap (and mislabeled as complete); since v1.3.1 both dsh and skills modes use the «stars segments + time-window bisection» full crawl, aligning the marketplace with GitHub
- **部分结果不再冒充完整**：分段抓取单页失败（限流/网络）标记 `failed` 并停止分裂，索引标记 `partial-merge` 且保留旧条目合并，杜绝截断数据标成 `full` / partial results are no longer labeled complete: segment page failures (rate limit/network) flag `failed` and stop splitting, the index becomes `partial-merge` and keeps old entries — truncated data can never claim `full`
- **插件分类**：registry 构建时按 description + name + 过滤后的 topics 做关键词规则分类（零额外 API，无需读 README），输出 `category` 字段（vision / document / memory / model / notify / coding / conversation / web-ui / agent / tool / resource / other）——生态泛标签（ai-agent/llm/deepseek 等）不参与分类，规则按优先级匹配，无法分类的归「其他」/ plugin categories: built into the registry at build time from description + name + filtered topics (zero extra API calls, no README reading) — `category` field (vision/document/memory/model/notify/coding/conversation/web-ui/agent/tool/resource/other); ecosystem-wide tags (ai-agent/llm/deepseek…) are excluded, rules match by priority, unmatched repos go to «other»
- **前端分类筛选**：DSH 插件 tab 新增分类 chips（全部 + 12 类），点击筛选，可与搜索词联合过滤；卡片名称旁显示分类徽章 / category filter chips added to the plugins tab (All + 12 categories), combinable with the search box; cards show a category badge

## v1.3.0 — 2026-08-14（全量 Skills 索引 / Full skills index）

- **全量 skills 索引**：`skills.json` 从 1867 条扩展至 **11000+ 条**——GitHub Search API 单 query 硬上限 1000 条、topic 页爬虫也被限制 50 页，因此改用「**stars 分段 + 时间窗口二分**」突破限制取全量：按 star 数分段查询（`stars:>=1000` / `100..999` / `10..99` / …），段拉满 1000 条即对半分裂，单值段（如 `stars:0`）按 `pushed` 时间窗口二分（窗口窄于 30 天即接受部分结果）；段内 0 新增直接收敛避免无谓查询 / full skills index: `skills.json` grew from 1867 to **11,000+ repos** — since both Search API (1000/query) and topic-page crawling (50 pages) are capped, we now use «stars segments + time-window bisection»: query by star ranges, bisect segments that fill 1000, bisect single-value segments (e.g. `stars:0`) by pushed time windows (accept partial results below 30-day granularity); segments with 0 new repos converge early
- **冷启动预算**：全量拉取约 1.5 小时（Search 30/min 限额是主要瓶颈）；`has_skill` 探测按 Core API 5000/h 额度护栏分批，CI 每 2 小时增量续跑直至全量探测完成（未探测仓库显示「未验证」）/ cold-start budget: ~1.5h for the full fetch (Search 30/min is the bottleneck); `has_skill` probing batches under the 5000/h Core quota guardrail, CI resumes incrementally every 2h until all repos are probed
- **探测分支回退**：爬虫来源已移除（GitHub 未认证 topic 页限制 50 页/1000 条），Trees 探测增加 main→master 分支回退（Search 数据自带 default_branch，爬虫数据没有）/ branch fallback main→master added to Trees probing (crawler source removed; Search data carries default_branch)
- **增量更新机制**：CI 每 2 小时以 `INCREMENTAL_DAYS=3` 增量拉取（只拉最近 3 天 pushed 的仓库——新仓库/star/更新时间变化全部捕获，几分钟完成，实测 1867→12665 条的索引增量轮次 2 分钟）；每天 04:00 UTC 全量重建刷新 star 数；`workflow_dispatch` 支持 `full=true` 手动全量 / incremental updates every 2h (`INCREMENTAL_DAYS=3`, only repos pushed in the last 3 days — new repos and star/updated changes are all captured, ~2 min per run); full rebuild daily at 04:00 UTC to refresh star counts; `workflow_dispatch` with `full=true` triggers a manual full build

---

## v1.2.0 — 2026-08-14（Skills 栏目 + 安装安全强化 / Skills column & install hardening）

- **通用 Skills 栏目（完整上线）**：设置页新增 tab「DSH 插件 | 通用 Skills」——`GET /api/marketplace/skills` 路由 + `skills.json` 全量索引构建器（`SOURCES_MODE=skills` 拉取 `topic:agent-skills` ∪ `topic:claude-skills` 并集，Trees API 探测 `has_skill` / `has_install_script`，truncated 大仓库标 null 不误判，增量继承 + 断点快照续跑 + 额度护栏）；前端分页触底加载（每页 60 + IntersectionObserver）、搜索、🛡 含安装脚本角标、「未验证」弱提示，安装复用现有 skill 流程 / Skills column fully shipped: new «DSH Plugins | General Skills» tabs — `/api/marketplace/skills` route + `skills.json` builder (multi-topic union, Trees probing, incremental inheritance, rate-limit guardrail); front-end paginated infinite scroll (60/page + IntersectionObserver), search, 🛡 install-script badge, «unverified» hint; install reuses the existing skill pipeline
- **索引当前覆盖 1867 个仓库**：受 GitHub Search API 单 query 硬上限 1000 条约束（两个 topic 各取最新 1000 条并集）；**v1.3 计划全量索引**（topic 页爬虫等）/ registry covers 1867 repos — Search API caps at 1000 results/query; full index planned for v1.3
- **全局安装互斥**：同一时刻只允许一个安装任务，其余安装按钮全部禁用（客户端）+ 服务端 409 兜底，从源头杜绝并发安装竞态 / global install mutex: one install at a time, all other buttons disabled + server-side 409
- **非插件仓库弹窗**：`package.json` 未声明 DSH 插件能力的仓库（聚合页 / 桌面应用 / 普通 npm 项目，如 awesome-*、iPolloWork）安装前弹窗告知「非插件，建议自行安装」，可选强制安装或取消 / non-plugin repo detection: repos without DSH plugin declaration get a confirmation dialog (install manually or force-install)
- **无可自动安装内容弹窗**：awesome 聚合页等改为弹窗展示 README 摘要 + 可点击仓库链接 / repos with no auto-installable content now show a dialog with README excerpt + clickable repo link
- **第二轮代码审查残留问题全部修复**（对应 `review.md` 的 R1/R2/R3 + m1–m6 + n2–n5）：/ all second-round review findings fixed (R1–R3, m1–m6, n2–n5):
  - **R1 DNS rebinding**：安装端点由「Origin===Host」改为 **Host 白名单校验**——仅放行本机回环（localhost/127.0.0.1/[::1]）、局域网私有网段（10/8、172.16/12、192.168/16）与 `DSH_MARKETPLACE_ALLOWED_HOSTS` 显式配置的主机，攻击者域名（含 rebinding 到 127.0.0.1 的域名）一律拒绝 / install endpoint now validates the Host against an allowlist (loopback / private LAN ranges / `DSH_MARKETPLACE_ALLOWED_HOSTS`) — attacker domains, including DNS-rebinding ones, are always rejected
  - **R2 环境变量最小化**：第三方安装脚本只获得**基础系统变量白名单**，npm 安装剔除全部密钥类变量（TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL）——`process.env` 不再全量外泄给第三方代码 / third-party scripts get a minimal env allowlist; npm installs strip all secret-class vars — `process.env` is no longer leaked wholesale
  - **R3 环境变量「空值可跳过」真正生效**（键存在即视为已提供），并顺带修复连带 bug：此前二次提交时用户填写的密钥不在 env 白名单里、插件实际拿不到 / empty-value skip now works (key presence decides), plus the related bug where user-submitted secrets never reached the plugin env
  - **m1** 列表标注改索引写入，恢复「按 Star 降序」的稳定顺序；**m2** 仅当已装版本**严格低于**最新版本才提示「更新」（仓库回滚不再误报）；**m3** 原 per-repo 安装锁升级为**全局安装互斥**（见上，任何并发安装都被拒绝）；**m4** patch 写入失败如实报错，不再误显示「已存在条目，跳过注册」；**m5** `installed.json` 写入串行化，并发安装不再互相覆盖；**m6** 外部 fetch 加 15 秒超时，CDN 挂起不再卡死列表服务
  - **n2** 403/413 错误文案接入 i18n；**n3** 预发布版本按段数字比较（`rc.10 > rc.9`）+ 支持一位/两位版本号；**n4** 请求体 Buffer 收集后一次解码；**n5** 客户端展示 403/409 的真实拒绝原因
- **冒烟测试**：`scripts/smoke-tests.mjs`（70 项断言，覆盖 R1/R2/n3/探测/继承/非插件判定），CI 语法检查步骤同步执行 / smoke tests (70 assertions) added and wired into CI
- **先装插件后装市场也能识别**：打开市场即自动扫描已安装的 cordis 插件（含 scoped 包 `@scope/name`），通过包名映射 + `repository` 双向校验与市场仓库比对，命中即标「已安装」/ plugins installed before the marketplace are now auto-detected on open: scans installed cordis packages (including scoped ones) and reconciles them against market repos via package-name mapping + bidirectional `repository` checks
- **DSH 官方插件清单**：运行时自动枚举 `@deepseek-ai/*` 官方包（含兜底清单），官方插件永远不会被当成或误标为用户安装的市场插件 / DSH official plugin list (runtime-enumerated `@deepseek-ai/*` plus fallback): official plugins are never treated as user-installed market plugins
- **索引携带包名（pkg_name）**：registry CI 构建时抓取各仓库 package.json 的 name，用于包名与仓库名不一致时的关联 / registry now carries each repo's package name (`pkg_name`) for robust repo↔package association

---

## v1.1.0 — 2026-08-14（体验优化 / UX improvements）

- **已安装置顶**：打开市场时自己已安装的插件排在列表最前面，其余按 Star 数降序；安装成功后卡片立即跳到顶部，无需刷新 / Installed plugins are listed first when opening the marketplace, the rest sorted by stars; a freshly installed card jumps to the top immediately
- **点击安装自动滚动到页首**的安装进度面板（阶段切换触发，日志刷新不打扰）/ auto-scroll to the install panel at the top when starting an install (triggered on phase change only)
- **pnpm 本地链接依赖兼容**：剥离 `link:` / `workspace:` 协议依赖后再 npm install（修复 `EUNSUPPORTEDPROTOCOL`），运行时由 DSH 宿主提供 / strips pnpm-only `link:`/`workspace:` dependencies before `npm install` (fixes `EUNSUPPORTEDPROTOCOL`); runtime resolution provided by the DSH host
- **npm 生命周期脚本确认弹窗**：`prepare` / `install` / `postinstall` 等脚本执行前征求确认——允许则按授权执行（带回退链），拒绝则取消并清空全部痕迹 / confirmation dialog for npm lifecycle scripts — «Allow» runs them as authorized (with fallback chain), «Deny» cancels and cleans up all traces
- **API Key 输入框改密码模式**、请求体上限、CSRF 自定义头校验等安全细节 / password-mode secret inputs, request body limit, CSRF custom-header check

---

## v1.0.0 — 2026-08-14（正式版 / Stable）

- 🎉 首个正式版本发布 / First stable release
- 新增社交预览封面（1280×640 分享图）/ Social preview image added
- README 增加徽章组（DeepSeek Harness 生态 / Stars / License / Registry CI / Last Commit / i18n）/ README badge group added
- 发布 GitHub Release v1.0.0 / GitHub Release v1.0.0 published

---

## v0.9.0-beta — 2026-08-14（安全加固 / Security hardening）

基于独立代码审查完成全面加固 / Hardened after an independent code review:

- **CSRF 防护**：安装端点校验自定义头 `X-DSH-Marketplace` + Origin 必须与 Host 一致，阻止恶意网页伪造"脚本确认"静默安装 / CSRF protection: custom header + Origin check on the install endpoint
- **包名白名单与路径包含校验**：`pkg.name` 按 npm 命名规则校验，目标路径必须在 profile node_modules 内，杜绝路径穿越 / 任意目录删除 / YAML 注入 / Package-name whitelist + path containment (no path traversal / arbitrary delete / YAML injection)
- **环境变量键白名单**：`answers` 只放行扫描确认的变量名，`__` 内部键不进环境，防止 PATH/HOME 劫持 / env key whitelist for `answers`
- **依赖脚本默认不执行**：`npm install` 默认 `--ignore-scripts`，第三方 prepare/install 脚本不再静默运行 / npm deps installed with `--ignore-scripts` by default
- **URL 协议校验**：`html_url` 仅放行 `https://github.com`，杜绝 `javascript:` XSS 向量 / URL protocol validation against `javascript:` XSS
- **并发互斥**：同一仓库安装加锁（重复请求 409），patch 写入串行化 + 临时文件原子 rename / per-repo install lock + atomic patch writes
- **请求体上限**：1 MB 超限返回 413，防内存耗尽 / 1 MB request body limit (413)
- **注册判定行级精确匹配**：`name: <pkg>` 按行匹配，前缀包名不再误判已注册 / exact line-based patch matching
- **密钥输入框改密码模式** / secret inputs now use `type="password"`
- **列表检测并行化**（并发 12）/ parallel installed-detection (concurrency 12)
- **语义化版本比较**：`1.0.0 > 1.0.0-rc.1` 判断正确 / semver-aware version comparison
- **环境变量检测增强**：支持 camelCase 形态，`BY_PASS` 等词不再误伤 / improved env-var scan (camelCase), no more `BY_PASS` false positives
- **registry 陈旧条目清理**：partial 合并时超过 14 天未出现的仓库自动剔除 / stale registry entries pruned after 14 days
- **CI 语法检查步骤** / syntax-check step added to CI

---

## v0.8.0-beta — 2026-08-14（Windows 安装管线修复 / Windows install pipeline fixes）

- **修复 `spawn npm ENOENT` / `EINVAL`**：Windows 上 `execFile` 无法启动 npm 的 `.cmd` 批处理，改用 `node.exe + npm-cli.js` 直接启动，不依赖 PATH / fixed `spawn npm ENOENT`/`EINVAL` by launching `node.exe + npm-cli.js` directly
- **依赖安装回退链**：peer 冲突自动改 `--legacy-peer-deps`（DSH 宿主已提供 `@deepseek-ai/*` peer）/ dependency fallback chain with `--legacy-peer-deps`
- **cordis 插件保留 `node_modules`**：带依赖的插件复制时不再排除依赖目录 / cordis plugins keep their `node_modules`
- **安装记录先写盘再入内存**：持久化失败不再留下脏的"已安装"状态 / install records persist before committing to memory
- **安装失败自动清理缓存**：失败不再残留克隆目录 / failed installs clean up their clone cache

---

## v0.7.0-beta — 2026-08-13（免责声明 / Disclaimer）

- 新增免责声明：插件均来自第三方 GitHub 仓库，与 DSH 插件市场无关，市场不作任何担保，安装风险自担 / Disclaimer added: plugins come from third-party repos, not affiliated with the marketplace; AS-IS, no warranty
- 免责声明同步展示在市场页面底部（中英双语）/ disclaimer also shown at the bottom of the marketplace page (bilingual)

---

## v0.6.0-beta — 2026-08-13（静态索引与规模扩展 / Static registry & scaling）

- **registry.json 静态索引**：插件列表优先从 CDN（jsDelivr）加载，零 GitHub API 调用、零限流 / static `registry.json` served via CDN — zero API calls, zero rate limits
- **GitHub Actions 自动重建**：每 2 小时生成并提交索引（当前收录 450+ 插件）/ CI rebuilds the registry every 2 hours (450+ plugins indexed)
- **搜索 API 兜底**：索引不可用时自动回退 / search-API fallback when the registry is unreachable
- **手动立即更新**：`update-registry.ps1 / .sh / .bat` 随时触发重建，无需等定时 / manual refresh scripts trigger an immediate rebuild
- **兜底搜索支持 GH_TOKEN**，上限提升至 5000 仓库 / fallback search honors GH_TOKEN, cap raised to 5000 repos

---

## v0.5.0-beta — 2026-08-13（一键安装 / Quick install）

- 仓库内置 `install.ps1` / `install.sh` 自安装脚本（支持直接运行、`irm | iex`、被市场执行三种模式）/ self-install scripts (`install.ps1` / `install.sh`) with three run modes
- README 新增「一键安装」：一条命令或一句话交给 AI 即可安装 / one-command or hand-it-to-an-AI install

---

## v0.4.0-beta — 2026-08-13（UI 修复 / UI fixes）

- **修复 busy 标志全局化**：一个安装进行中时所有按钮一起变「安装中...」→ 现在只有正在安装的仓库显示 / fixed global busy flag — only the installing repo shows «Installing...»
- **过期响应守卫**：并发安装时旧请求不再覆盖新面板 / stale install responses no longer clobber the active panel

---

## v0.3.0-beta — 2026-08-13（中英双语 / Bilingual）

- 界面与安装日志接入 DSH locale 服务，跟随 设置 → 常规 → Language 切换 / UI and install logs follow DSH's language setting (Settings → General → Language)
- 修复 locale 接入方式：改用官方 `inject: ["slots", "locale"]` 注入，DSH 设英文后界面正确切换 / switched to the official locale injection pattern
- README 中英双版（`README.md` / `README.en.md`）与切换横幅 / bilingual READMEs with a language switcher

---

## v0.2.0-beta — 2026-08-13（已安装识别强化 / Installed detection）

- **四重判定**：安装清单 + 目录启发式（含原始仓库名）+ 包名映射扫描 + 本体 `repository` 自识别 / four-way detection: manifest + directory heuristics + package-name mapping + self-identification
- 修复仓库名与包名不一致时误判（如 `DSH-Plugins-Marketplace` → `dsh-plugin-marketplace`）/ repos whose name differs from the package name are now recognized
- 已装版本号正确读出 / installed versions read correctly

---

## v0.1.0-beta — 2026-08-13（首个可用版本 / First usable version）

- 从 GitHub `topic:dsh-plugin` 分页拉取全部插件，按 Star 排序，10 分钟缓存 / pages all `topic:dsh-plugin` repos, sorted by stars, 10-min cache
- 一键安装：自动识别 skill / agent 预设 / cordis 插件 / 安装脚本四类 / one-click install with automatic type detection (skill / agent preset / cordis plugin / install script)
- 环境变量材料介入（安装暂停等待用户提供，可跳过）/ env-var input interception (pauses install for user material, skippable)
- 脚本执行确认（安全提示）/ third-party script confirmation dialog
- 版本检测与「更新」按钮 / version detection and «Update» button
- 搜索 / 刷新反馈 / GitHub 原链 / 深浅色适配 / search, refresh feedback, GitHub links, dark/light themes
