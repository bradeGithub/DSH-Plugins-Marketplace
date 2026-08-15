#!/usr/bin/env python3
"""Replay v1.3.13 test & changelog changes (issues #10/#11/#12). Run after apply-v1313.py."""
import pathlib, sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

def edit(rel, pairs):
    p = ROOT / rel
    s = p.read_text(encoding="utf-8")
    for old, new in pairs:
        assert s.count(old) == 1, f"{rel}: pattern not unique/found: {old[:60]!r} (count={s.count(old)})"
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")

# ───────────────── scripts/tests/integration/lib.test.mjs ─────────────────
edit("scripts/tests/integration/lib.test.mjs", [
('import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";',
 'import { mkdtempSync, mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";\nimport { fileURLToPath } from "node:url";'),
('import { join } from "node:path";',
 'import { join, dirname } from "node:path";'),
# search-fallback coverage: temporarily move bundled index away
('''  // fetchJson 错误路径（fetchJson 未导出，经 fetchAllRepos 内部触发）：
  // 所有 registry 源返回 403 → 回退搜索 API → fetchJson 抛错被捕获（含
  // res.text() 失败时的 .catch(() => "") 分支）→ 降级返回空数组。
  const orig5 = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => { throw new Error("text boom"); } });
  const degraded = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig5;
  check("fetchAllRepos 全失败降级空数组", Array.isArray(degraded) && degraded.length === 0, true);''',
'''  // fetchJson 错误路径（fetchJson 未导出，经 fetchAllRepos 内部触发）：
  // 所有 registry 源返回 403 → （内置索引存在会先兜底，#12——临时移开以覆盖
  // 更深层路径）→ 磁盘缓存（空）→ 搜索 API → fetchJson 抛错被捕获（含
  // res.text() 失败时的 .catch(() => "") 分支）→ 降级返回空数组。
  const bundledDsh = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "registry.json");
  renameSync(bundledDsh, bundledDsh + ".bak");
  try {
    const orig5 = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => { throw new Error("text boom"); } });
    const degraded = await lib.fetchAllRepos("dsh");
    globalThis.fetch = orig5;
    check("fetchAllRepos 全失败降级空数组", Array.isArray(degraded) && degraded.length === 0, true);
  } finally {
    renameSync(bundledDsh + ".bak", bundledDsh);
  }'''),
# readBundledIndex + #10/#11 regression block before final summary
('''  console.log(`\\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();''',
'''  // ---- readBundledIndex（#12）：随包内置索引可读、去重、排除本体 ----
  {
    const bundled = await lib.readBundledIndex("dsh");
    check("readBundledIndex dsh 非空", Array.isArray(bundled) && bundled.length > 100, true);
    check("readBundledIndex 排除本体", bundled.some((r) => r.name === "deepseek-harness"), false);
    const names = bundled.map((r) => r.full_name);
    check("readBundledIndex 去重", new Set(names).size === names.length, true);
    const bundledSkills = await lib.readBundledIndex("skills");
    check("readBundledIndex skills 非空", Array.isArray(bundledSkills) && bundledSkills.length > 1000, true);
  }

  // ==================== #10 / #11 回归 ====================
  // ---- parseGitmodulesUrls（纯函数）：https 与相对路径放行，file:// / git@ / git:// 拒绝 ----
  {
    const gm = '[submodule "a"]\\n\\tpath = upstream/a\\n\\turl = https://github.com/o/a.git\\n'
      + '[submodule "b"]\\n\\tpath = upstream/b\\n\\turl = ../b.git\\n';
    const ok = lib.parseGitmodulesUrls(gm);
    check("gitmodules https+相对路径 urls", ok.urls.length, 2);
    check("gitmodules https+相对路径 unsafe 为空", ok.unsafe, []);
    const bad = lib.parseGitmodulesUrls('[submodule "x"]\\n\\turl = file:///etc/passwd\\n[submodule "y"]\\n\\turl = git@github.com:o/y.git\\n');
    check("gitmodules file/git@ 被拒绝", bad.unsafe, ["file:///etc/passwd", "git@github.com:o/y.git"]);
    check("gitmodules 空文本", lib.parseGitmodulesUrls(""), { urls: [], unsafe: [] });
    check("gitmodules null 入参", lib.parseGitmodulesUrls(null), { urls: [], unsafe: [] });
  }

  // ---- detectType 分层判定 + findSkillRoots vendored 跳过（#11 fixture 回归）----
  const dtBase = join(process.env.DSH_HOME, "detecttype-fixtures");
  const mkFixture = (name, files) => {
    const root = join(dtBase, name);
    for (const [rel, content] of Object.entries(files)) {
      const f = join(root, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content, "utf8");
    }
    return root;
  };
  const DSH_PLUGIN_PKG = JSON.stringify({ name: "demo", version: "1.0.0", dsh: { client: { platform: "web", inject: [], immediately: true } } });
  // 1. 插件仓库 + vendored 子模块里的上游技能（oh-dsh 形态）→ cordis-plugin（修复前误判 skill）
  check("detectType 插件+vendored技能 → cordis-plugin",
    await lib.detectType(mkFixture("oh-dsh-like", {
      "package.json": DSH_PLUGIN_PKG,
      "upstream/dsh-tui/skills/audit/SKILL.md": "---\\nname: audit\\n---\\n",
      "upstream/dsh-tui/skills/review/SKILL.md": "---\\nname: review\\n---\\n"
    })), "cordis-plugin");
  // 2. 纯 skill 仓库带工具链 package.json（无 dsh 声明）→ skill（分层判定不能翻转为插件）
  check("detectType skill+工具package.json → skill",
    await lib.detectType(mkFixture("skill-with-tooling", {
      "package.json": JSON.stringify({ name: "skill-docs", scripts: { lint: "echo ok" } }),
      "SKILL.md": "---\\nname: my-skill\\n---\\n"
    })), "skill");
  // 3. 嵌套技能集合仓库（无 package.json）→ skill
  check("detectType 嵌套技能集合 → skill",
    await lib.detectType(mkFixture("skill-collection", {
      "skills/a/SKILL.md": "---\\nname: a\\n---\\n",
      "skills/b/SKILL.md": "---\\nname: b\\n---\\n"
    })), "skill");
  // 4. 非插件 package.json（无 SKILL.md）→ cordis-plugin（保留非插件确认弹窗路径）
  check("detectType 非插件package.json → cordis-plugin",
    await lib.detectType(mkFixture("plain-npm", {
      "package.json": JSON.stringify({ name: "plain-project" })
    })), "cordis-plugin");
  // 5. 皮肤/多包仓库（根无清单，子目录有插件清单）→ cordis-plugin（原行为保留）
  check("detectType 皮肤多包 → cordis-plugin",
    await lib.detectType(mkFixture("skins-like", {
      "skins/dark/package.json": DSH_PLUGIN_PKG,
      "README.md": "# skins"
    })), "cordis-plugin");
  // 6. 仅 vendored 目录含 SKILL.md（无 package.json）→ instructions（技能是上游的，不算本仓库内容）
  check("detectType 仅vendored技能 → instructions",
    await lib.detectType(mkFixture("vendored-only", {
      "upstream/x/SKILL.md": "---\\nname: x\\n---\\n",
      "README.md": "# readme"
    })), "instructions");
  check("findSkillRoots 跳过 upstream/", (await lib.findSkillRoots(join(dtBase, "vendored-only"))).length, 0);

  console.log(`\\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();'''),
])

