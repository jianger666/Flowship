/**
 * V3 主进程侧上传守卫（electron-app/browser/upload-guard.mjs + ops/env.mjs 的纯部分）。
 * 黑名单 / 形状向量与 server 侧 upload-policy.ts 共用（tests/helpers/browser-v3-vectors.ts），见 browser-v3-upload-policy.test.ts。
 */
import { describe, expect, it } from "vitest";

import { EXTRA_OPS } from "../electron-app/browser/ops/index.mjs";
import { OPS, createHandlers, describeUpload, normalize, taskDataAllowDirs } from "../electron-app/browser/ops/env.mjs";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { createDownloadRegistry } from "../electron-app/browser/downloads.mjs";
import {
  MAX_UPLOAD_BYTES,
  checkUploadShape,
  findSensitiveRule,
  isAppUserDataLike,
  revalidateUploadFiles,
  validateUploadFiles,
} from "../electron-app/browser/upload-guard.mjs";

import { PLATFORM_SHAPE_VECTORS, SENSITIVE_VECTORS, SHAPE_VECTORS } from "./helpers/browser-v3-vectors";

type FakeEntry = { size?: number; dir?: boolean; ino?: number; dev?: number };
const makeFs = (files: Record<string, FakeEntry>, links: Record<string, string> = {}) => {
  const resolveLinks = (p: string) => {
    for (const [from, to] of Object.entries(links)) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
    return p;
  };
  return {
    realpath: async (p: string) => {
      const r = resolveLinks(p);
      if (!(r in files)) throw new Error("ENOENT");
      return r;
    },
    stat: async (p: string) => {
      const f = files[p];
      if (!f) throw new Error("ENOENT");
      return { isFile: () => !f.dir, size: f.size ?? 10, ino: f.ino, dev: f.dev };
    },
  };
};

describe("upload-guard：共用向量", () => {
  it.each(SENSITIVE_VECTORS)("黑名单 $path → $hit（$note）", (v) => {
    const hit = findSensitiveRule(v.path, { dataRoots: v.dataRoots, allowedUnderData: v.allowedUnderData });
    expect(hit?.rule ?? null).toBe(v.hit);
  });

  it.each(SHAPE_VECTORS)("形状 $note → ok=$ok", (v) => {
    expect(checkUploadShape(v.path, { platform: "darwin" }).ok).toBe(v.ok);
  });

  // R1-11：在 posix 机器上通过注入 platform 测 win32 分支
  it.each(PLATFORM_SHAPE_VECTORS)("形状[$platform] $note → ok=$ok", (v) => {
    expect(checkUploadShape(v.path, { platform: v.platform }).ok).toBe(v.ok);
  });

  it("R1-11：win32 的 UNC 拒绝文案点明原因（网络共享 / UNC）", () => {
    const r = checkUploadShape("\\\\evil\\share\\a.txt", { platform: "win32" });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/UNC|网络共享/);
  });

  it("win32：盘符路径是绝对路径，POSIX 相对路径仍不是", () => {
    expect(checkUploadShape("C:\\Users\\me\\a.txt", { platform: "win32" }).ok).toBe(true);
    expect(checkUploadShape("a\\b.txt", { platform: "win32" }).ok).toBe(false);
    expect(checkUploadShape("C:\\Users\\..\\Windows\\a.txt", { platform: "win32" }).ok).toBe(false);
  });

  it("isAppUserDataLike：需要 <appData> + 目录名两段", () => {
    expect(isAppUserDataLike("/Users/me/Library/Application Support/fe-ai-flow/x")).toBe(true);
    expect(isAppUserDataLike("/Users/me/fe-ai-flow/data/x")).toBe(false);
  });
});

