/**
 * 第六轮 review（A0 / H1-01 / H1-02 / H1-04）：群答疑回复协议的复核回归。
 *
 * - A0   提示词与代码对「自动 @ 提问人」的口径一致（以代码为准、改提示词）
 * - H1-01 代码围栏判定在「首行超长且没有闭合」的输入上是二次方
 * - H1-02 「需属主确认」标记要容忍写法变体；未闭合标记只在同段内找闭合
 * - H1-04 哨兵词判定：先 NFKC + 去零宽；反引号 / 引号包住的哨兵词后面还有正文时是在「解释哨兵词」
 *
 * 性能一律用「n → 2n 的耗时比」（见 tests/helpers/scaling-ratio.ts），不用绝对耗时阈值。
 */
import { describe, expect, it } from "vitest";

import type { GroupMember } from "@/lib/server/feishu-bridge/group-contract";
import {
  buildGroupReplyRules,
  parseGroupReply,
  stripNeedsOwnerMarkers,
  unwrapCodeFence,
  type ParseGroupReplyCtx,
} from "@/lib/server/feishu-bridge/group-reply-protocol";

import { doublingRatio, LINEAR_RATIO_MAX } from "./helpers/scaling-ratio";

const tag = (id: string, name: string) => `<at user_id="${id}">${name}</at>`;

const members: GroupMember[] = [
  { openId: "ou_owner", name: "曾进有", kind: "user" },
  { openId: "ou_zhang", name: "张三", kind: "user" },
  { openId: "ou_an", name: "李安", kind: "user" },
  { openId: "ou_anruo", name: "安若流年", kind: "bot" },
  { openId: "ou_self", name: "Flowship机器人", kind: "bot" },
  { openId: "ou_d1", name: "王五", kind: "user" },
  { openId: "ou_d2", name: "王五", kind: "user" },
];

const human = { openId: "ou_zhang", name: "张三", isBot: false };
const bot = { openId: "ou_anruo", name: "安若流年", isBot: true };

const mk = (over: Partial<ParseGroupReplyCtx> = {}): ParseGroupReplyCtx => ({
  members,
  owner: { openId: "ou_owner", name: "曾进有" },
  requester: human,
  selfOpenId: "ou_self",
  ...over,
});

const SILENT = { kind: "silent", text: "", mentions: [], unresolvedAts: [] };

// ---------------------------------------------------------------------------
// A0 · 提示词与代码对「自动 @ 提问人」的口径
// ---------------------------------------------------------------------------

