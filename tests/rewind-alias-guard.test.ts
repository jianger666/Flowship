/**
 * 回退清理未跟踪文件时的「目标树别名」守卫（第三轮 review R1-01）。
 *
 * 背景：第二轮 F1-01 的修法是拿 `ls-files -o` 当「真未跟踪」的裁判——但它靠 index 的大小写语义：
 * `core.ignorecase=true` 时别名路径被 index 认成已跟踪、不会进 `ls-files -o`；而 `core.ignorecase=false`
 * 的仓建在大小写不敏感的盘上（流行的 StackOverflow 配法 / 从 Linux 拷来的仓 / NTFS）时，index 当它们是
 * 不同文件、`ls-files -o` 照样列出，unlink 于是解析到刚恢复的目标文件——整个目录丢光还报 ok。
 *
 * 修法：不信 index，直接拿目标树的路径集合做 NFC + 小写折叠比较，命中即绝不删。
 * 纯函数的用例在所有平台都跑（不是 runIf 大小写不敏感盘）；真仓用例按盘的实际行为选择断言。
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { restoreRepoTree, snapshotRepoTree } from "@/lib/server/chat-checkpoint";
import {
  buildTargetFoldSet,
  foldRepoPath,
  isTargetTreeAlias,
} from "@/lib/server/rewind-target-alias";

const GIT_IT_TIMEOUT_MS = 60_000;
const TMP_ROOT = path.join(os.tmpdir(), `fe-rewind-alias-${Date.now()}`);
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("折叠比较（纯函数，所有平台都跑）", () => {
  it("foldRepoPath：仅大小写不同、仅 NFC/NFD 不同的路径折叠成同一个键", () => {
    expect(foldRepoPath("Components/Button.tsx")).toBe(foldRepoPath("components/button.TSX"));
    // macOS 老盘 / 拷贝出来的文件名常是 NFD（e + 组合重音），仓里记的是 NFC
    const nfc = "caf\u00e9/a.ts";
    const nfd = "cafe\u0301/a.ts";
    expect(nfc).not.toBe(nfd);
    expect(foldRepoPath(nfc)).toBe(foldRepoPath(nfd));
    // 真正不同的文件不会被误折叠
    expect(foldRepoPath("src/a.ts")).not.toBe(foldRepoPath("src/b.ts"));
  });

  it("buildTargetFoldSet：吃 `ls-tree -z` 的 NUL 分隔输出；空输出 / 末尾 NUL 不产生空键", () => {
    const set = buildTargetFoldSet("Components/a.ts\0Components/b.ts\0README.md\0");
    expect([...set].sort()).toEqual(["components/a.ts", "components/b.ts", "readme.md"]);
    expect(buildTargetFoldSet("").size).toBe(0);
  });

  it("isTargetTreeAlias：与目标树任一路径仅大小写 / 规范化不同 → 视为别名（绝不删）；无关路径不拦", () => {
    const set = buildTargetFoldSet("Components/a.ts\0docs/Readme.md\0");
    expect(isTargetTreeAlias("components/a.ts", set)).toBe(true);
    expect(isTargetTreeAlias("COMPONENTS/A.TS", set)).toBe(true);
    expect(isTargetTreeAlias("Components/a.ts", set)).toBe(true);
    expect(isTargetTreeAlias("docs/readme.md", set)).toBe(true);
    // AI 新建的、目标树里没有任何同名（含忽略大小写）的文件：照常可清
    expect(isTargetTreeAlias("components/c.ts", set)).toBe(false);
    expect(isTargetTreeAlias("scratch/new-by-ai.ts", set)).toBe(false);
  });

  it("文件名里带空格 / 中文 / 引号：不依赖 git 的 quotepath（-z 原样）", () => {
    const set = buildTargetFoldSet('src/带 空格/"q".ts\0');
    expect(isTargetTreeAlias('src/带 空格/"Q".ts', set)).toBe(true);
  });
});

const initRepo = async (dir: string, ignorecase: "true" | "false") => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.ignorecase", ignorecase);
};

const isCaseInsensitiveFs = (() => {
  const probe = path.join(os.tmpdir(), `fe-case-probe-${process.pid}-${Date.now()}`);
  try {
    execFileSync("mkdir", ["-p", probe]);
    execFileSync("touch", [path.join(probe, "a")]);
    execFileSync("test", ["-e", path.join(probe, "A")]);
    return true;
  } catch {
    return false;
  } finally {
    try {
      execFileSync("rm", ["-rf", probe]);
    } catch {
      /* ignore */
    }
  }
})();

