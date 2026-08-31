/**
 * 事件流「不渲染」单一闸
 *
 * 协议内部步骤、消音审计、卡片已经说过的话，都从 isHiddenFromEventStream 过。
 * 组件里不许再各自 filter 一份。
 */
import { describe, expect, it } from "vitest";

import { ASK_EXPIRED_META_KEY, ASK_SKIPPED_META_KEY } from "@/lib/ask-pending";
import {
  isAskWaitStreamEvent,
  isHiddenFromEventStream,
} from "@/lib/event-stream-hidden";
import type { TaskEvent } from "@/lib/types";

let seq = 0;
const ev = (
  kind: TaskEvent["kind"],
  extra?: Partial<TaskEvent>,
): TaskEvent => ({
  id: `e${seq++}`,
  ts: seq,
  kind,
  text: extra?.text ?? "",
  meta: extra?.meta,
  ...extra,
});

const waitCurl =
  'curl -NsS --no-buffer "http://127.0.0.1:8776/api/tasks/t1/ask-wait?token=abc"';

describe("isAskWaitStreamEvent", () => {
  it("认 shell args 里的 ask-wait curl", () => {
    expect(
      isAskWaitStreamEvent(
        ev("tool_call", { meta: { args: { command: waitCurl } } }),
      ),
    ).toBe(true);
  });

  it("认 tool_result 正文里的 ask-wait URL", () => {
    expect(
      isAskWaitStreamEvent(ev("tool_result", { text: waitCurl })),
    ).toBe(true);
  });

  it("不认旧 wait-ack、不认普通 curl", () => {
    expect(
      isAskWaitStreamEvent(
        ev("tool_call", {
          meta: {
            args: {
              command: "curl http://127.0.0.1:8776/api/tasks/t1/wait-ack?token=x",
            },
          },
        }),
      ),
    ).toBe(false);
    expect(
      isAskWaitStreamEvent(
        ev("tool_call", {
          meta: { args: { command: "curl https://example.com" } },
        }),
      ),
    ).toBe(false);
    expect(isAskWaitStreamEvent(ev("assistant_message", { text: waitCurl }))).toBe(
      false,
    );
  });
});

describe("isHiddenFromEventStream", () => {
  it("藏 muted / 跳过标记 / 过期标记 / ask-wait / 回合内工具 error", () => {
    expect(
      isHiddenFromEventStream(ev("thinking", { meta: { muted: true } })),
    ).toBe(true);
    expect(
      isHiddenFromEventStream(
        ev("info", { meta: { supersededAskId: "ask_1", [ASK_SKIPPED_META_KEY]: true } }),
      ),
    ).toBe(true);
    expect(
      isHiddenFromEventStream(
        ev("info", { meta: { supersededAskId: "ask_1", [ASK_EXPIRED_META_KEY]: true } }),
      ),
    ).toBe(true);
    expect(
      isHiddenFromEventStream(
        ev("tool_call", { meta: { args: { command: waitCurl } } }),
      ),
    ).toBe(true);
    expect(
      isHiddenFromEventStream(ev("error", { meta: { callId: "call_1" } })),
    ).toBe(true);
  });

  it("历史未打 muted 的 ask-wait curl 刷新后也不进事件流", () => {
    expect(
      isHiddenFromEventStream(
        ev("tool_call", {
          text: `调用 Shell:${waitCurl}`,
          meta: { name: "Shell", args: waitCurl },
        }),
      ),
    ).toBe(true);
  });

  it("chat 才藏启动噪声和 boot 进度；task 形态仍看得见", () => {
    const startup = ev("info", { text: "Chat 任务启动 (model: gpt)" });
    const boot = ev("info", { meta: { bootStage: true } });
    const reconnect = ev("info", {
      text: "Chat 任务启动中",
      meta: { kind: "reconnecting" },
    });
    expect(isHiddenFromEventStream(startup, { isChat: true })).toBe(true);
    expect(isHiddenFromEventStream(boot, { isChat: true })).toBe(true);
    expect(isHiddenFromEventStream(startup)).toBe(false);
    expect(isHiddenFromEventStream(boot)).toBe(false);
    expect(isHiddenFromEventStream(reconnect, { isChat: true })).toBe(false);
    expect(
      isHiddenFromEventStream(
        ev("info", {
          text: "正在压缩上下文…",
          meta: { kind: "compaction", status: "running" },
        }),
        { isChat: true },
      ),
    ).toBe(false);
  });

  it("答题卡 / 普通工作过程不藏", () => {
    expect(
      isHiddenFromEventStream(
        ev("ask_user_request", { meta: { askId: "ask_1", questions: [] } }),
      ),
    ).toBe(false);
    expect(
      isHiddenFromEventStream(
        ev("tool_call", { meta: { args: { command: "ls src" } } }),
      ),
    ).toBe(false);
    expect(isHiddenFromEventStream(ev("error", { text: "整轮崩了" }))).toBe(
      false,
    );
  });
});
