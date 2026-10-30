/**
 * git 子进程的环境收口（R14 Q10-04 / Q10-07）：用户仓里被 git 拉起的钩子 / 配置命令，拿不到 GitLab PAT，
 * 并且 git 不会停下来等人输入。
 *
 * 背景：`FLOWSHIP_GITLAB_TOKEN` 是 Flowship 调 GitLab API 的 PAT，留在 server 的 process.env 里。
 * git 本身不读它（团队库走自己的 `TL_GIT_TOKEN`），但 git 拉起的子进程——用户仓的钩子（post-checkout …）、
 * `core.fsmonitor`、外部 diff 驱动、`remote.<n>.uploadpack`——会整份继承 env，用户仓里的任何一行脚本都读得到它。
 * 此前 `task-worktrees.runGit` 的注释甚至写着「不剔 GitLab token」；chat-checkpoint / task-changes / action-checks 等
 * 只剔了宿主注入变量、或整份继承。现统一走 `git-exec.ts` 的 `gitEnv()`。
 *
 * 行为测试：真实 git + 真实钩子 / fsmonitor / clean 过滤器 / uploadpack 把自己拿到的关键变量落盘（mac / linux；Windows 的钩子语义不同，整组跳过，Windows 未验证）。
 * 探针只落白名单变量，不落整份环境：整份 env 里有用户机器上的其它密钥，不该写盘、也不该因断言失败进测试报告。
 * 「探针真被触发」是每条用例的前提断言——否则 PAT 不在只是因为钩子根本没跑，是假绿。
 * 全程只用假 PAT（glpat-FAKE-…），落盘文件在临时目录里、用例结束即删，不涉及任何真实凭据。
 *
 * ⚠️ tests/helpers/hermetic-env.ts 全局把 GIT_TERMINAL_PROMPT 设成 "0"（防测试被提示挂住），这会让
 * 「gitEnv 有没有设它」的断言永远为真；所以每条用例开头显式 delete，探针里看到的才是 gitEnv 自己设的。
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { computeWorktreeFingerprint } from "@/lib/server/action-checks";
import { restoreRepoTree, snapshotRepoTree } from "@/lib/server/chat-checkpoint";
import { checkoutGitBranch, listRepoBranches } from "@/lib/server/git-branches";
import { createTask } from "@/lib/server/task-fs";
import { readRepoChanges, resolveChangeRepoTargets } from "@/lib/server/task-changes";
import { ensureTaskWorktrees } from "@/lib/server/task-worktrees";
import { restoreRepoAfterFailedTestingCheckout } from "@/lib/server/testing-task-branches";
import { resolveWkWorktreeBranchInfos } from "@/lib/server/wk-source-branch";
import type { Task } from "@/lib/types";

const FAKE_PAT = "glpat-FAKE-hook-sentinel-0001";
const TMP_ROOT = path.join(os.tmpdir(), `fe-git-hook-env-${Date.now()}`);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const TOUCHED = ["FLOWSHIP_GITLAB_TOKEN", "GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});
beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
  process.env.FLOWSHIP_GITLAB_TOKEN = FAKE_PAT;
  delete process.env.GIT_TERMINAL_PROMPT;
  delete process.env.GCM_INTERACTIVE;
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

/**
 * 探针：只把「关心的变量」追加写进 out（可被触发多次），不落整份环境——
 * 整份 env 里有用户机器上的其它密钥，不该写盘、更不该因为断言失败被打进测试报告。
 * PAT 是否在子进程环境里按「值」判断（grep -F，命中只记一个标记、不记值），变量名单独看（值替换成 <set>）。
 * 之后执行 tail（如 fsmonitor 要 exit 0、uploadpack 要接着跑真命令）。
 * ⚠️ 钩子的退出码会变成 git 命令自己的退出码（post-checkout 非 0 → checkout 报失败），所以探针本身必须退出 0：
 * 判断 PAT 用 `if … then … fi`（无 else 时退出码恒为 0），不能用 `grep -q … && echo …`（没命中 = 退出 1）。
 */
const probeScript = (out: string, tail = ""): string =>
  [
    "#!/bin/sh",
    "{",
    "  echo '--- probe'",
    "  env | grep -E '^(PATH|GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GIT_OPTIONAL_LOCKS|FLOWSHIP_GITLAB_TOKEN)=' | sed -E 's/^(FLOWSHIP_GITLAB_TOKEN)=.*/\\1=<set>/'",
    `  if env | grep -F -q '${FAKE_PAT}'; then echo 'PAT_VALUE_PRESENT=1'; fi`,
    `} >> "${out}"`,
    tail,
    "",
  ].join("\n");

const writeExecutable = async (file: string, content: string): Promise<void> => {
  await fs.writeFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);
};

