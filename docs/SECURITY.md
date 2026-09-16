# 安全模型 / Security Model

本文件是插件市场**全部信任边界与防护机制的规范文档**：端点鉴权、安装确认门、环境变量隔离、供应链防护、自更新完整性链。改任何一处前请先读对应小节——安全语义不可削弱。

<!-- TOC -->
- [1. 信任边界总览](#1-信任边界总览)
- [2. 端点鉴权（两个判定谓词 × 三层能力门槛）](#2-端点鉴权两个判定谓词-三层能力门槛)
  - [2.1 可信判定 `isTrustedRequest`](#21-可信判定-istrustedrequest)
  - [2.2 写判定 `isWriteAllowed`（可信判定之上叠加）](#22-写判定-iswriteallowed可信判定之上叠加)
  - [2.3 三层能力门槛（逐端点真实归属）](#23-三层能力门槛逐端点真实归属)
  - [2.4 并发互斥](#24-并发互斥)
- [3. 安装管线的确认门（consent gates）](#3-安装管线的确认门consent-gates)
- [4. 环境变量边界](#4-环境变量边界)
- [5. 供应链防护](#5-供应链防护)
- [6. 自更新完整性链](#6-自更新完整性链)
- [7. 环境变量注册表](#7-环境变量注册表)
- [8. 已知残余风险（诚实边界）](#8-已知残余风险诚实边界)
<!-- /TOC -->

## 1. 信任边界总览

市场的信任模型是「本地优先」：

- **可信**：本机回环连接（socket 层判定，不可伪造）、用户在页面上的显式确认动作
- **受限可信**：局域网客户端（读开放、写需显式开启 + 会话 token）
- **不可信**：公网来源、第三方插件仓库代码（安装即执行）、跨站浏览器请求

安装某个插件 = 授权该仓库代码在本机执行。市场负责的是「执行前让你知情、执行中给最小环境、执行后可追溯」，不是沙箱隔离。

## 2. 端点鉴权（两个判定谓词 × 三层能力门槛）

所有 `/api/marketplace/*` 端点共享两个判定谓词（`lib/http/auth.js`），但**门槛按操作能力分级，不按 HTTP 方法**——部分 GET 无门槛、部分 POST 只到可信层：

### 2.1 可信判定 `isTrustedRequest`

三重校验，任一失败返回 403：

- `X-DSH-Marketplace: 1` 自定义头必须存在——跨站简单请求无法携带自定义头，浏览器会强制 preflight 被 CORS 拦下（CSRF 防线）
- `Host` 必须在白名单内：本机回环 / 局域网私有网段 / `DSH_MARKETPLACE_ALLOWED_HOSTS` 显式追加——攻击者域名（含 DNS rebinding 解析到 127.0.0.1 的域名）一律拒绝
- 若带 `Origin` 头，其 host 必须与请求 `Host` 完全一致（含端口）；无 `Origin` 的非浏览器调用方（curl/本地脚本）放行

### 2.2 写判定 `isWriteAllowed`（可信判定之上叠加）

- **回环直连**：`req.socket.remoteAddress` 为 `127.0.0.1` / `::1`（IPv4-mapped 归一处理）→ 直接放行。判定基于连接层地址，LAN 客户端自报 `Host: 127.0.0.1` 无法伪造
- **LAN 写**：需同时满足——`config.json` 的 `lanWrite === true`（文件缺失/损坏视为关闭，默认安全）+ 请求头 `x-dsh-marketplace-token` 等于会话 token（`timingSafeEqual` 比较，长度不等直接拒防时序泄露）
- 会话 token 每次启动随机生成，不落盘

### 2.3 三层能力门槛（逐端点真实归属）

| 层 | 门槛 | 端点 |
|---|---|---|
| **公开读** | 无 | `list` GET、`skills` GET、`self-update` GET（状态查询） |
| **可信读 / 出网触发** | `isTrustedRequest` | `list`/`skills` 的 `?refresh=1` 修饰、`backup` GET、`restore/diff` POST（只算差异不落库）、`logs`、`feedback/pending`、`feedback/token` GET、`env-keys`、`profile` GET、`check-update` POST（触发 npm registry 查询） |
| **写** | `isWriteAllowed` | `install`、`uninstall`、`self-update` POST、`profile` POST、`env-edit`、`feedback` POST、`feedback/token` POST、`backup/webdav`、`restore/webdav` |

设计注记：列表基础读**无鉴权是刻意的**（无鉴权公开读）；`?refresh=1` 会触发上游拉取，才加可信门槛——防跨站 simple-request（`<img>`/form 无需自定义头即可发 GET）借 refresh 刷爆未认证 GitHub API 限流。同理，`check-update`/`restore/diff` 虽是 POST 但属「触发出网 / 只读预览」语义，停在可信层不进写层。

### 2.4 并发互斥

`install` / `uninstall` / `self-update` POST 三处持同一把安装互斥锁执行（`runInstallExclusive`），忙时返回 409（`installBusy` / `selfUpdateBusy`）；`profile` POST 只做 `isBusy` 预检——忙时 409 拒入但不取锁（切换本身是毫秒级配置写入，与长任务互斥即可，无需排队）。

## 3. 安装管线的确认门（consent gates）

安装流程共有 **11 个暂停点**：1 个材料收集门（question `id` = 环境变量名，非 `__confirm_*` 键）+ 10 个 `__confirm_*` 确认门。全部以 `awaiting-input` 状态返回前端，`answers` 字段携带作答后再次 POST 续跑；门按代码顺序逐个触发，一次 POST 可能停在下一个未答门。

**材料收集门**（先于全部 `__confirm_*` 门）：`script`/`cordis-plugin` 型仓库扫描声明的必需环境变量（≤8 个，`scanRequirements`），逐个出 `qEnv` 问题收集；`answers` 里出现该键即视为已答（可留空，空值以空串传入执行环境）。

| 门 | 触发条件 | 前端选项 | 放行条件 | 拒绝后果 |
|---|---|---|---|---|
| `__confirm_cli__` | README 给出 CLI 安装命令且 target 过 `isCliInstallTarget` 白名单 | `continue` / `cancel` | `=== "continue"` | **不中止安装**——跳过 CLI 代执行，回退常规市场安装流程 |
| `__confirm_secrets__` | 克隆仓库检出**硬编码 secrets**（`scanCacheSecrets`，命中文件/行号/类型） | `continue` / `cancel` | 非 `cancel` | `cancel` → 清理克隆缓存 + `aborted` |
| `__confirm_vulns__` | 依赖审计检出漏洞（`scanCacheVulnerabilities`，展示前 10 条） | `continue` / `cancel` | 非 `cancel` | `cancel` → 清理克隆缓存 + `aborted` |
| `__confirm_bundle__` | `type === "bundle"`（bundle 注册会写 profile dependencies 并执行 pnpm install，生命周期脚本是否运行不确定，故同级显式确认） | `allow` / `deny` | 非 `deny` | `deny` → 清理克隆缓存 + `aborted` |
| `__confirm_script__` | `type === "script"`（存在 `install.sh`/`install.ps1`，附 hazard 扫描结果） | `continue` / `cancel` | `=== "continue"` | 非 `continue` → 清理克隆缓存 + `aborted` |
| `__confirm_npm_scripts__` | `cordis-plugin` 检出 npm 生命周期脚本（`prepare`/`install`/`postinstall` 等，附 hazard 扫描） | `allow` / `deny` | 非 `deny` | `deny` → 清理克隆缓存 + `aborted` |
| `__confirm_host_deps__` | `cordis-plugin` 检出宿主遮蔽依赖（`scanHostShadowDeps`） | `continue` / `deny` | 非 `deny` | `deny` → 清理克隆缓存 + `aborted` |
| `__confirm_non_plugin__` | `cordis-plugin` 但无插件根且 `looksLikeDshPlugin === false` | `continue` / `cancel` | 非 `cancel` | `cancel` → 清理克隆缓存 + `aborted` |
| `__confirm_build__` | `cordis-plugin` 需构建（`needsPluginBuild`） | `allow` / `deny` | 非 `deny` | `deny` → 清理克隆缓存 + `aborted` |
| `__confirm_manual__` | `type === "instructions"`（无可自动安装形态，展示 README 前 800 字符） | **仅 `cancel`** | 非 `cancel` → 继续返回 `status: "manual"` + 仓库链接 | `cancel` → 清理克隆缓存 + `aborted` |

放行语义分两族：**严格放行**（`cli`/`script`——仅 `continue` 放行）与**中止值放行**（其余——除 deny/cancel 外任意值放行）。中止统一经 `cleanup(cacheDir)` 清理克隆缓存后返回 `aborted`；此时安装尚未写入任何目标目录或注册项，无中间态需要回滚。

> 历史注记：`__confirm_script__` 的中止分支曾不调用 `cleanup`（单测以「保留确认重试上下文」锁定），残留缓存会被 `cacheScripts` 判为已安装并锁死安装按钮——已修复为与其他门一致清理（登记见 [LIB-ISSUES.md](LIB-ISSUES.md) #11）。

## 4. 环境变量边界

- **第三方安装脚本**（`script` 型）：只获得 `buildMinimalEnv()`——`SCRIPT_ENV_KEYS` 白名单内的基础系统变量（PATH/HOME/TEMP/SHELL 等）+ 用户本次提交的材料——`process.env` 不会全量外泄
- **其余类型执行**（cordis 插件 npm 安装、CLI 代执行、卸载 pnpm remove）：`buildFilteredEnv()` 全量 env 剔除 `isSensitiveEnvKey` 命中项——`TOKEN`/`KEY`/`SECRET`/`PASSWORD`/`PASS`/`CREDENTIAL(S)`/`AUTH*` 值端凭据形态（字母数字感知边界，`KEYBOARD_LAYOUT`/`AUTH_TYPE` 不误伤）
- **用户材料**（`API_KEY` 等）：仅作为本次安装进程的环境变量传入（`envAllowList` 白名单收口，`__` 前缀内部键不注入），不写入任何持久化文件（安装脚本自身的行为除外）
- **env-edit 端点**：只允许写入该插件安装记录中登记过的 `envKeys` 键名，且键名须过 `isValidEnvKey`（拒绝 `DSH_` 保留前缀等 bootstrap-only 键），防止越权改任意变量；值落盘 `~/.dsh/marketplace/envs.json` + `~/.dsh/.env`
- **日志脱敏**：安装日志对外输出前经 `lib/redact.js` 多层净化（密钥/路径/上下文邻近/高熵+base64 重扫兜底），规则成对维护见 [TESTING.md](TESTING.md) §5.4

## 5. 供应链防护

- **符号链接拒绝**：安装复制时对每个条目做 `lstat` 检查，符号链接一律拒拷（`lstat` 失败同拒，fail-closed）——防止仓库内 symlink 指向 `~/.ssh/id_rsa` 之类宿主文件造成越界读
- **bundle 注册**：`bundle-register.js` 用 `realpath` 解析锚点，拒绝路径逃逸
- **克隆缓存所有权**：marketplace cache 目录归属校验，防 `url.insteadOf` 改写下的伪装归属
- **WebDAV 备份/恢复**（`isSafeWebdavUrl` + 手动重定向）：
  - 仅允许 http/https 绝对 URL；内嵌 `user:pass@` 一律拒绝（凭据走独立字段）
  - http 明文只允许局域网主机（私网 IPv4 / ULA IPv6 / `.local` / 单标签内网名——NAS WebDAV 典型形态）；公网强制 https，Basic 凭据与备份内容禁走明文
  - 任意 scheme 拒绝：`localhost`/`*.localhost` 主机名、回环、链路本地（169.254/16、fe80::/10 云元数据段）、未指定、CGNAT、IETF 分配/基准测试/文档段、组播、保留段、IPv6 过渡机制前缀（Teredo/6to4/NAT64 可走私内嵌 IPv4）；IPv4-mapped/compatible 地址按内嵌 v4 同规则判定；整数/十六进制/短式 IPv4 混淆写法经 WHATWG 归一后同判
  - 端口不限制（NAS WebDAV 常用自定义端口，白名单只会误伤）
  - `redirect: "manual"` 逐跳重检——每一跳重新过 `isSafeWebdavUrl`，防重定向跳到内网
- **请求体上限**：`MAX_BODY_BYTES` 1MB；仓库名正则校验；包名符合 npm 命名规则；CLI 安装目标白名单（`isCliInstallTarget`）

## 6. 自更新完整性链

市场本体自更新只采纳**经维护者 SSH 私钥签名的 release tag**：

1. 候选 tag 按版本降序逐个验签（上限 `MAX_TAG_CANDIDATES`），**首个通过者生效**——未签名/验签失败的更高版本 tag 不阻塞更新，逐个跳过
2. 验签在本地 git 对象上进行（`init --bare` + fetch tag ref + `cat-file` 取 tag 原文 + sshsig 验证），不依赖远端声明或 GitHub `verification.verified` 字段
3. 绑定链：ref 名 ↔ tag 对象内 tag 名一致；tag 声明的版本号 ↔ 该 ref 处 `package.json` version 一致；staging 检出后 HEAD == 已验证 commit SHA
4. staging 目录按 commit SHA 检出（`fetch --depth 1 origin <sha>`，免疫「验签后 tag 被拧走」）、核心文件校验后原子替换（`destRoot → backup → staging → destRoot`，第二步失败回滚）；任一步失败 fail-closed 拒更
5. 信任根 `ALLOWED_SIGNERS` 按**维护者**建模编译进 bundle（远端同名文件概不采信），`signedBy` 署名归因；吊销走 `REVOKED_KEYS`，生效点恒为「已信 key 签名的 release」——防信任自传播
6. GitHub 仓库写权限被夺也无法静默推送恶意更新——验签不依赖仓库信任

签名与发版操作细节见 [RELEASE.md](RELEASE.md) §2。

## 7. 环境变量注册表

| 变量 | 作用 | 缺省行为 |
|---|---|---|
| `DSH_MARKETPLACE_ALLOWED_HOSTS` | 逗号分隔追加可信 Host（主机名/IP） | 仅回环+LAN 私有段 |
| `DSH_MARKETPLACE_UPDATE_PRERELEASE` | 置 `1` 允许自更新采纳预发布 tag | 仅 `MAJOR.MINOR.PATCH` 稳定版 |
| `DSH_MARKETPLACE_ALLOW_UNSIGNED_UPDATE` | 置 `1` 跳过签名验证（**不建议开启**的逃生口；未签名 tag 仍须过 objectType=commit 与 tag↔version 绑定） | 验签 fail-closed |
| `DSH_MARKETPLACE_UPDATE_EXTRA_SIGNERS` | `;` 分隔追加可信签名公钥行（开发/测试追加面，与本地代码同信任级） | 仅内置 `ALLOWED_SIGNERS` |
| `DSH_MARKETPLACE_UPDATE_REPO_URL` | 覆盖自更新源仓库 URL（镜像/测试重定向；验签仍在本地 git 对象上进行，改 URL 不绕过签名） | `https://github.com/bradeGithub/DSH-Plugins-Marketplace.git` |
| `DSH_MARKETPLACE_BUNDLED_DIR` | 覆盖内置索引目录（测试隔离接缝） | 插件包根目录的 `registry.json`/`skills.json` |

## 8. 已知残余风险（诚实边界）

- **回环放行 = 本机任意进程可写**：回环连接直接放行写操作意味着本机其他进程也能借插件发请求——这是「本地优先」模型的固有取舍，靠不把 DSH web 端口暴露到不可信网络兜底
- **WebDAV 域名 rebinding 残余**：`isSafeWebdavUrl` 不做 DNS 解析（纯函数零 IO），「域名先解析到公网、请求时 rebinding 到内网」的窗口存在；残余暴露靠端点门禁 + 响应只回传 diff 兜底
- **安装任务无用户认证**：防护依赖网络层隔离，不含身份概念
- **curl|bash 固有限制**：安装脚本方式的 tarball 无签名校验（`install.sh` 头部注释有说明），这是远程脚本模式的固有弱点
