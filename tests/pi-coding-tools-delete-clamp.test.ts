/**
 * pi 的 `delete` 工具：路径钳制
 *
 * 改前只要 path 非空就 `fs.rm(recursive)`：`.` / `..` / 仓库根 / `.git` / 任意绝对路径都能被递归删除；
 * 非隔离任务的 cwd 就是用户的原仓库，未提交改动直接丢。
 * 现在：拒绝空 / `.` / `..`、cwd 本身及其祖先、cwd 之外（本任务数据目录的 workspace/ 内部除外）、
 * `.git`、git 仓库 / worktree 根；正常的文件 / 子目录删除不受影响。
 *
 * 第 4 轮：
 * - 尾斜杠 + 符号链接：`delete link/` 在 Node 22 实测会跟随链接、把指向的整个目录删光（校验按链接本身放行）→
 *   现在去尾斜杠、返回校验用的真实路径，只删链接本身；
 * - 任务目录例外收窄到 actions/ 与 workspace/ 内部，meta.json* / events.jsonl / tool-outputs / .event-seq 等平台内部文件一律拒绝；
 *
 * 第 7 轮：例外进一步收窄到只有 workspace/——actions/ 是 artifact 历史档案（已 ack 的上游产物不让回头动），
 * agent 改自己的产出用 write / edit 覆盖，不需要「删」；放行 actions/ 等于能抹掉审阅 / 验收依据。
 * - isPathInside 的 `..data` 误拦。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCodingToolDefs,
  checkDeleteTarget,
} from "../src/lib/server/pi-coding-tools";
import {
  ACTIONS_DIR,
  EVENTS_FILE,
  META_BACKUP_FILE,
  META_FILE,
  TOOL_OUTPUTS_DIR,
  WORKSPACE_DIR,
} from "../src/lib/server/task-fs-core";

let root: string;
let cwd: string;
let outside: string;
let savedDataDir: string | undefined;
let dataDir: string;

const exists = async (p: string): Promise<boolean> =>
  fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-delete-clamp-"));
  cwd = path.join(root, "repo");
  outside = path.join(root, "outside");
  dataDir = path.join(root, "data");
  await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "nested"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.join(dataDir, "tasks", "t1", "actions"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "tasks", "t2", "actions"), { recursive: true });
  await fs.writeFile(path.join(cwd, "a.txt"), "a");
  await fs.writeFile(path.join(cwd, "src", "nested", "b.txt"), "b");
  await fs.writeFile(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(outside, "keep.txt"), "keep");
  await fs.writeFile(path.join(dataDir, "tasks", "t1", "actions", "x.md"), "x");
  await fs.writeFile(path.join(dataDir, "tasks", "t1", "meta.json"), "{}");
  await fs.writeFile(path.join(dataDir, "tasks", "t2", "actions", "y.md"), "y");
  await fs.writeFile(path.join(dataDir, "tasks", "t2", "events.jsonl"), "{}\n");
  // 平台内部文件 / 目录（t1）
  const t1 = path.join(dataDir, "tasks", "t1");
  await fs.writeFile(path.join(t1, "events.jsonl"), "{}\n");
  await fs.writeFile(path.join(t1, "meta.json.bak"), "{}");
  await fs.writeFile(path.join(t1, ".event-seq"), "1");
  await fs.writeFile(path.join(t1, ".deleted-tombstone"), "");
  await fs.mkdir(path.join(t1, "tool-outputs"), { recursive: true });
  await fs.writeFile(path.join(t1, "tool-outputs", "c1.txt"), "full output");
  await fs.mkdir(path.join(t1, "actions", ".revisions", "act_1"), { recursive: true });
  await fs.writeFile(path.join(t1, "actions", ".revisions", "act_1", "2026.md"), "rev");
  await fs.mkdir(path.join(t1, "actions", ".excluded"), { recursive: true });
  await fs.writeFile(path.join(t1, "actions", ".excluded", "old.md"), "old");
  await fs.mkdir(path.join(t1, "workspace", "scratch"), { recursive: true });
  await fs.writeFile(path.join(t1, "workspace", "scratch", "tmp.txt"), "tmp");
  savedDataDir = process.env.FLOWSHIP_DATA_DIR;
  process.env.FLOWSHIP_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = savedDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

const runDelete = async (p: string, taskId?: string): Promise<string> => {
  const def = buildCodingToolDefs(
    cwd,
    (async () => ({})) as never,
    taskId ? { taskId } : undefined,
  ).find(
    (d) => (d as { name?: unknown }).name === "delete",
  ) as unknown as {
    execute: (
      id: string,
      params: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
  };
  if (!def) throw new Error("缺少 delete 工具");
  const r = await def.execute("call-1", { path: p });
  return r.content.map((c) => c.text).join("\n");
};

describe("checkDeleteTarget：拒绝", () => {
  it.each([
    ["空串", ""],
    ["纯空白", "   "],
    [".", "."],
    ["./", "./"],
    ["..", ".."],
    ["../", "../"],
    ["./..", "./.."],
    ["../..", "../.."],
  ])("%s → 拒绝", async (_label, target) => {
    const r = await checkDeleteTarget(cwd, target);
    expect(r.ok).toBe(false);
  });

  it("cwd 本身（绝对路径 / 绕一圈的相对路径）→ 拒绝", async () => {
    expect((await checkDeleteTarget(cwd, cwd)).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, `${cwd}${path.sep}`)).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, "src/..")).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, "src/../")).ok).toBe(false);
  });

  it("cwd 的祖先（会连带删掉 cwd）→ 拒绝", async () => {
    expect((await checkDeleteTarget(cwd, root)).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, path.dirname(root))).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, path.parse(root).root)).ok).toBe(false);
  });

  it("cwd 之外的路径（绝对 / 相对越界）→ 拒绝", async () => {
    expect((await checkDeleteTarget(cwd, path.join(outside, "keep.txt"))).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, "../outside/keep.txt")).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, "../outside")).ok).toBe(false);
  });

  it(".git 本身与其内部 → 拒绝", async () => {
    for (const p of [".git", ".git/HEAD", "./.git/", path.join(cwd, ".git")]) {
      const r = await checkDeleteTarget(cwd, p);
      expect(r.ok, p).toBe(false);
    }
  });

  it("git 仓库 / worktree 根（目录下有 .git，含 .git 是文件的 worktree）→ 拒绝", async () => {
    // 多仓任务：cwd 是公共父目录，里面每个子目录是一个仓
    const parent = path.join(root, "multi");
    await fs.mkdir(path.join(parent, "repoA", ".git"), { recursive: true });
    await fs.mkdir(path.join(parent, "repoB"), { recursive: true });
    await fs.writeFile(path.join(parent, "repoB", ".git"), "gitdir: /x/y\n"); // worktree 的 .git 是文件
    expect((await checkDeleteTarget(parent, "repoA")).ok).toBe(false);
    expect((await checkDeleteTarget(parent, "repoB")).ok).toBe(false);
  });

  it("本任务目录本身（tasks/<id>）→ 拒绝；数据目录里其它位置 → 拒绝", async () => {
    expect((await checkDeleteTarget(cwd, path.join(dataDir, "tasks", "t1"), "t1")).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, path.join(dataDir, "tasks"), "t1")).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, path.join(dataDir, "config.json"), "t1")).ok).toBe(false);
  });

  it("别的任务的目录 / 事件 / 产物（tasks/t2/…）→ 拒绝（当前任务是 t1）；改前只要在 tasks/ 下深一层就放行", async () => {
    for (const p of [
      path.join(dataDir, "tasks", "t2", "events.jsonl"),
      path.join(dataDir, "tasks", "t2", "actions", "y.md"),
      path.join(dataDir, "tasks", "t2", "actions"),
      path.join(dataDir, "tasks", "t2"),
    ]) {
      const r = await checkDeleteTarget(cwd, p, "t1");
      expect(r.ok, p).toBe(false);
    }
    // 经 ../ 绕进别的任务目录也一样
    expect((await checkDeleteTarget(path.join(dataDir, "tasks", "t1", "actions"), "../../t2/events.jsonl", "t1")).ok).toBe(false);
  });

  it("没有 taskId（工具构造时拿不到）→ 不给任务目录例外：连自己任务目录里的产出也走保守路径、被拒", async () => {
    const mine = path.join(dataDir, "tasks", "t1", "workspace", "scratch", "tmp.txt");
    // 对照：带正确 taskId 时这个目标是放行的——下面几条「被拒」确实是 taskId 缺失 / 不安全造成的，不是别的原因
    expect((await checkDeleteTarget(cwd, mine, "t1")).ok).toBe(true);
    expect((await checkDeleteTarget(cwd, mine)).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, mine, undefined)).ok).toBe(false);
    // taskId 不是单个安全路径段（穿越 / 分隔符 / 空）也当作没有
    for (const bad of ["", "..", "../t2", "t1/actions", "t1\\x", ".hidden"]) {
      expect((await checkDeleteTarget(cwd, mine, bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it(".git 大小写不敏感：.GIT / .Git/HEAD / 绝对路径大小写变体 → 拒绝（macOS / Windows 默认大小写不敏感）", async () => {
    for (const p of [".GIT", ".Git", ".GIT/HEAD", "./.Git/", path.join(cwd, ".GIT"), path.join(cwd, ".gIt", "HEAD")]) {
      const r = await checkDeleteTarget(cwd, p);
      expect(r.ok, p).toBe(false);
    }
    // 子目录里的 .GIT 也一样
    await fs.mkdir(path.join(cwd, "sub", ".GIT"), { recursive: true });
    expect((await checkDeleteTarget(cwd, "sub/.GIT")).ok).toBe(false);
  });

  it("Windows 会丢掉段尾空格 / 点、认备用数据流：.git. / .git␠ / .git::$DATA → 拒绝", async () => {
    for (const p of [".git.", ".git ", ".git::$DATA", ".GIT.."]) {
      const r = await checkDeleteTarget(cwd, p);
      expect(r.ok, p).toBe(false);
    }
  });

  it("「目录下有 .git」一道同样大小写不敏感：含 .GIT 的目录是仓库根 → 拒绝", async () => {
    const parent = path.join(root, "multi2");
    await fs.mkdir(path.join(parent, "repoC", ".GIT"), { recursive: true });
    await fs.mkdir(path.join(parent, "repoD", ".Git"), { recursive: true });
    expect((await checkDeleteTarget(parent, "repoC")).ok).toBe(false);
    expect((await checkDeleteTarget(parent, "repoD")).ok).toBe(false);
  });

  it("符号链接目录指向 cwd 之外：经它删外面的文件 → 拒绝", async () => {
    await fs.symlink(outside, path.join(cwd, "link-out"), "dir");
    const r = await checkDeleteTarget(cwd, "link-out/keep.txt");
    expect(r.ok).toBe(false);
  });
});

describe("checkDeleteTarget：放行", () => {
  it("cwd 内的文件 / 子目录（相对 / 绝对）", async () => {
    expect((await checkDeleteTarget(cwd, "a.txt")).ok).toBe(true);
    expect((await checkDeleteTarget(cwd, "./src/nested")).ok).toBe(true);
    expect((await checkDeleteTarget(cwd, path.join(cwd, "src"))).ok).toBe(true);
    expect((await checkDeleteTarget(cwd, "src/../a.txt")).ok).toBe(true);
  });

  it("名字里带 .git 前缀但不是 .git（.gitignore / .github）→ 放行", async () => {
    await fs.writeFile(path.join(cwd, ".gitignore"), "x");
    await fs.mkdir(path.join(cwd, ".github"), { recursive: true });
    expect((await checkDeleteTarget(cwd, ".gitignore")).ok).toBe(true);
    expect((await checkDeleteTarget(cwd, ".github")).ok).toBe(true);
  });

  it("本任务目录内的工作文件（tasks/<id>/workspace/...）", async () => {
    expect(
      (await checkDeleteTarget(cwd, path.join(dataDir, "tasks", "t1", "workspace", "scratch", "tmp.txt"), "t1")).ok,
    ).toBe(true);
  });

  it("本任务的 artifact 档案（tasks/<id>/actions/x.md）不放行：agent 改产出用 write / edit，不需要删", async () => {
    const r = await checkDeleteTarget(cwd, path.join(dataDir, "tasks", "t1", "actions", "x.md"), "t1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/workspace/);
  });

  it("目标本身是指向外面的符号链接：只删链接、不跟随", async () => {
    await fs.symlink(outside, path.join(cwd, "link-out"), "dir");
    expect((await checkDeleteTarget(cwd, "link-out")).ok).toBe(true);
  });
});

describe("delete 工具端到端", () => {
  it("正常删除：文件与非空子目录被删", async () => {
    expect(await runDelete("a.txt")).toContain("已删除");
    expect(await exists(path.join(cwd, "a.txt"))).toBe(false);
    expect(await runDelete("src")).toContain("已删除");
    expect(await exists(path.join(cwd, "src"))).toBe(false);
  });

  it("危险路径：返回拒绝文案、磁盘上什么都没少", async () => {
    for (const p of [".", "..", cwd, root, ".git", "../outside", path.join(outside, "keep.txt")]) {
      const text = await runDelete(p);
      expect(text, p).not.toContain("已删除");
      expect(text, p).toMatch(/拒绝|不能为空/);
    }
    expect(await exists(path.join(cwd, "a.txt"))).toBe(true);
    expect(await exists(path.join(cwd, ".git", "HEAD"))).toBe(true);
    expect(await exists(path.join(outside, "keep.txt"))).toBe(true);
  });

  it("端到端：删别的任务的文件被拒、磁盘不动；删本任务 workspace 放行（需要 spill.taskId）；本任务 actions/ 档案被拒", async () => {
    const other = path.join(dataDir, "tasks", "t2", "events.jsonl");
    const otherText = await runDelete(other, "t1");
    expect(otherText).toMatch(/拒绝/);
    expect(await exists(other)).toBe(true);

    const mine = path.join(dataDir, "tasks", "t1", "workspace", "scratch", "tmp.txt");
    // 没有 taskId：保守路径，被拒
    expect(await runDelete(mine)).toMatch(/拒绝/);
    expect(await exists(mine)).toBe(true);
    // 带 taskId：本任务 workspace 可删
    expect(await runDelete(mine, "t1")).toContain("已删除");
    expect(await exists(mine)).toBe(false);
    // 本任务 actions/ 下的 artifact 档案：带 taskId 也拒绝、磁盘不动
    const artifact = path.join(dataDir, "tasks", "t1", "actions", "x.md");
    expect(await runDelete(artifact, "t1")).toMatch(/拒绝/);
    expect(await exists(artifact)).toBe(true);
  });

  it("端到端：.GIT 大小写变体被拒、.git 内容不动", async () => {
    for (const p of [".GIT", ".Git/HEAD"]) {
      expect(await runDelete(p), p).toMatch(/拒绝/);
    }
    expect(await exists(path.join(cwd, ".git", "HEAD"))).toBe(true);
  });

  it("删不存在的路径：仍走 fs.rm 的报错（force: false），不被误报成成功", async () => {
    expect(await runDelete("nope.txt")).toContain("删除失败");
  });
});

// ---------- 第 4 轮：尾斜杠 + 符号链接 / 任务目录例外收窄 / ..data ----------

const realOf = (p: string): Promise<string> => fs.realpath(p);

describe("尾斜杠 + 符号链接：不跟随链接、只删链接本身", () => {
  it("`delete link/`（link → cwd 外的目录）：外面目录原样保留，只有链接被删（Node 22 旧逻辑会把外面整个删光）", async () => {
    await fs.symlink(outside, path.join(cwd, "link-out"), "dir");
    for (const spelled of ["link-out/", "link-out//", "./link-out/", `${path.join(cwd, "link-out")}${path.sep}`]) {
      await fs.rm(path.join(cwd, "link-out"), { force: true });
      await fs.symlink(outside, path.join(cwd, "link-out"), "dir");
      const text = await runDelete(spelled);
      expect(text, spelled).toContain("已删除");
      expect(await exists(path.join(outside, "keep.txt")), spelled).toBe(true);
      expect(await exists(outside), spelled).toBe(true);
      expect(await exists(path.join(cwd, "link-out")), spelled).toBe(false);
    }
  });

  it("`delete link/`（link → 另一个 git 仓库根）：仓库与 .git 原样保留", async () => {
    const repo2 = path.join(root, "repo2");
    await fs.mkdir(path.join(repo2, ".git"), { recursive: true });
    await fs.writeFile(path.join(repo2, ".git", "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(path.join(repo2, "f.txt"), "f");
    await fs.symlink(repo2, path.join(cwd, "repo-link"), "dir");
    // 相对写法经 path.resolve 会自己去掉尾斜杠，绝对写法才会把尾斜杠带进 abs（审代码方点的就是这个形态）
    const text = await runDelete(`${path.join(cwd, "repo-link")}${path.sep}`);
    expect(text).not.toMatch(/失败/);
    expect(await exists(path.join(repo2, ".git", "HEAD"))).toBe(true);
    expect(await exists(path.join(repo2, "f.txt"))).toBe(true);
    expect(await exists(path.join(cwd, "repo-link"))).toBe(false);
  });

  it("`delete link/`（link → cwd 自己的仓库根 .git 所在目录）：仓库不受影响", async () => {
    await fs.symlink(cwd, path.join(cwd, "self-link"), "dir");
    await runDelete(`${path.join(cwd, "self-link")}${path.sep}`);
    expect(await exists(path.join(cwd, ".git", "HEAD"))).toBe(true);
    expect(await exists(path.join(cwd, "a.txt"))).toBe(true);
  });

  it("任务 workspace 里指向别的任务目录的链接，带尾斜杠删：别的任务数据不动", async () => {
    const t2 = path.join(dataDir, "tasks", "t2");
    const link = path.join(dataDir, "tasks", "t1", "workspace", "to-t2");
    await fs.symlink(t2, link, "dir");
    const text = await runDelete(`${link}/`, "t1");
    expect(text).not.toMatch(/失败/);
    expect(await exists(path.join(t2, "events.jsonl"))).toBe(true);
    expect(await exists(path.join(t2, "actions", "y.md"))).toBe(true);
    expect(await exists(link)).toBe(false);
  });

  it("checkDeleteTarget 返回的 abs 无尾斜杠、且就是校验用的真实路径", async () => {
    const realCwd = await realOf(cwd);
    for (const spelled of ["src/nested/", "src/nested//", "./src/nested/"]) {
      const r = await checkDeleteTarget(cwd, spelled);
      expect(r.ok, spelled).toBe(true);
      if (r.ok) expect(r.abs, spelled).toBe(path.join(realCwd, "src", "nested"));
    }
    // 经符号链接父目录进来的路径：返回的是解析后的真实位置
    await fs.symlink(path.join(cwd, "src"), path.join(cwd, "src-alias"), "dir");
    const r = await checkDeleteTarget(cwd, "src-alias/nested/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe(path.join(realCwd, "src", "nested"));
  });

  it("尾斜杠不改变拒绝语义：.git/ / ./ / ../ / cwd/ 仍拒绝", async () => {
    for (const p of [".git/", ".GIT//", "./", "../", `${cwd}${path.sep}`, `${path.dirname(cwd)}${path.sep}`]) {
      const r = await checkDeleteTarget(cwd, p);
      expect(r.ok, p).toBe(false);
    }
  });
});

describe("任务数据目录例外：只放行 workspace/ 内部", () => {
  const t1 = (...parts: string[]): string => path.join(dataDir, "tasks", "t1", ...parts);

  it("workspace 内部放行：workspace/scratch（目录）、workspace/scratch/tmp.txt", async () => {
    for (const p of [t1("workspace", "scratch"), t1("workspace", "scratch", "tmp.txt")]) {
      expect((await checkDeleteTarget(cwd, p, "t1")).ok, p).toBe(true);
    }
  });

  it("平台内部文件 / 目录一律拒绝：meta / 备份 / 事件日志 / seq 边车 / 墓碑 / tool-outputs / actions 下的一切（artifact 与隐藏内部目录）", async () => {
    for (const p of [
      t1("meta.json"),
      t1("meta.json.bak"),
      t1("events.jsonl"),
      t1(".event-seq"),
      t1(".deleted-tombstone"),
      t1("tool-outputs"),
      t1("tool-outputs", "c1.txt"),
      t1("actions", "x.md"),
      t1("actions", "nested", "n.md"),
      t1("actions", ".revisions"),
      t1("actions", ".revisions", "act_1", "2026.md"),
      t1("actions", ".excluded", "old.md"),
      t1("actions", ".excluded"),
    ]) {
      const r = await checkDeleteTarget(cwd, p, "t1");
      expect(r.ok, p).toBe(false);
    }
  });

  it("workspace 目录本身、actions 目录本身、任务目录本身都不放行", async () => {
    for (const p of [t1("actions"), t1("workspace"), t1(), t1("actions") + path.sep, t1("workspace") + path.sep]) {
      expect((await checkDeleteTarget(cwd, p, "t1")).ok, p).toBe(false);
    }
  });

  it("大小写变体：META.JSON / Tool-Outputs/c1.txt / EVENTS.JSONL 仍拒绝（白名单按小写比，不在名单里默认拒绝）", async () => {
    for (const p of [t1("META.JSON"), t1("Tool-Outputs", "c1.txt"), t1("EVENTS.JSONL"), t1("Actions", ".REVISIONS", "act_1")]) {
      expect((await checkDeleteTarget(cwd, p, "t1")).ok, p).toBe(false);
    }
  });

  it("经 ../ 从 workspace 绕到内部文件：workspace/../meta.json、actions/x/../../events.jsonl → 拒绝", async () => {
    // 注意：path.join 会先把 `..` 归一化掉，那样传进去的就是 `t1/meta.json`、测不到「绕」本身；这里用字符串拼接保留原始 `..` 段
    const sep = path.sep;
    const raw = [
      `${t1("workspace")}${sep}..${sep}meta.json`,
      `${t1("actions")}${sep}x${sep}..${sep}..${sep}events.jsonl`,
      `${t1("workspace")}${sep}scratch${sep}..${sep}..${sep}tool-outputs${sep}c1.txt`,
    ];
    for (const p of raw) {
      expect(p).toContain(`..${sep}`); // 确认真的带着 `..` 段
      expect((await checkDeleteTarget(cwd, p, "t1")).ok, p).toBe(false);
    }
    // 对照：绕一圈又回到 workspace 内部的，归一化后就是合法目标，放行
    expect((await checkDeleteTarget(cwd, `${t1("workspace")}${sep}scratch${sep}..${sep}scratch${sep}tmp.txt`, "t1")).ok).toBe(true);
  });

  describe("cwd 包含平台数据根（无仓库任务 cwd = process.cwd()，dev 模式下 data/ 在其中）", () => {
    let proj: string;
    let pdata: string;
    const pt = (...p: string[]): string => path.join(pdata, "tasks", "t1", ...p);
    beforeEach(async () => {
      proj = path.join(root, "proj");
      pdata = path.join(proj, "data");
      await fs.mkdir(path.join(pdata, "tasks", "t1", "actions"), { recursive: true });
      await fs.mkdir(path.join(pdata, "tasks", "t1", "workspace"), { recursive: true });
      await fs.mkdir(path.join(pdata, "tasks", "t2", "actions"), { recursive: true });
      await fs.writeFile(pt("meta.json"), "{}");
      await fs.writeFile(pt("actions", "x.md"), "x");
      await fs.writeFile(pt("workspace", "w.txt"), "w");
      await fs.writeFile(path.join(pdata, "tasks", "t2", "meta.json"), "{}");
      await fs.writeFile(path.join(pdata, "tasks", "t2", "actions", "y.md"), "y");
      await fs.writeFile(path.join(proj, "src.txt"), "s");
      process.env.FLOWSHIP_DATA_DIR = pdata; // afterEach 会还原
    });

    it("数据根里除当前任务的 workspace 内容外一律拒绝：别的任务 / 本任务 meta 与 actions / 数据根本身 / tasks 目录", async () => {
      for (const p of [
        pt("meta.json"),
        pt("actions", "x.md"),
        path.join(pdata, "tasks", "t2", "meta.json"),
        path.join(pdata, "tasks", "t2", "actions", "y.md"),
        pdata,
        path.join(pdata, "tasks"),
        path.join(pdata, "tasks", "t1"),
        "data",
        "data/tasks/t2",
        "data/tasks/t1/meta.json",
      ]) {
        expect((await checkDeleteTarget(proj, p, "t1")).ok, p).toBe(false);
        expect((await checkDeleteTarget(proj, p)).ok, `${p}（无 taskId）`).toBe(false);
      }
    });

    it("大小写折叠：macOS / Windows 上 `Data` / `DATA/tasks/t2` 就是 `data`，同样拒绝；linux 保持大小写敏感（那是另一个目录）", async () => {
      for (const platform of ["darwin", "win32"] as const) {
        for (const p of ["Data", "DATA", "Data/tasks/t2", "DATA/tasks/t1/meta.json", path.join(proj, "dAtA", "tasks")]) {
          expect((await checkDeleteTarget(proj, p, "t1", platform)).ok, `${platform} ${p}`).toBe(false);
          expect((await checkDeleteTarget(proj, p, undefined, platform)).ok, `${platform} ${p}（无 taskId）`).toBe(false);
        }
      }
      // linux：`Data` 是另一个名字，数据根钳制不连坐（放行后 fs.rm 自己会报不存在）
      expect((await checkDeleteTarget(proj, "Data", "t1", "linux")).ok).toBe(true);
      // 当前任务 workspace 内容在折叠平台上照常放行（真实大小写）
      expect((await checkDeleteTarget(proj, pt("workspace", "w.txt"), "t1", "darwin")).ok).toBe(true);
    });

    it("当前任务 workspace 里的内容照常放行；cwd 里数据根之外的东西也照常放行", async () => {
      expect((await checkDeleteTarget(proj, pt("workspace", "w.txt"), "t1")).ok).toBe(true);
      expect((await checkDeleteTarget(proj, "src.txt", "t1")).ok).toBe(true);
      expect((await checkDeleteTarget(proj, "src.txt")).ok).toBe(true);
    });

    it("端到端：删 meta / 别的任务被拒、磁盘不动", async () => {
      const cwdSave = cwd;
      cwd = proj; // runDelete 用模块级 cwd
      try {
        for (const p of [pt("meta.json"), path.join(pdata, "tasks", "t2", "meta.json")]) {
          expect(await runDelete(p, "t1"), p).toMatch(/拒绝/);
          expect(await exists(p), p).toBe(true);
        }
      } finally {
        cwd = cwdSave;
      }
    });
  });

  it("workspace 里的符号链接指向任务内部文件：经链接删 → 越界拒绝；链接本身可删", async () => {
    const link = t1("workspace", "meta-link");
    await fs.symlink(t1(), link, "dir");
    expect((await checkDeleteTarget(cwd, path.join(link, "meta.json"), "t1")).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, link, "t1")).ok).toBe(true);
  });

  it("端到端：删 workspace 内容放行，删 meta / 事件日志 / tool-outputs 被拒、磁盘不动", async () => {
    expect(await runDelete(t1("workspace", "scratch"), "t1")).toContain("已删除");
    expect(await exists(t1("workspace", "scratch"))).toBe(false);
    for (const p of [t1("meta.json"), t1("events.jsonl"), t1("tool-outputs", "c1.txt"), t1("actions", ".revisions")]) {
      expect(await runDelete(p, "t1"), p).toMatch(/拒绝/);
      expect(await exists(p), p).toBe(true);
    }
  });

  it("常量不漂移：task-fs-core 的 WORKSPACE_DIR 内部可删；ACTIONS_DIR / META_FILE / EVENTS_FILE / TOOL_OUTPUTS_DIR / META_BACKUP_FILE 一律拒绝", async () => {
    await fs.mkdir(t1(ACTIONS_DIR), { recursive: true });
    await fs.mkdir(t1(WORKSPACE_DIR), { recursive: true });
    expect((await checkDeleteTarget(cwd, t1(ACTIONS_DIR, "n.md"), "t1")).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, t1(WORKSPACE_DIR, "n.txt"), "t1")).ok).toBe(true);
    for (const name of [ACTIONS_DIR, META_FILE, EVENTS_FILE, TOOL_OUTPUTS_DIR, META_BACKUP_FILE]) {
      expect((await checkDeleteTarget(cwd, t1(name), "t1")).ok, name).toBe(false);
      expect((await checkDeleteTarget(cwd, t1(name, "x"), "t1")).ok, `${name}/x`).toBe(false);
    }
  });
});

describe("isPathInside 不误拦以 .. 开头的合法文件名", () => {
  it("cwd 里的 `..data`、`...hidden`、`..cache/x` 可删（旧 startsWith('..') 会当成越界）", async () => {
    await fs.writeFile(path.join(cwd, "..data"), "d");
    await fs.writeFile(path.join(cwd, "...hidden"), "h");
    await fs.mkdir(path.join(cwd, "..cache"), { recursive: true });
    await fs.writeFile(path.join(cwd, "..cache", "x"), "x");
    for (const p of ["..data", "...hidden", "..cache", "..cache/x"]) {
      const r = await checkDeleteTarget(cwd, p);
      expect(r.ok, p).toBe(true);
    }
    expect(await runDelete("..data")).toContain("已删除");
    expect(await exists(path.join(cwd, "..data"))).toBe(false);
  });

  it("任务 workspace 里的 `..data` 同样可删；真正的越界（..、../x）仍拒绝", async () => {
    const p = path.join(dataDir, "tasks", "t1", "workspace", "..data");
    await fs.writeFile(p, "d");
    expect((await checkDeleteTarget(cwd, p, "t1")).ok).toBe(true);
    expect((await checkDeleteTarget(cwd, "../outside/keep.txt")).ok).toBe(false);
    expect((await checkDeleteTarget(cwd, "..")).ok).toBe(false);
  });
});
