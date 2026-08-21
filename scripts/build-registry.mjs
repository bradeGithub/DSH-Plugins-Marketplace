#!/usr/bin/env node
/**
 * 生成静态索引 —— DSH 插件市场 / 通用 Skills 栏目的数据源。
 *
 * 数据源：GitHub Search API。由 GitHub Actions 定时执行（见 .github/workflows/registry.yml），
 * 产物提交回 main 分支，插件通过 jsDelivr CDN 读取，零 API 限流。
 *
 * 模式（环境变量 SOURCES_MODE）：
 *   dsh（默认）  topic:dsh-plugin → registry.json（DSH 插件市场）
 *   skills       topic:agent-skills + topic:claude-skills 并集 → skills.json
 *                （额外用 Trees API 探测 has_skill / has_install_script，见下方「探测」注释）
 *
 * v1.3.1（全量）：GitHub Search API 单 query 硬上限 1000 条（topic 页爬虫同样被限制 50 页），
 * dsh / skills 模式统一用「stars 分段 + 时间窗口二分」突破上限取全量：
 *   - 按 star 数分段查询（stars:>=1000 / 100..999 / 10..99 / ...），每段 ≤1000 条即收敛；
 *   - 段拉满 1000 条说明还有更多 → 对半分裂（普通段按 star，单值段如 stars:0 按 pushed
 *     时间窗口二分，窗口窄于 MIN_WINDOW_DAYS 天即接受部分结果）；
 *   - 段内 0 新增（数据已被其他段覆盖）→ 直接收敛，避免无谓查询。
 * （v1.3 起 skills 模式使用；v1.3.1 起 dsh 模式同样使用——修复 topic:dsh-plugin 被
 *   单 query 1000 条上限截断、插件市场列表只显示 999 个（GitHub 实为 1500+）的问题。）
 * 带 token 时冷启动全量 ~12000+ 仓库约需 1.5 小时（Search 30/min 限额是主要瓶颈）；
 * CI 每 2 小时增量跑，updated_at 继承 + 0 新增收敛使其逐步收敛。
 *
 * 环境变量：
 *   GH_TOKEN / GITHUB_TOKEN  有则带认证头（Search 限额 30 次/分钟，Actions 内自动提供）
 *   SOURCES_MODE             索引模式：dsh | skills（默认 dsh）
 *   MAX_PAGES                最大翻页数（默认 100，本地测试可设小）
 *   REGISTRY_FILE            输出路径（默认仓库根 registry.json / skills.json）
 *   PROBE_FILE               探测断点快照路径（默认 <OUT_FILE>.probing，仅 skills 模式）
 *   SKIP_ENRICH=1            跳过 pkg_name 富化（raw.githubusercontent 不通/被墙时构建会卡在
 *                            每个请求的超时上；本地回归或断网环境可跳过，CI 始终执行）
 *
 * ── 探测额度预算（仅 skills 模式；Core API 5000/h、Search 30/min 各自独立限额）──
 *   冷启动（无历史）    ~12000 次 Trees 探测 → 超过 5000/h，靠护栏分批：
 *                       X-RateLimit-Remaining < 200 立即停止，partial-merge 落盘；
 *                       等一小时重跑同一命令，增量继承让已探测的仓库不再重复探测。
 *   稳态增量           ~300~800 次（仅 updated_at 变动的仓库）→ 远低于限额 ✓
 *   Search 分段        冷启动 ~100+ 段 × 10 页 ≈ 1.5 小时（30/min 限额）；稳态增量少 ✓
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MODE = process.env.SOURCES_MODE ?? "dsh";
const QUERIES = MODE === "skills"
  ? ["topic:agent-skills", "topic:claude-skills"]
  : ["topic:dsh-plugin"];
const OUT_FILE = process.env.REGISTRY_FILE ?? join(ROOT, "..", MODE === "skills" ? "skills.json" : "registry.json");
const PROBE_FILE = process.env.PROBE_FILE ?? OUT_FILE + ".probing";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 100);
const PER_PAGE = 100;
const EXCLUDED = new Set(["deepseek-harness"]);
const DELAY_MS = TOKEN ? 2200 : 6500; // 限流：带 token 30/min，未认证 10/min

// ── v1.3 skills 全量获取：Search API stars 分段 + 自动二分（突破单 query 1000 条上限）──
// GitHub Search API 每个 query 硬上限 1000 条（topic 页爬虫同样限制 50 页）。
// 按 star 数分段查询（stars:min..max），某段拉满 1000 条说明还有更多 → 对半分裂递归，
// 直到每段 <1000 条 → 全量收敛。带 token 时 ~30-50 次查询 ≈ 2 分钟。
const SKILL_STAR_SEGMENTS = [ // 起始分段（大 star 段大概率 <1000 直接收敛）
  { min: 1000, max: null },   // stars:>=1000
  { min: 100, max: 999 },
  { min: 10, max: 99 },
  { min: 1, max: 9 },
  { min: 0, max: 0 }
];
const SEGMENT_QUEUE_LIMIT = 120; // 防无限分裂的安全上限（超过则停止分裂，接受部分结果）
/** 单值段时间窗口最小粒度（天）：0-star 长尾仓库极多，按周切会无限查询；
 *  窗口窄于该值仍超 1000 条就接受部分结果。
 *  v1.4.8：dsh 模式收紧到 1 天——实测 topic:dsh-plugin 的 0-star 仓库几乎全部在近 3 天
 *  pushed（窗口 1155 > 1000），30 天粒度下必然截断，导致聚合页收录的 0-star 插件
 *  持续进不了索引（awesome-dsh-plugin 收录缺失 83 个中的 19 个即此因）。
 *  1 天粒度下每日新增 0-star ~400 条 < 1000，可全量收敛；全量模式查询量增加但可接受。
 *  skills 模式保持 30 天：0-star 长尾规模大一个数量级（数万条），穷尽成本不成比例，
 *  且其 0-star 仓库价值更低（README 已声明接受部分结果）。 */
const MIN_WINDOW_DAYS = MODE === "dsh" ? 1 : 30;
/** 增量模式窗口（天）：>0 时只拉最近 N 天 pushed 的仓库（新/更新仓库），
 *  老仓库从旧索引继承 + stale 剔除。CI 每 2 小时用增量（几分钟），每天全量刷新 star。 */
const INCREMENTAL_DAYS = Number(process.env.INCREMENTAL_DAYS ?? 0);
/** 增量模式的时间窗口上界（动态：当前日期 + 1 年，覆盖 pushed:>=since 查询）。 */
function incrementalEndDate() {
  return new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
}

// ── 探测护栏（仅 skills 模式）──
const PROBE_CONCURRENCY = 8;   // 探测并发（沿用 enrichPkgNames 的 worker 模式）
const RATE_LIMIT_FLOOR = Number(process.env.RATE_LIMIT_FLOOR ?? 200); // X-RateLimit-Remaining 低于此值立即停止探测（可环境变量覆盖，便于本地调试）
const PROBE_TIMEOUT_MS = 20000; // 单仓库 Trees 探测超时（大仓库可能较慢）
const SNAPSHOT_EVERY = 10;     // 每探测 N 个仓库写一次断点快照（中断后重跑可续）

