/**
 * 事件流「回合节奏」纯函数（lib/event-stream-rhythm）的行为约束。
 *
 * 用户 2026-10-12 反馈「右边时间流每条之间看着都没间隔了、分辨力太低」。实测旧数值下
 * 组内（说话 → 工作过程）19px、组间（工作过程 → 下一条说话）27px，比值 1.42，整列几乎等距。
 * 所以这里不只钉具体数值，还钉**档与档之间的关系**——数值以后可以调，
 * 但「组间必须明显大于组内」「chat 与 task 一致」这两条不能被调没了。
 */
import { describe, expect, it } from "vitest";

import {
  RHYTHM_GROUP_DIVIDER_TOP,
  rhythmPaddingBottom,
  rhythmPaddingTop,
  rhythmShowsGroupDivider,
  rhythmTier,
  type RhythmFacts,
  type RhythmTier,
  type RhythmVariant,
} from "@/lib/event-stream-rhythm";

const TALK: RhythmFacts = { talk: true, process: false };
const PROCESS: RhythmFacts = { talk: false, process: true };
const CARD: RhythmFacts = { talk: false, process: false };
/** AI 平铺正文（对话类、无框无底色） */
const AI_TEXT: RhythmFacts = { talk: true, process: false, aiText: true };
/** 用户这一侧的话（气泡 / 待发送 / 提问卡：对话类、自带底色或边框） */
const USER_SIDE: RhythmFacts = { talk: true, process: false, userSide: true };

/** Tailwind 间距类 → px（一个单位 4px：pt-0.5 = 2px、pt-7 = 28px） */
const px = (cls: string): number => {
  const m = /^p[tb]-(\d+(?:\.\d+)?)$/.exec(cls);
  if (!m) throw new Error(`不是间距类：${cls}`);
  return Number(m[1]) * 4;
};

const VARIANTS: RhythmVariant[] = ["chat", "log"];

describe("rhythmTier：节奏档判定", () => {
  it("列表第一条永远是 first——不管它是对话、过程还是卡片（它没有上文、只管离顶部的呼吸）", () => {
    for (const item of [TALK, PROCESS, CARD]) {
      expect(rhythmTier(0, item, null)).toBe("first");
    }
  });

  it("对话类永远是 conversation——不管上一条是什么（一段新的话 = 一个新的组）", () => {
    for (const prev of [TALK, PROCESS, CARD, null]) {
      expect(rhythmTier(3, TALK, prev)).toBe("conversation");
    }
  });

  it("紧跟对话后的过程行 = process-after-talk，紧跟对话后的卡片 = card-after-talk（卡片自带边框、不能像过程行那样贴着上文）", () => {
    expect(rhythmTier(2, PROCESS, TALK)).toBe("process-after-talk");
    expect(rhythmTier(2, CARD, TALK)).toBe("card-after-talk");
  });

  it("上一条不是对话：过程行 / 卡片都是连续堆叠的 process 档", () => {
    for (const prev of [PROCESS, CARD]) {
      expect(rhythmTier(2, PROCESS, prev)).toBe("process");
      expect(rhythmTier(2, CARD, prev)).toBe("process");
    }
  });

  it("没有上一条（只会出现在 index 0 以外的脏输入里）：非对话按 process 处理、不崩", () => {
    expect(rhythmTier(2, PROCESS, null)).toBe("process");
    expect(rhythmTier(2, CARD, null)).toBe("process");
  });
});

describe("rhythmPaddingTop / rhythmPaddingBottom：数值钉住", () => {
  it("first：chat 窄列居中给足呼吸（pt-6）、log 小一档（pt-4）", () => {
    expect(rhythmPaddingTop("chat", "first")).toBe("pt-6");
    expect(rhythmPaddingTop("log", "first")).toBe("pt-4");
  });

  it("对话 pt-7（28px）、紧跟对话的过程行 pt-1（4px）、紧跟对话的卡片 pt-2（8px）、连续过程行 pt-0.5（2px）", () => {
    for (const variant of VARIANTS) {
      expect(rhythmPaddingTop(variant, "conversation")).toBe("pt-7");
      expect(rhythmPaddingTop(variant, "process-after-talk")).toBe("pt-1");
      expect(rhythmPaddingTop(variant, "card-after-talk")).toBe("pt-2");
      expect(rhythmPaddingTop(variant, "process")).toBe("pt-0.5");
    }
  });

  it("最后一条的底部留白：chat pb-6、log pb-4", () => {
    expect(rhythmPaddingBottom("chat")).toBe("pb-6");
    expect(rhythmPaddingBottom("log")).toBe("pb-4");
  });
});