describe("validateUploadFiles", () => {
  const files = {
    "/work/proj/a.png": { size: 123 },
    "/work/proj/b.txt": { size: 4 },
    "/work/proj/dir": { dir: true },
    "/work/proj/huge.bin": { size: MAX_UPLOAD_BYTES + 1 },
    "/work/proj/exact.bin": { size: MAX_UPLOAD_BYTES },
    "/work/proj/.env": { size: 3 },
    "/Users/me/.ssh/id_rsa": { size: 3 },
    "/etc/hosts": { size: 3 },
    "/data/flowship/tasks/t1/uploads/p.png": { size: 7 },
    "/data/flowship/tasks/t1/meta.json": { size: 7 },
  };
  const links = { "/work/proj/innocent.txt": "/Users/me/.ssh/id_rsa", "/work/proj/hosts.txt": "/etc/hosts" };
  const fsx = makeFs(files, links);
  const base = { fs: fsx, platform: "darwin" };

  it("正常：返回 realpath / 文件名 / 大小，保持顺序", async () => {
    const out = await validateUploadFiles(["/work/proj/b.txt", "/work/proj/a.png"], base);
    expect(out).toEqual([
      { path: "/work/proj/b.txt", name: "b.txt", size: 4 },
      { path: "/work/proj/a.png", name: "a.png", size: 123 },
    ]);
  });

  it("恰好 100MB 放行，超 1 字节拒绝", async () => {
    await expect(validateUploadFiles(["/work/proj/exact.bin"], base)).resolves.toHaveLength(1);
    await expect(validateUploadFiles(["/work/proj/huge.bin"], base)).rejects.toThrow(/100MB/);
  });

  it("数量：0 个 / 11 个 / 非数组都拒", async () => {
    await expect(validateUploadFiles([], base)).rejects.toThrow(/至少/);
    await expect(validateUploadFiles(Array(11).fill("/work/proj/a.png"), base)).rejects.toThrow(/最多上传 10/);
    await expect(validateUploadFiles("/work/proj/a.png" as unknown as string[], base)).rejects.toThrow();
  });

  it("不存在 / 目录 / 相对路径 / .. 越界", async () => {
    await expect(validateUploadFiles(["/work/proj/none.txt"], base)).rejects.toThrow(/不存在/);
    await expect(validateUploadFiles(["/work/proj/dir"], base)).rejects.toThrow(/不是普通文件/);
    await expect(validateUploadFiles(["a.png"], base)).rejects.toThrow(/绝对路径/);
    await expect(validateUploadFiles(["/work/proj/../../etc/hosts"], base)).rejects.toThrow(/\.\./);
  });

  it("黑名单：原路径命中直接拒；符号链接指向受保护文件也拒（realpath 再查一次）", async () => {
    await expect(validateUploadFiles(["/work/proj/.env"], base)).rejects.toThrow(/安全/);
    await expect(validateUploadFiles(["/Users/me/.ssh/id_rsa"], base)).rejects.toThrow(/安全/);
    await expect(validateUploadFiles(["/work/proj/innocent.txt"], base)).rejects.toThrow(/符号链接/);
  });

  it("符号链接指向普通文件：返回 realpath（防校验后换链接）", async () => {
    const out = await validateUploadFiles(["/work/proj/hosts.txt"], base);
    expect(out[0].path).toBe("/etc/hosts");
  });

  it("任一文件不合规整批拒绝", async () => {
    await expect(validateUploadFiles(["/work/proj/a.png", "/work/proj/.env"], base)).rejects.toThrow(/安全/);
  });

  it("R1-11：win32 的 UNC / 设备路径在任何 realpath / stat 之前就被拒（不会触发 SMB / NTLM 外联）", async () => {
    const calls: string[] = [];
    const spyFs = {
      realpath: async (p: string) => {
        calls.push(`realpath ${p}`);
        return p;
      },
      stat: async (p: string) => {
        calls.push(`stat ${p}`);
        return { isFile: () => true, size: 1 };
      },
    };
    for (const p of ["\\\\evil\\s\\a.txt", "//evil/s/a.txt", "\\\\?\\UNC\\evil\\s\\a.txt", "\\\\.\\pipe\\x"]) {
      await expect(validateUploadFiles([p], { fs: spyFs, platform: "win32" }), p).rejects.toThrow(/UNC|网络共享/);
    }
    // 整批里混了 UNC：整批拒绝，且 UNC 那一项自己一次 fs 调用都没有（合规的那项可以照常被 realpath）
    await expect(validateUploadFiles(["C:\\work\\a.txt", "\\\\evil\\s\\b.txt"], { fs: spyFs, platform: "win32" })).rejects.toThrow(/UNC/);
    expect(calls.filter((c) => c.includes("evil"))).toEqual([]);
  });

  it("R1-27：新增的凭据名（id_ecdsa / .git-credentials / *.kdbx …）整批拒绝；符号链接指过去也拒", async () => {
    const f = makeFs(
      { "/work/proj/id_ecdsa": { size: 3 }, "/work/proj/.git-credentials": { size: 3 }, "/work/proj/vault.kdbx": { size: 3 }, "/Users/me/.pgpass": { size: 3 } },
      { "/work/proj/innocent.txt": "/Users/me/.pgpass" },
    );
    for (const p of ["/work/proj/id_ecdsa", "/work/proj/.git-credentials", "/work/proj/vault.kdbx"]) {
      await expect(validateUploadFiles([p], { fs: f, platform: "darwin" }), p).rejects.toThrow(/安全/);
    }
    await expect(validateUploadFiles(["/work/proj/innocent.txt"], { fs: f, platform: "darwin" })).rejects.toThrow(/符号链接/);
  });

  it("R1-27：返回项带 ino / dev 指纹（取自 stat），没有指纹的假 fs 为 undefined", async () => {
    const f = makeFs({ "/work/proj/a.png": { size: 1, ino: 77, dev: 5 }, "/work/proj/b.png": { size: 1 } });
    const out = await validateUploadFiles(["/work/proj/a.png", "/work/proj/b.png"], { fs: f, platform: "darwin" });
    expect(out[0]).toMatchObject({ path: "/work/proj/a.png", ino: 77, dev: 5 });
    expect(out[1].ino).toBeUndefined();
  });

  it("数据目录：默认拒；本任务 uploads 豁免；别的文件仍拒", async () => {
    const dataRoots = ["/data/flowship"];
    await expect(validateUploadFiles(["/data/flowship/tasks/t1/uploads/p.png"], { ...base, dataRoots })).rejects.toThrow(/数据目录/);
    const allowedUnderData = ["/data/flowship/tasks/t1/uploads"];
    await expect(validateUploadFiles(["/data/flowship/tasks/t1/uploads/p.png"], { ...base, dataRoots, allowedUnderData })).resolves.toHaveLength(1);
    await expect(validateUploadFiles(["/data/flowship/tasks/t1/meta.json"], { ...base, dataRoots, allowedUnderData })).rejects.toThrow(/数据目录/);
  });
});