function log(msg) {
  console.log(`[registry:${MODE}] ${msg}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ghHeaders() {
  return {
    "User-Agent": "dsh-plugin-marketplace-registry",
    Accept: "application/vnd.github+json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
  };
}

async function fetchPage(query, page, extraSort = "") {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}${extraSort ? `&sort=${extraSort}&order=desc` : ""}&per_page=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return await res.json();
}

/** B2 收录门控 normalize：fork 是噪音非覆盖（真排除），archived 保留但降权（客户端显示徽章）。 */
export function normalize(r) {
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

// ── 插件分类（dsh 模式）──
// 基于 description + name + 过滤后的 topics 的关键词规则分类（无需读 README）。
// 规则按优先级排列：先匹配先得（特异词在前，宽泛词在后），无匹配 → "other"。
// v1.3.8 依据 120 仓库 README 审计重排（基线准确率 45.8% → 100%）：
//   顺序要点：web-ui 提到 conversation 之前（对话类宽词曾吞掉 UI 插件）；
//   model 收紧（provider/deepseek-api/usage 曾误吞 web-ui/TUI）；
//   resource 强特征（awesome/目录/排行等）前置，避免聚合仓库被 coding/agent 抢走。
//   词表精修：/notif/、/style/、/compat/、/marketplace/、/ppt/、/office/、/\bgit\b/、/\btui\b/、
//   /code[- ]?intelligence/、裸 /rust/、裸 /tab/、裸 /compile/ 等误伤词已移除/加边界；
//   生态泛标签（coding-agents/developer-tools/prompt-engineering 等）入 TOPIC_STOP_WORDS。
//   规则能力之外的边界案例（desc 为空、语义在特征词之外）由 CATEGORY_OVERRIDES 人工覆写兜底。
// topics 参与分类前先剔除生态泛标签（ai-agent/llm/deepseek 等是生态标签不是功能标签）。
const TOPIC_STOP_WORDS = new Set([
  "agent", "agents", "ai-agent", "ai-agents", "ai", "llm", "deepseek", "deepseek-harness",
  "dsh", "dsh-plugin", "dsh-plugins", "dshtopic", "dsh-ecosystem", "cordis", "cordis-plugin",
  "claude", "claude-code", "claude-skills", "codex", "opencode", "openclaw", "hermes-agent",
  "harness", "harness-engineering", "typescript", "javascript", "python", "react", "nodejs",
  "open-source", "self-hosted", "local-first", "privacy-first", "api", "sdk", "plugin",
  "plugins", "extension", "openai", "gemini", "kimi", "glm", "minimax", "free",
  "web", "web-ui", "ui", "gui", "tool", "tools", "skill", "skills", "agent-skills",
  "automation", "workflow", "multi-agent", "ai-tools", "ai-assistant", "assistant",
  "chatgpt", "coding-agent", "coding-agents", "coding-assistant", "agentic-coding",
  "vibe-coding", "vibecoding", "ai-coding", "developer-tools", "pdf-parser",
  "debugging", "prompt-engineering", "system-design",
  "terminal", "tui", "cli"
]);

/** 分类文本：description + name + 过滤掉生态泛标签后的 topics。 */
export function categoryText(repo) {
  const topics = (Array.isArray(repo.topics) ? repo.topics : [])
    .filter((t) => !TOPIC_STOP_WORDS.has(String(t).toLowerCase()));
  return [repo.description, repo.name, ...topics].filter(Boolean).join(" \n ");
}

const CATEGORY_RULES = [
  {
    id: "vision",
    // v1.3.8：裸 /image|图片|图像/ 太宽（图片上传/导出误伤）→ 只认识别/理解类组合词
    patterns: [/vision/i, /ocr/i, /screenshot/i, /多模态/, /视觉识别|视觉工具|视觉任务|视觉插件|视觉能力|机器视觉|computer vision/i, /识图|图像识别|图片理解/, /截图/, /computer[- ]?use/i, /电脑控制/, /image[- ]?(generation|analysis|understanding|recognition|to[- ]text|caption|restoration)/i, /ui[- ]?restoration/i, /ui[- ]?还原/i]
  },
  {
    id: "memory",
    // v1.3.8：/技能/（技能实例≠记忆管理）、/distill|蒸馏/（技能蒸馏）、/跨会话/（功能特征词）移除
    patterns: [/memory/i, /记忆/, /knowledge/i, /知识/, /note/i, /笔记/, /recall/i, /回忆/, /skill[- ]?import/i, /knowledge[- ]?graph/i, /知识图谱/, /长期记忆/, /memo/i, /context[- ]?insight/i]
  },
  {
    id: "notify",
    // v1.3.8：/notif/ 移除（"browser notifications"/"push notifications" 把 UI 插件、资讯聚合误吞 → 只留明确通知词）
    patterns: [/通知/, /消息通知|消息提醒|消息推送/, /\bmessage notification/i, /telegram/i, /wechat/i, /微信/, /\bim\b/i, /提醒/, /alert/i, /ntfy/i, /broadcast/i, /广播/, /邮件/, /mail/i, /desktop[- ]?notification/i, /handoff/i, /消息互通/, /跨实例/]
  },
  // 聚合资源强特征（前置）：awesome 目录/排行/商店/手册必须在 document/coding 之前匹配，
  // 否则 curated 列表与手册会被"文档/开发"宽词抢走（v1.3.8 审计发现 5+ 错分）。
  {
    id: "resource",
    // v1.3.8：/discovery/ 收窄（OpenBiliClaw 内容发现 Agent 误伤 → 只认插件发现类）；
    // 增加资讯/RSS 聚合词（news-agent 类信息聚合仓库归 resource 而非 notify）；
    // bundle/pack 移除（"plugin bundle" 指打包产物不是合集，如 dsh-tui 被误归 resource）
    patterns: [/awesome/i, /curated/i, /精选/, /聚合/, /排行/, /雷达/, /目录/, /商店/, /catalog/i, /手册|handbook/i, /档案/, /插件发现|发现入口|plugin[- ]?discovery/i, /插件合集|插件集合/, /plugin[- ]?collection/i, /\brss\b|news[- ]?(aggregator|reader|digest)|新闻|资讯|订阅源/i]
  },
  {
    id: "document",
    // v1.3.8：/word\b/ 修成 /\bword\b/（keyword 误伤）；去掉 slide/presentation/mermaid/latex 等宽词；
    // 去掉 /ppt/（"PPTX export" 设计工具误伤）、/office/（AI workbench 的 Office artifacts 误伤，保留 /办公/）
    patterns: [/pdf/i, /excel/i, /xlsx/i, /spreadsheet/i, /表格/, /\bword\b/i, /docx/i, /论文/, /演示/, /办公/]
  },
  {
    id: "coding",
    // v1.3.8：/\bgit\b/ 移除（皮肤合集的 "git graph" 子功能误伤）；/\btui\b/ 移除（社区发行版的 "TUI 形态" 误伤，
    //   保留 terminal/终端 即可覆盖 TUI 插件）；/code[- ]?intelligence/ 移除（代码检索 MCP 归 tool）；
    //   /rust/ → /\brust\b/（"untrusted" 子串误伤）
    patterns: [/\bcoding/i, /vscode/i, /\bide\b/i, /\blsp\b/i, /\blint/i, /代码/, /编码/, /debug/i, /调试/, /\bcompile\b/i, /编译/, /terminal/i, /终端/, /\bbash\b/i, /\bshell\b/i, /编程/, /programming/i, /代码库/, /代码检索/, /源码|source[- ]?code/i, /syntax/i, /语法/, /monaco/i, /编辑器/, /editor/i, /camel/i, /\brust\b/i, /typescript/i, /python/i, /harmony/i, /鸿蒙/, /开发/, /developer/i, /dev[- ]?tool/i]
  },
  {
    id: "web-ui",
    // v1.3.8：提到 tool/model 之前（皮肤/UI 插件曾被子功能词抢走）；去 /\bpet\b/（图库宠物归 tool）；
    // 去 /style/（"Tag-style/Codex-style" 误伤 agent 运行时/输入框插件）；/tab/ → /\btab\b/（"database" 误伤）
    patterns: [/web[- ]?ui/i, /\bui\b/i, /界面/, /skin/i, /皮肤/, /theme/i, /主题/, /sidebar/i, /侧边栏/, /whale/i, /鲸鱼/, /宠物/, /美化/, /wallpaper/i, /壁纸/, /widget/i, /组件/, /home[- ]?page/i, /主页/, /status[- ]?bar/i, /状态栏/, /minigame/i, /小游戏/, /game/i, /游戏/, /panel/i, /面板/, /banner/i, /横幅/, /广告/, /\btab\b/i, /标签页/, /dock/i, /icon/i, /图标/, /avatar/i, /头像/, /\bdesign\b/i, /设计/, /导航|navbar/i, /生成式 ?ui|generative ui/i]
  },
  // 通用工具（合并原前后置两组；v1.3.8 增补 CLI/逆向/图库/图表/研究/一键配置 等审计命中词）
  {
    id: "tool",
    patterns: [/mcp[- ]?server/i, /sandbox/i, /沙箱/, /security/i, /安全/, /guardrail/i, /护栏/, /weather/i, /天气/, /calculator/i, /计算器/, /行情/, /ticker/i, /会议/, /meeting/i, /benchmark/i, /基准/, /fuzzer/i, /模糊测试/, /vault/i, /密码/, /credential/i, /凭据/, /encrypt/i, /加密/, /\botp\b/i, /\btotp\b/i, /profiler/i, /性能分析/, /探针/, /search/i, /搜索/, /browser/i, /浏览器/, /\btool/i, /工具/, /\bjson\b/i, /\bcsv\b/i, /\bregex\b/i, /encoding/i, /编码转换/, /\bstat\b/i, /schema/i, /protocol/i, /协议/, /remote/i, /远程/, /dns/i, /网络/, /network/i, /performance/i, /性能/, /health/i, /健康检查/, /check/i, /检查/, /monitor/i, /监控/, /备份/, /backup/i, /sync/i, /同步/, /export/i, /导入/, /import/i, /convert/i, /转换/, /decode/i, /解码/, /encode/i, /压缩/, /zip/i, /file/i, /文件/, /\bcli\b/i, /command[- ]?line/i, /reverse[- ]?engineer/i, /逆向/, /gallery/i, /图库/, /diagram/i, /图表|图形/, /\bresearch\b/i, /研究/, /一键配置|configure|configuration/i]
  },
  {
    id: "model",
    // v1.3.8：/provider/（anysearch 误伤）、/deepseek[- ]?api/（生态标签）、裸 /usage/、/tps/ 移除
    patterns: [/token/i, /用量/, /cost/i, /成本/, /balance/i, /余额/, /context[- ]?window/i, /上下文/, /计费/, /billing/i, /usage[- ]?stats?|token[- ]?usage|usage transparency/i, /用量统计/, /推理/, /inference/i, /quota/i, /额度/, /模型选择/, /model selection/i, /模型路由/, /model routing/i, /llm[- ]?fallback/i, /模型回退/, /token[- ]?stats/i, /token[- ]?usage/i]
  },
  {
    id: "conversation",
    // v1.3.8：/session/ 移除（Data Agent 的 session-scoped 误伤）
    patterns: [/conversation/i, /对话/, /会话/, /message[- ]?edit/i, /消息编辑/, /\bshare/i, /分享/, /rewind/i, /回退/, /annotation/i, /批注/, /\bchat/i, /聊天/, /\bturn\b/i, /回合/, /composer/i, /输入框/, /input[- ]?history/i, /粘贴/, /paste/i, /prompt/i, /提示词/, /回复/, /reply/i]
  },
  {
    id: "agent",
    // v1.3.8：/harness/（deepseek-harness-desktop 误伤）、/\bteam\b|团队/（太宽）移除
    patterns: [/\bagent\b(?!s)/i, /sub[- ]?agents?/i, /agentteams/i, /agent team/i, /multi[- ]?agent/i, /智能体/, /automation/i, /自动化/, /workflow/i, /工作流/, /orchestrat/i, /编排/, /subagent/i, /子代理/, /\bloop\b/i, /调度/, /scheduler/i, /autonomous/i, /自主/, /cowork/i, /协作/]
  },
  // 聚合资源弱特征（后置兜底）：管理/市场/社区/教程 等宽词（/生态|ecosystem/ 太宽已移除；
  // /compat/ 误吞 "OpenAI-compatible" 网关、/marketplace/ 误吞同名测试仓库 → 均已移除，/市场/ 已够）
  {
    id: "resource",
    patterns: [/plugin[- ]?manager/i, /插件管理/, /registry/i, /市场/, /社区/, /community/i, /教程/, /tutorial/i, /guide/i, /指南/, /documentation/i, /文档站/, /tracking/i, /追踪/, /\blist\b/i, /列表/, /collection/i, /集合/, /(?<!Git)hub\b/i, /雷达/, /radar/i]
  }
];
const CATEGORY_OTHER = "other";

/**
 * 人工分类覆写（v1.3.8）：120 仓库 README 审计后，对规则无法可靠判定的边界仓库做确定性人工修正。
 * 仅覆盖规则能力之外的案例——desc 为空、语义超出特征词、或特征词天然冲突（如"玩具"仓库含 protocol/文件 字样）。
 * 每条附理由；新仓库不受影响，仍由 CATEGORY_RULES 分类。
 */
const CATEGORY_OVERRIDES = new Map([
  // → other：本质不是 DSH 生态插件
  ["imsai-sh/zhuzhiliao", "other"], // 竹知了玩具模拟器，desc 仅"单文件"命中 tool
  ["c3ll256/dsh-toy", "other"], // 玩具协议演示，"protocol" 命中 tool 属误伤
  ["LoserFox/distill", "other"], // 对话蒸馏技能，命中 conversation 属特征词巧合
  ["bruc3van/dsh-desktop", "other"], // 第三方桌面客户端（安装器），非插件
  // → agent：agent 运行时/智能体类，被更早的工具词/界面词抢走
  ["sandbaseai/sandbase-harness", "agent"], // CMA agent 运行时，"sandbox" 命中 tool
  ["huiliyi37/dsh-tianshu-build", "agent"], // 开源 coding agent，"跨会话记忆" 命中 memory
  ["whiteguo233/dsh-openbiliclaw", "agent"], // Agent Bridge 插件，"DSH 界面常驻" 命中 web-ui
  // → tool：管理/配置/工作台类工具，被 coding/web-ui 宽词抢走
  ["kuangre123/codex-switch", "tool"], // Codex API 配置切换，"coding-agent" 命中 coding
  ["drewnekota/cetus", "tool"], // macOS 自动化启动器，"computer-use" 命中 vision
  ["zhaoolee/notes", "tool"], // 便签应用，"notes" 主题命中 memory
  ["ZSeven-W/dsh-openpencil", "tool"], // 设计预览编辑工具，"design" 命中 web-ui
  ["Fishquito7/dsh-skill-viewer", "tool"], // skill 管理工具，"DSH Web UI" 命中 web-ui
  ["LX2000WASD/dsh-web-plugin-manager", "tool"], // 插件管理工具，"Web UI 中管理" 命中 web-ui
  ["openma-ai/open-managed-agents", "tool"], // Claude Managed Agents API 实现/运行时
  ["Devin-AXIS/iPolloWork", "tool"], // AI 工作台，"visual-editor" 主题命中 coding
  ["unitarylab/quantum-practices", "tool"], // 量子算法实践技能包，无规则词 → other
  ["PivotStackIntelligence/dsh-github", "tool"], // GitHub 面板，desc 为空无法规则分类
  ["lzszq/dsh-scholar", "tool"], // 学术检索工具，desc 为空无法规则分类
  ["bobleer/dsh-acp-for-bitfun", "tool"], // DSH ACP 对接，"对接"无规则词
  ["tc206107/dsh-open-ecosystem", "tool"], // 生态工具，desc 为空无法规则分类
  ["Nagi-ovo/dsh-find-plugins", "tool"], // 插件发现工具，desc 为空无法规则分类
  ["morluto/leantoken", "tool"], // 代码检索/上下文管理 MCP，"rust" 实现主题命中 coding
  ["nexu-io/open-design", "web-ui"], // 设计引擎，"PDF/PPTX export" 命中 document
  // → model：token/模型管理类
  ["wink-run/tokenbank", "model"], // Token 记账/模型路由网关，"P2P network" 命中 tool
  // → coding：开发工作流类（"knowledge" 主题命中 memory 属误伤）
  ["btspoony/mstar-harness", "coding"], // Loop Engineering 工作流插件
  ["ccch1mneyyy/dsh-TUI", "coding"], // 终端 TUI 插件（Claude Code 风格全屏交互终端），description 含 "WeChat featured"（公众号收录）命中 notify 的 /wechat/ 属误伤
  // → conversation：对话/输入框类（特征词在规则之外）
  ["huiliyi37/dsh-tianshu-tui", "conversation"], // 终端 UI 对话插件，"terminal" 命中 coding
  ["omdsh-dev/dsh-at-file", "conversation"] // @file 输入框功能，"search workspace" 命中 tool
]);

export { CATEGORY_RULES, CATEGORY_OVERRIDES, TOPIC_STOP_WORDS, CATEGORY_OTHER };

/**
 * 人工验证标注（v1.4.1）：市场维护者实测过安装行为的仓库 → market_tags。
 *  - "verified-install"：实测可正常一键安装（官方 CLI 或市场流程均可）
 *  - "prereq"：可安装但需要前置条件（如 open-design 需先装官方 dsh CLI 并用其自带
 *    od CLI 接入，市场无法代执行，仅作提示）
 * 随 build-registry 每次构建注入索引，避免被 CI 重建覆盖。
 */
const MARKET_TAGS = new Map([
  ["dsh-market/dsh-market", ["verified-install"]],
  ["zhu1090093659/dsh-web-ui", ["verified-install"]],
  ["xiaobright/dsh-anchored-standard", ["verified-install"]],
  ["bradegithub/dsh-plugins-marketplace", ["verified-install"]],
  ["tt-a1i/archify", ["verified-install"]],
  ["small-tailqwq/dsh-deep-whale", ["verified-install"]], // issue #19 用户反馈正常 + 修复相对路径指令后实测可装
  ["scorp1o117/dsh-tdai-memory", ["verified-install"]], // issue #20 用户反馈正常（cordis-plugin 0.2.8）
  ["titanwings/colleague-skill", ["verified-install"]], // issue #22 用户反馈正常（skill）
  ["wx-yss/dsh-message-rail", ["verified-install"]], // issue #23 用户反馈正常（cli）
  ["weijiafu14/pi2dsh", ["verified-install"]], // issue #24 用户反馈正常（cli，npm 生态桥）
  ["liustack/modlens", ["verified-install"]], // issue #25 用户反馈正常（cli）
  ["mnemon-dev/mnemon", ["verified-install"]], // issue #31 用户反馈正常（cordis-plugin 0.1.0）
  ["taxueseek/dsh-files", ["verified-install"]], // issue #35 用户反馈正常（cordis-plugin 0.2.0）
  ["lx2000wasd/dsh-web-plugin-manager", ["verified-install"]], // issue #43 用户反馈正常（cli）
  ["csyangwen/dsh-memory-evolve", ["verified-install"]], // issue #42 用户反馈正常（cordis-plugin 0.1.0）
  ["anionex/agent-vision-toolkit", ["verified-install"]], // issue #41 用户反馈正常（cordis-plugin 0.1.2）
  ["nexu-io/open-design", ["prereq"]],
]);

/**
 * 注入人工验证标注（纯函数）：命中 MARKET_TAGS 的仓库写入 market_tags 数组，
 * 未命中删除旧字段（标注随表刷新，避免过期误导）。full_name 大小写不敏感。
 * @param {Array} repos registry 条目数组
 */
export function applyMarketTags(repos) {
  for (const repo of repos) {
    const tags = MARKET_TAGS.get(String(repo.full_name ?? "").toLowerCase());
    if (tags && tags.length > 0) repo.market_tags = [...tags];
    else delete repo.market_tags;
  }
  return repos;
}

/**
 * 可安装性徽标盖章（纯函数）：从 verify-installability.mjs 的探测报告（full_name → verdict）映射为
 * 面向客户端的精简字段 `installable`，只标注两类需要提示的仓库：
 *   "pkg-plain" → "non-plugin"（有 package.json 但非 DSH 插件，装了不可用）
 *   "manual"    → "manual"（无可自动安装内容，只能按 README 手动装）
 * 其余（cordis-plugin/bundle-plugin/skill/script/multi-plugin/agent-preset/unknown）不写字段 →
 * 客户端默认无徽标（bundle-plugin 是合法可装形态，与 cordis-plugin 同等对待，无红标）。
 * 报告缺失或条目缺失 → 删除旧盖章（徽标随报告刷新，避免过期误导）。
 * 人工验证标注优先：market_tags 含 "verified-install" 的仓库跳过机器盖章——
 * 探测器对「根目录非插件但 README 提供官方聚合包」的仓库会误判 pkg-plain
 * （如 dsh-web-ui，实测走官方 CLI 安装正常），人工实测应覆盖机器探测。
 * @param {Array} repos registry 条目数组
 * @param {Map<string,string>} verdictMap full_name → 探测 verdict
 */
export function applyInstallability(repos, verdictMap) {
  for (const repo of repos) {
    if (Array.isArray(repo.market_tags) && repo.market_tags.includes("verified-install")) {
      delete repo.installable;
      continue;
    }
    const v = verdictMap.get(String(repo.full_name ?? ""));
    if (v === "pkg-plain") repo.installable = "non-plugin";
    else if (v === "manual") repo.installable = "manual";
    else delete repo.installable;
  }
  return repos;
}

/**
 * B3 失效清理（纯函数）：报告 verdict === "gone"（B1 已由 repo 级 API 二次确认的真删除）
 * 的条目从索引剔除——「降权达到用户侧删除」：报告归档保留，仓库复活后 topic 扫描自然重收。
 * empty（仓库存在但无提交树）不剔除：新仓库可能很快有内容，保留无徽章。
 * @param {Array} repos registry 条目数组
 * @param {Map<string,string>} verdictMap full_name → 探测 verdict
 */
export function applyGoneCleanup(repos, verdictMap) {
  const gone = new Set();
  for (const [name, v] of verdictMap) if (v === "gone") gone.add(name);
  return repos.filter((r) => !gone.has(String(r.full_name ?? "")));
}

/**
 * 社区精选标注（v1.4.8）：构建期抓取 awesome 聚合页收录的仓库，与索引交集打
 * 「社区精选」徽章（market_tags 追加 "community-pick"）。
 * 聚合页由社区维护、人工筛选，代表「社区认可的插件」；徽章随每次构建刷新，
 * 列表更新后增量构建也能同步（统一重算）。机器探测明确非插件的仓库不打标。
 */
const COMMUNITY_PICK_SOURCES = [
  // 社区聚合页（awesome 列表）。新增源：追加 { repo, branch }（并集）。
  { repo: "awesome-dsh-plugin/awesome-dsh-plugin", branch: "main" }
];

/** 从聚合页 README 提取仓库链接（纯函数）：只取 github.com/owner/repo 形态，
 *  去 .git 后缀 / 尾部斜杠，转小写，去重。 */
export function extractCommunityPickLinks(text) {
  const out = new Set();
  const re = /github\.com\/([\w.-]+\/[\w.-]+)/g;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    out.add(m[1].replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase());
  }
  return out;
}

/** 抓取全部聚合页的收录集合（小写 full_name）。源全部失败返回空 Set（调用方降级，
 *  本次不打标——增量构建旧索引条目保留旧字段，下次构建恢复）。 */
async function fetchCommunityPicks() {
  const picks = new Set();
  for (const source of COMMUNITY_PICK_SOURCES) {
    try {
      const res = await fetch(`https://api.github.com/repos/${source.repo}/readme`, {
        headers: { ...ghHeaders(), Accept: "application/vnd.github.raw" },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) {
        log(`社区精选源 ${source.repo} 抓取失败：HTTP ${res.status}`);
        continue;
      }
      const links = extractCommunityPickLinks(await res.text());
      for (const f of links) picks.add(f);
      log(`社区精选源 ${source.repo}：收录 ${links.size} 个仓库`);
    } catch (error) {
      log(`社区精选源 ${source.repo} 抓取失败：${error.message}`);
    }
  }
  return picks;
}

