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
assert.equal(sha256(assembled), "ed93ff99089c8104aef4fa5f74e7290435838cf5379b7b3d9dcc28f5fe240893");
assert.equal(sha256(assembleClient()), sha256(assembled));
assert.equal(SOURCE_DIR, join(ROOT, "lib", "client-src"));

const output = execFileSync(process.execPath, [join(ROOT, "scripts", "assemble-client.mjs")], {
  cwd: tmpdir(),
  encoding: "utf8"
});
assert.match(output, /^client bundle clean: [0-9a-f]{64}\r?\n$/);

console.log("client assembler contract: 11 passed, 0 failed");
