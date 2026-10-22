/**
 * 聊天回退（含编辑回退）的失败文案 + 防重入（第二轮 review V7-05 / V7-06）
 *
 * V7-06：前端原先靠正则 `/跑|running|停止|409/` 匹配中文报错文案选提示——三种 409 都说「请先停止当前回复」，
 *   「任务正在停止/删除」时是错的、「已有回退在进行中」又匹配不上。改成按服务端 409 响应里的稳定 `code` 选提示，
 *   保留对老响应（无 code）的兜底。
 * V7-05：确认回退后界面零反馈、且可重入（再点一次得到红色「已有回退在进行中」，其实第一次在成功）。
 *   `runExclusiveRewind` 是单飞锁：飞行中第二次直接拒绝、不调 fn，结束（成败都）释放，状态变化通知 UI。
 */
import { describe, expect, it, vi } from "vitest";

import {
  REWIND_BUSY_NOTICE,
  isRewindFailureCode,
  rewindFailureToast,
  runExclusiveRewind,
} from "@/lib/rewind-failure";

/** 模拟 task-store 的 ApiRequestError（带 status / code）；不 import 它，避免拉起整个 task-store */
const apiError = (message: string, status: number, code?: string) =>
  Object.assign(new Error(message), { status, code });

describe("rewindFailureToast：按稳定 code 选提示，不再匹配中文文案", () => {
  it("run_active：说清「AI 还在回复」+ 让用户先停", () => {
    const text = rewindFailureToast(
      apiError("agent 正在跑、请先停止再回退", 409, "run_active"),
      "rewind",
    );
    expect(text).toContain("AI 还在回复");
    expect(text).toContain("先停止");
  });

  it("task_closing（任务正在停止/删除）：不再说「请先停止当前回复」——它停不了也不用停", () => {
    const text = rewindFailureToast(
      apiError("任务正在停止/删除、无法回退", 409, "task_closing"),
      "rewind",
    );
    expect(text).toContain("停止或删除");
    expect(text).not.toContain("请先停止当前回复");
  });

  it("其余 409 各说各的：排队中 / 正在发排队 / 正在起会话 / 已有回退在进行", () => {
    const cases: Array<[string, string]> = [
      ["queue_pending", "排队中的消息"],
      ["queue_draining", "正在发送排队消息"],
      ["session_starting", "正在启动新会话"],
      ["rewind_in_progress", "已有一次回退在进行中"],
    ];
    const seen = new Set<string>();
    for (const [code, needle] of cases) {
      const text = rewindFailureToast(apiError("x", 409, code), "rewind");
      expect(text, code).toContain(needle);
      seen.add(text);
    }
    // 六种 409 的提示两两不同——不会再「一个文案说所有」
    seen.add(rewindFailureToast(apiError("x", 409, "run_active"), "rewind"));
    seen.add(rewindFailureToast(apiError("x", 409, "task_closing"), "rewind"));
    expect(seen.size).toBe(6);
  });

  it("kind 只决定前缀：回退 →「回退失败：」，编辑 →「编辑失败：」，原因句相同", () => {
    const rewind = rewindFailureToast(apiError("x", 409, "queue_draining"), "rewind");
    const edit = rewindFailureToast(apiError("x", 409, "queue_draining"), "edit");
    expect(rewind.startsWith("回退失败：")).toBe(true);
    expect(edit.startsWith("编辑失败：")).toBe(true);
    expect(rewind.slice("回退失败：".length)).toBe(edit.slice("编辑失败：".length));
  });

  it("不认识的 code / 非 409 的已知 code：带上服务端原文，不乱猜", () => {
    expect(
      rewindFailureToast(apiError("找不到 eventId=e1 的检查点", 404, "no_checkpoint"), "rewind"),
    ).toBe("回退失败：找不到 eventId=e1 的检查点");
    expect(
      rewindFailureToast(apiError("some future thing", 409, "brand_new_code"), "rewind"),
    ).toBe("回退失败：some future thing");
    expect(
      rewindFailureToast(apiError("仅 chat 模式支持 rewind", 409, "not_chat"), "edit"),
    ).toBe("编辑失败：仅 chat 模式支持 rewind");
  });

  it("老响应（没有 code）的兜底：回退沿用旧规则——像「在跑 / 停止」的原文提示先停，其余带原文", () => {
    expect(rewindFailureToast(apiError("agent 正在跑、请先停止再回退", 409), "rewind")).toBe(
      "请先停止当前回复再回退",
    );
    expect(rewindFailureToast(new Error("HTTP 409"), "rewind")).toBe("请先停止当前回复再回退");
    expect(rewindFailureToast(new Error("磁盘满了"), "rewind")).toBe("回退失败：磁盘满了");
    // 编辑旧行为本来就是原文直出，没有正则
    expect(rewindFailureToast(apiError("agent 正在跑、请先停止再回退", 409), "edit")).toBe(
      "编辑失败：agent 正在跑、请先停止再回退",
    );
  });

  it("有 code 时不再看文案：文案里带「跑 / 停止」也不会误判成 run_active", () => {
    const text = rewindFailureToast(
      apiError("任务正在停止/删除、无法回退", 409, "task_closing"),
      "rewind",
    );
    expect(text).not.toContain("AI 还在回复");
  });

  it("非 Error 抛出物也不炸", () => {
    expect(rewindFailureToast("boom", "rewind")).toBe("回退失败：boom");
  });

  it("isRewindFailureCode：只认服务端会发的那一组", () => {
    for (const c of [
      "not_found",
      "not_chat",
      "no_checkpoint",
      "bad_target",
      "restore_failed",
      "run_active",
      "queue_pending",
      "queue_draining",
      "session_starting",
      "task_closing",
      "rewind_in_progress",
    ]) {
      expect(isRewindFailureCode(c), c).toBe(true);
    }
    expect(isRewindFailureCode("payload_mismatch")).toBe(false);
    expect(isRewindFailureCode(undefined)).toBe(false);
    expect(isRewindFailureCode(409)).toBe(false);
  });
});

