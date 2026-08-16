# STANDARD — DSH Plugin Marketplace Ingestion & Installation Spec

🌐 **Language / 语言:** **English** | [中文](STANDARD.md)

> This spec defines **how to shape a repository so the [DSH Plugin Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) detects it correctly, installs it correctly, and shows updates correctly**.
> The marketplace install pipeline is **feature-driven**: it scans the repository's file shape to decide how to install it. This document pins down the detection rules, the canonical shape of every plugin type, and the pitfalls we have hit (with real cases). **Write your repo this way and the marketplace will install, update, and uninstall it with one click.**

---

## 0. Ingestion prerequisites

- Add the topic **`dsh-plugin`** to the repository (GitHub repo page → Settings → Topics).
- The marketplace CI scans this topic every 2 hours and ingests repos automatically — **no application, no human review**.
- Suggested extra topics (help search & categorization): `dsh`, `deepseek-harness`, `agent-preset`, `cordis-plugin`, `dsh-skill`, etc.

## 1. Type detection overview (must-read for authors)

The marketplace scans feature files in the repo root in a **fixed order** — **the first match wins**:

| # | Feature | Detected type | Install behavior |
|---|---|---|---|
| 1 | Root has both `preset.yml` + `agent.cordis.yml` | agent-preset | Copy to `~/.dsh/.agent-presets/<id>` |
| 2 | Root `package.json` declares DSH plugin capability (`dsh` field / `@deepseek-ai/*` deps) | cordis-plugin | Build/install deps → copy into profile node_modules → register patch |
| 3 | Root has **`install.ps1`** (no plugin capability declared) | script | Execute the script (risk-confirmation dialog) |
| 4 | Root has **`install.sh`** (no plugin capability declared) | script | Execute the script (risk-confirmation dialog) |
| 5 | Subdirectory contains a full preset (`preset.yml` + `agent.cordis.yml`) | agent-preset | Copy each one |
| 6 | Root `package.json` (no DSH capability) + root `SKILL.md` | skill | Copy to `~/.dsh/skills/` |
| 7 | Root `SKILL.md` (no package.json) | skill | Same as above |
| 8 | Subdirectory contains plugin manifests (skins / multi-package repos) | cordis-plugin | Install each sub-package |
| 9 | Subdirectory contains skill manifests (skill collections) | skill | Install each one |
| 10 | No feature files at all | instructions | Show the README manual-install guide |

> ⚠️ **The two most important rules**:
> 1. **Rule #2 precedes #3/#4 (explicit declaration wins, enforced mechanically)** — a repo declaring `dsh` plugin capability is never treated as script type even with install scripts at the root; shipping convenience scripts alongside a cordis plugin is a legitimate shape. Still, scripts at the root mislead manual execution — move them into a `scripts/` subdirectory (see §6.1).
> 2. The `dsh` field in `package.json` (or `@deepseek-ai/*` dependencies) is the **plugin capability declaration** — without it, a root package.json is treated as a plain npm project.

---

## 2. Type A: cordis plugin (recommended primary form)

**Applies to**: any DSH plugin with a JS runtime (server tools / client skins / event handlers).

### 2.1 Minimal package.json

```json
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "main": "./lib/index.js",
  "type": "module",
  "files": ["lib"],
  "dsh": {
    "plugin": true,
    "kind": "server",
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "repository": { "type": "git", "url": "https://github.com/you/dsh-my-plugin.git" }
}
```

Field requirements:

| Field | Requirement |
|---|---|
| `name` | A valid npm package name (validated by `PKG_NAME_PATTERN`; scoped `@scope/name` allowed). **Same-named npm packages are mutually exclusive** — the marketplace hides lower-star repos with a `pkg_name` conflict; pick a unique name |
| `version` | Semver. **Must bump on every release** — the marketplace uses it for «update» detection (npm-published plugins use npm_version likewise) |
| `main` / `exports` | Point at an entry file that actually exists. **Missing entry + `scripts.build` present → the marketplace treats it as source-built and asks for a build confirmation** |
| `dsh` | **Plugin capability declaration** (any `dsh` object counts as a plugin). When `dsh.bundle.patch` points at a cordis patch manifest, the marketplace auto-registers it into the profile's cordis.patch.yml after install |
| `repository` | Strongly recommended — used by installed-recognition (same-repo matching) and the marketplace card display |
| `dependencies` / `peerDependencies` | The marketplace runs `npm install --omit=dev --ignore-scripts` (scripts only released after user confirmation); peer conflicts fall back to `--legacy-peer-deps` automatically. **DSH host interface packages (`@deepseek-ai/dsh-tools`, `dsh-llm`, `dsh-system-prompt`, `dsh-attachment`, `dsh-scope`, `dsh-schema`) must be `peerDependencies` only — never regular `dependencies`/`bundledDependencies`** (build-time versions go in `devDependencies`) — otherwise outdated copies shadow the host, breaking tool calls and built-in presets (real case in §6.6) |

