/**
 * `@` 文件候选请求带超时（第三轮 review R6-07）
 *
 * 旧写法 fetch 没有任何超时：服务端扫仓慢 / 挂起时，菜单停在 loading、`stale` 一直为真，
 * `onKeyDown` 对 Enter / Tab 的拦截（防半截 `@But` 被当正文提交）就永远不放——
 * 用户在这个输入框里按 Enter 发不出消息，直到手动 Esc。
 *
 * 修法：请求 + 读 body 整体受 `AT_FETCH_TIMEOUT_MS` 约束，超时按「这个 query 没有候选」收口
 * （结果所属 query 照记 → 菜单落「无匹配」、Enter 不再被吞）；调用方主动 abort（query 变了 / 卸载）
 * 仍是静默的 `aborted`，不能把新 query 的结果冲掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AT_FETCH_TIMEOUT_MS, fetchAtFiles } from "@/lib/at-mention-fetch";
import { atMenuView } from "@/lib/at-mention-pick";

const jsonResponse = (body: unknown, ok = true): Response =>
  ({ ok, json: async () => body }) as unknown as Response;

/** 永不 resolve 的 fetch（不理 signal——模拟最坏情况：abort 也不会让它 reject） */
const hangingFetch = (): typeof fetch => (() => new Promise<Response>(() => {})) as typeof fetch;

describe("fetchAtFiles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("正常：返回候选，并把 taskId / q 编进 URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ files: [{ path: "src/a.ts", isDir: false }] }),
    ) as unknown as typeof fetch;
    const out = await fetchAtFiles({
      taskId: "t_1",
      q: "a b",
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(out).toEqual({ kind: "ok", files: [{ path: "src/a.ts", isDir: false }] });
    const url = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toBe("/api/repo-files?taskId=t_1&q=a+b");
  });

  it("files 缺失 / 不是数组：当作空列表（不抛）", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "boom" })) as typeof fetch;
    const out = await fetchAtFiles({
      taskId: "t",
      q: "",
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(out).toEqual({ kind: "ok", files: [] });
  });

  it("HTTP 非 2xx：failed（不去解析错误体当候选）", async () => {
    const fetchImpl = (async () => jsonResponse({ files: [{ path: "x", isDir: false }] }, false)) as typeof fetch;
    const out = await fetchAtFiles({
      taskId: "t",
      q: "x",
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(out).toEqual({ kind: "failed" });
  });

  it("网络错误：failed", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    const out = await fetchAtFiles({
      taskId: "t",
      q: "x",
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(out).toEqual({ kind: "failed" });
  });

  it("挂起的请求：到点超时收口为 failed（修前永远 pending，Enter 一直被菜单吞）", async () => {
    const p = fetchAtFiles({
      taskId: "t",
      q: "x",
      signal: new AbortController().signal,
      fetchImpl: hangingFetch(),
    });
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(AT_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ kind: "failed" });
  });

  it("响应头到了、body 一直读不完：同样受超时约束", async () => {
    const fetchImpl = (async () =>
      ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response) as typeof fetch;
    const p = fetchAtFiles({
      taskId: "t",
      q: "x",
      signal: new AbortController().signal,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(AT_FETCH_TIMEOUT_MS + 1);
    expect(await p).toEqual({ kind: "failed" });
  });

  it("超时会 abort 底层请求（不让慢请求在后台白占连接）", async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const p = fetchAtFiles({
      taskId: "t",
      q: "x",
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(AT_FETCH_TIMEOUT_MS + 1);
    await p;
    expect(seen?.aborted).toBe(true);
  });

  it("调用方主动 abort（query 变了 / 卸载）：静默 aborted，不是 failed", async () => {
    const ctl = new AbortController();
    const p = fetchAtFiles({ taskId: "t", q: "x", signal: ctl.signal, fetchImpl: hangingFetch() });
    ctl.abort();
    expect(await p).toEqual({ kind: "aborted" });
  });

  it("调用方 abort 之后才返回的响应：丢弃（不能覆盖新 query 的结果）", async () => {
    const ctl = new AbortController();
    const fetchImpl = (async () => {
      ctl.abort();
      return jsonResponse({ files: [{ path: "old.ts", isDir: false }] });
    }) as typeof fetch;
    const out = await fetchAtFiles({ taskId: "t", q: "x", signal: ctl.signal, fetchImpl });
    expect(out).toEqual({ kind: "aborted" });
  });

  it("已经 aborted 的 signal：不发请求", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const out = await fetchAtFiles({ taskId: "t", q: "x", signal: ctl.signal, fetchImpl });
    expect(out).toEqual({ kind: "aborted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("超时后的菜单态：结果所属 query 照记 → 落「无匹配」、不再 stale（Enter 不再被吞）", () => {
    // 与 at-mention.tsx 的收口一致：failed → setResults({ query: q, files: [] })
    const stuck = atMenuView("But", null);
    expect(stuck.stale).toBe(true); // 修前一直是这个状态
    const afterTimeout = atMenuView("But", { query: "But", files: [] });
    expect(afterTimeout.mode).toBe("empty");
    expect(afterTimeout.stale).toBe(false);
  });
});
