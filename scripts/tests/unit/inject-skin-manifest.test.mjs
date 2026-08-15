// inject-skin-manifest 注入器测试：幂等注入 / 回读 / 替换 / 异常路径。

import { injectManifestIntoBundle, extractInjectedManifest } from "../../inject-skin-manifest.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

const manifest = JSON.stringify({ id: "qq98", name: "QQ2008 Retro", wiringId: "ui-skin-qq98", palette: { modes: ["light"] } });
const fakeBundle = `window.__ModuleLoader__.load({ id: "@linxin666/dsh-client-ui-skin-qq98", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	exports.apply = apply;
	return module.exports;
});`;

// 注入
const injected = injectManifestIntoBundle(fakeBundle, manifest);
check("注入非空", injected !== null, true);
check("注入保留原内容", injected.includes("exports.apply = apply;"), true);
check("注入含 manifest 导出", injected.includes("exports.manifest ="), true);
// 回读
const read = extractInjectedManifest(injected);
check("回读 id", read?.id, "qq98");
check("回读 name", read?.name, "QQ2008 Retro");
check("回读 wiringId", read?.wiringId, "ui-skin-qq98");

// 幂等：二次注入不产生重复段
const twice = injectManifestIntoBundle(injected, manifest);
check("二次注入含一个 manifest 段", (twice.match(/exports\.manifest =/g) ?? []).length, 1);
check("二次注入内容不变", twice, injected);

// 替换：新 manifest 覆盖旧
const manifest2 = JSON.stringify({ id: "qq98", name: "QQ2008 Retro v2" });
const replaced = injectManifestIntoBundle(injected, manifest2);
check("替换后回读新值", extractInjectedManifest(replaced)?.name, "QQ2008 Retro v2");

// 异常路径
check("无锚点 bundle 返回 null", injectManifestIntoBundle("no anchor here", manifest), null);
check("无 manifest 回读 null", extractInjectedManifest("nothing"), null);
check("畸形 manifest 段回读 null", extractInjectedManifest(`x exports.manifest = {broken;`), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
