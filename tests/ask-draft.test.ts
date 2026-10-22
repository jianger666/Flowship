/**
 * ask 答题卡草稿（上滚被虚拟列表卸载后输入不能丢）的契约。
 *
 * 复用现有草稿机制（view-memory 的 DraftScope + useRichInput({ draft })）：
 * 每题一个草稿位 `${taskId}:${askId}:${questionId}`，正文进 sessionStorage、图进附件快照，
 * 选择态进模块级 Map。这里测 store 层行为（模拟「卸载 → 重挂」= 重新 load）+ 清理 / 回收规则，
 * 组件接线靠源码契约钉（UI 在 node 环境跑不起来）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  askDraftId,
  clearAskDrafts,
  pruneAskDrafts,
  resolveInitialAskChoice,
} from "../src/lib/ask-draft";
import {
  clearAskDraftsWhere,
  clearAttachmentSnapshot,
  loadAskChoice,
  loadAttachmentSnapshot,
  loadDraft,
  saveAskChoice,
  saveAttachmentSnapshot,
  saveDraft,
} from "../src/lib/view-memory";

/** 最小 sessionStorage 内存实现（node 环境没有 window） */
const makeStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
};

const snap = (n: number) => ({
  images: [
    { id: `img${n}`, data: `${n}`, mimeType: "image/png", filename: `${n}.png` },
  ],
  paths: [],
});

/** 给一道题写满三类草稿：正文 + 图 + 选择态 */
const fill = (id: string, n: number) => {
  saveDraft("ask", id, `文字${n}`);
  saveAttachmentSnapshot("ask", id, snap(n));
  saveAskChoice(id, { optionId: `opt${n}`, otherMode: false });
};

const hasAny = (id: string): boolean =>
  loadDraft("ask", id) !== "" ||
  loadAttachmentSnapshot("ask", id) !== undefined ||
  loadAskChoice(id) !== undefined;

beforeEach(() => {
  vi.stubGlobal("window", { sessionStorage: makeStorage() });
});

afterEach(() => {
  clearAskDraftsWhere(() => true);
  clearAttachmentSnapshot("reply", "t1");
  vi.unstubAllGlobals();
});

describe("答题卡草稿：卸载重挂后原样还原", () => {
  it("正文 / 图 / 选择态都按 task+ask+题目存、重新 load（= 重挂）读得回", () => {
    const id = askDraftId("t1", "ask1", "q1");
    expect(id).toBe("t1:ask1:q1");
    saveDraft("ask", id, "我选自定义回答");
    saveAttachmentSnapshot("ask", id, snap(1));
    saveAskChoice(id, { optionId: undefined, otherMode: true });

    // 模拟虚拟列表卸载后重挂：组件 state 全丢，只剩 store
    expect(loadDraft("ask", id)).toBe("我选自定义回答");
    expect(loadAttachmentSnapshot("ask", id)).toEqual(snap(1));
    expect(loadAskChoice(id)).toEqual({ optionId: undefined, otherMode: true });
  });

  it("按 task / ask / 题目隔离：A 卡的输入绝不串进 B 卡", () => {
    fill(askDraftId("t1", "ask1", "q1"), 1);
    fill(askDraftId("t1", "ask1", "q2"), 2);
    fill(askDraftId("t1", "ask2", "q1"), 3);
    fill(askDraftId("t2", "ask1", "q1"), 4);
    expect(loadDraft("ask", askDraftId("t1", "ask1", "q1"))).toBe("文字1");
    expect(loadDraft("ask", askDraftId("t1", "ask1", "q2"))).toBe("文字2");
    expect(loadDraft("ask", askDraftId("t1", "ask2", "q1"))).toBe("文字3");
    expect(loadDraft("ask", askDraftId("t2", "ask1", "q1"))).toBe("文字4");
  });
});

describe("clearAskDrafts：提交成功后清掉这张卡", () => {
  it("清掉该 ask 名下所有题的正文 + 图 + 选择态；别的 ask / 任务 / scope 不动", () => {
    const q1 = askDraftId("t1", "ask1", "q1");
    const q2 = askDraftId("t1", "ask1", "q2");
    const otherAsk = askDraftId("t1", "ask2", "q1");
    const otherTask = askDraftId("t2", "ask1", "q1");
    fill(q1, 1);
    fill(q2, 2);
    fill(otherAsk, 3);
    fill(otherTask, 4);
    // 同 id 的常驻输入条草稿（scope=reply）必须不受影响
    saveDraft("reply", "t1", "输入条里的字");
    saveAttachmentSnapshot("reply", "t1", snap(9));

    clearAskDrafts("t1", "ask1");

    expect(hasAny(q1)).toBe(false);
    expect(hasAny(q2)).toBe(false);
    expect(hasAny(otherAsk)).toBe(true);
    expect(hasAny(otherTask)).toBe(true);
    expect(loadDraft("reply", "t1")).toBe("输入条里的字");
    expect(loadAttachmentSnapshot("reply", "t1")).toEqual(snap(9));
  });
});

