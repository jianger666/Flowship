/**
 * Q9-03：技能导入换目录的回滚分支 / 临时目录残留清扫。
 *
 * 用 `vi.spyOn(fs, "rename")` 注入失败，不依赖 chmod（Windows / root 下 chmod 夹具会 skip，回滚分支就没人守了）。
 * 变异：删掉回滚里的 `fs.rename(backup, dest)` → 「失败后旧版仍在」那条会红。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SKILL_IMPORT_LEFTOVER_MAX_AGE_MS,
  importSkillsFromCursor,
  sweepStaleSkillImportLeftovers,
} from "@/lib/server/app-skills";
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
  home = await fs.mkdtemp(path.join(os.tmpdir(), "fe-skill-rollback-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  await fs.rm(getAppSkillsDir(), { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe("importSkillsFromCursor：rename(tmp, dest) 失败 → 回滚旧版", () => {
  it("第二步 rename 失败：备份被改回 dest，旧版内容完整不丢，导入报失败而不是抛出", async () => {
    await writeSkill(getAppSkillsDir(), "foo", { "SKILL.md": "OLD", "keep.txt": "old-only" });
    await writeSkill(cursorSkills(), "foo", { "SKILL.md": "NEW" });

    const realRename = fs.rename.bind(fs);
    const dest = path.join(getAppSkillsDir(), "foo");
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      // 只让「新版换进 dest」这一步失败（from 是 .skill-import-xxx 临时目录、to 是 dest）
      if (String(to) === dest && path.basename(String(from)).startsWith(".skill-import-") && !String(from).endsWith(".old")) {
        throw Object.assign(new Error("EPERM: operation not permitted (injected)"), { code: "EPERM" });
      }
      return realRename(from, to);
    });

    const res = await importSkillsFromCursor(["foo"]);

    expect(res.imported).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.name).toBe("foo");
    // 失败不丢旧版：内容与附属文件都还在
    expect(await fs.readFile(path.join(dest, "SKILL.md"), "utf8")).toBe("OLD");
    expect(await fs.readFile(path.join(dest, "keep.txt"), "utf8")).toBe("old-only");
    // 没有遗留的临时目录 / 备份
    const left = (await fs.readdir(path.dirname(getAppSkillsDir()))).filter((n) => n.startsWith(".skill-import-"));
    expect(left).toEqual([]);
  });

  it("第一步 rename(dest → 备份) 失败（Windows 文件被占用）：旧版原样、导入失败", async () => {
    await writeSkill(getAppSkillsDir(), "foo", { "SKILL.md": "OLD" });
    await writeSkill(cursorSkills(), "foo", { "SKILL.md": "NEW" });
    const realRename = fs.rename.bind(fs);
    const dest = path.join(getAppSkillsDir(), "foo");
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === dest) throw Object.assign(new Error("EBUSY (injected)"), { code: "EBUSY" });
      return realRename(from, to);
    });
    const res = await importSkillsFromCursor(["foo"]);
    expect(res.failed).toHaveLength(1);
    expect(await fs.readFile(path.join(dest, "SKILL.md"), "utf8")).toBe("OLD");
  });

  it("反例（旧树能用的情形仍能用）：没有注入失败 → 正常替换成新版", async () => {
    await writeSkill(getAppSkillsDir(), "foo", { "SKILL.md": "OLD" });
    await writeSkill(cursorSkills(), "foo", { "SKILL.md": "NEW" });
    const res = await importSkillsFromCursor(["foo"]);
    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await fs.readFile(path.join(getAppSkillsDir(), "foo", "SKILL.md"), "utf8")).toBe("NEW");
  });
});

describe("临时目录残留清扫", () => {
  it("sweep：只清超过保留期的 .skill-import-*（含 .old），新的 / 无关目录不动", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fe-skill-sweep-"));
    try {
      const oldTmp = path.join(root, ".skill-import-1-aaa");
      const oldBak = path.join(root, ".skill-import-1-aaa.old");
      const fresh = path.join(root, ".skill-import-2-bbb");
      const other = path.join(root, "skills");
      for (const d of [oldTmp, oldBak, fresh, other]) {
        await fs.mkdir(d, { recursive: true });
        await fs.writeFile(path.join(d, "f.txt"), "x");
      }
      const now = Date.now();
      const stale = new Date(now - SKILL_IMPORT_LEFTOVER_MAX_AGE_MS - 60_000);
      await fs.utimes(oldTmp, stale, stale);
      await fs.utimes(oldBak, stale, stale);

      const removed = await sweepStaleSkillImportLeftovers(root, now);
      expect(removed.sort()).toEqual([".skill-import-1-aaa", ".skill-import-1-aaa.old"]);
      await expect(fs.access(oldTmp)).rejects.toThrow();
      await expect(fs.access(fresh)).resolves.toBeUndefined();
      await expect(fs.access(other)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("导入时顺手清上次遗留（Windows 占用 / 崩溃留下的 .old）", async () => {
    await writeSkill(cursorSkills(), "foo", { "SKILL.md": "NEW" });
    const root = path.dirname(getAppSkillsDir());
    await fs.mkdir(root, { recursive: true });
    const leftover = path.join(root, ".skill-import-9-zzz.old");
    await fs.mkdir(leftover, { recursive: true });
    const stale = new Date(Date.now() - SKILL_IMPORT_LEFTOVER_MAX_AGE_MS - 60_000);
    await fs.utimes(leftover, stale, stale);

    await importSkillsFromCursor(["foo"]);
    await expect(fs.access(leftover)).rejects.toThrow();
  });

  it("失败报错里不再带 .skill-import-* 临时路径（换回目标 skill 路径）", async () => {
    await writeSkill(cursorSkills(), "bad", { "SKILL.md": "x" });
    const realCp = fs.cp.bind(fs);
    vi.spyOn(fs, "cp").mockImplementation(async (src, dst, opts) => {
      await realCp(src, dst, opts).catch(() => {});
      throw new Error(`EACCES: permission denied, open '${String(dst)}/scripts/x.sh'`);
    });
    const res = await importSkillsFromCursor(["bad"]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.error).not.toContain(".skill-import-");
    expect(res.failed[0]!.error).toContain(path.join(getAppSkillsDir(), "bad"));
  });
});
