/**
 * deleteSkillBySource：按 frontmatter 名定位真实目录，对不上时明确失败（不再「删除成功」）
 *
 * 旧行为：直接 `rm(<根>/<name>, { recursive, force: true })`。设置页传来的是 SKILL.md frontmatter 里的名字，
 * 它不一定等于目录名：不一致时目标目录不存在、force 让它悄悄「成功」，skill 原样还在；
 * 若恰好有别的 skill 的目录叫这个名字，删掉的是那一个。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteSkillBySource } from "@/lib/server/app-skills";

let root: string;
let skillsDir: string;
let savedDataDir: string | undefined;

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n`;

const putSkill = async (dir: string, fmName: string | null): Promise<void> => {
  const d = path.join(skillsDir, dir);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(
    path.join(d, "SKILL.md"),
    fmName === null ? "no frontmatter at all\n" : skillMd(fmName),
  );
  await fs.writeFile(path.join(d, "helper.txt"), "附属文件");
};

const exists = async (p: string): Promise<boolean> =>
  fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-skill-del-"));
  skillsDir = path.join(root, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  savedDataDir = process.env.FLOWSHIP_DATA_DIR;
  process.env.FLOWSHIP_DATA_DIR = root;
});

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = savedDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

describe("deleteSkillBySource（app 源）", () => {
  it("常规：目录名 = frontmatter 名 → 整目录（含附属文件）删掉、返回 null", async () => {
    await putSkill("alpha", "alpha");
    expect(await deleteSkillBySource("alpha", "app")).toBeNull();
    expect(await exists(path.join(skillsDir, "alpha"))).toBe(false);
  });

  it("frontmatter 名与目录名不一致：按真实目录删（改前目标不存在、悄悄「成功」、skill 还在）", async () => {
    await putSkill("foo-skill-dir", "foo");
    expect(await deleteSkillBySource("foo", "app")).toBeNull();
    expect(await exists(path.join(skillsDir, "foo-skill-dir"))).toBe(false);
  });

  it("别的 skill 的目录恰好叫这个名字：删的是名字对得上的那个，不误删同名目录", async () => {
    await putSkill("foo", "bar"); // 目录 foo 里装的是叫 bar 的 skill
    await putSkill("foo-real", "foo"); // 叫 foo 的 skill 在 foo-real 里
    expect(await deleteSkillBySource("foo", "app")).toBeNull();
    expect(await exists(path.join(skillsDir, "foo-real"))).toBe(false);
    expect(await exists(path.join(skillsDir, "foo", "SKILL.md"))).toBe(true); // 没误删
  });

  it("找不到（没有同名目录、也没有 SKILL.md 声明这个名字）→ 明确失败、不报成功", async () => {
    await putSkill("keep", "keep");
    const r = await deleteSkillBySource("ghost", "app");
    expect(r).toContain("未找到");
    expect(await exists(path.join(skillsDir, "keep", "SKILL.md"))).toBe(true);
  });

  it("同名歧义（两个不同目录都声明 dup、目录名都不是 dup）→ 明确失败、两个都不删", async () => {
    await putSkill("d1", "dup");
    await putSkill("d2", "dup");
    const r = await deleteSkillBySource("dup", "app");
    expect(r).toContain("无法确定删哪一个");
    expect(await exists(path.join(skillsDir, "d1"))).toBe(true);
    expect(await exists(path.join(skillsDir, "d2"))).toBe(true);
  });

  it("同名多个时优先目录名也叫它的那个", async () => {
    await putSkill("dup", "dup");
    await putSkill("other-dir", "dup");
    expect(await deleteSkillBySource("dup", "app")).toBeNull();
    expect(await exists(path.join(skillsDir, "dup"))).toBe(false);
    expect(await exists(path.join(skillsDir, "other-dir"))).toBe(true);
  });

  it("残缺目录（SKILL.md 没有 frontmatter、扫描认不出）：目录名 = 名字 → 旧行为照旧清掉", async () => {
    await putSkill("broken", null);
    expect(await deleteSkillBySource("broken", "app")).toBeNull();
    expect(await exists(path.join(skillsDir, "broken"))).toBe(false);
  });

  it("分组目录里还装着别的 skill → 拒绝整目录删除、什么都不删", async () => {
    await putSkill("group", "group");
    await fs.mkdir(path.join(skillsDir, "group", "sub"), { recursive: true });
    await fs.writeFile(path.join(skillsDir, "group", "sub", "SKILL.md"), skillMd("sub"));
    const r = await deleteSkillBySource("group", "app");
    expect(r).toContain("其它 skill");
    expect(await exists(path.join(skillsDir, "group", "sub", "SKILL.md"))).toBe(true);
  });

  it("目录级符号链接装法：只删链接、不碰链接指向的真目录", async () => {
    const real = path.join(root, "real-skill");
    await fs.mkdir(real, { recursive: true });
    await fs.writeFile(path.join(real, "SKILL.md"), skillMd("linked"));
    await fs.symlink(real, path.join(skillsDir, "linked"), "dir");
    expect(await deleteSkillBySource("linked", "app")).toBeNull();
    expect(await exists(path.join(skillsDir, "linked"))).toBe(false);
    expect(await exists(path.join(real, "SKILL.md"))).toBe(true);
  });

  it("名字非法 / 路径穿越 → 拒绝、根目录与外面的东西都在", async () => {
    await fs.writeFile(path.join(root, "outside.txt"), "x");
    for (const bad of ["..", "../skills", "a/b", ".hidden", "", "a\\b"]) {
      const r = await deleteSkillBySource(bad, "app");
      expect(typeof r, bad).toBe("string");
    }
    expect(await exists(skillsDir)).toBe(true);
    expect(await exists(path.join(root, "outside.txt"))).toBe(true);
  });

  it("只读来源（builtin / team）→ 拒绝", async () => {
    expect(await deleteSkillBySource("x", "builtin")).toContain("不可删除");
    expect(await deleteSkillBySource("x", "team")).toContain("不可删除");
  });
});
