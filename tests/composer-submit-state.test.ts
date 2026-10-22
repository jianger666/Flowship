/**
 * chat 输入岛「回车之后」的状态收口（第三轮 review D7-03 / R5-01 / R3-02）
 *
 * - D7-03：chat 空闲首发，回车 → 服务端受理（热 1.3–2.7s / 冷 4.5–6.7s）整段，`canReply = !isSubmitting`
 *   被折进 `composeEnabled`，编辑器整体灰掉（placeholder「正在发送、稍候」、粘贴 / 拖图短路），
 *   与第二轮 V5-01「提交中编辑器不锁」相反；发送键也没有「发送中」的表达。
 *   → `composeEnabled` 不再被 submitting 关掉（防双发靠提交闩锁 + 发送键 disabled，不靠锁编辑器），
 *     发送键转圈、提示「发送中」。
 * - R5-01：失败恢复整体覆盖，飞行中敲的下一句 / 贴的图 / 路径被快照吞掉 → 复用 task 说话条的合并规则；
 *   受理后的自动聚焦会抢走用户正选着的上一条 AI 回复 → 有非空选区不聚焦。
 * - R3-02：「有后台子代理」被算成 composer 整套运行态（转圈 / 发送键变「排队发送」/ 附件按钮消失）。
 *   → 单独的 stopOnly：只多出停止键，其余不动。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  deriveComposeEnabled,
  shouldShowComposerRunning,
  shouldShowComposerStopOnly,
} from "@/lib/chat-pending-display";
import { deriveComposerActions } from "@/lib/composer-actions";
import {
  hasNonEmptySelection,
  shouldAutoFocusComposer,
} from "@/lib/composer-refocus";
import { runOptimisticSubmit, type PendingUploadImage } from "@/lib/optimistic-submit";
import type { RichInputPayload } from "@/lib/rich-input-payload";
import { restoreDraftMerged } from "@/lib/talk-draft-merge";

const source = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("deriveComposeEnabled（D7-03）：提交飞行期间编辑器不锁", () => {
  const base = {
    awaitingUser: false,
    awaitingAsk: false,
    isRunning: false,
    allowQueueWhileRunning: true,
    submitting: false,
  };

  it("空闲首发：回车后到服务端受理前（canReply=false、isRunning 尚假、submitting 真）仍可输入", () => {
    // 修前：false → 编辑器灰、placeholder「正在发送、稍候」
    expect(deriveComposeEnabled({ ...base, submitting: true })).toBe(true);
  });

  it("没有任何理由可输入时仍是 false（失活态 placeholder「agent 当前没有等待你回复」的前提不变）", () => {
    expect(deriveComposeEnabled(base)).toBe(false);
  });

  it("原有可输入的几种情形不受影响", () => {
    expect(deriveComposeEnabled({ ...base, awaitingUser: true })).toBe(true);
    expect(deriveComposeEnabled({ ...base, awaitingAsk: true })).toBe(true);
    expect(deriveComposeEnabled({ ...base, isRunning: true })).toBe(true); // chat 运行中可排队
    expect(deriveComposeEnabled({ ...base, isRunning: true, allowQueueWhileRunning: false })).toBe(false);
  });
});

describe("shouldShowComposerRunning / shouldShowComposerStopOnly（R3-02）", () => {
  it("只有后台子代理：不再算 composer 运行态（不转圈、发送键不变「排队发送」、附件按钮不消失）", () => {
    expect(
      shouldShowComposerRunning({ isRunning: false, submitting: false, awaitingAsk: false }),
    ).toBe(false);
  });

  it("运行态仍由 run 进行中 / 提交飞行决定，待答提问时不画", () => {
    expect(shouldShowComposerRunning({ isRunning: true, submitting: false, awaitingAsk: false })).toBe(true);
    expect(shouldShowComposerRunning({ isRunning: false, submitting: true, awaitingAsk: false })).toBe(true);
    expect(shouldShowComposerRunning({ isRunning: true, submitting: true, awaitingAsk: true })).toBe(false);
  });

  it("stopOnly：主 AI 空闲、后台子代理还在跑 → 只多一个停止键", () => {
    expect(
      shouldShowComposerStopOnly({
        isRunning: false,
        submitting: false,
        awaitingAsk: false,
        backgroundSubagentCount: 2,
      }),
    ).toBe(true);
  });

  it("stopOnly 不与完整运行态叠加（运行态自带停止键）；无后台子代理 / 待答提问时都不出", () => {
    const idle = { isRunning: false, submitting: false, awaitingAsk: false };
    expect(shouldShowComposerStopOnly({ ...idle, isRunning: true, backgroundSubagentCount: 1 })).toBe(false);
    expect(shouldShowComposerStopOnly({ ...idle, submitting: true, backgroundSubagentCount: 1 })).toBe(false);
    expect(shouldShowComposerStopOnly({ ...idle, backgroundSubagentCount: 0 })).toBe(false);
    expect(shouldShowComposerStopOnly({ ...idle, awaitingAsk: true, backgroundSubagentCount: 1 })).toBe(false);
    expect(shouldShowComposerStopOnly({ ...idle })).toBe(false);
  });
});

describe("deriveComposerActions：右侧动作组", () => {
  const act = (o: Partial<Parameters<typeof deriveComposerActions>[0]> = {}) =>
    deriveComposerActions({
      running: false,
      stopOnly: false,
      submitting: false,
      allowQueueWhileRunning: false,
      ...o,
    });

  it("常态：只有「发送」，附件按钮在", () => {
    expect(act()).toEqual({
      showAttach: true,
      runSpinner: false,
      stopButton: false,
      send: { label: "发送", spinning: false, tip: "发送" },
    });
  });

  it("常态提交飞行：发送键转圈、提示「发送中」，附件按钮不动（D7-03）", () => {
    expect(act({ submitting: true })).toEqual({
      showAttach: true,
      runSpinner: false,
      stopButton: false,
      send: { label: "发送", spinning: true, tip: "发送中" },
    });
  });

  it("运行态（chat 可排队）：左侧转圈 + 停止 + 「排队发送」，附件让位", () => {
    expect(act({ running: true, allowQueueWhileRunning: true })).toEqual({
      showAttach: false,
      runSpinner: true,
      stopButton: true,
      send: { label: "排队发送", spinning: false, tip: "排队发送" },
    });
  });

  it("运行态里提交飞行：只留一个转圈——转圈挪到发送键上并提示「发送中」", () => {
    expect(act({ running: true, submitting: true, allowQueueWhileRunning: true })).toEqual({
      showAttach: false,
      runSpinner: false,
      stopButton: true,
      send: { label: "排队发送", spinning: true, tip: "发送中" },
    });
  });

  it("运行态不能排队：没有发送键，左侧转圈保留（没有别处可转）", () => {
    expect(act({ running: true, submitting: true, allowQueueWhileRunning: false })).toEqual({
      showAttach: false,
      runSpinner: true,
      stopButton: true,
      send: null,
    });
  });

  it("stopOnly（R3-02）：只多出停止键，发送键 / 附件 / 转圈语义与常态完全一致", () => {
    const normal = act();
    const stopOnly = act({ stopOnly: true });
    expect(stopOnly).toEqual({ ...normal, stopButton: true });
    // 提交飞行时发送键照常转圈
    expect(act({ stopOnly: true, submitting: true }).send).toEqual({
      label: "发送",
      spinning: true,
      tip: "发送中",
    });
  });
});

describe("restoreDraftMerged（R5-01）：chat 失败恢复不覆盖飞行中新敲的内容", () => {
  const img = (data: string): PendingUploadImage => ({
    id: `i_${data}`,
    file: new File([], `${data}.png`, { type: "image/png" }),
    dataUrl: `data:image/png;base64,${data}`,
    data,
    mimeType: "image/png",
  });

  /** 模拟 chat 输入岛：编辑器内容 / 路径 / 图片三份状态 + 与 event-stream.submitVia 相同的 runOptimisticSubmit 接线 */
  const makeComposer = (init: { text: string; paths: string[]; images: PendingUploadImage[] }) => {
    const state = { ...init };
    const payload = (): RichInputPayload => ({
      text: state.text,
      images: state.images.map((i) => ({
        data: i.data,
        mimeType: i.mimeType,
        filename: i.file.name,
      })),
      attachments: [...state.paths],
      skillRefs: [],
    });
    const reset = () => {
      state.text = "";
      state.paths = [];
      state.images = [];
    };
    const restore = (p: RichInputPayload) =>
      restoreDraftMerged(p, {
        setValue: (updater) => {
          state.text = updater(state.text);
        },
        currentPaths: () => state.paths,
        currentImages: () => state.images,
        replacePaths: (paths) => {
          state.paths = paths;
        },
        replaceImages: (images) => {
          state.images = images;
        },
        maxPaths: 3,
        maxImages: 3,
      });
    return { state, payload, reset, restore };
  };

  it("失败：原文放前、飞行中新敲的接后；路径 / 图片合并去重，一个都不丢", async () => {
    const c = makeComposer({ text: "第一句", paths: ["/a"], images: [img("AAA")] });
    const snap = c.payload();
    let fail!: (e: Error) => void;
    const done = runOptimisticSubmit({
      payload: snap,
      reset: c.reset,
      restore: c.restore,
      send: () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    });
    // POST 飞行期间（编辑器不锁）：用户敲了下一句、贴了新图、又拖了一个文件
    expect(c.state.text).toBe("");
    c.state.text = "第二句";
    c.state.paths = ["/b"];
    c.state.images = [img("BBB")];
    fail(new Error("网络断了"));
    const out = await done;
    expect(out.ok).toBe(false);
    expect(c.state.text).toBe("第一句\n第二句");
    expect(c.state.paths).toEqual(["/a", "/b"]);
    expect(c.state.images.map((i) => i.data)).toEqual(["AAA", "BBB"]);
  });

  it("飞行中没敲新内容：恢复就是原样（与旧写法同结果）", async () => {
    const c = makeComposer({ text: "只有这一句", paths: ["/a"], images: [img("AAA")] });
    const out = await runOptimisticSubmit({
      payload: c.payload(),
      reset: c.reset,
      restore: c.restore,
      send: async () => {
        throw new Error("boom");
      },
    });
    expect(out.ok).toBe(false);
    expect(c.state.text).toBe("只有这一句");
    expect(c.state.paths).toEqual(["/a"]);
    expect(c.state.images.map((i) => i.data)).toEqual(["AAA"]);
  });

  it("恢复项优先占上限：路径 / 图片超上限从后面（新敲的）截断", () => {
    const c = makeComposer({ text: "x", paths: ["/a", "/b"], images: [img("A1"), img("A2")] });
    const snap = c.payload();
    c.reset();
    c.state.paths = ["/c", "/d"];
    c.state.images = [img("B1"), img("B2")];
    c.restore(snap);
    expect(c.state.paths).toEqual(["/a", "/b", "/c"]);
    expect(c.state.images.map((i) => i.data)).toEqual(["A1", "A2", "B1"]);
  });

  it("两边内容一样（连按两次）不重复拼接", () => {
    const c = makeComposer({ text: "同一句", paths: [], images: [] });
    const snap = c.payload();
    c.reset();
    c.state.text = "同一句";
    c.restore(snap);
    expect(c.state.text).toBe("同一句");
  });
});

