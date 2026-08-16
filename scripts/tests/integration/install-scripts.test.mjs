// install.sh / install.ps1 沙箱行为测试——临时 HOME/USERPROFILE 跑真实脚本，验证幂等契约。
//
// 场景（契约 = README 与实际环境 cordis.patch.yml 行为一致）：
//   A 全新环境：注册一次，追加条目 id=dsh-plugin-marketplace
//   B 已含真实嵌套条目（`- insert:` 块内缩进 name 行）：跳过，不追加
//   D 全新环境连跑 3 次：只注册一次（幂等）
//
// 依赖：install.sh 用 bash（Git Bash / CI Linux 均可用；环境无 bash 时跳过 sh 沙箱，
//       契约静态断言见 unit/install-scripts.test.mjs，跨平台必跑）；
//       install.ps1 用 pwsh（Windows 本机执行，其他平台跳过）。
// 契约的静态断言见 unit/install-scripts.test.mjs（跨平台必跑）。

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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

// ---- bash 探测 ----
// Windows 上 `bash` 可能解析到 WSL（C:\Windows\system32\bash.exe）——WSL 吞
// 反斜杠路径（127 找不到文件），且 HOME 为 Linux 语义（沙箱隔离被破坏：
// install.sh 会写 WSL 里真实 ~/.dsh，污染宿主 profile）。必须用 Git Bash
// （MSYS runtime，argv 层自动路径转换）或 CI Linux 原生 bash。探测不到 → SKIP
// sh 场景（ps1 场景仍验证核心契约，sh 契约由 CI 覆盖）。
function detectShBash() {
  if (process.platform !== "win32") return "bash";
  const candidates = ["bash", "C:\\Program Files\\Git\\bin\\bash.exe"];
  for (const cand of candidates) {
    try {
      const r = spawnSync(cand, ["--version"], { encoding: "utf8" });
      if (r.status === 0 && /msys|MINGW/i.test(`${r.stdout}${r.stderr}`)) return cand;
    } catch { /* 下一个候选 */ }
  }
  return null;
}
const shBash = detectShBash();

