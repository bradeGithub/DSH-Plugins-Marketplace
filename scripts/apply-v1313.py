#!/usr/bin/env python3
"""Replay all v1.3.13 fixes onto a pristine checkout (issues #10/#11/#12).
Usage: python3 scripts/apply-v1313.py <repo-root>
Every replacement asserts exactly one match — any drift fails loudly."""
import pathlib, sys, json

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

def edit(rel, pairs):
    p = ROOT / rel
    s = p.read_text(encoding="utf-8")
    for old, new in pairs:
        assert s.count(old) == 1, f"{rel}: pattern not unique/found: {old[:60]!r} (count={s.count(old)})"
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")

# ───────────────────────── lib/index.js ─────────────────────────
edit("lib/index.js", [
# 0. import fileURLToPath
('import { homedir } from "node:os";\nimport { createRequire } from "node:module";',
 'import { homedir } from "node:os";\nimport { createRequire } from "node:module";\nimport { fileURLToPath } from "node:url";'),
# 1a. messages zh
('    "cloneDone": "克隆完成。",',
 '    "cloneDone": "克隆完成。",\n    "submoduleDone": "检测到 git 子模块，已递归拉取。",\n    "submoduleUnsafe": "子模块地址不安全（仅允许 https 或相对路径）: {urls}",'),
# 1b. messages en
('    "cloneDone": "Clone complete.",',
 '    "cloneDone": "Clone complete.",\n    "submoduleDone": "Git submodules detected — initialized recursively.",\n    "submoduleUnsafe": "Unsafe submodule URLs (only https or relative paths allowed): {urls}",'),
# 2. parseGitmodulesUrls helper after readLifecycleScripts
('''    return ["preinstall", "install", "postinstall", "prepare"]
      .filter((name) => typeof scripts[name] === "string" && scripts[name].length > 0);
  } catch { /* 无 package.json 或解析失败 */ }
  return [];
}''',
'''    return ["preinstall", "install", "postinstall", "prepare"]
      .filter((name) => typeof scripts[name] === "string" && scripts[name].length > 0);
  } catch { /* 无 package.json 或解析失败 */ }
  return [];
}

/**
 * 解析 .gitmodules 中的全部子模块 url（纯函数），并做安全校验（#10）：
 * 只放行 https:// 与相对路径（./ ../，相对 origin 解析）；含 scheme 分隔符 ":"
 * 的非 https 地址（file://、git@、git://、ssh:// 等）一律拒绝——file:// 子模块可
 * 读取宿主机任意路径并纳入构建，属于本地文件泄露入口。
 * 返回 { urls, unsafe }：urls 为全部地址，unsafe 为被拒绝的地址（为空才允许拉取）。
 */
function parseGitmodulesUrls(text) {
  const urls = [];
  for (const m of String(text ?? "").matchAll(/^\\s*url\\s*=\\s*(\\S+)\\s*$/gm)) urls.push(m[1]);
  const unsafe = urls.filter((u) => u.includes(":") && !u.startsWith("https://"));
  return { urls, unsafe };
}'''),
# 3. submodule init after cloneDone in install handler
('''            await rm(cacheDir, { recursive: true, force: true });
            await execFileAsync("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, cacheDir], { timeout: 180000 });
            logLine(t(langFull, "cloneDone"));''',
'''            await rm(cacheDir, { recursive: true, force: true });
            await execFileAsync("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, cacheDir], { timeout: 180000 });
            logLine(t(langFull, "cloneDone"));
            // #10：含 git submodule 的仓库（如 oh-dsh 的 upstream/*）克隆后子模块是空目录，
            // 构建引用子模块源码（upstream/<pkg>/src/index.ts）必然失败——递归拉取。
            // 仅当 .gitmodules 存在时执行（99% 的仓库无子模块，省一次进程开销）；
            // 地址先过安全校验（仅 https / 相对路径），并显式禁止 file 协议兜底。
            if (await exists(join(cacheDir, ".gitmodules"))) {
              const gm = await readFile(join(cacheDir, ".gitmodules"), "utf8").catch(() => "");
              const { unsafe } = parseGitmodulesUrls(gm);
              if (unsafe.length > 0) throw new Error(t(langFull, "submoduleUnsafe", { urls: unsafe.join(", ") }));
              await execFileAsync("git", ["-c", "protocol.file.allow=never", "submodule", "update", "--init", "--recursive", "--depth", "1"], { cwd: cacheDir, timeout: 180000 });
              logLine(t(langFull, "submoduleDone"));
            }'''),
# 4a. vendored dir names const before findSkillRoots
('''/** Find root and nested Agent Skills without following symlinks or dependency caches. */
async function findSkillRoots(cacheDir, maxDepth = 5, limit = 200) {''',
'''/**
 * vendored 目录惯例命名（小写）：git submodule / 第三方源码常见目录。
 * findSkillRoots 跳过这些目录——其中的 SKILL.md 是上游项目的内容，不是本仓库分发的技能。
 */
const VENDORED_DIR_NAMES = new Set(["upstream", "vendor", "vendored", "third_party", "third-party", "external", "deps"]);

/** Find root and nested Agent Skills without following symlinks or dependency caches. */
async function findSkillRoots(cacheDir, maxDepth = 5, limit = 200) {'''),
# 4b. vendored skip in walk
('''      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await walk(join(dir, entry.name), depth + 1);
      if (roots.length >= limit) return;
    }
  };
  await walk(cacheDir, 0);
  return roots;
}

async function readSkillManifest(skillRoot) {''',
'''      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      // #11：跳过 vendored 目录（git submodule / 第三方源码惯例命名，如 oh-dsh 的
      // upstream/DSH-better-sidebar）——其中的 SKILL.md 属于上游项目自带内容，
      // 不是本仓库要向用户分发的技能，扫到会把插件仓库误判为 skill。
      if (VENDORED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
      await walk(join(dir, entry.name), depth + 1);
      if (roots.length >= limit) return;
    }
  };
  await walk(cacheDir, 0);
  return roots;
}

async function readSkillManifest(skillRoot) {'''),
# 5. detectType layered rewrite
('''async function detectType(cacheDir) {
  const has = (p) => exists(join(cacheDir, p));
  if ((await findSkillRoots(cacheDir, 5, 1)).length > 0) return "skill";
  if ((await has("preset.yml")) && (await has("agent.cordis.yml"))) return "agent-preset";
  if (await has("install.ps1")) return "script";
  if (await has("install.sh")) return "script";
  if (await has("package.json")) return "cordis-plugin";
  // 皮肤/多包仓库：根目录无清单但子目录含插件 → 同样按 cordis-plugin 安装（逐个安装子包）
  if ((await findPluginRoots(cacheDir)).length > 0) return "cordis-plugin";
  return "instructions";
}''',
'''/**
 * 安装类型识别（#11 分层判定，勿简单地把某一类提为全局最高优先）：
 * 1. agent 预设 / 安装脚本：特征文件明确，最优先；
 * 2. 根 package.json 声明 DSH 插件能力 → cordis-plugin——插件仓库附带的技能
 *    （含子模块里的上游技能，如 oh-dsh 的 upstream/* 下的 skills/*）不应让整个
 *    仓库被误判为 skill 而漏装插件本体；
 * 3. 根目录 SKILL.md → skill——仓库本体就是技能；带工具链 package.json（未声明
 *    DSH 能力）的纯 skill 仓库在此归位，不会被误判为插件；
 * 4. 嵌套插件根（皮肤/多包仓库）→ cordis-plugin；
 * 5. 嵌套技能根（技能集合仓库）→ skill；
 * 6. 其余 → instructions（手动安装弹窗）。
 */
async function detectType(cacheDir) {
  const has = (p) => exists(join(cacheDir, p));
  if ((await has("preset.yml")) && (await has("agent.cordis.yml"))) return "agent-preset";
  if (await has("install.ps1")) return "script";
  if (await has("install.sh")) return "script";
  if (await has("package.json")) {
    if ((await looksLikeDshPlugin(await readPackageJsonObject(cacheDir))) === true) return "cordis-plugin";
    // maxDepth=0：仅根目录的技能清单（大小写不敏感，复用 findSkillRoots 的判定）
    if ((await findSkillRoots(cacheDir, 0, 1)).length > 0) return "skill";
    // 非插件 package.json（聚合页/桌面应用/普通 npm 项目）：仍按 cordis-plugin 走，
    // 安装流程里的「非插件确认」弹窗会拦下盲装（原行为保留）。
    return "cordis-plugin";
  }
  if ((await findSkillRoots(cacheDir, 0, 1)).length > 0) return "skill";
  // 皮肤/多包仓库：根目录无清单但子目录含插件 → 同样按 cordis-plugin 安装（逐个安装子包）
  if ((await findPluginRoots(cacheDir)).length > 0) return "cordis-plugin";
  if ((await findSkillRoots(cacheDir, 5, 1)).length > 0) return "skill";
  return "instructions";
}'''),
# 6. writeListCache docstring
('''/** 写磁盘缓存（仅写完整索引；搜索兜底只有无缓存时才落盘，避免用残缺结果降级好缓存）。 */
async function writeListCache(kind, repos) {''',
'''/** 写磁盘缓存。只在完整索引（registry / bundled）成功时调用——搜索兜底结果天然
 *  残缺（Search API 单 query 上限 1000 条），落盘会把好缓存降级成残缺索引（#12）。 */
async function writeListCache(kind, repos) {'''),
# 7. fetchAllRepos rewrite with bundled index
('''/**
 * 拉取 kind 的全部仓库（dsh：topic:dsh-plugin；skills：agent-skills ∪ claude-skills）：
 * registry 索引优先（api/raw/CDN 三源），失败 → 磁盘缓存（上次成功的完整索引），
 * 再退搜索 API（天然不全，仅应急）。去重并排除 DSH 本体后按 Star 数从高到低排序。
 * 注意：pkg_name 冲突消解不在数据层做——「已安装优先」必须等 detectInstalled
 * （含 profile/repository 匹配）跑完才能判定，提前去重会隐藏用户手动安装的
 * 低 Star 仓库（见列表处理器里的 dedupeReposByPkgName）。
 */
async function fetchAllRepos(kind = "dsh") {
  const fromRegistry = await fetchRegistryRepos(kind);
  if (fromRegistry) {
    listSources[kind] = "registry";
    writeListCache(kind, fromRegistry); // 不 await：落盘失败不影响响应
    fromRegistry.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
    return fromRegistry;
  }
  const fromDisk = await readListCache(kind);
  if (fromDisk) {
    listSources[kind] = "cache";
    console.warn(`[dsh-plugin-marketplace] 索引网络源全部失败，使用本地磁盘缓存（${kind}，${fromDisk.length} 条）`);
    fromDisk.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
    return fromDisk;
  }
  const fromSearch = await fetchSearchRepos(kind);
  if (fromSearch && fromSearch.length > 0) writeListCache(kind, fromSearch);
  listSources[kind] = "search";
  fromSearch.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
  return fromSearch;
}''',
'''/**
 * 插件包内置索引（registry.json / skills.json 随包分发）：无网络依赖的可靠兜底（#12）。
 * skills.json 已超 12MB（12000+ 仓库），慢网/代理环境常撞 FETCH_TIMEOUT_MS 硬超时，
 * 回退搜索 API 只剩残缺结果。内置索引秒读且全量；「刷新」仍走网络源获取最新。
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
async function readBundledIndex(kind) {
  try {
    const data = JSON.parse(await readFile(join(MODULE_DIR, "..", kind === "skills" ? "skills.json" : "registry.json"), "utf8"));
    if (!data || !Array.isArray(data.repos)) return null;
    const seen = new Set();
    const collected = [];
    for (const r of data.repos) {
      if (!r || typeof r.full_name !== "string") continue;
      if (seen.has(r.full_name)) continue;
      seen.add(r.full_name);
      if (EXCLUDED_REPO_NAMES.has(r.name)) continue;
      collected.push(normalizeRepo(r));
    }
    return collected.length > 0 ? collected : null;
  } catch { /* 内置文件缺失/损坏（如手动裁剪安装） */ }
  return null;
}

/**
 * 拉取 kind 的全部仓库（dsh：topic:dsh-plugin；skills：agent-skills ∪ claude-skills）：
 * - skills 默认直读随包内置索引（秒开、离线可用，#12），force（点「刷新」）才先走网络源；
 * - dsh 与 force 刷新：registry 索引优先（api/raw/CDN 多源），失败 → 内置索引 →
 *   磁盘缓存（上次成功的完整索引）→ 搜索 API（天然不全，仅应急，且不再落盘污染缓存）。
 * 去重并排除 DSH 本体后按 Star 数从高到低排序。
 * 注意：pkg_name 冲突消解不在数据层做——「已安装优先」必须等 detectInstalled
 * （含 profile/repository 匹配）跑完才能判定，提前去重会隐藏用户手动安装的
 * 低 Star 仓库（见列表处理器里的 dedupeReposByPkgName）。
 */
async function fetchAllRepos(kind = "dsh", force = false) {
  if (force || kind !== "skills") {
    const fromRegistry = await fetchRegistryRepos(kind);
    if (fromRegistry) {
      listSources[kind] = "registry";
      writeListCache(kind, fromRegistry); // 不 await：落盘失败不影响响应
      fromRegistry.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
      return fromRegistry;
    }
  }
  const fromBundled = await readBundledIndex(kind);
  if (fromBundled) {
    listSources[kind] = "bundled";
    writeListCache(kind, fromBundled); // 让磁盘缓存也持有完整索引
    fromBundled.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
    return fromBundled;
  }
  const fromDisk = await readListCache(kind);
  if (fromDisk) {
    listSources[kind] = "cache";
    console.warn(`[dsh-plugin-marketplace] 索引网络源与内置索引均不可用，使用本地磁盘缓存（${kind}，${fromDisk.length} 条）`);
    fromDisk.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
    return fromDisk;
  }
  // #12：搜索兜底结果不写磁盘缓存——残缺结果会把上次成功的完整索引降级。
  const fromSearch = await fetchSearchRepos(kind);
  listSources[kind] = "search";
  fromSearch.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
  return fromSearch;
}'''),
# 8. getList passes force
('listFetchings[kind] = fetchAllRepos(kind)',
 'listFetchings[kind] = fetchAllRepos(kind, force)'),
# 9. exports
('findSkillRoots, findPluginRoots, detectType, dedupeReposByPkgName',
 'findSkillRoots, findPluginRoots, detectType, parseGitmodulesUrls, readBundledIndex, dedupeReposByPkgName'),
])

