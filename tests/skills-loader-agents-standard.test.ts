/**
 * agentskills.io 标准目录收口到 skills-loader 的回归测试
 *
 * 覆盖：
 * - 全局 ~/.agents/skills/ 作为低优先级源并入 loadSkills（gate=std、不查禁用表）
 * - 同名时 fe 私有源覆盖标准目录（飞书 CLI data/tools/skills 新版压 ~/.agents 历史副本）
 * - 项目级 <repo>/.agents/skills/ 由 loadSkillsForTask 并入，base 同名覆盖
 *
 * 全局目录通过 vi.mock("node:os").homedir 指向临时 fixture，隔离真实用户环境。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-skills-agents-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

// homedir 可变桩：mock 工厂在 import 时执行，用 holder 延迟到 beforeAll 再定值
const homeHolder = vi.hoisted(() => ({ home: "/nonexistent-home" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => homeHolder.home;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

import { getGlobalAgentsSkillsDir, loadSkills, loadSkillsForTask } from "@/lib/server/skills-loader";

const writeSkill = async (dir: string, name: string, desc = "测试技能") => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`,
    "utf-8",
  );
};

beforeAll(async () => {
  homeHolder.home = path.join(TMP_ROOT, "home");
  // 全局标准目录：user-global
  await writeSkill(
    path.join(homeHolder.home, ".agents", "skills", "my-global"),
    "my-global",
    "全局自装",
  );
  // 飞书 CLI 私有源（dataRoot/tools/skills）：与全局同名 → 应覆盖
  await writeSkill(
    path.join(TMP_ROOT, "tools", "skills", "my-dup"),
    "my-dup",
    "fe私有源版本",
  );
  // 全局也放一份 my-dup（历史旧副本）
  await writeSkill(
    path.join(homeHolder.home, ".agents", "skills", "my-dup"),
    "my-dup",
    "历史副本",
  );
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("agentskills 标准目录收口", () => {
  it("全局 ~/.agents/skills 被扫进 loadSkills", async () => {
    expect(getGlobalAgentsSkillsDir()).toContain(path.join(".agents", "skills"));
    const all = await loadSkills();
    const hit = all.find((s) => s.name === "my-global");
    expect(hit?.absPath).toContain(path.join(".agents", "skills"));
  });

  it("同名时 fe 私有源（tools/skills）覆盖全局标准目录的历史副本", async () => {
    const all = await loadSkills();
    const dup = all.find((s) => s.name === "my-dup");
    expect(dup?.absPath).toContain(path.join("tools", "skills"));
    expect(dup?.description).toBe("fe私有源版本");
    // 且全列表无重名（去重生效）
    const names = all.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("项目级 <repo>/.agents/skills 由 loadSkillsForTask 并入；base 同名覆盖", async () => {
    const repo = path.join(TMP_ROOT, "some-repo");
    await writeSkill(path.join(repo, ".agents", "skills", "proj-only"), "proj-only", "项目级");
    // 与全局同名的项目级 skill → base（含全局）应胜出？不——优先级是全局 > 项目，
    // 但两者都低于 fe 私有源；这里验证项目级能进来且同名归一到一份。
    const all = await loadSkillsForTask([repo]);
    const names = all.map((s) => s.name);
    expect(names).toContain("proj-only");
    expect(new Set(names).size).toBe(names.length);

    // 项目级与 fe 私有源同名 → fe 私有源版本胜出
    await writeSkill(path.join(repo, ".agents", "skills", "my-dup"), "my-dup", "项目级旧版");
    const all2 = await loadSkillsForTask([repo]);
    expect(all2.find((s) => s.name === "my-dup")?.description).toBe("fe私有源版本");

    // 无绑仓调用（[]）不炸、仍返回全局合并结果
    const base = await loadSkillsForTask([]);
    expect(base.find((s) => s.name === "my-global")).toBeDefined();
  });
});
