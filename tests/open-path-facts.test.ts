/**
 * open-path：读盘补上「扩展名黑名单」的两个洞（R14 S1 · Q14-01）
 *
 * 症状：`/api/system/open-path` 只按扩展名黑名单判断危险类型，route 里没有 realpath / stat：
 *  ① 无扩展名（或扩展名无害）但带可执行位的文件——macOS 的 `open` 会在终端里运行它；
 *  ② 名字无害的符号链接（`notes.txt → Foo.app`、`readme → /bin/ls`）——黑名单只看链接自己的名字，系统打开时却走到目标。
 * 修法：route 先读盘（`probeOpenPathFacts`：真实路径 + 是否带可执行位的普通文件），`buildOpenPathPlan` 把原路径和真实路径都过一遍黑名单，
 * 带可执行位的普通文件同样降级为「在文件管理器中显示」，交给系统的是真实路径。Windows 不读盘（没有可执行位；realpath 会顺着链接去连 UNC）。
 *
 * 三段：纯函数（facts 的各分支，任何平台都能跑）→ 读盘（真文件 / 符号链接 / 权限位，仅 POSIX）→ route（spawn 被 mock，真文件，仅 POSIX；
 * 只断言「开还是降级」与交给系统的路径，spawn 参数的平台细节由 local-file-os.test.ts 管）。
 * 改前三段都是红的：纯函数忽略第三个参数（行为断言红）、route 不读盘（行为断言红）、probe 模块不存在（懒导入，逐例红）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ // eslint-disable-line @typescript-eslint/no-unused-vars
    on(ev: string, cb: (code: number) => void) {
      if (ev === "exit") setTimeout(() => cb(0), 0);
      return this;
    },
    unref() {},
  })),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { buildOpenPathPlan, buildRevealInFolderSpec } from "@/lib/local-file-os";

/**
 * 用例内懒导入：改前 `open-path-facts` 这个模块不存在——静态导入会让整个套件在加载期就红，
 * D 段（新测试跑在改前代码上必须红）就分不出是哪条「行为断言」红了；懒导入后纯函数 / route 两段是行为断言红，
 * 只有 probe 这一段是「模块不存在」红（它改前没有可断言的行为）。
 */
const probeOpenPathFacts = async (p: string, platform: NodeJS.Platform) =>
  (await import("@/lib/server/open-path-facts")).probeOpenPathFacts(p, platform);

const { POST } = await import("@/app/api/system/open-path/route");

const POSIX = process.platform !== "win32";