# ───────────────────────── lib/client.js ─────────────────────────
edit("lib/client.js", [
('      dataSourceSearch: "⚠ 网络索引源不可用，当前为搜索兜底结果（不完整）",',
 '      dataSourceSearch: "⚠ 网络索引源不可用，当前为搜索兜底结果（不完整）",\n      dataSourceBundled: "当前显示插件内置索引（离线可用；点「刷新」获取最新）",'),
('      dataSourceSearch: "⚠ index sources unreachable — showing partial search results",',
 '      dataSourceSearch: "⚠ index sources unreachable — showing partial search results",\n      dataSourceBundled: "Showing the bundled index (offline-ready; click Refresh for the latest)",'),
])

# banner 条件（两处相同，逐个替换）
p = ROOT / "lib/client.js"
s = p.read_text(encoding="utf-8")
banner_old = '(dataSource === "cache" || dataSource === "search") ? h("p", { style: s.srcHint }, t(dataSource === "cache" ? "dataSourceCache" : "dataSourceSearch")) : null,'
banner_new = '(dataSource === "cache" || dataSource === "search" || dataSource === "bundled") ? h("p", { style: s.srcHint }, t(dataSource === "cache" ? "dataSourceCache" : (dataSource === "search" ? "dataSourceSearch" : "dataSourceBundled"))) : null,'
assert s.count(banner_old) == 2, f"client.js banner count={s.count(banner_old)}"
s = s.replace(banner_old, banner_new)
p.write_text(s, encoding="utf-8")

# ───────────────────────── package.json ─────────────────────────
pkg = ROOT / "package.json"
d = json.loads(pkg.read_text(encoding="utf-8"))
assert d["version"] == "1.3.12", f"unexpected version {d['version']}"
d["version"] = "1.3.13"
pkg.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

print("core files patched (index/client/package). Tests & changelog are applied by apply-v1313-tests.py")
