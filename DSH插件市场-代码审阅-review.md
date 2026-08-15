# DSH-Plugins-Marketplace 代码审阅报告

- 仓库：<https://github.com/bradeGithub/DSH-Plugins-Marketplace>
- 审阅版本：v1.3.11（commit `9fb3ffb`，2026-08-15）
- 审阅范围：`lib/index.js`（2037 行服务端）、`lib/client.js`（726 行客户端）、`install.sh` / `install.ps1`、`scripts/build-registry.mjs` 及测试/CI 脚手架、文档

---

## 总体评价

**结论：工程质量明显高于同类社区项目的平均水平，可以打 8/10。** 这不是"能跑就行"的玩具代码：有完整的单元 / 集成 / e2e / smoke 测试与覆盖率脚本、pre-commit 钩子、详实到近乎事故报告的 CHANGELOG（多处注明"用户线上报错即此"），注释里能看到大量真实踩坑后的防御性修复。安全设计（CSRF 头 + Host 白名单 + Origin 校验、env 最小化/过滤、包名白名单 + 路径越界双保险、原子写 + 串行队列 + 全局安装互斥）经过了认真思考，不是贴个免责声明了事。

主要扣分项集中在：两个真实的功能性 bug（安装脚本幂等失效、script 类型平台选择错误）、skills 列表的无界并发、以及 11MB 索引带来的可扩展性天花板。详述如下。

---

## 做得好的地方（择要）

1. **并发与状态管理严谨**。`installRunning` 全局互斥、`patchQueue` / `installedQueue` 串行化读-改-写、`cordis.patch.yml` 用临时文件 rename 原子写；installed.json 记录键统一 `installedKey()` 小写规范化（v1.3.11 刚修完大小写卸载假完成，说明这套纪律是有效的）。
2. **防御性细节密集且真诚**。HTTP body 收集用 Buffer 拼接避免 UTF-8 跨分片解码损坏（n4）；列表并发标注按索引写入而非 push 以保持 Star 排序（m1）；`== null` 而非 `=== null` 防止 undefined 键误判——每一处注释都对应一个真实事故。
3. **客户端 XSS 面干净**。`lib/client.js` 全程 React `createElement`，无一处 `innerHTML` / `insertAdjacentHTML`；仓库描述等不可信数据天然经 React 转义。服务端 `normalizeRepo` 对 `html_url` 白名单校验（仅放行 `https://github.com`），前后端两层都守住了。
4. **供应链攻击面收敛得当**。answers 注入子进程 env 前过 `allowedAnswers` 白名单、`__` 内部键不进环境（index.js:1904-1913）；script 类型用最小化 env 白名单、npm 用全量剔除敏感键的 env（R2）；包名过 npm 官方命名正则 + resolve 后路径越界检查（C2，index.js:1990-1997）。
5. **数据源韧性设计**。registry 三源（api / jsDelivr / raw）+ 磁盘缓存兜底 + 搜索 API 应急，且"残缺结果不污染好缓存"；`source` 字段透传给前端展示，用户可感知降级。
6. **构建脚本的分段抓取算法**。`build-registry.mjs` 用 stars 分段 + 时间窗口二分突破 Search API 单 query 1000 条上限，带额度护栏与断点续跑——这是认真读过 GitHub API 限制文档后的解法。

---

## 发现的问题

### 🔴 高优先级

#### H1. install.sh / install.ps1 的幂等检查失效，重复执行会重复注册

`install.sh:37` 与 `install.ps1:43` 用 `^name:` 行首锚定检查注册是否已存在：

```bash
grep -qE '^name:[[:space:]]+dsh-plugin-marketplace[[:space:]]*$' "$PATCH"
```

但补丁文件的真实格式（包括这两个脚本自己写入的格式）是 `name:` 缩进在 `- insert:` 块内：

```yaml
- insert:
    - id: dsh-plugin-marketplace
      name: dsh-plugin-marketplace
```

`^name:` 永远匹配不到缩进行 → **每次运行 install 脚本都会追加一条重复条目**。服务端 `hasPatchEntry()`（index.js:734）用的是 `^\s*name:` 多行模式，是正确的；两个安装脚本与之不一致。重复条目是否导致 loader 报错取决于 cordis 对重复 id 的容忍度，但至少会污染配置文件。

