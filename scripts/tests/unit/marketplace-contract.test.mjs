import {
  MARKETPLACE_RESPONSE_SCHEMA_VERSION,
  withMarketplaceResponseSchema
} from "../../../lib/http/marketplace-contract.js";
import {
  MARKETPLACE_CONTRACTS,
  MARKETPLACE_STATUSES,
  createMarketplaceFixtures,
  forwardMarketplacePayload,
  inspectMarketplacePayload,
  legacyMarketplacePayload,
  projectMarketplacePayload
} from "../contracts/marketplace.mjs";

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

check("marketplace 响应 schemaVersion 为稳定版本 1", MARKETPLACE_RESPONSE_SCHEMA_VERSION, 1);
const versioned = withMarketplaceResponseSchema({ status: "done", futureField: true });
check("生产响应附加 schemaVersion 且保留未知字段", versioned, {
  status: "done",
  futureField: true,
  schemaVersion: 1
});
const legacyPayload = { status: "done" };
withMarketplaceResponseSchema(legacyPayload);
check("生产响应版本化不修改输入", Object.hasOwn(legacyPayload, "schemaVersion"), false);
check("已有 schemaVersion 被当前 producer 规范化", withMarketplaceResponseSchema({ schemaVersion: 99 }).schemaVersion, 1);
check("非对象响应保持原值", withMarketplaceResponseSchema(["legacy"]), ["legacy"]);

const fixtures = createMarketplaceFixtures();
const samples = {
  list: fixtures.list,
  skills: fixtures.skills,
  profile: fixtures.profile,
  install: fixtures.installAwaiting,
  feedbackPending: fixtures.feedbackPending,
  feedbackToken: fixtures.feedbackToken,
  envKeys: fixtures.envKeys,
  backup: fixtures.backup,
  restoreDiff: fixtures.restoreDiff,
  logs: fixtures.logs,
  selfUpdate: fixtures.selfUpdate,
  checkUpdate: fixtures.checkUpdate,
  error: fixtures.error,
  uninstall: { status: "done", removed: 1 },
  feedback: { status: "done", issueUrl: null },
  envEdit: { status: "done", applied: [], restartRequired: true }
};

for (const kind of Object.keys(MARKETPLACE_CONTRACTS)) {
  check(`${kind} fixture 满足最小字段`, inspectMarketplacePayload(kind, samples[kind]).ok, true);
}

const listForward = forwardMarketplacePayload("list", fixtures.list);
check("forward payload 的未知顶层字段被投影忽略", projectMarketplacePayload("list", listForward), projectMarketplacePayload("list", fixtures.list));
check("forward payload 的未知 repo 字段被投影忽略", projectMarketplacePayload("list", listForward).repos, projectMarketplacePayload("list", fixtures.list).repos);
check("forward payload 不修改原始 fixture", fixtures.list.__contract_extension__, undefined);

const legacyList = legacyMarketplacePayload("list", fixtures.list);
check("legacy list 保留必需字段", inspectMarketplacePayload("list", legacyList).ok, true);
check("legacy list 可省略新增可选字段", Object.keys(legacyList).sort(), ["repos", "total"]);

const legacyAwaiting = legacyMarketplacePayload("install", fixtures.installAwaiting);
check("legacy awaiting 保留状态", legacyAwaiting.status, "awaiting-input");
check("legacy awaiting 保留继续流程所需问题", Array.isArray(legacyAwaiting.questions), true);
check("legacy awaiting 可省略非必需字段", legacyAwaiting.type, undefined);

check("已知状态集合包含所有终态", MARKETPLACE_STATUSES, ["done", "no-update", "awaiting-input", "aborted", "manual", "failed"]);
check("未知状态不被视为已知成功状态", MARKETPLACE_STATUSES.includes("future-status"), false);
check("未知状态不会等于 done", "future-status" === "done", false);

const secondFixtures = createMarketplaceFixtures();
fixtures.list.repos[0].name = "mutated";
check("每次创建 fixture 都不共享可变列表", secondFixtures.list.repos[0].name, "fixture-ready");
const legacyCopy = legacyMarketplacePayload("skills", secondFixtures.skills);
legacyCopy.repos[0].name = "legacy-mutated";
check("变体生成不修改源 fixture", secondFixtures.skills.repos[0].name, "fixture-skill");

const missing = inspectMarketplacePayload("list", { source: "legacy-only" });
check("缺少必需字段可被识别", missing, {
  ok: false,
  missing: ["repos", "total"],
  known: { source: "legacy-only" }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
