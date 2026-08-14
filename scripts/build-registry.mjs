#!/usr/bin/env node
/**
 * 生成静态索引 —— DSH 插件市场 / 通用 Skills 栏目的数据源。
 *
 * 数据源：GitHub Search API（按更新时间排序分页翻到底）。
 * 由 GitHub Actions 定时执行（见 .github/workflows/registry.yml），
 * 产物提交回 main 分支，插件通过 jsDelivr CDN 读取，零 API 限流。
 *
 * 模式（环境变量 SOURCES_MODE）：
 *   dsh（默认）  topic:dsh-plugin → registry.json（DSH 插件市场，行为与历史版本完全一致）
 *   skills       topic:agent-skills + topic:claude-skills 并集 → skills.json
 *                （额外用 Trees API 探测 has_skill / has_install_script，见下方「探测」注释）
 *
 * 环境变量：
 *   GH_TOKEN / GITHUB_TOKEN  有则带认证头（Search 限额 30 次/分钟，Actions 内自动提供）
 *   SOURCES_MODE             索引模式：dsh | skills（默认 dsh）
 *   MAX_PAGES                最大翻页数（默认 100，本地测试可设小）
 *   REGISTRY_FILE            输出路径（默认仓库根 registry.json / skills.json）
 *   PROBE_FILE               探测断点快照路径（默认 <OUT_FILE>.probing，仅 skills 模式）
 *   SKIP_ENRICH=1            跳过 pkg_name 富化（raw.githubusercontent 不通/被墙时构建会卡在
 *                            每个请求的超时上；本地回归或断网环境可跳过，CI 始终执行）
 *
 * ── 探测额度预算（仅 skills 模式；Core API 5000/h、Search 30/min 各自独立限额）──
 *   冷启动（无历史）    ~7000 次 Trees 探测 → 超过 5000/h，靠护栏分批：
 *                       X-RateLimit-Remaining < 200 立即停止，partial-merge 落盘；
 *                       等一小时重跑同一命令，增量继承让已探测的仓库不再重复探测。
 *   稳态增量           ~300~800 次（仅 updated_at 变动的仓库）→ 远低于限额 ✓
 *   Search 分页         ~70 页 × 2.2s（带 token）≈ 3 分钟，30/min 限额无压力 ✓
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MODE = process.env.SOURCES_MODE ?? "dsh";
const QUERIES = MODE === "skills"
  ? ["topic:agent-skills", "topic:claude-skills"]
  : ["topic:dsh-plugin"];
const OUT_FILE = process.env.REGISTRY_FILE ?? join(ROOT, "..", MODE === "skills" ? "skills.json" : "registry.json");
const PROBE_FILE = process.env.PROBE_FILE ?? OUT_FILE + ".probing";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 100);
const PER_PAGE = 100;
const EXCLUDED = new Set(["deepseek-harness"]);
const DELAY_MS = TOKEN ? 2200 : 6500; // 限流：带 token 30/min，未认证 10/min

// ── 探测护栏（仅 skills 模式）──
const PROBE_CONCURRENCY = 8;   // 探测并发（沿用 enrichPkgNames 的 worker 模式）
const RATE_LIMIT_FLOOR = Number(process.env.RATE_LIMIT_FLOOR ?? 200); // X-RateLimit-Remaining 低于此值立即停止探测（可环境变量覆盖，便于本地调试）
const PROBE_TIMEOUT_MS = 20000; // 单仓库 Trees 探测超时（大仓库可能较慢）
const SNAPSHOT_EVERY = 10;     // 每探测 N 个仓库写一次断点快照（中断后重跑可续）

function log(msg) {
  console.log(`[registry:${MODE}] ${msg}`);
}

function ghHeaders() {
  return {
    "User-Agent": "dsh-plugin-marketplace-registry",
    Accept: "application/vnd.github+json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
  };
}

async function fetchPage(query, page) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return await res.json();
}

function normalize(r) {
  return {
    full_name: r.full_name,
    name: r.name,
    description: r.description,
    html_url: r.html_url,
    stargazers_count: r.stargazers_count,
    updated_at: r.updated_at,
    default_branch: r.default_branch ?? "main",
    topics: r.topics ?? [],
    license: r.license?.spdx_id ?? null
  };
}

/**
 * 多 query 并集分页拉取（skills 模式 = agent-skills ∪ claude-skills）。
 * complete=true 仅当所有 query 都完整翻到底；任一 query 中断则 partial。
 */
