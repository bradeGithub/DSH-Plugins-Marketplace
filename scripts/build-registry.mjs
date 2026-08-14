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
 *  窗口窄于该值仍超 1000 条就接受部分结果（0-star 仓库价值最低，不值得穷尽）。 */
const MIN_WINDOW_DAYS = 30;
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

function normalize(r) {
  return {
    full_name: r.full_name,
    name: r.name,
    description: r.description,
    html_url: r.html_url,
    stargazers_count: r.stargazers_count,
    updated_at: r.updated_at,
    default_branch: r.default_branch ?? "main",
    topics: r.topics ?? [],
    license: r.license?.spdx_id ?? null
  };
}

// ── 插件分类（dsh 模式）──
// 基于 description + name + 过滤后的 topics 的关键词规则分类（无需读 README）。
// 规则按优先级排列：先匹配先得（视觉/文档等特异词在前，工具/聚合等宽泛词在后），
// 无匹配 → "other"（其他）。
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
  "chatgpt", "coding-agent", "coding-assistant", "terminal", "tui", "cli"
]);

/** 分类文本：description + name + 过滤掉生态泛标签后的 topics。 */
function categoryText(repo) {
  const topics = (Array.isArray(repo.topics) ? repo.topics : [])
    .filter((t) => !TOPIC_STOP_WORDS.has(String(t).toLowerCase()));
  return [repo.description, repo.name, ...topics].filter(Boolean).join(" \n ");
}

