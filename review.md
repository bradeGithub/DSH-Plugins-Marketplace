# DSH-Plugins-Marketplace 代码审查报告（第二轮）

- 审查日期：2026-08（第二轮，针对 v0.9.0-beta / v1.0.0 安全加固版本）
- 审查范围：全部源码文件（`lib/index.js`、`lib/client.js`、`scripts/build-registry.mjs`、`install.ps1/sh`、`update-registry.*`、`.github/workflows/registry.yml`、`README*`、`CHANGELOG.md`、`registry.json`）
- 审查维度：安全性、正确性、性能、可维护性、风格一致性、文档一致性

> 背景：第一轮报告（C1/C2 两个 Critical、M1–M6 六个 Major 等）提交后，项目方发布了 v0.9.0-beta 安全加固（见 `CHANGELOG.md:16-33`）。本轮对每个修复逐一验证，并重新审视全部代码，找出残留问题与加固引入的新问题。

---

## 一、上一轮问题修复验证

| 编号 | 上一轮问题 | 状态 | 说明 |
|---|---|---|---|
| C1 | 安装端点无 CSRF 防护、脚本确认可伪造 | ⚠️ 部分修复 | 已加 `X-DSH-Marketplace` 自定义头 + Origin===Host 校验（`lib/index.js:323-332`），客户端三处 fetch 均已带头（`lib/client.js:276,287,299`）。**残留 DNS rebinding 弱点**，见下方 R1。 |
| C2 | `pkg.name` 未校验 → 路径穿越/任意删除/YAML 注入 | ✅ 已修复 | `PKG_NAME_PATTERN` 白名单（`lib/index.js:33,790-792`）+ `resolve` 前缀包含双保险（`lib/index.js:793-797`），scoped 包 `@scope/name` 也安全。 |
| M1 | `answers` 键注入 env + 敏感变量全量泄露 | ⚠️ 部分修复 | 键白名单已修（`lib/index.js:740-745`）。**`process.env` 全量传给第三方脚本未修**，见 R2。 |
| M2 | cordis 安装静默执行第三方 npm 脚本 | ✅ 已修复 | 默认 `--ignore-scripts`（`lib/index.js:531-535`），回退链两步。 |
| M3 | `javascript:` URL XSS | ✅ 已修复 | 双层防御：服务端 `normalizeRepo` 只放行 `https://github.com`（`lib/index.js:416-433`）+ 客户端渲染前正则复核（`lib/client.js:164-165`）。 |
| M4 | 并发安装/patch 写竞态 | ✅ 已修复（有瑕疵） | `installLocks`（`lib/index.js:649,727-732`）+ patch 队列 + 临时文件原子 rename（`lib/index.js:344-360`）。瑕疵见 m3、m4。 |
| M5 | 请求体无上限 | ✅ 已修复 | 1 MB 上限 + 413（`lib/index.js:29,301-315`）。 |
| M6 | 注册判定子串误判 | ✅ 已修复 | 行级精确匹配（`lib/index.js:334-338`、`install.ps1:43`、`install.sh:37`）。 |
| m1 | 密钥输入框明文 | ✅ 已修复 | `type: "password"` + `autoComplete: "off"`（`lib/client.js:220-223`）。 |
| m2 | 列表检测串行慢 | ✅ 已修复 | 12 并发 + 提前预热缓存（`lib/index.js:594-622`）。 |
| m4 | 兜底搜索无 GH_TOKEN | ✅ 已修复 | 支持 token + 50 页上限（`lib/index.js:459-460`）。 |
| m5 | ENV_PATTERN 过窄/误伤 | ✅ 已修复 | 支持 camelCase、`_PASS` 前文约束（`lib/index.js:26`）。 |
| m6 | skill 复制含 .git、子串误伤 | ✅ 已修复 | `copyFilter` 边界精确匹配（`lib/index.js:381-389`）。 |
| m7 | `.ca-bundle.crt` 被复制 | ✅ 已修复 | `install.ps1:37`、`install.sh:33` 显式删除。 |
| m9 | partial-merge 不清理陈旧条目 | ✅ 已修复 | `registry_seen_at` + 14 天剔除（`scripts/build-registry.mjs:96-110`），`registry.json` 已含新字段（已核验）。 |
| m10 | 版本比较 | ⚠️ 部分修复 | `compareVersions` 已引入（`lib/index.js:363-379`），但更新方向判断与预发布比较仍有问题，见 m2、n3。 |
| m11 | 无测试 | ⚠️ 部分 | CI 已加 `node --check` 语法检查（`registry.yml:22-26`），仍无单元测试。 |
| n1 | 405 文案硬编码 | ✅ 已修复 | `lib/index.js:590,635` 已走 `t(lang, "methodNotAllowed")`。 |
| n2 | 安装脚本 id 与运行时不一致 | ✅ 已修复 | 统一为 `dsh-plugin-marketplace`（`install.ps1:46`、`install.sh:40`）。 |
| n7 | README 未记录安全模型 | ✅ 已修复 | 新增「安全说明」+「已知限制·安全模型」（`README.md:163-167,182`），中英双语一致。 |
| m3/m8/m12/n3/n4/n5/n6 | 全量渲染、CI 频率、安装完整性、exports、徽章、log key、顶层 await | ❌ 未修 | 均为上轮 Minor/Nit，本轮保持原样（见下方清单）。 |

