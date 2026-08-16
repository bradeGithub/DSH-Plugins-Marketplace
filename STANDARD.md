# STANDARD — DSH 插件市场收录与安装规范

🌐 **语言 / Language:** **中文** | [English](STANDARD.en.md)

> 本规范定义「一个仓库怎么写，才能被 [DSH 插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace)正确识别、正确安装、正确显示更新」。
> 市场安装管线是**特征驱动**的：它扫描仓库文件形态决定安装方式。本文档把判定规则、每类插件的规范写法、
> 以及踩过的坑（附真实案例）固化下来。**照此写，市场即可一键装、可更新、可卸载。**

---

## 0. 收录前提

- 仓库需添加 topic **`dsh-plugin`**（GitHub 仓库页 → Settings → Topics）。
- 市场 CI 每 2 小时扫描一次该 topic，自动收录；无需任何人工申请。
- 其余 topic 建议（帮助用户搜索与分类）：`dsh`、`deepseek-harness`、`agent-preset`、`cordis-plugin`、`dsh-skill` 等。

### 0.1 真插件最小定义（防 topic 蹭标签）

`dsh-plugin` topic 是收录入口，**不是**「真插件」的充分条件——非 DSH 仓库打标刷榜是生态已知问题
（实测案例：★40k 简历项目 `amruthpillai/reactive-resume`、★28k 的 `volcengine/OpenViking` 曾混入索引）。

「真插件」的最小硬信号（满足任一即可被识别为可安装内容）：

| 硬信号 | 判定类型 |
|---|---|
| 根/子目录 `package.json` 声明 DSH 插件能力（`dsh` 字段 / `@deepseek-ai/*` 依赖） | cordis-plugin |
| 根 `SKILL.md`（技能本体） | skill |
| 根 `preset.yml` + `agent.cordis.yml` | agent-preset |
| 根 `install.ps1` / `install.sh` | script（最低门槛） |

一个都没有 → 市场构建期判定为「非 DSH 插件」并盖红标（高 star 仓库有专项兜底判定）；完整判定顺序即 §1 的 10 步表。
该定义与 dshbase 等社区目录的收录门槛（仓库公开存在 + bundle 清单 + `dsh-plugin` topic）互认同源。

## 1. 类型判定总览（作者必读）

市场按**固定顺序**扫描仓库根目录特征文件，**先命中者生效**：

| 顺序 | 特征 | 判定类型 | 安装行为 |
|---|---|---|---|
| 1 | 根目录同时有 `preset.yml` + `agent.cordis.yml` | agent-preset | 复制到 `~/.dsh/.agent-presets/<id>` |
| 2 | 根 `package.json` 声明 DSH 插件能力（`dsh` 字段 / `@deepseek-ai/*` 依赖） | cordis-plugin | 构建/装依赖 → 复制到 profile node_modules → 注册 patch |
| 3 | 根目录有 **`install.ps1`**（未声明插件能力） | script | 执行该脚本（安全确认弹窗） |
| 4 | 根目录有 **`install.sh`**（未声明插件能力） | script | 执行该脚本（安全确认弹窗） |
| 5 | 子目录含完整预设（`preset.yml`+`agent.cordis.yml`） | agent-preset | 逐个复制 |
| 6 | 根 `package.json`（未声明 DSH 能力）+ 根 `SKILL.md` | skill | 复制到 `~/.dsh/skills/` |
| 7 | 根目录 `SKILL.md`（无 package.json） | skill | 同上 |
| 8 | 子目录含插件清单（皮肤/多包仓库） | cordis-plugin | 逐个子包安装 |
| 9 | 子目录含技能清单（技能合集） | skill | 逐个安装 |
| 10 | 无任何特征 | instructions | 展示 README 手动安装指引 |

