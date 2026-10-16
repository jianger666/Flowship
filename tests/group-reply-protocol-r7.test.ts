/**
 * 第七轮 review（K4-02 / K4-03 / K4-04 / K4-05 / K4-11）：群答疑回复协议的复核回归。
 *
 * - K4-02 整行被一对反引号 / 引号包住的「哨兵 + 说明」要静默（旧实现原样发群）
 * - K4-03 标注型（括号说明）必须「首个括号配对后恰好到行尾」——括号之后还有正文就不是标注
 * - K4-04 「需属主确认」标记的起头 / 闭合按 NFKC + 去 Cf 判（全角方括号、夹零宽字符），位置映射回原文
 * - K4-05 说明里的 `]` / `]]` 不提前截断；围栏 / 行内代码里的标记不触发；说明里含空行也能闭合
 * - K4-11 `GROUP_NEEDS_OWNER_RE`（二次型陷阱、生产无调用方）已删除
 *
 * 性能一律用「n → 2n 的耗时比」（见 tests/helpers/scaling-ratio.ts），不用绝对耗时阈值。
 */
import { describe, expect, it } from "vitest";

import * as contract from "@/lib/server/feishu-bridge/group-contract";
import type { GroupMember } from "@/lib/server/feishu-bridge/group-contract";
import {
  parseGroupReply,
  stripNeedsOwnerMarkers,
  type ParseGroupReplyCtx,
} from "@/lib/server/feishu-bridge/group-reply-protocol";

import { doublingRatio, LINEAR_RATIO_MAX } from "./helpers/scaling-ratio";

const tag = (id: string, name: string) => `<at user_id="${id}">${name}</at>`;

const members: GroupMember[] = [
  { openId: "ou_owner", name: "曾进有", kind: "user" },
  { openId: "ou_zhang", name: "张三", kind: "user" },
  { openId: "ou_anruo", name: "安若流年", kind: "bot" },
  { openId: "ou_self", name: "Flowship机器人", kind: "bot" },
];

const human = { openId: "ou_zhang", name: "张三", isBot: false };
const bot = { openId: "ou_anruo", name: "安若流年", isBot: true };

const mk = (over: Partial<ParseGroupReplyCtx> = {}): ParseGroupReplyCtx => ({
  members,
  owner: { openId: "ou_owner", name: "曾进有" },
  requester: bot,
  selfOpenId: "ou_self",
  ...over,
});

const SILENT = { kind: "silent", text: "", mentions: [], unresolvedAts: [] };
const ownerLine = (explain: string) =>
  `${tag("ou_owner", "曾进有")} 需要你确认：${explain}`;

/** 直接调解析入口：收集所有说明 + 剥完的文本 */
const strip = (raw: string) => {
  const explains: string[] = [];
  const r = stripNeedsOwnerMarkers(raw, (e) => explains.push(e));
  return { ...r, explains };
};

// ---------------------------------------------------------------------------
// K4-11 · GROUP_NEEDS_OWNER_RE 已删除
// ---------------------------------------------------------------------------

describe("K4-11 · 契约里不再导出二次型的 GROUP_NEEDS_OWNER_RE", () => {
  it("group-contract 的导出里没有它（解析一律走 parseGroupReply / stripNeedsOwnerMarkers）", () => {
    expect(Object.keys(contract)).not.toContain("GROUP_NEEDS_OWNER_RE");
    // 解析器真正用到的两个契约常量还在
    expect(Object.keys(contract)).toContain("GROUP_NEEDS_OWNER_HEAD_RE");
    expect(Object.keys(contract)).toContain("GROUP_NEEDS_OWNER_CLOSERS");
  });
});

// ---------------------------------------------------------------------------
// K4-02 · 整行被一对反引号 / 引号包住的「哨兵 + 说明」
// ---------------------------------------------------------------------------

