#!/usr/bin/env node
// 全量可安装性探测：对 registry.json 每个仓库做两阶段探测——
//   Phase A: git/trees?recursive=1（每仓库 1 次 API）→ SKILL.md / install 脚本 / package.json 位置
//   Phase B: contents API 读根 package.json（或子目录清单，最多 3 个）→ looksLikeDshPlugin 同款判定
// 结论（verdict，与 lib detectType 优先级一致）：
//   skill / agent-preset / script / cordis-plugin（真 DSH 插件） / multi-plugin（仅子目录有插件）
//   pkg-plain（有 package.json 但非 DSH 插件——可被 detectType 按 cordis 装，但装完不可用）/ manual（只能手动）
//   unknown（探测失败/truncated 无信号）/ gone（仓库已消失）
// 断点快照存系统临时目录，中断后重跑同一命令可续。
// 用法：node scripts/verify-installability.mjs [--limit=N] [--json=out.json]
// 令牌：env.GITHUB_TOKEN || env.GH_TOKEN || `gh auth token`（需已登录 gh）。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 0;
const jsonArg = process.argv.find((a) => a.startsWith("--json="));
const OUT = jsonArg ? jsonArg.split("=")[1] : join(ROOT, "installability-report.json");
const SNAPSHOT = join(tmpdir(), "dsh-install-probe.json");
const CONCURRENCY = 8;
const RATE_FLOOR = 150; // 剩余额度低于此值即停止（1796×2 请求，5000/hr 足够，留余量）
const SNAPSHOT_EVERY = 100;

function tokenOf() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}
const TOKEN = tokenOf();
const headers = { Authorization: `Bearer ${TOKEN}`, "User-Agent": "dsh-marketplace-installability-probe", "X-GitHub-Api-Version": "2022-11-28" };

async function fetchJson(url, accept) {
  const res = await fetch(url, { headers: { ...headers, ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(20000) });
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "0");
  if (res.status === 404) return { status: 404, remaining };
  if (res.status === 403) return { status: 403, remaining };
  if (!res.ok) return { status: res.status, remaining };
  return { status: 200, remaining, body: await res.text() };
}

const SKILL_RE = /(^|\/)SKILL\.md$/i;
const SCRIPT_RE = /(^|\/)install\.(sh|ps1|bat)$/i;
const PKG_RE = /package\.json$/i;

/** 过滤掉含点路径段的文件（.codex/.opencode/.github 等）：agent 工具链配置，不是用户可安装内容。 */
function visiblePaths(paths) {
  return paths.filter((p) => !String(p).split("/").some((seg) => seg.startsWith(".")));
}

/** 与 lib/index.js looksLikeDshPlugin 同款标准。 */
function looksLikeDshPlugin(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  if (pkg.dsh && typeof pkg.dsh === "object") return true;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  const names = Object.keys(deps);
  return names.includes("@deepseek-ai/cordis") || names.includes("@deepseek-ai/dsh") || names.some((n) => n.startsWith("@deepseek-ai/dsh-"));
}

/** Phase A：单仓库 trees 探测 → 信号集。返回 null 表示不可判定（网络失败）。 */
async function probeTree(repo) {
  const branches = [repo.default_branch || "main", "main", "master"].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const branch of branches) {
    const url = `https://api.github.com/repos/${repo.full_name}/git/trees/${branch}?recursive=1`;
    const res = await fetchJson(url, "application/vnd.github+json");
    if (res.status === 403) return { rateLimited: true, remaining: res.remaining };
    if (res.status === 404) return { gone: true, remaining: res.remaining };
    if (res.status !== 200) continue;
    let tree = [];
    let truncated = false;
    try {
      const data = JSON.parse(res.body);
      tree = Array.isArray(data.tree) ? data.tree.filter((f) => f.type === "blob") : [];
      truncated = data.truncated === true;
    } catch {
      return null;
    }
    const allPaths = tree.map((f) => String(f.path ?? ""));
    const paths = visiblePaths(allPaths);
    const rootPkg = paths.includes("package.json");
    const nestedPkgs = paths.filter((p) => PKG_RE.test(p) && p !== "package.json").slice(0, 5);
    const hasSkill = paths.some((p) => SKILL_RE.test(p));
    const hasScript = paths.some((p) => SCRIPT_RE.test(p));
    const isPreset = paths.includes("preset.yml") && paths.includes("agent.cordis.yml");
    return { rootPkg, nestedPkgs, hasSkill, hasScript, isPreset, truncated, remaining: res.remaining };
  }
  return null;
}

