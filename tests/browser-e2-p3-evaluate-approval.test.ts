/**
 * E2·P3 · A7：evaluate 授权真值表（electron-app/browser/evaluate-approval.mjs）。
 * 用真 PromptHub + 假 session（不依赖 Electron）；P8 的 debug 会复用同一个函数，所以这里钉死行为。
 */
import { describe, expect, it, vi } from "vitest";

import {
  EVALUATE_APPROVAL_EXT,
  EVALUATE_PROMPT_TIMEOUT_MS,
  EVALUATE_SETTINGS_KEY,
  EVALUATE_SUMMARY_MAX,
  ensureEvaluateApproval,
  isEvaluateApproved,
  summarizeExpression,
} from "../electron-app/browser/evaluate-approval.mjs";
import { createPromptHub } from "../electron-app/browser/prompts.mjs";

interface FakeOpts {
  enabled?: boolean;
  emitEvent?: (name: string, taskId: string, data: object) => unknown;
}

const makeSession = (opts: FakeOpts = {}) => {
  const exts = new Map<string, unknown>();
  const events: Array<{ name: string; taskId: string; data: object }> = [];
  const logs: string[] = [];
  const prompts = createPromptHub();
  const session = {
    taskId: "task-a7",
    prompts,
    getExt: (key: string, factory: () => unknown) => {
      if (!exts.has(key)) exts.set(key, factory());
      return exts.get(key);
    },
    log: (m: string) => logs.push(m),
    host: {
      isEvaluateEnabled: () => opts.enabled === true,
      emitEvent: (name: string, taskId: string, data: object) => {
        events.push({ name, taskId, data });
        return opts.emitEvent?.(name, taskId, data);
      },
    },
  };
  return { session, events, logs, prompts, exts };
};

const only = (prompts: ReturnType<typeof createPromptHub>) => {
  const l = prompts.list();
  expect(l).toHaveLength(1);
  return l[0];
};

