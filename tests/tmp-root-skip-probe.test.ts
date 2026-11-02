/**
 * 「整个文件的用例全被 skip」探针：vitest 不会为全 skip 的文件跑任何 hook（beforeEach / afterAll 都不跑），
 * 它的私有 tmp 根（见 tests/setup/hermetic-env.ts）只能靠 worker 被回收时的收尾兜底删掉。
 *
 * 平时它就是一个永久 skip 的占位用例；真正的用途是被 tests/hermetic-vitest-env.test.ts 单独拉起来
 * （设了 FLOWSHIP_TMP_PROBE_OUT），模块顶层（skip 的文件也会执行）把「这次的 tmp 根」写出去，
 * 由那边在子进程退出后确认它不在了。别改名（那边按文件名拉它）。
 */
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";

const out = process.env.FLOWSHIP_TMP_PROBE_OUT;
if (out) fs.writeFileSync(out, JSON.stringify({ tmpRoot: os.tmpdir() }));

describe.skip("全 skip 文件的私有 tmp 根探针", () => {
  it("永远不会跑", () => {
    expect(true).toBe(true);
  });
});
