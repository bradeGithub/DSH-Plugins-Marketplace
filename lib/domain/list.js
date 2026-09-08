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

export { dedupeReposByPkgName };