describe("A0 · buildGroupReplyRules 的 @ 口径与代码一致", () => {
  const rules = (requesterIsBot: boolean) =>
    buildGroupReplyRules({ requesterIsBot }).join("\n");

  it("真人提问：写明「正文已 @ 了别人就不再自动 @ 他，想让他也收到提醒就自己 @」", () => {
    const h = rules(false);
    // 原有承诺保留：正文没写 @ 时系统会自动 @
    expect(h).toContain("系统会自动 @ 他");
    // 新增的条件与出路
    expect(h).toContain("只要正文里已经 @ 了别人");
    expect(h).toContain("不会再自动 @ 他");
    expect(h).toContain("自己在正文里写 `@他的名字`");
  });

  it("机器人提问：不承诺自动 @（代码也从不给机器人补 @）", () => {
    const b = rules(true);
    expect(b).not.toContain("系统会自动 @ 他");
    expect(b).not.toContain("不会再自动 @ 他");
    expect(b).toContain("必须在正文里写");
  });

  it("两种提问方都写明：不要手写 <at> 标签、直接写 @名字", () => {
    for (const isBot of [true, false]) {
      const all = rules(isBot);
      expect(all, `isBot=${isBot}`).toContain("不要手写 `<at ...>` 标签");
      expect(all, `isBot=${isBot}`).toContain("直接写 `@名字`");
    }
  });

  describe("行为与措辞一致（提问人是真人）：正文有「真 @」→ 不自动补；没有 → 补", () => {
    const requesterTag = tag("ou_zhang", "张三");
    // [原文, 真 @ 到的人]：提问人（ou_zhang）都不该是「系统补的」
    const noAuto: Record<string, [string, string[]]> = {
      "@ 了别人（名字）": ["这个问 @李安 吧", ["ou_an"]],
      "@宿主（属主别名）": ["这个得问 @宿主", ["ou_owner"]],
      "手写可信 id 的标签": [`这个问 ${tag("ou_an", "李安")} 吧`, ["ou_an"]],
      "@ 了提问人自己（本来就在正文里，只出现一次）": ["@张三 可以", ["ou_zhang"]],
    };
    for (const [name, [raw, ids]] of Object.entries(noAuto)) {
      it(`不补：${name}`, () => {
        const r = parseGroupReply(raw, mk());
        expect(r.mentions.map((m) => m.openId)).toEqual(ids);
        const requesterTags = r.text.split(requesterTag).length - 1;
        expect(requesterTags).toBe(ids.includes("ou_zhang") ? 1 : 0);
      });
    }

    const autoAt: Record<string, string> = {
      "只有认不出的 @xxx": "@路人 好",
      "@ 了本机机器人自己": "@Flowship机器人 在的",
      "邮箱里的 @": "发到 a@example.com 就行",
      "重名歧义（不 @）": "@王五 看下",
      "未知 id 的手写标签（退化成纯文本）": `${tag("ou_fake", "某人")} 请看`,
    };
    for (const [name, raw] of Object.entries(autoAt)) {
      it(`照补：${name}`, () => {
        const r = parseGroupReply(raw, mk());
        expect(r.text.startsWith(`${requesterTag} `)).toBe(true);
        expect(r.mentions.map((m) => m.openId)).toEqual(["ou_zhang"]);
      });
    }

    it("属主确认行里系统补的 @ 不算「正文里的 @」：提问人照补（确认行在补 @ 之前不计）", () => {
      const r = parseGroupReply("先这样\n[[需属主确认：要不要上线]]", mk());
      expect(r.mentions.map((m) => m.openId)).toEqual(["ou_zhang", "ou_owner"]);
    });

    it("机器人提问：正文即使 @ 了别人，也不会替它补 @（与提示词「必须自己写」一致）", () => {
      const r = parseGroupReply("这个问 @李安 吧", mk({ requester: bot }));
      expect(r.mentions.map((m) => m.openId)).toEqual(["ou_an"]);
      const r2 = parseGroupReply("结论：可以", mk({ requester: bot }));
      expect(r2.mentions).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// H1-01 · FENCE_RE
// ---------------------------------------------------------------------------

describe("H1-01 · 代码围栏判定：首行超长且没有闭合时线性", () => {
  const variants: Record<string, (n: number) => string> = {
    "```+超长首行（无换行、无闭合）": (n) => `\`\`\`${"a".repeat(n)}`,
    "```+超长首行+一行正文（无闭合）": (n) => `\`\`\`${"a".repeat(n)}\nb`,
    "```+超长首行+多行（结尾多一个空格，所以不闭合）": (n) =>
      `\`\`\`${"a".repeat(n)}\nline\n\`\`\` `,
    "```+超长首行，结尾恰是 ```（闭合的单行围栏）": (n) =>
      `\`\`\`${"a".repeat(n)}\`\`\``,
  };
  for (const [name, build] of Object.entries(variants)) {
    it(`${name}：n → 2n 耗时比 < ${LINEAR_RATIO_MAX}`, () => {
      const ratio = doublingRatio((n) => {
        const raw = build(n);
        return () => parseGroupReply(raw, mk({ requester: bot }));
      }, 20_000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
    });
  }

  it("语义不变：包住整段 NO_REPLY 的各种代码围栏仍是哨兵", () => {
    for (const raw of [
      "```\nNO_REPLY\n```",
      "```text\nNO_REPLY\n```",
      "```\n\nNO_REPLY\n\n```",
      "  ```\nNO_REPLY\n```  ",
      "```\n`NO_REPLY`\n```",
      "```\n```\nNO_REPLY\n```\n```",
    ]) {
      expect(parseGroupReply(raw, mk()), JSON.stringify(raw)).toEqual(SILENT);
    }
  });

  it("单行围栏 ```NO_REPLY``` 也是「整段只是被围栏包住的哨兵」→ 静默（旧正则把它当成 info string、原样发群）", () => {
    expect(parseGroupReply("```NO_REPLY```", mk())).toEqual(SILENT);
    expect(parseGroupReply("```NO_REPLY。```", mk())).toEqual(SILENT);
  });

  describe("unwrapCodeFence 与旧正则逐例对拍（固定种子随机小输入）", () => {
    const OLD = /^```[^\n]*\n?([\s\S]*?)\n?```$/;
    const pieces = ["```", "`", "``", "\n", "\n\n", "a", "NO_REPLY", " ", "text", "\r"];
    const rng = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    it("围栏内容含换行 / 不匹配的输入：结果与旧正则完全一致", () => {
      const rand = rng(61);
      const pick = () => pieces[Math.floor(rand() * pieces.length)];
      let matchedWithNewline = 0;
      let notMatched = 0;
      for (let n = 0; n < 6000; n++) {
        let s = "";
        const len = Math.floor(rand() * 9);
        for (let k = 0; k < len; k++) s += pick();
        // 七成输入强制「头尾都是 ```」，否则绝大多数随机串根本不是围栏、对拍没有意义
        if (rand() < 0.7) s = `\`\`\`${s}\`\`\``;
        const m = OLD.exec(s);
        const expected = m ? (m[1] ?? "") : null;
        // 唯一有意的差异：围栏里没有换行（单行 ```x```）时，旧正则把 x 当 info string、内容 ""，
        // 新实现返回 x——见下一条用例与 unwrapCodeFence 的注释
        if (m && !s.slice(3, -3).includes("\n")) continue;
        if (m) matchedWithNewline++;
        else notMatched++;
        expect(unwrapCodeFence(s), JSON.stringify(s)).toBe(expected);
      }
      expect(matchedWithNewline).toBeGreaterThan(800);
      expect(notMatched).toBeGreaterThan(300);
    });

    it("单行围栏：返回围栏之间的内容（旧正则是 \"\"）", () => {
      expect(unwrapCodeFence("```NO_REPLY```")).toBe("NO_REPLY");
      expect(unwrapCodeFence("``````")).toBe("");
      expect(unwrapCodeFence("```a```")).toBe("a");
      expect(unwrapCodeFence("```a``")).toBeNull();
      expect(unwrapCodeFence("a```b```")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// H1-02 · 属主确认标记变体
// ---------------------------------------------------------------------------

describe("H1-02 · 「需属主确认」标记容忍写法变体", () => {
  const ownerLine = (explain: string) =>
    `${tag("ou_owner", "曾进有")} 需要你确认：${explain}`;

  const closedVariants: Record<string, string> = {
    标准写法: "[[需属主确认：接口是否分页]]",
    半角冒号: "[[需属主确认:接口是否分页]]",
    全角空格加冒号: "[[需属主确认\u3000：接口是否分页]]",
    冒号前半角空格: "[[需属主确认 ：接口是否分页]]",
    冒号前后都有空白: "[[需属主确认 \u3000： 接口是否分页 ]]",
    括号后有空白: "[[ 需属主确认：接口是否分页]]",
    括号后有全角空格: "[[\u3000需属主确认：接口是否分页]]",
    制表符: "[[\t需属主确认\t:\t接口是否分页]]",
    方头括号变体: "【需属主确认：接口是否分页】",
    方头括号加空白: "【 需属主确认\u3000: 接口是否分页 】",
  };
  for (const [name, mark] of Object.entries(closedVariants)) {
    it(`识别并落地：${name}`, () => {
      const r = parseGroupReply(`这个要宿主确认，已转告\n${mark}`, mk({ requester: bot }));
      expect(r.kind).toBe("send");
      expect(r.needsOwner).toBe("接口是否分页");
      expect(r.text).toBe(`这个要宿主确认，已转告\n${ownerLine("接口是否分页")}`);
      expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
      expect(r.text).not.toMatch(/需属主确认|\[\[|【/);
    });
  }

  // 第七轮 K4-11：这里原来拿契约里的 `GROUP_NEEDS_OWNER_RE` 对拍「[[ ]] 空白变体的口径」，那条正则已删除（生产无调用方、
  // 对长文本是二次型）。同样的语义改走真实的解析入口 `stripNeedsOwnerMarkers`：每种变体单独成条时整条被识别为一个标记、
  // 说明取对、剥完不剩任何字符。
  it("每种写法变体单独成条：stripNeedsOwnerMarkers 识别为一个标记、取出说明、剥完无剩余", () => {
    for (const [name, mark] of Object.entries(closedVariants)) {
      const explains: string[] = [];
      const r = stripNeedsOwnerMarkers(mark, (e) => explains.push(e));
      expect(r.found, name).toBe(true);
      expect(explains.map((e) => e.trim()), name).toEqual(["接口是否分页"]);
      expect(r.text, name).toBe("");
    }
  });

  it("括号按族配对：[[…]] 里可以有【】、【…】里可以有 [[ ]]", () => {
    const a = parseGroupReply("ok\n[[需属主确认：【排课】接口是否分页]]", mk({ requester: bot }));
    expect(a.needsOwner).toBe("【排课】接口是否分页");
    const b = parseGroupReply("ok\n【需属主确认：看 [[x]] 这段再定】", mk({ requester: bot }));
    expect(b.needsOwner).toBe("看 [[x]] 这段再定");
  });

  it("只是普通的【…】小标题 / 没有冒号 / 关键词不全：不是标记，原样保留", () => {
    for (const raw of [
      "【需属主确认】请看",
      "【属主确认：x】",
      "[[需属主：x]]",
      "【需属主确认 x】",
    ]) {
      const r = parseGroupReply(raw, mk({ requester: bot }));
      expect(r.kind, raw).toBe("send");
      expect(r.text, raw).toBe(raw);
      expect(r.needsOwner, raw).toBeUndefined();
    }
  });

  describe("未闭合标记只在同段内找闭合", () => {
    it("后面隔着空行的无关 ]] 不能当闭合：说明只取到行尾，后文（含那个 ]]）原样保留", () => {
      const r = parseGroupReply(
        "[[需属主确认：要不要上线\n\n后面的无关段落 a]] b\n另一段 c",
        mk({ requester: bot }),
      );
      expect(r.needsOwner).toBe("要不要上线");
      expect(r.text).toBe(`后面的无关段落 a]] b\n另一段 c\n${ownerLine("要不要上线")}`);
    });

    it("空行的几种写法：\\n\\n / \\r\\n\\r\\n / 只含空白的行 / 全角空格行，都算段落边界", () => {
      for (const gap of ["\n\n", "\r\n\r\n", "\n  \n", "\n\u3000\n", "\n\t\n"]) {
        const r = parseGroupReply(
          `[[需属主确认：要不要上线${gap}后文 x]] y`,
          mk({ requester: bot }),
        );
        expect(r.needsOwner, JSON.stringify(gap)).toBe("要不要上线");
        expect(r.text, JSON.stringify(gap)).toContain("后文 x]] y");
      }
    });

    it("同一段内跨行的闭合照旧有效（说明可以多行）", () => {
      const r = parseGroupReply(
        "ok\n[[需属主确认：第一行\n第二行]]\n尾巴",
        mk({ requester: bot }),
      );
      expect(r.needsOwner).toBe("第一行 第二行");
      expect(r.text).toContain("尾巴");
    });

    it("前一段的标记不闭合、后一段有自己完整的标记：各自独立，取第一条说明", () => {
      const r = parseGroupReply(
        "[[需属主确认：第一条\n\n正文\n[[需属主确认：第二条]]",
        mk({ requester: bot }),
      );
      expect(r.needsOwner).toBe("第一条");
      expect(r.text).toBe(`正文\n${ownerLine("第一条")}`);
    });

    it("方头括号未闭合：取到行尾；残留的 ] / 】 不进说明", () => {
      const a = parseGroupReply("ok\n【需属主确认：口径", mk({ requester: bot }));
      expect(a.needsOwner).toBe("口径");
      const b = parseGroupReply("ok\n【需属主确认：口径]]", mk({ requester: bot }));
      expect(b.needsOwner).toBe("口径");
      const c = parseGroupReply("ok\n[[需属主确认：口径】", mk({ requester: bot }));
      expect(c.needsOwner).toBe("口径");
    });

    it("单行标记仍照旧取到行尾（未闭合）", () => {
      const r = parseGroupReply(
        "结论 A\n[[需属主确认:要不要上线\n后面还有一行正文",
        mk({ requester: bot }),
      );
      expect(r.needsOwner).toBe("要不要上线");
      expect(r.text).toContain("后面还有一行正文");
    });
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量未闭合标记、同一段（每行一个）": (n) => "[[需属主确认：x\n".repeat(n),
      "大量未闭合标记 + 很远处另一段里的 ]]": (n) => `${"[[需属主确认：x\n".repeat(n)}\n\n]]`,
      "大量未闭合的方头括号标记（同一行）": (n) => "【需属主确认：".repeat(n),
      "大量未闭合标记、每段一个": (n) => "[[需属主确认：x\n\n".repeat(n),
      "括号后的超长空白": (n) => `[[${" ".repeat(n * 8)}x`,
      "未闭合说明里一长串 ]": (n) => `【需属主确认：${"]".repeat(n * 8)}x`,
      "未闭合说明里一长串 ]（以空白结尾）": (n) => `【需属主确认：${"]".repeat(n * 8)} x ]`,
      // 末尾有 ]]：先找到闭合，再去判断它前面有没有空行——这条路径要扫「\n + 空白」
      "每行一个换行 + 一小段空白（找空行时的扫描）": (n) =>
        `[[需属主确认：${"a\n          ".repeat(n)}]]`,
      "大量闭合标记": (n) => "[[需属主确认：x]] y\n".repeat(n),
      "大量方头括号闭合标记": (n) => "【需属主确认：x】 y\n".repeat(n),
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk({ requester: bot }));
        }, 8000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// H1-04 · 哨兵词判定
// ---------------------------------------------------------------------------

describe("H1-04 · 哨兵词先 NFKC + 去零宽再判", () => {
  const silentCases: Record<string, string> = {
    全角字母下划线: "ＮＯ＿ＲＥＰＬＹ",
    全角小写: "ｎｏ＿ｒｅｐｌｙ",
    零宽空格夹在中间: "NO\u200b_REPLY",
    零宽非连字符: "NO_\u200cREPLY",
    零宽连字符: "N\u200dO_REPLY",
    WORD_JOINER: "NO\u2060_REPLY",
    BOM夹在中间: "NO_\uFEFFREPLY",
    软连字符: "NO_RE\u00adPLY",
    零宽在首尾: "\u200b\u200bNO_REPLY\u200b",
    零宽夹在末尾标点前: "NO_REPLY\u200b。",
    全角加粗: "**ＮＯ＿ＲＥＰＬＹ**",
    全角反引号包住: "｀NO_REPLY｀",
    全角引号包住: "＂NO_REPLY＂",
    "全角 + 零宽 + 围栏": "```\nＮＯ\u200b＿ＲＥＰＬＹ\n```",
    首行是全角哨兵_后面是解释: "ＮＯ＿ＲＥＰＬＹ\n对方只是在确认",
    首行是零宽哨兵带括号说明: "NO\u200b_REPLY（对方只是确认）",
  };
  for (const [name, raw] of Object.entries(silentCases)) {
    it(`silent：${name}`, () => {
      for (const requester of [human, bot]) {
        expect(parseGroupReply(raw, mk({ requester })), JSON.stringify(raw)).toEqual(SILENT);
      }
    });
  }

  it("夹在正文里单独成行的全角 / 零宽哨兵：只剔那一行", () => {
    const a = parseGroupReply("第一段\nＮＯ＿ＲＥＰＬＹ\n第二段", mk({ requester: bot }));
    expect(a.text).toBe("第一段\n第二段");
    const b = parseGroupReply("第一段\nNO\u200b_REPLY（不用回）\n第二段", mk({ requester: bot }));
    expect(b.text).toBe("第一段\n第二段");
  });

  it("不是哨兵的不误杀，且发出去的是原文（不是归一化后的文本）", () => {
    for (const raw of [
      "ＮＯ＿ＲＥＰＬＹ＿ＦＯＯ 是个变量名",
      "NO\u200b_REPLYING 不是哨兵",
      "好的 ＮＯ＿ＲＥＰＬＹ 吧",
    ]) {
      const r = parseGroupReply(raw, mk({ requester: bot }));
      expect(r.kind, raw).toBe("send");
      expect(r.text, raw).toBe(raw);
    }
  });
});

describe("H1-04 · 反引号 / 引号包住的哨兵词 + 后面还有正文 = 在解释哨兵词，不当哨兵", () => {
  const body = "接口是 /a/b，参数 x 必填。";

  it("首行是反引号包住的 `NO_REPLY`、后面跟一大段正常答复：正文照发（哨兵行本身剔掉）", () => {
    const r = parseGroupReply(`\`NO_REPLY\`\n${body}`, mk({ requester: bot }));
    expect(r.kind).toBe("send");
    expect(r.text).toBe(body);
  });

  it("引号包住 + 首行之后才是正文（各种引号）", () => {
    for (const q of [['"', '"'], ["“", "”"], ["「", "」"], ["'", "'"], ["`", "`"]]) {
      const r = parseGroupReply(`${q[0]}NO_REPLY${q[1]}\n\n${body}`, mk({ requester: bot }));
      expect(r.kind, q.join("")).toBe("send");
      expect(r.text, q.join("")).toBe(body);
    }
  });

  it("同一行：反引号包住的哨兵词 + 逗号 / 冒号 / 破折号 + 正文 → 整行是正文、原样发", () => {
    for (const raw of [
      `\`NO_REPLY\`，不过这条我还是答一下：${body}`,
      `"NO_REPLY"：这是哨兵词，意思是不回复。但这里要答：${body}`,
      `“NO_REPLY” - 本来该静默，但是${body}`,
      `**\`NO_REPLY\`**（本来该静默）${body}`,
    ]) {
      const r = parseGroupReply(raw, mk({ requester: bot }));
      expect(r.kind, raw).toBe("send");
      expect(r.text, raw).toBe(raw);
    }
  });

  it("夹在正文中间：被反引号 / 引号包住的哨兵词后面跟着正文的行不再被剔（是在解释），其余哨兵行照旧剔", () => {
    const mid = (line: string) =>
      parseGroupReply(`第一段\n${line}\n第二段`, mk({ requester: bot })).text;
    // 在解释：整行保留
    for (const line of [
      "`NO_REPLY`：这是哨兵词，意思是不回复",
      '"NO_REPLY" - 本来该静默',
      "`NO_REPLY`，但是这里要答",
      "`NO_REPLY`（本来该静默）但这里还是答了",
    ]) {
      expect(mid(line), line).toBe(`第一段\n${line}\n第二段`);
    }
    // 照旧剔：裸写 / 加粗 + 说明；纯哨兵行（含反引号）；只带一对括号说明的标注型
    for (const line of [
      "NO_REPLY（不用回）",
      "**NO_REPLY**（不用回）",
      "NO_REPLY：不用回",
      "`NO_REPLY`",
      '"NO_REPLY。"',
      "`NO_REPLY`（不用回）",
    ]) {
      expect(mid(line), line).toBe("第一段\n第二段");
    }
  });

  it("哨兵词夹在句子里解释（这类本来就没被吞，钉住别回退）", () => {
    const raw = `按规矩这里应该回 \`NO_REPLY\`，但我觉得还是答一下：${body}`;
    const r = parseGroupReply(raw, mk({ requester: bot }));
    expect(r.kind).toBe("send");
    expect(r.text).toBe(raw);
  });

  describe("边界：整段回复除包裹符号外就是哨兵词 → 仍是哨兵（现有行为不变）", () => {
    const stillSilent: Record<string, string> = {
      反引号: "`NO_REPLY`",
      "反引号 + 句号": "`NO_REPLY`。",
      双引号加句号: '"NO_REPLY。"',
      弯引号: "“NO_REPLY”",
      多层包裹: '**`"NO_REPLY"`**',
      围栏: "```\nNO_REPLY\n```",
      围栏加引号: '```\n"NO_REPLY"\n```',
      "反引号 + 前后空行": "\n\n  `NO_REPLY`  \n\n",
      多行全是哨兵: "NO_REPLY\n\n`NO_REPLY`",
      "裸哨兵 + 解释": "NO_REPLY\n对方只是在确认",
      "加粗哨兵 + 括号说明": "**NO_REPLY**（对方只是确认）",
      "裸哨兵 + 冒号说明": "NO_REPLY：对方只是确认，没有提问",
      // 标注型：哨兵词后只带一对括号说明（提示词自己把 NO_REPLY 写在反引号里，模型常照抄反引号）
      "反引号哨兵 + 括号说明": "`NO_REPLY`（对方只是确认）",
      "加粗反引号哨兵 + 括号说明": "**`NO_REPLY`**（对方只是确认）",
      "引号哨兵 + 半角括号说明": '"NO_REPLY" (对方只是确认)',
    };
    for (const [name, raw] of Object.entries(stillSilent)) {
      it(`silent：${name}`, () => {
        for (const requester of [human, bot]) {
          expect(parseGroupReply(raw, mk({ requester })), JSON.stringify(raw)).toEqual(SILENT);
        }
      });
    }

    it("被反引号包住的哨兵行独占一行、后面没有别的正文：仍静默", () => {
      expect(parseGroupReply("`NO_REPLY`\n\n\n", mk())).toEqual(SILENT);
    });
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "超长首行（全是反引号 / 引号前缀）": (n) => `${"`\"*_~ ".repeat(n)}x`,
      "大量全角哨兵行": (n) => "ＮＯ＿ＲＥＰＬＹ\n".repeat(n),
      "大量夹零宽的哨兵行": (n) => "NO\u200b_REPLY\n".repeat(n),
      "大量被反引号包住的带说明哨兵行": (n) => "`NO_REPLY`（x）\n".repeat(n),
      "一整行全角字母": (n) => "Ａ".repeat(n * 8),
      "一整行零宽字符": (n) => `NO${"\u200b".repeat(n * 8)}_REPLY x`,
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk({ requester: bot }));
        }, 3000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});