/**
 * ── 验证徽章（discussion deepseek-harness#2269 对接契约：qing3a/dsh-plugin-verify）──
 * 数据源：验证仓库根目录 verified.json 开放数据层（聚合形态，比逐个重抓 reports/ 省请求）。
 * 字段契约（qing3a 2026-08-16 确认）：
 *   - 报告新增 fullName（插件仓库 owner/name）为稳定映射键；旧版条目以 repo URL 解析兜底
 *   - 条目含 verifiedBy（带版本）/ verifiedAt / reportUrl / waterfall / toolsResult / security
 *   - 顶层 schemaVersion 不匹配 → 整体跳过不盖章（fail-closed，防演进破坏解析）
 * 盖章语义与 installability / community picks 一致：每轮构建统一重算，抓取失败或
 * schemaVersion 不符时增量模式保留旧字段，下次构建恢复。
 */
const VERIFY_SOURCE = {
  repo: "qing3a/dsh-plugin-verify",
  branch: "main",
  file: "verified.json",
  schemaVersion: 1
};

/** 从 verified.json 条目解析插件仓库 full_name（纯函数）：
 *  优先契约字段 `fullName`；旧版条目回退从 `repo` URL 解析 owner/name。 */
export function parseVerificationFullName(entry) {
  if (typeof entry?.fullName === "string" && entry.fullName.includes("/")) return entry.fullName;
  const m = String(entry?.repo ?? "").match(/github\.com\/([\w.-]+\/[\w.-]+)/);
  if (m) return m[1].replace(/\.git$/i, "").replace(/\/+$/, "");
  return "";
}

