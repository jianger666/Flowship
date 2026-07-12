/**
 * 自定义 action：skill 挂载壳 + 存量 playbook→skill 自动迁移
 *
 * 回归点：
 * - 新格式 frontmatter-only（skill 必填、正文空）读写往返
 * - 老 ACTION.md 非空 playbook → 抽成 app 自管 skill + 壳重写（幂等）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-custom-action-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = TMP_ROOT;

import {
  createCustomAction,
  getCustomAction,
  listCustomActions,
  updateCustomAction,
} from "@/lib/server/custom-action-fs";
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
  it("创建 / 读取 / 更新：skill + extraSkills 落盘、正文为空", async () => {
    const created = await createCustomAction({
      label: "性能审计",
      skill: "perf-audit",
      summary: "扫一遍性能",
      extraSkills: ["feishu-doc"],
      freshAgent: true,
      placeholder: "贴页面 URL",
    });
    expect(created.id).toBeTruthy();
    expect(created.skill).toBe("perf-audit");
    expect(created.extraSkills).toEqual(["feishu-doc"]);
    expect(created.output).toBeUndefined();

    const raw = await fs.readFile(
      path.join(TMP_ROOT, "custom-actions", created.id, "ACTION.md"),
      "utf-8",
    );
    // frontmatter-only：正文不应再塞 playbook
    expect(raw).toContain("skill: perf-audit");
    expect(raw).toContain("extraSkills:");
    expect(raw).not.toMatch(/^## /m);

    const got = await getCustomAction(created.id);
    expect(got?.skill).toBe("perf-audit");
    expect(got?.extraSkills).toEqual(["feishu-doc"]);

    const updated = await updateCustomAction(created.id, {
      skill: "perf-audit-v2",
      extraSkills: [],
    });
    expect(updated.skill).toBe("perf-audit-v2");
    expect(updated.extraSkills).toBeUndefined();
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

describe("custom-action 存量迁移 playbook → skill", () => {
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

  it("老 playbook 正文 → 新建 app skill + ACTION.md 瘦身壳", async () => {
    await writeLegacyAction("perf-audit", {
      label: "Perf Audit",
      summary: "性能扫一遍",
      playbook: "## 目标\n扫性能瓶颈\n\n## 产出\n写报告",
      skills: ["feishu-doc"],
    });

    const def = await getCustomAction("perf-audit");
    expect(def).not.toBeNull();
    expect(def!.skill).toBe("perf-audit");
    expect(def!.extraSkills).toEqual(["feishu-doc"]);
    // 壳正文应已清空
    const actionRaw = await fs.readFile(
      path.join(TMP_ROOT, "custom-actions", "perf-audit", "ACTION.md"),
      "utf-8",
    );
    expect(actionRaw).toContain("skill: perf-audit");
    expect(actionRaw).not.toContain("扫性能瓶颈");

    // 抽出的 skill 住 app 自管目录、正文 = 原 playbook
    const skillRaw = await fs.readFile(
      path.join(getAppSkillsDir(), "perf-audit", "SKILL.md"),
      "utf-8",
    );
    expect(skillRaw).toContain("name: perf-audit");
    expect(skillRaw).toContain("description: 性能扫一遍");
    expect(skillRaw).toContain("扫性能瓶颈");
  });

  it("迁移幂等：再读一次不重复建 skill、壳不变", async () => {
    await writeLegacyAction("rollback", {
      label: "Rollback",
      playbook: "执行版本回滚步骤",
    });

    const first = await getCustomAction("rollback");
    expect(first?.skill).toBe("rollback");
    const skillPath = path.join(getAppSkillsDir(), "rollback", "SKILL.md");
    const skillStat1 = await fs.stat(skillPath);

    // 第二次读：正文已空、不应再迁
    const second = await getCustomAction("rollback");
    expect(second?.skill).toBe("rollback");
    const skillStat2 = await fs.stat(skillPath);
    expect(skillStat2.mtimeMs).toBe(skillStat1.mtimeMs);

    // app skills 下只有一个 rollback、没有 rollback-2
    const names = await fs.readdir(getAppSkillsDir());
    expect(names.filter((n) => n.startsWith("rollback"))).toEqual(["rollback"]);
  });

  it("skill 目录撞名 → 探 -2，不覆盖已有 skill", async () => {
    // 先占坑同名 skill
    const occupied = path.join(getAppSkillsDir(), "occupied");
    await fs.mkdir(occupied, { recursive: true });
    await fs.writeFile(
      path.join(occupied, "SKILL.md"),
      `---\nname: occupied\ndescription: 已有\n---\n\n旧内容别覆盖\n`,
      "utf-8",
    );

    await writeLegacyAction("occupied-action", {
      label: "Occupied",
      playbook: "新 playbook 正文",
    });
    // label slug = occupied、跟已有 skill 撞 → 应落到 occupied-2
    const def = await getCustomAction("occupied-action");
    expect(def?.skill).toBe("occupied-2");

    const old = await fs.readFile(path.join(occupied, "SKILL.md"), "utf-8");
    expect(old).toContain("旧内容别覆盖");
    const neu = await fs.readFile(
      path.join(getAppSkillsDir(), "occupied-2", "SKILL.md"),
      "utf-8",
    );
    expect(neu).toContain("新 playbook 正文");
  });

  it("listCustomActions 也会触发迁移", async () => {
    await writeLegacyAction("listed", {
      label: "Listed",
      playbook: "列表迁移正文",
    });
    const list = await listCustomActions();
    expect(list.some((a) => a.id === "listed" && a.skill === "listed")).toBe(
      true,
    );
    await expect(
      fs.access(path.join(getAppSkillsDir(), "listed", "SKILL.md")),
    ).resolves.toBeUndefined();
  });
});
