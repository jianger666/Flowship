/**
 * 需求群答疑流式卡（group-card-stream）：版式（照私聊流式卡）/ 建卡时机 / 节流 / 过程区 / 收尾 / 兜底 / 没有熔断。
 *
 * 2026-11-09 改：此前群卡只有一个 markdown 元素、推「当前段」，卡上永远只有一句话；现在照私聊卡
 *（header + 「思考与工具」折叠面板 + 正文 + 分割线 + footer），正文只增不换。
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
    batchUpdate: rec("batchUpdate", async () => undefined),
    patchSettings: rec("patchSettings", async () => undefined),
    sendMarkdown: rec("sendMarkdown", async () => ({})),
    nextSeq: () => (seq += 1),
    ...overrides,
  };
  return { deps, calls };
};

const ops = (calls: Call[]): string[] => calls.map((c) => c.op);

type CardJson = {
  schema: string;
  config: Record<string, unknown>;
  header: {
    title: { content: string };
    subtitle?: { content: string };
    template: string;
  };
  body: { elements: Array<Record<string, unknown>> };
};

/** 在卡片 JSON 里按 element_id 找元素（含折叠面板里嵌套的） */
const findEl = (
  card: CardJson,
  id: string,
): Record<string, unknown> | undefined => {
  const walk = (els: Array<Record<string, unknown>>): Record<string, unknown> | undefined => {
    for (const el of els) {
      if (el.element_id === id) return el;
      const nested = el.elements as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(nested)) {
        const hit = walk(nested);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(card.body.elements);
};

const answerOf = (card: CardJson): string =>
  String(findEl(card, "md_answer")?.content);
const processOf = (card: CardJson): string =>
  String(findEl(card, "md_process")?.content);
const footerOf = (card: CardJson): string =>
  String(findEl(card, "md_footer")?.content);

const putContents = (calls: Call[]): Call[] =>
  calls.filter((c) => c.op === "putContent");
const batchCalls = (calls: Call[]): Call[] =>
  calls.filter((c) => c.op === "batchUpdate");
/** batchUpdate 一次推的过程区内容 */
const processPushed = (c: Call): string => {
  const actions = c.args[1] as Array<{
    action: string;
    params: { element_id: string; element: { content: string } };
  }>;
  expect(actions).toHaveLength(1);
  expect(actions[0]!.action).toBe("update_element");
  expect(actions[0]!.params.element_id).toBe("md_process");
  return actions[0]!.params.element.content;
};

const tooLong = (): Error =>
  Object.assign(new Error("Card content exceeds limit"), { code: 200860 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("建卡时机、版式与投递目标", () => {
  it("没 push 过：finalize 全部走文本卡，不建卡（短回复 / 一次性回复）", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    const res = await s.finalize(["好的"]);
    expect(ops(calls)).toEqual(["sendMarkdown"]);
    expect(calls[0]!.args).toEqual(["oc_g", "好的"]);
    expect(res).toMatchObject({ delivered: true, streamed: false });
  });

  it("首次 push 才建卡：版式 = 私聊流式卡（header + 思考与工具面板 + 正文 + 分割线 + footer）→ 按 chat_id 发到群", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", title: "登录优化", deps });
    s.push("你好");
    await vi.advanceTimersByTimeAsync(0);
    expect(ops(calls)).toEqual(["createCard", "sendCard"]);
    const card = calls[0]!.args[0] as CardJson;
    expect(card.schema).toBe("2.0");
    expect(card.config.streaming_mode).toBe(true);
    expect(card.config.width_mode).toBe("fill");
    expect(card.config.summary).toEqual({ content: "生成中" });
    expect(card.config.streaming_config).toBeTruthy();
    expect(card.header.title.content).toBe("登录优化");
    expect(card.header.template).toBe("blue");
    // 元素顺序：折叠面板 → 正文 → 分割线 → footer
    expect(card.body.elements.map((e) => e.element_id ?? e.tag)).toEqual([
      "panel_process",
      "md_answer",
      "main_divider",
      "md_footer",
    ]);
    expect(card.body.elements[0]!.tag).toBe("collapsible_panel");
    expect(card.body.elements[0]!.expanded).toBe(false);
    expect(answerOf(card)).toBe("你好");
    expect(processOf(card)).toBe("");
    expect(footerOf(card)).toMatch(/生成中/); // spinner
    // 投递目标是群 chat_id（不是私聊 open_id）
    expect(calls[1]!.args).toEqual(["oc_g", "card_1"]);
    expect(s.isStarted()).toBe(true);
    expect(s.getIds()).toEqual({ cardId: "card_1", messageId: "om_1" });
  });

  it("没传标题：header 标题兜底 Flowship", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("你好");
    await vi.advanceTimersByTimeAsync(0);
    expect((calls[0]!.args[0] as CardJson).header.title.content).toBe("Flowship");
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
    expect(answerOf(calls[0]!.args[0] as CardJson)).toBe(
      "<at id=ou_x></at> 用 List&lt;string>",
    );
  });

  it("过程区先到、正文后到：pushProcess 本身不建卡（NO_REPLY 零消息）；首次 push 建卡时带上，面板标题数工具次数", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.pushProcess("> `Shell` · completed\n> ls\n\n> `Read` · running");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
    s.push("结论");
    await vi.advanceTimersByTimeAsync(0);
    const card = calls[0]!.args[0] as CardJson;
    expect(processOf(card)).toBe("> `Shell` · completed\n> ls\n\n> `Read` · running");
    const panel = card.body.elements[0] as { header: { title: { content: string } } };
    expect(panel.header.title.content).toBe("思考与工具 · 2 次工具调用");
    // 建卡带上了，不用再 batch 补推
    expect(batchCalls(calls)).toHaveLength(0);
  });
});

