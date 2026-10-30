/**
 * 共享库写入口：失败即回滚主克隆工作树（R14 B7-1 · Q13-06）
 *
 * 症状：上传 / 镜像 / 删除先改主克隆工作树（拷 skill / 删目录 / 整库镜像），再 add / 敏感扫描 / commit / push；
 * 任何一步失败（敏感命中、push 被拒、全部 skill 准备失败、拷贝中途抛错…）此前都不恢复——
 * 没传上去的 skill 目录留在工作树里，共享市场列表读本地工作树，用户看到「已在共享库」的幻影；
 * 删除失败则相反，本地目录没了、远端还在。一直留到下次 sync 的 reset + clean（若同时有残留锁，则永久）。
 *
 * 上半：`withWorktreeRollback` 外壳语义（真 git 临时仓）——没标成功就返回 / 抛错一律回到入口 HEAD；
 *       标了成功不动（含「返回值 ok:false 但 push 已成功」）；入口 HEAD 取不到只 warn；回滚失败不盖原错误。
 * 下半：真走对外入口（本地 bare 仓当远端、只 mock GitLab 的 /api/v4/user，脚手架见 tests/helpers/team-library-e2e.ts）：
 *       上传（敏感命中 / push 被拒 / 拷贝中途抛错 / 成功对照 / 部分成功不回滚）、删除失败、镜像失败。
 *       断言的都是可观察的结果：远端没动、本地 HEAD == 远端、`git status` 干净、skill 目录该在的在、不该在的不在。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  deleteFromTeamLibrary,
  mirrorKnowledgeBase,
  syncTeamLibrary,
  uploadSkillsToTeamLibrary,
  withWorktreeRollback,
} from "@/lib/server/team-library";
import { ownerFromGitLabIdentity } from "@/lib/server/team-library-ownership";
import { setupTeamLibraryE2E, TL_E2E_HOST } from "./helpers/team-library-e2e";

const execFileAsync = promisify(execFile);
const T = 60_000;

const git = async (args: string[], cwd: string): Promise<string> =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

const exists = async (p: string): Promise<boolean> =>
  !!(await fs.lstat(p).catch(() => null));

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n`;

describe("withWorktreeRollback：外壳语义", () => {
  const TMP = path.join(os.tmpdir(), `fe-tl-rollback-unit-${Date.now()}`);
  let seq = 0;

  /** 一个带一次提交的本地仓 */
  const newRepo = async (): Promise<string> => {
    const dir = path.join(TMP, `repo-${++seq}`);
    await fs.mkdir(dir, { recursive: true });
    await git(["init", "-b", "main"], dir);
    await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf-8");
    await git(["add", "."], dir);
    await git(["commit", "-m", "seed"], dir);
    return dir;
  };

  /** 在仓里写文件 + 暂存 + 提交（模拟「commit 成功、push 还没成功」） */
  const commitFile = async (
    repo: string,
    name: string,
    content: string,
  ): Promise<void> => {
    await fs.writeFile(path.join(repo, name), content, "utf-8");
    await git(["add", "."], repo);
    await git(["commit", "-m", `add ${name}`], repo);
  };

  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("没标成功就返回 → 暂存区 / 工作树 / 未跟踪文件全部恢复，HEAD 不变", async () => {
    const repo = await newRepo();
    const base = await git(["rev-parse", "HEAD"], repo);

    const r = await withWorktreeRollback(repo, async () => {
      await fs.writeFile(path.join(repo, "staged.txt"), "s\n", "utf-8");
      await git(["add", "staged.txt"], repo);
      await fs.writeFile(path.join(repo, "README.md"), "changed\n", "utf-8");
      await fs.mkdir(path.join(repo, "skills", "qa", "x"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "skills", "qa", "x", "SKILL.md"),
        "u\n",
        "utf-8",
      );
      return { ok: false as const };
    });

    expect(r).toEqual({ ok: false });
    expect(await git(["status", "--porcelain"], repo)).toBe("");
    expect(await git(["rev-parse", "HEAD"], repo)).toBe(base);
    expect(await exists(path.join(repo, "staged.txt"))).toBe(false);
    expect(await exists(path.join(repo, "skills"))).toBe(false);
    expect(await fs.readFile(path.join(repo, "README.md"), "utf-8")).toBe(
      "seed\n",
    );
  });

  it("本地提交了但没标成功（commit 成功、push 没成功）→ HEAD 回到入口", async () => {
    const repo = await newRepo();
    const base = await git(["rev-parse", "HEAD"], repo);

    await withWorktreeRollback(repo, async () => {
      await commitFile(repo, "ghost.txt", "ghost\n");
      return 1;
    });

    expect(await git(["rev-parse", "HEAD"], repo)).toBe(base);
    expect(await exists(path.join(repo, "ghost.txt"))).toBe(false);
    expect(await git(["status", "--porcelain"], repo)).toBe("");
  });

  it("抛错 → 先回滚、再把原错误原样抛出（同一个 Error 对象）", async () => {
    const repo = await newRepo();
    const base = await git(["rev-parse", "HEAD"], repo);
    const boom = new Error("boom");

    await expect(
      withWorktreeRollback(repo, async () => {
        await fs.writeFile(path.join(repo, "half.txt"), "half\n", "utf-8");
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await exists(path.join(repo, "half.txt"))).toBe(false);
    expect(await git(["status", "--porcelain"], repo)).toBe("");
    expect(await git(["rev-parse", "HEAD"], repo)).toBe(base);
  });

  it("标了成功 → 不回滚；哪怕返回值是 ok:false（上传 allOk=false 但 push 已成功）", async () => {
    const repo = await newRepo();
    const base = await git(["rev-parse", "HEAD"], repo);

    const r = await withWorktreeRollback(repo, async (done) => {
      await commitFile(repo, "pushed.txt", "pushed\n");
      done.committed();
      return { ok: false };
    });

    expect(r).toEqual({ ok: false });
    expect(await git(["rev-parse", "HEAD"], repo)).not.toBe(base);
    expect(await fs.readFile(path.join(repo, "pushed.txt"), "utf-8")).toBe(
      "pushed\n",
    );
  });

  it("标了成功之后再抛错（收尾阶段出错）→ 也不回滚，错误照常抛出", async () => {
    const repo = await newRepo();
    const base = await git(["rev-parse", "HEAD"], repo);

    await expect(
      withWorktreeRollback(repo, async (done) => {
        await commitFile(repo, "pushed.txt", "pushed\n");
        done.committed();
        throw new Error("after push");
      }),
    ).rejects.toThrow("after push");

    expect(await git(["rev-parse", "HEAD"], repo)).not.toBe(base);
    expect(await exists(path.join(repo, "pushed.txt"))).toBe(true);
  });

  it("入口 HEAD 取不到（空仓）→ 不回滚、只 warn，fn 的结果照常返回", async () => {
    const empty = path.join(TMP, `empty-${++seq}`);
    await fs.mkdir(empty, { recursive: true });
    await git(["init", "-b", "main"], empty);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await withWorktreeRollback(empty, async () => {
        await fs.writeFile(path.join(empty, "a.txt"), "a\n", "utf-8");
        return "result";
      });

      expect(r).toBe("result");
      expect(await exists(path.join(empty, "a.txt"))).toBe(true);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("取不到入口 HEAD")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("回滚本身失败（git 被占位目录 index.lock 挡住）→ 只 warn，不盖掉原错误", async () => {
    const repo = await newRepo();
    const boom = new Error("boom");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        withWorktreeRollback(repo, async () => {
          // 占位目录：reset --hard 写不了索引 → 回滚必然失败
          await fs.mkdir(path.join(repo, ".git", "index.lock"));
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("回滚工作树失败")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      await fs.rm(path.join(repo, ".git", "index.lock"), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("共享库写入口：失败即回滚（端到端，本地 bare 当远端）", () => {
  let env: Awaited<ReturnType<typeof setupTeamLibraryE2E>>;
  const alice = {
    host: TL_E2E_HOST,
    userId: 101,
    username: "alice",
    name: "Alice",
    emails: ["alice@example.com"],
  };

  const skillDir = (category: string, name: string): string =>
    path.join(env.repoDir, "skills", category, name);

  beforeAll(async () => {
    env = await setupTeamLibraryE2E({
      prefix: "fe-tl-rollback",
      token: "tok-alice",
      users: {
        "tok-alice": {
          id: 101,
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
        },
      },
      seedFiles: {
        // 远端已有 alice 的 skill：删除用例的对象
        "skills/qa/legacy/SKILL.md": skillMd("legacy"),
        "skills/qa/legacy/.flowship-owner.json": JSON.stringify(
          ownerFromGitLabIdentity(alice),
        ),
        // 镜像要整体替换掉的旧 knowledge/
        "knowledge/old.md": "old\n",
      },
      // 知识库源仓里只有 new.md：镜像会删 old.md、加 new.md
      knowledgeSeed: { "new.md": "new\n" },
    });
    const synced = await syncTeamLibrary();
    expect(synced.ok).toBe(true);
  }, T);

  afterAll(async () => {
    await env.cleanup();
  });

  /** 失败后的统一断言：远端没动、本地与远端一致、工作树干净 */
  const expectRolledBack = async (before: string): Promise<void> => {
    expect(await env.remoteHead()).toBe(before);
    expect(await env.localHead()).toBe(before);
    expect(await env.localStatus()).toBe("");
  };

  it(
    "上传：敏感命中 → 失败；暂存的 skill 目录被清掉、本地不留幻影",
    async () => {
      await env.writeAppSkill("leaky", {
        "SKILL.md": skillMd("leaky"),
        "config.env": "password=SuperSecretValue99\n",
      });
      const before = await env.remoteHead();

      const r = await uploadSkillsToTeamLibrary(["leaky"], "qa");

      expect(r.ok).toBe(false);
      expect((r.sensitiveHits ?? []).length).toBeGreaterThan(0);
      await expectRolledBack(before);
      expect(await exists(skillDir("qa", "leaky"))).toBe(false);
    },
    T,
  );

  it(
    "上传：push 被远端拒收 → 失败；本地 commit 被回滚、skill 目录不留",
    async () => {
      await env.writeAppSkill("rejected", { "SKILL.md": skillMd("rejected") });
      const before = await env.remoteHead();
      await env.installRejectHook();
      let r: Awaited<ReturnType<typeof uploadSkillsToTeamLibrary>>;
      try {
        r = await uploadSkillsToTeamLibrary(["rejected"], "qa");
      } finally {
        await env.removeRejectHook();
      }

      expect(r.ok).toBe(false);
      expect(r.error ?? "").toContain("push");
      await expectRolledBack(before);
      expect(await exists(skillDir("qa", "rejected"))).toBe(false);
    },
    T,
  );

  it(
    "上传：拷贝中途抛错（半拷贝）→ 全部准备失败；半拷贝的目录被清掉",
    async () => {
      await env.writeAppSkill("halfcopy", {
        "SKILL.md": skillMd("halfcopy"),
        "extra.md": "extra\n",
      });
      const before = await env.remoteHead();
      const orig = fs.copyFile.bind(fs);
      let n = 0;
      const spy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        n += 1;
        // 第 1 个文件拷完、第 2 个抛错 → 目录里留着半拷贝
        if (n === 2) {
          throw Object.assign(new Error("EIO: injected copy failure"), {
            code: "EIO",
          });
        }
        return orig(...args);
      });
      let r: Awaited<ReturnType<typeof uploadSkillsToTeamLibrary>>;
      try {
        r = await uploadSkillsToTeamLibrary(["halfcopy"], "qa");
      } finally {
        spy.mockRestore();
      }

      expect(n).toBeGreaterThanOrEqual(2);
      expect(r.ok).toBe(false);
      expect(r.error ?? "").toContain("全部 skill 准备失败");
      await expectRolledBack(before);
      expect(await exists(skillDir("qa", "halfcopy"))).toBe(false);
    },
    T,
  );

  it(
    "对照：上传成功不被回滚——远端有新提交、本地与远端一致、工作树干净、目录在",
    async () => {
      await env.writeAppSkill("good", { "SKILL.md": skillMd("good") });
      const before = await env.remoteHead();

      const r = await uploadSkillsToTeamLibrary(["good"], "qa");

      expect(r.ok).toBe(true);
      const after = await env.remoteHead();
      expect(after).not.toBe(before);
      expect(await env.localHead()).toBe(after);
      expect(await env.localStatus()).toBe("");
      expect(await env.remoteFiles()).toContain("skills/qa/good/SKILL.md");
      expect(await exists(skillDir("qa", "good"))).toBe(true);
    },
    T,
  );

  it(
    "部分成功（allOk=false 但 push 已成功）不回滚：成功的那条留在远端和本地",
    async () => {
      await env.writeAppSkill("part-a", { "SKILL.md": skillMd("part-a") });
      await env.writeAppSkill("part-b", { "SKILL.md": skillMd("part-b") });
      const orig = fs.copyFile.bind(fs);
      let n = 0;
      const spy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        n += 1;
        // part-a 的 SKILL.md 是第 1 次、part-b 的是第 2 次
        if (n === 2) {
          throw Object.assign(new Error("EIO: injected copy failure"), {
            code: "EIO",
          });
        }
        return orig(...args);
      });
      let r: Awaited<ReturnType<typeof uploadSkillsToTeamLibrary>>;
      try {
        r = await uploadSkillsToTeamLibrary(["part-a", "part-b"], "qa");
      } finally {
        spy.mockRestore();
      }

      expect(r.ok).toBe(false);
      expect(r.results.map((x) => x.ok)).toEqual([true, false]);
      const files = await env.remoteFiles();
      expect(files).toContain("skills/qa/part-a/SKILL.md");
      expect(files.some((f) => f.startsWith("skills/qa/part-b/"))).toBe(false);
      expect(await env.localHead()).toBe(await env.remoteHead());
      expect(await exists(skillDir("qa", "part-a"))).toBe(true);
    },
    T,
  );

  it(
    "删除：push 被远端拒收 → 失败；本地被 stage 删掉的 skill 目录恢复回来",
    async () => {
      const before = await env.remoteHead();
      await env.installRejectHook();
      let r: Awaited<ReturnType<typeof deleteFromTeamLibrary>>;
      try {
        r = await deleteFromTeamLibrary("legacy");
      } finally {
        await env.removeRejectHook();
      }

      expect(r.ok).toBe(false);
      await expectRolledBack(before);
      expect(await exists(path.join(skillDir("qa", "legacy"), "SKILL.md"))).toBe(
        true,
      );
      expect(await env.remoteFiles()).toContain("skills/qa/legacy/SKILL.md");
    },
    T,
  );

  it(
    "镜像：push 被远端拒收 → 失败；被整体替换掉的本地 knowledge/ 恢复原样",
    async () => {
      const before = await env.remoteHead();
      await env.installRejectHook();
      let r: Awaited<ReturnType<typeof mirrorKnowledgeBase>>;
      try {
        r = await mirrorKnowledgeBase();
      } finally {
        await env.removeRejectHook();
      }

      expect(r.ok).toBe(false);
      await expectRolledBack(before);
      expect(
        await fs.readFile(path.join(env.repoDir, "knowledge", "old.md"), "utf-8"),
      ).toBe("old\n");
      expect(await exists(path.join(env.repoDir, "knowledge", "new.md"))).toBe(
        false,
      );
    },
    T,
  );

  it(
    "镜像：拷贝中途抛错 → 失败；已被清空的本地 knowledge/ 恢复原样",
    async () => {
      const before = await env.remoteHead();
      let n = 0; // 用计数、不断言 spy：mockRestore 会清掉调用记录
      const spy = vi.spyOn(fs, "copyFile").mockImplementation(async () => {
        n += 1;
        throw Object.assign(new Error("EIO: injected copy failure"), {
          code: "EIO",
        });
      });
      let r: Awaited<ReturnType<typeof mirrorKnowledgeBase>>;
      try {
        r = await mirrorKnowledgeBase();
      } finally {
        spy.mockRestore();
      }

      expect(n).toBeGreaterThanOrEqual(1);
      expect(r.ok).toBe(false);
      expect(r.error ?? "").toContain("镜像拷贝失败");
      await expectRolledBack(before);
      expect(
        await fs.readFile(path.join(env.repoDir, "knowledge", "old.md"), "utf-8"),
      ).toBe("old\n");
      expect(await exists(path.join(env.repoDir, "knowledge", "new.md"))).toBe(
        false,
      );
    },
    T,
  );

  it(
    "对照：删除成功不被回滚——远端没有了、本地目录没了、本地与远端一致、工作树干净",
    async () => {
      await env.writeAppSkill("to-delete", {
        "SKILL.md": skillMd("to-delete"),
      });
      const up = await uploadSkillsToTeamLibrary(["to-delete"], "qa");
      expect(up.ok).toBe(true);
      expect(await env.remoteFiles()).toContain("skills/qa/to-delete/SKILL.md");
      const before = await env.remoteHead();

      const r = await deleteFromTeamLibrary("to-delete");

      expect(r.ok).toBe(true);
      const after = await env.remoteHead();
      expect(after).not.toBe(before);
      expect(await env.remoteFiles()).not.toContain(
        "skills/qa/to-delete/SKILL.md",
      );
      expect(await env.localHead()).toBe(after);
      expect(await env.localStatus()).toBe("");
      expect(await exists(skillDir("qa", "to-delete"))).toBe(false);
    },
    T,
  );

  // 放在最后：成功的镜像会把远端 / 本地的 knowledge/ 换成新内容
  it(
    "对照：镜像成功不被回滚——远端 knowledge/ 换成新内容、本地与远端一致、工作树干净",
    async () => {
      const before = await env.remoteHead();

      const r = await mirrorKnowledgeBase();

      expect(r.ok).toBe(true);
      const after = await env.remoteHead();
      expect(after).not.toBe(before);
      const files = await env.remoteFiles();
      expect(files).toContain("knowledge/new.md");
      expect(files).not.toContain("knowledge/old.md");
      expect(await env.localHead()).toBe(after);
      expect(await env.localStatus()).toBe("");
      expect(await exists(path.join(env.repoDir, "knowledge", "new.md"))).toBe(
        true,
      );
      expect(await exists(path.join(env.repoDir, "knowledge", "old.md"))).toBe(
        false,
      );
    },
    T,
  );
});
