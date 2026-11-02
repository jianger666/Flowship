/**
 * lark-api：单次超时可配（R14 P1-1）
 *
 * 所有飞书调用走同一条进程级单飞队列：一个「黑洞」请求占满默认 30s，后面所有任务的发消息 / 入站回执都要陪等。
 * 卡片更新类调用（PUT / PATCH / batch_update）传短超时；其它调用方不传 = 行为不变。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetLarkBinCacheForTest,
  __setLarkExecForTest,
  __setLarkRetryBaseForTest,
  batchUpdateCard,
  larkApi,
  patchCardSettings,
  runLark,
  sendTextMessage,
  updateCardElementContent,
  updateCardEntity,
} from "@/lib/server/feishu-bridge/lark-api";

const DEFAULT_MS = 30_000;

/** 记录每次 exec 收到的 timeout；响应固定成功 */
const recordTimeouts = (): number[] => {
  const seen: number[] = [];
  __setLarkExecForTest(async (_bin, _args, opts) => {
    seen.push(opts.timeout);
    return { stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
  });
  return seen;
};

beforeEach(() => {
  __resetLarkBinCacheForTest();
  __setLarkRetryBaseForTest(0);
});

afterEach(() => {
  __setLarkExecForTest(null);
  __resetLarkBinCacheForTest();
  __setLarkRetryBaseForTest(null);
});

describe("sendTextMessage：callOpts.timeoutMs 透传到 exec 的 timeout", () => {
  // finalizeTurn 的预算压缩（剩余不足 30s 时把单发超时压短）全靠这一层透传；被改坏的话预算测试只测到 outbound 的 mock，抓不到
  it("不传 = 默认 30s；传了就是传的值（且不影响后一次）", async () => {
    const seen: number[] = [];
    const okSend = JSON.stringify({ ok: true, data: { message_id: "om_x", chat_id: "oc_x" } });
    __setLarkExecForTest(async (_bin, _args, opts) => {
      seen.push(opts.timeout);
      return { stdout: okSend, stderr: "" };
    });
    await sendTextMessage("ou_x", "你好");
    await sendTextMessage("ou_x", "你好", { timeoutMs: 6500 });
    await sendTextMessage("ou_x", "你好", {});
    expect(seen).toEqual([DEFAULT_MS, 6500, DEFAULT_MS]);
  });
});

describe("runLark / larkApi：timeoutMs", () => {
  it("不传 = 默认 30s（改前行为不变）", async () => {
    const seen = recordTimeouts();
    await runLark(["im", "+messages-send"]);
    await larkApi("GET", "/open-apis/x");
    expect(seen).toEqual([DEFAULT_MS, DEFAULT_MS]);
  });

  it("传了就用传的值（runLark 与 larkApi 都透传），而且只管这一次调用、不影响后面的", async () => {
    const seen = recordTimeouts();
    await runLark(["im", "+messages-send"], { timeoutMs: 8000 });
    await larkApi("PUT", "/open-apis/x", { data: { a: 1 }, timeoutMs: 5000 });
    await larkApi("PUT", "/open-apis/x", { data: { a: 1 } });
    expect(seen).toEqual([8000, 5000, DEFAULT_MS]);
  });

  // execFile 的 timeout: 0 是「永不超时」——脏值绝不能原样传下去，否则一个黑洞请求会永久占住单飞队列
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "8000" as unknown as number])(
    "非法超时 %s 回退默认 30s",
    async (bad) => {
      const seen = recordTimeouts();
      await runLark(["im", "+messages-send"], { timeoutMs: bad });
      await larkApi("GET", "/open-apis/x", { timeoutMs: bad });
      expect(seen).toEqual([DEFAULT_MS, DEFAULT_MS]);
    },
  );

  // execFile 的 timeout 必须是无符号整数：小数直接抛 ERR_OUT_OF_RANGE（node 实测），
  // 终稿预算用单调时钟算出的剩余值就是小数——不取整的话预算内的补发整条失败
  it("小数超时向下取整成整数、至少 1ms（0.5 取整成 0 会变成「永不超时」）、过大的值封顶在 32 位整数", async () => {
    const seen = recordTimeouts();
    await runLark(["im", "+messages-send"], { timeoutMs: 1234.567 });
    await runLark(["im", "+messages-send"], { timeoutMs: 0.5 });
    await larkApi("GET", "/open-apis/x", { timeoutMs: 9999.999 });
    await runLark(["im", "+messages-send"], { timeoutMs: 1e12 });
    expect(seen).toEqual([1234, 1, 9999, 2_147_483_647]);
    for (const t of seen) expect(Number.isInteger(t)).toBe(true);
  });

  it("sendTextMessage 的小数超时同样取整后再交给 exec", async () => {
    const seen: number[] = [];
    const okSend = JSON.stringify({ ok: true, data: { message_id: "om_x", chat_id: "oc_x" } });
    __setLarkExecForTest(async (_bin, _args, opts) => {
      seen.push(opts.timeout);
      return { stdout: okSend, stderr: "" };
    });
    await sendTextMessage("ou_x", "你好", { timeoutMs: 6500.75 });
    expect(seen).toEqual([6500]);
  });

  it("超时（killed）的错误文案报这次调用实际用的超时值", async () => {
    __setLarkExecForTest(async () => {
      throw Object.assign(new Error("killed"), { killed: true, code: null });
    });
    await expect(
      runLark(["im", "+messages-send"], { timeoutMs: 8000 }),
    ).rejects.toThrow(/超时（8000ms）/);
    await expect(runLark(["im", "+messages-send"])).rejects.toThrow(
      /超时（30000ms）/,
    );
  });
});

describe("卡片更新函数的可选超时", () => {
  const cases: Array<[string, (o?: { timeoutMs?: number }) => Promise<void>]> = [
    [
      "updateCardElementContent",
      (o) => updateCardElementContent("c", "md_answer", "x", 1, o),
    ],
    ["batchUpdateCard", (o) => batchUpdateCard("c", [], 1, o)],
    ["updateCardEntity", (o) => updateCardEntity("c", {}, 1, o)],
    ["patchCardSettings", (o) => patchCardSettings("c", {}, 1, o)],
  ];

  it.each(cases)("%s：不传 = 30s（其它调用方行为不变），传 { timeoutMs: 8000 } = 8s", async (_name, call) => {
    const seen = recordTimeouts();
    await call();
    await call({ timeoutMs: 8000 });
    expect(seen).toEqual([DEFAULT_MS, 8000]);
  });
});
