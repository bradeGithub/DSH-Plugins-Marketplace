// 仓库标识归一化与 slug（分层重构：纯函数域，零 IO 零宿主依赖）。
// normalizeRepoRef/slugify 被 lib 全域引用；build-registry.mjs 可共享（双轨合并面）。

/** 插件分类白名单（与 build-registry.mjs 的 CATEGORY_RULES id 及 client.js CATEGORY_KEYS 对齐）。 */
const CATEGORY_KEYS = new Set(["vision", "document", "memory", "model", "notify", "coding", "conversation", "web-ui", "agent", "tool", "resource", "other"]);

/**
 * 归一化 GitHub 仓库标识（repository 字段或 full_name）为小写 owner/repo。
 * 兼容 https://github.com/owner/repo(.git)、git+https://…、git@github.com:… 等写法。
 */
function normalizeRepoRef(url) {
  if (typeof url !== "string") return null;
  // 性质测试发现：.git 剥离必须在 # 片段分割之后——"Owner/Repo.git#main" 的 $ 锚点
  // 被片段末尾挡住，先剥 .git 会残留（首过 "owner/repo.git" 非幂等 → installedKey 不一致）
  let s = url.trim()
    .replace(/^git\+/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .split("#")[0]
    .replace(/\.git$/i, "");
  return s.toLowerCase() || null;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}

/** win32 下 PATH 的 bash 可能是 WSL（C:\Windows\system32\bash.exe）：WSL 是真实 Linux
 *  bash，不认 `D:\...` 反斜杠路径（反斜杠转义吞掉 → 127 找不到文件）；Git Bash（MSYS）
 *  argv 层自动路径转换无需处理。把 Windows 路径转为 WSL 标准挂载点 /mnt/<盘>/... */
function wslPosixPath(p) {
  const m = /^([A-Za-z]):\\(.*)$/.exec(String(p ?? ""));
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : String(p ?? "");
}

function normalizeRegistryRepo(r) {
  return {
    full_name: r.full_name,
    name: r.name,
    description: r.description,
    html_url: r.html_url,
    stargazers_count: r.stargazers_count,
    updated_at: r.updated_at,
    default_branch: r.default_branch ?? "main",
    topics: r.topics ?? [],
    license: r.license?.spdx_id ?? null,
    fork: r.fork === true,
    archived: r.archived === true
  };
}

/** 归一化仓库元数据（兼容搜索 API 与 registry.json 两种字段形态）；html_url 只放行 https://github.com 链接。
 *  kind="skills" 时才保留 has_skill/has_install_script 三态（true/false/null 未知）；
 *  其他来源（插件市场 registry / 搜索兜底）没有探测字段——不写该字段（undefined），
 *  避免前端把「无探测数据」误判成「未验证」显示满屏徽章。 */
function normalizeRepo(r, kind = "dsh") {
  let htmlUrl = null;
  try {
    const u = new URL(String(r.html_url ?? ""));
    if (u.protocol === "https:" && u.host === "github.com") htmlUrl = u.href;
  } catch { /* 非法 URL 置空，客户端不渲染链接 */ }
  const out = {
    full_name: r.full_name,
    name: r.name,
    description: r.description,
    html_url: htmlUrl,
    stargazers_count: r.stargazers_count,
    updated_at: r.updated_at,
    default_branch: r.default_branch ?? "main",
    topics: r.topics ?? [],
    license: typeof r.license === "string" ? r.license : (r.license?.spdx_id ?? null),
    pkg_name: typeof r.pkg_name === "string" && r.pkg_name.length > 0 ? r.pkg_name : null,
    // registry.json 的版本号字段（构建期从仓库 package.json 抓取，供「更新」检测；
    // 搜索 API 兜底 / 无 package.json 的仓库没有 → null）
    version: typeof r.version === "string" && r.version.length > 0 ? r.version : null,
    // v1.4.11（issue #26）：npm 发布版本与真实包名——npm 型 cli 的升级提示数据源
    // （monorepo / npm 发布型插件根 package.json version 常年不 bump，以 npm dist-tags 为准）
    npm_version: typeof r.npm_version === "string" && r.npm_version.length > 0 ? r.npm_version : null,
    npm_pkg_name: typeof r.npm_pkg_name === "string" && r.npm_pkg_name.length > 0 ? r.npm_pkg_name : null,
    // registry.json 的分类字段（搜索 API 兜底没有 → null，客户端按「其他」处理）
    category: typeof r.category === "string" && CATEGORY_KEYS.has(r.category) ? r.category : null,
    // 构建期盖章字段必须透传：market_tags（人工验证徽章）与 installable（手动/非插件提示）
    market_tags: Array.isArray(r.market_tags) && r.market_tags.length > 0 ? [...r.market_tags] : undefined,
    installable: r.installable === "manual" || r.installable === "non-plugin" ? r.installable : undefined
  };
  // skills 索引字段（仅 skills 模式；registry / 搜索兜底不写，前端不显示「未验证」）
  if (kind === "skills") {
    out.has_skill = r.has_skill === true ? true : (r.has_skill === false ? false : null);
    out.has_install_script = r.has_install_script === true ? true : (r.has_install_script === false ? false : null);
  }
  return out;
}

export { slugify, normalizeRepoRef, normalizeRepo, normalizeRegistryRepo, wslPosixPath, CATEGORY_KEYS };
