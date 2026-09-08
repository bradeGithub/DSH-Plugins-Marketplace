// client 列表消费纯函数行为测试：eval 05a-logic.fragment 直接测纯函数。
// 覆盖：fingerprintOf（fp 优先 / 无 fp 回退）、filterRepos（分类+搜索）、
// appendSkillsPage（第 1 页替换 / 后续页跨页去重）、shouldLoadMore（触底门控）。
// 与 browser E2E（壳行为）互补——本文件测的是内层消费逻辑本身，不依赖浏览器。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fragment = readFileSync(join(ROOT, "lib", "client-src", "05a-logic.fragment"), "utf8");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fragment, sandbox, { filename: "05a-logic.fragment" });
const { fingerprintOf, filterRepos, appendSkillsPage, shouldLoadMore } = sandbox;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
  if (ok) console.log(`PASS ${name}`);
}

// ---- fingerprintOf：服务端 fp 优先 ----
check("fingerprintOf 优先服务端 fp", fingerprintOf({ fp: "abc", source: "search", total: 3 }), "abc");
check("fingerprintOf 无 fp 回退 source+cached_at+total", fingerprintOf({ source: "cache", cached_at: "t1", total: 2 }), JSON.stringify(["cache", "t1", 2]));
check("fingerprintOf 缺字段回退空值", fingerprintOf({}), JSON.stringify(["", "", 0]));
check("fingerprintOf 非字符串 fp 走回退", fingerprintOf({ fp: 123, source: "s", total: 1 }), JSON.stringify(["s", "", 1]));

// ---- filterRepos：分类 + 搜索 ----
const repos = [
  { name: "pdf", full_name: "a/pdf", category: "document", topics: ["pdf", "doc"] },
  { name: "image", full_name: "b/image", category: "vision", topics: ["img"] },
  { name: "pdf-tool", full_name: "c/pdf-tool", category: "tool", topics: ["pdf"] }
];
check("filterRepos 全量", filterRepos(repos, "", "all").length, 3);
check("filterRepos 分类过滤", filterRepos(repos, "", "vision").map((r) => r.name), ["image"]);
check("filterRepos 搜索命中 name", filterRepos(repos, "pdf", "all").map((r) => r.name), ["pdf", "pdf-tool"]);
check("filterRepos 搜索命中 full_name", filterRepos(repos, "b/image", "all").map((r) => r.name), ["image"]);
check("filterRepos 搜索命中 topics", filterRepos(repos, "doc", "all").map((r) => r.name), ["pdf"]);
check("filterRepos 分类+搜索叠加", filterRepos(repos, "pdf", "tool").map((r) => r.name), ["pdf-tool"]);
check("filterRepos 大小写不敏感", filterRepos(repos, "PDF", "all").length, 2);
check("filterRepos 空结果", filterRepos(repos, "zzz", "all").length, 0);
check("filterRepos 缺 topics 不崩", filterRepos([{ name: "x", full_name: "a/x", category: "other" }], "x", "all").length, 1);

// ---- appendSkillsPage：第 1 页替换 / 后续页跨页去重 ----
const p1 = [
  { full_name: "o/s1", name: "s1" },
  { full_name: "o/s2", name: "s2" }
];
const p2 = [
  { full_name: "o/s2", name: "s2" }, // 与第 1 页重复 → 去重
  { full_name: "o/s3", name: "s3" }
];
check("appendSkillsPage 第 1 页直接替换", appendSkillsPage(null, 1, p1).map((r) => r.full_name), ["o/s1", "o/s2"]);
check("appendSkillsPage 第 1 页替换旧数据", appendSkillsPage([{ full_name: "old" }], 1, p1).length, 2);
check("appendSkillsPage 后续页跨页去重", appendSkillsPage(p1, 2, p2).map((r) => r.full_name), ["o/s1", "o/s2", "o/s3"]);
check("appendSkillsPage 后续页保留顺序", appendSkillsPage(p1, 2, p2).length, 3);
check("appendSkillsPage 空数据不追加", appendSkillsPage(p1, 2, []).length, 2);
check("appendSkillsPage 缺 repos 不崩", appendSkillsPage(p1, 2, undefined).length, 2);

// ---- shouldLoadMore：触底门控 ----
check("shouldLoadMore 未加载完且非加载中 → true", shouldLoadMore([1, 2], 5, false), true);
check("shouldLoadMore 已加载完 → false", shouldLoadMore([1, 2, 3, 4, 5], 5, false), false);
check("shouldLoadMore 加载中 → false", shouldLoadMore([1, 2], 5, true), false);
check("shouldLoadMore repos 为空 → false", shouldLoadMore(null, 5, false), false);
check("shouldLoadMore repos 空数组但 total>0 → true（第 1 页空则继续加载）", shouldLoadMore([], 5, false), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