describe("restoreRepoTree × core.ignorecase=false（R1-01）", () => {
  it.runIf(isCaseInsensitiveFs)(
    "S2：大小写不敏感盘 + ignorecase=false + 目标点是未跟踪的 Components/，回合内盘上改名成 components/：回退后文件必须还在",
    async () => {
      const repo = path.join(TMP_ROOT, "s2");
      await initRepo(repo, "false");
      await fs.mkdir(path.join(repo, "Components"), { recursive: true });
      await fs.writeFile(path.join(repo, "a.txt"), "a\n");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-m", "init");
      // 目标点：Components/ 下的两个文件都还是「未跟踪」
      await fs.writeFile(path.join(repo, "Components", "a.ts"), "A\n");
      await fs.writeFile(path.join(repo, "Components", "b.ts"), "B\n");
      const target = await snapshotRepoTree(repo);
      if ("error" in target) throw new Error(target.error);

      // AI 回合：盘上把目录改成小写（两步 mv，大小写不敏感盘上才能改名）
      await fs.rename(path.join(repo, "Components"), path.join(repo, "tmp-rename"));
      await fs.rename(path.join(repo, "tmp-rename"), path.join(repo, "components"));
      const safety = await snapshotRepoTree(repo);
      if ("error" in safety) throw new Error(safety.error);
      expect(git(repo, "ls-tree", "-r", "--name-only", safety.treeOid)).toContain("components/a.ts");

      const restored = await restoreRepoTree(repo, target.treeOid, { safetyTreeOid: safety.treeOid });

      expect(restored.ok).toBe(true);
      expect(await fs.readFile(path.join(repo, "Components", "a.ts"), "utf8")).toBe("A\n");
      expect(await fs.readFile(path.join(repo, "Components", "b.ts"), "utf8")).toBe("B\n");
      expect(restored.removedUntracked).toEqual([]);
    },
    GIT_IT_TIMEOUT_MS,
  );

  it.runIf(isCaseInsensitiveFs)(
    "S4：目标点已跟踪 Components/a.ts，回合内 git mv 成 components/ 并提交、里面还有被忽略的 .env.local（挡住 rmdir）：回退后 Components/a.ts 必须在",
    async () => {
      const repo = path.join(TMP_ROOT, "s4");
      await initRepo(repo, "false");
      await fs.mkdir(path.join(repo, "Components"), { recursive: true });
      await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
      await fs.writeFile(path.join(repo, "Components", "a.ts"), "A\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "init");
      const target = await snapshotRepoTree(repo);
      if ("error" in target) throw new Error(target.error);

      git(repo, "mv", "Components", "tmp-rename");
      git(repo, "mv", "tmp-rename", "components");
      git(repo, "commit", "-m", "rename dir case");
      await fs.writeFile(path.join(repo, "components", ".env.local"), "SECRET=1\n");
      const safety = await snapshotRepoTree(repo);
      if ("error" in safety) throw new Error(safety.error);

      const restored = await restoreRepoTree(repo, target.treeOid, { safetyTreeOid: safety.treeOid });

      expect(restored.ok).toBe(true);
      expect(await fs.readFile(path.join(repo, "Components", "a.ts"), "utf8")).toBe("A\n");
      // 被忽略的本地文件同样没被碰
      expect(await fs.readFile(path.join(repo, "components", ".env.local"), "utf8")).toBe("SECRET=1\n");
    },
    GIT_IT_TIMEOUT_MS,
  );

  it.runIf(!isCaseInsensitiveFs)(
    "大小写敏感盘（Linux CI）：同名异大小写是两个真文件，别名守卫宁可多留、不删——保守取舍钉成用例",
    async () => {
      const repo = path.join(TMP_ROOT, "cs");
      await initRepo(repo, "false");
      await fs.mkdir(path.join(repo, "Components"), { recursive: true });
      await fs.writeFile(path.join(repo, "a.txt"), "a\n");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-m", "init");
      await fs.writeFile(path.join(repo, "Components", "a.ts"), "A\n");
      const target = await snapshotRepoTree(repo);
      if ("error" in target) throw new Error(target.error);

      // AI 回合新建了一个只差大小写的目录与文件，另有一个与目标树完全无关的新文件
      await fs.mkdir(path.join(repo, "components"), { recursive: true });
      await fs.writeFile(path.join(repo, "components", "a.ts"), "ai-made\n");
      await fs.writeFile(path.join(repo, "new-by-ai.ts"), "x\n");
      const safety = await snapshotRepoTree(repo);
      if ("error" in safety) throw new Error(safety.error);

      const restored = await restoreRepoTree(repo, target.treeOid, { safetyTreeOid: safety.treeOid });

      expect(restored.ok).toBe(true);
      // 无关的 AI 新文件照常清掉（清理功能没被守卫废掉）
      await expect(fs.access(path.join(repo, "new-by-ai.ts"))).rejects.toThrow();
      expect(restored.removedUntracked).toContain("new-by-ai.ts");
      // 目标树里的文件还在；别名文件被保守地留下（它在安全快照里，随时能找回；多留一个文件好过删错一个）
      expect(await fs.readFile(path.join(repo, "Components", "a.ts"), "utf8")).toBe("A\n");
      expect(restored.removedUntracked).not.toContain("components/a.ts");
      expect(await fs.readFile(path.join(repo, "components", "a.ts"), "utf8")).toBe("ai-made\n");
    },
    GIT_IT_TIMEOUT_MS,
  );
});
