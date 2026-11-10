/**
 * R2-10：上传守卫的两处补强（黑名单的向量在 tests/helpers/browser-v3-vectors.ts，两侧各跑一遍，这里不重复）：
 *  ① Windows 语义的路径在「整条校验链」里被拒（不只是 findSensitiveRule 单函数）；
 *  ② revalidateUploadFiles 在文件系统不提供有效 ino 时退回比较 size + mtimeMs（旧版 undefined !== undefined 恒放行）。
 */
import { describe, expect, it } from "vitest";

import { revalidateUploadFiles, validateUploadFiles } from "../electron-app/browser/upload-guard.mjs";
import { checkUploadPaths, type UploadPolicyEnv } from "@/lib/server/browser/upload-policy";

type StatShape = { isFile: () => boolean; size: number; ino?: number; dev?: number; mtimeMs?: number };

/** 可在两次校验之间改 stat 结果的假 fs（realpath 恒等） */
const makeFs = (init: Partial<StatShape> = {}) => {
  const state: { ino?: number; dev?: number; size: number | undefined; mtimeMs?: number } = { size: 5, ...init };
  const fs = {
    realpath: async (p: string) => p,
    stat: async (): Promise<StatShape> => ({ isFile: () => true, size: state.size as number, ino: state.ino, dev: state.dev, mtimeMs: state.mtimeMs }),
  };
  return { state, fs };
};

