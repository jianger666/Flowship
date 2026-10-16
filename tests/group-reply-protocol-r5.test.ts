/**
 * 第五轮 review（G1 / G2）：群答疑回复协议的缺口回归。
 *
 * 安全相关的用例只用最小合成数据：目的是证明「校验会拒绝 / 会净化」，不是构造可用载荷。
 */
import { describe, expect, it } from "vitest";
import type {
  GroupMember,
  ParsedGroupReply,
} from "@/lib/server/feishu-bridge/group-contract";
import {
  parseGroupReply,
  type ParseGroupReplyCtx,
} from "@/lib/server/feishu-bridge/group-reply-protocol";

const tag = (id: string, name: string) => `<at user_id="${id}">${name}</at>`;

const members: GroupMember[] = [
  { openId: "ou_owner", name: "曾进有", kind: "user" },
  { openId: "ou_zhang", name: "张三", kind: "user" },
  { openId: "ou_an", name: "李安", kind: "user" },
  { openId: "ou_anruo", name: "安若流年", kind: "bot" },
  { openId: "ou_self", name: "Flowship机器人", kind: "bot" },
  { openId: "ou_bob", name: "Bob", kind: "user" },
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

const TRUSTED_IDS = new Set([
  "ou_owner",
  "ou_zhang",
  "ou_an",
  "ou_anruo",
  "ou_bob",
  "ou_blank",
]);

/** 本模块自己拼出的规范标签：id 与名字里都不可能再有尖括号 */
const CANON_TAG_RE = /<at user_id="([^"<>]*)">([^<>]*)<\/at>/g;

/**
 * 核心不变量：text 里每一个 `<at` 都必须是「可信 id 的规范标签」且该 id 在 mentions 里；
 * 剔掉这些规范标签后，不许残留任何 `<at` / `</at`（不论大小写 / 空白 / 闭合与否）。
 */
const expectOnlyTrustedAtTags = (r: ParsedGroupReply, label = ""): void => {
  const mentionIds = new Set(r.mentions.map((m) => m.openId));
  for (const m of r.text.matchAll(CANON_TAG_RE)) {
    expect(TRUSTED_IDS.has(m[1]), `${label} 不可信 id 出现在 text：${m[1]}`).toBe(true);
    expect(mentionIds.has(m[1]), `${label} 标签 id 不在 mentions：${m[1]}`).toBe(true);
  }
  // 用占位符而不是空串替换：删掉规范标签会让它两侧的文字粘出「测试自己造的」假标签
  const rest = r.text.replace(CANON_TAG_RE, "\u0000");
  // 「at 标签」= `<at` / `</at` 后面不再跟名字字符（`<atlas>` / `</atX` 不是标签）
  expect(rest, `${label} 残留了未经校验的 at 标签片段`).not.toMatch(
    /<\/?at(?![A-Za-z0-9_-])/i,
  );
};

