// 提交规范校验纯函数：供 Git Hook 与 smoke-tests 共同使用。
// 校验规则与仓库提交历史对齐（见 git log）：
//   <type>(<scope>): <中文描述>
// type 白名单: feat/fix/chore/ci/docs/style/refactor/test/perf/assets/revert/merge
// scope 可选: 小写字母/连字符，如 fix(install)
// 兼容 git 默认合并提交主题（"Merge branch ..." / "Merge pull request ..."）。

export const COMMIT_TYPES = [
  "feat", "fix", "chore", "ci", "docs", "style",
  "refactor", "test", "perf", "assets", "revert", "merge",
];

export const SUBJECT_PATTERN = /^(feat|fix|chore|ci|docs|style|refactor|test|perf|assets|revert|merge)(\([a-z][a-z0-9-]*\))?: .+/;

/** git 默认合并提交主题（本地 merge / PR 合入产物）直接放行。 */
const MERGE_SUBJECT_PATTERN = /^Merge\b/;

/** 取提交信息的第一行（主题）并去空白。 */
export function extractSubject(message) {
  if (typeof message !== "string") return "";
  return message.split("\n")[0].trim();
}

/**
 * 校验提交主题是否符合规范。
 * @param {string} subject 提交主题
 * @param {object} [opts] 校验选项
 * @param {"error"|"warn"|"off"} [opts.emojiLevel] emoji 检查等级：
 *   - error: 含 emoji 即拒绝（默认）
 *   - warn: 仅提示，不拒绝
 *   - off: 跳过 emoji 检查
 * @returns {{ ok: boolean, reason: string, warnings?: string[] }}
 *   ok=false 时 reason 为拒绝原因；ok=true 但 warnings 非空时表示有警告（warn 等级）。
 */
