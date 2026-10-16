/**
 * G4-02：task 输入条的发送幂等键（clientItemId）。
 *
 * 服务端 task 待送达队列按 clientItemId 去重，输入条以前不传，响应丢了再按回车会重复入队。
 * 上半部分测纯函数的复用 / 换号规则；下半部分是接线契约——输入条真的把 id 传给了
 * submitTaskQuestion、成功后才 settle。接线契约只能读源码（仓库测试环境是 node、没有 DOM），
 * 属于弱契约：只防「又把这条线删了」，行为正确性靠上半部分。
 * 前端接线未在浏览器里看过。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetTalkSendAttemptsForTest,
  claimTalkClientItemId,
  settleTalkClientItemId,
  talkSendFingerprint,
} from "@/lib/talk-send-attempt";

/** 可预测的发号器：id1、id2… */
const seqAlloc = () => {
  let n = 0;
  return () => `id${++n}`;
};

const base = { text: "把 A 改成 B" };

beforeEach(() => {
  __resetTalkSendAttemptsForTest();
});

describe("claimTalkClientItemId", () => {
  it("失败后原样重试：复用同一个 id（服务端靠它认出是同一条）", () => {
    const alloc = seqAlloc();
    const first = claimTalkClientItemId("t1", base, alloc);
    // 没 settle = 上一次没成功
    const retry = claimTalkClientItemId("t1", base, alloc);
    expect(retry).toBe(first);
    expect(first).toBe("id1");
  });

  it("成功 settle 后：下一条（哪怕内容一模一样）换新 id", () => {
    const alloc = seqAlloc();
    const first = claimTalkClientItemId("t1", base, alloc);
    settleTalkClientItemId("t1", first);
    const next = claimTalkClientItemId("t1", base, alloc);
    expect(next).not.toBe(first);
    expect(next).toBe("id2");
  });

  it("失败后改了内容：换新 id（同 id 带新内容会被服务端当重复吞掉）", () => {
    const alloc = seqAlloc();
    const first = claimTalkClientItemId("t1", base, alloc);
    expect(claimTalkClientItemId("t1", { text: "把 A 改成 C" }, alloc)).not.toBe(first);
  });

  it("正文以外任一维度变化也换新 id：图 / 路径附件 / skill / 显式模型", () => {
    const img = { data: "AAAA", mimeType: "image/png", filename: "a.png" };
    const variants: Array<Parameters<typeof claimTalkClientItemId>[1]> = [
      { ...base, images: [img] },
      { ...base, attachments: ["/tmp/a.txt"] },
      { ...base, skills: [{ name: "s", absPath: "/s/SKILL.md" }] },
      { ...base, modelKey: "gpt-x:" },
    ];
    for (const v of variants) {
      __resetTalkSendAttemptsForTest();
      const alloc = seqAlloc();
      const a = claimTalkClientItemId("t1", base, alloc);
      const b = claimTalkClientItemId("t1", v, alloc);
      expect(b).not.toBe(a);
    }
  });

  it("同长度、同类型、同文件名但内容不同的图不算同一条", () => {
    const alloc = seqAlloc();
    const a = claimTalkClientItemId(
      "t1",
      { ...base, images: [{ data: "AAAA", mimeType: "image/png" }] },
      alloc,
    );
    const b = claimTalkClientItemId(
      "t1",
      { ...base, images: [{ data: "BBBB", mimeType: "image/png" }] },
      alloc,
    );
    expect(b).not.toBe(a);
  });

  it("相同的图 / 路径 / skill / 模型：仍复用", () => {
    const alloc = seqAlloc();
    const input = {
      text: "看图",
      images: [{ data: "AAAA", mimeType: "image/png", filename: "a.png" }],
      attachments: ["/tmp/a.txt"],
      skills: [{ name: "s", absPath: "/s/SKILL.md" }],
      modelKey: "gpt-x:",
    };
    const a = claimTalkClientItemId("t1", input, alloc);
    // 深拷贝一份：不能靠引用相等蒙混
    const b = claimTalkClientItemId("t1", JSON.parse(JSON.stringify(input)), alloc);
    expect(b).toBe(a);
  });

  it("按 task 隔离：另一个 task 同内容不共用 id，也不顶掉本 task 的记录", () => {
    const alloc = seqAlloc();
    const a = claimTalkClientItemId("t1", base, alloc);
    const b = claimTalkClientItemId("t2", base, alloc);
    expect(b).not.toBe(a);
    // t1 重试仍拿到自己的
    expect(claimTalkClientItemId("t1", base, alloc)).toBe(a);
  });

  it("默认发号器：非空、两次不同（走 allocClientChatQueueItemId）", () => {
    const a = claimTalkClientItemId("t1", { text: "x" });
    settleTalkClientItemId("t1", a);
    const b = claimTalkClientItemId("t1", { text: "x" });
    expect(a).toMatch(/^cq_[0-9a-f]{12}$/);
    expect(b).not.toBe(a);
  });
});

describe("settleTalkClientItemId", () => {
  it("只清自己那一班：晚到的旧回调不能误删后来新一条的记录", () => {
    const alloc = seqAlloc();
    const old = claimTalkClientItemId("t1", base, alloc);
    // 内容变了 → 新一条顶掉旧记录
    const fresh = claimTalkClientItemId("t1", { text: "新内容" }, alloc);
    settleTalkClientItemId("t1", old);
    // 新一条的记录还在：失败重试仍复用
    expect(claimTalkClientItemId("t1", { text: "新内容" }, alloc)).toBe(fresh);
  });

  it("对没有记录的 task / 陌生 id 调用不炸", () => {
    expect(() => settleTalkClientItemId("nope", "x")).not.toThrow();
  });
});

describe("talkSendFingerprint", () => {
  it("不把整段图片 base64 带进指纹", () => {
    const big = "A".repeat(200_000);
    const fp = talkSendFingerprint({
      text: "x",
      images: [{ data: big, mimeType: "image/png" }],
    });
    expect(fp.length).toBeLessThan(500);
  });
});

describe("接线契约（弱：读源码）", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../src/components/tasks/task-talk-composer.tsx"),
    "utf8",
  );

  // 用 test() 而不是 toMatch：失败时不把整份组件源码打进报错
  it("输入条把 clientItemId 传给 submitTaskQuestion", () => {
    expect(
      /submitTaskQuestion\([\s\S]*?\{[^{}]*clientItemId[^{}]*\}\s*,?\s*\)/.test(src),
    ).toBe(true);
  });

  it("clientItemId 来自 claimTalkClientItemId，成功后才 settle（失败路径在 return 之前不 settle）", () => {
    expect(/claimTalkClientItemId\(/.test(src)).toBe(true);
    const settleAt = src.indexOf("settleTalkClientItemId(");
    const failAt = src.indexOf("if (!outcome.ok)");
    expect(failAt).toBeGreaterThan(0);
    expect(settleAt).toBeGreaterThan(failAt);
  });
});
