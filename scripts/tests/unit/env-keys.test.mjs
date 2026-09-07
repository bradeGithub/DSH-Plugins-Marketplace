// env-keys 路由行为测试：篡改的受管目录外 location 不得触发扫描。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const home = mkdtempSync(join(tmpdir(), "dsh-env-keys-"));
process.env.DSH_HOME = home.replace(/\\/g, "/");
const outside = join(home, "outside-location");
mkdirSync(join(home, "marketplace"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "README.md"), "OPENAI_API_KEY=must-not-be-scanned\n", "utf8");
writeFileSync(join(home, "marketplace", "installed.json"), JSON.stringify({
  "none/env-outside": {
    type: "skill",
    name: "outside",
    location: outside,
    envKeys: null
  }
}), "utf8");

const lib = await import("../../../lib/index.js");
const registered = [];
lib.apply({
  get: (service) => service === "webServer" ? { register: (route) => registered.push(route) } : undefined,
  logger: { warn: () => {} },
  slots: { inject: () => {} }
});
const handler = registered.find((route) => route.path === "/api/marketplace/env-keys")?.handler;
if (!handler) {
  check("env-keys handler 存在", false, true);
} else {
  let body = null;
  await handler(
    {
      method: "GET",
      headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
      url: "/api/marketplace/env-keys?repo=none%2Fenv-outside"
    },
    { writeHead: () => {}, end: (text) => { body = JSON.parse(text); } }
  );
  check("受管目录外 location 不扫描 envKeys", body?.envKeys, []);
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
