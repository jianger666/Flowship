/**
 * 「测试里 mkdtemp 了却没清」探针：每个测试文件一个私有 tmp 根（见 tests/setup/hermetic-env.ts），
 * 文件收尾由 setup 整棵删，测试自己忘了清也不会在系统 tmp 里留残留。
 *
 * 平时它就是两条普通断言（os.tmpdir() 是私有根、里面建的目录落在根里）；真正的用途是被
 * tests/hermetic-vitest-env.test.ts 单独拉起来（设了 FLOWSHIP_TMP_PROBE_OUT），把「这次的 tmp 根」和「故意没清的目录」
 * 写到那个文件里，由那边在子进程退出后确认它们都不在了。别改名（那边按文件名拉它）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("私有 tmp 根探针", () => {
  const leaked = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-root-probe-leak-"));
  fs.writeFileSync(path.join(leaked, "x.txt"), "x");

  it("os.tmpdir() 是本文件私有的 fvt-* 根，故意不清的目录落在它里面", () => {
    expect(path.basename(os.tmpdir())).toMatch(/^fvt-/);
    expect(leaked.startsWith(os.tmpdir() + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(leaked, "x.txt"))).toBe(true);
  });

  it("需要时把 tmp 根与泄漏目录的路径写给外层检查", () => {
    const out = process.env.FLOWSHIP_TMP_PROBE_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify({ tmpRoot: os.tmpdir(), leaked, dataDir: process.env.FLOWSHIP_DATA_DIR }));
    expect(true).toBe(true);
  });
});
