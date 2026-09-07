// infra/proc.js 直接导入测试：先锁定子进程适配边界，再迁移调用点。
import { createProc, MAX_EXEC_BUFFER } from "../../../lib/infra/proc.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function fixture({ platform = "linux", existing = [], execResult = { stdout: "ok", stderr: "" }, execError = null, bashProbe = { status: 0, stdout: "bash", stderr: "" } } = {}) {
  const calls = [];
  const probes = [];
  const proc = createProc({
    platform,
    processExecPath: "node-test",
    npmCliPath: "node-npm-cli.js",
    dshCliPath: "C:/Users/test/AppData/npm/dsh.cmd",
    execFileAsync: async (file, args, opts) => {
      calls.push({ file, args, opts });
      if (execError) throw execError;
      return execResult;
    },
    spawnSync: (file, args, opts) => {
      probes.push({ file, args, opts });
      return bashProbe;
    },
    exists: async (path) => existing.includes(path),
  });
  return { proc, calls, probes };
}

const common = { cwd: "C:/work", env: { PATH: "safe" }, timeout: 1234 };
check("MAX_EXEC_BUFFER 为 32MB", MAX_EXEC_BUFFER, 32 * 1024 * 1024);

// 默认文件探测：只使用真实存在的 Node 可执行文件，不启动真实 npm。
{
  const calls = [];
  const proc = createProc({
    platform: "win32",
    npmCliPath: process.execPath,
    execFileAsync: async (file, args, opts) => {
      calls.push({ file, args, opts });
      return {};
    },
  });
  await proc.runNpm(["--version"]);
  check("默认 exists 探测已存在 npm-cli", calls[0].file, process.execPath);

  const fallbackCalls = [];
  const fallbackProc = createProc({
    platform: "win32",
    npmCliPath: "C:/path-that-does-not-exist/npm-cli.js",
    execFileAsync: async (file, args, opts) => {
      fallbackCalls.push({ file, args, opts });
      return {};
    },
  });
  await fallbackProc.runNpm(["--version"]);
  check("默认 exists 失败时回退 cmd.exe", fallbackCalls[0].args, ["/c", "npm.cmd", "--version"]);
}

