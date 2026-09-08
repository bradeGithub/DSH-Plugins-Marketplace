import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { wslPosixPath } from "../domain/normalize.js";

export const MAX_EXEC_BUFFER = 32 * 1024 * 1024;

const defaultExecFileAsync = promisify(execFile);
const defaultExists = (path) => stat(path).then(() => true).catch(() => false);

function safeOptions(opts = {}) {
  return { ...opts, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true };
}

export function createProc({
  platform = process.platform,
  processExecPath = process.execPath,
  npmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  dshCliPath,
  execFileAsync: injectedExecFileAsync = defaultExecFileAsync,
  spawnSync: injectedSpawnSync = spawnSync,
  exists = defaultExists,
} = {}) {
  const executor = injectedExecFileAsync;
  const currentDshCliPath = () => dshCliPath ?? join(process.env.APPDATA ?? "", "npm", "dsh.cmd");

  async function execFileSafe(file, args, opts = {}) {
    return await executor(file, args, safeOptions(opts));
  }

  async function probe(file, args = []) {
    try {
      const result = await execFileSafe(file, args, { timeout: 5000 });
      return String(result?.stdout ?? "").trim().split("\n")[0].slice(0, 20);
    } catch {
      return "missing";
    }
  }

  async function runNpm(args, opts = {}) {
    if (platform === "win32") {
      if (await exists(npmCliPath)) return await execFileSafe(processExecPath, [npmCliPath, ...args], opts);
      return await execFileSafe("cmd.exe", ["/c", "npm.cmd", ...args], opts);
    }
    return await execFileSafe("npm", args, opts);
  }

  async function runPnpm(args, opts = {}) {
    if (platform === "win32") {
      return await execFileSafe("cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], opts);
    }
    return await execFileSafe("pnpm", args, opts);
  }

  async function runGit(args, opts = {}) {
    return await execFileSafe("git", args, opts);
  }

  async function runDsh(args, opts = {}) {
    if (platform === "win32") {
      const file = await exists(currentDshCliPath()) ? currentDshCliPath() : "dsh";
      return await execFileSafe("cmd.exe", ["/c", file, ...args], opts);
    }
    return await execFileSafe("dsh", args, opts);
  }

  async function runScript(scriptPath, opts = {}) {
    if (String(scriptPath).toLowerCase().endsWith(".ps1")) {
      return await execFileSafe(
        "pwsh",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        opts
      );
    }
    let shArgs = [scriptPath];
    if (platform === "win32") {
      const result = injectedSpawnSync("bash", ["--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result?.status === 0 && !/msys|MINGW/i.test(`${result.stdout ?? ""}${result.stderr ?? ""}`)) {
        shArgs = [wslPosixPath(scriptPath)];
      }
    }
    return await execFileSafe("bash", shArgs, opts);
  }

  return { execFileSafe, probe, runNpm, runPnpm, runGit, runDsh, runScript };
}

const defaultProc = createProc();
export const execFileSafe = defaultProc.execFileSafe;
export const probe = defaultProc.probe;
export const runNpm = defaultProc.runNpm;
export const runPnpm = defaultProc.runPnpm;
export const runGit = defaultProc.runGit;
export const runDsh = defaultProc.runDsh;
export const runScript = defaultProc.runScript;
