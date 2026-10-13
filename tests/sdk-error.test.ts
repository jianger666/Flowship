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
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildRunNotFinishedError,
  extractSdkErrorBits,
  isRetryableRunError,
  matchSdkGiveUp,
  SDK_GIVE_UP_RULES,
  summarizeRunFailure,
} from "@/lib/server/sdk-error";

// 「裸 status=error 无诊断」友好文案（连接断 / 额度用完无法区分、兼列两种原因）
const DROP_TEXT =
  "本轮异常结束——可能是长连接断开（等待太久 / 网络·代理中断 / 电脑休眠），也可能是 Cursor 额度·用量已用完。请先确认账号额度；额度正常多为连接断开、重新发起本轮通常可恢复。";

// task-runner 抛的裸 error：status=error + run 元数据 dump、无任何诊断段
const taskBareDrop =
  'agent run status=error\n--- SDK result dump ---\n{"id":"run-x","status":"error","durationMs":5548417}';

describe("summarizeRunFailure", () => {
  it("1. task-runner 裸 status=error（只跟 result dump）→ 判为长连接被断、换友好文案", () => {
    const r = summarizeRunFailure(taskBareDrop, new Error(taskBareDrop));
    expect(r.isConnectionDrop).toBe(true);
    expect(r.text).toBe(DROP_TEXT);
    // detail 始终保留原始诊断（连接断 / 额度时 text 是友好文案、但原始 dump 不丢、落 meta 供排查）
    expect(r.detail).toContain("status=error");
    expect(r.detail).toContain("SDK result dump");
  });

  it("1b. detail：非连接断（有诊断）时 detail 等于 text", () => {
    const msg = "agent run status=error: model overloaded";
    const r = summarizeRunFailure(msg, new Error(msg));
    expect(r.isConnectionDrop).toBe(false);
    expect(r.detail).toBe(r.text);
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

// ---------------------------------------------------------------------------
// Bug #3：SDK 自己「放弃」本轮的终态报错
// ---------------------------------------------------------------------------
//
// 事故（2026-10-08/09，claude-sonnet-5-5 [max] 的长回合）：事件流里连着出现两张红卡——
//   ① `SDK ERROR：Agent turn stopped after repeated resume attempts made no progress`
//   ② `Chat agent 异常：agent run status=error --- SDK stream error message --- … --- SDK result dump --- {…}`
// ② 是一整坨英文 + JSON dump，没人看得懂；而且它没被识别成任何一类，既无友好文案、也没有显式的「不自动重连」。
// 下面的原文取自事故现场的 events.jsonl（run id / requestId 换成了假的）。

const noProgressRaw =
  "agent run status=error\n--- SDK stream error message ---\nAgent turn stopped after repeated resume attempts made no progress\n--- SDK result dump ---\n" +
  '{"id":"run-00000000-fake","requestId":"00000000-fake","status":"error","error":{"message":"Agent turn stopped after repeated resume attempts made no progress"},"model":{"id":"claude-sonnet-5-5","params":[{"id":"reasoning_effort","value":"max"}]},"durationMs":1579061,"usage":{"inputTokens":7749027,"outputTokens":177066,"totalTokens":15675020}}';

const connFailedStreamRaw =
  'agent run status=error\n--- SDK stream error message ---\nConnection failed repeatedly\n--- SDK result dump ---\n{"id":"run-x","status":"error","error":{"message":"Connection failed repeatedly"}}';

describe("summarizeRunFailure · SDK 自己放弃本轮（Bug #3）", () => {
  it("1. 事故原文（no progress）→ 友好文案；原文一字不丢地留在 detail", () => {
    const r = summarizeRunFailure(noProgressRaw, new Error(noProgressRaw));
    expect(r.isSdkGiveUp).toBe(true);
    // 不是「裸连接断」：那一类有「重试通常可恢复」的承诺，这里不能混
    expect(r.isConnectionDrop).toBe(false);
    expect(r.text).toContain("断线续接");
    expect(r.text).toContain("发一条消息即可接着继续");
    // 看得懂的话里不再出现英文 dump
    expect(r.text).not.toContain("agent run status=");
    expect(r.text).not.toContain("SDK result dump");
    // 排查线索不丢：原始串完整保留（错误卡「诊断详情」可展开看）
    expect(r.detail).toBe(noProgressRaw);
  });

  it("2. 「重复回答」的善后提示：别混着看、以最后一个完整版本为准（文案里要有）", () => {
    const r = summarizeRunFailure(noProgressRaw, new Error(noProgressRaw));
    expect(r.text).toContain("多遍回答");
    expect(r.text).toContain("最后一个完整的版本");
  });

  it("3. Connection failed repeatedly（stream message 形态 / inline 形态）→ 友好文案", () => {
    const inline = "agent run status=error: Connection failed repeatedly";
    for (const raw of [connFailedStreamRaw, inline]) {
      const r = summarizeRunFailure(raw, new Error(raw));
      expect(r.isSdkGiveUp, raw).toBe(true);
      expect(r.isConnectionDrop, raw).toBe(false);
      expect(r.text, raw).toContain("连续多次连接失败");
      expect(r.detail, raw).toBe(raw);
    }
  });

  it("4. 大小写不敏感（SDK 改了首字母大小写也认）", () => {
    expect(matchSdkGiveUp("CONNECTION FAILED REPEATEDLY")?.id).toBe(
      "connection-failed",
    );
    expect(
      matchSdkGiveUp("agent turn stopped after repeated resume attempts made no progress")
        ?.id,
    ).toBe("no-progress");
  });

  it("5. 错误对象带 SDK 字段（code / cause）→ 仍给友好文案，字段照旧拼进 detail", () => {
    const err = Object.assign(new Error(noProgressRaw), { code: "internal" });
    const r = summarizeRunFailure(noProgressRaw, err);
    expect(r.isSdkGiveUp).toBe(true);
    expect(r.detail).toContain("SDK error fields");
    expect(r.detail).toContain("internal");
  });

  it("6. 不误伤：普通报错 / 裸连接断 / 额度类都不算「SDK 放弃」", () => {
    const cases = [
      "agent run status=error: model overloaded",
      "agent run status=error\n--- SDK stream error message ---\nrate limit exceeded\n--- SDK result dump ---\n{}",
      taskBareDrop,
      "agent run status=error",
      "fetch failed",
      "Cannot read properties of undefined (reading 'foo')",
    ];
    for (const raw of cases) {
      expect(matchSdkGiveUp(raw), raw).toBeNull();
      expect(summarizeRunFailure(raw, new Error(raw)).isSdkGiveUp, raw).toBe(
        false,
      );
    }
  });

  it("7. 规则表自检：id 不重复、文案非空、都不依赖「为什么续接」这种没有证据的断言", () => {
    const ids = SDK_GIVE_UP_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of SDK_GIVE_UP_RULES) {
      expect(rule.text.length).toBeGreaterThan(20);
      // 根因（服务端 / 网络 / 停滞检测）目前无公开钩子可区分——文案里不许写死某一种
      expect(rule.text).not.toMatch(/因为|由于|sonnet|限流|额度/i);
    }
  });
});

describe("isRetryableRunError · SDK 自己放弃的一律不自动重连（Bug #3）", () => {
  it("1. no progress / Connection failed repeatedly → 不重连", () => {
    expect(isRetryableRunError(noProgressRaw, new Error(noProgressRaw))).toBe(
      false,
    );
    expect(
      isRetryableRunError(connFailedStreamRaw, new Error(connFailedStreamRaw)),
    ).toBe(false);
  });

  it("2. 即使同时带网络类关键字 / SDK 自标 isRetryable，也不重连（显式否决、不靠正则碰巧不匹配）", () => {
    const withNetwork =
      "agent run status=error: Connection failed repeatedly (fetch failed, ECONNRESET)";
    expect(isRetryableRunError(withNetwork, new Error(withNetwork))).toBe(false);

    const err = Object.assign(new Error(noProgressRaw), { isRetryable: true });
    expect(isRetryableRunError(noProgressRaw, err)).toBe(false);
    // attempt 也不改变结论
    expect(isRetryableRunError(noProgressRaw, err, 1)).toBe(false);
  });

  it("3. 对照：否决只针对这两句，其它该重连的照旧重连", () => {
    // 裸连接断
    expect(isRetryableRunError(taskBareDrop, new Error(taskBareDrop))).toBe(true);
    // 网络类关键字
    const net = "agent run status=error: fetch failed";
    expect(isRetryableRunError(net, new Error(net))).toBe(true);
    // SDK 自标可重试
    const flagged = Object.assign(new Error("boom"), { isRetryable: true });
    expect(isRetryableRunError("boom", flagged)).toBe(true);
    // 认证错照旧不重连
    const auth = "unauthenticated";
    expect(isRetryableRunError(auth, new Error(auth))).toBe(false);
  });
});

describe("buildRunNotFinishedError · 保留 SDK 的终态错误作 cause（Bug #3）", () => {
  it("result.error 存在 → 作为 cause 挂上，message 原样", () => {
    const sdkError = { message: "Agent turn stopped …", code: "internal" };
    const err = buildRunNotFinishedError("agent run status=error", {
      error: sdkError,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("agent run status=error");
    expect(err.cause).toBe(sdkError);
  });

  it("没有 result.error → 不挂 cause（不凭空造一个）", () => {
    const err = buildRunNotFinishedError("agent run status=error", {});
    expect("cause" in err).toBe(false);
  });

  it("cause 不是 Error 实例 → extractSdkErrorBits 不读它，既有的连接断判定不被改变", () => {
    // 裸 status=error 且 SDK 的 error 里没有任何内容：仍然是「裸连接断」
    const bare = buildRunNotFinishedError(taskBareDrop, {
      error: { message: "" },
    });
    expect(extractSdkErrorBits(bare)).toEqual({});
    expect(summarizeRunFailure(bare.message, bare).isConnectionDrop).toBe(true);
    expect(isRetryableRunError(bare.message, bare)).toBe(true);
  });
});

describe("接线契约 · 两个 runner 的非 finished 抛错都走 buildRunNotFinishedError", () => {
  const REPO = path.resolve(import.meta.dirname, "..");
  const read = (rel: string): string =>
    fs.readFileSync(path.join(REPO, rel), "utf-8");

  it.each(["src/lib/server/chat-runner.ts", "src/lib/server/task-runner.ts"])(
    "%s：不再裸 `throw new Error(\\`agent run status=…`",
    (rel) => {
      const src = read(rel);
      expect(src).toMatch(/throw buildRunNotFinishedError\(\s*`agent run status=/);
      expect(src).not.toMatch(/throw new Error\(\s*`agent run status=/);
    },
  );
});