async function fetchAllTopics() {
  const merged = new Map();
  let allComplete = true;
  for (const q of QUERIES) {
    let totalCount = null;
    let complete = false;
    let freshCount = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const data = await fetchPage(q, page);
        totalCount = data.total_count ?? totalCount;
        const items = data.items ?? [];
        for (const r of items) {
          if (merged.has(r.full_name)) continue; // 跨 query 全局去重
          if (EXCLUDED.has(r.name)) continue;
          merged.set(r.full_name, normalize(r));
          freshCount++;
        }
        log(`[${q}] page ${page}: +${items.length}（累计 ${merged.size}${totalCount != null ? ` / ${totalCount}` : ""}）`);
        if (items.length < PER_PAGE) { complete = true; break; }
        if (totalCount != null && freshCount >= totalCount) { complete = true; break; }
      } catch (error) {
        // GitHub Search API 硬上限：单 query 最多返回 1000 条（第 11 页起 422）。
        // 此时数据已拉满，视为完整而非失败——每 query 1000 条是 Search 方案的物理上限。
        const limited = /Only the first 1000 search results/.test(String(error?.message ?? ""));
        if (limited) {
          complete = true;
          log(`[${q}] 已达 Search API 1000 条/query 上限（${freshCount} 条），视为完整`);
        } else {
          log(`[${q}] page ${page} 失败：${error.message}（使用已拉取的部分数据）`);
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
    if (!complete) allComplete = false;
  }
  return { repos: [...merged.values()], complete: allComplete };
}

/**
 * 从 Trees 响应中判定探测字段（纯函数，便于测试）：
 * - has_skill: 存在 SKILL.md（仓库根或任意子目录，仅 blob）
 * - has_install_script: 存在 install.sh / install.ps1 / install.bat（安全徽章数据）
 * - truncated=true 且未命中 → null（未知）——超大仓库可能没返回完整树，
 *   此时「没扫到」不能断定「没有」，必须记 null，绝不误判 false。
 */
export function classifyTree(tree, truncated) {
  const list = Array.isArray(tree) ? tree : [];
  const hasSkill = list.some((f) => f.type === "blob" && /(^|\/)SKILL\.md$/i.test(String(f.path ?? "")));
  const hasScript = list.some((f) => /(^|\/)install\.(sh|ps1|bat)$/i.test(String(f.path ?? "")));
  return {
    has_skill: hasSkill ? true : (truncated ? null : false),
    has_install_script: hasScript ? true : (truncated ? null : false)
  };
}

/** 增量继承判定（纯函数）：updated_at 未变且旧条目有**真实探测结果**（true/false）→ 整包继承。
 *  null（未知：未探测 / 护栏中断 / truncated 大仓库）不继承——重跑时重新探测，
 *  保证冷启动分批探测能逐步收敛到全量真实结果（truncated 大仓库数量有限，反复重试代价可接受）。 */
export function shouldInheritProbe(repo, old) {
  return Boolean(old && old.updated_at === repo.updated_at && typeof old.has_skill === "boolean");
}

/**
 * pkg_name 冲突消解（纯函数）：同名 npm 包在 node_modules 的安装目标互斥（同目录互相覆盖），
 * 索引并列会误导（显示两张卡、装一个盖掉另一个）。保留 Star 高者，低者移入 dropped。
 * 无 pkg_name 的条目按 full_name 天然唯一，不参与冲突。
 * @returns {{ repos: Array, dropped: string[] }} dropped 为被隐藏条目的 full_name 列表。
 */
export function dedupeByPkgName(repos) {
  const byKey = new Map();
  const dropped = [];
  for (const r of repos) {
    const key = r.pkg_name ? `pkg:${r.pkg_name}` : `repo:${r.full_name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    const prevStars = prev.stargazers_count ?? 0;
    const curStars = r.stargazers_count ?? 0;
    if (curStars > prevStars) {
      dropped.push(prev.full_name);
      byKey.set(key, r);
    } else {
      dropped.push(r.full_name);
    }
  }
  return { repos: [...byKey.values()], dropped };
}

/** 探测单个仓库（Trees API 一次调用同时拿到 has_skill / has_install_script）。失败容忍：null 表示未知。 */
async function probeRepo(repo) {
  const url = `https://api.github.com/repos/${repo.full_name}/git/trees/${repo.default_branch}?recursive=1`;
  let res;
  try {
    res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    repo.has_skill = null;
    repo.has_install_script = null;
    return null; // 网络/超时失败：标记未知，无额度信息
  }
  let remaining = null;
  const rl = res.headers.get("x-ratelimit-remaining");
  if (rl != null) remaining = Number(rl);
  if (!res.ok) {
    repo.has_skill = null;
    repo.has_install_script = null;
    return remaining;
  }
  try {
    const data = await res.json();
    const classified = classifyTree(data.tree, data.truncated === true);
    repo.has_skill = classified.has_skill;
    repo.has_install_script = classified.has_install_script;
  } catch {
    repo.has_skill = null;
    repo.has_install_script = null;
  }
  return remaining;
}

/** 断点快照写队列（串行化，多 worker 并发写同一文件会交错）。 */
let snapshotQueue = Promise.resolve();
function queueSnapshot(repos) {
  const data = {
    generated_at: new Date().toISOString(),
    schema_version: 1,
    count: repos.length,
    source: "probing",
    repos: repos.map((r) => ({ ...r }))
  };
  snapshotQueue = snapshotQueue
    .then(() => writeFile(PROBE_FILE, JSON.stringify(data, null, 2), "utf8"))
    .catch(() => {});
  return snapshotQueue;
}

/**
 * 并发探测队列 + 额度护栏：
 * - 每次探测后读 X-RateLimit-Remaining，< RATE_LIMIT_FLOOR 立即停止（部分结果照常落盘）；
 * - 边跑边写 PROBE_FILE 快照，进程被杀/中断后重跑同一命令可续（loadExisting 优先读快照）。
 */
async function probeAll(repos, probeQueue) {
  if (probeQueue.length === 0) return;
  log(`开始探测 ${probeQueue.length} 个仓库（Trees API，并发 ${PROBE_CONCURRENCY}，护栏 < ${RATE_LIMIT_FLOOR}）...`);
  let cursor = 0;
  let probeStop = false;
  let probeDone = 0;
  const worker = async () => {
    while (cursor < probeQueue.length && !probeStop) {
      const repo = probeQueue[cursor++];
      const remaining = await probeRepo(repo);
      if (remaining != null && remaining < RATE_LIMIT_FLOOR) {
        log(`额度护栏触发：X-RateLimit-Remaining=${remaining} < ${RATE_LIMIT_FLOOR}，停止探测（结果已落盘，等一小时重跑同一命令可续）`);
        probeStop = true;
      }
      probeDone++;
      if (probeDone % SNAPSHOT_EVERY === 0) await queueSnapshot(repos);
    }
  };
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, () => worker()));
  await snapshotQueue; // 等最后一次快照写完再继续
  log(`探测完成：${probeDone}/${probeQueue.length}（${probeStop ? "额度护栏触发" : "队列耗尽"}）`);
}

