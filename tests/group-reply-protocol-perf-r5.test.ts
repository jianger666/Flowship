/**
 * 第五轮 review G1-07（回复协议侧）：agent 最终回复里的病态长串不得让解析器二次型膨胀。
 *
 * 为什么要测：parseGroupReply 是同步纯函数，跑在服务进程的事件循环里，一次几十秒的回溯会把
 * 整个 Flowship（含属主正在用的会话）卡死；输入是 agent 的最终回复，群里任何人都能诱导它写出
 * 一长串重复字符。入向卡片净化侧的同类问题见 tests/inbound-card-sanitize-r5.test.ts。
 *
 * 预算说明：不是性能基准，是「慢出几个数量级」的探测——线性实现在这些输入上是毫秒级，
 * 二次型实现要数秒到数十秒；1 秒余量在高负载机器上也不会误报。
 */
import { describe, expect, it } from "vitest";

import type { GroupMember } from "@/lib/server/feishu-bridge/group-contract";
import {
  parseGroupReply,
  type ParseGroupReplyCtx,
} from "@/lib/server/feishu-bridge/group-reply-protocol";

const members: GroupMember[] = [
  { openId: "ou_owner", name: "曾进有", kind: "user" },
  { openId: "ou_zhang", name: "张三", kind: "user" },
];

const ctx: ParseGroupReplyCtx = {
  members,
  owner: { openId: "ou_owner", name: "曾进有" },
  requester: { openId: "ou_anruo", name: "安若流年", isBot: true },
  selfOpenId: "ou_self",
};

const BUDGET_MS = 1000;
const timed = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe("G1-07 · parseGroupReply 在病态长串上有界（线性）", () => {
  it("超长标点串：哨兵判定剥「末尾标点」不能每个起点都扫一遍到文末", () => {
    for (const ch of ["。", "."]) {
      const raw = `${ch.repeat(30_000)}x`;
      expect(timed(() => parseGroupReply(raw, ctx)), `char=${ch}`).toBeLessThan(
        BUDGET_MS,
      );
    }
    // 语义不变：多个末尾标点照剥
    expect(parseGroupReply("NO_REPLY。。。！!.", ctx).kind).toBe("silent");
  });

  it("正文中间超长空白串 + 需属主确认：剥标记后清行尾空白不能二次型", () => {
    for (const blank of [" ", "\t"]) {
      const raw = `a${blank.repeat(30_000)}b\n[[需属主确认：x]]`;
      expect(timed(() => parseGroupReply(raw, ctx))).toBeLessThan(BUDGET_MS);
    }
    // 语义不变：行尾空白被剥、其余空白原样
    const r = parseGroupReply("a  \nb c \t\n[[需属主确认：x]]", ctx);
    expect(r.text.split("\n").slice(0, 2)).toEqual(["a", "b c"]);
  });

  it("需属主确认说明里重复的残缺 <at（没有 >）不能二次型", () => {
    const raw = `ok\n[[需属主确认：${"<at ".repeat(15_000)}]]`;
    expect(timed(() => parseGroupReply(raw, ctx))).toBeLessThan(BUDGET_MS);
  });

  it("需属主确认说明里重复的 <at x>（没有 </at>）不能二次型", () => {
    const raw = `ok\n[[需属主确认：${"<at x>".repeat(120_000)}]]`;
    expect(timed(() => parseGroupReply(raw, ctx))).toBeLessThan(BUDGET_MS);
  });

  it("大量没有 ]] 的 [[需属主确认： 开头不能每个都扫一遍到文末", () => {
    const raw = "[[需属主确认：".repeat(75_000);
    expect(timed(() => parseGroupReply(raw, ctx))).toBeLessThan(BUDGET_MS);
  });

  it("大量没有 </at> 的 <at user_id=…> 开标签不能每个都扫一遍到文末", () => {
    const raw = '<at user_id="ou_fake">'.repeat(40_000);
    expect(timed(() => parseGroupReply(raw, ctx))).toBeLessThan(BUDGET_MS);
  });

  it("碎片拆除正则（`<` 与 at 之间容忍空白）在长空白串上也是线性", () => {
    for (const raw of [
      `<${" ".repeat(100_000)}x`,
      `<${" ".repeat(50_000)}/${" ".repeat(50_000)}x`,
      "< ".repeat(50_000),
      "</ ".repeat(40_000),
    ]) {
      expect(timed(() => parseGroupReply(raw, ctx))).toBeLessThan(BUDGET_MS);
    }
  });

  it("大量不同的未识别 @名字：去重不能是线性表查找", () => {
    const raw = Array.from({ length: 60_000 }, (_, i) => `@u${i} `).join("");
    expect(timed(() => parseGroupReply(raw, ctx))).toBeLessThan(BUDGET_MS);
  });
});