describe("buildOpenPathPlan + facts：纯函数", () => {
  it("没有 facts：与改前一致（黑名单外照开、黑名单内降级）", () => {
    expect(buildOpenPathPlan("/Users/a/readme", "darwin")).toEqual({
      kind: "open",
      spec: { command: "open", args: ["/Users/a/readme"] },
    });
    expect(buildOpenPathPlan("/Users/a/x.command", "darwin").kind).toBe("reveal");
    // facts 是空对象 / 只有 executableFile:false 也等同没有
    expect(buildOpenPathPlan("/Users/a/readme", "darwin", {})).toEqual(
      buildOpenPathPlan("/Users/a/readme", "darwin"),
    );
    expect(
      buildOpenPathPlan("/Users/a/readme", "linux", { executableFile: false }),
    ).toEqual(buildOpenPathPlan("/Users/a/readme", "linux"));
  });

  it("executableFile → macOS / Linux 降级为在文件管理器中显示，notice 说是可执行权限", () => {
    const mac = buildOpenPathPlan("/Users/a/tool", "darwin", { executableFile: true });
    expect(mac).toEqual({
      kind: "reveal",
      spec: buildRevealInFolderSpec("/Users/a/tool", "darwin"),
      notice: "出于安全考虑，不直接打开带可执行权限的文件，已改为在文件管理器中显示",
    });
    const lin = buildOpenPathPlan("/home/a/tool", "linux", { executableFile: true });
    expect(lin).toEqual({
      kind: "reveal",
      spec: buildRevealInFolderSpec("/home/a/tool", "linux"),
      notice: "出于安全考虑，不直接打开带可执行权限的文件，已改为在文件管理器中显示",
    });
  });

  it("executableFile 对 win32 没有意义（没有可执行位）：忽略、照常打开", () => {
    const p = buildOpenPathPlan("C:\\a\\tool", "win32", { executableFile: true });
    expect(p.kind).toBe("open");
  });

  it("realPath 命中危险扩展名：名字无害的链接 notes.txt → run.command / Foo.app（macOS）降级，notice 说的是真实文件的类型", () => {
    const viaFile = buildOpenPathPlan("/Users/a/notes.txt", "darwin", {
      realPath: "/Users/b/run.command",
    });
    expect(viaFile).toEqual({
      kind: "reveal",
      spec: buildRevealInFolderSpec("/Users/b/run.command", "darwin"),
      notice: "出于安全考虑，不直接运行 .command 文件，已改为在文件管理器中显示",
    });
    const viaApp = buildOpenPathPlan("/Users/a/notes.txt", "darwin", {
      realPath: "/Applications/Foo.app",
    });
    expect(viaApp.kind).toBe("reveal");
    if (viaApp.kind === "reveal") expect(viaApp.notice).toContain(".app");
  });

  it("realPath 在 .app 包内部（macOS）：无扩展名的包内可执行文件也降级", () => {
    const p = buildOpenPathPlan("/Users/a/link", "darwin", {
      realPath: "/Applications/Foo.app/Contents/MacOS/Foo",
    });
    expect(p.kind).toBe("reveal");
    if (p.kind === "reveal") {
      expect(p.notice).toBe("出于安全考虑，不直接运行此文件，已改为在文件管理器中显示");
    }
  });

  it("Linux：链接指向 .desktop → 降级（reveal 的是真实路径的父目录）", () => {
    const p = buildOpenPathPlan("/home/a/notes.txt", "linux", { realPath: "/opt/x/app.desktop" });
    expect(p).toEqual({
      kind: "reveal",
      spec: { command: "xdg-open", args: ["/opt/x"] },
      notice: "出于安全考虑，不直接运行 .desktop 文件，已改为在文件管理器中显示",
    });
  });

  it("原路径危险、真实路径无害（反过来的情形）：仍按原路径降级——两个都判", () => {
    const p = buildOpenPathPlan("/Users/a/x.command", "darwin", { realPath: "/Users/a/plain.txt" });
    expect(p.kind).toBe("reveal");
  });

  it("真实路径无害：交给系统的是真实路径，不是符号链接路径", () => {
    expect(
      buildOpenPathPlan("/Users/a/link.txt", "darwin", { realPath: "/Users/b/plain.txt" }),
    ).toEqual({ kind: "open", spec: { command: "open", args: ["/Users/b/plain.txt"] } });
    expect(
      buildOpenPathPlan("/home/a/link.txt", "linux", { realPath: "/data/plain.txt" }),
    ).toEqual({ kind: "open", spec: { command: "xdg-open", args: ["/data/plain.txt"] } });
  });

  it("realPath 与原路径相同 → 等价于没有 realPath", () => {
    expect(
      buildOpenPathPlan("/Users/a/plain.txt", "darwin", { realPath: "/Users/a/plain.txt" }),
    ).toEqual(buildOpenPathPlan("/Users/a/plain.txt", "darwin"));
  });

  it("可执行位和 realPath 同时给：先按扩展名 / .app 判（notice 说类型），不是 .app 才轮到可执行位", () => {
    const app = buildOpenPathPlan("/Users/a/l", "darwin", {
      realPath: "/Applications/Foo.app",
      executableFile: true,
    });
    expect(app.kind === "reveal" && app.notice).toContain(".app");
    const bare = buildOpenPathPlan("/Users/a/l", "darwin", {
      realPath: "/Users/b/tool",
      executableFile: true,
    });
    expect(bare.kind === "reveal" && bare.notice).toContain("可执行权限");
  });

  it("通用语义（route 在 win32 不读盘，但纯函数照样判）：realPath 是 UNC / 含双引号 → 拒绝；是 .exe → 降级", () => {
    expect(
      buildOpenPathPlan("C:\\a\\notes.txt", "win32", { realPath: "\\\\evil\\share\\x.txt" }).kind,
    ).toBe("reject");
    expect(
      buildOpenPathPlan("C:\\a\\notes.txt", "win32", { realPath: 'C:\\a\\"x.txt' }).kind,
    ).toBe("reject");
    expect(
      buildOpenPathPlan("C:\\a\\notes.txt", "win32", { realPath: "C:\\b\\evil.exe" }).kind,
    ).toBe("reveal");
  });
});