const CATEGORY_RULES = [
  {
    id: "vision",
    patterns: [/vision/i, /image/i, /ocr/i, /screenshot/i, /多模态/, /视觉识别|视觉工具|视觉任务|视觉插件|视觉能力|机器视觉|computer vision/i, /截图/, /图像/, /图片/, /computer[- ]?use/i, /电脑控制/, /image[- ]?to[- ]?text/i, /ui[- ]?restoration/i, /ui[- ]?还原/i]
  },
  {
    id: "document",
    patterns: [/pdf/i, /excel/i, /xlsx/i, /spreadsheet/i, /表格/, /word\b/i, /docx/i, /文档/, /论文/, /paper/i, /ppt/i, /slide/i, /演示/, /presentation/i, /办公/, /office/i, /mermaid/i, /latex/i]
  },
  {
    id: "memory",
    patterns: [/memory/i, /记忆/, /knowledge/i, /知识/, /note/i, /笔记/, /recall/i, /回忆/, /skill[- ]?import/i, /技能/, /knowledge[- ]?graph/i, /知识图谱/, /长期记忆/, /distill/i, /蒸馏/, /memo/i]
  },
  {
    id: "model",
    patterns: [/token/i, /用量/, /cost/i, /成本/, /balance/i, /余额/, /context[- ]?window/i, /上下文/, /provider/i, /计费/, /billing/i, /usage/i, /tps/i, /推理/, /inference/i, /quota/i, /额度/, /deepseek[- ]?api/i, /模型选择/, /model selection/i, /模型路由/, /model routing/i, /llm[- ]?fallback/i, /模型回退/, /token[- ]?stats/i, /token[- ]?usage/i]
  },
  {
    id: "notify",
    patterns: [/notif/i, /通知/, /消息通知|消息提醒|消息推送/, /\bmessage notification/i, /telegram/i, /wechat/i, /微信/, /\bim\b/i, /提醒/, /alert/i, /ntfy/i, /broadcast/i, /广播/, /邮件/, /mail/i, /desktop[- ]?notification/i]
  },
  {
    id: "coding",
    patterns: [/\bcoding/i, /vscode/i, /\bide\b/i, /\blsp\b/i, /\blint/i, /\bgit\b/i, /代码/, /编码/, /debug/i, /调试/, /compile/i, /编译/, /terminal/i, /终端/, /\btui\b/i, /\bbash\b/i, /\bshell\b/i, /编程/, /programming/i, /代码库/, /code[- ]?intelligence/i, /代码检索/, /syntax/i, /语法/, /monaco/i, /编辑器/, /editor/i, /camel/i, /rust/, /typescript/i, /python/i, /harmony/i, /鸿蒙/, /开发/, /developer/i, /dev[- ]?tool/i]
  },
  // 工具强特征（前置）：明确的工具词（MCP server/沙箱/安全/天气/计算器等），
  // 避免被宽泛的 agent 规则抢先（如 "MCP server ... into your agent"）。
  {
    id: "tool",
    patterns: [/mcp[- ]?server/i, /sandbox/i, /沙箱/, /security/i, /安全/, /guardrail/i, /护栏/, /weather/i, /天气/, /calculator/i, /计算器/, /行情/, /ticker/i, /会议/, /meeting/i, /benchmark/i, /基准/, /fuzzer/i, /模糊测试/, /vault/i, /密码/, /credential/i, /凭据/, /encrypt/i, /加密/, /\botp\b/i, /\btotp\b/i, /profiler/i, /性能分析/, /探针/]
  },
  {
    id: "conversation",
    patterns: [/conversation/i, /对话/, /session/i, /会话/, /message[- ]?edit/i, /消息编辑/, /\bshare/i, /分享/, /rewind/i, /回退/, /annotation/i, /批注/, /\bchat/i, /聊天/, /\bturn\b/i, /回合/, /composer/i, /输入框/, /input[- ]?history/i, /粘贴/, /paste/i, /prompt/i, /提示词/, /回复/, /reply/i]
  },
  {
    id: "web-ui",
    patterns: [/\bui\b/i, /界面/, /skin/i, /皮肤/, /theme/i, /主题/, /sidebar/i, /侧边栏/, /whale/i, /鲸鱼/, /\bpet\b/i, /宠物/, /美化/, /wallpaper/i, /壁纸/, /widget/i, /组件/, /home[- ]?page/i, /主页/, /status[- ]?bar/i, /状态栏/, /style/i, /样式/, /minigame/i, /小游戏/, /game/i, /游戏/, /panel/i, /面板/, /banner/i, /横幅/, /广告/, /tab/i, /标签页/, /dock/i, /icon/i, /图标/, /avatar/i, /头像/]
  },
  {
    id: "agent",
    patterns: [/\bagent\b(?!s)/i, /sub[- ]?agents?/i, /agentteams/i, /agent team/i, /multi[- ]?agent/i, /智能体/, /automation/i, /自动化/, /workflow/i, /工作流/, /orchestrat/i, /编排/, /\bteam\b/i, /团队/, /subagent/i, /子代理/, /\bloop\b/i, /调度/, /scheduler/i, /autonomous/i, /自主/, /harness/i, /cowork/i, /协作/]
  },
  {
    id: "tool",
    patterns: [/weather/i, /天气/, /search/i, /搜索/, /browser/i, /浏览器/, /\btool/i, /工具/, /calculator/i, /计算器/, /\bjson\b/i, /\bcsv\b/i, /\bregex\b/i, /encoding/i, /编码转换/, /\bstat\b/i, /schema/i, /mcp[- ]?server/i, /sandbox/i, /沙箱/, /security/i, /安全/, /guardrail/i, /护栏/, /protocol/i, /协议/, /remote/i, /远程/, /dns/i, /网络/, /network/i, /performance/i, /性能/, /benchmark/i, /基准/, /profiler/i, /profile/i, /fuzzer/i, /模糊测试/, /health/i, /健康检查/, /check/i, /检查/, /monitor/i, /监控/, /备份/, /backup/i, /sync/i, /同步/, /export/i, /导入/, /import/i, /convert/i, /转换/, /decode/i, /解码/, /encode/i, /压缩/, /zip/i, /file/i, /文件/, /vault/i, /密码/, /credential/i, /凭据/, /encrypt/i, /加密/, /totp/i, /otp/i]
  },
  {
    id: "resource",
    patterns: [/awesome/i, /精选/, /聚合/, /handbook/i, /手册/, /\bstore\b/i, /商店/, /directory/i, /目录/, /\blist\b/i, /列表/, /collection/i, /集合/, /plugin[- ]?manager/i, /插件管理/, /registry/i, /marketplace/i, /市场/, /生态/, /ecosystem/i, /(?<!Git)hub\b/i, /社区/, /community/i, /教程/, /tutorial/i, /guide/i, /指南/, /documentation/i, /文档站/, /catalog/i, /雷达/, /radar/i, /tracking/i, /追踪/, /compat/i, /兼容/]
  }
];
const CATEGORY_OTHER = "other";