/** 可在两次校验之间「换文件」的假 fs：realpath 指向哪、ino / dev / 大小是多少都由 state 决定 */
const makeSwappableFs = () => {
  const state = { realpathTo: "/work/proj/a.png" as string | null, ino: 100, dev: 1, size: 5, isFile: true };
  const fsx = {
    realpath: async (p: string) => {
      if (p !== "/work/proj/a.png") return p;
      if (state.realpathTo === null) throw new Error("ENOENT");
      return state.realpathTo;
    },
    stat: async () => ({ isFile: () => state.isFile, size: state.size, ino: state.ino, dev: state.dev }),
  };
  return { state, fs: fsx };
};

describe("revalidateUploadFiles（R1-27 TOCTOU：交给页面前紧贴着再校验）", () => {
  const first = async () => {
    const sw = makeSwappableFs();
    const files = await validateUploadFiles(["/work/proj/a.png"], { fs: sw.fs, platform: "darwin" });
    return { sw, files };
  };

  it("文件没变：通过；指纹来自首次校验", async () => {
    const { sw, files } = await first();
    expect(files[0]).toMatchObject({ ino: 100, dev: 1 });
    await expect(revalidateUploadFiles(files, { fs: sw.fs })).resolves.toBeUndefined();
  });

  it("ino 变了（文件被删后换成别的文件 / 硬链接）→ 拒绝", async () => {
    const { sw, files } = await first();
    sw.state.ino = 101;
    await expect(revalidateUploadFiles(files, { fs: sw.fs })).rejects.toThrow(/被替换/);
  });

  it("dev 变了（换到别的盘 / 挂载点）→ 拒绝", async () => {
    const { sw, files } = await first();
    sw.state.dev = 2;
    await expect(revalidateUploadFiles(files, { fs: sw.fs })).rejects.toThrow(/被替换/);
  });

  it("换成指向凭据文件的符号链接（即使 ino / dev 碰巧一样）→ 黑名单拒绝，错误里不带完整路径", async () => {
    const { sw, files } = await first();
    sw.state.realpathTo = "/Users/me/.ssh/id_rsa";
    const err = await revalidateUploadFiles(files, { fs: sw.fs }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/安全|受保护/);
    expect(err?.message).not.toContain("/Users/me");
  });

  it("换成指向 Flowship 数据目录的符号链接 → 数据目录规则同样生效", async () => {
    const { sw, files } = await first();
    sw.state.realpathTo = "/data/flowship/tasks/t9/meta.json";
    await expect(revalidateUploadFiles(files, { fs: sw.fs, dataRoots: ["/data/flowship"] })).rejects.toThrow(/数据目录/);
  });

  it("文件被删 / 变成目录 / 长大超过 100MB → 拒绝", async () => {
    const a = await first();
    a.sw.state.realpathTo = null;
    await expect(revalidateUploadFiles(a.files, { fs: a.sw.fs })).rejects.toThrow(/消失/);
    const b = await first();
    b.sw.state.isFile = false;
    await expect(revalidateUploadFiles(b.files, { fs: b.sw.fs })).rejects.toThrow(/非普通文件/);
    const c = await first();
    c.sw.state.size = MAX_UPLOAD_BYTES + 1;
    await expect(revalidateUploadFiles(c.files, { fs: c.sw.fs })).rejects.toThrow(/100MB/);
  });

  it("首次没取到指纹（undefined）而复检取到了 → 视为变化，宁可错拒", async () => {
    const { sw } = await first();
    await expect(revalidateUploadFiles([{ path: "/work/proj/a.png", name: "a.png" }], { fs: sw.fs })).rejects.toThrow(/被替换/);
  });
});