describe("节流与最新全文", () => {
  it("300ms 内多次 push 只推一次最新全文（走 md_answer）；序号严格递增；内容没变不重复推", async () => {
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
    const puts = putContents(calls);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.args.slice(0, 3)).toEqual(["card_1", "md_answer", "abcd"]);
    // 没有新内容：再过很久也不再推
    await vi.advanceTimersByTimeAsync(5000);
    expect(putContents(calls)).toHaveLength(1);
    // 又来新内容：序号比上一发大
    s.push("abcde");
    await vi.advanceTimersByTimeAsync(301);
    const puts2 = putContents(calls);
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
    const puts = putContents(calls);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.args[2]).toBe("第一句，第二句");
  });

  it("前缀分叉（新文本不以旧文本为前缀）也照样整段推上去", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("我先看下代码");
    await vi.advanceTimersByTimeAsync(0);
    s.push("结论：没问题");
    await vi.advanceTimersByTimeAsync(301);
    expect(putContents(calls)[0]!.args[2]).toBe("结论：没问题");
  });
});

describe("过程区（折叠面板内的 md_process）", () => {
  it("已建卡后 pushProcess：走 batch update_element（嵌套元素流式 PUT 静默无效），不走 putContent；内容没变不重复推", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("正文");
    await vi.advanceTimersByTimeAsync(0);
    s.pushProcess("**思考 1** · running\n想想");
    await vi.advanceTimersByTimeAsync(301);
    const batches = batchCalls(calls);
    expect(batches).toHaveLength(1);
    expect(processPushed(batches[0]!)).toBe("**思考 1** · running\n想想");
    expect(batches[0]!.args[0]).toBe("card_1");
    expect(putContents(calls)).toHaveLength(0); // 正文没变
    // 同样内容再推：不重复
    s.pushProcess("**思考 1** · running\n想想");
    await vi.advanceTimersByTimeAsync(5000);
    expect(batchCalls(calls)).toHaveLength(1);
    // 变了才推；序号比上一发大
    s.pushProcess("**思考 1** · completed\n想想");
    await vi.advanceTimersByTimeAsync(301);
    const b2 = batchCalls(calls);
    expect(b2).toHaveLength(2);
    expect(b2[1]!.args[2] as number).toBeGreaterThan(b2[0]!.args[2] as number);
  });

  it("一轮刷新里过程区和正文都变了：先过程区后正文，序号依次递增", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    s.pushProcess("p1");
    s.push("ab");
    await vi.advanceTimersByTimeAsync(301);
    const flushOps = ops(calls).slice(2);
    expect(flushOps).toEqual(["batchUpdate", "putContent"]);
    const seqs = calls.slice(2).map((c) => (c.op === "batchUpdate" ? c.args[2] : c.args[3]) as number);
    expect(seqs[1]).toBeGreaterThan(seqs[0]!);
  });

  it("过程区刷新失败：不影响正文刷新；退避后重试、恢复后补推最新过程区", async () => {
    let fail = true;
    const { deps, calls } = makeDeps({
      batchUpdate: async (...args) => {
        calls.push({ op: "batchUpdate", args });
        if (fail) throw new Error("rate limited");
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    s.pushProcess("p1");
    s.push("ab");
    await vi.advanceTimersByTimeAsync(301);
    expect(batchCalls(calls)).toHaveLength(1); // 失败了
    expect(putContents(calls)).toHaveLength(1); // 正文照推
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    const b = batchCalls(calls);
    expect(processPushed(b[b.length - 1]!)).toBe("p1");
  });

  it("收尾后的 pushProcess 一律忽略", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    await s.finalize(["a"]);
    const before = calls.length;
    s.pushProcess("迟到的过程区");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(before);
  });
});