/**
 * 插件分类（纯函数）：扫描 description + name + 过滤后的 topics，按规则优先级匹配。
 * 返回分类 id；无匹配返回 "other"。
 */
export function classifyRepo(repo) {
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
async function fetchStarSegment(topic, seg, since) {
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
      if (seen.has(r.full_name) || EXCLUDED.has(r.name)) continue;
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
 * - truncated=true 且未命中 → null（未知）——超大仓库可能没返回完整树，
 *   此时「没扫到」不能断定「没有」，必须记 null，绝不误判 false。
 */
export function classifyTree(tree, truncated) {
  const list = Array.isArray(tree) ? tree : [];
  const hasSkill = list.some((f) => f.type === "blob" && /(^|\/)SKILL\.md$/i.test(String(f.path ?? "")));
  const hasScript = list.some((f) => /(^|\/)install\.(sh|ps1|bat)$/i.test(String(f.path ?? "")));
  return {
    has_skill: hasSkill ? true : (truncated ? null : false),
    has_install_script: hasScript ? true : (truncated ? null : false)
  };
}

/** 增量继承判定（纯函数）：updated_at 未变且旧条目有**真实探测结果**（true/false）→ 整包继承。
 *  null（未知：未探测 / 护栏中断 / truncated 大仓库）不继承——重跑时重新探测，
 *  保证冷启动分批探测能逐步收敛到全量真实结果（truncated 大仓库数量有限，反复重试代价可接受）。 */
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
  const STALE_DAYS = 14;
  const now = Date.now();
  const existing = (MODE === "skills" || !complete) ? await loadExisting() : [];
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

  // skills 模式：增量继承（控额度的命根子）+ Trees 探测
  if (MODE === "skills") {
    const probeQueue = [];
    for (const repo of repos) {
      if (shouldInheritProbe(repo, oldMap.get(repo.full_name))) {
        const old = oldMap.get(repo.full_name);
        Object.assign(repo, {
          has_skill: old.has_skill,
          has_install_script: old.has_install_script,
          pkg_name: old.pkg_name ?? null
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
  }

  // dsh 模式：按简介/标签关键词分类（skills 模式本期不分类）
  if (MODE === "dsh") {
    for (const repo of repos) repo.category = classifyRepo(repo);
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

  const out = {
    generated_at: new Date().toISOString(),
    ...(MODE === "skills" ? { schema_version: 1, ...(stars ? { index_mode: incremental ? "incremental" : "stars" } : {}) } : {}), // dsh 模式输出与历史版本逐字段一致（回归）
    count: repos.length,
    source: complete ? "full" : "partial-merge",
    repos
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  if (MODE === "skills") await rm(PROBE_FILE, { force: true }).catch(() => {});
  log(`已写入 ${OUT_FILE}：${repos.length} 个仓库（${out.source}${stars ? "，stars 分段全量" : ""}）`);
}

/** 并发抓取仓库 package.json 的 name 字段写入 pkg_name；includeVersion 时顺带抓 version
 *  （dsh 模式启用——市场「更新」检测用 registry 版本号对比已装版本，不再依赖本地缓存）。
 *  已存在且无需刷新的仓库跳过（skills 模式保持只补缺，避免每次增量全量重抓 12000+ 仓库）。 */
async function enrichPkgNames(repos, includeVersion = false) {
  const todo = repos.filter((r) => (includeVersion ? !r.pkg_name || !r.version : !r.pkg_name));
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
        }
      } catch { /* 网络失败：保持 null */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  log(`pkg_name 富化完成：${todo.filter((r) => r.pkg_name).length}/${todo.length}${includeVersion ? `，version ${todo.filter((r) => r.version).length}` : ""}`);
}

// 直接运行才执行 main（被 smoke-tests import 时只暴露纯函数，无副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[registry:${MODE}] 失败：${error.message}`);
    process.exit(1);
  });
}