describe("upload handler：setFileInputFiles 之前必须复检（R1-27）", () => {
  type Sent = Array<[string, unknown]>;
  const mkUpload = (guardFs: unknown, beforeAction?: () => void) => {
    const sent: Sent = [];
    const tab = {
      id: "t1",
      url: "https://a.test/",
      title: "A",
      navCommitted: 0,
      navStarted: 0,
      ensureCdp: async () => {},
      setAI: async () => {},
      resolveRef: () => ({ role: "textbox", name: "文件", backendNodeId: 9, sessionId: null }),
      send: async (method: string, params: unknown) => {
        sent.push([method, params]);
        return {};
      },
      mapNodeError: (e: unknown) => e,
    };
    const session = {
      tabSeq: 1,
      tabs: [tab],
      // runAction 在「首次校验之后、setFiles 之前」：这里就是攻击者换文件的时机
      runAction: async (_o: unknown, fn: (ctx: unknown) => Promise<unknown>) => {
        beforeAction?.();
        return fn({ tab, describe: () => {}, signal: undefined, tabSeqAtStart: 1 });
      },
    };
    const handlers = createHandlers({
      app: { getPath: () => "/ud" },
      log: () => {},
      getSession: () => session,
      requireSession: () => session,
      actions: {
        labelOf: () => "文件输入框",
        callOnNode: async () => ({ isFileInput: true, multiple: true, disabled: false, directory: false }),
        locate: async () => {
          throw new Error("不该走按钮路径");
        },
        settle: async () => {},
      },
      abortable: (p: Promise<unknown>) => p,
      guardFs,
    }) as unknown as { upload: (t: string, a: { ref: string; paths: string[] }) => Promise<{ files: unknown[] }> };
    return { sent, handlers };
  };
  const setCalls = (sent: Sent) => sent.filter(([m]) => m === "DOM.setFileInputFiles");
  const args = { ref: "e1", paths: ["/work/proj/a.png"] };

  it("文件没变：照常 setFileInputFiles，交给页面的是 realpath", async () => {
    const sw = makeSwappableFs();
    const { sent, handlers } = mkUpload(sw.fs);
    const r = await handlers.upload("task_1", args);
    expect(r.files).toEqual([{ name: "a.png", size: 5 }]);
    expect(setCalls(sent)).toEqual([["DOM.setFileInputFiles", { files: ["/work/proj/a.png"], backendNodeId: 9 }]]);
  });

  it("校验后文件被换（ino 变）：BAD_ARGS，且一次 setFileInputFiles 都没发", async () => {
    const sw = makeSwappableFs();
    const { sent, handlers } = mkUpload(sw.fs, () => {
      sw.state.ino = 999;
    });
    await expect(handlers.upload("task_1", args)).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/被替换/) });
    expect(setCalls(sent)).toEqual([]);
  });

  it("校验后路径被换成指向凭据文件的符号链接：BAD_ARGS，没发 setFileInputFiles", async () => {
    const sw = makeSwappableFs();
    const { sent, handlers } = mkUpload(sw.fs, () => {
      sw.state.realpathTo = "/Users/me/.ssh/id_ed25519";
    });
    await expect(handlers.upload("task_1", args)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(setCalls(sent)).toEqual([]);
  });

  it("校验后文件被删：BAD_ARGS，没发 setFileInputFiles", async () => {
    const sw = makeSwappableFs();
    const { sent, handlers } = mkUpload(sw.fs, () => {
      sw.state.realpathTo = null;
    });
    await expect(handlers.upload("task_1", args)).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/消失/) });
    expect(setCalls(sent)).toEqual([]);
  });
});

