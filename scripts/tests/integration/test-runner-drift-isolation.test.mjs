import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_SOURCE = join(ROOT, "scripts", "tests", "run.mjs");
const DRIFT_REPORT = join(ROOT, "drift-report.json");
const AUTO_PREFIX = "dsh-runner-drift-";
const RUN_TIMEOUT = 180000;

function autoDriftDirs(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(AUTO_PREFIX))
    .map((entry) => entry.name)
    .sort();
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function withoutDriftEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.DRIFT_REPORT_FILE;
  return env;
}

function makeSandbox(withFailure = false) {
  const root = mkdtempSync(join(tmpdir(), "dsh-runner-sandbox-"));
  const tempRoot = join(root, "tmp");
  const unitDir = join(root, "scripts", "tests", "unit");
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  const runner = join(root, "scripts", "tests", "run.mjs");
  const observeFile = join(root, "observed-drift-path.txt");
  copyFileSync(RUNNER_SOURCE, runner);
  writeFileSync(join(root, "scripts", "tests", "cleanup.mjs"), "process.exit(0);\n", "utf8");
  writeFileSync(
    join(unitDir, "observe-drift.test.mjs"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.RUNNER_OBSERVE_FILE, process.env.DRIFT_REPORT_FILE ?? "undefined", "utf8");\n',
    "utf8"
  );
  if (withFailure) {
    writeFileSync(
      join(unitDir, "zz-runner-failure.test.mjs"),
      'console.error("runner failure fixture"); process.exit(1);\n',
      "utf8"
    );
  }
  return { root, tempRoot, runner, observeFile };
}

function runRunner(sandbox, env, args = ["--level=unit"]) {
  return spawnSync(process.execPath, [sandbox.runner, ...args], {
    cwd: sandbox.root,
    env: {
      ...env,
      TEMP: sandbox.tempRoot,
      TMP: sandbox.tempRoot,
      TMPDIR: sandbox.tempRoot,
      RUNNER_OBSERVE_FILE: sandbox.observeFile
    },
    encoding: "utf8",
    timeout: RUN_TIMEOUT,
    windowsHide: true,
    stdio: "pipe"
  });
}

function observedPath(sandbox) {
  return readFileSync(sandbox.observeFile, "utf8");
}

function isAutoDriftPath(path) {
  return path !== "undefined" && path.includes(AUTO_PREFIX);
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// 仓库根 drift-report.json 是构建产物、允许不存在（新架构默认把 drift 写临时目录；
// CI 的 chore 提交也曾提交过它的删除）。因此基准摘要必须"存在才算"：
// 有基线 → 断言哈希不变；无基线 → 断言 runner 也不新建该文件（同样是隔离验证）。
// 严禁在模块顶层无条件 readFileSync 该路径——否则全新 checkout 直接 ENOENT 挂掉（2026-09-10 CI 事故）。
const hadRepoDrift = existsSync(DRIFT_REPORT);
const originalDigest = hadRepoDrift ? digest(DRIFT_REPORT) : null;
function checkRepoDriftUntouched(name) {
  if (hadRepoDrift) check(name, digest(DRIFT_REPORT), originalDigest);
  else check(`${name}（无基线时不得新建）`, existsSync(DRIFT_REPORT), false);
}

const defaultSandbox = makeSandbox();
try {
  const originalDirs = autoDriftDirs(defaultSandbox.tempRoot);
  const result = runRunner(defaultSandbox, withoutDriftEnv());
  const observed = observedPath(defaultSandbox);
  check("未设置 drift 路径时 sandbox runner 成功", result.status, 0);
  check("未设置 drift 路径注入临时报告", isAutoDriftPath(observed), true);
  check("默认报告临时路径退出后已清理", existsSync(observed), false);
  checkRepoDriftUntouched("未设置 drift 路径不改写仓库报告");
  check("默认 drift 临时目录退出后清理", autoDriftDirs(defaultSandbox.tempRoot), originalDirs);
} finally {
  rmSync(defaultSandbox.root, { recursive: true, force: true });
}

const explicitSandbox = makeSandbox();
try {
  const originalDirs = autoDriftDirs(explicitSandbox.tempRoot);
  const explicitReportPath = join(explicitSandbox.root, "explicit-report.json");
  writeFileSync(explicitReportPath, "caller-owned", "utf8");
  const explicitEnv = {
    ...process.env,
    DRIFT_REPORT_FILE: explicitReportPath
  };
  const result = runRunner(explicitSandbox, explicitEnv);
  check("显式 drift 路径 sandbox runner 成功", result.status, 0);
  check("显式 drift 路径原样传入子测试", observedPath(explicitSandbox), explicitReportPath);
  check("显式 drift 报告不被 runner 删除", readFileSync(explicitReportPath, "utf8"), "caller-owned");
  check("显式 drift 路径不创建默认临时目录", autoDriftDirs(explicitSandbox.tempRoot), originalDirs);
  checkRepoDriftUntouched("显式 drift 路径不改写仓库报告");
} finally {
  rmSync(explicitSandbox.root, { recursive: true, force: true });
}

const failureSandbox = makeSandbox(true);
try {
  const originalDirs = autoDriftDirs(failureSandbox.tempRoot);
  const result = runRunner(failureSandbox, withoutDriftEnv());
  const observed = observedPath(failureSandbox);
  check("子测试失败时 runner 保留非零退出码", result.status, 1);
  check("子测试失败仍注入临时报告", isAutoDriftPath(observed), true);
  check("子测试失败时临时报告仍被清理", existsSync(observed), false);
  checkRepoDriftUntouched("子测试失败时不改写仓库报告");
  check("子测试失败时默认 drift 目录仍清理", autoDriftDirs(failureSandbox.tempRoot), originalDirs);
} finally {
  rmSync(failureSandbox.root, { recursive: true, force: true });
}

const invalidSandbox = makeSandbox();
try {
  const result = runRunner(invalidSandbox, withoutDriftEnv(), ["--level=invalid"]);
  check("非法层级仍返回非零退出码", result.status, 1);
} finally {
  rmSync(invalidSandbox.root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
