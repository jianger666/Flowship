/**
 * 群协作「AI 可见文字」的体量护栏——防止提示词无限堆积（2026-11-19，用户：「不希望提示词无限堆积」）。
 *
 * 背景：群里「谁能干什么 / 回复发哪 / 怎么沉默」的规则一度散在十几处、各写各的；每出一个 bug 就在某处补一段，
 * 补完没人删。这个文件把它们登记成一张表，给两道闸：
 *
 *  ① 体量：每个面有字节预算（= 当前实测 + 约 7% 余量）。超了**先删 / 合并**，别直接调预算；
 *     精简之后顺手把预算降下来（预算只许降；要升，请在评审里讲清为什么这段话非加不可）。
 *  ② 重复：任意两个面之间、以及与 prompts/*.md 之间，不许出现 ≥ 24 字的相同片段——共享句只写一遍，
 *     放在 group-non-owner-prompt 的 GROUP_REPLY_* / GROUP_ACK_ONLY_TEXT 里被引用（引用产生的相同片段在比较前剥掉）。
 *
 * 分三类记，因为「谁来付这笔钱」不同：
 *  - resident：每个任务会话都付（工具列表里的描述；即使从没绑过群）——最该省；
 *  - per-message：只有群消息才付，且每条都付（非属主的约束段 / 声明、所有者尾注、硬拒回话）；
 *  - per-bypass-turn：只读旁路那一轮的提示词里多出来的一句。
 *  `prompts/_super.md` 里**没有**任何群专属文字（见 tests/group-copy-wiring.test.ts），这里只给它一个整体上限。
 *
 * 基线（UTF-8 字节；HEAD = 本轮改动前已提交的版本，「—」= HEAD 里没有这个面）：
 *   面                         HEAD    本轮    说明
 *   tool.expect_group_reply    3201    2942    合并重复的占位 / 有效期 / 去重句
 *   tool.set_owner_note        1169    1499    +330：玉灵 bug 的防回归（所有者在群里的授权被当成别人的话），tests/owner-note.test.ts 钉着
 *   guard.human（开关开）      1138    1230    +92：凭据条款 + 回复去向（共享句，评审后已收紧 −12）
 *   guard.human+note（带备注）  —     1782    有所有者备注时的固定部分：+ 第 3 条例外 + 第 5 条的 pi / MCP 披露（备注原文另算）
 *   guard.bot                  1590    1576
 *   open.human（开关关）          —     856    新增：状态不能靠「缺席」表达（见 group-non-owner-prompt 文件头）；含「写备注 / 新建定时 / 操作电脑仍只听所有者」。
 *                                            802 → 856（+54，评审 b）：声明要与代码里的同权恒拒表对齐（补「新建定时 / 操作电脑」），
 *                                            并补一句「别用命令行绕开」——硬闸只管 Flowship 自己的工具，管不到 agent 自带的 shell，只能叮嘱
 *   bot.etiquette               924     920
 *   owner.note                    —     337    新增：随所有者的每条群消息（取代曾经常驻 _super.md 的 1.4KB「群消息怎么读」）；
 *                                            排队 / 回复他人消息时只带为真的半句（102B / 241B）
 *   denied                      271     183    去掉一句只对部分工具成立的括号解释
 *   restricted.sessionLine        —     285    旁路提示词一句话（上一轮曾是 915）
 *   _super.md                 38659   38659    持平：无常驻群文案
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as P from "@/lib/group-non-owner-prompt";
import { formatReplyRulesSection } from "@/lib/server/feishu-bridge/group-answer-context";
import { flowShipTools } from "@/lib/server/flowship-tools";

const root = path.resolve(import.meta.dirname, "..");
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const desc = (name: string): string => {
  const d = flowShipTools.find((t) => t.name === name)?.description;
  if (!d) throw new Error(`找不到工具 ${name}`);
  return d;
};

/** 旁路「# 边界」里讲会话的那一行（restricted-question 没有单独导出它，按源码取） */
const restrictedSessionLine = (): string => {
  const src = readFileSync(
    path.join(root, "src/lib/server/restricted-question.ts"),
    "utf-8",
  );
  const line = src
    .split("\n")
    .find((l) => l.includes("你这一路是「任务此刻没有进行中的会话」"));
  if (!line) throw new Error("找不到旁路边界里「没有进行中的会话」那一行");
  return line;
};

type Kind = "resident" | "per-message" | "per-bypass-turn";
interface Surface {
  id: string;
  kind: Kind;
  /** UTF-8 字节预算（当前实测 + 约 7%） */
  budget: number;
  text: () => string;
  /** false = 不参与重复检测（它是另一个面的超集 / 变体，比较只会产生必然的噪声） */
  dup?: boolean;
}