const installHook = (repo: string, name: string, out: string): Promise<void> =>
  writeExecutable(path.join(repo, ".git", "hooks", name), probeScript(out));

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

const readDump = (out: string): Promise<string> => fs.readFile(out, "utf8").catch(() => "");

/**
 * 探针落盘的内容：先确认探针真被触发（PATH 在、环境没被洗空），再看没有 PAT（值和变量名都没有），
 * 最后看 gitEnv 自己设的「不等人输入」变量。顺序有意义：改前（旧代码）应当先红在「带着 PAT」这一条。
 * 全部先布尔化再断言：失败消息里只有我们写的说明，不会把探针内容打进报告。
 */
const expectProbeClean = (dump: string): void => {
  expect(
    /^PATH=/m.test(dump),
    "探针没被触发（钩子 / fsmonitor / uploadpack 根本没跑）——下面的『没有 PAT』断言会是假绿",
  ).toBe(true);
  expect(dump.includes("PAT_VALUE_PRESENT"), "子进程环境里带着 GitLab PAT 的值").toBe(false);
  expect(/^FLOWSHIP_GITLAB_TOKEN=/m.test(dump), "子进程环境里有 FLOWSHIP_GITLAB_TOKEN 变量").toBe(false);
  expect(
    /^GIT_TERMINAL_PROMPT=0$/m.test(dump),
    "git 子进程没拿到 GIT_TERMINAL_PROMPT=0（凭据缺失时会停下来等人输入）",
  ).toBe(true);
  expect(
    /^GCM_INTERACTIVE=never$/m.test(dump),
    "git 子进程没拿到 GCM_INTERACTIVE=never（Git Credential Manager 会弹窗）",
  ).toBe(true);
};