describe("pruneAskDrafts：ask 作废 / 已答 / 换新 ask 后回收", () => {
  it("只保留当前待答 ask 的草稿，本任务其余全清；别的任务不碰", () => {
    const current = askDraftId("t1", "askNew", "q1");
    const stale1 = askDraftId("t1", "askOld", "q1");
    const stale2 = askDraftId("t1", "askOld2", "q1");
    const otherTask = askDraftId("t2", "askOld", "q1");
    fill(current, 1);
    fill(stale1, 2);
    fill(stale2, 3);
    fill(otherTask, 4);

    pruneAskDrafts("t1", "askNew");

    expect(hasAny(current)).toBe(true);
    expect(hasAny(stale1)).toBe(false);
    expect(hasAny(stale2)).toBe(false);
    expect(hasAny(otherTask)).toBe(true);
  });

  it("没有待答 ask（keep = null，如已被作废 / 已答）→ 本任务全部清掉", () => {
    const a = askDraftId("t1", "askA", "q1");
    const b = askDraftId("t1", "askB", "q1");
    const other = askDraftId("t2", "askA", "q1");
    fill(a, 1);
    fill(b, 2);
    fill(other, 3);

    pruneAskDrafts("t1", null);

    expect(hasAny(a)).toBe(false);
    expect(hasAny(b)).toBe(false);
    expect(hasAny(other)).toBe(true);
  });

  it("不误伤常驻输入条草稿（reply / talk）", () => {
    saveDraft("reply", "t1", "r");
    saveDraft("talk", "t1", "t");
    saveAttachmentSnapshot("reply", "t1", snap(1));
    pruneAskDrafts("t1", null);
    expect(loadDraft("reply", "t1")).toBe("r");
    expect(loadDraft("talk", "t1")).toBe("t");
    expect(loadAttachmentSnapshot("reply", "t1")).toEqual(snap(1));
  });
});

describe("resolveInitialAskChoice：还原选择态的一致性", () => {
  const opts = { options: [{ id: "a" }, { id: "b" }] };
  const none = { hasText: false, hasImages: false };

  it("没有选项的纯文本题：恒为自定义模式", () => {
    expect(resolveInitialAskChoice({}, undefined, none)).toEqual({
      optionId: undefined,
      otherMode: true,
    });
    expect(resolveInitialAskChoice({ options: [] }, undefined, none).otherMode).toBe(
      true,
    );
  });

  it("有选项、没记过 → 初始态（没选、非自定义），与改造前行为一致", () => {
    expect(resolveInitialAskChoice(opts, undefined, none)).toEqual({
      optionId: undefined,
      otherMode: false,
    });
  });

  it("记着选了 b → 还原选 b、非自定义；选项互斥于自定义文本", () => {
    expect(
      resolveInitialAskChoice(opts, { optionId: "b", otherMode: true }, none),
    ).toEqual({ optionId: "b", otherMode: false });
  });

  it("记着的 optionId 已不在选项里 → 丢弃", () => {
    expect(
      resolveInitialAskChoice(opts, { optionId: "zzz", otherMode: false }, none),
    ).toEqual({ optionId: undefined, otherMode: false });
  });

  it("记着「自定义回答」→ 还原自定义模式", () => {
    expect(
      resolveInitialAskChoice(opts, { optionId: undefined, otherMode: true }, none)
        .otherMode,
    ).toBe(true);
  });

  it("没选选项但草稿里有正文 / 图（如 reload 后内存选择态没了、sessionStorage 正文还在）→ 自定义模式，免得输入框被藏、正文却被提交", () => {
    expect(
      resolveInitialAskChoice(opts, undefined, { hasText: true, hasImages: false })
        .otherMode,
    ).toBe(true);
    expect(
      resolveInitialAskChoice(opts, undefined, { hasText: false, hasImages: true })
        .otherMode,
    ).toBe(true);
  });
});

// ---- 接线契约 ----

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...p: string[]) => readFileSync(path.join(srcDir, ...p), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("答题卡草稿接线契约", () => {
  const card = stripComments(read("components", "tasks", "ask-user-inline.tsx"));

  it("每题输入走 useRichInput 的 draft（scope=ask、按 task+ask+题目的 id），不再是纯组件 state", () => {
    expect(card).toMatch(/useRichInput\(\{[\s\S]*?draft:\s*\{\s*scope:\s*"ask",\s*id:\s*draftId\s*\}/);
    expect(card).toContain("askDraftId(taskId, askId, question.id)");
  });

  it("选项 / 自定义模式点选时直写 store，挂载时按 resolveInitialAskChoice 还原", () => {
    expect(card).toContain("saveAskChoice(draftId");
    expect(card).toContain("resolveInitialAskChoice(question, loadAskChoice(draftId)");
  });

  it("提交成功（含稍后再补充，二者共用 applyAskSuccess）清掉本卡草稿", () => {
    const i = card.indexOf("const applyAskSuccess");
    expect(i).toBeGreaterThan(0);
    const fn = card.slice(i, card.indexOf("const handleAskInFlightError", i));
    expect(fn).toContain("clearAskDrafts(task.id, askId)");
  });

  it("父组件不再在 askId effect 里 setDrafts({}) 清空——子组件挂载上报（含还原内容）会被冲掉", () => {
    expect(card).not.toContain("setDrafts({})");
    // 草稿按 askId 归属存放
    expect(card).toContain("draftState.askId === askId");
  });

  it("事件流在流这一层（不随虚拟列表卸载）按当前待答 ask 回收本任务过期草稿", () => {
    const stream = stripComments(read("components", "tasks", "event-stream.tsx"));
    expect(stream).toContain("pruneAskDrafts(task.id, pendingAskIdForDrafts)");
  });

  it("DraftScope 含 ask", () => {
    expect(stripComments(read("lib", "view-memory.ts"))).toMatch(
      /export type DraftScope = "reply" \| "talk" \| "ask"/,
    );
  });
});
