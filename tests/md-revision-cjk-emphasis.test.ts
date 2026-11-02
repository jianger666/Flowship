/**
 * 任务 B：CJK 标点紧邻的强调 / 删除线（`**“重点”**内容`），哨兵插入后行内结构不能变。
 *
 * 机理：哨兵是私有区字符（U+E000–E003），既不是空白、也不是标点、也不是 CJK。
 * CommonMark + cjk-friendly 对强调边界的判定看「标记两侧字符的类别」：
 * `”**内容` 里闭合 `**` 右侧是 CJK 字符 → cjk-friendly 放宽、成强调；
 * 词级 diff 在 `**` 旁边插入哨兵（`”**\uE000新\uE001内容`）后右侧变成「其他字符」，不再放宽 →
 * 合并视图里新版本来正常的加粗变成字面 `**`（反过来也会：新版里字面的 `**` 被哨兵「救活」成强调）。
 *
 * 判据（md-revision.ts 的 mergeInlineableBlock）：渲染端看到的是 parse(合并串)，把其中被删除片段与哨兵归约掉后的
 * 节点类型序列，必须与 parse(新版块) 的节点类型序列一致；不一致 → 回退为整块 modified（出新版原文）。
 *
 * 全部走真实 remark 解析 + 真实 Streamdown SSR（与 tests/revision-render-chain.test.ts 同一套 harness 口径）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";

import { buildRevisionView, type RevisionView } from "../src/lib/md-revision";
import { createRevisionRemarkPlugins } from "../src/lib/revision-render-chain";
import {
  REVISION_REHYPE_PLUGINS,
  RevisionDel,
  RevisionIns,
} from "../src/lib/revision-rehype-plugins";
import { REVISION_SYNTAX_PLUGINS } from "../src/lib/revision-syntax-plugins";

const SENTINELS = /[\uE000-\uE004]/;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

const renderView = (view: RevisionView): string =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        plugins: REVISION_SYNTAX_PLUGINS,
        remarkPlugins: createRevisionRemarkPlugins(view.blockMarks, {
          sentinels: view.stats.leakFallback !== true,
        }),
        rehypePlugins: REVISION_REHYPE_PLUGINS,
        components: { ins: RevisionIns, del: RevisionDel },
      } as never,
      view.mergedMd,
    ),
  );

/** 修订渲染 + 「新版独立渲染」（同一条链路、无任何改动标记）做对照 */
const renderPair = (oldMd: string, newMd: string) => {
  const view = buildRevisionView(oldMd, newMd);
  const html = renderView(view);
  const ref = renderView(buildRevisionView(newMd, newMd));
  return { view, html, ref };
};

/**
 * 把修订渲染还原成「用户应当看到的新版」：删掉词级 del、拆掉词级 ins 的包装、剥掉块级标记属性。
 * 还原后必须与新版独立渲染逐字节相等——强调 / 删除线 / 链接 / 行内代码的结构有任何漂移（字面 `**`、多 / 少一个 <strong>）都会不等。
 */
const normalizeToNew = (html: string): string =>
  html
    .replace(/<del data-revision-hit="del"[^>]*>[\s\S]*?<\/del>/g, "")
    .replace(/<ins data-revision-hit="ins"[^>]*>([\s\S]*?)<\/ins>/g, "$1")
    .replace(/ data-block-index="[^"]*"/g, "")
    .replace(/ data-revision-status="[^"]*"/g, "")
    .replace(/ data-revision-hit="[^"]*"/g, "");

/** 失败样例：哨兵紧贴强调标记，会改变边界判定——必须回退为整块 */
const FALLBACK_CASES: Array<[string, string, string]> = [
  ["闭合 ** 右侧新增（引号 + CJK 紧邻）", "这是**“重点”**内容。", "这是**“重点”**新内容。"],
  ["闭合 ** 右侧新增更多字", "**“重点”**内容", "**“重点”**很多内容"],
  ["开 ** 左侧新增", "前面**“重点”**", "前面新增**“重点”**"],
  ["开 ** 左侧删除", "前面旧词**“重点”**", "前面**“重点”**"],
  ["斜体（单 *）", "这是*“重点”*内容", "这是*“重点”*新内容"],
  ["GFM 删除线 ~~", "这是~~“旧”~~内容", "这是~~“旧”~~新内容"],
  ["闭合标记右侧新增标点", "这是**“重点”**内容", "这是**“重点”**。内容"],
  [
    "反向：新版里字面的 **（ASCII 相邻不成强调）被哨兵「救活」成强调",
    "foo**好**bar",
    "foo**“好”**bar",
  ],
  ["引用块内", "> 这是**“重点”**内容。", "> 这是**“重点”**新内容。"],
  [
    "列表项内（其它项不变）",
    "- 这是**“重点”**内容。\n- 第二项文字保持不变",
    "- 这是**“重点”**新内容。\n- 第二项文字保持不变",
  ],
];