---

## 二、新发现问题

### R1（Major·残留）DNS rebinding 防护不完整
`lib/index.js:323-332`（`isTrustedRequest`）

- **问题**：Origin===Host 校验防得住普通跨站 CSRF，但防不住 **DNS rebinding**：攻击者让 `evil.com` 解析到 `127.0.0.1:3080` 后，用户访问 `http://evil.com:3080` 的页面时，页面 origin 与请求 Host **都是** `evil.com:3080`——校验通过；且此时请求对浏览器而言是同源的，**自定义头也不受 preflight 限制**。代码注释"攻击者域名无法伪造 Host"不成立：Host 头由浏览器按 URL 填写，正是攻击者域名。
- **缓解因素**：Chromium 系浏览器的 Private Network Access 会拦截部分公网→本机请求；Firefox/Safari 未完整实现，仍可被利用。利用门槛高于普通 CSRF，但这是 C1 声称修复的完整闭环中的缺口。
- **修复建议**：校验 Host 头白名单——只允许 `localhost`、`127.0.0.1`、`[::1]`（以及显式配置的局域网地址），而非与 Origin 比较。白名单外的 Host 直接拒绝。

### R2（Major·残留）全部 `process.env` 仍传递给第三方脚本
`lib/index.js:740`（`const env = { ...process.env }`）、`lib/index.js:773,776`（script 类型执行）

- **问题**：M1 修复只限制了 `answers` 的键，但构建 env 时仍整体展开 `process.env`。第三方 `install.sh` / `install.ps1` 一旦被用户确认执行，就能静默读取用户机器的全部环境变量——包括 `GH_TOKEN`、`GITHUB_TOKEN`、各类 API Key 等敏感值并上传。`scanRequirements` 的设计意图是"只把用户明确提供的材料传给插件"，但全量环境传递使该意图落空。
- **修复建议**：对 script 类型构造最小化 env（`PATH`、`HOME`、`TEMP`、`USERPROFILE` 等白名单 + `answers`）；对 npm 安装至少过滤 `*_TOKEN` / `*_KEY` / `*_SECRET` / `*_PASSWORD` 类变量（npm 自身不需要它们）。

### R3（Major·新发现，正确性）环境变量"空值可跳过"实际无法跳过，安装陷入循环
`lib/index.js:666`（`.filter((v) => !answers[v])`）、`lib/index.js:197-198`（UI 文案"空值可跳过"）

- **问题**：UI 明确提示"空值可跳过"（中英文案均如此）。但用户提交空字符串时 `answers[v] === ""`，`!""` 为 `true`，变量仍被判定为缺失 → 服务端再次返回 `awaiting-input` → 用户再次提交空值 → **永远循环，无法继续安装**，只能点取消。用户完全不填写直接点"提交"同样循环（键不存在时 `!undefined` 也为 `true`）。这意味着所有需要环境变量的插件，用户要么填值、要么放弃——"跳过"承诺是虚假的。
- **修复建议**：改为 `.filter((v) => !(v in answers))`（或判断 `answers[v] === undefined`），空字符串视为"已提供、跳过"。

### m1（Minor）并行标注破坏了"按 Star 排序"的列表顺序
`lib/index.js:596-622`（worker 内 `flagged.push`）

