/**
 * 旁路（需求群受限答疑）run 的「在飞」信号——事件流工具块该不该继续转圈
 *
 * 背景（第四轮双审 P1-2）：旁路答疑与 task 运行状态机解耦、**不写 runStatus**，
 * 而任务详情页的 `isRunning` 只看 `task.runStatus === "running"` →
 * 旁路 agent 跑着的长 shell / 子代理写进事件流后被判成脏数据、渲染成灰色「已中断」。
 *
 * 修法不是把旁路接回 runStatus（那是上一轮刚拆掉的耦合），而是单独一条 UI 信号：
 * 登记表变化即 publish `restricted_run` 帧、watch bootstrap 补发当前值、
 * 页面把它并进「运行中」判定。三段各自钉在下面。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  hasRestrictedQuestionInFlight,
  registerRestrictedQuestion,
  subscribeTaskStream,
  unregisterRestrictedQuestion,
  type TaskStreamEvent,
} from "@/lib/server/task-stream";
import { watchTaskStream } from "@/lib/task-store";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const readSrc = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");

describe("服务端信号源：登记表变化即发帧", () => {
  const unsubs: Array<() => void> = [];

  afterEach(() => {
    while (unsubs.length > 0) unsubs.pop()?.();
  });

  it("起跑发 active=true、退出发 active=false", () => {
    const id = `rq-signal-${Date.now()}`;
    const seen: boolean[] = [];
    unsubs.push(
      subscribeTaskStream(id, (ev: TaskStreamEvent) => {
        if (ev.kind === "restricted_run") seen.push(ev.active);
      }),
    );

    const run = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(id, run);
    expect(seen).toEqual([true]);
    unregisterRestrictedQuestion(id, run);
    expect(seen).toEqual([true, false]);
    expect(hasRestrictedQuestionInFlight(id)).toBe(false);
  });

  it("两条并发时先退出的那条不许把信号打成 false（按表算、不按「我退出了」算）", () => {
    const id = `rq-signal-multi-${Date.now()}`;
    const seen: boolean[] = [];
    unsubs.push(
      subscribeTaskStream(id, (ev: TaskStreamEvent) => {
        if (ev.kind === "restricted_run") seen.push(ev.active);
      }),
    );

    const a = { cancelled: false, cancel: () => {} };
    const b = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(id, a);
    registerRestrictedQuestion(id, b);
    unregisterRestrictedQuestion(id, a);
    expect(seen).toEqual([true, true, true]);
    unregisterRestrictedQuestion(id, b);
    expect(seen.at(-1)).toBe(false);
  });
});

describe("客户端分发：SSE restricted_run → onRestrictedRun", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 拼一段 SSE 响应体（帧格式与 watch-task route 一致） */
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

  it("bootstrap 补发的 active=true 与收口的 false 都转发给调用方", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "task", task: { id: "t1", events: [] } },
          { type: "restricted_run", active: true },
          { type: "restricted_run", active: false },
        ]),
      ),
    );

    const active: boolean[] = [];
    await watchTaskStream("t1", {
      onRestrictedRun: (v) => active.push(v),
    });

    expect(active).toEqual([true, false]);
  });

  it("非法帧（缺 active）不回调——别把 undefined 当成「不在跑」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([{ type: "restricted_run" }])),
    );

    const onRestrictedRun = vi.fn();
    await watchTaskStream("t1", { onRestrictedRun });

    expect(onRestrictedRun).not.toHaveBeenCalled();
  });
});

// UI 组件在 node 环境跑不起来（见 vitest.config.ts），页面与路由这两段靠源码契约守——
// 与 tests/event-stream-run-active.test.ts 同款手法
describe("接线契约", () => {
  it("任务详情页把旁路信号并进 EventStream 的 isRunning", () => {
    const source = readSrc("app", "tasks", "[id]", "page.tsx");
    // 订阅了信号
    expect(source).toContain("onRestrictedRun");
    // 且真用在运行态判定上（只订阅不用 = P1-2 原样复发）
    const tagStart = source.indexOf("<EventStream");
    expect(tagStart).toBeGreaterThan(0);
    const tag = source.slice(tagStart, source.indexOf("/>", tagStart));
    expect(tag).toContain("isRunning");
    expect(tag).toContain("restrictedRunActive");
  });

  it("watch-task 路由既转发 restricted_run 帧、也在 bootstrap 无条件补当前值", () => {
    const source = readSrc(
      "app",
      "api",
      "tasks",
      "[id]",
      "watch-task",
      "route.ts",
    );
    expect(source).toContain('case "restricted_run"');
    // 中途打开页面 / 断线重连收不到 register / unregister 那两帧——必须补一帧当前值。
    // 且不能写成「只有在飞才补」：断线期间答完的话，客户端会一直挂着旧的 true
    expect(source).toContain(
      "active: hasRestrictedQuestionInFlight(id),",
    );
  });
});