describe("G1-01 · 不可信 id 的嵌套 at 标签不得拼出完整标签", () => {
  const cases: Record<string, string> = {
    "审查报告里的复现：外层不可信 + 内层 all": `<at user_id="ou_fake"><at user_id="all">X</at></at>`,
    三层嵌套: `<at user_id="ou_fake"><at user_id="ou_fake2"><at user_id="all">X</at></at></at>`,
    闭合标签单独出现在前: `</at><at user_id="all">X</at>`,
    闭合标签单独出现在后: `<at user_id="ou_fake">a</at></at></at>`,
    大小写与空白变体: `<AT  USER_ID = 'ou_fake' ><aT user_id='all'>X</At></AT >`,
    "可信外层 + 不可信内层": `<at user_id="ou_an"><at user_id="all">X</at></at>`,
    "本机 id 外层 + 不可信内层": `<at user_id="ou_self"><at user_id="all">X</at></at>`,
    "id=all 的卡片 md 写法": `<at id=all></at> 注意`,
    无引号属性: `<at user_id=all>X</at>`,
    只有开标签没有闭合: `<at user_id="all">X`,
    "开标签残缺（没有 >）": `前 <at user_id="all"`,
    "外层不可信，内层 `<` 与外层闭合标签拼接": `<at user_id="ou_fake">x<</at>at user_id="all">X</at>`,
    "本机 id 外层，内层尾部 `<` 与后文拼接": `<at user_id="ou_self">x<</at>at user_id="all">X</at>`,
    "外层名字为空的可信 id": `<at user_id="ou_blank"><at user_id="all">X</at></at>`,
  };
  for (const [name, raw] of Object.entries(cases)) {
    for (const requester of [human, bot]) {
      it(`${name}（提问人${requester.isBot ? "是机器人" : "是真人"}）`, () => {
        const r = parseGroupReply(
          raw,
          mk({
            requester,
            members: [...members, { openId: "ou_blank", name: "", kind: "user" }],
          }),
        );
        expectOnlyTrustedAtTags(r, name);
      });
    }
  }

  it("复现输入：mentions 里没有的 all 标签不得出现在 text", () => {
    const r = parseGroupReply(
      `<at user_id="ou_fake"><at user_id="all">X</at></at>`,
      mk({ requester: bot }),
    );
    // 文字可以留（已被拆成不会被飞书解析的普通字符），但不能是 `<at ...>` 标签
    expect(r.text).not.toMatch(/<at/i);
    expect(r.text).not.toMatch(/<\/at/i);
    expect(r.mentions).toEqual([]);
  });

  it("可信外层 + 不可信内层：仍只有外层那个可信 @", () => {
    const r = parseGroupReply(
      `<at user_id="ou_an"><at user_id="all">X</at></at>`,
      mk({ requester: bot }),
    );
    expect(r.mentions).toEqual([{ openId: "ou_an", name: "李安" }]);
    expect(r.text.startsWith(tag("ou_an", "李安"))).toBe(true);
  });

  it("「需属主确认」说明里的嵌套 / 残缺 at 标签也不拼出新标签", () => {
    for (const note of [
      `<at user_id="x"><at user_id="all">X</at></at>`,
      `<<at x>at user_id="all">X</at>`,
      `<at user_id="all"`,
    ]) {
      const r = parseGroupReply(`ok\n[[需属主确认：${note}]]`, mk({ requester: bot }));
      expectOnlyTrustedAtTags(r, note);
      expect(r.needsOwner ?? "").not.toMatch(/<\/?at/i);
    }
  });

  it("夹带标记剥离后拼出的标签同样被拦（标记一剥，两侧文本会粘在一起）", () => {
    const r = parseGroupReply(
      `<at user_id="all"[[需属主确认：确认一下]]>X</at>`,
      mk({ requester: bot }),
    );
    expectOnlyTrustedAtTags(r);
  });

  it("fuzz（固定种子）：随机拼接 at 开 / 闭标签片段，每个 <at 都对应 mentions 里的可信条目", () => {
    // mulberry32：固定种子，失败可复现
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const frags = [
      `<at user_id="ou_an">`,
      `<at user_id="ou_fake">`,
      `<at user_id="all">`,
      `<at user_id='ou_self'>`,
      `<AT USER_ID = "all" >`,
      `<at id=all>`,
      `</at>`,
      `</AT >`,
      `</at`,
      `<at`,
      `<`,
      `>`,
      `at user_id="all">`,
      `/at>`,
      `<at user_id="ou_fake"`,
      `李安`,
      `X`,
      `@李安`,
      `@张三`,
      `@宿主`,
      `[[需属主确认：`,
      `]]`,
      `\n`,
      ` `,
    ];
    const rand = rng(20261015);
    for (let n = 0; n < 600; n++) {
      const len = 1 + Math.floor(rand() * 14);
      let raw = "";
      for (let k = 0; k < len; k++) raw += frags[Math.floor(rand() * frags.length)];
      for (const requester of [human, bot]) {
        const r = parseGroupReply(raw, mk({ requester }));
        expectOnlyTrustedAtTags(r, `seed#${n} ${JSON.stringify(raw)}`);
      }
    }
  });
});

