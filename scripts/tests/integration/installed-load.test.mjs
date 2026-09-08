// installed.json 加载边界测试：
// - 损坏（JSON.parse 失败）→ WARN + 备份原文件（.corrupt-<ts>），安装记录以空处理
//   ——静默当空会让所有已安装标注消失、误判未安装导致重复安装（数据丢失不可恢复）；
// - 文件不存在（首次运行）→ 空清单，无备份（正常路径）。
//
// 独立文件的原因：loadInstalled 在 import lib 时执行（模块级状态），必须在本文件内
// 先构造 DSH_HOME + installed.json 再 import；损坏与缺失场景需独立进程隔离。

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

// ---- 场景 A：installed.json 损坏 → WARN + 备份 + 空清单 ----
{
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-load-corrupt-")).replace(/\\/g, "/");
  const marketRoot = join(process.env.DSH_HOME, "marketplace");
  mkdirSync(marketRoot, { recursive: true });
  const installedFile = join(marketRoot, "installed.json");
  const brokenContent = '{"owner/broken": { type: "skill", name: "broken", location: "/x", installedAt: 1 },'; // 截断 JSON
  writeFileSync(installedFile, brokenContent, "utf8");
  const lib = await import("../../../lib/index.js");
  const backups = readdirSync(marketRoot).filter((f) => f.startsWith("installed.json.corrupt-"));
  check("损坏 installed.json 生成 .corrupt-* 备份", backups.length >= 1, true);
  if (backups.length >= 1) {
    check("备份内容为原损坏内容（可人工恢复）", readFileSync(join(marketRoot, backups[0]), "utf8"), brokenContent);
  }
  check("损坏后安装记录以空处理（不误判已安装）", lib.hasInstalledRecord("owner/broken") === false, true);
  rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  delete process.env.DSH_HOME;
}

// ---- 场景 B：installed.json 不存在（首次运行）→ 无备份（正常路径）----
// 注：import 缓存单例——lib2 即场景 A 的同一模块（loadInstalled 只在模块级执行一次），
// 因此 B 的核心断言是「新目录下不生成备份 + 不崩溃」；空清单行为已由场景 A 覆盖。
{
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-load-missing-")).replace(/\\/g, "/");
  const marketRoot = join(process.env.DSH_HOME, "marketplace");
  mkdirSync(marketRoot, { recursive: true });
  const lib2 = await import("../../../lib/index.js");
  check("首次运行（无文件）不生成备份", readdirSync(marketRoot).filter((f) => f.startsWith("installed.json.corrupt-")).length, 0);
  check("首次运行空清单（同模块实例）", lib2.hasInstalledRecord("owner/x") === false, true);
  rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  delete process.env.DSH_HOME;
}

// ---- 场景 C（独立进程）：备份写盘失败 → 不抛异常（WARN 兜底，启动不被阻断）----
// loadInstalled 模块级只执行一次，备份失败场景无法与场景 A 同进程共存。
// Date.now 打桩固定备份名 → 预创建同名目录 → writeFile EISDIR → 触发备份失败分支。
{
  const script = `
Date.now = () => 123456789;
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-load-wfail-")).replace(/\\\\/g, "/");
const root = join(process.env.DSH_HOME, "marketplace");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "installed.json"), "{broken", "utf8");
mkdirSync(join(root, "installed.json.corrupt-123456789"), { recursive: true }); // 同名目录占位 → 写备份 EISDIR
await import("./lib/index.js");
rmSync(process.env.DSH_HOME, { recursive: true, force: true });
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT, encoding: "utf8", timeout: 30_000,
  });
  check("备份写盘失败不抛异常（loadInstalled 不崩溃）", child.status, 0);
  check("备份写盘失败 WARN 兜底提示（路径含于文案中）", /备份损坏的 .*installed\.json 失败/.test(child.stderr), true);
}

// ---- 场景 D（独立进程）：feedback.json / envs.json 损坏 → 同样备份 + 以空恢复（readStateJson 共用）----
// 契约退役前置（TDD）：loadFeedback/loadEnvStore 经 readStateJson 的损坏恢复
// 此前只有 security-guards 正则保证——行为断言落地后契约可退役（分层期减正则面）。
// 独立进程原因同场景 C：路径常量 import 时锁定，损坏恢复需隔离环境。
{
  const script = `
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-load-fbenv-")).replace(/\\\\\\\\/g, "/");
const root = join(process.env.DSH_HOME, "marketplace");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "feedback.json"), "{ broken feedback", "utf8");
writeFileSync(join(root, "envs.json"), "{ broken envs", "utf8");
const lib = await import("./lib/index.js");
const registered = [];
lib.apply({ get: (s) => (s === "webServer" ? { register: (r) => registered.push(r) } : undefined), logger: { warn: () => {} } });
// 等待 loadFeedback/loadEnvStore 异步读盘完成：fs.readFile 回调在 poll 阶段，
// setTimeout 在 timers 阶段先执行——固定延时是竞态，轮询备份文件出现
for (let i = 0; i < 60; i++) {
  if (readdirSync(root).some((f) => f.includes(".json.corrupt-"))) break;
  await new Promise((r) => setTimeout(r, 50));
}
const backups = readdirSync(root).filter((f) => /^(feedback|envs)\\.json\\.corrupt-/.test(f)).sort();
console.log("BACKUPS=" + backups.length);
const pendingHandler = registered.find((h) => h.path === "/api/marketplace/feedback/pending")?.handler;
let pBody = null;
if (pendingHandler) {
  await pendingHandler(
    { method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, socket: { remoteAddress: "127.0.0.1" }, url: "/api/marketplace/feedback/pending" },
    { writeHead: () => {}, end: (b) => { try { pBody = JSON.parse(b); } catch { pBody = null; } } },
  );
}
console.log("PENDING=" + JSON.stringify([pBody?.status, (pBody?.pending ?? []).length]));
rmSync(process.env.DSH_HOME, { recursive: true, force: true });
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT, encoding: "utf8", timeout: 30_000,
  });
  const backups = Number((child.stdout.match(/BACKUPS=(\d+)/) ?? [])[1] ?? -1);
  const pending = JSON.parse((child.stdout.match(/PENDING=(\[.*\])/) ?? [])[1] ?? "null");
  check("损坏 feedback/envs 生成 .corrupt-* 备份", backups, 2);
  check("损坏 feedback 后 pending 以空恢复", pending, ["done", 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
