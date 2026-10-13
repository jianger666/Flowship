/**
 * 「什么都没设置的测试」探针（事故现场的形状）。
 *
 * 一个没自己改 FLOWSHIP_DATA_DIR 的测试：静态 import task-fs（DATA_DIR 在模块加载时钉死），
 * 再调一个会触发惰性 boot-recovery 的 API——2026-10-09 就是这个形状的测试在 agent shell 里
 * 带着正式数据目录跑，把别的聊天标成了「已中断」。
 *
 * 平时它就是两条普通的隔离断言；真正的用途是被 tests/hermetic-vitest-env.test.ts 用
 * 「继承了桌面包数据目录」的环境单独拉起来，再由那边检查假的桌面包数据有没有被动过。
 * 别往里加需要特定环境的断言，也别改名（那边按文件名拉它）。
 */
import os from "node:os";
import { describe, expect, it } from "vitest";

import { isAppUserDataPath } from "@/lib/server/app-data-dir";
import { listTasks } from "@/lib/server/task-fs";
import { taskDir } from "@/lib/server/task-fs-core";

describe("没自己设置 FLOWSHIP_DATA_DIR 的测试（事故现场的形状）", () => {
  it("DATA_DIR 落在临时目录、不是桌面包的数据目录", () => {
    const dir = taskDir("probe");
    expect(isAppUserDataPath(dir)).toBe(false);
    expect(dir.startsWith(os.tmpdir())).toBe(true);
  });

  it("调会触发惰性 boot-recovery 的 API 不会出事", async () => {
    await expect(listTasks()).resolves.toBeDefined();
  });
});
