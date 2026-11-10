/**
 * V3 server 侧上传策略（src/lib/server/browser/upload-policy.ts）：白名单 + 黑名单。
 * 黑名单 / 形状向量与主进程 upload-guard.mjs 共用同一组（tests/helpers/browser-v3-vectors.ts），保证两侧各自实现判定一致。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_UPLOAD_BYTES,
  checkUploadPaths,
  checkUploadShape,
  findSensitiveRule,
  isAppUserDataLike,
  isInsideDir,
  resolveUploadEnv,
  type TaskDirSource,
  type UploadPolicyEnv,
} from "@/lib/server/browser/upload-policy";

import { PLATFORM_SHAPE_VECTORS, SENSITIVE_VECTORS, SHAPE_VECTORS } from "./helpers/browser-v3-vectors";

type FakeEntry = { size?: number; dir?: boolean };
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
      return { isFile: () => !f.dir, size: f.size ?? 10 };
    },
  };
};

describe("upload-policy：共用向量（与主进程 upload-guard 一致）", () => {
  it.each(SENSITIVE_VECTORS)("黑名单 $path → $hit（$note）", (v) => {
    const hit = findSensitiveRule(v.path, { dataRoots: v.dataRoots, allowedUnderData: v.allowedUnderData });
    expect(hit?.rule ?? null).toBe(v.hit);
  });

  it.each(SHAPE_VECTORS)("形状 $note → ok=$ok", (v) => {
    expect(checkUploadShape(v.path, "darwin").ok).toBe(v.ok);
  });

  // R1-11：在 posix 机器上通过注入 platform 测 win32 分支（与主进程 upload-guard 共用向量）
  it.each(PLATFORM_SHAPE_VECTORS)("形状[$platform] $note → ok=$ok", (v) => {
    expect(checkUploadShape(v.path, v.platform).ok).toBe(v.ok);
  });

  it("isAppUserDataLike / isInsideDir 的边界", () => {
    expect(isAppUserDataLike("/Users/me/Library/Application Support/fe-ai-flow-test/x")).toBe(true);
    expect(isAppUserDataLike("/Users/me/fe-ai-flow/data")).toBe(false);
    expect(isInsideDir("/a/b/c", "/a/b")).toBe(true);
    expect(isInsideDir("/a/bc", "/a/b")).toBe(false);
    expect(isInsideDir("/a/b", "/")).toBe(false); // 根目录当作没配置
    expect(isInsideDir("/A/B/c", "/a/b", true)).toBe(false);
    expect(isInsideDir("/A/B/c", "/a/b", false)).toBe(true);
  });
});

describe("checkUploadPaths", () => {
  const files: Record<string, FakeEntry> = {
    "/work/proj": { dir: true },
    "/work/proj/src/a.png": { size: 123 },
    "/work/proj/.env": { size: 3 },
    "/work/proj/link-out.txt": { size: 3 },
    "/work/proj/dir": { dir: true },
    "/work/proj/huge.bin": { size: MAX_UPLOAD_BYTES + 1 },
    "/private/tmp": { dir: true },
    "/private/tmp/report.pdf": { size: 2048 },
    "/private/tmp/id_rsa": { size: 1 },
    "/Users/me/Downloads": { dir: true },
    "/Users/me/Downloads/Flowship-browser/page.pdf": { size: 5 },
    "/Users/me/Documents/x.pdf": { size: 5 },
    "/etc/hosts": { size: 5 },
    "/Users/me/.ssh/id_rsa": { size: 5 },
    "/data/flowship/tasks/t1/uploads": { dir: true },
    "/data/flowship/tasks/t1/uploads/p.png": { size: 9 },
    "/data/flowship/tasks/t1/meta.json": { size: 9 },
    "/data/flowship/tasks/t2/uploads/q.png": { size: 9 },
    "/Work/proj": { dir: true },
    "/Work/proj/a.txt": { size: 1 },
  };
  const links = {
    "/tmp": "/private/tmp", // macOS：/tmp 是 /private/tmp 的符号链接
    "/work/proj/link-out.txt": "/etc/hosts",
    "/work/proj/link-ssh.txt": "/Users/me/.ssh/id_rsa",
  };
  const fsx = makeFs({ ...files, "/work/proj/link-ssh.txt": { size: 5 } }, links);
  const env = (over: Partial<UploadPolicyEnv> = {}): UploadPolicyEnv => ({
    platform: "darwin",
    allowedRoots: ["/work/proj", "/tmp", "/Users/me/Downloads", "/data/flowship/tasks/t1/uploads"],
    dataRoots: ["/data/flowship"],
    allowedUnderData: ["/data/flowship/tasks/t1/uploads"],
    ...over,
  });
  const check = (paths: unknown, over: Partial<UploadPolicyEnv> = {}) => checkUploadPaths(paths, env(over), fsx);
  const rejected = async (paths: unknown, rule: string, msg?: RegExp, over: Partial<UploadPolicyEnv> = {}) => {
    const v = await check(paths, over);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.rule).toBe(rule);
      if (msg) expect(v.message).toMatch(msg);
    }
  };

  it("任务工作目录内的文件放行，返回 realpath / 名字 / 大小", async () => {
    const v = await check(["/work/proj/src/a.png"]);
    expect(v).toEqual({ ok: true, files: [{ path: "/work/proj/src/a.png", name: "a.png", size: 123 }] });
  });

  it("macOS：/tmp 是 /private/tmp 的符号链接——用 realpath 比较仍然放行，并交出 realpath", async () => {
    const v = await check(["/tmp/report.pdf"]);
    expect(v).toEqual({ ok: true, files: [{ path: "/private/tmp/report.pdf", name: "report.pdf", size: 2048 }] });
  });

  it("下载目录（含 Flowship-browser 子目录）放行", async () => {
    await expect(check(["/Users/me/Downloads/Flowship-browser/page.pdf"])).resolves.toMatchObject({ ok: true });
  });

  it("不在白名单：拒绝文案说明规则并告诉怎么办", async () => {
    await rejected(["/Users/me/Documents/x.pdf"], "outside", /不在任务允许的目录内.*请先把文件复制到任务工作目录/);
  });

  it("../ 越界：形状阶段就拒（要求规范化的绝对路径）", async () => {
    await rejected(["/work/proj/../../etc/hosts"], "shape", /\.\./);
    await rejected(["/work/proj/src/../src/a.png"], "shape", /\.\./);
  });

  it("相对路径 / 非数组 / 空数组 / 超过 10 个", async () => {
    await rejected(["src/a.png"], "shape", /绝对路径/);
    await rejected("/work/proj/src/a.png", "count");
    await rejected([], "count");
    await rejected(Array(11).fill("/work/proj/src/a.png"), "count", /最多上传 10/);
  });

  it("符号链接逃逸：白名单内的链接指向白名单外 → 按 realpath 判，拒绝", async () => {
    await rejected(["/work/proj/link-out.txt"], "outside");
  });

  it("符号链接指向 ~/.ssh：黑名单（realpath）拒绝，文案点出符号链接", async () => {
    await rejected(["/work/proj/link-ssh.txt"], "blacklist", /符号链接/);
  });

  it("黑名单优先于白名单：白名单内的 .env / id_rsa 一样拒", async () => {
    await rejected(["/work/proj/.env"], "blacklist", /\.env|凭据/);
    await rejected(["/tmp/id_rsa"], "blacklist", /id_rsa/);
    await rejected(["/Users/me/.ssh/id_rsa"], "blacklist", /\.ssh/, { allowedRoots: ["/Users/me/.ssh"] });
  });

  it("数据目录：即使白名单里有，除本任务 uploads 外一律拒", async () => {
    await expect(check(["/data/flowship/tasks/t1/uploads/p.png"])).resolves.toMatchObject({ ok: true });
    await rejected(["/data/flowship/tasks/t1/meta.json"], "blacklist", /数据目录/, { allowedRoots: ["/data/flowship"] });
    await rejected(["/data/flowship/tasks/t2/uploads/q.png"], "blacklist", /数据目录/, { allowedRoots: ["/data/flowship"] });
  });

  it("不存在 / 目录 / 超过 100MB", async () => {
    await rejected(["/work/proj/none.txt"], "missing", /不存在/);
    await rejected(["/work/proj/dir"], "not-file", /不是普通文件/);
    await rejected(["/work/proj/huge.bin"], "too-large", /100MB/);
  });

  it("任一文件不合规整批拒绝，不返回部分结果", async () => {
    await rejected(["/work/proj/src/a.png", "/work/proj/.env"], "blacklist");
    await rejected(["/work/proj/src/a.png", "/Users/me/Documents/x.pdf"], "outside");
  });

  it("白名单大小写：linux 区分，darwin / win32 不区分", async () => {
    const roots = { allowedRoots: ["/work/proj"] };
    await rejected(["/Work/proj/a.txt"], "outside", undefined, { ...roots, platform: "linux" });
    await expect(check(["/Work/proj/a.txt"], { ...roots, platform: "darwin" })).resolves.toMatchObject({ ok: true });
  });

  it("白名单为空 → 一律 outside（不会因为配置缺失而放开）", async () => {
    await rejected(["/work/proj/src/a.png"], "outside", undefined, { allowedRoots: [] });
  });

  it("R1-11：win32 的 UNC / 设备路径在 realpath / stat 之前就被拒（rule=shape），不会触发 SMB / NTLM 外联", async () => {
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
    const winEnv = env({ platform: "win32", allowedRoots: ["C:\\work"], dataRoots: [], allowedUnderData: [] });
    for (const p of ["\\\\evil\\s\\a.txt", "//evil/s/a.txt", "\\\\?\\UNC\\evil\\s\\a.txt", "\\\\.\\pipe\\x"]) {
      const v = await checkUploadPaths([p], winEnv, spyFs);
      expect(v, p).toMatchObject({ ok: false, rule: "shape" });
      expect(!v.ok && v.message).toMatch(/UNC|网络共享/);
    }
    // 混在一批里：UNC 那项自己没有任何 fs 调用（allowedRoots 的 realpath 来自配置、不含 evil）
    const mixed = await checkUploadPaths(["C:\\work\\a.txt", "\\\\evil\\s\\b.txt"], winEnv, spyFs);
    expect(mixed).toMatchObject({ ok: false, rule: "shape" });
    expect(calls.filter((c) => c.includes("evil"))).toEqual([]);
  });

  it("R1-27：新增的凭据名（id_ecdsa / .git-credentials / *.kdbx …）在白名单目录里也拒；符号链接指向它们同样拒", async () => {
    const f = makeFs(
      {
        "/work/proj": { dir: true },
        "/work/proj/id_ecdsa": { size: 3 },
        "/work/proj/.git-credentials": { size: 3 },
        "/work/proj/vault.kdbx": { size: 3 },
        "/Users/me/.pgpass": { size: 3 },
        "/work/proj/link-pgpass.txt": { size: 3 },
      },
      { "/work/proj/link-pgpass.txt": "/Users/me/.pgpass" },
    );
    for (const p of ["/work/proj/id_ecdsa", "/work/proj/.git-credentials", "/work/proj/vault.kdbx"]) {
      const v = await checkUploadPaths([p], env(), f);
      expect(v, p).toMatchObject({ ok: false, rule: "blacklist" });
    }
    const link = await checkUploadPaths(["/work/proj/link-pgpass.txt"], env(), f);
    expect(link).toMatchObject({ ok: false, rule: "blacklist" });
    expect(!link.ok && link.message).toMatch(/符号链接/);
  });
});

describe("resolveUploadEnv：白名单根目录的来源", () => {
  const source = (over: Partial<TaskDirSource> = {}): TaskDirSource => ({
    getTask: async () => ({ repoPaths: ["/repos/a", "/repos/b"] }),
    workRepoPaths: () => ["/wt/t1/a", "/repos/b"],
    worktreesDir: (id) => `/wt/${id}`,
    taskDataDir: (id) => `/data/tasks/${id}`,
    workspaceDir: (id) => `/data/tasks/${id}/workspace`,
    dataRoot: () => "/data",
    ...over,
  });
  const opts = { tmpdir: "/var/folders/xx/T", homedir: "/Users/me", platform: "darwin" };

  it("工作目录 / 仓库 / worktree 容器 / 任务 uploads+workspace / 临时目录 / 下载目录", async () => {
    const e = await resolveUploadEnv("t1", { ...opts, source: source() });
    expect(e.allowedRoots).toEqual(
      expect.arrayContaining([
        "/wt/t1/a",
        "/repos/b",
        "/repos/a",
        "/wt/t1",
        "/data/tasks/t1/uploads",
        "/data/tasks/t1/workspace",
        "/var/folders/xx/T",
        "/tmp",
        "/Users/me/Downloads",
      ]),
    );
    expect(e.dataRoots).toEqual(["/data"]);
    expect(e.allowedUnderData).toEqual(["/data/tasks/t1/uploads", "/data/tasks/t1/workspace"]);
  });

  it("不用 task.workCwd 这种可能很宽的公共父目录", async () => {
    const e = await resolveUploadEnv("t1", { ...opts, source: source({ getTask: async () => ({ repoPaths: ["/repos/a"], workCwd: "/repos" } as never) }) });
    expect(e.allowedRoots).not.toContain("/repos");
  });

  it("任务不存在 / 读取失败：退回 uploads + workspace + 临时目录 + 下载目录，不抛", async () => {
    const none = await resolveUploadEnv("tX", { ...opts, source: source({ getTask: async () => null }) });
    expect(none.allowedRoots).toEqual(["/data/tasks/tX/uploads", "/data/tasks/tX/workspace", "/var/folders/xx/T", "/tmp", "/Users/me/Downloads"]);
    const boom = await resolveUploadEnv("tX", {
      ...opts,
      source: source({
        getTask: async () => {
          throw new Error("坏了");
        },
      }),
    });
    expect(boom.allowedRoots).toEqual(["/var/folders/xx/T", "/tmp", "/Users/me/Downloads"]);
    expect(boom.allowedUnderData).toEqual([]);
  });

  it("win32 不加 /tmp", async () => {
    const e = await resolveUploadEnv("t1", { ...opts, platform: "win32", source: source() });
    expect(e.allowedRoots).not.toContain("/tmp");
  });
});

describe("真实文件系统：realpath / 符号链接 / 临时目录", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const mk = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v3-policy-"));
    made.push(root);
    return root;
  };

  it("白名单内真实文件放行；指向白名单外的符号链接拒绝；指向 .ssh 的链接拒绝", async () => {
    const root = mk();
    const work = path.join(root, "work");
    const outside = path.join(root, "outside");
    const sshDir = path.join(root, "home", ".ssh");
    for (const d of [work, outside, sshDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(work, "ok.txt"), "hello");
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    fs.writeFileSync(path.join(sshDir, "id_rsa"), "x");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(work, "escape.txt"));
    fs.symlinkSync(path.join(sshDir, "id_rsa"), path.join(work, "key.txt"));
    const env: UploadPolicyEnv = { platform: process.platform, allowedRoots: [work], dataRoots: [], allowedUnderData: [] };

    const ok = await checkUploadPaths([path.join(work, "ok.txt")], env);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.files[0].name).toBe("ok.txt");
      expect(ok.files[0].size).toBe(5);
      // 交给主进程的是 realpath（macOS 的 /var → /private/var 会体现出来）
      expect(ok.files[0].path).toBe(fs.realpathSync(path.join(work, "ok.txt")));
    }
    const esc = await checkUploadPaths([path.join(work, "escape.txt")], env);
    expect(esc).toMatchObject({ ok: false, rule: "outside" });
    const key = await checkUploadPaths([path.join(work, "key.txt")], env);
    expect(key).toMatchObject({ ok: false, rule: "blacklist" });
    const dir = await checkUploadPaths([work], env);
    expect(dir).toMatchObject({ ok: false, rule: "not-file" });
  });
});