describe("收尾", () => {
  it("终稿：等在飞的刷新落定 → 整卡 PUT（header 已完成·绿、footer 耗时 · 模型、摘要是正文开头）→ 过程区回写 → 关 streaming_mode；刷新不会在终稿之后再冒出来", async () => {
    let releasePut!: () => void;
    const putGate = new Promise<void>((r) => (releasePut = r));
    const { deps, calls } = makeDeps({
      putContent: async (...args) => {
        calls.push({ op: "putContent", args });
        await putGate;
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", title: "登录优化", deps });
    s.push("半截");
    await vi.advanceTimersByTimeAsync(0);
    s.pushProcess("> `Shell` · completed");
    s.push("半截内容");
    await vi.advanceTimersByTimeAsync(301); // 刷新发出、卡在 gate
    const fin = s.finalize(["完整答案"], {
      outcome: "ok",
      durationMs: 83_000,
      model: "claude-sonnet-5",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((c) => c.op === "putCard")).toBe(false); // 还在等刷新落定
    releasePut();
    const res = await fin;
    expect(res).toMatchObject({ delivered: true, streamed: true });
    const order = ops(calls);
    expect(order.indexOf("putCard")).toBeGreaterThan(order.indexOf("putContent"));
    const put = calls.find((c) => c.op === "putCard")!;
    expect(put.args[0]).toBe("card_1");
    const card = put.args[1] as CardJson;
    expect(card.header.title.content).toBe("登录优化");
    expect(card.header.template).toBe("green");
    expect(card.header.subtitle?.content).toBe("已完成");
    expect(answerOf(card)).toBe("完整答案");
    expect(processOf(card)).toBe("> `Shell` · completed");
    expect(footerOf(card)).toContain("1m23s");
    expect(footerOf(card)).toContain("claude-sonnet-5");
    expect(footerOf(card)).not.toMatch(/生成中/);
    // 摘要 = 正文开头（会话列表 / 推送预览），不是「已完成」
    expect(card.config.summary).toEqual({ content: "完整答案" });
    // 整卡 PUT 带 streaming_mode:true（同私聊卡），随后 PATCH settings 才关
    expect(card.config.streaming_mode).toBe(true);
    // 顺序：putCard → 过程区 batch 回写 → patchSettings
    const iPut = order.indexOf("putCard");
    const iBatch = order.lastIndexOf("batchUpdate");
    const iPatch = order.indexOf("patchSettings");
    expect(iBatch).toBeGreaterThan(iPut);
    expect(iPatch).toBeGreaterThan(iBatch);
    expect(processPushed(calls[iBatch]!)).toBe("> `Shell` · completed");
    const patch = calls[iPatch]!;
    expect(patch.args[0]).toBe("card_1");
    expect(patch.args[1]).toEqual({
      config: { streaming_mode: false, update_multi: true, width_mode: "fill" },
    });
    // 序号：putCard < batch < patch，严格递增
    expect(calls[iBatch]!.args[2] as number).toBeGreaterThan(put.args[2] as number);
    expect(patch.args[2] as number).toBeGreaterThan(calls[iBatch]!.args[2] as number);
    // 终稿之后不再有刷新
    s.push("终稿后的迟到内容");
    await vi.advanceTimersByTimeAsync(5000);
    expect(putContents(calls)).toHaveLength(1);
  });

  it("没有过程区：不做过程区 batch 回写（只 PUT + PATCH）", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    await s.finalize(["终稿"]);
    expect(ops(calls)).toEqual(["createCard", "sendCard", "putCard", "patchSettings"]);
  });

  it("outcome=failed：红色 header、footer「处理失败 · 统计」、无「已完成」副标题", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    await s.finalize(["提示"], { outcome: "failed", durationMs: 5_000 });
    const card = calls.find((c) => c.op === "putCard")!.args[1] as CardJson;
    expect(card.header.template).toBe("red");
    expect(card.header.subtitle).toBeUndefined();
    expect(footerOf(card)).toBe("处理失败 · 5s");
  });

  it("没传收尾选项：按正常完成处理（绿、footer 为空）", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    await s.finalize(["终稿"]);
    const card = calls.find((c) => c.op === "putCard")!.args[1] as CardJson;
    expect(card.header.template).toBe("green");
    expect(footerOf(card)).toBe("");
  });

  it("给了 body：整份累积全文进卡，其余块不另发文本卡", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("开头");
    await vi.advanceTimersByTimeAsync(0);
    const body = "第一段\n\n第二段\n\n第三段";
    const res = await s.finalize(["块1", "块2", "块3"], { body });
    expect(res).toMatchObject({ delivered: true, streamed: true });
    const card = calls.find((c) => c.op === "putCard")!.args[1] as CardJson;
    expect(answerOf(card)).toBe(body);
    expect(calls.some((c) => c.op === "sendMarkdown")).toBe(false);
  });

  it("没给 body（旧行为）：第 1 块进卡，其余块各发一张文本卡（顺序保持）", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("开头");
    await vi.advanceTimersByTimeAsync(0);
    const res = await s.finalize(["块1", "块2", "块3"]);
    expect(res.delivered).toBe(true);
    const card = calls.find((c) => c.op === "putCard")!.args[1] as CardJson;
    expect(answerOf(card)).toBe("块1");
    expect(calls.filter((c) => c.op === "sendMarkdown").map((c) => c.args[1])).toEqual([
      "块2",
      "块3",
    ]);
  });

  it("没给块也没给 body：卡保持已推的最新全文（只改 header / footer）", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("已推的内容");
    await vi.advanceTimersByTimeAsync(0);
    await s.finalize([], { outcome: "failed" });
    const card = calls.find((c) => c.op === "putCard")!.args[1] as CardJson;
    expect(answerOf(card)).toBe("已推的内容");
    expect(card.header.template).toBe("red");
  });

  it("终态补未闭合的代码围栏；流式中间帧不补（不破坏打字机前缀）", async () => {
    const { deps, calls } = makeDeps();
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("看这段：\n```ts\nconst a = 1");
    await vi.advanceTimersByTimeAsync(0);
    expect(answerOf(calls[0]!.args[0] as CardJson)).toBe("看这段：\n```ts\nconst a = 1");
    await s.finalize(["看这段：\n```ts\nconst a = 1"]);
    const card = calls.find((c) => c.op === "putCard")!.args[1] as CardJson;
    expect(answerOf(card)).toMatch(/```\s*$/);
    expect((answerOf(card).match(/```/g) ?? []).length).toBe(2);
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
    s.pushProcess("p");
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
    expect(putContents(calls)).toHaveLength(1);
    // 失败后退避：下一次 600ms 后，再下一次 1200ms…（不是 300ms 一发）
    await vi.advanceTimersByTimeAsync(590);
    expect(putContents(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(putContents(calls)).toHaveLength(2);
    fail = false;
    s.push("abc");
    await vi.advanceTimersByTimeAsync(10_000);
    const puts = putContents(calls);
    expect(puts[puts.length - 1]!.args[2]).toBe("abc");
    // 持续失败时重试间隔封顶 5s：不会无限变慢、也不会无限变快
    fail = true;
    s.push("abcd");
    await vi.advanceTimersByTimeAsync(60_000);
    const n = putContents(calls).length;
    expect(n).toBeLessThan(2 + 1 + 1 + 60 / 0.6); // 远少于 300ms 一发的 200 次
    expect(n).toBeGreaterThan(5);
  });

  it("终稿 PUT 失败：重试后成功就算落成（不另发兜底卡）；成功后照常回写过程区 / 关流式", async () => {
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
    s.pushProcess("p");
    const res = await s.finalize(["终稿"]);
    expect(attempts).toBe(3);
    expect(res).toMatchObject({ delivered: true, streamed: true });
    expect(calls.some((c) => c.op === "sendMarkdown")).toBe(false);
    expect(calls.some((c) => c.op === "patchSettings")).toBe(true);
  });

  it("终稿 PUT 重试用尽：全部块另发文本卡兜底（半截卡留着，但群里有完整答案）；不再碰过程区 / 关流式", async () => {
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
    const res = await s.finalize(["块1", "块2"], { body: "整份" });
    expect(calls.filter((c) => c.op === "putCard")).toHaveLength(3);
    // 兜底发的是切好的全部块（不是 body）
    expect(calls.filter((c) => c.op === "sendMarkdown").map((c) => c.args[1])).toEqual([
      "块1",
      "块2",
    ]);
    expect(res).toMatchObject({ delivered: true, streamed: true });
    expect(calls.some((c) => c.op === "patchSettings")).toBe(false);
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

  it("终稿后的过程区回写 / 关流式失败：只记日志，不影响 delivered（正文已经送达）", async () => {
    const { deps, calls } = makeDeps({
      batchUpdate: async () => {
        throw new Error("batch down");
      },
      patchSettings: async (...args) => {
        calls.push({ op: "patchSettings", args });
        throw new Error("patch down");
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps, finalRetryDelaysMs: [0] });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    s.pushProcess("p");
    const res = await s.finalize(["终稿"]);
    expect(res).toMatchObject({ delivered: true, streamed: true });
    expect(calls.some((c) => c.op === "sendMarkdown")).toBe(false);
  });
});

describe("内容超限（飞书卡片 30KB）：逐档收紧后重发", () => {
  it("终稿 too_long：不占重试次数，收紧一档（正文 ≤10000 字、带省略提示）就地重发直到成功；兜底文本卡不发", async () => {
    const big = "字".repeat(30_000);
    const seen: number[] = [];
    const { deps, calls } = makeDeps({
      putCard: async (...args) => {
        calls.push({ op: "putCard", args });
        const len = answerOf(args[1] as CardJson).length;
        seen.push(len);
        if (len > 6_000) throw tooLong(); // 10k 档仍超限，要收到 5k 档才过
      },
    });
    const s = createGroupCardStream({
      chatId: "oc_g",
      deps,
      finalRetryDelaysMs: [], // 零次普通重试：证明收紧不占重试名额
    });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    const res = await s.finalize(["块1"], { body: big });
    expect(res).toMatchObject({ delivered: true, streamed: true });
    expect(seen.length).toBe(3); // 95k→ 首发（≈30000，未收紧）/ 10k 档 / 5k 档
    expect(seen[0]).toBe(30_000);
    expect(seen[1]).toBeLessThanOrEqual(10_000);
    expect(seen[2]).toBeLessThanOrEqual(5_000);
    const last = calls.filter((c) => c.op === "putCard").at(-1)!.args[1] as CardJson;
    expect(answerOf(last)).toContain("内容较长，后半已省略");
    expect(calls.some((c) => c.op === "sendMarkdown")).toBe(false);
  });

  it("三档收到底仍 too_long：回到普通重试（有限次）→ 文本卡兜底，不死循环", async () => {
    const { deps, calls } = makeDeps({
      putCard: async (...args) => {
        calls.push({ op: "putCard", args });
        throw tooLong();
      },
    });
    const s = createGroupCardStream({
      chatId: "oc_g",
      deps,
      finalRetryDelaysMs: [0],
    });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    const res = await s.finalize(["块1"], { body: "字".repeat(30_000) });
    // 首发 + 3 档收紧（10k / 5k / 2.5k）+ 普通重试 1 次，之后兜底
    const puts = calls.filter((c) => c.op === "putCard");
    expect(puts.length).toBeGreaterThanOrEqual(4);
    expect(puts.length).toBeLessThanOrEqual(6);
    expect(calls.filter((c) => c.op === "sendMarkdown").map((c) => c.args[1])).toEqual(["块1"]);
    expect(res).toMatchObject({ delivered: true, streamed: true });
  });

  it("流式中间帧 too_long：往下收一档，后续帧不再撞同一堵墙", async () => {
    const { deps, calls } = makeDeps({
      putContent: async (...args) => {
        calls.push({ op: "putContent", args });
        if (String(args[2]).length > 12_000) throw tooLong();
      },
    });
    const s = createGroupCardStream({ chatId: "oc_g", deps });
    s.push("a");
    await vi.advanceTimersByTimeAsync(0);
    s.push("字".repeat(20_000));
    await vi.advanceTimersByTimeAsync(301); // 第 1 帧：超限失败 → 收紧到 10k 档
    await vi.advanceTimersByTimeAsync(2_000); // 退避后第 2 帧：已是收紧后的内容，成功
    const puts = putContents(calls);
    expect(puts.length).toBe(2);
    expect(String(puts[0]!.args[2]).length).toBeGreaterThan(12_000);
    expect(String(puts[1]!.args[2]).length).toBeLessThanOrEqual(10_000);
  });
});
