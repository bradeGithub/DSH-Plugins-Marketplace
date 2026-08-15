// install.sh / install.ps1 沙箱行为测试——临时 HOME/USERPROFILE 跑真实脚本，验证幂等契约。
//
// 场景（契约 = README 与实际环境 cordis.patch.yml 行为一致）：
//   A 全新环境：注册一次，追加条目 id=dsh-plugin-marketplace
//   B 已含真实嵌套条目（`- insert:` 块内缩进 name 行）：跳过，不追加
//   D 全新环境连跑 3 次：只注册一次（幂等）
//
// 依赖：install.sh 用 bash（Git Bash / CI Linux 均可用）；
//       install.ps1 用 pwsh（Windows 本机执行，其他平台跳过）。
// 契约的静态断言见 unit/install-scripts.test.mjs（跨平台必跑）。

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const INDENTED_ENTRY = `# 注释\n- insert:\n    - id: dsh-plugin-marketplace\n      name: dsh-plugin-marketplace\n`;

function patchPath(home) {
  return join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
}
function readPatch(home) {
  const p = patchPath(home);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// ---- install.sh：bash 沙箱（场景 A/B/D）----
function runSh(home) {
  execFileSync("bash", [join(ROOT, "install.sh")], {
    env: { ...process.env, HOME: home },
    cwd: ROOT,
    stdio: "pipe"
  });
}

// A：全新环境
const homeA = mkdtempSync(join(tmpdir(), "dsh-inst-sh-a-"));
try {
  runSh(homeA);
  const patch = readPatch(homeA);
  check("sh-A: 全新环境注册一次", (patch.match(/name: dsh-plugin-marketplace/g) || []).length, 1);
  check("sh-A: 追加 id 为 dsh-plugin-marketplace", /- id: dsh-plugin-marketplace/.test(patch), true);
  check("sh-A: 非独立 plugin-marketplace id", !/- id: plugin-marketplace(?![-\w])/.test(patch), true);
} finally { rmSync(homeA, { recursive: true, force: true }); }

// B：已含真实嵌套条目（缩进 name 行）→ 跳过
const homeB = mkdtempSync(join(tmpdir(), "dsh-inst-sh-b-"));
try {
  mkdirSync(join(homeB, ".dsh", "profiles", "web"), { recursive: true });
  writeFileSync(patchPath(homeB), INDENTED_ENTRY, "utf8");
  runSh(homeB);
  check("sh-B: 嵌套条目已注册 → 跳过不追加", readPatch(homeB), INDENTED_ENTRY);
} finally { rmSync(homeB, { recursive: true, force: true }); }

// D：全新环境连跑 3 次 → 只注册一次
const homeD = mkdtempSync(join(tmpdir(), "dsh-inst-sh-d-"));
try {
  for (let i = 0; i < 3; i++) runSh(homeD);
  const patch = readPatch(homeD);
  check("sh-D: 连跑 3 次只注册一次", (patch.match(/name: dsh-plugin-marketplace/g) || []).length, 1);
} finally { rmSync(homeD, { recursive: true, force: true }); }

// ---- install.ps1：pwsh 沙箱（仅 Windows 本机）----
if (process.platform === "win32") {
  function runPs1(userProfile) {
    execFileSync("pwsh", ["-NoProfile", "-File", join(ROOT, "install.ps1")], {
      env: { ...process.env, USERPROFILE: userProfile },
      cwd: ROOT,
      stdio: "pipe"
    });
  }
  // A：全新环境
  const psA = mkdtempSync(join(tmpdir(), "dsh-inst-ps-a-"));
  try {
    runPs1(psA);
    const patch = readPatch(psA);
    check("ps1-A: 全新环境注册一次", (patch.match(/name: dsh-plugin-marketplace/g) || []).length, 1);
    check("ps1-A: 追加 id 为 dsh-plugin-marketplace", /- id: dsh-plugin-marketplace/.test(patch), true);
  } finally { rmSync(psA, { recursive: true, force: true }); }
  // B：嵌套条目跳过
  const psB = mkdtempSync(join(tmpdir(), "dsh-inst-ps-b-"));
  try {
    mkdirSync(join(psB, ".dsh", "profiles", "web"), { recursive: true });
    writeFileSync(patchPath(psB), INDENTED_ENTRY, "utf8");
    runPs1(psB);
    check("ps1-B: 嵌套条目已注册 → 跳过不追加", readPatch(psB), INDENTED_ENTRY);
  } finally { rmSync(psB, { recursive: true, force: true }); }
  // D：连跑 3 次
  const psD = mkdtempSync(join(tmpdir(), "dsh-inst-ps-d-"));
  try {
    for (let i = 0; i < 3; i++) runPs1(psD);
    const patch = readPatch(psD);
    check("ps1-D: 连跑 3 次只注册一次", (patch.match(/name: dsh-plugin-marketplace/g) || []).length, 1);
  } finally { rmSync(psD, { recursive: true, force: true }); }
} else {
  console.log("SKIP ps1 沙箱（非 Windows 平台，需 pwsh）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