describe("受理后自动聚焦避让非空选区（R5-01 ◐）", () => {
  const sel = (text: string) => ({ isCollapsed: text.length === 0, toString: () => text });

  it("hasNonEmptySelection：只有真的选着字才算", () => {
    expect(hasNonEmptySelection(sel("上一条回复里的一段"))).toBe(true);
    expect(hasNonEmptySelection(sel(""))).toBe(false);
    expect(hasNonEmptySelection(null)).toBe(false);
    expect(hasNonEmptySelection(undefined)).toBe(false);
    // 折叠的光标（isCollapsed）即使 toString 有值也不算（防御异常实现）
    expect(hasNonEmptySelection({ isCollapsed: true, toString: () => "x" })).toBe(false);
  });

  it("没有选区、焦点不在抽屉：聚焦（原有行为）", () => {
    expect(shouldAutoFocusComposer({ activeInsideSheet: false, selection: sel("") })).toBe(true);
    expect(shouldAutoFocusComposer({ activeInsideSheet: false, selection: null })).toBe(true);
  });

  it("用户正选着一段字（多半在复制上一条 AI 回复）：不抢焦点", () => {
    expect(shouldAutoFocusComposer({ activeInsideSheet: false, selection: sel("要复制的一段") })).toBe(false);
  });

  it("焦点在右侧抽屉里：照旧不抢", () => {
    expect(shouldAutoFocusComposer({ activeInsideSheet: true, selection: sel("") })).toBe(false);
  });
});

