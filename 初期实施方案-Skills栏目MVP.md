# 初期实施方案：「通用热门 Skills」栏目 MVP

> 版本：v2.0（2026-08-14），替代旧版方案的阶段 1+3 部分
> 范围：**只做一件事**——DSH 市场里上线"通用热门 Skills"栏目，数据来自新建的全量 skills 索引
> 原则：主链路一天闭环；monorepo 展开、awesome 列表、静态站、CLI 全部后置，不在本期范围

---

## 一、本期目标与非目标

### 目标
- CI/本地构建出全量 skills 索引 `skills.json`（≥ 5000 条，基于 GitHub topic 搜索）
- DSH 设置页新增「通用 Skills」tab：浏览、搜索、一键安装到 `~/.dsh/skills/`、已安装识别
- 与现有「DSH 插件」tab 完全隔离，互不干扰

### 非目标（本期不做，别手痒）
- ❌ monorepo 子目录展开（`anthropics/skills` 等多 SKILL.md 仓库）→ v2
- ❌ awesome 列表数据源 → v2
- ❌ GitHub Pages 静态站 → 栏目上线发贴之后
- ❌ 卸载功能（DSH 插件侧的，原计划 P0）→ 另排
- ❌ skill 弱更新提示 → v2

---

## 二、执行顺序总览

```
步骤 1  build-registry.mjs 支持 skills 模式（多 topic 并集 + SKILL.md 探测 + 增量继承）
步骤 2  本地冷启动，跑出首版 skills.json，人肉抽查质量，提交 main
步骤 3  CI workflow 加 skills 构建 job（此后纯增量，几分钟一次）
步骤 4  lib/index.js 加 /api/marketplace/skills 路由（复用拉取/缓存/回退逻辑）
步骤 5  lib/client.js 加 tab + 卡片复用 + 已安装判定
步骤 6  验收 → 发版 → 当天发帖
```

---

## 三、步骤 1：build-registry.mjs 改造（约 1~1.5 小时）

### 3.1 模式开关

不改动现有 `registry.json`（DSH 插件）的任何行为，用环境变量切换：

```js
const MODE = process.env.SOURCES_MODE ?? "dsh";

const QUERIES = MODE === "skills"
  ? ["topic:agent-skills", "topic:claude-skills"]   // 本期仅两个 topic，取并集
  : ["topic:dsh-plugin"];                            // 原行为

const OUT_FILE = process.env.REGISTRY_FILE
  ?? join(ROOT, "..", MODE === "skills" ? "skills.json" : "registry.json");
```

### 3.2 多 query 并集拉取

把现有"单 query 分页翻到底"的循环包一层：

```js
async function fetchAllTopics() {
  const merged = new Map();
  for (const q of QUERIES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchPage(q, page);   // 原 fetchPage 加 query 参数
      const items = data.items ?? [];
      for (const r of items) {
        if (!merged.has(r.full_name) && !EXCLUDED.has(r.name)) {
          merged.set(r.full_name, normalize(r));
        }
      }
      if (items.length < PER_PAGE) break;
      await sleep(DELAY_MS);                    // 带 token 2.2s，Search 限额 30/min
    }
  }
  return [...merged.values()];
}
```

成本：~7000 仓库 ÷ 100/页 ≈ 70 页 × 2.2s ≈ **3 分钟**，Search API 限额毫无压力。

### 3.3 SKILL.md 探测（Trees API，一次调用探四件事）

对每个需要探测的仓库，一次 Trees 调用同时记录：

```js
async function probeRepo(repo) {
  const res = await fetch(
    `https://api.github.com/repos/${repo.full_name}/git/trees/${repo.default_branch}?recursive=1`,
    { headers: ghHeaders() }
  );
  if (!res.ok) { repo.has_skill = null; return; }   // 失败容忍：null 表示未知，不污染数据
  const { tree = [] } = await res.json();
  repo.has_skill  = tree.some(f => f.type === "blob" && /(^|\/)SKILL\.md$/i.test(f.path));
  repo.has_install_script = tree.some(f => /(^|\/)install\.(sh|ps1|bat)$/i.test(f.path));  // 安全徽章数据，前端本期可先不展示
  // package.json name 也从树里确认存在性，pkg_name 仍走 raw 富化（不占额度）
}
```

> ⚠️ Trees API 对超大仓库会返回 `truncated: true`——此时 SKILL.md 若没扫到，不能断定 `has_skill=false`，应记 `null`（未知）。一行判断，别漏。

### 3.4 增量继承（控额度的命根子）

合并旧索引时，`updated_at` 未变的条目**整包继承探测结果**，不进探测队列：

```js
const old = oldMap.get(repo.full_name);
if (old && old.updated_at === repo.updated_at && old.has_skill !== undefined) {
  Object.assign(repo, {
    has_skill: old.has_skill,
    has_install_script: old.has_install_script,
    pkg_name: old.pkg_name ?? null,
  });
} else {
  probeQueue.push(repo);
}
```

### 3.5 额度护栏

- 每次 probe 后读响应头 `X-RateLimit-Remaining`，**< 200 立即停止探测**，用部分结果走现有 partial-merge 落盘
- 探测队列并发 8（沿用 `enrichPkgNames` 的 worker 模式），间隔无需刻意压低，护栏兜底
- 探测结果**边跑边写临时文件**（`skills.json.probing`），中断后重跑可续

### 3.6 输出格式

```jsonc
{
  "generated_at": "...",
  "schema_version": 1,
  "count": 5231,
  "source": "full | partial-merge",
  "repos": [
    {
      "full_name": "owner/name",
      "name": "...",
      "description": "...",
      "html_url": "...",
      "stargazers_count": 0,
      "updated_at": "...",
      "default_branch": "main",
      "topics": [],
      "license": "MIT",
      "has_skill": true,           // true / false / null(未知)
      "has_install_script": false, // 同上
      "pkg_name": null,
      "registry_seen_at": "..."    // 沿用 stale 剔除机制
    }
  ]
}
```

客户端过滤：`has_skill !== false` 才进市场列表（true 和 null 都显示，null 图标弱化）。

### 3.7 额度预算表（贴代码注释里）

| 阶段 | Core API 调用 | 限额 5000/h |
|---|---|---|
| 冷启动（无历史） | ~7000（探测）| **超额** → 本地分批/护栏分批 |
| 稳态增量 | ~300~800（仅变动仓库）| ✅ < 20% |
| Search 分页 | ~70 次 | Search 独立限额 30/min ✅ |

---

## 四、步骤 2：本地冷启动（1~2 小时，期间可写前端）

```bash
GH_TOKEN=<你的PAT> SOURCES_MODE=skills node scripts/build-registry.mjs
```

- 撞额度护栏触发后，等一小时重跑同一命令（增量继承会让它续跑，已探测的不重复）
- 产出 `skills.json` 后**人肉抽查 20 条**：
  - star 前 10 是否都有 SKILL.md（`has_skill: true`）
  - 随机 10 条 `has_skill: false/null` 的，点进仓库看是否误判
  - truncated 大仓库是否被正确标 `null` 而非 `false`
- 抽查通过后提交 main。CI 从此进入稳态增量模式

---

## 五、步骤 3：CI workflow（10 分钟）

```yaml
- name: Build DSH registry
  run: node scripts/build-registry.mjs
