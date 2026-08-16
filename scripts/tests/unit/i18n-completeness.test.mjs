// i18n 完整性检查（机械化比对 t() 引用 vs 字典 key）：
// - lib/index.js 的 MESSAGES.zh / MESSAGES.en（服务端文案，113 处 t() 引用）
// - lib/client.js 的 DICT_ZH / DICT_EN（前端 bundle 文案）
// 缺 key 时 t() 返回裸 key 名（用户看到 "step1"）——比对防止漏文案。
// 与 coverage/mutation/property 同属「机械化质量检查」族。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lib = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
const client = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** 提取 { "key": ... } 对象块的 key 集合（锚定起止文本，避免全文件匹配误收 fetch 头等）。
 *  兼容两种形态：lib 的带引号 "key": 与 client 的裸键 key:；过滤块名自身（zh:/en:）。 */
function blockKeys(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) return new Set();
  const block = src.slice(start, end);
  const keys = new Set([...block.matchAll(/"?([a-zA-Z][a-zA-Z0-9]*)"?\s*:/g)].map((m) => m[1]));
  keys.delete("zh");
  keys.delete("en");
  return keys;
}

// ---- lib/index.js：MESSAGES.zh / MESSAGES.en / t() 引用 ----
{
  const zh = blockKeys(lib, "zh: {", "en: {");
  const en = blockKeys(lib, "en: {", "\n};");
  // 引用形态后置断言 (?=[,)])：排除动态键拼接（t("cat" + ...)）
  const used = new Set([...lib.matchAll(/t\((?:lang|langFull|langOf\(req, [^)]*\)), "([a-zA-Z][a-zA-Z0-9]*)"(?=[,)])/g)].map((m) => m[1]));
  const zhMissing = [...used].filter((k) => !zh.has(k));
  const enMissing = [...zh].filter((k) => !en.has(k));
  check("lib: zh 字典无缺失（t 引用全部有文案）", zhMissing, []);
  check("lib: en 字典覆盖 zh 全部 key", enMissing, []);
}

// ---- lib：t() 的 vars 与文案占位符一致性 ----
// t("key", { v }) 的 vars 名必须覆盖文案里的全部 {v} 占位符——缺 vars 时 {v} 原样泄漏
// 给用户（案例：noScript 文案缺 {repo} 但调用传了——用户看不到哪个仓库失败）。
// 已知限制：vars 对象含 ${...} 模板串（qManual 案例）会被 [^}]* 截断——提取不可靠，
// 宁可漏报不可误报（该调用已人工确认）。
{
  const zhBlock = lib.slice(lib.indexOf("zh: {"), lib.indexOf("en: {"));
  const zhText = new Map([...zhBlock.matchAll(/"([a-zA-Z][a-zA-Z0-9]+)":\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const bad = [];
  for (const m of lib.matchAll(/t\((?:lang|langFull|langOf\(req, [^)]*\)), "([a-zA-Z][a-zA-Z0-9]*)", \{[^}]*\}/g)) {
    const key = m[1];
    const text = zhText.get(key) ?? "";
    const placeholders = new Set([...text.matchAll(/\{([a-zA-Z0-9]+)\}/g)].map((x) => x[1]));
    const varsBlock = m[0].slice(m[0].indexOf("{") + 1, m[0].lastIndexOf("}"));
    // 兼容简写（{ bin }）/键值（{ n: x, m: y }）/多行；切片排除结尾 }——允许串尾终结符
    const vars = new Set([...varsBlock.matchAll(/([a-zA-Z0-9]+)(?=\s*(?:[:},]|$))/g)].map((x) => x[1]));
    const truncated = m[0].includes("${"); // 模板串截断：提取不可靠，跳过
    for (const v of placeholders) {
      if (!vars.has(v) && !truncated) bad.push(`${key}:{${v}}`);
    }
  }
  check("lib: 文案占位符全部有 vars 传入（不泄漏 {var} 原文）", bad, []);
}

// ---- lib/client.js：DICT_ZH / DICT_EN / t() 引用 ----
{
  const zh = blockKeys(client, "var DICT_ZH = {", "var DICT_EN = {");
  const en = blockKeys(client, "var DICT_EN = {", "\n    };");
  // client 的 t(key, vars) 单参形态（含 t("key", { ... }) 与 t("key")）；
  // 后置断言排除动态键拼接（t("cat" + category)）
  const used = new Set([...client.matchAll(/\bt\("([a-zA-Z][a-zA-Z0-9]*)"(?=[,)])/g)].map((m) => m[1]));
  const zhMissing = [...used].filter((k) => !zh.has(k));
  const enMissing = [...zh].filter((k) => !en.has(k));
  check("client: zh 字典无缺失", zhMissing, []);
  check("client: en 字典覆盖 zh 全部 key", enMissing, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