// ---- install.sh：bash 沙箱（场景 A/B/D）----
// 合并说明：上游 hasBash 简单存在检查被 detectShBash 取代（WSL 的 bash 存在但吞
// 反斜杠路径 + HOME 语义破坏沙箱隔离——必须 Git Bash/MSYS 或 CI Linux）；sh 场景
// 包在 if (shBash) 内（与上游 if(hasBash()) 结构一致），ps1 侧保留上游 hasPwsh 探测。
if (shBash) {
  function runSh(home) {
    // PATH 前置必然失败的 stub dsh：环境若装过 dsh CLI（维护者本机），install.sh 的
    // command -v dsh 检测会走「官方安装」分支（真实网络 + 真实 profile），沙箱断言
    // 必失败。stub exit 1 → 官方分支失败 → 回退手动分支（与 ps1 的 stub 语义一致）。
    const stubDir = mkdtempSync(join(tmpdir(), "dsh-sh-stub-"));
    writeFileSync(join(stubDir, "dsh"), "#!/bin/sh\nexit 1\n", "utf8");
    try {
      execFileSync(shBash, [join(ROOT, "install.sh")], {
        env: { ...process.env, HOME: home, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
        cwd: ROOT,
        stdio: "pipe"
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
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
} else {
  console.log("SKIP sh 沙箱（环境无 bash，Git Bash / CI Linux 下运行）");
}

// ---- install.ps1：pwsh 沙箱（仅 Windows 本机；环境无 pwsh 时跳过，与 sh 侧对称）----
function hasPwsh() {
  try { execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }); return true; } catch { return false; }
}
if (process.platform === "win32" && hasPwsh()) {
  function runPs1(userProfile) {
    // 沙箱隔离：宿主 dsh CLI 会令脚本走「官方安装」分支（写真实 profile 而非
    // USERPROFILE，且每次 60s+）——PATH 前置必然失败的 stub dsh：脚本
    // $ErrorActionPreference=Stop 下外部命令非零退出即抛异常 → catch 回退手动分支，
    // 沙箱断言才成立（install.ps1 顶部的 dsh 检测本意是真实用户环境的优化）。
    // 不直接跑仓库根 install.ps1：$PSScriptRoot=仓库根 → Copy-Item 复制整个仓库
    // （含 .git，~60MB 逐文件 + Defender 扫描 ~90s/次）——复制脚本到最小 fixture
    // 目录（占位 package.json 满足 PSScriptRoot 检查），$src 只复制 KB 级内容。
    const stubDir = mkdtempSync(join(tmpdir(), "dsh-stub-"));
    const srcDir = mkdtempSync(join(tmpdir(), "dsh-ps1-src-"));
    copyFileSync(join(ROOT, "install.ps1"), join(srcDir, "install.ps1"));
    writeFileSync(join(srcDir, "package.json"), JSON.stringify({ name: "fixture-market", version: "1.0.0" }), "utf8");
    writeFileSync(join(stubDir, "dsh.cmd"), "@echo off\r\nexit /b 1\r\n", "utf8");
    writeFileSync(join(stubDir, "dsh"), "#!/bin/sh\nexit 1\n", "utf8");
    const env = { ...process.env, USERPROFILE: userProfile, PATH: `${stubDir};${process.env.PATH ?? ""}` };
    try {
      // 超时兜底：网络/复制异常挂起时防止整个测试文件无限阻塞（超时抛 ETIMEDOUT 明确失败）
      execFileSync("pwsh", ["-NoProfile", "-File", join(srcDir, "install.ps1")], {
        env,
        cwd: srcDir,
        stdio: "pipe",
        timeout: 100_000
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  }
  // 并行化：fixture 化后 install.ps1 走本地分支（无网络下载，秒级）；A/B/D 的
  // HOME 彼此独立，可并行执行；D 的 3 次连跑必须串行（同一 HOME 的幂等语义测试）。
  const psA = mkdtempSync(join(tmpdir(), "dsh-inst-ps-a-"));
  const psB = mkdtempSync(join(tmpdir(), "dsh-inst-ps-b-"));
  const psD = mkdtempSync(join(tmpdir(), "dsh-inst-ps-d-"));
  await Promise.all([
    (async () => {
      // A：全新环境
      try {
        runPs1(psA);
        const patch = readPatch(psA);
        check("ps1-A: 全新环境注册一次", (patch.match(/name: dsh-plugin-marketplace/g) || []).length, 1);
        check("ps1-A: 追加 id 为 dsh-plugin-marketplace", /- id: dsh-plugin-marketplace/.test(patch), true);
      } finally { rmSync(psA, { recursive: true, force: true }); }
    })(),
    (async () => {
      // B：嵌套条目跳过
      try {
        mkdirSync(join(psB, ".dsh", "profiles", "web"), { recursive: true });
        writeFileSync(patchPath(psB), INDENTED_ENTRY, "utf8");
        runPs1(psB);
        check("ps1-B: 嵌套条目已注册 → 跳过不追加", readPatch(psB), INDENTED_ENTRY);
      } finally { rmSync(psB, { recursive: true, force: true }); }
    })(),
    (async () => {
      // D：连跑 3 次（同一 HOME 串行）
      try {
        for (let i = 0; i < 3; i++) runPs1(psD);
        const patch = readPatch(psD);
        check("ps1-D: 连跑 3 次只注册一次", (patch.match(/name: dsh-plugin-marketplace/g) || []).length, 1);
      } finally { rmSync(psD, { recursive: true, force: true }); }
    })(),
  ]);
} else if (process.platform === "win32") {
  console.log("SKIP ps1 沙箱（环境无 pwsh，Windows 本机 / CI Windows 下运行）");
} else {
  console.log("SKIP ps1 沙箱（非 Windows 平台，需 pwsh）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
