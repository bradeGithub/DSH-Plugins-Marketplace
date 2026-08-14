#!/usr/bin/env node
// Git Hook 共享检查脚本：按需调用单个或多个检查项。
// 用法：
//   node scripts/hooks/check.mjs                      # 全量（pre-commit 全部检查）
//   node scripts/hooks/check.mjs --stage=pre-commit   # 提交前（syntax+tests+toc+secret）
//   node scripts/hooks/check.mjs --stage=commit-msg   # 提交信息校验
//   node scripts/hooks/check.mjs --only=syntax        # 仅语法检查
//   node scripts/hooks/check.mjs --only=secret        # 仅密钥扫描
//   node scripts/hooks/check.mjs --only=toc           # 仅 TOC 检测
//   node scripts/hooks/check.mjs --only=tests         # 仅 smoke-tests
//   node scripts/hooks/check.mjs --help               # 用法说明
// 纯校验逻辑在 validate.mjs（可被 smoke-tests 覆盖），本文件只做编排。

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNTAX_CHECK_FILES, validateSubject, extractSubject, parseHookConfig, DEFAULT_HOOK_CONFIG, detectSecret } from "./validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = `用法:
  node scripts/hooks/check.mjs [选项]

选项:
  --stage=<pre-commit|commit-msg>  运行某个 git 阶段的检查集（默认 pre-commit）
  --only=<name>                    仅运行单项检查（syntax|tests|toc|secret|commit-msg|coverage）
  --help                           显示本帮助