**建议**：两个脚本的正则改为 `^[[:space:]]*name:` / `^\s*name:`，与服务端对齐；并加一个 e2e 用例（连续跑两次 install，断言 patch 文件只有一条记录）。

#### H2. script 类型插件的平台脚本选择写反了

`installRepo` 的 script 分支（index.js:1950-1959）：只要仓库含 `install.ps1` 就用 `pwsh` 执行，否则用 `bash` 执行 `install.sh`——**完全不看出运行平台**。

- Linux/macOS 上装有 ps1 的插件：用户机器大概率没有 `pwsh`，直接 ENOENT 失败；
- Windows 上只有 `install.sh` 的插件：`bash` 通常不存在（除非恰好装了 Git Bash 且在 PATH）。

`detectType`（index.js:1322-1323）也是无条件 ps1 优先。**建议**：按 `process.platform` 选择脚本——Windows 优先 ps1、其他平台优先 sh，两者都缺时给出明确报错而不是 spawn 失败。

#### H3. `/api/marketplace/skills` 的已安装标注无并发上限

dsh 插件列表的标注用了 12 个 worker 的并发池（index.js:1465-1502），但 skills 列表（index.js:1533）是：

```js
const flagged = await Promise.all(list.map(async (repo) => { ... await detectSkillInstalled(repo) ... }));
```

skills 索引当前 12000+ 仓库，这意味着一次冷启动请求会瞬间发起上万个并发 `fs.stat`。Node 的 libuv 线程池默认只有 4 个线程，极端情况下可能拖垮事件循环或触发 EMFILE。**建议**：复用 dsh 列表的 worker 池模式。

#### H4. skills.json 已达 11MB，首个索引源恒失败 + 拉取成本不可持续

实测 `skills.json` 约 **11MB**（12000+ 仓库）。两个后果：

1. 第一索引源 `api.github.com/.../contents/skills.json`（index.js:909）——GitHub Contents API 对超过 1MB 的文件直接拒绝（403 "too large"），所以这个源对 skills 栏目**永远失败**，每次都要白白超时一次才落到 jsDelivr；
2. 每次缓存过期 / 强制刷新都要全量下载 11MB JSON，弱网环境下列表体验会持续恶化，且体积还在随生态增长。

**建议**：索引拆分（按首字母/分页分片，前端触底加载时按需取片）或至少 gzip 分发（jsDelivr 支持）；同时在 `registrySources()` 里对 skills 跳过 api 源，避免无效请求。

### 🟡 中优先级

#### M1. 安装全程同步挂在单个 POST 上，长任务有超时风险

clone（180s）+ npm install（180s）+ build（600s）+ awaiting-input 多轮回环，全部串在一次 HTTP 请求里。浏览器 fetch 本身能挂住，但用户若在 DSH 前套了反向代理（README 提到局域网访问场景），代理默认 60s 超时就会切断连接，此时后端任务还在跑、前端却报失败，状态错位。**建议**：改为任务句柄 + 轮询（`/install/status?id=`），或 SSE 推送日志——也能顺带解决"安装中关窗后无法恢复查看进度"的问题。

#### M2. 版本检测只认 package.json version 字段

`latestVersion` 取 registry 的 `version` 字段（构建期从仓库 package.json 抓取），已装版本读本地 package.json（index.js:1491-1493）。很多作者发版不 bump version，更新提示会永久性漏报。**建议**：克隆缓存里本来就有 git 信息，可用 `git rev-parse HEAD` 与 registry 记录的 commit 比对作为兜底信号。

#### M3. `readJsonBody` 解析失败静默吞掉，`badRequest` 分支不可达

index.js:685：`catch { return {} }`——非法 JSON 被当成空 body，随后报的是 `badRepo`（repo 格式错误）而非 `badRequest`。排障时会误导。建议解析失败时抛 400。

#### M4. 环境变量扫描有漏报和误报

