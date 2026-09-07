import { createEnvEditUseCase } from "../../../lib/app/env-edit.js";

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

const VALID_KEYS = new Set(["API_KEY", "TOKEN", "MY_API_KEY", "customToken"]);
const isValidEnvKey = (key) => VALID_KEYS.has(key);
const RECORD = { envKeys: ["API_KEY", "TOKEN"] };

function makeEnvEdit(overrides = {}) {
  const calls = [];
  const writes = [];
  let stored = null;
  let dotenv = null;
  const records = new Map([["owner/demo", RECORD]]);
  const queue = {
    add: async (task) => {
      calls.push("queue.add");
      return await task();
    }
  };
  const options = {
    envsFile: "/market/envs.json",
    marketRoot: "/market",
    dotenvFile: "/home/dsh/.env",
    dshHome: "/home/dsh",
    readStateJson: async () => stored,
    mkdir: async (...args) => calls.push(["mkdir", ...args]),
    readFile: async (file) => {
      calls.push(["readFile", file]);
      if (dotenv === null) throw new Error("ENOENT");
      return dotenv;
    },
    writeFile: async (file, data, encoding) => {
      calls.push(["writeFile", file]);
      writes.push({ file, data, encoding });
    },
    queue,
    getInstalledRecord: (repo) => records.get(repo) ?? null,
    isValidEnvKey,
    maxKeys: 16,
    maxValueLength: 4000,
    ...overrides
  };
  const flow = createEnvEditUseCase(options);
  return {
    flow,
    calls,
    writes,
    records,
    setStored: (value) => { stored = value; },
    setDotenv: (value) => { dotenv = value; }
  };
}

{
  const { flow } = makeEnvEdit();
  check("初始存储为空", flow.getStored("owner/demo"), {});
}

{
  const { flow, setStored } = makeEnvEdit();
  setStored({ "owner/demo": { API_KEY: "saved" }, "owner/other": { TOKEN: "other" } });
  await flow.load();
  check("load 恢复 envStore", flow.getStored("owner/demo"), { API_KEY: "saved" });
  check("load 保留其他仓库", flow.getStored("owner/other"), { TOKEN: "other" });
}

{
  const { flow, setStored } = makeEnvEdit();
  setStored(["not", "an", "object"]);
  await flow.load();
  check("load 非对象按空处理", flow.getStored("owner/demo"), {});
}

{
  const { flow } = makeEnvEdit();
  const result = await flow.applyEnvEdit({ repo: "missing/repo", values: { API_KEY: "x" } });
  check("未安装返回 not-installed", result, { status: "not-installed" });
}

{
  const { flow } = makeEnvEdit();
  const result = await flow.applyEnvEdit({ repo: "owner/demo", values: {} });
  check("空 values 返回 no-applied", result, { status: "no-applied" });
}

{
  const { flow } = makeEnvEdit();
  const result = await flow.applyEnvEdit({ repo: "owner/demo", values: null });
  check("非对象 values 返回 no-applied", result, { status: "no-applied" });
}

{
  const { flow } = makeEnvEdit();
  const result = await flow.applyEnvEdit({ repo: "owner/demo", values: { "bad key!": "x" } });
  check("非法键返回 invalid-key", result, { status: "invalid-key", key: "bad key!" });
}

{
  const { flow } = makeEnvEdit();
  const values = {};
  for (let i = 0; i < 17; i++) values[`KEY_${i}`] = "x";
  const result = await flow.applyEnvEdit({ repo: "owner/demo", values });
  check("超过键数量返回 too-many-keys", result, { status: "too-many-keys" });
}

{
  const { flow } = makeEnvEdit({ isValidEnvKey: (key) => /^[A-Z][A-Z0-9_]+$/.test(key) });
  const result = await flow.applyEnvEdit({ repo: "owner/demo", values: { API_KEY: "x", TOKEN: "y" } });
  check("白名单键保存成功", result, { status: "done", applied: ["API_KEY", "TOKEN"], restartRequired: true });
}