describe("档与档之间的关系：别让整列又变回等距", () => {
  it("层级严格递减：对话 > 卡片 > 紧跟对话的过程行 > 连续过程行……", () => {
    for (const variant of VARIANTS) {
      const conv = px(rhythmPaddingTop(variant, "conversation"));
      const card = px(rhythmPaddingTop(variant, "card-after-talk"));
      const afterProcess = px(rhythmPaddingTop(variant, "process-after-talk"));
      const process = px(rhythmPaddingTop(variant, "process"));
      expect(conv).toBeGreaterThan(card);
      expect(card).toBeGreaterThan(afterProcess);
      expect(afterProcess).toBeGreaterThan(process);
    }
  });

  it("组间（对话档）至少是组内（紧跟对话的过程行）的 5 倍——旧数值只有 2 倍（16 / 8），整列几乎等距", () => {
    for (const variant of VARIANTS) {
      const between = px(rhythmPaddingTop(variant, "conversation"));
      const within = px(rhythmPaddingTop(variant, "process-after-talk"));
      expect(between / within).toBeGreaterThanOrEqual(5);
    }
  });

  it("组内别压死：紧跟对话的过程行至少留 4px（贴死会读成上一段话的脚注残片）", () => {
    for (const variant of VARIANTS) {
      expect(
        px(rhythmPaddingTop(variant, "process-after-talk")),
      ).toBeGreaterThanOrEqual(4);
    }
  });

  it("chat 与 task(log) 除了首条，每一档数值都一样（用户拍板「task 和 chat 保持一致」）", () => {
    const shared: RhythmTier[] = [
      "conversation",
      "process-after-talk",
      "card-after-talk",
      "process",
    ];
    for (const tier of shared) {
      expect(rhythmPaddingTop("chat", tier)).toBe(rhythmPaddingTop("log", tier));
    }
    // 首条：形态不同才不同
    expect(rhythmPaddingTop("chat", "first")).not.toBe(
      rhythmPaddingTop("log", "first"),
    );
  });

  it("每档返回的都是 Tailwind 的 padding-top 整串（拼接出来的类名不会被生成 CSS）", () => {
    const tiers: RhythmTier[] = [
      "first",
      "conversation",
      "process-after-talk",
      "card-after-talk",
      "process",
    ];
    for (const variant of VARIANTS) {
      for (const tier of tiers) {
        expect(rhythmPaddingTop(variant, tier)).toMatch(/^pt-\d+(\.\d+)?$/);
      }
      expect(rhythmPaddingBottom(variant)).toMatch(/^pb-\d+(\.\d+)?$/);
    }
  });
});

describe("rhythmShowsGroupDivider：AI 新一段话的开头画渐隐细线（留白之外再给一个分界）", () => {
  /** 按真实调用方式：先算档、再问要不要画线 */
  const divider = (
    index: number,
    item: RhythmFacts,
    prev: RhythmFacts | null,
  ): boolean => rhythmShowsGroupDivider(rhythmTier(index, item, prev), item, prev);

  it("AI 回复接在过程行 / 卡片 / 上一段 AI 话后面：画线（这是「新的一组」的开头）", () => {
    for (const prev of [PROCESS, CARD, AI_TEXT]) {
      expect(divider(3, AI_TEXT, prev)).toBe(true);
    }
  });

  it("AI 回复紧跟用户这一侧的话（气泡 / 待发送 / 提问卡）：不画线——一问一答是同一组，不能被线劈开", () => {
    expect(divider(3, AI_TEXT, USER_SIDE)).toBe(false);
  });

  it("列表第一条不画线（没有上文，档是 first）", () => {
    expect(divider(0, AI_TEXT, null)).toBe(false);
  });

  it("用户气泡 / 提问卡自己不画线：它们自带底色或边框，本来就是醒目的锚点", () => {
    for (const prev of [PROCESS, CARD, AI_TEXT]) {
      expect(divider(3, USER_SIDE, prev)).toBe(false);
    }
  });

  it("过程行 / 卡片不画线：它们属于上一段话的「组内」，线只切组间", () => {
    for (const item of [PROCESS, CARD]) {
      for (const prev of [TALK, AI_TEXT, PROCESS]) {
        expect(divider(3, item, prev)).toBe(false);
      }
    }
  });

  it("没标 aiText / userSide 的对话类（旧调用方 / 其它对话）保守地不画线：宁可少画、不能错画", () => {
    expect(divider(3, TALK, PROCESS)).toBe(false);
    expect(divider(3, TALK, TALK)).toBe(false);
  });

  it("线落在对话档留白的正中：top 偏移 = 对话档 padding-top 的一半（改一个必须改另一个）", () => {
    const top = px(RHYTHM_GROUP_DIVIDER_TOP.replace(/^top-/, "pt-"));
    for (const variant of VARIANTS) {
      expect(top * 2).toBe(px(rhythmPaddingTop(variant, "conversation")));
    }
    expect(RHYTHM_GROUP_DIVIDER_TOP).toMatch(/^top-\d+(\.\d+)?$/);
  });
});