describe("G1-03 / G2-03 · prompt 展示的是清洗后的名字，解析器两种写法都认", () => {
  const li: GroupMember = { openId: "ou_li", name: "[外包]李四", kind: "user" };

  it("写 prompt 里展示的清洗名（去掉方括号）→ 真 @", () => {
    const r = parseGroupReply(
      "@外包李四 看下",
      mk({ members: [...members, li], requester: bot }),
    );
    expect(r.mentions).toEqual([{ openId: "ou_li", name: "[外包]李四" }]);
    expect(r.unresolvedAts).toEqual([]);
    expect(r.text).toBe(`${tag("ou_li", "[外包]李四")} 看下`);
  });

  it("写原名也照旧命中（既有行为不变）", () => {
    const r = parseGroupReply(
      "@[外包]李四 看下",
      mk({ members: [...members, li], requester: bot }),
    );
    expect(r.mentions).toEqual([{ openId: "ou_li", name: "[外包]李四" }]);
  });

  it("尖括号 / 连续空白 / 超长截断后的清洗名都认", () => {
    const long = "超长昵称".repeat(15); // 60 字，prompt 里会被截成前 39 字 + 「…」
    const ms: GroupMember[] = [
      { openId: "ou_a", name: "李<四>", kind: "user" },
      { openId: "ou_b", name: "王  小明", kind: "user" },
      { openId: "ou_c", name: long, kind: "user" },
    ];
    const clipped = `${Array.from(long).slice(0, 39).join("")}…`;
    const r = parseGroupReply(
      `@李四 你好 @王 小明 在吗 @${clipped} 收到`,
      mk({ members: ms, requester: bot }),
    );
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_a", "ou_b", "ou_c"]);
    expect(r.unresolvedAts).toEqual([]);
  });

  it("与 prompt 的 formatRosterSection 对拍：prompt 里列出的每个名字照抄都能 @ 到对应的人", async () => {
    const { formatRosterSection } = await import(
      "@/lib/server/feishu-bridge/group-answer-context"
    );
    const ms: GroupMember[] = [
      { openId: "ou_p1", name: "[外包]李四", kind: "user" },
      { openId: "ou_p2", name: "李<五>", kind: "user" },
      { openId: "ou_p3", name: "A   B", kind: "bot" },
      { openId: "ou_p4", name: "超长昵称".repeat(15), kind: "user" },
      { openId: "ou_p5", name: "张三", kind: "user" },
    ];
    const lines = formatRosterSection({
      members: ms,
      requester: { openId: "ou_p5", name: "张三", isBot: false },
    });
    const shown = lines
      .filter((l) => l.startsWith("  - "))
      .map((l) => l.slice(4, l.lastIndexOf("（")));
    expect(shown).toHaveLength(ms.length);
    shown.forEach((name, idx) => {
      const r = parseGroupReply(
        `@${name} 好`,
        mk({ members: ms, owner: undefined, requester: bot, selfOpenId: undefined }),
      );
      expect(
        r.mentions.map((m) => m.openId),
        `prompt 展示名 ${JSON.stringify(name)} 没能解析成 ${ms[idx].openId}`,
      ).toEqual([ms[idx].openId]);
    });
  });

  it("二义不变：同一清洗名对应不同 open_id → 仍判歧义，不 @", () => {
    const ms: GroupMember[] = [
      { openId: "ou_x", name: "[外包]李四", kind: "user" },
      { openId: "ou_y", name: "<外包>李四", kind: "user" },
    ];
    const r = parseGroupReply("@外包李四 看下", mk({ members: ms, requester: bot }));
    expect(r.mentions).toEqual([]);
    expect(r.unresolvedAts).toEqual(["外包李四"]);
  });

  it("二义不变：原名与别人的清洗名同长度冲突时，原名命中者优先（和修之前一样）", () => {
    const ms: GroupMember[] = [
      { openId: "ou_x", name: "[外包]李四", kind: "user" },
      { openId: "ou_real", name: "外包李四", kind: "user" },
    ];
    const r = parseGroupReply("@外包李四 看下", mk({ members: ms, requester: bot }));
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_real"]);
    expect(r.unresolvedAts).toEqual([]);
  });

  it("最长匹配跨原名 / 清洗名：清洗名更长时不被较短的原名截断", () => {
    const ms: GroupMember[] = [
      { openId: "ou_short", name: "外包", kind: "user" },
      { openId: "ou_li", name: "[外包]李四", kind: "user" },
    ];
    const r = parseGroupReply("@外包李四 看下", mk({ members: ms, requester: bot }));
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_li"]);
  });

  it("清洗后为空的名字不参与匹配", () => {
    const ms: GroupMember[] = [{ openId: "ou_e", name: "[]<>", kind: "user" }];
    const r = parseGroupReply("@ 你好 @路人", mk({ members: ms, requester: bot }));
    expect(r.mentions).toEqual([]);
  });
});

const SILENT = { kind: "silent", text: "", mentions: [], unresolvedAts: [] };

