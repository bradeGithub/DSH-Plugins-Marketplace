// 验证徽章盖章纯函数测试（discussion #2269 对接契约：qing3a/dsh-plugin-verify）。
// 覆盖：fullName 优先 / repo URL 回退 / schemaVersion fail-closed / 盖章与旧字段清除。
import { parseVerificationFullName, parseVerificationData, applyVerification } from "../../build-registry.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- parseVerificationFullName ----
check("fullName 字段优先", parseVerificationFullName({ fullName: "vlln/dsh-navbar", repo: "https://github.com/other/x" }), "vlln/dsh-navbar");
check("fullName 缺斜杠视为无效 → 回退 repo URL", parseVerificationFullName({ fullName: "dsh-navbar", repo: "https://github.com/vlln/dsh-navbar" }), "vlln/dsh-navbar");
check("repo URL 回退解析", parseVerificationFullName({ repo: "https://github.com/TwotwoPiggy/dsh-balance" }), "TwotwoPiggy/dsh-balance");
check("repo URL 去 .git / 尾部斜杠", parseVerificationFullName({ repo: "https://github.com/a/b.git/" }), "a/b");
check("两者皆缺返回空串", parseVerificationFullName({}), "");

// ---- parseVerificationData ----
const VALID = {
  schemaVersion: 1,
  generatedAt: "2026-08-16T07:23:10.866Z",
  plugins: [
    { name: "dsh-balance", repo: "https://github.com/TwotwoPiggy/dsh-balance", verifiedBy: "dsh-plugin-verify@0.1.2", verifiedAt: "2026-08-14", reportUrl: "https://github.com/qing3a/dsh-plugin-verify/blob/main/reports/balance-2026-08-14.json", waterfall: "7/7", toolsResult: true },
    { name: "dsh-navbar", fullName: "vlln/dsh-navbar", repo: "https://github.com/other/wrong", verifiedBy: "dsh-plugin-verify", verifiedAt: "2026-08-15T18:44:53Z", reportUrl: "https://github.com/qing3a/dsh-plugin-verify/blob/main/reports/navbar-2026-08-16.json" }
  ]
};
const m1 = parseVerificationData(VALID);
check("schemaVersion=1 解析为 Map", m1 instanceof Map && m1.size, 2);
const balance = m1.get("twotwopiggy/dsh-balance");
check("URL 回退条目盖章（小写键）", balance && [balance.verdict, balance.verifiedBy, balance.waterfall, balance.toolsResult],
  ["pass", "dsh-plugin-verify@0.1.2", "7/7", true]);
check("fullName 优先条目（repo 误导时不误匹配）", m1.has("vlln/dsh-navbar") && !m1.has("other/wrong"), true);
check("schemaVersion 不符 → null（fail-closed）", parseVerificationData({ schemaVersion: 2, plugins: [] }), null);
check("非法入参 → null", parseVerificationData(null), null);
check("plugins 缺失 → 空 Map", parseVerificationData({ schemaVersion: 1 }) instanceof Map, true);

// ---- applyVerification ----
const repos = [
  { full_name: "TwotwoPiggy/dsh-balance" },
  { full_name: "VLLN/dsh-navbar" }, // 大小写不敏感命中
  { full_name: "unverified/x", verdict: "pass", verifiedBy: "old", reportUrl: "stale", schemaVersion: 1, waterfall: "1/7", toolsResult: false } // 旧字段应清除
];
applyVerification(repos, m1);
check("命中条目平铺盖章", repos[0], {
  full_name: "TwotwoPiggy/dsh-balance",
  verdict: "pass", verifiedBy: "dsh-plugin-verify@0.1.2", verifiedAt: "2026-08-14",
  reportUrl: "https://github.com/qing3a/dsh-plugin-verify/blob/main/reports/balance-2026-08-14.json",
  schemaVersion: 1, waterfall: "7/7", toolsResult: true
});
check("大小写不敏感命中", repos[1].reportUrl, "https://github.com/qing3a/dsh-plugin-verify/blob/main/reports/navbar-2026-08-16.json");
check("未命中条目旧字段全清除", repos[2], { full_name: "unverified/x" });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