- name: Build skills registry
  run: SOURCES_MODE=skills node scripts/build-registry.mjs
```

- 频率保持每 2 小时（增量模式下额度够）；若发现配额紧张再降 6 小时
- 两个产物的 stale 剔除机制各自独立，互不影响

---

## 六、步骤 4：服务端路由（lib/index.js，约 30 分钟）

1. 抽现有"拉 registry"的函数，URL 参数化，skills 版指向：
   `https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/skills.json` → 兜底 raw.githubusercontent
2. 新路由 `GET /api/marketplace/skills`：返回过滤后（`has_skill !== false`）按 star 降序的列表，字段含 `installed` / `installedAt`
3. 已安装判定（skills 专用，两重即可）：
   - `installed.json` 中 `type === "skill"` 且 repo 匹配
   - `~/.dsh/skills/<name>` 目录存在性探测
   - （包名映射/repository 校验那三重是 cordis 插件的，skills 用不上）
4. 安装：**零改动**。现有 `POST /api/marketplace/install` 的 skill 分支（识别 SKILL.md → 复制到 `~/.dsh/skills/`）直接可用，前端传 `repo` 即可

---

## 七、步骤 5：前端 tab（lib/client.js，约 1.5~2 小时）

1. 设置页加 tab 栏：「DSH 插件」|「通用 Skills」，各自持有搜索词、列表、加载状态
2. Skills tab 复用卡片组件，差异点：
   - 隐藏「更新」按钮（skill 无版本概念）
   - `has_install_script: true` 的卡片加 🛡 角标（你安全叙事的第一个露出，成本一行）
   - `has_skill: null` 的条目名称旁加"未验证"弱提示
3. 排序沿用：已安装置顶 + star 降序
4. 性能：5000+ 卡片必须做**每页 60 + IntersectionObserver 触底加载**（约 30 行），搜索在完整数组 filter 后重新分页。别一次渲染，会卡
5. 断网/拉取失败：tab 内独立错误提示 + 重试按钮，不影响另一个 tab

---

## 八、步骤 6：验收清单

- [ ] `skills.json` count ≥ 5000，抽查准确率 ≥ 90%
- [ ] 冷启动后第二次 CI 运行 < 10 分钟，Core API 消耗 < 1000
- [ ] 两 tab 互不干扰；断网各自报错
- [ ] 安装 1 个热门独立 skill 仓库 → 落 `~/.dsh/skills/` → 卡片变灰"已安装"并置顶
- [ ] 滚动到底加载顺畅，搜索实时过滤无卡顿
- [ ] `registry.json` 内容与改造前 diff 为空（回归）

## 九、上线当天（分发动作，零代码）

1. 仓库 topics 加：`agent-skills`、`claude-skills`、`skill-marketplace`
2. README 在功能特性里加一条："通用 Skills 栏目：5000+ 全量索引（CI 每日校验完整性），安全脚本执行前确认"
3. 发帖（r/ClaudeAI + V2EX + 即刻），标题主打差异点：
   > 「5000+ skills 全量索引的插件市场——别的市场拉 GitHub 只能拉 400 条，我们用 CI 预建索引；安装脚本执行前会先问你」
4. 截图：tab 界面 + 🛡 安全角标 + 安装确认弹窗

---

## 十、本期明确砍掉的东西（写在这里防自己反悔）

| 砍掉项 | 原因 | 何时捡回 |
|---|---|---|
| monorepo 展开 | Trees 已探测到多 SKILL.md，数据结构留了 `null` 余地；展开逻辑 + 前端子条目 + 子目录安装约 +3 小时 | 栏目上线后 v2 |
| awesome 列表源 | 增量 < 10%，解析 + 元数据回捞 +2 小时 | v2 |
| 静态站 | 依赖本期数据稳定后才有意义 | 发帖有反响后 |
| 抽 core / CLI | 无流量前重构是纯成本 | 静态站验证需求后 |
