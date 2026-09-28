/**
 * pnpm 调用参数按「目标目录是否自带 pnpm-workspace.yaml」决定 --ignore-workspace。
 *
 * - 文件存在 → 目标目录自身即 workspace 根锚（pnpm 向上查找在最近一个
 *   pnpm-workspace.yaml 处停），其中 settings（nodeLinker/autoInstallPeers/
 *   allowBuilds/minimumReleaseAge* 等）必须生效——此时 --ignore-workspace 会把
 *   settings 一并剥掉（实证：hoisted 丢失退回 isolated .pnpm 布局 → 插件拿到
 *   与宿主不同的 cordis 实例；allowBuilds 失效令 git 依赖构建脚本被封）。
 * - 文件缺失 → 需要 --ignore-workspace 兜底：否则祖先目录的 workspace 文件会把
 *   本目录吞进其 workspace——依赖装进祖先 node_modules 且静默成功
 *   （issue #146/#147/#168 吞依赖陷阱）。
 *
 * @param {string[]} args - 形如 ["install", ...] / ["remove", pkg] 的命令参数
 * @param {boolean} hasOwnWorkspaceFile - 目标目录自带 pnpm-workspace.yaml
 * @returns {string[]} 追加或不追加 --ignore-workspace 的参数列表
 */
export function withPnpmWorkspaceScope(args, hasOwnWorkspaceFile) {
  if (hasOwnWorkspaceFile) return args;
  return [args[0], "--ignore-workspace", ...args.slice(1)];
}