> ⚠️ **最重要的两条规则**：
> 1. **第 2 条先于第 3/4 条（显式声明优先，机制兜底）**——声明过 `dsh` 插件能力的仓库即使根目录带 install 脚本也不会被判为脚本型，
>    cordis 插件附分发脚本是合法形态。但脚本留在根目录仍会**误导用户手动执行**，建议移入 `scripts/` 子目录（见 §6.1）。
> 2. `package.json` 的 `dsh` 字段（或 `@deepseek-ai/*` 依赖）是「插件能力声明」——有它才算 cordis 插件，
>    否则根 package.json 会被当成普通 npm 项目处理。

---

## 2. 类型 A：cordis 插件（推荐主形态）

**适用**：一切带 JS 运行时的 DSH 插件（服务端工具 / 客户端皮肤 / 事件处理）。

### 2.1 最小 package.json

```json
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "main": "./lib/index.js",
  "type": "module",
  "files": ["lib"],
  "dsh": {
    "plugin": true,
    "kind": "server",
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "repository": { "type": "git", "url": "https://github.com/you/dsh-my-plugin.git" }
}
```

字段要求：

| 字段 | 要求 |
|---|---|
| `name` | 合法 npm 包名（`PKG_NAME_PATTERN` 校验；scoped 包 `@scope/name` 允许）。**同名 npm 包互斥**——市场会把 pkg_name 冲突的低 star 仓库隐藏，请用唯一名 |
| `version` | 遵循 semver。**每次发版必须 bump**——市场用它做「更新」检测（npm 发布型插件的 npm_version 同理） |
| `main` / `exports` | 指向真实存在的入口文件。**入口缺失 + 有 `scripts.build` → 市场视为源码型，弹构建确认** |
| `dsh` | **插件能力声明**（有 `dsh` 对象即视为插件）。`dsh.bundle.patch` 指向 cordis patch 清单时，市场安装后自动注册到 profile 的 cordis.patch.yml |
| `repository` | 强烈建议填写——已安装识别（同仓库匹配）与市场卡片展示依赖它 |
| `dependencies` / `peerDependencies` | 市场安装时执行 `npm install --omit=dev --ignore-scripts`（用户确认后才放开脚本）；peer 冲突自动回退 `--legacy-peer-deps`。**DSH 宿主接口包（`@deepseek-ai/dsh-tools`、`dsh-llm`、`dsh-system-prompt`、`dsh-attachment`、`dsh-scope`、`dsh-schema`）只能进 `peerDependencies`，禁止进普通 `dependencies`/`bundledDependencies`**（构建期版本放 `devDependencies`）——否则旧版副本遮蔽宿主，工具调用全挂、内置预设失效（真实案例见 §6.6） |

### 2.2 源码型 vs 产物型

- **产物型（推荐）**：仓库提交构建产物（`lib/` 或 dist），`main` 指向已存在文件 → 市场直接复制安装，快且无构建风险。
- **源码型**：`scripts.build` 存在且 `main` 文件不在仓库（.gitignore）→ 市场安装时弹「安装依赖并执行构建」确认，
  用户确认后执行 `npm/pnpm install`（完整依赖含 dev）→ `npm run build` → 复制产物。构建脚本需在无交互环境下可用。

### 2.3 安装管线（市场自动完成）

1. 克隆仓库 → 判定 cordis-plugin；
2. 需要构建则构建确认 → 装依赖（默认禁第三方脚本）；
3. 复制到 `~/.dsh/profiles/web/node_modules/<pkg_name>`（排除 .git）；
4. 入口校验（main 文件存在 / dsh.bundle 声明 / 任意顶层 JS）；
5. 注册 `cordis.patch.yml`（幂等，行级精确匹配）；
6. 记录版本 → 重启 DSH 生效。

### 2.4 多包仓库（皮肤合集等）

根目录无 package.json 但子目录有插件清单 → 市场按 `findPluginRoots`（深度 3）**逐个安装子包**。
注意：子包的 package.json 同样需要 `dsh` 字段或 `@deepseek-ai/*` 依赖（否则不会被识别为插件）。

