/**
 * skill-creator 在 pi provider 下拿不到 FLOWSHIP_DATA_DIR（stripHostInjectedEnv 故意剥掉），
 * 所以 prompt 的可用 skill 段必须直接带上自管 skill 目录的绝对路径。
 * 行为断言：渲染结果里能读出 `<dataRoot>/skills/<skill名>/SKILL.md`，且不依赖 agent 侧环境变量。
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAppSkillsDir,
  renderAppSkillsDirHint,
  renderSkillsForPrompt,
  type SkillEntry,
} from "@/lib/server/skills-loader";

const ORIG = process.env.FLOWSHIP_DATA_DIR;
afterEach(() => {
  if (ORIG === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = ORIG;
});

const entry = (name: string): SkillEntry =>
  ({
    name,
    description: "demo",
    absPath: `/x/${name}/SKILL.md`,
  }) as SkillEntry;

describe("可用 skill 段：自管 skill 目录绝对路径提示", () => {
  it("段首（第二行）带数据目录下的 skills 绝对路径，随 FLOWSHIP_DATA_DIR 变化", () => {
    const dir = path.join(path.sep, "tmp", "flowship-hint-data");
    process.env.FLOWSHIP_DATA_DIR = dir;
    const rendered = renderSkillsForPrompt([entry("a")]);
    const lines = rendered.split("\n");
    // 第一行仍是「相对路径解析」（skill-resource-paths 依赖），提示在第二行
    expect(lines[0]).toContain("相对路径解析");
    expect(lines[1]).toContain(
      path.join(dir, "skills", "<skill名>", "SKILL.md"),
    );
    expect(getAppSkillsDir()).toBe(path.join(dir, "skills"));
  });

  it("提示行本身不泄漏凭证相关字段", () => {
    process.env.FLOWSHIP_DATA_DIR = path.join(path.sep, "tmp", "d");
    const hint = renderAppSkillsDirHint();
    expect(hint).not.toMatch(/token|config\.json|password/i);
  });
});
