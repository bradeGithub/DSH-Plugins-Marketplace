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
| `dependencies` / `peerDependencies` | 市场安装时执行 `npm install --omit=dev --ignore-scripts`（用户确认后才放开脚本）；peer 冲突自动回退 `--legacy-peer-deps` |

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

## 9. 外部参考（与官方/社区文档的分工）

本规范只覆盖**「市场识别层」**：仓库怎么写才能被市场正确收录/安装/更新。
更深层的「DSH 框架插件怎么写」（bundle manifest、patch 行、Service/客户端 API）请看：

- **官方**：[《打包与安装插件》publish.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)——bundle/profile 两个 manifest、加载顺序、patch 覆盖规则（本文档 §2 的 `dsh.bundle.patch` 即源于此）
- **社区**：[make-dsh-plugin skill](https://github.com/vlln/plugin-registry)——官方 bundle 形态选择表（`dsh.bundle`/`dsh.client`/`dsh.skills`/`dsh.mcpServers`）、验证纪律、gotchas
- **社区**：[dsh-plugin-development skill](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/.dsh/skills/dsh-plugin-development/SKILL.md)——运行面判断（host/client）、官方模板参考
- **精选列表**：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)——社区精选与安全免责声明（安装第三方代码的风险提示）

*维护者注：本文件与 `lib/index.js` 的 `detectType` / `installRepo` 实现一一对应；改动判定逻辑时须同步更新本表。*
