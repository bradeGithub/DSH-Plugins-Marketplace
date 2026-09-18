// 列表组合纯逻辑域（分层重构：纯函数，零 IO 零宿主依赖）。
// dedupeReposByPkgName 被 list handler 和 build-registry.mjs 共享。

/**
 * 同名包去重（pkg_name 冲突）：同一 npm 包名出现多个仓库时，保留已安装或高星条目。
 * 分组键：有 pkg_name → `pkg:${pkg_name}`（npm 唯一约束）；无 pkg_name → `repo:${full_name}`（不去重）。
 * 排序权重：已安装 +1e12（保底优先）+ stars 数值；NaN stars 按 0 处理（性质测试发现 NaN 比较恒不成立）。
 * isInstalled 必须由调用方传入——消除对 installedMap 的隐式依赖，domain 纯函数层不读全局状态。
 *
 * @param repos 仓库列表
 * @param isInstalled 判定仓库是否已安装的回调（r => boolean）
 * @returns {{ repos: Array, dropped: string[] }} 去重后的列表 + 被隐藏的仓库名
 */
function dedupeReposByPkgName(repos, isInstalled) {
  const rank = (r) => {
    const stars = Number(r.stargazers_count ?? 0);
    return (isInstalled(r) ? 1e12 : 0) + (Number.isFinite(stars) ? stars : 0);
  };
  const byKey = new Map();
  const dropped = [];
  for (const r of repos) {
    const key = r.pkg_name ? `pkg:${r.pkg_name}` : `repo:${r.full_name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    if (rank(r) > rank(prev)) {
      dropped.push(prev.full_name);
      byKey.set(key, r);
    } else {
      dropped.push(r.full_name);
    }
  }
  return { repos: [...byKey.values()], dropped };
}

// ── S1 信号面：排序与筛选（routes 服务端分页与客户端本地排序共用纯函数）──

/** 列表排序键白名单：stars（默认）/ trending（7d 增速）/ updated / name。 */
const LIST_SORT_KEYS = new Set(["stars", "trending", "updated", "name"]);

/** 已验证判定（纯函数）：market_tags 含 verified-install 人工标注。 */
function isVerifiedRepo(r) {
  return Array.isArray(r?.market_tags) && r.market_tags.includes("verified-install");
}

/**
 * 列表比较器工厂（纯函数）：trending 按 stars_delta_7d 降序（null 未知垫底），
 * 同值回退 stars 降序；updated 按 updated_at 降序；name 按 full_name 升序。
 * 未知排序键回退 stars——调用方先过 LIST_SORT_KEYS 校验，这里双保险。
 */
function listComparator(sortKey) {
  const key = LIST_SORT_KEYS.has(sortKey) ? sortKey : "stars";
  const starsOf = (r) => (Number.isFinite(r?.stargazers_count) ? r.stargazers_count : 0);
  if (key === "trending") {
    return (a, b) => {
      const da = Number.isFinite(a?.stars_delta_7d) ? a.stars_delta_7d : -Infinity;
      const db = Number.isFinite(b?.stars_delta_7d) ? b.stars_delta_7d : -Infinity;
      if (da !== db) return db - da;
      return starsOf(b) - starsOf(a);
    };
  }
  if (key === "updated") {
    return (a, b) => {
      const ta = Date.parse(a?.updated_at ?? "") || 0;
      const tb = Date.parse(b?.updated_at ?? "") || 0;
      if (ta !== tb) return tb - ta;
      return starsOf(b) - starsOf(a);
    };
  }
  if (key === "name") {
    return (a, b) => String(a?.full_name ?? "").localeCompare(String(b?.full_name ?? ""));
  }
  return (a, b) => starsOf(b) - starsOf(a);
}

/**
 * 列表筛选谓词（纯函数）：opts.verified=只留已验证徽章；opts.hideArchived=隐藏归档仓库。
 * 无 opts 恒 true——调用方按需组合。
 */
function repoListFilter(opts) {
  const verifiedOnly = opts?.verified === true;
  const hideArchived = opts?.hideArchived === true;
  if (!verifiedOnly && !hideArchived) return () => true;
  return (r) => {
    if (verifiedOnly && !isVerifiedRepo(r)) return false;
    if (hideArchived && r?.archived === true) return false;
    return true;
  };
}

/**
 * 字段加权匹配分（纯函数）：name=8 / full_name=4 / topics=2 / description=1，
 * 命中字段累加（name 命中通常连带 full_name=12 封顶）。不命中返回 0——
 * 调用方以 score>0 做过滤、以降序做相关度排序。q 为空恒 0。
 */
function repoMatchScore(r, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q || !r) return 0;
  let score = 0;
  if (String(r.name ?? "").toLowerCase().includes(q)) score += 8;
  if (String(r.full_name ?? "").toLowerCase().includes(q)) score += 4;
  if ((r.topics ?? []).some((t) => String(t).toLowerCase().includes(q))) score += 2;
  if (String(r.description ?? "").toLowerCase().includes(q)) score += 1;
  return score;
}

export { dedupeReposByPkgName, LIST_SORT_KEYS, isVerifiedRepo, listComparator, repoListFilter, repoMatchScore };