---

## 3. 类型 B：技能（skill）

**适用**：纯提示词技能（SKILL.md 形态，无 JS 运行时）。

- 根目录放 **`SKILL.md`**（大小写不敏感）；
- 可选 frontmatter 声明技能名：`name: my-skill`（小写字母数字连字符），缺失时用仓库名；
- 带工具链 package.json（未声明 `dsh`）的仓库：根 SKILL.md 仍按 skill 安装——**不要在 skill 仓库声明 `dsh` 字段**，否则会判成插件而漏装技能。
- 注意：`.git` / 点目录 / `node_modules` / vendored 目录（如 `upstream/`）里的 SKILL.md 会被忽略，不会误装。

## 4. 类型 C：agent 预设

**适用**：agent 预设包（preset 形态）。

- 同时含 `preset.yml` + `agent.cordis.yml` → 判定 agent-preset；
- 预设目录可放子目录（如 `preset/`，深度 3 内），市场逐个复制到 `~/.dsh/.agent-presets/<目录名>`；
- 若同时想装插件逻辑：把 JS 部分做成 cordis 插件（两个独立仓库，或插件仓库子目录放预设——判定顺序 4 在 5 之前，根目录**同时有**插件清单与子目录预设时，预设优先）。

## 5. 类型 D：安装脚本型（install.ps1 / install.sh）

**适用**：无法用上述形态表达的安装逻辑（系统级配置、外部依赖编排）。

脚本契约（市场克隆仓库后在仓库根执行）：

1. **自包含**：市场只克隆 git 仓库、不构建。脚本不能依赖构建产物（`lib/`、`dist/` 等 .gitignore 内容）；需要构建请在脚本内完成（`bash scripts/build.sh`）。
2. **幂等**：重复执行安全——已注册/已复制的部分自动跳过。
3. **双平台**：`install.ps1`（Windows，pwsh）与 `install.sh`（bash）按平台二选一；只提供一个则另一平台报错。
4. **环境解析**：`$env:DSH_HOME` / `$HOME` 判定 profile 目录；profile 不存在时明确报错。
5. **安全提示**：用户安装时会看到「执行第三方脚本有风险」确认弹窗——README 里如实说明脚本做什么。
6. **卸载**：脚本型安装无法自动回滚（市场卸载只删记录与克隆缓存），脚本自身效果需作者提供反向操作说明。

> ⚠️ **脚本型与 cordis 插件二选一**：如果项目本质是 cordis 插件（有 package.json + `dsh` 声明），
> **不要**在根目录放 install.ps1/install.sh——见 §6.1。脚本型安装没有版本检测、没有更新按钮、没有自动卸载。

## 6. 反模式与真实案例

### 6.1 根目录 install 脚本与 cordis 声明并存（dsh-paper-tutor 案例）

作者把 cordis 插件（`dsh.plugin=true` 声明齐全）的便捷安装脚本 `install.ps1`/`install.sh` 放在**仓库根**：
- 旧版判定顺序命中脚本特征 → script 型，跳过 cordis 管线；
- 脚本本地模式又依赖构建产物 `lib/index.js`（仓库未提交）→ 直接报错，**用户点安装必然失败**。

**现状（机制兜底）**：判定顺序已改为「`dsh` 声明优先于 install 脚本」——声明过插件能力的仓库即使脚本留在根目录也会正确按 cordis-plugin 安装（自动完成「构建确认 → 装依赖 → 复制 → 注册 patch」）。**但脚本仍建议移入 `scripts/` 子目录**：留在根目录会误导用户手动执行，且对「未声明 dsh 的脚本型仓库」而言根目录脚本仍是判定特征。

### 6.2 描述漂移导致分类跳变（dsh-TUI 案例）

市场用 `description` + `name` + `topics` 关键词做分类（coding/notify/memory/…）。某插件原分类 `coding`，
作者在简介里加了一句「DSH 官方公众号收录…WeChat featured」→ 命中 notify 规则 → 分类跳变，测试报警。