describe.skipIf(process.platform === "win32")("git 拉起的子进程拿不到 PAT、不等人输入", () => {
  it("git-branches：checkoutGitBranch 触发的 post-checkout 钩子", async () => {
    const out = path.join(TMP_ROOT, "checkout.env");
    const repo = await initRepo("checkout");
    git(repo, "branch", "feat");
    await installHook(repo, "post-checkout", out);

    const res = await checkoutGitBranch(repo, "feat");

    expect(res).toEqual({ ok: true });
    expectProbeClean(await readDump(out));
  }, 30_000);

  it("testing-task-branches：失败回滚时的 `git checkout` 触发的 post-checkout 钩子", async () => {
    const out = path.join(TMP_ROOT, "testing-restore.env");
    const repo = await initRepo("testing-restore");
    git(repo, "checkout", "-b", "feat"); // 此刻在 feat（= 测试分支）；原分支 main
    await installHook(repo, "post-checkout", out);

    await restoreRepoAfterFailedTestingCheckout(
      {
        repoPath: repo,
        branch: "feat",
        currentBranch: "main",
        currentCommit: git(repo, "rev-parse", "HEAD"),
      },
      new AbortController().signal,
    );

    expect(git(repo, "branch", "--show-current")).toBe("main");
    expectProbeClean(await readDump(out));
  }, 30_000);

  it("task-worktrees：ensureTaskWorktrees 的 `git worktree add` 触发的 post-checkout 钩子", async () => {
    const out = path.join(TMP_ROOT, "worktree.env");
    const repo = await initRepo("worktree");
    await installHook(repo, "post-checkout", out);
    const task = await createTask({
      title: "钩子环境",
      mode: "task",
      workRole: "fe",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/840001",
    } as never);

    await ensureTaskWorktrees(task, () => true);

    expectProbeClean(await readDump(out));
  }, 60_000);

  it("chat-checkpoint：restoreRepoTree 的 `read-tree -u` 触发的 post-index-change / post-checkout 钩子（台账没点名的同类缺口）", async () => {
    const out = path.join(TMP_ROOT, "rewind.env");
    const repo = await initRepo("rewind");
    const snap = await snapshotRepoTree(repo);
    if (!("treeOid" in snap)) throw new Error(`快照失败：${snap.error}`);
    await fs.writeFile(path.join(repo, "f.txt"), "changed after snapshot\n");
    await installHook(repo, "post-index-change", out);
    await installHook(repo, "post-checkout", out);

    const res = await restoreRepoTree(repo, snap.treeOid);

    expect(res.ok, res.error).toBe(true);
    expect(await fs.readFile(path.join(repo, "f.txt"), "utf8")).toBe("base\n");
    expectProbeClean(await readDump(out));
  }, 30_000);

  it("task-changes：readRepoChanges 的 status / diff 会运行 core.fsmonitor 配置的命令；只读预览的 GIT_OPTIONAL_LOCKS=0 仍在", async () => {
    const out = path.join(TMP_ROOT, "changes.env");
    const repo = await initRepo("changes");
    await fs.writeFile(path.join(repo, "f.txt"), "dirty\n");
    const fsmonitor = path.join(TMP_ROOT, "changes-fsmonitor.sh");
    await writeExecutable(fsmonitor, probeScript(out, "exit 0"));
    git(repo, "config", "core.fsmonitor", fsmonitor);
    const task = { mode: "chat" as const, repoPaths: [repo], workCwd: repo };

    const res = await readRepoChanges(resolveChangeRepoTargets(task)[0], task, {
      scope: { kind: "uncommitted" },
    });

    expect(res.unavailable).toBeUndefined();
    expect(res.files.map((f) => f.path)).toContain("f.txt");
    const dump = await readDump(out);
    expectProbeClean(dump);
    expect(/^GIT_OPTIONAL_LOCKS=0$/m.test(dump), "只读预览的 GIT_OPTIONAL_LOCKS=0 丢了").toBe(true);
  }, 30_000);

  it("wk-source-branch：resolveWkWorktreeBranchInfos 的 `ls-remote` 会运行 remote.origin.uploadpack 配置的命令", async () => {
    const out = path.join(TMP_ROOT, "wk-uploadpack.env");
    const origin = path.join(TMP_ROOT, "wk-origin.git");
    git(TMP_ROOT, "init", "--bare", "-b", "main", origin);
    const repo = await initRepo("wk");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    const wrapper = path.join(TMP_ROOT, "wk-uploadpack.sh");
    await writeExecutable(wrapper, probeScript(out, 'exec git upload-pack "$@"'));
    git(repo, "config", "remote.origin.uploadpack", wrapper);
    const task = {
      id: "t_probe_wk",
      mode: "chat",
      reqId: "REQ-9001",
      repoPaths: [repo],
    } as unknown as Task;

    await expect(resolveWkWorktreeBranchInfos(task)).resolves.toEqual([]);

    expectProbeClean(await readDump(out));
  }, 30_000);

  it("git-branches：listRepoBranches({ refresh }) 的 `fetch --prune` 更新远端 refs 时会触发 reference-transaction 钩子", async () => {
    const out = path.join(TMP_ROOT, "fetch-reftx.env");
    const origin = path.join(TMP_ROOT, "fetch-origin.git");
    git(TMP_ROOT, "init", "--bare", "-b", "main", origin);
    const repo = await initRepo("fetch");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "fetch", "-q", "origin"); // 先对齐一次：之后 refresh 的 fetch 只有「新分支」这一处 ref 变化
    await installHook(repo, "reference-transaction", out);
    // origin 上新长出一个分支：refresh 的 fetch 要把它拉成 refs/remotes/origin/feat/probe，这次 ref 更新才会拉起钩子
    git(origin, "update-ref", "refs/heads/feat/probe", "main");

    const res = await listRepoBranches(repo, { refresh: true });

    expect(res.isRepo).toBe(true);
    expect(JSON.stringify(res.branches), "refresh 的 fetch 没把 origin 上的新分支拉下来").toContain("feat/probe");
    expectProbeClean(await readDump(out));
  }, 30_000);

  it("action-checks：computeWorktreeFingerprint 的 diff / ls-files 会运行 core.fsmonitor，hash-object 会运行 clean 过滤器", async () => {
    const outFsm = path.join(TMP_ROOT, "fingerprint-fsmonitor.env");
    const outClean = path.join(TMP_ROOT, "fingerprint-clean.env");
    const repo = await initRepo("fingerprint");
    // 未跟踪文件：指纹要对它们跑 `git hash-object --stdin-paths`（不带 --no-filters → 会运行 filter.<n>.clean，Q1-04）
    await fs.writeFile(path.join(repo, ".gitattributes"), "*.probe filter=probe\n");
    await fs.writeFile(path.join(repo, "note.probe"), "untracked\n");
    const fsmonitor = path.join(TMP_ROOT, "fingerprint-fsmonitor.sh");
    await writeExecutable(fsmonitor, probeScript(outFsm, "exit 0"));
    const clean = path.join(TMP_ROOT, "fingerprint-clean.sh");
    await writeExecutable(clean, probeScript(outClean, "cat"));
    git(repo, "config", "core.fsmonitor", fsmonitor);
    git(repo, "config", "filter.probe.clean", clean);

    const fingerprint = await computeWorktreeFingerprint(repo);

    expect(fingerprint, "指纹没算出来：被测命令在探针被拉起之前就失败了").toMatch(/^[0-9a-f]{64}$/);
    expectProbeClean(await readDump(outFsm)); // git diff / git ls-files → core.fsmonitor
    expectProbeClean(await readDump(outClean)); // git hash-object --stdin-paths → filter.probe.clean
  }, 30_000);
});
