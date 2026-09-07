const ENV_PATTERN = /\b(?:[A-Z][A-Z0-9_]{1,}(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)|[A-Z][A-Z0-9_]{3,}_PASS|[a-z][A-Za-z0-9]*(?:ApiKey|Token|Secret|Password))\b/g;

const HOST_SHADOW_PACKAGES = new Set([
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-scope",
  "@deepseek-ai/dsh-schema"
]);

const HAZARD_CRED_PATTERNS = [
  { id: "read-aws-credentials", re: /(?:\.aws[\\/]credentials|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)/i, severity: "critical" },
  { id: "read-ssh-key", re: /(?:\.ssh[\\/])?id_(?:rsa|ed25519|ecdsa)(?:\.pub)?\b/i, severity: "critical" },
  { id: "read-docker-config", re: /\.docker[\\/]config\.json\b/i, severity: "high" },
  { id: "read-kube-config", re: /\.kube[\\/]config\b/i, severity: "high" },
  { id: "read-npmrc-token", re: /(?:\.npmrc\b|_authToken|NPM_TOKEN)/i, severity: "high" },
  { id: "read-git-credentials", re: /(?:\.git-credentials|GIT_ASKPASS)/i, severity: "high" },
  { id: "browser-password-db", re: /(?:Login Data|Web Data|logins\.json|key4\.db|cookies\.sqlite)/i, severity: "critical" },
  { id: "windows-credential-manager", re: /(?:\bcmdkey\b|\bvaultcmd\b|CredentialManager)/i, severity: "high" },
];

