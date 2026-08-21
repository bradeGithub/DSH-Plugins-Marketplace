#!/usr/bin/env node
// 真实安装验收（手动，不进自动金字塔）：issue 报告异常的插件逐个体检。
// 与 install.e2e.mjs（本地 fixture 离线）不同——本工具走真实网络 clone + 真实
// pnpm 安装，验证：①脱敏管线在真实 bug 日志下无泄漏/形态合理 ②安装链路的真实
// 错误信息可诊断（workspace 吞依赖 / entry 缺失 / registry 缺包等）。
// 用法：node scripts/tests/manual/real-install-verify.mjs [repo...]
//   不带参数跑内置 issue 清单（#168/#152/#147/#146/#145/#134/#125/#93/#90/#84/#82）
//   带参数只体检指定仓库：node scripts/tests/manual/real-install-verify.mjs lynx-gt/dsh-subagent-cwd
// 注意：真实网络 + 安装耗时（每仓 5s~2min），临时 DSH_HOME 隔离不污染真实部署。

import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** 目录删除容错：git 超时残留子进程可能占文件（EBUSY），重试 + 失败静默。 */
function safeRm(p) {
  for (let i = 0; i < 3; i++) {
    try { rmSync(p, { recursive: true, force: true }); return; } catch { /* 下轮重试 */ }
  }
}

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DSH = join(tmpdir(), "dsh-real-install-verify");
safeRm(DSH);
process.env.DSH_HOME = DSH;
const PROF = join(DSH, "profiles", "web");
mkdirSync(join(PROF, "node_modules", "@deepseek-ai"), { recursive: true });
writeFileSync(join(PROF, "package.json"), JSON.stringify({ name: "web-profile", private: true }));
// cordis patch 文件：appendPatchEntry 需要存在可追加的 YAML
writeFileSync(join(PROF, "cordis.patch.yml"), "# dsh-plugin-marketplace real-install-verify\n");

const lib = await import(`file:///${ROOT.replace(/\\/g, "/")}/lib/index.js`);

// issue 报告异常的插件（异常反馈清单，持续扩充）
const DEFAULT_CASES = [
  { repo: "liustack/modlens", issue: "#168/#143" },
  { repo: "V1ki/dsh-plugin-subscriptions", issue: "#152" },
  { repo: "lynx-gt/dsh-subagent-cwd", issue: "#147" },
  { repo: "SeverusZh/dsh-plugin-subagent-director", issue: "#146" },
  { repo: "ccch1mneyyy/dsh-TUI", issue: "#145" },
  { repo: "zhu1090093659/dsh-web-ui", issue: "#134" },
  { repo: "omdsh-dev/dsh-genui", issue: "#125" },
  { repo: "Tencent/BrowserSkill", issue: "#93" },
  { repo: "whiteguo233/OpenBiliClaw", issue: "#84" },
  { repo: "DTSFO/dsh-conversation-rewind", issue: "#82" },
];
const argRepos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const CASES = argRepos.length > 0
  ? argRepos.map((repo) => ({ repo, issue: "手动指定" }))
  : DEFAULT_CASES;

// 泄漏形态（与 redact.test.mjs 三面组织的泄漏面同源，另加路径/undefined 拼接）
const leakPatterns = [
  { re: /C:\\Users\\[^\\]+/, name: "Win 用户名路径" },
  { re: /\/home\/[a-z0-9_]+/, name: "/home 路径" },
  { re: /(?:ghp_|github_pat_|glpat-|sk-|sk-ant-|gsk_|xai-|pplx-|AIza|GOCSPX-|AKIA|LTAI|AKID|hf_|npm_)[A-Za-z0-9_-]{8,}/, name: "密钥形态" },
  { re: /Bearer\s+[A-Za-z0-9._-]{16,}/, name: "Bearer 凭证" },
  { re: /undefined/, name: "undefined 拼接" },
];

let pass = 0, fail = 0;

async function runCase(repo, issue, attempt = 1) {
  const log = [];
  const logLine = (l) => { log.push(String(l ?? "")); };
  const start = Date.now();
  let type = "?";
  const cacheDir = join(DSH, "cache", repo.replace("/", "__"));
  try {
    mkdirSync(join(DSH, "cache"), { recursive: true });
    logLine(`[0/5] 克隆 https://github.com/${repo} ...`);
    execFileSync("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, cacheDir],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 90000, windowsHide: true });
    logLine("[1/5] 克隆完成");

    const detect = await lib.detectTypeDetail(cacheDir);
    type = detect.type;
    logLine(`[2/5] 识别类型: ${type}（${detect.reasonKey}）`);

    const result = await lib.installRepo({
      type, cacheDir, repo,
      log, answers: {}, logLine, lang: "zh-CN",
      envAllowList: [], npmTarget: null,
    });
    logLine(`[5/5] 安装完成: ${result.name} v${result.version ?? "?"}`);
    writeFileSync(join(DSH, `log-${repo.replace("/", "__")}.txt`), log.join("\n"), "utf8"); // 完整日志留档
    safeRm(cacheDir);
    const snapshot = lib.buildFeedbackLogSnapshot(log);
    const findings = leakPatterns.filter((p) => p.re.test(snapshot)).map((p) => p.name);
    const ok = findings.length === 0;
    if (ok) pass++; else fail++;
    console.log(`${ok ? "PASS" : "FAIL"} ${repo} [${issue}] type=${type} ${Date.now() - start}ms`);
    if (!ok) console.log(`     泄漏: ${findings.join(", ")}\n     ── 快照预览 ──\n${snapshot.slice(0, 400)}`);
    return;
  } catch (e) {
    const msg = String(e?.message ?? e);
    // 网络超时重试一次（git/spawn 层超时）
    if (attempt === 1 && /ETIMEDOUT|timeout|Timeout/i.test(msg)) {
      console.log(`RETRY ${repo} [${issue}]（${msg.slice(0, 60)}）`);
      return runCase(repo, issue, 2);
    }
    const snapshot = lib.buildFeedbackLogSnapshot(log);
    const findings = leakPatterns.filter((p) => p.re.test(snapshot)).map((p) => p.name);
    const leak = findings.length > 0;
    if (leak) fail++; else pass++; // 安装失败但快照无泄漏 = 脱敏合格（错误本身即诊断信息）
    console.log(`${leak ? "FAIL" : "PASS"} ${repo} [${issue}] type=${type} 安装异常（快照${leak ? "泄漏" : "无泄漏"}）: ${msg.slice(0, 120)}`);
    if (leak) console.log(`     ── 快照预览 ──\n${snapshot.slice(0, 400)}`);
    writeFileSync(join(DSH, `log-${repo.replace("/", "__")}.txt`), log.join("\n"), "utf8"); // 完整日志留档
    safeRm(cacheDir);
  }
}

for (const c of CASES) await runCase(c.repo, c.issue);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`完整日志目录（诊断用）: ${DSH}`);
process.exit(fail === 0 ? 0 : 1);
