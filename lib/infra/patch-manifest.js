// cordis.patch.yml 的文件适配器：只处理本插件注册块的读改写。

export function createPatchManifestAdapter({
  fs: { readFile, writeFile, rename },
  hasPatchEntry,
  queue,
  defaultPatchPath,
}) {
  function resolvePatchPath(patchPath) {
    return patchPath === undefined ? defaultPatchPath() : patchPath;
  }

  async function appendPatchEntry(entryId, pkgName, patchPath) {
    const targetPath = resolvePatchPath(patchPath);
    return await queue.add(async () => {
      const patch = await readFile(targetPath, "utf8").catch(() => "");
      if (hasPatchEntry(patch, pkgName)) return false;
      const quoted = /^[@!&*#?|>'"%`]/.test(pkgName) ? `"${pkgName}"` : pkgName;
      const row = `    - id: ${entryId}\n      name: ${quoted}\n`;
      const lines = patch.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/^\[\]\s*$/.test(lines[i])) lines[i] = "";
      }
      const base = lines.join("\n").trimEnd();
      const next = base === ""
        ? `# dsh-plugin-marketplace 自动注册的插件条目\n- insert:\n${row}`
        : base.endsWith("\n") ? base + "\n- insert:\n" + row : base + "\n\n- insert:\n" + row;
      const tmp = targetPath + ".tmp";
      await writeFile(tmp, next, "utf8");
      await rename(tmp, targetPath);
      return true;
    });
  }

  async function removePatchEntry(pkgName, patchPath) {
    const targetPath = resolvePatchPath(patchPath);
    return await queue.add(async () => {
      const patch = await readFile(targetPath, "utf8").catch(() => "");
      if (!hasPatchEntry(patch, pkgName)) return false;
      const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const namePattern = new RegExp("^\\s*name:\\s*(?:\"|')?" + escaped + "(?:\"|')?\\s*$", "m");
      const lines = patch.split("\n");
      const out = [];
      let inBlock = false;
      let blockLines = [];
      let blockHasTarget = false;
      const flushBlock = () => {
        if (inBlock && !blockHasTarget) out.push(...blockLines);
        inBlock = false;
        blockLines = [];
        blockHasTarget = false;
      };
      for (const line of lines) {
        if (/^- insert:\s*$/.test(line)) {
          flushBlock();
          inBlock = true;
          blockLines = [line];
        } else if (inBlock) {
          if (/^[^ \t]/.test(line) && line.trim() !== "") {
            flushBlock();
            out.push(line);
          } else {
            blockLines.push(line);
            if (namePattern.test(line)) blockHasTarget = true;
          }
        } else {
          out.push(line);
        }
      }
      flushBlock();
      let next = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
      const hasContent = out.some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
      if (!hasContent) next = "[]\n";
      const tmp = targetPath + ".tmp";
      await writeFile(tmp, next, "utf8");
      await rename(tmp, targetPath);
      return true;
    });
  }

  return { appendPatchEntry, removePatchEntry };
}
