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
- [5.5 机械化质量检查（行覆盖之外）](#55-机械化质量检查行覆盖之外)
- [5. 端到端（e2e）策略](#5-端到端e2e策略)
- [6. 编写清单](#6-编写清单)
- [7. 已知 lib API 问题](#7-已知-lib-api-问题)
<!-- /TOC -->
| **unit** | `scripts/tests/unit/` | 纯函数、无 IO、毫秒级 | 678 项（17 文件） |
| **integration** | `scripts/tests/integration/` | 临时 DSH_HOME、mock fetch | 176+ 项（7 文件） |
| **e2e** | `scripts/tests/e2e/` | 真实 git 流程、fixture 仓库 | 见 install.e2e.mjs（160 项） |

统一运行器：`node scripts/tests/run.mjs`（`--level=unit|integration|e2e`、`--json`）。当前合计约 **1014+ 项**断言（678+176+160）。
⚠️ 上表数量为 2026-08-16 快照，**精确数量以 `run.mjs` 输出为准**（每文件末尾 `N passed`），勿手工维护此数字；新增测试后如数字偏差大再更新一次即可。

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
- lib/index.js：**非豁免行 100%**（222/222），豁免仅限深集成与防御性闭包（下表）
- 检查：`node scripts/coverage.mjs`（NODE_V8_COVERAGE 零依赖）
- **当前**：lib/index.js 非豁免 100%（222/222）
- pre-commit 自动检查 coverage（`--only=coverage`）
- **行覆盖 ≠ 健壮**：语义正确性由机械化检查族补充（见 §5.5）

### 豁免原则

豁免**仅在合理不可测**时使用（coverage.mjs 的 `EXEMPT_LIB_FUNCS`）：

| 豁免项 | 原因 |
|---|---|
| `runNpm`、`npmInstallWithFallback` | 依赖真实 npm 二进制，mock 不稳定 |
| `readJsonBody`、`exists`、`json` 等内部辅助 | 通过 handler 间接触发 |
| `readPackageVersion`、`readPackageName`、`readPackageJsonObject`、`copyFilter` | 深集成依赖解析路径，经调用链间接覆盖 |
| 防御性死代码闭包（`rm(...).catch(`、启动预热 `getList().catch(`） | 仅 fs 权限/占用等异常态触发（markers 见 coverage.mjs） |
| toc.mjs `isMain` 主循环 | 仅 CLI 运行时执行 |

**不豁免**：纯函数、可 mock 的 IO、可通过调用链触发的逻辑——必须覆盖。
豁免登记与 coverage.mjs 的 `EXEMPT_LIB_FUNCS` / `EXEMPT_LIB_MARKERS` 保持一致（新增豁免必须同时登记两处）。

## 5.5 机械化质量检查（行覆盖之外）

行覆盖只回答「代码被执行了多少」——语义正确性由三个机械化工具补充：

| 工具 | 命令 | 度量 |
|---|---|---|
| 突变测试 | `node scripts/mutation-test.mjs` | 测试敏感度（24 个语义突变点；存活 = 语义未锁定；当前存活 3 个全部评估为接受） |
| 性质测试 | `node scripts/tests/unit/property-based.test.mjs` | 不变式（幂等/反对称/传递性/边界/差分 `annotateInstalled ≡ detectInstalled`；8/8） |
| i18n 完整性 | `node scripts/tests/unit/i18n-completeness.test.mjs` | 字典覆盖 + 占位符一致性（5/5，进金字塔自动跑） |

改 lib 后三件套复跑顺序：`coverage → mutation → property → smoke`。

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
- **SKIP 策略**：前置条件缺失（如 git 不可用）时输出 SKIP 并以 0 退出（CI 不失败）

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

## 7. 已知 lib API 问题

测试过程中发现的 lib/index.js API 设计问题（**不在本分支修改**）：
见 [LIB-ISSUES.md](LIB-ISSUES.md)——已整理，待商讨提交 upstream。
