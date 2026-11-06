/**
 * 需求群答疑流式卡（group-card-stream）：建卡时机 / 节流 / 收尾 / 兜底 / 没有熔断。
 *
 * 全部走注入的假依赖 + 假计时器，不碰飞书、不碰真实数据目录（序号分配器也换成假的）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGroupCardStream,
  type GroupCardStreamDeps,
} from "@/lib/server/feishu-bridge/group-card-stream";

type Call = { op: string; args: unknown[] };

const makeDeps = (
  overrides: Partial<GroupCardStreamDeps> = {},
): { deps: GroupCardStreamDeps; calls: Call[] } => {
  const calls: Call[] = [];
  let seq = 0;
  const rec =
    <A extends unknown[], R>(op: string, fn: (...a: A) => R) =>
    (...args: A): R => {
      calls.push({ op, args });
      return fn(...args);
    };
  const deps: GroupCardStreamDeps = {
    createCard: rec("createCard", async () => ({ card_id: "card_1" })),
    sendCard: rec("sendCard", async () => ({ message_id: "om_1" })),
    putContent: rec("putContent", async () => undefined),
    putCard: rec("putCard", async () => undefined),
    sendMarkdown: rec("sendMarkdown", async () => ({})),
    nextSeq: () => (seq += 1),
    ...overrides,
  };
  return { deps, calls };
};

const ops = (calls: Call[]): string[] => calls.map((c) => c.op);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("建卡时机与投递目标", () => {
  it("没 push 过：finalize 全部走文本卡，不建卡（短回复 / 一次性回复）", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    const res = await s.finalize(["好的"]);
    expect(ops(calls)).toEqual(["sendMarkdown"]);
    expect(calls[0]!.args).toEqual(["oc_g", "好的"]);
    expect(res).toMatchObject({ delivered: true, streamed: false });
  });

  it("首次 push 才建卡：流式卡 JSON（streaming_mode 开 + 打字机配置 + 摘要「生成中」）→ 按 chat_id 发到群", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("你好");
    await vi.advanceTimersByTimeAsync(0);
    expect(ops(calls)).toEqual(["createCard", "sendCard"]);
    const card = calls[0]!.args[0] as {
      schema: string;
      config: Record<string, unknown>;
      body: { elements: Array<{ element_id: string; content: string }> };
    };
    expect(card.schema).toBe("2.0");
    expect(card.config.streaming_mode).toBe(true);
    expect(card.config.width_mode).toBe("fill");
    expect(card.config.summary).toEqual({ content: "生成中" });
    expect(card.config.streaming_config).toBeTruthy();
    expect(card.body.elements).toEqual([
      { tag: "markdown", element_id: "md_text", content: "你好" },
    ]);
    // 投递目标是群 chat_id（不是私聊 open_id）
    expect(calls[1]!.args).toEqual(["oc_g", "card_1"]);
    expect(s.isStarted()).toBe(true);
    expect(s.getIds()).toEqual({ cardId: "card_1", messageId: "om_1" });
  });

  it("空白 push 不建卡", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("   \n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
  });

  it("<at user_id> 旧写法在推送前转成卡片写法；字面量 < 转义", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push('<at user_id="ou_x">张三</at> 用 List<string>');
    await vi.advanceTimersByTimeAsync(0);
    const card = calls[0]!.args[0] as {
      body: { elements: Array<{ content: string }> };
    };
    expect(card.body.elements[0]!.content).toBe("<at id=ou_x></at> 用 List&lt;string>");
  });
});

describe("节流与最新全文", () => {
  it("300ms 内多次 push 只推一次最新全文；序号严格递增；内容没变不重复推", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    s.push("ab");
    s.push("abc");
    s.push("abcd");
    await vi.advanceTimersByTimeAsync(299);
    expect(ops(calls)).toEqual(["createCard", "sendCard"]);
    await vi.advanceTimersByTimeAsync(2);
    const puts = calls.filter((c) => c.op === "putContent");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.args.slice(0, 3)).toEqual(["card_1", "md_text", "abcd"]);
    // 没有新内容：再过很久也不再推
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.filter((c) => c.op === "putContent")).toHaveLength(1);
    // 又来新内容：序号比上一发大
    s.push("abcde");
    await vi.advanceTimersByTimeAsync(301);
    const puts2 = calls.filter((c) => c.op === "putContent");
    expect(puts2).toHaveLength(2);
    expect(puts2[1]!.args[3] as number).toBeGreaterThan(puts2[0]!.args[3] as number);
  });

  it("建卡还在飞时又来了新内容：卡里是首次内容，建完后补推最新全文", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, calls } = makeDeps({
      createCard: async (json) => {
        calls.push({ op: "createCard", args: [json] });
        await gate;
        return { card_id: "card_1" };
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("第一句");
    await vi.advanceTimersByTimeAsync(0);
    s.push("第一句，第二句");
    release();
    await vi.advanceTimersByTimeAsync(400);
    const puts = calls.filter((c) => c.op === "putContent");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.args[2]).toBe("第一句，第二句");
  });

  it("段落切换（新文本不以旧文本为前缀）也照样整段推上去", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("我先看下代码");
    await vi.advanceTimersByTimeAsync(0);
    s.push("结论：没问题");
    await vi.advanceTimersByTimeAsync(301);
    const puts = calls.filter((c) => c.op === "putContent");
    expect(puts[0]!.args[2]).toBe("结论：没问题");
  });
});

describe("收尾", () => {
  it("终稿：等在飞的刷新落定 → 整卡 PUT（streaming_mode 显式关、摘要是正文开头）；刷新不会在终稿之后再冒出来", async () => {
    let releasePut!: () => void;
    const putGate = new Promise<void>((r) => (releasePut = r));
    const { deps, calls } = makeDeps({
      putContent: async (...args) => {
        calls.push({ op: "putContent", args });
        await putGate;
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("半截");
    await vi.advanceTimersByTimeAsync(0);
    s.push("半截内容");
    await vi.advanceTimersByTimeAsync(301); // 刷新发出、卡在 gate
    const fin = s.finalize(["完整答案"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((c) => c.op === "putCard")).toBe(false); // 还在等刷新落定
    releasePut();
    const res = await fin;
    expect(res).toMatchObject({ delivered: true, streamed: true });
    const order = ops(calls);
    expect(order.indexOf("putCard")).toBeGreaterThan(order.indexOf("putContent"));
    const put = calls.find((c) => c.op === "putCard")!;
    const card = put.args[1] as {
      config: Record<string, unknown>;
      body: { elements: Array<{ content: string }> };
    };
    expect(card.config.streaming_mode).toBe(false);
    expect(card.config.summary).toEqual({ content: "完整答案" });
    expect(card.config.streaming_config).toBeUndefined();
    expect(card.body.elements[0]!.content).toBe("完整答案");
    // 终稿之后不再有刷新
    s.push("终稿后的迟到内容");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ops(calls).filter((o) => o === "putContent")).toHaveLength(1);
  });

  it("多块：第 1 块进流式卡，其余块各发一张文本卡（顺序保持）", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("开头");
    await vi.advanceTimersByTimeAsync(0);
    const res = await s.finalize(["块1", "块2", "块3"]);
    expect(res.delivered).toBe(true);
    expect(calls.filter((c) => c.op === "sendMarkdown").map((c) => c.args[1])).toEqual([
      "块2",
      "块3",
    ]);
  });

  it("多块发送遇到第一个失败就停，返回 delivered:false + 错误", async () => {
    const boom = new Error("send boom");
    const { deps, calls } = makeDeps({
      sendMarkdown: async (...args) => {
        calls.push({ op: "sendMarkdown", args });
        throw boom;
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    const res = await s.finalize(["块1", "块2"]);
    expect(calls.filter((c) => c.op === "sendMarkdown")).toHaveLength(1);
    expect(res).toMatchObject({ delivered: false, streamed: false });
    expect(res.error).toBe(boom);
  });

  it("幂等：重复 finalize 返回同一个结果、不重复发", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    const a = s.finalize(["x"]);
    const b = s.finalize(["y"]);
    expect(b).toBe(a);
    await a;
    expect(calls.filter((c) => c.op === "sendMarkdown")).toHaveLength(1);
  });
});

describe("失败与兜底（没有熔断）", () => {
  it("建卡失败：不再重试建卡，finalize 全部走文本卡，群里照样拿到完整回复", async () => {
    let creates = 0;
    const { deps, calls } = makeDeps({
      createCard: async () => {
        creates += 1;
        throw new Error("no cardkit scope");
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    s.push("ab");
    s.push("abc");
    await vi.advanceTimersByTimeAsync(2000);
    expect(creates).toBe(1);
    expect(s.isStarted()).toBe(false);
    const res = await s.finalize(["完整"]);
    expect(res).toMatchObject({ delivered: true, streamed: false });
    expect(calls.filter((c) => c.op === "sendMarkdown").map((c) => c.args[1])).toEqual([
      "完整",
    ]);
  });

  it("发卡失败（实体建了但没发出去）同样按「没有卡」处理", async () => {
    const { deps, calls } = makeDeps({
      sendCard: async () => {
        throw new Error("send boom");
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    const res = await s.finalize(["完整"]);
    expect(res.streamed).toBe(false);
    expect(calls.some((c) => c.op === "sendMarkdown")).toBe(true);
    expect(calls.some((c) => c.op === "putCard")).toBe(false);
  });

  it("中间刷新失败：只记日志不抛、之后照常再试（间隔变长但封顶）、恢复后推上最新全文", async () => {
    let fail = true;
    const { deps, calls } = makeDeps({
      putContent: async (...args) => {
        calls.push({ op: "putContent", args });
        if (fail) throw new Error("rate limited");
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    s.push("ab");
    await vi.advanceTimersByTimeAsync(301); // 第 1 次失败
    expect(calls.filter((c) => c.op === "putContent")).toHaveLength(1);
    // 失败后退避：下一次 600ms 后，再下一次 1200ms…（不是 300ms 一发）
    await vi.advanceTimersByTimeAsync(590);
    expect(calls.filter((c) => c.op === "putContent")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls.filter((c) => c.op === "putContent")).toHaveLength(2);
    fail = false;
    s.push("abc");
    await vi.advanceTimersByTimeAsync(10_000);
    const puts = calls.filter((c) => c.op === "putContent");
    expect(puts[puts.length - 1]!.args[2]).toBe("abc");
    // 持续失败时重试间隔封顶 5s：不会无限变慢、也不会无限变快
    fail = true;
    s.push("abcd");
    await vi.advanceTimersByTimeAsync(60_000);
    const n = calls.filter((c) => c.op === "putContent").length;
    expect(n).toBeLessThan(2 + 1 + 1 + 60 / 0.6); // 远少于 300ms 一发的 200 次
    expect(n).toBeGreaterThan(5);
  });

  it("终稿 PUT 失败：重试后成功就算落成（不另发兜底卡）", async () => {
    let attempts = 0;
    const { deps, calls } = makeDeps({
      putCard: async (...args) => {
        calls.push({ op: "putCard", args });
        attempts += 1;
        if (attempts < 3) throw new Error("timeout");
      },
    });
    const s = createGroupCardStream({
      chatId: "oc_g",
      deps,
      finalRetryDelaysMs: [0, 0],
    });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    const res = await s.finalize(["终稿"]);
    expect(attempts).toBe(3);
    expect(res).toMatchObject({ delivered: true, streamed: true });
    expect(calls.some((c) => c.op === "sendMarkdown")).toBe(false);
  });

  it("终稿 PUT 重试用尽：全部块另发文本卡兜底（半截卡留着，但群里有完整答案）", async () => {
    const { deps, calls } = makeDeps({
      putCard: async (...args) => {
        calls.push({ op: "putCard", args });
        throw new Error("gone");
      },
    });
    const s = createGroupCardStream({
      chatId: "oc_g",
      deps,
      finalRetryDelaysMs: [0, 0],
    });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    const res = await s.finalize(["块1", "块2"]);
    expect(calls.filter((c) => c.op === "putCard")).toHaveLength(3);
    expect(calls.filter((c) => c.op === "sendMarkdown").map((c) => c.args[1])).toEqual([
      "块1",
      "块2",
    ]);
    expect(res).toMatchObject({ delivered: true, streamed: true });
  });

  it("终稿 PUT 用尽、兜底也发不出去：delivered:false，带上错误", async () => {
    const boom = new Error("all down");
    const { deps } = makeDeps({
      putCard: async () => {
        throw new Error("gone");
      },
      sendMarkdown: async () => {
        throw boom;
      },
    });
    const s = createGroupCardStream({
      chatId: "oc_g",
      deps,
      finalRetryDelaysMs: [0],
    });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    const res = await s.finalize(["终稿"]);
    expect(res.delivered).toBe(false);
    expect(res.error).toBe(boom);
  });
});
