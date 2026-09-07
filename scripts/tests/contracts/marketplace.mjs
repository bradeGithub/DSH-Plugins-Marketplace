const REPO_FIELDS = Object.freeze([
  "full_name",
  "name",
  "description",
  "html_url",
  "category",
  "topics",
  "installable",
  "installed",
  "stargazers_count",
  "updated_at",
  "default_branch",
  "license",
  "fork",
  "archived",
  "pkg_name",
  "npm_pkg_name",
  "version",
  "npm_version",
  "has_skill",
  "has_install_script",
  "market_tags",
  "eco_type",
  "reportUrl",
  "verdict",
  "verifiedBy",
  "verifiedAt",
  "waterfall",
  "toolsResult",
  "disclosure",
  "cliNpm",
  "installedVersion",
  "latestVersion",
  "updateAvailable"
]);

const CONTRACTS = {
  list: {
    required: ["repos", "total"],
    optional: ["cached_at", "filtered", "dropped", "source", "fp", "page", "pageSize"]
  },
  skills: {
    required: ["repos", "total"],
    optional: ["cached_at", "filtered", "dropped", "source", "page", "pageSize"]
  },
  install: {
    required: ["status"],
    optional: ["repo", "type", "questions", "log", "error", "url", "cliCommand", "scannedVars"]
  },
  uninstall: {
    required: ["status"],
    optional: ["repo", "removed", "log", "error"]
  },
  profile: {
    required: ["status"],
    optional: ["profile", "error"]
  },
  feedbackPending: {
    required: ["status", "pending"],
    optional: ["error"]
  },
  feedback: {
    required: ["status"],
    optional: ["issueUrl", "manualUrl", "error", "repo", "log"]
  },
  feedbackToken: {
    required: ["status", "hasToken"],
    optional: ["error"]
  },
  envKeys: {
    required: ["status", "repo", "envKeys", "configured"],
    optional: ["error"]
  },
  envEdit: {
    required: ["status"],
    optional: ["repo", "applied", "restartRequired", "error"]
  },
  backup: {
    required: ["status"],
    optional: ["backup", "log", "error"]
  },
  restoreDiff: {
    required: ["status"],
    optional: ["missing", "already", "log", "error"]
  },
  logs: {
    required: ["status", "text", "count", "log"],
    optional: ["error"]
  },
  selfUpdate: {
    required: [],
    optional: ["status", "installedVersion", "latestVersion", "updateAvailable", "checkedAt", "error", "message"]
  },
  checkUpdate: {
    required: ["status"],
    optional: ["repo", "installedVersion", "latestVersion", "updateAvailable", "error"]
  },
  error: {
    required: ["error"],
    optional: ["status"]
  }
};

export const MARKETPLACE_CONTRACTS = Object.freeze(
  Object.fromEntries(
    Object.entries(CONTRACTS).map(([kind, spec]) => [kind, Object.freeze({
      required: Object.freeze([...spec.required]),
      optional: Object.freeze([...spec.optional, "schemaVersion"]),
      fields: Object.freeze([...spec.required, ...spec.optional, "schemaVersion"])
    })])
  )
);

export const MARKETPLACE_STATUSES = Object.freeze([
  "done",
  "no-update",
  "awaiting-input",
  "aborted",
  "manual",
  "failed"
]);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function projectRepos(repos) {
  if (!Array.isArray(repos)) return clone(repos);
  return repos.map((repo) => {
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) return clone(repo);
    const projected = {};
    for (const field of REPO_FIELDS) {
      if (Object.hasOwn(repo, field)) projected[field] = clone(repo[field]);
    }
    return projected;
  });
}

function specFor(kind) {
  const spec = MARKETPLACE_CONTRACTS[kind];
  if (!spec) throw new Error(`unknown marketplace contract: ${kind}`);
  return spec;
}

export function projectMarketplacePayload(kind, payload) {
  const spec = specFor(kind);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const projected = {};
  for (const field of spec.fields) {
    if (Object.hasOwn(payload, field)) {
      projected[field] = field === "repos" ? projectRepos(payload[field]) : clone(payload[field]);
    }
  }
  return projected;
}

