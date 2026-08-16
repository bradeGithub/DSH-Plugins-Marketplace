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
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { looksLikeDshPlugin } from "./build-registry.mjs";

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
  const resetMs = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000 || 0;
  if (res.status === 404) return { status: 404, remaining, resetMs };
  if (res.status === 403) return { status: 403, remaining, resetMs };
  if (!res.ok) return { status: res.status, remaining, resetMs };
  return { status: 200, remaining, resetMs, body: await res.text() };
}

const SKILL_RE = /(^|\/)SKILL\.md$/i;
const SCRIPT_RE = /(^|\/)install\.(sh|ps1|bat)$/i;
const PKG_RE = /package\.json$/i;

/** 过滤掉含点路径段的文件（.codex/.opencode/.github 等）：agent 工具链配置，不是用户可安装内容。 */
function visiblePaths(paths) {
  return paths.filter((p) => !String(p).split("/").some((seg) => seg.startsWith(".")));
}

/** Phase A：单仓库 trees 探测 → 信号集。返回 null 表示不可判定（网络失败）。 */
async function probeTree(repo) {
  const branches = [repo.default_branch || "main", "main", "master"].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const branch of branches) {
    const url = `https://api.github.com/repos/${repo.full_name}/git/trees/${branch}?recursive=1`;
    const res = await fetchJson(url, "application/vnd.github+json");
    if (res.status === 403) return { rateLimited: true, remaining: res.remaining, resetMs: res.resetMs };
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
    const skillPaths = paths.filter((p) => SKILL_RE.test(p)).slice(0, 20);
    const hasSkill = skillPaths.length > 0;
    // 只有**根目录** SKILL.md 才算 skill 形态（对齐 lib/index.js detectType 分层判定）——
    // 深层埋的 SKILL.md 是大项目内部内容，不是市场可安装的技能本体
    // （教训：amruthpillai/reactive-resume 的 skills/resume-builder/SKILL.md、
    //  volcengine/OpenViking 的 bot/workspace/skills/*/SKILL.md 曾让两者被误判为 skill）。
    const rootSkill = skillPaths.some((p) => /^SKILL\.md$/i.test(p));
    // 技能集合形态 = SKILL.md 位于 skills/<name>/SKILL.md 等 ≤2 级路径；
    // 更深（bot/workspace/skills/*/SKILL.md 4 级）是大项目内部工具链内容 → 不算技能集合。
    const minSkillDepth = hasSkill ? Math.min(...skillPaths.map((p) => p.split("/").length)) : Infinity;
    const hasScript = paths.some((p) => SCRIPT_RE.test(p));
    // 同款：只有根 install 脚本才算 script 型（detectType 只认根目录 install.ps1/install.sh；
    // OpenViking 深层 install.sh 曾触发 script 判定）
    const rootScript = paths.some((p) => /^install\.(sh|ps1|bat)$/i.test(p));
    const isPreset = paths.includes("preset.yml") && paths.includes("agent.cordis.yml");
    return { rootPkg, nestedPkgs, hasSkill, rootSkill, minSkillDepth, hasScript, rootScript, isPreset, truncated, remaining: res.remaining };
  }
  return null;
}

