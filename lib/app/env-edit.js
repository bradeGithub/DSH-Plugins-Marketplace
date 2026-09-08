export function createEnvEditUseCase({
  envsFile,
  marketRoot,
  dotenvFile,
  dshHome,
  readStateJson,
  mkdir,
  readFile,
  writeFile,
  queue,
  getInstalledRecord,
  isValidEnvKey,
  maxKeys = 16,
  maxValueLength = 4000
}) {
  let envStore = {};

  const persist = async () => {
    await mkdir(marketRoot, { recursive: true });
    await writeFile(envsFile, JSON.stringify(envStore, null, 2), "utf8");
  };

  const load = async () => {
    const data = await readStateJson(envsFile);
    if (data && typeof data === "object" && !Array.isArray(data)) envStore = data;
  };

  const getStored = (repo) => {
    const stored = envStore[repo];
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  };

  const writeDotEnv = async (entries) => {
    let lines = [];
    try {
      lines = (await readFile(dotenvFile, "utf8")).split(/\r?\n/);
    } catch {}
    const keyPattern = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/;
    for (const [key, value] of Object.entries(entries)) {
      if (!isValidEnvKey(key)) continue;
      const cleaned = String(value).replace(/[\r\n]+/g, " ");
      const line = `${key}=${/[\s"'#]/.test(cleaned) ? `"${cleaned.replace(/"/g, '\\"')}"` : cleaned}`;
      let replaced = false;
      for (let i = 0; i < lines.length; i++) {
        const match = keyPattern.exec(lines[i]);
        if (match && match[1] === key) {
          lines[i] = line;
          replaced = true;
          break;
        }
      }
      if (!replaced) lines.push(line);
    }
    await mkdir(dshHome, { recursive: true });
    await writeFile(dotenvFile, lines.join("\n") + "\n", "utf8");
  };

  const applyEnvEdit = async ({ repo, values }) => {
    const record = getInstalledRecord(repo);
    if (!record) return { status: "not-installed" };
    const input = values && typeof values === "object" && !Array.isArray(values) ? values : {};
    const keys = Object.keys(input);
    if (keys.length > maxKeys) return { status: "too-many-keys" };
    const bad = keys.find((key) => !isValidEnvKey(key));
    if (bad) return { status: "invalid-key", key: bad };

    const allowed = new Set(Array.isArray(record.envKeys) ? record.envKeys : []);
    const current = { ...getStored(repo) };
    const applied = [];
    for (const [key, rawValue] of Object.entries(input)) {
      if (allowed.size > 0 && !allowed.has(key)) continue;
      const value = String(rawValue ?? "").trim().slice(0, maxValueLength);
      if (value === "") delete current[key];
      else current[key] = value;
      applied.push(key);
    }
    if (applied.length === 0) return { status: "no-applied" };

    envStore = { ...envStore, [repo]: current };
    await queue.add(persist);
    await writeDotEnv(current);
    return { status: "done", applied, restartRequired: true };
  };

  return { load, getStored, applyEnvEdit };
}