describe("G1-08 · NO_REPLY 的常见变形也算哨兵", () => {
  const silentCases: Record<string, string> = {
    加粗: "**NO_REPLY**",
    下划线加粗: "__NO_REPLY__",
    斜体: "*NO_REPLY*",
    删除线: "~~NO_REPLY~~",
    加粗加句号: "**NO_REPLY。**",
    后面跟全角括号说明: "NO_REPLY（对方只是确认）",
    后面跟半角括号说明: "NO_REPLY(对方只是确认)",
    后面跟冒号说明: "NO_REPLY：对方只是确认，没有提问",
    后面跟破折号说明: "NO_REPLY - 对方只是确认",
    "加粗 + 括号说明": "**NO_REPLY**（对方只是确认）",
    "哨兵独占首行，后面是解释": "NO_REPLY\n对方只是在确认",
    "首行前有空行": "\n\nNO_REPLY\n\n对方只是在确认，不需要回应。",
    "加粗首行 + 解释": "**NO_REPLY**\n对方只是在确认",
  };
  for (const [name, raw] of Object.entries(silentCases)) {
    it(`silent：${name}`, () => {
      for (const requester of [human, bot]) {
        expect(parseGroupReply(raw, mk({ requester }))).toEqual(SILENT);
      }
    });
  }

  it("夹在正文中间 / 末尾的带说明哨兵行：只剔那一行，其余照发（既有行为的延伸）", () => {
    const mid = parseGroupReply("第一段\nNO_REPLY（不用回）\n第二段", mk({ requester: bot }));
    expect(mid.kind).toBe("send");
    expect(mid.text).toBe("第一段\n第二段");
    const tail = parseGroupReply("结论：可以\n**NO_REPLY**", mk({ requester: bot }));
    expect(tail.text).toBe("结论：可以");
  });

  it("不是哨兵的不误杀：哨兵词只是别的词的前缀 / 夹在行里 / 前面有正文", () => {
    for (const raw of [
      "NO_REPLY_FOO 是个变量名",
      "NO_REPLYING 不是哨兵",
      "好的 NO_REPLY 吧",
      "答复如下\nNO_REPLY 是哨兵词",
    ]) {
      const r = parseGroupReply(raw, mk({ requester: bot }));
      expect(r.kind, raw).toBe("send");
      expect(r.text, raw).toContain("NO_REPLY");
    }
  });
});

describe("G1-09 · 邮箱里的 @ 不是 @ 某人", () => {
  it("local@Bob.com 原样保留，不被改写成 at 标签", () => {
    const r = parseGroupReply("发到 zhang@Bob.com 就行", mk({ requester: bot }));
    expect(r.text).toBe("发到 zhang@Bob.com 就行");
    expect(r.mentions).toEqual([]);
    expect(r.unresolvedAts).toEqual([]);
  });

  it("带点号的本地部分 / 多级域名也一样", () => {
    const r = parseGroupReply("联系 zhang.san+x@Bob.com.cn 或 li-an@Bob.io", mk({ requester: bot }));
    expect(r.text).toBe("联系 zhang.san+x@Bob.com.cn 或 li-an@Bob.io");
    expect(r.mentions).toEqual([]);
  });

  it("真人提问：邮箱不算真 @，仍补 @ 提问人", () => {
    const r = parseGroupReply("发到 zhang@Bob.com 就行", mk());
    expect(r.text).toBe(`${tag("ou_zhang", "张三")} 发到 zhang@Bob.com 就行`);
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_zhang"]);
  });

  it("正常的 @Bob 不受影响（行首 / 空格后 / 中文后紧贴 / 句末带点）", () => {
    for (const raw of ["@Bob 好", "请 @Bob 看", "请@Bob 看", "麻烦 @Bob."]) {
      const r = parseGroupReply(raw, mk({ requester: bot }));
      expect(r.mentions.map((m) => m.openId), raw).toEqual(["ou_bob"]);
    }
  });
});