export function inspectMarketplacePayload(kind, payload) {
  const spec = specFor(kind);
  const isObject = Boolean(payload && typeof payload === "object" && !Array.isArray(payload));
  const missing = isObject ? spec.required.filter((field) => !Object.hasOwn(payload, field)) : [...spec.required];
  return { ok: isObject && missing.length === 0, missing, known: projectMarketplacePayload(kind, payload) };
}

export function legacyMarketplacePayload(kind, payload) {
  const spec = specFor(kind);
  const result = projectMarketplacePayload(kind, payload);
  const preserve = kind === "install" && result.status === "awaiting-input" ? ["questions"] : [];
  for (const field of spec.optional) {
    if (!preserve.includes(field)) delete result[field];
  }
  return result;
}

export function forwardMarketplacePayload(kind, payload) {
  const result = clone(payload);
  result.__contract_extension__ = { producer: "new", ignored: true };
  if (Array.isArray(result.repos)) {
    result.repos = result.repos.map((repo) => ({ ...repo, __contract_extension__: { ignored: true } }));
  }
  return result;
}

export function createMarketplaceFixtures() {
  const pluginRepos = [
    {
      full_name: "fixture-owner/fixture-ready",
      name: "fixture-ready",
      description: "A ready-to-install fixture plugin",
      category: "coding",
      topics: ["fixture", "ready"],
      installable: true,
      installed: false,
      stargazers_count: 12,
      updated_at: "2026-01-01T00:00:00Z"
    },
    {
      full_name: "fixture-owner/fixture-installed",
      name: "fixture-installed",
      description: "An already installed fixture plugin",
      category: "coding",
      topics: ["fixture", "installed"],
      installable: true,
      installed: true,
      stargazers_count: 8,
      updated_at: "2026-01-02T00:00:00Z"
    },
    {
      full_name: "fixture-owner/fixture-manual",
      name: "fixture-manual",
      description: "A fixture repository that cannot be installed",
      category: "other",
      topics: ["fixture", "manual"],
      installable: "non-plugin",
      installed: false,
      stargazers_count: 3,
      updated_at: "2026-01-03T00:00:00Z"
    }
  ];
  const skillRepos = [
    {
      full_name: "fixture-owner/fixture-skill",
      name: "fixture-skill",
      description: "A fixture general skill",
      category: "other",
      topics: ["fixture", "skill"],
      installable: true,
      installed: false,
      stargazers_count: 4,
      updated_at: "2026-01-04T00:00:00Z"
    },
    {
      full_name: "fixture-owner/fixture-skill-two",
      name: "fixture-skill-two",
      description: "A second fixture general skill",
      category: "other",
      topics: ["fixture", "skill"],
      installable: true,
      installed: false,
      stargazers_count: 2,
      updated_at: "2026-01-05T00:00:00Z"
    }
  ];
  return {
    list: { repos: pluginRepos, total: pluginRepos.length, source: "fixture", fp: "fixture-list-v1", dropped: 0 },
    skills: { repos: skillRepos, total: skillRepos.length, page: 1, pageSize: 20, source: "fixture", dropped: 0 },
    profile: { status: "done", profile: "web" },
    installAwaiting: {
      status: "awaiting-input",
      type: "cordis-plugin",
      questions: [{ id: "__confirm_npm_scripts__", question: "fixture lifecycle confirmation", options: [{ label: "允许", value: "allow" }, { label: "不允许（取消安装）", value: "deny" }] }]
    },
    installDone: { status: "done", type: "cordis-plugin", log: ["fixture install complete"] },
    installAborted: { status: "aborted", type: "cordis-plugin", log: ["fixture install denied"] },
    uninstall: { status: "done", removed: 1, log: [] },
    feedbackPending: { status: "done", pending: [] },
    feedbackToken: { status: "done", hasToken: false },
    envKeys: { status: "done", repo: "fixture-owner/fixture-ready", envKeys: [], configured: {} },
    backup: { status: "done", backup: { app: "dsh-plugin-marketplace", repos: [] }, log: [] },
    restoreDiff: { status: "done", missing: [], already: [], log: [] },
    logs: { status: "done", text: "", count: 0, log: [] },
    selfUpdate: { installedVersion: "1.5.5", latestVersion: "1.5.5", updateAvailable: false, checkedAt: 0, error: null },
    checkUpdate: { status: "done", installedVersion: "1.0.0", latestVersion: "1.0.0", updateAvailable: false },
    error: { error: "fixture unavailable" }
  };
}