/** 对照样例：不能被误回退，仍须是词级 ins / del */
const KEEP_WORD_LEVEL_CASES: Array<[string, string, string]> = [
  ["普通加粗内部新增", "普通 **加粗** 文字", "普通 **加粗内容** 文字"],
  ["加粗内换词（无标点）", "这是**重点**内容", "这是**关键**内容"],
  ["加粗内换词（引号内改词，哨兵不贴 **）", "这是**“重点”**内容", "这是**“关键”**内容"],
  ["引号加粗之后追加（哨兵离 ** 远）", "说**“好”**吧", "说**“好”**吧啊"],
  ["引号加粗之前追加（哨兵离 ** 远）", "说**“好”**吧", "嗯说**“好”**吧"],
  ["CJK 加粗右侧新增（无标点，cjk 放宽与哨兵无关）", "这是**重点**内容。", "这是**重点**新内容。"],
  ["链接文字之后新增", "[文档](https://example.com/a) 很长的说明", "[文档](https://example.com/a) 很长的详细说明"],
  ["行内代码之后新增", "使用 `npm run build` 构建项目", "使用 `npm run build` 构建整个项目"],
  [
    "两个链接之间的纯删除（被删文本独占一个 text 节点：归约必须去掉它，否则多出一个 text 节点被误回退）",
    "参见[文档一](https://x.com/1)过时的说明[文档二](https://x.com/2)了解更多详情",
    "参见[文档一](https://x.com/1)[文档二](https://x.com/2)了解更多详情",
  ],
  ["列表某项改词", "- 第一项内容\n- 第二项内容", "- 第一项内容\n- 第二项改动内容"],
  ["引用改词", "> 引用的原文内容", "> 引用的新文内容"],
  ["普通中文段落", "今天天气很好。", "今天天气不错。"],
];

describe("任务 B：强调边界被哨兵改变 → 回退为整块 modified（真实 remark + Streamdown SSR）", () => {
  it.each(FALLBACK_CASES)("%s：合并视图还原后与新版独立渲染一致，且整块回退", (_name, oldMd, newMd) => {
    const { view, html, ref } = renderPair(oldMd, newMd);
    expect(view.stats.leakFallback, "不能被 guard 降级兜底遮蔽").toBeUndefined();
    // 核心不变量：用户看到的新版结构 = 新版独立渲染（修复前这里是字面 `**` / 少一个 <strong>）
    expect(normalizeToNew(html)).toBe(normalizeToNew(ref));
    // 回退口径：整块出新版原文、不带任何哨兵 / 词级标记
    expect(view.mergedMd).toBe(newMd);
    expect(view.mergedMd).not.toMatch(SENTINELS);
    // （只数带修订标记的：GFM `~~x~~` 在新版里本来就渲染成原生 <del>，那不是修订）
    expect(count(html, /data-revision-hit="(?:ins|del)"/g)).toBe(0);
    // 整块 modified：角标 / 旧文弹窗取的旧原文就是旧块源码
    expect(view.blockMarks).toEqual([
      expect.objectContaining({ index: 0, status: "modified", oldSource: oldMd }),
    ]);
    // 统计口径仍有改动（工具栏不是 +0 −0）
    expect(view.stats.ins + view.stats.del).toBeGreaterThan(0);
  });

  it("反向样例的字面量：新版是字面 `**`，回退后渲染里也是字面 `**`（不是被「救活」的加粗）", () => {
    const { html } = renderPair("foo**好**bar", "foo**“好”**bar");
    expect(html.replace(/<[^>]+>/g, "")).toContain("foo**“好”**bar");
    expect(html).not.toContain('data-streamdown="strong"');
  });

  it("正向样例的字面量：新版是加粗，回退后渲染里是 <strong>、没有字面 `**`", () => {
    const { html } = renderPair("这是**“重点”**内容。", "这是**“重点”**新内容。");
    expect(html).toContain('data-streamdown="strong"');
    expect(html.replace(/<[^>]+>/g, "")).not.toContain("**");
  });
});

