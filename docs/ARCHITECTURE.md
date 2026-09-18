# 架构与数据流 / Architecture

插件市场的内部结构：分层职责、数据源链、安装管线、版本检测、已安装判定与运行时 owner 语义。改代码前先对齐本文的边界约定。

<!-- TOC -->
- [1. 分层与依赖方向](#1-分层与依赖方向)
- [2. 数据源链（多级降级，搜索 API 兜底）](#2-数据源链多级降级搜索-api-兜底)
- [3. 安装管线（5 步 + 确认门）](#3-安装管线5-步-确认门)
- [4. 版本检测逻辑](#4-版本检测逻辑)
- [5. 已安装判定（六段管线，打开市场即自动比对）](#5-已安装判定六段管线打开市场即自动比对)
- [6. 存储布局](#6-存储布局)
- [7. 客户端 bundle 与并发原语](#7-客户端-bundle-与并发原语)
- [8. 行为级已知限制](#8-行为级已知限制)
<!-- /TOC -->

## 1. 分层与依赖方向

服务端业务固定按 `http → app → domain` 分层，`infra` 作为注入层可被任意层直接使用；`lib/index.js` 是**组合根**（composition root）：只做宿主装配、启动编排与兼容导出，不承载业务逻辑。

```
lib/
├── index.js      组合根：宿主装配、启动编排、兼容导出（rev 哈希、randomHex 等注入原语）
├── client.js     浏览器发布 bundle（client-src 片段确定性装配产物）
├── redact.js     日志脱敏规则集（密钥/路径/邻近上下文/高熵兜底）
├── allowed-signers.js  自更新信任根（编译期 ALLOWED_SIGNERS/REVOKED_KEYS，见 SECURITY.md §6）
├── skin-manifest.js    皮肤清单实现（见 SKIN-MANIFEST-SPEC.md）
├── http/         HTTP 路由与请求层
│   ├── routes.js            全部端点注册与参数解析（见 HTTP-API.md）
│   ├── auth.js              isTrustedRequest / isWriteAllowed 鉴权判定（见 SECURITY.md §2）
│   ├── request.js           readJsonBody / marketplaceJson 等请求原语
│   └── marketplace-contract.js  前后端共享契约
├── app/          use-case owner：每个文件管一个业务面
│   ├── install.js           安装编排（consent 门、材料暂停、类型分派）
│   ├── install-exec.js      安装执行（复制、symlink 拒绝、注册）
│   ├── uninstall.js         卸载
│   ├── update.js            自更新（签名验证、staging、原子替换）
│   ├── installed-state.js   安装记录与持久化队列
│   ├── list-runtime.js      列表缓存：single-flight / generation / TTL
│   ├── profile-index.js     profile 与索引管理
│   ├── repository-classification.js  仓库类型分类
│   ├── feedback.js          安装反馈用例
│   ├── backup.js            备份/恢复/WebDAV
│   ├── env-edit.js          插件环境变量写入
│   └── diagnostics.js       诊断画像缓存、近期日志环、detached snapshot
├── domain/       纯逻辑与规则（零 IO，可直接单测）
│   ├── validation.js        校验规则集（Host 白名单、env 键名、版本比较、CLI 目标白名单…）
│   ├── normalize.js         registry 条目归一化
│   ├── list.js / scan.js    列表与扫描规则
│   ├── installed-index.js   已安装索引规则
│   ├── security-scan.js     安装前 secrets 扫描规则
│   ├── sshsig.js            SSH 签名验证（验签域逻辑）
│   ├── profile.js / adaptor.js / i18n.js
└── infra/        适配器注入层（fs/network/proc/queue 全部可注入替身）
    ├── proc.js              进程执行（git/npm/pnpm/dsh/脚本）
    ├── fetch.js / registry-cache.js   网络与索引缓存
    ├── queue.js             createMutex / createQueue
    ├── patch-manifest.js    cordis.patch.yml 队列化写入
    ├── store.js             持久化存储
    ├── repository-scan.js   marketplace cache 的 skill/plugin/preset 根扫描与 manifest/lifecycle 读取
    ├── security-scan.js     文件系统扫描适配
    ├── bundle-register.js   bundle 包注册（realpath 锚点）
    ├── marketplace-metadata.js / profile-scan.js / adaptor.js
```

新增职责时按单一职责边界先补契约测试（见 [TESTING.md](TESTING.md)）。

## 2. 数据源链（多级降级，搜索 API 兜底）

```
GitHub Actions（registry.yml：每 2 小时增量 + 每天 04:00 UTC 全量，仓库自带 token）
   └─ scripts/build-registry.mjs
        │  分页拉取 topic:dsh-plugin / agent-skills ∪ claude-skills
        │  「stars 分段 + 时间窗口二分」突破 Search API 单 query 1000 条上限：
        │  段内拉满 1000 条则按 star 对半分裂；单值段（min===max）改按 pushed
        │  时间窗口二分，窗口窄于 MIN_WINDOW_DAYS 即接受部分结果
        │  （dsh 模式 1 天 / skills 模式 30 天）
        │  去重、排除本体、pkg_name 冲突消解（同名 npm 包保留高 star 者）
        └─ 提交 registry.json / skills.json 回 main（按 Star 排序）
```

运行时 `load(kind, force)`（`lib/infra/registry-cache.js`）按序降级：

```
dsh 冷加载 / 任意 refresh=1：          skills 普通加载（非 force）：
1. api.github.com/contents/{f}.gz     1. 内置索引（插件包根 {f}）
     （Accept: raw；有 GITHUB_TOKEN/   2. 磁盘缓存（≤6h，generated_at 计龄）
      GH_TOKEN 则带 Bearer）           3. GitHub Search API 分页兜底
2. cdn.jsdelivr .gz（checkFresh）
3. raw.githubusercontent .gz
4. cdn.jsdelivr 未压缩（checkFresh）
5. raw.githubusercontent 未压缩
6. 内置索引 → 磁盘缓存 → Search API
```

- **远端链五源**：Contents API 优先（`.gz` 压缩 + 官方原文通道），CDN/raw 各试 `.gz` 与未压缩两档；jsDelivr 源带 `checkFresh` 新鲜度门（`generated_at` 超过 6h 拒收——防 CDN 边缘缓存喂旧索引）
- **skills 特例**：普通加载跳过远端链直接走内置索引（大索引避免每次冷启下载），`?refresh=1` 才拉远端
- **增量与全量节奏**：CI 每 2 小时增量（`INCREMENTAL_DAYS=3`，只拉最近 3 天 pushed 的仓库）并与旧索引合并；每天 04:00 UTC 全量重建刷新 star 数
- **pkg_name 富化**：构建期读仓库 `package.json` 补 `pkg_name` 字段（`SKIP_ENRICH=1` 可跳过）；`has_skill` 探测按 Core API 额度分批补齐（增量续跑，未探测仓库显示「未验证」）
- **star 增速（S1 信号面）**：索引每次构建提交回 main——git 历史本身即快照库。构建期 `commits?path=<index>&until=<7d/30d前>` 定位基线提交 → `contents?ref=<sha>` 取当时索引 → 写 `stars_delta_7d`/`stars_delta_30d`（`null` = 基线不可得，诚实未知非 0）。每轮构建 +4 次 API 调用，零存储增长；仅 CI 环境（`GITHUB_REPOSITORY` + token）启用。列表端点 `sort=trending` 按 7d 增速排序（null 垫底），`verified=1`/`hideArchived=1` 过滤先于分页，`total` 计数诚实
- **API 消耗口径**：10 分钟内存 TTL + single-flight 内零请求；冷加载首击 Contents API（计入 Core 限流：未认证 60 次/时）；Search API 只在远端五源 + 内置 + 磁盘缓存全失败时兜底（未认证 10 次/分）；索引内容只含仓库元数据，安装仍直连 `github.com` 克隆
- **测试接缝**：`DSH_MARKETPLACE_BUNDLED_DIR` 覆盖内置索引目录

## 3. 安装管线（5 步 + 确认门）

```
[1/5] git clone 到 ~/.dsh/marketplace/cache/<owner>__<name>/
      └─ README 声明 CLI 安装命令时先经 __confirm_cli__ 门（见 SECURITY.md §3），
         放行则 dsh plugin add/install 代执行，失败回退常规流程（npm 目标有
         installNpmTargetToTemp 兜底）
[2/5] 类型识别：SKILL.md → skill；preset.yml + agent.cordis.yml → agent 预设；
      package.json → cordis 插件；install.sh/ps1 → 安装脚本
[3/5] 扫描 README / install 脚本 / .env 示例中的环境变量声明（API_KEY 类，≤8 个）
      └─ 发现需要 → 暂停（awaiting-input），等用户提交材料
[4/5] 执行安装：复制 skill/预设/插件包，或运行安装脚本
      └─ 经 consent 门（secrets/vulns/bundle/script/npm 生命周期/宿主遮蔽依赖/
         非插件特征/构建/manual，见 SECURITY.md §3）
[5/5] 写入 installed.json 安装清单并注册 cordis.patch.yml
```

安装目标的安装位置：skill → `~/.dsh/skills/`；agent 预设 → `~/.dsh/.agent-presets/`；cordis 插件 → 目标 profile 的 `node_modules/` + patch 注册；脚本型 → 执行脚本本体。

## 4. 版本检测逻辑

| 数据 | 来源（按优先级，均在 `/list` 装配时求值） |
|---|---|
| 已装版本 | `installed.json` 记录 `version` → 无记录时 `matchProfileEntry` 命中项的 `version`（profile 扫描出的安装目录 `package.json`，键序 `slug`/`repo.name`/`pkg_name`/`npm_pkg_name`）；cli-npm 形态记录（`type==="cli"` 且 target 为 npm 包名）直读 `node_modules/<pkg>/package.json` |
| 最新版本 | 索引 `version` 字段 → 缺失时读市场缓存克隆 `<owner>__<name>/package.json`；cli-npm 形态用索引 `npm_version`（构建期 dist-tags 富化） |

两者都存在且已装版本**严格低于**最新版（`compareVersions`，semver + 预发布感知）→ `updateAvailable`，卡片显示「更新」按钮 + `已装 vX → vY`。仅对含 `package.json` 的 cordis 插件生效；skill / 预设 / 脚本类与 cli 仓库形态记录无版本概念。版本比对全部读本地数据，零额外网络请求。

## 5. 已安装判定（六段管线，打开市场即自动比对）

`profile-index.js` 按序短路（`idx` 未就绪时回退 `detectInstalled`）：

1. `installed.json` 安装清单命中（`hasInstalledRecord`）——本插件装的有记录
2. 托管目录启发式：`~/.dsh/skills/`、`~/.dsh/.agent-presets/` 下出现同名目录，且 `dirOwners` 属主校验通过（无 `repository` 字段的条目按目录属主消歧，防同名不同 owner 误标）
3. 本体识别：仓库命中本插件自身 `package.json` 的 `repository` 字段即视为已安装
4. `profileHit`：profile 包扫描按 `slug`/`repo.name`/`pkg_name` 键命中，且 `repository` 字段双向校验（已装包的 `repository` 必须与目标仓库一致——防「同名不同仓库」误判，也支持反向查找：先装插件后装市场时 scoped 包/包名差异大的也能正确标记）
5. `cacheScripts`：缓存目录被 `detectCacheType` 判为 script 型 → 视为已安装（故脚本型删缓存即恢复可安装）
6. `cachePkgNames` → `profileHit`：缓存克隆的 `package.json` 名再查一遍 profile——仓库名与包名不一致（如 `DSH-Plugins-Marketplace` → `dsh-plugin-marketplace`）也能识别并读出已装版本

`@deepseek-ai/*` 官方插件自动枚举并排除（运行时探测 + 内置兜底清单），永不被标为已安装；`deepseek-harness` 仓库本体硬编码排除（不属于插件）。skills 列表走独立的 `annotateSkillInstalled` 路径。

## 6. 存储布局

```
~/.dsh/
├── profiles/web/
│   ├── node_modules/dsh-plugin-marketplace/   ← 插件本体
│   │   ├── package.json        （dsh.client 声明 + exports 映射）
│   │   └── lib/
│   │       ├── index.js        （组合根：宿主装配/启动编排/兼容导出）
│   │       ├── client.js       （发布 bundle：客户端市场页面 UI）
│   │       └── client-src/     （bundle 源片段，开发时由 assembler 拼接）
│   └── cordis.patch.yml        （插件注册条目）
├── marketplace/
│   ├── cache/<owner>__<name>/  （克隆缓存：安装与版本比对数据源）
│   ├── list-cache/<kind>.json  （列表磁盘缓存：dsh.json / skills.json，6h 计龄）
│   ├── installed.json          （已安装清单：type/name/location/version/installedAt/envKeys/profile）
│   ├── feedback.json           （安装反馈队列 + GitHub token）
│   ├── envs.json               （env-edit 已保存键值）
│   └── config.json             （targetProfile / lanWrite 等配置）
├── skills/                     （skill 安装目标）
└── .agent-presets/             （agent 预设安装目标）
```

## 7. 客户端 bundle 与并发原语

- **bundle 装配**：`lib/client-src/*.fragment` 经 `node scripts/assemble-client.mjs --write` 确定性拼接为 `lib/client.js`（`window.__ModuleLoader__.load` 格式，`require` 可解析 DSH 平台模块）；不带 `--write` 只做漂移检查。rev 版本号按内容哈希生成，重启后浏览器自动拉新
- **并发**：`createMutex`（全局安装互斥，忙时 409）/ `createQueue`（patch 文件与安装记录的持久化队列）；`list-runtime` 与 `profile-index` 各自的 single-flight / generation / TTL 语义由组合层跨 owner 接线
- **诊断**：`diagnostics.js` 管画像缓存、近期日志环与 detached snapshot；日志对外输出经 `lib/redact.js` 多层脱敏（密钥/路径/上下文邻近/高熵兜底）

## 8. 行为级已知限制

- 安装任务整体挂在单个长 POST 上（克隆 + npm 安装 + 构建 + 材料确认多轮回环），短超时反向代理可能切断连接——后端仍继续执行，刷新页面确认结果
- 「社区收录」徽章来自第三方 awesome 聚合页构建期抓取；抓取失败该次构建不更新徽章（增量构建保留旧标，下次构建恢复）
- 插件代码改动需重启 DSH 生效（web profile 的 HMR 禁用）

安全侧的已知残余风险（回环放行、WebDAV rebinding 窗口等）见 [SECURITY.md](SECURITY.md) §8。
