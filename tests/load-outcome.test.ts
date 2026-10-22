/**
 * 「加载失败说谎」的归类契约：详情 503 / 断网不能画「任务不存在」，
 * 列表首拉失败不能画「还没有任务」——只有 404 / 410（服务端确定没有）才算不存在。
 * 行为靠纯函数测；接线靠源码契约钉（UI 在 node 环境跑不起来，参考 earlier-events-wiring-contract）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyLoadError,
  classifyTaskDetailResult,
  deriveListLoadView,
  loadErrorMessage,
} from "../src/lib/load-outcome";
import { ApiRequestError } from "../src/lib/task-store";

describe("classifyLoadError", () => {
  it("404 not_found / 410 task_deleted：服务端确定没有 → notFound（不给重试）", () => {
    expect(classifyLoadError(new ApiRequestError("not_found", 404))).toEqual({
      kind: "notFound",
    });
    expect(classifyLoadError(new ApiRequestError("task_deleted", 410))).toEqual({
      kind: "notFound",
    });
  });

  it("503 temporarily_unavailable / 5xx / 400：不确定 → error（带原因、可重试）", () => {
    for (const status of [400, 500, 502, 503, 504]) {
      expect(
        classifyLoadError(new ApiRequestError("temporarily_unavailable", status)),
      ).toEqual({ kind: "error", message: "temporarily_unavailable" });
    }
  });

  it("断网（fetch 抛 TypeError，没有 status）→ error", () => {
    expect(classifyLoadError(new TypeError("Failed to fetch"))).toEqual({
      kind: "error",
      message: "Failed to fetch",
    });
  });

  it("非 Error 抛值 / 空文案 / status 不是数字：都归 error 且文案非空", () => {
    expect(classifyLoadError("boom")).toEqual({ kind: "error", message: "boom" });
    const empty = classifyLoadError(new Error(""));
    expect(empty.kind).toBe("error");
    expect(loadErrorMessage(new Error("  "))).toBe("未知错误");
    // 形似 status 的字符串不算 404
    expect(classifyLoadError({ status: "404", message: "x" }).kind).toBe("error");
  });
});

describe("classifyTaskDetailResult（fetchTask：404→null、其余非 2xx 抛错）", () => {
  it("拿到 task → ok；拿到 null（fetchTask 对 404 的返回）→ notFound", () => {
    expect(classifyTaskDetailResult({ task: { id: "t" } })).toEqual({ kind: "ok" });
    expect(classifyTaskDetailResult({ task: null })).toEqual({ kind: "notFound" });
  });

  it("抛错：404/410 → notFound；503 / 断网 → error（以前这两种都被画成「任务不存在或已删除」）", () => {
    expect(
      classifyTaskDetailResult({ error: new ApiRequestError("not_found", 404) }),
    ).toEqual({ kind: "notFound" });
    expect(
      classifyTaskDetailResult({
        error: new ApiRequestError("temporarily_unavailable", 503),
      }).kind,
    ).toBe("error");
    expect(
      classifyTaskDetailResult({ error: new TypeError("Failed to fetch") }).kind,
    ).toBe("error");
  });
});

describe("deriveListLoadView", () => {
  it("没加载完 → loading", () => {
    expect(deriveListLoadView({ loaded: false, loadError: null, count: 0 })).toBe(
      "loading",
    );
    expect(deriveListLoadView({ loaded: false, loadError: "x", count: 0 })).toBe(
      "loading",
    );
  });

  it("首拉失败（没数据 + 有失败原因）→ error，而不是 empty", () => {
    expect(deriveListLoadView({ loaded: true, loadError: "HTTP 503", count: 0 })).toBe(
      "error",
    );
  });

  it("真的没有任务（加载成功、列表为空）→ empty", () => {
    expect(deriveListLoadView({ loaded: true, loadError: null, count: 0 })).toBe(
      "empty",
    );
  });

  it("已有数据时后台刷新失败 → 仍 ready（不拿失败态盖掉能用的旧列表）", () => {
    expect(deriveListLoadView({ loaded: true, loadError: "断网", count: 5 })).toBe(
      "ready",
    );
    expect(deriveListLoadView({ loaded: true, loadError: null, count: 5 })).toBe(
      "ready",
    );
  });
});

// ---- 接线契约 ----

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...p: string[]) => readFileSync(path.join(srcDir, ...p), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("加载失败接线契约", () => {
  it("详情页：refresh 走归类函数；失败态在「不存在」之前判定且带重试", () => {
    const page = stripComments(read("app", "tasks", "[id]", "page.tsx"));
    expect(page).toContain("classifyTaskDetailResult(");
    // 旧实现：catch 里 toast 后直接落到 task=null → 画「任务不存在」
    expect(page).not.toMatch(/catch \(err\) \{\s*if \(routeIdRef\.current !== requestedId\) return;\s*toast\.error\(`加载任务失败/);
    const failureIdx = page.indexOf("if (!task && loadFailure)");
    const notFoundIdx = page.indexOf("任务不存在或已删除");
    expect(failureIdx).toBeGreaterThan(0);
    expect(notFoundIdx).toBeGreaterThan(failureIdx);
    const failureBlock = page.slice(failureIdx, notFoundIdx);
    expect(failureBlock).toContain("重试");
    expect(failureBlock).toContain("void refresh()");
  });

  it("列表 hook：失败写入 loadError、成功清掉并导出；侧栏 / 对话落点用 deriveListLoadView 且带重试", () => {
    const hook = stripComments(read("hooks", "use-task-list.tsx"));
    expect(hook).toContain("setLoadError(loadErrorMessage(err))");
    expect(hook).toContain("setLoadError(null)");
    expect(hook).toMatch(/value=\{\{[\s\S]*loadError,/);

    const sidebar = stripComments(read("components", "app-sidebar.tsx"));
    expect(sidebar).toContain('listView === "error"');
    expect(sidebar.slice(sidebar.indexOf('listView === "error"'))).toContain("重试");

    const chats = stripComments(read("app", "chats", "page.tsx"));
    expect(chats).toContain('deriveListLoadView({ loaded, loadError, count: tasks.length }) === "error"');
  });
});