describe("A7·evaluate 授权真值表", () => {
  it("总闸开 → 直接放行（via config），不弹提示、不留会话标记", async () => {
    const { session, prompts, events } = makeSession({ enabled: true });
    await expect(ensureEvaluateApproval(session as never, { summary: "1+1" })).resolves.toEqual({ via: "config" });
    expect(prompts.size()).toBe(0);
    expect(isEvaluateApproved(session as never)).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("总闸关 + 无会话批准 → 弹 evaluate 提示（可选动作 deny 在前 = 默认；detail 只有 summary）", async () => {
    const { session, prompts } = makeSession();
    const p = ensureEvaluateApproval(session as never, { summary: "document.title", tabId: "t1", host: "a.test" });
    const info = only(prompts);
    expect(info.kind).toBe("evaluate");
    expect(info.actions).toEqual(["deny", "task", "always"]);
    expect(info.tabId).toBe("t1");
    expect(info.host).toBe("a.test");
    expect(Object.keys(info.detail)).toEqual(["summary"]);
    expect(info.detail.summary).toBe("document.title");
    expect(info.expiresAt - info.since).toBe(EVALUATE_PROMPT_TIMEOUT_MS);
    prompts.answer(info.id, { action: "deny" });
    await expect(p).rejects.toMatchObject({ code: "DENIED" });
  });

  it("task → 放行并写会话标记，之后免提示；不发设置事件", async () => {
    const { session, prompts, events } = makeSession();
    const p = ensureEvaluateApproval(session as never, { summary: "x" });
    prompts.answer(only(prompts).id, { action: "task" });
    await expect(p).resolves.toEqual({ via: "prompt-task" });
    expect(isEvaluateApproved(session as never)).toBe(true);
    await expect(ensureEvaluateApproval(session as never, { summary: "y" })).resolves.toEqual({ via: "task" });
    expect(prompts.size()).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("always → 放行 + 恰好一个 settings_set 事件（白名单键值，带 taskId）；R6-04：不写会话标记（免审批只认实时总闸）", async () => {
    const { session, prompts, events } = makeSession();
    const p = ensureEvaluateApproval(session as never, { summary: "x" });
    prompts.answer(only(prompts).id, { action: "always" });
    await expect(p).resolves.toEqual({ via: "prompt-always" });
    expect(events).toEqual([{ name: "settings_set", taskId: "task-a7", data: { key: EVALUATE_SETTINGS_KEY, value: true } }]);
    expect(EVALUATE_SETTINGS_KEY).toBe("browserEvaluateEnabled");
    expect(isEvaluateApproved(session as never)).toBe(false);
  });

  it("always 的事件发送抛错 → 本次仍放行（只影响「永久」那一半），并记日志；也不留会话标记", async () => {
    const { session, prompts, logs } = makeSession({
      emitEvent: () => {
        throw new Error("channel closed");
      },
    });
    const p = ensureEvaluateApproval(session as never, { summary: "x" });
    prompts.answer(only(prompts).id, { action: "always" });
    await expect(p).resolves.toEqual({ via: "prompt-always" });
    expect(isEvaluateApproved(session as never)).toBe(false);
    expect(logs.join("\n")).toContain("channel closed");
  });

  it("deny → DENIED；拒绝不被记住，下一次重新弹提示", async () => {
    const { session, prompts } = makeSession();
    const p1 = ensureEvaluateApproval(session as never, { summary: "x" });
    prompts.answer(only(prompts).id, { action: "deny" });
    await expect(p1).rejects.toMatchObject({ code: "DENIED" });
    expect(isEvaluateApproved(session as never)).toBe(false);
    const p2 = ensureEvaluateApproval(session as never, { summary: "x" });
    expect(prompts.size()).toBe(1);
    prompts.answer(only(prompts).id, { action: "deny" });
    await expect(p2).rejects.toMatchObject({ code: "DENIED" });
  });

  it("无人处理超时 → DENIED（文案说明是超时；注入的缩短超时生效）", async () => {
    vi.useFakeTimers();
    try {
      const { session, prompts } = makeSession();
      const p = ensureEvaluateApproval(session as never, { summary: "x", timeoutMs: 300 });
      const assertion = expect(p).rejects.toMatchObject({ code: "DENIED", message: expect.stringContaining("没有在") });
      await vi.advanceTimersByTimeAsync(301);
      await assertion;
      expect(prompts.size()).toBe(0);
      expect(isEvaluateApproved(session as never)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("R6-19：evaluate 桶已满（面板上还挂着别的授权卡）→ DENIED，文案是「还有未处理的授权请求」，不写成「没有在 2 分钟内处理」", async () => {
    const { session, prompts } = makeSession();
    void prompts.request({ kind: "evaluate", host: "a.test" });
    void prompts.request({ kind: "evaluate", host: "b.test" });
    const err = (await ensureEvaluateApproval(session as never, { summary: "x" }).catch((e: unknown) => e)) as { message: string };
    expect(err).toMatchObject({ code: "DENIED" });
    expect(err.message).toContain("未处理");
    expect(err.message).not.toContain("没有在");
    expect(isEvaluateApproved(session as never)).toBe(false);
  });

  it("回答无效（不存在的 id / 不在允许集合的动作）→ 返回 false，提示仍挂起，没被批准", async () => {
    const { session, prompts } = makeSession();
    const p = ensureEvaluateApproval(session as never, { summary: "x" });
    const info = only(prompts);
    expect(prompts.answer("p999", { action: "task" })).toBe(false);
    expect(prompts.answer(info.id, { action: "allow-session" })).toBe(false); // permission 提示的动作，不能串到 evaluate 上
    expect(prompts.answer(info.id, { action: "ALWAYS" })).toBe(false);
    expect(prompts.answer(info.id, "task" as never)).toBe(false);
    expect(prompts.size()).toBe(1);
    expect(isEvaluateApproved(session as never)).toBe(false);
    prompts.answer(info.id, { action: "deny" });
    await expect(p).rejects.toMatchObject({ code: "DENIED" });
  });

  it("signal 已中止 → 不弹提示直接抛 signal.reason；等待中中止 → 撤掉提示", async () => {
    const { session, prompts } = makeSession();
    const done = new AbortController();
    done.abort(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
    await expect(ensureEvaluateApproval(session as never, { summary: "x", signal: done.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(prompts.size()).toBe(0);

    const ac = new AbortController();
    const p = ensureEvaluateApproval(session as never, { summary: "x", signal: ac.signal });
    expect(prompts.size()).toBe(1);
    ac.abort(Object.assign(new Error("stop"), { code: "CANCELLED" }));
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    await Promise.resolve();
    expect(prompts.size()).toBe(0); // 唯一的等待者走了 → 没人等这张卡，撤掉
    expect(isEvaluateApproved(session as never)).toBe(false);
  });

  it("并发多次 evaluate 共用一张审批卡；一个等待者取消不影响另一个；一次回答全部放行", async () => {
    const { session, prompts } = makeSession();
    const ac = new AbortController();
    const p1 = ensureEvaluateApproval(session as never, { summary: "a", signal: ac.signal });
    const p2 = ensureEvaluateApproval(session as never, { summary: "b" });
    const p3 = ensureEvaluateApproval(session as never, { summary: "c" });
    expect(prompts.size()).toBe(1); // 只有一张卡
    ac.abort(Object.assign(new Error("stop"), { code: "CANCELLED" }));
    await expect(p1).rejects.toMatchObject({ code: "CANCELLED" });
    expect(prompts.size()).toBe(1); // 还有等待者：卡不能被撤
    prompts.answer(only(prompts).id, { action: "task" });
    await expect(p2).resolves.toEqual({ via: "prompt-task" });
    await expect(p3).resolves.toEqual({ via: "prompt-task" });
  });

  it("所有等待者都取消 → 撤卡后，下一次 evaluate 会重新弹一张新卡（不会挂在作废的卡上）", async () => {
    const { session, prompts } = makeSession();
    const a1 = new AbortController();
    const p1 = ensureEvaluateApproval(session as never, { summary: "a", signal: a1.signal });
    a1.abort(Object.assign(new Error("stop"), { code: "CANCELLED" }));
    await expect(p1).rejects.toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(prompts.size()).toBe(0);
    const p2 = ensureEvaluateApproval(session as never, { summary: "b" });
    expect(prompts.size()).toBe(1);
    prompts.answer(only(prompts).id, { action: "task" });
    await expect(p2).resolves.toEqual({ via: "prompt-task" });
  });

  it("会话销毁（PromptHub 被取消）按拒绝处理", async () => {
    const { session, prompts } = makeSession();
    const p = ensureEvaluateApproval(session as never, { summary: "x" });
    prompts.cancel(only(prompts).id);
    await expect(p).rejects.toMatchObject({ code: "DENIED", message: expect.stringContaining("取消") });
    expect(isEvaluateApproved(session as never)).toBe(false);
  });

  it("批准是会话级：换一个会话（新的 ext 存储）要重新审批", async () => {
    const a = makeSession();
    const pa = ensureEvaluateApproval(a.session as never, { summary: "x" });
    a.prompts.answer(only(a.prompts).id, { action: "task" });
    await pa;
    const b = makeSession();
    expect(isEvaluateApproved(b.session as never)).toBe(false);
    const pb = ensureEvaluateApproval(b.session as never, { summary: "x" });
    expect(b.prompts.size()).toBe(1);
    b.prompts.answer(only(b.prompts).id, { action: "deny" });
    await expect(pb).rejects.toBeTruthy();
    expect(a.exts.has(EVALUATE_APPROVAL_EXT)).toBe(true);
  });
});

describe("A7·summary 清洗（页面 / 模型给的表达式进提示前）", () => {
  it("折叠空白、剥格式字符（零宽 / 双向控制 / 标签字符）、限 200 字", () => {
    const raw = `  a\u200b\u202e\u0007b\n\n\tc  ${"x".repeat(400)}`;
    const s = summarizeExpression(raw);
    expect(s.startsWith("ab c x")).toBe(true);
    expect(/[\u200b\u202e\u0007\n\t]/.test(s)).toBe(false);
    expect(s.length).toBeLessThanOrEqual(EVALUATE_SUMMARY_MAX + 1);
    expect(s.endsWith("…")).toBe(true);
  });

  it("非字符串 / 空值不崩", () => {
    expect(summarizeExpression(undefined)).toBe("");
    expect(summarizeExpression(null)).toBe("");
    expect(summarizeExpression(12345)).toBe("12345");
  });

  it("提示 detail 里放的就是清洗后的前 200 字（不是全文）", async () => {
    const { session, prompts } = makeSession();
    const long = `/* ${"A".repeat(500)} */ document.cookie`;
    const p = ensureEvaluateApproval(session as never, { summary: long });
    const info = only(prompts);
    expect(info.detail.summary.length).toBeLessThanOrEqual(EVALUATE_SUMMARY_MAX + 1);
    expect(info.detail.summary).not.toContain("document.cookie");
    prompts.answer(info.id, { action: "deny" });
    await expect(p).rejects.toBeTruthy();
  });
});