const SURFACES: Surface[] = [
  {
    id: "tool.expect_group_reply",
    kind: "resident",
    budget: 3100,
    text: () => desc("expect_group_reply"),
  },
  {
    id: "tool.set_owner_note",
    kind: "resident",
    budget: 1620,
    text: () => desc("set_owner_note"),
  },
  {
    id: "guard.human",
    kind: "per-message",
    budget: 1320,
    text: () => P.buildNonOwnerGuardFootnote("李四"),
  },
  {
    // 有所有者备注时多出来的固定部分（备注原文由所有者写、≤1000 字，另算）
    id: "guard.human+note",
    kind: "per-message",
    budget: 1810,
    text: () => P.buildNonOwnerGuardFootnote("李四", { ownerNote: "x" }),
    dup: false,
  },
  {
    id: "guard.bot",
    kind: "per-message",
    budget: 1700,
    text: () =>
      P.buildNonOwnerGuardFootnote("别家机器人", {
        isBot: true,
        openId: "ou_abcdef",
      }),
  },
  {
    id: "open.human",
    kind: "per-message",
    budget: 920,
    text: () => P.buildNonOwnerOpenNote("李四"),
  },
  {
    id: "bot.etiquette",
    kind: "per-message",
    budget: 990,
    text: () => P.buildBotEtiquetteNote("别家机器人", "ou_abcdef"),
  },
  {
    id: "owner.note",
    kind: "per-message",
    budget: 360,
    text: () => P.OWNER_GROUP_NOTE,
  },
  {
    id: "denied",
    kind: "per-message",
    budget: 200,
    text: () => P.buildNonOwnerToolDenied("submit_work"),
  },
  {
    id: "restricted.sessionLine",
    kind: "per-bypass-turn",
    budget: 305,
    text: restrictedSessionLine,
  },
];

/** 共享句：由同一个常量在多个面里被引用——比较前剥掉，不算重复 */
const SHARED = [P.GROUP_REPLY_WHERE, P.GROUP_REPLY_SILENCE, P.GROUP_ACK_ONLY_TEXT];

/**
 * 本来就由同一个构造函数产出的面对（模板 / 规则由同一处代码生成、测试钉死一致），不参与互相比较：
 * - guard.human × guard.bot：同一个 buildNonOwnerGuardFootnote 的两个分支；
 * - guard.bot × bot.etiquette：约束段第 4 条（机器人变体）与「同权但仍要克制」共用 buildBotEtiquetteRule。
 */
const ALLOWED_PAIRS: Array<[string, string]> = [
  ["guard.human", "guard.bot"],
  ["guard.bot", "bot.etiquette"],
];

const MIN_DUP_CHARS = 24;
/** 片段里至少要有这么多汉字才算「一句话重复」——纯工具名枚举（submit_work / submit_mr …）必须写得一样，不是复制的句子 */
const MIN_DUP_CJK = 8;
const CJK = /[\u4e00-\u9fff]/g;

const strip = (s: string): string =>
  SHARED.reduce((acc, c) => acc.split(c).join("\u0000"), s);

const gramsOf = (s: string): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + MIN_DUP_CHARS <= s.length; i++) {
    const g = s.slice(i, i + MIN_DUP_CHARS);
    if (g.includes("\u0000")) continue;
    if ((g.match(CJK)?.length ?? 0) < MIN_DUP_CJK) continue;
    out.add(g);
  }
  return out;
};

const firstCommon = (a: Set<string>, b: Set<string>): string | null => {
  for (const g of a) if (b.has(g)) return g;
  return null;
};

const promptFiles = (): Array<{ id: string; text: string }> =>
  readdirSync(path.join(root, "prompts"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      id: `prompts/${f}`,
      text: readFileSync(path.join(root, "prompts", f), "utf-8"),
    }));

describe("体量：每个群相关的 AI 可见面都在预算内（超了先删 / 合并，别直接调预算）", () => {
  for (const s of SURFACES) {
    it(`${s.id}（${s.kind}）≤ ${s.budget}B`, () => {
      const size = bytes(s.text());
      expect(
        size,
        `「${s.id}」现在 ${size}B，超过预算 ${s.budget}B。别加——先删或合并同类句；` +
          `共享句放 group-non-owner-prompt 的 GROUP_REPLY_* 里被引用，不要在别处再写一遍。` +
          `确实非加不可：把预算改大并在评审里讲清理由；精简之后记得把预算降回来。`,
      ).toBeLessThanOrEqual(s.budget);
    });
  }

  it("prompts/_super.md 整体不超过 39000B（现 38659B）：每个任务都付这笔钱，群专属内容不许往里加", () => {
    const sup = readFileSync(path.join(root, "prompts/_super.md"), "utf-8");
    expect(
      bytes(sup),
      "`_super.md` 常驻在每个任务里。要加内容先删等量旧内容；群专属的规矩放「消息自带的尾注」（OWNER_GROUP_NOTE 一类），别放这里。",
    ).toBeLessThanOrEqual(39000);
  });
});

