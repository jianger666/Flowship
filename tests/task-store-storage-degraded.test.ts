/**
 * 客户端分发：SSE storage_degraded 帧 → onStorageDegraded（R14 B2-2 / Q9-01 = Q15-02）
 * src/lib/task-store.ts 的 watchTaskStream
 *
 * 服务端在事件写盘失败 / 恢复时推 `{ type: "storage_degraded", degraded, code? }`，每次连接的 bootstrap 还会无条件补发一帧当前值；
 * 界面据此在事件流顶部显示 / 收起红条。帧来自网络、按「不可信输入」处理：
 *   - degraded 必须是布尔，否则整帧丢弃、不回调——宁可不动本地状态，也别拿脏数据把红条抹掉或凭空点亮；
 *   - degraded:true → `{ code }`，code 是字符串就原样透传（文案分档在界面层的 describeStorageDegraded，
 *     这里不做白名单：服务端以后多一个码，客户端不能把它吞成空）；缺失或不是字符串 → 空串（界面按「其它」档文案）；
 *   - degraded:false → 严格的 null（「没降级」），哪怕帧里多带了 code。
 *
 * 用真实的 watchTaskStream + stub 掉的 fetch，跟 thinking-snapshot-dispatch.test.ts / restricted-run-signal.test.ts 同一套做法。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StorageDegradedState } from "@/lib/storage-degraded";
import { watchTaskStream, type TaskStreamCallbacks } from "@/lib/task-store";

/** 拼一段 SSE 响应体（帧格式与 watch-task route 一致：`data: <json>\n\n`） */
const sseResponse = (payloads: unknown[]): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};

/** 每条流都以 bootstrap 的 task 帧开头（与真实连接一致：先 task、再各路补发帧） */
const TASK_FRAME = { type: "task", task: { id: "t1", events: [] } };

const stubFetch = (payloads: unknown[]) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse([TASK_FRAME, ...payloads])),
  );

/** 喂入若干帧，收集 onStorageDegraded 收到的全部参数（按到达顺序） */
const statesOf = async (payloads: unknown[]): Promise<Array<StorageDegradedState | null>> => {
  stubFetch(payloads);
  const got: Array<StorageDegradedState | null> = [];
  await watchTaskStream("t1", { onStorageDegraded: (s) => got.push(s) });
  return got;
};

const degraded = (code?: unknown) => ({
  type: "storage_degraded",
  degraded: true,
  ...(code === undefined ? {} : { code }),
});
const recovered = { type: "storage_degraded", degraded: false };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SSE storage_degraded（degraded:true）→ onStorageDegraded({ code })", () => {
  it("降级帧带 code:\"ENOSPC\" → 回调 { code: \"ENOSPC\" }", async () => {
    expect(await statesOf([degraded("ENOSPC")])).toEqual([{ code: "ENOSPC" }]);
  });

  it.each(["EDQUOT", "EROFS", "EIO", "EACCES", "EBUSY", "EWEIRD"])(
    "code=%s：是字符串就原样透传（不做白名单 / 改写，文案分档在界面层）",
    async (code) => {
      expect(await statesOf([degraded(code)])).toEqual([{ code }]);
    },
  );

  it("降级帧没带 code（旧服务端 / 码未知）→ { code: \"\" }，界面按「其它」档文案", async () => {
    const got = await statesOf([degraded()]);
    expect(got).toEqual([{ code: "" }]);
    // 不能是 { code: undefined }：toEqual 把 undefined 属性当缺失，这里单独钉死「确实是空串」
    expect(got[0]?.code).toBe("");
  });

  it.each([
    { label: "数字", code: 28 },
    { label: "null", code: null },
    { label: "对象", code: { errno: 28 } },
    { label: "数组", code: ["ENOSPC"] },
    { label: "布尔", code: true },
  ])("code 不是字符串（$label）→ 回退成空串，不把脏值交给界面", async ({ code }) => {
    const got = await statesOf([degraded(code)]);
    expect(got).toEqual([{ code: "" }]);
    expect(got[0]?.code).toBe("");
  });

  it("code 本身就是空串 → { code: \"\" }（仍是「降级中」，不是 null）", async () => {
    expect(await statesOf([degraded("")])).toEqual([{ code: "" }]);
  });
});

