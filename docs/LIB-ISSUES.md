# lib/index.js 排查记录（测试驱动暴露的问题，暂不修改）

排查方式：为 lib 编写全覆盖测试时发现的 API/行为问题。
**原则**：fix branch 不修上游代码，问题先记录，商讨后再决定动作（单独 issue/PR/保持）。

<!-- TOC -->
- [问题清单](#问题清单)
- [汇总观察](#汇总观察)
- [建议动作（待商讨）](#建议动作待商讨)
<!-- /TOC -->

## 问题清单

| # | 函数 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| 1 | `normalizeRepo(r)` | 需要对象入参（`r.html_url`），字符串入参返回全 null 对象 | `normalizeRepo("owner/repo")` → `{html_url:null,...}` | 调用方必须传 GitHub API 对象；测试无法用字符串 |
| 2 | `isOfficialPackage(pkgName)` | 是 `async`，但内部可能依赖 `loadOfficialPackages()` 网络 | 签名 `async function` | 调用方若忘 await 会拿到 Promise |
| 3 | `sanitizeManifest(pkg)` | 返回 undefined 而非清洗后的对象 | 测试 `sanitizeManifest({name:"x"})` → undefined | 语义不清：是"原地修改"还是"返回新对象"？ |
| 4 | `hasPatchEntry(patchText, pkgName)` | 匹配 `name: <pkg>` 行（正则），不是任意文本包含 | `hasPatchEntry("a:1","b")` → false | 入参语义是 YAML 文本不是 key:value 任意串 |
| 5 | `matchProfileEntry(profile, repo, keys)` | 三参且 `profile` 是 Map（`.get`），非字符串 | 单参调用 TypeError `keys is not iterable` | 依赖 Map 结构 + 官方包列表（网络） |
| 6 | `buildFilteredEnv()` | 无参，读 `process.env`（全局） | 无法传参隔离 | 测试需临时改 process.env，副作用风险 |
| 7 | `appendPatchEntry(entryId, pkgName)` | async 双参（entryId 而非文本） | 单参调用返回 Promise | 与 `hasPatchEntry` 入参风格不一致 |
| 8 | `loadOwnRepo()` | async，依赖 DSH_HOME 目录结构 | 空目录返回空数组 | 测试需构造目录 |
| 9 | `detectInstalled(repo)` | 入参 repo（对象）非字符串 | 测试传字符串失败 | 与 normalizeRepo 相同风格（对象入参） |
| 10 | `fetchJson` 错误路径 | 403 时 `res.text()` 后再 throw | mock 需同时 mock text | 错误信息包含响应体，测试要完整 mock |

## 汇总观察

- **入参风格不一致**：部分函数收字符串（`normalizeRepoRef`），部分收对象（`normalizeRepo`/`detectInstalled`）
- **async 边界模糊**：`isOfficialPackage`/`appendPatchEntry` 是 async，但命名无 `Async` 后缀
- **副作用**：`buildFilteredEnv` 读全局 process.env，`sanitizeManifest` 行为不明
- **Map 依赖**：`matchProfileEntry` 需要 Map，文档未说明

## 建议动作（待商讨）

1. 这些是**上游 lib 的 API 设计问题**，不属于 fix branch 范围
2. 可选：整理成 issue 提交 upstream（bradeGithub/DSH-Plugins-Marketplace）
3. 测试层面：lib-tests 针对**实际签名**写（不猜），标记问题但不改 lib
