# 更新日志 / Changelog

本仓库的版本迭代记录。**v1.0.0 之前的版本均为 beta 系列**（开发期迭代，未单独打 tag）。/ Version history of this repository. **All versions before v1.0.0 are part of the beta series** (development iterations, not individually tagged).

---

## Unreleased / v1.4.0（插件分类 / Plugin categories）

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