describe("重复：共享句只写一遍", () => {
  it(`任意两个面之间、以及与 prompts/*.md 之间，没有 ≥ ${MIN_DUP_CHARS} 字的相同片段（GROUP_REPLY_* 引用已剥掉）`, () => {
    const mine = SURFACES.filter((s) => s.dup !== false).map((s) => ({
      id: s.id,
      grams: gramsOf(strip(s.text())),
    }));
    // prompts/*.md **不剥**共享句：剥了的话，把共享句整段贴进 _super.md 就查不出来了（评审）。
    // 共享句出现在 prompts 里由下面单独的用例查。
    const prompts = promptFiles().map((p) => ({
      id: p.id,
      grams: gramsOf(p.text),
    }));
    const allowed = (a: string, b: string): boolean =>
      ALLOWED_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

    const hits: string[] = [];
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i]!;
        const b = mine[j]!;
        if (allowed(a.id, b.id)) continue;
        const g = firstCommon(a.grams, b.grams);
        if (g) hits.push(`「${a.id}」×「${b.id}」：…${g}…`);
      }
      for (const p of prompts) {
        const g = firstCommon(mine[i]!.grams, p.grams);
        if (g) hits.push(`「${mine[i]!.id}」×「${p.id}」：…${g}…`);
      }
    }

    expect(
      hits,
      "这些面之间出现了相同的长片段——同一句话写了两遍，迟早漂移（这正是「提示词打架」的来源）。" +
        "合并成一处：放进 group-non-owner-prompt 的共享常量并在各处引用；或直接删掉其中一处。",
    ).toEqual([]);
  });

  it("共享句（GROUP_REPLY_* / GROUP_ACK_ONLY_TEXT）不得出现在 prompts/*.md 里——比较前剥掉了它们，所以要单独查，否则往 _super.md 里贴一份就查不出来", () => {
    const shared = SHARED.map((s) => gramsOf(s));
    for (const p of promptFiles()) {
      const grams = gramsOf(p.text);
      shared.forEach((sg, i) => {
        const hit = firstCommon(sg, grams);
        expect(
          hit,
          `${p.id} 里出现了共享句 #${i} 的片段「…${hit}…」：共享句只放 group-non-owner-prompt、随群消息走，别常驻进任何任务的提示词`,
        ).toBeNull();
      });
    }
  });

  it("prompts/*.md 里没有群消息抬头字面（群专属规矩随消息走，不常驻任何任务的提示词）", () => {
    for (const p of promptFiles()) {
      expect(p.text, `${p.id} 不该出现群消息抬头`).not.toContain("[群消息·来自");
      expect(p.text, `${p.id} 不该有「群消息怎么读」`).not.toContain("群消息怎么读");
    }
  });
});

/**
 * 共享句拼进模板时的「叠字」：GROUP_ACK_ONLY_TEXT 自己以「只是」开头，GROUP_REPLY_SILENCE 曾在它前面又加了一个，
 * 真人约束段和「限制已关」声明里于是出现「只是只是」——发给了模型，当时的测试却全绿（全量回归才发现）。
 * 这里对每个面的成品文字查「相邻重复的 2~4 字」；合法的叠词（谢谢 / 看看）是单字重复，不在这个范围里。
 */
const STUTTER = /([\u4e00-\u9fff]{2,4})\1/g;
const stutters = (s: string): string[] => [...s.matchAll(STUTTER)].map((m) => m[0]);

describe("拼接叠字：共享句拼进模板后不能出现相邻重复（曾拼出「只是只是」）", () => {
  const targets: Array<{ id: string; text: () => string }> = [
    ...SURFACES.map((s) => ({ id: s.id, text: s.text })),
    // 答疑 agent 的守则同样引用 GROUP_ACK_ONLY_TEXT / 首次招呼例外，也查一遍
    { id: "answer.rules(真人)", text: () => formatReplyRulesSection({ requesterIsBot: false }).join("\n") },
    { id: "answer.rules(机器人)", text: () => formatReplyRulesSection({ requesterIsBot: true }).join("\n") },
  ];
  for (const t of targets) {
    it(`${t.id} 没有相邻重复的 2~4 字`, () => {
      expect(
        stutters(t.text()),
        `「${t.id}」里有叠字——多半是共享常量自带的开头 / 结尾，被模板又写了一遍`,
      ).toEqual([]);
    });
  }
});

