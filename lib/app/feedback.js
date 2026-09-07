export function createFeedbackUseCase({
  feedbackFile,
  marketRoot,
  readStateJson,
  mkdir,
  writeFile,
  queue,
  fetchImpl,
  readBodyLimited,
  timeoutSignal,
  selfUpdateRepo,
  feedbackLogTail,
  translate,
  now = () => Date.now()
}) {
  let pendingFeedback = [];
  let feedbackToken = "";
  const message = (lang, key, params) => translate(lang ?? "zh", key, params);

  const persist = async () => {
    await mkdir(marketRoot, { recursive: true });
    await writeFile(
      feedbackFile,
      JSON.stringify({ pending: pendingFeedback, token: feedbackToken }, null, 2),
      "utf8"
    );
  };

  const buildIssue = (entry, ok, note, withLog) => {
    const title = `[安装反馈] ${ok ? "正常" : "异常"}: ${entry.repo}`;
    const resultText = ok ? "正常 / Works" : "异常 / Broken";
    const logBlock = withLog && !ok && typeof entry.logSnapshot === "string" && entry.logSnapshot.length > 0
      ? `\n<details><summary>安装日志（尾部 ${feedbackLogTail} 行，已脱敏）/ Install log (last ${feedbackLogTail} lines, sanitized)</summary>\n\n\`\`\`\n${entry.logSnapshot}\n\`\`\`\n\n</details>`
      : "";
    const env = entry.envProfile && typeof entry.envProfile === "object" ? entry.envProfile : null;
    const envParts = env ? [env.platform, `Node ${env.node}`] : [];
    if (env?.dsh) envParts.push(`DSH ${env.dsh}`);
    if (env?.market) envParts.push(`市场 / Marketplace v${env.market}`);
    if (env?.pnpm) envParts.push(`pnpm ${env.pnpm}`);
    if (env?.git) envParts.push(`git ${env.git}`);
    const envText = envParts.length > 0 ? envParts.join(" · ") : "unknown";
    const body = [
      "<!-- dsh-plugin-marketplace auto-feedback -->",
      "",
      "## 安装反馈 / Install Feedback",
      "",
      "| | |",
      "|---|---|",
      `| 插件 / Plugin | ${entry.name ?? entry.repo} |`,
      `| 仓库 / Repo | ${entry.repo} |`,
      `| 类型 / Type | ${entry.type ?? "unknown"} |`,
      `| 版本 / Version | ${entry.version ?? "unknown"} |`,
      `| 安装方式 / Method | ${entry.method ?? "unknown"} |`,
      entry.reinstall === true ? "| 重装 / Reinstall | yes |" : "",
      `| 时间 / Time | ${new Date(entry.installedAt ?? now()).toISOString().slice(0, 16)} UTC |`,
      `| 结果 / Result | ${resultText} |`,
      "",
      `**环境 / Environment**: ${envText}`,
      note ? `\n**用户描述 / User notes**\n\n> ${note}` : "",
      logBlock,
      "",
      "---",
      "",
      "_(由 DSH 插件市场自动提交 / Auto-submitted by dsh-plugin-marketplace)_"
    ].filter((line) => line !== "").join("\n");
    return { title, body };
  };

  const submitToGitHub = async (entry, ok, note) => {
    const withLog = !ok;
    const { title, body } = buildIssue(entry, ok, note, withLog);
    const manualBody = withLog ? buildIssue(entry, ok, note, false).body : body;
    const manualUrl = `https://github.com/${selfUpdateRepo}/issues/new?${new URLSearchParams({ title, body: manualBody }).toString()}`;
    if (!feedbackToken) return { manualUrl };

    const createIssue = async (withLabels) => {
      const labels = ["install-feedback", ...(ok ? [] : ["install-failed"] )];
      const payload = { title, body };
      if (withLabels) payload.labels = labels;
      return await fetchImpl(`https://api.github.com/repos/${selfUpdateRepo}/issues`, {
        method: "POST",
        headers: {
          "User-Agent": "dsh-plugin-marketplace",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${feedbackToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: timeoutSignal()
      });
    };

    try {
      let response = await createIssue(true);
      if (response.status === 422) response = await createIssue(false);
      if (!response.ok) return { manualUrl, error: `GitHub API ${response.status}` };
      const issue = JSON.parse((await readBodyLimited(response)).toString("utf8"));
      return { issueUrl: issue.html_url };
    } catch (error) {
      return { manualUrl, error: String(error?.message ?? error) };
    }
  };

  return {
    getState: () => ({ pending: pendingFeedback, hasToken: Boolean(feedbackToken) }),
    getPending: () => pendingFeedback,
    async load() {
      await queue.add(async () => {
        const data = await readStateJson(feedbackFile);
        if (data) {
          if (Array.isArray(data.pending)) pendingFeedback = data.pending;
          if (typeof data.token === "string") feedbackToken = data.token;
        }
      });
    },
    async saveFeedback() {
      await queue.add(persist);
    },
    async queueFeedback(entry) {
      await queue.add(async () => {
        pendingFeedback = pendingFeedback.filter((item) => item.repo !== entry.repo);
        pendingFeedback.push(entry);
        await persist();
      });
    },
    async queueFeedbackSafe(entry, logLine, lang) {
      try {
        await this.queueFeedback(entry);
      } catch (error) {
        logLine?.(message(lang, "feedbackQueueFail", { err: String(error?.message ?? error).slice(0, 120) }));
      }
    },
    removePendingFeedback(repo) {
      const before = pendingFeedback.length;
      pendingFeedback = pendingFeedback.filter((entry) => entry.repo !== repo);
      return pendingFeedback.length !== before;
    },
    async submitFeedback({ repo, ok, note, lang }) {
      const entry = await queue.add(async () => {
        const index = pendingFeedback.findIndex((item) => item.repo === repo);
        if (index === -1) return null;
        const [next] = pendingFeedback.splice(index, 1);
        await persist();
        return next;
      });
      if (!entry) {
        return {
          status: "not-found",
          repo,
          issueUrl: null,
          error: message(lang, "feedbackNotFound")
        };
      }
      return { status: "done", ...(await submitToGitHub(entry, ok, note)) };
    },
    async setToken(token) {
      await queue.add(async () => {
        feedbackToken = token;
        await persist();
      });
      return { status: "done", hasToken: Boolean(feedbackToken) };
    }
  };
}