**作者须知**：简介里的宣传性词汇（微信/通知/商店/榜单）会影响分类。分类只影响市场展示栏目，不影响安装。
若被误分，可在市场仓库提 issue 申请人工覆写（`CATEGORY_OVERRIDES`）。

### 6.3 版本不 bump → 更新检测失效

市场的「更新」检测对比仓库 package.json 的 `version`（npm 型对比 npm dist-tags）。**只改代码不发版**会让
「更新」按钮永远不出现（用户只能卸载重装）。发版规则：改代码 → bump version → push（tag 可选）。

### 6.4 自己注册 patch → 双加载崩溃（issue #39）

插件安装时市场**自动**注册 cordis.patch.yml。插件不要在运行时/安装脚本里再注册自己的 patch 条目
（profile bundles 加载 + patch 双注册 → webserver 重复路由 → 启动崩溃）。市场安装的自己会跳过重复注册。

### 6.5 pkg_name 撞名 → 被隐藏

同名 npm 包在 node_modules 里互斥（互相覆盖）。市场对 pkg_name 冲突的仓库**只显示 star 高的一个**。
取名时请查一下 npm/registry 是否已被占用。

### 6.6 宿主接口包打成普通依赖 → 遮蔽宿主（dsh-excel-chat 案例）

某插件把 `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-system-prompt` / `dsh-attachment` 声明为普通 `dependencies`——
安装「成功」、插件也能加载，但这些**旧版副本被提升到 profile 顶层并优先于宿主加载**，导致：
- 所有工具调用失败（`Cannot read properties of undefined (reading 'prepare')`）
- DSH 内置 `minimal` 预设无法挂载（`ctx.systemPrompt.suppressRuntimeContext is not a function`）

**正确做法**：宿主接口包一律 `peerDependencies`（版本范围对齐当前 DSH），构建所需放 `devDependencies`。
市场安装时会静态检出普通依赖中的宿主包并弹确认警示（可拒绝）；但**市场警示不能替代平台修复**——同版本独立副本仍可能模块身份冲突，需要 DSH 宿主优先解析机制。

---

## 7. 自测清单（提收录前跑一遍）

```bash
# 1. 判定类型（预期之外的结果就是坑）
git clone <你的仓库> /tmp/x && 检查根目录特征文件对照 §1 表格

# 2. cordis 插件：入口与构建
node -e "const p=require('/tmp/x/package.json');console.log(p.dsh, p.main, require('fs').existsSync('/tmp/x/'+p.main))"
#    预期：dsh 对象存在；main 文件存在（产物型）或 scripts.build 存在（源码型）

# 3. 技能：SKILL.md 在根目录，frontmatter name 合法

# 4. 脚本型：两种平台脚本都有；无构建产物依赖；幂等（连跑 2 次无副作用）

# 5. 描述自查：无与插件本质无关的分类敏感词（微信/通知/商店/榜单…）

# 6. version 已 bump（与上次发版不同）

# 7. 披露自查：云端依赖 / 数据外发 / API key 存储 / 法域已在 SKILL.md frontmatter 或 package.json disclosure 字段如实声明（见 §9 字段契约）。
#    完整命令块见 skill-compliance 的 docs/disclosure-selfcheck.md（7a 云端依赖 / 7b 凭据 / 7c 权限 /
#    7d 端点一致性 / 7e 法域保留 / 7f 宿主依赖硬规则）；机器可读规则集
#    disclosure-selfcheck-rules.json（DISCL-001~006 + DEP-001）可由 skill-compliance v1.4.0 自动执行。

# 8.（可选）已跑过发布合规检查（如 skill-compliance：金融敏感词/免责声明/安全红线/广告法极限词 + 披露规则集）
```

---

## 8. 市场行为速查

