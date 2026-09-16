# HTTP 接口参考 / HTTP API Reference

插件市场服务端通过 `webServer.register({kind:"exact", path, handler})` 暴露的全部端点。鉴权模型与安全边界见 [SECURITY.md](SECURITY.md) §2。

<!-- TOC -->
- [1. 鉴权矩阵](#1-鉴权矩阵)
- [2. 端点全表（17 个路径）](#2-端点全表17-个路径)
  - [浏览与列表](#浏览与列表)
  - [安装与卸载](#安装与卸载)
  - [自更新](#自更新)
  - [反馈](#反馈)
  - [环境变量](#环境变量)
  - [备份与恢复](#备份与恢复)
  - [其他](#其他)
- [3. 安装状态机](#3-安装状态机)
<!-- /TOC -->

## 1. 鉴权矩阵

门槛按操作能力分三层（不按 HTTP 方法），谓词细节见 [SECURITY.md](SECURITY.md) §2：

| 层 | 门槛 | 端点 |
|---|---|---|
| 公开读 | 无 | `list` GET、`skills` GET、`self-update` GET |
| 可信读 / 出网触发 | `isTrustedRequest`（CSRF 头 + Host 白名单 + Origin 一致） | `list`/`skills` 的 `?refresh=1`、`backup` GET、`restore/diff` POST、`logs`、`feedback/pending`、`feedback/token` GET、`env-keys`、`profile` GET、`check-update` POST |
| 写 | `isWriteAllowed`（可信 + 回环直连 / LAN `lanWrite`+token） | `install`、`uninstall`、`self-update` POST、`profile` POST、`env-edit`、`feedback` POST、`feedback/token` POST、`backup/webdav`、`restore/webdav` |

统一错误语义：`403` 不可信/未授权，`405` 方法不允许，`409` 安装互斥忙（`installBusy`/`selfUpdateBusy`），`413` 请求体超 `MAX_BODY_BYTES`（1MB），`400` 参数非法。`lang` 参数或 `Accept-Language` 决定错误文案语言。

## 2. 端点全表（17 个路径）

### 浏览与列表

| 端点 | 方法 | 参数 / body | 返回 |
|---|---|---|---|
| `/api/marketplace/list` | GET | `?refresh=1` 强制重拉 | `{ repos, total, dropped, cached_at, source, fp }`；每项含 `installed` / `installedVersion` / `latestVersion` / `updateAvailable` / `cliNpm`；已安装置顶，其余 Star 降序 |
| `/api/marketplace/skills` | GET | `?refresh=1` 强制重拉；`?q=&page=&pageSize=`（≤200）触发服务端分页 | 通用 Skills 列表（`skills.json` 索引，过滤 `has_skill !== false`；每项含 `installed` / `installedAt`）。无分页参数返回全量 `{ repos, total, filtered, dropped, cached_at, source }`；带分页参数返回 `{ repos, page, pageSize, total, filtered, dropped, cached_at, source }`；`q` 服务端匹配名称/全名/标签/描述 |

### 安装与卸载

| 端点 | 方法 | body | 返回 |
|---|---|---|---|
| `/api/marketplace/install` | POST | `{ "repo": "owner/name", "answers": { "ENV_NAME": "值" } }` | `status`: `done` / `awaiting-input` / `aborted` / `failed` / `manual` + 逐步日志；`awaiting-input` 时附待确认项（见 [SECURITY.md](SECURITY.md) §3 确认门表） |
| `/api/marketplace/uninstall` | POST | `{ "repo": "owner/name" }` | `done`（含 `removed` 计数与日志）；删除安装目录 + `cordis.patch.yml` 注册条目 + 安装记录 |
| `/api/marketplace/check-update` | POST | `{ "repo": "owner/name" }` | npm 型 cli 插件手动版本检测（npmjs 与 npmmirror 双源并行，npmjs 官方值优先）：`done` + `updateAvailable` / `latestVersion` |

> 卸载依赖 `installed.json` 安装记录——**通过本市场安装**的插件可完整卸载；手动预装的插件仅识别为「已安装」，无卸载入口。脚本型插件效果不可回滚，卸载仅删记录。

### 自更新

| 端点 | 方法 | body | 返回 |
|---|---|---|---|
| `/api/marketplace/self-update` | GET | — | `{ installedVersion, latestVersion, updateAvailable, checkedAt }` |
| `/api/marketplace/self-update` | POST | — | `no-update` / `done` / `failed`；仅采纳维护者 SSH 签名的 release tag（验签→SHA 检出 staging→原子替换，细节见 [SECURITY.md](SECURITY.md) §6） |

### 反馈

| 端点 | 方法 | body | 返回 |
|---|---|---|---|
| `/api/marketplace/feedback` | POST | `{ "repo", "ok": true|false, "note": "≤2000 字符" }` | `done`（含 `issueUrl` / `manualUrl`）；repo 未安装时 `issueUrl: null` + `error` |
| `/api/marketplace/feedback/pending` | GET | — | `{ pending: [...] }` 待确认反馈队列 |
| `/api/marketplace/feedback/token` | GET | — | `{ status:"done", hasToken }`（token 本身不回显） |
| `/api/marketplace/feedback/token` | POST | `{ "token": "…" }`（空串清除） | `{ status:"done", hasToken }`；token 用于反馈自动建 issue |

反馈链路与脱敏机制见 [FEEDBACK.md](FEEDBACK.md)。

### 环境变量

| 端点 | 方法 | 参数 / body | 返回 |
|---|---|---|---|
| `/api/marketplace/env-keys` | GET | `?repo=owner/name` | `{ repo, envKeys: [...], configured: {KEY: bool} }`——键名来自安装记录或托管目录重扫；值永不回显，只回 `configured` 布尔 |
| `/api/marketplace/env-edit` | POST | `{ "repo", "values": {KEY: "值"} }` | `done` + `applied` + `restartRequired: true`（生效需重启 DSH）；只允许写安装记录登记的键名（防越权）；`not-installed` → 404，`too-many-keys` / `invalid-key` / `no-applied` → 400；落盘 `~/.dsh/marketplace/envs.json` + `~/.dsh/.env` |

### 备份与恢复

| 端点 | 方法 | body | 返回 |
|---|---|---|---|
| `/api/marketplace/backup` | GET | — | `{ status:"done", backup: { repos: [...] }, log }` 安装记录导出 |
| `/api/marketplace/restore/diff` | POST | `{ "backup": {...} }` | `{ status:"done", missing: [...], already: [...], log }` 恢复差异（不执行恢复）；`backup` 非法 → 400 |
| `/api/marketplace/backup/webdav` | POST | `{ "url", "username"?, "password"?, "backup"? }` | 推送备份到 WebDAV：`{ status:"done", count, log }`；`invalid-url` → 400；上游 HTTP 错误 → `failed` |
| `/api/marketplace/restore/webdav` | POST | `{ "url", "username"?, "password"? }` | 拉取备份并返回恢复差异 `{ status:"done", missing, already, log }`；`invalid-url`/`invalid-backup` → 400；上游 HTTP 错误 → `failed` |

WebDAV 的 URL 合法性规则（SSRF/重定向/明文凭据防护）见 [SECURITY.md](SECURITY.md) §5。

### 其他

| 端点 | 方法 | 参数 / body | 返回 |
|---|---|---|---|
| `/api/marketplace/profile` | GET | — | `{ status:"done", profile }` 当前目标 profile 名 |
| `/api/marketplace/profile` | POST | `{ "profile": "name" }` | 切换安装目标 profile；校验 `PROFILE_NAME_RE` + `~/.dsh/profiles/<name>` 存在，写入 `config.json` `targetProfile`；安装忙时 409（仅 `isBusy` 预检，不持锁） |
| `/api/marketplace/logs` | GET | — | `{ status:"done", text, count, log }` 脱敏安装日志导出 |

## 3. 安装状态机

```
POST /install ──→ done            完成
              ──→ awaiting-input  等待用户（材料收集门 / 10 个确认门；answers 再 POST 续跑，见 SECURITY.md §3）
              ──→ aborted         用户中止门 → 清理克隆缓存后返回 aborted
              ──→ failed          执行失败（日志含原因；use-case 层失败清理克隆缓存）
              ──→ manual          instructions 型仓库：返回仓库链接供手动安装
```

注意：`__confirm_cli__` 拒绝不是 `aborted`——回退常规市场安装流程（`cliSkipped` 后继续管线）。