/** Phase B：读 package.json 内容判定真插件。 */
async function fetchPkg(repo, path) {
  const url = `https://api.github.com/repos/${repo.full_name}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetchJson(url, "application/vnd.github.raw+json");
  if (res.status === 403) return { rateLimited: true, remaining: res.remaining, resetMs: res.resetMs };
  if (res.status !== 200) return { ok: false, remaining: res.remaining };
  try {
    const pkg = JSON.parse(res.body);
    return { ok: true, looksLike: looksLikeDshPlugin(pkg), remaining: res.remaining };
  } catch {
    return { ok: false, remaining: res.remaining };
  }
}

/** 判定（对齐 detectType 分层：preset > cordis 声明 > 根 install 脚本 > 根 skill > 嵌套包 > 嵌套 skill）。
 *  与旧版的关键差异（蹭 topic 案例修复）：
 *  - 根清单 dsh 声明优先于 install 脚本（审查 B1，防「插件+分发脚本」被劫持为 script 型）；
 *  - 只有**根目录** SKILL.md 才算 skill（skill-with-tooling 合法形态），深层 SKILL.md 是大项目
 *    内部内容 → pkg-plain（reactive-resume/OpenViking 曾因此漏过 non-plugin 徽章）；
 *  - 只有**根目录** install 脚本才算 script 型（深层 install.sh 同理）。 */
export function verdictOf(sig, pkgLooks, nestedLooks) {
  if (!sig) return "unknown";
  if (sig.gone) return "gone";
  if (sig.isPreset) return "agent-preset";
  if (sig.rootPkg && pkgLooks === true) return "cordis-plugin";
  if (sig.rootScript === true) return "script";
  if (sig.rootPkg) {
    if (sig.rootSkill === true) return "skill";
    // truncated：路径集不完整，根 SKILL.md 可能缺失——有 skill 信号时保守判 skill
    if (sig.truncated) return sig.hasSkill ? "skill" : "pkg-plain";
    return "pkg-plain";
  }
  if (sig.hasSkill) {
    // 无根清单：≤2 级的 SKILL.md 是技能集合形态（skills/<name>/SKILL.md）；
    // 更深埋的是大项目内部工具链内容（OpenViking 的 bot/workspace/skills/*/SKILL.md 4 级）
    // → 不可自动安装，走 manual（README 手动安装徽章）。
    // truncated 时路径集不完整，minSkillDepth 可能偏大 → 保守判 skill。
    if (sig.truncated) return "skill";
    return sig.minSkillDepth <= 2 ? "skill" : "manual";
  }
  if ((sig.nestedPkgs?.length ?? 0) > 0) return nestedLooks === true ? "multi-plugin" : "pkg-plain";
  if (sig.truncated) return "unknown"; // truncated 且无任何信号：不能断定没有
  return "manual";
}

async function main() {
  const registry = JSON.parse(await readFile(join(ROOT, "registry.json"), "utf8"));
  let repos = registry.repos;
  if (LIMIT > 0) repos = repos.slice(0, LIMIT);

  // 断点续跑：已有非 pending 结论的仓库跳过（pending=unknown 的条目下次重试）。
  // 基线 = 临时断点快照（本机续跑）+ 仓库内已提交的报告（CI 每轮环境全新，靠报告文件续跑收敛）。
  let results = {};
  for (const src of [SNAPSHOT, OUT]) {
    try {
      const prev = JSON.parse(await readFile(src, "utf8"));
      if (Array.isArray(prev.repos)) for (const r of prev.repos) {
        if (!results[r.full_name] || (results[r.full_name].pending === true && r.pending !== true)) {
          results[r.full_name] = r;
        }
      }
    } catch { /* 首次运行 / 报告不存在 */ }
  }

  const todo = repos.filter((r) => {
    const e = results[r.full_name];
    return !e || e.pending === true;
  });
  console.log(`探测 ${todo.length}/${repos.length} 个仓库（并发 ${CONCURRENCY}，额度护栏 < ${RATE_FLOOR}）...`);

  let cursor = 0;
  let done = 0;
  let remaining = 5000;
  let waits = 0;
  const MAX_WAITS = 2; // 最多等 2 个 reset 窗口（2 小时），之后带已收集结果收尾

  /** 额度耗尽：不消费当前仓库（等待后重试同一仓库），超过最大等待次数返回 false。 */
  async function waitForQuota(resetMs) {
    const waitMs = Math.max(0, (resetMs ?? Date.now() + 60000) - Date.now()) + 10000;
    waits++;
    if (waits > MAX_WAITS) return false;
    console.log(`额度耗尽（剩余 ${remaining}），等待 ${Math.round(waitMs / 60000)} 分钟后重试（第 ${waits} 次）...`);
    await new Promise((res) => setTimeout(res, waitMs));
    return true;
  }

  const worker = async () => {
    while (cursor < todo.length) {
      const repo = todo[cursor++];
      const entry = { full_name: repo.full_name, verdict: "unknown" };
      try {
        const sig = await probeTree(repo);
        if (!sig) { results[repo.full_name] = entry; done++; continue; }
        if (sig.rateLimited) {
          cursor--; // 同一仓库等待后重试
          if (!(await waitForQuota(sig.resetMs))) break;
          continue;
        }
        if (sig.gone) { entry.verdict = "gone"; }
        else if (sig.remaining != null) remaining = sig.remaining;
        if (!sig.gone && (sig.rootPkg || sig.nestedPkgs.length > 0)) {
          // 根清单优先；仅子目录清单时读最多 3 个子包
          const paths = sig.rootPkg ? ["package.json"] : sig.nestedPkgs.slice(0, 3);
          let looks = false;
          let stopped = false;
          let resetMs = 0;
          for (const p of paths) {
            const r = await fetchPkg(repo, p);
            if (r.rateLimited) { remaining = r.remaining; resetMs = r.resetMs; stopped = true; break; }
            if (r.ok && r.looksLike) { looks = true; break; }
            if (r.remaining != null) remaining = r.remaining;
          }
          if (stopped) {
            cursor--; // 同一仓库等待后重试
            if (!(await waitForQuota(resetMs))) break;
            continue;
          }
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
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  // 兜底：任何原因未探测到的条目记 unknown+pending（保证报告条目与 registry 对齐；续跑自动重试）
  for (const r of todo) {
    if (!results[r.full_name]) results[r.full_name] = { full_name: r.full_name, verdict: "unknown", pending: true };
  }
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

// 直接运行才执行 main（被测试 import 时只暴露纯函数，无副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`失败：${e.message}`); process.exit(1); });
}
