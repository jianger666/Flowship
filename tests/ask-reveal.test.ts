/**
 * 新提问出现时还原被浏览器「放大」遮住的栏（审核 R8-05 ①）。
 *
 * 防的事：聊天页放大后对话栏 inert + 宽 0、任务页放大后事件流栏折叠，而 ask_user 答题卡就在那一栏里；
 * 系统通知在「聚焦且正看着这个任务」时静音——AI 停下来等人、卡片却被藏着。
 * 这里钉：判定口径（只认新提问的上升沿 / 只在被遮住时）、两个页面的接线（遮住的判据 / 还原动作）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pendingAskIdOf, shouldRevealForNewAsk } from "@/lib/ask-reveal";
import type { TaskEvent } from "@/lib/types";

let seq = 0;
const ev = (kind: TaskEvent["kind"], meta?: Record<string, unknown>): TaskEvent => ({
  id: `e${seq++}`,
  ts: seq,
  kind,
  text: "",
  meta,
});
const ask = (askId: string) => ev("ask_user_request", { askId, questions: [] });
const reply = (askId: string) => ev("ask_user_reply", { askId });
const supersede = (askId: string) => ev("info", { supersededAskId: askId });

describe("pendingAskIdOf：当前待回答提问的 askId", () => {
  it("没有事件 / 没有提问 / 提问已答 / 已作废 → null", () => {
    expect(pendingAskIdOf(undefined)).toBeNull();
    expect(pendingAskIdOf(null)).toBeNull();
    expect(pendingAskIdOf([])).toBeNull();
    expect(pendingAskIdOf([ev("info")])).toBeNull();
    expect(pendingAskIdOf([ask("a1"), reply("a1")])).toBeNull();
    expect(pendingAskIdOf([ask("a1"), supersede("a1")])).toBeNull();
  });

  it("有待回答的提问 → 它的 askId；事件继续增长（流式输出）时 askId 不变", () => {
    const base = [ev("info"), ask("a1")];
    expect(pendingAskIdOf(base)).toBe("a1");
    expect(pendingAskIdOf([...base, ev("info")])).toBe("a1");
  });

  it("只认最新一条（与 findPendingAskEvent 同口径）：旧提问没了结、新提问已出现 → 新的 id", () => {
    expect(pendingAskIdOf([ask("a1"), ask("a2")])).toBe("a2");
  });
});

describe("shouldRevealForNewAsk：只在「新提问 + 被遮住」时还原", () => {
  it("无提问 → 出现新提问：被遮住就还原，没遮住不动", () => {
    expect(shouldRevealForNewAsk(null, "a1", true)).toBe(true);
    expect(shouldRevealForNewAsk(null, "a1", false)).toBe(false);
  });

  it("同一条提问（事件增长、重渲染）不重复触发——用户看到后又自己放大，不被反复拉回来", () => {
    expect(shouldRevealForNewAsk("a1", "a1", true)).toBe(false);
  });

  it("提问被答掉 / 作废（→ null）不触发", () => {
    expect(shouldRevealForNewAsk("a1", null, true)).toBe(false);
    expect(shouldRevealForNewAsk(null, null, true)).toBe(false);
  });

  it("旧提问被作废、直接换成新提问（id 变了）算新的", () => {
    expect(shouldRevealForNewAsk("a1", "a2", true)).toBe(true);
  });

  it("整段时间线：用户放大 → 新提问弹出被还原 → 用户答完 → 再放大 → 同一条提问无事 → 下一条新提问再还原", () => {
    let hidden = false;
    let prev: string | null = null;
    const reveals: string[] = [];
    const step = (next: string | null) => {
      if (shouldRevealForNewAsk(prev, next, hidden)) {
        reveals.push(next!);
        hidden = false; // 还原
      }
      prev = next;
    };
    hidden = true; // 用户放大
    step("a1"); // 新提问 → 还原
    hidden = true; // 用户看过了，又放大去看浏览器
    step("a1"); // 同一条（比如事件增长）→ 不动
    step(null); // 用户答完
    step("a2"); // 下一条新提问 → 再还原
    expect(reveals).toEqual(["a1", "a2"]);
  });
});

describe("接线契约（源码）", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("hook：effect 只由 askId 驱动；首次渲染已在等的提问不算新（prev 以首次 askId 起步）；isHidden / reveal 走 ref", () => {
    const hook = strip(read("src/hooks/use-reveal-on-new-ask.ts"));
    expect(hook).toContain("useRef(askId)");
    expect(hook).toContain("}, [askId]);");
    expect(hook).toContain("shouldRevealForNewAsk(prev, askId, isHiddenRef.current())");
    expect(hook).toContain("revealRef.current()");
    // prev 在判定之前就更新（否则「同一条」会被当成新的反复触发）
    expect(hook.indexOf("prevAskIdRef.current = askId")).toBeLessThan(hook.indexOf("shouldRevealForNewAsk("));
  });

  it("聊天页：被遮住 = 对话栏盖住态；还原走 revealChat（只还原、不会反过来盖住）", () => {
    const view = strip(read("src/components/tasks/chat-view.tsx"));
    expect(view).toContain("pendingAskIdOf(task.events)");
    expect(view).toContain("useRevealOnNewAsk(pendingAskId, () => browserPane.chatCovered, browserPane.revealChat)");
    const hook = strip(read("src/components/browser/use-chat-browser-pane.ts"));
    const reveal = hook.slice(hook.indexOf("const revealChat = useCallback("), hook.indexOf("useLayoutEffect("));
    expect(reveal).toContain("openRef.current && chatCoveredRef.current");
    expect(reveal).toContain("toggleCover()");
    expect(hook).toMatch(/return \{[^}]*\brevealChat\b/);
  });

  it("任务页：被遮住 = 「放大造成的」事件流折叠（用户自己折叠的不替他展开）；还原走 restoreEventStreamFromMaximize", () => {
    const page = strip(read("src/app/tasks/[id]/page.tsx"));
    expect(page).toContain("pendingAskIdOf(taskEventsForAsk)");
    expect(page).toMatch(
      /useRevealOnNewAsk\(\s*pendingAskId,\s*\(\) => browserMaximizedRef\.current && !!eventStreamPanelRef\.current\?\.isCollapsed\(\),\s*restoreEventStreamFromMaximize,\s*\)/,
    );
    // 声明顺序：用到的 ref / 回调都在它之前（否则运行期 TDZ）
    const iUse = page.indexOf("useRevealOnNewAsk(\n");
    expect(iUse).toBeGreaterThan(page.indexOf("const restoreEventStreamFromMaximize = useCallback("));
    expect(iUse).toBeGreaterThan(page.indexOf("const browserMaximizedRef = useRef("));
    // 必须在「task 为空」的早返回之前（hook 顺序不能随 task 加载与否变化）
    expect(iUse).toBeLessThan(page.indexOf("if (!task) {"));
  });
});
