/**
 * 第八轮 review（L4-05 / L4-06 / L4-10 + 测试质量里的 foldWithMap fuzz）：群答疑回复协议的复核回归。
 *
 * - L4-05 未闭合围栏不算代码：模型漏写收尾 ``` 时，围栏后面真正的「需属主确认」要照常触发（第七轮把它钉成了规格）
 * - L4-06 闭合围栏里的 `NO_REPLY` 行是示例，不剔（旧实现剔掉后留下空围栏）；围栏外的照旧剔
 * - L4-10 说明里有孤立 `[` 且没法配平时，回退取第一个 `]]`，不再吞同一行的后文（含后面的 `[[链接]]`）
 *
 * （foldWithMap 的种子 fuzz / 元测试在 tests/group-reply-protocol-fold-fuzz-r8.test.ts。）
 *
 * 性能一律用「n → 2n 的耗时比」（见 tests/helpers/scaling-ratio.ts），不用绝对耗时阈值。
 */
import { describe, expect, it } from "vitest";

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

const bot = { openId: "ou_anruo", name: "安若流年", isBot: true };

/** 默认提问人是机器人：不会因「正文没有真 @」被自动补 @，输出就是正文本身 */
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

const strip = (raw: string) => {
  const explains: string[] = [];
  const r = stripNeedsOwnerMarkers(raw, (e) => explains.push(e));
  return { ...r, explains };
};

// ---------------------------------------------------------------------------
// L4-05 · 未闭合的围栏不算代码
// ---------------------------------------------------------------------------