- **漏报**：`scanRequirements`（index.js:1239）只 `readdir` 根目录一层，多包仓库子目录插件的 README/.env 扫不到（虽然 cordis 分支对每个 pkgDir 调用，但函数本身不递归）；
- **误报**：`ENV_PATTERN`（index.js:76）的 camelCase 分支 `[a-z][A-Za-z0-9]*(?:ApiKey|Key|Token|...)` 会命中 README 正文里的 `hotKey`、`monoRepoToken` 之类普通词汇，弹出假的材料收集窗。误报只烦人，漏报会让插件装完拿不到密钥。建议 camelCase 分支要求至少 2 段驼峰（如 `[a-z]+[A-Z][A-Za-z]*(?:ApiKey|Token|...)`），或对命中的词做一次"在 .env 示例/文档代码块中出现"的加权。

#### M5. adaptor.json 重定向是静默的供应链信任点

`adaptorRedirectRepo()`（index.js:25）会把用户点击安装的 A 仓库**静默换成** B 仓库。当前用途正当（修正打错 tag 的仓库），但这个机制一旦被恶意 PR 污染，就成了把用户引向攻击者仓库的入口。**建议**：发生重定向时在安装日志和确认弹窗中明示"实际安装的是 owner-B/repo-B"，让用户有机会发现不一致。

#### M6. 卸载能力未覆盖手动预装插件，且文档漂移

卸载完全依赖 `installed.json` 记录（index.js:1838-1842），手动装的插件无法从市场卸载（尽管 `detectInstalled` 能识别它们）。另外 README 的「HTTP 接口」表没有列出 `/api/marketplace/uninstall` 和 `/api/marketplace/self-update` 两个端点——文档落后于实现了。

### 🟢 低优先级

- **L1** `removePatchEntry` 的行级 YAML 块解析对带行内注释、多行值的条目会误判。自己生成的格式能正确处理，够用，但建议在函数注释里声明"仅保证处理本插件生成的格式"。
- **L2** `compareVersions` 对 `1.2.3.4` 这类四段版本回退字符串比较（index.js:847），可能出现 `1.10.0.0 < 1.9.0.0` 的误判。四段版本罕见，记录即可。
- **L3** `install.sh` 的 `mktemp -d` 临时目录在 curl|bash 模式下不清理；tarball 无哈希/签名校验（curl|bash 模式的固有限制，README 已如实声明，属于可接受的取舍）。
- **L4** `dedupeReposByPkgName` 隐藏低星同名仓库时只写服务端日志（index.js:1040），用户无感知。建议列表底部给一条"N 个同名包已隐藏"的提示。
- **L5** 卸载 cordis 插件时 `!/-plugins$/.test(record.name)` 的过滤（index.js:1860）没有任何注释解释来历，后人无法判断这个启发式的边界。补一句注释即可。
- **L6** 确认状态（`__confirm_script__` 等）完全由客户端回传，服务端无法验证用户真的看过弹窗内容。本地工具场景下威胁有限，但如果未来加远程访问能力，这里需要服务端持有待确认会话状态。

---

## 建议的修复顺序

| 顺序 | 项 | 理由 |
|---|---|---|
| 1 | H1（安装脚本幂等正则） | 一行修复，消除配置文件污染的确定性 bug |
| 2 | H2（平台脚本选择） | 一行 `process.platform` 判断，直接决定一类插件能否装成功 |
| 3 | H3（skills 无界并发） | 复用现有 worker 池模式，半小时工作量 |
| 4 | H4（索引分片/gzip） | 越早做越好——12000 仓库还没到痛点极限，但趋势确定 |
| 5 | M1（安装任务异步化） | 工作量最大，但做完后 M3 和长任务体验一起解决 |
| 6 | M5 / M6（重定向明示、文档同步） | 低成本，信任收益高 |

## 最后一句话

这个项目的代码和它的 README 气质一致：**知道自己每一步在做什么，也知道哪里还没做**。H1/H2 这种"脚本与主程序实现漂移"的问题，恰恰说明需要把 install 脚本也纳入 e2e 回归（现在 e2e 只覆盖 lib）。把上面四个高优先级修掉，这个项目的代码质量就没什么可挑的了。
