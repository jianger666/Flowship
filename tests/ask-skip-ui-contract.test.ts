/**
 * 「已跳过」在 UI 上的三处表现（源码契约闸）
 *
 * 用户实测缺陷的三个症状必须一起消失，缺一个就还是「牛皮癣」：
 * 1. 事件流里那张待答卡片 → 收成一行灰色「AI 提过 N 个问题 · 已跳过」（可展开看原问题）
 * 2. 顶部橙色「AI 在等你回答」悬浮条 → 消失
 * 3. 推进按钮 → 恢复可用（`canAdvance` 不再被未答 ask 按住）
 *
 * 2 和 3 靠的是同一个不变量：三处都只看 `findPendingAskEvent`，而跳过写的是标准作废标记
 *（`meta.supersededAskId`）——判定一变，两个症状自动消失。本文件把这条链钉死：
 * 谁把判定换成别的写法（各自 grep 事件 / 自己判 kind）就红。
 *
 * UI 组件在 node 环境跑不起来（见 vitest.config.ts），所以走源码契约、
 * 判定逻辑本身由 tests/ask-pending.test.ts 覆盖。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");

describe("事件流：跳过的提问收成一行", () => {
  const rows = read("components", "tasks", "event-stream", "rows.tsx");

  it("命中 isAskSkipped 时走独立的折叠行、不再渲染整张卡", () => {
    expect(rows).toContain("isAskSkipped");
    expect(rows).toContain("SkippedAskRow");
    expect(rows).toContain("已跳过");
  });

  it("折叠行可展开看原问题——事件流是历史、不能把 AI 问过什么抹掉", () => {
    // 展开态渲染原题（共用 lib/ask-pending 的解析、不自己再写一份）
    expect(rows).toContain("extractAskQuestions");
    const idx = rows.indexOf("const SkippedAskRow");
    expect(idx).toBeGreaterThan(0);
    const body = rows.slice(idx, idx + 2000);
    expect(body).toContain("setOpen");
    expect(body).toContain("ChevronDown");
  });

  it("有真答案时按「已答」显示——answered 优先于 skipped（极窄竞态兜底）", () => {
    expect(rows).toContain("() => !answered && isAskSkipped(");
  });
});

describe("悬浮条 / 推进按钮：跟着同一个判定走", () => {
  it("「AI 在等你回答」悬浮条只在 findPendingAskEvent 命中时渲染", () => {
    const stream = read("components", "tasks", "event-stream.tsx");
    expect(stream).toContain("findPendingAskEvent(task.events)");
    // 渲染条件就是 pendingAskEvent 本身——跳过后它变 null、悬浮条自然消失。
    // 2026-07-28 悬浮层合并（琥珀条 +「回到最新」按钮共处 StreamFloatingBar、
    // 由同一处决定两者的共存位置）后判定源没变：只是从「整颗组件挂条件」
    // 变成「琥珀条那半边挂条件」，中间不许再夹别的判断
    expect(stream).toContain("hasPendingAsk={!!pendingAskEvent}");
    expect(stream).toMatch(/\{hasPendingAsk && \(\s*<button/);
    expect(stream).toContain("AI 在等你回答");
  });

  it("跳过标记那条 info 不再单独占一行——话由 ask 折叠行说", () => {
    const stream = read("components", "tasks", "event-stream.tsx");
    expect(stream).toContain("isAskSkipMarkerEvent");
    // 只滤显示：标记仍在 events.jsonl 里，了结判定全靠它
    expect(stream).toContain("!isAskSkipMarkerEvent(e)");
  });

  it("canAdvance 的「等提问答案」判定同样只看 findPendingAskEvent", () => {
    const page = read("app", "tasks", "[id]", "page.tsx");
    expect(page).toContain(
      'task.runStatus === "awaiting_user" && !!findPendingAskEvent(task.events)',
    );
    expect(page).toContain("!awaitingAskAnswer &&");
  });

  it("「跟 AI 说」输入条的答题提示也走同一判定", () => {
    const composer = read("components", "tasks", "task-talk-composer.tsx");
    expect(composer).toContain("findPendingAskEvent(task.events)");
  });
});

describe("解析单一源：ask meta 只有一份解析", () => {
  it("答题卡 / 回放行 / ask-reply 路由都从 lib/ask-pending 取，不各写一份", () => {
    for (const file of [
      ["components", "tasks", "ask-user-inline.tsx"],
      ["components", "tasks", "event-stream", "rows.tsx"],
      ["app", "api", "tasks", "[id]", "ask-reply", "route.ts"],
    ]) {
      const source = read(...file);
      expect(source, `${file.join("/")} 应从 ask-pending 取解析`).toContain(
        "extractAskQuestions",
      );
      // 本地再定义一份就是漂移的开始
      expect(
        source.includes("const extractAskQuestions ="),
        `${file.join("/")} 不该自己再定义一份解析`,
      ).toBe(false);
    }
  });
});