describe.skipIf(!POSIX)("probeOpenPathFacts：读盘（真文件 / 符号链接 / 权限位）", () => {
  let root = "";
  const at = (...p: string[]) => path.join(root, ...p);

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fe-open-facts-")));
    await fs.writeFile(at("plain.txt"), "hello\n");
    await fs.chmod(at("plain.txt"), 0o644);
    await fs.writeFile(at("tool"), "#!/bin/sh\necho hi\n");
    await fs.chmod(at("tool"), 0o755);
    await fs.writeFile(at("group-x"), "x\n");
    await fs.chmod(at("group-x"), 0o610); // 只有 group 带 x：任一 x 位都算
    await fs.writeFile(at("other-x"), "x\n");
    await fs.chmod(at("other-x"), 0o601); // 只有 other 带 x
    await fs.mkdir(at("Foo.app"), { mode: 0o755 });
    await fs.mkdir(at("dir"), { mode: 0o755 });
    await fs.symlink(at("tool"), at("link-to-tool"));
    await fs.symlink(at("Foo.app"), at("notes.txt"));
    await fs.symlink(at("plain.txt"), at("link-to-plain"));
    await fs.symlink(at("dir"), at("dir-link"));
    await fs.symlink(at("nope"), at("dangling"));
    await fs.symlink(at("loop-b"), at("loop-a"));
    await fs.symlink(at("loop-a"), at("loop-b"));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("普通文件（0644）：真实路径就是它自己，不带可执行位", async () => {
    expect(await probeOpenPathFacts(at("plain.txt"), process.platform)).toEqual({
      realPath: at("plain.txt"),
      executableFile: false,
    });
  });

  it("无扩展名的可执行文件（0755）→ executableFile: true", async () => {
    expect(await probeOpenPathFacts(at("tool"), process.platform)).toEqual({
      realPath: at("tool"),
      executableFile: true,
    });
  });

  it("owner / group / other 任一 x 位都算可执行", async () => {
    expect((await probeOpenPathFacts(at("group-x"), process.platform))?.executableFile).toBe(true);
    expect((await probeOpenPathFacts(at("other-x"), process.platform))?.executableFile).toBe(true);
  });

  it("符号链接 → 可执行文件：realPath 是目标，executableFile 看目标", async () => {
    expect(await probeOpenPathFacts(at("link-to-tool"), process.platform)).toEqual({
      realPath: at("tool"),
      executableFile: true,
    });
  });

  it("符号链接 → 普通文件：realPath 是目标，不带可执行位", async () => {
    expect(await probeOpenPathFacts(at("link-to-plain"), process.platform)).toEqual({
      realPath: at("plain.txt"),
      executableFile: false,
    });
  });

  it("名字无害的链接 notes.txt → Foo.app（目录）：realPath 暴露出 .app；目录不算可执行文件", async () => {
    expect(await probeOpenPathFacts(at("notes.txt"), process.platform)).toEqual({
      realPath: at("Foo.app"),
      executableFile: false,
    });
  });

  it("目录（总有 x 位）不算可执行文件；目录链接解开", async () => {
    expect((await probeOpenPathFacts(at("dir"), process.platform))?.executableFile).toBe(false);
    expect(await probeOpenPathFacts(at("dir-link"), process.platform)).toEqual({
      realPath: at("dir"),
      executableFile: false,
    });
  });

  it("中间路径段是符号链接也解开：dir-link/ 下的文件", async () => {
    await fs.writeFile(at("dir", "inner-tool"), "x\n");
    await fs.chmod(at("dir", "inner-tool"), 0o755);
    expect(await probeOpenPathFacts(at("dir-link", "inner-tool"), process.platform)).toEqual({
      realPath: at("dir", "inner-tool"),
      executableFile: true,
    });
  });

  it("读不到就不给事实（不存在 / 悬空链接 / 链接成环 / 路径含 NUL）：交回纯函数按原路径判", async () => {
    expect(await probeOpenPathFacts(at("missing"), process.platform)).toBeUndefined();
    expect(await probeOpenPathFacts(at("dangling"), process.platform)).toBeUndefined();
    expect(await probeOpenPathFacts(at("loop-a"), process.platform)).toBeUndefined();
    expect(await probeOpenPathFacts(`${at("plain.txt")}\0x`, process.platform)).toBeUndefined();
  });

  it("win32 不读盘：没有可执行位，realpath 还会顺着链接去连 UNC", async () => {
    const spy = vi.spyOn(fs, "realpath");
    try {
      expect(await probeOpenPathFacts(at("tool"), "win32")).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe.skipIf(!POSIX)("POST /api/system/open-path：读盘后再判", () => {
  let root = "";
  const at = (...p: string[]) => path.join(root, ...p);
  /** 本机平台上「危险扩展名」的一个例子：macOS 的 .command、Linux 的 .desktop */
  const DANGER_EXT = process.platform === "darwin" ? "command" : "desktop";

  const call = async (p: string) => {
    const res = await POST(
      new Request("http://127.0.0.1/api/system/open-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const spawned = () => spawnMock.mock.calls.map((c) => ({ command: c[0] as string, args: c[1] as string[] }));
  /** 本机平台上「正常打开 target」的 spawn */
  const openSpec = (target: string) => ({
    command: process.platform === "darwin" ? "open" : "xdg-open",
    args: [target],
  });
  const revealSpec = (target: string) => buildRevealInFolderSpec(target, process.platform);

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fe-open-route-")));
    await fs.writeFile(at("plain.txt"), "hello\n");
    await fs.chmod(at("plain.txt"), 0o644);
    await fs.writeFile(at("tool"), "#!/bin/sh\necho hi\n");
    await fs.chmod(at("tool"), 0o755);
    await fs.writeFile(at(`run.${DANGER_EXT}`), "x\n");
    await fs.chmod(at(`run.${DANGER_EXT}`), 0o644); // 不带 x 位：只靠「真实路径的扩展名」才能拦住
    await fs.mkdir(at("dir"), { mode: 0o755 });
    await fs.symlink(at("tool"), at("readme.txt")); // 名字无害、指向可执行文件
    await fs.symlink(at(`run.${DANGER_EXT}`), at("notes.txt")); // 名字无害、指向危险扩展名
    await fs.symlink(at("plain.txt"), at("link.txt"));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    spawnMock.mockClear();
  });

  it("无扩展名的可执行文件：不打开，改成在文件管理器中显示（带说明）", async () => {
    const r = await call(at("tool"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, revealed: true });
    expect(String(r.body.notice)).toContain("可执行权限");
    expect(spawned()).toEqual([revealSpec(at("tool"))]);
  });

  it("名字无害的符号链接 readme.txt → 可执行文件：同样降级，显示的是真实文件", async () => {
    const r = await call(at("readme.txt"));
    expect(r.body).toMatchObject({ ok: true, revealed: true });
    expect(spawned()).toEqual([revealSpec(at("tool"))]);
  });

  it(`名字无害的符号链接 notes.txt → run.${DANGER_EXT}（不带可执行位）：靠真实路径的扩展名降级`, async () => {
    const r = await call(at("notes.txt"));
    expect(r.body).toMatchObject({ ok: true, revealed: true });
    expect(String(r.body.notice)).toContain(`.${DANGER_EXT}`);
    expect(spawned()).toEqual([revealSpec(at(`run.${DANGER_EXT}`))]);
  });

  it("普通文件照常打开，响应里没有 revealed", async () => {
    const r = await call(at("plain.txt"));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(spawned()).toEqual([openSpec(at("plain.txt"))]);
  });

  it("指向普通文件的符号链接：照常打开，交给系统的是真实路径", async () => {
    const r = await call(at("link.txt"));
    expect(r.body).toEqual({ ok: true });
    expect(spawned()).toEqual([openSpec(at("plain.txt"))]);
  });

  it("目录（带 x 位）照常打开", async () => {
    const r = await call(at("dir"));
    expect(r.body).toEqual({ ok: true });
    expect(spawned()).toEqual([openSpec(at("dir"))]);
  });

  it("不存在的路径：读不到事实，仍按原路径交给系统（行为同改前）", async () => {
    const r = await call(at("missing.txt"));
    expect(r.body).toEqual({ ok: true });
    expect(spawned()).toEqual([openSpec(at("missing.txt"))]);
  });

  it("系统打开失败：错误文案原样返回（400）", async () => {
    spawnMock.mockImplementationOnce(() => ({
      on(ev: string, cb: (code: number) => void) {
        if (ev === "exit") setTimeout(() => cb(1), 0);
        return this;
      },
      unref() {},
    }));
    const r = await call(at("missing.txt"));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "打开失败（退出码 1）" });
  });
});