| 能力 | cordis-plugin | skill | agent-preset | script |
|---|---|---|---|---|
| 一键安装 | ✅ | ✅ | ✅ | ✅（确认弹窗） |
| 版本检测 / 更新按钮 | ✅（package.json version；npm 型按 dist-tags） | ❌ | ❌ | ❌ |
| 自动卸载 | ✅（删目录 + 移除 patch） | ✅ | ✅ | ⚠️ 仅删记录（脚本效果不可回滚） |
| 依赖安装 | ✅（默认禁脚本，可确认放开） | — | — | 脚本自理 |
| 构建 | ✅（源码型弹确认） | — | — | 脚本自理 |
| 安全确认 | 依赖脚本确认（如有） | 无 | 无 | 第三方脚本风险确认 |

---

## 9. 发布披露清单（合规层最小契约）

> 识别层管「怎么装」，验证层管「装了能不能信」，**披露层管「装之前该不该装、数据去了哪」**。
> 以下披露项是作者契约的一部分——在 SKILL.md frontmatter（snake_case）或 package.json `disclosure`
> 字段（camelCase）中如实声明即可；市场通过**披露开放数据层**（`wwumit/skills-catalog` 的
> `catalog.json`，讨论 #2269 三方对齐的「方案 B」）构建期抓取盖章，客户端卡片显示「披露 ✓」徽章
> （悬停可见 云端/本地、端点、凭据、法域、保留策略摘要）。

### 字段契约（DISCLOSURE v0.2，与 wwumit 三方对齐）

| 披露项（必填分级） | frontmatter 声明形态 | 市场索引形态（catalog.json 输出） | 要求 |
|---|---|---|---|
| **D1 云端依赖**（必填） | `cloud: false` | `cloud` (bool) | 是否发数据到云端；端点列在 `network` |
| **D1 网络端点** | `network: []` | `network` (string[]) | 数据目的地，如 `["https://compliancehub.cn"]` |
| **D2 离线模式**（建议） | `offline_mode: true` | `offlineMode` (bool) | 是否存在完全离线路径 |
| **D3 凭据处理**（必填） | `api_keys: [{env, storage}]` | `apiKeys` ({env, storage}[]) | key 获取方式/存储位置（`file-0600` 等枚举）/是否落日志 |
| **D4 权限声明**（必填） | `permissions:` frontmatter | — | 网络/文件系统/环境变量读写范围 |
| **D5 法域标签**（建议） | `jurisdiction: []` | `jurisdiction` (string[]) | PIPL(CN)/CCPA(US-CA)/GDPR(EU) 等 |
| **D6 数据保留**（建议） | `retention: "session"` | `retention` (string) | none / session / server |