/** 解析 verified.json 为 小写 full_name → 验证证据 Map（纯函数，便于单测）。
 *  顶层 schemaVersion 不匹配返回 null（fail-closed）。 */
export function parseVerificationData(json) {
  if (!json || typeof json !== "object" || json.schemaVersion !== VERIFY_SOURCE.schemaVersion) return null;
  const entries = Array.isArray(json.plugins) ? json.plugins : [];
  const map = new Map();
  for (const e of entries) {
    const fullName = parseVerificationFullName(e);
    if (!fullName) continue;
    const v = {
      // 开放数据层只收录通过验证的插件；fail 结论由报告本体承载（reportUrl 直达明细）
      verdict: "pass",
      verifiedBy: typeof e.verifiedBy === "string" && e.verifiedBy ? e.verifiedBy : "dsh-plugin-verify",
      verifiedAt: typeof e.verifiedAt === "string" ? e.verifiedAt : "",
      reportUrl: typeof e.reportUrl === "string" ? e.reportUrl : "",
      schemaVersion: json.schemaVersion
    };
    if (typeof e.waterfall === "string") v.waterfall = e.waterfall;
    if (typeof e.toolsResult === "boolean") v.toolsResult = e.toolsResult;
    map.set(fullName.toLowerCase(), v);
  }
  return map;
}

/** 验证徽标盖章（纯函数）：命中 map 的条目平铺写 verdict/verifiedBy/verifiedAt/
 *  reportUrl/schemaVersion（+waterfall/toolsResult 摘要证据）；未命中删除全部旧字段
 *  （证据随每轮构建刷新，防过期误导）。full_name 大小写不敏感。
 * @param {Array} repos registry 条目数组
 * @param {Map<string,Object>} verificationMap 小写 full_name → 验证证据 */
export function applyVerification(repos, verificationMap) {
  const KEYS = ["verdict", "verifiedBy", "verifiedAt", "reportUrl", "schemaVersion", "waterfall", "toolsResult"];
  for (const repo of repos) {
    const v = verificationMap.get(String(repo.full_name ?? "").toLowerCase());
    if (v) Object.assign(repo, v);
    else for (const k of KEYS) delete repo[k];
  }
  return repos;
}

/** 抓取 verified.json 并解析为盖章 Map；抓取失败 / 格式不符返回 null
 *  （本次构建不盖章，增量模式旧字段保留，下次构建恢复）。 */
async function fetchVerificationMap() {
  try {
    const url = `https://raw.githubusercontent.com/${VERIFY_SOURCE.repo}/${VERIFY_SOURCE.branch}/${VERIFY_SOURCE.file}`;
    const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      log(`验证数据源 ${VERIFY_SOURCE.repo} 抓取失败：HTTP ${res.status}`);
      return null;
    }
    const map = parseVerificationData(JSON.parse(await res.text()));
    if (map === null) {
      log(`验证数据源 schemaVersion 不匹配（期望 ${VERIFY_SOURCE.schemaVersion}）：本次不盖章（fail-closed）`);
      return null;
    }
    return map;
  } catch (error) {
    log(`验证数据源 ${VERIFY_SOURCE.repo} 抓取失败：${error.message}`);
    return null;
  }
}

/**
 * ── 披露徽章（discussion #2269 合规层对接：wwumit/skills-catalog 开放数据层）──
 * 数据源：catalog.json（wwumit 2026-08-16 确认的「方案 B」聚合形态，21 个精选技能全部带
 * disclosure）。字段契约：
 *   - fullName（发布仓 owner/name）为稳定映射键，与验证层同款匹配逻辑
 *   - disclosure 对象（camelCase）：cloud / network / offlineMode / apiKeys[] / jurisdiction / retention
 *   - disclosureSchemaVersion（"0.2"）独立于验证层 schemaVersion；≠0.2 整体跳过不盖章（fail-closed）
 * 盖章语义与验证徽章一致：每轮构建统一重算，抓取失败时增量模式保留旧字段，下次构建恢复。
 */
const DISCLOSURE_SOURCE = {
  repo: "wwumit/skills-catalog",
  branch: "main",
  file: "catalog.json",
  schemaVersion: 1,
  disclosureSchemaVersion: "0.2"
};

/** 解析 catalog.json 为 小写 fullName → { disclosure, disclosureSchemaVersion } Map（纯函数）。
 *  顶层 schemaVersion / disclosureSchemaVersion 任一不匹配返回 null（fail-closed）。
 *  缺 fullName 或缺 disclosure 对象的条目跳过（不盖章）。 */
/** 聚合多个技能条目的披露为仓级披露（纯函数）：network/apiKeys/jurisdiction 去重合并，
 *  retention 取最严等级（none < session < server），offlineMode 全为 true 才 true。
 *  供双颗粒度形态（repos[].cloudSkills）聚合云端技能详情用。 */
function aggregateDisclosure(entries, isCloud) {
  if (entries.length === 0) return null;
  const retentionRank = { none: 0, session: 1, server: 2 };
  const out = {
    cloud: isCloud,
    network: [],
    offlineMode: true,
    apiKeys: [],
    jurisdiction: [],
    retention: "none"
  };
  for (const e of entries) {
    const d = e.disclosure;
    if (!d || typeof d !== "object") continue;
    for (const n of Array.isArray(d.network) ? d.network : []) if (!out.network.includes(n)) out.network.push(n);
    if (d.offlineMode === false) out.offlineMode = false;
    for (const k of Array.isArray(d.apiKeys) ? d.apiKeys : []) {
      if (!out.apiKeys.some((x) => x && x.env === (k && k.env))) out.apiKeys.push(k);
    }
    for (const j of Array.isArray(d.jurisdiction) ? d.jurisdiction : []) if (!out.jurisdiction.includes(j)) out.jurisdiction.push(j);
    if (typeof d.retention === "string" && (retentionRank[d.retention] ?? -1) > (retentionRank[out.retention] ?? -1)) out.retention = d.retention;
  }
  return out;
}

/** 解析 catalog.json 为 小写 fullName → { disclosure, disclosureSchemaVersion } Map（纯函数）。
 *  顶层 schemaVersion / disclosureSchemaVersion 任一不匹配返回 null（fail-closed）。
 *  双颗粒度形态（wwumit 2026-08-16 新增）：`repos[].cloudSkills` 定仓级 cloud，
 *  云端技能详情从 `skills[]` 聚合合并（端点/凭据/法域全量，不丢任一技能）；
 *  旧形态（无 repos 数组）回退：技能条目按 fullName 聚合，cloud:true 优先（fail-safe）。 */
export function parseDisclosureData(json) {
  if (!json || typeof json !== "object") return null;
  if (json.schemaVersion !== DISCLOSURE_SOURCE.schemaVersion) return null;
  if (String(json.disclosureSchemaVersion) !== DISCLOSURE_SOURCE.disclosureSchemaVersion) return null;
  const skills = Array.isArray(json.skills) ? json.skills : [];
  const repos = Array.isArray(json.repos) ? json.repos : [];
  const map = new Map();

  // 技能级条目索引（小写 fullName → 条目数组）
  const skillsByRepo = new Map();
  for (const s of skills) {
    const repoKey = String(s?.fullName ?? "").toLowerCase();
    if (!repoKey.includes("/")) continue;
    if (!s.disclosure || typeof s.disclosure !== "object") continue;
    if (!skillsByRepo.has(repoKey)) skillsByRepo.set(repoKey, []);
    skillsByRepo.get(repoKey).push(s);
  }

  if (repos.length > 0) {
    for (const r of repos) {
      const key = String(r?.fullName ?? "").toLowerCase();
      if (!key.includes("/")) continue;
      const cloudNames = new Set(Array.isArray(r.cloudSkills) ? r.cloudSkills : []);
      const repoSkills = skillsByRepo.get(key) ?? [];
      const cloudSkills = repoSkills.filter((s) => cloudNames.has(s.name));
      const disclosure = aggregateDisclosure(cloudSkills.length > 0 ? cloudSkills : repoSkills.slice(0, 1), cloudSkills.length > 0);
      if (!disclosure) continue;
      map.set(key, { disclosure, disclosureSchemaVersion: String(json.disclosureSchemaVersion) });
    }
  } else {
    for (const [key, entries] of skillsByRepo) {
      const pick = entries.find((s) => s.disclosure.cloud === true) ?? entries[0];
      map.set(key, { disclosure: pick.disclosure, disclosureSchemaVersion: String(json.disclosureSchemaVersion) });
    }
  }
  return map;
}

