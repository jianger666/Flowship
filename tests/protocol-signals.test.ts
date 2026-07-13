/**
 * 协议信号 ↔ prompt 模板一致性测试（V0.6.27）
 *
 * 防的事故：信号常量改了 / 加了、prompt 里教 agent 的字面量没同步（或反之）——
 * agent 按旧文档解析、拿到结果却不认识。历史真实案例：INTERNAL_ERROR 在 grep 终态
 * 列表里、_super.md 却没教过 agent 这个头。
 *
 * 还顺带对账 prompt 模板占位符：模板里 {{xxx}} 出现但渲染端没供值 →
 * 渲染成「（未提供）」混进 prompt、这类漏配在运行时无报错、只能测试期抓。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SIGNALS,
  SIGNAL_PREFIXES,
  buildNextActionHead,
} from "@/lib/protocol-signals";

const promptsDir = path.resolve(import.meta.dirname, "..", "prompts");
const superMd = readFileSync(path.join(promptsDir, "_super.md"), "utf-8");

describe("信号常量 ↔ _super.md 一致性", () => {
  it("agent 面向的固定信号、_super.md 都要教（字面量出现）", () => {
    // V0.13.x：send 消息头（用户回复 / 统一消息 / NEXT_ACTION 前缀）+ 附件段头
    const agentFacing = [
      SIGNALS.USER_REPLY,
      SIGNALS.USER_MESSAGE,
      SIGNALS.ATTACHED_IMAGES,
    ];
    for (const sig of agentFacing) {
      expect(superMd, `_super.md 缺信号说明：${sig}`).toContain(sig);
    }
  });

  it("带参信号前缀（NEXT_ACTION）在 _super.md 出现", () => {
    expect(superMd).toContain(SIGNAL_PREFIXES.NEXT_ACTION);
  });

  it("工具返回头（SUBMITTED / ASK_SUBMITTED / ASK_USER_REPLY）在 _super.md 出现", () => {
    // 这些头由 chat-mcp 工具返回 / ask-reply 路由拼、_super.md 教 agent 怎么读
    expect(superMd).toContain("[SUBMITTED]");
    expect(superMd).toContain("[ASK_SUBMITTED]");
    expect(superMd).toContain("[ASK_USER_REPLY]");
    expect(superMd).toContain("[ASK_USER_REPLY deferred]");
  });

  it("旧协议残留不该再出现在 _super.md（已退役）", () => {
    for (const legacy of [
      "[SHELL_WAIT_GUIDE",
      "[KEEPALIVE",
      "[TASK_DONE]",
      "[TASK_ABANDONED]",
      "[STALE]",
      "[INVALID_TOKEN]",
      "wait-ack",
      "long-poll",
      // V0.13.x：revise / 问一问 双通道并入 [USER_MESSAGE] 统一消息
      "[ACTION_ACK",
      "[USER_QUESTION]",
    ]) {
      expect(superMd, `_super.md 残留旧协议字样：${legacy}`).not.toContain(
        legacy,
      );
    }
  });
});

describe("信号构造函数格式", () => {
  it("buildNextActionHead 全参形态与 _super.md 教的格式一致", () => {
    const head = buildNextActionHead({
      actionId: "act_3",
      actionType: "build",
      n: 3,
      artifactPath: "actions/3-build.md",
    });
    expect(head).toBe(
      "[NEXT_ACTION action_id=act_3 type=build n=3 artifact_path=actions/3-build.md]",
    );
    // _super.md 里教 agent 的格式样例必须与构造端字段顺序一致（type 枚举含 custom）
    expect(superMd).toContain(
      "[NEXT_ACTION action_id=<id> type=<plan|build|review|ship|learn|dev|custom> n=<N> artifact_path=actions/<N>-<type>.md]",
    );
  });

  it("buildNextActionHead 省参形态正确收缩", () => {
    expect(buildNextActionHead({})).toBe("[NEXT_ACTION]");
    expect(buildNextActionHead({ actionType: "plan" })).toBe(
      "[NEXT_ACTION type=plan]",
    );
  });
});

describe("prompt 模板占位符对账（防漏渲染）", () => {
  const extractPlaceholders = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) out.add(m[1]);
    return out;
  };

  it("_super.md 占位符 ⊆ buildSuperPrompt 供值表", () => {
    // 跟 task-runner.buildSuperPrompt 的 renderSuperPromptTemplate vars 对账——
    // 在那边加占位符忘了供值、这里炸
    const supplied = new Set([
      "taskId",
      "taskTitle",
      "userIdentityLine",
      "repoSection",
      "repoBranchSection",
      "qaRoleDirective",
      "repoPath",
      "roleLabel",
      "role",
      "contextDocsSection",
      "rulesSection",
      "skillsSection",
      "eventsLogPath",
      "actionArtifactsDir",
      "sharedRules",
      "actionHistorySection",
      "firstActionDirective",
      "currentActionPlaybook",
      // V0.7.20：等待纪律共用片段（chat / task 单一源、wait-protocol-prompt.waitDisciplineSection）
      "waitDiscipline",
    ]);
    for (const ph of extractPlaceholders(superMd)) {
      expect(supplied, `_super.md 用了未供值占位符 {{${ph}}}`).toContain(ph);
    }
  });

  it("_shared.md 占位符 ⊆ loadSharedPrompt 供值表", () => {
    const sharedMd = readFileSync(path.join(promptsDir, "_shared.md"), "utf-8");
    const supplied = new Set(["repoPath", "taskId"]);
    for (const ph of extractPlaceholders(sharedMd)) {
      expect(supplied, `_shared.md 用了未供值占位符 {{${ph}}}`).toContain(ph);
    }
  });

  it("action-*.md 占位符 ⊆ loadActionPrompt 供值表", () => {
    const supplied = new Set([
      "taskId",
      "taskTitle",
      "repoPath",
      "role",
      "roleLabel",
      "actionArtifactsDir",
      // V0.6.29：learn action 挖事件日志
      "eventsLogPath",
    ]);
    for (const type of ["plan", "build", "review", "ship", "learn", "dev"]) {
      const md = readFileSync(
        path.join(promptsDir, `action-${type}.md`),
        "utf-8",
      );
      for (const ph of extractPlaceholders(md)) {
        expect(
          supplied,
          `action-${type}.md 用了未供值占位符 {{${ph}}}`,
        ).toContain(ph);
      }
    }
  });
});
