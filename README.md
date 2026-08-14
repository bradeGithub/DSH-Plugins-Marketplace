# DSH插件市场（dsh-plugin-marketplace）

🌐 **语言 / Language:** **中文** | [English](README.en.md)

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的插件市场插件：从 GitHub 的 [`dsh-plugin` topic](https://github.com/topics/dsh-plugin) 拉取全部插件，在 DSH Web GUI 的设置页中以卡片列表展示，支持**一键安装 / 自动更新 / 版本检测 / 已安装识别**，全程无需命令行。

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-生态插件-4D6BFE?logo=deepseek&logoColor=white)
![GitHub Stars](https://img.shields.io/github/stars/bradeGithub/DSH-Plugins-Marketplace?logo=github)
![License](https://img.shields.io/github/license/bradeGithub/DSH-Plugins-Marketplace)
![Registry CI](https://img.shields.io/github/actions/workflow/status/bradeGithub/DSH-Plugins-Marketplace/registry.yml?label=registry%20CI)
![Last Commit](https://img.shields.io/github/last-commit/bradeGithub/DSH-Plugins-Marketplace)
![类型](https://img.shields.io/badge/类型-客户端%2B服务端插件-blue)
![平台](https://img.shields.io/badge/平台-Web%20GUI-lightgrey)
![i18n](https://img.shields.io/badge/i18n-中文%20%7C%20English-important)

---

## ⚡ 一键安装（复制即用）

**喂给 AI 的一句话**（AI 具备命令执行能力即可，无需解释）：

> 安装 DSH 插件市场插件（dsh-plugin-marketplace）：克隆 https://github.com/bradeGithub/DSH-Plugins-Marketplace 到 ~/.dsh/profiles/web/node_modules/dsh-plugin-marketplace，在 ~/.dsh/profiles/web/cordis.patch.yml 中注册（id: plugin-marketplace，name: dsh-plugin-marketplace），然后重启 dsh web。

**或者直接复制命令执行：**

| 平台 | 命令 |
|---|---|
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/install.ps1 \| iex` |
| macOS / Linux | `curl -sL https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/install.sh \| bash` |

> ⚠️ 上述命令会从本仓库下载并执行安装脚本（复制插件本体 + 注册 `cordis.patch.yml`），属于「信任即执行」；也可以克隆仓库后手动运行 `install.ps1` / `install.sh`，或直接在本插件市场中安装本仓库（含 `install.ps1`，市场会先征求你的确认）。
> 建议先下载脚本**肉眼检查一遍**再执行（`irm <url> | iex` / `curl <url> | bash` 是公认的远程代码执行模式）。
> 安装完成后需**重启 DSH**（重新运行 `dsh web`）再刷新页面。

---

## ✨ 功能特性

- **全量拉取**：插件列表优先从**静态索引**（`registry.json`，jsDelivr CDN 分发，GitHub Actions 每 2 小时自动生成）加载——零 API 调用、零限流，几千个插件也能秒开；索引不可用时自动回退 GitHub 搜索 API 分页拉取（缓存 10 分钟）。列表排序：**已安装的插件置顶**，其余按 Star 数从高到低
- **一键安装**：每个插件卡片带「安装」按钮，点击后自动完成：克隆仓库 → 识别类型 → 扫描所需环境变量 → 执行安装
- **自带一键安装**：本仓库内置 `install.ps1` / `install.sh`，一行命令即可安装，也可把上面的一句话直接交给 AI 执行
- **智能类型识别**：自动区分并安装以下类型的仓库：
  - `skill`（含 `SKILL.md`）→ 安装到 `~/.dsh/skills/`
  - agent 预设（含 `preset.yml` + `agent.cordis.yml`）→ 安装到 `~/.dsh/.agent-presets/`
  - cordis 插件（含 `package.json`）→ 安装依赖并注册到 web profile
  - 安装脚本（`install.sh` / `install.ps1`）→ 执行脚本
- **用户材料介入**：当插件需要 `API_KEY` / `TOKEN` / `SECRET` 等环境变量时，**安装自动暂停**，在页面内弹窗请你提供材料（或跳过），不会盲装
- **脚本执行确认**：检测到第三方安装脚本（`install.sh` / `install.ps1`）或 npm 生命周期脚本（`prepare` / `install` / `postinstall` 等）时，先弹窗征求你的确认——拒绝即取消安装并**清理全部痕迹**
- **已安装识别**：四重判定——安装清单（`installed.json`）+ 目录启发式探测 + 包名映射扫描 + 本体 `repository` 自识别，已安装的插件按钮变为不可点击的灰色「已安装」
- **中英双语**：界面与安装日志跟随 DSH 的语言设置自动切换 中文 / English（设置 → 常规 → Language）
- **版本检测与更新**：cordis 插件自动对比已装版本与仓库最新版本（从本地缓存读取，零额外网络请求），不一致时按钮变为「更新」，点击即可覆盖升级
- **搜索**：按插件名 / 仓库全名 / 标签实时过滤
- **插件分类**：构建时按简介/标签自动分类（12 类：视觉多模态 / 文档办公 / 记忆知识 / 模型用量 / 通知通讯 / 开发编码 / 对话会话 / 界面美化 / Agent 自动化 / 通用工具 / 聚合资源 / 其他），前端分类 chips 筛选 + 卡片分类徽章
- **通用 Skills 栏目**：设置页 tab 切换到「通用 Skills」——浏览 CI 构建的全量 skills 索引（`agent-skills` ∪ `claude-skills`，12000+ 仓库），支持搜索 / 分页触底加载 / 一键安装到 `~/.dsh/skills/` / 已安装识别；含安装脚本的仓库带 🛡 标识，探测未知的仓库带「未验证」弱提示
- **刷新反馈**：点「刷新」强制重新拉取，并以弹窗提示「刷新成功 / 刷新失败」
- **Github原链**：每个卡片提供跳转到原仓库的链接（新标签页打开）
- **深浅色适配**：全部使用 DSH 主题令牌（`--dsw-alias-*`），自动适配深色 / 浅色模式
- **排除本体**：硬编码排除 `deepseek-harness`（DSH 自身仓库，不属于插件）

---

## 📦 安装本插件

> 💡 不想手动操作？用上面的 [⚡ 一键安装](#-一键安装复制即用)（一条命令或一句话交给 AI）。

本插件位于 `~/.dsh/profiles/web/node_modules/dsh-plugin-marketplace/`，并通过 `~/.dsh/profiles/web/cordis.patch.yml` 注册：

```yaml
- insert:
    - id: plugin-marketplace
      name: dsh-plugin-marketplace
```

> ⚠️ **重启生效**：DSH 的 Web profile 关闭了配置热重载（`hmr` 被禁用），修改插件代码或注册条目后需要**重启 DSH**（重新运行 `dsh web` 或 `start-dsh.bat`）再刷新页面。

---

## 🚀 使用方法

1. 重启 DSH 后打开 Web GUI，进入 **设置 → DSH插件市场**
2. 页面自动加载全部插件（按 Star 排序），也可点击「刷新」强制重新拉取
3. 使用搜索框按名字过滤插件
4. 点击插件卡片上的按钮：
   - **安装** → 开始安装，日志实时滚动
   - 需要材料时 → 页面弹出输入框，提供 API Key 等后点「提交材料并继续安装」
   - **更新** → 检测到新版本时覆盖升级
   - **已安装**（灰色）→ 无需操作

---

## 🔧 工作原理

### 数据源（registry 优先，搜索 API 兜底）

```
GitHub Actions（每 2 小时，仓库自带 token）
   └─ scripts/build-registry.mjs：分页拉取 topic:dsh-plugin，增量合并，去重/排除本体
        └─ 提交 registry.json 回 main（全量 460+ 个插件，按 Star 排序）
             └─ 插件读取：jsDelivr CDN（国内快）→ raw.githubusercontent（兜底）
                  └─ 全部失败才回退 GitHub 搜索 API（分页翻到底，缓存 10 分钟）
```

- 索引由 CI 生成，**终端用户零 API 调用、零限流**；新插件最迟两小时内进入索引
- **手动立即更新**：运行仓库里的 `update-registry.bat`（Windows）或 `update-registry.sh`（macOS / Linux），随时触发 CI 重建索引，无需等待 2 小时定时（需已安装并登录 [gh CLI](https://cli.github.com)）
- 索引内容只含仓库元数据（名称/描述/Star/更新时间/标签/许可），安装仍然直连 `github.com` 克隆

### 安装流程（5 步）

```
[1/5] git clone 仓库到 ~/.dsh/marketplace/cache/<owner>__<name>/
[2/5] 识别类型（SKILL.md / agent 预设 / 安装脚本 / package.json）
[3/5] 扫描 README / install 脚本 / .env 示例中的环境变量（API_KEY 等）
      └─ 发现需要 → 暂停安装，等待用户提供材料（可跳过）
[4/5] 执行安装（复制 skill / 预设 / 插件包，或运行安装脚本）
      └─ 脚本类 → 先征求用户确认（第三方代码风险提示）
[5/5] 写入安装清单（installed.json）并返回结果
```

### 版本检测逻辑

| 数据 | 来源 |
|---|---|
| 已装版本 | `installed.json` 记录；历史安装无记录时读取安装目录 `package.json` |
| 最新版本 | 市场缓存克隆目录 `~/.dsh/marketplace/cache/<owner>__<name>/package.json` |

两者都存在且不一致 → 卡片显示「更新」按钮 + `已装 vX → vY` 提示。
（仅对含 `package.json` 的 cordis 插件生效；skill / 预设 / 脚本类无版本概念。）

### 已安装判定（五重，打开市场即自动比对）

1. `~/.dsh/marketplace/installed.json` 安装清单（本插件安装的）
2. 目录启发式探测：`~/.dsh/skills/<名>`、`~/.dsh/.agent-presets/<名>`、市场缓存克隆
3. 包名映射：扫描已安装目录的 `package.json` 名称（含 scoped 包 `@scope/name`），与仓库名 / 原始仓库名 / 索引包名（`pkg_name`）比对——仓库名与包名不一致（如 `DSH-Plugins-Marketplace` → `dsh-plugin-marketplace`）也能识别，并正确读出已装版本
4. **repository 归属校验（双向）**：已装包 `package.json` 的 `repository` 字段必须与目标仓库一致——既防「同名不同仓库」误判，也支持反向查找（先装插件后装市场时，scoped 包 / 包名差异大的插件也能正确标为已安装）
5. 本体识别：仓库命中本插件自身 `package.json` 的 `repository` 字段即视为已安装

> **官方插件自动排除**：DSH 自带的官方插件（`@deepseek-ai/*`，运行时自动枚举 + 内置兜底清单）永远不会被当成「用户安装的市场插件」，也不会被误标为已安装。

---

## 📁 文件结构

```
~/.dsh/
├── profiles/web/
│   ├── node_modules/dsh-plugin-marketplace/   ← 本插件本体
│   │   ├── package.json        （dsh.client 声明 + exports）
│   │   └── lib/
│   │       ├── index.js        （服务端：GitHub 拉取 / 安装管线 / 版本检测）
│   │       └── client.js       （客户端：市场页面 UI）
│   └── cordis.patch.yml        （插件注册条目）
└── marketplace/
    ├── cache/<owner>__<name>/  （克隆缓存，安装与版本对比的数据源）
    └── installed.json          （已安装清单：type / name / location / version / installedAt）
```

---

## 📡 HTTP 接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/marketplace/list` | GET | 插件列表（按 Star 降序，含 `installed` / `installedVersion` / `latestVersion` / `updateAvailable`）；`?refresh=1` 强制重新拉取 |
| `/api/marketplace/skills` | GET | 通用 Skills 列表（`skills.json` 索引，过滤 `has_skill !== false`，含 `installed` / `installedAt`）；`?refresh=1` 强制重新拉取 |
| `/api/marketplace/install` | POST | 安装 / 更新，body：`{ "repo": "owner/name", "answers": { "ENV_NAME": "值" } }`；返回 `done` / `awaiting-input` / `aborted` / `failed` 状态 + 逐步日志 |

---

## ⚠️ 安全说明

- 安装即信任该仓库：安装脚本（`install.sh` / `install.ps1`）会在你的机器上**执行任意代码**，市场会在执行前弹出确认
- 你提供的 API Key 等材料只作为**本次安装的环境变量**传入，不会写入任何持久化文件（安装脚本自身的行为除外）
- 第三方安装脚本运行时只获得**最小化环境变量**（基础系统变量 + 你提交的材料）；npm 依赖安装会剔除全部密钥类变量——`process.env` 不会全量外泄给插件代码
- 安装端点仅接受可信来源：请求必须携带 `X-DSH-Marketplace` 头，且 Host 在**白名单**内（本机回环 / 局域网私有网段 / 环境变量 `DSH_MARKETPLACE_ALLOWED_HOSTS` 显式追加），防跨站伪造与 DNS rebinding
- 插件包会被复制到 web profile 并注册到 `cordis.patch.yml`——这意味着它会随 DSH 启动加载，请只安装你信任的仓库

---

## ⚖️ 免责声明

- 本插件市场仅提供**发现与安装的便利**：市场中的所有插件均来自第三方 GitHub 仓库，由各仓库作者独立开发与维护，**与 DeepSeek Harness 及本插件市场没有任何关联**
- 插件市场**不对任何插件的质量、可靠性、安全性、可用性作任何明示或默示担保**——包括但不限于代码质量、许可证合规性、数据隐私、恶意行为、兼容性等
- 索引中出现某个插件**不构成任何推荐或背书**；安装即代表你已自行评估并接受相应风险，建议安装前阅读仓库源码与 README
- 本插件市场按「现状」（AS-IS）提供。因安装或使用任何第三方插件造成的任何直接或间接损失（包括数据丢失、系统损坏、隐私泄露等），**插件市场及其开发者不承担任何责任**

---

## 🔄 已知限制

- **安全模型**：安装端点无用户认证，防护依赖「本地网络隔离 + CSRF 头 + Host 白名单（本机/局域网/可配置）+ Origin 校验」——请勿将 DSH web 端口暴露到不可信网络；安装即意味着在机器上执行第三方代码（npm 依赖与安装脚本），请只安装你信任并已核验的仓库
- 版本检测仅对含 `package.json` 的插件生效；skill / 预设 / 脚本类无版本概念
- 插件列表默认走静态索引（CDN）；仅当索引的两个源都不可用时才回退 GitHub 搜索 API，此时未认证限流 **10 次/分钟**，频繁点「刷新」可能触发限流（会提示刷新失败，稍等再试）
- **Skills 索引范围**：v1.3 起为**全量索引**——通过 Search API「stars 分段 + 时间窗口二分」突破单 query 1000 条上限，收录 `agent-skills` ∪ `claude-skills` 全部仓库（当前 12000+）；`has_skill` 探测按 Core API 额度分批补齐（CI 每 2 小时增量续跑，未探测的仓库显示「未验证」）
- **索引更新节奏**：CI 每 2 小时增量拉取（最近 3 天 pushed 的仓库，新仓库/star/更新时间即时捕获），每天 04:00 UTC 全量重建刷新 star 数；`update-registry.bat` 手动触发时可用 `full=true` 立即全量
- 安装脚本类插件的「已安装」判定基于缓存目录存在性，卸载（删除缓存）后会重新显示为可安装
- 插件代码修改后需**重启 DSH** 才能生效（Web profile 的 HMR 处于禁用状态）

---

## 🌱 第三方生态

[Harness Desktop](https://github.com/baiyuscc13724-max/deepseek-harness-desktop) 是第三方社区维护的 Windows 桌面版，稳定版已内置本插件市场。用户可以在 **设置 → DSH插件市场** 中直接查看、安装和更新社区插件，无需使用命令行。

此条目由 Harness Desktop 作者提交；该作者同时维护桌面端使用的 DSH-Plugins-Marketplace 分支。Harness Desktop 与本仓库及 DeepSeek 官方均无官方关联。

---

## 🛠️ 开发与维护

- 修改服务端逻辑：编辑 `lib/index.js`（语法检查：`node --check`）
- 修改页面 UI：编辑 `lib/client.js`（浏览器 bundle，`window.__ModuleLoader__.load` 格式，`require` 可解析 DSH 平台模块）
- 修改后重启 DSH 生效；客户端 bundle 的版本号（rev）按内容哈希生成，重启后浏览器自动拉取新版本

---

## 📝 更新日志

版本迭代记录见 [CHANGELOG.md](CHANGELOG.md)（v1.0.0 之前为 beta 系列）。

---

## 📄 许可

MIT
