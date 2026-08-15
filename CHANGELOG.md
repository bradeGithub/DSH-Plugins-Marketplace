# 更新日志 / Changelog

本仓库的版本迭代记录。**v1.0.0 之前的版本均为 beta 系列**（开发期迭代，未单独打 tag）。/ Version history of this repository. **All versions before v1.0.0 are part of the beta series** (development iterations, not individually tagged).
---

## v1.4.4 — 2026-08-15（修复:满屏「未验证」+ 徽章不显示 + git 网络错误分类 / Fixes: unverified badges everywhere, missing badges & git network error classification）

**修复批次（issue #19/#20/#21 反馈闭环产出 + 实测回归）**：市场本体更新到 v1.4.3 后的五个问题一次修复 / a fix batch from the feedback loop and real-world regression: five issues found after the v1.4.3 release

- **修复插件市场满屏「未验证」（issue #21 截图确认）**：`normalizeRepo` 把插件市场（registry.json）条目也归一化出 `has_skill: null`——该字段本只属于 Skills 栏目（探测未知的弱化提示），导致整个插件市场 tab 每条都显示「未验证」徽章。现在仅 skills 模式输出三态（true/false/null），插件市场不再显示；实测插件市场 3283 条 0 条带该字段，Skills 栏目 null 仅 8 条不变 / the plugin-marketplace tab showed "unverified" on every card because `normalizeRepo` stamped `has_skill: null` onto registry entries that never had the field (it belongs only to the Skills tab's unknown-probe hint); now only skills mode carries the tri-state field — 0/3283 marketplace entries affected, Skills tab unchanged
- **修复「已验证安装」等徽章不显示（实测回归）**：`normalizeRepo` 未透传构建期盖章字段 `market_tags` / `installable`——列表接口把它们丢掉，前端「✓ 已验证安装」「仅手动安装」「非 DSH 插件」徽章从未显示。补透传后 dsh-market / dsh-web-ui / dsh-anchored-standard / 市场本体 / archify / dsh-deep-whale / dsh-tdai-memory 全部显示徽章 / `normalizeRepo` dropped the build-time stamp fields `market_tags` and `installable`, so the "verified install", "manual only" and "not a plugin" badges never rendered; now passed through — all seven verified repos show their badge
- **修复老安装记录「编辑」无 env 键（实测回归）**：v1.4.3 之前安装的记录没有 `envKeys` 字段，编辑弹窗无键可配；现在从已安装的包目录重新扫描 API KEY 形态键名（dsh-balance-monitor 实测重扫出 `DEEPSEEK_API_KEY`）/ install records created before v1.4.3 lack `envKeys`, leaving the edit dialog empty; the env-keys endpoint now rescans the installed package directory (dsh-balance-monitor resurfaces `DEEPSEEK_API_KEY`)
- **修复 git clone 网络失败误报「构建失败」（issue #21）**：用户无法直连 github.com 时（`Failed to connect to github.com port 443`）错误被归类为「构建/包管理命令失败」，误导排查；新增 git 网络错误识别（置于 Command failed 之前），提示检查网络 / 配置 git 代理（附 Windows 示例）/ git clone network failures (no direct github.com access) were misreported as build failures; a dedicated network rule now fires first with proxy configuration guidance
- **人工验证徽章 +2（反馈闭环）**：dsh-deep-whale（issue #19）、dsh-tdai-memory（issue #20）加入「✓ 已验证安装」/ two more verified-install badges from user feedback
- **回归测试**：smoke 191 / 单元+集成 121 / e2e 152 全绿 / full suite green

## v1.4.3 — 2026-08-15（已安装插件环境变量编辑 / Edit env vars of installed plugins）

**新功能（issue #18）**：安装后没有入口重新配置 API KEY 等环境变量的问题——已安装卡片新增「编辑」按钮，补填/修改环境变量，重启 DSH 生效。 / new "Edit" button on installed cards lets you add or change environment variables (API keys) after installation, taking effect on the next DSH restart.

- **编辑按钮**：已安装卡片（插件市场与 Skills 双栏目）新增「编辑」→ 弹窗列出该插件安装时扫描到的 env 键名（值不回显，已配置打标），可补填/修改/删除，也可手动添加键 / installed cards now show an Edit button opening a dialog with the plugin's scanned env keys (values never echoed back; configured keys are marked), supporting add / modify / remove and manual key entry
- **值存储与生效**：值写入市场本地 `envs.json`（不随备份导出）+ 合并写入 `~/.dsh/.env`（dsh user 层，`loadLayeredEnv` 每次启动注入 process.env）——重启 DSH 后生效；安装记录保存 env 键名白名单（只存键名，保持「备份不含密钥」承诺） / values are stored in the marketplace-local `envs.json` (excluded from backups) and merged into `~/.dsh/.env`, the dsh user env layer injected at every startup — effective after a DSH restart; install records keep an env-key whitelist (names only, honoring the no-secrets-in-backups promise)
- **安全**：键名格式校验（UPPER_SNAKE / 驼峰 API 键形态）、`DSH_` 保留前缀拒绝、未安装 404、单次上限 16 键 / key names are format-validated, the reserved `DSH_` prefix is rejected, uninstalled repos get 404, and at most 16 keys per save
- **回归测试**：e2e +9（404 / 非法键 / 保留前缀 / 落盘 / 值不回显 / 未安装空列表）；smoke 191 / 单元+集成 113 / e2e 151 全绿 / 9 new e2e cases; full suite green (smoke 191 / unit+integration 113 / e2e 151)

