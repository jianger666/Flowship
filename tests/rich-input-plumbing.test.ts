/**
 * 富输入统一化（v1.1.x）的纯逻辑回归
 *
 * 覆盖四处「抽出来后成为单一来源」的组装逻辑：
 * 1. `composer-history`：两种 ↑ 历史（会话消息 / 推进指令）
 * 2. `buildSkillDirective`：`/` skill 指引段（chat / question / advance / ask-reply 共用）
 * 3. `buildNextActionDirective`：推进链路把 skill 指引拼进 [NEXT_ACTION] 载荷的位置
 * 4. `buildRichInputPayload`：提交四件套（空值语义 / trim / skill 上限截断）
 *
 * UI 组件 / hook 本身不在 vitest 覆盖范围（node 环境无 DOM、见 vitest.config.ts）——
 * 所以 `reset()` 这种「只存在于 hook 里」的完整性用源码契约兜（见文件末尾）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildActionInstructionHistory,
  buildInputHistory,
} from "@/lib/composer-history";
import { buildSkillDirective, MAX_SKILL_REFS } from "@/lib/protocol-signals";
import { buildRichInputPayload } from "@/lib/rich-input-payload";
import { buildNextActionDirective } from "@/lib/server/task-prompts";
import type { ActionRecord, TaskEvent } from "@/lib/types";

const ev = (
  kind: TaskEvent["kind"],
  text: string,
  id = Math.random().toString(36).slice(2),
): TaskEvent =>
  ({ id, kind, text, ts: Date.now() }) as TaskEvent;

const action = (
  n: number,
  userInstruction: string,
  extra: Partial<ActionRecord> = {},
): ActionRecord =>
  ({
    id: `act_${n}`,
    n,
    type: "build",
    status: "completed",
    userInstruction,
    createdAt: new Date().toISOString(),
    ...extra,
  }) as ActionRecord;

describe("composer-history：会话输入历史", () => {
  it("只取 user_reply、新→旧、去空、相邻去重", () => {
    const events = [
      ev("user_reply", "第一条"),
      ev("assistant_message", "AI 回复"),
      ev("user_reply", "  "),
      ev("user_reply", "第二条"),
      ev("user_reply", "第二条"),
      ev("user_reply", "第三条"),
    ];
    expect(buildInputHistory(events)).toEqual(["第三条", "第二条", "第一条"]);
  });

  it("没有 user_reply 时返空数组（↑ 不劫持）", () => {
    expect(buildInputHistory([ev("assistant_message", "只有 AI 说话")])).toEqual(
      [],
    );
  });
});

describe("composer-history：推进指令历史", () => {
  it("新→旧、去空、相邻去重", () => {
    const actions = [
      action(1, "先出方案"),
      action(2, "   "),
      action(3, "按方案实现"),
      action(4, "按方案实现"),
      action(5, "补个单测"),
    ];
    expect(buildActionInstructionHistory(actions)).toEqual([
      "补个单测",
      "按方案实现",
      "先出方案",
    ]);
  });

  it("划除（excluded）的 action 不进历史——跟 agent 上下文同口径", () => {
    const actions = [
      action(1, "保留的指令"),
      action(2, "被划除的指令", { excluded: true }),
    ];
    expect(buildActionInstructionHistory(actions)).toEqual(["保留的指令"]);
  });
});

describe("buildSkillDirective：`/` skill 指引段", () => {
  it("没引用时返空串（调用方可无脑前置拼接）", () => {
    expect(buildSkillDirective(undefined)).toBe("");
    expect(buildSkillDirective([])).toBe("");
  });

  it("逐条列出 name + absPath", () => {
    const out = buildSkillDirective([
      { name: "lark-doc", absPath: "/skills/lark-doc/SKILL.md" },
      { name: "code-review", absPath: "/skills/code-review/SKILL.md" },
    ]);
    expect(out).toContain("[使用 skill]");
    expect(out).toContain("- lark-doc：/skills/lark-doc/SKILL.md");
    expect(out).toContain("- code-review：/skills/code-review/SKILL.md");
  });
});

describe("buildNextActionDirective：推进载荷里的 skill 指引", () => {
  const base = action(3, "", { id: "act_3", type: "build", n: 3 });

  it("skill 指引排在用户指令之前（先 read skill 再执行）", () => {
    const text = buildNextActionDirective({
      action: base,
      userInstruction: "把登录页改成新设计",
      skillDirective: buildSkillDirective([
        { name: "frontend-design", absPath: "/skills/frontend-design/SKILL.md" },
      ]),
    });
    expect(text.indexOf("[使用 skill]")).toBeGreaterThan(-1);
    expect(text.indexOf("[使用 skill]")).toBeLessThan(
      text.indexOf("把登录页改成新设计"),
    );
  });

  it("没引用 skill 时载荷零变化（旧行为不受影响）", () => {
    const withEmpty = buildNextActionDirective({
      action: base,
      userInstruction: "随便改改",
      skillDirective: "",
    });
    const without = buildNextActionDirective({
      action: base,
      userInstruction: "随便改改",
    });
    expect(withEmpty).toBe(without);
    expect(withEmpty).not.toContain("[使用 skill]");
  });

  it("空指令仍走原兜底文案、skill 指引照样在", () => {
    const text = buildNextActionDirective({
      action: base,
      userInstruction: "",
      skillDirective: buildSkillDirective([
        { name: "lark-doc", absPath: "/skills/lark-doc/SKILL.md" },
      ]),
    });
    expect(text).toContain("[使用 skill]");
    expect(text).toContain("（用户没填具体指令、按本 action 标准流程执行）");
  });
});

describe("buildRichInputPayload：提交四件套", () => {
  const skill = (n: number) => ({
    name: `s${n}`,
    absPath: `/skills/s${n}/SKILL.md`,
  });

  it("正文 trim；图 / 路径 / skill 全空时一律 undefined（body 不多带空字段）", () => {
    const { payload, skillOverflow } = buildRichInputPayload({
      value: "  改一下登录页  ",
      images: [],
      paths: [],
      skillRefs: [],
    });
    expect(payload).toEqual({
      text: "改一下登录页",
      images: undefined,
      attachments: undefined,
      skillRefs: undefined,
    });
    expect(skillOverflow).toBe(false);
  });

  it("四件套齐活：图 / 路径 / skill 原样带上（skill 只带 name + absPath）", () => {
    const images = [{ data: "b64", mimeType: "image/png", filename: "a.png" }];
    const { payload } = buildRichInputPayload({
      value: "看这张图 /s1",
      images,
      paths: ["/tmp/a.ts", "/tmp/dir"],
      skillRefs: [{ ...skill(1), extra: "不该被带出去" } as never],
    });
    expect(payload.text).toBe("看这张图 /s1");
    expect(payload.images).toEqual(images);
    expect(payload.attachments).toEqual(["/tmp/a.ts", "/tmp/dir"]);
    expect(payload.skillRefs).toEqual([skill(1)]);
  });

  it(`skill 超 ${MAX_SKILL_REFS} 个 → 截断到前 ${MAX_SKILL_REFS} 个并报 overflow（整条 400 才是最坏结果）`, () => {
    const refs = Array.from({ length: MAX_SKILL_REFS + 3 }, (_, i) => skill(i));
    const { payload, skillOverflow } = buildRichInputPayload({
      value: "跑一下",
      images: [],
      paths: [],
      skillRefs: refs,
    });
    expect(payload.skillRefs).toHaveLength(MAX_SKILL_REFS);
    expect(payload.skillRefs?.[0]).toEqual(skill(0));
    expect(skillOverflow).toBe(true);
  });

  it("只有附件没有正文也是合法载荷（贴张图直接发）", () => {
    const { payload } = buildRichInputPayload({
      value: "   ",
      images: [{ data: "b64", mimeType: "image/png" }],
      paths: [],
      skillRefs: [],
    });
    expect(payload.text).toBe("");
    expect(payload.images).toHaveLength(1);
  });
});

/**
 * `reset()` 活在 hook 里、node 环境跑不了（没 DOM / 没 RTL），但它漏清任何一样
 * 都会把上一个任务的草稿 / 截图 / skill 串到下一个会话去——用源码契约把四件都钉住。
 */
describe("useRichInput.reset 完整性（源码契约）", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "hooks", "use-rich-input.ts"),
    "utf-8",
  );

  it("reset 清掉全部四样：正文草稿 / 图 / 路径附件 / slash 菜单态", () => {
    const body = source.slice(
      source.indexOf("const reset = useCallback"),
      source.indexOf("const pickPaths"),
    );
    expect(body).toContain('setValue("")');
    expect(body).toContain("attachReset()");
    expect(body).toContain("pathReset()");
    expect(body).toContain("slashReset()");
  });
});