describe("runExclusiveRewind：回退单飞锁（V7-05 可重入）", () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("飞行中再来一次：直接拒绝、不调 fn（不会发第二个 POST 换来「已有回退在进行中」）", async () => {
    const lock = { current: null as string | null };
    const onChange = vi.fn();
    const first = deferred<string>();
    const fn1 = vi.fn(() => first.promise);
    const fn2 = vi.fn(async () => "second");

    const p1 = runExclusiveRewind(lock, "ev_1", onChange, fn1);
    expect(lock.current).toBe("ev_1");
    const r2 = await runExclusiveRewind(lock, "ev_2", onChange, fn2);
    expect(r2).toEqual({ ran: false });
    expect(fn2).not.toHaveBeenCalled();
    // 被拒绝的那次不能把别人的锁 / 状态动掉
    expect(lock.current).toBe("ev_1");

    first.resolve("done");
    expect(await p1).toEqual({ ran: true, value: "done" });
    expect(lock.current).toBeNull();
  });

  it("状态通知：开始通知 eventId、结束通知 null；被拒绝的不通知", async () => {
    const lock = { current: null as string | null };
    const onChange = vi.fn();
    await runExclusiveRewind(lock, "ev_1", onChange, async () => 1);
    expect(onChange.mock.calls).toEqual([["ev_1"], [null]]);

    const hold = deferred<void>();
    const p = runExclusiveRewind(lock, "ev_2", onChange, () => hold.promise);
    onChange.mockClear();
    await runExclusiveRewind(lock, "ev_3", onChange, async () => 1);
    expect(onChange).not.toHaveBeenCalled();
    hold.resolve();
    await p;
  });

  it("fn 抛错：锁照样释放、状态回到 null、错误原样抛给调用方（之后能再回退）", async () => {
    const lock = { current: null as string | null };
    const onChange = vi.fn();
    await expect(
      runExclusiveRewind(lock, "ev_1", onChange, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.current).toBeNull();
    expect(onChange.mock.calls.at(-1)).toEqual([null]);
    expect(await runExclusiveRewind(lock, "ev_2", onChange, async () => "ok")).toEqual({
      ran: true,
      value: "ok",
    });
  });

  it("同步抛错的 fn 同样释放", async () => {
    const lock = { current: null as string | null };
    await expect(
      runExclusiveRewind(lock, "ev_1", () => {}, () => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    expect(lock.current).toBeNull();
  });

  it("「正在回退」提示文案固定（调用方在被拒绝时 toast 它）", () => {
    expect(REWIND_BUSY_NOTICE).toBe("正在回退，请稍候");
  });
});
