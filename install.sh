#!/usr/bin/env bash
# DSH 插件市场（dsh-plugin-marketplace）一键安装脚本
#
# 支持三种执行方式：
#   1) 本仓库直接运行：  git clone 后运行 ./install.sh
#   2) 一行命令（推荐）：curl -sL https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/install.sh | bash
#   3) 由 DSH 插件市场执行（repo 被识别为 script 类型时自动调用）
#
# 安装内容：
#   - 复制本体到 ~/.dsh/profiles/web/node_modules/dsh-plugin-marketplace/
#   - 在 ~/.dsh/profiles/web/cordis.patch.yml 中注册（已存在则跳过）
# 完成后需重启 DSH（重新运行 dsh web）再刷新页面。
set -euo pipefail

REPO_URL="https://github.com/bradeGithub/DSH-Plugins-Marketplace"

# 优先使用官方安装方式：dsh CLI + pnpm 可用时，由 harness 自身完成安装与 reconcile
#（免手工拷贝与 patch 注册，卸载/更新也走官方命令）；失败则回退手动安装。
if command -v dsh >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  echo "检测到 dsh CLI，使用官方安装方式：dsh plugin --profile web install bradeGithub/DSH-Plugins-Marketplace"
  if dsh plugin --profile web install "bradeGithub/DSH-Plugins-Marketplace"; then
    echo ""
    echo "✔ dsh-plugin-marketplace installed via official CLI"
    echo "  请重启 DSH（重新运行 dsh web）后刷新页面生效。"
    echo "  Restart DSH (re-run dsh web), then refresh the page."
    exit 0
  fi
  echo "官方 CLI 安装失败，回退到手动安装方式..." >&2
fi

# 定位源码目录：直接运行 = 脚本所在目录；curl|bash 模式 = 无路径，改为下载仓库 tarball
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  SRC="$SCRIPT_DIR"
else
  TMP="$(mktemp -d)"
  # L3（KIMI 审阅）：curl|bash 模式下载的临时目录退出时清理，不残留
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading $REPO_URL ..."
  curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" | tar xz -C "$TMP"
  # 不硬编码解压后的顶层目录名（issue #17）：GitHub 归档命名随规则变化，
  # 且部分环境的 tar（如 TAR_OPTIONS=--strip-components）会去掉顶层目录、
  # 把文件直接铺进临时目录——动态定位含 package.json 的目录，两种布局都兼容。
  SRC="$(find "$TMP" -maxdepth 2 -name package.json -print -quit)"
  SRC="${SRC%/package.json}"
  if [[ -z "$SRC" || ! -f "$SRC/package.json" ]]; then
    echo "下载内容异常：未在临时目录（$TMP）找到仓库源码。请重试，或改用 git clone 方式安装。" >&2
    exit 1
  fi
fi

DEST="$HOME/.dsh/profiles/web/node_modules/dsh-plugin-marketplace"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"
rm -rf "$DEST/.git"
rm -f "$DEST/install.ps1" "$DEST/install.sh" "$DEST/.ca-bundle.crt"

# 注册到 web profile 补丁（幂等；行级精确匹配，避免前缀子串误判）。
# 注意：patch 条目是 `- insert:` 块内的缩进行（`      name: ...`），
# 行首锚定必须允许前导空白，否则永远匹配不到 → 每次运行都会追加重复条目（KIMI 审阅 H1）。
# v1.4.12（issue #39）：若本体已通过 profile bundles 加载，再注册 patch 会双加载 → 跳过。
PATCH="$HOME/.dsh/profiles/web/cordis.patch.yml"
BUNDLED=false
PROFILE_PKG="$HOME/.dsh/profiles/web/package.json"
# 精确 JSON 判定（与 install.ps1 的 -contains 语义一致）：必须落在 dsh.profile.bundles 数组内才算
# bundles 加载——裸 grep 子串会误判 dependencies 里同名字符串为 bundles，导致「已通过 bundles 加载」
# 的假阳性而跳过 patch 注册，市场装了却不加载（审查 C2）。
if [[ -f "$PROFILE_PKG" ]] && node -e 'try{const p=require(process.argv[1]);process.exit(Array.isArray(p.dsh&&p.dsh.profile&&p.dsh.profile.bundles)&&p.dsh.profile.bundles.includes("dsh-plugin-marketplace")?0:1)}catch(e){process.exit(1)}' "$PROFILE_PKG"; then
  BUNDLED=true
fi
if $BUNDLED; then
  echo "Marketplace already loaded via profile bundles (skipped patch registration)"
elif [[ -f "$PATCH" ]] && grep -qE '^[[:space:]]*name:[[:space:]]+dsh-plugin-marketplace[[:space:]]*$' "$PATCH"; then
  echo "Already registered in cordis.patch.yml (skipped)"
else
  # issue #71/#73：官方默认文件是「注释 + 空数组 []」——[] 是 flow 序列，其后追加块序列项
  # （- insert:）是非法 YAML，DSH 启动解析即崩。追加前清掉顶层裸 [] 行。
  if [[ -f "$PATCH" ]] && grep -qx '\[\]' "$PATCH"; then
    sed -i '/^\[\]$/d' "$PATCH"
  fi
  printf '\n- insert:\n    - id: dsh-plugin-marketplace\n      name: dsh-plugin-marketplace\n' >> "$PATCH"
  echo "Registered in cordis.patch.yml"
fi

echo ""
echo "✔ dsh-plugin-marketplace installed to $DEST"
echo "  Restart DSH (re-run dsh web), then refresh the page."
echo "  请重启 DSH（重新运行 dsh web）后刷新页面生效。"