describe("任务 B 对照：正常样例不被过度回退（仍是词级 ins / del，且结构不变量成立）", () => {
  it.each(KEEP_WORD_LEVEL_CASES)("%s", (_name, oldMd, newMd) => {
    const { view, html, ref } = renderPair(oldMd, newMd);
    expect(view.stats.leakFallback).toBeUndefined();
    // 仍然是词级：合并串里有哨兵、渲染里有真实的 ins / del
    expect(view.mergedMd).toMatch(SENTINELS);
    expect(view.mergedMd).not.toBe(newMd);
    expect(count(html, /<ins[\s>]/g) + count(html, /<del[\s>]/g)).toBeGreaterThan(0);
    // 词级的同时结构也与新版一致
    expect(normalizeToNew(html)).toBe(normalizeToNew(ref));
  });

  it("引号内换词：恰好 1 个 ins + 1 个 del，且仍在同一个 <strong> 里", () => {
    const { html } = renderPair("这是**“重点”**内容", "这是**“关键”**内容");
    expect(count(html, /<ins[\s>]/g)).toBe(1);
    expect(count(html, /<del[\s>]/g)).toBe(1);
    expect(count(html, /data-streamdown="strong"/g)).toBe(1);
  });
});

describe("任务 B：回退只限出问题的那一块，同一文档里别的块仍是词级", () => {
  it("三段文档：第 2 段（哨兵贴 **）整块回退，第 1 / 3 段仍词级，块下标与标记对齐", () => {
    const oldMd = "今天天气很好。\n\n这是**“重点”**内容。\n\n明天计划出门。";
    const newMd = "今天天气不错。\n\n这是**“重点”**新内容。\n\n明天计划出游。";
    const { view, html, ref } = renderPair(oldMd, newMd);
    expect(view.stats.leakFallback).toBeUndefined();
    expect(view.blockMarks.map((m) => [m.index, m.status])).toEqual([
      [0, "modified"],
      [1, "modified"],
      [2, "modified"],
    ]);
    // 第 2 段回退：出新版原文；第 1 / 3 段仍带哨兵
    const blocks = view.mergedMd.split("\n\n");
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe("这是**“重点”**新内容。");
    expect(blocks[0]).toMatch(SENTINELS);
    expect(blocks[2]).toMatch(SENTINELS);
    // 渲染：恰好 2 组词级（第 1、3 段各 1 ins + 1 del），第 2 段没有修订标记
    expect(count(html, /<ins[\s>]/g)).toBe(2);
    expect(count(html, /<del[\s>]/g)).toBe(2);
    expect(normalizeToNew(html)).toBe(normalizeToNew(ref));
  });

  it("较大文档（400 段、每 4 段改一处，其中一半是哨兵贴 ** 的样例）：不变量成立、没有降级", () => {
    const oldParts: string[] = [];
    const newParts: string[] = [];
    for (let i = 0; i < 400; i++) {
      const tail = `第${i}段的固定说明文字`;
      if (i % 4 === 0) {
        oldParts.push(`这是**“重点${i}”**内容。${tail}`);
        newParts.push(`这是**“重点${i}”**新内容。${tail}`);
      } else if (i % 4 === 2) {
        oldParts.push(`今天天气很好${i}。${tail}`);
        newParts.push(`今天天气不错${i}。${tail}`);
      } else {
        oldParts.push(`保持不变${i}。${tail}`);
        newParts.push(`保持不变${i}。${tail}`);
      }
    }
    const { view, html, ref } = renderPair(oldParts.join("\n\n"), newParts.join("\n\n"));
    expect(view.stats.leakFallback).toBeUndefined();
    expect(view.stats.degraded).toBeUndefined();
    expect(normalizeToNew(html)).toBe(normalizeToNew(ref));
    // 100 段是哨兵贴 ** 的 → 整块回退（无 ins/del）；另 100 段是普通改词 → 各 1 ins + 1 del
    expect(count(html, /<ins[\s>]/g)).toBe(100);
    expect(count(html, /<del[\s>]/g)).toBe(100);
    expect(view.blockMarks.filter((m) => m.status === "modified")).toHaveLength(200);
  });
});
