/**
 * 第五轮 review G1-01 补充：at 标签的「写法变体」与更严的随机不变量。
 *
 * 与 tests/group-reply-protocol-r5.test.ts 的区别：那边的不变量只拦「`<at` / `</at` 紧挨着」的写法；
 * 这里把 `<` 与 `at` 之间夹空白 / 零宽字符 / 斜杠后空白的写法也算进「疑似 at 标签」——
 * 飞书服务端解析是否宽松我们没法验证，净化宁可多拆一个 `<`（只是显示成全角），也不留下一个可能被解析的变体。
 * 安全相关用例只用最小合成数据：目的是证明「会净化」，不是构造可用载荷。
 */
import { describe, expect, it } from "vitest";

import type { GroupMember } from "@/lib/server/feishu-bridge/group-contract";
import {
  parseGroupReply,
  type ParseGroupReplyCtx,
} from "@/lib/server/feishu-bridge/group-reply-protocol";

const members: GroupMember[] = [
  { openId: "ou_owner", name: "曾进有", kind: "user" },
  { openId: "ou_zhang", name: "张三", kind: "user" },
  { openId: "ou_an", name: "李安", kind: "user" },
  { openId: "ou_self", name: "机器人", kind: "bot" },
  { openId: "ou_bob", name: "Bob", kind: "user" },
  // 群昵称谁都能改：名字里夹标签片段也不能拼出标签
  { openId: "ou_nick", name: `</at><at user_id="all">改名`, kind: "user" },
];

const TRUSTED_IDS = new Set([...members.map((m) => m.openId), "ou_req"]);

const mk = (over: Partial<ParseGroupReplyCtx> = {}): ParseGroupReplyCtx => ({
  members,
  owner: { openId: "ou_owner", name: "曾进有" },
  requester: { openId: "ou_req", name: "提问人", isBot: true },
  selfOpenId: "ou_self",
  ...over,
});

/** 宽松的「疑似 at 标签起点」：`<` 后可夹空白 / 零宽字符 / 斜杠（及其后的空白），再接 `at` 且不是名字字符 */
const LOOSE_AT_START = /<[\s\p{Cf}]*(?:\/[\s\p{Cf}]*)?at(?![A-Za-z0-9_-])/iu;

const CANON_TAG_RE = /<at user_id="([^"<>]*)">([^<>]*)<\/at>/g;

const expectOnlyTrustedAtTags = (
  text: string,
  mentionIds: Set<string>,
  label: string,
): void => {
  for (const m of text.matchAll(CANON_TAG_RE)) {
    expect(
      TRUSTED_IDS.has(m[1]) && mentionIds.has(m[1]),
      `${label} 标签 id 不可信或不在 mentions：${m[1]}`,
    ).toBe(true);
  }
  // 占位符而不是空串：删掉规范标签会让两侧文字粘出测试自己造的假标签
  const rest = text.replace(CANON_TAG_RE, "\u0000");
  expect(rest, `${label} 残留疑似 at 标签`).not.toMatch(LOOSE_AT_START);
};

describe("G1-01 补充 · `<` 与 at 之间夹空白 / 零宽字符的变体也被拆掉", () => {
  const variants: Record<string, string> = {
    "`<` 后空格": `< at user_id="all">X</at>`,
    "`<` 后制表符": `<\tat user_id="all">X`,
    "`<` 后零宽字符": `<\u200bat user_id="all">X`,
    "闭标签 `</` 后空格": `<at user_id="ou_fake">a</ at>`,
    "`<` 后空格 + 斜杠": `< /at>`,
    "换行隔开": `<\nat user_id="all">`,
  };
  for (const [name, raw] of Object.entries(variants)) {
    it(name, () => {
      const r = parseGroupReply(raw, mk());
      expectOnlyTrustedAtTags(
        r.text,
        new Set(r.mentions.map((m) => m.openId)),
        name,
      );
    });
  }

  it("不误伤普通尖括号文字：比较式 / 泛型 / 以 at 开头的别的单词", () => {
    for (const raw of [
      "当 a < b 且 c > d 时",
      "返回 List<String> 与 Map<K, V>",
      "看下 <attr> 和 <atlas> 两个标签",
      "n < attempts 时重试",
    ]) {
      const r = parseGroupReply(raw, mk());
      expect(r.text, raw).toBe(raw);
    }
  });
});

describe("G1-01 补充 · 随机拼接（固定种子）：疑似 at 标签只能是规范的可信标签", () => {
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
    `< at user_id="all">`,
    `<\u200bat user_id="all">`,
    `</ at>`,
    `<\tat>`,
    `<at\u200buser_id="all">`,
    `&lt;at user_id="all"&gt;`,
    `at user_id="all">`,
    `/at>`,
    `李安`,
    `X`,
    `@李安`,
    `@张三`,
    `@宿主`,
    `@Bob`,
    `a@Bob.com`,
    `[[需属主确认：`,
    `]]`,
    `]`,
    `\n`,
    ` `,
    `NO_REPLY`,
    `**`,
    `<<at>`,
    `@<at user_id="all">`,
  ];

  it("2000 组 × 3 种提问人（含昵称夹标签片段的真人）", () => {
    const rand = rng(20261015);
    const requesters = [
      { openId: "ou_req", name: "提问人", isBot: false },
      { openId: "ou_req", name: `</at><at user_id="all">提问人`, isBot: false },
      { openId: "ou_req", name: "提问人", isBot: true },
    ];
    for (let n = 0; n < 2000; n++) {
      const len = 1 + Math.floor(rand() * 16);
      let raw = "";
      for (let k = 0; k < len; k++) raw += frags[Math.floor(rand() * frags.length)];
      for (const requester of requesters) {
        const r = parseGroupReply(raw, mk({ requester }));
        for (const m of r.mentions) {
          expect(TRUSTED_IDS.has(m.openId), `mentions 里出现不可信 id：${m.openId}`).toBe(true);
        }
        expectOnlyTrustedAtTags(
          r.text,
          new Set(r.mentions.map((m) => m.openId)),
          `#${n} ${JSON.stringify(raw)}`,
        );
      }
    }
  });
});