## v1.4.2 — 2026-08-15（hotfix：修复安装反馈弹窗导致市场白屏 / hotfix: fix marketplace blank screen from the feedback dialog）

**紧急修复**：v1.4.1 引入的安装反馈弹窗在部分环境下使插件市场整页空白——`fbDismissed`（「稍后再说」会话标记）的模块级声明在编辑时未落盘，`useEffect` 读取未声明变量抛 `ReferenceError`，React 组件树崩溃。本版补上声明并回归验证。 / v1.4.1's install-feedback dialog could blank out the whole marketplace: the module-level declaration of `fbDismissed` (the "later" session flag) was lost during editing, so the effect read an undeclared variable and React crashed. Declaration restored and the full suite re-verified.

- **修复**：补回 `fbDismissed` 模块级声明（`lib/client.js`），mock 浏览器环境执行 client 工厂无运行时异常；新增引用的 25 个标识符逐一核对均有声明 / restored the missing module-level declaration; the client factory runs clean in a mocked browser environment and every new identifier was verified declared
- **回归测试**：smoke 191 / 单元+集成 111 / e2e 140 全绿 / full suite green

## v1.4.1 — 2026-08-15（安装反馈闭环 + 人工验证标注 + 第三方 CLI 接入提示 / Install-feedback loop, curated verification tags & third-party CLI integration hints）

**小版本迭代**：安装体验闭环——装完问用户、反馈进 GitHub issue；市场列表新增人工验证徽章；扫描器补上第三方 CLI 的 DSH 接入指令识别 / a minor release closing the install-feedback loop (ask after install, file results as GitHub issues), adding curated verification badges to the listing and recognizing third-party CLI integration commands in READMEs

- **安装反馈闭环（新）**：安装成功后登记待确认队列，下次打开插件市场弹出「插件 X 是否正常安装并运行?」——✓ 正常 / ✗ 不正常（可填备注）/ 稍后再说；提交后自动同步 GitHub issue（配置 Token 则自动创建，标题 `[安装反馈] ✅/❌: 仓库`、带 `install-feedback` label；未配置则打开预填好的新建 issue 页面，反馈一条不丢） / after each install a confirmation dialog appears the next time the marketplace opens; answers (works/broken + optional notes) are filed as GitHub issues automatically when a Token is configured, or via a pre-filled issue page otherwise
- **人工验证标注（新）**：`market_tags` 构建期注入——实测可一键安装的仓库盖「✓ 已验证安装」绿徽章（dsh-market / dsh-web-ui / dsh-anchored-standard / 市场本体 / archify），open-design 盖「需前置内容」橙徽章（需先装官方 dsh CLI 并经其自带 od CLI 接入）；人工实测优先于机器探测（dsh-web-ui 根目录非插件但官方聚合包实测可装，不再误盖「非 DSH 插件」） / curated `market_tags` stamped at build time: green "install verified" badges on repos proven to install one-click, orange "prereqs needed" on open-design; human verification overrides machine probing
- **第三方 CLI 接入指令识别（新）**：扫描 README 中 `<cli> agent setup deepseek-harness` 形式（如 Open Design 的 `od agent setup deepseek-harness`）——识别为官方接入方式并以安装日志提示，不代执行（需对方 daemon 在跑，且语义是接入 dsh 而非安装市场插件） / READMEs documenting DSH integration via another tool's own CLI (e.g. `od agent setup deepseek-harness`) are surfaced as official-method hints without being executed
- **测试残留自动清理（新）**：新增 `scripts/tests/cleanup.mjs` 并接入测试运行器——每次测试后自动删除 %TEMP% 下测试/验证产生的临时目录与文件（保留运行中 DSH harness 的近 7 天临时文件） / a cleanup script hooked into the test runner removes test leftovers from %TEMP% after every run (running harness temp files are kept)
- **回归测试**：smoke 191 / 单元+集成 111 / e2e 140 全绿 / full suite green

## v1.4.0 — 2026-08-15（官方 CLI 安装优先 + 嵌套预设 + 安装体验 / Official CLI-first install, nested presets & install experience）**里程碑版本**：1.3 系列 12 个迭代后的一次功能集结——安装方式、识别能力、排障体验三个方向同时升级 / a milestone release bundling the post-1.3 feature batch: install method, type detection and troubleshooting experience

