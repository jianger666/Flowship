/**
 * 对话正文 15px / 代码块 14px 的 className 契约（2026-10-12）
 *
 * ⚠ 这是**弱保护**：vitest 没有布局引擎，这里只能断言「关键类名 / 规则还在」。
 * 真实验证是 2026-10-12 在 Chrome（headless、隔离数据目录、浅 / 深两套主题）里量 computed style：
 *   AI 正文 15px / 28px；行内 code 12px；路径 code 12px；代码块文字 14px / 21px（修前是 10.29px）；
 *   文件预览弹窗（文档面）正文仍是 14px / 24px、代码块同样从 10.29px 变 14px。
 * 它的价值是：有人顺手「清理」掉这些看似多余的类时拦一下，并把原因写在报错旁边。
 *
 * 为什么需要它：2026-07-21 立「对话正文 15px」后，外层 wrapper 写了 `text-[15px] leading-7`，
 * 但 typography 的 `.prose-sm` 在 prose 元素**自己**身上设了 14px / 1.714，把外层盖掉——
 * 规范写 15px、实际一直 14px，三个月没人发现。字号要落在 prose 元素上（`size="reply"`）。
 * 同类坑：`.prose-sm` 对 `pre`、`code` 各乘一次 .857em，代码块文字实际是 14 → 12 → 10.29px，
 * `code-block-body` 上写的 0.875rem 只管到容器。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO, rel), "utf-8");

const md = read("src/components/markdown-text.tsx");
const rows = read("src/components/tasks/event-stream/rows.tsx");
const css = read("src/app/globals.css");
const rule = read(".cursor/rules/ui-conventions.mdc");

/** 源码里所有 `<MarkdownText ... />` 自闭合标签（属性里没有 "/>"，足够用） */
const markdownTags = (src: string): string[] =>
  src.match(/<MarkdownText\b[\s\S]*?\/>/g) ?? [];

describe("对话正文 15px：字号落在 prose 元素上", () => {
  it("MARKDOWN_REPLY_TEXT 就是规范里写的那一串", () => {
    const value = /export const MARKDOWN_REPLY_TEXT = "([^"]+)";/.exec(md)?.[1];
    expect(value).toBe("text-[15px] leading-7");
    // 规范文件字号阶梯表里 15px 那一行写的也是这一串——两边对不上 = 规则漂移
    expect(rule).toMatch(/\| 15px \| `text-\[15px\] leading-7` \|/);
  });

  it("reply 档：prose 容器带 REPLY_PROSE_CLASS（正文档 + 行内 code 钉 text-xs）", () => {
    expect(md).toContain('size === "reply" && REPLY_PROSE_CLASS');
    expect(
      md,
      "prose-sm 的行内 code 是 .857em，基准抬到 15px 会变 12.86px（阶梯外），必须钉回 text-xs；" +
        "选择器用 :not(pre)>code，别误伤代码块里的 pre > code",
    ).toContain(
      'const REPLY_PROSE_CLASS = cn(MARKDOWN_REPLY_TEXT, "[&_:not(pre)>code]:text-xs");',
    );
  });

  it("默认档不带 15px：size 缺省 = default（问答卡 / 工具产出等次要面保持 14px / 12px）", () => {
    expect(md).toContain('size = "default",');
  });

  it("路径 code：default 档 0.85em、reply 档 text-xs；三处渲染都走 PATH_CODE_SIZE", () => {
    expect(md).toMatch(/default: "text-\[0\.85em\]",\s*reply: "text-xs",/);
    expect(md.match(/PATH_CODE_SIZE\[size\]/g) ?? []).toHaveLength(3);
    // 0.85em 字面量只该剩映射表里这一处：reply 档（15px 基准）下它会变 12.75px，落到阶梯之外
    expect(md.match(/text-\[0\.85em\]/g) ?? []).toHaveLength(1);
  });
});

describe("AI 回复三处都用 reply 档，次要面不放大", () => {
  it("rows.tsx：流式占位（chat / log）+ 定稿气泡 = 3 处 size=reply，答题回执保持默认档", () => {
    const tags = markdownTags(rows);
    expect(tags, "rows.tsx 里的 MarkdownText 调用数变了——新增的要想清楚属于哪一档").toHaveLength(4);

    const reply = tags.filter((t) => /\bsize="reply"/.test(t));
    expect(reply).toHaveLength(3);

    // 流式的两处必须都是 reply：不一致的话流式结束换成正式行时整段文字会跳一下
    const streaming = tags.filter((t) => /\bstreaming\b/.test(t));
    expect(streaming).toHaveLength(2);
    for (const t of streaming) expect(t).toMatch(/\bsize="reply"/);

    // 定稿气泡（text={ev.text}）= reply；答题回执（text={replyEvent.text}）是用户答的话、保持默认档
    const finalBody = tags.filter((t) => t.includes("text={ev.text}"));
    expect(finalBody).toHaveLength(1);
    expect(finalBody[0]).toMatch(/\bsize="reply"/);
    const askReply = tags.filter((t) => t.includes("text={replyEvent.text}"));
    expect(askReply).toHaveLength(1);
    expect(askReply[0]).not.toMatch(/\bsize="reply"/);
  });

  it("外层 wrapper 走 MARKDOWN_REPLY_TEXT 常量，不再手写 15px 字面量", () => {
    expect(rows).not.toContain('"text-[15px] leading-7"');
    expect(rows).toContain("className={MARKDOWN_REPLY_TEXT}");
    expect(rows).toContain("cn(MESSAGE_ACTION_HOST, MARKDOWN_REPLY_TEXT)");
  });

  it("其它 MarkdownText 调用方（问答卡 / 群问答 / 工具产出）不传 reply：它们是次要面、保持 14px / 12px", () => {
    for (const rel of [
      "src/components/tasks/ask-user-inline.tsx",
      // 群问答的 MarkdownText 在拆出来的单轮卡片里（面板本身不再直接渲染 markdown）
      "src/components/tasks/group-qa-round-card.tsx",
      "src/components/tasks/event-stream/tool-block.tsx",
    ]) {
      const tags = markdownTags(read(rel));
      expect(tags.length, `${rel} 应该有 MarkdownText 调用`).toBeGreaterThan(0);
      for (const t of tags) expect(t, rel).not.toMatch(/size="reply"/);
    }
  });
});

describe("代码块文字 14px：pre / code 继承容器字号", () => {
  it("globals.css：code-block-body 字号走 --prose-code-size（默认 0.875rem）", () => {
    expect(css).toMatch(
      /\.prose \[data-streamdown="code-block-body"\] \{[^}]*font-size: var\(--prose-code-size, 0\.875rem\);/,
    );
  });

  it("globals.css：body 里的 pre / code 显式继承字号（否则 prose-sm 的 .857em 会叠两次 → 10.29px）", () => {
    expect(css).toMatch(
      /\.prose \[data-streamdown="code-block-body"\] pre,\s*\.prose \[data-streamdown="code-block-body"\] code \{[^}]*font-size: inherit;[^}]*line-height: inherit;/,
    );
  });

  it("12px 档容器（工具块产出）把 --prose-code-size 降到 0.75rem，代码块不比周围正文还大", () => {
    const tool = read("src/components/tasks/event-stream/tool-block.tsx");
    expect(tool).toContain("[--prose-code-size:0.75rem]");
  });
});
