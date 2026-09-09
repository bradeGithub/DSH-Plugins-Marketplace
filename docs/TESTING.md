# 测试规范（Testing Standards）

本文件定义本仓库的**测试金字塔架构**、覆盖率要求、测试编写规范与端到端策略。
执行规范见 [GIT_HOOKS.md](GIT_HOOKS.md)，代码规范见 [CODING_STANDARDS.md](CODING_STANDARDS.md)。

## 1. 测试金字塔

```
        e2e         真实环境（git/npm/HTTP），少量但关键
       integration  临时目录 + mock（IO/网络）
      unit          纯函数，快速，覆盖主体
```

| 层级 | 目录 | 特征 | 当前数量 |
|---|---|---|---|

<!-- TOC -->
- [1. 测试金字塔](#1-测试金字塔)
- [2. 命名与位置](#2-命名与位置)
- [3. 断言框架](#3-断言框架)
- [4. 覆盖率要求](#4-覆盖率要求)
  - [豁免原则](#豁免原则)
  - [patch manifest adapter](#patch-manifest-adapter)
  - [runtime registry/cache adapter](#runtime-registrycache-adapter)
  - [profile scan and InstalledIndex adapter](#profile-scan-and-installedindex-adapter)
  - [bundle register adapter](#bundle-register-adapter)
  - [install executor behavior contract](#install-executor-behavior-contract)
  - [installed state behavior contract](#installed-state-behavior-contract)
  - [diagnostics runtime contract](#diagnostics-runtime-contract)
  - [client 列表消费逻辑契约](#client-列表消费逻辑契约)
  - [repository scan adapter](#repository-scan-adapter)
  - [repository classification contract](#repository-classification-contract)
  - [security scan contract](#security-scan-contract)
  - [adaptor contract](#adaptor-contract)
  - [marketplace metadata contract](#marketplace-metadata-contract)
  - [test runner drift report isolation](#test-runner-drift-report-isolation)
- [5.5 机械化质量检查（行覆盖之外）](#55-机械化质量检查行覆盖之外)
- [5.4 脱敏测试（redact）](#54-脱敏测试redact)
- [5. 端到端（e2e）策略](#5-端到端e2e策略)
  - [前端浏览器 E2E（独立质量门）](#前端浏览器-e2e独立质量门)
  - [部署黄金路径行为契约](#部署黄金路径行为契约)
  - [workspace 吞依赖陷阱（issue #146/#147/#168 同源根因）](#workspace-吞依赖陷阱issue-146147168-同源根因)
  - [真实安装验收（手动，不进自动金字塔）](#真实安装验收手动不进自动金字塔)
- [6. 编写清单](#6-编写清单)
- [7. 已知 lib API 问题](#7-已知-lib-api-问题)
<!-- /TOC -->
| **unit** | `scripts/tests/unit/` | 纯函数、app 用例/执行器、bundle assembler、VM 运行时契约和静态契约 | 68 个测试文件 |
| **integration** | `scripts/tests/integration/` | 临时 DSH_HOME/真实临时目录、mock fetch/proc、真实测试运行器子进程 | 18 个测试文件 |
| **e2e** | `scripts/tests/e2e/` | 真实 git 流程、fixture 仓库与真实 DSH | 3 个测试文件 |
| **frontend browser e2e** | `scripts/tests/browser/` | 真实 DSH Web UI/marketplace bundle、Playwright context 与确定性 API fixture | 9 个行为契约 |

统一 Node 运行器：`node scripts/tests/run.mjs`（`--level=unit|integration|e2e`、`--json`）。当前共 89 个 Node 测试入口；精确通过数以每文件末尾 `N passed` 和运行器汇总为准。前端浏览器层是独立质量门，不计入该 89 个入口、Node coverage 或 mutation 数字。

## 2. 命名与位置

- 文件名：`<module>.test.mjs`（unit/integration）、`<feature>.e2e.mjs`（e2e）
- unit 放纯函数模块对应测试；integration 放依赖 IO 的；e2e 放跨模块真实流程
- 相对 import 路径按层级调整（unit 在 `tests/unit/`，lib 需 `../../../lib/index.js`）

## 3. 断言框架

零依赖，与仓库风格一致：

```js
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
// 结尾：
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- 断言命名：中文描述，含具体输入输出（`"hasEmoji 旗帜区域指示符"`）
- 正向 + 负向成对（`true`/`false`、`合法`/`非法`）
- 覆盖边界：空串、null、undefined、CRLF/LF、Unicode

## 4. 覆盖率要求

- 目标：**hook 校验逻辑（validate.mjs、toc.mjs）100%**
- `lib` 与纳入清单的 Node 脚本：**非豁免函数 100%**（当前为 584/584）
- `lib/client.js` 是浏览器 bundle，不计入 Node V8 函数口径；由 `client-runtime.test.mjs` 的 VM 执行契约、`client-assembler.test.mjs` 的字节无漂移契约和 `client-logic.test.mjs` 的消费纯函数契约守护
- 检查：`node scripts/coverage.mjs`（NODE_V8_COVERAGE 零依赖）
- coverage 不在 pre-commit 自动检查中；由 `node scripts/hooks/check.mjs --only=coverage` 或 CI 显式执行
- **行覆盖 ≠ 健壮**：语义正确性由机械化检查族补充（见 §5.5）

### 豁免原则

豁免**仅在合理不可测**时使用（coverage.mjs 的 `EXEMPT_LIB_FUNCS`）：

| 豁免项 | 原因 |
|---|---|
| `runNpm`、`npmInstallWithFallback` | 依赖真实 npm 二进制，mock 不稳定 |
| `exists` 等内部辅助 | 通过 handler 间接触发 |
| `readPackageVersion`、`readPackageName`、`readPackageJsonObject`、`copyFilter` | 深集成依赖解析路径，经调用链间接覆盖 |
| 防御性死代码闭包（`rm(...).catch(`、启动预热 `getList().catch(`） | 仅 fs 权限/占用等异常态触发（markers 见 coverage.mjs） |
| toc.mjs `isMain` 主循环 | 仅 CLI 运行时执行 |

**不豁免**：纯函数、可 mock 的 IO、可通过调用链触发的逻辑——必须覆盖。
豁免登记与 coverage.mjs 的 `EXEMPT_LIB_FUNCS` / `EXEMPT_LIB_MARKERS` 保持一致（新增豁免必须同时登记两处）。

### patch manifest adapter

`lib/infra/patch-manifest.js` 的 `createPatchManifestAdapter()` 由 `scripts/tests/unit/infra-patch-manifest.test.mjs` 使用独立 fake filesystem 直接验证。Oracle 锁定首次/重复追加、裸 `[]` 清理、scoped 名称引号、只删除本插件格式块、保留 skin/其他块、空文件回落 `[]\n`、默认与显式 profile 路径、共享队列串行化和 tmp+rename 失败传播。

入口兼容导出与真实调用链继续由 `scripts/tests/integration/lib.test.mjs`、`scripts/tests/integration/uninstall.test.mjs` 和 `scripts/tests/e2e/install.e2e.mjs` 验证；adapter 不使用覆盖率豁免。patch 规则变化时必须同时更新行为 Oracle、相关 integration/e2e 夹具和 mutation 清单，不得只修改源码形态正则。

### runtime registry/cache adapter

`lib/infra/registry-cache.js` 的 `createRegistryCacheAdapter()` 由 `scripts/tests/unit/infra-registry-cache.test.mjs` 使用独立 fake fetch、fake filesystem 和可控 clock 直接验证。Oracle 锁定 dsh/skills/force 的 source priority、registry gzip/raw 换源、HTTP/JSON/gzip 失败回退、响应与解压大小上限、CDN 新鲜度、search 分页与跨 query 去重、坏缓存过滤、TTL 边界、bundled/cache/search 回退、raw cache 写入边界和 tmp+rename。search 合成结果不写回 raw cache；adapter 不持有入口的内存 TTL、单飞或 source 状态。

入口兼容导出、列表 runtime 的 source/cache metadata、路由 payload、installed/profile 标注和 self-update 读取继续由 integration 与 e2e 测试覆盖。该 adapter 不使用 coverage 豁免；缓存、来源优先级和 raw cache 边界均由对应行为测试覆盖。

### profile scan and InstalledIndex adapter

`lib/infra/profile-scan.js` 的 `createProfileScanAdapter()` 通过注入 fake filesystem、路径和包/cache 读取能力，独立验证当前 profile 的 `node_modules`、共享 skills/preset 目录和 marketplace cache 扫描。Oracle 锁定隐藏目录跳过、scoped 包递归、版本补全、包名大小写归一、profile 隔离、managed dirs 以及 script/package-name 投影；adapter 不持有入口缓存、single-flight、generation 或队列。

`lib/domain/installed-index.js` 的 `buildInstalledIndex()` 和 `profileHit()` 只接收显式 profile、installed records、受管目录、cache entries、official package 与 own-repo 输入，构建 repository 反向索引、目录属主和 cache 派生集合。domain 不读取 IO、环境或入口状态，并复制输入 Map/Set；入口继续持有缓存失效、单飞、代际保护和兼容导出。


### bundle register adapter

`lib/infra/bundle-register.js` 的 `createBundleRegisterAdapter()` 通过注入 fake filesystem、fake `runPnpm`、fake resolver 和显式 profile paths，独立验证 bundle manifest 更新与 profile 解析。Oracle 锁定缺失 manifest fail-closed、dependencies/profile.bundles 投影、npm/GitHub 依赖规格、`--ignore-workspace`、pnpm 非零但可解析的告警成功、manifest 回滚、main 路径越界/缺失拒绝、非法依赖名、依赖解析失败、回滚失败保留原错误、realpath 锚点和旧 profile 路径。

入口通过兼容 wrapper 调用 adapter；`installRepo`、`runInstallUseCase`、安装互斥、反馈/installed 状态和 HTTP 路由分别由现有 owner 与 HTTP 层负责。直接 Oracle 为 bundle-register 12/12，静态边界契约 32/32；完整 unit/integration 60/60，测试金字塔 63/63（install 180/180、real-dsh 8/8、workspace-trap 9/9）；coverage 501/501 函数（100%）；mutation 149/149（133 行为 + 14 静态契约，0 survivor、0 skip）。提交钩子和 coverage 均将分类漂移报告写入临时目录；`build-registry.mjs` 也遵循 `DRIFT_REPORT_FILE`，保护工作区报告不被质量门改写。

### install executor behavior contract

`lib/app/install-exec.js` 的 `createInstallExecutor()` 将 `installRepo` 六类执行分支从入口移出，但只接收显式 fs/path/proc/scan/package/adapters/env 能力，不读取 HTTP、入口状态或 profile 全局变量。`lib/index.js` 保留原 `installRepo` 签名和默认 profile snapshot wrapper；`createInstallUseCase()` 继续负责 installed/feedback 持久化、失败清理和结果映射。

`app-install-exec.test.mjs` 不是类型检测测试：独立 Oracle 直接断言 skill/preset 的真实复制与过滤、bundle 注册参数和无 patch 副作用、script 的平台选择/cwd/env、cordis-plugin 的依赖清洗与 build/npm 顺序、多包聚合/入口 warnings/patch path，以及 manual 的 README 截断和零安装副作用。`integration/install-exec.test.mjs` 再用真实临时目录验证 skill/preset/plugin 的文件结果。当前 focused 行为 Oracle 为 **28/28**，真实目录 integration 为 **7/7**；入口 `lib.test.mjs` 为 **345/345**，install E2E 为 **180/180**。

安装执行器 mutation 覆盖 m151–m164 共 14 个行为突变，涵盖分支选择、复制过滤、bundle spec、平台脚本、环境构建、依赖清洗、构建/npm 顺序、入口 warnings、patch 快照、README 截断、错误传播和版本结果；完整 mutation 结果为 **269/269**（246 行为 + 23 静态契约，0 survivor、0 skip）。新增 executor 不使用 coverage 豁免。

### installed state behavior contract

`lib/app/installed-state.js` 的 `createInstalledState()` 独立持有安装记录 Map、`installed.json` 持久化队列和成功变更通知；文件读取、写入、市场根目录创建、队列与 repository key 归一化均通过依赖注入进入。owner 不导入 HTTP、入口、profile/index 或 list，也不暴露可变内部 Map。

`scripts/tests/unit/app-installed-state.test.mjs` 直接验证缺失/损坏读取委托、大小写与 GitHub URL 归一、完整状态写入、先持久化后提交内存、失败原错传播、前序失败后的队列恢复、并发不丢记录、snapshot/entries 隔离、通知顺序/取消和无记录删除不通知；`scripts/tests/integration/installed-state.test.mjs` 使用真实临时目录验证文件内容、重载、损坏备份和真实写入失败恢复。focused 结果分别为 **25/25** 与 **10/10**。

`lib/index.js` 仅装配 owner 并保留 `getInstalledRecord`、`hasInstalledRecord`、`saveInstalled`、`removeInstalled` 兼容转接；InstalledIndex 使用 detached snapshot，backup 使用 detached entries，profile/index 失效由入口注册一次 `onChange` 订阅。旧 `installed.json` 格式、记录字段、启动加载时序和 HTTP/安装/卸载契约不变。

`lib/app/profile-index.js` 现在独立拥有 profile scan cache、InstalledIndex、single-flight、generation、稳定状态窗口、fallback 和 profile/installed 变更失效；它复用 `lib/infra/profile-scan.js` 与 `lib/domain/installed-index.js`，不拥有 `installed.json`。`lib/app/list-runtime.js` 独立拥有 `listCaches`、`listFetchings`、`listSources`、TTL、single-flight 和 detached cache metadata；HTTP 继续负责标注、dedupe、分页和响应映射。profile/index runtime focused unit 为 **29/29**，接线静态契约为 **32/32**，installed-index integration 为 **41/41**；list runtime focused unit 为 **23/23**。


### diagnostics runtime contract

`lib/app/diagnostics.js` 的 `createDiagnosticsRuntime()` 独立持有环境画像缓存和近期日志环，所有文件、路径、进程、版本和时钟能力由入口注入；owner 不导入 HTTP、宿主 API 或 `lib/index.js`。`scripts/tests/unit/app-diagnostics.test.mjs` 直接锁定基础画像 fallback、profile DSH 版本读取、异步缓存、坏/缺 package 容错、pnpm/git 探测参数、ISO 时间戳、nullish 输入、单条 4096 截断、400 条尾部淘汰和 detached 日志快照。

`scripts/tests/integration/diagnostics-runtime.test.mjs` 使用真实临时 profile 目录和 `node:fs/promises` 验证 package 读取、缓存复用、缺失/损坏 package 的省略行为与真实日志快照隔离。`lib/http/routes.js` 只接收 `getRecentLogs()`，日志响应从同一次快照生成脱敏文本、count 和文案；`buildFeedbackLogSnapshot()` 与脱敏规则仍由原边界负责。

完整 unit/integration 为 **69/69**；测试金字塔为 **72/72**（unit 56、integration 13、e2e 3）；覆盖率为 **550/550 函数（100%）**，其中 `lib/app/diagnostics.js` 为 **8/8**；mutation 为 **197/197**（181 行为 + 16 静态契约，0 survivor、0 skip），新增 m191–m198 锁定缓存、坏 package 容错、工具探测参数、截断、环边界、快照隔离和响应 count。syntax、TOC、secret、hooks、diff check、client assembler drift 与 real-dsh **8/8** 均通过。

### client 列表消费逻辑契约

`lib/client-src/05a-logic.fragment` 承载 client 的列表消费纯函数（`fingerprintOf`、`filterRepos`、`appendSkillsPage`、`shouldLoadMore`），无 React/fetch/DOM 依赖，由 `scripts/tests/unit/client-logic.test.mjs` 直接 eval 测行为：fp 门控（服务端 fp 优先 / 无 fp 回退 source+cached_at+total）、插件分类+搜索过滤、Skills 跨页去重（第 1 页替换 / 后续页按 full_name 去重拼接）、触底加载门控（未加载完且非加载中）。该层与 browser E2E（壳行为）互补——测的是内层消费逻辑本身，不依赖浏览器；当前 **24/24**。`client-assembler.test.mjs` 锁定 fragment 清单与 bundle 字节无漂移。

### repository scan adapter

`lib/infra/repository-scan.js` 的 `createRepositoryScanAdapter()` 只承接 marketplace cache 仓库目录的扫描与读取 IO；`fs.readdir`、`fs.readFile`、`path.joinPath` 和 `looksLikeDshPlugin` 均由组合入口显式注入。adapter 提供 skill、plugin、preset 根查找，以及 skill manifest 和 lifecycle script 读取；不持有类型判定优先级、安全扫描、安装状态或入口状态。

`scripts/tests/unit/infra-repository-scan.test.mjs` 直接使用 fake Dirent/filesystem 锁定大小写、深度/数量上限、隐藏目录、`node_modules`、vendored 目录、symlink、根命中停止、坏 JSON、严格领域判定、preset 双文件条件、manifest 回退/错误传播和 lifecycle 白名单/顺序/空值过滤；focused Oracle 为 **12/12**。`scripts/tests/integration/repository-scan.test.mjs` 使用真实临时目录验证根/嵌套 skill、多包 plugin、普通包排除、preset、生命周期和坏输入；integration 为 **9/9**。

repository-scan adapter 的行为契约覆盖完整 unit/integration、测试金字塔、coverage、mutation、入口回归和真实宿主安装流程；扫描边界、注入方向和失败语义均有独立测试守护。

部署黄金路径行为契约由隔离 integration **38/38** 与真实临时 DSH 宿主 e2e **15/15** 覆盖；完整测试、coverage、mutation、syntax、TOC、secret、hooks 和 client assembler drift 均作为独立质量门执行。

### repository classification contract

`lib/app/repository-classification.js` 的 `createRepositoryClassification()` 只编排运行时分类，不读写宿主状态，也不直接做 IO。根文件存在性、package.json 读取、skill/plugin/preset 扫描和声明判定都由入口注入；`detectType`、`detectTypeDetail` 的公开参数、类型字符串及理由键保持不变。运行时分类不复用构建期的 `verdictOf()` 或 `classifyEcoType()`，因为探测报告、生态标签和安装类型不是同一契约。

`scripts/tests/unit/app-repository-classification.test.mjs` 的独立行为 Oracle 覆盖声明与脚本冲突、preset 优先级、普通根包的非插件确认语义、根/嵌套 skill 与 plugin、损坏清单、严格 `true`、理由键、扫描预算、短路、不缓存结果和能力异常传播；当前 **28/28**。`scripts/tests/integration/repository-classification.test.mjs` 通过真实临时目录与生产入口、repository-scan 和 install preflight 组合，验证分类与确认链，当前 **27/27**；同一夹具也覆盖入口兼容路径，当前 **27/27**。

分类行为突变 m217–m231 覆盖优先级、类型/理由映射、短路、扫描预算和结果隔离；这些语义由行为测试锁定，未新增 coverage 豁免。

### security scan contract

安装前安全扫描按依赖方向拆为两个模块：`lib/domain/security-scan.js` 只包含环境变量、宿主 shadow dependency、脚本/lifecycle 规则、lockfile/CVE 归一化、advisory 投影和 secrets 候选规则；`lib/infra/security-scan.js` 的 `createSecurityScanAdapter()` 通过显式 fs/path、`findSecrets`、受限 body reader、超时和 fetch 能力承接目录遍历、文件读取与 npm advisory 请求。`lib/domain/scan.js` 仅保留兼容转发，不再持有 IO。

`domain-security-scan.test.mjs` 直接以纯输入输出锁定规则，`infra-security-scan.test.mjs` 使用可记录 fake fs/path/fetch 锁定调用边界、失败静默和请求形态，`integration/security-scan.test.mjs` 使用真实临时目录与真实 Node fs/path 验证 bash/PowerShell/lifecycle、`.env`、lockfile、宿主依赖和 advisory 结果。`security-guards.test.mjs` 额外锁定 domain 无 IO/HTTP/环境反向依赖、adapter 能力注入和入口装配方向；`validate.test.mjs` 锁定新模块进入 syntax check 清单。

安全扫描行为突变 m232–m250 共 19 个，覆盖脚本、lifecycle、lockfile/CVE、secrets、失败静默和注入边界；当前 mutation 报告为 **269/269**（246 行为 + 23 静态契约，0 survivor、0 skip）。focused Oracle 为 domain **26/26**、infra **19/19**、真实临时目录 integration **9/9**、security guards **66/66**，并由既有 preflight、入口、runtime closure 和 install E2E 回归覆盖。

### adaptor contract

`lib/infra/adaptor.js` 的 `createAdaptorAdapter()` 通过注入的配置加载能力一次读取 `adaptor.json`，过滤非法 `from`/`to` 条目，并把规则交给无 IO 的 `lib/domain/adaptor.js`。domain 规则只负责精确重定向查询和列表投影：移除 from 条目、按配置顺序补入 `meta.full_name`、调用注入的 `normalizeRepo`，保持重复 from、重复目标、非数组和损坏配置的既有语义。

`scripts/tests/unit/domain-adaptor.test.mjs` 与 `scripts/tests/unit/infra-adaptor.test.mjs` 直接验证输入不别名、空转回退、显式能力注入和配置加载失败；`lib.test.mjs` 与 list/route integration 继续通过兼容出口和生产 `adaptor.json` 验证 MuseAI 重定向、列表移除/补入及安装目标保持不变。domain 不导入 Node IO、环境或入口，routes 只消费注入的两个能力。

adaptor 规则新增行为突变 m251–m260 共 10 个，全部被行为测试锁定；与 metadata 突变合计后，完整 mutation 为 **269/269**（246 行为 + 23 静态契约，0 survivor、0 skip）。完整 unit/integration 为 **82/82**，测试金字塔为 **85/85**，coverage 为 **584/584 函数（100%）**；property-based **8/8**、smoke **192/192**、frontend browser E2E **9/9**、真实 host/API E2E **20/20**、install E2E **180/180** 均通过。

### marketplace metadata contract

`lib/infra/marketplace-metadata.js` 的 `createMarketplaceMetadataAdapter()` 承接官方包集合和本体仓库元数据的 IO/cache 生命周期。官方包集合以 fallback 为基线，枚举解析出的 `@deepseek-ai/*` 目录并统一小写；本体 repository 支持字符串或 `{ url }`，保持 GitHub 前缀、`.git` 和大小写归一。有效官方集合和有效 own repository 结果缓存；失败或无效 own repository 返回 `null`，并保留下一次调用重试的旧行为。

`scripts/tests/unit/infra-marketplace-metadata.test.mjs` 通过 fake fs/resolver 锁定 fallback、枚举、缓存和失败语义；`scripts/tests/integration/marketplace-metadata.test.mjs` 使用真实临时目录验证 scope 枚举、package.json 读取和缺失回退。`profile-index.js` 只通过显式注入消费 `loadOfficialPackages`/`loadOwnRepo`，`installed-index.js` 继续只接收已解析的 `official` 与 `ownRepo` 值，不把 IO 下沉到 domain。

marketplace metadata 新增行为突变 m261–m270 共 10 个，全部被行为测试锁定；其结果已计入本节上一段所述的 **269/269** mutation 质量门。

### test runner drift report isolation


`scripts/tests/run.mjs` 的 `DRIFT_REPORT_FILE` 隔离由 `scripts/tests/integration/test-runner-drift-isolation.test.mjs` 通过真实子进程验证，而非只检查源码字面量或函数类型。未显式提供报告路径时，runner 为子测试创建 invocation-scoped 临时目录并在成功/失败退出后清理；显式路径原样传递且不由 runner 删除。Oracle 同时断言 runner 的成功/失败退出码、子进程环境、临时报告生命周期，以及仓库根 `drift-report.json` 的 hash 不变。

该契约属于测试基础设施的 integration 行为门；`run.mjs` 已纳入语法检查清单。`check.mjs`、`coverage.mjs` 和直接 runner 调用均应优先使用仓库外报告路径，保护报告的当前基线不得被质量门改写。


## 5.5 机械化质量检查（行覆盖之外）

行覆盖只回答「代码被执行了多少」——语义正确性由三个机械化工具补充：

| 工具 | 命令 | 度量 |
|---|---|---|
| 突变测试 | `node scripts/mutation-test.mjs` | 测试敏感度（269 个语义突变点；存活 = 语义未锁定；当前应为 0 survivor / 0 skip） |
| 性质测试 | `node scripts/tests/unit/property-based.test.mjs` | 不变式（幂等/反对称/传递性/边界/差分 `annotateInstalled ≡ detectInstalled`；8/8） |
| i18n 完整性 | `node scripts/tests/unit/i18n-completeness.test.mjs` | 字典覆盖 + 占位符一致性（5/5，进金字塔自动跑） |

改 lib 后三件套复跑顺序：`coverage → mutation → property → smoke`。

**质量门分层：** 默认 `pre-commit` 只执行快速的 syntax、unit/integration、TOC 和 secret 检查；完整 Node E2E 通过 `node scripts/hooks/check.mjs --only=e2e` 执行，浏览器 E2E 通过 `node scripts/tests/frontend-e2e.mjs` 执行，coverage 和 mutation 使用各自显式命令。严格 E2E 模式下缺少 git、npm、pnpm 或 DSH CLI 会失败，不会把未执行计为通过。

**当前质量边界：** `584/584` 函数覆盖、`269/269` mutation、`8/8` property、`192/192` smoke、Node E2E `180/180` + `20/20` + `9/9` 和浏览器 E2E `9/9` 提供了独立行为证据，但函数覆盖不代表分支或语义完备。`.github/workflows/quality.yml` 以 `contents: read` 建立可复现的只读 CI 质量门：安装 Node 24、pnpm/DSH CLI、browser lockfile 依赖和 Playwright 托管 Chromium，并显式执行严格 Node E2E、浏览器 E2E、coverage、property、smoke 和 mutation。

**HTTP/浏览器响应契约兼容：** 当前生产 HTTP marketplace 响应由 `lib/http/marketplace-contract.js` 统一附加 `schemaVersion: 1`；它只复制顶层对象，不删除未知字段。缺少 `schemaVersion` 的 legacy producer 仍按旧字段消费，新增字段对旧 consumer 保持可忽略；破坏性字段/状态变更必须提升主版本，新增字段先保持可选。Node route Oracle 与 browser E2E 覆盖 legacy producer（允许缺失版本和可选字段）及 forward producer（版本字段、未知顶层和列表项字段），未知状态不得被当作 `done`，consumer 必须进入失败/人工处理路径。日志事件版本不复用 HTTP payload 版本。

**结构化事件：** `lib/app/diagnostics.js` 在人类可读日志环之外维护结构化事件环（`pushEvent`/`getRecentEvents`），每条事件含 `event`、`level`、`error_code`、`trace_id`、`duration_ms`、`message` 与 `at`，字段归一、单条截断、容量淘汰并返回 detached snapshot。安装、卸载、自更新、反馈与 check-update 边界已接入事件发射，且安装、自更新的完成/失败事件在 HTTP 边界实测填充非负 `duration_ms`；`/logs` 人类可读响应、toast 与 `console.warn` 保持不变。事件字典变更必须同步更新 `app-diagnostics.test.mjs` 的字段与容量断言。`trace_id` 仅作为可选字段承载调用方传入值，本插件为单进程本地单跳 HTTP 边界，不生成也不跨 use case 自动传播 trace（分布式追踪为非目标）。`http-routes.test.mjs` 在 route 边界锁定事件接线：install(done/failed/manual/aborted/awaiting-input)、uninstall(done/failed)、self_update(done/failed/version_fail)、feedback(not_found)、check_update(done) 的精确 event 序列 + level + error_code，并覆盖 413 bodyTooLarge、409 busy、list/skills 500、check-update 404、env-keys managed 目录扫描与 list 最终排序等边界分支。

**后续质量属性：** registry workflow 的 `contents: write` 与自动推送 main 仍需单独供应链审阅；HTTP marketplace payload 已进入 schemaVersion 1，后续只在出现破坏性字段/状态变更时提升主版本。browser E2E 的 accessibility 与多语言覆盖只在有明确产品契约时加入，不把当前 8/8 扩写为全 UI 覆盖。

**性能基准：** `scripts/benchmarks/marketplace.mjs` 用确定性合成数据（mulberry32 固定种子）测量 `dedupeReposByPkgName`、`listFingerprint`、`buildInstalledIndex` 与 `profileHit` 在 1k/5k/20k 规模下的 CPU 趋势，输出 JSON（样本规模、warmup、迭代次数、median/p95、node/platform/git revision）。基准不把机器相关绝对耗时当作断言；CI 只上传 `benchmark-trend` artifact 供趋势观察，不直接阻断。`benchmark-contract.test.mjs` 锁定输入不变式与结果正确性。

**供应链治理：** `scripts/provenance.mjs` 用零依赖 SHA-256 对关键生成物（`lib/index.js`、`lib/client.js`、`registry.json(.gz)`、`skills.json(.gz)`、browser lockfile）与 git revision 生成 provenance JSON，不写仓库、不覆盖 `drift-report.json`。CI 对 browser lockfile 执行高严重度 `npm audit --audit-level=high`、生成 CycloneDX SBOM，并上传 `supply-chain` artifact；不引入 Docker/Trivy/OSV 等外部工具。`supply-chain.test.mjs` 锁定 provenance 输出形态与 CI 供应链步骤。

## 5.4 脱敏测试（redact）

安装日志附公开 issue 前的多层脱敏（`lib/redact.js`），测试按三面组织（`scripts/tests/unit/redact.test.mjs`）：

| 面 | 断言方式 | 覆盖 |
|---|---|---|
| 泄漏面 | `noLeak(name, input, ...secrets)`——输出不含敏感原文子串 | 已知密钥 21 形态（AWS 含临时凭证/sk 系/GitHub PAT/JWT/PEM/DB 连接串/webhook/Bearer 头）+ 用户路径 + 上下文邻近捕获 |
| 误报面 | `keep(name, input, ...parts)`——非敏感上下文保留 | 包名含 token/停用词/纯小写标识符/短值不掩码 |
| 注入面 | CR/LF 统一、控制字符剔除、markdown 围栏 ``` → ''' | 防击穿 issue details 折叠块 |

**新增密钥规则**：`lib/redact.js` KNOWN_KEY_RULES 加正则 + redact.test.mjs 加对应 noLeak 断言（成对维护）。
性质测试的 sanitizeLog 不变式（路径残留/密钥残留/标记存在）是 fuzz 层兜底——粘连形态（多路径分隔符拼接）由它守护。

**findSecrets（安装前扫描复用面）**：同文件导出的结构化扫描（返回 `{line, kind, text}`），测试断言已知密钥/邻近命中行号、URL 不误报、maxHits 截断；集成层 `scanCacheSecrets` 断言目录遍历（node_modules 跳过/.env 基名命中/相对路径形态）、e2e 断言弹窗链路（值已脱敏 + continue/cancel 两分支）。

**依赖 CVE 扫描（scanCacheVulnerabilities）**：`readVulnScanDeps` 纯函数断言扫描面（dependencies+optional，dev 不进）与版本解析（lockfile 精确优先/剥 ^~ 取下界）；集成层 mock fetch 断言 bulk API 命中（只收 critical/high）、moderate 不弹、网络失败与 API 非 200 静默降级、file: 协议读子包版本；e2e mock bulk URL 断言弹窗详情与 continue/cancel 双分支。

## 5. 端到端（e2e）策略

e2e 用**本地 fixture 替代真实网络**，保证 CI 可复现：

- **git fixture**：本地 `git init` 仓库 + `GIT_CONFIG_GLOBAL` 环境变量 + `insteadOf` URL 重写
  ```ini
  [url "C:/path/to/fixture/repo"]
      insteadOf = https://github.com/owner/repo.git
  ```
  路径必须**正斜杠**（Windows 反斜杠会被 git 丢弃）
- **DSH_HOME 隔离**：必须在 `import lib` **之前**设置（ESM 静态 import 提升——用**动态 import** 控制顺序）
  ```js
  process.env.DSH_HOME = mkdtempSync(...);
  const lib = await import("../../../lib/index.js");
  ```
- **handler 触发**：apply(ctx) 捕获 webServer.register 的路由 handler，模拟 HTTP req/res 调用
- **SKIP 与严格模式**：本地直接运行某个 E2E 时，缺少 git、npm、pnpm 或 DSH CLI 可以输出明确的 `SKIP` 并退出 0，因为该次运行没有声称覆盖该环境；完整质量门应通过 `node scripts/hooks/check.mjs --only=e2e` 执行，该入口传入 `DSH_REQUIRE_E2E=1`，缺少声明的前置工具或任一 E2E 失败都会返回非零。CI 应使用同一严格入口。

### 前端浏览器 E2E（独立质量门）

前端浏览器 E2E 与真实宿主/API E2E 分开计数：`real-dsh.e2e.mjs` 验证真实 DSH HTTP/安装链路，不执行 DOM 操作；`scripts/tests/browser/marketplace-ui.spec.mjs` 才验证真实浏览器加载 Web profile、marketplace client bundle 和用户可观察交互。此前通过 MCP 完成的点击、reload、DOM/console 检查属于手工 UI 探测，不计入自动化通过数。

显式入口：

```text
node scripts/tests/frontend-e2e.mjs
```

该入口只使用 `scripts/tests/browser/package-lock.json` 锁定的测试依赖，缺少 `node_modules` 时显式失败；CI 通过 `npx playwright install --with-deps chromium` 安装 Playwright 托管 Chromium，本机也可由 `DSH_BROWSER_EXECUTABLE` 覆盖或在默认路径存在时复用调试专用 Chromium。未配置浏览器路径时不把本机绝对路径当作前置条件。

每个测试拥有独立 browser context、独立临时 `DSH_HOME`/profile/端口和独立 API fixture 状态。页面真实加载 DSH UI 与 `lib/client.js`，仅通过 page route 固定 `/api/marketplace/*` 响应；fixture 不访问线上 registry、Skills、GitHub 或第三方安装。测试结束只清理测试创建的 context、DSH 子进程树和临时目录，不触碰用户 profile、静态索引或 `drift-report.json`。

行为契约覆盖：市场挂载与安装状态、插件/Skills 标签切换、Skills 触底加载下一页并跨页去重、失败重试与搜索空结果、生命周期确认取消、legacy 响应兼容、forward 未知字段兼容、网络中断后重试恢复、刷新请求进行中按钮禁用、profile 保存后 reload 重新挂载。定位优先使用 role + accessible name，断言使用 Playwright web-first assertions；不使用固定 sleep、CSS 实现细节或全量截图。当前独立 browser suite **9/9** 通过；失败时保留 trace/screenshot 供诊断，但不作为通过标准。

### 部署黄金路径行为契约

部署黄金路径由两层互补行为契约覆盖：

- `scripts/tests/integration/runtime-closure.test.mjs` 在导入入口前设置临时 `DSH_HOME`，通过真实 `apply()` 路由接线与确定性 fixture 验证 list/Skills、skill/preset/plugin 类型识别、三类安装卸载、installed 标注、lifecycle 确认链、重复等待复用缓存和 profile 隔离；当前 **38/38**。
- `scripts/tests/e2e/real-dsh.e2e.mjs` 启动真实 `dsh --profile web --no-open`，使用专用端口、临时 profile、临时 `DSH_HOME` 和本地 git fixture 的 `GIT_CONFIG_GLOBAL` URL rewrite，通过真实 HTTP 验证 list、Skills、skill 安装→卸载、lifecycle cancel、profile 标注/fingerprint 切换与非法 profile；并对 list/skills/profile/install/uninstall 的真实响应做契约形状断言（`inspectMarketplacePayload`），封住「browser mock 掩盖真实输出漂移」的缺口；当前 **20/20**。
- 真实宿主测试只回收测试创建的进程树和临时目录；不把用户 profile、`installed.json`、patch、真实 `node_modules` 或 `drift-report.json` 当作清理对象。三类安装的完整确定性结果仍由 integration 契约负责，避免复制安装实现。

### workspace 吞依赖陷阱（issue #146/#147/#168 同源根因）

**机制**：用户主目录常驻 `pnpm-workspace.yaml`（DSH 部署只写 allowBuilds，**无 packages 字段**）→
pnpm 11 向上查找把**根目录当唯一项目** → `~/.dsh/profiles/web` 的裸 `pnpm install` 被吞：
依赖装不进 profile node_modules 却静默 "Already up to date" → bundle 装不上。
npm 不受影响（npm 只认 package.json 显式 workspaces 字段）。

**修复**：runPnpm 的三个调用点（bundle 注册 install / bundle 卸载 remove / buildPluginPackage install）
带 `--ignore-workspace` 跳过 workspace 发现；`pnpm run build` 保持不带（monorepo 插件需 workspace: 协议）。

**测试**：`scripts/tests/e2e/workspace-trap.e2e.mjs`（进金字塔，e2e 层）——构造祖先 workspace 根
（无 packages 字段，同真实主目录形态）后：对照组裸 pnpm 被吞（判别力）/修复后依赖进 profile/
workspace 根未被污染/npm 路径不受影响。git + pnpm 缺失时 SKIP。

### 真实安装验收（手动，不进自动金字塔）

`scripts/tests/manual/real-install-verify.mjs [repo...]`——真实网络 clone + 真实安装，
验证：①脱敏管线在真实 bug 日志下无泄漏（密钥/路径/undefined 拼接形态）②安装链路真实错误
可诊断。内置 issue 异常反馈清单（#168/#152/#147/#146/#145/#134/#125/#93/#90/#84/#82）；
带参数只体检指定仓库。临时 DSH_HOME 隔离不污染真实部署；网络超时自动重试一次；
每仓 5s~2min，非 CI 环境跑。

## 6. 编写清单

新增代码时必须：
1. 纯函数 → unit 断言
2. 文件 IO/网络 → integration（临时目录/mock fetch）
3. 跨模块真实流程 → e2e（fixture）
4. 跑 `node scripts/tests/run.mjs` 全绿
5. 跑 `node scripts/coverage.mjs` 确认无回退
6. 新增语义 → 突变复跑（`node scripts/mutation-test.mjs`——新增行为应有红用例锁定）
7. 改纯函数 → 性质复跑（`node scripts/tests/unit/property-based.test.mjs`）
8. 改文案/字典 → i18n 检查（进金字塔自动跑）
9. 异步行为 → 等待可观察状态或显式 deferred 边界；不得用固定延时推断写盘、队列或请求已完成
10. E2E 前置条件 → 本地探测可明确 SKIP；质量门/CI 必须使用严格模式并在前置工具缺失时失败

## 7. 已知 lib API 问题

测试过程中发现的 lib/index.js API 设计问题（**不在本分支修改**）：
见 [LIB-ISSUES.md](LIB-ISSUES.md)——已整理，待商讨提交 upstream。
