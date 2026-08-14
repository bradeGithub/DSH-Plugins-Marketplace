import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectType, findSkillRoots } from "../lib/index.js";

const repo = await mkdtemp(join(tmpdir(), "dsh-marketplace-multi-skill-"));
try {
  await mkdir(join(repo, "skills", "pdf"), { recursive: true });
  await mkdir(join(repo, "skills", "slides"), { recursive: true });
  await writeFile(join(repo, "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\n");
  await writeFile(join(repo, "skills", "slides", "SKILL.md"), "---\nname: slides\n---\n");

  const roots = await findSkillRoots(repo);
  assert.deepEqual(roots.map((value) => value.split(/[\\/]/).at(-1)).sort(), ["pdf", "slides"]);
  assert.equal(await detectType(repo), "skill");
  console.log("2 passed, 0 failed");
} finally {
  await rm(repo, { recursive: true, force: true });
}
