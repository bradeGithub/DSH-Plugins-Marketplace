# DSH Plugin Marketplace (dsh-plugin-marketplace)

🌐 **Language / 语言:** **English** | [中文](README.md)

A plugin marketplace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): it pulls **every** repository tagged with the [`dsh-plugin` topic](https://github.com/topics/dsh-plugin) on GitHub and shows them as cards in the Settings page of the DSH Web GUI — **one-click install / auto-update / version detection / installed recognition**, with no command line required.

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-ecosystem%20plugin-4D6BFE?logo=deepseek&logoColor=white)
![GitHub Stars](https://img.shields.io/github/stars/bradeGithub/DSH-Plugins-Marketplace?logo=github)
![License](https://img.shields.io/github/license/bradeGithub/DSH-Plugins-Marketplace)
![Registry CI](https://img.shields.io/github/actions/workflow/status/bradeGithub/DSH-Plugins-Marketplace/registry.yml?label=registry%20CI)
![Last Commit](https://img.shields.io/github/last-commit/bradeGithub/DSH-Plugins-Marketplace)
![Type](https://img.shields.io/badge/Type-client%2Bserver%20plugin-blue)
![Platform](https://img.shields.io/badge/Platform-Web%20GUI-lightgrey)
![i18n](https://img.shields.io/badge/i18n-zh%20%7C%20en-important)

---

## ⚡ Quick install (copy & run)

**One sentence to hand to an AI** (any AI with command execution works — no further explanation needed):

> Install the DSH plugin marketplace (dsh-plugin-marketplace): clone https://github.com/bradeGithub/DSH-Plugins-Marketplace into ~/.dsh/profiles/web/node_modules/dsh-plugin-marketplace, register it in ~/.dsh/profiles/web/cordis.patch.yml (id: plugin-marketplace, name: dsh-plugin-marketplace), then restart dsh web.

**Or just copy & run a command:**

| Platform | Command |
|---|---|
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/install.ps1 \| iex` |
| macOS / Linux | `curl -sL https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/install.sh \| bash` |

> ⚠️ The commands above download and run the install script from this repo (copies the plugin and registers it in `cordis.patch.yml`) — trust-to-execute. Alternatively, clone the repo and run `install.ps1` / `install.sh` manually, or install this repo directly from the plugin marketplace (it contains `install.ps1`, so the marketplace asks for your confirmation first).
> It is recommended to **review the script first** before executing it (`irm <url> | iex` / `curl <url> | bash` is a well-known remote-code-execution pattern).
> After installing, **restart DSH** (re-run `dsh web`) and refresh the page.

---

## ✨ Features

- **Full fetch**: the plugin list is served primarily from a **static registry** (`registry.json`, distributed via the jsDelivr CDN and regenerated every 2 hours by GitHub Actions) — zero API calls, zero rate limits, instant even with thousands of plugins; when the registry is unavailable it automatically falls back to paging the GitHub search API (10-minute cache). List order: **installed plugins first**, then the rest sorted by star count descending
- **One-click install**: each card has an «Install» button that automatically runs: clone repo → detect type → scan required env vars → install
- **Built-in quick install**: this repo ships `install.ps1` / `install.sh` — install with a single command, or hand the one-liner above to any AI
- **Smart type detection**: automatically detects and installs the following repo types:
  - `skill` (contains `SKILL.md`) → installed to `~/.dsh/skills/`
  - agent preset (contains `preset.yml` + `agent.cordis.yml`) → installed to `~/.dsh/.agent-presets/`
  - cordis plugin (contains `package.json`) → installs dependencies and registers into the web profile
  - install script (`install.sh` / `install.ps1`) → executes the script
- **User input interception**: when a plugin needs env vars like `API_KEY` / `TOKEN` / `SECRET`, **installation pauses automatically** and an in-page dialog asks you for the material (or you can skip) — never installs blind
- **Script execution confirmation**: when a third-party install script (`install.sh` / `install.ps1`) or an npm lifecycle script (`prepare` / `install` / `postinstall`, etc.) is detected, asks for your confirmation first — declining cancels the install and **cleans up all traces**
- **Installed recognition**: four-way detection — install manifest (`installed.json`) + directory heuristic probing + package-name mapping scan + self-identification via the plugin's own `repository` field; installed plugins show a disabled grey «Installed» button
- **Bilingual**: the UI and install logs follow DSH's language setting — 中文 / English (Settings → General → Language)
- **Version detection & updates**: cordis plugins compare the installed version against the latest version of the repo (read from the local cache, zero extra network requests); when they differ the button turns into «Update» — click to overwrite-upgrade
- **Search**: real-time filtering by plugin name / full repo name / tags
- **General Skills column**: switch to the «General Skills» tab in Settings — browse the CI-built skills index (`agent-skills` ∪ `claude-skills`, 1800+ repos) with search / paginated infinite scroll / one-click install to `~/.dsh/skills/` / installed recognition; repos with install scripts carry a 🛡 badge, unverified probes show a weak «unverified» hint
- **Refresh feedback**: click «Refresh» to force a re-fetch, with a toast confirming «refresh succeeded / refresh failed»
- **GitHub link**: every card links to the original repo (opens in a new tab)
- **Dark/light themes**: built entirely on DSH theme tokens (`--dsw-alias-*`), adapting automatically
- **Self-exclusion**: `deepseek-harness` (DSH's own repo, not a plugin) is hard-coded excluded

---

## 📦 Installing this plugin

> 💡 Prefer no manual steps? Use the [⚡ Quick install](#-quick-install-copy--run) section above (a single command, or the one-liner handed to an AI).

The plugin lives at `~/.dsh/profiles/web/node_modules/dsh-plugin-marketplace/` and is registered via `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: plugin-marketplace
      name: dsh-plugin-marketplace
```

> ⚠️ **Restart required**: the DSH web profile has configuration hot-reload disabled (`hmr` off). After changing plugin code or registration entries you need to **restart DSH** (re-run `dsh web` or `start-dsh.bat`) and then refresh the page.

---

## 🚀 Usage

1. Restart DSH, open the Web GUI and go to **Settings → DSH Plugin Marketplace**
2. The page auto-loads all plugins (sorted by stars); click «Refresh» to force a re-fetch
3. Use the search box to filter plugins by name
4. Click the button on a plugin card:
   - **Install** → starts installation with a live-scrolling log
   - Material needed → an input dialog appears; provide the API key etc. and click «Submit and continue install»
   - **Update** → overwrite-upgrade when a newer version is detected
   - **Installed** (grey) → nothing to do

---

## 🔧 How it works

### Data source (registry first, search API fallback)

```
GitHub Actions (every 2 hours, repo's own token)
   └─ scripts/build-registry.mjs: pages topic:dsh-plugin, incremental merge, dedupe/self-exclude
        └─ commits registry.json back to main (460+ plugins, sorted by stars)
             └─ plugin reads: jsDelivr CDN (fast in CN) → raw.githubusercontent (fallback)
                  └─ only if all sources fail: GitHub search API (paged, 10-min cache)
```

- The registry is generated by CI, so end users make **zero API calls and hit no rate limits**; new plugins appear within two hours at most
- **Manual refresh anytime**: run `update-registry.bat` (Windows) or `update-registry.sh` (macOS / Linux) from this repo to trigger a CI rebuild of the registry immediately, no need to wait for the 2-hour schedule (requires the [gh CLI](https://cli.github.com) to be installed and logged in)
- The registry only contains repo metadata (name / description / stars / updated_at / topics / license); installing still clones directly from `github.com`

### Install pipeline (5 steps)

```
[1/5] git clone repo to ~/.dsh/marketplace/cache/<owner>__<name>/
[2/5] Detect type (SKILL.md / agent preset / install script / package.json)
[3/5] Scan README / install scripts / .env examples for env vars (API_KEY etc.)
      └─ found → pause installation, wait for user material (skippable)
[4/5] Perform install (copy skill / preset / plugin package, or run install script)
      └─ script type → ask for user confirmation first (third-party code risk)
[5/5] Write the install manifest (installed.json) and return the result
```

### Version detection logic

| Data | Source |
|---|---|
| Installed version | `installed.json` record; for legacy installs without a record, read the install dir's `package.json` |
| Latest version | the market cache clone `~/.dsh/marketplace/cache/<owner>__<name>/package.json` |

When both exist and differ → the card shows an «Update» button plus `installed vX → vY`.
(Only applies to cordis plugins containing `package.json`; skills / presets / script types have no version concept.)

### Installed detection (five-way, auto-reconciled on every open)

1. `~/.dsh/marketplace/installed.json` install manifest (installed via this plugin)
2. Directory heuristic probing: `~/.dsh/skills/<name>`, `~/.dsh/.agent-presets/<name>`, market cache clone
3. Package-name mapping: scans the `package.json` names of installed directories (including scoped `@scope/name` packages) and compares them against the repo name / raw repo name / registry package name (`pkg_name`) — repos whose name differs from the package name (e.g. `DSH-Plugins-Marketplace` → `dsh-plugin-marketplace`) are still recognized, and the installed version is read correctly
4. **Repository ownership check (both directions)**: the installed package's `repository` field must match the target repo — this prevents false positives for same-named repos from different owners, and enables reverse matching (plugins installed before the marketplace are correctly flagged as installed, even for scoped packages or large name differences)
5. Self-identification: a repo matching this plugin's own `repository` field in `package.json` counts as installed (the market never shows its own repo as «Install»)

> **Official plugins are auto-excluded**: DSH's built-in official plugins (`@deepseek-ai/*`, discovered at runtime from the install directory plus a fallback list) are never treated as user-installed marketplace plugins and are never mis-flagged as installed.

---

## 📁 File structure

```
~/.dsh/
├── profiles/web/
│   ├── node_modules/dsh-plugin-marketplace/   ← this plugin
│   │   ├── package.json        (dsh.client declaration + exports)
│   │   └── lib/
│   │       ├── index.js        (server: GitHub fetch / install pipeline / version detection)
│   │       └── client.js       (client: marketplace page UI)
│   └── cordis.patch.yml        (plugin registration entry)
└── marketplace/
    ├── cache/<owner>__<name>/  (clone cache; data source for install & version comparison)
    └── installed.json          (install manifest: type / name / location / version / installedAt)
```

---

## 📡 HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/api/marketplace/list` | GET | Plugin list (star-descending, with `installed` / `installedVersion` / `latestVersion` / `updateAvailable`); `?refresh=1` forces a re-fetch |
| `/api/marketplace/skills` | GET | General skills list (from `skills.json`, filtered to `has_skill !== false`, with `installed` / `installedAt`); `?refresh=1` forces a re-fetch |
| `/api/marketplace/install` | POST | Install / update, body: `{ "repo": "owner/name", "answers": { "ENV_NAME": "value" } }`; returns `done` / `awaiting-input` / `aborted` / `failed` status + step-by-step log |

---

## ⚠️ Security notes

- Installing means trusting the repo: install scripts (`install.sh` / `install.ps1`) can **execute arbitrary code** on your machine; the market asks for confirmation before running them
- API keys and other material you provide are passed only as **environment variables for that installation** and are never written to any persistent file (except what the install script itself does)
- Third-party install scripts run with a **minimal environment** (basic system variables + the material you submitted); npm dependency installs strip all secret-class variables — `process.env` is never leaked wholesale to plugin code
- The install endpoint only accepts trusted origins: requests must carry the `X-DSH-Marketplace` header and the Host must be in the **allowlist** (loopback / private LAN ranges / extra hosts via the `DSH_MARKETPLACE_ALLOWED_HOSTS` env var), protecting against cross-site forgery and DNS rebinding
- Plugin packages are copied into the web profile and registered in `cordis.patch.yml` — they load with every DSH startup, so only install repos you trust

---

## ⚖️ Disclaimer

- This marketplace only provides **discovery and installation convenience**: every plugin listed comes from a third-party GitHub repository, developed and maintained independently by its authors, and is **not affiliated with DeepSeek Harness or this marketplace in any way**
- The marketplace makes **no express or implied warranty** about the quality, reliability, security, usability, or fitness of any plugin — including but not limited to code quality, license compliance, data privacy, malicious behavior, and compatibility
- A plugin appearing in the index **does not constitute any recommendation or endorsement**; installing means you have evaluated and accepted the risks yourself. Review the repo's source and README before installing
- This marketplace is provided **AS-IS**. The marketplace and its developers accept **no liability** for any direct or indirect loss (including data loss, system damage, privacy leaks, etc.) caused by installing or using any third-party plugin

---

## 🔄 Known limitations

- **Security model**: the install endpoint has no user authentication; protection relies on **local-network isolation plus a CSRF header check, a Host allowlist (loopback / LAN / configurable) and an Origin check** — do not expose the DSH web port to untrusted networks. Installing means executing third-party code on your machine (npm dependencies and install scripts); only install repos you trust and have reviewed
- Version detection only works for plugins with `package.json`; skills / presets / script types have no version concept
- The plugin list is served from the static registry (CDN) by default; the GitHub search API is used only when both registry sources are unreachable, and its unauthenticated limit is **10 requests/minute** — clicking «Refresh» too often during fallback may hit the limit (the UI will report refresh failure — wait and retry)
- **Skills index scope**: full index since v1.3 — Search API «stars segments + time-window bisection» breaks the 1000-results-per-query cap, covering all repos of `agent-skills` ∪ `claude-skills` (11,000+ currently); `has_skill` probing fills in batches under the Core API quota (CI resumes incrementally every 2 hours; unprobed repos show a «unverified» hint)
- «Installed» recognition for script-type plugins is based on cache-dir existence; after deleting the cache it will show as installable again
- Plugin code changes require a **DSH restart** to take effect (the web profile's HMR is disabled)

---

## 🌱 Third-party ecosystem

[Harness Desktop](https://github.com/baiyuscc13724-max/deepseek-harness-desktop) is a third-party, community-maintained Windows desktop app. Its stable release includes this marketplace, so users can browse, install, and update community plugins from **Settings → DSH Plugin Marketplace** without using the command line.

This entry was submitted by the Harness Desktop author, who also maintains the DSH-Plugins-Marketplace fork used by the desktop app. Harness Desktop has no official affiliation with this repository or DeepSeek.

---

## 🛠️ Development & maintenance

- Server-side logic: edit `lib/index.js` (syntax check: `node --check`)
- Page UI: edit `lib/client.js` (browser bundle, `window.__ModuleLoader__.load` format; `require` resolves DSH platform modules)
- Restart DSH for changes to take effect; the client bundle's revision (`rev`) is content-hashed, and the browser fetches the new version automatically after a restart
- Localization: dictionaries live at the top of `lib/client.js` (UI) and in `MESSAGES` in `lib/index.js` (server logs); the plugin registers its namespace into DSH's locale service and follows the DSH language setting (fallback: browser language)

---

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history (all versions before v1.0.0 are part of the beta series).

---

## 📄 License

MIT
