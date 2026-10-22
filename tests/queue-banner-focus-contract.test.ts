/**
 * 排队面板自动弹开不抢焦点 + 进入已有排队的会话不弹（第二轮 review U3b-02 / N1）。
 *
 * - U3b-02：base-ui Popover 默认 `initialFocus=true`，自动弹开时焦点被抢到第一个按钮，
 *   用户接着打的字落不进输入框，按空格 / 回车会直接触发按钮（chat：点开行内编辑）。
 *   只有「自动弹开」要关初始聚焦；用户手动点开仍要聚焦进弹层（键盘可达）。
 * - N1：`prevCountRef` 初值必须是挂载时的条数，否则切到一个本来就有排队的会话时
 *   首次渲染就被当成「0→N」，面板自动弹开并抢走 composer 的自动聚焦。
 *
 * 组件的 effect 在 node 测试环境跑不起来，这里把两条不变量钉在源码上：
 * 谁改回 `useRef(0)` / 去掉 initialFocus 绑定，这里立刻红。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe.each([
  ["chat-queue-banner", "src/components/tasks/chat-queue-banner.tsx"],
  ["talk-queue-banner", "src/components/tasks/talk-queue-banner.tsx"],
])("%s", (_name, file) => {
  const src = source(file);

  it("N1：「从无到有」的基线以挂载时的值起步，不是 0", () => {
    if (_name === "chat-queue-banner") {
      // chat 排队条常驻挂载（第三轮 R6-01）：「从无到有」由 chat-view 在实时 dispatch 里判、
      // 经 autoOpenTick 递增通知；基线 = 挂载时的 tick（挂载 = 恢复，不弹）。
      // 行为见 tests/queue-banner.test.ts（queueAutoOpenOnProjection：restore 永不弹）
      expect(src).toMatch(/const lastTickRef = useRef\(autoOpenTick\)/);
      expect(src).not.toMatch(/const lastTickRef = useRef\(0\)/);
      expect(src).not.toMatch(/const prevCountRef = /);
    } else {
      expect(src).toMatch(/const prevCountRef = useRef\(queuedCount\)/);
      expect(src).not.toMatch(/const prevCountRef = useRef\(0\)/);
    }
  });

  it("U3b-02：自动弹开标记驱动 initialFocus（自动开不聚焦、手动开聚焦）", () => {
    expect(src).toMatch(/initialFocus=\{!autoOpened\}/);
    // 自动弹开处置 true，手动开 / 关处置 false
    expect(src).toMatch(/setAutoOpened\(true\)/);
    expect(src).toMatch(/setAutoOpened\(false\)/);
  });
});