- 版本化：开放数据层顶层 `disclosureSchemaVersion`（当前 `"0.2"`）独立于验证层 `schemaVersion`；不匹配时市场**整体跳过不盖章**（fail-closed）
- 映射键：`fullName`（发布仓 `owner/name`），与验证层 verified.json 同款匹配逻辑；数据层另提供仓级 `repos[].cloudSkills` 索引与技能级 `skillFullName`——市场按仓库盖章时聚合云端技能详情（端点/凭据/法域去重合并、retention 取最严），同仓混合披露不再失真
- 示例见 [DISCLOSURE_PROPOSAL.md](https://github.com/wwumit/skills-catalog/blob/main/docs/DISCLOSURE_PROPOSAL.md)（wwumit v0.2 提案）

### 自测与检查（机器可读）

- **规则集**：[disclosure-selfcheck-rules.json](https://github.com/wwumit/skills-tools/blob/main/skills/skill-compliance/docs/disclosure-selfcheck-rules.json)（schema v1）——7 条规则（DISCL-001~006 + DEP-001）：id / 严重级 / 必填标记（D1/D3/D4 与 DEP-001 宿主依赖为必填）/ check_command / 判定说明，供检查器与 CI 直接消费
- **命令块**：[disclosure-selfcheck.md](https://github.com/wwumit/skills-tools/blob/main/skills/skill-compliance/docs/disclosure-selfcheck.md)（7a~7f）——作者提收录前手动跑
- **自动执行**：`skill-compliance` v1.4.0（`comply.py check`）全自动跑同一套规则，JSON 输出含 disclosure 摘要
- **三态衔接**：规则集的「缺必填」判定 = 市场卡片「⚠️ 缺必填项」态的机器依据；「无 disclosure 但有网络调用」=「❓ 未声明」态的依据（市场侧消费端已备好，接入时即用）

参考实现：`skill-compliance`（规则库 JSON → 检查 → 评分 → 报告，含金融敏感词/免责声明/安全红线/广告法极限词 + 披露完整性检查）。

---

## 10. 验证层对接（verification 字段契约）

> 「识别层管怎么装」之后是「**验证层管装了能不能信**」——运行时验证结论由社区验证工具产出，
> 市场在构建期抓取开放数据层并盖章到索引条目，客户端卡片显示「✓ 已验证」徽章（悬停可见
> 验证方/时间/证据摘要，点击直达逐条判定明细）。

### 字段契约（registry.json 条目，平铺）

| 字段 | 含义 | 来源 |
|---|---|---|
| `verdict` | `pass`（开放数据层只收录通过验证的条目；fail 结论由报告本体承载） | 开放数据层条目 |
| `verifiedBy` | 验证工具与版本（如 `dsh-plugin-verify@0.1.2`） | 开放数据层条目 |
| `verifiedAt` | 验证时间（时效判断依据） | 开放数据层条目 |
| `reportUrl` | 验证报告链接（逐条规则判定明细） | 开放数据层条目 |
| `schemaVersion` | 契约版本；不匹配时市场**整体跳过不盖章**（fail-closed，防演进破坏解析） | 开放数据层顶层 |
| `waterfall` / `toolsResult` | 摘要证据：waterfall 命中数（如 `7/7`）/ 工具真实执行是否成功 | 开放数据层条目 |

### 数据流

1. [dsh-plugin-verify](https://github.com/qing3a/dsh-plugin-verify)（社区验证工具，deepseek-harness discussion #2269 对接）产出 `reports/*.json`——报告以 **`fullName`**（插件仓库 `owner/name`）为稳定映射键；
2. 验证仓库根 `verified.json`（开放数据层）聚合全部已验证条目；
3. 市场 CI 每次构建抓取 `verified.json` → 按 `fullName` 匹配索引条目盖章（旧版条目回退从 `repo` URL 解析 owner/name）；
4. 客户端卡片显示「✓ 已验证」徽章，点击直达报告。

作者须知：验证是**第三方中立证据**，盖章 ≠ 市场背书；`verifiedAt` 决定时效——报告随插件演进过期，新版本需重新验证。

---

## 11. 外部参考（与官方/社区文档的分工）

本规范只覆盖**「市场识别层」**：仓库怎么写才能被市场正确收录/安装/更新。
更深层的「DSH 框架插件怎么写」（bundle manifest、patch 行、Service/客户端 API）请看：

- **官方**：[《打包与安装插件》publish.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)——bundle/profile 两个 manifest、加载顺序、patch 覆盖规则（本文档 §2 的 `dsh.bundle.patch` 即源于此）
- **社区**：[make-dsh-plugin skill](https://github.com/vlln/plugin-registry)——官方 bundle 形态选择表（`dsh.bundle`/`dsh.client`/`dsh.skills`/`dsh.mcpServers`）、验证纪律、gotchas
- **社区**：[dsh-plugin-development skill](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/.dsh/skills/dsh-plugin-development/SKILL.md)——运行面判断（host/client）、官方模板参考
- **精选列表**：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)——社区精选与安全免责声明（安装第三方代码的风险提示）

*维护者注：本文件与 `lib/index.js` 的 `detectType` / `installRepo` 实现一一对应；改动判定逻辑时须同步更新本表。*
