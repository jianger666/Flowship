/**
 * 第四轮 Q3-01 / Q3-02（原因非空）/ Q3-14（宿主变量）：git 执行底座。
 *
 *  - Q3-01：回退的 `ls-tree -r --name-only -z` 复用 runGit（旧 maxBuffer 8MiB）→ 大仓路径总字节超限时整体中止、
 *    原因为空（`String(e.stderr ?? e.message)` 对空串不回落）。现在：256MiB + `||` 回落；
 *  - Q3-02：WIP 守卫的 runGit 同样 `e.stderr ?? e.message` → 失败原因为空；
 *  - Q3-14：chat-checkpoint 的 runGit 整份继承 process.env（宿主注入变量原样交给用户仓的 git 钩子），
 *    action-checks 的 gitCapture / hash-object 同。
 *
 * 做法：真 git 临时仓；用一个「透传」的 execFile 包装在**特定 git 子命令**上注入超限错误（`stderr` 为空串、
 * `message` 为 "stdout maxBuffer length exceeded"，与 Node 的真实形态一致），其余调用原样走真 git。
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  inject: null as null | ((args: string[]) => Error | null),
  calls: [] as Array<{ args: string[]; opts: { maxBuffer?: number; env?: NodeJS.ProcessEnv; timeout?: number } }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const real = promisify(actual.execFile) as unknown as (
    cmd: string,
    args: string[],
    opts: object,
  ) => Promise<{ stdout: string; stderr: string }>;
  const wrapper = ((...a: Parameters<typeof actual.execFile>) =>
    actual.execFile(...a)) as typeof actual.execFile;
  (wrapper as unknown as Record<symbol, unknown>)[promisify.custom] = async (
    cmd: string,
    args: string[],
    opts: { maxBuffer?: number; env?: NodeJS.ProcessEnv; timeout?: number },
  ) => {
    if (cmd === "git") {
      hook.calls.push({ args: [...args], opts });
      const err = hook.inject?.(args);
      if (err) throw err;
    }
    return real(cmd, args, opts);
  };
  return { ...actual, execFile: wrapper };
});

import type { Task } from "@/lib/types";

const TMP_ROOT = path.join(os.tmpdir(), `fe-git-runner-r4-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  RESET_GIT_TIMEOUT_MS,
  snapshotRepoTree,
  restoreRepoTree,
  syncCheckpointRefs,
} from "@/lib/server/chat-checkpoint";
import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  removeTaskWorktrees,
} from "@/lib/server/task-worktrees";

const DATA_DIR = process.env.FLOWSHIP_DATA_DIR!;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 1 << 30 }).trim();
const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);

/** 与 Node 超限时抛出的错误同形：stderr 是空串（不是 undefined）、信息在 message 里 */
const maxBufferError = (): Error =>
  Object.assign(new Error("stdout maxBuffer length exceeded"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    stdout: "",
    stderr: "",
  });

const initRepo = async (name: string): Promise<string> => {
  const repo = path.join(TMP_ROOT, name);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "f.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  return repo;
};

