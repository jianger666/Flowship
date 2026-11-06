/**
 * 提测 / 联调交卷后，用户再让改东西：脚注补一段「重新交卷 ≠ 再对外做一遍」。
 *
 * 背景：产出审阅中的消息脚注要求「无论问还是改都重新交卷」，agent 又带着整套提测剧本的上下文，
 * 用户提测之后说「这里再改下代码」，它会把「修改」当成「提测要重做」——改完又 push / 提 MR / 评论 / @ 测试。
 * 这里**不加硬拦截**（用户明确要再提测时 AI 照做），只在消息里把话讲明白，让 AI 按用户这句话自己判断。
 *
 * 只测得了「消息里有没有这段、什么时候有」；模型实际会不会照做没法在单测里验证。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgentMessage,
  buildExternalEffectNote,
} from "../src/lib/server/chat-pending";
import type { ActionType } from "../src/lib/types";

const root = path.resolve(import.meta.dirname, "..");

const acked = (actionType?: ActionType, text = "把这个文案再改下") =>
  buildAgentMessage({
    kind: "user_message",
    text,
    ackContext: { actionId: "act_1", artifactPath: "actions/4-ship.md", actionType },
  });

describe("提测 / 联调：产出审阅中的消息多一段「重新交卷 ≠ 再对外做一遍」", () => {
  it("提测：保留原有〈产出审阅中〉+ 先交卷指令，并补上说明", () => {
    const t = acked("ship");
    // 原有契约一个字不丢（protocol-signals 与 _super.md 都靠这些字面量）
    expect(t).toContain("〈产出审阅中〉");
    expect(t).toContain("先调 submit_work（同 action_id）重新交卷");
    expect(t).toContain("[SUBMITTED]");
    // 新增段：重新交卷只是刷新记录、不等于再提测
    expect(t).toContain("这份产出是「提测」");
    expect(t).toContain("不等于要再提测一遍");
    // 默认别顺手做对外动作
    expect(t).toContain("不要顺手重新 push / 提 MR / 评论 / @ 测试人员");
    // 但不是硬拦：用户明确要再提测就做
    expect(t).toContain("用户明确说了要再提测 / 更新 MR / 通知，再去做对外那几步");
    // 改完要说清楚 MR 里还没有
    expect(t).toContain("这次修改只在本地、MR 里还没有");
    expect(t).toContain("仅本地改动、未推送");
  });

  it("联调：同一段，文案换成「联调」", () => {
    const t = acked("dev");
    expect(t).toContain("这份产出是「联调」");
    expect(t).toContain("不等于要再联调一遍");
    expect(t).toContain("用户明确说了要再联调 / 更新 MR / 通知");
    expect(t).not.toContain("提测");
  });

  it("补充段紧跟在原脚注后面（另起一行），而不是替换它", () => {
    const base = acked(undefined);
    const ship = acked("ship");
    expect(ship.startsWith(base)).toBe(true);
    expect(ship.slice(base.length)).toBe(`\n${buildExternalEffectNote("ship")}`);
  });

  it("plan / build / review / 自定义 / 没传类型：脚注与改动前完全一致（没有这段）", () => {
    const base = acked(undefined);
    for (const type of ["plan", "build", "review", "custom"] as const) {
      expect(acked(type)).toBe(base);
    }
    expect(base).not.toContain("不等于要再");
    expect(buildExternalEffectNote(undefined)).toBe("");
    expect(buildExternalEffectNote("build")).toBe("");
  });

  it("没有产出在等审阅（普通插话）：不带这段，哪怕之前交过提测", () => {
    const plain = buildAgentMessage({ kind: "user_message", text: "改下标题" });
    expect(plain).not.toContain("不等于要再");
    expect(plain).toContain("这是任务过程中用户的插话");
  });

  it("定时触发优先：不出现〈产出审阅中〉，也就没有这段", () => {
    const t = buildAgentMessage({
      kind: "user_message",
      text: "[SCHEDULE_FIRED id=1]",
      scheduled: true,
      ackContext: { actionId: "act_1", actionType: "ship" },
    });
    expect(t).not.toContain("〈产出审阅中〉");
    expect(t).not.toContain("不等于要再");
  });
});

describe("提示词与接线", () => {
  const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf-8");

  it("_super.md 的〈产出审阅中〉规则里有同样的说明，且仍保留先交卷的原句", () => {
    const md = read("prompts", "_super.md");
    expect(md).toContain("提测 / 联调（ship / dev）的〈产出审阅中〉");
    expect(md).toContain("不等于再提测一遍");
    expect(md).toContain("先做该做的（问类查清、改类改完），再调 `submit_work`（同 action_id）重新交卷");
  });

  it("_shared.md §5.1：ship 只改本地时写「仅本地改动、未推送」", () => {
    const md = read("prompts", "_shared.md");
    expect(md).toContain("仅本地改动、未推送");
  });

  it("task-question-inject 构造 ackContext 时带上 actionType（脚注靠它判断）", () => {
    const src = read("src", "lib", "server", "task-question-inject.ts");
    expect(src).toMatch(/actionType:\s*ackAction\.type/);
  });
});
