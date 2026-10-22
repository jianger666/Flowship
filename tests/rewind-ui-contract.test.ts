/**
 * 聊天回退（含编辑回退）的 UI 接线契约（第二轮 review V7-05 / V7-06；源码契约闸）
 *
 * 行为本身在 tests/rewind-failure.test.ts（单飞锁 / 按 code 选提示）、tests/rewind-route.test.ts（路由带 code）、
 * tests/chat-edit-rewind.test.ts（服务端 reason）。组件在 node 环境跑不起来，这里钉「接线没接歪」：
 *
 * - V7-05：两个回退入口都走同一把单飞锁 + 回退进行中有反馈（loading toast / 按钮转圈 + 其余禁用），
 *   被拒绝时不弹确认框、不发第二个 POST
 * - V7-06：失败提示按服务端 409 的稳定 `code` 选，chat-view 里不再有匹配中文文案的正则
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");

const chatView = read("components", "tasks", "chat-view.tsx");
const eventStream = read("components", "tasks", "event-stream.tsx");
const rows = read("components", "tasks", "event-stream", "rows.tsx");
const route = read("app", "api", "tasks", "[id]", "rewind", "route.ts");
const checkpoint = read("lib", "server", "chat-checkpoint.ts");

const sliceBetween = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from);
  expect(start, `找不到 ${from}`).toBeGreaterThan(0);
  const end = src.indexOf(to, start);
  expect(end, `找不到 ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("V7-05：回退有反馈、不可重入", () => {
  const handleRewind = sliceBetween(
    chatView,
    "const handleRewind = useCallback(",
    "const handleEditRewind = useCallback(",
  );
  const handleEditRewind = sliceBetween(
    chatView,
    "const handleEditRewind = useCallback(",
    "// C：待发送气泡直改",
  );

  it("回退（确认后）：整段 POST 包在 runExclusiveRewind 里，进行中给 loading toast，结束用同一个 id 收口", () => {
    expect(handleRewind).toContain("runExclusiveRewind(");
    expect(handleRewind).toContain("rewindLockRef");
    expect(handleRewind).toContain("setRewindingEventId");
    expect(handleRewind).toContain("toast.loading(");
    // 成功 / 失败都把 loading toast 就地换掉，不留一个永远转圈的
    expect(handleRewind).toMatch(/toast\.success\([\s\S]*?\{ id: toastId \}/);
    expect(handleRewind).toMatch(/toast\.error\([\s\S]*?\{ id: toastId \}/);
    // 锁必须在 POST 之外释放不了的地方：POST 在 fn 里面
    const iLock = handleRewind.indexOf("runExclusiveRewind(");
    const iPost = handleRewind.indexOf("rewindChatToEvent(");
    expect(iPost).toBeGreaterThan(iLock);
  });

  it("回退已在进行时：连确认框都不弹（再确认一次只会换来服务端「已有回退在进行中」）", () => {
    const iGuard = handleRewind.indexOf("rewindLockRef.current");
    const iConfirm = handleRewind.indexOf("await confirm(");
    expect(iGuard).toBeGreaterThan(0);
    expect(iGuard).toBeLessThan(iConfirm);
    expect(handleRewind).toContain("REWIND_BUSY_NOTICE");
  });

  it("编辑回退：同一把锁，回退 POST（含 409 短重试）整段在锁内；已有回退时直接失败返回", () => {
    expect(handleEditRewind).toContain("runExclusiveRewind(");
    expect(handleEditRewind).toContain("rewindLockRef");
    const iLock = handleEditRewind.indexOf("runExclusiveRewind(");
    const iPost = handleEditRewind.indexOf("rewindChatToEvent(");
    const iRetry = handleEditRewind.indexOf("err.status === 409");
    expect(iPost).toBeGreaterThan(iLock);
    expect(iRetry).toBeGreaterThan(iLock);
    // 最前面先看锁：别人在回退就别再确认 / 停当前回复
    const iGuard = handleEditRewind.indexOf("rewindLockRef.current");
    expect(iGuard).toBeGreaterThan(0);
    expect(iGuard).toBeLessThan(handleEditRewind.indexOf("await confirm("));
    expect(iGuard).toBeLessThan(handleEditRewind.indexOf("await stopAgentCore()"));
  });

  it("rewindingEventId 一路透传：ChatView → EventStream → EventRow → 动作条按钮", () => {
    expect(chatView).toMatch(/rewindingEventId=\{rewindingEventId\}/);
    expect(eventStream).toMatch(/rewindingEventId\?: string \| null;/);
    expect(eventStream).toMatch(/rewindingEventId=\{rewindingEventId\}/);
    expect(rows).toMatch(/rewindingEventId\?: string \| null;/);
    // 动作条：本行转圈（busy）、其余行禁用（disabled）——回退进行中再点任何一行都没意义
    const rewindAction = sliceBetween(rows, 'key: "rewind"', 'key: "resend"');
    expect(rewindAction).toContain("busy: rewindingEventId === ev.id");
    expect(rewindAction).toMatch(/disabled: !!rewindingEventId/);
  });
});

describe("V7-06：失败提示按 code 选、不匹配中文文案", () => {
  it("chat-view 里不再有匹配报错中文的正则（跑 / running / 停止 / 409）", () => {
    expect(chatView).not.toMatch(/\/跑\|running\|停止\|409\/i\.test/);
    expect(chatView).not.toContain('toast.error("请先停止当前回复再回退")');
  });

  it("两个入口的失败提示都走 rewindFailureToast（回退 / 编辑各一个前缀）", () => {
    expect(chatView).toContain('rewindFailureToast(err, "rewind")');
    expect(chatView).toContain('rewindFailureToast(err, "edit")');
    expect(chatView).not.toContain("`编辑失败：${(err as Error).message}`");
  });

  it("路由：RewindError 的响应带 code（reason 优先、否则 RewindError.code）", () => {
    expect(route).toMatch(
      /errorResponse\(err\.message, err\.status, \{\s*code: err\.reason \?\? err\.code,?\s*\}\)/,
    );
  });

  it("服务端：细分 409 的 reason 都在 throw 点显式给出（不靠文案推断）", () => {
    for (const reason of [
      "task_closing",
      "queue_draining",
      "session_starting",
      "queue_pending",
      "rewind_in_progress",
    ]) {
      expect(checkpoint.includes(`"${reason}"`), reason).toBe(true);
    }
    // 前端要的 code 集合与服务端 reason 同源（共用 lib/rewind-failure 的类型）
    expect(checkpoint.includes("RewindFailureCode")).toBe(true);
  });
});