/** 披露徽章盖章（纯函数）：命中 map 的条目平铺写 disclosure + disclosureSchemaVersion；
 *  未命中删除旧字段（证据随每轮构建刷新，防过期误导）。full_name 大小写不敏感。 */
export function applyDisclosure(repos, disclosureMap) {
  for (const repo of repos) {
    const d = disclosureMap.get(String(repo.full_name ?? "").toLowerCase());
    if (d) Object.assign(repo, d);
    else {
      delete repo.disclosure;
      delete repo.disclosureSchemaVersion;
    }
  }
  return repos;
}

/** 抓取 catalog.json 并解析为盖章 Map；抓取失败 / 版本不符返回 null
 *  （本次构建不盖章，增量模式旧字段保留，下次构建恢复）。 */
async function fetchDisclosureMap() {
  try {
    const url = `https://raw.githubusercontent.com/${DISCLOSURE_SOURCE.repo}/${DISCLOSURE_SOURCE.branch}/${DISCLOSURE_SOURCE.file}`;
    const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      log(`披露数据源 ${DISCLOSURE_SOURCE.repo} 抓取失败：HTTP ${res.status}`);
      return null;
    }
    const map = parseDisclosureData(JSON.parse(await res.text()));
    if (map === null) {
      log(`披露数据源 schema 不匹配（期望 disclosureSchemaVersion ${DISCLOSURE_SOURCE.disclosureSchemaVersion}）：本次不盖章（fail-closed）`);
      return null;
    }
    return map;
  } catch (error) {
    log(`披露数据源 ${DISCLOSURE_SOURCE.repo} 抓取失败：${error.message}`);
    return null;
  }
}

/**
 * DSH 插件能力判定（与 lib/index.js、verify-installability.mjs 同款标准，本文件为唯一脚本侧来源）：
 * package.json 有 dsh 字段，或依赖 @deepseek-ai/cordis、@deepseek-ai/dsh、@deepseek-ai/dsh-* 任一。
 */
export function looksLikeDshPlugin(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  if (pkg.dsh && typeof pkg.dsh === "object") return true;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  const names = Object.keys(deps);
  return names.includes("@deepseek-ai/cordis") || names.includes("@deepseek-ai/dsh") || names.some((n) => n.startsWith("@deepseek-ai/dsh-"));
}

/**
 * bundle 声明判定（与 lib/index.js isBundlePackage 同款）：dsh.bundle.patch 非空字符串。
 * bundle 包经 profile bundles 层注册（issue #134），与普通 cordis 插件安装路径不同。
 */
export function isBundlePackage(pkg) {
  return Boolean(pkg && typeof pkg === "object" && pkg.dsh && typeof pkg.dsh === "object"
    && pkg.dsh.bundle && typeof pkg.dsh.bundle === "object"
    && typeof pkg.dsh.bundle.patch === "string" && pkg.dsh.bundle.patch.length > 0);
}

/** DSH 生态 topics 白名单：含这些主题的仓库即使根清单无 dsh 声明也不盖
 *  「非 DSH 插件」（技能/预设/多包形态的根清单判定不适用，避免误伤）。 */
const DSH_TOPIC_HINTS = new Set(["cordis-plugin", "cordis", "dsh-skill", "agent-skills", "dsh-preset", "agent-preset"]);

/**
 * 高 star 蹭 topic 兜底盖章（纯函数，build-registry 内 applyPlainPkgFallback 的文档见调用处）：
 * 根 package.json 明确无 DSH 能力声明（__plainPkg 标记，enrichPkgNames 抓取时记录）+
 * 无探测结论 + 无 verified-install 人工标注 + topics 无 DSH 生态信号 + star ≥ minStars
 * → installable = "non-plugin"（客户端显示「非 DSH 插件」红标）。
 * 教训案例：amruthpillai/reactive-resume（★40k 简历项目）、volcengine/OpenViking（★28k）
 * 打 dsh-plugin topic 蹭收录，installability 探测未覆盖时卡片无任何警示。
 * 已有 installable 结论的条目不动——探测报告（verify-installability.mjs）是权威刷新源。
 */
export function applyPlainPkgFallback(repos, minStars = 3000) {
  for (const repo of repos) {
    if (repo.__plainPkg !== true) continue;
    if (repo.installable !== void 0) continue;
    if (Array.isArray(repo.market_tags) && repo.market_tags.includes("verified-install")) continue;
    if ((repo.stargazers_count ?? 0) < minStars) continue;
    if (Array.isArray(repo.topics) && repo.topics.some((t) => DSH_TOPIC_HINTS.has(String(t)))) continue;
    repo.installable = "non-plugin";
  }
  return repos;
}

/**
 * 插件分类（纯函数）：扫描 description + name + 过滤后的 topics，按规则优先级匹配。
 * 返回分类 id；无匹配返回 "other"。
 */
export function classifyRepo(repo) {
  const overridden = CATEGORY_OVERRIDES.get(String(repo.full_name ?? ""));
  if (overridden) return overridden;
  const text = categoryText(repo);
  for (const rule of CATEGORY_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) return rule.id;
    }
  }
  return CATEGORY_OTHER;
}

/**
 * pkg_name 冲突消解（纯函数）：同名 npm 包在 node_modules 的安装目标互斥（同目录互相覆盖），
 * 索引并列会误导（显示两张卡、装一个盖掉另一个，如 dsh-archive-viewer 的 keepermttl/csiroqa）。
 * 保留 Star 高者，低者移入 dropped。无 pkg_name 的条目按 full_name 天然唯一，不参与冲突。
 * @returns {{ repos: Array, dropped: string[] }} dropped 为被隐藏条目的 full_name 列表。
 */