{
  const { flow } = makeEnvEdit({ isValidEnvKey: () => true });
  const result = await flow.applyEnvEdit({ repo: "owner/demo", values: { CUSTOM: "x" } });
  check("已有 envKeys 时拒绝未扫描键", result, { status: "no-applied" });
}

{
  const { flow, records } = makeEnvEdit({ isValidEnvKey: () => true });
  records.set("owner/empty", { envKeys: [] });
  const result = await flow.applyEnvEdit({ repo: "owner/empty", values: { CUSTOM: "x" } });
  check("无 envKeys 时允许合法自定义键", result.status, "done");
}

{
  const { flow, records } = makeEnvEdit();
  records.set("owner/empty", { envKeys: [] });
  const result = await flow.applyEnvEdit({ repo: "owner/empty", values: { API_KEY: "  value  " } });
  check("值去首尾空白", result.applied, ["API_KEY"]);
  check("保存后的值可读", flow.getStored("owner/empty"), { API_KEY: "value" });
}

{
  const { flow, records } = makeEnvEdit();
  records.set("owner/empty", { envKeys: [] });
  const result = await flow.applyEnvEdit({ repo: "owner/empty", values: { API_KEY: "x".repeat(4001) } });
  check("值长度截断为 4000", result.status, "done");
  check("截断值长度", flow.getStored("owner/empty").API_KEY.length, 4000);
}

{
  const { flow, records } = makeEnvEdit();
  records.set("owner/empty", { envKeys: [] });
  await flow.applyEnvEdit({ repo: "owner/empty", values: { API_KEY: "old" } });
  const result = await flow.applyEnvEdit({ repo: "owner/empty", values: { API_KEY: "   " } });
  check("空值清除键", result.status, "done");
  check("清除后存储为空", flow.getStored("owner/empty"), {});
}

{
  const { flow, writes, setDotenv } = makeEnvEdit();
  setDotenv("# header\nAPI_KEY=old\nOTHER=keep\n");
  await flow.applyEnvEdit({ repo: "owner/demo", values: { API_KEY: "new" } });
  check("替换 .env 原有键", writes.at(-1).data.includes("API_KEY=new"), true);
  check("保留 .env 其他行", writes.at(-1).data.includes("OTHER=keep"), true);
}

{
  const { flow, writes } = makeEnvEdit();
  await flow.applyEnvEdit({ repo: "owner/demo", values: { API_KEY: "needs space" } });
  check("首次写入 .env", writes.at(-1).file, "/home/dsh/.env");
  check("特殊值使用双引号", writes.at(-1).data.includes('API_KEY="needs space"'), true);
}

{
  const { flow, writes } = makeEnvEdit();
  await flow.applyEnvEdit({ repo: "owner/demo", values: { API_KEY: "say\"hello" } });
  check("双引号转义", writes.at(-1).data.includes('API_KEY="say\\"hello"'), true);
}

{
  const { flow, writes } = makeEnvEdit();
  await flow.applyEnvEdit({ repo: "owner/demo", values: { API_KEY: "line1\nline2" } });
  check("值内换行净化", writes.at(-1).data.includes('API_KEY="line1 line2"'), true);
}

{
  const { flow, calls, writes } = makeEnvEdit();
  await flow.applyEnvEdit({ repo: "owner/demo", values: { API_KEY: "x" } });
  check("持久化通过队列", calls.filter((item) => item === "queue.add").length, 1);
  check("同时写 envs.json", writes.some((item) => item.file === "/market/envs.json"), true);
  check("同时写 .env", writes.some((item) => item.file === "/home/dsh/.env"), true);
}

{
  const { flow, records } = makeEnvEdit({ writeFile: async (file) => {
    if (file === "/market/envs.json") throw new Error("disk full");
  } });
  records.set("owner/empty", { envKeys: [] });
  let thrown = "";
  try {
    await flow.applyEnvEdit({ repo: "owner/empty", values: { API_KEY: "x" } });
  } catch (error) {
    thrown = error.message;
  }
  check("envs 持久化失败向调用方抛出", thrown, "disk full");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
