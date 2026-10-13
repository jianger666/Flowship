/**
 * vitest setupFiles：每个测试文件在 import 任何被测模块之前先把进程环境隔离干净。
 * 逻辑与原因见 tests/helpers/hermetic-env.ts（文件名故意不带 .test，不会被当成测试收集）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach } from "vitest";

import { applyHermeticEnv, assertEnvNotAppData } from "../helpers/hermetic-env";

const { dataDir } = applyHermeticEnv(process.env, () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-vitest-data-")),
);

beforeEach(() => {
  assertEnvNotAppData(process.env);
});

afterAll(() => {
  // 尽力清理：个别测试的异步写入可能还在落盘，清不掉就留给系统清 tmp，别让清理失败拖红测试
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* ignore */
  }
});
