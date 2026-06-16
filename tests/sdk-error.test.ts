/**
 * summarizeRunFailure 单测（V0.8.x）
 *
 * 防的事故：单 Run 长连接被断（等太久 / 网抖 / 代理砍 idle / 休眠 / 后端回收久挂 run）时、
 * SDK 给的是 status=error|expired、message 全空、无 code/cause——只剩一坨 run 元数据 dump。
 * 这类最常见、对用户无信息量、还吓人、应换成「长连接已断开」友好提示；
 * 真·有诊断的错（认证 / 限流 / MCP / 协议）必须照旧展示详情、别被误吞。
 *
 * 识别只靠正则 + error 字段、肉眼难保证不误判（裸 error vs 带 inline 详情 / 带 stream message /
 * 带 code），所以喂典型错误串测边界、锁住「连接断」与「真错」的分界。
 */
import { describe, expect, it } from "vitest";

import { summarizeRunFailure } from "@/lib/server/sdk-error";

const DROP_TEXT =
  "长连接已断开——通常是等待太久、网络/代理中断或电脑休眠导致，不是任务本身出错，重新发起本轮通常可恢复。";

// task-runner 抛的裸 error：status=error + run 元数据 dump、无任何诊断段
const taskBareDrop =
  'agent run status=error\n--- SDK result dump ---\n{"id":"run-x","status":"error","durationMs":5548417}';

describe("summarizeRunFailure", () => {
  it("1. task-runner 裸 status=error（只跟 result dump）→ 判为长连接被断、换友好文案", () => {
    const r = summarizeRunFailure(taskBareDrop, new Error(taskBareDrop));
    expect(r.isConnectionDrop).toBe(true);
    expect(r.text).toBe(DROP_TEXT);
  });

  it("2. status=expired 同样算长连接被断（后端回收久挂 run）", () => {
    const msg =
      'agent run status=expired\n--- SDK result dump ---\n{"id":"run-y","status":"expired"}';
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(true);
    expect(r.text).toBe(DROP_TEXT);
  });

  it("3. chat-runner 裸 status=error（无 result dump、直接到串尾）→ 长连接被断", () => {
    const msg = "agent run status=error";
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(true);
    expect(r.text).toBe(DROP_TEXT);
  });

  it("4. 带 SDK stream error message（有诊断）→ 不是连接断、保留详情", () => {
    const msg =
      "agent run status=error\n--- SDK stream error message ---\nrate limit exceeded\n--- SDK result dump ---\n{}";
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(false);
    expect(r.text).toContain("rate limit exceeded");
  });

  it("5. chat-runner inline 详情（status=error: <text>）→ 不是连接断", () => {
    const msg = "agent run status=error: model overloaded";
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(false);
    expect(r.text).toContain("model overloaded");
  });

  it("6. 错误对象带 code/cause（ConnectError）→ 不是连接断、详情拼上 SDK error fields", () => {
    // message 形似裸 error、但 err 上挂了 connect code（如 16=unauthenticated）→ 有诊断、不该吞
    const err = Object.assign(new Error(taskBareDrop), { code: 16 });
    const r = summarizeRunFailure(taskBareDrop, err);
    expect(r.isConnectionDrop).toBe(false);
    expect(r.text).toContain("SDK error fields");
    expect(r.text).toContain("16");
  });

  it("7. 非 run-status 抛错（其它异常）→ 不是连接断、原样保留", () => {
    const msg = "Cannot read properties of undefined (reading 'foo')";
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(false);
    expect(r.text).toBe(msg);
  });

  it("8. status=error 后挂别的文本（既非 dump 也非串尾）→ 保守判为非连接断", () => {
    // 防误吞：只有「status 后紧跟 result dump / 串尾」才算裸。其它形态一律走详情分支。
    const msg = "agent run status=error something unexpected here";
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(false);
  });

  it("9. dump 里带诊断字段 result（reviewAI P1 护栏）→ 不判连接断、不吞线索", () => {
    // 将来 SDK 若往 RunResult dump 塞诊断、即使正则命中也不能当连接断吞掉
    const msg =
      'agent run status=error\n--- SDK result dump ---\n{"id":"run-x","status":"error","durationMs":120000,"result":"model overloaded"}';
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(false);
    expect(r.text).toContain("model overloaded");
  });

  it("10. dump 里带 error 对象（非空）→ 不判连接断", () => {
    const msg =
      'agent run status=error\n--- SDK result dump ---\n{"id":"run-x","status":"error","error":{"code":"X"}}';
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(false);
  });

  it("11. dump 仅元数据（无诊断字段）→ 仍判连接断", () => {
    // 护栏只 demote「带诊断」的、纯元数据 dump 不受影响
    const msg =
      'agent run status=error\n--- SDK result dump ---\n{"id":"run-x","status":"error","model":{"id":"opus"},"durationMs":5548417,"result":""}';
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(true);
    expect(r.text).toBe(DROP_TEXT);
  });

  it("12. dump 被截断（非法 JSON）→ parse 失败、不据此 demote、仍按裸 error 判连接断", () => {
    // slice(1500) 截断时 parse 失败：保守不 demote（主闸正则+bits 已把关、最常见诊断已被 task-runner inline）
    const msg =
      'agent run status=error\n--- SDK result dump ---\n{"id":"run-x","status":"error","durationMs":554841';
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(true);
  });

  it("13. dump 里诊断字段是空对象 error:{} → 无信息量、不算诊断、仍判连接断", () => {
    // 空对象不该误 demote（reviewAI 非阻塞小点：行为与「非空对象才算诊断」注释对齐）
    const msg =
      'agent run status=error\n--- SDK result dump ---\n{"id":"run-x","status":"error","error":{}}';
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(true);
  });
});
