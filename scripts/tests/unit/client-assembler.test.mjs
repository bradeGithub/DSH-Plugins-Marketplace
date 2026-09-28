import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleClient,
  checkClientBundle,
  CLIENT_BUNDLE,
  FRAGMENT_FILES,
  SOURCE_DIR,
  sha256
} from "../../assemble-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bundle = readFileSync(CLIENT_BUNDLE, "utf8");
const assembled = assembleClient();

assert.equal(assembled, bundle);
assert.equal(assembled.charCodeAt(0) === 0xfeff, false);
assert.equal(assembled.includes("\r"), false);
assert.equal(FRAGMENT_FILES.length, 8);
assert.deepEqual(FRAGMENT_FILES, [
  "01-wrapper.fragment",
  "02-i18n.fragment",
  "03-theme.fragment",
  "04-components.fragment",
  "05a-logic.fragment",
  "05-tabs.fragment",
  "06-marketplace.fragment",
  "07-entry.fragment",
]);
assert.equal(checkClientBundle().ok, true);
// 生命周期契约（DSH 0.1.7 运行时卸载）：客户端注册面 disposer 必须经 ctx.effect 收集——
// locale 字典（已有）、样式标签、locale 订阅。slots.inject 经宿主源码核实自带 fiber
// 作用域（client-runtime inject 内部 ctx.effect），无需重复收集。
assert.match(bundle, /"dsh-plugin-marketplace: dictionaries"/);
assert.match(bundle, /"dsh-plugin-marketplace: styles"/);
assert.match(bundle, /"dsh-plugin-marketplace: locale subscription"/);
assert.equal(sha256(assembled), "9ed5663b19393124a8eeffc49cc2ab7030a51bb09b289fb001c5daf506fde864");
assert.equal(sha256(assembleClient()), sha256(assembled));
assert.equal(SOURCE_DIR, join(ROOT, "lib", "client-src"));

const output = execFileSync(process.execPath, [join(ROOT, "scripts", "assemble-client.mjs")], {
  cwd: tmpdir(),
  encoding: "utf8"
});
assert.match(output, /^client bundle clean: [0-9a-f]{64}\r?\n$/);

console.log("client assembler contract: 14 passed, 0 failed");
