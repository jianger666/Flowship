/**
 * vitest setupFiles：每个测试文件在 import 任何被测模块之前先把进程环境隔离干净。
 * 逻辑与原因见 tests/helpers/hermetic-env.ts（文件名故意不带 .test，不会被当成测试收集）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach } from "vitest";

import { applyHermeticEnv, assertEnvNotAppData } from "../helpers/hermetic-env";

// 模块加载时（任何用例装假定时器之前）就抓住真 setTimeout：用了 `vi.useFakeTimers()` 的文件，
// 收尾时全局 setTimeout 已是假的、永远不触发，下面的让出会把 afterAll 卡到 hook 超时。
const realSetTimeout = globalThis.setTimeout;

const { dataDir } = applyHermeticEnv(process.env, () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-vitest-data-")),
);

beforeEach(() => {
  assertEnvNotAppData(process.env);
});

afterAll(async () => {
  // 文件收尾先让出一小段：测试里没人 await 的 fire-and-forget 写盘（appendEvent 的 meta touch、事件 / seq sidecar、
  // 飞书桥的落盘……）常在最后一个用例之后才落完。这时目录一被下面删掉，它们就 ENOENT、各打一条 console.warn，
  // 而这条日志常落在文件收尾之后——vitest 关 worker 的 rpc 时还有一条没送完，整次运行报
  // `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`、退出码 1（Linux CI 上红过一次）。
  // 这是时间裕量、不是同步点：只覆盖「落盘链在 50ms 内走完」的常见情形；各文件自己清目录前该等的锁仍要自己等。
  await new Promise<void>((r) => realSetTimeout(r, 50));
  // 尽力清理：个别测试的异步写入可能还在落盘，清不掉就留给系统清 tmp，别让清理失败拖红测试
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* ignore */
  }
});
