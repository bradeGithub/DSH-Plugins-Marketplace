import assert from "node:assert/strict";
import { createRepositoryClassification } from "../../../lib/app/repository-classification.js";

let pass = 0;
let fail = 0;
async function test(name, run) {
  try {
    await run();
    pass++;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}

function fixture({ files = [], pkg = null, declared = false, bundle = false, rootSkill = false,
  presets = [], plugins = [], nestedSkills = [] } = {}, overrides = {}) {
  const present = new Set(files);
  const calls = [];
  const deps = {
    exists: async (path) => {
      calls.push(["exists", path]);
      return present.has(path.slice("/cache/".length));
    },
    joinPath: (...parts) => parts.join("/"),
    readPackageJsonObject: async (dir) => {
      calls.push(["package", dir]);
      return pkg;
    },
    looksLikeDshPlugin: async (value) => {
      calls.push(["declared", value]);
      return declared;
    },
    isBundlePackage: (value) => {
      calls.push(["bundle", value]);
      return bundle;
    },
    findPresetRoots: async (...args) => {
      calls.push(["preset", ...args]);
      return presets;
    },
    findSkillRoots: async (...args) => {
      calls.push(["skill", ...args]);
      return args[1] === 0 ? (rootSkill ? [args[0]] : []) : nestedSkills;
    },
    findPluginRoots: async (...args) => {
      calls.push(["plugin", ...args]);
      return plugins;
    },
    ...overrides,
  };
  return { classifier: createRepositoryClassification(deps), calls, present };
}

const cases = [
  ["根预设压过声明、脚本及技能", {
    files: ["preset.yml", "agent.cordis.yml", "package.json", "install.ps1"],
    pkg: {}, declared: true, bundle: true, rootSkill: true,
  }, ["agent-preset", "presetRoot", "preset"]],
  ["bundle 声明压过脚本和嵌套预设", {
    files: ["package.json", "install.ps1"], pkg: {}, declared: true, bundle: true, presets: ["nested"],
  }, ["bundle", "bundleDeclared", "bundle"]],
  ["DSH 声明压过根脚本和根技能", {
    files: ["package.json", "install.sh"], pkg: {}, declared: true, rootSkill: true,
  }, ["cordis-plugin", "dshDeclared", "dshDeclared"]],
  ["双脚本优先 ps1 且压过嵌套预设", {
    files: ["install.ps1", "install.sh"], presets: ["nested"],
  }, ["script", "ps1", "script"]],
  ["只有 sh 的根脚本", { files: ["install.sh"] }, ["script", "sh", "script"]],
  ["预设缺少配对文件不能抢占根脚本", {
    files: ["preset.yml", "install.sh"],
  }, ["script", "sh", "script"]],
  ["嵌套预设压过普通根包和根技能", {
    files: ["package.json"], pkg: {}, rootSkill: true, presets: ["nested"], plugins: ["plugin"],
  }, ["agent-preset", "nestedPreset", "preset"]],
  ["工具链根包与根技能", {
    files: ["package.json"], pkg: {}, rootSkill: true,
  }, ["skill", "pkgSkillRoot", "skill"]],
  ["普通根包不得借嵌套技能或插件绕过确认", {
    files: ["package.json"], pkg: {}, plugins: ["plugin"], nestedSkills: ["skill"],
  }, ["cordis-plugin", "pkgOnly", "pkgOnly"]],
  ["损坏清单仍保留 package-only 分支", {
    files: ["package.json"], pkg: null,
  }, ["cordis-plugin", "pkgOnly", "pkgOnly"]],
  ["损坏清单不阻止根技能识别", {
    files: ["package.json"], pkg: null, rootSkill: true,
  }, ["skill", "pkgSkillRoot", "skill"]],
  ["声明判定必须严格 true", {
    files: ["package.json", "install.sh"], pkg: {}, declared: 1, bundle: true,
  }, ["script", "sh", "script"]],
  ["无根包时根技能压过嵌套插件", {
    rootSkill: true, plugins: ["plugin"], nestedSkills: ["skill"],
  }, ["skill", "skillRoot", "skill"]],
  ["无根包时嵌套插件压过嵌套技能", {
    plugins: ["plugin"], nestedSkills: ["skill"],
  }, ["cordis-plugin", "nestedPlugin", "nestedPlugin"]],
  ["仅嵌套技能集合", { nestedSkills: ["skill"] }, ["skill", "nestedSkill", "skill"]],
  ["没有特征只提供手动说明", {}, ["instructions", "none", "none"]],
];

for (const [name, input, [type, reason, hint]] of cases) {
  await test(name, async () => {
    const { classifier } = fixture(input);
    const detail = await classifier.detectTypeDetail("/cache");
    assert.deepEqual(detail, { type, reasonKey: `detectReason.${reason}`, hintKey: `detectHint.${hint}` });
    assert.equal(await classifier.detectType("/cache"), type);
  });
}

await test("根预设命中不读取清单或扫描目录", async () => {
  const { classifier, calls } = fixture({ files: ["preset.yml", "agent.cordis.yml"] });
  await classifier.detectTypeDetail("/cache");
  assert.deepEqual(calls, [["exists", "/cache/preset.yml"], ["exists", "/cache/agent.cordis.yml"]]);
});

await test("声明命中不探测脚本或扫描目录", async () => {
  const pkg = { name: "demo" };
  const { classifier, calls } = fixture({ files: ["package.json"], pkg, declared: true });
  await classifier.detectTypeDetail("/cache");
  assert.deepEqual(calls, [
    ["exists", "/cache/preset.yml"], ["exists", "/cache/package.json"],
    ["package", "/cache"], ["declared", pkg], ["bundle", pkg],
  ]);
});

await test("脚本命中不启动嵌套扫描", async () => {
  const { classifier, calls } = fixture({ files: ["install.ps1"] });
  await classifier.detectTypeDetail("/cache");
  assert.equal(calls.some(([kind]) => ["preset", "skill", "plugin"].includes(kind)), false);
});

await test("根技能与深层技能使用不同扫描预算", async () => {
  const { classifier, calls } = fixture();
  await classifier.detectTypeDetail("/cache");
  assert.deepEqual(calls.filter(([kind]) => ["preset", "skill", "plugin"].includes(kind)), [
    ["preset", "/cache"], ["skill", "/cache", 0, 1], ["plugin", "/cache"], ["skill", "/cache", 5, 1],
  ]);
});

await test("普通根包只查根技能而不继续扫描子插件", async () => {
  const { classifier, calls } = fixture({ files: ["package.json"], pkg: {} });
  await classifier.detectTypeDetail("/cache");
  assert.deepEqual(calls.filter(([kind]) => ["skill", "plugin"].includes(kind)), [["skill", "/cache", 0, 1]]);
});

await test("嵌套扫描后重新观察根清单存在性", async () => {
  let present = false;
  const { classifier } = fixture({}, {
    exists: async (path) => path === "/cache/package.json" && present,
    findPresetRoots: async () => { present = true; return []; },
  });
  assert.deepEqual(await classifier.detectTypeDetail("/cache"), {
    type: "cordis-plugin", reasonKey: "detectReason.pkgOnly", hintKey: "detectHint.pkgOnly",
  });
});

await test("分类结果不跨调用缓存或共享可变对象", async () => {
  const { classifier, present } = fixture();
  const first = await classifier.detectTypeDetail("/cache");
  first.type = "corrupted";
  assert.equal(await classifier.detectType("/cache"), "instructions");
  present.add("install.sh");
  assert.equal(await classifier.detectType("/cache"), "script");
});

for (const capability of ["exists", "readPackageJsonObject", "findPresetRoots", "findSkillRoots", "findPluginRoots"]) {
  await test(`${capability} 未处理的能力错误不被分类器吞掉`, async () => {
    const error = new Error(`${capability} failed`);
    const input = capability === "readPackageJsonObject" ? { files: ["package.json"] } : {};
    const { classifier } = fixture(input, { [capability]: async () => { throw error; } });
    await assert.rejects(classifier.detectTypeDetail("/cache"), (actual) => actual === error);
  });
}

console.log(`\napp-repository-classification: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