describe("L4-05 · 未闭合的围栏起头不算围栏：后面真正的标记照常触发", () => {
  const MARK = "[[需属主确认：要不要上线]]";

  it("报告复现：```bash 没收尾 → needsOwner 取到、属主被 @、标记不再原样发群", () => {
    const r = parseGroupReply(`好的\n\`\`\`bash\nnpm test\n${MARK}`, mk());
    expect(r.kind).toBe("send");
    expect(r.needsOwner).toBe("要不要上线");
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
    expect(r.text).toBe(`好的\n\`\`\`bash\nnpm test\n${ownerLine("要不要上线")}`);
    expect(r.text).not.toContain("[[");
  });

  const unclosed: Record<string, string> = {
    "波浪线围栏没收尾": `好的\n~~~\nnpm test\n${MARK}`,
    "围栏在标记之前很多行": `好的\n\`\`\`\n${"line\n".repeat(30)}${MARK}`,
    "标记后面还有正文": `好的\n\`\`\`bash\nnpm test\n${MARK}\n还有别的话`,
    "围栏缩进 3 格没收尾": `好的\n   \`\`\`\nnpm test\n${MARK}`,
    "止行比起头围栏短（``` 收不了 ````）": `好的\n\`\`\`\`\nnpm test\n\`\`\`\n${MARK}`,
    "止行是另一种符号（``` 收不了 ~~~）": `好的\n\`\`\`\nnpm test\n~~~\n${MARK}`,
    "止行带了别的字（那是新的起头、不是止行）": `好的\n\`\`\`\nnpm test\n\`\`\`bash\n${MARK}`,
    "全角反引号围栏没收尾": `好的\n｀｀｀\nnpm test\n${MARK}`,
    "方头括号写法": "好的\n```bash\nnpm test\n【需属主确认：要不要上线】",
  };
  for (const [name, raw] of Object.entries(unclosed)) {
    it(`触发：${name}`, () => {
      const r = parseGroupReply(raw, mk());
      expect(r.needsOwner, name).toBe("要不要上线");
      expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
      expect(r.text).not.toMatch(/\[\[|【需/);
    });
  }

  it("未闭合围栏里的标记自己也没收尾（模型漏了两处）：照样取到行尾", () => {
    const r = parseGroupReply("好的\n```bash\nnpm test\n[[需属主确认：要不要上线", mk());
    expect(r.needsOwner).toBe("要不要上线");
  });

  it("闭合的围栏照旧不触发（对照，防翻过头）；围栏之后再出现没收尾的围栏，只有后者触发", () => {
    const demo = "[[需属主确认：示例]]";
    const raw = `先看示例：\n\`\`\`\n${demo}\n\`\`\`\n再看这段：\n\`\`\`bash\n${MARK}`;
    const r = strip(raw);
    expect(r.explains).toEqual(["要不要上线"]);
    expect(r.text).toBe(`先看示例：\n\`\`\`\n${demo}\n\`\`\`\n再看这段：\n\`\`\`bash\n`);
  });

  it("没收尾的起头在前、后面有一个完整的围栏：完整的围栏仍是代码，里面的示例不触发", () => {
    const demo = "[[需属主确认：示例]]";
    const raw = `\`\`\`bash\n外面的话\n~~~\n${demo}\n~~~\n结束`;
    const r = strip(raw);
    expect(r.found).toBe(false);
    expect(r.text).toBe(raw);
  });

  it("未闭合围栏后面的行仍识别行内代码：行内代码里的示例不触发", () => {
    const raw = "好的\n```bash\n写法是 `[[需属主确认：示例]]` 这样";
    const r = strip(raw);
    expect(r.found).toBe(false);
    expect(r.text).toBe(raw);
    // 同一行里代码外还有一个真的：只触发代码外的
    const r2 = strip("好的\n```bash\n写法 `[[需属主确认：示例]]` 然后 [[需属主确认：真的]]");
    expect(r2.explains).toEqual(["真的"]);
  });

  it("与哨兵行剔除的交互：没收尾的围栏不是代码，里面的 NO_REPLY 行照旧被剔（与 L4-06 的「闭合围栏才保留」一致）", () => {
    const r = parseGroupReply("好的\n```\nNO_REPLY\n以上", mk());
    expect(r.text).toBe("好的\n```\n以上");
  });

  it("与内容截断的交互：没收尾的围栏之后的标记说明超长 → 仍按 200 字截断（末字省略号）", () => {
    const long = "很长的说明".repeat(80); // 400 字
    const r = parseGroupReply(`好的\n\`\`\`bash\nnpm test\n[[需属主确认：${long}]]`, mk());
    expect(Array.from(r.needsOwner ?? "")).toHaveLength(200);
    expect(r.needsOwner?.endsWith("…")).toBe(true);
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
  });

  it("与「说明里含空行」的交互：没收尾的围栏之后、说明跨空行的标记照常收进整段说明", () => {
    const r = parseGroupReply("好的\n```bash\nnpm test\n[[需属主确认：前\n\n后]]", mk());
    expect(r.needsOwner).toBe("前 后");
    expect(r.text).toBe(`好的\n\`\`\`bash\nnpm test\n${ownerLine("前 后")}`);
  });

  describe("线性：n → 2n 耗时比", () => {
    const demo = "[[需属主确认：示例]]";
    const cases: Record<string, (n: number) => string> = {
      "大量未闭合的围栏起头（反引号）": (n) => "```a\n".repeat(n * 2) + MARK,
      "大量未闭合的围栏起头（波浪线）": (n) => "~~~a\n".repeat(n * 2) + MARK,
      "反引号与波浪线交替的未闭合起头": (n) => "```a\n~~~a\n".repeat(n) + MARK,
      "未闭合起头 + 后面大量完整围栏": (n) => `\`\`\`a\n${`~~~\n${demo}\n~~~\n`.repeat(n)}${MARK}`,
      "大量起头长度递减、都不闭合": (n) => `${Array.from({ length: Math.min(n, 120) }, (_, k) => `${"`".repeat(130 - k)}a\n`).join("")}${MARK}`,
      "未闭合起头 + 大量未闭合标记": (n) => `\`\`\`\n${"[[需属主确认：x\n".repeat(n)}`,
      "每个围栏都闭合、起止行很多": (n) => `\`\`\`\n${demo}\n\`\`\`\n`.repeat(n),
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk());
        }, 4000, { trials: 9 });
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// L4-06 · 闭合围栏里的 NO_REPLY 行不剔
// ---------------------------------------------------------------------------

describe("L4-06 · 闭合围栏里的 NO_REPLY 行是示例：不剔（不留空围栏）；围栏外的照旧剔", () => {
  it("报告复现：格式如下 + 围栏里的 NO_REPLY → 原样发出", () => {
    const raw = "格式如下：\n```\nNO_REPLY\n```\n以上";
    const r = parseGroupReply(raw, mk());
    expect(r.kind).toBe("send");
    expect(r.text).toBe(raw);
  });

  const fenced: Record<string, string> = {
    "带语言的围栏": "格式如下：\n```text\nNO_REPLY\n```\n以上",
    "波浪线围栏": "格式如下：\n~~~\nNO_REPLY\n~~~\n以上",
    "围栏缩进 3 格": "格式如下：\n   ```\nNO_REPLY\n   ```\n以上",
    "围栏里带说明的哨兵行": "格式如下：\n```\nNO_REPLY：对方只是确认\n```\n以上",
    "围栏里整行被反引号包住的哨兵行": "格式如下：\n```\n`NO_REPLY：对方只是确认`\n```\n以上",
    "围栏里的列表符形态": "格式如下：\n```\n* NO_REPLY：对方只是确认\n```\n以上",
    "全角哨兵词": "格式如下：\n```\nＮＯ＿ＲＥＰＬＹ\n```\n以上",
    "零宽夹在哨兵词里": "格式如下：\n```\nNO\u200b_REPLY\n```\n以上",
    "围栏里夹多行": "格式如下：\n```\na\nNO_REPLY\nb\n```\n以上",
    "全角反引号围栏": "格式如下：\n｀｀｀\nNO_REPLY\n｀｀｀\n以上",
    "四个反引号的围栏（里面有三个反引号）": "格式如下：\n````\n```\nNO_REPLY\n```\n````\n以上",
    "围栏在最前面（首个非空行是围栏起头、不是哨兵）": "```\nNO_REPLY\n```\n以上",
    "围栏在最后": "格式如下：\n```\nNO_REPLY\n```",
  };
  for (const [name, raw] of Object.entries(fenced)) {
    it(`原样保留：${name}`, () => {
      const r = parseGroupReply(raw, mk());
      expect(r.kind, name).toBe("send");
      expect(r.text, name).toBe(raw);
    });
  }

  it("围栏里的保留、围栏外的照旧剔（同一条回复里两处都有）", () => {
    const r = parseGroupReply("开头\nNO_REPLY\n```\nNO_REPLY\n```\nNO_REPLY：对方只是确认\n结尾", mk());
    expect(r.text).toBe("开头\n```\nNO_REPLY\n```\n结尾");
  });

  it("两个围栏之间的 NO_REPLY 行不在围栏里：照旧剔", () => {
    const r = parseGroupReply("```\nx\n```\nNO_REPLY\n```\ny\n```", mk());
    expect(r.text).toBe("```\nx\n```\n```\ny\n```");
  });

  it("夹在正文里的 NO_REPLY 行（没有围栏）照旧剔，列表符形态的带说明行同样被剔（审查方认可的现状）", () => {
    expect(parseGroupReply("第一段\nNO_REPLY\n第二段", mk()).text).toBe("第一段\n第二段");
    expect(parseGroupReply("a\n* NO_REPLY：对方只是确认\nb", mk()).text).toBe("a\nb");
  });

  it("首个非空行是哨兵：整段静默（不受围栏判定影响）", () => {
    expect(parseGroupReply("NO_REPLY\n```\nx\n```", mk())).toEqual(SILENT);
    expect(parseGroupReply("\n\nNO_REPLY\n对方只是在确认", mk())).toEqual(SILENT);
  });

  it("整段只是一个围栏包住的哨兵：仍静默（第六轮既有语义）", () => {
    expect(parseGroupReply("```\nNO_REPLY\n```", mk())).toEqual(SILENT);
    expect(parseGroupReply("```text\nNO_REPLY\n```", mk())).toEqual(SILENT);
  });

  it("围栏里的 NO_REPLY 保留之后，围栏外的「需属主确认」照常触发", () => {
    const r = parseGroupReply("格式如下：\n```\nNO_REPLY\n```\n[[需属主确认：要不要上线]]", mk());
    expect(r.needsOwner).toBe("要不要上线");
    expect(r.text).toBe(`格式如下：\n\`\`\`\nNO_REPLY\n\`\`\`\n${ownerLine("要不要上线")}`);
  });

  it("没有 NO_REPLY 行的回复：不做围栏分析也不受影响（含围栏的普通回复原样）", () => {
    const raw = "看这段：\n```ts\nconst a = 1;\n```\n完";
    expect(parseGroupReply(raw, mk()).text).toBe(raw);
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量围栏、每个里面一行 NO_REPLY": (n) => "```\nNO_REPLY\n```\n".repeat(n),
      "大量围栏外的 NO_REPLY 行": (n) => "x\nNO_REPLY\n".repeat(n),
      "没收尾的围栏 + 大量 NO_REPLY 行": (n) => `\`\`\`\n${"NO_REPLY\n".repeat(n)}`,
      "大量没收尾的围栏起头 + 末尾一行 NO_REPLY": (n) => `${"```a\n".repeat(n * 2)}x\nNO_REPLY\n`,
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => parseGroupReply(raw, mk());
        }, 4000, { trials: 9 });
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// L4-10 · 孤立 `[` 没法配平时回退取第一个闭合符，不吞后文
// ---------------------------------------------------------------------------

describe("L4-10 · 说明里有孤立 `[`：回退取第一个闭合符，同一行的后文与后面的 [[链接]] 不被吞进说明", () => {
  it("报告复现：说明 = `用 [ 表示`，后半句与后面的链接留在正文", () => {
    const raw = "[[需属主确认：用 [ 表示]] 后面还有一句话 [[链接]]";
    const r = strip(raw);
    expect(r.explains).toEqual(["用 [ 表示"]);
    expect(r.text).toBe(" 后面还有一句话 [[链接]]");
    const p = parseGroupReply(raw, mk());
    expect(p.needsOwner).toBe("用 [ 表示");
    expect(p.text).toBe(`后面还有一句话 [[链接]]\n${ownerLine("用 [ 表示")}`);
    expect(p.text).toContain("[[链接]]");
  });

  const loneBracket: Array<[string, string, string, string]> = [
    // [名称, 原文, 期望说明, 期望剥完后的文本]
    ["后面跟多个链接", "[[需属主确认：用 [ 表示]] 见 [[链接]] 和 [[文档]]", "用 [ 表示", " 见 [[链接]] 和 [[文档]]"],
    ["前面有正文", "ok\n[[需属主确认：用 [ 表示]] 后面还有一句话 [[链接]]", "用 [ 表示", "ok\n 后面还有一句话 [[链接]]"],
    ["孤立 [ 在说明开头", "[[需属主确认：[ 开头]] 后文 [[链接]]", "[ 开头", " 后文 [[链接]]"],
    ["方头括号族：说明里有孤立【", "【需属主确认：用【表示】 后面还有一句话 【链接】", "用【表示", " 后面还有一句话 【链接】"],
    ["后文只有一个普通的 [x] 引用", "[[需属主确认：用 [ 表示]] 见 [1]", "用 [ 表示", " 见 [1]"],
  ];
  for (const [name, raw, explain, rest] of loneBracket) {
    it(name, () => {
      const r = strip(raw);
      expect(r.explains).toEqual([explain]);
      expect(r.text).toBe(rest);
    });
  }

  describe("第七轮 K4-05 的既有语义仍成立", () => {
    const keep: Array<[string, string, string]> = [
      ["闭合符串里多一个 ]：a[0]]] → 说明 看 a[0]", "ok\n[[需属主确认：看 a[0]]]", "看 a[0]"],
      ["嵌套下标、闭合符就在行尾", "ok\n[[需属主确认：看 a[b[0]]]]", "看 a[b[0]]"],
      ["说明里有 ]] 且后面还有字，行尾才是闭合符（取行尾，说明里保留 ]]）", "ok\n[[需属主确认：数组 a[b[0]] 怎么取]]", "数组 a[b[0]] 怎么取"],
      ["说明里有成对的 [[x]]", "ok\n[[需属主确认：看 [[x]] 这段再定]]", "看 [[x]] 这段再定"],
      ["方头括号：说明里有成对的【】", "ok\n【需属主确认：看【x】这段】", "看【x】这段"],
    ];
    for (const [name, raw, explain] of keep) {
      it(name, () => {
        expect(strip(raw).explains).toEqual([explain]);
        expect(parseGroupReply(raw, mk()).text).toBe(`ok\n${ownerLine(explain)}`);
      });
    }

    it("说明没配平且行尾没有闭合符：退回第一个闭合符（后面的正文保留）", () => {
      const r = strip("ok\n[[需属主确认：看 a[0 再说]] 然后别的");
      expect(r.explains).toEqual(["看 a[0 再说"]);
      expect(r.text).toBe("ok\n 然后别的");
    });

    it("同一行有别的标记起头：不跨过去取行尾", () => {
      const r = parseGroupReply("ok\n[[需属主确认：A[ ]] 文字 [[需属主确认：B]]", mk());
      expect(r.needsOwner).toBe("A[");
      expect(r.text).toContain("文字");
      expect(r.text).not.toContain("B]]");
    });

    it("说明里含空行：行尾闭合 + 近 + 配平 + 没有别的起头 → 收进来（与第七轮一致）", () => {
      const r = parseGroupReply("ok\n[[需属主确认：前\n\n后]]", mk());
      expect(r.needsOwner).toBe("前 后");
    });

    it("说明里含空行但不满足条件：不跨过去（后文行中间的 ]] / 没配平 / 别的起头）", () => {
      const a = parseGroupReply("[[需属主确认：要不要上线\n\n后面的无关段落 a]] b\n另一段 c", mk());
      expect(a.needsOwner).toBe("要不要上线");
      const b = parseGroupReply("[[需属主确认：要不要上线\n\n另一段 a[0]]", mk());
      expect(b.needsOwner).toBe("要不要上线");
      const c = parseGroupReply("[[需属主确认：第一条\n\n正文\n[[需属主确认：第二条]]", mk());
      expect(c.needsOwner).toBe("第一条");
    });
  });

  it("【残余·推演/实测均如此】孤立 [ 之后、同一行行尾恰好有一个能凑平括号的 ]]：仍取行尾那个（与「取第一个」的差异）", () => {
    // 取行尾的条件是「它能让说明配平」，按「左括号数 ≤ 右括号数」判：`用 [ 表示]] 然后 x]]` 的行尾 ]] 让 opens=1 ≤ closes=2，
    // 被当成凑平；`数组 a[b[0]] 怎么取]]` 是 2 / 2。保留的是后者（K4-05 钉着），代价是前者的后半句被收进说明。
    // 改成「恰好相等才取行尾」可以把前者分出去（沙箱实测：整个 group-reply-protocol-r7 / r8 / fold-fuzz 里只有本条会变），
    // 本轮未采用——多一个 `]` 的写法（`看 a[0]] 的值]]`）会改取第一个闭合符，留给后续取舍。
    const r = strip("[[需属主确认：用 [ 表示]] 然后 x]]");
    expect(r.explains).toEqual(["用 [ 表示]] 然后 x"]);
  });

  describe("线性：n → 2n 耗时比（直接测 stripNeedsOwnerMarkers：被改的就是它，少受 @ 解析等无关开销的影响）", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量「孤立 [ + 后面一串 [[链接]]」（每行一个）": (n) => "[[需属主确认：用 [ 表示]] 见 [[链接]]\n".repeat(n),
      "同一行大量「孤立 [」标记": (n) => "[[需属主确认：用 [ 表示]] 见 [[链接]] ".repeat(n),
      "孤立 [ + 一行很长的无起头后文": (n) => `[[需属主确认：用 [ 表示]] ${"见 [[链接]] ".repeat(n * 4)}`,
      "孤立 [ + 一行很长的、行尾有 ]] 的后文（无起头）": (n) => `[[需属主确认：用 [ 表示]] ${"见 [x ".repeat(n * 4)}]]`,
      "孤立 [ + 一行很长的、行尾 ]] 能凑平括号的后文（取行尾，说明吞掉整段）": (n) => `[[需属主确认：用 [ 表示]] ${"见 x ".repeat(n * 4)}]]`,
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => stripNeedsOwnerMarkers(raw, () => {});
        }, 4000, { trials: 9 });
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});
