/**
 * 第 20 轮评审探针（建议收进 tests/）：真渲染 EventRow 的群用户消息。
 * 非属主并入同会话的一轮：显示「非宿主」、不给原样重发 / 编辑；属主群消息保持原样（正控）。
 * 另钉「↑ 历史不收非属主的话」——现有测试里没有任何一条会在 composer-history 这行被改掉时变红（突变存活）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EventRow } from "@/components/tasks/event-stream/rows";
import { DialogProvider } from "@/hooks/use-dialog";
import { buildInputHistory, buildTaskInputHistory } from "@/lib/composer-history";
import type { Task, TaskEvent } from "@/lib/types";

const task = {
  id: "t1", title: "x", mode: "task", actions: [], events: [], repoPaths: [],
  feishuStoryUrl: "https://project.feishu.cn/x/story/detail/1",
} as unknown as Task;
const userEv = (meta: Record<string, unknown>, text = "[群消息·来自 小明（非任务所有者）]\n登录接口返回啥？"): TaskEvent =>
  ({ id: "e1", ts: 1, kind: "user_reply", text, meta: { source: "feishu_group", groupSender: "小明", ...meta } }) as unknown as TaskEvent;
const render = (ev: TaskEvent, variant: "chat" | "log") =>
  renderToStaticMarkup(
    createElement(
      DialogProvider,
      null,
      createElement(EventRow, {
        ev, taskId: task.id, task, variant,
        onResend: vi.fn(async () => true),
        onEditInPlace: variant === "chat" ? vi.fn(async () => true) : undefined,
      } as never),
    ),
  );

describe("群用户消息行（真渲染）", () => {
  for (const variant of ["chat", "log"] as const) {
    it(`[${variant}] 属主群消息（正控）：有重发 / 编辑 / 飞书群标签，无「非宿主」`, () => {
      const html = render(userEv({}, "[群消息·来自 老陈]\n帮我改一下"), variant);
      expect(html).toContain("飞书群");
      expect(html).not.toContain("非宿主");
      expect(html).toMatch(/原样重发|编辑/);
    });
    it(`[${variant}] 非属主并入同会话：显示「非宿主」，无重发 / 编辑`, () => {
      const html = render(userEv({ groupNonOwnerTurn: true }), variant);
      expect(html).toContain("非宿主");
      expect(html).toContain("飞书群");
      expect(html).not.toMatch(/原样重发|编辑（|编辑后重发/);
    });
  }
  it("↑ 历史：非属主一轮的话不进，属主群消息进（正控）", () => {
    const owner = { ...userEv({}, "owner 的话"), id: "o", ts: 1 } as TaskEvent;
    const stranger = { ...userEv({ groupNonOwnerTurn: true }, "陌生人的话"), id: "s", ts: 2 } as TaskEvent;
    expect(buildInputHistory([owner, stranger])).toEqual(["owner 的话"]);
    expect(buildTaskInputHistory([owner, stranger], [])).toEqual(["owner 的话"]);
  });
});