export function dedupeByPkgName(repos) {
  const byKey = new Map();
  const dropped = [];
  for (const r of repos) {
    const key = r.pkg_name ? `pkg:${r.pkg_name}` : `repo:${r.full_name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    const prevStars = prev.stargazers_count ?? 0;
    const curStars = r.stargazers_count ?? 0;
    if (curStars > prevStars) {
      dropped.push(prev.full_name);
      byKey.set(key, r);
    } else {
      dropped.push(r.full_name);
    }
  }
  return { repos: [...byKey.values()], dropped };
}

/** 构造 star 范围查询串：{ min:100, max:null } → "stars:>=100"；{ min:0, max:0 } → "stars:0"；
 *  带 timeRange 时追加 " pushed:YYYY-MM-DD..YYYY-MM-DD"（单值段的第二维度）；
 *  增量模式（since 非空且无 timeRange）时追加 " pushed:>=YYYY-MM-DD"。 */
export function starRangeQuery(topic, seg, since) {
  const max = seg.max ?? null;
  const range = max === null
    ? `stars:>=${seg.min}`
    : (seg.min === max ? `stars:${seg.min}` : `stars:${seg.min}..${max}`);
  const time = seg.timeRange ? ` pushed:${seg.timeRange}` : (since ? ` pushed:>=${since}` : "");
  return `topic:${topic} ${range}${time}`;
}

/** 日期字符串取中（YYYY-MM-DD），用于时间窗口二分。 */
export function midDateStr(a, b) {
  const ta = Date.parse(a + "T00:00:00Z");
  const tb = Date.parse(b + "T00:00:00Z");
  return new Date(Math.floor((ta + tb) / 2)).toISOString().slice(0, 10);
}

/** 段分裂：普通段按 star 对半；单值段（min===max）按 pushed 时间窗口二分（第二维度）。
 *  时间窗口窄于 MIN_WINDOW_DAYS 天时不再分裂（0-star 长尾仓库极多，按周切会无限查询）。 */
export function splitSegment(seg) {
  if (seg.min === seg.max) {
    const [a, b] = (seg.timeRange || "2008-01-01..2026-12-31").split("..");
    const days = Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
    if (days <= MIN_WINDOW_DAYS) return []; // 窗口已到最小粒度，接受该窗口最多 1000 条
    const mid = midDateStr(a, b);
    if (mid === a || mid === b) return [];
    return [
      { min: seg.min, max: seg.max, timeRange: `${a}..${mid}` },
      { min: seg.min, max: seg.max, timeRange: `${mid}..${b}` }
    ];
  }
  const hi = seg.max ?? 100000000;
  const mid = Math.floor((hi + seg.min) / 2);
  return [
    { min: seg.min, max: mid },
    { min: mid + 1, max: seg.max }
  ];
}

/**
 * v1.3：单 star 段拉取（sort=stars 降序，最多 10 页 = 1000 条）。
 * 返回 { repos, newCount, full, failed }：
 *   full=false 表示 10 页全满、该段可能还有更多（需分裂）；
 *   newCount=0 表示本段没有新增仓库（数据已被其他段覆盖）→ 调用方直接收敛，不再分裂；
 *   failed=true 表示中途有页面失败（限流/网络）→ 数据可能不全，调用方标记未完成但不分裂。
 */
/** B2 门控测试导出：单段抓取（fork 排除在循环内）。 */
export async function fetchStarSegment(topic, seg, since) {
  const query = starRangeQuery(topic, seg, since);
  const collected = [];
  const seen = new Set();
  let newCount = 0;
  for (let page = 1; page <= 10; page++) {
    let data;
    try {
      data = await fetchPage(query, page, "stars");
    } catch (error) {
      // 单页失败：使用已收集数据并标记 failed（该段视为拉完，避免限流下死循环/雪崩）
      log(`[seg:${query}] page ${page} 失败：${error.message}，使用已收集的 ${collected.length} 条`);
      return { repos: collected, newCount, full: true, failed: true };
    }
    const items = data.items ?? [];
    for (const r of items) {
      // B2：fork 真排除（带 topic 的 fork 不是独立插件，纯噪音）——降权无价值，直接不进索引
      if (seen.has(r.full_name) || EXCLUDED.has(r.name) || r.fork === true) continue;
      seen.add(r.full_name);
      collected.push(normalize(r));
      newCount++;
    }
    log(`[seg:${query}] page ${page}: +${items.length}（新增 ${newCount}）`);
    if (items.length < PER_PAGE) return { repos: collected, newCount, full: true }; // 段内拉完
    await sleep(DELAY_MS);
  }
  return { repos: collected, newCount, full: false }; // 10 页全满 → 可能还有更多，需要分裂
}

/**
 * v1.3.1：dsh / skills 模式获取——star 分段 BFS，段拉满 1000 条则对半分裂递归。
 * since 非空 = 增量模式：所有查询加 pushed:>=since（只拉最近更新的仓库），
 * 单值段（stars:0）初始时间窗口以 since 为下界；老仓库由调用方从旧索引继承。
 * 返回 { repos, complete }（complete=true 表示所有段都收敛）。
 */
async function crawlByStars(topic, since) {
  const all = [];
  const seen = new Set();
  // 增量模式：单值段初始时间窗口 = since..未来（避免 splitSegment 用 2008 默认下界）
  const queue = since
    ? SKILL_STAR_SEGMENTS.map((seg) => seg.min === seg.max
        ? { ...seg, timeRange: `${since}..${incrementalEndDate()}` }
        : { ...seg })
    : [...SKILL_STAR_SEGMENTS];
  let complete = true;
  while (queue.length > 0) {
    if (queue.length > SEGMENT_QUEUE_LIMIT) {
      log(`[${topic}] 分段队列超过上限 ${SEGMENT_QUEUE_LIMIT}，停止分裂（结果可能不全）`);
      complete = false;
      break;
    }
    const seg = queue.shift();
    const { repos, newCount, full, failed } = await fetchStarSegment(topic, seg, since);
    let added = 0;
    for (const r of repos) {
      if (seen.has(r.full_name)) continue;
      seen.add(r.full_name);
      all.push(r);
      added++;
    }
    log(`[${topic}] 段 ${starRangeQuery(topic, seg, since)}：+${added}（累计 ${all.length}）${failed ? "，部分失败不完整" : (newCount === 0 ? "，无新增收敛" : (full ? "，收敛" : "，拉满需分裂"))}`);
    if (failed) {
      // 段内页面失败（限流/网络）：数据可能不全，标记未完成；不再分裂，避免限流下雪崩
      complete = false;
    } else if (!full && newCount > 0) {
      // 拉满 1000 条且有新增 → 分裂（普通段按 star 对半；单值段按时间窗口二分）
      const children = splitSegment(seg);
      if (children.length === 0) {
        log(`[${topic}] 段 ${starRangeQuery(topic, seg, since)} 已到最小粒度仍超 1000 条，接受部分结果`);
        complete = false;
      } else {
        queue.push(...children);
        complete = false;
      }
    } else if (!full) {
      // 拉满但 0 新增：本段数据已被其他段覆盖，继续分裂只会重复拉取，直接收敛
      complete = false;
    }
    await sleep(DELAY_MS);
  }
  return { repos: all, complete };
}

/**
 * 获取全部仓库：dsh / skills 模式统一用 stars 分段全量（突破单 query 1000 条上限），
 * 失败回退单 query 分页（兜底仍受 1000 条/query 物理上限限制，标记部分结果而非完整）。
 * INCREMENTAL_DAYS>0 时进入增量模式（只拉最近更新的仓库，老条目由旧索引继承）。
 */
async function fetchAllTopics() {
  try {
    const merged = new Map();
    let allComplete = true;
    const since = INCREMENTAL_DAYS > 0
      ? new Date(Date.now() - INCREMENTAL_DAYS * 86400000).toISOString().slice(0, 10)
      : null;
    for (const q of QUERIES) {
      // QUERIES 是完整 Search query（"topic:dsh-plugin" / "topic:agent-skills"），分段需要纯 topic 名
      const topic = String(q).replace(/^topic:/, "");
      const { repos, complete } = await crawlByStars(topic, since);
      if (!complete) allComplete = false;
      for (const r of repos) {
        if (!merged.has(r.full_name)) merged.set(r.full_name, r);
      }
    }
    return { repos: [...merged.values()], complete: allComplete, stars: true, incremental: since ? true : false };
  } catch (error) {
    log(`stars 分段拉取失败：${error.message}，回退单 query 分页（1000 条/query 物理上限，结果可能不全）`);
  }
  // ── 兜底：单 query 分页（历史实现；Search API 对单 query 最多返回 1000 条）──
  const merged = new Map();
  let allComplete = true;
  for (const q of QUERIES) {
    let totalCount = null;
    let complete = false;
    let freshCount = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const data = await fetchPage(q, page);
        totalCount = data.total_count ?? totalCount;
        const items = data.items ?? [];
        for (const r of items) {
          if (merged.has(r.full_name)) continue; // 跨 query 全局去重
          if (EXCLUDED.has(r.name)) continue;
          if (r.fork === true) continue; // B2：fork 真排除（兜底路径同款）
          merged.set(r.full_name, normalize(r));
          freshCount++;
        }
        log(`[${q}] page ${page}: +${items.length}（累计 ${merged.size}${totalCount != null ? ` / ${totalCount}` : ""}）`);
        if (items.length < PER_PAGE) { complete = true; break; }
        if (totalCount != null && freshCount >= totalCount) { complete = true; break; }
      } catch (error) {
        // GitHub Search API 硬上限：单 query 最多返回 1000 条（第 11 页起 422）。
        // 这是截断而非完整——标记未完成，让旧索引条目保留合并，避免把部分结果冒充 full。
        const limited = /Only the first 1000 search results/.test(String(error?.message ?? ""));
        if (limited) {
          complete = false;
          log(`[${q}] 已达 Search API 1000 条/query 上限（${freshCount} 条），数据被截断，标记部分结果`);
        } else {
          log(`[${q}] page ${page} 失败：${error.message}（使用已拉取的部分数据）`);
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
    if (!complete) allComplete = false;
  }
  return { repos: [...merged.values()], complete: allComplete };
}

/**
 * 从 Trees 响应中判定探测字段（纯函数，便于测试）：
 * - has_skill: 存在 SKILL.md（仓库根或任意子目录，仅 blob）
 * - has_install_script: 存在 install.sh / install.ps1 / install.bat（安全徽章数据）
 * - 安装形态判定：root_skill（根 SKILL.md = 单技能形态）、
 *   skill_min_depth（SKILL.md 最小路径段数：1=根 / 3=skills/<name>/ 合集 / ≥4=大项目内部埋藏）、
 *   root_script（根 install 脚本）。对齐 verify-installability 的 verdictOf 语义——
 *   skills 条目据此区分「单技能/技能合集/深层埋藏（非市场可装）」。
 * - truncated=true 且未命中 → null（未知）——超大仓库可能没返回完整树，
 *   此时「没扫到」不能断定「没有」，必须记 null，绝不误判 false。
 */
export function classifyTree(tree, truncated) {
  const list = Array.isArray(tree) ? tree : [];
  const skillPaths = list
    .filter((f) => f.type === "blob" && /(^|\/)SKILL\.md$/i.test(String(f.path ?? "")))
    .map((f) => String(f.path ?? ""));
  const hasSkill = skillPaths.length > 0;
  const hasScript = list.some((f) => /(^|\/)install\.(sh|ps1|bat)$/i.test(String(f.path ?? "")));
  const rootSkill = skillPaths.some((p) => /^SKILL\.md$/i.test(p));
  const rootScript = list.some((f) => /^install\.(sh|ps1|bat)$/i.test(String(f.path ?? "")));
  const skillMinDepth = hasSkill ? Math.min(...skillPaths.map((p) => p.split("/").length)) : null;
  return {
    has_skill: hasSkill ? true : (truncated ? null : false),
    has_install_script: hasScript ? true : (truncated ? null : false),
    root_skill: hasSkill ? rootSkill : (truncated ? null : false),
    skill_min_depth: hasSkill ? skillMinDepth : null,
    root_script: hasScript ? rootScript : (truncated ? null : false)
  };
}

/** 增量继承判定（纯函数）：updated_at 未变且旧条目有**真实探测结果**（true/false）→ 整包继承。
 *  null（未知：未探测 / 护栏中断 / truncated 大仓库）不继承——重跑时重新探测，
 *  保证冷启动分批探测能逐步收敛到全量真实结果（truncated 大仓库数量有限，反复重试代价可接受）。
 *  C：skills 模式的形态字段（root_skill/skill_min_depth/root_script）随继承一起带（同一探测来源）。 */
export function shouldInheritProbe(repo, old) {
  return Boolean(old && old.updated_at === repo.updated_at && typeof old.has_skill === "boolean");
}

/**
 * 探测单个仓库（Trees API；爬虫来源无 default_branch 信息，按 main→master 顺序尝试）。
 * 一次调用同时拿到 has_skill / has_install_script。失败容忍：null 表示未知。
 */
async function probeRepo(repo) {
  const branches = [repo.default_branch || "main", "main", "master"].filter((v, i, a) => v && a.indexOf(v) === i);
  let res = null;
  for (const branch of branches) {
    const url = `https://api.github.com/repos/${repo.full_name}/git/trees/${branch}?recursive=1`;
    try {
      res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch {
      continue; // 网络/超时：换分支重试
    }
    if (res.ok) break; // 该分支存在
    if (res.status !== 404) break; // 非 404（限流/无权限等）不再换分支
  }
  if (!res) {
    repo.has_skill = null;
    repo.has_install_script = null;
    return null; // 网络/超时失败：标记未知，无额度信息
  }
  let remaining = null;
  const rl = res.headers.get("x-ratelimit-remaining");
  if (rl != null) remaining = Number(rl);
  if (!res.ok) {
    repo.has_skill = null;
    repo.has_install_script = null;
    return remaining;
  }
  try {
    const data = await res.json();
    const classified = classifyTree(data.tree, data.truncated === true);
    repo.has_skill = classified.has_skill;
    repo.has_install_script = classified.has_install_script;
    // C：安装形态字段（单技能/合集/深层埋藏/根脚本）——仅 skills 模式消费，dsh 模式不写
    if (MODE === "skills") {
      repo.root_skill = classified.root_skill;
      repo.skill_min_depth = classified.skill_min_depth;
      repo.root_script = classified.root_script;
    }
  } catch {
    repo.has_skill = null;
    repo.has_install_script = null;
  }
  return remaining;
}

/** 断点快照写队列（串行化，多 worker 并发写同一文件会交错）。 */
let snapshotQueue = Promise.resolve();
function queueSnapshot(repos) {
  const data = {
    generated_at: new Date().toISOString(),
    schema_version: 1,
    count: repos.length,
    source: "probing",
    repos: repos.map((r) => ({ ...r }))
  };
  snapshotQueue = snapshotQueue
    .then(() => writeFile(PROBE_FILE, JSON.stringify(data, null, 2), "utf8"))
    .catch(() => {});
  return snapshotQueue;
}

/**
 * 并发探测队列 + 额度护栏：
 * - 每次探测后读 X-RateLimit-Remaining，< RATE_LIMIT_FLOOR 立即停止（部分结果照常落盘）；
 * - 边跑边写 PROBE_FILE 快照，进程被杀/中断后重跑同一命令可续（loadExisting 优先读快照）。
 */
async function probeAll(repos, probeQueue) {
  if (probeQueue.length === 0) return;
  log(`开始探测 ${probeQueue.length} 个仓库（Trees API，并发 ${PROBE_CONCURRENCY}，护栏 < ${RATE_LIMIT_FLOOR}）...`);
  let cursor = 0;
  let probeStop = false;
  let probeDone = 0;
  const worker = async () => {
    while (cursor < probeQueue.length && !probeStop) {
      const repo = probeQueue[cursor++];
      const remaining = await probeRepo(repo);
      if (remaining != null && remaining < RATE_LIMIT_FLOOR) {
        log(`额度护栏触发：X-RateLimit-Remaining=${remaining} < ${RATE_LIMIT_FLOOR}，停止探测（结果已落盘，等一小时重跑同一命令可续）`);
        probeStop = true;
      }
      probeDone++;
      if (probeDone % SNAPSHOT_EVERY === 0) await queueSnapshot(repos);
    }
  };
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, () => worker()));
  await snapshotQueue; // 等最后一次快照写完再继续
  log(`探测完成：${probeDone}/${probeQueue.length}（${probeStop ? "额度护栏触发" : "队列耗尽"}）`);
}

