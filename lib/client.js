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
      empty: "没有找到插件（GitHub 上 topic 为 dsh-plugin 的仓库为空或搜索受限）",
      skillsEmpty: "没有找到 Skills（索引为空或暂时不可用）",
      loadFail: "加载失败: {err}",
      retry: "重试",
      badgeNew: "新仓库",
      badgeShield: "🛡 含安装脚本",
      badgeUnverified: "未验证",
      updatedAt: "更新于 {d}",
      githubLink: "Github原链",
      tags: "标签: {tags}",
      installed: "已安装",
      install: "安装",
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
      doneMsgLoc: " · 位置: {loc}",
      manualMsg: "该项目无法一键安装（无 SKILL.md / agent 预设 / 安装脚本 / 插件清单），什么都不会被安装。它可能是聚合页或文档仓库，请前往仓库自行安装：{url}",
      abortedMsg: "安装已取消",
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
      catConversation: "对话会话",
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
      empty: "No plugins found (no repos with the dsh-plugin topic, or GitHub search is rate-limited)",
      skillsEmpty: "No skills found (empty index or temporarily unavailable)",
      loadFail: "Failed to load: {err}",
      retry: "Retry",
      badgeNew: "new repo",
      badgeShield: "🛡 install script",
      badgeUnverified: "unverified",
      updatedAt: "updated {d}",
      githubLink: "GitHub repo",
      tags: "Tags: {tags}",
      installed: "Installed",
      install: "Install",
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
      doneMsgLoc: " · Location: {loc}",
      manualMsg: "This repo cannot be installed with one click (no SKILL.md / agent preset / install script / plugin manifest), so nothing was installed. It may be a curated list or documentation repo — please install it manually: {url}",
      abortedMsg: "Install cancelled",
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
      installOverlay: { position: "fixed", inset: 0, zIndex: 2100, display: "grid", placeItems: "center", padding: 20, background: "rgba(15,23,42,.42)", backdropFilter: "blur(4px)" },
      panel: { boxSizing: "border-box", width: "min(620px, calc(100vw - 40px))", maxHeight: "min(720px, calc(100vh - 40px))", overflow: "auto", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14, padding: "18px 20px", background: "var(--dsw-alias-bg-layer-2)", boxShadow: "var(--dsw-shadow-lv4, 0 24px 70px rgba(0,0,0,.3))" },
      err: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13, margin: "8px 0 0" },
      errRow: { display: "flex", alignItems: "center", gap: 10, margin: "8px 0 0" },
      selfUpdBanner: { border: "1px solid var(--dsw-alias-state-warn-secondary, #b45309)", background: "var(--dsw-alias-state-warn-primary-alpha, rgba(180,83,9,.10))", color: "var(--dsw-alias-state-warn-primary, #d97706)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, fontWeight: 600 },
      toast: { position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)", zIndex: 2000, maxWidth: "80vw", padding: "8px 16px", borderRadius: 10, fontSize: 13, boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.25))", background: "var(--dsw-alias-button-contrast-fill)", color: "var(--dsw-alias-label-primary-inverted)" },
      toastErr: { position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)", zIndex: 2000, maxWidth: "80vw", padding: "8px 16px", borderRadius: 10, fontSize: 13, boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.25))", background: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-label-primary-inverted)" }
    };

    function injectStyles() {
      if (document.getElementById("dshm-styles")) return;
      var el = document.createElement("style");
      el.id = "dshm-styles";
      el.textContent = [
        ".dshm-btn{transition:background .12s var(--ds-ease-in-out, ease)}",
        ".dshm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
        ".dshm-btn:disabled{opacity:.55;cursor:default}",
        ".dshm-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}",
        ".dshm-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}",
        ".dshm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
        "@keyframes dshm-progress{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}",
        ".dshm-progress{height:4px;margin:14px 0;overflow:hidden;border-radius:4px;background:var(--dsw-alias-bg-layer-3)}",
        ".dshm-progress>span{display:block;width:34%;height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary);animation:dshm-progress 1.15s ease-in-out infinite}"
      ].join("\n");
      document.head.appendChild(el);
    }

    function RepoCard(props) {
      var repo = props.repo;
      var busy = props.busy;        // 全局互斥：任何安装进行中 → 所有安装按钮禁用
      var selfBusy = props.selfBusy; // 本卡片正在安装 → 显示「安装中...」
      var installed = !!props.installed;
      var updateAvailable = !!props.updateAvailable;
      var done = installed && !updateAvailable;
      // skills 索引专属标识：含安装脚本（🛡）/ 探测未知（弱提示）
      var shield = repo.has_install_script === true;
      var unverified = repo.has_skill === null;
      // 只渲染 https://github.com 链接，杜绝 javascript: 等协议注入
      var safeUrl = /^https:\/\/github\.com\//.test(String(repo.html_url || "")) ? repo.html_url : null;
      return h("div", { style: s.card },
        h("div", { style: s.row },
          h("div", { style: { flex: 1, minWidth: 0, marginRight: 12 } },
            h("p", { style: s.name }, repo.name,
              h("span", { style: s.badge }, repo.stargazers_count > 0 ? "★ " + repo.stargazers_count : t("badgeNew")),
              repo.category && repo.category !== "other" ? h("span", { style: s.badge }, t("cat" + String(repo.category).split("-").map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(""))) : null,
              shield ? h("span", { style: s.badgeShield }, t("badgeShield")) : null,
              unverified ? h("span", { style: s.badge }, t("badgeUnverified")) : null),
            h("p", { style: s.meta }, repo.full_name + " · " + t("updatedAt", { d: (repo.updated_at || "").slice(0, 10) }) + (repo.license ? " · " + repo.license : "") + " · ",
              safeUrl ? h("a", { href: safeUrl, target: "_blank", rel: "noopener noreferrer", style: s.link }, t("githubLink")) : null,
              updateAvailable ? h("span", { style: s.updateHint }, t("updateHint", { old: repo.installedVersion, new: repo.latestVersion })) : null),
            repo.description ? h("p", { style: s.desc }, repo.description) : null,
            repo.topics && repo.topics.length > 0 ? h("p", { style: s.meta }, t("tags", { tags: repo.topics.slice(0, 6).join(", ") })) : null
          ),
          h("div", { style: { flex: "none" } },
            h("button", {
              className: "dshm-btn" + (done ? "" : " dshm-btn-primary"),
              style: done ? s.btnInstalled : s.btnPrimary,
              disabled: busy || done,
              onClick: function () { props.onInstall(repo.full_name); }
            }, selfBusy ? t("installing") : (updateAvailable ? t("update") : (installed ? t("installed") : t("install"))))
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
          (inst.result.count > 1 ? t("doneSkills", { count: inst.result.count }) : t("doneMsg", { type: inst.result.type })) + (inst.result.location ? t("doneMsgLoc", { loc: inst.result.location }) : "")),
        inst.result && (inst.result.status === "manual") && h("p", { style: s.err }, linkify(t("manualMsg", { url: inst.result.url || "" }))),
        inst.result && (inst.result.status === "aborted") && h("p", { style: s.err }, t("abortedMsg")),
        inst.result && (inst.result.status === "failed") && h("p", { style: s.err }, t("failedMsg", { err: (inst.result.error || "unknown") })),
        inst.phase !== "running" ? h("button", { className: "dshm-btn", style: Object.assign({}, s.btn, { marginTop: 12 }), onClick: props.cancel }, t("backToList")) : null
      );
    }

    /** DSH 插件 tab：现有市场列表逻辑 + 分类筛选。 */
    var CATEGORY_KEYS = ["vision", "document", "memory", "model", "notify", "coding", "conversation", "web-ui", "agent", "tool", "resource", "other"];
    function PluginTab(props) {
      var state = useState(null); var repos = state[0]; var setRepos = state[1];
      var state2 = useState(null); var error = state2[0]; var setError = state2[1];
      var state3 = useState(""); var query = state3[0]; var setQuery = state3[1];
      var state4 = useState("all"); var category = state4[0]; var setCategory = state4[1];

      function doRefresh(force) {
        props.showToast(t("refreshing"), true);
        fetch("/api/marketplace/list?lang=" + langCurrent + (force ? "&refresh=1" : ""), { headers: { "X-DSH-Marketplace": "1" } }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) { setError(data.error); props.showToast(t("refreshFail", { err: data.error }), false); }
          else { setRepos(data.repos || []); props.showToast(t("refreshOk", { n: (data.repos || []).length }), true); }
        }).catch(function (err) {
          props.showToast(t("refreshFail", { err: String(err) }), false);
        });
      }

      useEffect(function () {
        var cancelled = false;
        setError(null);
        fetch("/api/marketplace/list?lang=" + langCurrent, { headers: { "X-DSH-Marketplace": "1" } }).then(function (r) { return r.json(); }).then(function (data) {
          if (cancelled) return;
          if (data.error) { setError(data.error); setRepos([]); }
          else setRepos(data.repos || []);
        }).catch(function (err) { if (!cancelled) { setError(String(err)); setRepos([]); } });
        return function () { cancelled = true; };
      }, [props.tick]);

      return h("div", null,
        h("div", { style: s.head },
          h("div", null,
            h("h2", { style: s.title }, t("sectionLabel")),
            h("p", { style: s.sub }, t("pageSub"))
          ),
          h("button", { className: "dshm-btn", style: s.btn, onClick: function () { doRefresh(true); } }, t("refresh"))
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
          return [
            h("p", { key: "count", style: Object.assign({}, s.meta, { margin: "0 0 8px" }) },
              t("countTotal", { n: repos.length }) + ((q || category !== "all") ? t("countMatch", { n: list.length }) : "")),
            list.map(function (repo) {
              // 全局互斥：任何安装进行中 → 所有按钮禁用；只有正在安装的那个显示「安装中...」
              return h(RepoCard, { key: repo.full_name, repo: repo, installed: repo.installed, updateAvailable: repo.updateAvailable, busy: !!(props.inst && props.inst.phase === "running"), selfBusy: !!(props.inst && props.inst.phase === "running" && props.inst.repo === repo.full_name), onInstall: function (fullName) { props.setInputValues({}); props.runInstall(fullName, {}, []); } });
            }),
            list.length === 0 ? h("p", { key: "empty", style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, q ? t("noMatch", { q: query }) : t("noMatchCat")) : null
          ];
        })() : null,
        repos && repos.length === 0 && !error ? h("p", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("empty")) : null
      );
    }

    /** 通用 Skills tab：全量索引 + 分页（每页 60，IntersectionObserver 触底加载）。 */
    var SKILL_PAGE_SIZE = 60;
    function SkillsTab(props) {
      var state = useState(null); var repos = state[0]; var setRepos = state[1];
      var state2 = useState(null); var error = state2[0]; var setError = state2[1];
      var state3 = useState(""); var query = state3[0]; var setQuery = state3[1];
      var state4 = useState(SKILL_PAGE_SIZE); var visible = state4[0]; var setVisible = state4[1];

      function doRefresh(force) {
        props.showToast(t("refreshing"), true);
        fetch("/api/marketplace/skills?lang=" + langCurrent + (force ? "&refresh=1" : ""), { headers: { "X-DSH-Marketplace": "1" } }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) { setError(data.error); props.showToast(t("refreshFail", { err: data.error }), false); }
          else { setRepos(data.repos || []); setVisible(SKILL_PAGE_SIZE); props.showToast(t("refreshOk", { n: (data.repos || []).length }), true); }
        }).catch(function (err) {
          props.showToast(t("refreshFail", { err: String(err) }), false);
        });
      }

      useEffect(function () {
        var cancelled = false;
        setError(null);
        fetch("/api/marketplace/skills?lang=" + langCurrent, { headers: { "X-DSH-Marketplace": "1" } }).then(function (r) { return r.json(); }).then(function (data) {
          if (cancelled) return;
          if (data.error) { setError(data.error); setRepos([]); }
          else { setRepos(data.repos || []); setVisible(SKILL_PAGE_SIZE); }
        }).catch(function (err) { if (!cancelled) { setError(String(err)); setRepos([]); } });
        return function () { cancelled = true; };
      }, [props.tick]);

      // 搜索词变化时重置分页（搜索在完整数组 filter 后重新分页）
      useEffect(function () { setVisible(SKILL_PAGE_SIZE); }, [query]);

      // 触底加载：sentinel 进入视口 → 追加一页
      useEffect(function () {
        var el = document.getElementById("dshm-skills-sentinel");
        if (!el) return;
        var observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) setVisible(function (n) { return n + SKILL_PAGE_SIZE; });
          });
        }, { rootMargin: "300px" });
        observer.observe(el);
        return function () { observer.disconnect(); };
      }, [repos, query]);

      var q = query.trim().toLowerCase();
      var list = q
        ? (repos || []).filter(function (r) {
            return (r.name + " " + r.full_name + " " + (r.topics || []).join(" ")).toLowerCase().indexOf(q) !== -1;
          })
        : (repos || []);
      var shown = list.slice(0, visible);
      var hasMore = shown.length < list.length;

      return h("div", null,
        h("div", { style: s.head },
          h("div", null,
            h("h2", { style: s.title }, t("tabSkills")),
            h("p", { style: s.sub }, t("skillsSub"))
          ),
          h("button", { className: "dshm-btn", style: s.btn, onClick: function () { doRefresh(true); } }, t("refresh"))
        ),
        h("input", {
          style: Object.assign({}, s.input, { marginTop: 0, marginBottom: 12 }),
          type: "search",
          placeholder: t("searchPlaceholderSkills"),
          value: query,
          onChange: function (e) { setQuery(e.target.value); }
        }),
        error ? h("div", { style: s.errRow },
          h("p", { style: s.err, margin: 0 }, t("loadFail", { err: error })),
          h("button", { className: "dshm-btn", style: s.btn, onClick: function () { doRefresh(false); } }, t("retry"))
        ) : null,
        repos === null ? h("p", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("loading")) : null,
        repos ? [
          h("p", { key: "count", style: Object.assign({}, s.meta, { margin: "0 0 8px" }) },
            t("countSkills", { n: repos.length }) + (q ? t("countMatch", { n: list.length }) : "")),
          shown.map(function (repo) {
            return h(RepoCard, { key: repo.full_name, repo: repo, installed: repo.installed, updateAvailable: false, busy: !!(props.inst && props.inst.phase === "running"), selfBusy: !!(props.inst && props.inst.phase === "running" && props.inst.repo === repo.full_name), onInstall: function (fullName) { props.setInputValues({}); props.runInstall(fullName, {}, []); } });
          }),
          hasMore ? h("div", { key: "sentinel", id: "dshm-skills-sentinel", style: { height: 1 } }) : null,
          list.length === 0 ? h("p", { key: "empty", style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("noMatch", { q: query })) : null
        ] : null,
        repos && repos.length === 0 && !error ? h("p", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("skillsEmpty")) : null
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
          headers: { "Content-Type": "application/json", "X-DSH-Marketplace": "1" },
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
        }).catch(function (err) {
          setInst(function (prev) {
            if (!prev || prev.repo !== repo) return prev;
            return { repo: repo, phase: "failed", log: (prev.log || []).concat([t("requestFail", { err: String(err) })]), questions: [], answers: answers || {}, result: null };
          });
          setTick(tick + 1);
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

      function showToast(text, ok) {
        setToast({ text: text, ok: !!ok });
      }

      var tabProps = { inst: inst, runInstall: runInstall, setInputValues: setInputValues, tick: tick, showToast: showToast };

      return h("div", { style: s.page },
        toast ? h("div", { style: toast.ok ? s.toast : s.toastErr }, toast.text) : null,
        selfUpd && selfUpd.updateAvailable ? h("div", { style: s.selfUpdBanner }, t("selfUpdate", { old: selfUpd.installedVersion, new: selfUpd.latestVersion })) : null,
        h("div", { style: s.tabBar },
          h("button", { style: activeTab === "plugins" ? s.tabActive : s.tabBtn, onClick: function () { setActiveTab("plugins"); } }, t("tabPlugins")),
          h("button", { style: activeTab === "skills" ? s.tabActive : s.tabBtn, onClick: function () { setActiveTab("skills"); } }, t("tabSkills"))
        ),
        inst ? h("div", { style: s.installOverlay }, h(InstallPanel, { inst: inst, inputValues: inputValues, setInputValues: setInputValues, submit: submit, cancel: cancelInstall })) : null,
        activeTab === "plugins" ? h(PluginTab, tabProps) : h(SkillsTab, tabProps),
        h("p", { key: "disclaimer", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginTop: 16, lineHeight: 1.6 } }, t("disclaimer"))
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