describe("K4-02 · 整行被一对包裹符包住的「哨兵 + 说明」→ 静默", () => {
  const wholeWrapped: Record<string, string> = {
    "反引号包住整行（报告复现）": "`NO_REPLY：对方只是确认`",
    "反引号 + 半角冒号": "`NO_REPLY:对方只是确认`",
    "反引号 + 破折号": "`NO_REPLY - 对方只是确认`",
    "反引号 + 逗号": "`NO_REPLY，对方只是确认`",
    "反引号 + 括号说明都在包裹内": "`NO_REPLY（对方只是确认）`",
    "说明末尾的句号在包裹内": "`NO_REPLY：对方只是确认。`",
    "句号在包裹外": "`NO_REPLY：对方只是确认`。",
    双引号: '"NO_REPLY：对方只是确认"',
    弯引号: "“NO_REPLY：对方只是确认”",
    直角引号: "「NO_REPLY：对方只是确认」",
    "加粗包反引号": "**`NO_REPLY：对方只是确认`**",
    "反引号包加粗哨兵": "`**NO_REPLY**：对方只是确认`",
    "说明里还有别种引号": '`NO_REPLY：对方说了"收到"`',
    "全角反引号 + 全角哨兵": "｀ＮＯ＿ＲＥＰＬＹ：对方只是确认｀",
    "零宽夹在哨兵里": "`NO\u200b_REPLY：对方只是确认`",
    前后空白: "  `NO_REPLY：对方只是确认`  ",
  };
  for (const [name, raw] of Object.entries(wholeWrapped)) {
    it(`silent：${name}`, () => {
      for (const requester of [human, bot]) {
        expect(parseGroupReply(raw, mk({ requester })), JSON.stringify(raw)).toEqual(SILENT);
      }
    });
  }

  it("夹在正文里：整行被包住的哨兵行只剔那一行，其余照发", () => {
    for (const [name, line] of Object.entries(wholeWrapped)) {
      const r = parseGroupReply(`第一段\n${line}\n第二段`, mk());
      expect(r.text, name).toBe("第一段\n第二段");
    }
  });

  it("首个非空行是被整行包住的哨兵行、后面还有正文：整段静默（与「哨兵 + 自我解释」同口径）", () => {
    expect(parseGroupReply("`NO_REPLY：对方只是确认`\n另一段话", mk())).toEqual(SILENT);
  });

  describe("不算「整行被包住」的（仍是在解释哨兵词 / 后面还有正文）→ 照发", () => {
    const body = "接口是 /a/b，参数 x 必填。";
    const explaining: Record<string, string> = {
      "反引号只包哨兵词、冒号后是正文（残余：照发）": "`NO_REPLY`：说明",
      "反引号只包哨兵词 + 逗号 + 正文": `\`NO_REPLY\`，不过我还是答一下：${body}`,
      // 防「行首反引号与行尾反引号配对」的误杀：这里行尾的反引号是正文里的行内代码，哨兵词那一对在 NO_REPLY 后面就闭合了
      "行尾恰好也是反引号的正文（行内代码收尾）": "`NO_REPLY`，不过我还是答一下：接口是 `/a/b`",
      "包裹在说明里闭合、闭合之后还有正文": "`NO_REPLY：对方只是确认` 但我还是答一下：接口是 /a/b",
      "引号里的说明后面又跟正文": '"NO_REPLY：先说明" 接着是正文',
      "加粗哨兵词后用反引号包说明": "**NO_REPLY** `：说明` 然后是正文",
    };
    for (const [name, raw] of Object.entries(explaining)) {
      it(`send：${name}`, () => {
        const r = parseGroupReply(raw, mk());
        expect(r.kind, raw).toBe("send");
        expect(r.text, raw).toBe(raw);
      });
    }
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量整行被包住的哨兵行": (n) => "`NO_REPLY：x`\n".repeat(n),
      "超长说明 + 行尾才闭合": (n) => `\`NO_REPLY：${"x".repeat(n * 8)}\``,
      "超长说明里全是反引号（每个都是候选收尾）": (n) => `\`NO_REPLY：${"`".repeat(n * 8)}x`,
      "前缀里每种引号都有 + 超长说明": (n) => `${"`\"“‘「『'".repeat(n)}NO_REPLY：${"x".repeat(n * 8)}`,
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk());
        }, 3000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// K4-03 · noteOnly：首个括号配对后恰好到行尾
// ---------------------------------------------------------------------------

describe("K4-03 · 标注型（括号说明）必须括号之后到行尾没有正文", () => {
  describe("括号说明之后还有正文 → 不是标注，真正的回复照发（旧实现整条被吞）", () => {
    const parenThenBody: Record<string, string> = {
      "报告复现": "`NO_REPLY`（先说明）接口是 /a/b（见文档）",
      "半角括号": '"NO_REPLY" (note) 接口是 /a/b (见文档)',
      "括号说明后又一个括号再跟正文": "`NO_REPLY`（a）（b）后面是正文",
      "嵌套括号后跟正文，正文又以括号结尾": "`NO_REPLY`（a（b）c）正文（x）",
      "括号后跟的正文以右括号结尾": "`NO_REPLY`（先说明）参见（附录）",
    };
    for (const [name, raw] of Object.entries(parenThenBody)) {
      it(`send（首行）：${name}`, () => {
        const r = parseGroupReply(raw, mk());
        expect(r.kind, raw).toBe("send");
        expect(r.text, raw).toBe(raw);
      });
      it(`send（夹在正文里，整行保留）：${name}`, () => {
        const r = parseGroupReply(`第一段\n${raw}\n第二段`, mk());
        expect(r.text, raw).toBe(`第一段\n${raw}\n第二段`);
      });
    }

    it("首行是这种行、后面还有别的行：整段照发（不是整段静默）", () => {
      const raw = "`NO_REPLY`（先说明）接口是 /a/b（见文档）\n参数 x 必填";
      const r = parseGroupReply(raw, mk());
      expect(r.kind).toBe("send");
      expect(r.text).toBe(raw);
    });
  });

  describe("括号说明恰好到行尾（只剩空白 / 标点 / 包裹符号）→ 仍是标注型，静默", () => {
    const noteOnly: Record<string, string> = {
      "括号说明到行尾": "`NO_REPLY`（对方只是确认）",
      "嵌套括号": "`NO_REPLY`（对方（已读）只是确认）",
      "括号后只剩句号": "`NO_REPLY`（对方只是确认）。",
      "括号后只剩空白": "`NO_REPLY`（对方只是确认）   ",
      "括号后只剩包裹符号": "**`NO_REPLY`（对方只是确认）**",
      "半角括号 + 引号": '"NO_REPLY" (对方只是确认)',
    };
    for (const [name, raw] of Object.entries(noteOnly)) {
      it(`silent：${name}`, () => {
        for (const requester of [human, bot]) {
          expect(parseGroupReply(raw, mk({ requester })), JSON.stringify(raw)).toEqual(SILENT);
        }
      });
      it(`夹在正文里只剔这一行：${name}`, () => {
        expect(parseGroupReply(`第一段\n${raw}\n第二段`, mk()).text, raw).toBe("第一段\n第二段");
      });
    }
  });

  it("括号没配平（缺右括号）：不算标注型，当作在解释哨兵词、照发（保守：宁可多发一行也不吞）", () => {
    const raw = "`NO_REPLY`（对方只是确认";
    const r = parseGroupReply(raw, mk());
    expect(r.kind).toBe("send");
    expect(r.text).toBe(raw);
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量「括号说明 + 正文」行": (n) => "`NO_REPLY`（x）y\n".repeat(n),
      "超长的左括号串": (n) => `\`NO_REPLY\`${"（".repeat(n * 8)}`,
      "超长的左括号串 + 右括号": (n) => `\`NO_REPLY\`${"（".repeat(n * 8)}${"）".repeat(n * 8)}正文`,
      "超长括号内说明": (n) => `\`NO_REPLY\`（${"x".repeat(n * 8)}）正文`,
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk());
        }, 3000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// K4-04 · 标记起头 / 闭合按 NFKC + 去 Cf 判，位置映射回原文
// ---------------------------------------------------------------------------

describe("K4-04 · 「需属主确认」标记：全角方括号 / 夹零宽字符也识别，发群的仍是原文", () => {
  const variants: Record<string, string> = {
    全角方括号: "［［需属主确认：接口是否分页］］",
    "半角开头 + 全角闭合": "[[需属主确认：接口是否分页］］",
    "全角开头 + 半角闭合": "［［需属主确认：接口是否分页]]",
    "全角方括号 + 全角空格": "［［\u3000需属主确认\u3000：接口是否分页］］",
    "全角方括号 + 半角冒号": "［［需属主确认:接口是否分页］］",
    "两个 [ 之间夹零宽空格": "[\u200b[需属主确认：接口是否分页]]",
    "括号后夹零宽空格": "[[\u200b需属主确认：接口是否分页]]",
    "关键词里夹零宽": "[[需属主\u200b确认：接口是否分页]]",
    "冒号前夹零宽": "[[需属主确认\u200b：接口是否分页]]",
    "闭合符之间夹零宽": "[[需属主确认：接口是否分页]\u200b]",
    "夹 WORD JOINER / BOM / 软连字符": "[\u2060[\uFEFF需属主\u00ad确认：接口是否分页]]",
    "全角 + 零宽混合": "［\u200b［需属主确认：接口是否分页］\u2060］",
    "方头括号夹零宽": "【\u200b需属主确认：接口是否分页\u200b】",
    "方头括号 + 全角空格 + 零宽": "【\u3000\u200b需属主确认\u3000：接口是否分页】",
  };
  for (const [name, mark] of Object.entries(variants)) {
    it(`识别并落地：${name}`, () => {
      const r = parseGroupReply(`这个要宿主确认，已转告\n${mark}`, mk());
      expect(r.kind).toBe("send");
      expect(r.needsOwner).toBe("接口是否分页");
      expect(r.text).toBe(`这个要宿主确认，已转告\n${ownerLine("接口是否分页")}`);
      expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
      expect(r.text).not.toMatch(/需属主确认|\[\[|【|［/);
    });
  }

  it("标记独占整条回复：只剩一行确认行（全角 / 零宽写法同口径）", () => {
    for (const [name, mark] of Object.entries(variants)) {
      const r = parseGroupReply(mark, mk());
      expect(r.text, name).toBe(ownerLine("接口是否分页"));
    }
  });

  it("标记前后紧贴的零宽字符一并剔掉，不留「看不见但非空」的残渣", () => {
    const r = parseGroupReply("ok\n\u200b[[需属主确认：x]]\u200b", mk());
    expect(r.text).toBe(`ok\n${ownerLine("x")}`);
    // 只有标记 + 零宽：整条仍然只剩确认行
    expect(parseGroupReply("\u200b［［需属主确认：x］］\u200b", mk()).text).toBe(ownerLine("x"));
  });

  it("说明取原文：全角字母 / 数字 / 标点原样保留，不被 NFKC 改写", () => {
    const r = parseGroupReply("ok\n［［需属主确认：看 ＡＢ 的ＩＤ，第①项？］］", mk());
    expect(r.needsOwner).toBe("看 ＡＢ 的ＩＤ，第①项？");
  });

  describe("位置映射：NFKC 会让长度变化的字符夹在标记前后，剔掉的必须是原文里标记的位置", () => {
    // `…` → `...`（1 → 3）、`㈱` → `(株)`（1 → 3）、`①` → `1`、`ﬁ` → `fi`（1 → 2）、`㎏` → `kg`（1 → 2）
    const before = "省略号…… 公司㈱ 编号① 连字ﬁ";
    const after = "单位㎏ 全角ＡＢＣ，结束……";

    it("标记独占一行：前后文原样保留", () => {
      const r = parseGroupReply(`${before}\n［［需属主确认：x］］\n${after}`, mk());
      expect(r.needsOwner).toBe("x");
      expect(r.text).toBe(`${before}\n\n${after}\n${ownerLine("x")}`);
    });

    it("标记在行中间：只剔标记本身", () => {
      const r = parseGroupReply(`${before} ［［需属主确认：x］］ ${after}`, mk());
      expect(r.text).toBe(`${before}  ${after}\n${ownerLine("x")}`);
    });

    it("直接看 stripNeedsOwnerMarkers：剥完的文本 = 原文去掉标记，说明取原文（含会展开的字符）", () => {
      const raw = `${before}［［需属主确认：……共㈱①］］${after}`;
      const r = strip(raw);
      expect(r.found).toBe(true);
      expect(r.explains).toEqual(["……共㈱①"]);
      expect(r.text).toBe(`${before}${after}`);
    });

    it("多个标记、中间夹会展开的字符：各自位置都对", () => {
      const raw = `A…［［需属主确认：一］］B㈱［［需属主确认：二］］C①`;
      const r = strip(raw);
      expect(r.explains).toEqual(["一", "二"]);
      expect(r.text).toBe("A…B㈱C①");
    });

    it("标记本身含会展开的字符（说明里的 …）：闭合符位置仍对", () => {
      const r = strip("ａ［［需属主确认：好…］］ｂ");
      expect(r.explains).toEqual(["好…"]);
      expect(r.text).toBe("ａｂ");
    });
  });

  it("不是标记的不误杀，且原样输出（缺冒号 / 缺关键词 / 单个方括号）", () => {
    for (const raw of [
      "［［需属主确认］］ 请看",
      "［［需属主：x］］",
      "［需属主确认：x］",
      "好\u200b的 [[需属主确认]]",
    ]) {
      const r = parseGroupReply(raw, mk());
      expect(r.kind, raw).toBe("send");
      expect(r.text, raw).toBe(raw);
      expect(r.needsOwner, raw).toBeUndefined();
    }
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量全角方括号闭合标记": (n) => "［［需属主确认：x］］ y\n".repeat(n),
      "大量夹零宽的标记": (n) => "[\u200b[需属主确认：x]]\u200b y\n".repeat(n),
      "大量全角方括号未闭合标记": (n) => "［［需属主确认：x\n".repeat(n),
      "整段全是会展开的字符 + 末尾一个标记": (n) => `${"…".repeat(n * 8)}\n［［需属主确认：x］］`,
      "整段全是零宽字符 + 末尾一个标记": (n) => `${"\u200b".repeat(n * 8)}\n[[需属主确认：x]]`,
      "标记起头后夹超长零宽串": (n) => `[[${"\u200b".repeat(n * 8)}需属主确认：x]]`,
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk());
        }, 4000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// K4-05 · ① 说明里的 ] / ]]  ② 代码里的标记不触发  ③ 说明里含空行
// ---------------------------------------------------------------------------

describe("K4-05① · 说明里出现的 `]` / `]]` 不提前截断", () => {
  const cases: Array<[string, string, string]> = [
    // [名称, 原文, 期望的说明]
    ["报告复现：a[0] 后紧跟闭合符 ]]]", "ok\n[[需属主确认：看 a[0]]]", "看 a[0]"],
    ["说明里有嵌套下标 a[b[0]]", "ok\n[[需属主确认：看 a[b[0]]]]", "看 a[b[0]]"],
    ["说明里有 ]] 且后面还有字，行尾才是闭合符", "ok\n[[需属主确认：数组 a[b[0]] 怎么取]]", "数组 a[b[0]] 怎么取"],
    ["说明里有成对的 [[x]]", "ok\n[[需属主确认：看 [[x]] 这段再定]]", "看 [[x]] 这段再定"],
    ["说明里有 [1] 引用（配平的，对照）", "ok\n[[需属主确认：参考 [1] 的口径]]", "参考 [1] 的口径"],
    ["说明里只有一个多余的 ]", "ok\n[[需属主确认：看 x] 再说]]", "看 x] 再说"],
    ["方头括号：说明里有成对的【】", "ok\n【需属主确认：看【x】这段】", "看【x】这段"],
  ];
  for (const [name, raw, explain] of cases) {
    it(`${name}`, () => {
      const r = parseGroupReply(raw, mk());
      expect(r.needsOwner).toBe(explain);
      expect(r.text).toBe(`ok\n${ownerLine(explain)}`);
    });
  }

  it("闭合符后面还跟着字：a[0]]] 的第三个 ] 属于说明，后文原样保留", () => {
    const r = strip("ok\n[[需属主确认：看 a[0]]] 后续");
    expect(r.explains).toEqual(["看 a[0]"]);
    expect(r.text).toBe("ok\n 后续");
  });

  it("闭合符多写了 ]（说明是配平的）：多余的 ] 当笔误一并剔掉，正文不残留孤立括号", () => {
    for (const [raw, rest] of [
      ["ok\n[[需属主确认：x]]]", "ok\n"],
      ["ok\n[[需属主确认：x]]]]", "ok\n"],
      ["ok\n【需属主确认：x】】", "ok\n"],
      ["ok\n[[需属主确认：x]]] 后续", "ok\n 后续"],
    ] as const) {
      const r = strip(raw);
      expect(r.explains, raw).toEqual(["x"]);
      expect(r.text, raw).toBe(rest);
    }
  });

  it("不跨到后文无关的 ]]：说明已配平，闭合后同一行里别处的 ]] 不被吞进说明", () => {
    const r = strip("ok\n[[需属主确认：A]] 正文 a[0]]");
    expect(r.explains).toEqual(["A"]);
    expect(r.text).toBe("ok\n 正文 a[0]]");
  });

  it("不吞掉同一行的下一个标记：前一个说明没配平时也只在自己的闭合符处收尾", () => {
    const r = parseGroupReply("ok\n[[需属主确认：A[ ]] 文字 [[需属主确认：B]]", mk());
    expect(r.needsOwner).toBe("A[");
    expect(r.text).toContain("文字");
    expect(r.text).not.toContain("[[");
    expect(r.text).not.toContain("B");
  });

  it("说明没配平且行尾也没有闭合符：退回第一个闭合符（后面的正文保留）", () => {
    const r = strip("ok\n[[需属主确认：看 a[0 再说]] 然后别的");
    expect(r.explains).toEqual(["看 a[0 再说"]);
    expect(r.text).toBe("ok\n 然后别的");
  });

  describe("既有语义不变（未闭合 → 取到行尾；只漏一个 ] 去残留括号）", () => {
    it("未闭合 + 说明里有 a[0]", () => {
      const r = strip("ok\n[[需属主确认：看 a[0]");
      expect(r.explains).toEqual(["看 a[0"]);
    });
    it("只漏一个 ]", () => {
      expect(strip("ok\n[[需属主确认：范围]").explains).toEqual(["范围"]);
    });
    it("未闭合行尾残留 ]]（方头括号族）", () => {
      expect(strip("ok\n【需属主确认：口径]]").explains).toEqual(["口径"]);
    });
  });
});

describe("K4-05② · 代码围栏 / 行内代码里的标记不触发", () => {
  const demo = "[[需属主确认：示例]]";

  const notTriggered: Record<string, string> = {
    "围栏（无语言）": `说明如下：\n\`\`\`\n${demo}\n\`\`\`\n正文`,
    "围栏（带语言）": `说明如下：\n\`\`\`text\n${demo}\n\`\`\`\n正文`,
    "围栏里夹多行": `说明如下：\n\`\`\`\n第一行\n${demo}\n第三行\n\`\`\`\n正文`,
    "波浪线围栏": `说明如下：\n~~~\n${demo}\n~~~\n正文`,
    "四个反引号的围栏（里面有三个反引号）": `说明如下：\n\`\`\`\`\n\`\`\`\n${demo}\n\`\`\`\n\`\`\`\`\n正文`,
    "围栏缩进 3 格": `说明如下：\n   \`\`\`\n${demo}\n   \`\`\`\n正文`,
    // （第八轮 L4-05：原先这里还有一条「未闭合的围栏（到文末都是代码）」，把真标记泄漏钉成了规格——已翻转，
    //  见下面 `未闭合的围栏不算代码`。）
    "围栏里的方头括号写法": "说明如下：\n```\n【需属主确认：示例】\n```\n正文",
    "全角反引号围栏": `说明如下：\n｀｀｀\n［［需属主确认：示例］］\n｀｀｀\n正文`,
    "行内代码": `写法是 \`${demo}\` 这样`,
    "行内代码（双反引号）": `写法是 \`\`${demo}\`\` 这样`,
    "行内代码里的方头括号写法": "写法是 `【需属主确认：示例】` 这样",
    "独占一行的行内代码": `\`${demo}\``,
    "行内代码里的全角写法": "写法是 `［［需属主确认：示例］］` 这样",
  };
  for (const [name, raw] of Object.entries(notTriggered)) {
    it(`不触发、原文原样发出（不留空围栏）：${name}`, () => {
      const r = parseGroupReply(raw, mk());
      expect(r.kind).toBe("send");
      expect(r.needsOwner).toBeUndefined();
      expect(r.mentions).toEqual([]);
      // 原文一字不动：既没有触发，也没有把示例标记剥掉后留下空围栏 / 空行内代码
      expect(r.text).toBe(raw);
    });
  }

  it("围栏里的示例不触发，围栏外真正的标记照常触发（围栏原样保留）", () => {
    const raw = `先看示例：\n\`\`\`\n${demo}\n\`\`\`\n这个要宿主定\n[[需属主确认：要不要上线]]`;
    const r = parseGroupReply(raw, mk());
    expect(r.needsOwner).toBe("要不要上线");
    expect(r.text).toBe(
      `先看示例：\n\`\`\`\n${demo}\n\`\`\`\n这个要宿主定\n${ownerLine("要不要上线")}`,
    );
  });

  // 第八轮 L4-05：翻转第七轮的「未闭合围栏到文末都是代码」。第七轮把它钉成规格，结果是模型漏写收尾 ``` 时，
  // 围栏后面真正的「需属主确认」整条原样发群、属主没被 @，与 findCodeRanges 自己写的「判错宁可把示例当标记触发」相反。
  // 现在未闭合的围栏起头不算围栏（后面没有止行 → 它只是一行普通文字）。
  it("未闭合的围栏不算代码：报告复现——后面真正的标记照常触发、属主被 @", () => {
    const r = parseGroupReply("好的\n```bash\nnpm test\n[[需属主确认：要不要上线]]", mk());
    expect(r.needsOwner).toBe("要不要上线");
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
    // 标记被剥掉、补上确认行；围栏起头行与命令行原样保留
    expect(r.text).toBe(`好的\n\`\`\`bash\nnpm test\n${ownerLine("要不要上线")}`);
    expect(r.text).not.toContain("[[");
  });

  it("围栏关闭之后的标记照常触发", () => {
    const r = parseGroupReply("```\ncode\n```\n[[需属主确认：y]]", mk());
    expect(r.needsOwner).toBe("y");
    expect(r.text).toBe(`\`\`\`\ncode\n\`\`\`\n${ownerLine("y")}`);
  });

  it("不是代码的反引号不会把后文整段「吞成代码」：落单的反引号 / 已闭合的行内代码 / 同行闭合的 ```x```", () => {
    for (const prev of ["it`s here", "用 `a` 和 `b` 两个", "```x```", "``` y ```"]) {
      const r = parseGroupReply(`${prev}\n[[需属主确认：y]]`, mk());
      expect(r.needsOwner, prev).toBe("y");
      expect(r.text, prev).toBe(`${prev}\n${ownerLine("y")}`);
    }
  });

  it("标记前面同一行有行内代码、标记本身在代码外：照常触发", () => {
    const r = parseGroupReply("用 `x` 的话 [[需属主确认：y]]", mk());
    expect(r.needsOwner).toBe("y");
  });

  it("行内代码里有标记、同一行代码外还有一个：只触发代码外的", () => {
    const r = strip(`写法 \`${demo}\` 然后 [[需属主确认：真的]]`);
    expect(r.explains).toEqual(["真的"]);
    expect(r.text).toBe(`写法 \`${demo}\` 然后 `);
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量围栏 + 围栏里的标记": (n) => `\`\`\`\n${demo}\n\`\`\`\n`.repeat(n),
      "大量行内代码里的标记": (n) => `\`${demo}\` `.repeat(n),
      "一长串反引号 + 一个标记": (n) => `${"`".repeat(n * 8)}${demo}`,
      "大量单个反引号隔开的标记": (n) => `\`${demo}\n`.repeat(n),
      "未闭合围栏 + 大量未闭合标记": (n) => `\`\`\`\n${"[[需属主确认：x\n".repeat(n)}`,
      "大量不闭合的围栏起头": (n) => "```a\n".repeat(n * 2) + demo,
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk());
        }, 4000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});

describe("K4-05③ · 说明里含空行：闭合符在行尾且就在近处时，整段说明都收进来", () => {
  it("报告复现：说明里含空行，needsOwner 取全，「后]]」不再原样发群", () => {
    const r = parseGroupReply("ok\n[[需属主确认：前\n\n后]]", mk());
    expect(r.needsOwner).toBe("前 后");
    expect(r.text).toBe(`ok\n${ownerLine("前 后")}`);
    expect(r.text).not.toContain("]]");
  });

  it("空行的几种写法：\\n\\n / \\r\\n\\r\\n / 只含空白的行 / 全角空格行", () => {
    for (const gap of ["\n\n", "\r\n\r\n", "\n  \n", "\n\u3000\n", "\n\t\n"]) {
      const r = parseGroupReply(`ok\n[[需属主确认：前${gap}后]]`, mk());
      expect(r.needsOwner, JSON.stringify(gap)).toBe("前 后");
      expect(r.text, JSON.stringify(gap)).toBe(`ok\n${ownerLine("前 后")}`);
    }
  });

  it("多个空行 / 方头括号 / 闭合符后跟空白", () => {
    expect(parseGroupReply("ok\n[[需属主确认：一\n\n二\n\n三]]", mk()).needsOwner).toBe("一 二 三");
    expect(parseGroupReply("ok\n【需属主确认：前\n\n后】", mk()).needsOwner).toBe("前 后");
    const r = parseGroupReply("ok\n[[需属主确认：前\n\n后]]   \n尾巴", mk());
    expect(r.needsOwner).toBe("前 后");
    expect(r.text).toContain("尾巴");
  });

  it("闭合符在行尾，后面隔着空行才是别的正文：正文保留", () => {
    const r = parseGroupReply("ok\n[[需属主确认：前\n\n后]]\n\n另一段", mk());
    expect(r.needsOwner).toBe("前 后");
    expect(r.text).toBe(`ok\n\n另一段\n${ownerLine("前 后")}`);
  });

  describe("仍然不跨到后文无关的 ]]（既有语义，第六轮钉的）", () => {
    it("后面隔着空行、但 ]] 在行中间（后面还有字）：不是闭合符，说明只取到行尾", () => {
      const r = parseGroupReply("[[需属主确认：要不要上线\n\n后面的无关段落 a]] b\n另一段 c", mk());
      expect(r.needsOwner).toBe("要不要上线");
      expect(r.text).toBe(`后面的无关段落 a]] b\n另一段 c\n${ownerLine("要不要上线")}`);
    });

    it("闭合符在行尾，但中间已经有别的标记起头：那是别的标记的闭合符", () => {
      const r = parseGroupReply(
        "[[需属主确认：第一条\n\n正文\n[[需属主确认：第二条]]",
        mk(),
      );
      expect(r.needsOwner).toBe("第一条");
      expect(r.text).toBe(`正文\n${ownerLine("第一条")}`);
    });

    // 上一条用例（第二个标记的 `[[` 没配平）会先被「配平」那一关拦下、碰不到「中间有别的起头」这条限制；
    // 这里用连续的 `]]]]` 让 run-shift 把配平凑出来，限制才是唯一的拦路者：
    // 没有它，第一个标记会把第二个标记整个吞成自己说明的一部分，属主只看到一条、第二条的说明被埋在第一条里。
    it("跨空行时，中间已有别的标记起头（哪怕靠连续 ]]]] 能配平）：各是各的标记，不互相吞", () => {
      const r = strip("[[需属主确认：A\n\n正文 [[需属主确认：B]]]]");
      expect(r.explains).toEqual(["A", "B"]);
      expect(r.text).toBe("\n\n正文 ");
    });

    it("闭合符在行尾，但离起头太远（超过 600 字）：不当闭合符", () => {
      const far = "无关段落。".repeat(200); // 1000 字
      const r = parseGroupReply(`[[需属主确认：要不要上线\n\n${far} 结尾]]`, mk());
      expect(r.needsOwner).toBe("要不要上线");
      expect(r.text).toContain(far);
      expect(r.text).toContain("结尾]]");
    });

    it("空行之后的 ]] 在行尾，但它前面有没配平的 [（那是后文自己的括号）：不当闭合符", () => {
      const r = parseGroupReply("[[需属主确认：要不要上线\n\n另一段 a[0]]", mk());
      expect(r.needsOwner).toBe("要不要上线");
      expect(r.text).toContain("另一段 a[0]]");
    });

    it("空行之后是配平的 [[x]]（后文自己的链接写法）：不当闭合符", () => {
      const r = parseGroupReply("[[需属主确认：要不要上线\n\n见 [[文档]]", mk());
      expect(r.needsOwner).toBe("要不要上线");
      expect(r.text).toContain("见 [[文档]]");
    });
  });

  it("【残余·取舍，现状如此】空行之后一段话恰好以 ]] 结尾、中间没有别的标记、也没有 [：当作说明的延续", () => {
    // 这是「说明里含空行」与「后文无关的行尾 ]]」在形态上无法区分的那一边：选择前者（说明含空行是模型会写出的形态）。
    // 反例：`[[需属主确认：要不要上线\n\n另一段无关内容 a]]`——无关的那一行被收进说明、从群消息里剥掉。
    const r = parseGroupReply("[[需属主确认：要不要上线\n\n另一段无关内容 a]]", mk());
    expect(r.needsOwner).toBe("要不要上线 另一段无关内容 a");
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量未闭合标记、每个后面隔空行 + 远处一个行尾 ]]": (n) => `${"[[需属主确认：x\n\n".repeat(n)}]]`,
      "大量说明里含空行的闭合标记": (n) => "[[需属主确认：前\n\n后]]\n".repeat(n),
      "大量没配平的标记同一行（行尾有别的标记的闭合符）": (n) => "[[需属主确认：a[]] ".repeat(n),
      "大量没配平的标记、每行一个": (n) => `${"[[需属主确认：a[\n".repeat(n)}x]]`,
      "说明里一长串 ]": (n) => `[[需属主确认：${"]".repeat(n * 8)}x]]`,
      "没配平 + 一长串 ]": (n) => `[[需属主确认：a[${"]".repeat(n * 8)}`,
      "闭合符后一长串空白": (n) => `[[需属主确认：a[ ]]${" ".repeat(n * 8)}\n`.repeat(2),
      "同一行大量没配平标记 + 超长行尾空白": (n) => `${"[[需属主确认：a[]] ".repeat(100)}${" ".repeat(n * 8)}`,
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk());
        }, 4000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});