# ───────────────── scripts/tests/e2e/install.e2e.mjs ─────────────────
edit("scripts/tests/e2e/install.e2e.mjs", [
('import { execFileSync } from "node:child_process";',
 'import { execFileSync } from "node:child_process";\nimport { fileURLToPath } from "node:url";'),
('import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";',
 'import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from "node:fs";'),
('''  // ---- 列表磁盘缓存兜底：fetch 全部返回空（模拟三源全挂）时，
  //      优先返回本地缓存（上次成功索引），而不是搜索 API 的残缺结果；
  //      无缓存时才走搜索兜底。----
  const cacheDir2 = join(HOME, "marketplace", "list-cache");
  mkdirSync(cacheDir2, { recursive: true });
  const cachedRepo = { full_name: "cached-owner/demo-cached", name: "demo-cached", description: "cached", html_url: "https://github.com/cached-owner/demo-cached", stargazers_count: 5, updated_at: "2026-01-01T00:00:00Z", default_branch: "main", topics: [], license: null, pkg_name: null, version: null, category: null, has_skill: false, has_install_script: false };
  writeFileSync(join(cacheDir2, "dsh.json"), JSON.stringify({ saved_at: new Date().toISOString(), kind: "dsh", count: 1, repos: [cachedRepo] }), "utf8");
  const cachedList = await lib.fetchAllRepos("dsh");
  check("e2e 磁盘缓存兜底返回缓存条目", cachedList.some((r) => r.full_name === "cached-owner/demo-cached"), true);

  rmSync(join(cacheDir2, "dsh.json"), { force: true });
  const searchFallback = await lib.fetchAllRepos("dsh");
  check("e2e 无缓存时搜索兜底返回空数组", Array.isArray(searchFallback), true);
  const skillCacheDir = join(HOME, "marketplace", "list-cache");
  writeFileSync(join(skillCacheDir, "skills.json"), JSON.stringify({ saved_at: new Date().toISOString(), kind: "skills", count: 2, repos: [cachedRepo, { ...cachedRepo, full_name: "cached-owner/demo-cached-2", name: "demo-cached-2" }] }), "utf8");
  const cachedSkills = await lib.fetchAllRepos("skills");
  check("e2e skills 磁盘缓存兜底 2 条", cachedSkills.length, 2);
  rmSync(join(skillCacheDir, "skills.json"), { force: true });''',
'''  // ---- 列表兜底顺序（#12）：网络源全挂（本 e2e 无网络 mock，fetch 恒失败）→
  //      内置索引（随包分发，真实 registry.json/skills.json）→ 磁盘缓存 → 搜索兜底。
  //      磁盘缓存用例需临时移开内置文件才能覆盖该层；fire-and-forget 的缓存落盘
  //      用短暂等待规避竞态。----
  const cacheDir2 = join(HOME, "marketplace", "list-cache");
  mkdirSync(cacheDir2, { recursive: true });
  const cachedRepo = { full_name: "cached-owner/demo-cached", name: "demo-cached", description: "cached", html_url: "https://github.com/cached-owner/demo-cached", stargazers_count: 5, updated_at: "2026-01-01T00:00:00Z", default_branch: "main", topics: [], license: null, pkg_name: null, version: null, category: null, has_skill: false, has_install_script: false };
  const bundledDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const bundledDsh = join(bundledDir, "registry.json");
  const bundledSkills = join(bundledDir, "skills.json");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) dsh 网络全挂 → 内置索引兜底（不含假缓存条目，条目数为真实量级）
  const bundledList = await lib.fetchAllRepos("dsh");
  check("e2e dsh 网络全挂回退内置索引", bundledList.length > 100 && !bundledList.some((r) => r.full_name === "cached-owner/demo-cached"), true);
  await sleep(500); // 等待 bundled 分支的磁盘缓存落盘完成，避免与下面重写缓存文件交错

  // 2) 内置索引缺失（临时移开）→ 磁盘缓存兜底
  renameSync(bundledDsh, bundledDsh + ".bak");
  try {
    writeFileSync(join(cacheDir2, "dsh.json"), JSON.stringify({ saved_at: new Date().toISOString(), kind: "dsh", count: 1, repos: [cachedRepo] }), "utf8");
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
  await sleep(500);

  // 5) skills 内置缺失（临时移开）→ 磁盘缓存兜底
  renameSync(bundledSkills, bundledSkills + ".bak");
  try {
    writeFileSync(join(cacheDir2, "skills.json"), JSON.stringify({ saved_at: new Date().toISOString(), kind: "skills", count: 2, repos: [cachedRepo, { ...cachedRepo, full_name: "cached-owner/demo-cached-2", name: "demo-cached-2" }] }), "utf8");
    const cachedSkills = await lib.fetchAllRepos("skills");
    check("e2e skills 磁盘缓存兜底 2 条", cachedSkills.length, 2);
  } finally {
    renameSync(bundledSkills + ".bak", bundledSkills);
  }
  rmSync(join(cacheDir2, "skills.json"), { force: true });'''),
])

