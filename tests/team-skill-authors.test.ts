/**
 * 团队库 skill 创建人索引：git log 输出解析纯函数 + getTeamSkillAuthors 单飞
 *
 * 契约：
 * - `--reverse` 时间正序、首个新增某目录 SKILL.md 的 commit author = 创建人
 * - 同目录重复新增（删了重加）不覆盖首次记录
 * - 只认 SKILL.md 锚点文件、其它新增文件忽略
 * - cache miss 并发两次 → 底层全量 log 只执行一次
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetTeamSkillAuthorsForTest,
  getTeamSkillAuthors,
  parseAuthorIndexFromGitLog,
} from "@/lib/server/team-skill-authors";

const M = "\u0001"; // 与实现一致的 commit 头行标记（%x01）

afterEach(() => {
  __resetTeamSkillAuthorsForTest();
});

describe("parseAuthorIndexFromGitLog", () => {
  it("按首次引入 SKILL.md 的 commit 归属创建人", () => {
    const stdout = [
      `${M}陈禄江`,
      "",
      "skills/common/wk-biz-analyze/SKILL.md",
      "skills/common/wk-biz-analyze/.flowship-action.json",
      "",
      `${M}苏蔚`,
      "",
      "knowledge/skills/global/wk-harness/SKILL.md",
      "knowledge/skills/global/wk-harness/references/doc-repo.md",
    ].join("\n");
    expect(parseAuthorIndexFromGitLog(stdout)).toEqual({
      "skills/common/wk-biz-analyze": "陈禄江",
      "knowledge/skills/global/wk-harness": "苏蔚",
    });
  });

  it("同目录重复新增不覆盖首次创建人", () => {
    const stdout = [
      `${M}甲`,
      "skills/common/a/SKILL.md",
      `${M}乙`,
      "skills/common/a/SKILL.md", // 删了重加：仍算甲创建
    ].join("\n");
    expect(parseAuthorIndexFromGitLog(stdout)).toEqual({
      "skills/common/a": "甲",
    });
  });

  it("非 SKILL.md 新增与根目录裸 SKILL.md 都忽略", () => {
    const stdout = [
      `${M}甲`,
      "skills/common/a/references/api.md",
      "SKILL.md", // 仓库根裸文件、无目录可归属
      "README.md",
    ].join("\n");
    expect(parseAuthorIndexFromGitLog(stdout)).toEqual({});
  });

  it("空输出返回空表", () => {
    expect(parseAuthorIndexFromGitLog("")).toEqual({});
  });
});

describe("getTeamSkillAuthors inFlight 单飞", () => {
  it("并发两次 cache miss → 全量 git log 只执行一次", async () => {
    let logCalls = 0;
    let releaseLog!: () => void;
    const logGate = new Promise<void>((r) => {
      releaseLog = r;
    });

    const fakeGit = async (
      _repoDir: string,
      args: string[],
    ): Promise<string | null> => {
      if (args[0] === "rev-parse") return "abc123deadbeef";
      if (args[0] === "log") {
        logCalls += 1;
        await logGate;
        return [`${M}甲`, "skills/common/a/SKILL.md"].join("\n");
      }
      return null;
    };

    const p1 = getTeamSkillAuthors("/fake-repo", fakeGit);
    const p2 = getTeamSkillAuthors("/fake-repo", fakeGit);
    // 两趟都已进入、卡在 logGate 前——此时应只有 1 次 log
    await Promise.resolve();
    await Promise.resolve();
    expect(logCalls).toBe(1);

    releaseLog();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual({ "skills/common/a": "甲" });
    expect(b).toEqual({ "skills/common/a": "甲" });
    expect(logCalls).toBe(1);
  });
});