/** Phase B：读 package.json 内容判定真插件。 */
async function fetchPkg(repo, path) {
  const url = `https://api.github.com/repos/${repo.full_name}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetchJson(url, "application/vnd.github.raw+json");
  if (res.status === 403) return { rateLimited: true, remaining: res.remaining };
  if (res.status !== 200) return { ok: false, remaining: res.remaining };
  try {
    const pkg = JSON.parse(res.body);
    return { ok: true, looksLike: looksLikeDshPlugin(pkg), remaining: res.remaining };
  } catch {
    return { ok: false, remaining: res.remaining };
  }
}

/** 判定（与 detectType 优先级一致：skill > preset > script > cordis > multi）。 */
function verdictOf(sig, pkgLooks, nestedLooks) {
  if (!sig) return "unknown";
  if (sig.gone) return "gone";
  if (sig.hasSkill) return "skill";
  if (sig.isPreset) return "agent-preset";
  if (sig.hasScript) return "script";
  if (sig.rootPkg) return pkgLooks === true ? "cordis-plugin" : "pkg-plain";
  if (sig.nestedPkgs.length > 0) return nestedLooks === true ? "multi-plugin" : "pkg-plain";
  if (sig.truncated) return "unknown"; // truncated 且无任何信号：不能断定没有
  return "manual";
}

async function main() {
  const registry = JSON.parse(await readFile(join(ROOT, "registry.json"), "utf8"));
  let repos = registry.repos;
  if (LIMIT > 0) repos = repos.slice(0, LIMIT);

  // 断点续跑：已有结论的仓库跳过
  let results = {};
  try {
    const prev = JSON.parse(await readFile(SNAPSHOT, "utf8"));
    if (Array.isArray(prev.repos)) for (const r of prev.repos) results[r.full_name] = r;
  } catch { /* 首次运行 */ }

  const todo = repos.filter((r) => !results[r.full_name]);
  console.log(`探测 ${todo.length}/${repos.length} 个仓库（并发 ${CONCURRENCY}，额度护栏 < ${RATE_FLOOR}）...`);

  let cursor = 0;
  let done = 0;
  let rateLimited = false;
  let remaining = 5000;

  const worker = async () => {
    while (cursor < todo.length && !rateLimited) {
      const repo = todo[cursor++];
      const entry = { full_name: repo.full_name, verdict: "unknown" };
      try {
        const sig = await probeTree(repo);
        if (!sig) { results[repo.full_name] = entry; done++; continue; }
        if (sig.rateLimited) { rateLimited = true; remaining = sig.remaining; continue; }
        if (sig.gone) { entry.verdict = "gone"; }
        else if (sig.remaining != null) remaining = sig.remaining;
        if (!sig.gone && (sig.rootPkg || sig.nestedPkgs.length > 0)) {
          // 根清单优先；仅子目录清单时读最多 3 个子包
          const paths = sig.rootPkg ? ["package.json"] : sig.nestedPkgs.slice(0, 3);
          let looks = false;
          let stopped = false;
          for (const p of paths) {
            const r = await fetchPkg(repo, p);
            if (r.rateLimited) { rateLimited = true; remaining = r.remaining; stopped = true; break; }
            if (r.ok && r.looksLike) { looks = true; break; }
            if (r.remaining != null) remaining = r.remaining;
          }
          if (stopped) continue;
          entry.verdict = verdictOf(sig, looks, looks);
        } else if (!sig.gone) {
          entry.verdict = verdictOf(sig, false, false);
        }
        if (entry.verdict === "unknown" && sig && sig.truncated) entry.truncated = true;
      } catch {
        entry.verdict = "unknown";
      }
      results[repo.full_name] = entry;
      done++;
      if (done % SNAPSHOT_EVERY === 0) {
        await writeFile(SNAPSHOT, JSON.stringify({ repos: [...Object.values(results)] }, null, 2), "utf8").catch(() => {});
        console.log(`  进度 ${done}/${todo.length}（剩余额度 ${remaining}）`);
      }
      if (rateLimited) console.log(`额度护栏触发：X-RateLimit-Remaining=${remaining}，停止（等一小时重跑同一命令续跑）`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await writeFile(SNAPSHOT, JSON.stringify({ repos: [...Object.values(results)] }, null, 2), "utf8").catch(() => {});

  // 汇总
  const counts = {};
  for (const r of Object.values(results)) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const order = ["cordis-plugin", "multi-plugin", "skill", "agent-preset", "script", "pkg-plain", "manual", "unknown", "gone"];
  console.log("\n===== 可安装性汇总 =====");
  for (const v of order) if (counts[v]) console.log(String(counts[v]).padStart(5), v);
  for (const [v, n] of Object.entries(counts)) if (!order.includes(v)) console.log(String(n).padStart(5), v);

  // 各类示例（便于抽查）
  for (const v of order) {
    const ex = Object.values(results).filter((r) => r.verdict === v).slice(0, 6).map((r) => r.full_name);
    if (ex.length > 0) console.log(`\n[${v}] 示例: ${ex.join(", ")}${counts[v] > 6 ? " …" : ""}`);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    counts,
    repos: Object.values(results).sort((a, b) => a.full_name.localeCompare(b.full_name))
  }, null, 2) + "\n", "utf8");
  console.log(`\n报告已写入 ${OUT}`);
}

main().catch((e) => { console.error(`失败：${e.message}`); process.exit(1); });
