/**
 * 答题回执的人话层（第二轮 review V12-01）。
 *
 * ask_user_reply 的 text 是写给 agent 的协议文本（`[ASK_USER_REPLY]` 抬头 / 「稍后再补充」整段指令），
 * 事件流给人看的内容只能来自结构化的 meta.answers；text 本身不改（仍原样送 agent / 飞书桥）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ASK_REPLY_DEFERRED_DISPLAY,
  askReplyDisplayBlocks,
  askReplyDisplaySummary,
  askReplyDisplayText,
} from "@/lib/ask-reply-display";
import { markdownToMdast } from "@/lib/markdown-visible-search";
import type { AskUserQuestion } from "@/lib/types";

const questions: AskUserQuestion[] = [
  { id: "q1", question: "用哪个日期库？" },
  { id: "q2", question: "要不要兼容 IE？" },
];

const PROTOCOL_TEXT =
  "[ASK_USER_REPLY]\n\nQ1: 用哪个日期库？\n答：dayjs\n\nQ2: 要不要兼容 IE？\n答：不要";

const DEFERRED_TEXT = [
  "[ASK_USER_REPLY deferred]",
  "",
  "用户选择**稍后再补充**、未提供任何答案。",
  "**不要**再就这同一组问题重新调 ask_user——用户已明示稍后补、再问就是冒犯。",
].join("\n");

describe("askReplyDisplayText", () => {
  it("有结构化答案：按题目顺序展示，不含协议抬头", () => {
    const text = askReplyDisplayText(
      {
        text: PROTOCOL_TEXT,
        meta: {
          askId: "a1",
          answers: [
            { questionId: "q2", answer: "不要" },
            { questionId: "q1", answer: "dayjs" },
          ],
        },
      },
      questions,
    );
    expect(text).toBe(
      "Q1: 用哪个日期库？\n答：dayjs\n\nQ2: 要不要兼容 IE？\n答：不要",
    );
    expect(text).not.toContain("ASK_USER_REPLY");
  });

  it("稍后再补充：只说人话，不露出对 AI 的指令", () => {
    const text = askReplyDisplayText(
      { text: DEFERRED_TEXT, meta: { askId: "a1", deferred: true, answers: [] } },
      questions,
    );
    expect(text).toBe(ASK_REPLY_DEFERRED_DISPLAY);
    expect(text).not.toContain("冒犯");
  });

  it("meta 缺 deferred 标记但 text 是 deferred 抬头（老事件）：同样按「稍后再补充」", () => {
    expect(askReplyDisplayText({ text: DEFERRED_TEXT, meta: undefined })).toBe(
      ASK_REPLY_DEFERRED_DISPLAY,
    );
  });

  it("没传题目（找不到配对提问）：只列回答，不编问题", () => {
    const text = askReplyDisplayText({
      text: PROTOCOL_TEXT,
      meta: {
        answers: [
          { questionId: "q1", answer: "dayjs" },
          { questionId: "q2", answer: "不要" },
        ],
      },
    });
    expect(text).toBe("Q1\n答：dayjs\n\nQ2\n答：不要");
  });

  it("某题没答：写「（未回答）」；只贴图没填字：指向附图", () => {
    const noImage = askReplyDisplayText(
      { text: PROTOCOL_TEXT, meta: { answers: [{ questionId: "q1", answer: "dayjs" }] } },
      questions,
    );
    expect(noImage).toContain("Q2: 要不要兼容 IE？\n答：（未回答）");

    const withImage = askReplyDisplayText(
      {
        text: PROTOCOL_TEXT,
        meta: {
          answers: [
            { questionId: "q1", answer: "dayjs" },
            { questionId: "q2", answer: "   " },
          ],
          images: [{ absPath: "/tmp/a.png" }],
        },
      },
      questions,
    );
    expect(withImage).toContain("Q2: 要不要兼容 IE？\n答：（见附图）");
  });

  it("脏条目（缺 questionId / 非对象）被跳过，不崩", () => {
    const text = askReplyDisplayText(
      {
        text: PROTOCOL_TEXT,
        meta: {
          answers: [null, 3, { answer: "x" }, { questionId: "q1", answer: "dayjs" }],
        },
      },
      questions,
    );
    expect(text).toContain("答：dayjs");
  });

  it("完全没有结构化数据（老事件）：退回原文但去掉协议抬头", () => {
    const text = askReplyDisplayText({ text: PROTOCOL_TEXT, meta: undefined });
    expect(text.startsWith("Q1: ")).toBe(true);
    expect(text).not.toContain("[ASK_USER_REPLY]");
  });

  it("不改入参（text 仍是协议文本，给 agent / 飞书桥用）", () => {
    const ev = { text: PROTOCOL_TEXT, meta: { answers: [] as unknown[] } };
    askReplyDisplayText(ev, questions);
    expect(ev.text).toBe(PROTOCOL_TEXT);
  });
});

describe("askReplyDisplaySummary", () => {
  it("多题用「 · 」连，且不含协议词", () => {
    const s = askReplyDisplaySummary(
      {
        text: PROTOCOL_TEXT,
        meta: {
          answers: [
            { questionId: "q1", answer: "dayjs" },
            { questionId: "q2", answer: "不要" },
          ],
        },
      },
      questions,
    );
    expect(s).toBe("dayjs · 不要");
  });

  it("稍后再补充 → 人话", () => {
    expect(
      askReplyDisplaySummary({ text: DEFERRED_TEXT, meta: { deferred: true } }),
    ).toBe(ASK_REPLY_DEFERRED_DISPLAY);
  });
});

describe("事件流接线（源码契约）", () => {
  const rows = readFileSync(
    path.resolve(
      import.meta.dirname,
      "..",
      "src/components/tasks/event-stream/rows.tsx",
    ),
    "utf-8",
  );

  it("已答卡不再直接渲染 replyEvent.text；答案走纯文本容器、不再走 markdown（Q7b-03）", () => {
    expect(rows).not.toMatch(/text=\{replyEvent\.text\}/);
    expect(rows).toContain("askReplyDisplayBlocks(replyEvent");
    expect(rows).not.toContain("askReplyDisplayMarkdown");
    expect(rows).toMatch(/whitespace-pre-wrap break-words">\{b\.answer\}/);
  });

  it("过程行 / log 卡的摘要与正文也走人话层", () => {
    expect(rows).toContain("askReplyView?.summary ?? ev.text");
    expect(rows).toContain("bodyText={bodyText}");
    expect(rows).toMatch(/text=\{bodyText \?\? ev\.text\}/);
  });

  it("「稍后再补充」的卡头不说「已回答」", () => {
    expect(rows).toMatch(/replyEvent\?\.meta\?\.deferred === true/);
    expect(rows).toContain("个问题稍后再补充");
  });
});


describe("Q7b-03 / Q6-19：已答卡的答案不走 markdown，逐字展示（真实 mdast 管线对照）", () => {
  type N = { type: string; value?: string; url?: string; depth?: number; children?: N[] };
  const walk = (n: N, f: (x: N) => void): void => {
    f(n);
    n.children?.forEach((c) => walk(c, f));
  };
  const nodes = (md: string): N[] => {
    const out: N[] = [];
    walk(markdownToMdast(md) as N, (x) => out.push(x));
    return out;
  };
  const reply = (answers: Array<{ questionId: string; answer: string }>) => ({
    text: "[ASK_USER_REPLY]\n\n…",
    meta: { answers },
  });
  const answerOf = (raw: string): string => {
    const blocks = askReplyDisplayBlocks(reply([{ questionId: "q1", answer: raw }]), questions);
    const b = blocks[0];
    if (b?.kind !== "qa") throw new Error("应是 qa 块");
    return b.answer;
  };

  /** 旧实现（R9b-06）：反斜杠转义 + 硬换行，作对照——证明「转义后走 markdown」这条路本身就是坏的 */
  const oldEscape = (text: string): string =>
    text
      .split(/\r?\n/)
      .map((line) =>
        line.replace(/[\\`*_[\]<>#+\-!|~$&]/g, (c) => `\\${c}`).replace(/^(\s*\d+)([.)])/, "$1\\$2"),
      )
      .join("  \n");

  const URLS = [
    "https://github.com/foo-bar/baz_qux",
    "https://github.com/foo-bar/baz_qux?q=a&b=2#frag",
    "https://example.com/a_b/c-d!",
    "http://127.0.0.1:3000/a_b?x=1&y=2",
    "https://a-b.com/x_y?a=1&b=2",
  ];

  it("旧路径（对照）：URL 答案转义后进 markdown → 链接目标带反斜杠 / `%5C`（坏链接）", () => {
    const bad = URLS.filter((u) => {
      const links = nodes(`答：${oldEscape(u)}`).filter((n) => n.type === "link");
      return links.some((l) => (l.url ?? "").includes("\\"));
    });
    // 至少含 `-` / `_` 的几条会坏
    expect(bad.length).toBeGreaterThanOrEqual(3);
  });

  it("旧路径（对照）：`=` 没转义，单独一行 `====` 会把上一行变 heading", () => {
    expect(nodes(oldEscape("标题\n====")).map((n) => n.type)).toContain("heading");
  });

  it("新路径：URL / `?&#!` / `-` `_` 答案逐字返回，且展示块里没有任何 markdown 参与", () => {
    for (const u of URLS) {
      expect(answerOf(u), u).toBe(`答：${u}`);
    }
  });

  it("新路径：`====` / `---` / 行首列表符 / 多行答案逐字返回（换行靠 pre-wrap，不靠 markdown 硬换行）", () => {
    for (const raw of ["标题\n====", "a\n=", "a\n   ===  ", "x\n---\ny", "- x\n- y", "1. 一\n2. 二", "*强调* [链接](x) `代码`", "<b>x</b> &amp; \\ ~~s~~ | t |"]) {
      expect(answerOf(raw), JSON.stringify(raw)).toBe(`答：${raw.trim()}`);
    }
  });

  it("性质：含 URL 片段 / `=` / `?&#!` 字母表的随机答案，展示函数逐字返回原文（共 3000 个）", () => {
    const alphabet = [
      "a", "b", "中", " ", "-", "*", "_", "#", ">", "[", "]", "(", ")", "`", "1", ".", "+", "!", "|", "~", "$", "&", "<", "\\", "\n",
      "=", "====", "---", "?", "?q=a&b=2", "#frag", "https://", "http://", "www.", "a-b.com", "/x_y", "foo@bar.com", ":",
    ];
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 0x100000000;
    };
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const len = 1 + Math.floor(rnd() * 12);
      let raw = "";
      for (let k = 0; k < len; k++) raw += alphabet[Math.floor(rnd() * alphabet.length)];
      const trimmed = raw.trim();
      if (!trimmed) continue;
      expect(answerOf(raw), JSON.stringify(raw)).toBe(`答：${trimmed}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(2500);
  });

  it("题目仍是 markdown 源文本（交给 MarkdownText），答案不混进题目", () => {
    const blocks = askReplyDisplayBlocks(
      reply([
        { questionId: "q1", answer: "https://a-b.com/x_y" },
        { questionId: "q2", answer: "" },
      ]),
      [
        { id: "q1", question: "用 **哪个** 仓库？" },
        { id: "q2", question: "要不要兼容 IE？" },
      ],
    );
    expect(blocks).toEqual([
      { kind: "qa", label: "Q1", question: "用 **哪个** 仓库？", answer: "答：https://a-b.com/x_y" },
      { kind: "qa", label: "Q2", question: "要不要兼容 IE？", answer: "答：（未回答）" },
    ]);
  });

  it("没传题目：只给序号标签（question 为 null），答案仍逐字；只贴图写「（见附图）」", () => {
    expect(
      askReplyDisplayBlocks(reply([{ questionId: "z", answer: " https://x.io/a_b " }])),
    ).toEqual([{ kind: "qa", label: "Q1", question: null, answer: "答：https://x.io/a_b" }]);
    expect(
      askReplyDisplayBlocks({ text: "x", meta: { answers: [{ questionId: "q1", answer: "" }], images: ["a.png"] } }, questions)[0],
    ).toMatchObject({ answer: "答：（见附图）" });
  });

  it("稍后再补充 / 兜底 / 空答案：与纯文本版一致（都是 plain / 占位）", () => {
    expect(askReplyDisplayBlocks({ text: "x", meta: { deferred: true } })).toEqual([
      { kind: "plain", text: ASK_REPLY_DEFERRED_DISPLAY },
    ]);
    expect(askReplyDisplayBlocks({ text: "[ASK_USER_REPLY]\n\n旧事件原文" })).toEqual([
      { kind: "plain", text: "旧事件原文" },
    ]);
    expect(askReplyDisplayBlocks(reply([{ questionId: "q1", answer: "" }]), questions)[0]).toMatchObject({
      answer: "答：（未回答）",
    });
  });
});
