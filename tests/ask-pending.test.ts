/**
 * ask_user「是否还该弹窗」判定单测（断线重启「多弹窗并发」修复的回归护栏）
 *
 * 核心防的事故（用户实测踩坑）：agent 问用户问题时断网、用户重启当前阶段——
 * 旧 ask 的 token 已失效却没被作废、前端反复复活旧弹窗、用户答了必报错、还死循环。
 * 修法：断线重启 / 换 agent / 停止时后端补 info 标记 meta.supersededAskId、
 * findPendingAskEvent 把「已答 或 已作废」的 ask 都当了结、不再弹。
 */
import { describe, expect, it } from "vitest";

import {
  findPendingAskEvent,
  isAskReplied,
  isAskSettled,
  isAskSuperseded,
} from "@/lib/ask-pending";
import type { TaskEvent } from "@/lib/types";

// 造一条事件（只填判定相关字段）
let seq = 0;
const ev = (
  kind: TaskEvent["kind"],
  meta?: Record<string, unknown>,
): TaskEvent => ({
  id: `e${seq++}`,
  ts: seq,
  kind,
  text: "",
  meta,
});

const ask = (askId: string) => ev("ask_user_request", { askId, questions: [] });
const reply = (askId: string) => ev("ask_user_reply", { askId });
const supersede = (askId: string) => ev("info", { supersededAskId: askId });

describe("isAskReplied", () => {
  it("有对应 ask_user_reply → true", () => {
    expect(isAskReplied([ask("X"), reply("X")], "X")).toBe(true);
  });
  it("没有 reply → false", () => {
    expect(isAskReplied([ask("X")], "X")).toBe(false);
  });
  it("reply 是别的 askId → false", () => {
    expect(isAskReplied([ask("X"), reply("Y")], "X")).toBe(false);
  });
});

describe("isAskSuperseded", () => {
  it("有 info supersededAskId → true", () => {
    expect(isAskSuperseded([ask("X"), supersede("X")], "X")).toBe(true);
  });
  it("没有作废标记 → false", () => {
    expect(isAskSuperseded([ask("X")], "X")).toBe(false);
  });
  it("作废的是别的 askId → false", () => {
    expect(isAskSuperseded([ask("X"), supersede("Y")], "X")).toBe(false);
  });
});

describe("isAskSettled", () => {
  it("已答 → 了结", () => {
    expect(isAskSettled([ask("X"), reply("X")], "X")).toBe(true);
  });
  it("已作废 → 了结", () => {
    expect(isAskSettled([ask("X"), supersede("X")], "X")).toBe(true);
  });
  it("既没答也没作废 → 未了结", () => {
    expect(isAskSettled([ask("X")], "X")).toBe(false);
  });
});

describe("findPendingAskEvent", () => {
  it("空事件流 → null", () => {
    expect(findPendingAskEvent([])).toBeNull();
  });

  it("单条未答 ask → 返回它", () => {
    const events = [ask("X")];
    expect(findPendingAskEvent(events)?.meta?.askId).toBe("X");
  });

  it("单条已答 ask → null（弹窗关闭）", () => {
    expect(findPendingAskEvent([ask("X"), reply("X")])).toBeNull();
  });

  it("单条已作废 ask → null（不弹失效旧问题）", () => {
    expect(findPendingAskEvent([ask("X"), supersede("X")])).toBeNull();
  });

  it("旧 ask 已答 + 新 ask 未答 → 返回新（倒序取最新未了结）", () => {
    const events = [ask("X"), reply("X"), ask("Y")];
    expect(findPendingAskEvent(events)?.meta?.askId).toBe("Y");
  });

  it("两条都未答 → 返回更新的那条（串行、一次只弹一个）", () => {
    const events = [ask("X"), ask("Y")];
    expect(findPendingAskEvent(events)?.meta?.askId).toBe("Y");
  });

  // 核心回归（同事踩坑、2026-07 修）：agent 重问后旧 ask 没标作废、用户答完新的、
  // 修复前旧弹窗会复活（倒序找「第一条未了结」命中 X）、答了必失败还把任务误标 error。
  // 修复后只认最新一条：Y 已答 → null、X 永不复活。
  it("旧 ask 未作废 + 新 ask 已答 → null（旧提问不复活）", () => {
    const events = [ask("X"), ask("Y"), reply("Y")];
    expect(findPendingAskEvent(events)).toBeNull();
  });

  it("ask_user_request 缺 askId → 跳过", () => {
    const broken = ev("ask_user_request", { questions: [] });
    expect(findPendingAskEvent([broken])).toBeNull();
  });

  // 核心回归：用户报的 bug 场景——断网问 X、重启作废 X、新 agent 重问 Y、用户答 Y、
  // 此后 X 不该复活（修复前 X 永久 pending、答完 Y 会再弹 X、答 X 又 410 死循环）
  it("断线重启场景：旧 ask 被作废 + 新 ask 已答 → null（旧问题不复活、无死循环）", () => {
    const events = [
      ask("X"), // 断网前 agent 问的那组
      supersede("X"), // 用户点重启、后端作废 X
      ask("Y"), // 新 agent 断点续传重新问（新 askId）
      reply("Y"), // 用户答完 Y
    ];
    expect(findPendingAskEvent(events)).toBeNull();
  });

  it("断线重启场景：作废 X 后、新 ask Y 还没答 → 只弹 Y（不弹失效的 X）", () => {
    const events = [ask("X"), supersede("X"), ask("Y")];
    expect(findPendingAskEvent(events)?.meta?.askId).toBe("Y");
  });
});
