/**
 * `@` 候选超时 / 失败与「无匹配」不同文案（第四轮 Q6-09）
 *
 * 旧：请求 5s 没出结果（或失败）→ 落「无匹配文件」，用户以为仓里真没有、只能乱改字；
 * 新：失败 / 超时落同样的空结果（Enter 不再被吞），但带 failed 标记，空态写「候选加载超时，改个字再试」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AT_FETCH_TIMEOUT_MS, fetchAtFiles } from "@/lib/at-mention-fetch";
import {
  AT_EMPTY_HINT,
  AT_FAILED_HINT,
  atEmptyHint,
  atMenuView,
  atResultsFromOutcome,
} from "@/lib/at-mention-pick";

const jsonResponse = (body: unknown, ok = true): Response =>
  ({ ok, json: async () => body }) as unknown as Response;

describe("Q6-09：失败 / 超时与无匹配文案区分", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("真实超时 → failed 结果 → 菜单空态 + 「候选加载超时」文案（Enter 仍不被吞）", async () => {
    const hanging = (() => new Promise<Response>(() => {})) as typeof fetch;
    const p = fetchAtFiles({
      taskId: "t",
      q: "But",
      signal: new AbortController().signal,
      fetchImpl: hanging,
    });
    await vi.advanceTimersByTimeAsync(AT_FETCH_TIMEOUT_MS + 1);
    const out = await p;
    expect(out.kind).toBe("failed");

    const results = atResultsFromOutcome("But", out as never);
    expect(results).toEqual({ query: "But", files: [], failed: true });
    const view = atMenuView("But", results);
    expect(view.mode).toBe("empty");
    expect(view.stale).toBe(false); // 不再拦 Enter
    expect(atEmptyHint(results!.failed)).toBe("候选加载超时，改个字再试");
  });

  it("HTTP 非 2xx 同样是失败文案", async () => {
    const fetchImpl = (async () => jsonResponse({ files: [] }, false)) as typeof fetch;
    const out = await fetchAtFiles({
      taskId: "t",
      q: "x",
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(atResultsFromOutcome("x", out as never)?.failed).toBe(true);
  });

  it("旧树能用：成功但没有匹配 → 仍写「无匹配文件」", async () => {
    const fetchImpl = (async () => jsonResponse({ files: [] })) as typeof fetch;
    const out = await fetchAtFiles({
      taskId: "t",
      q: "zzz",
      signal: new AbortController().signal,
      fetchImpl,
    });
    const results = atResultsFromOutcome("zzz", out as never);
    expect(results).toEqual({ query: "zzz", files: [], failed: false });
    expect(atEmptyHint(results!.failed)).toBe(AT_EMPTY_HINT);
    expect(AT_EMPTY_HINT).toBe("无匹配文件");
  });

  it("旧树能用：有候选照常；aborted 静默不产生结果", () => {
    const hit = { path: "src/a.ts", isDir: false };
    expect(atResultsFromOutcome("a", { kind: "ok", files: [hit] })).toEqual({
      query: "a",
      files: [hit],
      failed: false,
    });
    expect(atResultsFromOutcome("a", { kind: "aborted" })).toBeNull();
  });

  it("两条文案必须不同（回归保护）", () => {
    expect(AT_FAILED_HINT).not.toBe(AT_EMPTY_HINT);
  });
});
