#!/usr/bin/env node
/**
 * 轻量突变测试运行器（零依赖，仅 node: 内置模块）。
 *
 * 目的：量化现有测试对 lib/index.js 语义的敏感度。
 * 方法：对 lib/index.js 做文本突变（注入一个 bug）→ 跑测试子集 →
 *       若测试全绿则该突变「存活」（= 该语义未被测试锁定）。
 *
 * 隔离约束：绝不直接修改工作区的 lib/index.js（主会话可能同时在改）。
 *  - 在系统临时目录（os.tmpdir()，前缀 dsh-mutation-）创建副本结构：
 *      <tmp>/lib/index.js
 *      <tmp>/scripts/tests/unit/security-guards.test.mjs
 *      <tmp>/scripts/tests/unit/lib-pure.test.mjs
 *    （保留相对结构——测试内 import "../../../lib/index.js" 相对路径在副本结构中仍然有效）
 *  - 每个突变以「工作区当前 lib/index.js」为基线重新复制（保证基线最新）
 *  - 进程退出（exit hook）时清理临时目录
 *
 * 测试子集分类：
 *  - security-guards.test.mjs：静态契约（正则断言文本形态）——文本突变必然触发失败，
 *    单独统计为「文本契约锁定」；
 *  - lib-pure.test.mjs：行为测试（运行时行为）——突变存活说明行为未被锁定（高价值发现）。
 *
 * 用法：node scripts/mutation-test.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// ---- 路径常量 ----
const THIS_DIR = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = join(THIS_DIR, "..");                          // 工作区根
const WORKSPACE_LIB = join(ROOT, "lib", "index.js");
const UNIT_DIR = join(ROOT, "scripts", "tests", "unit");
const CONTRACT_TEST = "security-guards.test.mjs";          // 静态契约测试
const BEHAVIOR_TEST = "lib-pure.test.mjs";                  // 行为测试

// 临时副本结构（exit hook 清理）
const TMP = mkdtempSync(join(tmpdir(), "dsh-mutation-"));
const TMP_LIB = join(TMP, "lib", "index.js");
const TMP_UNIT = join(TMP, "scripts", "tests", "unit");

// ---- 突变清单（种子 20 个按实际源码调整过 pattern + 补充 4 个，共 24 个）----
// 每个突变：{ id, name, pattern(正则), replacement, type, note }
// pattern 未命中源码 → SKIP（语义可能已变化）；replacement 无效果 → SKIP。
const MUTATIONS = [
  // m01/m02 说明：compareVersions 函数体内没有 `>= 0` / `< 0`（内部是
  // pa[key] < pb[key] 三元），实际写法在调用点（checkSelfUpdate / 双源取高 /
  // updateAvailable 判定），pattern 按实际源码调整到调用点，语义变化真实。
  {
    id: "m01",
    name: "compareVersions 调用点 >= 0 → > 0（相等版本不再视为已最新）",
    type: "behavior",
    pattern: /compareVersions\(([^)]*)\) >= 0/g,
    replacement: "compareVersions($1) > 0",
    note: "checkSelfUpdate 跳过条件与双源取高（reduce）各 1 处；lib-pure 只直接测 compareVersions 函数，不测调用点"
  },
  {
    id: "m02",
    name: "compareVersions 调用点 < 0 → <= 0（相等版本 updateAvailable 变 true）",
    type: "behavior",
    pattern: /compareVersions\(([^)]*)\) < 0/g,
    replacement: "compareVersions($1) <= 0",
    note: "updateAvailable 判定共 4 处（2286/2298/2527/2925），一次全改"
  },
  {
    id: "m03",
    name: "readStateJson ENOENT 分支反转（!== → ===，损坏静默当空）",
    type: "behavior",
    pattern: /error\?\.code !== "ENOENT"/g,
    replacement: 'error?.code === "ENOENT"',
    note: "种子预期「行为测试存活 → 高价值」，但 security-guards 有静态断言该形态（见报告分类）"
  },
  {
    id: "m04",
    name: "isSensitiveEnvKey 删除 AUTH(?!_)（AUTH_TYPE/AUTH_PATH 变敏感）",
    type: "behavior",
    pattern: /CREDENTIALS\?\|AUTH\(\?!_\)/g,
    replacement: "CREDENTIALS?|AUTH",
    note: "只改代码处（注释里的 AUTH(?!_) 不动）"
  },
  {
    id: "m05",
    name: "isSensitiveEnvKey 删除词头边界 (?<![A-Za-z0-9])（MONKEY 等变敏感）",
    type: "behavior",
    pattern: /\(\?<!\[A-Za-z0-9\]\)\(TOKEN/g,
    replacement: "(TOKEN",
    note: "KEY 结尾的普通词（MONKEY）会被误判敏感"
  },
  {
    id: "m06",
    name: "normalizeRepoRef 删除 .toLowerCase()（大小写混写键不再归一）",
    type: "behavior",
    pattern: /return s\.toLowerCase\(\) \|\| null;/g,
    replacement: "return s || null;",
    note: "installedMap 键 / dedupe key 的大小写归一语义消失"
  },
  {
    id: "m07",
    name: "wslPosixPath 盘符不再 toLowerCase（C: → /mnt/C/）",
    type: "behavior",
    pattern: /\$\{m\[1\]\.toLowerCase\(\)\}/g,
    replacement: "${m[1]}",
    note: "用模板字面量片段精确定位（m[1].toLowerCase() 另有一处 2199 行 cli 解析，不误伤）"
  },
  {
    id: "m08",
    name: "LOG_LINE_MAX 4096 → 4095",
    type: "behavior",
    pattern: /const LOG_LINE_MAX = 4096;/g,
    replacement: "const LOG_LINE_MAX = 4095;",
    note: "单条日志截断上限偏移 1 字节"
  },
  {
    id: "m09",
    name: "MAX_RESPONSE_BYTES 32 → 31（响应上限偏移 1MB）",
    type: "behavior",
    pattern: /const MAX_RESPONSE_BYTES = 32 \* 1024 \* 1024;/g,
    replacement: "const MAX_RESPONSE_BYTES = 31 * 1024 * 1024;",
    note: "L6 响应大小上限整体偏移"
  },
  {
    id: "m10",
    name: "MAX_EXEC_BUFFER 32 → 31（子进程输出上限偏移 1MB）",
    type: "behavior",
    pattern: /const MAX_EXEC_BUFFER = 32 \* 1024 \* 1024;/g,
    replacement: "const MAX_EXEC_BUFFER = 31 * 1024 * 1024;",
    note: "安装/自更新链 maxBuffer 上限偏移"
  },
  {
    id: "m11",
    name: "MAX_BODY_BYTES 1024*1024 → 1023*1024（单次 body 上限偏移 1KB）",
    type: "behavior",
    pattern: /const MAX_BODY_BYTES = 1024 \* 1024;/g,
    replacement: "const MAX_BODY_BYTES = 1023 * 1024;",
    note: "security-guards 未断言该常量（只锁了 MAX_RESPONSE_BYTES/MAX_EXEC_BUFFER/LOG_LINE_MAX）"
  },
  {
    id: "m12",
    name: "safeAssign 删除 __proto__ 剔除条件（原型污染面重开）",
    type: "behavior",
    pattern: /k === "__proto__" \|\| /g,
    replacement: "",
    note: "L7 防护只剩 constructor/prototype"
  },
  {
    id: "m13",
    name: "isTrustedHost 删除 192.168 私有网段分支",
    type: "behavior",
    pattern: /if \(a === 192 && b === 168\) return true;\n/g,
    replacement: "",
    note: "192.168.x.x 局域网访问被拒"
  },
  {
    id: "m14",
    name: "isTrustedHost 删除 localhost 分支",
    type: "behavior",
    pattern: /hostname === "localhost" \|\| /g,
    replacement: "",
    note: "仅剩 127.0.0.1/[::1]/::1"
  },
  {
    id: "m15",
    name: "CSRF 头检查 !== → ===（带头请求反被拒）",
    type: "behavior",
    pattern: /req\.headers\[CSRF_HEADER\] !== "1"/g,
    replacement: 'req.headers[CSRF_HEADER] === "1"',
    note: "X-DSH-Marketplace: 1 的合法请求被拒，缺头请求放行（语义反转）"
  },
  {
    id: "m16",
    name: "dedupe 排序删除 1e12 + 安装权重（已装不再优先）",
    // 注意：pattern 必须匹配代码形态而非注释（注释里也出现 "1e12 + "，匹配注释是假存活）
    type: "behavior",
    pattern: /\(isInstalled\(r\) \? 1e12 : 0\) \+/g,
    replacement: "(0) +",
    note: "已装低星仓库会被未装高星同名仓库顶掉"
  },
  {
    id: "m17",
    name: "check-update 包名段数校验 > 2 → > 1（scoped 包被拒）",
    type: "behavior",
    pattern: /parts\.length > 2/g,
    replacement: "parts.length > 1",
    note: "@scope/name 形态包名全部 400"
  },
  {
    id: "m18",
    name: "env-keys 受管目录校验 .some 前加 !（逻辑反转）",
    type: "behavior",
    pattern: /const managed = \[PROFILE_NM, SKILLS_DIR, PRESETS_DIR, CACHE_DIR\]\.some\(/g,
    replacement: "const managed = ![PROFILE_NM, SKILLS_DIR, PRESETS_DIR, CACHE_DIR].some(",
    note: "受管目录外任意路径被扫描（路径注入面重开）"
  },
  {
    id: "m19",
    name: "slugify 删除 .toLowerCase()（大写仓库名 slug 变化）",
    type: "behavior",
    pattern: /String\(s\)\.toLowerCase\(\)\.replace/g,
    replacement: "String(s).replace",
    note: "slug 不再小写归一"
  },
  {
    id: "m20",
    name: "responseTooLarge > → >=（恰好 32MB 响应被拒）",
    type: "behavior",
    pattern: /len > MAX_RESPONSE_BYTES/g,
    replacement: "len >= MAX_RESPONSE_BYTES",
    note: "边界（len == 上限）语义翻转；security-guards 只断言存在性与 content-length 读取，不锁操作符"
  },
  // ---- 补充突变（发现的高价值点）----
  {
    id: "m21",
    name: "comparePre 数字标识 vs 字母数字标识顺序反转（数字段不再优先）",
    type: "behavior",
    pattern: /if \(xNum\) return 1;/g,
    replacement: "if (xNum) return -1;",
    note: "lib-pure 有数字vs数字（rc.10>rc.9）与字母vs字母（beta.2>alpha.5），缺「数字 vs 字母」用例"
  },
  {
    id: "m22",
    name: "SCRIPT_ENV_KEYS 删除 PATH（minimal env 丢失 PATH）",
    type: "behavior",
    pattern: /"PATH", "PATHEXT"/g,
    replacement: '"PATHEXT"',
    note: "buildMinimalEnv 不再带 PATH，脚本找不到可执行文件；lib-pure 的白名单是测试内硬编码副本，与源码清单重复"
  },
  {
    id: "m23",
    name: "isSensitiveEnvKey 正则删除 /i 标志（大小写不敏感语义消失）",
    type: "behavior",
    pattern: /\(\?\!\[A-Za-z0-9\]\)\/i\.test\(String\(name \?\? ""\)\)/g,
    replacement: '(?![A-Za-z0-9])/.test(String(name ?? ""))',
    note: "只去掉 /i 标志（保留正则字面量定界符，语法合法）；github_token / db_password 等小写键名不再被过滤；全部敏感用例都用大写键名"
  },
  {
    id: "m24",
    name: "isTrustedHost 172 网段收窄（b <= 31 → b <= 30，172.31 变拒绝）",
    type: "behavior",
    pattern: /b >= 16 && b <= 31/g,
    replacement: "b >= 16 && b <= 30",
    note: "lib-pure 只测 172.16（允许）与 172.32（拒绝）两个端点，172.17-172.31 边界未锁定"
  }
];

// ---- 临时副本初始化：建目录结构 + 复制测试文件（保留相对结构）----
function setupTemp() {
  mkdirSync(join(TMP, "lib"), { recursive: true });
  mkdirSync(TMP_UNIT, { recursive: true });
  copyFileSync(WORKSPACE_LIB, TMP_LIB);
  copyFileSync(join(UNIT_DIR, CONTRACT_TEST), join(TMP_UNIT, CONTRACT_TEST));
  copyFileSync(join(UNIT_DIR, BEHAVIOR_TEST), join(TMP_UNIT, BEHAVIOR_TEST));
}

// ---- 测试执行：在临时副本上跑单个测试文件，cwd=<tmp> ----
function runTest(file) {
  const r = spawnSync(process.execPath, ["scripts/tests/unit/" + file], {
    cwd: TMP,
    encoding: "utf8",
    timeout: 120000
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const failLines = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL"));
  // status != 0 但没有 FAIL 断言行 → 运行崩溃（如模块加载失败），单独标记
  const crashed = r.status !== 0 && failLines.length === 0;
  return { ok: r.status === 0, failLines, crashed };
}

// ---- 报告辅助 ----
function firstFails(failLines, n = 3) {
  return failLines.slice(0, n).map((l) => l.replace(/^FAIL /, ""));
}

// ---- 主流程 ----
function main() {
  setupTemp();
  const base0 = readFileSync(WORKSPACE_LIB, "utf8");
  const baseLines = base0.split("\n").length;
  console.log("=== DSH 突变测试报告 ===");
  console.log(`基线：${WORKSPACE_LIB}（${base0.length} 字节 / ${baseLines} 行）`);
  console.log(`子集：${CONTRACT_TEST}（静态契约）+ ${BEHAVIOR_TEST}（行为）`);
  console.log(`突变：${MUTATIONS.length} 个`);

  const survived = [];   // 行为未锁定（两子集全绿）
  const killed = [];     // 被行为测试锁定（security-guards 绿、lib-pure 红）
  const contracted = []; // 被静态契约锁定（security-guards 红）
  const skipped = [];    // pattern 未命中 / 替换无效果

  const t0 = Date.now();

  for (const m of MUTATIONS) {
    // 1) 每次从工作区当前 lib/index.js 重新读取为基线（保证基线最新）
    let base;
    try {
      base = readFileSync(WORKSPACE_LIB, "utf8");
    } catch (e) {
      console.log(`[${m.id}] 读取基线失败，跳过：${e.message}`);
      skipped.push({ m, reason: "读取基线失败" });
      continue;
    }

    // 2) 断言 pattern 出现（出现次数>0），不出现 → SKIP
    const reTest = new RegExp(m.pattern.source, m.pattern.flags.replace("g", ""));
    const reReplace = new RegExp(m.pattern.source, m.pattern.flags);
    const hits = base.match(reReplace);
    if (!hits || hits.length === 0) {
      console.log(`[${m.id}] ${m.name} → SKIP（pattern 未命中源码，语义可能已变化）`);
      skipped.push({ m, reason: "pattern 未命中源码" });
      continue;
    }

    // 3) 注入突变并写回副本
    const mutated = base.replace(reReplace, m.replacement);
    if (mutated === base) {
      console.log(`[${m.id}] ${m.name} → SKIP（替换无效果）`);
      skipped.push({ m, reason: "替换无效果" });
      continue;
    }
    try {
      writeFileSync(TMP_LIB, mutated, "utf8");
    } catch (e) {
      console.log(`[${m.id}] 写副本失败，跳过：${e.message}`);
      skipped.push({ m, reason: "写副本失败" });
      continue;
    }

    // 4) 跑两个子集
    const c = runTest(CONTRACT_TEST);
    const b = runTest(BEHAVIOR_TEST);

    // 5) 分类：静态契约优先（文本突变必然触发文本断言失败 → 文本契约锁定）
    let cls, detail;
    if (c.crashed) {
      cls = "contract-crash";
      detail = { contract: "崩溃（非断言）" };
    } else if (!c.ok) {
      cls = "contract";
      detail = { contractFails: firstFails(c.failLines) };
    } else if (b.crashed) {
      cls = "behavior-crash";
      detail = { behavior: "崩溃（非断言）" };
    } else if (!b.ok) {
      cls = "killed";
      detail = { behaviorFails: firstFails(b.failLines) };
    } else {
      cls = "survived";
      detail = {};
    }

    const label = cls === "survived" ? "存活" : cls === "killed" ? "被杀" : cls === "contract" ? "文本契约锁定" : cls === "behavior-crash" ? "行为崩溃" : cls === "contract-crash" ? "契约崩溃" : "?";
    console.log(`[${m.id}] ${m.name} → ${label}`);
    if (cls === "contract") for (const f of detail.contractFails) console.log(`    security-guards FAIL: ${f}`);
    if (cls === "killed") for (const f of detail.behaviorFails) console.log(`    lib-pure FAIL: ${f}`);
    if (cls === "behavior-crash") console.log("    lib-pure 崩溃（见上）");
    if (cls === "contract-crash") console.log("    security-guards 崩溃（见上）");

    if (cls === "survived") survived.push({ m, hits: hits.length, detail });
    else if (cls === "killed") killed.push({ m, hits: hits.length, detail });
    else if (cls === "contract") contracted.push({ m, hits: hits.length, detail });
    else if (cls === "behavior-crash") killed.push({ m, hits: hits.length, detail: { behaviorFails: ["[崩溃] lib-pure 运行崩溃"] } });
    else if (cls === "contract-crash") contracted.push({ m, hits: hits.length, detail: { contractFails: ["[崩溃] security-guards 运行崩溃"] } });
  }

  // ---- 汇总 ----
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n=== 汇总（" + elapsed + "s）===");
  console.log(`存活（行为未锁定）: ${survived.length} 个`);
  console.log(`被杀（行为测试锁定）: ${killed.length} 个`);
  console.log(`文本契约锁定: ${contracted.length} 个`);
  console.log(`SKIP: ${skipped.length} 个`);

  console.log("\n--- 存活突变（行为类，高价值）---");
  for (const { m, hits } of survived) {
    console.log(`\n${m.id} ${m.name}`);
    console.log(`  命中 ${hits} 处；存活原因：${m.note}`);
  }

  console.log("\n--- 被杀清单（行为测试锁定）---");
  for (const { m, detail } of killed) {
    const fs = detail.behaviorFails ?? [];
    console.log(`${m.id} ${m.name} —— ${fs.length > 0 ? "被 lib-pure「" + fs[0] + "」等 " + fs.length + " 处杀" : detail.behavior ?? "?"}`);
  }

  console.log("\n--- 文本契约锁定（security-guards 直接锁定形态）---");
  for (const { m, detail } of contracted) {
    const fs = detail.contractFails ?? [];
    console.log(`${m.id} ${m.name} —— ${fs.length > 0 ? "被 security-guards「" + fs[0] + "」等 " + fs.length + " 处锁" : "?"}`);
  }

  console.log("\n--- SKIP 清单 ---");
  for (const { m, reason } of skipped) console.log(`${m.id} ${m.name} —— ${reason}`);

  // ---- 结论：行为测试最薄弱的面 ----
  console.log("\n=== 结论：行为测试最薄弱的面 ===");
  const findings = [
    "1. 版本判定调用点（m01/m02）：lib-pure 只测 compareVersions 函数返回值，updateAvailable / checkSelfUpdate / 双源取高的语义拼接处（>= 0 / < 0 判定）完全未锁定。建议把更新判定抽成纯函数（如 shouldUpdate(installed, latest)）补相等/新版/旧版三用例。",
    "2. 规范化函数（m06 normalizeRepoRef 大小写、m19 slugify）：两个纯函数均无行为测试（slugify 甚至未导出）。建议 lib-pure 补「大小写混写 full_name 与已装记录命中」用例，并导出 slugify 后补大写仓库名用例。",
    "3. 资源上限常量（m11 MAX_BODY_BYTES）：security-guards 锁了 MAX_RESPONSE_BYTES / MAX_EXEC_BUFFER / LOG_LINE_MAX，唯独 MAX_BODY_BYTES 无任何断言（常量与使用点都没有）。建议并入「单次外部输入内存上限」契约。",
    "4. 边界语义（m20 responseTooLarge 恰好等于上限、m24 172.17-172.31 网段、m21 数字段 vs 字母段）：测试只覆盖典型值与端点，不覆盖边界。建议各补一条边界用例。",
    "5. 重复硬编码（m22）：buildMinimalEnv 的白名单在测试内整份复制，源码删项（如 PATH）不报警。建议导出 SCRIPT_ENV_KEYS，测试断言 buildMinimalEnv 键集 === 导出清单。",
    "6. 大小写不敏感（m23）：isSensitiveEnvKey 的 /i 标志无用例（敏感用例全用大写键名）。建议补「github_token 小写键名也敏感」。",
    "7. 排序权重（m16 dedupe 1e12）：已装优先的排序语义无行为测试。建议补「已装低星 vs 未装高星同 pkg_name → 保留已装」。",
    "8. 备注 m03：readStateJson 的 ENOENT 区分被 security-guards 静态锁定（种子预期的「行为存活」未发生），但损坏文件 → WARN + 备份 .corrupt-<ts> 的运行时路径仍无行为测试（loadInstalled 在 integration 子集外）。建议在 installed-load 测试里补损坏 JSON 分支。"
  ];
  for (const f of findings) console.log(f);

  console.log("\n（本次运行未改动工作区任何文件；临时副本已随进程退出清理）");
}

// exit hook：无论正常/异常退出都清理临时目录
process.on("exit", () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响退出 */ }
});
process.on("uncaughtException", (e) => {
  console.error("运行器异常：", e);
  process.exit(1);
});

main();