// execFileSafe：参数必须保持数组，安全选项由适配层统一注入。
{
  const { proc, calls } = fixture();
  await proc.execFileSafe("tool", ["--name", "a b"], { ...common, maxBuffer: 1, windowsHide: false });
  check("execFileSafe 保持参数数组", calls[0].args, ["--name", "a b"]);
  check("execFileSafe 透传 cwd/env/timeout", calls[0].opts, {
    cwd: "C:/work", env: { PATH: "safe" }, timeout: 1234,
    maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
}

// Linux：直接调用 npm/pnpm/dsh。
{
  const { proc, calls } = fixture();
  await proc.runNpm(["install", "pkg"], common);
  await proc.runPnpm(["install", "--frozen-lockfile"], common);
  await proc.runDsh(["plugin", "list"], common);
  await proc.runGit(["--version"], common);
  check("Linux runNpm 直接 npm", calls[0].file, "npm");
  check("Linux runNpm 保持参数数组", calls[0].args, ["install", "pkg"]);
  check("Linux runPnpm 直接 pnpm", calls[1].file, "pnpm");
  check("Linux runDsh 直接 dsh", calls[2].file, "dsh");
  check("Linux runGit 直接 git", calls[3].file, "git");
}

// Windows npm：优先 node + npm-cli.js，找不到时走 cmd.exe npm.cmd。
{
  const withCli = fixture({ platform: "win32", existing: ["node-npm-cli.js"] });
  await withCli.proc.runNpm(["install", "pkg"], common);
  check("Windows runNpm 优先 node 执行 npm-cli", withCli.calls[0].file, "node-test");
  check("Windows npm-cli 参数独立传递", withCli.calls[0].args, ["node-npm-cli.js", "install", "pkg"]);

  const withoutCli = fixture({ platform: "win32" });
  await withoutCli.proc.runNpm(["install", "a b"], common);
  check("Windows npm 回退 cmd.exe", withoutCli.calls[0].file, "cmd.exe");
  check("Windows npm 回退不拼接命令", withoutCli.calls[0].args, ["/c", "npm.cmd", "install", "a b"]);
}

// Windows pnpm：cmd.exe 参数仍保持独立数组。
{
  const { proc, calls } = fixture({ platform: "win32" });
  await proc.runPnpm(["install", "a b"], common);
  check("Windows runPnpm 使用 cmd.exe", calls[0].file, "cmd.exe");
  check("Windows runPnpm 使用 /d /s /c 参数", calls[0].args, ["/d", "/s", "/c", "pnpm", "install", "a b"]);
}

// Windows dsh：显式 npm prefix 路径优先，缺失时由 PATH 解析。
{
  const withCli = fixture({ platform: "win32", existing: ["C:/Users/test/AppData/npm/dsh.cmd"] });
  await withCli.proc.runDsh(["plugin", "add", "a b"], common);
  check("Windows runDsh 使用已知 dsh.cmd", withCli.calls[0].args, ["/c", "C:/Users/test/AppData/npm/dsh.cmd", "plugin", "add", "a b"]);

  const withoutCli = fixture({ platform: "win32" });
  await withoutCli.proc.runDsh(["plugin", "add", "a b"], common);
  check("Windows runDsh 缺失时回退 PATH", withoutCli.calls[0].args, ["/c", "dsh", "plugin", "add", "a b"]);
}

// probe：成功取首行，失败归一化为 missing；探测本身也隐藏窗口并限时。
{
  const success = fixture({ execResult: { stdout: "pnpm 9.1.0\nextra", stderr: "" } });
  check("probe 成功返回首行", await success.proc.probe("pnpm", ["--version"]), "pnpm 9.1.0");
  check("probe 使用 5 秒超时", success.calls[0].opts.timeout, 5000);
  check("probe 隐藏窗口", success.calls[0].opts.windowsHide, true);

  const failed = fixture({ execError: new Error("not found") });
  check("probe 失败返回 missing", await failed.proc.probe("git", ["--version"]), "missing");
}

// runScript：PowerShell 与 bash 均经 execFileSafe，脚本路径是独立参数。
{
  const ps = fixture({ platform: "win32" });
  await ps.proc.runScript("C:/cache/install.ps1", { cwd: "C:/cache", env: {} });
  check("runScript ps1 使用 pwsh", ps.calls[0].file, "pwsh");
  check("runScript ps1 参数数组", ps.calls[0].args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/cache/install.ps1"]);

  const sh = fixture({ platform: "linux" });
  await sh.proc.runScript("/tmp/install.sh", { cwd: "/tmp", env: {} });
  check("runScript sh 使用 bash", sh.calls[0].file, "bash");
  check("runScript sh 参数数组", sh.calls[0].args, ["/tmp/install.sh"]);
}

// Windows bash：成功探测到原生 WSL bash 时转换脚本路径；MSYS 或探测失败保持原路径。
{
  const wsl = fixture({ platform: "win32", bashProbe: { status: 0, stdout: "GNU bash", stderr: "" } });
  await wsl.proc.runScript("C:\\cache\\install.sh", { cwd: "C:\\cache" });
  check("runScript WSL bash 转换 Windows 路径", wsl.calls[0].args, ["/mnt/c/cache/install.sh"]);
  check("runScript WSL 探测参数", wsl.probes[0], {
    file: "bash",
    args: ["--version"],
    opts: { encoding: "utf8", windowsHide: true },
  });

  const msys = fixture({ platform: "win32", bashProbe: { status: 0, stdout: "MINGW64 bash", stderr: "" } });
  await msys.proc.runScript("C:\\cache\\install.sh");
  check("runScript MSYS bash 保持 Windows 路径", msys.calls[0].args, ["C:\\cache\\install.sh"]);

  const unavailable = fixture({ platform: "win32", bashProbe: { status: 1, stdout: "", stderr: "missing" } });
  await unavailable.proc.runScript("C:\\cache\\install.sh");
  check("runScript bash 探测失败保持原路径", unavailable.calls[0].args, ["C:\\cache\\install.sh"]);
}

// Windows dsh.cmd 路径随运行时 APPDATA 解析，避免测试/宿主切换环境后使用旧路径。
{
  const savedAppData = process.env.APPDATA;
  const calls = [];
  const proc = createProc({
    platform: "win32",
    exists: async (path) => path.replace(/\\/g, "/") === `${process.env.APPDATA}/npm/dsh.cmd`,
    execFileAsync: async (file, args, opts) => {
      calls.push({ file, args, opts });
      return {};
    },
  });
  try {
    process.env.APPDATA = "C:/dynamic-one";
    await proc.runDsh(["plugin", "list"]);
    process.env.APPDATA = "C:/dynamic-two";
    await proc.runDsh(["plugin", "list"]);
    check("runDsh 动态读取 APPDATA", calls.map((call) => call.args[1]), [
      "C:\\dynamic-one\\npm\\dsh.cmd",
      "C:\\dynamic-two\\npm\\dsh.cmd",
    ]);
  } finally {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