async function loadExisting() {
  // skills 模式优先读断点快照（比正式索引新，含中断前的探测结果），实现断点续跑
  const candidates = MODE === "skills" ? [PROBE_FILE, OUT_FILE] : [OUT_FILE];
  for (const file of candidates) {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (data && Array.isArray(data.repos)) return data.repos;
    } catch { /* 首次运行或文件损坏，尝试下一个 */ }
  }
  return [];
}

async function main() {
  log(`模式=${MODE}，queries=[${QUERIES.join(", ")}]，输出=${OUT_FILE}`);
  const { repos: fresh, complete } = await fetchAllTopics();

  // 增量合并：完整拉取则整体替换，否则保留旧条目（新数据优先）。
  // skills 模式即使完整拉取也必须加载旧索引——探测继承依赖旧探测结果（探测远比 Search 贵）。
  const STALE_DAYS = 14;
  const now = Date.now();
  const existing = (MODE === "skills" || !complete) ? await loadExisting() : [];
  const oldMap = new Map(existing.map((r) => [r.full_name, r]));
  const freshNames = new Set(fresh.map((r) => r.full_name));
  const merged = new Map();
  for (const r of [...existing, ...fresh]) {
    if (!r || typeof r.full_name !== "string" || EXCLUDED.has(r.name)) continue;
    const seenAt = freshNames.has(r.full_name)
      ? new Date().toISOString()
      : (r.registry_seen_at || "1970-01-01T00:00:00.000Z");
    if (Date.parse(seenAt) < now - STALE_DAYS * 24 * 3600 * 1000) continue;
    merged.set(r.full_name, { ...r, registry_seen_at: seenAt });
  }
  let repos = [...merged.values()].sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));

  // skills 模式：增量继承（控额度的命根子）+ Trees 探测
  if (MODE === "skills") {
    const probeQueue = [];
    for (const repo of repos) {
      if (shouldInheritProbe(repo, oldMap.get(repo.full_name))) {
        const old = oldMap.get(repo.full_name);
        Object.assign(repo, {
          has_skill: old.has_skill,
          has_install_script: old.has_install_script,
          pkg_name: old.pkg_name ?? null
        });
      } else {
        probeQueue.push(repo);
      }
    }
    await probeAll(repos, probeQueue);
    // 护栏中断等未探测到的条目补 null，保证三态字段完整（true / false / null 未知）
    for (const repo of repos) {
      if (repo.has_skill === undefined) repo.has_skill = null;
      if (repo.has_install_script === undefined) repo.has_install_script = null;
    }
  }

  // 富化：为缺失 pkg_name 的仓库抓取 package.json 的 name（raw 抓取，不占 API 额度）。
  // 失败容忍：拿不到包名的仓库 pkg_name 为 null，不影响其余功能。
  if (process.env.SKIP_ENRICH === "1") {
    log("SKIP_ENRICH=1：跳过 pkg_name 富化");
  } else {
    await enrichPkgNames(repos);
  }

  // pkg_name 冲突消解：同名 npm 包在 node_modules 里的安装目标互斥（同目录互相覆盖），
  // 索引里并列会误导用户（显示两张卡、装一个盖掉另一个，如 dsh-archive-viewer 的
  // keepermttl/csiroqa 两个仓库）。保留 Star 高者，低者从索引剔除并告警维护者改名。
  const { repos: deduped, dropped: droppedRepos } = dedupeByPkgName(repos);
  if (droppedRepos.length > 0) {
    for (const fullName of droppedRepos) {
      log(`pkg_name 冲突：隐藏低 Star 条目 ${fullName}（同名 npm 包只能安装一个，请原作者改名）`);
    }
  }
  repos = deduped;

  const out = {
    generated_at: new Date().toISOString(),
    ...(MODE === "skills" ? { schema_version: 1 } : {}), // dsh 模式输出与历史版本逐字段一致（回归）
    count: repos.length,
    source: complete ? "full" : "partial-merge",
    repos
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  if (MODE === "skills") await rm(PROBE_FILE, { force: true }).catch(() => {});
  log(`已写入 ${OUT_FILE}：${repos.length} 个仓库（${out.source}）`);
}

/** 并发抓取仓库 package.json 的 name 字段写入 pkg_name（已存在的跳过）。 */
async function enrichPkgNames(repos) {
  const todo = repos.filter((r) => !r.pkg_name);
  if (todo.length === 0) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const r = todo[cursor++];
      const url = `https://raw.githubusercontent.com/${r.full_name}/${r.default_branch}/package.json`;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "dsh-plugin-marketplace-registry" },
          signal: AbortSignal.timeout(15000)
        });
        if (res.ok) {
          const pkg = await res.json();
          if (typeof pkg.name === "string" && pkg.name.length > 0) {
            r.pkg_name = pkg.name;
          }
        }
      } catch { /* 网络失败：保持 null */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  log(`pkg_name 富化完成：${todo.filter((r) => r.pkg_name).length}/${todo.length}`);
}

// 直接运行才执行 main（被 smoke-tests import 时只暴露纯函数，无副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[registry:${MODE}] 失败：${error.message}`);
    process.exit(1);
  });
}
