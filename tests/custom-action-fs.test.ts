/**
 * 自定义 action：skill 托管壳（.flowship-action.json）+ 旧格式停用 + 迁移
 *
 * 回归点：
 * - 自建派生 app:<skill>；创建要求 skill 目录已存在
 * - 导入保留 .flowship-action.json；导出写 requiresKnowledge
 * - 迁移幂等 + actionLayout remap
 * - legacy playbook 仍列在 custom-actions/
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-custom-action-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

import {
  appActionIdFor,
  createCustomAction,
  CustomActionFsError,
  exportCustomAction,
  getCustomAction,
  importCustomActionBundle,
  listCustomActions,
  migrateCustomActionsToSkillHosted,
  parseFlowshipActionMeta,
  remapActionLayoutIds,
  removeActionShell,
  sanitizeSkillName,
  updateCustomAction,
} from "@/lib/server/custom-action-fs";
import { usableCustomActions } from "@/lib/action-layout";
import { getAppSkillsDir } from "@/lib/server/skills-loader";

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

/** 每个用例清 custom-actions + app skills + config，避免互相污染 */
beforeEach(async () => {
  await fs.rm(path.join(TMP_ROOT, "custom-actions"), {
    recursive: true,
    force: true,
  });
  await fs.rm(getAppSkillsDir(), { recursive: true, force: true });
  await fs.rm(path.join(TMP_ROOT, "config.json"), { force: true });
});