describe("检测器自检：别让「重复检测」悄悄退化成永远不报的摆设", () => {
  it("叠字检测：「只是只是」能检出，「谢谢」「看看」这类单字叠词不算", () => {
    expect(stutters("对方没问任何问题、只是只是「收到」「好的」")).toEqual(["只是只是"]);
    expect(stutters("「收到」「好的」「谢谢」这类确认；看看就行")).toEqual([]);
  });

  const sentence = "任务所有者本人不在场时，别替他拍板任何需要确认的事项"; // 25 个汉字量级的一整句
  it("复制了一整句 → 能检出", () => {
    const a = gramsOf(strip(`前缀甲。${sentence}。后缀甲`));
    const b = gramsOf(strip(`别的开头。${sentence}。别的结尾`));
    expect(firstCommon(a, b)).not.toBeNull();
  });

  it("只共享工具名枚举 → 不算（名字必须写得一样）", () => {
    const a = gramsOf(strip("甲：不调用 submit_work / submit_mr / ask_user / schedule 这些"));
    const b = gramsOf(strip("乙：禁止 submit_work / submit_mr / ask_user / schedule 之类"));
    expect(firstCommon(a, b)).toBeNull();
  });

  it("共享句（GROUP_REPLY_WHERE 等常量）被引用 → 剥掉后不算重复", () => {
    const a = gramsOf(strip(`甲开头。${P.GROUP_REPLY_WHERE}甲结尾。`));
    const b = gramsOf(strip(`乙开头。${P.GROUP_REPLY_WHERE}乙结尾。`));
    expect(firstCommon(a, b)).toBeNull();
  });

  it("反例：共享句被整段贴进别处（比如 _super.md）→ 单独那个检查能抓到（比较前剥共享句时它是漏的）", () => {
    const pasted = `一段无关的话。${P.GROUP_REPLY_WHERE}另一段无关的话。`;
    expect(firstCommon(gramsOf(P.GROUP_REPLY_WHERE), gramsOf(pasted))).not.toBeNull();
    // 对照：剥掉后确实什么都不剩——这就是「只比剥过的」会漏的原因
    expect(firstCommon(gramsOf(strip(P.GROUP_REPLY_WHERE)), gramsOf(strip(pasted)))).toBeNull();
  });

  it("太短的相同词组（< 24 字）不算", () => {
    const a = gramsOf("只答疑：能读文件、搜代码、答问题，别的都不行啊");
    const b = gramsOf("他说只答疑：能读文件、搜代码，还说了别的完全不同的话");
    expect(firstCommon(a, b)).toBeNull();
  });
});

describe("登记表自检：新增群相关面必须登记在这里", () => {
  it("group-non-owner-prompt 的每个「构造文字」导出都已登记（新增导出却忘了登记 = 绕过预算）", () => {
    // 这些导出是**文字构造器 / 文字常量**；设置页预览常量是它们的别名，开关 / 白名单不是文字
    const registered = new Set([
      "buildNonOwnerGuardFootnote",
      "buildNonOwnerOpenNote",
      "buildBotEtiquetteNote",
      "OWNER_GROUP_NOTE",
      // 所有者尾注的构造器：两个半句各自按需带，任何变体都是全量形态（OWNER_GROUP_NOTE，已登记）的子集，不会比它长
      "buildOwnerGroupNote",
      "buildNonOwnerToolDenied",
      // 共享句：作为 SHARED 剥离、各自有预算无意义（它们已经算进引用它们的面里）
      "GROUP_REPLY_WHERE",
      "GROUP_REPLY_SILENCE",
      "GROUP_ACK_ONLY_TEXT",
      // 抬头 / 例外句 / 别名：短小或是别名，不单独记
      "buildNonOwnerGroupHeader",
      "buildBotFirstGreetingException",
      "GROUP_NON_OWNER_GUARD_PROMPT_PREVIEW",
      "GROUP_NON_OWNER_OPEN_NOTE_PREVIEW",
      // 非文字
      "GROUP_NON_OWNER_GUARD_DEFAULT",
      "GROUP_BOTS_EQUAL_RIGHTS_DEFAULT",
      "NON_OWNER_TURN_ALLOWED_TOOLS",
    ]);
    const unregistered = Object.keys(P).filter((k) => !registered.has(k));
    expect(
      unregistered,
      `group-non-owner-prompt 新增了导出 ${unregistered.join(", ")}：如果它是给 AI 看的文字，请登记进 SURFACES 并给预算；` +
        `如果不是，把它加进本用例的 registered 名单。`,
    ).toEqual([]);
  });
});
