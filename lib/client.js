window.__ModuleLoader__.load({
  id: "dsh-plugin-marketplace",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    // ===== 双语文案 =====
    var NS = "dsh-plugin-marketplace";
    var DICT_ZH = {
      sectionLabel: "DSH插件市场",
      tabPlugins: "DSH 插件",
      tabSkills: "通用 Skills",
      pageSub: "每次启动自动拉取全部插件，按 Star 数从高到低排列（缓存 10 分钟）",
      skillsSub: "CI 定期构建的 skills 索引，一键安装到 ~/.dsh/skills/（含安装脚本的仓库带 🛡 标识）",
      refresh: "刷新",
      refreshing: "正在刷新 ...",
      refreshOk: "刷新成功，共 {n} 个",
      refreshFail: "刷新失败：{err}",
      loading: "正在从 GitHub 加载 ...",
      countTotal: "共 {n} 个插件",
      countSkills: "共 {n} 个 Skills",
      countMatch: "，匹配 {n} 个",
      noMatch: "没有匹配「{q}」的插件",
      noMatchCat: "该分类下暂无插件",
      selfUpdate: "插件市场有可用更新：v{old} → v{new}",
      selfUpdateBtn: "立即更新",
      selfUpdating: "更新中...",
      selfUpdated: "已更新到 v{new}，重启 DSH 生效",
      selfUpdateFail: "更新失败：{err}",
      empty: "没有找到插件（GitHub 上 topic 为 dsh-plugin 的仓库为空或搜索受限）",
      skillsEmpty: "没有找到 Skills（索引为空或暂时不可用）",
      loadFail: "加载失败: {err}",
      retry: "重试",
      badgeNew: "新仓库",
      badgeShield: "🛡 含安装脚本",
      badgeUnverified: "未验证",
      badgeManual: "仅手动安装",
      badgeNonPlugin: "非 DSH 插件",
      badgeVerifiedInstall: "✓ 已验证安装",
      badgeVerified: "✓ 已验证",
      badgeVerifiedTip: "{by} 运行时验证通过（{at}）{ev}",
      badgeDisclosure: "披露 ✓",
      discCloud: "数据发云端",
      discLocal: "纯本地",
      discNetwork: "端点 {n}",
      discApiKeys: "凭据 {n}",
      discJurisdiction: "法域 {n}",
      discRetention: "保留 {n}",
      badgePrereq: "需前置内容",
      badgeCommunityPick: "社区收录",
      badgeCommunityPickTip: "此项目已被awesome-dsh-plugin等聚合页收录",
      installDisabled: "不可安装",
      installDisabledTip: "非 DSH 插件，无法一键安装",
      checkUpdate: "检测更新",
      checkingUpdate: "检测中...",
      checkUpToDate: "已是最新版本（v{ver}）",
      checkUpdateFail: "检测失败：{err}",
      updateTo: "更新 v{new}",
      dataSourceCache: "⚠ 网络索引源不可用，当前显示本地缓存（可能滞后）",
      dataSourceSearch: "⚠ 网络索引源不可用，当前为搜索兜底结果（不完整）",
      dataSourceBundled: "当前显示插件内置索引（离线可用；点「刷新」获取最新）",
      dedupeHint: "{n} 个同名包已隐藏（同名 npm 包只能安装一个）",
      backupTitle: "备份与恢复",
      profileTitle: "目标 profile",
      profileLabel: "安装目标：",
      profileSave: "保存",
      profileSaved: "目标 profile 已设为 {profile}",
      profileSaveFail: "保存失败：{err}",
      profileNote: "插件将安装到该 profile（默认 web）。仅限已存在的 profile 名（字母数字下划线连字符）。",
      editBtn: "编辑",
      editTitle: "编辑环境变量",
      editHint: "为 {repo} 配置环境变量（如 API KEY）。值仅保存在本机，重启 DSH 后生效。",
      editEmpty: "该插件没有扫描到可配置的环境变量——可手动填写键名（如 OPENAI_API_KEY）。",
      editKeyPlaceholder: "键名（如 OPENAI_API_KEY）",
      editValuePlaceholder: "值",
      editAddKey: "+ 添加键",
      editRemove: "移除",
      editSave: "保存",
      editSaved: "已保存，重启 DSH 后生效",
      editFail: "保存失败：{err}",
      editConfigured: "已配置",
      fbTitle: "安装反馈",
      fbAsk: "你安装的插件 {name} 是否正常安装并运行？",
      fbOk: "正常",
      fbBad: "不正常",
      fbLater: "稍后再说",
      fbNote: "补充说明（可选，会随反馈发给作者）",
      fbSubmitting: "提交中...",
      fbSent: "已反馈，谢谢！",
      fbManual: "请在打开的 GitHub 页面提交反馈（标题已预填）",
      fbFail: "反馈提交失败：{err}",
      fbTokenLabel: "GitHub Token（可选）：",
      fbTokenSave: "保存",
      fbTokenSaved: "Token 已保存",
      fbTokenNote: "配置后「正常/不正常」反馈自动创建 issue；未配置则打开预填页面手动提交。Token 仅保存在本机，用于向 DSH 插件市场仓库提交反馈。",
      fbToggle: "是否发送反馈",
      backupExport: "导出备份",
      backupImport: "导入并恢复",
      backupWebdavUrl: "WebDAV 地址",
      backupWebdavUser: "用户名",
      backupWebdavPass: "密码",
      backupWebdavPush: "备份到 WebDAV",
      backupWebdavPull: "从 WebDAV 恢复",
      backupDownloadOk: "备份已导出（JSON 文件）",
      backupRestoreStart: "开始恢复 {n} 个插件（逐个走安装流程）…",
      backupRestoreDone: "备份恢复完成 ✔",
      backupRestoreErr: "恢复失败: {err}",
      backupBadFile: "备份文件格式不正确",
      backupNote: "备份含安装记录（仓库/类型/版本），不含密钥（环境变量从不持久化）",
      cliHintLabel: "README 官方安装指令",
      cliHintCopy: "复制",
      cliHintCopied: "已复制 ✔",
      badgeBundle: "bundle 插件",
      badgeBundleTip: "经 profile bundles 层注册的 bundle 形态（dsh.bundle.patch 声明），安装走 bundle 专用管线",
      badgeDesktop: "桌面客户端",
      badgeDesktopTip: "安装器/桌面客户端/启动器形态——非插件生态件，市场无法代装",
      typeCli: "官方 CLI",
      typeMap: {
        "cordis-plugin": "cordis 插件",
        "bundle": "bundle 插件",
        "script": "安装脚本",
        "skill": "skill",
        "agent-preset": "agent 预设",
        "instructions": "手动安装",
      },
      logExport: "导出日志",
      updatedAt: "更新于 {d}",
      githubLink: "Github原链",
      tags: "标签: {tags}",
      installed: "已安装",
      install: "安装",
      uninstall: "卸载",
      uninstallingBtn: "卸载中...",
      uninstallOk: "已卸载 {repo}",
      uninstallFail: "卸载失败: {err}",
      update: "更新",
      installing: "安装中...",
      runningMsg: "正在下载并检查安装内容，请稍候…",
      updateHint: "已装 v{old} → v{new}",
      inputTitle: "安装前需要确认 {repo}",
      placeholder: "粘贴 {name} 的值（如 API Key）",
      submitContinue: "确认并继续",
      cancel: "取消",
      panelTitle: "安装 {repo} ({phase})",
      "phase.running": "运行中",
      "phase.input": "等待输入",
      "phase.done": "完成",
      "phase.aborted": "已取消",
      "phase.failed": "失败",
      "phase.manual": "无法自动安装",
      doneMsg: "安装完成 ✔ 类型: {type}",
      doneSkills: "安装完成 ✔ 已安装 {count} 个 Skills",
      donePlugins: "安装完成 ✔ 已安装 {count} 个插件",
      doneMsgLoc: " · 位置: {loc}",
      manualMsg: "该项目无法一键安装（无 SKILL.md / agent 预设 / 安装脚本 / 插件清单），什么都不会被安装。它可能是聚合页或文档仓库，请前往仓库自行安装：{url}",
      abortedMsg: "安装已取消",
      cancelRunning: "取消并关闭（后台任务将继续，稍后可重试）",
      failedMsg: "安装失败: {err}",
      backToList: "返回列表",
      requestFail: "请求失败: {err}",
      searchPlaceholder: "搜索插件名（如 pdf、image、ppt）...",
      searchPlaceholderSkills: "搜索 Skills（如 pdf、ppt、excel）...",
      catAll: "全部",
      catOther: "其他",
      catVision: "视觉多模态",
      catDocument: "文档办公",
      catMemory: "记忆知识",
      catModel: "模型用量",
      catNotify: "通知通讯",
      catCoding: "开发编码",
      catConversation: "对话聊天",
      catWebUi: "界面美化",
      catAgent: "Agent 自动化",
      catTool: "通用工具",
      catResource: "聚合资源",
      disclaimer: "免责声明：所有插件均来自第三方 GitHub 仓库，与 DSH 插件市场无关，请自行评估其可靠性与安全性。"
    };
    var DICT_EN = {
      sectionLabel: "DSH Plugin Marketplace",
      tabPlugins: "DSH Plugins",
      tabSkills: "General Skills",
      pageSub: "Fetches all plugins on startup, sorted by stars (10-min cache)",
      skillsSub: "CI-built skills index; one-click install to ~/.dsh/skills/ (repos with install scripts carry a 🛡 badge)",
      refresh: "Refresh",
      refreshing: "Refreshing ...",
      refreshOk: "Refreshed — {n} items",
      refreshFail: "Refresh failed: {err}",
      loading: "Loading from GitHub ...",
      countTotal: "{n} plugins",
      countSkills: "{n} skills",
      countMatch: ", {n} matched",
      noMatch: "No plugin matches \"{q}\"",
      noMatchCat: "No plugins in this category",
      selfUpdate: "Marketplace update available: v{old} → v{new}",
      selfUpdateBtn: "Update now",
      selfUpdating: "Updating...",
      selfUpdated: "Updated to v{new} — restart DSH to apply",
      selfUpdateFail: "Update failed: {err}",
      empty: "No plugins found (no repos with the dsh-plugin topic, or GitHub search is rate-limited)",
      skillsEmpty: "No skills found (empty index or temporarily unavailable)",
      loadFail: "Failed to load: {err}",
      retry: "Retry",
      badgeNew: "new repo",
      badgeShield: "🛡 install script",
      badgeUnverified: "unverified",
      badgeManual: "manual only",
      badgeNonPlugin: "not a DSH plugin",
      badgeVerifiedInstall: "✓ install verified",
      badgeVerified: "✓ verified",
      badgeVerifiedTip: "Runtime-verified by {by} ({at}) {ev}",
      badgeDisclosure: "disclosed ✓",
      discCloud: "cloud data",
      discLocal: "local only",
      discNetwork: "endpoints {n}",
      discApiKeys: "keys {n}",
      discJurisdiction: "jurisdiction {n}",
      discRetention: "retention {n}",
      badgePrereq: "prereqs needed",
      badgeCommunityPick: "Community listed",
      badgeCommunityPickTip: "This project is listed in awesome-dsh-plugin and other curated lists",
      installDisabled: "Not installable",
      installDisabledTip: "Not a DSH plugin; one-click install unavailable",
      checkUpdate: "Check update",
      checkingUpdate: "Checking...",
      checkUpToDate: "Already up to date (v{ver})",
      checkUpdateFail: "Check failed: {err}",
      updateTo: "Update to v{new}",
      dataSourceCache: "⚠ index sources unreachable — showing local cache (may be stale)",
      dataSourceSearch: "⚠ index sources unreachable — showing partial search results",
      dataSourceBundled: "Showing the bundled index (offline-ready; click Refresh for the latest)",
      dedupeHint: "{n} duplicate packages hidden (same npm package can only be installed once)",
      backupTitle: "Backup & Restore",
      profileTitle: "Target profile",
      profileLabel: "Install target:",
      profileSave: "Save",
      profileSaved: "Target profile set to {profile}",
      profileSaveFail: "Save failed: {err}",
      profileNote: "Plugins will install into this profile (default: web). Existing profile names only (alphanumeric/underscore/hyphen).",
      editBtn: "Edit",
      editTitle: "Edit environment variables",
      editHint: "Configure environment variables (e.g. API KEY) for {repo}. Values stay on this machine and take effect after restarting DSH.",
      editEmpty: "No configurable environment variables were detected for this plugin — you can add keys manually (e.g. OPENAI_API_KEY).",
      editKeyPlaceholder: "Key (e.g. OPENAI_API_KEY)",
      editValuePlaceholder: "Value",
      editAddKey: "+ Add key",
      editRemove: "Remove",
      editSave: "Save",
      editSaved: "Saved — takes effect after restarting DSH",
      editFail: "Save failed: {err}",
      editConfigured: "configured",
      fbTitle: "Install feedback",
      fbAsk: "Did the plugin {name} install and run correctly?",
      fbOk: "Works",
      fbBad: "Broken",
      fbLater: "Later",
      fbNote: "Notes (optional; sent to the author)",
      fbSubmitting: "Submitting...",
      fbSent: "Feedback sent, thanks!",
      fbManual: "Please submit the feedback on the opened GitHub page (title is pre-filled)",
      fbFail: "Feedback failed: {err}",
      fbTokenLabel: "GitHub Token (optional):",
      fbTokenSave: "Save",
      fbTokenSaved: "Token saved",
      fbTokenNote: "With a token, works/broken feedback auto-creates an issue; without one, a pre-filled page opens for manual submission. The token stays local and is only used to file feedback issues to the marketplace repo.",
      fbToggle: "Send feedback",
      backupExport: "Export backup",
      backupImport: "Import & restore",
      backupWebdavUrl: "WebDAV URL",
      backupWebdavUser: "Username",
      backupWebdavPass: "Password",
      backupWebdavPush: "Backup to WebDAV",
      backupWebdavPull: "Restore from WebDAV",
      backupDownloadOk: "Backup exported (JSON file)",
      backupRestoreStart: "Restoring {n} plugins (one by one through the install flow)…",
      backupRestoreDone: "Backup restore complete ✔",
      backupRestoreErr: "Restore failed: {err}",
      backupBadFile: "Invalid backup file",
      backupNote: "Backup holds install records (repo/type/version); secrets are never persisted, so nothing sensitive is included",
      cliHintLabel: "Official CLI install command (from README)",
      cliHintCopy: "Copy",
      cliHintCopied: "Copied ✔",
      badgeBundle: "bundle plugin",
      badgeBundleTip: "bundle form registered via the profile bundles layer (dsh.bundle.patch); installs through the bundle pipeline",
      badgeDesktop: "desktop client",
      badgeDesktopTip: "installer / desktop client / launcher form — not a plugin; the marketplace cannot install it",
      typeCli: "official CLI",
      typeMap: {
        "cordis-plugin": "cordis plugin",
        "bundle": "bundle plugin",
        "script": "install script",
        "skill": "skill",
        "agent-preset": "agent preset",
        "instructions": "manual install",
      },
      logExport: "Export logs",
      updatedAt: "updated {d}",
      githubLink: "GitHub repo",
      tags: "Tags: {tags}",
      installed: "Installed",
      install: "Install",
      uninstall: "Uninstall",
      uninstallingBtn: "Uninstalling...",
      uninstallOk: "Uninstalled {repo}",
      uninstallFail: "Uninstall failed: {err}",
      update: "Update",
      installing: "Installing...",
      runningMsg: "Downloading and checking the package…",
      updateHint: "v{old} → v{new} installed",
      inputTitle: "Confirm before installing {repo}",
      placeholder: "Paste value for {name} (e.g. API key)",
      submitContinue: "Confirm and continue",
      cancel: "Cancel",
      panelTitle: "Installing {repo} ({phase})",
      "phase.running": "running",
      "phase.input": "awaiting input",
      "phase.done": "done",
      "phase.aborted": "cancelled",
      "phase.failed": "failed",
      "phase.manual": "manual install required",
      doneMsg: "Install complete ✔ Type: {type}",
      doneSkills: "Install complete ✔ {count} Skills installed",
      donePlugins: "Install complete ✔ {count} plugins installed",
      doneMsgLoc: " · Location: {loc}",
      manualMsg: "This repo cannot be installed with one click (no SKILL.md / agent preset / install script / plugin manifest), so nothing was installed. It may be a curated list or documentation repo — please install it manually: {url}",
      abortedMsg: "Install cancelled",
      cancelRunning: "Cancel & close (the background task continues; you can retry later)",
      failedMsg: "Install failed: {err}",
      backToList: "Back to list",
      requestFail: "Request failed: {err}",
      searchPlaceholder: "Search plugins (e.g. pdf, image, ppt)...",
      searchPlaceholderSkills: "Search skills (e.g. pdf, ppt, excel)...",
      catAll: "All",
      catOther: "Other",
      catVision: "Vision & Multimodal",
      catDocument: "Documents & Office",
      catMemory: "Memory & Knowledge",
      catModel: "Models & Usage",
      catNotify: "Notifications",
      catCoding: "Coding & Dev",
      catConversation: "Conversation",
      catWebUi: "Web UI & Skins",
      catAgent: "Agents & Automation",
      catTool: "Tools",
      catResource: "Collections",
      disclaimer: "Disclaimer: all plugins come from third-party GitHub repositories and are not affiliated with DSH Plugin Marketplace — please evaluate their reliability and security yourself."
    };

    function browserLang() {
      var raw = (typeof navigator !== "undefined" && navigator.language) || "zh";
      return String(raw).toLowerCase().split("-")[0] === "zh" ? "zh" : "en";
    }
    var langCurrent = browserLang();
    /** 安装反馈：本次页面会话内点过「稍后再说」→ 不再自动弹（重开页面重新询问）。 */
    var fbDismissed = false;
    /** 翻译函数：apply 时替换为 DSH locale 服务的绑定，否则用浏览器语言回退。 */
    var t = function (key, vars) {
      var dict = langCurrent === "en" ? DICT_EN : DICT_ZH;
      var s = dict[key] || key;
      if (vars) for (var k in vars) s = s.split("{" + k + "}").join(String(vars[k]));
      return s;
    };
    var localeChangeCbs = [];
    function notifyLocaleChange() {
      for (var i = 0; i < localeChangeCbs.length; i++) {
        try { localeChangeCbs[i](); } catch (e) { /* ignore */ }
      }
    }

    // 排序：已安装置顶，其余按 Star 数从高到低
    function installedFirstSort(list) {
      return list.slice().sort(function (a, b) {
        if (!!a.installed !== !!b.installed) return a.installed ? -1 : 1;
        return (b.stargazers_count || 0) - (a.stargazers_count || 0);
      });
    }

    // 写操作请求头：CSRF 头 + 会话 token（M1——服务端 tapIndex 注入页面，
    // LAN 模式写操作必需；回环模式服务端不校验，携带无害）
    function mpHeaders(extra) {
      var h = Object.assign({ "X-DSH-Marketplace": "1" }, extra || {});
      var tk = window.__DSH_MP_TOKEN__;
      if (tk) h["x-dsh-marketplace-token"] = tk;
      return h;
    }

    // 刷新指纹：与当前已展示内容一致时跳过重渲染。
    // 服务端内容指纹（fp，full_name 序列哈希）优先——cached_at 每次 refresh 都变，用它门控会永远不跳过；
    // 旧版服务端无 fp 时回退 source+cached_at+total（= 每次重渲染的旧行为）：只按 source+total 门控
    // 会在「内容一进一出」时错误跳过 → 列表漏更新，安全侧宁可比对新值。
    function fingerprintOf(data) {
      if (typeof data.fp === "string") return data.fp;
      return JSON.stringify([data.source || "", data.cached_at || "", data.total || 0]);
    }

    // 全部使用 DSH 主题令牌（--dsw-alias-*），自动适配深色/浅色模式
    var s = {
      page: { maxWidth: 880, fontFamily: "var(--dsw-font-family, system-ui, sans-serif)", color: "var(--dsw-alias-label-primary)", padding: "4px 2px" },
      head: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 },
      title: { fontSize: 17, fontWeight: 600, margin: 0, color: "var(--dsw-alias-label-primary)" },
      sub: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", margin: "2px 0 0" },
      tabBar: { display: "flex", gap: 4, marginBottom: 14, borderBottom: "1px solid var(--dsw-alias-border-l2)", paddingBottom: 0 },
      tabBtn: { padding: "7px 16px", borderRadius: "8px 8px 0 0", border: "1px solid transparent", borderBottom: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary)", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" },
      tabActive: { padding: "7px 16px", borderRadius: "8px 8px 0 0", border: "1px solid var(--dsw-alias-border-l2)", borderBottom: "2px solid var(--dsw-alias-brand-primary)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },
      btn: { padding: "5px 14px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: 13, minWidth: 72, whiteSpace: "nowrap" },
      btnPrimary: { padding: "5px 14px", borderRadius: 6, border: "1px solid transparent", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)", cursor: "pointer", fontSize: 13, minWidth: 72, whiteSpace: "nowrap" },
      btnDanger: { padding: "5px 14px", borderRadius: 6, border: "1px solid var(--dsw-alias-state-error-secondary)", background: "transparent", color: "var(--dsw-alias-state-error-primary)", cursor: "pointer", fontSize: 13, minWidth: 72, whiteSpace: "nowrap" },
      btnUninstall: { padding: "5px 14px", borderRadius: 6, border: "1px solid var(--dsw-alias-state-error-secondary)", background: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-label-primary-inverted, #fff)", cursor: "pointer", fontSize: 13, minWidth: 72, whiteSpace: "nowrap" },
      btnUpdate: { padding: "5px 14px", borderRadius: 6, border: "1px solid transparent", background: "var(--dsw-alias-state-warn-primary, #d97706)", color: "var(--dsw-alias-label-primary-inverted, #fff)", cursor: "pointer", fontSize: 13, minWidth: 72, whiteSpace: "nowrap", fontWeight: 600 },
      btnInstalled: { padding: "5px 14px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-tertiary)", cursor: "default", fontSize: 13, minWidth: 72, whiteSpace: "nowrap", opacity: 0.85 },
      card: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: "12px 14px", marginBottom: 10, background: "var(--dsw-alias-bg-layer-2)" },
      row: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
      name: { fontSize: 14, fontWeight: 600, margin: 0, color: "var(--dsw-alias-label-primary)" },
      meta: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", margin: "3px 0 0" },
      link: { color: "var(--dsw-alias-brand-primary)", textDecoration: "none", cursor: "pointer", marginLeft: 4 },
      updateHint: { color: "var(--dsw-alias-state-warn-primary)", marginLeft: 4 },
      desc: { fontSize: 13, margin: "8px 0 0", lineHeight: 1.5, color: "var(--dsw-alias-label-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word" },
      log: { background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", borderRadius: 8, padding: "10px 12px", fontSize: 12, lineHeight: 1.6, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace" },
      input: { width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", fontSize: 13, marginTop: 4 },
      field: { margin: "10px 0" },
      q: { fontSize: 13, margin: "0 0 2px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word" },
      badge: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-border-l3)", color: "var(--dsw-alias-label-tertiary)", marginLeft: 8 },
      badgeShield: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-state-warn-secondary, #b45309)", color: "var(--dsw-alias-state-warn-primary)", marginLeft: 8 },
      badgeManual: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-border-l3)", color: "var(--dsw-alias-label-secondary)", marginLeft: 8 },
      badgeNonPlugin: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-state-error-secondary, #b91c1c)", color: "var(--dsw-alias-state-error-primary)", marginLeft: 8 },
      badgeVerifiedInstall: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-state-success-secondary, #15803d)", color: "var(--dsw-alias-state-success-primary)", marginLeft: 8 },
      badgePrereq: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-state-warn-secondary, #b45309)", color: "var(--dsw-alias-state-warn-primary)", marginLeft: 8 },
      badgeCommunityPick: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-brand-primary, #4d6bfe)", color: "var(--dsw-alias-brand-primary)", marginLeft: 8 },
      badgeBundle: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-state-success-secondary, #15803d)", color: "var(--dsw-alias-state-success-primary)", marginLeft: 8, cursor: "default", textTransform: "none" },
      badgeDesktop: { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, border: "1px solid var(--dsw-alias-state-warn-secondary, #b45309)", color: "var(--dsw-alias-state-warn-primary)", marginLeft: 8, cursor: "default", textTransform: "none" },
      srcHint: { fontSize: 12, color: "var(--dsw-alias-state-warn-primary, #d97706)", margin: "0 0 8px" },
      installOverlay: { position: "fixed", inset: 0, zIndex: 2100, display: "grid", placeItems: "center", padding: 20, background: "rgba(15,23,42,.42)", backdropFilter: "blur(4px)" },
      panel: { boxSizing: "border-box", width: "min(620px, calc(100vw - 40px))", maxHeight: "min(720px, calc(100vh - 40px))", overflow: "auto", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14, padding: "18px 20px", background: "var(--dsw-alias-bg-layer-2)", boxShadow: "var(--dsw-shadow-lv4, 0 24px 70px rgba(0,0,0,.3))" },
      err: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13, margin: "8px 0 0" },
      errRow: { display: "flex", alignItems: "center", gap: 10, margin: "8px 0 0" },
      selfUpdBanner: { border: "1px solid var(--dsw-alias-state-warn-secondary, #b45309)", background: "var(--dsw-alias-state-warn-primary-alpha, rgba(180,83,9,.10))", color: "var(--dsw-alias-state-warn-primary, #d97706)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, fontWeight: 600 },
      toast: { position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)", zIndex: 2000, maxWidth: "80vw", padding: "8px 16px", borderRadius: 10, fontSize: 13, boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.25))", background: "var(--dsw-alias-button-contrast-fill)", color: "var(--dsw-alias-label-primary-inverted)" },
      toastErr: { position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)", zIndex: 2000, maxWidth: "80vw", padding: "8px 16px", borderRadius: 10, fontSize: 13, boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.25))", background: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-label-primary-inverted)" }
    };

    function injectStyles() {
      var css = [
        ".dshm-btn{transition:background .12s var(--ds-ease-in-out, ease)}",
        ".dshm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
        ".dshm-btn:disabled{opacity:.55;cursor:default}",
        ".dshm-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}",
        ".dshm-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}",
        ".dshm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
        "@keyframes dshm-progress{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}",
        ".dshm-progress{height:4px;margin:14px 0;overflow:hidden;border-radius:4px;background:var(--dsw-alias-bg-layer-3)}",
        ".dshm-progress>span{display:block;width:34%;height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary);animation:dshm-progress 1.15s ease-in-out infinite}",
        // 亮色对比度校正（恢复 cea8b27）：qq98/trading/xp/miku 的亮色模式把 bg 层改浅但
        // label-primary-foreground 仍是白（dark-first 失效），label-tertiary 小字在浅层上
        // 对比度仅 ~2.2-3.4:1 不可读；这些皮肤下把 .dshm-dim（次要文本）统一提升为
        // label-secondary（实测 ≥4.6:1）。:not([data-ds-dark-theme]) 限定亮色模式——
        // 深色模式下 tertiary/secondary 都是浅色系，无需覆盖；CSS 选择器天然响应皮肤动态切换。
        // 注意：皮肤中心映射表中"同花顺"(id=ths) 的 bodyAttr 是 data-dsh-ths，
        // 而另有 id=trading 的皮肤 bodyAttr 是 data-dsh-trading——两个都保留。
        "body[data-dsh-retro]:not([data-ds-dark-theme]) .dshm-dim,body[data-dsh-trading]:not([data-ds-dark-theme]) .dshm-dim,body[data-dsh-ths]:not([data-ds-dark-theme]) .dshm-dim,body[data-dsh-xp]:not([data-ds-dark-theme]) .dshm-dim,body[data-dsh-miku]:not([data-ds-dark-theme]) .dshm-dim{color:var(--dsw-alias-label-secondary)!important}",
        // 皮肤包原生 UI 白字浅底修正（更深层问题，页面级）：5 皮肤亮色模式把
        // --dsw-alias-label-primary-foreground 定义为 #fff 配浅 bg-layer（#f2f7fc 等）——
        // DSH 原生设置面板等用该 alias 的文字不可读（皮肤包 bug，实测确认）。页面级
        // 覆盖为皮肤自己的主文字色 var(--dsw-alias-label-primary)（亮色下为深色系，
        // 与浅底对比度 >>4.5:1）；仅问题皮肤 + 仅亮色，深色模式不碰。
        "body[data-dsh-retro]:not([data-ds-dark-theme]),body[data-dsh-trading]:not([data-ds-dark-theme]),body[data-dsh-ths]:not([data-ds-dark-theme]),body[data-dsh-xp]:not([data-ds-dark-theme]),body[data-dsh-miku]:not([data-ds-dark-theme]){--dsw-alias-label-primary-foreground:var(--dsw-alias-label-primary)!important}",
        // 亮色模式 UI chrome 白字浅底（更深层问题：皮肤包规则
        // `[data-pane=sidebar]>div>:first-child *{color:#fff}` 把侧栏入口文字染白。
        // ths/miku 亮色下侧栏头部是浅渐变叠浅底（ths 实测像素 ~rgb(149,153,159) 2.87:1、
        // miku ~rgb(126,132,141) 3.7:1 不可读）故覆盖；qq98/xp 侧栏为不透明深蓝渐变
        // （实测 7~15:1 可读）不覆盖。miku 标题栏 [class*="mikuTitlebar"] 半透明浅彩虹
        // （像素 rgb(88,109,161)）同样覆盖。
        // 注意：qq98 的详情面板（explorer-col 头部）为深蓝渐变底 + 白字（实测 8.68:1 可读）
        // ——曾误加覆盖导致深字深底（实测暴露），故 explorer-col 仅 miku（浅底）覆盖。
        "body[data-dsh-ths]:not([data-ds-dark-theme]) [data-pane=\"sidebar\"] > div > :first-child,",
        "body[data-dsh-ths]:not([data-ds-dark-theme]) [data-pane=\"sidebar\"] > div > :first-child *,",
        "body[data-dsh-miku]:not([data-ds-dark-theme]) [data-pane=\"sidebar\"] > div > :first-child,",
        "body[data-dsh-miku]:not([data-ds-dark-theme]) [data-pane=\"sidebar\"] > div > :first-child *,",
        "body[data-dsh-miku]:not([data-ds-dark-theme]) [data-aionui-explorer-col] > div > :first-child,",
        "body[data-dsh-miku]:not([data-ds-dark-theme]) [data-aionui-explorer-col] > div > :first-child *,",
        "body[data-dsh-miku]:not([data-ds-dark-theme]) [class*=\"mikuTitlebar\"],",
        "body[data-dsh-miku]:not([data-ds-dark-theme]) [class*=\"mikuTitlebar\"] *{color:var(--dsw-alias-label-primary)!important}",
        // qq98 body 根色重绑：皮肤包 `body[data-dsh-retro]{color:#dcebfa}`（浅蓝白）——
        // body 自身深蓝渐变底上可读，但主区域容器覆盖浅色背景后文字仍继承 #dcebfa
        // （实测浅字浅底 ~1.5:1 不可读，用户实测暴露）；亮色下重绑为深色 label-primary，
        // 继承链文字全部修正；深色模式 body 浅字深底本就正确，不碰。
        "body[data-dsh-retro]:not([data-ds-dark-theme]){color:var(--dsw-alias-label-primary)!important}",
        // qq98/xp 设置面板溢出染白：皮肤包 `[data-pane=sidebar]>div>:first-child *{color:#fff}`
        // 通配规则命中侧栏内所有元素——设置面板（hs7_7G_panel overlay，浅底 rgb(232,241,250)）
        // 挂在侧栏 :first-child DOM 内，文字被溢出染白（qq98 实测白字浅底、xp 同款
        // rgb(255,255,255)，用户实测暴露）；侧栏深蓝渐变底部分白字可读（7:1）不受影响
        // （选择器只命中 panel 类）。实测页面可见 [class*="panel"] 仅设置面板一个，覆盖无副作用。
        // ths/miku 的侧栏通配覆盖规则已含 * 通配，设置面板自然被覆盖，无需此规则。
        "body[data-dsh-retro]:not([data-ds-dark-theme]) [class*=\"panel\"],",
        "body[data-dsh-retro]:not([data-ds-dark-theme]) [class*=\"panel\"] *,",
        "body[data-dsh-xp]:not([data-ds-dark-theme]) [class*=\"panel\"],",
        "body[data-dsh-xp]:not([data-ds-dark-theme]) [class*=\"panel\"] *{color:var(--dsw-alias-label-primary)!important}"
      ].join("\n");
      var el = document.getElementById("dshm-styles");
      // 覆写式（幂等）：HMR/重复加载时旧 style 标签已存在——直接更新内容，
      // 新 CSS 必须生效（此前 return 跳过导致 bundle 更新后 CSS 永不刷新——实测暴露）
      if (el) { el.textContent = css; return; }
      el = document.createElement("style");
      el.id = "dshm-styles";
      el.textContent = css;
      document.head.appendChild(el);
    }

    function RepoCard(props) {
      var repo = props.repo;
      var busy = props.busy;        // 全局互斥：任何安装进行中 → 所有安装按钮禁用
      var selfBusy = props.selfBusy; // 本卡片正在安装 → 显示「安装中...」
      var installed = !!props.installed;
      var updateAvailable = !!props.updateAvailable;
      // v1.4.11：npm 型 cli 已安装 → 「检测更新」手动按钮（checkSt: null / "checking" / "update:vX"）
      var npmCli = installed && !!repo.cliNpm;
      var checkState = useState(null);
      var checkSt = checkState[0];
      var setCheckSt = checkState[1];
      var checkReady = npmCli && typeof checkSt === "string" && checkSt.indexOf("update:") === 0;
      var checking = npmCli && checkSt === "checking";
      var done = installed && !updateAvailable && !npmCli;
      // skills 索引专属标识：含安装脚本（🛡）/ 探测未知（弱提示）
      var shield = repo.has_install_script === true;
      var unverified = repo.has_skill === null;
      // 可安装性徽标（registry 构建期盖章）：非 DSH 插件 / 仅手动安装
      var manualOnly = repo.installable === "manual";
      var nonPlugin = repo.installable === "non-plugin";
      // 人工验证标注（registry 构建期注入）：实测可一键安装 / 需前置内容
      var verifiedInstall = Array.isArray(repo.market_tags) && repo.market_tags.indexOf("verified-install") >= 0;
      var prereq = Array.isArray(repo.market_tags) && repo.market_tags.indexOf("prereq") >= 0;
      // 社区精选（registry 构建期抓取 awesome 聚合页收录打标）
      var communityPick = Array.isArray(repo.market_tags) && repo.market_tags.indexOf("community-pick") >= 0;
      // 运行时验证徽章（discussion #2269 对接：qing3a/dsh-plugin-verify 构建期盖章，verdict=pass）
      var verifiedPass = repo.verdict === "pass";
      var verifiedUrl = /^https:\/\/github\.com\//.test(String(repo.reportUrl || "")) ? repo.reportUrl : null;
      var verifiedEvidence = [];
      if (typeof repo.waterfall === "string" && repo.waterfall) verifiedEvidence.push("waterfall " + repo.waterfall);
      if (typeof repo.toolsResult === "boolean") verifiedEvidence.push("tools " + (repo.toolsResult ? "✓" : "✗"));
      var verifiedTip = verifiedPass
        ? t("badgeVerifiedTip", {
            by: repo.verifiedBy || "dsh-plugin-verify",
            at: String(repo.verifiedAt || "").slice(0, 10),
            ev: verifiedEvidence.length > 0 ? "· " + verifiedEvidence.join(" · ") : ""
          })
        : "";
      // 披露徽章（discussion #2269 合规层：wwumit/skills-catalog 开放数据层构建期盖章）
      var hasDisclosure = repo.disclosure && typeof repo.disclosure === "object";
      var disclosureTip = "";
      if (hasDisclosure) {
        var d = repo.disclosure;
        var discParts = [d.cloud === true ? t("discCloud") : t("discLocal")];
        if (Array.isArray(d.network) && d.network.length > 0) discParts.push(t("discNetwork", { n: d.network.join(", ") }));
        if (Array.isArray(d.apiKeys) && d.apiKeys.length > 0) discParts.push(t("discApiKeys", { n: d.apiKeys.map(function (k) { return k && k.env ? k.env : "?"; }).join(", ") }));
        if (Array.isArray(d.jurisdiction) && d.jurisdiction.length > 0) discParts.push(t("discJurisdiction", { n: d.jurisdiction.join(", ") }));
        if (typeof d.retention === "string" && d.retention) discParts.push(t("discRetention", { n: d.retention }));
        disclosureTip = discParts.join(" · ");
      }
      // 只渲染 https://github.com 链接，杜绝 javascript: 等协议注入
      var safeUrl = /^https:\/\/github\.com\//.test(String(repo.html_url || "")) ? repo.html_url : null;
      return h("div", { style: s.card },
        h("div", { style: s.row },
          h("div", { style: { flex: 1, minWidth: 0, marginRight: 12 } },
            h("p", { style: s.name }, repo.name,
              h("span", { className: "dshm-dim", style: s.badge }, repo.stargazers_count > 0 ? "★ " + repo.stargazers_count : t("badgeNew")),
              repo.category && repo.category !== "other" ? h("span", { className: "dshm-dim", style: s.badge }, t("cat" + String(repo.category).split("-").map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(""))) : null,
              shield ? h("span", { style: s.badgeShield }, t("badgeShield")) : null,
              manualOnly ? h("span", { style: s.badgeManual }, t("badgeManual")) : null,
              nonPlugin ? h("span", { style: s.badgeNonPlugin }, t("badgeNonPlugin")) : null,
              unverified ? h("span", { style: s.badge }, t("badgeUnverified")) : null,
              verifiedInstall ? h("span", { style: s.badgeVerifiedInstall }, t("badgeVerifiedInstall")) : null,
              repo.eco_type === "bundle" ? h("span", { style: s.badgeBundle, title: t("badgeBundleTip") }, t("badgeBundle")) : null,
              repo.eco_type === "desktop" ? h("span", { style: s.badgeDesktop, title: t("badgeDesktopTip") }, t("badgeDesktop")) : null,
              prereq ? h("span", { style: s.badgePrereq }, t("badgePrereq")) : null,
              communityPick ? h("span", { style: s.badgeCommunityPick, title: t("badgeCommunityPickTip") }, t("badgeCommunityPick")) : null,
              verifiedPass ? h("span", { style: s.badgeVerifiedInstall, title: verifiedTip },
                verifiedUrl ? h("a", { href: verifiedUrl, target: "_blank", rel: "noopener noreferrer", style: { color: "inherit", textDecoration: "none" } }, t("badgeVerified")) : t("badgeVerified")) : null,
              hasDisclosure ? h("span", { style: s.badgeVerifiedInstall, title: disclosureTip }, t("badgeDisclosure")) : null),
            h("p", { style: s.meta }, repo.full_name + " · " + t("updatedAt", { d: (repo.updated_at || "").slice(0, 10) }) + (repo.license ? " · " + repo.license : "") + " · ",
              safeUrl ? h("a", { href: safeUrl, target: "_blank", rel: "noopener noreferrer", style: s.link }, t("githubLink")) : null,
              updateAvailable ? h("span", { style: s.updateHint }, t("updateHint", { old: repo.installedVersion, new: repo.latestVersion })) : null),
            repo.description ? h("p", { style: s.desc }, repo.description) : null,
            repo.topics && repo.topics.length > 0 ? h("p", { className: "dshm-dim", style: s.meta }, t("tags", { tags: repo.topics.slice(0, 6).join(", ") })) : null
          ),
          h("div", { style: { flex: "none", display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" } },
            h("button", {
              className: "dshm-btn" + (done || npmCli ? "" : " dshm-btn-primary"),
              style: checkReady ? s.btnUpdate : (npmCli ? s.btn : (done ? s.btnInstalled : (updateAvailable ? s.btnUpdate : s.btnPrimary))),
              disabled: busy || done || nonPlugin || checking || props.uninstalling === repo.full_name,
              title: nonPlugin ? t("installDisabledTip") : undefined,
              onClick: function () {
                // npm 型 cli：先「检测更新」；检测到新版后按钮变「更新」走安装管线重装
                if (npmCli && !checkReady) { props.onCheckUpdate(repo, setCheckSt); return; }
                props.onInstall(repo.full_name);
              }
            }, selfBusy ? t("installing")
              : (updateAvailable ? t("update")
                : (checkReady ? t("updateTo", { new: checkSt.slice("update:".length) })
                  : (checking ? t("checkingUpdate")
                    : (npmCli ? t("checkUpdate")
                      : (installed ? t("installed")
                        : (nonPlugin ? t("installDisabled") : t("install")))))))),
            installed ? h("button", {
              className: "dshm-btn",
              style: Object.assign({}, s.btn, { border: "1px solid var(--dsw-alias-border-l3)" }),
              disabled: busy || props.uninstalling === repo.full_name,
              onClick: function () { props.onEdit(repo.full_name); }
            }, t("editBtn")) : null,
            installed ? h("button", {
              className: "dshm-btn dshm-btn-danger",
              style: s.btnUninstall,
              disabled: busy || props.uninstalling === repo.full_name,
              onClick: function () { props.onUninstall(repo.full_name); }
            }, props.uninstalling === repo.full_name ? t("uninstallingBtn") : t("uninstall")) : null
          )
        )
      );
    }

    /** 把 question 文本中的 http(s) URL 渲染为可点击链接（弹窗里给仓库链接方便自行安装）。 */
    function linkify(text) {
      return String(text).split(/(https?:\/\/[^\s]+)/g).map(function (part, i) {
        if (/^https?:\/\//.test(part)) {
          return h("a", { key: i, href: part, target: "_blank", rel: "noopener noreferrer", style: s.link }, part);
        }
        return h("span", { key: i }, part);
      });
    }

    function InstallPanel(props) {
      var inst = props.inst;
      var inputValues = props.inputValues;
      var setInputValues = props.setInputValues;
      // README CLI 指令复制反馈（顶层声明，遵守 hooks 调用顺序）
      var copyState = useState(false); var copied = copyState[0]; var setCopied = copyState[1];
      if (inst.phase === "input") {
        var hasTextQuestion = inst.questions.some(function (q) { return !(q.options && q.options.length > 0); });
        return h("div", { id: "dshm-install-panel", style: s.panel },
          h("p", { style: s.title, margin: "0 0 8px" }, t("inputTitle", { repo: inst.repo })),
          h("div", { style: s.log }, inst.log.map(function (l, i) { return h("div", { key: i }, l); })),
          inst.questions.map(function (q) {
            var value = inputValues[q.id] || "";
            if (q.options && q.options.length > 0) {
              return h("div", { style: s.field, key: q.id },
                h("p", { style: s.q }, linkify(q.question)),
                h("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
                  q.options.map(function (opt) {
                    var primary = opt.value === "continue" || opt.value === "allow";
                    return h("button", {
                      key: opt.value || opt.label,
                      className: primary ? "dshm-btn dshm-btn-primary" : "dshm-btn dshm-btn-danger",
                      style: primary ? s.btnPrimary : s.btnDanger,
                      onClick: function () {
                        var next = Object.assign({}, inputValues); next[q.id] = opt.value || opt.label; setInputValues(next);
                        props.submit(next);
                      }
                    }, opt.label);
                  })
                )
              );
            }
            return h("div", { style: s.field, key: q.id },
              h("p", { style: s.q }, linkify(q.question)),
              h("input", {
                style: s.input,
                type: "password",
                autoComplete: "off",
                placeholder: t("placeholder", { name: q.id }),
                value: value,
                onChange: function (e) { var next = Object.assign({}, inputValues); next[q.id] = e.target.value; setInputValues(next); }
              })
            );
          }),
          h("div", { style: { display: "flex", gap: 8, marginTop: 12 } },
            hasTextQuestion ? h("button", { className: "dshm-btn dshm-btn-primary", style: s.btnPrimary, onClick: function () { props.submit(inputValues); } }, t("submitContinue")) : null,
            h("button", { className: "dshm-btn", style: s.btn, onClick: props.cancel }, t("cancel"))
          )
        );
      }
      var phaseName = t("phase." + inst.phase) || inst.phase;
      return h("div", { id: "dshm-install-panel", style: s.panel },
        h("p", { style: s.title, margin: "0 0 8px" }, t("panelTitle", { repo: inst.repo, phase: phaseName })),
        inst.phase === "running" ? h("div", null,
          h("p", { style: s.sub }, t("runningMsg")),
          h("div", { className: "dshm-progress", "aria-label": t("installing") }, h("span", null))
        ) : null,
        inst.log.length > 0 ? h("div", { style: s.log }, inst.log.map(function (l, i) { return h("div", { key: i }, l); })) : null,
        inst.result && (inst.result.status === "done") && h("p", { style: { fontSize: 13, margin: "10px 0 0", color: "var(--dsw-alias-state-success-primary)" } },
          (inst.result.count > 1
            ? (inst.result.type === "skill" ? t("doneSkills", { count: inst.result.count }) : t("donePlugins", { count: inst.result.count }))
            : t("doneMsg", { type: inst.result.type === "cli" ? t("typeCli") : (t("typeMap")[inst.result.type] ?? inst.result.type) })) + (inst.result.location ? t("doneMsgLoc", { loc: inst.result.location }) : "")),
        inst.result && (inst.result.status === "manual") && h("p", { style: s.err }, linkify(t("manualMsg", { url: inst.result.url || "" }))),
        inst.result && inst.result.cliCommand ? (function () {
          // README 官方 CLI 安装指令：显示 + 一键复制（navigator.clipboard 不可用时降级 execCommand）
          function copyCmd() {
            var text = inst.result.cliCommand;
            function fallback() {
              var ta = document.createElement("textarea");
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              try { document.execCommand("copy"); setCopied(true); } catch (e) { /* ignore */ }
              ta.remove();
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () { setCopied(true); }, fallback);
            } else fallback();
            setTimeout(function () { setCopied(false); }, 2000);
          }
          return h("div", { style: { margin: "10px 0 0", padding: "10px 12px", borderRadius: 8, background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l2)" } },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
              h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontWeight: 600 } }, t("cliHintLabel")),
              h("button", { className: "dshm-btn", style: Object.assign({}, s.btn, { padding: "2px 10px", fontSize: 12 }), onClick: copyCmd }, copied ? t("cliHintCopied") : t("cliHintCopy"))
            ),
            h("code", { style: { display: "block", marginTop: 6, fontSize: 12, color: "var(--dsw-alias-label-primary)", wordBreak: "break-all", userSelect: "all" } }, inst.result.cliCommand)
          );
        })() : null,
        inst.result && (inst.result.status === "aborted") && h("p", { style: s.err }, t("abortedMsg")),
        inst.result && (inst.result.status === "failed") && h("p", { style: s.err }, t("failedMsg", { err: (inst.result.error || "unknown") })),
        inst.phase !== "running" ? h("button", { className: "dshm-btn", style: Object.assign({}, s.btn, { marginTop: 12 }), onClick: props.cancel }, t("backToList")) : h("button", { className: "dshm-btn", style: Object.assign({}, s.btn, { marginTop: 12 }), onClick: props.cancel }, t("cancelRunning"))
      );
    }

    /** DSH 插件 tab：现有市场列表逻辑 + 分类筛选 + 分页懒加载（PR #16）。 */
    var CATEGORY_KEYS = ["vision", "document", "memory", "model", "notify", "coding", "conversation", "web-ui", "agent", "tool", "resource", "other"];
    var PLUGIN_PAGE_SIZE = 60;
    function PluginTab(props) {
      var state = useState(null); var repos = state[0]; var setRepos = state[1];
      var state2 = useState(null); var error = state2[0]; var setError = state2[1];
      var state3 = useState(""); var query = state3[0]; var setQuery = state3[1];
      var state4 = useState("all"); var category = state4[0]; var setCategory = state4[1];
      var state5 = useState(""); var dataSource = state5[0]; var setDataSource = state5[1];
      var state6 = useState(0); var dropped = state6[0]; var setDropped = state6[1];
      var state7 = useState(null); var lastFp = state7[0]; var setLastFp = state7[1];
      var state8 = useState(false); var refreshing = state8[0]; var setRefreshing = state8[1];
      var state9 = useState(PLUGIN_PAGE_SIZE); var visible = state9[0]; var setVisible = state9[1];


      function doRefresh(force) {
        setRefreshing(true);
        props.showToast(t("refreshing"), true);
        fetch("/api/marketplace/list?lang=" + langCurrent + (force ? "&refresh=1" : ""), { headers: { "X-DSH-Marketplace": "1" } }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) { setError(data.error); props.showToast(t("refreshFail", { err: data.error }), false); return; }
          var fp = fingerprintOf(data);
          // 指纹（source + cached_at + total）与当前已展示内容一致 → 跳过 setState，避免列表闪烁
          if (repos === null || fp !== lastFp) {
            setRepos(data.repos || []);
            setDataSource(data.source || "");
            setDropped(data.dropped || 0);
            setVisible(PLUGIN_PAGE_SIZE);
            setLastFp(fp);
          }
          props.showToast(t("refreshOk", { n: (data.repos || []).length }), true);
        }).catch(function (err) {
          props.showToast(t("refreshFail", { err: String(err) }), false);
        }).finally(function () { setRefreshing(false); });
      }

      useEffect(function () {
        var cancelled = false;
        setError(null);
        fetch("/api/marketplace/list?lang=" + langCurrent, { headers: { "X-DSH-Marketplace": "1" } }).then(function (r) { return r.json(); }).then(function (data) {
          if (cancelled) return;
          if (data.error) { setError(data.error); setRepos([]); }
          else { setRepos(data.repos || []); setDataSource(data.source || ""); setDropped(data.dropped || 0); setVisible(PLUGIN_PAGE_SIZE); setLastFp(fingerprintOf(data)); }
        }).catch(function (err) { if (!cancelled) { setError(String(err)); setRepos([]); } });
        return function () { cancelled = true; };
      }, [props.tick]);

      // 搜索词/分类变化时重置分页（搜索在完整数组 filter 后重新分页）
      useEffect(function () { setVisible(PLUGIN_PAGE_SIZE); }, [query, category]);

      // 触底加载：sentinel 进入视口 → 追加一页（与 Skills tab 相同的交互）
      useEffect(function () {
        var el = document.getElementById("dshm-plugins-sentinel");
        if (!el) return;
        var observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) setVisible(function (n) { return n + PLUGIN_PAGE_SIZE; });
          });
        }, { rootMargin: "300px" });
        observer.observe(el);
        return function () { observer.disconnect(); };
      }, [repos, query, category]);

      return h("div", null,
        h("div", { style: s.head },
          h("div", null,
            h("h2", { style: s.title }, t("sectionLabel")),
            h("p", { className: "dshm-dim", style: s.sub }, t("pageSub"))
          ),
          h("button", { className: "dshm-btn", style: s.btn, disabled: refreshing, onClick: function () { doRefresh(true); } }, refreshing ? t("refreshing") : t("refresh"))
        ),
        h("input", {
          style: Object.assign({}, s.input, { marginTop: 0, marginBottom: 8 }),
          type: "search",
          placeholder: t("searchPlaceholder"),
          value: query,
          onChange: function (e) { setQuery(e.target.value); }
        }),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 } },
          ["all"].concat(CATEGORY_KEYS).map(function (key) {
            var active = category === key;
            var label = key === "all" ? t("catAll") : t("cat" + key.split("-").map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(""));
            return h("button", {
              key: key,
              className: "dshm-btn",
              style: active ? Object.assign({}, s.btn, { background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)", borderColor: "transparent", fontWeight: 600 }) : s.btn,
              onClick: function () { setCategory(key); }
            }, label);
          })
        ),
        (dataSource === "cache" || dataSource === "search" || dataSource === "bundled") ? h("p", { style: s.srcHint }, t(dataSource === "cache" ? "dataSourceCache" : (dataSource === "search" ? "dataSourceSearch" : "dataSourceBundled"))) : null,
        error ? h("div", { style: s.errRow },
          h("p", { style: s.err, margin: 0 }, t("loadFail", { err: error })),
          h("button", { className: "dshm-btn", style: s.btn, onClick: function () { doRefresh(false); } }, t("retry"))
        ) : null,
        repos === null ? h("p", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("loading")) : null,
        repos ? (function () {
          var q = query.trim().toLowerCase();
          var list = repos.filter(function (r) {
            if (category !== "all" && (r.category || "other") !== category) return false;
            if (!q) return true;
            return (r.name + " " + r.full_name + " " + (r.topics || []).join(" ")).toLowerCase().indexOf(q) !== -1;
          });
          var shown = list.slice(0, visible);
          var hasMore = shown.length < list.length;
          return [
            h("p", { key: "count", className: "dshm-dim", style: Object.assign({}, s.meta, { margin: "0 0 8px" }) },
              t("countTotal", { n: repos.length }) + ((q || category !== "all") ? t("countMatch", { n: list.length }) : "")),
            dropped > 0 ? h("p", { key: "dedupe", style: s.srcHint }, t("dedupeHint", { n: dropped })) : null,
            shown.map(function (repo) {
              // 全局互斥：任何安装进行中 → 所有按钮禁用；只有正在安装的那个显示「安装中...」
              return h(RepoCard, { key: repo.full_name, repo: repo, installed: repo.installed, updateAvailable: repo.updateAvailable, busy: !!(props.inst && props.inst.phase === "running"), selfBusy: !!(props.inst && props.inst.phase === "running" && props.inst.repo === repo.full_name), uninstalling: props.uninstalling, onEdit: props.onEdit, onUninstall: props.onUninstall, onCheckUpdate: props.onCheckUpdate, onInstall: function (fullName) { props.setInputValues({}); props.runInstall(fullName, {}, []); } });
            }),
            hasMore ? h("div", { key: "sentinel", id: "dshm-plugins-sentinel", style: { height: 1 } }) : null,
            list.length === 0 ? h("p", { key: "empty", className: "dshm-dim", style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, q ? t("noMatch", { q: query }) : t("noMatchCat")) : null
          ];
        })() : null,
        repos === null ? h("p", { className: "dshm-dim", style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("loading")) : null,
        repos && repos.length === 0 && !error ? h("p", { className: "dshm-dim", style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("empty")) : null
      );
    }

    /** 通用 Skills tab：服务端分页（每页 100，#14），搜索下推服务端，触底加载下一页。 */
    var SKILL_PAGE_SIZE = 100;
    var skillsFetchSeq = 0; // 模块级请求序号：查询/刷新/翻页竞态时丢弃过期响应
    /** 备份恢复队列（模块级，单市场实例）：逐项走正常安装流程，awaiting-input 弹窗期间自动暂停。 */
    var restoreState = { list: null, idx: 0 };
    function SkillsTab(props) {
      var state = useState(null); var repos = state[0]; var setRepos = state[1];
      var state2 = useState(null); var error = state2[0]; var setError = state2[1];
      var state3 = useState(""); var query = state3[0]; var setQuery = state3[1];
      var state4 = useState(1); var page = state4[0]; var setPage = state4[1];
      var state5 = useState(""); var dataSource = state5[0]; var setDataSource = state5[1];
      var state6 = useState(0); var dropped = state6[0]; var setDropped = state6[1];
      var state7 = useState(0); var total = state7[0]; var setTotal = state7[1];
      var state8 = useState(false); var loading = state8[0]; var setLoading = state8[1];
      // refreshing 独立声明于 SkillsTab 自身作用域（不能引用 PluginTab 内的同名 state——
      // SkillsTab 是顶层函数，二轮审查 ReferenceError：渲染 disabled: refreshing 即崩）
      var state9 = useState(false); var refreshing = state9[0]; var setRefreshing = state9[1];

      function fetchPage(pg, q, refresh) {
        var mySeq = ++skillsFetchSeq;
        setLoading(true);
        return fetch("/api/marketplace/skills?lang=" + langCurrent + "&page=" + pg + "&pageSize=" + SKILL_PAGE_SIZE + "&q=" + encodeURIComponent(q || "") + (refresh ? "&refresh=1" : ""), { headers: { "X-DSH-Marketplace": "1" } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (mySeq !== skillsFetchSeq) return; // 已被更新的请求取代
            if (data.error) { setError(data.error); setLoading(false); }
            else {
              setRepos(function (prev) {
                if (pg === 1) return data.repos || [];
                var seen = {};
                (prev || []).forEach(function (r) { seen[r.full_name] = true; });
                return (prev || []).concat((data.repos || []).filter(function (r) { if (seen[r.full_name]) return false; seen[r.full_name] = true; return true; }));
              });
              setPage(pg);
              setTotal(data.total != null ? data.total : (data.repos || []).length);
              setDataSource(data.source || "");
              setDropped(data.dropped || 0);
              setError(null);
              setLoading(false);
            }
          })
          .catch(function (err) { if (mySeq === skillsFetchSeq) { setError(String(err)); setLoading(false); } });
      }

      function doRefresh(force) {
        setRefreshing(true);
        props.showToast(t("refreshing"), true);
        fetchPage(1, query, true).finally(function () { setRefreshing(false); });
      }

      // 初始加载 / 外部 tick（安装卸载后刷新第一页）
      useEffect(function () { fetchPage(1, "", false); }, [props.tick]);
      // 搜索词变化 → 重置并加载第 1 页（搜索已下推服务端）
      useEffect(function () { fetchPage(1, query, false); }, [query]);

      // 触底加载：sentinel 进入视口且未加载完 → 下一页
      useEffect(function () {
        var el = document.getElementById("dshm-skills-sentinel");
        if (!el) return;
        var observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting && !loading && repos && repos.length < total) {
              fetchPage(page + 1, query, false);
            }
          });
        }, { rootMargin: "300px" });
        observer.observe(el);
        return function () { observer.disconnect(); };
      }, [repos, query, total, loading]);

      var q = query.trim().toLowerCase();

      return h("div", null,
        h("div", { style: s.head },
          h("div", null,
            h("h2", { style: s.title }, t("tabSkills")),
            h("p", { style: s.sub }, t("skillsSub"))
          ),
          h("button", { className: "dshm-btn", style: s.btn, disabled: refreshing, onClick: function () { doRefresh(true); } }, refreshing ? t("refreshing") : t("refresh"))
        ),
        h("input", {
          style: Object.assign({}, s.input, { marginTop: 0, marginBottom: 12 }),
          type: "search",
          placeholder: t("searchPlaceholderSkills"),
          value: query,
          onChange: function (e) { setQuery(e.target.value); }
        }),
        (dataSource === "cache" || dataSource === "search" || dataSource === "bundled") ? h("p", { style: s.srcHint }, t(dataSource === "cache" ? "dataSourceCache" : (dataSource === "search" ? "dataSourceSearch" : "dataSourceBundled"))) : null,
        error ? h("div", { style: s.errRow },
          h("p", { style: s.err, margin: 0 }, t("loadFail", { err: error })),
          h("button", { className: "dshm-btn", style: s.btn, onClick: function () { doRefresh(false); } }, t("retry"))
        ) : null,
        repos === null ? h("p", { className: "dshm-dim", style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("loading")) : null,
        repos ? [
          h("p", { key: "count", className: "dshm-dim", style: Object.assign({}, s.meta, { margin: "0 0 8px" }) },
            t("countSkills", { n: total }) + (q ? t("countMatch", { n: total }) : "")),
          dropped > 0 ? h("p", { key: "dedupe", style: s.srcHint }, t("dedupeHint", { n: dropped })) : null,
          repos.map(function (repo) {
            return h(RepoCard, { key: repo.full_name, repo: repo, installed: repo.installed, updateAvailable: false, busy: !!(props.inst && props.inst.phase === "running"), selfBusy: !!(props.inst && props.inst.phase === "running" && props.inst.repo === repo.full_name), uninstalling: props.uninstalling, onEdit: props.onEdit, onUninstall: props.onUninstall, onCheckUpdate: props.onCheckUpdate, onInstall: function (fullName) { props.setInputValues({}); props.runInstall(fullName, {}, []); } });
          }),
          repos.length < total && !loading ? h("div", { key: "sentinel", id: "dshm-skills-sentinel", style: { height: 1 } }) : null,
          repos.length === 0 && !loading ? h("p", { key: "empty", className: "dshm-dim", style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("noMatch", { q: query })) : null
        ] : null,
        repos && repos.length === 0 && !error && !loading ? h("p", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("skillsEmpty")) : null
      );
    }

    function MarketplaceSection() {
      var tabState = useState("plugins"); var activeTab = tabState[0]; var setActiveTab = tabState[1];
      var state3 = useState(null); var inst = state3[0]; var setInst = state3[1];
      var state4 = useState({}); var inputValues = state4[0]; var setInputValues = state4[1];
      var state5 = useState(0); var tick = state5[0]; var setTick = state5[1];
      var state7 = useState(null); var toast = state7[0]; var setToast = state7[1];
      var state8 = useState(0); var setRerender = state8[1];
      var state9 = useState(null); var selfUpd = state9[0]; var setSelfUpd = state9[1];
      var selfUpdState = useState(false); var selfUpdating = selfUpdState[0]; var setSelfUpdating = selfUpdState[1];
      var state11 = useState(null); var uninstallingRepo = state11[0]; var setUninstallingRepo = state11[1];
      // 安装反馈：待确认队列 + 当前输入
      var fbState = useState([]); var fbPending = fbState[0]; var setFbPending = fbState[1];
      var fbNoteState = useState(""); var fbNote = fbNoteState[0]; var setFbNote = fbNoteState[1];
      var fbBusyState = useState(false); var fbBusy = fbBusyState[0]; var setFbBusy = fbBusyState[1];
      var fbTokenState = useState(""); var fbTokenInput = fbTokenState[0]; var setFbTokenInput = fbTokenState[1];
      // 反馈开关（v1.4.6）：默认开启；关闭后不拉取/不弹「是否正常」确认弹窗。偏好存 localStorage。
      var fbEnabledState = useState(function () {
        try { return localStorage.getItem("dshm.fb.enabled") !== "0"; } catch (e) { return true; }
      });
      var fbEnabled = fbEnabledState[0]; var setFbEnabled = fbEnabledState[1];
      // 环境变量编辑（issue #18）：弹窗表单 state
      var editState = useState(null); var editRepo = editState[0]; var setEditRepo = editState[1];
      var editRowsState = useState([]); var editRows = editRowsState[0]; var setEditRows = editRowsState[1];
      var editBusyState = useState(false); var editBusy = editBusyState[0]; var setEditBusy = editBusyState[1];

      /** 打开编辑弹窗：拉取该插件扫描到的 env 键（值不回显）。 */
      function openEdit(repo) {
        setEditBusy(true);
        setEditRepo(repo);
        setEditRows([]);
        fetch("/api/marketplace/env-keys?repo=" + encodeURIComponent(repo), { headers: { "X-DSH-Marketplace": "1" } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            setEditBusy(false);
            if (data && data.envKeys) {
              setEditRows((data.envKeys || []).map(function (k) {
                return { key: k, value: "", configured: !!(data.configured && data.configured[k]) };
              }));
            } else if (data && data.error) {
              setEditRepo(null);
              showToast(t("editFail", { err: data.error }), false);
            }
          })
          .catch(function (err) { setEditBusy(false); setEditRepo(null); showToast(t("editFail", { err: String(err) }), false); });
      }

      /** 保存编辑：POST 值（空值 = 清除该键）。 */
      function saveEdit() {
        if (!editRepo || editBusy) return;
        setEditBusy(true);
        var values = {};
        editRows.forEach(function (row) {
          var key = (row.key || "").trim();
          if (!key) return;
          values[key] = row.value || "";
        });
        fetch("/api/marketplace/env-edit", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ repo: editRepo, values: values })
        }).then(function (r) { return r.json(); }).then(function (data) {
          setEditBusy(false);
          if (data && data.status === "done") {
            setEditRepo(null);
            showToast(t("editSaved"), true);
          } else {
            showToast(t("editFail", { err: (data && data.error) || "unknown" }), false);
          }
        }).catch(function (err) {
          setEditBusy(false);
          showToast(t("editFail", { err: String(err) }), false);
        });
      }

      function updateEditRow(idx, field, value) {
        setEditRows(editRows.map(function (row, i) { return i === idx ? Object.assign({}, row, { [field]: value }) : row; }));
      }

      /** 打开市场时读取是否已配置 token（不回显 token 本身，仅用于提示）。 */
      useEffect(function () {
        fetch("/api/marketplace/feedback/token", { headers: { "X-DSH-Marketplace": "1" } })
          .then(function (r) { return r.json(); })
          .then(function (data) { if (data && data.hasToken) setFbTokenInput("********"); })
          .catch(function () { /* 静默 */ });
      }, []);

      // 目标 profile（issue #184）：打开市场时读取当前值
      var profileState = useState("web");
      var targetProfile = profileState[0]; var setTargetProfile = profileState[1];
      var profileBusyState = useState(false); var profileBusy = profileBusyState[0]; var setProfileBusy = profileBusyState[1];
      useEffect(function () {
        fetch("/api/marketplace/profile", { headers: { "X-DSH-Marketplace": "1" } })
          .then(function (r) { return r.json(); })
          .then(function (data) { if (data && data.status === "done" && data.profile) setTargetProfile(data.profile); })
          .catch(function () { /* 静默 */ });
      }, []);

      /** 保存目标 profile（空值回退 web）。 */
      function saveTargetProfile() {
        var name = targetProfile.trim() || "web";
        setProfileBusy(true);
        var prevProfile = targetProfile;
        fetch("/api/marketplace/profile", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ profile: name })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.status === "done") {
            showToast(t("profileSaved", { profile: data.profile }), true);
            setTargetProfile(data.profile);
            // 已安装标注随 profile 变化（服务端按当前 PROFILE_NM 扫描）——tick 触发
            // PluginTab/SkillsTab 重新拉取，列表立即反映新目标的标注。
            if (data.profile !== prevProfile) setTick(tick + 1);
          } else {
            showToast(t("profileSaveFail", { err: (data && data.error) || "unknown" }), false);
          }
        }).catch(function (err) { showToast(t("profileSaveFail", { err: String(err) }), false); })
          .finally(function () { setProfileBusy(false); });
      }

      /** 保存/清除 GitHub Token（空串或 ****** 视为清除）。 */
      function saveFbToken() {
        var token = fbTokenInput.trim();
        if (token === "********") token = "";
        fetch("/api/marketplace/feedback/token", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ token: token })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.status === "done") {
            showToast(t("fbTokenSaved"), true);
            setFbTokenInput(data.hasToken ? "********" : "");
          } else {
            showToast(t("fbFail", { err: (data && data.error) || "unknown" }), false);
          }
        }).catch(function (err) { showToast(t("fbFail", { err: String(err) }), false); });
      }

      // 打开市场时拉取待确认反馈（安装完成后服务端写入队列）
      useEffect(function () {
        var cancelled = false;
        if (fbDismissed || !fbEnabled) return function () { cancelled = true; };
        fetch("/api/marketplace/feedback/pending", { headers: { "X-DSH-Marketplace": "1" } })
          .then(function (r) { return r.json(); })
          .then(function (data) { if (!cancelled && Array.isArray(data.pending) && data.pending.length > 0) setFbPending(data.pending); })
          .catch(function () { /* 网络失败：静默，不打扰 */ });
        return function () { cancelled = true; };
      }, [tick, fbEnabled]);

      /** 提交反馈：POST 服务端（移除队列 + 同步 GitHub issue），返回 issueUrl/manualUrl。 */
      function submitFeedback(ok) {
        var entry = fbPending[0];
        if (!entry || fbBusy) return;
        setFbBusy(true);
        fetch("/api/marketplace/feedback", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ repo: entry.repo, ok: ok, note: fbNote, lang: langCurrent })
        }).then(function (r) { return r.json(); }).then(function (data) {
          setFbBusy(false);
          if (data && data.status === "done") {
            showToast(t("fbSent"), true);
            // 同步结果：自动创建的 issue 或预填手动提交链接 → 打开浏览器
            if (data.issueUrl) { window.open(data.issueUrl, "_blank"); }
            else if (data.manualUrl) { window.open(data.manualUrl, "_blank"); showToast(t("fbManual"), true); }
            else if (data.error) { showToast(t("fbFail", { err: data.error }), false); }
            setFbNote("");
            var rest = fbPending.slice(1);
            setFbPending(rest);
          } else {
            showToast(t("fbFail", { err: (data && data.error) || "unknown" }), false);
          }
        }).catch(function (err) {
          setFbBusy(false);
          showToast(t("fbFail", { err: String(err) }), false);
        });
      }

      function dismissFeedback() {
        fbDismissed = true;
        setFbPending([]);
        setFbNote("");
      }

      /** npm 型 cli 插件手动版本检测（v1.4.11）：查 npm registry → 有新版则按钮变「更新 vX」走重装。 */
      function checkUpdate(repo, setCheckSt) {
        setCheckSt("checking");
        fetch("/api/marketplace/check-update", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DSH-Marketplace": "1" },
          body: JSON.stringify({ repo: repo.full_name })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.status === "done" && data.updateAvailable) {
            setCheckSt("update:" + data.latestVersion);
            showToast(t("updateHint", { old: data.installedVersion, new: data.latestVersion }), true);
          } else if (data && data.status === "done" && !data.updateAvailable) {
            setCheckSt(null);
            showToast((data && data.error) || t("checkUpToDate", { ver: data.installedVersion }), true);
          } else {
            setCheckSt(null);
            showToast((data && data.error) || t("checkUpdateFail", { err: "unknown" }), false);
          }
        }).catch(function (err) {
          setCheckSt(null);
          showToast(t("checkUpdateFail", { err: String(err) }), false);
        });
      }

      /** 反馈开关切换：写 localStorage；关闭时清空已拉取的待确认队列（重新打开会自动重拉）。 */
      function toggleFbEnabled() {
        var next = !fbEnabled;
        try { localStorage.setItem("dshm.fb.enabled", next ? "1" : "0"); } catch (e) { /* 存储不可用：仅会话内生效 */ }
        setFbEnabled(next);
        if (!next) setFbPending([]);
      }

      // 小优待：打开页面时拉取市场本体自更新检测结果（服务端启动时已直链 GitHub 查过，
      // 超过 30 分钟未检查会在此顺带重查）；tick 变化（安装/刷新后）重拉，更新完提示即消失
      useEffect(function () {
        var cancelled = false;
        fetch("/api/marketplace/self-update", { headers: { "X-DSH-Marketplace": "1" } })
          .then(function (r) { return r.json(); })
          .then(function (data) { if (!cancelled) setSelfUpd(data || null); })
          .catch(function () { if (!cancelled) setSelfUpd(null); });
        return function () { cancelled = true; };
      }, [tick]);

      /** 一键更新市场本体（v1.4.7）：POST self-update → 服务端克隆最新仓库并原子替换，重启 DSH 生效。
       *  v1.5.1：CLI 路径失败后服务端回退目录替换（CLI 180s + clone 300s），
       *  前端 900s 超时兜底——「运行中」不再无限挂起（spawn EINVAL 案例）。 */
      function runSelfUpdate() {
        if (selfUpdating) return;
        setSelfUpdating(true);
        fetch("/api/marketplace/self-update", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(900000)
        }).then(function (r) { return r.json(); }).then(function (data) {
          setSelfUpdating(false);
          if (data && data.status === "done") {
            setSelfUpd(null);
            showToast(t("selfUpdated", { new: data.installedVersion }), true);
          } else {
            showToast((data && data.error) || t("selfUpdateFail", { err: "unknown" }), false);
            if (data && data.status === "no-update") setSelfUpd(null);
          }
        }).catch(function (err) {
          setSelfUpdating(false);
          showToast(t("selfUpdateFail", { err: String(err) }), false);
        });
      }

      useEffect(function () {
        if (!toast) return;
        var t2 = setTimeout(function () { setToast(null); }, 2600);
        return function () { clearTimeout(t2); };
      }, [toast]);

      // 语言切换时重新渲染（翻译函数读取实时语言快照）
      useEffect(function () {
        var cb = function () { setRerender(function (n) { return n + 1; }); };
        localeChangeCbs.push(cb);
        return function () {
          var i = localeChangeCbs.indexOf(cb);
          if (i >= 0) localeChangeCbs.splice(i, 1);
        };
      }, []);

      function runInstall(repo, answers, baseLog) {
        setInst({ repo: repo, phase: "running", log: baseLog || [], questions: [], answers: answers, result: null });
        fetch("/api/marketplace/install", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ repo: repo, answers: answers || {}, lang: langCurrent })
        }).then(function (r) { return r.json(); }).then(function (data) {
          setInst(function (prev) {
            // 面板可能已被另一个安装占用：过期响应直接丢弃，避免旧日志覆盖新面板
            if (!prev || prev.repo !== repo) return prev;
            var base = prev.log || [];
            // n5：403（来源校验拒绝）/ 409（并发安装中）等响应没有 status 但有 error，
            // 把真实原因写进日志，不再显示无信息的「安装失败: unknown」
            var extra = [];
            if (!data.status && data.error) extra = [data.error];
            var log = base.concat(extra, data.log || []);
            if (data.status === "awaiting-input") {
              return { repo: repo, phase: "input", log: log, questions: data.questions || [], answers: answers || {}, result: null };
            }
            var phase = data.status === "done" ? "done" : (data.status === "aborted" ? "aborted" : (data.status === "manual" ? "manual" : "failed"));
            return { repo: repo, phase: phase, log: log, questions: [], answers: answers || {}, result: data };
          });
          // 安装结束（非等待输入）：两个 tab 都重新拉取列表——服务端实时标注 installed，
          // 安装成功的卡片自动变「已安装」并置顶，无需本地拼装状态
          if (data.status !== "awaiting-input") setTick(tick + 1);
          // 备份恢复队列推进（manual/aborted 也继续下一个，避免卡死）
          if (data.status !== "awaiting-input" && restoreState.list) {
            restoreState.idx++;
            nextRestore();
          }
        }).catch(function (err) {
          setInst(function (prev) {
            if (!prev || prev.repo !== repo) return prev;
            return { repo: repo, phase: "failed", log: (prev.log || []).concat([t("requestFail", { err: String(err) })]), questions: [], answers: answers || {}, result: null };
          });
          setTick(tick + 1);
          if (restoreState.list) {
            restoreState.idx++;
            nextRestore();
          }
        });
      }

      function submit(values) {
        if (!inst) return;
        // Issue #5：先为所有当前问题 id 预填空串——服务端按「键存在即视为已提供
        // （空值=跳过）」判定，未触碰的输入框键不存在会被误判为「未提供」，
        // 导致空值跳过后反复弹窗死循环；选项型问题不受影响（选中值会覆盖空串）。
        var all = {};
        (inst.questions || []).forEach(function (q) { all[q.id] = ""; });
        var merged = Object.assign({}, inst.answers || {}, all, values || {});
        runInstall(inst.repo, merged, inst.log);
      }

      function cancelInstall() {
        setInst(null);
        setInputValues({});
        setTick(tick + 1);
      }

      /** 卸载：POST /api/marketplace/uninstall，完成后刷新列表并 toast 反馈。 */
      function uninstallPlugin(fullName) {
        if (uninstallingRepo) return;
        setUninstallingRepo(fullName);
        fetch("/api/marketplace/uninstall", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ repo: fullName, lang: langCurrent })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.status === "done") {
            // removed=0 说明没有实际删除任何内容（无记录/无可定位目录）——弹日志原文而不是虚假的「已卸载」
            if (data.removed === 0 && Array.isArray(data.log) && data.log.length > 0) {
              showToast(data.log.join(" "), false);
            } else {
              showToast(t("uninstallOk", { repo: fullName }), true);
            }
          } else {
            showToast(t("uninstallFail", { err: (data && (data.error || data.log && data.log.join(" "))) || "unknown" }), false);
          }
          setTick(tick + 1);
        }).catch(function (err) {
          showToast(t("uninstallFail", { err: String(err) }), false);
          setTick(tick + 1);
        }).finally(function () {
          setUninstallingRepo(null);
        });
      }

      function showToast(text, ok) {
        setToast({ text: text, ok: !!ok });
      }

      // ---- 备份 / 恢复（#15）----
      var wdState1 = useState(""); var wdUrl = wdState1[0]; var setWdUrl = wdState1[1];
      var wdState2 = useState(""); var wdUser = wdState2[0]; var setWdUser = wdState2[1];
      var wdState3 = useState(""); var wdPass = wdState3[0]; var setWdPass = wdState3[1];

      function nextRestore() {
        if (!restoreState.list) return;
        if (restoreState.idx >= restoreState.list.length) {
          restoreState.list = null;
          showToast(t("backupRestoreDone"), true);
          setTick(tick + 1);
          return;
        }
        runInstall(restoreState.list[restoreState.idx], {}, []);
      }

      function startRestore(repoList) {
        if (restoreState.list) return; // 已在恢复中
        if (!Array.isArray(repoList) || repoList.length === 0) return;
        restoreState.list = repoList;
        restoreState.idx = 0;
        showToast(t("backupRestoreStart", { n: repoList.length }), true);
        nextRestore();
      }

      function exportBackup() {
        fetch("/api/marketplace/backup", { headers: { "X-DSH-Marketplace": "1" } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error || !data.backup) { showToast(data.error || t("backupRestoreErr", { err: "empty" }), false); return; }
            var blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: "application/json" });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "dsh-marketplace-backup-" + new Date().toISOString().slice(0, 10) + ".json";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
            showToast(t("backupDownloadOk"), true);
          })
          .catch(function (err) { showToast(t("backupRestoreErr", { err: String(err) }), false); });
      }

      function importBackupFile(file) {
        if (!file || restoreState.list) return;
        var reader = new FileReader();
        reader.onload = function () {
          var backup;
          try { backup = JSON.parse(String(reader.result)); } catch (e) { showToast(t("backupBadFile"), false); return; }
          fetch("/api/marketplace/restore/diff", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-DSH-Marketplace": "1" },
            body: JSON.stringify({ backup: backup })
          }).then(function (r) { return r.json(); }).then(function (data) {
            if (data.error) { showToast(data.error, false); return; }
            showToast((data.log || []).join(" ") || t("backupRestoreDone"), true);
            if (Array.isArray(data.missing) && data.missing.length > 0) startRestore(data.missing);
          }).catch(function (err) { showToast(t("backupRestoreErr", { err: String(err) }), false); });
        };
        reader.readAsText(file);
      }

      function webdavPush() {
        if (restoreState.list) return;
        fetch("/api/marketplace/backup/webdav", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ url: wdUrl.trim(), username: wdUser.trim(), password: wdPass })
        }).then(function (r) { return r.json(); }).then(function (data) {
          showToast((data.log || []).join(" ") || (data.error || t("backupRestoreErr", { err: "webdav" })), data.status === "done");
        }).catch(function (err) { showToast(t("backupRestoreErr", { err: String(err) }), false); });
      }

      function webdavPull() {
        if (restoreState.list) return;
        fetch("/api/marketplace/restore/webdav", {
          method: "POST",
          headers: mpHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ url: wdUrl.trim(), username: wdUser.trim(), password: wdPass })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) { showToast(data.error, false); return; }
          showToast((data.log || []).join(" ") || t("backupRestoreDone"), true);
          if (Array.isArray(data.missing) && data.missing.length > 0) startRestore(data.missing);
        }).catch(function (err) { showToast(t("backupRestoreErr", { err: String(err) }), false); });
      }

      function exportLogs() {
        fetch("/api/marketplace/logs", { headers: { "X-DSH-Marketplace": "1" } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error || typeof data.text !== "string") { showToast(data.error || t("backupRestoreErr", { err: "logs" }), false); return; }
            var blob = new Blob([data.text], { type: "text/plain" });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "dsh-marketplace-logs-" + new Date().toISOString().slice(0, 10) + ".txt";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
            showToast((data.log || []).join(" ") || t("backupRestoreDone"), true);
          })
          .catch(function (err) { showToast(t("backupRestoreErr", { err: String(err) }), false); });
      }

      var wdInputStyle = Object.assign({}, s.input, { width: 150, marginTop: 0 });

      var tabProps = { inst: inst, runInstall: runInstall, setInputValues: setInputValues, tick: tick, showToast: showToast, uninstalling: uninstallingRepo, onEdit: openEdit, onUninstall: uninstallPlugin, onCheckUpdate: checkUpdate };

      return h("div", { style: s.page },
        toast ? h("div", { style: toast.ok ? s.toast : s.toastErr }, toast.text) : null,
        selfUpd && selfUpd.updateAvailable ? h("div", { style: Object.assign({}, s.selfUpdBanner, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }) },
          h("span", null, t("selfUpdate", { old: selfUpd.installedVersion, new: selfUpd.latestVersion })),
          h("button", { className: "dshm-btn", style: Object.assign({}, s.btnUpdate, { minWidth: 88 }), disabled: selfUpdating, onClick: runSelfUpdate }, selfUpdating ? t("selfUpdating") : t("selfUpdateBtn"))
        ) : null,
        h("div", { style: s.tabBar },
          h("button", { style: activeTab === "plugins" ? s.tabActive : s.tabBtn, onClick: function () { setActiveTab("plugins"); } }, t("tabPlugins")),
          h("button", { style: activeTab === "skills" ? s.tabActive : s.tabBtn, onClick: function () { setActiveTab("skills"); } }, t("tabSkills")),
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", marginBottom: 6 } },
            h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", whiteSpace: "nowrap" } },
              h("input", { type: "checkbox", checked: fbEnabled, onChange: toggleFbEnabled, style: { accentColor: "var(--dsw-alias-brand-primary)", cursor: "pointer", margin: 0 } }),
              t("fbToggle")
            )
          )
        ),
        h("div", { key: "profile-cfg", style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: "10px 14px", margin: "0 0 12px" } },
          h("p", { style: { fontSize: 12, fontWeight: 600, margin: "0 0 8px", color: "var(--dsw-alias-label-secondary)" } }, t("profileTitle")),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, t("profileLabel")),
            h("input", { style: Object.assign({}, wdInputStyle, { width: 160 }), type: "text", placeholder: "web", value: targetProfile, onChange: function (e) { setTargetProfile(e.target.value); } }),
            h("button", { className: "dshm-btn", style: s.btn, disabled: profileBusy, onClick: saveTargetProfile }, profileBusy ? t("installing") : t("profileSave"))
          ),
          h("p", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", margin: "6px 0 0" } }, t("profileNote"))
        ),
        h("div", { key: "backup", style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: "10px 14px", margin: "0 0 12px" } },
          h("p", { style: { fontSize: 12, fontWeight: 600, margin: "0 0 8px", color: "var(--dsw-alias-label-secondary)" } }, t("backupTitle")),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            h("button", { className: "dshm-btn", style: s.btn, onClick: exportBackup }, t("backupExport")),
            h("button", { className: "dshm-btn", style: s.btn, onClick: function () { var el = document.getElementById("dshm-backup-file"); if (el) el.click(); } }, t("backupImport")),
            h("input", { id: "dshm-backup-file", type: "file", accept: ".json,application/json", style: { display: "none" }, onChange: function (e) { importBackupFile(e.target.files && e.target.files[0]); e.target.value = ""; } }),
            h("input", { style: wdInputStyle, placeholder: t("backupWebdavUrl"), value: wdUrl, onChange: function (e) { setWdUrl(e.target.value); } }),
            h("input", { style: Object.assign({}, wdInputStyle, { width: 100 }), placeholder: t("backupWebdavUser"), value: wdUser, onChange: function (e) { setWdUser(e.target.value); } }),
            h("input", { style: Object.assign({}, wdInputStyle, { width: 100 }), type: "password", placeholder: t("backupWebdavPass"), value: wdPass, onChange: function (e) { setWdPass(e.target.value); } }),
            h("button", { className: "dshm-btn", style: s.btn, onClick: webdavPush }, t("backupWebdavPush")),
            h("button", { className: "dshm-btn", style: s.btn, onClick: webdavPull }, t("backupWebdavPull")),
            h("button", { className: "dshm-btn", style: s.btn, onClick: exportLogs }, t("logExport"))
          ),
          h("p", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", margin: "6px 0 0" } }, t("backupNote"))
        ),
        h("div", { key: "feedback-cfg", style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: "10px 14px", margin: "0 0 12px" } },
          h("p", { style: { fontSize: 12, fontWeight: 600, margin: "0 0 8px", color: "var(--dsw-alias-label-secondary)" } }, t("fbTitle")),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, t("fbTokenLabel")),
            h("input", { style: Object.assign({}, wdInputStyle, { width: 220 }), type: "password", placeholder: "ghp_...", value: fbTokenInput, onChange: function (e) { setFbTokenInput(e.target.value); } }),
            h("button", { className: "dshm-btn", style: s.btn, onClick: saveFbToken }, t("fbTokenSave"))
          ),
          h("p", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", margin: "6px 0 0" } }, t("fbTokenNote"))
        ),
        inst ? h("div", { style: s.installOverlay }, h(InstallPanel, { inst: inst, inputValues: inputValues, setInputValues: setInputValues, submit: submit, cancel: cancelInstall })) : null,
        editRepo ? h("div", { style: s.installOverlay }, h("div", { style: s.panel },
          h("h3", { style: { margin: "0 0 8px", fontSize: 15 } }, t("editTitle")),
          h("p", { style: { fontSize: 12, margin: "0 0 12px", color: "var(--dsw-alias-label-secondary)" } }, t("editHint", { repo: editRepo })),
          editRows.length === 0 && !editBusy ? h("p", { style: { fontSize: 12, margin: "0 0 12px", color: "var(--dsw-alias-state-warn-primary)" } }, t("editEmpty")) : null,
          editRows.map(function (row, i) {
            return h("div", { key: i, style: { display: "flex", gap: 8, alignItems: "center", margin: "0 0 8px" } },
              h("input", { style: Object.assign({}, s.input, { marginTop: 0, flex: "1 1 40%" }), type: "text", placeholder: t("editKeyPlaceholder"), value: row.key, onChange: function (e) { updateEditRow(i, "key", e.target.value); } }),
              h("input", { style: Object.assign({}, s.input, { marginTop: 0, flex: "1 1 40%" }), type: "password", placeholder: t("editValuePlaceholder") + (row.configured ? " (" + t("editConfigured") + ")" : ""), value: row.value, onChange: function (e) { updateEditRow(i, "value", e.target.value); } }),
              h("button", { className: "dshm-btn", style: s.btn, disabled: editBusy, onClick: function () { setEditRows(editRows.filter(function (_, j) { return j !== i; })); } }, t("editRemove"))
            );
          }),
          h("div", { style: { display: "flex", gap: 8, justifyContent: "space-between", marginTop: 14 } },
            h("button", { className: "dshm-btn", style: s.btn, disabled: editBusy, onClick: function () { setEditRows(editRows.concat([{ key: "", value: "", configured: false }])); } }, t("editAddKey")),
            h("div", { style: { display: "flex", gap: 8 } },
              h("button", { className: "dshm-btn", style: s.btn, disabled: editBusy, onClick: function () { setEditRepo(null); } }, t("cancelRunning")),
              h("button", { className: "dshm-btn dshm-btn-primary", style: s.btnPrimary, disabled: editBusy, onClick: saveEdit }, editBusy ? t("installing") : t("editSave"))
            )
          )
        )) : null,
        (!inst && fbEnabled && fbPending.length > 0) ? h("div", { style: s.installOverlay }, (function () {
          var entry = fbPending[0];
          return h("div", { style: s.panel },
            h("h3", { style: { margin: "0 0 8px", fontSize: 15 } }, t("fbTitle")),
            h("p", { style: { fontSize: 13, margin: "0 0 4px", color: "var(--dsw-alias-label-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, t("fbAsk", { name: entry.name || entry.repo })),
            h("p", { style: { fontSize: 12, margin: "0 0 10px", color: "var(--dsw-alias-label-tertiary)" } }, entry.repo + (entry.version ? " · v" + entry.version : "")),
            h("input", { style: Object.assign({}, s.input, { marginTop: 0 }), type: "text", placeholder: t("fbNote"), value: fbNote, onChange: function (e) { setFbNote(e.target.value); } }),
            h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 } },
              h("button", { className: "dshm-btn", style: Object.assign({}, s.btn, { border: "1px solid var(--dsw-alias-state-success-secondary, #15803d)", color: "var(--dsw-alias-state-success-primary)" }), disabled: fbBusy, onClick: function () { submitFeedback(true); } }, fbBusy ? t("fbSubmitting") : t("fbOk")),
              h("button", { className: "dshm-btn", style: Object.assign({}, s.btn, { border: "1px solid var(--dsw-alias-state-error-secondary, #b91c1c)", color: "var(--dsw-alias-state-error-primary)" }), disabled: fbBusy, onClick: function () { submitFeedback(false); } }, fbBusy ? t("fbSubmitting") : t("fbBad")),
              h("button", { className: "dshm-btn", style: s.btn, disabled: fbBusy, onClick: dismissFeedback }, t("fbLater"))
            )
          );
        })()) : null,
        activeTab === "plugins" ? h(PluginTab, tabProps) : h(SkillsTab, tabProps),
        h("p", { key: "disclaimer", className: "dshm-dim", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginTop: 16, lineHeight: 1.6 } }, t("disclaimer"))
      );
    }

    function apply(ctx) {
      injectStyles();
      // 接入 DSH locale 服务（经 inject 注入，官方消费方式）：
      // 注册本插件字典、绑定翻译函数、订阅语言切换重渲染
      if (ctx.locale && typeof ctx.locale.register === "function") {
        try {
          var dispose = ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN });
          if (typeof ctx.effect === "function") ctx.effect(() => dispose, "dsh-plugin-marketplace: dictionaries");
        } catch (e) { /* 命名空间重复注册等极端情况：忽略 */ }
        try { t = ctx.locale.bind(NS); } catch (e) { /* 保持回退翻译 */ }
        try { langCurrent = ctx.locale.getLocale().active || langCurrent; } catch (e) { /* ignore */ }
        if (typeof ctx.locale.subscribe === "function") {
          try {
            ctx.locale.subscribe(function () {
              try { langCurrent = ctx.locale.getLocale().active; } catch (e) { /* ignore */ }
              notifyLocaleChange();
            });
          } catch (e) { /* ignore */ }
        }
      }
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-plugin-marketplace",
          order: 30,
          locale: NS,
          label: function () { return t("sectionLabel"); }
        }, MarketplaceSection);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