describe("G1-07 · parseGroupReply 在病态输入上不是二次型", () => {
  // 修之前实测：4 万个句号 ≈ 9 秒、4 万个 `<at` 的说明 ≈ 2.7 秒，且按平方增长。
  // 预算 1.5 秒只用来抓「慢出几个数量级」，线性实现在这些输入上是个位数毫秒
  const BUDGET_MS = 1500;
  const timed = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const run = (raw: string) => parseGroupReply(raw, mk());

  it("末尾标点剥壳：5 万个半角句号 / 全角句号 + 一个字", () => {
    for (const dot of [".", "。", "！", "!"]) {
      const evil = `${dot.repeat(50_000)}x`;
      expect(timed(() => run(evil)), dot).toBeLessThan(BUDGET_MS);
      expect(run(evil).kind).toBe("send");
    }
  });

  it("「需属主确认」说明里有 6 万个 `<at` 碎片", () => {
    const evil = `ok\n[[需属主确认：${"<at".repeat(60_000)}]]`;
    let r: ParsedGroupReply | undefined;
    expect(timed(() => (r = run(evil)))).toBeLessThan(BUDGET_MS);
    expect(r?.needsOwner).toBeTruthy();
    expect(r?.needsOwner ?? "").not.toMatch(/<\/?at(?![A-Za-z0-9_-])/i);
  });

  it("60 万字符：大量没有闭合的标记 / 大量没有 </at> 的开标签 / 说明里大量开标签", () => {
    // 60 万是为了让二次型实现明确越过预算；真实上限（飞书单条消息）约 15 万
    for (const evil of [
      "[[需属主确认：".repeat(600_000 / 8),
      '<at user_id="a">'.repeat(600_000 / 16),
      `[[需属主确认：${"<at x>".repeat(600_000 / 6)}]]`,
    ]) {
      expect(timed(() => run(evil))).toBeLessThan(BUDGET_MS);
    }
  });

  it("标记后的大段空白也不拖慢（剥标记后的空行整理）", () => {
    const evil = `x${" ".repeat(200_000)}y\n[[需属主确认：a]]`;
    expect(timed(() => run(evil))).toBeLessThan(BUDGET_MS);
  });

  it("其余常见病态形态：大量 @ / 邮箱形态 / 围栏 / 强调符", () => {
    for (const evil of [
      "@".repeat(200_000),
      "@a".repeat(100_000),
      "a@b".repeat(60_000),
      "```a\n".repeat(40_000),
      `${"*".repeat(200_000)}x`,
      "NO_REPLY（x）\n".repeat(14_000),
    ]) {
      expect(timed(() => run(evil))).toBeLessThan(BUDGET_MS);
    }
  });
});

describe("G1-10 · 未闭合的 [[需属主确认：… 也要落地", () => {
  it("末尾未闭合：剥标记、补属主 @、needsOwner 取到行尾", () => {
    const r = parseGroupReply("先这样\n[[需属主确认：接口是否分页", mk({ requester: bot }));
    expect(r.needsOwner).toBe("接口是否分页");
    expect(r.text).toBe(
      `先这样\n${tag("ou_owner", "曾进有")} 需要你确认：接口是否分页`,
    );
    expect(r.text).not.toContain("[[");
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
  });

  it("中间行未闭合：说明只取到行尾，后面的正文保留", () => {
    const r = parseGroupReply(
      "结论 A\n[[需属主确认:要不要上线\n后面还有一行正文",
      mk({ requester: bot }),
    );
    expect(r.needsOwner).toBe("要不要上线");
    expect(r.text).toContain("结论 A");
    expect(r.text).toContain("后面还有一行正文");
    expect(r.text).not.toContain("[[");
  });

  it("只漏了一个 ]：多余的 ] 不进说明", () => {
    const r = parseGroupReply("ok\n[[需属主确认：范围]", mk({ requester: bot }));
    expect(r.needsOwner).toBe("范围");
    expect(r.text).not.toContain("[[");
  });

  it("未闭合且没有说明：标记剥掉、不写 needsOwner", () => {
    const r = parseGroupReply("正文\n[[需属主确认：", mk({ requester: bot }));
    expect(r.text).toBe("正文");
    expect(r.needsOwner).toBeUndefined();
  });

  it("真人提问：未闭合标记同样补确认行，并补 @ 提问人（G1-05 口径）", () => {
    const r = parseGroupReply("先这样\n[[需属主确认：口径", mk());
    expect(r.needsOwner).toBe("口径");
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_zhang", "ou_owner"]);
  });

  it("闭合标记不受影响：仍只取闭合标记的说明（可跨行）", () => {
    const r = parseGroupReply("ok\n[[需属主确认：第一行\n第二行]]\n尾巴", mk({ requester: bot }));
    expect(r.needsOwner).toBe("第一行 第二行");
    expect(r.text).toContain("尾巴");
  });
});
