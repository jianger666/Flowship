/**
 * inspectWorkDirGit 的 `.git` 指针解析——对真实 git 建出来的 worktree 校验分类
 *
 * 钉死的缺陷：git>=2.48（`worktree.useRelativePaths`）写出的相对 `gitdir:` 指针是「相对 `.git` 文件所在目录的
 * 真实路径」算的；旧实现用 `path.resolve(workDir, pointer)` 做字面量折叠，workDir 路径里只要有一级软链
 * （数据目录 / worktrees 目录换盘后软链回来、macOS 的 /tmp、/var 等），`..` 就会按「字面上的上一级」走，
 * 指到一个不存在的位置，把好好的工作区判成 broken、被改名隔离后重建（用户看到「改动全消失了」）。
 *
 * 本机 git 版本可能低于 2.48（不会自己写相对指针），所以这里按 git>=2.48 的写法手工改写指针 / 反向登记，
 * 并用真 git 的 `rev-parse` 先证明「git 自己认这个工作区」，再断言我们的判定也是 intact。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  __inspectWorkDirGitForTest as inspectWorkDirGit,
  __readWorktreeGitDirForTest as readWorktreeGitDir,
} from "@/lib/server/task-worktrees";

// realpath 一次：macOS 的 os.tmpdir() 自带 /var → /private/var 软链，不先摊平会掩盖「软链是我们自己造的」这件事
const ROOT = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "fe-inspect-git-")),
);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.local",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.local",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const mkRepo = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
};

/**
 * 在 `realWorkDir` 建 linked worktree，并改写成 git>=2.48 `useRelativePaths` 的相对形态：
 * `.git` 文件里的指针 / 管理目录里的反向登记都是「相对对方的真实目录」
 */
