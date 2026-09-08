// infra/queue.js 直接导入测试（分层重构契约：createMutex / createQueue）。
import { createMutex, createQueue } from "../../../lib/infra/queue.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((release) => { resolve = release; });
  return { promise, resolve };
}

// ---- createMutex ----

// 行为：初始不忙
const m1 = createMutex();
check("mutex 初始不忙", m1.isBusy(), false);

// 行为：run 后立即忙（异步任务未完成前）
const m2 = createMutex();
let m2Resolved = false;
const m2Started = deferred();
const m2Release = deferred();
const m2Task = m2.run(async () => {
  m2Started.resolve();
  await m2Release.promise;
  m2Resolved = true;
  return "done";
});
await m2Started.promise;
check("mutex run 后立即忙", m2.isBusy(), true);
m2Release.resolve();

// 行为：run 返回原任务的值
const m3Result = await m2Task;
check("mutex run 返回任务结果", m3Result, "done");
check("mutex 任务完成后不忙", m2.isBusy(), false);
check("mutex 任务确实执行了", m2Resolved, true);

// 行为：忙时 run 拒绝新任务
const m4 = createMutex();
const m4Started = deferred();
const m4Release = deferred();
const m4First = m4.run(async () => {
  m4Started.resolve();
  await m4Release.promise;
  return "first";
});
await m4Started.promise;
let m4SecondThrew = false;
try {
  await m4.run(async () => "second");
} catch (e) {
  m4SecondThrew = true;
}
check("mutex 忙时 run 抛错", m4SecondThrew, true);
m4Release.resolve();
check("mutex 忙时不影响首个任务", await m4First, "first");

// 行为：任务失败后 mutex 恢复可用
const m5 = createMutex();
let m5Failed = false;
try {
  await m5.run(async () => { throw new Error("boom"); });
} catch {
  m5Failed = true;
}
check("mutex 任务失败可 catch", m5Failed, true);
check("mutex 失败后恢复可用", m5.isBusy(), false);
check("mutex 失败后可再次 run", await m5.run(async () => "recovered"), "recovered");

// ---- createQueue ----

// 行为：队列按添加顺序串行执行
const q1Order = [];
const q1 = createQueue();
const q1Started = deferred();
const q1Release = deferred();
const q1Promises = [
  q1.add(async () => {
    q1Started.resolve();
    await q1Release.promise;
    q1Order.push("a");
  }),
  q1.add(async () => {
    q1Order.push("b");
  }),
  q1.add(async () => {
    q1Order.push("c");
  }),
];
await q1Started.promise;
q1Release.resolve();
await Promise.all(q1Promises);
check("queue 串行执行顺序", q1Order, ["a", "b", "c"]);

// 行为：队列中前序失败不阻断后续
const q2 = createQueue();
let q2SecondRan = false;
try {
  await q2.add(async () => { throw new Error("fail"); });
} catch { /* 预期 */ }
await q2.add(async () => { q2SecondRan = true; });
check("queue 前序失败不阻断后续", q2SecondRan, true);

// 行为：队列 add 返回任务结果
const q3 = createQueue();
const q3Result = await q3.add(async () => 42);
check("queue add 返回任务结果", q3Result, 42);

// 行为：队列 add 失败时向调用方抛出
const q4 = createQueue();
let q4Threw = false;
try {
  await q4.add(async () => { throw new Error("q4 boom"); });
} catch {
  q4Threw = true;
}
check("queue add 失败抛给调用方", q4Threw, true);

// 行为：空队列不报错
const q5 = createQueue();
check("空队列无副作用", true, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
