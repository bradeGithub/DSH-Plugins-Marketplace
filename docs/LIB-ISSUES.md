# lib/index.js 排查记录（测试驱动暴露的问题，暂不修改）

> **跟踪 issue：[#9 lib API 设计问题清单](https://github.com/bradeGithub/DSH-Plugins-Marketplace/issues/9)**——本文件为原始排查记录 + 现状核查，后续动作在 issue 中跟进。

排查方式：为 lib 编写全覆盖测试时发现的 API/行为问题。
**原则**：不顺手重构修掉，问题先记录，商讨后再决定动作（单独 issue/PR/保持）。

**现状核查说明**：本节每项标注「仍成立 / 描述已更新 / 内部已演进」。覆盖率 100% ≠ 问题解决——
API 设计层面的入参风格 / async 边界 / 副作用 / Map 依赖**本质未改**（遵守不移除原则）；但部分函数实现
已演进，#1/#3/#10 的旧描述与代码脱节，已同步。

<!-- TOC -->
- [问题清单](#问题清单)
- [汇总观察](#汇总观察)
- [建议动作（待商讨）](#建议动作待商讨)
<!-- /TOC -->

## 问题清单

| # | 函数 | 问题 | 现状核查 | 影响 |
|---|---|---|---|---|
| 1 | `normalizeRepo(r)` | 需要对象入参（`r.html_url`），字符串入参返回全 null 对象 | **描述已更新**：对象入参仍必需；已加 `kind` 参数（dsh/skills 模式切换，skills 保留 has_skill 三态）+ 透传 pkg_name/version/npm_version/market_tags/installable/category 等构建期字段。直接断言：lib.test ×5 | 调用方必须传 GitHub API 对象；测试无法用字符串 |
| 2 | `isOfficialPackage(pkgName)` | 是 `async`，但内部可能依赖 `loadOfficialPackages()` 网络 | 仍成立。直接断言（lib.test，mock 官方/非官方包） | 调用方若忘 await 会拿到 Promise |
| 3 | `sanitizeManifest(pkg)` | 返回 undefined 而非清洗后的对象 | **描述已更新（已演进）**：现返回 `removed` 数组（被移除的 `section:name` 列表），原地删除 pnpm 本地依赖（link:/workspace:）——语义已明确，不再是「返回 undefined 行为不明」。直接断言返回为 object（lib.test） | 历史困惑已消除；返回值现为副作用清单 |
| 4 | `hasPatchEntry(patchText, pkgName)` | 匹配 `name: <pkg>` 行（正则），不是任意文本包含 | 仍成立（行级正则 `^name: [...]<pkg>[...]$`）。直接断言（lib.test 存在/缺失） | 入参语义是 YAML 文本不是 key:value 任意串 |
| 5 | `matchProfileEntry(profile, repo, keys)` | 三参且 `profile` 是 Map（`.get`），非字符串 | **内部已演进，签名仍成立**：#157 已加 dirOwners 属主反索引（无 repository 的 skills/presets 目录条目按目录属主消歧，防同名不同 owner 误标）。直接断言（installed-index.test 全量覆盖） | 依赖 Map 结构 + 官方包列表（网络）+ 现在也依赖 installedIndex.dirOwners |
| 6 | `buildFilteredEnv()` | 无参，读 `process.env`（全局） | 仍成立。直接断言（lib-pure，无敏感键残留） | 测试需临时改 process.env，副作用风险 |
| 7 | `appendPatchEntry(entryId, pkgName)` | async 双参（entryId 而非文本） | **内部已演进，签名仍成立**：返回契约已明确（已存在 → false 不重写）；patch 写队列串行化 + 队列断链防护（前一任务失败不阻断后续，当前任务失败如实抛错）。直接断言（lib.test 原子追加 + YAML 合法性） | 与 `hasPatchEntry` 入参风格不一致 |
| 8 | `loadOwnRepo()` | async，依赖 DSH_HOME 目录结构 | 仍成立。直接断言（lib.test 返回对象或 null） | 测试需构造目录 |
| 9 | `detectInstalled(repo)` | 入参 repo（对象）非字符串 | **内部已演进，签名仍成立**：#157 多路径判定加强（dirOwners 属主校验、包名映射 repository 撞名拦截、官方包排除、name-null 语义）。直接断言（installed-index.test 25+ 场景） | 与 normalizeRepo 相同风格（对象入参） |
| 10 | `fetchJson` 错误路径 | 403 时 `res.text()` 后再 throw | **描述已更新（已演进）**：现 `(url, extraHeaders={})` + timeout + `responseTooLarge` 超限防护 + content-length 快路径 / 流式计数兜底；错误路径统一 `!res.ok` 抛错（非仅 403）。未导出 → 经 `fetchAllRepos` 内部触发间接测试；security-guards 静态锁「超限抛错」契约 | 错误信息包含响应体，测试要完整 mock |

## 汇总观察

- **入参风格不一致**：部分函数收字符串（`normalizeRepoRef`），部分收对象（`normalizeRepo`/`detectInstalled`）
- **async 边界模糊**：`isOfficialPackage`/`appendPatchEntry` 是 async，但命名无 `Async` 后缀
- **副作用**：`buildFilteredEnv` 读全局 process.env（仍）；`sanitizeManifest` 行为已明确为原地删除 + 返回清单（演进）
- **Map 依赖**：`matchProfileEntry` 需要 Map（现另依赖 installedIndex）

## 建议动作（待商讨）

1. 这些是**上游 lib 的 API 设计问题**，不属于 fix branch 范围
2. 可选：整理成 issue 提交 upstream（bradeGithub/DSH-Plugins-Marketplace）
3. 测试层面：lib-tests 针对**实际签名**写（不猜），标记问题但不改 lib
4. **维护节奏**：函数实现持续演进（#3/#10 行为明确化、#5/#9 内部加固均已在覆盖内），本清单建议在重大改动或上游大版本合并后复查同步一次