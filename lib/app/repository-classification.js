const TYPE_REASONS = Object.freeze({
  presetRoot: { type: "agent-preset", reasonKey: "detectReason.presetRoot", hintKey: "detectHint.preset" },
  bundleDeclared: { type: "bundle", reasonKey: "detectReason.bundleDeclared", hintKey: "detectHint.bundle" },
  dshDeclared: { type: "cordis-plugin", reasonKey: "detectReason.dshDeclared", hintKey: "detectHint.dshDeclared" },
  ps1: { type: "script", reasonKey: "detectReason.ps1", hintKey: "detectHint.script" },
  sh: { type: "script", reasonKey: "detectReason.sh", hintKey: "detectHint.script" },
  nestedPreset: { type: "agent-preset", reasonKey: "detectReason.nestedPreset", hintKey: "detectHint.preset" },
  pkgSkillRoot: { type: "skill", reasonKey: "detectReason.pkgSkillRoot", hintKey: "detectHint.skill" },
  pkgOnly: { type: "cordis-plugin", reasonKey: "detectReason.pkgOnly", hintKey: "detectHint.pkgOnly" },
  skillRoot: { type: "skill", reasonKey: "detectReason.skillRoot", hintKey: "detectHint.skill" },
  nestedPlugin: { type: "cordis-plugin", reasonKey: "detectReason.nestedPlugin", hintKey: "detectHint.nestedPlugin" },
  nestedSkill: { type: "skill", reasonKey: "detectReason.nestedSkill", hintKey: "detectHint.skill" },
  none: { type: "instructions", reasonKey: "detectReason.none", hintKey: "detectHint.none" },
});

function resultFor(reason) {
  return { ...TYPE_REASONS[reason] };
}

export function createRepositoryClassification({
  exists,
  joinPath,
  readPackageJsonObject,
  findPresetRoots,
  findSkillRoots,
  findPluginRoots,
  looksLikeDshPlugin,
  isBundlePackage,
}) {
  async function detectTypeDetail(cacheDir) {
    const has = (relative) => exists(joinPath(cacheDir, relative));

    if (await has("preset.yml") && await has("agent.cordis.yml")) {
      return resultFor("presetRoot");
    }

    const rootPackage = await has("package.json") ? await readPackageJsonObject(cacheDir) : null;
    if (rootPackage && await looksLikeDshPlugin(rootPackage) === true) {
      return resultFor(isBundlePackage(rootPackage) ? "bundleDeclared" : "dshDeclared");
    }

    if (await has("install.ps1")) return resultFor("ps1");
    if (await has("install.sh")) return resultFor("sh");

    if ((await findPresetRoots(cacheDir)).length > 0) {
      return resultFor("nestedPreset");
    }

    if (await has("package.json")) {
      if ((await findSkillRoots(cacheDir, 0, 1)).length > 0) {
        return resultFor("pkgSkillRoot");
      }
      return resultFor("pkgOnly");
    }

    if ((await findSkillRoots(cacheDir, 0, 1)).length > 0) {
      return resultFor("skillRoot");
    }
    if ((await findPluginRoots(cacheDir)).length > 0) {
      return resultFor("nestedPlugin");
    }
    if ((await findSkillRoots(cacheDir, 5, 1)).length > 0) {
      return resultFor("nestedSkill");
    }
    return resultFor("none");
  }

  async function detectType(cacheDir) {
    return (await detectTypeDetail(cacheDir)).type;
  }

  return { detectTypeDetail, detectType };
}