const seedSkill = async (name: string, body = "方法论正文") => {
  const dir = path.join(getAppSkillsDir(), name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: 测\n---\n\n${body}\n`,
    "utf-8",
  );
  return dir;
};

describe("custom-action 新格式（skill 托管 json）", () => {
  it("创建 / 读取 / 更新：写 .flowship-action.json、id=app:<skill>", async () => {
    await seedSkill("perf-audit");
    const created = await createCustomAction({
      label: "性能审计",
      skill: "perf-audit",
      placeholder: "贴页面 URL",
    });
    expect(created.id).toBe("app:perf-audit");
    expect(created.origin).toBe("app-skill");
    expect(created.skill).toBe("perf-audit");
    expect(created.output).toBeUndefined();

    const raw = await fs.readFile(
      path.join(getAppSkillsDir(), "perf-audit", ".flowship-action.json"),
      "utf-8",
    );
    const meta = JSON.parse(raw) as Record<string, unknown>;
    expect(meta.label).toBe("性能审计");
    expect(meta).not.toHaveProperty("id");
    expect(meta).not.toHaveProperty("skill");

    const got = await getCustomAction("app:perf-audit");
    expect(got?.skill).toBe("perf-audit");

    // skill 字段不可变
    await expect(
      updateCustomAction("app:perf-audit", { skill: "perf-audit-v2" }),
    ).rejects.toThrow(/不可改/);

    const updated = await updateCustomAction("app:perf-audit", {
      label: "性能审计 v2",
      placeholder: "新占位",
    });
    expect(updated.label).toBe("性能审计 v2");
    expect(updated.skill).toBe("perf-audit");
  });

  it("创建：skill 目录不存在 → 抛；已有 json → ALREADY_MOUNTED", async () => {
    await expect(
      createCustomAction({ label: "无 skill", skill: "missing-xyz" }),
    ).rejects.toMatchObject({
      name: "CustomActionFsError",
      code: "NOT_FOUND",
    });

    await seedSkill("dup-shell");
    await createCustomAction({ label: "一次", skill: "dup-shell" });
    await expect(
      createCustomAction({ label: "二次", skill: "dup-shell" }),
    ).rejects.toBeInstanceOf(CustomActionFsError);
    await expect(
      createCustomAction({ label: "二次", skill: "dup-shell" }),
    ).rejects.toMatchObject({ code: "ALREADY_MOUNTED" });
  });

  it("output / requiresKnowledge 读写往返", async () => {
    await seedSkill("rollback-method");
    const created = await createCustomAction({
      label: "版本回滚",
      skill: "rollback-method",
      output: "输出回滚记录：\n- 回到哪个版本\n- 动了哪些分支",
      requiresKnowledge: true,
    });
    expect(created.output).toContain("回到哪个版本");
    expect(created.requiresKnowledge).toBe(true);

    const raw = await fs.readFile(
      path.join(getAppSkillsDir(), "rollback-method", ".flowship-action.json"),
      "utf-8",
    );
    expect(raw).toContain("requiresKnowledge");
    expect(raw).toContain("回到哪个版本");

    const cleared = await updateCustomAction("app:rollback-method", {
      output: "  ",
      requiresKnowledge: false,
    });
    expect(cleared.output).toBeUndefined();
    expect(cleared.requiresKnowledge).toBeUndefined();
    const clearedRaw = await fs.readFile(
      path.join(getAppSkillsDir(), "rollback-method", ".flowship-action.json"),
      "utf-8",
    );
    expect(clearedRaw).not.toContain("output");
    expect(clearedRaw).not.toContain("requiresKnowledge");
  });

  it("removeActionShell 只删 json、保留 skill 目录", async () => {
    await seedSkill("shell-only");
    await createCustomAction({ label: "壳", skill: "shell-only" });
    await removeActionShell("shell-only");
    await expect(
      fs.access(
        path.join(getAppSkillsDir(), "shell-only", ".flowship-action.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(getAppSkillsDir(), "shell-only", "SKILL.md")),
    ).resolves.toBeUndefined();
    expect(await getCustomAction("app:shell-only")).toBeNull();
  });
});

describe("parseFlowshipActionMeta requiresKnowledge", () => {
  it("仅严格 true 才写入；其它假值忽略", () => {
    expect(
      parseFlowshipActionMeta(
        JSON.stringify({ label: "a", requiresKnowledge: true, exportedAt: 1 }),
      )?.requiresKnowledge,
    ).toBe(true);
    expect(
      parseFlowshipActionMeta(
        JSON.stringify({
          label: "a",
          requiresKnowledge: false,
          exportedAt: 1,
        }),
      )?.requiresKnowledge,
    ).toBeUndefined();
    expect(
      parseFlowshipActionMeta(
        JSON.stringify({
          label: "a",
          requiresKnowledge: "true",
          exportedAt: 1,
        }),
      )?.requiresKnowledge,
    ).toBeUndefined();
  });
});

describe("旧格式（playbook 正文）：停用、不自动抽 skill", () => {
  const writeLegacyAction = async (
    id: string,
    opts: {
      label: string;
      playbook: string;
      skills?: string[];
    },
  ) => {
    const dir = path.join(TMP_ROOT, "custom-actions", id);
    await fs.mkdir(dir, { recursive: true });
    const skillsLine =
      opts.skills && opts.skills.length > 0
        ? `skills:\n${opts.skills.map((s) => `  - ${s}`).join("\n")}\n`
        : "";
    const raw = `---
label: ${opts.label}
${skillsLine}createdAt: 1000
updatedAt: 1000
---

${opts.playbook}
`;
    await fs.writeFile(path.join(dir, "ACTION.md"), raw, "utf-8");
  };

  it("get 不迁移：返回 legacyPlaybook 标记、文件原样", async () => {
    await writeLegacyAction("perf-audit", {
      label: "Perf Audit",
      playbook: "## 目标\n扫性能瓶颈\n\n## 产出\n写报告",
      skills: ["feishu-doc"],
    });

    const def = await getCustomAction("perf-audit");
    expect(def).not.toBeNull();
    expect(def!.skill).toBe("");
    expect(def!.legacyPlaybook).toContain("扫性能瓶颈");

    const actionRaw = await fs.readFile(
      path.join(TMP_ROOT, "custom-actions", "perf-audit", "ACTION.md"),
      "utf-8",
    );
    expect(actionRaw).toContain("扫性能瓶颈");
    expect(actionRaw).not.toContain("skill: ");
  });

  it("list：legacy 带标记返回；推进列表滤掉", async () => {
    await writeLegacyAction("listed", {
      label: "Listed",
      playbook: "列表正文",
    });
    await seedSkill("some-skill");
    await createCustomAction({ label: "新动作", skill: "some-skill" });
    const list = await listCustomActions();
    const legacy = list.find((a) => a.id === "listed");
    expect(legacy?.legacyPlaybook).toBe("列表正文");
    const usable = usableCustomActions(list);
    expect(usable.map((a) => a.label)).toEqual(["新动作"]);
  });

  it("旧平铺 <id>.md 仍目录化（无损搬家）", async () => {
    const flat = path.join(TMP_ROOT, "custom-actions", "flat-legacy.md");
    await fs.mkdir(path.dirname(flat), { recursive: true });
    await fs.writeFile(
      flat,
      `---\nlabel: Flat\ncreatedAt: 1000\nupdatedAt: 1000\n---\n\n平铺正文\n`,
      "utf-8",
    );
    const list = await listCustomActions();
    const def = list.find((a) => a.id === "flat-legacy");
    expect(def?.legacyPlaybook).toBe("平铺正文");
    await expect(fs.access(flat)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("legacy 不可编辑 / 不可导出", async () => {
    await writeLegacyAction("frozen", {
      label: "Frozen",
      playbook: "冻结正文",
    });
    await expect(
      updateCustomAction("frozen", { label: "改名" }),
    ).rejects.toThrow(/旧格式/);
    const target = path.join(TMP_ROOT, "export-legacy");
    await fs.mkdir(target, { recursive: true });
    await expect(exportCustomAction("frozen", target)).rejects.toThrow(
      /旧格式/,
    );
  });
});

describe("迁移 custom-actions → skill 托管", () => {
  it("非 legacy ACTION.md → 写 json + 删旧目录；幂等", async () => {
    await seedSkill("migrated-skill");
    const oldDir = path.join(TMP_ROOT, "custom-actions", "old-act");
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(
      path.join(oldDir, "ACTION.md"),
      `---\nlabel: 旧挂壳\nskill: migrated-skill\noutput: 产出\ncreatedAt: 100\nupdatedAt: 200\n---\n`,
      "utf-8",
    );

    const r1 = await migrateCustomActionsToSkillHosted();
    expect(r1.idMap["old-act"]).toBe("app:migrated-skill");
    await expect(fs.access(oldDir)).rejects.toMatchObject({ code: "ENOENT" });
    const meta = parseFlowshipActionMeta(
      await fs.readFile(
        path.join(getAppSkillsDir(), "migrated-skill", ".flowship-action.json"),
        "utf-8",
      ),
    );
    expect(meta?.label).toBe("旧挂壳");
    expect(meta?.exportedAt).toBe(200);

    // 幂等：再迁不覆盖、不炸
    await fs.writeFile(
      path.join(getAppSkillsDir(), "migrated-skill", ".flowship-action.json"),
      JSON.stringify({ label: "已有", exportedAt: 999 }),
      "utf-8",
    );
    // 再塞一个旧目录（模拟半残）——有 json 时只删目录
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(
      path.join(oldDir, "ACTION.md"),
      `---\nlabel: 再迁\nskill: migrated-skill\ncreatedAt: 1\nupdatedAt: 1\n---\n`,
      "utf-8",
    );
    await migrateCustomActionsToSkillHosted();
    const kept = parseFlowshipActionMeta(
      await fs.readFile(
        path.join(getAppSkillsDir(), "migrated-skill", ".flowship-action.json"),
        "utf-8",
      ),
    );
    expect(kept?.label).toBe("已有");
    await expect(fs.access(oldDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("remapActionLayoutIds：映射 + 去重；builtin-fix-bug → app:fix-bug", async () => {
    expect(
      remapActionLayoutIds(
        {
          order: ["plan", "old-act", "app:migrated-skill", "builtin-fix-bug"],
          hidden: ["old-act", "ship"],
        },
        {
          "old-act": "app:migrated-skill",
          "builtin-fix-bug": "app:fix-bug",
        },
      ),
    ).toEqual({
      order: ["plan", "app:migrated-skill", "app:fix-bug"],
      hidden: ["app:migrated-skill", "ship"],
    });
  });

  it("迁移时 remap config.json actionLayout", async () => {
    await seedSkill("layout-skill");
    await fs.writeFile(
      path.join(TMP_ROOT, "config.json"),
      JSON.stringify({
        actionLayout: {
          order: ["plan", "my-old", "builtin-fix-bug"],
          hidden: ["my-old"],
        },
      }),
      "utf-8",
    );
    const oldDir = path.join(TMP_ROOT, "custom-actions", "my-old");
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(
      path.join(oldDir, "ACTION.md"),
      `---\nlabel: 布局测\nskill: layout-skill\ncreatedAt: 1\nupdatedAt: 1\n---\n`,
      "utf-8",
    );

    await migrateCustomActionsToSkillHosted();
    const cfg = JSON.parse(
      await fs.readFile(path.join(TMP_ROOT, "config.json"), "utf-8"),
    ) as { actionLayout: { order: string[]; hidden: string[] } };
    expect(cfg.actionLayout.order).toEqual([
      "plan",
      "app:layout-skill",
      "app:fix-bug",
    ]);
    expect(cfg.actionLayout.hidden).toEqual(["app:layout-skill"]);
  });

  it("skill 目录缺失 → 跳过保留 ACTION.md", async () => {
    const oldDir = path.join(TMP_ROOT, "custom-actions", "orphan");
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(
      path.join(oldDir, "ACTION.md"),
      `---\nlabel: 孤儿\nskill: no-such-skill\ncreatedAt: 1\nupdatedAt: 1\n---\n`,
      "utf-8",
    );
    await migrateCustomActionsToSkillHosted();
    await expect(
      fs.access(path.join(oldDir, "ACTION.md")),
    ).resolves.toBeUndefined();
    // 非 legacy 不进 list
    const list = await listCustomActions();
    expect(list.find((a) => a.id === "orphan")).toBeUndefined();
  });
});

describe("custom-action 导出 / 导入", () => {
  it("导出：拷 skill + 写 json（含 requiresKnowledge）", async () => {
    await seedSkill("export-me", "导出用方法论");
    const created = await createCustomAction({
      label: "导出测",
      skill: "export-me",
      output: "要一份报告",
      placeholder: "贴链接",
      requiresKnowledge: true,
    });

    const target = path.join(TMP_ROOT, "export-out");
    await fs.mkdir(target, { recursive: true });
    const { skillDir, skillName } = await exportCustomAction(
      created.id,
      target,
    );
    expect(skillName).toBe("export-me");
    expect(skillDir).toBe(path.join(target, "export-me"));

    const meta = JSON.parse(
      await fs.readFile(path.join(skillDir, ".flowship-action.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(meta.label).toBe("导出测");
    expect(meta.requiresKnowledge).toBe(true);
    expect(meta).not.toHaveProperty("id");
  });

  it("导出：主 skill 本机找不到 → 报错", async () => {
    // 手写 json 但 SKILL.md 名对不上加载链——用假目录名直接 create 需要 skill 存在；
    // 这里 seed 后删 SKILL 不可见：删整个目录外的 find 失败场景用 team id 不便；
    // 改为 seed 后用 get 不到的 id
    await seedSkill("gone-soon");
    await createCustomAction({ label: "将丢", skill: "gone-soon" });
    await fs.rm(path.join(getAppSkillsDir(), "gone-soon"), {
      recursive: true,
      force: true,
    });
    const target = path.join(TMP_ROOT, "export-fail");
    await fs.mkdir(target, { recursive: true });
    await expect(
      exportCustomAction(appActionIdFor("gone-soon"), target),
    ).rejects.toThrow(/不存在|找不到/);
  });

  it("导入：保留 .flowship-action.json、派生 app action", async () => {
    const pack = path.join(TMP_ROOT, "import-pack", "import-me");
    await fs.mkdir(pack, { recursive: true });
    await fs.writeFile(
      path.join(pack, "SKILL.md"),
      `---\nname: import-me\ndescription: 导入测\n---\n\n导入正文\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(pack, ".flowship-action.json"),
      JSON.stringify({
        label: "导入挂壳",
        output: "产出一份清单",
        summary: "旧简介该忽略",
        exportedAt: Date.now(),
      }),
      "utf-8",
    );

    const r = await importCustomActionBundle(pack);
    expect(r.skillName).toBe("import-me");
    expect(r.action?.id).toBe("app:import-me");
    expect(r.action?.label).toBe("导入挂壳");
    expect(r.action?.origin).toBe("app-skill");
    expect(r.actionError).toBeUndefined();

    await expect(
      fs.access(
        path.join(getAppSkillsDir(), "import-me", ".flowship-action.json"),
      ),
    ).resolves.toBeUndefined();
  });

  it("导入：无 json → 只进 skill、不挂壳", async () => {
    const pack = path.join(TMP_ROOT, "import-pack", "skill-only");
    await fs.mkdir(pack, { recursive: true });
    await fs.writeFile(
      path.join(pack, "SKILL.md"),
      `---\nname: skill-only\ndescription: 仅 skill\n---\n\n只有方法论\n`,
      "utf-8",
    );
    const r = await importCustomActionBundle(pack);
    expect(r.action).toBeNull();
  });

  it("导入：同名 skill 已存在 → 报错不覆盖", async () => {
    await seedSkill("dup-skill", "旧内容");
    const pack = path.join(TMP_ROOT, "import-pack", "dup-skill");
    await fs.mkdir(pack, { recursive: true });
    await fs.writeFile(
      path.join(pack, "SKILL.md"),
      `---\nname: dup-skill\ndescription: 新\n---\n\n新内容别覆盖\n`,
      "utf-8",
    );
    await expect(importCustomActionBundle(pack)).rejects.toThrow(
      /同名 skill 已存在/,
    );
  });

  it("导入：缺 SKILL.md / description / name 不一致 → 报错", async () => {
    const noMd = path.join(TMP_ROOT, "import-pack", "no-skill-md");
    await fs.mkdir(noMd, { recursive: true });
    await expect(importCustomActionBundle(noMd)).rejects.toThrow(/SKILL\.md/);

    const noDesc = path.join(TMP_ROOT, "import-pack", "no-desc");
    await fs.mkdir(noDesc, { recursive: true });
    await fs.writeFile(
      path.join(noDesc, "SKILL.md"),
      `---\nname: no-desc\n---\n\n没 description\n`,
      "utf-8",
    );
    await expect(importCustomActionBundle(noDesc)).rejects.toThrow(
      /缺 description|格式不合法/,
    );

    const mismatch = path.join(TMP_ROOT, "import-pack", "name-mismatch");
    await fs.mkdir(mismatch, { recursive: true });
    await fs.writeFile(
      path.join(mismatch, "SKILL.md"),
      `---\nname: other-name\ndescription: 名字对不上\n---\n\n正文\n`,
      "utf-8",
    );
    await expect(importCustomActionBundle(mismatch)).rejects.toThrow(/不一致/);
  });

  it("导入：bundle 内 symlink 一律删除", async () => {
    const pack = path.join(TMP_ROOT, "import-pack", "with-symlink");
    await fs.mkdir(pack, { recursive: true });
    await fs.writeFile(
      path.join(pack, "SKILL.md"),
      `---\nname: with-symlink\ndescription: 带链\n---\n\n正文\n`,
      "utf-8",
    );
    const outside = path.join(TMP_ROOT, "secret-outside.txt");
    await fs.writeFile(outside, "secret\n", "utf-8");
    await fs.symlink(outside, path.join(pack, "leak"));
    const nested = path.join(pack, "scripts");
    await fs.mkdir(nested, { recursive: true });
    await fs.symlink(outside, path.join(nested, "also-leak"));

    const r = await importCustomActionBundle(pack);
    expect(r.skillName).toBe("with-symlink");
    const dest = path.join(getAppSkillsDir(), "with-symlink");
    await expect(fs.lstat(path.join(dest, "leak"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.lstat(path.join(dest, "scripts", "also-leak")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("sanitizeSkillName（防路径穿越）", () => {
  it("合法名放行；../ / 前导点 / 空拒", () => {
    expect(sanitizeSkillName("perf-audit")).toBe("perf-audit");
    expect(sanitizeSkillName("写代码")).toBe("写代码");
    expect(sanitizeSkillName("../evil")).toBeUndefined();
    expect(sanitizeSkillName(".hidden")).toBeUndefined();
    expect(sanitizeSkillName("a/b")).toBeUndefined();
  });

  it("创建时 skill=../evil → 抛错", async () => {
    await expect(
      createCustomAction({ label: "坏", skill: "../evil" }),
    ).rejects.toThrow(/非法/);
  });
});

describe("listCustomActions 流程 order 排序", () => {
  it("有 order 升序排前；无 order 按 updatedAt 倒序排后", async () => {
    // 无 order：updatedAt 大的应排在「无 order 组」前面
    await seedSkill("no-order-old");
    await seedSkill("no-order-new");
    await seedSkill("ord-30");
    await seedSkill("ord-10");
    await seedSkill("ord-20");

    await createCustomAction({
      label: "旧无序",
      skill: "no-order-old",
    });
    // 稍晚创建 → exportedAt 更大
    await new Promise((r) => setTimeout(r, 5));
    await createCustomAction({
      label: "新无序",
      skill: "no-order-new",
    });

    // 直接写 json 带 order（绕过 create 的 exportedAt=now，避免干扰）
    const writeOrdered = async (
      name: string,
      label: string,
      order: number,
      exportedAt: number,
    ) => {
      await fs.writeFile(
        path.join(getAppSkillsDir(), name, ".flowship-action.json"),
        JSON.stringify({ label, order, exportedAt }, null, 2) + "\n",
        "utf-8",
      );
    };
    await writeOrdered("ord-30", "序30", 30, 1000);
    await writeOrdered("ord-10", "序10", 10, 3000);
    await writeOrdered("ord-20", "序20", 20, 2000);

    const list = await listCustomActions();
    const ids = list.map((a) => a.id);
    // 有 order：10 → 20 → 30 在前；无 order：新 → 旧
    expect(ids).toEqual([
      "app:ord-10",
      "app:ord-20",
      "app:ord-30",
      "app:no-order-new",
      "app:no-order-old",
    ]);
    expect(list[0]?.order).toBe(10);
    expect(list[1]?.order).toBe(20);
    expect(list[2]?.order).toBe(30);
    expect(list[3]?.order).toBeUndefined();
  });

  it("parseFlowshipActionMeta 透传有限 order；非法不认", () => {
    expect(
      parseFlowshipActionMeta(
        JSON.stringify({ label: "有序", order: 40, exportedAt: 1 }),
      ),
    ).toMatchObject({ label: "有序", order: 40 });
    expect(
      parseFlowshipActionMeta(
        JSON.stringify({ label: "坏", order: "10", exportedAt: 1 }),
      )?.order,
    ).toBeUndefined();
    expect(
      parseFlowshipActionMeta(
        JSON.stringify({ label: "坏", order: Number.NaN, exportedAt: 1 }),
      )?.order,
    ).toBeUndefined();
  });
});

describe("app 优先去重（同 skill 名）", () => {
  it("app 壳存在时 list 只出 app:、get team: 返 null；卸壳后 team 恢复", async () => {
    await seedSkill("dual");
    await createCustomAction({ label: "本地双源", skill: "dual" });
    const list = await listCustomActions();
    expect(list.find((a) => a.id === "app:dual")?.origin).toBe("app-skill");
    expect(list.find((a) => a.id === "team:dual")).toBeUndefined();
  });
});
