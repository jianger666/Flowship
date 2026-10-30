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