const FILE = "/work/proj/a.png";
const firstCheck = async (init: Partial<StatShape>) => {
  const h = makeFs(init);
  const files = await validateUploadFiles([FILE], { fs: h.fs, platform: "darwin" });
  return { ...h, files };
};
const recheckError = async (files: unknown[], fs: ReturnType<typeof makeFs>["fs"]): Promise<string | null> => {
  try {
    await revalidateUploadFiles(files as never, { fs });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("R2-10 ②：Windows 路径语义的路径在整条校验链里被拒", () => {
  const winPaths = [
    "C:\\work\\server.pem.",
    "C:\\work\\server.pem ",
    "C:\\work\\x.key::$DATA",
    "C:\\work\\x.pem:Zone.Identifier",
    "C:\\Users\\me\\.ssh.\\id_rsa",
    "C:\\Users\\me\\.ssh::$INDEX_ALLOCATION\\id_rsa",
  ];

  it("主进程 validateUploadFiles：在碰任何 fs 之前就按黑名单拒绝（fs 一个都不该被调用）", async () => {
    let touched = 0;
    const fs = {
      realpath: async (p: string) => {
        touched += 1;
        return p;
      },
      stat: async () => {
        touched += 1;
        return { isFile: () => true, size: 1 };
      },
    };
    for (const p of winPaths) {
      await expect(validateUploadFiles([p], { fs, platform: "win32" }), p).rejects.toThrow(/出于安全考虑拒绝/);
    }
    expect(touched).toBe(0);
  });

  it("server checkUploadPaths：同样在碰文件本身之前以 blacklist 拒绝（只允许解析白名单根目录 C:\\work）", async () => {
    let touched = 0;
    const fs = {
      realpath: async (p: string) => {
        if (p !== "C:\\work") touched += 1; // 白名单根的 realpath 是每次调用的固定开销，不算
        return p;
      },
      stat: async () => {
        touched += 1;
        return { isFile: () => true, size: 1 };
      },
    };
    const env: UploadPolicyEnv = { platform: "win32", allowedRoots: ["C:\\work"], dataRoots: [], allowedUnderData: [] };
    for (const p of winPaths) {
      const v = await checkUploadPaths([p], env, fs);
      expect(v, p).toMatchObject({ ok: false, rule: "blacklist" });
    }
    expect(touched).toBe(0);
  });
});

describe("R2-10 ③：revalidateUploadFiles 在没有有效 ino 时退回 size + mtimeMs", () => {
  it("validateUploadFiles 的返回项带 mtimeMs（取自 stat）", async () => {
    const { files } = await firstCheck({ ino: 7, dev: 1, mtimeMs: 1700000000000 });
    expect(files[0]).toMatchObject({ ino: 7, dev: 1, mtimeMs: 1700000000000 });
  });

  it("ino 两次都缺失、size / mtime 没变 → 通过（文件系统不给 ino 不该一律拒）", async () => {
    const { fs, files } = await firstCheck({ mtimeMs: 1000 });
    expect(await recheckError(files, fs)).toBeNull();
  });

  it("ino 两次都缺失、size 变了 → 拒绝（旧版 undefined !== undefined 为假，恒放行）", async () => {
    const { fs, state, files } = await firstCheck({ mtimeMs: 1000 });
    state.size = 6;
    expect(await recheckError(files, fs)).toMatch(/发生了变化.*不提供文件标识/);
  });

  it("ino 两次都缺失、mtime 变了 → 拒绝", async () => {
    const { fs, state, files } = await firstCheck({ mtimeMs: 1000 });
    state.mtimeMs = 2000;
    expect(await recheckError(files, fs)).toMatch(/发生了变化/);
  });

  it("ino 为 0（部分文件系统的占位值）按缺失处理：回退比对，size 变了 → 拒绝；没变 → 通过", async () => {
    const same = await firstCheck({ ino: 0, dev: 1, mtimeMs: 1000 });
    expect(await recheckError(same.files, same.fs)).toBeNull();
    const changed = await firstCheck({ ino: 0, dev: 1, mtimeMs: 1000 });
    changed.state.size = 9;
    expect(await recheckError(changed.files, changed.fs)).toMatch(/发生了变化/);
  });

  it("mtimeMs 一次有一次没有 → 视为不一致；两次都没有则只比 size（mtime 缺失不等于放行 size 变化）", async () => {
    const a = await firstCheck({ mtimeMs: 1000 });
    a.state.mtimeMs = undefined;
    expect(await recheckError(a.files, a.fs)).toMatch(/发生了变化/);
    // 反方向：首次没有、复检才有 mtime，同样是「取值方式变了」
    const c = await firstCheck({});
    c.state.mtimeMs = 1000;
    expect(await recheckError(c.files, c.fs)).toMatch(/发生了变化/);
    const b = await firstCheck({});
    expect(await recheckError(b.files, b.fs)).toBeNull();
    b.state.size = 7;
    expect(await recheckError(b.files, b.fs)).toMatch(/发生了变化/);
  });

  it("首次校验的结果里没有 size（不是 validateUploadFiles 的返回值）且没有 ino：没东西可比，fail-closed 拒绝", async () => {
    const { fs } = makeFs({});
    expect(await recheckError([{ path: FILE, name: "a.png" }], fs)).toMatch(/发生了变化/);
  });

  it("两次 stat 都拿不到 size（且没有 ino）：`undefined === undefined` 不能当成「没变」，fail-closed 拒绝", async () => {
    const { fs, state } = makeFs({});
    state.size = undefined;
    expect(await recheckError([{ path: FILE, name: "a.png" }], fs)).toMatch(/发生了变化/);
  });

  it("一次有 ino、一次没有（换了文件系统 / 取值方式）→ 仍按「被替换」拒绝", async () => {
    const a = await firstCheck({ ino: 100, dev: 1, mtimeMs: 1000 });
    a.state.ino = undefined;
    expect(await recheckError(a.files, a.fs)).toMatch(/被替换/);
    const b = await firstCheck({ mtimeMs: 1000 });
    b.state.ino = 100;
    expect(await recheckError(b.files, b.fs)).toMatch(/被替换/);
  });

  it("两次都有有效 ino：仍只按 ino / dev 判（mtime 变了不误拒；ino 变了拒绝）——不因加了退路而放宽或收紧", async () => {
    const ok = await firstCheck({ ino: 100, dev: 1, mtimeMs: 1000 });
    ok.state.mtimeMs = 5000;
    expect(await recheckError(ok.files, ok.fs)).toBeNull();
    const swapped = await firstCheck({ ino: 100, dev: 1, mtimeMs: 1000 });
    swapped.state.ino = 101;
    expect(await recheckError(swapped.files, swapped.fs)).toMatch(/被替换/);
    const dev = await firstCheck({ ino: 100, dev: 1, mtimeMs: 1000 });
    dev.state.dev = 2;
    expect(await recheckError(dev.files, dev.fs)).toMatch(/被替换/);
  });
});
