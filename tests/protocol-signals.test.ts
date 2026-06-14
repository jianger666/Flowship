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
  TERMINAL_SIGNAL_TOKENS,
  buildNextActionHead,
  keepaliveLine,
  shellWaitGuideHead,
} from "@/lib/protocol-signals";

const promptsDir = path.resolve(import.meta.dirname, "..", "prompts");
const superMd = readFileSync(path.join(promptsDir, "_super.md"), "utf-8");

describe("信号常量 ↔ _super.md 一致性", () => {
  it("agent 面向的固定信号、_super.md 都要教（字面量出现）", () => {
    // SHELL_WAIT_GUIDE / ATTACHED_* 是工具返回头、INTERNAL_ERROR 是错误头——
    // 这些也都该在 super prompt 里出现过、agent 才认识
    const agentFacing = [
      SIGNALS.ACTION_ACK_APPROVE,
      SIGNALS.ACTION_ACK_REVISE,
      SIGNALS.USER_REPLY,
      SIGNALS.TASK_DONE,
      SIGNALS.TASK_ABANDONED,
      SIGNALS.CANCELLED,
      SIGNALS.STALE,
      SIGNALS.INVALID_TOKEN,
      // 历史事故主角：曾在 grep 终态表里、prompt 却没教（R2 review 发现、V0.6.27 补）
      SIGNALS.INTERNAL_ERROR,
    ];
    for (const sig of agentFacing) {
      expect(superMd, `_super.md 缺信号说明：${sig}`).toContain(sig);
    }
  });

  it("带参信号前缀（NEXT_ACTION / KEEPALIVE / SHELL_WAIT_GUIDE）在 _super.md 出现", () => {
    expect(superMd).toContain(SIGNAL_PREFIXES.NEXT_ACTION);
    expect(superMd).toContain(SIGNAL_PREFIXES.KEEPALIVE);
    expect(superMd).toContain("[SHELL_WAIT_GUIDE token=");
  });

  it("终态 token 表覆盖全部固定信号的 token（少一个 = agent 拿到结果还在空转）", () => {
    // 从 SIGNALS 里抠出所有 token（方括号内第一个词）
    const tokens = new Set(
      Object.values(SIGNALS)
        .map((s) => /^\[([A-Z_]+)/.exec(s)?.[1])
        .filter((t): t is string => !!t),
    );
    // SHELL_WAIT_GUIDE / ATTACHED_* 不是 wait-ack stdout 终态行、不要求在 grep 表里
    tokens.delete("SHELL_WAIT_GUIDE");
    tokens.delete("ATTACHED_IMAGES");
    tokens.delete("ATTACHED_PATHS");
    tokens.add("NEXT_ACTION"); // 带参信号、也是终态

    for (const t of tokens) {
      expect(
        TERMINAL_SIGNAL_TOKENS as readonly string[],
        `TERMINAL_SIGNAL_TOKENS 缺 ${t}`,
      ).toContain(t);
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
    // _super.md 里教 agent 的格式样例必须与构造端字段顺序一致
    expect(superMd).toContain(
      "[NEXT_ACTION action_id=<id> type=<plan|build|review|ship|test|learn> n=<N> artifact_path=actions/<N>-<type>.md]",
    );
  });

  it("buildNextActionHead 省参形态正确收缩", () => {
    expect(buildNextActionHead({})).toBe("[NEXT_ACTION]");
    expect(buildNextActionHead({ actionType: "plan" })).toBe(
      "[NEXT_ACTION type=plan]",
    );
  });

  it("keepaliveLine / shellWaitGuideHead 前缀正确", () => {
    expect(keepaliveLine()).toMatch(/^\[KEEPALIVE ts=\d+\]\n$/);
    expect(shellWaitGuideHead("tok_1")).toBe("[SHELL_WAIT_GUIDE token=tok_1]");
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
      "repoSection",
      "repoBranchSection",
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
    for (const type of ["plan", "build", "review", "ship", "test", "learn"]) {
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