beforeEach(() => {
  hook.inject = null;
  hook.calls.length = 0;
});
afterEach(() => {
  hook.inject = null;
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("Q3-01：回退的 ls-tree（目标树全部路径）", () => {
  it("超限（模拟 8–12 万文件的大仓）：整体中止（fail-closed、没动工作区）、原因非空且点名超限", async () => {
    const repo = await initRepo("rw-limit");
    const target = await snapshotRepoTree(repo);
    if ("error" in target) throw new Error(target.error);
    await fs.writeFile(path.join(repo, "ai-new.txt"), "AI 本回合新增\n");
    await fs.appendFile(path.join(repo, "f.txt"), "AI 改动\n");
    const safety = await snapshotRepoTree(repo);
    if ("error" in safety) throw new Error(safety.error);
    hook.calls.length = 0;
    hook.inject = (args) => (args[0] === "ls-tree" ? maxBufferError() : null);

    const res = await restoreRepoTree(repo, target.treeOid, { safetyTreeOid: safety.treeOid });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ls-tree 失败/);
    // 冒号后必须有内容（旧实现：空）
    expect(res.error!.split("：").pop()!.trim()).not.toBe("");
    expect(res.error).toContain("maxBuffer");
    // fail-closed：没往下走到 read-tree，工作区原样
    expect(hook.calls.some((c) => c.args[0] === "read-tree" && c.args.includes("-u"))).toBe(false);
    expect(await fs.readFile(path.join(repo, "f.txt"), "utf8")).toBe("base\nAI 改动\n");
    expect(await fs.readFile(path.join(repo, "ai-new.txt"), "utf8")).toBe("AI 本回合新增\n");
  }, 60_000);

  it("ls-tree / diff-tree 的容量上限已放大到 ≥256MiB（旧：8MiB）", async () => {
    const repo = await initRepo("rw-cap");
    const target = await snapshotRepoTree(repo);
    if ("error" in target) throw new Error(target.error);
    await fs.writeFile(path.join(repo, "x.txt"), "x\n");
    const safety = await snapshotRepoTree(repo);
    if ("error" in safety) throw new Error(safety.error);
    hook.calls.length = 0;

    const res = await restoreRepoTree(repo, target.treeOid, { safetyTreeOid: safety.treeOid });

    expect(res.ok).toBe(true);
    for (const sub of ["ls-tree", "diff-tree"]) {
      const c = hook.calls.find((x) => x.args[0] === sub);
      expect(c, sub).toBeDefined();
      expect(c!.opts.maxBuffer).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    }
  }, 60_000);

  it("第五轮 P4：破坏性的 `read-tree -u --reset` 超时放宽到 120s，只读的 ls-tree 仍是 15s（被超时杀掉会留下半恢复的工作区）", async () => {
    const repo = await initRepo("rw-timeout");
    const target = await snapshotRepoTree(repo);
    if ("error" in target) throw new Error(target.error);
    await fs.writeFile(path.join(repo, "y.txt"), "y\n");
    const safety = await snapshotRepoTree(repo);
    if ("error" in safety) throw new Error(safety.error);
    hook.calls.length = 0;

    const res = await restoreRepoTree(repo, target.treeOid, { safetyTreeOid: safety.treeOid });

    expect(res.ok).toBe(true);
    const reset = hook.calls.find((c) => c.args[0] === "read-tree" && c.args.includes("--reset"));
    expect(reset?.opts.timeout).toBe(RESET_GIT_TIMEOUT_MS);
    expect(RESET_GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    const ls = hook.calls.find((c) => c.args[0] === "ls-tree");
    expect(ls?.opts.timeout).toBe(15_000);
  }, 60_000);

  it("真大仓：目标树路径总字节 > 8MiB（4 万个 230 字节文件名）——旧树整体中止，现在回退成功、AI 新增文件被清", async () => {
    const repo = path.join(TMP_ROOT, "rw-big");
    await fs.mkdir(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t.local");
    git(repo, "config", "user.name", "t");
    const N = 40_000;
    const pad = "p".repeat(220);
    const lines: string[] = ["commit refs/heads/main", "committer t <t@t.local> 1700000000 +0000", "data 4", "big", ""];
    for (let i = 0; i < N; i++) {
      const p = `d${String(i % 200).padStart(3, "0")}/${pad}${String(i).padStart(5, "0")}.ts`;
      lines.push(`M 100644 inline ${p}`, "data 3", "x\n");
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: lines.join("\n") + "\n", maxBuffer: 1 << 30 });
    git(repo, "reset", "--hard", "-q");
    const lsBytes = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], { cwd: repo, maxBuffer: 1 << 30 }).length;
    expect(lsBytes).toBeGreaterThan(8 * 1024 * 1024); // 前提：确实超过旧上限

    const target = await snapshotRepoTree(repo);
    if ("error" in target) throw new Error(target.error);
    await fs.writeFile(path.join(repo, "ai-new.txt"), "AI 本回合新增\n");
    const safety = await snapshotRepoTree(repo);
    if ("error" in safety) throw new Error(safety.error);

    const res = await restoreRepoTree(repo, target.treeOid, { safetyTreeOid: safety.treeOid });

    expect(res.error ?? "").toBe("");
    expect(res.ok).toBe(true);
    expect(res.removedUntracked).toEqual(["ai-new.txt"]);
    expect(await exists(path.join(repo, "ai-new.txt"))).toBe(false);
  }, 240_000);
});