### 2.2 Source-built vs pre-built

- **Pre-built (recommended)**: commit the build output (`lib/` or dist) and point `main` at an existing file → the marketplace copies and installs directly, fast and build-risk-free.
- **Source-built**: `scripts.build` exists and the `main` file is not committed (.gitignored) → the marketplace asks «install dependencies and run the build»; on confirmation it runs `npm/pnpm install` (full deps incl. dev) → `npm run build` → copies the output. The build script must work in a non-interactive environment.

### 2.3 Install pipeline (performed automatically by the marketplace)

1. Clone repo → detect cordis-plugin;
2. Build confirmation if needed → install deps (third-party scripts disabled by default);
3. Copy to `~/.dsh/profiles/web/node_modules/<pkg_name>` (excluding .git);
4. Entry validation (main file exists / `dsh.bundle` declared / any top-level JS);
5. Register `cordis.patch.yml` (idempotent, line-exact matching);
6. Record version → restart DSH to take effect.

### 2.4 Multi-package repos (skin collections, etc.)

No root package.json but subdirectories with plugin manifests → the marketplace walks `findPluginRoots` (depth 3) and **installs each sub-package**. Note: each sub-package's package.json also needs the `dsh` field or `@deepseek-ai/*` dependencies (otherwise it is not recognized as a plugin).

---

## 3. Type B: skill

**Applies to**: pure prompt skills (SKILL.md form, no JS runtime).

- Put **`SKILL.md`** in the repo root (case-insensitive);
- Optionally declare the skill name in frontmatter: `name: my-skill` (lowercase alphanumeric + hyphens); falls back to the repo name;
- Repos with a tooling package.json (no `dsh` field): the root SKILL.md still installs as a skill — **do NOT declare a `dsh` field in a skill repo**, or it will be detected as a plugin and the skill will be missed.
- Note: SKILL.md files under `.git` / dot-directories / `node_modules` / vendored directories (e.g. `upstream/`) are ignored and never installed.

## 4. Type C: agent preset

**Applies to**: agent preset packages (preset form).

