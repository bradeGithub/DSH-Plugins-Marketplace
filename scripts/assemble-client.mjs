#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLIENT_BUNDLE = join(ROOT, "lib", "client.js");
const SOURCE_DIR = join(ROOT, "lib", "client-src");
const FRAGMENT_FILES = [
  "01-wrapper.fragment",
  "02-i18n.fragment",
  "03-theme.fragment",
  "04-components.fragment",
  "05a-logic.fragment",
  "05-tabs.fragment",
  "06-marketplace.fragment",
  "07-entry.fragment",
];

function readFragments() {
  return FRAGMENT_FILES.map((name) => {
    const text = readFileSync(join(SOURCE_DIR, name), "utf8");
    if (text.charCodeAt(0) === 0xfeff) throw new Error(`BOM is not allowed: ${name}`);
    if (text.includes("\r")) throw new Error(`CRLF is not allowed: ${name}`);
    return text;
  });
}

export function assembleClient() {
  return readFragments().join("");
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function checkClientBundle() {
  const assembled = assembleClient();
  const current = readFileSync(CLIENT_BUNDLE, "utf8");
  return {
    ok: assembled === current,
    assembledHash: sha256(assembled),
    currentHash: sha256(current),
    assembled,
    current,
  };
}

export function main(argv = process.argv.slice(2)) {
  const write = argv.includes("--write");
  const result = checkClientBundle();
  if (write) {
    writeFileSync(CLIENT_BUNDLE, result.assembled, "utf8");
    console.log(`client bundle written: ${result.assembledHash}`);
    return 0;
  }
  if (!result.ok) {
    console.error(`client bundle drift: ${result.currentHash} != ${result.assembledHash}`);
    return 1;
  }
  console.log(`client bundle clean: ${result.currentHash}`);
  return 0;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) process.exitCode = main();

export { CLIENT_BUNDLE, FRAGMENT_FILES, ROOT, SOURCE_DIR };