示例:
  node scripts/hooks/check.mjs --only=secret    # 只扫密钥
  node scripts/hooks/check.mjs --stage=commit-msg "msgfile"`;

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : undefined;
};

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const stage = arg("stage") ?? "pre-commit";
const only = arg("only");
const validOnly = ["syntax", "tests", "toc", "secret", "commit-msg", "coverage"];
if (only && !validOnly.includes(only)) {
  console.error(`[FAIL] 未知 --only 值 "${only}"，可选: ${validOnly.join(" | ")}`);
  process.exit(1);
}
const want = (name) => !only || only === name;

/** 读取仓库 .hooksrc 配置（不存在则返回默认）。 */
function loadHookConfig(root) {
  const p = join(root, ".hooksrc");
  if (!existsSync(p)) return { ...DEFAULT_HOOK_CONFIG };
  try {
    return parseHookConfig(readFileSync(p, "utf8"));
  } catch {
    return { ...DEFAULT_HOOK_CONFIG };
  }
}

let failed = false;
const fail = (label, msg) => {
  console.error(`[FAIL] [${label}] ${msg}`);
  failed = true;
};

// ---- 1. 语法检查（与 CI 的 node --check 同步）----
function checkSyntax() {
  if (!want("syntax")) return;
  for (const f of SYNTAX_CHECK_FILES) {
    if (existsSync(join(ROOT, f))) {
      try {
        execFileSync("node", ["--check", f], { cwd: ROOT, stdio: "pipe" });
        console.log(`[OK] [syntax] ${f}`);
      } catch {
        fail("syntax", `${f} 语法错误`);
      }
    }
  }
}

// ---- 2. 测试金字塔（unit → integration → e2e）----
function checkTests() {
  if (!want("tests")) return;
  try {
    // 常规提交只跑 unit+integration（快，<1s）；e2e（真实 npm 安装 ~23s）由 CI/--only=tests 全量执行
    execFileSync("node", ["scripts/tests/run.mjs", "--level=unit,integration"], { cwd: ROOT, stdio: "inherit" });
    console.log("[OK] [tests] unit+integration 全部通过");
  } catch {
    fail("tests", "unit+integration 存在失败项");
  }
}

// ---- 3. TOC 检测 ----
function checkToc() {
  if (!want("toc")) return;
  try {
    const tocCfg = loadHookConfig(ROOT);
    const args = ["scripts/toc.mjs", "--check"];
    if ((tocCfg.tocExclude ?? []).length > 0) {
      args.push("--exclude=" + tocCfg.tocExclude.join(","));
    }
    execFileSync("node", args, { cwd: ROOT, stdio: "inherit" });
    console.log("[OK] [toc] 文档 TOC 有效");
  } catch {
    fail("toc", "文档 TOC 缺失或过期，请运行 node scripts/toc.mjs 重新生成");
  }
}

// ---- 4. 敏感密钥扫描（暂存文件）----
function checkSecret() {
  if (!want("secret")) return;
  const cfg = loadHookConfig(ROOT);
  if (cfg.secretLevel === "off") return;
  try {
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: ROOT, encoding: "utf8" });
    const files = staged.split("\n").map((s) => s.trim()).filter(Boolean);
    let found = 0;
    for (const f of files) {
      if (cfg.secretExclusions.some((ex) => f.includes(ex))) continue;
      if (!existsSync(join(ROOT, f))) continue;
      let content;
      try {
        content = readFileSync(join(ROOT, f), "utf8");
      } catch {
        continue; // 二进制/编码异常跳过
      }
      const r = detectSecret(content);
      if (r.found) {
        found++;
        console.error(`[FAIL] [secret] ${f}: 疑似密钥 ${r.samples.join(", ")}`);
      }
    }
    if (found > 0) {
      if (cfg.secretLevel === "error") {
        fail("secret", `${found} 个文件疑似包含密钥，禁止提交（可用 .hooksrc secretExclusions 排除，或确认后移除）`);
      } else {
        console.warn(`[WARN] [secret] ${found} 个文件疑似包含密钥（warn 等级，不阻断）`);
      }
    } else {
      console.log("[OK] [secret] 未发现疑似密钥");
    }
  } catch (e) {
    fail("secret", `密钥扫描失败: ${e.message}`);
  }
}

// ---- 5. 提交信息规范 ----
function checkCommitMsg() {
  if (!want("commit-msg")) return;
  const msgPath = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(ROOT, ".git", "COMMIT_EDITMSG");
  if (!existsSync(msgPath)) {
    fail("commit-msg", `未找到提交信息文件: ${msgPath}`);
  } else {
    const subject = extractSubject(readFileSync(msgPath, "utf8"));
    const level = loadHookConfig(ROOT).emojiLevel ?? "error";
    const r = validateSubject(subject, { emojiLevel: level });
    if (r.ok) {
      console.log(`[OK] [commit-msg] ${subject}`);
      for (const w of r.warnings ?? []) {
        console.warn(`[WARN] [commit-msg] ${w}（warn 等级，不阻断）`);
      }
    } else {
      fail("commit-msg", r.reason);
    }
  }
}

// ---- 6. 覆盖率检查（hook 校验逻辑 100% 覆盖；含 e2e 全量，耗时 ~25s）----
// 常规提交不执行（见 pre-commit 分组）；CI/PR 前用 `--only=coverage` 手动或自动执行。
function checkCoverage() {
  if (!want("coverage")) return;
  try {
    execFileSync("node", ["scripts/coverage.mjs"], { cwd: ROOT, stdio: "inherit" });
    console.log("[OK] [coverage] 覆盖率达标");
  } catch {
    fail("coverage", "覆盖率未达 100%，请补充测试断言");
  }
}

if (stage === "pre-commit") {
  checkSyntax();
  checkTests();
  checkToc();
  checkSecret();
  // coverage 不在此列：耗时长（e2e 真实 npm 安装 ~25s），由 --only=coverage / CI 执行
  // --only=commit-msg 时单独执行（无 --only 时静默跳过）
  if (only === "commit-msg") checkCommitMsg();
}
if (stage === "commit-msg") {
  checkCommitMsg();
}

if (failed) {
  console.error("\n[FAIL] Git Hook 检查未通过，请修复后重试。");
  process.exit(1);
}
console.log("\n[OK] 全部检查通过。");
