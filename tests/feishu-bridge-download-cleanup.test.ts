/**
 * 下载失败 / 超时被杀后，lark-cli 可能已写出的半截 `dl-*` 产物要清掉（评审 R1-22）：
 * 没人持有它的路径，只靠 30 天 TTL 清扫兜底的话，大文件下载超时一次就是几十 MB 残留。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-dl-clean-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const { __setLarkExecForTest, downloadMessageResource } = await import(
  "@/lib/server/feishu-bridge/lark-api"
);

const bridgeDir = () => path.join(TMP, "data", "feishu-bridge");

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(bridgeDir(), { recursive: true });
});

afterEach(async () => {
  __setLarkExecForTest(null);
  await fs.rm(TMP, { recursive: true, force: true });
});

const outNameOf = (args: string[]): string => args[args.indexOf("--output") + 1]!;

describe("downloadMessageResource：失败 / 超时后清半截产物", () => {
  it("CLI 写了半截文件后超时被杀 → 抛错的同时清掉半截（含按 Content-Disposition 改了扩展名的变体）；不碰别的文件", async () => {
    await fs.writeFile(path.join(bridgeDir(), "bridge-state.json"), "{}", "utf-8");
    await fs.writeFile(path.join(bridgeDir(), "dl-1-other-download"), "别的下载", "utf-8");
    __setLarkExecForTest(async (_file, args, opts) => {
      const out = outNameOf(args);
      await fs.writeFile(path.join(opts.cwd!, out), "半截数据", "utf-8");
      await fs.writeFile(path.join(opts.cwd!, `${out}.pdf`), "半截数据2", "utf-8");
      throw Object.assign(new Error("Command failed: lark-cli ..."), { killed: true, code: null });
    });
    await expect(downloadMessageResource("om_x", "file_key_1", "file")).rejects.toThrow();
    const left = (await fs.readdir(bridgeDir())).sort();
    expect(left).toEqual(["bridge-state.json", "dl-1-other-download"]);
  });

  it("某个半截文件删不掉（EBUSY / EPERM）：不影响同批其余半截被清（每条各自 try/catch，不是整个循环一个 try）", async () => {
    __setLarkExecForTest(async (_file, args, opts) => {
      const out = outNameOf(args);
      await fs.writeFile(path.join(opts.cwd!, out), "半截1", "utf-8");
      await fs.writeFile(path.join(opts.cwd!, `${out}.pdf`), "半截2", "utf-8");
      await fs.writeFile(path.join(opts.cwd!, `${out}.zip`), "半截3", "utf-8");
      throw Object.assign(new Error("Command failed: lark-cli ..."), { killed: true, code: null });
    });
    // 第一次 rm 失败（不论 readdir 把哪个排在前面），之后照常删
    const rmSpy = vi
      .spyOn(fs, "rm")
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      });
    try {
      await expect(downloadMessageResource("om_x", "file_key_3", "file")).rejects.toThrow();
      expect(rmSpy.mock.calls.length).toBe(3); // 三个都尝试了（旧逻辑第一个抛错后循环就断了，只试 1 次）
    } finally {
      rmSpy.mockRestore();
    }
    const left = await fs.readdir(bridgeDir());
    expect(left).toHaveLength(1); // 只剩那个被模拟成删不掉的；其余两个已清
  });

  it("下载成功：产物照常返回、不被清理", async () => {
    __setLarkExecForTest(async (_file, args, opts) => {
      await fs.writeFile(path.join(opts.cwd!, outNameOf(args)), "完整数据", "utf-8");
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    });
    const abs = await downloadMessageResource("om_x", "file_key_2", "file");
    expect(await fs.readFile(abs, "utf-8")).toBe("完整数据");
  });
});
