/**
 * 回车后马上切走再切回：列表里的「在等 AI」进度行不能消失（2026-10-17 用户截图）。
 *
 * 现象：新对话发一条消息、回车后立刻切到别的对话再切回，事件流里只剩用户气泡 + 一行折叠的「启动过程 ⚠ · 1 步」，
 * 任何「在转」的东西都没有，只有输入框上方一行静态的「正在启动…」。
 *
 * 根因（读代码得出）：
 *   - 启动阶段的进度行（BootStageRow：正在检查 MCP / 创建会话 / 发送…）是 ephemeral 的，只走 SSE、不落盘
 *     （server/boot-progress.ts：「reload 后天然为空」），切走再切回、组件重挂后这条就没了；
 *   - 兜底的「准备环境… 已等待 Ns」（`__loading__`）只在「末项是 user_reply」时挂（`isRunning && lastIsUser`）。
 *     但 chat 剔除了不可用的 MCP 时，服务端会落一条启动链 info（`meta.subkind = "boot"`，文案 ⚠️ 已跳过…），
 *     它被收进「启动过程」工作过程组、成了流尾——末项不再是 user_reply，兜底行不挂；
 *   - 输入框上方的「正在启动…」是 `yieldToTail` 的，本来就只是静态一行。
 * 修法：流尾是「只有启动链提示」的工作过程组、且 run 还在跑 = 模型还没开口，照样挂 `__loading__`；
 * 挂上后状态行让位、组尾的「处理中…」也让位（同一件事不上下各说一遍）。
 *
 * UI 在 node 环境跑不起来（见 vitest.config.ts），所以判定函数走纯函数测试，接线走源码契约。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shouldShowSendLoading } from "@/lib/chat-pending-display";
import {
  groupChatRenderItems,
  isBootOnlyWorkGroup,
  shouldShowProcessingPlaceholder,
  type ChatRenderItem,
} from "@/lib/chat-turns";
import type { StreamRenderItem } from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({ ts: 1, ...partial });

const userReply = (id = "u1"): TaskEvent => ev({ id, kind: "user_reply", text: "2222" });
/** 线上真实形态：chat-runner 剔除不可用 MCP 后落的那条（带机器字段） */
const mcpSkipped = (id = "b1"): TaskEvent =>
  ev({
    id,
    kind: "info",
    text: "⚠️ 已跳过 1 个不可用的 MCP：figma-desktop（连接失败）——相关能力本次不可用",
    meta: { subkind: "boot" },
  });

const grouped = (events: TaskEvent[]): ChatRenderItem[] =>
  groupChatRenderItems(events as unknown as StreamRenderItem[]);
const lastOf = (items: ChatRenderItem[]): ChatRenderItem | undefined => items[items.length - 1];

describe("isBootOnlyWorkGroup", () => {
  it("只有启动链 info 的组 → true（含 MCP 跳过警告）", () => {
    const last = lastOf(grouped([userReply(), mcpSkipped()]));
    expect(last?.kind).toBe("__work_group__");
    expect(isBootOnlyWorkGroup(last)).toBe(true);
  });

  it("多条启动链 info 连成一组也是 true", () => {
    const last = lastOf(
      grouped([
        userReply(),
        ev({ id: "b0", kind: "info", text: "正在准备工作区…", meta: { subkind: "boot" } }),
        ev({ id: "b1", kind: "info", text: "正在启动 agent…（model: m、系统工具）", meta: { subkind: "boot" } }),
        mcpSkipped("b2"),
      ]),
    );
    expect(isBootOnlyWorkGroup(last)).toBe(true);
  });

  it("组里一旦有真正的过程（thinking / 工具），就不是「纯启动」了 → false", () => {
    const withThinking = lastOf(
      grouped([userReply(), mcpSkipped(), ev({ id: "t1", kind: "thinking", text: "想一下" })]),
    );
    expect(withThinking?.kind).toBe("__work_group__");
    expect(isBootOnlyWorkGroup(withThinking)).toBe(false);

    // 工具块（mergeToolDisplayEvents 之后的形态）同样算真正的过程
    const toolBlock = {
      kind: "__tool_block__",
      id: "c1",
      ts: 2,
      name: "read",
      status: "running",
    } as unknown as StreamRenderItem;
    const withTool = lastOf(
      groupChatRenderItems([userReply(), mcpSkipped(), toolBlock] as unknown as StreamRenderItem[]),
    );
    expect(withTool?.kind).toBe("__work_group__");
    expect(isBootOnlyWorkGroup(withTool)).toBe(false);
  });

  it("不是工作过程组 → false：用户气泡 / AI 回复 / 非启动类 info / 空", () => {
    expect(isBootOnlyWorkGroup(lastOf(grouped([userReply()])))).toBe(false);
    expect(
      isBootOnlyWorkGroup(lastOf(grouped([userReply(), ev({ id: "a1", kind: "assistant_message", text: "好" })]))),
    ).toBe(false);
    // 操作反馈类 info（不是启动链）独立平铺、不进组
    expect(
      isBootOnlyWorkGroup(lastOf(grouped([userReply(), ev({ id: "i1", kind: "info", text: "用户停止了对话" })]))),
    ).toBe(false);
    expect(isBootOnlyWorkGroup(undefined)).toBe(false);
    expect(isBootOnlyWorkGroup(null)).toBe(false);
  });

  it("空组 → false（没有成员说明不了任何事）", () => {
    expect(isBootOnlyWorkGroup({ kind: "__work_group__", members: [] } as never)).toBe(false);
  });
});