export function validateSubject(subject, opts = {}) {
  const emojiLevel = opts.emojiLevel ?? "error";
  const warnings = [];
  if (typeof subject !== "string" || subject.length === 0) {
    return { ok: false, reason: "提交主题为空" };
  }
  if (emojiLevel !== "off" && hasEmoji(subject)) {
    const msg = "提交主题包含 emoji（规范禁用的装饰符号）";
    if (emojiLevel === "error") {
      return { ok: false, reason: msg };
    }
    warnings.push(msg);
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    // git 默认合并提交主题（"Merge branch 'x'" 等）不属于规范格式但属于合法合并产物，直接放行
    if (MERGE_SUBJECT_PATTERN.test(subject)) {
      return { ok: true, reason: "", warnings };
    }
    return { ok: false, reason: `格式不符: "${subject}"，期望 <type>(<scope>): <描述>` };
  }
  const type = subject.split(/[(:]/)[0];
  if (!COMMIT_TYPES.includes(type)) {
    return { ok: false, reason: `type "${type}" 不在白名单: ${COMMIT_TYPES.join("/")}` };
  }
  return { ok: true, reason: "", warnings };
}

/**
 * 检测文本是否包含 emoji。
 *
 * 采用 Unicode Emoji 属性的完整模式（参考 emoji-regex-xs，零依赖内联）：
 * - \p{Emoji} 基字符（含 Emoji_Presentation 与文本表示类）
 * - EMod 表情修饰、肤色、区域指示符对（旗帜）、ZWJ 序列、数字 keycap、标签序列
 * 与 emoji-regex（Unicode 全量）行为对齐；©/® 单独字符按 Unicode 定义属于
 * Emoji 属性也会命中（跨端一致，不区分文本/表情呈现）。
 *
 * 用于提交信息与文档新增内容的 emoji 禁令（见 docs/DEVELOPMENT.md）。
 */
export function hasEmoji(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const re = new RegExp(
    "\\p{RI}{2}|(?![#*\\d](?!\\uFE0F?\\u20E3))\\p{Emoji}(?:\\p{EMod}|[\\u{E0020}-\\u{E007E}]+\\u{E007F}|\\uFE0F?\\u20E3)?(?:\\u200D\\p{Emoji}(?:\\p{EMod}|[\\u{E0020}-\\u{E007E}]+\\u{E007F}|\\uFE0F?\\u20E3)?)*",
    "gu"
  );
  return re.test(text);
}

/** 需要语法检查的文件清单（与 CI registry.yml 保持一致）。 */
export const SYNTAX_CHECK_FILES = [
  "lib/index.js",
  "lib/app/install-exec.js",
  "lib/app/installed-state.js",
  "lib/infra/bundle-register.js",
  "lib/domain/security-scan.js",
  "lib/infra/security-scan.js",
  "lib/infra/adaptor.js",
  "lib/infra/marketplace-metadata.js",
  "lib/domain/adaptor.js",
  "lib/domain/scan.js",
  "lib/http/marketplace-contract.js",
  "lib/client.js",
  "scripts/assemble-client.mjs",
  "scripts/build-registry.mjs",
  "scripts/registry/validate-categories.mjs",
  "scripts/registry/refresh-audit-snapshots.mjs",
  "scripts/validate-categories.mjs",
  "scripts/refresh-audit-snapshots.mjs",
  "scripts/smoke-tests.mjs",
  "scripts/toc.mjs",
  "scripts/coverage.mjs",
  "scripts/benchmarks/marketplace.mjs",
  "scripts/provenance.mjs",
  "scripts/tests/run.mjs",
  "scripts/hooks/check.mjs",
  "scripts/hooks/validate.mjs",
];

/** 有效等级集合。 */
export const LEVELS = ["error", "warn", "off"];

/** Hook 配置默认值（emoji、TOC 和密钥扫描均严格阻断）。 */
export const DEFAULT_HOOK_CONFIG = {
  emojiLevel: "error",             // error | warn | off（提交信息 emoji 检查，默认 error）
  tocLevel: "error",               // error | warn | off（README TOC 检查，默认 error）
  requireCommitMsg: true,
  secretLevel: "error",            // error | warn | off（密钥扫描）
  secretExclusions: [],            // 排除路径片段（如 ".env.example"）
  tocExclude: [],                  // TOC 自动扫描追加排除片段（逗号分隔）
  precommitStrategy: "auto",       // auto | full（按 staged 改动分级；full 恒全量快速门）
};

/**
 * 检测文本中是否包含高危密钥格式（防止把真实密钥提交进仓库）。
 * 匹配常见服务的密钥模式，长度校验降低误报：
 * - sk- 开头（OpenAI/DeepSeek/Anthropic 等，要求较长）
 * - ghp_/gho_/ghs_/github_pat_（GitHub）
 * - AKIA[0-9A-Z]{16}（AWS）
 * - xox[baprs]-（Slack）
 * - AIza[0-9A-Za-z_-]{35}（Google）
 * - 通用 TOKEN/KEY/SECRET= 形式的高熵值
 * 注意：仅检测"形似密钥"的字符串，无法保证其为真实密钥；误报时可用
 * .hooksrc 的 secretExclusions 排除（见 docs/GIT_HOOKS.md）。
 * @returns {{ found: boolean, samples: string[] }}
 */
export function detectSecret(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { found: false, samples: [] };
  }
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,              // OpenAI/DeepSeek/Anthropic 风格
    /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{36,}\b/g,    // GitHub PAT
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,        // GitHub fine-grained
    /\bAKIA[0-9A-Z]{16}\b/g,                    // AWS access key
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,        // Slack token
    /\bAIza[0-9A-Za-z_-]{35}\b/g,               // Google API key
  ];
  const samples = [];
  for (const re of patterns) {
    const matches = text.match(re);
    if (matches) {
      // 打码展示（保留前后 4 位），避免在输出中泄漏
      for (const m of matches) {
        samples.push(m.length > 8 ? m.slice(0, 4) + "…" + m.slice(-4) : "…");
      }
    }
  }
  return { found: samples.length > 0, samples: [...new Set(samples)] };
}

/**
 * 解析 .hooksrc 配置文本（key=value 行，# 注释；支持 JSON 值）。
 * 示例：
 *   # Git Hook 分级配置
 *   emojiLevel=warn      # error|warn|off
 *   requireCommitMsg=false
 * @param {string} text 配置文件内容
 * @returns {object} 合并默认值后的配置
 */