- **问题**：12 个 worker 并发处理，`flagged.push` 按**完成顺序**而非原始 `repos` 顺序插入。各仓库磁盘 IO 耗时不同，返回给客户端的列表顺序被打乱，README 承诺的"按 Star 数从高到低排列"失效（Star 排序只在 `fetchAllRepos` 阶段生效，标注阶段被洗乱）。
- **修复建议**：用索引写入 `flagged[i] = ...`（改游标为原子计数器同时记录索引），或 push 后按 `stargazers_count` 重排。

### m2（Minor）更新提示方向判断错误（降级也会提示"更新"）
`lib/index.js:613`（`compareVersions(installedVersion, latestVersion) !== 0`）

- **问题**：只要版本**不同**就置 `updateAvailable = true`。已装 `1.2.0`、最新 `1.0.0` 时（如仓库回滚），UI 显示"已装 v1.2.0 → v1.0.0"的"更新"按钮。
- **修复建议**：改为 `compareVersions(installedVersion, latestVersion) < 0`。

### m3（Minor）安装锁 key 大小写敏感，可绕过互斥
`lib/index.js:649,727`（`installLocks` 以原始 `repo` 字符串为 key）

- **问题**：`Foo/Bar` 与 `foo/bar` 是两个锁 key，但 `cacheDir` 都归一为 `foo__bar`（`lib/index.js:656`）——并发安装同一仓库（不同大小写写法）时 `rm` / clone / cp 仍会互相踩踏。M4 的互斥闭环存在绕过路径。
- **修复建议**：锁 key 用规范化形式：`repo.toLowerCase()` 或直接以 `cacheDir` 路径作 key。

### m4（Minor）patch 写入失败被静默吞掉，并显示误导性日志
`lib/index.js:358`（`patchQueue = task.catch(() => {})`）

- **问题**：`appendPatchEntry` 内 `readFile` / `writeFile` / `rename` 抛错时被 `catch(() => {})` 吞掉，函数静默返回 `undefined` → 调用方（`lib/index.js:809-810`）走 `patchExists` 分支，日志显示"已存在该插件条目，跳过注册"，而实际 patch 并未写入；安装仍被标记为 `done` + `installed`。用户会被误导认为注册成功，插件加载失败后无从排查。
- **修复建议**：队列 catch 仅用于防止队列断链，但保存首个错误并在 `await` 之后重新抛出（或返回明确的状态枚举），让安装流程如实报错。

### m5（Minor）`saveInstalled` 读-改-写竞态
`lib/index.js:56-64`

- **问题**：与 patch 同类的读-改-写问题，但 `INSTALLED_FILE` 没有进队列。两个不同仓库并发安装完成时，若快照读取与写入交错，后写者可能覆盖先写者，丢失一条已安装记录（后果：UI 误显示"可安装"，无破坏性，但属于同类缺陷遗漏）。
- **修复建议**：与 `appendPatchEntry` 一样走串行队列，或改为追加式写（读文件 → 合并 → 写，串行化）。

### m6（Minor）外部 fetch 无超时，CDN 挂起会长期阻塞列表服务
`lib/index.js:391-397`（`fetchJson`）、`lib/index.js:436-456`（`fetchRegistryRepos`）

- **问题**：两个 `fetch` 均无 `AbortSignal.timeout`。jsDelivr 挂起时，启动预热的 `getList()` 会长期占用 `listFetching`（`lib/index.js:491-501`），此后所有 `/api/marketplace/list` 请求都排队等待同一个挂起请求，页面"正在从 GitHub 加载 ..."卡死（子进程有 timeout，网络 fetch 没有）。
- **修复建议**：`fetch(url, { signal: AbortSignal.timeout(15000) })`，失败即尝试下一个源/回退。