describe("切走再切回后的进度行：把纯函数拼成事件流里的判定", () => {
  /** 与 event-stream 第三层 memo 同口径：末项是 user_reply，或（chat）是纯启动组 */
  const loadingShown = (events: TaskEvent[], opts: { isRunning: boolean; isChat?: boolean; hasInflight?: boolean }) => {
    const last = lastOf(grouped(events));
    const lastIsUser = last?.kind === "user_reply";
    const lastIsBootOnly = (opts.isChat ?? true) && isBootOnlyWorkGroup(last);
    return shouldShowSendLoading({
      isRunning: opts.isRunning,
      lastIsUser: lastIsUser || lastIsBootOnly,
      hasInflight: opts.hasInflight ?? false,
    });
  };

  it("用户截图那一刻：[user_reply, MCP 跳过警告] + 在跑 → 要有进度行", () => {
    expect(loadingShown([userReply(), mcpSkipped()], { isRunning: true })).toBe(true);
  });

  it("没在跑（启动失败 / 被停止）→ 不挂，别对着一个已经结束的 run 空转", () => {
    expect(loadingShown([userReply(), mcpSkipped()], { isRunning: false })).toBe(false);
  });

  it("模型已经开口（有 thinking / 工具 / 回复）→ 不再挂", () => {
    expect(
      loadingShown(
        [userReply(), mcpSkipped(), ev({ id: "t1", kind: "thinking", text: "想一下" })],
        { isRunning: true },
      ),
    ).toBe(false);
    expect(
      loadingShown(
        [userReply(), mcpSkipped(), ev({ id: "a1", kind: "assistant_message", text: "好" })],
        { isRunning: true },
      ),
    ).toBe(false);
  });

  it("task 形态不走这条（没有状态行、启动组本来就带进行态）", () => {
    expect(loadingShown([userReply(), mcpSkipped()], { isRunning: true, isChat: false })).toBe(false);
  });

  it("原有语义不变：末项是 user_reply + 在跑 → 挂；有 inflight 占位 → 挂", () => {
    expect(loadingShown([userReply()], { isRunning: true })).toBe(true);
    expect(loadingShown([userReply()], { isRunning: false })).toBe(false);
    expect(loadingShown([], { isRunning: false, hasInflight: true })).toBe(true);
  });
});

describe("组尾「处理中…」让位给流尾进度行", () => {
  const on = {
    isRunning: true,
    isLastItem: true,
    hasRunning: false,
    hasStreamingText: false,
    lastMemberKind: "info",
    statusLineVisible: false,
  };

  it("纯函数：statusLineVisible 为真时让位（流尾进度行与状态行同理）", () => {
    expect(shouldShowProcessingPlaceholder(on)).toBe(true);
    expect(shouldShowProcessingPlaceholder({ ...on, statusLineVisible: true })).toBe(false);
  });
});

describe("事件流接线（源码契约）", () => {
  const eventStream = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "components", "tasks", "event-stream.tsx"),
    "utf-8",
  );

  const sliceBalanced = (source: string, marker: string, open: "(" | "{"): string => {
    const close = open === "(" ? ")" : "}";
    const start = source.indexOf(marker);
    expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
    const from = source.indexOf(open, start + marker.length - 1);
    let depth = 0;
    for (let i = from; i < source.length; i++) {
      const ch = source[i];
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error(`\`${marker}\` 的 ${open}${close} 没配平`);
  };

  const itemsMemo = () => sliceBalanced(eventStream, "const items: RenderItem[] = useMemo", "(");

  it("第三层 memo：纯启动组流尾只在 chat 判，并并入 lastIsUser 交给 shouldShowSendLoading", () => {
    const memo = itemsMemo();
    expect(memo).toContain("const lastIsBootOnly = isChat && isBootOnlyWorkGroup(last);");
    const call = sliceBalanced(memo, "shouldShowSendLoading(", "(");
    expect(call).toContain("lastIsUser: lastIsUser || lastIsBootOnly,");
  });

  it("进度行带落盘起算时间：memo 里 __loading__ 项带 since、渲染把它交给 PendingRow、PendingRow 首次挂载时才定起算点", () => {
    const memo = itemsMemo();
    // __loading__ 项的 since 来自 loadingSinceTs；有 inflight 占位时不取（那时流里最近的 user_reply 是上一轮的）
    const sinceCall = sliceBalanced(memo, "since: loadingSinceTs(", "(");
    expect(sinceCall).toContain("withPending");
    expect(sinceCall).toMatch(/,\s*hasInflight,?\s*\)$/);
    expect(eventStream).toContain("<PendingRow since={item.since} />");
    const rowStart = eventStream.indexOf("const PendingRow = ({ since }");
    expect(rowStart, "找不到 PendingRow").toBeGreaterThanOrEqual(0);
    const row = eventStream.slice(rowStart, eventStream.indexOf("\n};\n", rowStart));
    // useState 的惰性初始值：只在首次挂载算一次；since 之后才到（占位 → 落盘交接）不会让计时往回跳
    expect(row).toContain("const [t0] = useState(() => resolveLoadingStart(since, Date.now()));");
    expect(row).toContain("Math.floor((Date.now() - t0) / 1000)");
    // state 存整秒数（同一秒内的 tick 被 React 跳过、每秒只重渲一次），不存 Date.now()（每次都变 = 重渲翻倍）
    expect(row).toContain("const [elapsed, setElapsed] = useState(");
    expect(row).not.toContain("setNow(");
  });

  it("组尾「处理中…」的 statusLineVisible 也算上流尾进度行（漏了 = 启动组头说「处理中…」、下面又一行「准备环境…」）", () => {
    const call = sliceBalanced(eventStream, "shouldShowProcessingPlaceholder({", "(");
    expect(call).toContain("statusLineVisible: statusLineVisible || tailHasProgressRow,");
  });
});
