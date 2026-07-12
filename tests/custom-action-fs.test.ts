/**
 * 自定义 action：skill 挂载壳 + 旧格式停用语义
 *
 * 回归点：
 * - 新格式 frontmatter-only（skill 必填、正文空）读写往返
 * - 旧格式（playbook 写正文、无 skill）：不自动迁移、带 legacyPlaybook 标记返回、
 *   推进列表滤掉、编辑 / 导出报错；旧平铺 <id>.md 仅目录化搬家（无损）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-custom-action-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = TMP_ROOT;

import {
  createCustomAction,
  exportCustomAction,
  getCustomAction,
  importCustomActionBundle,
  listCustomActions,
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

beforeEach(async () => {
  // 每个用例清 custom-actions + app skills，避免互相污染
  await fs.rm(path.join(TMP_ROOT, "custom-actions"), {
    recursive: true,
    force: true,
  });
  await fs.rm(getAppSkillsDir(), { recursive: true, force: true });
});

describe("custom-action 新格式（skill 挂载壳）", () => {
  it("创建 / 读取 / 更新：skill 落盘、正文为空", async () => {
    const created = await createCustomAction({
      label: "性能审计",
      skill: "perf-audit",
      summary: "扫一遍性能",
      placeholder: "贴页面 URL",
    });
    expect(created.id).toBeTruthy();
    expect(created.skill).toBe("perf-audit");
    expect(created.output).toBeUndefined();

    const raw = await fs.readFile(
      path.join(TMP_ROOT, "custom-actions", created.id, "ACTION.md"),
      "utf-8",
    );
    // frontmatter-only：正文不应再塞 playbook；已删的壳配置字段不再写出
    expect(raw).toContain("skill: perf-audit");
    expect(raw).not.toContain("extraSkills:");
    expect(raw).not.toContain("freshAgent:");
    expect(raw).not.toMatch(/^## /m);

    const got = await getCustomAction(created.id);
    expect(got?.skill).toBe("perf-audit");

    const updated = await updateCustomAction(created.id, {
      skill: "perf-audit-v2",
    });
    expect(updated.skill).toBe("perf-audit-v2");
  });

  it("旧数据残留 extraSkills / freshAgent：解析忽略、不炸也不带出", async () => {
    // 手写带旧字段的 ACTION.md（壳瘦身前的数据）、验证 parse 兼容
    const dir = path.join(TMP_ROOT, "custom-actions", "old-fields");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "ACTION.md"),
      `---\nlabel: 旧字段\nskill: some-skill\nextraSkills:\n  - feishu-doc\nfreshAgent: false\ncreatedAt: 1000\nupdatedAt: 1000\n---\n`,
      "utf-8",
    );
    const def = await getCustomAction("old-fields");
    expect(def?.skill).toBe("some-skill");
    // 类型上已无这两个字段；运行时值也不该被带出
    expect((def as unknown as Record<string, unknown>).extraSkills).toBeUndefined();
    expect((def as unknown as Record<string, unknown>).freshAgent).toBeUndefined();
  });

  it("output 字段：多行读写往返、空串清掉、不写 frontmatter", async () => {
    const created = await createCustomAction({
      label: "版本回滚",
      skill: "rollback-method",
      output: "输出回滚记录：\n- 回到哪个版本\n- 动了哪些分支\n- 验证结果",
    });
    expect(created.output).toContain("回到哪个版本");
    expect(created.output).toContain("验证结果");

    const raw = await fs.readFile(
      path.join(TMP_ROOT, "custom-actions", created.id, "ACTION.md"),
      "utf-8",
    );
    expect(raw).toContain("output:");
    expect(raw).toContain("回到哪个版本");

    const got = await getCustomAction(created.id);
    expect(got?.output).toBe(created.output);

    // 空串 = 清空，序列化不再写 output 字段
    const cleared = await updateCustomAction(created.id, { output: "  " });
    expect(cleared.output).toBeUndefined();
    const clearedRaw = await fs.readFile(
      path.join(TMP_ROOT, "custom-actions", created.id, "ACTION.md"),
      "utf-8",
    );
    expect(clearedRaw).not.toContain("output:");
  });
});

describe("旧格式（playbook 正文）：停用、不自动迁移", () => {
  const writeLegacyAction = async (
    id: string,
    opts: {
      label: string;
      summary?: string;
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
    const summaryLine = opts.summary ? `summary: ${opts.summary}\n` : "";
    const raw = `---
label: ${opts.label}
${summaryLine}${skillsLine}createdAt: 1000
updatedAt: 1000
---

${opts.playbook}
`;
    await fs.writeFile(path.join(dir, "ACTION.md"), raw, "utf-8");
  };

  it("get 不迁移：返回 legacyPlaybook 标记、文件原样、不生成 skill", async () => {
    await writeLegacyAction("perf-audit", {
      label: "Perf Audit",
      summary: "性能扫一遍",
      playbook: "## 目标\n扫性能瓶颈\n\n## 产出\n写报告",
      skills: ["feishu-doc"],
    });

    const def = await getCustomAction("perf-audit");
    expect(def).not.toBeNull();
    // 停用标记：skill 空串 + legacyPlaybook 带原文（旧 skills 字段解析时忽略）
    expect(def!.skill).toBe("");
    expect(def!.legacyPlaybook).toContain("扫性能瓶颈");

    // 文件不动：playbook 还在正文、没被重写成壳
    const actionRaw = await fs.readFile(
      path.join(TMP_ROOT, "custom-actions", "perf-audit", "ACTION.md"),
      "utf-8",
    );
    expect(actionRaw).toContain("扫性能瓶颈");
    expect(actionRaw).not.toContain("skill: ");

    // app skills 目录不该冒出新 skill
    const names = await fs.readdir(getAppSkillsDir()).catch(() => []);
    expect(names).toEqual([]);
  });

  it("list 不迁移：legacy 定义带标记返回、不生成 skill", async () => {
    await writeLegacyAction("listed", {
      label: "Listed",
      playbook: "列表正文",
    });
    const list = await listCustomActions();
    const legacy = list.find((a) => a.id === "listed");
    expect(legacy?.legacyPlaybook).toBe("列表正文");
    expect(legacy?.skill).toBe("");
    const names = await fs.readdir(getAppSkillsDir()).catch(() => []);
    expect(names).toEqual([]);
  });

  it("推进列表过滤：usableCustomActions 滤掉 legacy、留新格式", async () => {
    await writeLegacyAction("legacy-one", {
      label: "旧动作",
      playbook: "旧正文",
    });
    await createCustomAction({ label: "新动作", skill: "some-skill" });
    const list = await listCustomActions();
    const usable = usableCustomActions(list);
    expect(usable.map((a) => a.label)).toEqual(["新动作"]);
  });

  it("旧平铺 <id>.md 仍目录化（无损搬家、内容不动、legacy 标记正确）", async () => {
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
    // 平铺文件已清、目录版内容原样（含 playbook 正文）
    await expect(fs.access(flat)).rejects.toMatchObject({ code: "ENOENT" });
    const dirRaw = await fs.readFile(
      path.join(TMP_ROOT, "custom-actions", "flat-legacy", "ACTION.md"),
      "utf-8",
    );
    expect(dirRaw).toContain("平铺正文");
  });

  it("legacy 不可编辑 / 不可导出（报错引导重建）", async () => {
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

  it("中文 label → action id 保留中文（不再回退随机串）", async () => {
    const created = await createCustomAction({
      label: "写代码",
      skill: "写代码",
    });
    expect(created.id).toBe("写代码");
    // 撞名探 -2
    const second = await createCustomAction({
      label: "写代码",
      skill: "写代码",
    });
    expect(second.id).toBe("写代码-2");
  });
});

describe("custom-action 导出 / 导入（skill 包 + .flowship-action.json）", () => {
  const seedSkill = async (name: string, body = "方法论正文") => {
    const dir = path.join(getAppSkillsDir(), name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: 测导出\n---\n\n${body}\n`,
      "utf-8",
    );
    return dir;
  };

  it("导出：拷主 skill 目录并写 .flowship-action.json（不含 id）", async () => {
    await seedSkill("export-me", "导出用方法论");
    const created = await createCustomAction({
      label: "导出测",
      skill: "export-me",
      summary: "简介",
      output: "要一份报告",
      placeholder: "贴链接",
    });

    const target = path.join(TMP_ROOT, "export-out");
    await fs.mkdir(target, { recursive: true });
    const { skillDir, skillName } = await exportCustomAction(
      created.id,
      target,
    );
    expect(skillName).toBe("export-me");
    expect(skillDir).toBe(path.join(target, "export-me"));

    const skillMd = await fs.readFile(
      path.join(skillDir, "SKILL.md"),
      "utf-8",
    );
    expect(skillMd).toContain("导出用方法论");

    const meta = JSON.parse(
      await fs.readFile(path.join(skillDir, ".flowship-action.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(meta.label).toBe("导出测");
    expect(meta.output).toBe("要一份报告");
    expect(meta).not.toHaveProperty("id");
    expect(typeof meta.exportedAt).toBe("number");
  });

  it("导出：主 skill 本机找不到 → 报错", async () => {
    const created = await createCustomAction({
      label: "缺 skill",
      skill: "missing-skill-xyz",
    });
    const target = path.join(TMP_ROOT, "export-fail");
    await fs.mkdir(target, { recursive: true });
    await expect(exportCustomAction(created.id, target)).rejects.toThrow(
      /找不到/,
    );
  });

  it("导入：带 .flowship-action.json → skill + 挂壳；自管目录不留 .flowship-action.json", async () => {
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
        // 旧导出包残留字段：导入时应被静默忽略、不报错
        freshAgent: false,
        exportedAt: Date.now(),
      }),
      "utf-8",
    );

    const r = await importCustomActionBundle(pack);
    expect(r.skillName).toBe("import-me");
    expect(r.action?.label).toBe("导入挂壳");
    expect(r.action?.skill).toBe("import-me");
    expect(r.action?.output).toBe("产出一份清单");
    expect(r.actionError).toBeUndefined();

    await expect(
      fs.access(path.join(getAppSkillsDir(), "import-me", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(getAppSkillsDir(), "import-me", ".flowship-action.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("导入：无 .flowship-action.json → 只进 skill、不挂壳", async () => {
    const pack = path.join(TMP_ROOT, "import-pack", "skill-only");
    await fs.mkdir(pack, { recursive: true });
    await fs.writeFile(
      path.join(pack, "SKILL.md"),
      `---\nname: skill-only\ndescription: 仅 skill\n---\n\n只有方法论\n`,
      "utf-8",
    );
    const r = await importCustomActionBundle(pack);
    expect(r.skillName).toBe("skill-only");
    expect(r.action).toBeNull();
    expect(r.actionError).toBeUndefined();
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
    const old = await fs.readFile(
      path.join(getAppSkillsDir(), "dup-skill", "SKILL.md"),
      "utf-8",
    );
    expect(old).toContain("旧内容");
  });

  it("导入：缺 SKILL.md → 报错", async () => {
    const pack = path.join(TMP_ROOT, "import-pack", "no-skill-md");
    await fs.mkdir(pack, { recursive: true });
    await expect(importCustomActionBundle(pack)).rejects.toThrow(/SKILL\.md/);
  });

  it("导入：SKILL.md 缺 description → 报错", async () => {
    const pack = path.join(TMP_ROOT, "import-pack", "no-desc");
    await fs.mkdir(pack, { recursive: true });
    await fs.writeFile(
      path.join(pack, "SKILL.md"),
      `---\nname: no-desc\n---\n\n没 description\n`,
      "utf-8",
    );
    await expect(importCustomActionBundle(pack)).rejects.toThrow(
      /缺 description|格式不合法/,
    );
  });

  it("导入：frontmatter name 与目录名不一致 → 报错", async () => {
    const pack = path.join(TMP_ROOT, "import-pack", "name-mismatch");
    await fs.mkdir(pack, { recursive: true });
    await fs.writeFile(
      path.join(pack, "SKILL.md"),
      `---\nname: other-name\ndescription: 名字对不上\n---\n\n正文\n`,
      "utf-8",
    );
    await expect(importCustomActionBundle(pack)).rejects.toThrow(
      /不一致/,
    );
  });
});
