// 并发控制基础设施（分层重构：纯逻辑，零 IO 零宿主依赖）。
// createMutex — 安装互斥（installRunning 同款语义）
// createQueue — Promise 链串行化（installedQueue/patchQueue 同款语义）

/**
 * 单飞互斥锁：同一时刻只允许一个任务运行。
 * - run(fn)：执行异步任务，忙时抛 Error
 * - isBusy()：查询是否正在运行
 * - 任务完成（含失败）后自动释放
 *
 * 对应 index.js 的 installRunning 模式：安装/卸载路由先查 isBusy，
 * 通过后 run 包裹任务，finally 自动清除。
 */
function createMutex() {
  let running = null;
  return {
    isBusy() {
      return running !== null;
    },
    async run(fn) {
      if (running !== null) throw new Error("mutex is busy");
      const task = (async () => fn())();
      running = task;
      try {
        return await task;
      } finally {
        running = null;
      }
    },
  };
}

/**
 * Promise 链串行化队列：按 add 顺序逐个执行，前序失败不阻断后续。
 * - add(fn)：加入队列并返回本任务的结果；前序失败时本任务仍会执行
 *
 * 对应 index.js 的 installedQueue/patchQueue 模式：
 *   queue = queue.catch(() => {}).then(() => task);
 * catch 隔离前序错误，then 串行执行下一个。
 */
function createQueue() {
  let chain = Promise.resolve();
  return {
    add(fn) {
      const task = chain.catch(() => {}).then(() => fn());
      chain = task;
      return task;
    },
  };
}

export { createMutex, createQueue };