describe("taskDataAllowDirs", () => {
  it("安全 taskId → <userData>/data/tasks/<id>/{uploads,workspace}", () => {
    expect(taskDataAllowDirs("/ud", "task_1")).toEqual(["/ud/data/tasks/task_1/uploads", "/ud/data/tasks/task_1/workspace"]);
    expect(taskDataAllowDirs("/ud", "t-2", ["/custom"])).toContain("/custom/tasks/t-2/uploads");
  });
  it("不安全的 taskId（路径穿越）→ 不豁免任何目录", () => {
    expect(taskDataAllowDirs("/ud", "../other")).toEqual([]);
    expect(taskDataAllowDirs("/ud", "a/b")).toEqual([]);
    expect(taskDataAllowDirs("/ud", "")).toEqual([]);
  });
});

describe("ops/env：参数规整", () => {
  it("OPS 与总表：upload / downloads 都登记，且不与其它模块重名", () => {
    expect([...OPS]).toEqual(["upload", "downloads"]);
    expect(EXTRA_OPS).toEqual(expect.arrayContaining(["upload", "downloads"]));
    expect(new Set(EXTRA_OPS).size).toBe(EXTRA_OPS.length);
  });

  it("upload：ref 必填；paths 1–10 个非空字符串；tabId 带过", () => {
    expect(normalize("upload", { ref: "e12", paths: ["/tmp/a.txt"], tabId: "t2" }, OP_HELPERS)).toEqual({ ref: "e12", paths: ["/tmp/a.txt"], tabId: "t2" });
    expect(() => normalize("upload", { paths: ["/tmp/a"] }, OP_HELPERS)).toThrow(/ref/);
    expect(() => normalize("upload", { ref: "e1" }, OP_HELPERS)).toThrow(/paths/);
    expect(() => normalize("upload", { ref: "e1", paths: [] }, OP_HELPERS)).toThrow(/paths/);
    expect(() => normalize("upload", { ref: "e1", paths: [""] }, OP_HELPERS)).toThrow(/paths/);
    expect(() => normalize("upload", { ref: "e1", paths: [1] }, OP_HELPERS)).toThrow(/paths/);
    expect(() => normalize("upload", { ref: "e1", paths: Array(11).fill("/tmp/a") }, OP_HELPERS)).toThrow(/paths/);
  });

  it("downloads：action 必填 list|wait；timeoutMs 夹到 1000–300000，默认 30000；sinceId ≥ 0", () => {
    expect(normalize("downloads", { action: "list" }, OP_HELPERS)).toEqual({ action: "list", timeoutMs: 30_000 });
    expect(normalize("downloads", { action: "wait", sinceId: 3, timeoutMs: 10 }, OP_HELPERS)).toEqual({ action: "wait", sinceId: 3, timeoutMs: 1000 });
    expect(normalize("downloads", { action: "wait", timeoutMs: 9e9 }, OP_HELPERS)).toMatchObject({ timeoutMs: 300_000 });
    expect(normalize("downloads", { action: "wait", sinceId: -5 }, OP_HELPERS)).toMatchObject({ sinceId: 0 });
    expect(() => normalize("downloads", {}, OP_HELPERS)).toThrow(/action/);
    expect(() => normalize("downloads", { action: "clear" }, OP_HELPERS)).toThrow(/action/);
  });
});