describe("Q3-02：WIP 守卫 status 失败的原因永远非空", () => {
  it("status 超限（stderr 为空串）→ failed、目录保留，原因含 maxBuffer（旧：冒号后为空）", async () => {
    const repo = await initRepo("wip-reason");
    const t = {
      id: "t_1700000029001_reason",
      mode: "task",
      title: "原因非空",
      repoStatus: "developing",
      runStatus: "idle",
      repoPaths: [repo],
      isolateWorktree: true,
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/820001",
      actions: [],
      mrs: [],
    } as unknown as Task;
    await fs.mkdir(path.join(DATA_DIR, "tasks", t.id), { recursive: true });
    await ensureTaskWorktrees(t, () => true);
    const wd = getTaskWorkRepoPaths(t)[0];
    await fs.writeFile(path.join(wd, "wip.ts"), "未提交\n");
    hook.calls.length = 0;
    hook.inject = (args) => (args[0] === "status" ? maxBufferError() : null);

    const removed = await removeTaskWorktrees(t);

    expect(removed.removedAny).toBe(false);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    const reason = removed.snapshotFailures![0].reason;
    expect(reason.split("：").pop()!.trim()).not.toBe("");
    expect(reason).toContain("maxBuffer");
    expect(await fs.readFile(path.join(wd, "wip.ts"), "utf8")).toBe("未提交\n");
    // 守卫 status 带了 -uall，且容量远大于旧 4MiB
    const st = hook.calls.find((c) => c.args[0] === "status");
    expect(st!.args).toContain("--untracked-files=all");
    expect(st!.opts.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("Q3-14：git 钩子拿到的环境不含宿主注入变量", () => {
  const SENTINELS: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: "1",
    PORT: "8876",
    HOSTNAME: "127.0.0.1",
    __NEXT_PRIVATE_STANDALONE_CONFIG: '{"sentinel":true}',
    FLOWSHIP_DATA_DIR: "/data/prod-sentinel",
  };
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(SENTINELS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(SENTINELS)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const expectHostEnvAbsent = (dump: string): void => {
    const keys = new Set(dump.split("\n").map((l) => l.split("=")[0]));
    for (const k of Object.keys(SENTINELS)) expect(keys.has(k), `钩子环境里不该有 ${k}`).toBe(false);
    expect(keys.has("PATH")).toBe(true); // 没把环境整个洗空
  };

  const withHook = async (name: string, hookName: string) => {
    const repo = await initRepo(name);
    const out = path.join(TMP_ROOT, `${name}.env`);
    const hookFile = path.join(repo, ".git", "hooks", hookName);
    await fs.writeFile(hookFile, `#!/bin/sh\nenv >> "${out}"\n`, { mode: 0o755 });
    await fs.chmod(hookFile, 0o755);
    return { repo, out };
  };

  it("chat-checkpoint：syncCheckpointRefs 的 update-ref 触发 reference-transaction 钩子", async () => {
    const { repo, out } = await withHook("env-ref", "reference-transaction");
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    await syncCheckpointRefs("t_env", {
      repoSnapshots: [{ repoPath: repo, treeOid: tree }],
    } as never);

    expectHostEnvAbsent(await fs.readFile(out, "utf8"));
  });

  it("chat-checkpoint：restoreRepoTree 的 read-tree -u 触发 post-index-change 钩子（回退路径）", async () => {
    const { repo, out } = await withHook("env-restore", "post-index-change");
    const target = await snapshotRepoTree(repo);
    if ("error" in target) throw new Error(target.error);
    await fs.appendFile(path.join(repo, "f.txt"), "改\n");
    await fs.rm(out, { force: true });

    const res = await restoreRepoTree(repo, target.treeOid);

    expect(res.ok).toBe(true);
    expectHostEnvAbsent(await fs.readFile(out, "utf8"));
  });

  it("action-checks：computeWorktreeFingerprint 的 gitCapture（git diff）与 hash-object 两处都剔宿主变量（Q1-01 / Q1-04）", async () => {
    const { computeWorktreeFingerprint } = await import("@/lib/server/action-checks");
    const repo = await initRepo("env-fp");
    const outDiff = path.join(TMP_ROOT, "fp-diff.env");
    const outHash = path.join(TMP_ROOT, "fp-hash.env");
    // clean 过滤器是用户仓里可配的任意命令：tracked.txt 走 diff 路径、untracked.txt 走 hash-object 路径，各写各的文件
    await fs.writeFile(path.join(repo, ".gitattributes"), "tracked.txt filter=dumpa\nuntracked.txt filter=dumpb\n");
    git(repo, "config", "filter.dumpa.clean", `sh -c 'env >> "${outDiff}"; cat'`);
    git(repo, "config", "filter.dumpb.clean", `sh -c 'env >> "${outHash}"; cat'`);
    await fs.writeFile(path.join(repo, "tracked.txt"), "v1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "tracked");
    await fs.writeFile(path.join(repo, "tracked.txt"), "v2 改动\n");
    await fs.writeFile(path.join(repo, "untracked.txt"), "新文件\n");
    await fs.rm(outDiff, { force: true });
    await fs.rm(outHash, { force: true });

    const fp = await computeWorktreeFingerprint(repo);

    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expectHostEnvAbsent(await fs.readFile(outDiff, "utf8"));
    expectHostEnvAbsent(await fs.readFile(outHash, "utf8"));
  });

  it("对照：GIT_INDEX_FILE 这类调用方显式给的增量变量仍然传得进 git（snapshotRepoTree 靠它隔离真实 index）", async () => {
    const repo = await initRepo("env-index");
    const realIndexBefore = await fs.readFile(path.join(repo, ".git", "index"));
    await fs.writeFile(path.join(repo, "new.txt"), "n\n");
    const snap = await snapshotRepoTree(repo);
    expect("error" in snap).toBe(false);
    // 真实 index 一个字节没动（若 GIT_INDEX_FILE 没生效，add -A 会写进真实 index）
    expect((await fs.readFile(path.join(repo, ".git", "index"))).equals(realIndexBefore)).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe("?? new.txt");
  });
});
