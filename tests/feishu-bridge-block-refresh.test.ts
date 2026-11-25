/**
 * 设置页「消息桥接」块：总开关打开后什么时候去拉 /api/feishu-bridge/status（R20-15）
 *
 * 真问题：乐观更新下开关一拨 `feishuChatBridge` 就变 true，而 PATCH /api/settings 此刻才发出去——这时拉 status，
 * 服务端读盘多半还是旧值 false、consumer 还没起，返回「未运行」；之后没有人再拉一次（只在开关变化时拉一次），
 * 用户只能手动点「重新检测」。修复：父级把「总开关的值已落盘」（`!dirty.feishuChatBridge`）传下来，
 * 块里改成「已打开 **且已落盘**」才拉——落盘时服务端已因写盘通知开始对账，这次 GET 会并入那次对账、读到起来之后的状态。
 *
 * 本文件用 tests/helpers/react-hook-stub.ts 的 `memoCallbacks` 模式让组件体里的真 hook 在受控 dispatcher 下跑，
 * 逐步改 props 观察 fetch 的次数（这是「时间里的行为」，renderToStaticMarkup 测不到）；
 * 另外钉住 page → FeishuCliSection → FeishuBridgeBlock 的接线，防止这个 prop 在中间断掉（断了 = 永远缺省 true = 回到老行为，且没有任何报错）。
 * 没做的事：没有在真 Electron 里点开关观察（见 HANDOFF 第二十轮「没验证项」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeishuBridgeBlock } from "@/components/settings/feishu-bridge-block";

import { createHookHarness } from "./helpers/react-hook-stub";
import { readSource } from "./helpers/source-text";

type BlockProps = Parameters<typeof FeishuBridgeBlock>[0];

const noop = (): void => undefined;
const baseProps = (over: Partial<BlockProps>): BlockProps => ({
  feishuChatBridge: false,
  onFeishuChatBridgeChange: noop,
  feishuBridgeStreaming: true,
  onFeishuBridgeStreamingChange: noop,
  feishuGroupNonOwnerGuard: true,
  onFeishuGroupNonOwnerGuardChange: noop,
  feishuGroupBotsEqualRights: false,
  onFeishuGroupBotsEqualRightsChange: noop,
  ...over,
});

describe("FeishuBridgeBlock：总开关打开后的状态拉取时机", () => {
  // 显式标出 url 形参：下面要读 `mock.calls[0]?.[0]`，实现不带形参时 tsc 会把 calls 推成 `[][]`（TS2493）
  const fetchMock = vi.fn<(url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(async () => ({
    ok: true,
    json: async () => ({ ok: true }),
  }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 一次 render + 跑 effect + 让 refresh 里的 await 走完 */
  const step = async (
    h: ReturnType<typeof createHookHarness>,
    props: Partial<BlockProps>,
  ): Promise<number> => {
    h.render(() => FeishuBridgeBlock(baseProps(props)));
    h.flushEffects();
    await new Promise<void>((r) => setImmediate(r));
    return fetchMock.mock.calls.length;
  };

  it("页面加载时就是「已打开且已落盘」：拉一次；之后同样的 props 再渲染不会重复拉", async () => {
    const h = createHookHarness({ memoCallbacks: true });
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: true })).toBe(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/feishu-bridge/status");
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: true })).toBe(1);
    h.unmount();
  });

  it("刚拨开关、还没落盘：不拉；落盘（saved 变 true）那一刻才拉，且只拉一次", async () => {
    const h = createHookHarness({ memoCallbacks: true });
    expect(await step(h, { feishuChatBridge: false, feishuChatBridgeSaved: true })).toBe(0); // 初始：关
    // 用户拨开：草稿 true、盘上还是 false → dirty
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: false })).toBe(0);
    // 保存还没结束时别的 state 变了重渲染：仍然不拉
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: false })).toBe(0);
    // PATCH 落盘：dirty 清掉
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: true })).toBe(1);
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: true })).toBe(1);
    h.unmount();
  });

  it("关 → 开 的完整往返：只有「开且已落盘」那一步拉；关的两步都不拉", async () => {
    const h = createHookHarness({ memoCallbacks: true });
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: true })).toBe(1); // 加载：开
    expect(await step(h, { feishuChatBridge: false, feishuChatBridgeSaved: false })).toBe(1); // 拨关、未落盘
    expect(await step(h, { feishuChatBridge: false, feishuChatBridgeSaved: true })).toBe(1); // 关已落盘
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: false })).toBe(1); // 再拨开、未落盘：不拉（老行为这里会拉）
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: true })).toBe(2); // 落盘：拉
    h.unmount();
  });

  it("保存被拒后草稿回滚（开 → 关且 saved）：不拉", async () => {
    const h = createHookHarness({ memoCallbacks: true });
    expect(await step(h, { feishuChatBridge: false, feishuChatBridgeSaved: true })).toBe(0);
    expect(await step(h, { feishuChatBridge: true, feishuChatBridgeSaved: false })).toBe(0);
    expect(await step(h, { feishuChatBridge: false, feishuChatBridgeSaved: true })).toBe(0); // 回滚
    h.unmount();
  });

  it("不传 feishuChatBridgeSaved（老调用方）：缺省按「已落盘」，开着就拉一次——行为与改动前一致", async () => {
    const h = createHookHarness({ memoCallbacks: true });
    expect(await step(h, { feishuChatBridge: true })).toBe(1);
    h.unmount();
  });

  it("开关关着：无论 saved 是什么都不拉", async () => {
    for (const saved of [true, false]) {
      const h = createHookHarness({ memoCallbacks: true });
      expect(await step(h, { feishuChatBridge: false, feishuChatBridgeSaved: saved })).toBe(0);
      h.unmount();
    }
  });
});