describe("describeUpload：日志只记文件名", () => {
  it("不含目录；超过 3 个折叠", () => {
    const d = describeUpload(
      [
        { path: "/Users/secret-name/proj/a.png", name: "a.png", size: 1 },
        { path: "/Users/secret-name/proj/b.png", name: "b.png", size: 1 },
        { path: "/Users/secret-name/proj/c.png", name: "c.png", size: 1 },
        { path: "/Users/secret-name/proj/d.png", name: "d.png", size: 1 },
      ],
      "按钮「上传」",
    );
    expect(d.summary).toContain("a.png");
    expect(d.summary).toContain("等 4 个");
    expect(d.summary).not.toMatch(/secret-name|\/Users/);
    expect(d.label).toBe("上传 4 个文件");
  });
});

describe("downloads handler（假会话）", () => {
  const mkHandlers = (session: unknown) =>
    createHandlers({
      app: { getPath: () => "/ud" },
      log: () => {},
      getSession: () => session,
      requireSession: () => {
        throw new Error("不该调用");
      },
      actions: {},
      abortable: (p: Promise<unknown>) => p,
    }) as unknown as { downloads: (t: string, a: Record<string, unknown>, s?: AbortSignal) => Promise<{ downloads: unknown[]; timedOut: boolean }> };

  it("没有会话 / 会话已销毁：返回空，不建会话、不报错", async () => {
    await expect(mkHandlers(undefined).downloads("t", { action: "list" })).resolves.toEqual({ downloads: [], timedOut: false });
    await expect(mkHandlers({ destroyed: true, downloads: createDownloadRegistry() }).downloads("t", { action: "wait", timeoutMs: 1000 })).resolves.toEqual({
      downloads: [],
      timedOut: false,
    });
  });

  it("list 给最近记录（最新在前）；wait 等在途结束；signal 可打断", async () => {
    const reg = createDownloadRegistry({ startGraceMs: 0 });
    const a = reg.addStarted({ fileName: "a", path: "/dl/a" })!;
    const h = mkHandlers({ destroyed: false, downloads: reg });
    const listed = await h.downloads("t", { action: "list" });
    expect(listed.downloads).toHaveLength(1);

    const waiting = h.downloads("t", { action: "wait", timeoutMs: 5000 });
    reg.finish(a.id, "completed", { receivedBytes: 1 });
    await expect(waiting).resolves.toMatchObject({ timedOut: false });

    const b = reg.addStarted({ fileName: "b", path: "/dl/b" })!;
    const ac = new AbortController();
    const aborted = h.downloads("t", { action: "wait", timeoutMs: 60_000 }, ac.signal);
    ac.abort(new Error("cancel"));
    await expect(aborted).rejects.toThrow("cancel");
    reg.finish(b.id, "cancelled");
  });
});
