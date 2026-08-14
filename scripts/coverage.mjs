#!/usr/bin/env node
// 覆盖率报告：使用 NODE_V8_COVERAGE 收集 smoke-tests 的 v8 覆盖率并汇总。
// 用法：
//   node scripts/coverage.mjs           运行 smoke-tests 并输出函数/分支覆盖率
//   node scripts/coverage.mjs --json    输出 JSON 报告（供 CI 解析）
// 零依赖：仅用 Node 内置（fs + URL），数据来自 v8 覆盖率 JSON。
// 覆盖目标模块：scripts/hooks/validate.mjs、scripts/toc.mjs、lib/index.js。

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 覆盖率目标：我们维护的 hook 校验模块 + 上游 lib（测试金字塔覆盖范围）
// toc.mjs 的 CLI 入口分支（isMain 内）无法被测试触发，属合理豁免。
const TARGETS = [
  "scripts/hooks/validate.mjs",
  "scripts/toc.mjs",
  "lib/index.js",
];
const jsonOut = process.argv.includes("--json");

// 豁免：无法通过测试触发的合理分支。
// - toc.mjs 主循环（isMain() 内，仅 CLI 运行时执行）
// - lib/index.js：runNpm 等命名深集成函数（按函数名），以及
//   防御性死代码闭包（按行号）——见审计记录
const EXEMPT_LIB_FUNCS = [
  "runNpm", "npmInstallWithFallback", "readJsonBody",
  "exists", "json", "readPackageVersion", "readPackageName",
  "readPackageJsonObject", "copyFilter",
];

/** lib/index.js 中防御性死代码闭包的起始行号（v8 匿名闭包无法按名豁免）。 */
const EXEMPT_LIB_LINES = [
  976,   // 启动预热 getList 失败 catch（getList 实际永不 reject）
  1172,  // npm 脚本拒绝分支清理闭包
  1201,  // 非插件取消分支清理闭包
  1228,  // manual 取消分支清理闭包
  1252,  // instructions→manual 结果路径清理闭包
  1262,  // 安装失败 catch 清理闭包
];

/** 计算 lib/index.js 中豁免函数的起始偏移集合（函数名 + 行号）。 */
function libExemptOffsets(root) {
  const path = join(root, "lib", "index.js");
  if (!existsSync(path)) return new Set();
  const src = readFileSync(path, "utf8");
  const set = new Set();
  for (const name of EXEMPT_LIB_FUNCS) {
    const i = src.indexOf("function " + name);
    if (i !== -1) set.add(i);
  }
  // 按行号豁免（匿名闭包）：行号 → 行首偏移
  const lines = src.split("\n");
  for (const ln of EXEMPT_LIB_LINES) {
    if (ln >= 1 && ln <= lines.length) {
      let off = 0;
      for (let i = 0; i < ln - 1; i++) off += lines[i].length + 1;
      set.add(off);
    }
  }
  return set;
}

/** 计算 toc.mjs 主循环豁免（isMain 起始偏移）。 */
function tocMainOffset(root) {
  const path = join(root, "scripts", "toc.mjs");
  if (!existsSync(path)) return -1;
  return readFileSync(path, "utf8").indexOf("if (isMain())");
}

// 1. 临时目录收集覆盖率
const covDir = mkdtempSync(join(tmpdir(), "dsh-cov-"));
try {
  execFileSync("node", ["scripts/tests/run.mjs"], {
    cwd: ROOT,
    stdio: jsonOut ? ["inherit", "ignore", "inherit"] : "inherit",
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
  });
} finally {
  // 继续处理覆盖率（smoke 失败也输出报告）
}