async function loadExisting() {
  // skills 模式优先读断点快照（比正式索引新，含中断前的探测进度），实现断点续跑
  const candidates = MODE === "skills" ? [PROBE_FILE, OUT_FILE] : [OUT_FILE];
  for (const file of candidates) {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (data && Array.isArray(data.repos)) return data.repos;
    } catch { /* 首次运行或文件损坏，尝试下一个 */ }
  }
  return [];
}

async function main() {
  log(`模式=${MODE}，queries=[${QUERIES.join(", ")}]，输出=${OUT_FILE}`);
  const { repos: fresh, complete, stars, incremental } = await fetchAllTopics();

  // 增量合并：完整拉取则整体替换，否则保留旧条目（新数据优先）。
  // skills 模式即使完整拉取也必须加载旧索引——探测继承依赖旧探测结果（探测远比 Search 贵）。
  // incremental 也必须加载旧索引：增量只拉最近 N 天 pushed 的仓库，若所有段恰好都收敛
  // （complete=true），不合并会把旧索引整体替换成残缺子集（v1.4.5 修复）。
  // 审查 C3：dsh 全量构建同样必须加载旧索引——分类漂移检测（oldMap 比对旧 category）依赖它；
  // 此前全量分支 existing=[] 导致漂移检测空跑且 0 漂移时误删 drift-report.json。
  // 合并循环对 existing 本就安全（fresh 优先 + stale 剔除），无条件加载无副作用。
  const STALE_DAYS = 14;
  const now = Date.now();
  const existing = await loadExisting();
  const oldMap = new Map(existing.map((r) => [r.full_name, r]));
  const freshNames = new Set(fresh.map((r) => r.full_name));
  const merged = new Map();
  for (const r of [...existing, ...fresh]) {
    if (!r || typeof r.full_name !== "string" || EXCLUDED.has(r.name)) continue;
    const seenAt = freshNames.has(r.full_name)
      ? new Date().toISOString()
      : (r.registry_seen_at || "1970-01-01T00:00:00.000Z");
    if (Date.parse(seenAt) < now - STALE_DAYS * 24 * 3600 * 1000) continue;
    merged.set(r.full_name, { ...r, registry_seen_at: seenAt });
  }
  let repos = [...merged.values()].sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));

  // 适配层（adaptor.json）：移除打错 tag 的错误条目（本体非插件等），补入真实插件条目。
  // 放在富化/分类之前，让补入条目同样获得 pkg_name / category 处理。
  if (MODE === "dsh") {
    const adaptor = JSON.parse(await readFile(join(ROOT, "..", "adaptor.json"), "utf8").catch(() => "{}"));
    const redirects = Array.isArray(adaptor.redirects)
      ? adaptor.redirects.filter((r) => r && typeof r.from === "string" && r.meta && typeof r.meta.full_name === "string")
      : [];
    if (redirects.length > 0) {
      const fromSet = new Set(redirects.map((r) => r.from));
      repos = repos.filter((r) => !fromSet.has(r.full_name));
      for (const r of redirects) {
        if (!repos.some((x) => x.full_name === r.meta.full_name)) {
          repos.push({ ...r.meta, registry_seen_at: new Date().toISOString() });
        }
        log(`适配层：${r.from} → ${r.meta.full_name}`);
      }
    }
  }

  // 人工验证标注（market_tags）：随构建注入，两种模式都打（skills 栏目同样展示）。
  applyMarketTags(repos);

  // skills 模式：增量继承（控额度的命根子）+ Trees 探测
  if (MODE === "skills") {
    const probeQueue = [];
    for (const repo of repos) {
      if (shouldInheritProbe(repo, oldMap.get(repo.full_name))) {
        const old = oldMap.get(repo.full_name);
        Object.assign(repo, {
          has_skill: old.has_skill,
          has_install_script: old.has_install_script,
          pkg_name: old.pkg_name ?? null,
          // C：形态字段随继承带（同一探测来源，updated_at 未变即真实）
          root_skill: old.root_skill,
          skill_min_depth: old.skill_min_depth,
          root_script: old.root_script
        });
      } else {
        probeQueue.push(repo);
      }
    }
    await probeAll(repos, probeQueue);
    // 护栏中断等未探测到的条目补 null，保证三态字段完整（true / false / null 未知）
    for (const repo of repos) {
      if (repo.has_skill === undefined) repo.has_skill = null;
      if (repo.has_install_script === undefined) repo.has_install_script = null;
    }
  }

  // 富化：为缺失 pkg_name 的仓库抓取 package.json 的 name（raw 抓取，不占 API 额度）。
  // 失败容忍：拿不到包名的仓库 pkg_name 为 null，不影响其余功能。
  if (process.env.SKIP_ENRICH === "1") {
    log("SKIP_ENRICH=1：跳过 pkg_name 富化");
  } else {
    await enrichPkgNames(repos, MODE === "dsh");
    // 高 star 蹭 topic 兜底（reactive-resume / OpenViking 教训）：根清单无 DSH 能力声明的
    // 大项目在无探测结论时直接盖「非 DSH 插件」——enrich 阶段顺带判定，零额外请求。
    if (MODE === "dsh") {
      const before = repos.filter((r) => r.installable === "non-plugin").length;
      applyPlainPkgFallback(repos);
      const after = repos.filter((r) => r.installable === "non-plugin").length;
      if (after > before) log(`高 star 兜底盖章：${after - before} 个条目 → non-plugin`);
    }
    // v1.4.11：npm 版本富化（issue #26）——npm 发布型插件的升级提示数据源
    if (MODE === "dsh") await enrichNpmVersions(repos);
  }

  // dsh 模式：按简介/标签关键词分类（skills 模式本期不分类）。
  // 漂移比对（分类漂移检测）：对旧索引里已有 category 的条目，比较旧盖章 vs 本次重分类输出，
  // 不一致 → 元数据漂移（作者改了简介/主题）或人工覆写修正（CATEGORY_OVERRIDES 生效），
  // 写入 drift-report.json（随构建提交）供维护者定期复审——**不阻塞构建**。
  // 增量构建只比对近 N 天新拉取的仓库（旧条目元数据未更新，输出不变）；全量构建比对全索引。
  if (MODE === "dsh") {
    const driftItems = [];
    for (const repo of repos) {
      const prev = oldMap.get(repo.full_name);
      const cat = classifyRepo(repo);
      repo.category = cat;
      if (prev && typeof prev.category === "string" && prev.category !== cat) {
        driftItems.push({
          full_name: repo.full_name,
          previous: prev.category,
          current: cat,
          desc_now: repo.description ?? null,
          desc_prev: prev.description ?? null
        });
      }
    }
    try {
      const reportPath = join(ROOT, "..", "drift-report.json");
      if (driftItems.length > 0) {
        await writeFile(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), count: driftItems.length, items: driftItems }, null, 2) + "\n", "utf8");
        log(`分类漂移 ${driftItems.length} 条（drift-report.json）：${driftItems.map((d) => `${d.full_name} ${d.previous}→${d.current}`).join("、")}`);
      } else {
        await rm(reportPath, { force: true });
      }
    } catch { /* 报告写入失败不阻塞构建 */ }
  }

  // dsh 模式：可安装性徽标盖章（installability-report.json，由 scripts/verify-installability.mjs 刷新）。
  // v1.4.9：修复 ROOT 路径少一层 `..`——build-registry.mjs 的 ROOT 是 scripts/ 目录，
  // 报告在仓库根，旧代码读 scripts/installability-report.json 永远 ENOENT，
  // 导致「非 DSH 插件 / 仅手动安装」徽章自 v1.4.1 起从未在构建产物里盖章。
  if (MODE === "dsh") {
    try {
      const report = JSON.parse(await readFile(join(ROOT, "..", "installability-report.json"), "utf8"));
      const verdictMap = new Map(
        Array.isArray(report.repos) ? report.repos.map((r) => [String(r.full_name), r.verdict]) : []
      );
      applyInstallability(repos, verdictMap);
      // B3：已确认 gone 的条目从索引剔除（报告归档保留，复活自动重收）
      const before = repos.length;
      repos = applyGoneCleanup(repos, verdictMap);
      if (repos.length < before) log(`B3 失效清理：剔除 ${before - repos.length} 个已确认 gone 条目（报告归档可恢复）`);
    } catch {
      log("installability-report.json 缺失或损坏：本次构建不标注可安装性徽标");
    }
  }

  // dsh 模式：pkg_name 冲突消解——同名 npm 包在 node_modules 安装目标互斥，
  // 索引并列会误导（如 dsh-archive-viewer 的 keepermttl/csiroqa 两个仓库）。
  // skills 模式不进 node_modules，同名包不冲突，不去重。
  if (MODE === "dsh") {
    const { repos: deduped, dropped: droppedRepos } = dedupeByPkgName(repos);
    if (droppedRepos.length > 0) {
      for (const fullName of droppedRepos) {
        log(`pkg_name 冲突：隐藏低 Star 条目 ${fullName}（同名 npm 包只能安装一个，请原作者改名）`);
      }
    }
    repos = deduped;
  }

  // 社区精选徽章（v1.4.8）：统一重算（先移除旧标再按最新列表添加），增量构建也能
  // 同步聚合页更新；抓取失败时跳过重算（增量模式旧索引条目保留旧字段，下次构建恢复）。
  if (MODE === "dsh") {
    const picks = await fetchCommunityPicks();
    if (picks.size > 0) {
      let picked = 0;
      for (const repo of repos) {
        const tags = Array.isArray(repo.market_tags) ? repo.market_tags.filter((t) => t !== "community-pick") : [];
        if (picks.has(String(repo.full_name ?? "").toLowerCase()) && repo.installable !== "non-plugin") {
          tags.push("community-pick");
          picked++;
        }
        if (tags.length > 0) repo.market_tags = tags;
        else delete repo.market_tags;
      }
      log(`社区精选打标完成：${picked}/${repos.length} 个仓库`);
    } else {
      log("社区精选列表抓取失败：本次不更新徽章（增量模式旧字段保留，下次构建恢复）");
    }
  }

  // 验证徽章（discussion #2269 对接契约：qing3a/dsh-plugin-verify 开放数据层）。
  // 抓取失败 / schemaVersion 不符 → 本次不盖章（增量模式旧字段保留，下次构建恢复）。
  if (MODE === "dsh") {
    const verificationMap = await fetchVerificationMap();
    if (verificationMap) {
      let stamped = 0;
      for (const repo of repos) {
        if (verificationMap.has(String(repo.full_name ?? "").toLowerCase())) stamped++;
      }
      applyVerification(repos, verificationMap);
      log(`验证徽章盖章完成：${stamped}/${repos.length} 个仓库（${VERIFY_SOURCE.repo}）`);
    }
  }

  // 披露徽章（discussion #2269 合规层对接：wwumit/skills-catalog 开放数据层）。
  // 抓取失败 / disclosureSchemaVersion 不符 → 本次不盖章（fail-closed，增量模式旧字段保留）。
  if (MODE === "dsh") {
    const disclosureMap = await fetchDisclosureMap();
    if (disclosureMap) {
      let stamped = 0;
      for (const repo of repos) {
        if (disclosureMap.has(String(repo.full_name ?? "").toLowerCase())) stamped++;
      }
      applyDisclosure(repos, disclosureMap);
      log(`披露徽章盖章完成：${stamped}/${repos.length} 个仓库（${DISCLOSURE_SOURCE.repo}）`);
    }
  }

  // 清理内部判定标记（不进索引产物）
  for (const repo of repos) delete repo.__plainPkg;

  const out = {
    generated_at: new Date().toISOString(),
    ...(MODE === "skills" ? { schema_version: 1, ...(stars ? { index_mode: incremental ? "incremental" : "stars" } : {}) } : {}), // dsh 模式输出与历史版本逐字段一致（回归）
    count: repos.length,
    source: complete ? "full" : "partial-merge",
    repos
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  const raw = JSON.stringify(out, null, 2) + "\n";
  await writeFile(OUT_FILE, raw, "utf8");
  // #14（issue #14）：同时产出 .json.gz——12MB 索引 gzip 后约 1.5MB，
  // 运行时网络刷新优先拉压缩版（jsDelivr/raw 均按原样提供 .gz 文件）。
  try {
    const gz = gzipSync(raw);
    await writeFile(`${OUT_FILE}.gz`, gz);
    log(`已写入 ${OUT_FILE}.gz（${(gz.length / 1024 / 1024).toFixed(2)} MB）`);
  } catch (error) {
    log(`gzip 产物写入失败（不影响主索引）：${error.message}`);
  }
  if (MODE === "skills") await rm(PROBE_FILE, { force: true }).catch(() => {});
  log(`已写入 ${OUT_FILE}：${repos.length} 个仓库（${out.source}${stars ? "，stars 分段全量" : ""}）`);
}

