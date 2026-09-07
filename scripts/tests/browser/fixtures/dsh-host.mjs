import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const isWin = process.platform === "win32";

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function dshInvocation(args) {
  const explicit = process.env.DSH_E2E_BIN;
  if (explicit && existsSync(explicit)) return { command: process.execPath, args: [explicit, ...args] };
  try {
    const npm = isWin ? "npm.cmd" : "npm";
    const globalRoot = execFileSync(npm, ["root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
    const entry = join(globalRoot, "@deepseek-ai", "dsh", "lib", "bin.js");
    if (existsSync(entry)) return { command: process.execPath, args: [entry, ...args] };
  } catch {
    // Fall through to the normal CLI lookup.
  }
  return isWin
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", "dsh", ...args] }
    : { command: "dsh", args };
}

function writeProfile(profilesRoot, name, sourceRoot) {
  const profile = join(profilesRoot, name);
  mkdirSync(join(profile, "node_modules"), { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({
    name: `dsh-frontend-e2e-${name}`,
    private: true,
    dependencies: name === "web"
      ? { "dsh-plugin-marketplace": `link:${sourceRoot.replace(/\\/g, "/")}` }
      : {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-marketplace"] }
    }
  }, null, 2), "utf8");
  writeFileSync(join(profile, "cordis.patch.yml"), "[]\n", "utf8");
  return profile;
}

function copyMarketplaceBundle(profile, sourceRoot) {
  const target = join(profile, "node_modules", "dsh-plugin-marketplace");
  mkdirSync(target, { recursive: true });
  for (const file of ["package.json", "cordis.patch.yml", "registry.json", "skills.json", "adaptor.json"]) {
    cpSync(join(sourceRoot, file), join(target, file));
  }
  cpSync(join(sourceRoot, "lib"), join(target, "lib"), { recursive: true });
}

async function waitForHost(url, child) {
  let childExit = null;
  child.once("exit", (code, signal) => { childExit = { code, signal }; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (childExit) throw new Error(`dsh web 启动失败: ${JSON.stringify(childExit)}`);
    try {
      const response = await fetch(`${url}/api/marketplace/profile`, {
        headers: { "X-DSH-Marketplace": "1" },
        signal: AbortSignal.timeout(1_000)
      });
      if (response.status === 200) return;
    } catch {
      // Keep polling until the observable ready response arrives.
    }
    await wait(100);
  }
  throw new Error("dsh web 60s 内未就绪");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    } catch {
      try { child.kill(); } catch { /* process already exited */ }
    }
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch {
      try { child.kill(); } catch { /* process already exited */ }
    }
  }
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolveExit(); });
  });
}

export async function createDshHost() {
  const sourceRoot = ROOT;
  const home = mkdtempSync(join(tmpdir(), "dsh-frontend-e2e-"));
  const profilesRoot = join(home, "profiles");
  const webProfile = writeProfile(profilesRoot, "web", sourceRoot);
  writeProfile(profilesRoot, "desktop", sourceRoot);
  copyMarketplaceBundle(webProfile, sourceRoot);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const invocation = dshInvocation(["--profile", "web", "--no-open", "--port", String(port)]);
  // 捕获子进程 stdout：DSH 0.1.2+ 在启动时打印带 `?token=` 的鉴权 URL，
  // 根路径无 token 时返回 401（0.1.1 及更早直接服务裸 URL）。解析该 URL 供页面导航。
  let bootOutput = "";
  const child = spawn(invocation.command, invocation.args, {
    env: { ...process.env, DSH_HOME: home.replace(/\\/g, "/") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: !isWin
  });
  child.stdout?.on("data", (chunk) => { bootOutput += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { bootOutput += chunk.toString(); });
  try {
    await waitForHost(url, child);
  } catch (error) {
    await stopChild(child);
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  // 等待 stdout 中的鉴权 URL 落盘（0.1.2 在启动时打印；0.1.1 无 token 则跳过）。
  const tokenDeadline = Date.now() + 5_000;
  while (Date.now() < tokenDeadline && !/[?&]token=/.test(bootOutput)) {
    await wait(50);
  }
  const tokenMatch = bootOutput.match(/[?&]token=([A-Za-z0-9_-]+)/);
  const authUrl = tokenMatch ? `${url}/?token=${tokenMatch[1]}` : url;
  let closed = false;
  return {
    home,
    webProfile,
    port,
    url,
    authUrl,
    async close() {
      if (closed) return;
      closed = true;
      await stopChild(child);
      rmSync(home, { recursive: true, force: true });
    }
  };
}

export async function openMarketplace(page, authUrl) {
  await page.goto(authUrl, { waitUntil: "domcontentloaded" });
  const continueButton = page.getByRole("button", { name: "继续", exact: true });
  try {
    await continueButton.waitFor({ state: "visible", timeout: 10_000 });
    await continueButton.click();
  } catch (error) {
    if (!String(error?.message ?? error).includes("Timeout")) throw error;
  }
  const settings = page.getByRole("button", { name: "设置", exact: true });
  await settings.waitFor({ state: "visible", timeout: 30_000 });
  await settings.click();
  const section = page.getByText("DSH插件市场", { exact: true }).last();
  await section.waitFor({ state: "visible", timeout: 30_000 });
  await section.click();
  await page.getByRole("heading", { name: "DSH插件市场", exact: true }).last().waitFor({ state: "visible", timeout: 30_000 });
}
