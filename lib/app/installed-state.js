export function createInstalledState({
  file,
  marketRoot,
  readStateJson,
  mkdir,
  writeFile,
  queue,
  normalizeRepoRef,
}) {
  let records = new Map();
  const listeners = new Set();

  const keyOf = (fullName) => normalizeRepoRef(fullName) ?? String(fullName ?? "");

  const mapFromData = (data) => {
    const next = new Map();
    if (data && typeof data === "object") {
      for (const [key, value] of Object.entries(data)) next.set(keyOf(key), value);
    }
    return next;
  };

  const persist = async (next) => {
    const data = {};
    for (const [key, value] of next) data[key] = value;
    await mkdir(marketRoot, { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), "utf8");
  };

  const notify = (event) => {
    for (const listener of listeners) listener(event);
  };

  const snapshot = () => new Map(records);

  return {
    async load() {
      records = mapFromData(await readStateJson(file));
    },

    get(fullName) {
      return records.get(keyOf(fullName));
    },

    has(fullName) {
      return records.has(keyOf(fullName));
    },

    snapshot,

    entries() {
      return snapshot().entries();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async save(fullName, record) {
      const key = keyOf(fullName);
      return await queue.add(async () => {
        const next = snapshot();
        next.set(key, record);
        await persist(next);
        records = next;
        notify({ type: "save", key, record });
      });
    },

    async remove(fullName) {
      const key = keyOf(fullName);
      return await queue.add(async () => {
        const next = snapshot();
        const existed = next.has(key);
        const record = next.get(key);
        next.delete(key);
        await persist(next);
        records = next;
        if (existed) notify({ type: "remove", key, record });
      });
    },
  };
}
