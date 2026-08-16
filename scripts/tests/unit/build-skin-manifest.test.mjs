// build-skin-manifest 生成器测试：修复规则 / 组装 / 校验。
// 测试用内联 bundle 样例（不依赖真实皮肤包部署路径）。

import { applyFixups, buildManifest, buildAndValidate } from "../../build-skin-manifest.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// ---- applyFixups：fg 重绑修复规则 ----
// 亮色 fg=#fff + 浅 bg → 修复为 label-primary
const fixed = applyFixups({
  light: { "bg-base": "#ffffff", "label-primary": "#17293c", "label-primary-foreground": "#fff" },
  dark: { "bg-base": "#101c2b", "label-primary": "#d8e6f4", "label-primary-foreground": "#fff" },
});
check("亮色浅底 fg=#fff 修复为 label-primary", fixed.light["label-primary-foreground"], "#17293c");
check("暗色深底 fg=#fff 保持（正常设计）", fixed.dark["label-primary-foreground"], "#fff");
// 亮色深底（bg 亮度低）不修
const darkBg = applyFixups({
  light: { "bg-base": "#0e2f5e", "label-primary": "#dcebfa", "label-primary-foreground": "#fff" },
  dark: {},
});
check("亮色深底 fg=#fff 不修", darkBg.light["label-primary-foreground"], "#fff");
// fg 非 #fff（大写/变体）不修
const notWhite = applyFixups({
  light: { "bg-base": "#ffffff", "label-primary": "#17293c", "label-primary-foreground": "#dcebfa" },
  dark: {},
});
check("fg 非纯白不修", notWhite.light["label-primary-foreground"], "#dcebfa");
// label-primary 缺失时不修（防 undefined 覆盖）
const noPrimary = applyFixups({
  light: { "bg-base": "#ffffff", "label-primary-foreground": "#fff" },
  dark: {},
});
check("label-primary 缺失不修", noPrimary.light["label-primary-foreground"], "#fff");
// 修复不改变原对象（纯函数）
const orig = { light: { "bg-base": "#ffffff", "label-primary": "#17293c", "label-primary-foreground": "#fff" }, dark: {} };
applyFixups(orig);
check("applyFixups 纯函数不修改入参", orig.light["label-primary-foreground"], "#fff");

// ---- buildManifest：结构组装 ----
const fakeBundle = `
  var css = "body[data-dsh-retro]{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#17293c;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-label-secondary:#3d566e;--dsw-alias-label-tertiary:#5f7890;--dsw-alias-brand-primary:#2b7cd9}body[data-dsh-retro][data-ds-dark-theme]{--dsw-alias-bg-base:#101c2b;--dsw-alias-label-primary:#d8e6f4;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-label-secondary:#a9c0d8;--dsw-alias-label-tertiary:#7f9ab5;--dsw-alias-brand-primary:#6aa8f0}";
`;
const config = {
  id: "qq98",
  name: "QQ2008 Retro",
  author: "dsh-web-ui",
  accent: "#2b7cd9",
  bodyAttr: "data-dsh-retro",
  package: "@linxin666/dsh-client-ui-skin-qq98",
  order: 1,
  tags: ["retro"],
  components: { titlebar: { text: "#fff", background: "#111", ratio: 4.5 } },
  checks: [{ kind: "contrast", text: "ref:label-primary", background: "ref:bg-base", minRatio: 4.5, mode: "light" }],
};
const built = buildManifest(config, fakeBundle);
check("manifest schemaVersion", built.schemaVersion, 1);
check("manifest id/bodyAttr", [built.id, built.bodyAttr], ["qq98", "data-dsh-retro"]);
check("manifest name（UI 显示名）", built.name, "QQ2008 Retro");
check("manifest palette modes", built.palette.modes, ["light", "dark"]);
check("manifest 亮色提取 6 token", Object.keys(built.palette.light).length, 6);
check("manifest 暗色提取 6 token", Object.keys(built.palette.dark).length, 6);
check("manifest 亮色 fg 自动修复", built.palette.light["label-primary-foreground"], "#17293c");
check("manifest 暗色 fg 保持", built.palette.dark["label-primary-foreground"], "#fff");
check("manifest components 透传", built.components.titlebar.ratio, 4.5);
check("manifest checks 透传", built.checks.length, 1);

// ---- buildAndValidate：生成 + 校验 ----
const { manifest, result } = buildAndValidate(config, fakeBundle);
check("buildAndValidate ok", result.ok, true);
check("buildAndValidate 无 errors", result.errors.length, 0);
check("buildAndValidate manifest 可用", manifest.id, "qq98");

// 缺必选 token 的 bundle → 校验失败（生成器忠实暴露）
const brokenBundle = `var css = "body[data-dsh-retro]{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#17293c}";`;
const broken = buildAndValidate(config, brokenBundle);
check("缺 token bundle 校验失败", broken.result.ok, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
