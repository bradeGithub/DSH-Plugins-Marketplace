#!/usr/bin/env node
// 零依赖性能基准：测量 marketplace 纯函数在确定性合成数据下的 CPU 趋势。
// 只输出 JSON（样本规模、warmup、迭代次数、median/p95、node/platform/git revision），
// 不在功能测试中加入机器相关的绝对耗时阈值；CI 只上传趋势 artifact，不直接阻断。
//
// 用法：
//   node scripts/benchmarks/marketplace.mjs [--json=out.json] [--iterations=200]
// 默认把 JSON 打到 stdout；--json 额外写文件。

import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeReposByPkgName } from "../../lib/domain/list.js";
import { buildInstalledIndex, profileHit } from "../../lib/domain/installed-index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : fallback;
};
const iterations = Number(arg("iterations", "200"));
const jsonOut = arg("json", null);

// 确定性 PRNG（mulberry32）——合成数据可复现，不依赖 Math.random。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRepos(count, seed) {
  const rand = mulberry32(seed);
  const repos = [];
  for (let i = 0; i < count; i++) {
    const owner = `owner-${Math.floor(rand() * 200)}`;
    const name = `repo-${i}`;
    repos.push({
      full_name: `${owner}/${name}`,
      name,
      stargazers_count: Math.floor(rand() * 5000),
      pkg_name: rand() > 0.3 ? `pkg-${Math.floor(rand() * (count / 2))}` : null,
      installed: rand() > 0.8
    });
  }
  return repos;
}

function makeProfile(count, seed) {
  const rand = mulberry32(seed);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const name = `pkg-${i}`;
    entries.set(name, {
      name,
      repository: `owner-${Math.floor(rand() * 200)}/repo-${i}`,
      version: "1.0.0"
    });
  }
  return entries;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function bench(fn, iterations) {
  // warmup：让 JIT 稳定后再计时
  for (let i = 0; i < 20; i++) fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return { median: median(samples), p95: p95(samples), samples: samples.length };
}

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const SIZES = [1000, 5000, 20000];
const results = {};

for (const size of SIZES) {
  const repos = makeRepos(size, 0x5eed + size);
  results[`dedupe_${size}`] = bench(() => dedupeReposByPkgName(repos, (r) => r.installed === true), iterations);
  results[`fingerprint_${size}`] = bench(() => {
    let h = 2166136261;
    for (const r of repos) {
      const s = String(r?.full_name ?? "");
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      h ^= 0x3b;
      h ^= r?.installed === true ? 0x5f : 0;
    }
    return `${h >>> 0}-${repos.length}`;
  }, iterations);
}

for (const size of SIZES) {
  const profile = makeProfile(size, 0xbeef + size);
  const index = buildInstalledIndex({
    profile,
    installedEntries: [],
    managedDirs: [],
    managedRoots: [],
    cacheEntries: { scripts: [], packageNames: [] },
    official: new Set(),
    ownRepo: null
  });
  const probe = { full_name: `owner-1/repo-${size - 1}` };
  results[`index_build_${size}`] = bench(() => buildInstalledIndex({
    profile,
    installedEntries: [],
    managedDirs: [],
    managedRoots: [],
    cacheEntries: { scripts: [], packageNames: [] },
    official: new Set(),
    ownRepo: null
  }), iterations);
  results[`profile_hit_${size}`] = bench(() => profileHit(index, probe, [`pkg-${size - 1}`]), iterations);
}

const report = {
  benchmark: "marketplace-pure-functions",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  git_revision: gitRevision(),
  iterations,
  results
};

const text = JSON.stringify(report, null, 2);
console.log(text);
if (jsonOut) writeFileSync(jsonOut, text + "\n", "utf8");
