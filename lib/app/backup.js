export function createBackupUseCase({
  getInstalledEntries,
  readOwnVersion,
  installedKey,
  hasInstalledRecord,
  fetchImpl,
  readBodyLimited,
  responseTooLarge,
  timeoutSignal,
  isSafeWebdavUrl,
  translate,
  now = () => Date.now()
}) {
  const message = (lang, key, params) => translate(lang ?? "zh", key, params);

  const buildBackup = () => {
    const repos = [...getInstalledEntries()]
      .map(([key, record]) => ({
        repo: installedKey(key),
        type: record.type ?? null,
        name: record.name ?? null,
        names: Array.isArray(record.names) && record.names.length > 0 ? record.names : null,
        version: record.version ?? null,
        installedAt: record.installedAt ?? null
      }))
      .filter((record) => typeof record.repo === "string" && record.repo.length > 0)
      .sort((a, b) => (a.installedAt ?? 0) - (b.installedAt ?? 0));
    return {
      app: "dsh-plugin-marketplace",
      appVersion: readOwnVersion(),
      exportedAt: new Date(now()).toISOString(),
      repos
    };
  };

  const isValidBackup = (backup) => Boolean(backup && typeof backup === "object" && Array.isArray(backup.repos)
    && backup.repos.every((record) => record && typeof record.repo === "string"));

  const diffRecords = (backup) => {
    const missing = [];
    const already = [];
    for (const record of backup.repos) {
      (hasInstalledRecord(record.repo) ? already : missing).push(record);
    }
    return { missing, already };
  };

  const buildDiffResult = ({ missing, already }, lang) => ({
    missing: missing.map((record) => typeof record === "string" ? record : record.repo),
    already: already.map((record) => typeof record === "string" ? record : record.repo),
    log: missing.length === 0
      ? [message(lang, "restoreDiffNone")]
      : [message(lang, "restoreDiff", { n: missing.length, m: already.length })]
  });

  const diffBackup = (backup, lang) => buildDiffResult(diffRecords(backup), lang);

  const webdavHeaders = (accept, username, password) => {
    const headers = { "User-Agent": "dsh-plugin-marketplace", Accept: accept };
    if (username) {
      headers.Authorization = "Basic " + Buffer.from(`${username}:${password ?? ""}`).toString("base64");
    }
    return headers;
  };

  const pushWebdav = async ({ url, backup, username, password, lang }) => {
    if (!isSafeWebdavUrl(url)) return { status: "invalid-url" };
    const selected = isValidBackup(backup) ? backup : buildBackup();
    try {
      const headers = {
        "Content-Type": "application/json",
        ...webdavHeaders("application/json", username, password)
      };
      const response = await fetchImpl(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(selected),
        signal: timeoutSignal()
      });
      if (!response.ok && response.status !== 201 && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { status: "done", count: selected.repos.length, log: [message(lang, "webdavPushOk")] };
    } catch (error) {
      const errorText = String(error?.message ?? error);
      return {
        status: "failed",
        error: errorText,
        log: [message(lang, "webdavFail", { err: errorText })]
      };
    }
  };

  const restoreWebdav = async ({ url, username, password, lang }) => {
    if (!isSafeWebdavUrl(url)) return { status: "invalid-url" };
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: webdavHeaders("application/json", username, password),
        signal: timeoutSignal()
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (responseTooLarge(response)) throw new Error("备份响应过大");
      const backup = JSON.parse((await readBodyLimited(response)).toString("utf8"));
      if (!isValidBackup(backup)) return { status: "invalid-backup" };
      return { status: "done", ...diffBackup(backup, lang) };
    } catch (error) {
      const errorText = String(error?.message ?? error);
      return {
        status: "failed",
        error: errorText,
        log: [message(lang, "webdavFail", { err: errorText })]
      };
    }
  };

  return {
    buildBackup,
    isValidBackup,
    diffBackup,
    buildDiffResult,
    pushWebdav,
    restoreWebdav
  };
}
