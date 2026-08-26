// Git Hook 调度器（check.mjs）行为测试：spawn 子进程验证编排逻辑。
// 覆盖本地 staged 扫描、CI 增量扫描（CHECK_DIFF_BASE）、未知 --only、--help。
// 与 validate.test.mjs（校验纯函数）互补——本文件测的是编排层。
//
// 注意：CHECK_WORKTREE 指向临时仓库，secret 扫描的 git diff 与文件读取
// 都在临时仓库内进行，不触碰真实仓库的 index。

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..");
const CHECK = join(ROOT, "scripts", "hooks", "check.mjs");

const run = (args, env = {}) => spawnSync("node", [CHECK, ...args], {
  cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000, windowsHide: true,
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
  execFileSync("git", ["init", "-q"], { cwd: work, stdio: "pipe", windowsHide: true });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: work, stdio: "pipe", windowsHide: true });
  execFileSync("git", ["config", "user.name", "t"], { cwd: work, stdio: "pipe", windowsHide: true });
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
    check("未知 --only 输出含可用值", /syntax \| tests \| toc \| secret/.test(r.stderr), true);
  }

  // 场景 A：干净文件 staged → secret 通过
  {
    writeFileSync(join(work, "clean.js"), "module.exports = 1;\n", "utf8");
    execFileSync("git", ["add", "clean.js"], { cwd: work, stdio: "pipe", windowsHide: true });
    const r = run(["--only=secret"], { CHECK_WORKTREE: work });
    check("干净文件 staged secret 退出码 0", r.status, 0);
  }

  // 场景 B：含密钥文件 staged → secret 拦截（error 级）
  {
    const sk = ["sk-", "AbCd1234EfGh5678IjKl90Mn"].join("");
    writeFileSync(join(work, "leaky.js"), `const k = "${sk}";\n`, "utf8");
    execFileSync("git", ["add", "leaky.js"], { cwd: work, stdio: "pipe", windowsHide: true });
    const r = run(["--only=secret"], { CHECK_WORKTREE: work });
    check("密钥文件 staged 退出码 1", r.status, 1);
    check("密钥拦截输出含文件名", r.stderr.includes("leaky.js"), true);
  }

  // 场景 C：CI 增量模式（CHECK_DIFF_BASE）——扫已提交的相对基线的变更
  {
    // 基线：仅 clean.js 的提交
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work, stdio: "pipe", windowsHide: true });
    // 增量提交：加密钥文件（sk- 后 ≥20 字符才命中 detectSecret 规则）
    writeFileSync(join(work, "ci-leak.txt"), `api_key=${["sk-", "AbCd1234EfGh5678IjKl90Mn"].join("")}\n`, "utf8");
    execFileSync("git", ["add", "ci-leak.txt"], { cwd: work, stdio: "pipe", windowsHide: true });
    execFileSync("git", ["commit", "-qm", "add ci-leak"], { cwd: work, stdio: "pipe", windowsHide: true });
    const r = run(["--only=secret"], { CHECK_WORKTREE: work, CHECK_DIFF_BASE: "HEAD~1" });
    check("CI 增量模式扫到已提交密钥 退出码 1", r.status, 1);
    check("CI 增量模式输出含增量文件名", r.stderr.includes("ci-leak.txt"), true);
  }

  // 场景 D：CI 增量模式无密钥增量 → 通过
  {
    writeFileSync(join(work, "ci-clean.txt"), "hello\n", "utf8");
    execFileSync("git", ["add", "ci-clean.txt"], { cwd: work, stdio: "pipe", windowsHide: true });
    execFileSync("git", ["commit", "-qm", "add clean"], { cwd: work, stdio: "pipe", windowsHide: true });
    const r = run(["--only=secret"], { CHECK_WORKTREE: work, CHECK_DIFF_BASE: "HEAD~1" });
    check("CI 增量模式干净增量 退出码 0", r.status, 0);
  }

  // 场景 E：secretExclusions 排除路径生效
  {
    mkdirSync(join(work, "vendor"), { recursive: true });
    writeFileSync(join(work, "vendor", "example.txt"), `password=sk-123456\n`, "utf8");
    execFileSync("git", ["add", "vendor/example.txt"], { cwd: work, stdio: "pipe", windowsHide: true });
    writeFileSync(join(work, ".hooksrc"), "secretLevel=error\nsecretExclusions=vendor/\n", "utf8");
    const r = run(["--only=secret"], { CHECK_WORKTREE: work });
    check("secretExclusions 排除 vendor/ 退出码 0", r.status, 0);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
