/**
 * 「分支被其他工作树占用」的纯逻辑：porcelain 解析 / 占用计算 / 展示文案
 *
 * 背景（用户实测）：分支选择器把被别的 worktree 占着的分支列成普通可点项，点了 toast 出
 * 「致命错误：'fix/xxx' 已经检出到 '/Users/.../Flowship-win-fix'」——git 的原文、还随系统语言变。
 * 修法是用 `git worktree list --porcelain`（与语言无关）算占用关系；本文件锁这条链路里的纯函数，
 * 真 git 的端到端行为见 tests/git-branches-occupancy.integration.test.ts。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  occupantLabel,
  occupantOf,
  occupiedBranchHint,
  occupiedBranchMessage,
} from "@/lib/git-branch-occupancy";
import {
  buildBranchOccupancy,
  parseWorktreeList,
  type WorktreeEntry,
} from "@/lib/server/git-branches";
import type { GitBranchOccupant } from "@/lib/types";

const SHA = "46406c7".padEnd(40, "a");

describe("parseWorktreeList：git worktree list --porcelain", () => {
  it("主仓 + 任务隔离工作区 + detached + 已删除登记：逐段解析、分支名去掉 refs/heads/", () => {
    const porcelain = [
      "worktree /Users/me/Flowship",
      `HEAD ${SHA}`,
      "branch refs/heads/main",
      "",
      // 任务隔离工作区：路径含空格（Application Support）、分支名含斜杠
      "worktree /Users/me/Library/Application Support/fe-ai-flow/data/worktrees/t_1_abc/Flowship",
      `HEAD ${SHA}`,
      "branch refs/heads/feature/login/v2",
      "locked claimed by task t_1_abc",
      "",
      "worktree /Users/me/scratch",
      `HEAD ${SHA}`,
      "detached",
      "",
      "worktree /Users/me/gone",
      `HEAD ${SHA}`,
      "branch refs/heads/fix/old",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    expect(parseWorktreeList(porcelain)).toEqual<WorktreeEntry[]>([
      { path: "/Users/me/Flowship", branch: "main", bare: false, prunable: false },
      {
        path: "/Users/me/Library/Application Support/fe-ai-flow/data/worktrees/t_1_abc/Flowship",
        branch: "feature/login/v2",
        bare: false,
        prunable: false,
      },
      { path: "/Users/me/scratch", branch: null, bare: false, prunable: false },
      { path: "/Users/me/gone", branch: "fix/old", bare: false, prunable: true },
    ]);
  });

  it("bare 仓条目标 bare、没有分支", () => {
    expect(parseWorktreeList("worktree /srv/repo.git\nbare\n")).toEqual([
      { path: "/srv/repo.git", branch: null, bare: true, prunable: false },
    ]);
  });

  it("prunable 行不带原因（git 只吐 `prunable`）也认", () => {
    const [entry] = parseWorktreeList(
      "worktree /x\nbranch refs/heads/a\nprunable\n",
    );
    expect(entry?.prunable).toBe(true);
  });

  it("CRLF 换行（Windows git / 被改过换行的输出）不把 \\r 带进路径和分支名", () => {
    const [entry] = parseWorktreeList(
      "worktree /x/y\r\nHEAD abc\r\nbranch refs/heads/feat\r\n\r\n",
    );
    expect(entry).toEqual({
      path: "/x/y",
      branch: "feat",
      bare: false,
      prunable: false,
    });
  });

  it("Windows：git 吐正斜杠盘符路径、转成反斜杠；UNC / POSIX 路径原样", () => {
    const entries = parseWorktreeList(
      [
        "worktree C:/Users/me/Flowship",
        "branch refs/heads/main",
        "",
        "worktree D:/work space/Flowship-win-fix",
        "branch refs/heads/fix/win",
        "",
        "worktree //server/share/repo",
        "branch refs/heads/unc",
        "",
        "worktree /posix/path",
        "branch refs/heads/posix",
      ].join("\n"),
    );
    expect(entries.map((e) => e.path)).toEqual([
      "C:\\Users\\me\\Flowship",
      "D:\\work space\\Flowship-win-fix",
      "//server/share/repo",
      "/posix/path",
    ]);
  });

  it("空输出 / 首个 worktree 行之前的杂行：不崩、不产出幻影条目", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(
      parseWorktreeList("branch refs/heads/orphan\nbare\nprunable\n"),
    ).toEqual([]);
  });

  it("分支名叫 __proto__ / constructor 也是合法分支，照常解析", () => {
    const entries = parseWorktreeList(
      "worktree /a\nbranch refs/heads/__proto__\n\nworktree /b\nbranch refs/heads/constructor\n",
    );
    expect(entries.map((e) => e.branch)).toEqual(["__proto__", "constructor"]);
  });
});

describe("buildBranchOccupancy：哪些分支被「其他」工作树占着", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "occ-pure-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const alive = tmp;
  const ghost = path.join(tmp, "no-such-dir");
  const wt = (
    branch: string | null,
    over: Partial<WorktreeEntry> = {},
  ): WorktreeEntry => ({
    path: alive,
    branch,
    bare: false,
    prunable: false,
    ...over,
  });

  it("当前工作树自己的分支不算占用——否则当前分支也会被置灰", async () => {
    const res = await buildBranchOccupancy(
      [wt("main"), wt("feature/a", { path: "/other" })],
      "main",
    );
    expect(Object.keys(res)).toEqual(["feature/a"]);
  });

  it("detached（无分支）和 bare 条目不产生占用", async () => {
    // bare 条目故意带一个 ≠ current 的分支名：真实 porcelain 里 bare 没有 branch 行，
    // 但这里要锁的是「bare 本身不算检出」这条规则——分支名若与 current 同名，会被「排除当前分支」
    // 那条先挡掉、根本测不到 bare（变异验证时就漏过一次）
    const res = await buildBranchOccupancy(
      [wt(null), wt("bare-branch", { bare: true }), wt("feature/b")],
      "main",
    );
    expect(Object.keys(res)).toEqual(["feature/b"]);
  });

  it("当前是 detached HEAD（current=null）：所有带分支的其他工作树都算占用", async () => {
    const res = await buildBranchOccupancy([wt("main"), wt("dev")], null);
    expect(Object.keys(res).sort()).toEqual(["dev", "main"]);
  });

  it("missing：git 标了 prunable，或目录 stat 不到（旧 git 不输出 prunable）", async () => {
    const res = await buildBranchOccupancy(
      [
        wt("alive-branch"),
        wt("pruned-branch", { prunable: true }),
        wt("ghost-branch", { path: ghost }),
      ],
      "main",
    );
    expect(res["alive-branch"]).toEqual({ path: alive, missing: false });
    expect(res["pruned-branch"]?.missing).toBe(true);
    expect(res["ghost-branch"]).toEqual({ path: ghost, missing: true });
  });

  it("同一分支被多个工作树强行检出（worktree add --force）：留第一个", async () => {
    const res = await buildBranchOccupancy(
      [wt("dup", { path: alive }), wt("dup", { path: ghost })],
      "main",
    );
    expect(res.dup).toEqual({ path: alive, missing: false });
  });

  it("分支名叫 __proto__ / constructor：结果是自有属性、不污染原型、JSON 往返不丢", async () => {
    const res = await buildBranchOccupancy(
      [wt("__proto__"), wt("constructor")],
      "main",
    );
    expect(Object.getPrototypeOf(res)).toBe(Object.prototype);
    expect(Object.hasOwn(res, "__proto__")).toBe(true);
    expect(Object.hasOwn(res, "constructor")).toBe(true);

    // 响应体走 JSON：JSON.parse 对 "__proto__" 键建的是自有属性，客户端才读得到
    const wire = JSON.parse(JSON.stringify(res)) as typeof res;
    expect(occupantOf(wire, "__proto__")).toEqual({ path: alive, missing: false });
    expect(occupantOf(wire, "constructor")).toEqual({ path: alive, missing: false });
  });
});

describe("occupantOf：只认自有属性", () => {
  it("没被占用的分支叫 constructor / toString / hasOwnProperty 时不会被误判成被占用", () => {
    const occupied: Record<string, GitBranchOccupant> = {
      "feature/a": { path: "/wt", missing: false },
    };
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(occupantOf(occupied, name), name).toBeUndefined();
    }
    expect(occupantOf(occupied, "feature/a")).toEqual({ path: "/wt", missing: false });
  });

  it("occupied 缺省（没有任何占用）→ undefined", () => {
    expect(occupantOf(undefined, "main")).toBeUndefined();
  });
});

describe("展示文案", () => {
  const live: GitBranchOccupant = {
    path: "/Users/me/Documents/my/Flowship-win-fix",
    missing: false,
  };
  const gone: GitBranchOccupant = { path: "/Users/me/old-wt", missing: true };

  it("占用者标签取路径末两段：任务隔离工作区不会被读成「就在主仓里」", () => {
    // basename 只会得到「Flowship」，跟主仓同名、误导
    expect(
      occupantLabel(
        "/Users/me/Library/Application Support/fe-ai-flow/data/worktrees/t_1791789448738_oq8nxj/Flowship",
      ),
    ).toBe("t_1791789448738_oq8nxj/Flowship");
    expect(occupantLabel(live.path)).toBe("my/Flowship-win-fix");
  });

  it("标签兼容 Windows 反斜杠 / 尾部分隔符 / 单段路径", () => {
    expect(occupantLabel("C:\\Users\\me\\Flowship-win-fix")).toBe("me/Flowship-win-fix");
    expect(occupantLabel("/a/b/")).toBe("a/b");
    expect(occupantLabel("/solo")).toBe("solo");
    expect(occupantLabel("/")).toBe("/");
  });

  it("选择器小字：占用写「已在 … 检出」、登记残留写「已删除」", () => {
    expect(occupiedBranchHint(live)).toBe("已在 my/Flowship-win-fix 检出");
    expect(occupiedBranchHint(gone)).toBe("登记在已删除的工作树上");
  });

  it("完整说明告诉用户三件事：为什么不行 / 占在哪 / 怎么办（且不是 git 原文）", () => {
    const occupiedMsg = occupiedBranchMessage("fix/win", live);
    expect(occupiedMsg).toContain("fix/win");
    expect(occupiedMsg).toContain(live.path);
    expect(occupiedMsg).toContain("不能同时检出到两个目录");
    expect(occupiedMsg).toContain("请先在那个目录里切走");

    const goneMsg = occupiedBranchMessage("fix/old", gone);
    expect(goneMsg).toContain("fix/old");
    expect(goneMsg).toContain(gone.path);
    expect(goneMsg).toContain("git worktree prune");

    for (const msg of [occupiedMsg, goneMsg]) {
      // 回归点：以前 toast 的是 git 的 fatal 原文
      expect(msg).not.toMatch(/fatal|致命/i);
    }
    // 两档措辞必须不同——残留登记不能让用户去「切走」一个根本不存在的目录
    expect(goneMsg).not.toContain("请先在那个目录里切走");
  });
});
