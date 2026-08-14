# 代码规范（Coding Standards）

本文件定义代码层面的规范：语言、结构、注释、命名、错误处理与跨平台兼容。
提交/文档规范见 [DEVELOPMENT.md](DEVELOPMENT.md)，Git Hook 见 [GIT_HOOKS.md](GIT_HOOKS.md)。

## 1. 语言与运行时

- JavaScript（ESM，`"type": "module"`），无构建步骤，纯 Node 可运行
- 最低 Node 版本：仓库 engines 声明（当前 `^22.19.0 || >=24`）
- 禁止 TypeScript 依赖、禁止编译产物提交（源码即运行产物）

## 2. 模块结构

- 纯函数模块放 `scripts/` 或 `lib/`，**无副作用顶层逻辑**
- 需要"直接运行 + 被 import"双用的脚本（如 toc.mjs）：
  - 顶层副作用必须包在 `if (isMain())` 内
  - `isMain()` 用 `pathToFileURL(argv[1])` 与 `import.meta.url` 比较 + basename fallback
- 导出：具名导出（`export function` / `export const`），禁止默认导出混用

## 3. 注释规范

- **语言**：中文注释（与仓库历史一致）
- **格式**：
  - 模块/函数级：`/** 说明 */`，解释"做什么 + 为什么"
  - 行内：`// 解释边界条件/动机`，不复述代码
- **禁止**：无意义注释（`// increment i`）、注释掉的死代码、中文与英文混排

## 4. 命名规范

- 变量/函数：camelCase
- 常量：UPPER_SNAKE_CASE（模块级常量）
- 文件名：kebab-case（`build-registry.mjs`、`smoke-tests.mjs`）
- 布尔返回函数：`is*` / `has*` / `should*` 前缀

## 5. 错误处理

- 纯函数返回结果对象 `{ ok, reason }` 或明确值，**不抛异常做业务判断**
- IO/子进程操作：`try/catch` 捕获并转为可读错误信息
- 失败信号：退出码 0/1（脚本场景），不静默吞错

## 6. 跨平台兼容（多端健壮）

| 场景 | 规范 |
|---|---|

<!-- TOC -->
- [1. 语言与运行时](#1-语言与运行时)
- [2. 模块结构](#2-模块结构)
- [3. 注释规范](#3-注释规范)
- [4. 命名规范](#4-命名规范)
- [5. 错误处理](#5-错误处理)
- [6. 跨平台兼容（多端健壮）](#6-跨平台兼容多端健壮)
- [7. 测试规范](#7-测试规范)
- [8. 安全规范](#8-安全规范)
<!-- /TOC -->
| 路径 | 始终用 `node:path` 的 `join`/`dirname`/`resolve`，禁止手拼分隔符 |
| 路径转 URL | `pathToFileURL`（处理反斜杠/盘符大小写） |
| 换行符 | 文件写入保留原 EOL；比较用 `normalizeEol` |
| 环境变量 | 禁止读取私有/敏感 key 泄漏（见 lib/index.js 的 env 最小化） |
| 子进程 | `execFileSync` + 数组参数（避免 shell 注入） |
| 编码 | 读写统一 UTF-8 |

## 7. 测试规范

- 框架：`scripts/smoke-tests.mjs`（纯 node `check(name, actual, expected)`）
- **覆盖目标**：校验/纯函数逻辑 100%（emoji 检测、提交规范、TOC、版本比较等）
- 断言风格：正向 + 负向成对，覆盖边界（空串、null、undefined、CRLF/LF）
- 新增函数必须配套断言，CI 与 hook 双重执行

## 8. 安全规范

- 禁止把 API key / token / secret 写入代码或提交（env 最小化白名单）
- 外部请求：超时、Host 校验、DNS rebinding 防护（见 lib/index.js）
- 安装脚本执行前必须确认（防供应链注入）
