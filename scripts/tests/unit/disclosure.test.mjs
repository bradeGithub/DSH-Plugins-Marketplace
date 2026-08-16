// 披露徽章盖章纯函数测试（discussion #2269 合规层对接：wwumit/skills-catalog 开放数据层）。
// 覆盖：fullName 映射 / disclosureSchemaVersion fail-closed / 缺字段条目跳过 / 盖章与旧字段清除。
import { parseDisclosureData, applyDisclosure } from "../../build-registry.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const VALID = {
  schemaVersion: 1,
  disclosureSchemaVersion: "0.2",
  updatedAt: "2026-08-16T12:20:28.241Z",
  skills: [
    {
      name: "ccpa-check",
      fullName: "wwumit/skills-compliance-intl",
      disclosure: {
        cloud: true,
        network: ["https://compliancehub.cn"],
        offlineMode: true,
        apiKeys: [{ env: "COMPLIANCEHUB_API_KEY", storage: "file-0600" }],
        jurisdiction: ["US-CA"],
        retention: "session"
      }
    },
    {
      name: "backtest-analyzer",
      fullName: "wwumit/skills-stock",
      disclosure: { cloud: false, network: [], offlineMode: true, apiKeys: [], jurisdiction: [], retention: "none" }
    },
    { name: "no-fullname", disclosure: { cloud: false } },
    { name: "no-disclosure", fullName: "wwumit/some-repo" }
  ]
};

const m1 = parseDisclosureData(VALID);
check("schemaVersion=1 + disclosureSchemaVersion=0.2 解析为 Map", m1 instanceof Map && m1.size, 2);
check("disclosure 对象盖章（小写键）", m1.get("wwumit/skills-compliance-intl")?.disclosure.cloud, true);
check("缺 fullName / 缺 disclosure 的条目跳过", m1.has("wwumit/some-repo"), false);

// 同仓多技能 disclosure 不同 → cloud:true 优先（fail-safe 警示从严，compliance-intl 案例）
const MIXED = {
  schemaVersion: 1,
  disclosureSchemaVersion: "0.2",
  skills: [
    { name: "local-a", fullName: "mix/repo", disclosure: { cloud: false, network: [], apiKeys: [], jurisdiction: [], retention: "none" } },
    { name: "cloud-a", fullName: "mix/repo", disclosure: { cloud: true, network: ["https://x.cn"], apiKeys: [{ env: "K", storage: "file-0600" }], jurisdiction: ["US-CA"], retention: "session" } },
    { name: "local-b", fullName: "mix/repo", disclosure: { cloud: false, network: [], apiKeys: [], jurisdiction: [], retention: "none" } }
  ]
};
const mixed = parseDisclosureData(MIXED);
check("同仓混合披露 → cloud:true 优先", mixed.get("mix/repo")?.disclosure.cloud, true);
check("cloud:true 条目不被后续 cloud:false 覆盖", mixed.get("mix/repo")?.disclosure.network[0], "https://x.cn");

// 双颗粒度形态（wwumit 新增 repos[].cloudSkills）：仓级 cloud 由 cloudSkills 定，
// 云端技能详情从 skills 聚合合并（端点/凭据去重，不丢任一云端技能）
const DUAL = {
  schemaVersion: 1,
  disclosureSchemaVersion: "0.2",
  skills: [
    { name: "ccpa-check", fullName: "wwumit/skills-compliance-intl", disclosure: { cloud: true, network: ["https://compliancehub.cn"], offlineMode: true, apiKeys: [{ env: "COMPLIANCEHUB_API_KEY", storage: "file-0600" }], jurisdiction: ["US-CA"], retention: "session" } },
    { name: "gdpr-check", fullName: "wwumit/skills-compliance-intl", disclosure: { cloud: true, network: ["https://compliancehub.cn", "https://gdpr.cn"], offlineMode: false, apiKeys: [{ env: "GDPR_API_KEY", storage: "file-0600" }], jurisdiction: ["EU"], retention: "server" } },
    { name: "local-guard", fullName: "wwumit/skills-compliance-intl", disclosure: { cloud: false, network: [], offlineMode: true, apiKeys: [], jurisdiction: [], retention: "none" } },
    { name: "stock-a", fullName: "wwumit/skills-stock", disclosure: { cloud: false, network: [], offlineMode: true, apiKeys: [], jurisdiction: [], retention: "none" } }
  ],
  repos: [
    { fullName: "wwumit/skills-compliance-intl", skillCount: 3, cloudSkills: ["ccpa-check", "gdpr-check"] },
    { fullName: "wwumit/skills-stock", skillCount: 1, cloudSkills: [] }
  ]
};
const dual = parseDisclosureData(DUAL);
check("双颗粒度：云端仓 cloud=true", dual.get("wwumit/skills-compliance-intl")?.disclosure.cloud, true);
check("双颗粒度：云端技能端点合并去重", dual.get("wwumit/skills-compliance-intl")?.disclosure.network,
  ["https://compliancehub.cn", "https://gdpr.cn"]);
check("双颗粒度：云端技能凭据合并", dual.get("wwumit/skills-compliance-intl")?.disclosure.apiKeys.length, 2);
check("双颗粒度：retention 取最严（server）", dual.get("wwumit/skills-compliance-intl")?.disclosure.retention, "server");
check("双颗粒度：offlineMode 任一 false → false", dual.get("wwumit/skills-compliance-intl")?.disclosure.offlineMode, false);
check("双颗粒度：本地仓 cloud=false", dual.get("wwumit/skills-stock")?.disclosure.cloud, false);
check("disclosureSchemaVersion 不符 → null（fail-closed）",
  parseDisclosureData({ schemaVersion: 1, disclosureSchemaVersion: "0.3", skills: [] }), null);
check("schemaVersion 不符 → null",
  parseDisclosureData({ schemaVersion: 2, disclosureSchemaVersion: "0.2", skills: [] }), null);
check("数值形态 0.2 兼容", parseDisclosureData({ schemaVersion: 1, disclosureSchemaVersion: 0.2, skills: [] }) instanceof Map, true);
check("非法入参 → null", parseDisclosureData(null), null);

const repos = [
  { full_name: "wwumit/skills-compliance-intl" },
  { full_name: "WWUMIT/skills-stock" }, // 大小写不敏感
  { full_name: "other/repo", disclosure: { cloud: false }, disclosureSchemaVersion: "0.2" } // 旧字段应清除
];
applyDisclosure(repos, m1);
check("命中条目平铺盖章", repos[0].disclosure.cloud, true);
check("命中条目带版本", repos[0].disclosureSchemaVersion, "0.2");
check("大小写不敏感命中", repos[1].disclosure.cloud, false);
check("未命中条目旧字段全清除", repos[2].disclosure === undefined && repos[2].disclosureSchemaVersion === undefined, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
