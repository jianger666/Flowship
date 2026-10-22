/**
 * 第三轮 review D7-01：答题卡「30s 转投递中」之后若请求自己失败，inFlight 不解锁
 *
 * 事实（读码核对，ask-user-inline.tsx）：提交超过 30s 仍没返回 → `markInFlight()`：submitting=false、
 * inFlight=true（卡片只读、按钮「投递中…」禁用、横幅「回答投递中，请勿重复提交」）并起 90s 兜底解锁。
 * 之后请求**自己失败**（5xx / 网断 reject）：catch 里 toast 报错 + `setSubmitting(false)`，
 * **不清 inFlight**（只有成功路径 applyAskSuccess 清）→ toast 说失败，卡片却继续写「请勿重复提交」约 90s，
 * 期间无法重答，而答案其实没送达、AI 在干等。`handleDefer`（稍后再补充）同款。
 *
 * 修法：状态迁移收成纯 reducer（submitting / inFlight 两个量一起迁，不再各自 setState 漏一个），
 * 非「投递冲突」的失败一律回到可提交态；90s 兜底 timer 在失败 / 成功 / 重新进入投递时都清掉，
 * 不让上一次尝试遗留的 timer 误解锁下一次。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ASK_SUBMIT_IDLE,
  classifyAskSubmitError,
  isAskSubmitLocked,
  reduceAskSubmit,
  type AskSubmitState,
} from "../src/lib/ask-submit-state";
import { ApiRequestError } from "../src/lib/task-store";

const run = (events: Parameters<typeof reduceAskSubmit>[1][], from: AskSubmitState = ASK_SUBMIT_IDLE) =>
  events.reduce(reduceAskSubmit, from);

describe("reduceAskSubmit：提交态迁移表", () => {
  it("start：进入提交中（inFlight 不动）", () => {
    expect(run([{ type: "start" }])).toEqual({ submitting: true, inFlight: false });
  });

  it("slow（>30s 未返回）/ conflict（409 ask_in_flight）：转投递中只读", () => {
    expect(run([{ type: "start" }, { type: "slow" }])).toEqual({ submitting: false, inFlight: true });
    expect(run([{ type: "start" }, { type: "conflict" }])).toEqual({ submitting: false, inFlight: true });
  });

  it("succeeded：全解锁", () => {
    expect(run([{ type: "start" }, { type: "slow" }, { type: "succeeded" }])).toEqual(ASK_SUBMIT_IDLE);
  });

  it("D7-01 复现：转投递中之后请求失败 → failed 必须把 inFlight 一并解掉，回到可提交", () => {
    const s = run([{ type: "start" }, { type: "slow" }, { type: "failed" }]);
    expect(s).toEqual({ submitting: false, inFlight: false }); // 改前：inFlight 留着 true 约 90s
    expect(isAskSubmitLocked(s)).toBe(false);
  });

  it("没到 30s 就失败：也回到可提交（既有行为不变）", () => {
    expect(run([{ type: "start" }, { type: "failed" }])).toEqual(ASK_SUBMIT_IDLE);
  });

  it("90s 兜底解锁：只放 inFlight", () => {
    expect(run([{ type: "start" }, { type: "slow" }, { type: "fallback_unlock" }])).toEqual(ASK_SUBMIT_IDLE);
  });

  it("切 ask（reset）：全清", () => {
    expect(run([{ type: "start" }, { type: "slow" }, { type: "reset" }])).toEqual(ASK_SUBMIT_IDLE);
  });

  it("失败后可重答：再 start → 再失败 / 再成功，状态不残留", () => {
    const s = run([
      { type: "start" },
      { type: "slow" },
      { type: "failed" },
      { type: "start" },
      { type: "succeeded" },
    ]);
    expect(s).toEqual(ASK_SUBMIT_IDLE);
  });

  it("isAskSubmitLocked：submitting 或 inFlight 任一为真就锁（按钮 / 选项只读）", () => {
    expect(isAskSubmitLocked({ submitting: true, inFlight: false })).toBe(true);
    expect(isAskSubmitLocked({ submitting: false, inFlight: true })).toBe(true);
    expect(isAskSubmitLocked(ASK_SUBMIT_IDLE)).toBe(false);
  });
});

describe("classifyAskSubmitError：失败怎么处理", () => {
  it("409 ask_in_flight → 投递冲突（另一条链在送答案，卡片转只读等终态，不报错）", () => {
    const err = new ApiRequestError("投递中", 409, { code: "ask_in_flight" });
    expect(classifyAskSubmitError(err)).toEqual({ kind: "in_flight" });
  });

  it("5xx / 400 / 普通 Error / 非 Error（网络断）→ 可重试失败，toast 明说「回答未送达，可重新提交」并带原因", () => {
    const cases: unknown[] = [
      new ApiRequestError("服务端炸了", 500),
      new ApiRequestError("回答内容不合法", 400),
      new Error("Failed to fetch"),
      "boom",
    ];
    for (const err of cases) {
      const c = classifyAskSubmitError(err);
      expect(c.kind).toBe("failed");
      if (c.kind === "failed") {
        expect(c.message).toContain("回答未送达，可重新提交");
        expect(c.message).toContain(err instanceof Error ? err.message : String(err));
      }
    }
  });

  // Q6-18：服务端 ask-reply 的 404 / 409 终态文案本身就是「别再答了」，前缀「可重新提交」自相矛盾
  it.each([
    ["找不到提问", 404, "找不到这组提问"],
    ["已回答", 409, "askId=ask_123 已经回答过、不能重复提交"],
    ["已跳过", 409, "这组提问已跳过（你发了新消息）、无需再回答"],
    ["已过期", 409, "这组提问已过期，请在下方继续"],
    ["已失效", 409, "这组提问已失效、AI 已继续工作，无需再回答"],
    ["410 同义", 410, "已失效"],
  ])("终态拒绝（%s，%i）→ rejected：toast 只写服务端原文，绝不出现「可重新提交」", (_n, status, msg) => {
    const c = classifyAskSubmitError(new ApiRequestError(msg, status, { code: "ask_stale" }));
    expect(c).toEqual({ kind: "rejected", message: msg });
    expect(JSON.stringify(c)).not.toContain("可重新提交");
  });

  it("终态拒绝但服务端没给原因：兜底一句「不需要再回答」，不留空 toast、也不说可重新提交", () => {
    const c = classifyAskSubmitError(new ApiRequestError("", 409, { code: "x" }));
    expect(c.kind).toBe("rejected");
    if (c.kind === "rejected") {
      expect(c.message).toContain("不需要再回答");
      expect(c.message).not.toContain("可重新提交");
    }
  });

  it("只有 ApiRequestError 才按状态码判终态：普通 Error 即使 message 里带 404 / 409 也算可重试（网络层）", () => {
    expect(classifyAskSubmitError(new Error("HTTP 409")).kind).toBe("failed");
  });

  it("原因为空：只说「回答未送达，可重新提交」，不留悬空冒号", () => {
    const c = classifyAskSubmitError(new Error(""));
    expect(c).toEqual({ kind: "failed", message: "回答未送达，可重新提交" });
  });
});

describe("接线（源码契约，仅钉位置）", () => {
  const src = readFileSync(
    path.join(__dirname, "..", "src/components/tasks/ask-user-inline.tsx"),
    "utf8",
  );

  it("提交态走 reducer，不再各自 setSubmitting / setInFlight（漏清一个就是 D7-01）", () => {
    expect(src).toMatch(/useReducer\(\s*reduceAskSubmit,\s*ASK_SUBMIT_IDLE,?\s*\)/);
    expect(src).not.toContain("setInFlight(");
    expect(src).not.toContain("setSubmitting(");
  });

  it("handleSubmit / handleDefer 的 catch 都走同一个失败出口；出口里：失败 → 清 90s 兜底 timer + dispatch failed + toast", () => {
    expect(src.match(/handleAskSubmitError\(err\);/g)?.length).toBe(2);
    const start = src.indexOf("const handleAskSubmitError = (err: unknown) => {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("const handleSubmit = async", start));
    expect(body).toContain("classifyAskSubmitError(err)");
    const clearAt = body.indexOf("clearInFlightUnlockTimer();");
    const failedAt = body.indexOf('dispatchSubmit({ type: "failed" });');
    const toastAt = body.indexOf("toast.error(plan.message);");
    expect(clearAt).toBeGreaterThan(-1);
    expect(failedAt).toBeGreaterThan(clearAt);
    expect(toastAt).toBeGreaterThan(failedAt);
  });

  it("再次进入投递前先清上一次遗留的兜底 timer；成功 / 卸载也清", () => {
    const mark = src.slice(
      src.indexOf("const markInFlight = ("),
      src.indexOf("const applyAskSuccess"),
    );
    expect(mark.indexOf("clearInFlightUnlockTimer();")).toBeLessThan(
      mark.indexOf("inFlightUnlockTimerRef.current = window.setTimeout("),
    );
    const success = src.slice(src.indexOf("const applyAskSuccess"), src.indexOf("const handleAskSubmitError"));
    expect(success).toContain("clearInFlightUnlockTimer();");
    expect(src).toMatch(/submitTimersRef\.current = \[\];\s*clearInFlightUnlockTimer\(\);/);
  });
});
