import { createAuth } from "../../../lib/http/auth.js";

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function makeAuth(overrides = {}) {
  const calls = [];
  const options = {
    isTrustedHost: (host) => host === "127.0.0.1:3080" || host === "192.168.1.5:3080",
    readConfig: async () => {
      calls.push("readConfig");
      return { lanWrite: true };
    },
    randomHex: () => "a".repeat(64),
    timingSafeEqual: (a, b) => {
      if (a.length !== b.length) throw new Error("length mismatch");
      return a.toString() === b.toString();
    },
    ...overrides
  };
  const auth = createAuth(options);
  return { auth, calls };
}

{
  const { auth } = makeAuth();
  check("token 为 64 位 hex", /^[0-9a-f]{64}$/.test(auth.getToken()), true);
  check("token 头名", auth.tokenHeader, "x-dsh-marketplace-token");
}

{
  const { auth } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  check("回环写放行", await auth.isWriteAllowed(req), true);
}

{
  const { auth } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "192.168.1.5:3080" },
    socket: { remoteAddress: "192.168.1.5" }
  };
  check("LAN 写需 token", await auth.isWriteAllowed(req), false);
}

{
  const { auth } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "192.168.1.5:3080", "x-dsh-marketplace-token": "a".repeat(64) },
    socket: { remoteAddress: "192.168.1.5" }
  };
  check("LAN 写带正确 token 放行", await auth.isWriteAllowed(req), true);
}

{
  const { auth } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "192.168.1.5:3080", "x-dsh-marketplace-token": "b".repeat(64) },
    socket: { remoteAddress: "192.168.1.5" }
  };
  check("LAN 写错误 token 拒绝", await auth.isWriteAllowed(req), false);
}

{
  const { auth } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "192.168.1.5:3080", "x-dsh-marketplace-token": "short" },
    socket: { remoteAddress: "192.168.1.5" }
  };
  check("token 长度不同直接拒绝", await auth.isWriteAllowed(req), false);
}

{
  const { auth, calls } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "192.168.1.5:3080", "x-dsh-marketplace-token": "a".repeat(64) },
    socket: { remoteAddress: "192.168.1.5" }
  };
  await auth.isWriteAllowed(req);
  check("LAN 分支读取配置", calls.includes("readConfig"), true);
}

{
  const { auth } = makeAuth({ readConfig: async () => null });
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "192.168.1.5:3080", "x-dsh-marketplace-token": "a".repeat(64) },
    socket: { remoteAddress: "192.168.1.5" }
  };
  check("lanWrite 未开启拒绝", await auth.isWriteAllowed(req), false);
}

{
  const { auth } = makeAuth({ readConfig: async () => { throw new Error("ENOENT"); } });
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "192.168.1.5:3080", "x-dsh-marketplace-token": "a".repeat(64) },
    socket: { remoteAddress: "192.168.1.5" }
  };
  check("配置读取失败视为未开启", await auth.isWriteAllowed(req), false);
}

{
  const { auth } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    socket: { remoteAddress: "::ffff:127.0.0.1" }
  };
  check("IPv4-mapped IPv6 归一放行", await auth.isWriteAllowed(req), true);
}

{
  const { auth } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    socket: { remoteAddress: "10.0.0.5" }
  };
  check("非回环 socket 不直接放行", await auth.isWriteAllowed(req), false);
}

{
  const { auth } = makeAuth();
  const req = {
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  check("回环分支不读配置", await auth.isWriteAllowed(req), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
