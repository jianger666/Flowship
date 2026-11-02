/**
 * 保存请求接入 AbortSignal 的行为测试（mock fetch，不起服务）
 *
 * 覆盖：
 * - updateTaskFields / createCustomActionReq / updateCustomActionReq 把调用方传的 signal 原样交给 fetch；
 * - 配 withTimeout 工厂形态：超时即 abort 底层 fetch，调用方拿到的是「超时文案」而不是 AbortError 的原始文案；
 * - 不传 signal 时行为不变（fetch 的 init 里没有 signal）；
 * - 服务端已在处理的请求被 abort 只断本端连接——文案里「服务端可能已保存成功」必须保留（契约断言）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCustomActionReq,
  updateCustomActionReq,
} from "@/lib/custom-action-client";
import { updateTaskFields } from "@/lib/task-store";
import { withTimeout } from "@/lib/with-timeout";

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** 永不返回、只在 signal abort 时以 AbortError reject 的 fetch（模拟「服务端挂住」） */
const installHangingFetch = (): FetchCall[] => {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: RequestInit = {}) =>
      new Promise<Response>((_, reject) => {
        calls.push({ url, init });
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      }),
  );
  return calls;
};

/** 立即成功返回 JSON 的 fetch */
const installOkFetch = (body: unknown): FetchCall[] => {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TIMEOUT_MSG = "请求超时（测试）；服务端可能已保存成功，请以任务页为准";

describe("updateTaskFields：signal 透传", () => {
  it("传 signal：原样交给 fetch；不传：init 里没有 signal", async () => {
    const calls = installOkFetch({ task: { id: "t1" } });
    const ac = new AbortController();
    await updateTaskFields("t1", { title: "x" }, { signal: ac.signal });
    expect(calls[0].url).toBe("/api/tasks/t1");
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].init.signal).toBe(ac.signal);

    await updateTaskFields("t1", { title: "y" });
    expect(calls[1].init.signal).toBeUndefined();
  });

  it("配 withTimeout 工厂：服务端挂住 → 超时 abort 底层 fetch，调用方拿到超时文案（不是 AbortError）", async () => {
    const calls = installHangingFetch();
    const p = withTimeout(
      (signal) => updateTaskFields("t1", { title: "x" }, { signal }),
      1000,
      TIMEOUT_MSG,
    );
    const assertion = expect(p).rejects.toThrow(TIMEOUT_MSG);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(calls).toHaveLength(1);
    expect(calls[0].init.signal?.aborted).toBe(true);
  });
});

describe("createCustomActionReq / updateCustomActionReq：signal 透传", () => {
  const input = { name: "a" } as never;

  it("create：signal 原样交给 fetch；不传则没有", async () => {
    const calls = installOkFetch({ action: { id: "a1" } });
    const ac = new AbortController();
    await createCustomActionReq(input, { signal: ac.signal });
    expect(calls[0].url).toBe("/api/custom-actions");
    expect(calls[0].init.signal).toBe(ac.signal);
    await createCustomActionReq(input);
    expect(calls[1].init.signal).toBeUndefined();
  });

  it("update：signal 原样交给 fetch（id 仍 encode）；不传则没有", async () => {
    const calls = installOkFetch({ action: { id: "team:a1" } });
    const ac = new AbortController();
    await updateCustomActionReq("team:a1", { label: "b" }, { signal: ac.signal });
    expect(calls[0].url).toBe("/api/custom-actions/team%3Aa1");
    expect(calls[0].init.signal).toBe(ac.signal);
    await updateCustomActionReq("team:a1", { label: "c" });
    expect(calls[1].init.signal).toBeUndefined();
  });

  it("create / update 配 withTimeout 工厂：超时 abort 底层 fetch、拿到超时文案", async () => {
    for (const run of [
      (signal: AbortSignal) => createCustomActionReq(input, { signal }),
      (signal: AbortSignal) => updateCustomActionReq("a1", { label: "b" }, { signal }),
    ]) {
      const calls = installHangingFetch();
      const p = withTimeout(run, 500, TIMEOUT_MSG);
      const assertion = expect(p).rejects.toThrow(TIMEOUT_MSG);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      expect(calls[0].init.signal?.aborted).toBe(true);
    }
  });

  it("读响应体途中被 abort：AbortError 原样抛出，不被吞成 null 后变成「Cannot destructure」之类的怪错误", async () => {
    const abortErr = new DOMException("This operation was aborted", "AbortError");
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw abortErr;
      },
    }));
    await expect(createCustomActionReq(input)).rejects.toBe(abortErr);
    await expect(updateCustomActionReq("a1", {})).rejects.toBe(abortErr);
  });

  it("响应体不是 JSON（非 abort 的解析失败）：行为不变——ok 时给 null、非 ok 时给「请求失败（状态码）」", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    await expect(createCustomActionReq(input)).rejects.toThrow("请求失败（502）");
  });
});

describe("接线契约：两个保存弹窗都走工厂形态并透传 signal，超时文案保留「服务端可能已保存成功」", () => {
  const read = (rel: string): string =>
    readFileSync(path.join(process.cwd(), rel), "utf-8");

  it("edit-task-dialog：withTimeout((signal) => updateTaskFields(..., { signal }))", () => {
    const src = read("src/components/tasks/edit-task-dialog.tsx");
    expect(src).toMatch(
      /withTimeout\(\s*\(signal\)\s*=>\s*updateTaskFields\(task\.id,\s*patch,\s*\{\s*signal\s*\}\)/,
    );
    expect(src).toContain("服务端可能已保存成功");
  });

  it("custom-action-editor：withTimeout((signal) => create/update(..., { signal }))", () => {
    const src = read("src/components/custom-actions/custom-action-editor.tsx");
    expect(src).toMatch(/withTimeout\(\s*\(signal\)\s*=>/);
    expect(src).toMatch(/updateCustomActionReq\(editing\.id,\s*payload,\s*\{\s*signal\s*\}\)/);
    expect(src).toMatch(/createCustomActionReq\(payload,\s*\{\s*signal\s*\}\)/);
    expect(src).toContain("服务端可能已保存成功");
  });
});