/** 并发抓取仓库 package.json 的 name 字段写入 pkg_name；includeVersion 时顺带抓 version
 *  （dsh 模式启用——市场「更新」检测用 registry 版本号对比已装版本，不再依赖本地缓存）。
 *  已存在且无需刷新的仓库跳过（skills 模式保持只补缺，避免每次增量全量重抓 12000+ 仓库）。
 *  dsh 模式额外做「根清单 DSH 能力判定」：抓取成功时记录 __plainPkg（无 dsh 能力声明），
 *  供 applyPlainPkgFallback 给高 star 蹭 topic 条目盖章（reactive-resume/OpenViking 教训）。
 *  高 star（≥3000）且无 installable 结论且无 verified-install 标注的条目**每轮重抓**
 *  （数量级几十个，raw 请求无 Core 额度）——真插件补 dsh 声明后兜底徽章自动消失。 */
async function enrichPkgNames(repos, includeVersion = false) {
  const highStarSuspect = (r) => includeVersion
    && (r.stargazers_count ?? 0) >= 3000
    && r.installable === void 0
    && !(Array.isArray(r.market_tags) && r.market_tags.includes("verified-install"));
  // bundle 状态新鲜度敏感（声明可变），带 bundle 标记的条目强制每轮重抓
  // ——否则旧 `bundle: true` 残留（普通插件意外显示 bundle 徽章），或 bundle 移除后永不清除。
  const bundleSuspect = (r) => includeVersion && r.bundle === true;
  const todo = repos.filter((r) => (includeVersion ? !r.pkg_name || !r.version : !r.pkg_name) || highStarSuspect(r) || bundleSuspect(r));
  if (todo.length === 0) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const r = todo[cursor++];
      const url = `https://raw.githubusercontent.com/${r.full_name}/${r.default_branch}/package.json`;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "dsh-plugin-marketplace-registry" },
          signal: AbortSignal.timeout(15000)
        });
        if (res.ok) {
          const pkg = await res.json();
          if (typeof pkg.name === "string" && pkg.name.length > 0) {
            r.pkg_name = pkg.name;
          }
          if (includeVersion && typeof pkg.version === "string" && pkg.version.length > 0) {
            r.version = pkg.version;
          }
          if (includeVersion) {
            r.__plainPkg = looksLikeDshPlugin(pkg) !== true;
            // bundle 声明轻标记——三态写回（是 bundle → true，否 → 清除旧值）。
            // 只条件写 true 会导致仓库从 bundle 变普通插件后旧标记永久残留。
            if (isBundlePackage(pkg)) r.bundle = true; else delete r.bundle;
          }
        }
      } catch { /* 网络失败：保持 null */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  log(`pkg_name 富化完成：${todo.filter((r) => r.pkg_name).length}/${todo.length}${includeVersion ? `，version ${todo.filter((r) => r.version).length}` : ""}`);
}

/**
 * npm 版本富化（v1.4.11）：对有 pkg_name 但缺 npm_version 的仓库查 npm registry
 * （npmmirror）拿 dist-tags.latest 与真实包名，写入 npm_version / npm_pkg_name。
 * 解决 issue #26：monorepo / npm 发布型插件（如 dsh-web-ui）根 package.json version
 * 常年不 bump，GitHub 侧版本与 npm 实际发布版本脱节——npm 型 cli 的自动升级提示
 * 以 npm_version（安装源同源）为准。
 * 继承策略：合并后旧条目保留 npm_version（不重查）；本轮 fresh 重拉的仓库字段缺失 → 重查；
 * 每天 04:00 全量重建（complete 整体替换）时全部重查 → 每天刷新一次 npm 版本。
 * npm 实时性由前端「检测更新」手动按钮兜底（实时查 registry，不依赖索引）。 */
async function enrichNpmVersions(repos) {
  const todo = repos.filter((r) => typeof r.pkg_name === "string" && r.pkg_name.length > 0 && !r.npm_version);
  if (todo.length === 0) return;
  let cursor = 0;
  let hit = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const r = todo[cursor++];
      try {
        const res = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(r.pkg_name)}`, {
          headers: { "User-Agent": "dsh-plugin-marketplace-registry" },
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) continue;
        const d = await res.json();
        if (d && typeof d["dist-tags"]?.latest === "string" && d["dist-tags"].latest.length > 0) {
          r.npm_version = d["dist-tags"].latest;
          // npm 返回的真实包名（monorepo 根 name 可能与实际发布名不同，如 dsh-web-ui → @linxin666/dsh-web-ui-all）
          if (typeof d.name === "string" && d.name.length > 0) r.npm_pkg_name = d.name;
          hit++;
        }
      } catch { /* npm 不可达：保持缺失（前端手动检测兜底） */ }
    }
  };
  await Promise.all(Array.from({ length: 16 }, () => worker()));
  log(`npm 版本富化完成：${hit}/${todo.length}`);
}

// 直接运行才执行 main（被 smoke-tests import 时只暴露纯函数，无副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[registry:${MODE}] 失败：${error.message}`);
    process.exit(1);
  });
}