export function parseHookConfig(text) {
  const cfg = { ...DEFAULT_HOOK_CONFIG };
  if (typeof text !== "string") return cfg;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "emojiLevel") {
      if (LEVELS.includes(value)) cfg.emojiLevel = value;
    } else if (key === "tocLevel") {
      if (LEVELS.includes(value)) cfg.tocLevel = value;
    } else if (key === "requireCommitMsg") {
      cfg.requireCommitMsg = value === "true";
    } else if (key === "secretLevel") {
      if (LEVELS.includes(value)) cfg.secretLevel = value;
    } else if (key === "secretExclusions") {
      // 逗号分隔的路径片段
      cfg.secretExclusions = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "tocExclude") {
      // 逗号分隔的路径片段（TOC 自动扫描排除）
      cfg.tocExclude = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "precommitStrategy") {
      if (value === "full" || value === "auto") cfg.precommitStrategy = value;
    }
  }
  return cfg;
}

/**
 * 从 .hooksrc 文件加载配置（文件不存在返回默认）。
 * 仅做字符串解析，不触碰文件系统外部 IO（路径由调用方提供）。
 */
export function loadHookConfigFromText(text) {
  return parseHookConfig(text);
}

/**
 * 提交内容感知的 pre-commit 分级运行判定（纯函数，可单测）。
 * 输入 staged 文件列表，返回本次 pre-commit 应运行的检查项子集。
 *
 * fail-safe 原则：只对明确且保守的「低成本区域」降级（docs-only / tests-only）；
 * 任何命中核心（lib/scripts）、hook 自身改动、或无法判定的情况一律回退全量快速门，
 * 绝不因分级漏跑集成测试。CI 不降级（调用方在 CI 下强制 full）。
 *
 * @param {string[]} files staged 文件名列表
 * @param {{ precommitStrategy: string }} [cfg] .hooksrc 配置
 * @returns {{ runTests: string, tier: string }}
 *   runTests: "none"（docs/generated，跳过测试）| "unit"（tests-only 快层）
 *            | "unit,integration"（核心，全量快速门）
 *   tier: 判定标签（docs-only / tests-only / docs+tests / core / hook / generated / empty / full）
 */
export function classifyPrecommitTier(files, cfg = {}) {
  if (cfg.precommitStrategy === "full") return { runTests: "unit,integration", tier: "full" };
  const list = Array.isArray(files) ? files.filter((s) => typeof s === "string") : [];
  if (list.length === 0) return { runTests: "unit,integration", tier: "empty" };

  const isTest = (f) => /\.(test|e2e)\.mjs$/.test(f) || /\.spec\.\w+$/.test(f) || f.startsWith("scripts/tests/");
  const isDoc = (f) => f.endsWith(".md") || f.startsWith("docs/");
  // hook 自身改动：分级逻辑/配置变化最可能破坏门，必须全量
  const isHook = (f) => /scripts\/hooks\//.test(f) || /install-hooks\./.test(f) || f === ".hooksrc";
  // CI 自动化生成的注册表/索引产物：走增量密钥扫描 + toc，不触发集成
  const isGenerated = (f) => /^registry\.json$/.test(f) || /^skills\.json$/.test(f) || /\.gzip$/.test(f);

  if (list.every(isHook)) return { runTests: "unit,integration", tier: "hook" };
  if (list.every(isDoc)) return { runTests: "none", tier: "docs-only" };
  // tests-only 保留一层 unit 快测（秒级覆盖纯函数/适配器契约），不跑 integration 慢层；
  // 若同提交还改了 lib/scripts 核心，core 判定会回退全量，不会漏跑。
  if (list.every(isTest)) return { runTests: "unit", tier: "tests-only" };
  // 混合 docs + tests（无 lib/scripts 核心）→ 低成本，保留 unit 快层
  if (list.every((f) => isDoc(f) || isTest(f))) return { runTests: "unit", tier: "docs+tests" };
  if (list.every(isGenerated)) return { runTests: "none", tier: "generated" };
  // 命中核心（lib / 非测试 scripts / 无法判定的其他）→ 全量快速门
  return { runTests: "unit,integration", tier: "core" };
}
