// Git Hook 调度器（check.mjs）行为测试：spawn 子进程验证编排逻辑。
// 覆盖本地 staged 扫描、CI 增量扫描（CHECK_DIFF_BASE）、未知 --only、--help。
// 与 validate.test.mjs（校验纯函数）互补——本文件测的是编排层。
//
// 注意：CHECK_WORKTREE 指向临时仓库，secret 扫描的 git diff 与文件读取
// 都在临时仓库内进行，不触碰真实仓库的 index。

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..");
const CHECK = join(ROOT, "scripts", "hooks", "check.mjs");
const CHECK_SOURCE = readFileSync(CHECK, "utf8");
const COVERAGE_SOURCE = readFileSync(join(ROOT, "scripts", "coverage.mjs"), "utf8");
const BUILD_REGISTRY_SOURCE = readFileSync(join(ROOT, "scripts", "build-registry.mjs"), "utf8");
const GIT_CONTEXT_KEYS = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH", "GIT_PREFIX",
]);
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_CONTEXT_KEYS.has(key)));

const run = (args, env = {}) => spawnSync("node", [CHECK, ...args], {
  cwd: ROOT, encoding: "utf8", env: { ...testEnv, ...env }, timeout: 120000, windowsHide: true,
});
const git = (args, options) => execFileSync("git", args, {
  ...options, env: { ...testEnv, ...(options?.env ?? {}) },
});

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// ---- 临时 git 仓库（CHECK_WORKTREE 隔离）----
const work = mkdtempSync(join(tmpdir(), "dsh-hook-")).replace(/\\/g, "/");
try {
  git(["init", "-q"], { cwd: work, stdio: "pipe", windowsHide: true });
  git(["config", "user.email", "t@t"], { cwd: work, stdio: "pipe", windowsHide: true });
  git(["config", "user.name", "t"], { cwd: work, stdio: "pipe", windowsHide: true });
  // .hooksrc：secretLevel error（默认即 error，显式写出防默认漂移）
  writeFileSync(join(work, ".hooksrc"), "secretLevel=error\n", "utf8");

  // --help → exit 0
  {
    const r = run(["--help"]);
    check("--help 退出码 0", r.status, 0);
  }

  // 未知 --only → exit 1 + 提示
  {
    const r = run(["--only=bogus"]);
    check("未知 --only 退出码 1", r.status, 1);
    check("未知 --only 输出含可用值", /syntax \| tests \| e2e \| toc \| secret/.test(r.stderr), true);
  }

  // coverage 入口必须真的调用 checkCoverage；仅返回 0 的空跑无法作为门控。
  check("--only=coverage 实际分派 checkCoverage", /if \(only === "coverage"\) checkCoverage\(\);/.test(CHECK_SOURCE), true);
  check("提交前测试隔离漂移报告", /DRIFT_REPORT_FILE: join\(driftDir, "drift-report\.json"\)/.test(CHECK_SOURCE), true);
  check("build registry 支持隔离漂移报告", BUILD_REGISTRY_SOURCE.includes('process.env.DRIFT_REPORT_FILE ?? join(ROOT, "..", "drift-report.json")'), true);
  check("coverage 测试失败保留失败码", /let testsFailed = false;[\s\S]*?testsFailed = true;[\s\S]*?coveredFuncs < totalFuncs \|\| testsFailed/.test(COVERAGE_SOURCE), true);
  check("--only=e2e 纳入可选检查", /\["syntax", "tests", "e2e", "toc", "secret", "commit-msg", "coverage"\]/.test(CHECK_SOURCE), true);
  check("默认 pre-commit 不隐式运行 e2e", /if \(only === "e2e"\) checkE2e\(\);/.test(CHECK_SOURCE), true);
  check("e2e 检查实际运行 e2e 层", /\["scripts\/tests\/run\.mjs", "--level=e2e"\]/.test(CHECK_SOURCE), true);
  check("e2e 检查严格处理缺少前置工具", /DSH_REQUIRE_E2E: "1"/.test(CHECK_SOURCE), true);

  // 场景 A：干净文件 staged → secret 通过
  {
    writeFileSync(join(work, "clean.js"), "module.exports = 1;\n", "utf8");
    git(["add", "clean.js"], { cwd: work, stdio: "pipe", windowsHide: true });
    const r = run(["--only=secret"], { CHECK_WORKTREE: work });
    check("干净文件 staged secret 退出码 0", r.status, 0);
  }

  // 场景 B：含密钥文件 staged → secret 拦截（error 级）
  {
    const sk = ["sk-", "AbCd1234EfGh5678IjKl90Mn"].join("");
    writeFileSync(join(work, "leaky.js"), `const k = "${sk}";\n`, "utf8");
    git(["add", "leaky.js"], { cwd: work, stdio: "pipe", windowsHide: true });
    const r = run(["--only=secret"], { CHECK_WORKTREE: work });
    check("密钥文件 staged 退出码 1", r.status, 1);
    check("密钥拦截输出含文件名", r.stderr.includes("leaky.js"), true);
  }

  // 场景 C：CI 增量模式（CHECK_DIFF_BASE）——扫已提交的相对基线的变更
  {
    // 基线：仅 clean.js 的提交
    git(["commit", "-qm", "base"], { cwd: work, stdio: "pipe", windowsHide: true });
    // 增量提交：加密钥文件（sk- 后 ≥20 字符才命中 detectSecret 规则）
    writeFileSync(join(work, "ci-leak.txt"), `api_key=${["sk-", "AbCd1234EfGh5678IjKl90Mn"].join("")}\n`, "utf8");
    git(["add", "ci-leak.txt"], { cwd: work, stdio: "pipe", windowsHide: true });
    git(["commit", "-qm", "add ci-leak"], { cwd: work, stdio: "pipe", windowsHide: true });
    const r = run(["--only=secret"], { CHECK_WORKTREE: work, CHECK_DIFF_BASE: "HEAD~1" });
    check("CI 增量模式扫到已提交密钥 退出码 1", r.status, 1);
    check("CI 增量模式输出含增量文件名", r.stderr.includes("ci-leak.txt"), true);
  }

  // 场景 D：CI 增量模式无密钥增量 → 通过
  {
    writeFileSync(join(work, "ci-clean.txt"), "hello\n", "utf8");
    git(["add", "ci-clean.txt"], { cwd: work, stdio: "pipe", windowsHide: true });
    git(["commit", "-qm", "add clean"], { cwd: work, stdio: "pipe", windowsHide: true });
    const r = run(["--only=secret"], { CHECK_WORKTREE: work, CHECK_DIFF_BASE: "HEAD~1" });
    check("CI 增量模式干净增量 退出码 0", r.status, 0);
  }

  // 场景 E：secretExclusions 排除路径生效
  {
    mkdirSync(join(work, "vendor"), { recursive: true });
    writeFileSync(join(work, "vendor", "example.txt"), `password=sk-123456\n`, "utf8");
    git(["add", "vendor/example.txt"], { cwd: work, stdio: "pipe", windowsHide: true });
    writeFileSync(join(work, ".hooksrc"), "secretLevel=error\nsecretExclusions=vendor/\n", "utf8");
    const r = run(["--only=secret"], { CHECK_WORKTREE: work });
    check("secretExclusions 排除 vendor/ 退出码 0", r.status, 0);
  }

  // 场景 F：syntax 检查可运行且通过（真实仓库全绿）
  {
    const r = run(["--only=syntax"]);
    check("syntax 检查退出码 0", r.status, 0);
  }

  // 场景 G：toc 检查可运行且通过（真实仓库 TOC 有效）
  {
    const r = run(["--only=toc"]);
    check("toc 检查退出码 0", r.status, 0);
  }

  // 场景 H：commit-msg 合法格式通过 / 非法格式拦截
  {
    const okMsg = join(work, "ok-msg.txt");
    writeFileSync(okMsg, "feat(scope): 合法提交信息\n", "utf8");
    const okR = run(["--only=commit-msg", okMsg]);
    check("commit-msg 合法格式退出码 0", okR.status, 0);

    const badMsg = join(work, "bad-msg.txt");
    writeFileSync(badMsg, "bad subject no type\n", "utf8");
    const badR = run(["--only=commit-msg", badMsg]);
    check("commit-msg 非法格式退出码 1", badR.status, 1);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
