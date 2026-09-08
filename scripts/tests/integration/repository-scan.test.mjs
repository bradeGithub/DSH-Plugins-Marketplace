import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositoryScanAdapter } from "../../../lib/infra/repository-scan.js";

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

const root = await mkdtemp(join(tmpdir(), "dsh-repository-scan-"));
const pluginPackage = JSON.stringify({
  name: "demo-plugin",
  version: "1.0.0",
  dsh: { client: {} },
});
try {
  await mkdir(join(root, "skills", "one"), { recursive: true });
  await mkdir(join(root, "skills", "two", "deep"), { recursive: true });
  await mkdir(join(root, "upstream", "ignored"), { recursive: true });
  await mkdir(join(root, ".hidden", "ignored"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "skills", "one", "SKILL.md"), "# one\n", "utf8");
  await writeFile(join(root, "skills", "two", "deep", "skill.md"), "# two\n", "utf8");
  await writeFile(join(root, "upstream", "ignored", "SKILL.md"), "# ignored\n", "utf8");
  await writeFile(join(root, ".hidden", "ignored", "SKILL.md"), "# ignored\n", "utf8");
  await writeFile(join(root, "node_modules", "ignored", "SKILL.md"), "# ignored\n", "utf8");

  await mkdir(join(root, "packages", "a", "nested"), { recursive: true });
  await mkdir(join(root, "packages", "b"), { recursive: true });
  await mkdir(join(root, "plain", "child"), { recursive: true });
  await writeFile(join(root, "packages", "a", "package.json"), pluginPackage, "utf8");
  await writeFile(join(root, "packages", "a", "nested", "package.json"), pluginPackage, "utf8");
  await writeFile(join(root, "packages", "b", "package.json"), pluginPackage, "utf8");
  await writeFile(join(root, "plain", "package.json"), JSON.stringify({ name: "plain" }), "utf8");
  await writeFile(join(root, "plain", "child", "package.json"), pluginPackage, "utf8");
  await writeFile(join(root, ".hidden", "ignored", "package.json"), pluginPackage, "utf8");
  await writeFile(join(root, "node_modules", "ignored", "package.json"), pluginPackage, "utf8");

  await mkdir(join(root, "presets", "one", "nested"), { recursive: true });
  await mkdir(join(root, "presets", "two"), { recursive: true });
  await mkdir(join(root, "presets", "partial", "child"), { recursive: true });
  await writeFile(join(root, "presets", "one", "preset.yml"), "one\n", "utf8");
  await writeFile(join(root, "presets", "one", "agent.cordis.yml"), "one\n", "utf8");
  await writeFile(join(root, "presets", "one", "nested", "preset.yml"), "nested\n", "utf8");
  await writeFile(join(root, "presets", "one", "nested", "agent.cordis.yml"), "nested\n", "utf8");
  await writeFile(join(root, "presets", "two", "preset.yml"), "two\n", "utf8");
  await writeFile(join(root, "presets", "partial", "preset.yml"), "partial\n", "utf8");
  await writeFile(join(root, "presets", "partial", "child", "preset.yml"), "child\n", "utf8");
  await writeFile(join(root, "presets", "partial", "child", "agent.cordis.yml"), "child\n", "utf8");

  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts: {
      prepare: "prepare",
      postinstall: "postinstall",
      install: "install",
      preinstall: "preinstall",
      test: "test",
    },
  }), "utf8");

  const adapter = createRepositoryScanAdapter({
    fs: { readdir, readFile },
    path: { joinPath: join },
    looksLikeDshPlugin: (pkg) => pkg?.dsh?.client ? true : false,
  });

  const skillRoots = (await adapter.findSkillRoots(root)).sort();
  check("真实目录 skill 根和嵌套根", skillRoots, [
    join(root, "skills", "one"),
    join(root, "skills", "two", "deep"),
  ].sort());
  check("真实目录 skill manifest 内容", await adapter.readSkillManifest(join(root, "skills", "two", "deep")), "# two\n");

  const pluginRoots = (await adapter.findPluginRoots(root)).sort();
  check("真实目录 plugin 根", pluginRoots, [
    join(root, "packages", "a"),
    join(root, "packages", "b"),
    join(root, "plain", "child"),
  ].sort());

  const presetRoots = (await adapter.findPresetRoots(root)).sort();
  check("真实目录 preset 根", presetRoots, [
    join(root, "presets", "one"),
    join(root, "presets", "partial", "child"),
  ].sort());
  check("真实目录 preset 根命中后停止向下", presetRoots.includes(join(root, "presets", "one", "nested")), false);

  check("真实 package lifecycle 固定顺序", await adapter.readLifecycleScripts(root), [
    "preinstall", "install", "postinstall", "prepare",
  ]);
  await mkdir(join(root, "invalid-lifecycle"), { recursive: true });
  await writeFile(join(root, "invalid-lifecycle", "package.json"), JSON.stringify({
    scripts: { preinstall: "", install: 42, postinstall: "postinstall", prepare: null },
  }), "utf8");
  check("真实 package 非法脚本类型和空值过滤", await adapter.readLifecycleScripts(join(root, "invalid-lifecycle")), [
    "postinstall",
  ]);
  check("缺失 package lifecycle 返回空", await adapter.readLifecycleScripts(join(root, "missing")), []);
  await mkdir(join(root, "malformed-lifecycle"), { recursive: true });
  await writeFile(join(root, "malformed-lifecycle", "package.json"), "{bad", "utf8");
  check("坏 package lifecycle 返回空", await adapter.readLifecycleScripts(join(root, "malformed-lifecycle")), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