describe("SSE storage_degraded（degraded:false）→ onStorageDegraded(null)", () => {
  it("恢复帧 → 严格的 null（不是 undefined，也不是 { code: \"\" }）", async () => {
    const got = await statesOf([recovered]);
    expect(got).toHaveLength(1);
    expect(got[0]).toBeNull();
  });

  it("恢复帧即使多带了 code 也只回调 null（code 只对降级帧有意义）", async () => {
    const got = await statesOf([{ type: "storage_degraded", degraded: false, code: "ENOSPC" }]);
    expect(got).toHaveLength(1);
    expect(got[0]).toBeNull();
  });
});

describe("无效帧一律丢弃（degraded 不是布尔）", () => {
  const withDegraded = (value: unknown) => ({ type: "storage_degraded", degraded: value, code: "ENOSPC" });

  it.each([
    { label: "缺 degraded 字段", frame: { type: "storage_degraded", code: "ENOSPC" } },
    { label: '字符串 "true"', frame: withDegraded("true") },
    { label: '字符串 "false"', frame: withDegraded("false") },
    { label: "数字 1", frame: withDegraded(1) },
    { label: "数字 0", frame: withDegraded(0) },
    { label: "null", frame: withDegraded(null) },
    { label: "空串", frame: withDegraded("") },
    { label: "空对象", frame: withDegraded({}) },
    { label: "数组", frame: withDegraded([]) },
  ])("degraded 为 $label → 整帧丢弃、不回调（别拿脏数据点亮 / 抹掉红条）", async ({ frame }) => {
    // truthy 的非布尔会误点亮红条、falsy 的非布尔会误抹掉红条——两个方向都要钉
    expect(await statesOf([frame])).toEqual([]);
  });

  it("无效帧夹在合法帧之间：只丢无效的，前后的合法帧照常到、顺序不变", async () => {
    const got = await statesOf([degraded("ENOSPC"), withDegraded("true"), withDegraded(null), recovered]);
    expect(got).toEqual([{ code: "ENOSPC" }, null]);
  });

});

describe("帧序与隔离", () => {
  it("降级 → 码变化 → 恢复 → 再降级：逐帧回调、顺序与到达顺序一致", async () => {
    const got = await statesOf([degraded("ENOSPC"), degraded("EROFS"), recovered, degraded("EIO")]);
    expect(got).toEqual([{ code: "ENOSPC" }, { code: "EROFS" }, null, { code: "EIO" }]);
  });

  it("bootstrap 的 task 帧先到、降级帧随后：回调按帧到达顺序触发", async () => {
    stubFetch([degraded("ENOSPC"), recovered]);
    const order: string[] = [];
    await watchTaskStream("t1", {
      onTaskUpdate: () => order.push("task"),
      onStorageDegraded: (s) => order.push(s ? `degraded:${s.code}` : "recovered"),
    });
    expect(order).toEqual(["task", "degraded:ENOSPC", "recovered"]);
  });

  it("没注册 onStorageDegraded 的调用方（别的页面也用 watchTaskStream）收到该帧不抛", async () => {
    stubFetch([degraded("ENOSPC"), recovered]);
    await expect(watchTaskStream("t1", {})).resolves.toEqual({ established: true });
  });

  it("该帧只触发 onStorageDegraded：不串到 onError / onTaskDeleted / onBackgroundSubagents 等别的分支", async () => {
    stubFetch([degraded("ENOSPC"), recovered]);
    // Proxy 让「任意回调名」都存在并记名：不用手工枚举 TaskStreamCallbacks 的几十个成员，以后新增回调也自动被覆盖
    const calls: string[] = [];
    const spy = new Proxy<TaskStreamCallbacks>(
      {},
      {
        get: (_target, prop) => () => {
          calls.push(String(prop));
        },
      },
    );
    await watchTaskStream("t1", spy);
    // task 帧触发 建连 + 任务快照；两条 storage_degraded 帧各触发一次 onStorageDegraded，此外什么都没有
    expect(calls).toEqual([
      "onConnectionEstablished",
      "onTaskUpdate",
      "onStorageDegraded",
      "onStorageDegraded",
    ]);
  });
});
