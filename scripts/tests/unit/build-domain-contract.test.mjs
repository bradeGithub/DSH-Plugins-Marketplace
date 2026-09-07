import { normalizeRegistryRepo } from "../../../lib/domain/normalize.js";
import { hasDshPluginDeclaration, isBundlePackage } from "../../../lib/domain/validation.js";
import {
  normalize,
  looksLikeDshPlugin,
  isBundlePackage as buildIsBundlePackage
} from "../../build-registry.mjs";

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

const fullRepo = {
  full_name: "owner/repo",
  name: "repo",
  description: "A plugin",
  html_url: "https://github.com/owner/repo",
  stargazers_count: 42,
  updated_at: "2026-09-01T00:00:00Z",
  default_branch: "trunk",
  topics: ["dsh-plugin", "tool"],
  license: { spdx_id: "MIT" },
  fork: true,
  archived: false
};
const expectedFullRepo = {
  full_name: "owner/repo",
  name: "repo",
  description: "A plugin",
  html_url: "https://github.com/owner/repo",
  stargazers_count: 42,
  updated_at: "2026-09-01T00:00:00Z",
  default_branch: "trunk",
  topics: ["dsh-plugin", "tool"],
  license: "MIT",
  fork: true,
  archived: false
};

check("registry 投影完整字段保持旧语义", normalizeRegistryRepo(fullRepo), expectedFullRepo);
check("build normalize 与 domain 投影相同", normalize(fullRepo), expectedFullRepo);
check("registry 投影保留 html_url 原值", normalizeRegistryRepo({ html_url: "https://example.invalid/a" }).html_url, "https://example.invalid/a");
check("registry 投影缺省可选字段", normalizeRegistryRepo({ full_name: "a/b", name: "b" }), {
  full_name: "a/b",
  name: "b",
  description: undefined,
  html_url: undefined,
  stargazers_count: undefined,
  updated_at: undefined,
  default_branch: "main",
  topics: [],
  license: null,
  fork: false,
  archived: false
});

const pluginWithDsh = { dsh: { client: {} } };
const pluginWithCoreDep = { dependencies: { "@deepseek-ai/dsh-client-runtime": "^1" } };
const pluginWithNearMissDep = { dependencies: { "@deepseek-ai/dshx": "^1" } };
const plainPackage = { dependencies: { react: "^18" } };
check("domain DSH 声明字段", hasDshPluginDeclaration(pluginWithDsh), true);
check("domain 非对象 dsh 不认作声明", hasDshPluginDeclaration({ dsh: "client" }), false);
check("domain DSH 核心依赖", hasDshPluginDeclaration(pluginWithCoreDep), true);
check("domain 相近但非法依赖名", hasDshPluginDeclaration(pluginWithNearMissDep), false);
check("domain 普通包", hasDshPluginDeclaration(plainPackage), false);
check("domain 非对象", hasDshPluginDeclaration(null), false);
check("build DSH 声明复用 domain", looksLikeDshPlugin(pluginWithDsh), true);
check("build 普通包复用 domain", looksLikeDshPlugin(plainPackage), false);
check("build 非对象保持 false", looksLikeDshPlugin(null), false);

const bundle = { dsh: { bundle: { patch: "./cordis.patch.yml" } } };
check("domain bundle 判定", isBundlePackage(bundle), true);
check("build bundle 判定复用 domain", buildIsBundlePackage(bundle), true);
check("bundle 空 patch 不是 bundle", isBundlePackage({ dsh: { bundle: { patch: "" } } }), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
