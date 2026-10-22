/**
 * 「从 Cursor 导入 skill」：先拷到临时目录、成功后才替换旧版（第三轮 review D2b-04）。
 *
 * 旧实现 `fs.rm(dest)` 然后 `fs.cp(src, dest)`：源目录里任何一个读不了的文件（权限 / 坏链）
 * 让 cp 中途抛错，用户原来装好的同名 skill 已经被删光，留下半截目录。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importSkillsFromCursor, writeAppSkill } from "@/lib/server/app-skills";
import { getAppSkillsDir } from "@/lib/server/skills-loader";

let home: string;

const writeSkill = async (root: string, name: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, name, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
  }
};

const cursorSkills = () => path.join(home, ".cursor", "skills");

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "fe-skill-import-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  await fs.rm(getAppSkillsDir(), { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // chmod 000 的夹具文件要先放开才删得掉
  await fs.chmod(path.join(cursorSkills(), "lock", "scripts", "x.sh"), 0o644).catch(() => {});
  await fs.rm(home, { recursive: true, force: true });
});

describe("importSkillsFromCursor 替换语义", () => {
  it("成功：旧版整个被换掉（旧版里多出来的文件不残留），目录里没有遗留的临时目录", async () => {
    await writeSkill(getAppSkillsDir(), "foo", { "SKILL.md": "OLD", "stale.txt": "old-only" });
    await writeSkill(cursorSkills(), "foo", { "SKILL.md": "NEW", "scripts/run.sh": "echo" });

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await fs.readFile(path.join(getAppSkillsDir(), "foo", "SKILL.md"), "utf8")).toBe("NEW");
    expect(await fs.readFile(path.join(getAppSkillsDir(), "foo", "scripts", "run.sh"), "utf8")).toBe("echo");
    await expect(fs.access(path.join(getAppSkillsDir(), "foo", "stale.txt"))).rejects.toThrow();
    // skills 目录里只有 foo；数据根下也没留 .skill-import-* 临时目录
    expect(await fs.readdir(getAppSkillsDir())).toEqual(["foo"]);
    const siblings = await fs.readdir(path.dirname(getAppSkillsDir()));
    expect(siblings.filter((n) => n.startsWith(".skill-import"))).toEqual([]);
  });

  it("首次导入（本来没有旧版）也正常", async () => {
    await writeSkill(cursorSkills(), "fresh", { "SKILL.md": "NEW" });
    const res = await importSkillsFromCursor(["fresh"]);
    expect(res.imported).toEqual(["fresh"]);
    expect(await fs.readFile(path.join(getAppSkillsDir(), "fresh", "SKILL.md"), "utf8")).toBe("NEW");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "源里有读不了的文件、拷贝中途失败：旧版原样保留，临时目录清掉，报告失败",
    async () => {
      await writeSkill(getAppSkillsDir(), "lock", { "SKILL.md": "OLD", "keep.txt": "keep-me" });
      await writeSkill(cursorSkills(), "lock", { "SKILL.md": "NEW", "scripts/x.sh": "secret" });
      await fs.chmod(path.join(cursorSkills(), "lock", "scripts", "x.sh"), 0o000);

      const res = await importSkillsFromCursor(["lock"]);

      expect(res.imported).toEqual([]);
      expect(res.failed).toHaveLength(1);
      expect(res.failed[0].name).toBe("lock");
      // 旧版一个字节没动
      expect(await fs.readFile(path.join(getAppSkillsDir(), "lock", "SKILL.md"), "utf8")).toBe("OLD");
      expect(await fs.readFile(path.join(getAppSkillsDir(), "lock", "keep.txt"), "utf8")).toBe("keep-me");
      const siblings = await fs.readdir(path.dirname(getAppSkillsDir()));
      expect(siblings.filter((n) => n.startsWith(".skill-import"))).toEqual([]);
    },
  );

  it("writeAppSkill：覆盖写走临时文件 + rename，成功后目录里没有 .tmp 残留", async () => {
    expect(await writeAppSkill("doc", "v1")).toBeNull();
    expect(await writeAppSkill("doc", "v2")).toBeNull();
    expect(await fs.readFile(path.join(getAppSkillsDir(), "doc", "SKILL.md"), "utf8")).toBe("v2");
    expect(await fs.readdir(path.join(getAppSkillsDir(), "doc"))).toEqual(["SKILL.md"]);
    // 校验失败路径不变
    expect(await writeAppSkill("doc", "   ")).toBe("SKILL.md 内容不能为空");
  });

  it("多个里一个失败不影响其余（逐个独立）", async () => {
    await writeSkill(cursorSkills(), "good", { "SKILL.md": "NEW" });
    const res = await importSkillsFromCursor(["missing", "good"]);
    expect(res.imported).toEqual(["good"]);
    expect(res.failed.map((f) => f.name)).toEqual(["missing"]);
  });
});