- **README 官方 CLI 安装优先（新安装方式）**：克隆后解析 README 的 `dsh plugin install/add` 指令——存在则**直接执行官方 CLI 安装**（`dsh plugin --profile web <install|add> <目标>`，目标两级策略：本仓库包优先，否则采用 README 首条指令如聚合包），成功即完成、失败自动回退市场流程；`cli` 类型记录可正常卸载 / when the README offers an official `dsh plugin install/add` command, the installer now executes it directly (repo/package target preferred, otherwise the README's first command such as an aggregate package), falling back to the marketplace flow on failure; `cli`-type records are uninstallable
- **CLI 指令识别兼容 flags+包名写法**：`dsh plugin --profile web add dshmarket`（flags 在动词前、目标为 npm 包名）也能识别，返回整条指令 / the README scanner recognizes flags-before-verb and package-name forms
- **嵌套 agent 预设识别**：`findPresetRoots` 扫描子目录中的 `preset.yml + agent.cordis.yml`——预设目录在子目录的仓库（如 dsh-anchored-standard 的 preset/）从「非插件拦截」变为一键安装；多预设按目录名逐个装到 `~/.dsh/.agent-presets/`（`preset` 惯例目录用仓库名作 id），卸载按 names 逐个删防误删 / presets living in subdirectories are now detected and installed one-click (multi-preset repos install each variant; the conventional `preset/` dir takes the repo name as its id); uninstall removes per-name only
- **安装后有效性验证**：cordis 插件安装后检查可加载入口（main/lib/index.js/顶层 JS/纯 client 清单），缺失则明示「已安装但可能未生效」并随响应返回 warnings / post-install verification checks for a loadable entry and warns explicitly when missing
- **安装失败分类提示**：常见 npm/pnpm 错误（网络/EINTEGRITY/版本缺失/node-gyp/模块缺失/权限）翻译成双语排查建议，接入失败日志与响应 / common npm/pnpm failures are classified into actionable bilingual hints
- **脱敏日志导出**：近期操作日志环形缓冲 + `/api/marketplace/logs` 导出（主目录路径与密钥形态打码），客户端「导出日志」一键下载 / sanitized recent-operation log export for bug reports
- **回归测试**：smoke 187 / 单元+集成 105 / e2e 129 全绿 / full suite green

## v1.3.15 — 2026-08-15（README 官方 CLI 安装指令提示 / README CLI install hint）

- **安装时检查 README 的 `dsh plugin install <repo>` 指令**：克隆完成后扫描 README（含 README.en.md 等变体），发现指向当前仓库的官方 CLI 安装指令时——安装日志首行提示「README 提供官方 CLI 安装指令」（与市场安装等效，二选一）；完成/手动响应携带 `cliCommand`，安装面板显示**可一键复制**的指令块（clipboard API 失败自动降级 execCommand）/ the installer now scans the cloned README for a `dsh plugin install <repo>` command targeting the current repo: a hint line is logged and the done/manual response carries `cliCommand`, rendered in the install panel as a copyable snippet with clipboard fallback
- **安全与正确性**：只识别指向当前仓库的指令（大小写不敏感，兼容 `dsh plugin add`、完整 URL / `.git` 后缀写法），README 里其他仓库的示例不会误提示 / only commands targeting the current repo are shown (case-insensitive; supports `dsh plugin add`, full URLs and `.git` suffixes); examples for other repos are ignored
- **回归测试**：集成 +5（install/add 变体、大小写、他仓库不命中、无指令/目录缺失返回 null）、e2e +1（安装响应断言 cliCommand）；smoke 187 / 单元+集成 80 / e2e 103 全绿 / +5 integration and +1 e2e cases; full suite green

## v1.3.14 — 2026-08-15（索引 gzip 分页 + 备份恢复 / Gzip indexes, server-side paging & backup/restore）

- **索引 gzip 产物（#14）**：构建期同步产出 `registry.json.gz` / `skills.json.gz`（11.3MB → 2.0MB、1.8MB → 0.3MB）；运行时所有网络源优先拉 `.gz`（下载后解压），registry.json.gz 回落到 1MB 以内使 GitHub Contents API 的 api 源对两个索引都重新可用；CI 提交步骤纳入 `.gz` / the build now emits gzipped indexes (11.3MB→2.0MB); all runtime sources prefer `.json.gz` and gunzip after download; the api source works again for both indexes since the gz files fit under the 1MB Contents API limit; CI commits the `.gz` artifacts
- **skills 服务端分页 + 搜索下推（#14）**：`/api/marketplace/skills` 支持 `?page=&pageSize=&q=`（分页模式只标注当前页，≤200 项/页；搜索下推到服务端过滤名称/全名/标签/简介）；不带参数保持全量返回（旧客户端兼容）；Skills tab 改为服务端分页——每页 100、触底加载下一页、搜索即查即得，不再把上万条索引一次性灌进浏览器 / `/api/marketplace/skills` now supports server-side paging and search (`page`/`pageSize`/`q`); the Skills tab fetches pages on demand (100/page, infinite scroll) and search queries the server instead of filtering a full in-memory copy; legacy full-list responses are unchanged
- **备份与恢复（#15）**：新增「备份与恢复」面板——导出备份（JSON 下载）/ 导入备份恢复（差异计算后逐个走正常安装流程，材料/构建确认照常弹出）；可选 WebDAV（http(s) + Basic 认证）推送/拉取备份；备份只含安装记录（仓库/类型/版本），环境变量从不持久化故天然无密钥；WebDAV 地址协议校验防 SSRF / new Backup & Restore panel: export a JSON snapshot of install records, import & restore by diffing then re-installing missing repos through the normal install flow; optional WebDAV push/pull with Basic auth; snapshots contain no secrets (env answers are never persisted); WebDAV URLs are protocol-checked against SSRF
- **回归测试**：e2e 新增 14 条（分页/搜索过滤、backup 记录与键规范化、restore diff 缺失/已装、WebDAV 非 http 地址 400）；smoke 187、单元+集成 75、e2e 102 全绿 / 14 new e2e cases; full suite green (smoke 187 / unit+integration 75 / e2e 102)

## v1.3.13 — 2026-08-15（子模块安装 + 类型识别分层 + Skills 内置索引 / Submodule install + layered type detection + bundled skills index）

- **git submodule 插件安装修复（#10）**：克隆后检测 `.gitmodules`，存在即递归拉取子模块（`--depth 1`），修复 oh-dsh 等以子模块组织源码的插件构建失败（`Could not resolve upstream/*/src/index.ts`）；子模块地址做安全校验——仅放行 https 与相对路径，`file://` 等协议直接拒绝安装（本地文件泄露防护），并显式禁用 file 协议兜底 / clone now detects `.gitmodules` and initializes submodules recursively, fixing build failures for submodule-based plugins like oh-dsh; submodule URLs are validated (https / relative only, `file://` rejected) with the file protocol explicitly disabled
- **安装类型识别分层重构（#11）**：`detectType` 不再把 skill 检测放在全局最高优先——改为 预设/脚本 → 根 package.json 声明 DSH 能力 → 根 SKILL.md → 嵌套插件根 → 嵌套技能根 的分层判定；SKILL.md 与 package.json 共存的插件仓库（如 oh-dsh）不再被误判为 skill 而漏装插件本体，带工具链 package.json 的纯 skill 仓库也不会反向误判；`findSkillRoots` 新增 vendored 目录跳过（upstream/vendor/third_party 等，子模块上游技能不算本仓库分发内容）/ `detectType` is now layered instead of skill-first: repos with a DSH-capable package.json are no longer misjudged as skills (which skipped the plugin itself), while pure skill repos with tooling package.json stay skills; `findSkillRoots` skips vendored dirs (upstream/vendor/third_party/...)
- **Skills 栏目内置索引兜底（#12）**：skills 列表默认直读随包分发的 skills.json（秒开、离线可用），点「刷新」仍走网络源获取最新；修复 12MB skills.json 撞 15s 硬超时导致栏目刷不出来/数据残缺的问题；前端新增「内置索引」数据源提示条 / the skills tab now reads the bundled skills.json by default (instant, offline-ready) with Refresh still hitting network sources; fixes the 12MB index hitting the 15s timeout; a new "bundled" data-source banner is shown
- **搜索兜底不再污染磁盘缓存（#12 根因）**：搜索 API 的残缺结果（单 query 上限 1000 条）不再写入磁盘缓存，避免把上次成功的完整索引降级 / partial search-API fallback results no longer overwrite the last good full index on disk
- **回归测试**：新增 19 条用例（.gitmodules 地址校验、detectType 六种形态、vendored 跳过、内置索引可读/去重/排除本体、兜底顺序、搜索不污染缓存），e2e 与集成的 3 条缓存兜底用例适配内置索引层（临时移开内置文件以覆盖更深层路径）/ 19 new regression cases covering gitmodules URL validation, six detectType shapes, vendored-dir skipping, bundled index integrity, fallback ordering and no search-cache pollution; 3 cache-fallback cases adapted to the bundled-index tier
- 致谢 / Thanks: @lws2004（#10 #11 报告与补丁草案）、@GangCLiu（#12 报告与完整补丁）

---

## v1.3.12 — 2026-08-15（KIMI K3 代码审阅整改 / Review fixes per KIMI K3 audit）

按《DSH插件市场-代码审阅-review.md》逐项整改（H1-H4 全部修复，M3-M6/L1/L3-L5 修复，M1/M2 记为已知限制） / all H1–H4 and M3–M6/L1/L3–L5 items from the KIMI K3 review fixed; M1/M2 documented as known limitations

- **H1 安装脚本幂等失效**：`install.sh`/`install.ps1` 的注册检查用 `^name:` 行首锚定，匹配不到 `- insert:` 块内的缩进行 → 每次运行重复追加条目；改为 `^\s*name:` 与服务端一致 / install scripts' idempotency check now allows leading whitespace (indented `name:` inside `- insert:` blocks), matching the server
- **H2 script 类型平台选择**：不再无条件 ps1 优先——Windows 优先 ps1、其他平台优先 sh，首选缺失回退另一脚本，两者皆缺给出明确报错 / script-type installs now pick the script by platform (ps1 on Windows, sh elsewhere) with a clear error when neither fits
- **H3 skills 列表无界并发**：已安装标注复用 12-worker 并发池（12000+ 仓库不再一次性发起上万并发 fs.stat）/ skills flagging uses the same 12-worker pool as the plugin list
- **H4 skills.json 超 1MB**：GitHub Contents API 对 >1MB 文件必 403 → skills 模式跳过 api 源，不再每次刷新白打一个必失败的请求 / the api source is skipped for skills (11MB index exceeds the 1MB Contents API limit)
- **M3 非法 JSON 静默吞掉**：`readJsonBody` 解析失败抛 400（此前被当成空 body 报 badRepo，误导排障）；卸载处理器错误码统一用 `status` / invalid JSON now throws 400 instead of being silently treated as an empty body
- **M4 环境变量扫描**：camelCase 分支去掉裸 `Key|Pass`（"hotKey" 等普通词不再误报）；扫描递归两层（跳过点目录/node_modules/dist/build），多包仓库子目录 README 不再漏报 / env scan: dropped bare `Key|Pass` suffixes (no more `hotKey` false positives) and recursed two levels for sub-directory READMEs
- **M5 适配层重定向明示**：安装日志首行输出「适配层重定向：实际安装的是 X」 / adaptor redirects are now announced in the install log
- **M6 文档漂移**：README 补全 `/api/marketplace/uninstall`、`/api/marketplace/self-update` 端点与手动预装插件不可卸载的说明 / README documents the missing endpoints and the manual-install uninstall limitation
- **L1/L3/L5**：`removePatchEntry` 声明仅支持本插件生成格式；`install.sh` curl|bash 模式临时目录加 `trap` 清理；`-plugins$` 防呆过滤补注释
- **L4 同名包隐藏提示**：`dedupeReposByPkgName` 返回 `{ repos, dropped }`，列表接口透传 `dropped` 计数，客户端显示「N 个同名包已隐藏」提示条 / duplicate-package hiding is no longer silent: the API reports `dropped` and the client shows a hint
- **审计集同步**：CI 重建的 registry 暂缺 `bruc3van/dsh-desktop`、`JustGenius-s/DSH-Desktop`（搜索索引滞后，完整爬取后回归）→ 移出审计集；`Nagi-ovo/dsh-visualize` 简介明确为「在 DSH 对话中生成」→ 期望改为 conversation

## v1.3.11 — 2026-08-15（卸载大小写修复 / Uninstall case-sensitivity fix）

- **卸载假完成修复**：安装处理器保存记录时未规范化仓库名，`Small-tailqwq/dsh-deep-whale` 这类带大写字母的仓库记录键保留了原始大小写；卸载处理器把请求规范化成小写后查不到记录，返回「done」但什么都没删——表现为弹「卸载完成」却无实际效果、卸载按钮仍在。修复：记录键统一按 `normalizeRepoRef` 小写规范化（加载/保存/删除/查询全部走同一入口），旧文件遗留的大写键在加载时自动迁移 / uninstall falsely reported "done": install saved the record under the raw-case repo key (e.g. `Small-tailqwq/dsh-deep-whale`), while uninstall normalized the request to lowercase and missed the record — nothing was deleted but the dialog said "complete". Fix: all install-record keys are canonicalized to lowercase via one lookup entry (`installedKey`), and legacy mixed-case keys are normalized on load
- **客户端不再假报成功**：卸载响应 `removed=0`（无记录/无可定位目录）时弹日志原文提示，不再显示「已卸载」/ the client no longer claims success when nothing was removed — `removed=0` shows the server log text instead of "uninstalled"
- **e2e 回归**：新增 5 条大小写不一致用例（大写键记录 + 小写卸载请求 → 真正删除目录与记录）/ 5 new e2e cases cover the mixed-case record + lowercase uninstall path

## v1.3.10 — 2026-08-15（列表源容灾 + CI 修复 / List-source resilience & CI fix）

- **列表索引磁盘缓存**：索引网络源（api.github.com / jsDelivr CDN / raw.githubusercontent）全挂时不再回退到搜索 API 的残缺结果（dsh 上限 1000 条、skills 兜底仅 266 条）——改为优先使用上次成功拉取的**完整索引**（本地 `marketplace/list-cache/`，api/CDN/raw 全失败自动启用），搜索 API 仅作最后应急且不污染缓存 / a disk cache now keeps the last successful full index (`marketplace/list-cache/`); when all three index sources are unreachable the list serves the complete cached index instead of the truncated search-API fallback (1000-plugin cap / 266 skills), and search results never downgrade a good cache
- **数据源透明化**：列表接口新增 `source` 字段（registry / cache / search），客户端在「本地缓存」或「搜索兜底」模式下显示黄色提示条，不再让用户困惑于数量骤变 / list APIs now report `source` (registry/cache/search); the client shows a warning banner in cache/search mode so count changes are self-explanatory
- **api 源带 token**：环境存在 GH_TOKEN/GITHUB_TOKEN 时 api.github.com 源携带认证（60 次/小时 → 5000 次/小时） / the api.github.com source uses the env token when present (60/hr → 5000/hr)
- **探测工具容灾**：`verify-installability.mjs` 遇到限流 403 时记录 unknown 并**等待 reset 后重试同一仓库**（最多 2 个窗口），结尾兜底补 unknown，报告条目永远与 registry 对齐 / `verify-installability.mjs` now waits out rate-limit 403s and retries the same repo (up to 2 windows), and backfills unknown entries so the report always matches the registry
- **CI Linux 失败修复**：smoke-tests 自动发现路径改用 `fileURLToPath`（367dab2 引入的 Windows-only 路径转换在 Linux 上生成无效反斜杠路径，导致 13:14/14:55 两个定时任务失败并触发失败邮件）/ CI Linux failure fixed: the smoke-test auto-discovery path now uses `fileURLToPath` (a Windows-only path conversion from 367dab2 produced invalid backslash paths on Linux, failing the 13:14/14:55 scheduled builds)
- **点目录技能误装修复**：`findSkillRoots`/探测跳过 `.codex/.opencode` 等点目录——其 SKILL.md 是仓库自身开发流程技能（如 iPolloWork 的 72 个 Codex 技能），不再被误判为可安装 skill 而倒进用户 skills 目录；iPolloWork 探测结论修正为「非 DSH 插件」/ dot-directory SKILL.md no longer counts as installable (`.codex/.opencode` skills are the repo's own dev flows — e.g. iPolloWork's 72 Codex skills won't be dumped into `~/.dsh/skills/` anymore); iPolloWork now probes as "not a DSH plugin"

## v1.3.9 — 2026-08-15（可安装性徽标 + 全量探测 / Installability badges & full probe）

- **全量可安装性探测**：新增 `scripts/verify-installability.mjs`——对 registry 全部 1796 个仓库做两阶段 GitHub API 探测（git/trees 找 SKILL.md/安装脚本/package.json + contents API 读清单判定真 DSH 插件），输出 `installability-report.json`（断点续跑、额度护栏）/ new `verify-installability.mjs` probes every registry repo in two phases (trees for SKILL.md / install scripts / manifests + package.json contents for the real-plugin check), writing `installability-report.json` (resumable, rate-limit guarded)
- **探测结论（1796 仓库）**：84.9% 可一键安装——cordis 插件 1122、技能 283、脚本 62、多包 56、agent 预设 1；8.6%（155）有 package.json 但非 DSH 插件（如 PicGo-Core）；5.8%（105）仅能手动安装（awesome 列表/文档仓库）；11 个仓库已删除（已从 registry 清理）/ verdicts across 1796 repos: 84.9% one-click installable (1122 cordis plugins, 283 skills, 62 scripts, 56 multi-package, 1 preset); 8.6% (155) have a manifest but are not DSH plugins (e.g. PicGo-Core); 5.8% (105) manual-only (awesome lists / docs); 11 deleted repos cleaned from the registry
- **卡片徽标**：构建期把探测结论盖章进 registry（`installable` 字段），卡片显示「仅手动安装」灰标 /「非 DSH 插件」红标，列表不隐藏，信息透明 / registry now carries an `installable` stamp from the probe; cards show a gray "manual only" or red "not a DSH plugin" badge without hiding anything
- **盖章纯函数 + 回归测试**：`applyInstallability` 导出并固化为单元测试（pkg-plain→non-plugin、manual→manual、报告外清章） / `applyInstallability` is a pure exported function pinned by a unit test
- **审计集同步**：已消失的 `UntR/dsh-plugin-marketplace-e2e-verification`（临时验证仓库）从 `audit-expected.json` 移除（119 条）/ the deleted disposable verification repo dropped from the audit set (119 entries)

## v1.3.8 — 2026-08-15（分类引擎重写 + 100% 审计回归 / Category engine rewrite & audit parity）

- **分类准确率 45.8% → 100%**：以 120 个 Top 仓库 README 人工审计结果为基准（`audit-expected.json`），重排规则优先级并逐词精修 `CATEGORY_RULES`——移除误伤词（`/notif/`、`/style/`、`/compat/`、`/marketplace/`、`/ppt/`、`/office/`、`/\bgit\b/`、`/\btui\b/`、裸 `/rust/`、裸 `/tab/`、裸 `/compile/` 等），生态泛标签（`coding-agents`、`developer-tools`、`prompt-engineering`、`agentic-coding` 等）移入停用词表；新增 `CATEGORY_OVERRIDES` 人工覆写表兜底规则能力之外的边界仓库（desc 为空 / 语义超出特征词），每条附理由 / category accuracy 45.8% → 100% against a 120-repo README audit (`audit-expected.json`): rule priority reordered and the pattern set surgically rewritten — false-positive words removed (`/notif/`, `/style/`, `/compat/`, `/marketplace/`, `/ppt/`, `/office/`, `/\bgit\b/`, `/\btui\b/`, bare `/rust/`, bare `/tab/`, bare `/compile/`, …); ecosystem-wide topics (`coding-agents`, `developer-tools`, `prompt-engineering`, `agentic-coding`, …) moved into the stop-word list; a curated `CATEGORY_OVERRIDES` map now covers edge repos rules cannot judge (empty descriptions, semantics beyond feature words), each entry annotated with its rationale
- **你点名的三个案例全部归位**：`dsh-ads` 界面美化（原误分"对话"）、`dsh-web-ui` 界面美化（原误分"开发编码"）、`dsh-TUI` 开发编码（原误分"模型用量"）；`dsh-tui/dsh-tui` 等"plugin bundle"打包产物不再误归"聚合资源" / the three cases you flagged are all fixed: `dsh-ads` → 界面美化 (was "对话"), `dsh-web-ui` → 界面美化 (was "开发编码"), `dsh-TUI` → 开发编码 (was "模型用量"); "plugin bundle" packaging repos like `dsh-tui/dsh-tui` no longer land in "聚合资源"
- **分类标签易读性**：对话类分类文案由「对话会话」改为「对话聊天」，避免"对话对话"的观感歧义 / the conversation-category label reads 「对话聊天」 instead of 「对话会话」 (no more confusing doubled word)
- **分类回归测试**：新增 `scripts/tests/unit/categories.test.mjs`，将 120 仓库审计期望固化为单元测试，规则改动回归即红；`validate-categories.mjs` 支持 DEBUG=1 输出命中词，便于日后精修 / a new unit test (`categories.test.mjs`) pins the 120-repo audit expectations so any future rule regression turns CI red; `validate-categories.mjs` prints matched patterns under DEBUG=1 for future tuning
- **registry.json 已重分类**：1796 条目按新规则全量重算（825 条分类变更），`generated_at` 已刷新 / `registry.json` reclassified in place (825 of 1796 entries changed), `generated_at` refreshed

## v1.3.7 — 2026-08-14（卸载功能 + 适配层 / Uninstall & adaptor layer）

- **卸载功能**：已安装卡片新增红底「卸载」按钮——skill / agent 预设直接删除安装目录；cordis 插件删除包目录 + `cordis.patch.yml` 注册条目 + 安装记录（多插件仓库按记录的子包名逐个卸载）；脚本型插件移除记录与缓存并明确提示；与安装共用全局互斥 / uninstall: installed cards get a red «Uninstall» button — skills/presets delete their install dirs; cordis plugins remove the package dir + `cordis.patch.yml` entry + install record (multi-package repos uninstall each recorded sub-package); script-type plugins remove the record and cache with a clear note; shares the global install mutex
- **「更新」按钮橙底**：可更新时主按钮改为橙色高亮 / the «Update» button now uses an orange highlight
- **适配层 adaptor.json**：硬编码重定向不规范项目——如 `yejiming/MuseAI`（本体是独立软件却打了 dsh-plugin tag，安装会崩溃）重定向到真实插件 `yejiming/dsh-museai-tavern`（未打 tag，索引拉不到）；列表移除错误条目并补入真实条目，安装请求自动重定向；构建期与运行时双路径生效 / adaptor layer (`adaptor.json`): hardcoded redirects for misbehaving projects — e.g. `yejiming/MuseAI` (a standalone app that wrongly carries the dsh-plugin tag and crashes on install) redirects to the real plugin `yejiming/dsh-museai-tavern` (untagged, invisible to the index); the list drops the wrong entry and adds the real one, install requests are redirected; applied both at build time and at runtime
- **测试金字塔跨平台修复**：`toc.test.mjs` 的仓库根路径改用 `fileURLToPath`（此前 Windows-only 的路径转换导致 Linux CI 的 Syntax check 失败）/ cross-platform test fix: `toc.test.mjs` resolves the repo root via `fileURLToPath` (the previous Windows-only path conversion broke the Linux CI syntax check)

## v1.3.6 — 2026-08-14（皮肤/多包仓库支持 + 安装确认回环修复 / Skin & multi-package repos + install round-trip fix）

- **皮肤/多包仓库自动安装**：根目录无插件清单但子目录含 DSH 插件（如 `dsh-deep-whale` 的皮肤合集）时，自动发现全部子包清单（`findPluginRoots`，`looksLikeDshPlugin` 过滤防误装）并逐个安装——scoped 包名路径校验、patch 注册、npm 脚本/构建确认按子包汇总，完成显示「已安装 N 个插件」/ skin & multi-package repos: when the repo root has no manifest but subdirectories contain DSH plugins (e.g. the `dsh-deep-whale` skin collection), all sub-package manifests are discovered (`findPluginRoots`, filtered by `looksLikeDshPlugin`) and installed one by one — scoped-name path checks, patch registration, npm-script/build confirms aggregated per package, completion shows «N plugins installed»
- **安装确认回环卡死对话框修复**：提交材料/确认后服务端不再重复克隆（复用 ≤15 分钟的新鲜缓存），二次请求从几十秒变为毫秒级；「运行中」阶段新增「取消并关闭」按钮，后台任务结束后 mutex 自动释放，杜绝无法关闭的卡死对话框 / stuck install dialog fixed: the server no longer re-clones on answer submission (reuses the fresh ≤15-min cache, round-trips drop from tens of seconds to milliseconds); a «Cancel & close» button was added to the running phase — the background task finishes and releases the mutex, so the dialog can never get stuck

## v1.3.5 — 2026-08-14（安装健壮性 + 测试体系收编 / Install robustness & test pyramid）

- **空值跳过修复（issue #5）**：安装流程提交时预填所有问题 id 为空串——服务端按「键存在即视为已提供」判定，此前未触碰的输入框键缺失导致空值跳过后反复弹窗死循环；选项型问题不受影响 / empty-value skip fixed (issue #5): submit now pre-fills every question id with an empty string — the server treats key-presence as provided, and untouched fields previously had no key, causing an infinite re-prompt loop; option questions are unaffected
- **Windows pnpm 构建修复（PR #4）**：`runPnpm` 的 win32 分支改为经 `cmd.exe /d /s /c` 启动——Node `execFile` 无法直接启动 `.cmd`，此前凡带 `pnpm-lock.yaml` 的源码型插件在 Windows 上构建必失败（spawn EINVAL）/ Windows pnpm builds fixed (PR #4): `runPnpm` now launches via `cmd.exe /d /s /c` on win32 — `execFile` cannot start `.cmd` shims, so source-only plugins with `pnpm-lock.yaml` always failed to build on Windows (spawn EINVAL)
- **webServer 依赖注入（PR #7）**：`lib/index.js` 声明 `export const inject = ["webServer"]`——此前未声明服务依赖，cordis 不保证 webServer 先启动，`dsh web` 插件树加载存在竞态失败 / webServer dependency injection (PR #7): declared `inject = ["webServer"]` — without it cordis does not guarantee the service starts first, causing a racy plugin-tree load failure
- **测试体系收编（PR #8 + follow-up）**：测试金字塔 unit 160 / integration 51 / e2e 49 全量收编（本地 fixture git 仓库 + mock 网络 + 隔离 DSH_HOME，e2e 附 Windows 无符号链接权限适配）；覆盖率工具（NODE_V8_COVERAGE 零依赖）；Git Hook 体系按 review 降级收编——`merge` 加入提交类型白名单、emoji/TOC 默认 warn 不阻断、密钥扫描保持 error，`install-hooks` 可选不强制；规范文档体系恢复（作者 force-push 时丢失的 docs/ 已从旧 head 找回）/ test pyramid adopted (PR #8 + follow-ups): unit 160 / integration 51 / e2e 49 (local fixture git repos + mocked network + isolated DSH_HOME; e2e adapted for Windows without symlink privilege); zero-dependency coverage tool; Git Hooks adopted in downgraded form per review — `merge` added to the commit-type whitelist, emoji/TOC default to warn (non-blocking), secret scan stays error, `install-hooks` remains optional; docs restored (the author's force-push dropped `docs/`; recovered from the old head)
- **lib API 问题转 issue**：测试排查发现的 10 条 lib API 设计问题转 [issue #9](https://github.com/bradeGithub/DSH-Plugins-Marketplace/issues/9) 跟踪 / the 10 lib API design findings from test-driven review are tracked in [issue #9](https://github.com/bradeGithub/DSH-Plugins-Marketplace/issues/9)

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
