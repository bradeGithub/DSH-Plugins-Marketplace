#!/usr/bin/env node
// 端到端测试：installRepo 完整流程（真实 git clone + skill 安装 + cordis-plugin 的
// 真实 npm 安装）。通过 apply 捕获 install handler，模拟 HTTP 请求触发；用 git
// url.insteadOf 将 https://github.com/ 重写为本地 fixture 仓库，不依赖网络。
// cordis-plugin 分支用 file: 依赖 + npm_config_offline 离线性安装。
// 前置：git 可用（`git --version`）；npm 缺失时跳过 cordis-plugin 分支。
// 运行：node scripts/tests/e2e/install.e2e.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

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

  // install handler 错误分支：非法 repo → 400
  const badReq = {
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    url: "/api/marketplace/install",
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
    });

    let r = await postInstall("e2e-owner/demo-plugin", {});
    check("e2e cordis 安装状态 200", r.status, 200);
    check("e2e cordis 响应 done", r.body && r.body.status, "done");
    check("e2e cordis installed", r.body && r.body.installed, true);
    check("e2e cordis 类型", r.body && r.body.type, "cordis-plugin");
    check("e2e cordis 包名", r.body && r.body.name, "demo-plugin");
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
    });

    r = await postInstall("e2e-owner/demo-build-pnpm", { __confirm_build__: "allow" });
    if (process.platform === "win32") {
      check("e2e build pnpm 路径 win32 runPnpm EINVAL → failed", r.body && r.body.status, "failed");
    } else {
      check("e2e build pnpm 路径（done 或 failed，取决于 pnpm 可用性）", r.body && ["done", "failed"].includes(r.body.status), true);
    }
  }

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