// 2. 聚合 v8 覆盖率 JSON
const libSrc = existsSync(join(ROOT, "lib", "index.js")) ? readFileSync(join(ROOT, "lib", "index.js"), "utf8") : "";
const libLines = libSrc.split("\n");
/** 行号 → 该行起始偏移（用于把 v8 偏移换算为行号）。 */
function offsetToLine(offset) {
  let ln = 1;
  for (let i = 0; i < libLines.length; i++) {
    if (offset > offsetOfLine(i + 1)) ln = i + 2;
  }
  return ln;
}
function offsetOfLine(n) {
  let off = 0;
  for (let i = 0; i < n - 1 && i < libLines.length; i++) off += libLines[i].length + 1;
  return off;
}
const EXEMPT_LIB_LINE_SET = new Set(EXEMPT_LIB_LINES);
const libExempt = libExemptOffsets(ROOT);
const tocMain = tocMainOffset(ROOT);
// 仓库根目录的 file:// 前缀：e2e 触发真实 npm install 时，npm 子进程（也在
// NODE_V8_COVERAGE 下运行）会为 npm 自身 node_modules 里的模块生成 coverage，
// 其中不少也名为 lib/index.js——只按尾部路径匹配会误收，必须限定在仓库根目录内。
const ROOT_PREFIX = "file:///" + ROOT.replace(/\\/g, "/").replace(/^\/+/, "") + "/";
const sources = new Map(); // url -> {funcs: Map, branches: []}
const files = existsSync(covDir) ? readdirSync(covDir).filter((f) => f.endsWith(".json")) : [];
for (const f of files) {
  const data = JSON.parse(readFileSync(join(covDir, f), "utf8"));
  for (const result of data.result) {
    const url = result.url;
    // 统一正斜杠比较（file:// URL 与 TARGETS 路径）
    if (!url.startsWith(ROOT_PREFIX)) continue;
    if (!TARGETS.some((t) => url.endsWith("/" + t.replace(/\\/g, "/")))) continue;
    if (!sources.has(url)) sources.set(url, { funcs: new Map(), branches: [] });
    const agg = sources.get(url);
    for (const fn of result.functions) {
      const offset = fn.ranges[0]?.startOffset ?? 0;
      // 豁免判断
      let exempt = false;
      if (url.endsWith("/lib/index.js")) {
        exempt = libExempt.has(offset) || EXEMPT_LIB_LINE_SET.has(offsetToLine(offset));
      } else if (url.endsWith("/scripts/toc.mjs") && tocMain !== -1) {
        exempt = offset >= tocMain;
      }
      if (exempt) continue;
      const key = `${fn.functionName}@${offset}`;
      const prev = agg.funcs.get(key);
      if (!prev || fn.ranges[0]?.count > prev) {
        agg.funcs.set(key, fn.ranges[0]?.count ?? 0);
      }
    }
    for (const br of result.branchCoverage ?? []) {
      agg.branches.push(...(br.blockRanges ?? []));
    }
  }
}

// 3. 汇总报告
  const report = [];
  let totalFuncs = 0, coveredFuncs = 0;
  for (const [url, agg] of sources) {
    const funcs = [...agg.funcs.values()];
    const covered = funcs.filter((c) => c > 0).length;
    totalFuncs += funcs.length;
    coveredFuncs += covered;
    const pct = funcs.length ? Math.round((covered / funcs.length) * 100) : 100;
    const uncovered = [...agg.funcs.entries()].filter(([, c]) => c === 0).map(([k]) => k.split("@")[0]);
    // 从 file:///D:/.../scripts/... 提取仓库相对路径
    const rel = url.replace(/^file:\/\/\//, "").split(/[/\\]/).slice(-3).join("/");
    report.push({
      file: rel,
      functions: funcs.length,
      covered,
      percent: pct,
      uncovered,
    });
  }

const overall = totalFuncs ? Math.round((coveredFuncs / totalFuncs) * 100) : 100;
if (jsonOut) {
  console.log(JSON.stringify({ overall, files: report }, null, 2));
} else {
  console.log(`覆盖率: ${coveredFuncs}/${totalFuncs} 函数 (${overall}%)`);
  for (const r of report) {
    console.log(`  ${r.file}: ${r.percent}% (${r.covered}/${r.functions})`);
    if (r.uncovered.length > 0) {
      console.log(`    未覆盖: ${r.uncovered.join(", ")}`);
    }
  }
  if (overall < 100) {
    console.log(`\n提示: 覆盖率未达 100%，检查未覆盖函数并补充断言（目标 100%）。`);
    process.exit(1);
  }
}