### Nit（本轮新增）
- **n1. 死文案**：`MESSAGES` 中 `npmFallbackScripts`（`lib/index.js:218,261`）在 `--ignore-scripts` 默认化后已无引用，建议删除或复用为提示"依赖脚本已跳过"。
- **n2. 403/413 错误消息硬编码英文**（`lib/index.js:637,642`）：与全站 i18n 不一致（n1 修复遗漏了这两个新端点路径）。
- **n3. `compareVersions` 预发布比较是词法比较**（`lib/index.js:378`）：`rc.10` vs `rc.9` 顺序错误；且解析仅支持 `x.y.z`，两位版本号（`1.0`）回退字符串比较。建议逐段数字比较预发布标识。
- **n4. `readJsonBody` 字符串拼接**（`lib/index.js:305`）：`raw += chunk` 按 chunk 独立解码，多字节 UTF-8 跨 TCP 分片时会产生替换字符，极端情况下合法 JSON 解析失败。建议 `Buffer.concat` 后一次性解码。
- **n5. 客户端对 403/409 的响应处理不佳**（`lib/client.js:301-317`）：403（CSRF 拒绝）/409（并发拒绝）时 `data.status` 为 undefined → 面板走 failed 分支但 `data.log` 为空 → 显示"安装失败: unknown"，用户无法得知真实原因。建议客户端识别 `data.error` 并写入日志。
- **n6. 上轮未修项**（保持不变，不再展开）：客户端 491 卡片全量渲染无虚拟列表（`lib/client.js:365-371`）；CI 每 2 小时约 1600 分钟/月接近 Actions 免费额度（`registry.yml:6`）；`irm | iex` / `curl | bash` 安装模式无完整性校验提示；`package.json:9` 导出浏览器 bundle 为 Node 入口；0 star 仓库显示"新仓库"徽章（`lib/client.js:170`）；日志列表用数组下标作 key（`lib/client.js:196,239`）；模块顶层 `await loadInstalled()`（`lib/index.js:177`）。

---

## 三、已验证无问题（本轮新增核验）

- ✅ **C2 完整闭环**：白名单 + `resolve` 前缀双保险对普通包、scoped 包、`..`、绝对路径、Windows 反斜杠均安全；`PKG_NAME_PATTERN.test` 无 `g` 标志，无 lastIndex 状态问题。
- ✅ **CSRF 自定义头在客户端三处请求全覆盖**（列表×2 + 安装×1），服务端严格 `=== "1"` 比较；Origin 非法/缺失 Host 时默认拒绝（fail-closed）。
- ✅ **互斥锁时序正确**：锁检查（`lib/index.js:649`）与锁设置（`lib/index.js:727`）之间无 await 让出点，同仓库并发请求的 409 判断无竞态窗口；`finally` 保证锁释放。
- ✅ **`copyFilter` 边界精确**：`.git` 与 `node_modules` 均按 `src === dir || src.startsWith(dir + sep)` 判断，`node_modules_backup` 类目录不再误伤。
- ✅ **`hasPatchEntry` 正则转义正确**，包名中的正则元字符不会破坏匹配。
- ✅ **并行 worker 的游标 `cursor++` 在同步段执行**（单线程安全），12 并发无越界。
- ✅ **`registry_seen_at` 已随 CI 产物落盘**（`registry.json` 全部条目含该字段，已核验），14 天剔除逻辑（`scripts/build-registry.mjs:104-110`）对旧格式条目（缺失字段 → epoch）也能正确剔除。
- ✅ **`--ignore-scripts` 默认化与 CHANGELOG/README 表述一致**；脚本类型插件的确认流程未受影响（`lib/index.js:682-702`）。
- ✅ **安装失败清理、缓存不复用判定、客户端过期响应丢弃**等上轮已验证项在新版中逻辑未变，仍有效。

---

## 四、总结

| 级别 | 数量 | 内容 |
|---|---|---|
| Critical | 0 | 上轮 2 个 Critical 均已修复（C2 完整、C1 主体已修但留 rebinding 缺口，见 R1） |
| Major | 3 | R1（DNS rebinding 缺口）、R2（process.env 全量泄露给第三方脚本）、R3（环境变量空值无法跳过→安装循环，正确性 bug） |
| Minor | 6 | m1（列表排序被打乱）、m2（降级误报"更新"）、m3（锁 key 大小写绕过）、m4（patch 错误被吞）、m5（installed.json 写竞态）、m6（fetch 无超时） |
| Nit | 6（新）+ 6（上轮未修） | 见上 |

**结论**：v0.9.0-beta 的加固质量整体扎实——C2、M2、M3、M5、M6 等高风险项修复完整且实现干净，双保险设计（白名单+路径包含、双层 URL 校验）值得肯定。剩余问题中 **R3 是影响普通用户可用性的正确性 bug（建议立即修）**，R1、R2 是安全模型的收尾工作。修复这三项后，本项目不再有超出"用户知情自担风险"设计前提的漏洞。

**优先修复顺序建议**：R3 → R1 → R2 → m1 → m4 → m3 → m2 → m5 → m6。