describe("接线契约（补充；行为已由上面的纯函数测试锁住）", () => {
  const eventStream = source("src/components/tasks/event-stream.tsx");
  const composer = source("src/components/conversation-composer.tsx");
  const chatView = source("src/components/tasks/chat-view.tsx");

  it("event-stream：composeEnabled 走 deriveComposeEnabled 并带上 submitting；composer 另收 stopOnly", () => {
    expect(eventStream).toMatch(/const composeEnabled = deriveComposeEnabled\(/);
    expect(eventStream).toMatch(/submitting: !!submitting/);
    expect(eventStream).toMatch(/stopOnly=\{composerStopOnly\}/);
    expect(eventStream).toMatch(/shouldShowComposerStopOnly\(/);
  });

  it("event-stream：失败恢复走 restoreDraftMerged，且读最新的路径 / 图片（ref，不是闭包里的陈旧值）", () => {
    expect(eventStream).toMatch(/restoreDraftMerged\(/);
    expect(eventStream).toMatch(/pathsRef\.current/);
    expect(eventStream).toMatch(/imagesRef\.current/);
  });

  it("event-stream：自动聚焦走 shouldAutoFocusComposer（避让非空选区）", () => {
    expect(eventStream).toMatch(/shouldAutoFocusComposer\(/);
  });

  it("composer：右侧动作组走 deriveComposerActions，stopOnly 单独一个 prop", () => {
    expect(composer).toMatch(/deriveComposerActions\(/);
    expect(composer).toMatch(/stopOnly\?: boolean/);
  });

  it("chat-view：不再传「正在发送、稍候」这条失活提示（编辑器不锁了，它是死代码）", () => {
    expect(chatView).not.toContain("正在发送、稍候");
  });
});