const SCRIPT_HAZARD_PATTERNS = {
  bash: [
    { id: "curl-pipe-shell", severity: "critical", category: "downloadExec", re: /\b(?:curl|wget|fetch)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba|z|da|a|k)?sh\b/i },
    { id: "curl-pipe-python", severity: "critical", category: "downloadExec", re: /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?python[23]?\b/i },
    { id: "bash-c-curl-subshell", severity: "critical", category: "downloadExec", re: /\b(?:ba|z)?sh\s+-c\s+["']?\$\((?:curl|wget)\b/i },
    { id: "eval-curl-subshell", severity: "critical", category: "downloadExec", re: /\beval\s+["']?\$\((?:curl|wget)\b/i },
    { id: "process-substitution-bash", severity: "critical", category: "downloadExec", re: /\b(?:ba|z)?sh\s+<\((?:curl|wget)\b/i },
    { id: "base64-decode-pipe-sh", severity: "critical", category: "obfuscation", re: /\b(?:echo|printf)\s+[A-Za-z0-9+/=]{40,}\s*\|\s*base64\s+(?:-d|--decode)\s*\|\s*(?:ba|z)?sh\b/i },
    { id: "node-e-eval-base64", severity: "critical", category: "obfuscation", re: /\bnode\s+(?:-e|--eval)\s+["'].*(?:eval|Function)\s*\(.*(?:Buffer\.from|atob|base64)/i },
    { id: "bare-eval", severity: "high", category: "dynamicExec", re: /\beval\s+["'`$]/ },
    { id: "hex-escape-string", severity: "medium", category: "obfuscation", re: /(?:\\x[0-9a-f]{2}){8,}/ },
    ...HAZARD_CRED_PATTERNS.map((p) => ({ ...p, category: "credRead" })),
    { id: "printenv-pipe-net", severity: "high", category: "exfil", re: /\b(?:printenv|env)\b[^\n|;]*\|\s*(?:curl|wget|nc|ncat)\b/i },
    { id: "crontab-add-run", severity: "high", category: "pathStartup", re: /\bcrontab\b/i },
    { id: "systemctl-enable", severity: "high", category: "pathStartup", re: /\bsystemctl\s+enable\b/i },
    { id: "launchagent-plist", severity: "high", category: "pathStartup", re: /Launch(?:Agents|Daemons)[^\n]*\.plist/i },
    { id: "rc-file-append", severity: "medium", category: "rcModify", re: /(?:>>|Add-Content|tee\s+-a|Out-File\s+[^\r\n]*?-Append)\s+[^\r\n"'`]*\.(?:bashrc|zshrc|bash_profile|bash_aliases|profile|zprofile)\b/i },
    { id: "nc-reverse-shell", severity: "critical", category: "exfil", re: /\b(?:nc|ncat|netcat)\b[^\n]*(?:-e\s|\/bin\/(?:ba)?sh)/ },
    { id: "bash-dev-tcp", severity: "critical", category: "exfil", re: /\/dev\/tcp\/[0-9.]+\/[0-9]+/ },
    { id: "webhook-exfil-url", severity: "high", category: "exfil", re: /https:\/\/[^\s]*(?:hooks\.slack\.com\/services|discord\.com\/api\/webhooks)/i },
    { id: "find-exec-rm", severity: "high", category: "fileOps", re: /\bfind\b[^\n]*-exec\s+rm\b/i },
    { id: "setx-path", severity: "medium", category: "pathStartup", re: /\bsetx\s+(?:\/m\s+)?path\b/i },
  ],
  ps1: [
    { id: "iex-iwr", severity: "critical", category: "downloadExec", re: /\b(?:iex|invoke-expression)\s*\(?\s*(?:iwr|invoke-webrequest|irm|invoke-restmethod)\b/i },
    { id: "download-pipe-iex", severity: "critical", category: "downloadExec", re: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl)\b[^\n|;]*\|\s*(?:iex|invoke-expression)\b/i },
    { id: "iex-downloadstring", severity: "critical", category: "downloadExec", re: /\b(?:iex|invoke-expression)\s*\(?\s*\(?\s*(?:new-object\s+)?(?:net\.|system\.net\.)?webclient\)?\.downloadstring/i },
    { id: "powershell-encodedcommand", severity: "critical", category: "obfuscation", re: /\bpowershell(?:\.exe)?\b[^\n]*-(?:e(?:nc(?:odedcommand)?)?)\s+[A-Za-z0-9+/=]{20,}/i },
    { id: "bitsadmin-transfer", severity: "high", category: "downloadExec", re: /\b(?:bitsadmin|start-bitstransfer)\b[^\n]*https?:\/\//i },
    { id: "certutil-urlcache", severity: "high", category: "downloadExec", re: /\bcertutil\s+(?:-urlcache|-decode)\b/i },
    { id: "iex-any", severity: "high", category: "dynamicExec", re: /\b(?:invoke-expression|iex)\b/i },
    { id: "dot-source-remote", severity: "high", category: "downloadExec", re: /\.\s+["']?https?:\/\//i },
    ...HAZARD_CRED_PATTERNS.map((p) => ({ ...p, category: "credRead" })),
    { id: "read-env-file-ps", severity: "medium", category: "credRead", re: /(?:Get-Content|gc|type)\s+[^\n|;&]*\.env\b/i },
    { id: "schtasks-create", severity: "critical", category: "pathStartup", re: /\bschtasks\s+\/create\b/i },
    { id: "register-scheduled-job", severity: "high", category: "pathStartup", re: /\bregister-scheduled(?:job|task)\b|\bnew-scheduledtask\b/i },
    { id: "sc-create-service", severity: "critical", category: "pathStartup", re: /\bsc(?:\.exe)?\s+create\b/i },
    { id: "wmi-event-subscription", severity: "critical", category: "pathStartup", re: /(?:__EventFilter|CommandLineEventConsumer|FilterToConsumerBinding)/ },
    { id: "startup-folder-write", severity: "high", category: "pathStartup", re: /Start Menu\\Programs\\Startup/i },
    { id: "registry-run-key", severity: "critical", category: "pathStartup", re: /CurrentVersion\\Run(?:Once)?\b/i },
    { id: "setx-path", severity: "high", category: "pathStartup", re: /\bsetx\s+(?:\/m\s+)?path\b/i },
    { id: "setenv-var-path", severity: "high", category: "pathStartup", re: /\[Environment\]::SetEnvironmentVariable\(\s*["']Path["']/i },
    { id: "run-key-new-itemproperty", severity: "critical", category: "pathStartup", re: /New-ItemProperty[^\n]*Run/i },
    { id: "set-executionpolicy-bypass", severity: "high", category: "dynamicExec", re: /\bset-executionpolicy\s+[^\n]*(?:bypass|unrestricted)/i },
    { id: "disable-defender", severity: "critical", category: "fileOps", re: /\bset-mppreference\b[^\n]*(?:-disablerealtime|-exclusionpath)/i },
    { id: "remove-item-force-recurse", severity: "medium", category: "fileOps", re: /\bremove-item\s+[^\n]*-recurse[^\n]*-force/i },
  ],
};

const HAZARD_ALLOWLIST_DOMAINS = [
  "raw.githubusercontent.com",
  "github.com",
  "get.docker.com",
  "install.meteor.com",
  "bootstrap.pypa.io",
  "nodejs.org",
  "deb.nodesource.com",
  "npmjs.com",
  "registry.npmjs.org",
];

const HAZARD_COMBO_PATTERNS = [
  { id: "combo-base64-literal-decode", category: "obfuscation", severity: "high",
    a: /[A-Za-z0-9+/]{80,}={0,2}/, b: /\b(?:atob|base64\s+(?:-d|--decode)|Buffer\.from\([^)]*base64|FromBase64String)\b/i },
  { id: "combo-env-dump-exfil", category: "exfil", severity: "critical", sameLine: true,
    a: /(?:process\.env\b.*(?:JSON\.stringify|Object\.(?:keys|entries|values))|printenv|env\s*\|\s*)/i,
    b: /(?:https?:\/\/|fetch\(|curl\s|wget\s|Invoke-WebRequest|iwr\s|requests\.post)/i },
  { id: "combo-fingerprint-exfil", category: "exfil", severity: "critical", sameLine: true,
    a: /\$\(?\s*(?:whoami|pwd|hostname)\b/i,
    b: /(?:https?:\/\/|curl\s|wget\s|nslookup\s|Invoke-RestMethod|irm\s)/i },
  { id: "combo-dns-token", category: "exfil", severity: "high", sameLine: true,
    a: /\b(?:nslookup|resolve-dnsname)\b/i,
    b: /\$\{?\w*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|CRED)/i },
  { id: "combo-download-spawn", category: "downloadExec", severity: "critical",
    a: /\b(?:curl|wget|Invoke-WebRequest|iwr|irm|start-bitstransfer|bitsadmin)\b[^\n]*https?:\/\//i,
    b: /(?:exec(?:Sync|File(?:Sync)?)?\s*\(|spawn(?:Sync)?\s*\(|Start-Process\b|(?:^|[;&])\s*&\s*(?:\$[A-Za-z_]|\/tmp\/)|invoke-expression\b|iex\b)/i },
];

const JS_HAZARD_PATTERNS = [
  { id: "remote-eval", severity: "critical", category: "dynamicExec", re: /(?:https?\.(?:get|request)\s*\(|fetch\s*\(|request\s*\()[\s\S]{0,200}?\beval\s*\(/i },
  { id: "eval-base64", severity: "critical", category: "obfuscation", re: /\beval\s*\([\s\S]{0,120}?(?:Buffer\.from\([^)]*base64|atob\s*\()/i },
  { id: "childproc-silent", severity: "high", category: "dynamicExec", re: /(?:exec|spawn|execFile)\s*\(\s*[^)]*\{?[\s\S]{0,80}?stdio\s*:\s*["']ignore["']/i },
  { id: "childproc-bracket-call", severity: "medium", category: "dynamicExec", re: /require\(['"]child_process['"]\)\[['"](?:exec|spawn|execFile|execSync)['"]\]/i },
  { id: "env-dump", severity: "high", category: "credRead", re: /(?:JSON\.stringify\s*\(\s*process\.env|Object\.(?:keys|entries|values)\s*\(\s*process\.env)/i },
  { id: "obfuscated-url", severity: "medium", category: "obfuscation", re: /['"][^'"]{20,}['"]\s*\+\s*['"][^'"]{20,}['"][\s\S]{0,120}?https?:\/\//i },
];

const SECRET_SCAN_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".json", ".yaml", ".yml",
  ".sh", ".ps1", ".psm1", ".bat", ".cmd", ".py", ".rb", ".go", ".rs",
  ".toml", ".ini", ".cfg", ".conf", ".xml", ".md", ".txt", ".html", ".css",
]);
const SECRET_SCAN_BASENAMES = new Set([".env", ".env.local", ".env.production", ".env.development"]);
const SECRET_SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor"]);
const SECRET_SCAN_MAX_FILES = 200;
const SECRET_SCAN_MAX_FILE_BYTES = 512 * 1024;
const CVE_MAX_QUERIES = 100;

export function extractEnvNames(text) {
  const names = new Set();
  for (const match of String(text ?? "").matchAll(ENV_PATTERN)) names.add(match[0]);
  return [...names];
}

export function findHostShadowDeps(pkg) {
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.bundledDependencies && typeof pkg.bundledDependencies === "object" ? pkg.bundledDependencies : {})
  };
  return [...new Set(Object.keys(deps).filter((name) => HOST_SHADOW_PACKAGES.has(name)))];
}

export function scriptHazardLangFor(filePath) {
  return (/\.ps1$/i).test(String(filePath ?? "")) ? "ps1" : "bash";
}

export function hazardUrlAllowed(line) {
  for (const domain of HAZARD_ALLOWLIST_DOMAINS) {
    const boundary = new RegExp(`https?://(?:[^/\\s]*\\.)?${domain.replaceAll(".", "\\.")}(?=[/"'\\s]|$)`, "i");
    if (boundary.test(line)) return true;
  }
  return false;
}

export function classifyScriptHazards(content, filePath) {
  const hits = [];
  const rules = SCRIPT_HAZARD_PATTERNS[scriptHazardLangFor(filePath)];
  const lines = String(content ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < 8; i++) {
    const line = lines[i];
    for (const rule of rules) {
      if (rule.re.test(line)) {
        const severity = rule.category === "downloadExec" && hazardUrlAllowed(line) ? "medium" : rule.severity;
        hits.push({ category: rule.category, line: i + 1, text: line.trim().slice(0, 120), id: rule.id, severity });
        break;
      }
    }
  }
  if (hits.length < 8) {
    for (const combo of HAZARD_COMBO_PATTERNS) {
      if (hits.length >= 8) break;
      const lineA = lines.findIndex((line) => combo.a.test(line));
      const lineB = lines.findIndex((line) => combo.b.test(line));
      const sameLineOk = combo.sameLine === true
        ? lineA >= 0 && lineB >= 0
        : lineA >= 0 && lineB >= 0 && lineA !== lineB;
      if (sameLineOk) {
        hits.push({ category: combo.category, line: lineA + 1, text: `[combo] ${combo.id}`, id: combo.id, severity: combo.severity });
      }
    }
  }
  return hits;
}

export function lifecycleScriptTargets(pkg) {
  const targets = [];
  const seen = new Set();
  const scripts = pkg?.scripts ?? {};
  for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
    const command = typeof scripts[name] === "string" ? scripts[name] : "";
    for (const match of command.matchAll(/node\s+([^\s&;|]+\.js)/g)) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        targets.push(match[1]);
      }
    }
  }
  return targets;
}

export function classifyLifecycleHazards(pkg, localScripts = new Map()) {
  const hits = [];
  const scripts = pkg?.scripts ?? {};
  for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
    const command = typeof scripts[name] === "string" ? scripts[name] : "";
    if (!command) continue;
    for (const rule of JS_HAZARD_PATTERNS) {
      if (rule.re.test(command)) hits.push({ script: name, category: rule.category, severity: rule.severity, id: rule.id, text: command.slice(0, 120) });
    }
    for (const match of command.matchAll(/node\s+([^\s&;|]+\.js)/g)) {
      const content = localScripts.get(match[1]);
      if (typeof content !== "string") continue;
      for (const rule of JS_HAZARD_PATTERNS) {
        if (rule.re.test(content)) hits.push({ script: name, category: rule.category, severity: rule.severity, id: rule.id, text: `${match[1]}: ${content.slice(0, 80)}` });
      }
    }
  }
  return hits;
}

export function parseLockfileVersions(text) {
  const map = new Map();
  if (typeof text !== "string") return map;
  try {
    if (text.includes("package-lock") || text.trimStart().startsWith("{")) {
      const data = JSON.parse(text);
      for (const key of Object.keys(data.packages ?? {})) {
        const match = key.match(/node_modules\/(\@[^/]+\/[^/]+|[^@/][^/]*)$/);
        const version = data.packages[key]?.version;
        if (match && typeof version === "string") map.set(match[1], version);
      }
    } else {
      for (const match of text.matchAll(/^\s+(?:'?)?([^'\s:]+)@(?:[^:]+)?:\s*$/gm)) {
        const escapedName = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const versionMatch = text.match(new RegExp(`^\\s+'?${escapedName}@[\\s\\S]{0,200}?version:?\\s*([0-9][0-9a-zA-Z.+-]*)`, "m"));
        if (versionMatch) map.set(match[1], versionMatch[1]);
      }
    }
  } catch {}
  return map;
}

export function readVulnScanDeps(pkg, lockVersions) {
  const out = [];
  for (const section of ["dependencies", "optionalDependencies"]) {
    const deps = pkg?.[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== "string" || range.length === 0) continue;
      if (range.startsWith("npm:")) {
        const match = range.slice(4).match(/^(?:@[^/]+\/)?[^@]+@(.+)$/);
        if (match) {
          const realName = range.slice(4, range.length - match[1].length - 1);
          out.push({ name: realName, version: match[1] });
        }
        continue;
      }
      if (/^(?:workspace|link):/.test(range)) continue;
      const exact = lockVersions.get(name);
      if (/^[0-9]+\.[0-9]+\.[0-9]+/.test(exact ?? "")) {
        out.push({ name, version: exact });
      } else {
        const match = range.match(/^(?:\^|~|>=?)?\s*v?([0-9]+(?:\.[0-9x*]+){0,2})/i);
        if (match) out.push({ name, version: match[1], range });
      }
    }
  }
  return out.slice(0, CVE_MAX_QUERIES);
}

export function filterVulnerabilityHits(deps, advisories) {
  const hits = [];
  for (const dep of deps) {
    for (const advisory of Array.isArray(advisories?.[dep.name]) ? advisories[dep.name] : []) {
      if (advisory.severity === "critical" || advisory.severity === "high") {
        hits.push({
          name: dep.name,
          version: dep.version,
          severity: advisory.severity,
          title: String(advisory.title ?? "").slice(0, 120),
          vulnerable: String(advisory.vulnerable_versions ?? "").slice(0, 80),
          url: String(advisory.url ?? ""),
        });
      }
    }
  }
  return hits;
}

export function isSecretScanFile(name) {
  const fileName = String(name ?? "");
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return SECRET_SCAN_BASENAMES.has(fileName.toLowerCase())
    || (ext.startsWith(".") && SECRET_SCAN_EXTENSIONS.has(ext));
}

export function isSecretScanSkipDir(name) {
  return SECRET_SCAN_SKIP_DIRS.has(String(name ?? ""));
}

export {
  ENV_PATTERN,
  HOST_SHADOW_PACKAGES,
  HAZARD_CRED_PATTERNS,
  SCRIPT_HAZARD_PATTERNS,
  HAZARD_ALLOWLIST_DOMAINS,
  HAZARD_COMBO_PATTERNS,
  JS_HAZARD_PATTERNS,
  SECRET_SCAN_EXTENSIONS,
  SECRET_SCAN_BASENAMES,
  SECRET_SCAN_SKIP_DIRS,
  SECRET_SCAN_MAX_FILES,
  SECRET_SCAN_MAX_FILE_BYTES,
  CVE_MAX_QUERIES,
};