describe("page → FeishuCliSection → FeishuBridgeBlock：feishuChatBridgeSaved 的接线不能断", () => {
  it("settings 页：从 useSettings 取 dirty，传 `!dirty.feishuChatBridge` 给 FeishuCliSection", () => {
    const src = readSource("src/app/settings/page.tsx");
    // 解构：`const { …, dirty, … } = useSettings();`
    const end = src.indexOf("} = useSettings();");
    expect(end, "找不到 useSettings() 的解构").toBeGreaterThan(-1);
    const destructure = src.slice(src.lastIndexOf("const {", end), end);
    expect(destructure, "page 要从 useSettings() 解出 dirty").toMatch(/\bdirty,/);
    // 且和总开关那一行在同一个 <FeishuCliSection …/> 里（不是随手挂在别的组件上）
    const start = src.indexOf("<FeishuCliSection");
    expect(start, "找不到 <FeishuCliSection").toBeGreaterThan(-1);
    const section = src.slice(
      start,
      src.indexOf("/>", src.indexOf("onFeishuGroupBotsEqualRightsChange", start)),
    );
    expect(section).toMatch(/feishuChatBridge=\{settings\.feishuChatBridge === true\}/);
    expect(section).toMatch(/feishuChatBridgeSaved=\{!dirty\.feishuChatBridge\}/);
  });

  it("FeishuCliSection：声明并原样转给 FeishuBridgeBlock", () => {
    const src = readSource("src/components/settings/feishu-cli-card.tsx");
    expect(src).toMatch(/feishuChatBridgeSaved\?: boolean;/);
    const start = src.indexOf("<FeishuBridgeBlock");
    expect(start, "找不到 <FeishuBridgeBlock").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("/>", start));
    expect(block).toMatch(/feishuChatBridgeSaved=\{feishuChatBridgeSaved\}/);
  });

  it("FeishuBridgeBlock：缺省 true、effect 的条件与依赖都带上它", () => {
    const src = readSource("src/components/settings/feishu-bridge-block.tsx");
    expect(src).toMatch(/feishuChatBridgeSaved = true,/);
    expect(src).toMatch(/if \(!feishuChatBridge \|\| !feishuChatBridgeSaved\) return;/);
    expect(src).toMatch(/\}, \[feishuChatBridge, feishuChatBridgeSaved, refresh\]\);/);
  });
});