- Contains both `preset.yml` + `agent.cordis.yml` → detected as agent-preset;
- The preset directory may live in a subdirectory (e.g. `preset/`, within depth 3); the marketplace copies each one to `~/.dsh/.agent-presets/<dir-name>`;
- If you also want installable plugin logic: make the JS part a cordis plugin (two separate repos, or put the preset in a subdirectory of the plugin repo — rule #4 precedes #5, so when a repo has **both** a plugin manifest at root and a preset in a subdirectory, the preset wins).

## 5. Type D: install script (install.ps1 / install.sh)

**Applies to**: install logic that cannot be expressed in the forms above (system-level configuration, external dependency orchestration).

Script contract (the marketplace clones the repo and runs the script from the repo root):

1. **Self-contained**: the marketplace only clones the git repo — it does not build. The script must not depend on build artifacts (`lib/`, `dist/`, etc. — .gitignored content); if a build is needed, do it inside the script (`bash scripts/build.sh`).
2. **Idempotent**: re-running is safe — already-registered / already-copied parts are skipped automatically.
3. **Both platforms**: `install.ps1` (Windows, pwsh) and `install.sh` (bash) are selected by platform; providing only one makes the other platform fail with a clear error.
4. **Environment resolution**: use `$env:DSH_HOME` / `$HOME` to locate the profile directory; fail clearly when the profile does not exist.
5. **Safety disclosure**: users see a «running third-party code is risky» confirmation dialog before install — the README should honestly describe what the script does.
6. **Uninstall**: script-type installs cannot be auto-rolled-back (marketplace uninstall only removes the record and the clone cache); the author must document how to reverse the script's effects.

> ⚠️ **Script type and cordis plugin are mutually exclusive**: if the project is essentially a cordis plugin (has package.json + `dsh` declaration),
> do **NOT** put install.ps1/install.sh in the repo root — see §6.1. Script-type installs have no version detection, no update button, no automatic uninstall.

## 6. Anti-patterns & real cases

### 6.1 Root install scripts coexisting with a cordis declaration (dsh-paper-tutor case)

The author placed the convenience install scripts `install.ps1`/`install.sh` of a cordis plugin (with a complete `dsh.plugin=true` declaration) in the **repo root**:
- The old detection order hit the script feature → script type, skipping the cordis pipeline;
- The script's local mode then required the build artifact `lib/index.js` (not committed) → hard error, **users clicking install always failed**.

**Current state (mechanical fallback)**: the detection order is now «`dsh` declaration precedes install scripts» — repos declaring plugin capability are correctly installed as cordis-plugin even with scripts at the root (the marketplace performs «build confirmation → install deps → copy → register patch» automatically). **Scripts are still recommended to live in a `scripts/` subdirectory**: root-level scripts mislead manual execution, and for repos without a `dsh` declaration the root script remains the script-type feature.

### 6.2 Description drift flips the category (dsh-TUI case)

The marketplace categorizes by keywords in `description` + `name` + `topics` (coding/notify/memory/…). One plugin was categorized `coding`; the author then added «DSH official WeChat featured…» to the description → matched the notify rule → category flipped and the regression test tripped.

**Author note**: promotional wording in the description (WeChat / notify / store / ranking) affects the category. The category only affects the marketplace column display, not installability. If mis-categorized, open an issue in the marketplace repo to request a manual override (`CATEGORY_OVERRIDES`).

### 6.3 No version bump → update detection never fires

The marketplace's «update» detection compares the repo's package.json `version` (npm-published plugins compare npm dist-tags). **Changing code without a release** means the «Update» button never appears (users must uninstall/reinstall). Release rule: change code → bump version → push (tag optional).

### 6.4 Self-registering a patch → double-load crash (issue #39)

The marketplace **automatically** registers cordis.patch.yml on install. Plugins must not register their own patch entry again at runtime or in their install scripts (profile-bundles load + patch double registration → duplicate webserver routes → startup crash). The marketplace's own install skips duplicate registration.

### 6.5 pkg_name collision → hidden from the list

Same-named npm packages are mutually exclusive in node_modules (they overwrite each other). The marketplace shows **only the higher-star repo** among `pkg_name` conflicts. Check npm/registry before choosing a name.

### 6.6 Host interface packages as regular deps → host shadowing (dsh-excel-chat case)

A plugin declared `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-system-prompt` / `dsh-attachment` as regular `dependencies` —
the install «succeeded» and the plugin loaded, but these **outdated copies were hoisted to the top of the profile and loaded before the host versions**, causing:
- every tool call to fail (`Cannot read properties of undefined (reading 'prepare')`)
- the built-in `minimal` preset to fail mounting (`ctx.systemPrompt.suppressRuntimeContext is not a function`)

**Correct shape**: host interface packages go in `peerDependencies` (aligned with the current DSH version range); build-time needs go in `devDependencies`. The marketplace now statically detects host packages in regular deps and shows a confirmation warning (deniable); **the marketplace warning cannot replace a platform fix** — even same-version duplicate copies can cause module identity conflicts, which needs host-priority resolution in DSH itself.

---

## 7. Self-check list (run before submitting for ingestion)

```bash
# 1. Detected type (any surprise = a pitfall)
git clone <your repo> /tmp/x  # compare root feature files against the §1 table

# 2. cordis plugin: entry & build
node -e "const p=require('/tmp/x/package.json');console.log(p.dsh, p.main, require('fs').existsSync('/tmp/x/'+p.main))"
#    expected: dsh object present; main file exists (pre-built) or scripts.build exists (source-built)

# 3. Skill: SKILL.md at root, frontmatter name valid

# 4. Script type: scripts for both platforms; no build-artifact dependency; idempotent (run twice, no side effects)

# 5. Description self-check: no category-sensitive words unrelated to the plugin's nature (WeChat / notify / store / ranking…)

# 6. version has been bumped (differs from the last release)
```

---

## 8. Marketplace behavior quick reference

| Capability | cordis-plugin | skill | agent-preset | script |
|---|---|---|---|---|
| One-click install | ✅ | ✅ | ✅ | ✅ (confirmation dialog) |
| Version detection / update button | ✅ (package.json version; npm type via dist-tags) | ❌ | ❌ | ❌ |
| Automatic uninstall | ✅ (remove dir + patch entry) | ✅ | ✅ | ⚠️ record only (script effects not reversible) |
| Dependency install | ✅ (scripts disabled by default, releasable on confirmation) | — | — | Script's own job |
| Build | ✅ (source-built asks for confirmation) | — | — | Script's own job |
| Safety confirmation | Dependency scripts (if any) | None | None | Third-party script risk confirmation |

---

## 9. External references (division of labor with official/community docs)

This spec only covers the **marketplace-recognition layer**: how to shape a repo so the marketplace ingests/installs/updates it correctly.
For the deeper «how to write a DSH framework plugin» (bundle manifest, patch rows, Service/client APIs), see:

- **Official**: [Publishing & installing plugins (publish.md)](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) — the two manifests (bundle/profile), load order, patch override rules (§2's `dsh.bundle.patch` derives from here)
- **Community**: [make-dsh-plugin skill](https://github.com/vlln/plugin-registry) — official bundle form selection table (`dsh.bundle`/`dsh.client`/`dsh.skills`/`dsh.mcpServers`), verification discipline, gotchas
- **Community**: [dsh-plugin-development skill](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/.dsh/skills/dsh-plugin-development/SKILL.md) — runtime-surface judgment (host/client), official template references
- **Curated list**: [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — community curation and the security disclaimer (risks of running third-party code)

*Maintainer note: this document corresponds one-to-one with `detectType` / `installRepo` in `lib/index.js`; any change to the detection logic must update this table in sync.*