const addRelativeWorktree = (
  repo: string,
  realWorkDir: string,
  branch: string,
): string => {
  fs.mkdirSync(path.dirname(realWorkDir), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", branch, realWorkDir);
  // 管理目录名不一定等于目录名（重名时 git 会加数字后缀），所以读 git 刚写下的绝对指针，不自己拼
  const admin = fs
    .readFileSync(path.join(realWorkDir, ".git"), "utf8")
    .match(/^gitdir:\s*(.+?)\s*$/m)![1];
  fs.writeFileSync(
    path.join(realWorkDir, ".git"),
    `gitdir: ${path.relative(realWorkDir, admin)}\n`,
  );
  fs.writeFileSync(
    path.join(admin, "gitdir"),
    `${path.relative(admin, path.join(realWorkDir, ".git"))}\n`,
  );
  return admin;
};

const MAIN = path.join(ROOT, "home", "me", "proj");

beforeAll(() => {
  mkRepo(MAIN);
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("inspectWorkDirGit：相对 gitdir 指针按真实目录解析（跟 git 一致）", () => {
  it("基线：绝对指针的普通 worktree → intact", async () => {
    const wd = path.join(ROOT, "plain", "abs", "repo");
    fs.mkdirSync(path.dirname(wd), { recursive: true });
    git(MAIN, "worktree", "add", "-q", "-b", "b-abs", wd);
    expect((await inspectWorkDirGit(wd, MAIN)).state).toBe("intact");
  });

  it("相对指针 + workDir 路径无软链 → intact", async () => {
    const wd = path.join(ROOT, "plain", "rel", "repo");
    addRelativeWorktree(MAIN, wd, "b-rel");
    expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect((await inspectWorkDirGit(wd, MAIN)).state).toBe("intact");
  });

  it("相对指针 + worktrees 目录是软链（换盘）：经软链路径访问仍是 intact，不能被判 broken", async () => {
    // 真实位置在另一块盘 <ROOT>/ssd/<n>，Flowship 经 <ROOT>/home/me/data/worktrees 这条软链访问
    const realBase = path.join(ROOT, "ssd", "link-a");
    const dataDir = path.join(ROOT, "home", "me", "data-a");
    fs.mkdirSync(realBase, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.symlinkSync(realBase, path.join(dataDir, "worktrees"));
    addRelativeWorktree(MAIN, path.join(realBase, "t1", "repo"), "b-link-a");

    const viaLink = path.join(dataDir, "worktrees", "t1", "repo");
    // 先证明「git 自己认」——否则这条用例就在测一个不存在的场景
    expect(git(viaLink, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(git(viaLink, "branch", "--show-current")).toBe("b-link-a");

    const res = await inspectWorkDirGit(viaLink, MAIN);
    expect(res.state, res.reason).toBe("intact");
  });

  it("相对指针 + workDir 自己的上级目录是软链：经软链路径访问仍是 intact", async () => {
    // 软链落在 workDir 的直接上级：<link>/repo 实际是 <ROOT>/ssd/link-b/t1/repo 的内容
    const realTaskDir = path.join(ROOT, "ssd", "link-b", "t1");
    const linkTaskDir = path.join(ROOT, "home", "me", "data-b", "t1");
    fs.mkdirSync(path.dirname(linkTaskDir), { recursive: true });
    addRelativeWorktree(MAIN, path.join(realTaskDir, "repo"), "b-link-b");
    fs.symlinkSync(realTaskDir, linkTaskDir);

    const viaLink = path.join(linkTaskDir, "repo");
    expect(git(viaLink, "rev-parse", "--is-inside-work-tree")).toBe("true");
    const res = await inspectWorkDirGit(viaLink, MAIN);
    expect(res.state, res.reason).toBe("intact");
  });

  it("相对指针所在目录的 realpath 取不到（I/O 错）→ unknown，不能退回字面量解析后当 broken", async () => {
    const wd = path.join(ROOT, "plain", "rel-eio", "repo");
    addRelativeWorktree(MAIN, wd, "b-rel-eio");
    const spy = vi.spyOn(fs.promises, "realpath").mockRejectedValue(
      Object.assign(new Error("EIO: i/o error"), { code: "EIO" }),
    );
    try {
      const res = await inspectWorkDirGit(wd, MAIN);
      expect(res.state).toBe("unknown");
    } finally {
      spy.mockRestore();
    }
  });

  it("反例：经软链访问、但主仓里的 worktree 登记真的没了（prune 后）→ 仍判 broken，不会被误放成 intact", async () => {
    const realBase = path.join(ROOT, "ssd", "link-c");
    const dataDir = path.join(ROOT, "home", "me", "data-c");
    fs.mkdirSync(realBase, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.symlinkSync(realBase, path.join(dataDir, "worktrees"));
    const admin = addRelativeWorktree(
      MAIN,
      path.join(realBase, "t1", "repo"),
      "b-link-c",
    );
    fs.rmSync(admin, { recursive: true, force: true });

    const viaLink = path.join(dataDir, "worktrees", "t1", "repo");
    const res = await inspectWorkDirGit(viaLink, MAIN);
    expect(res.state).toBe("broken");
  });

  it("反例：经软链访问、主仓整个不见了、任务主仓也够不着 → unknown（不隔离、不重建）", async () => {
    const mainGone = path.join(ROOT, "home", "me", "proj-gone");
    mkRepo(mainGone);
    const realBase = path.join(ROOT, "ssd", "link-d");
    const dataDir = path.join(ROOT, "home", "me", "data-d");
    fs.mkdirSync(realBase, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.symlinkSync(realBase, path.join(dataDir, "worktrees"));
    addRelativeWorktree(mainGone, path.join(realBase, "t1", "repo"), "b-link-d");
    fs.renameSync(mainGone, `${mainGone}-unmounted`);

    const viaLink = path.join(dataDir, "worktrees", "t1", "repo");
    const res = await inspectWorkDirGit(viaLink, mainGone);
    expect(res.state).toBe("unknown");
  });

  it("任务主仓自己是 linked worktree（相对指针、经软链）：旧主仓位置失效时仍认它可达 → broken（可重建）", async () => {
    // 主仓 B 是 A 的 linked worktree：repoPath/.git 是指针文件，可达性要顺着指针再看一层
    const realRepoBase = path.join(ROOT, "ssd", "link-e");
    const linkRepoBase = path.join(ROOT, "home", "me", "repos-e");
    fs.mkdirSync(realRepoBase, { recursive: true });
    fs.mkdirSync(path.dirname(linkRepoBase), { recursive: true });
    fs.symlinkSync(realRepoBase, linkRepoBase);
    addRelativeWorktree(MAIN, path.join(realRepoBase, "proj-b"), "b-link-e");
    const repoViaLink = path.join(linkRepoBase, "proj-b");

    // workDir 的绝对指针指向一个早已不存在的旧主仓位置（主仓搬过家）
    const wd = path.join(ROOT, "plain", "moved", "repo");
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(
      path.join(wd, ".git"),
      `gitdir: ${path.join(ROOT, "old-home", "proj", ".git", "worktrees", "repo")}\n`,
    );

    const res = await inspectWorkDirGit(wd, repoViaLink);
    expect(res.state, res.reason).toBe("broken");
  });
});

// 依赖初始化命令的「已跑过 / 已试满次数」标记文件落在 worktree 私有 gitdir 里，靠 readWorktreeGitDir 定位。
// 它原来自己又解析了一遍 `.git` 指针、对相对路径用 `path.resolve(workDir, pointer)` 字面量折叠——
// 和 inspectWorkDirGit 修掉的是同一个 bug（相对指针 + workDir 路径里有软链）。后果比误判 broken 更隐蔽：
// 算出一个不存在的 gitdir → 标记读不到、写也写不进去（写入处 `.catch(() => {})` 把失败吞了）→
// 「命令最多试 2 次 / 成功过就不再跑」的去重整个失效，每次启动 agent 都重跑一条可能长达 15 分钟的 install。
describe("readWorktreeGitDir：与 inspectWorkDirGit 同口径解析 gitdir 指针", () => {
  it("绝对指针：原样返回（基线）", async () => {
    const wd = path.join(ROOT, "plain", "rgd-abs", "repo");
    fs.mkdirSync(path.dirname(wd), { recursive: true });
    git(MAIN, "worktree", "add", "-q", "-b", "b-rgd-abs", wd);
    const admin = fs
      .readFileSync(path.join(wd, ".git"), "utf8")
      .match(/^gitdir:\s*(.+?)\s*$/m)![1];
    expect(await readWorktreeGitDir(wd)).toBe(path.resolve(admin));
  });

  it("相对指针 + 无软链：解析到管理目录", async () => {
    const wd = path.join(ROOT, "plain", "rgd-rel", "repo");
    const admin = addRelativeWorktree(MAIN, wd, "b-rgd-rel");
    expect(await readWorktreeGitDir(wd)).toBe(admin);
  });

  it("相对指针 + worktrees 目录是软链：经软链路径访问也要解析到真实管理目录（旧实现指到不存在的位置）", async () => {
    const realBase = path.join(ROOT, "ssd", "rgd-link");
    const dataDir = path.join(ROOT, "home", "me", "data-rgd");
    fs.mkdirSync(realBase, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.symlinkSync(realBase, path.join(dataDir, "worktrees"));
    const admin = addRelativeWorktree(MAIN, path.join(realBase, "t1", "repo"), "b-rgd-link");

    const viaLink = path.join(dataDir, "worktrees", "t1", "repo");
    const gitDir = await readWorktreeGitDir(viaLink);
    expect(gitDir).toBe(admin);
    // 解析出的位置必须真的存在——标记文件要写进去
    expect(fs.existsSync(gitDir!)).toBe(true);
  });

  it("realpath 取不到（I/O 错）→ null，不退回字面量解析（调用方按「不是真 worktree、不冒险反复执行」处理）", async () => {
    const wd = path.join(ROOT, "plain", "rgd-eio", "repo");
    addRelativeWorktree(MAIN, wd, "b-rgd-eio");
    const spy = vi.spyOn(fs.promises, "realpath").mockRejectedValue(
      Object.assign(new Error("EIO"), { code: "EIO" }),
    );
    try {
      expect(await readWorktreeGitDir(wd)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("没有 `.git` / `.git` 是目录 / 没有 gitdir: 行 → null", async () => {
    const none = path.join(ROOT, "plain", "rgd-none", "repo");
    fs.mkdirSync(none, { recursive: true });
    expect(await readWorktreeGitDir(none)).toBeNull();

    const dirForm = path.join(ROOT, "plain", "rgd-dir", "repo");
    fs.mkdirSync(path.join(dirForm, ".git"), { recursive: true });
    expect(await readWorktreeGitDir(dirForm)).toBeNull();

    const garbage = path.join(ROOT, "plain", "rgd-garbage", "repo");
    fs.mkdirSync(garbage, { recursive: true });
    fs.writeFileSync(path.join(garbage, ".git"), "not a pointer\n");
    expect(await readWorktreeGitDir(garbage)).toBeNull();
  });
});