# ───────────────── CHANGELOG.md ─────────────────
cl = ROOT / "CHANGELOG.md"
s = cl.read_text(encoding="utf-8")
entry = """---

## v1.3.13 — 2026-08-15（子模块安装 + 类型识别分层 + Skills 内置索引 / Submodule install + layered type detection + bundled skills index）

- **git submodule 插件安装修复（#10）**：克隆后检测 `.gitmodules`，存在即递归拉取子模块（`--depth 1`），修复 oh-dsh 等以子模块组织源码的插件构建失败（`Could not resolve upstream/*/src/index.ts`）；子模块地址做安全校验——仅放行 https 与相对路径，`file://` 等协议直接拒绝安装（本地文件泄露防护），并显式禁用 file 协议兜底 / clone now detects `.gitmodules` and initializes submodules recursively, fixing build failures for submodule-based plugins like oh-dsh; submodule URLs are validated (https / relative only, `file://` rejected) with the file protocol explicitly disabled
- **安装类型识别分层重构（#11）**：`detectType` 不再把 skill 检测放在全局最高优先——改为 预设/脚本 → 根 package.json 声明 DSH 能力 → 根 SKILL.md → 嵌套插件根 → 嵌套技能根 的分层判定；SKILL.md 与 package.json 共存的插件仓库（如 oh-dsh）不再被误判为 skill 而漏装插件本体，带工具链 package.json 的纯 skill 仓库也不会反向误判；`findSkillRoots` 新增 vendored 目录跳过（upstream/vendor/third_party 等，子模块上游技能不算本仓库分发内容）/ `detectType` is now layered instead of skill-first: repos with a DSH-capable package.json are no longer misjudged as skills (which skipped the plugin itself), while pure skill repos with tooling package.json stay skills; `findSkillRoots` skips vendored dirs (upstream/vendor/third_party/...)
- **Skills 栏目内置索引兜底（#12）**：skills 列表默认直读随包分发的 skills.json（秒开、离线可用），点「刷新」仍走网络源获取最新；修复 12MB skills.json 撞 15s 硬超时导致栏目刷不出来/数据残缺的问题；前端新增「内置索引」数据源提示条 / the skills tab now reads the bundled skills.json by default (instant, offline-ready) with Refresh still hitting network sources; fixes the 12MB index hitting the 15s timeout; a new "bundled" data-source banner is shown
- **搜索兜底不再污染磁盘缓存（#12 根因）**：搜索 API 的残缺结果（单 query 上限 1000 条）不再写入磁盘缓存，避免把上次成功的完整索引降级 / partial search-API fallback results no longer overwrite the last good full index on disk
- **回归测试**：新增 19 条用例（.gitmodules 地址校验、detectType 六种形态、vendored 跳过、内置索引可读/去重/排除本体、兜底顺序、搜索不污染缓存），e2e 与集成的 3 条缓存兜底用例适配内置索引层（临时移开内置文件以覆盖更深层路径）/ 19 new regression cases covering gitmodules URL validation, six detectType shapes, vendored-dir skipping, bundled index integrity, fallback ordering and no search-cache pollution; 3 cache-fallback cases adapted to the bundled-index tier
- 致谢 / Thanks: @lws2004（#10 #11 报告与补丁草案）、@GangCLiu（#12 报告与完整补丁）
"""
marker = "\n---\n\n## v1.3.12"
assert marker in s, "changelog marker missing"
s = s.replace(marker, entry + "\n---\n\n## v1.3.12", 1)
cl.write_text(s, encoding="utf-8")

print("tests & changelog patched")
