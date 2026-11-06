/**
 * 「服务端读文件 → 预览正文」端到端（SSR 级）：用真实文件跑 readLocalFileForPreview，把它的真实产出直接喂给 LocalFilePreviewBody。
 *
 * 为什么要有这一层：viewer 的单测用的是手写的假数据，而「假数据的约定」和「服务端真实产出」可能悄悄不一致
 * （例如 pptx 的 index 是 1 起，手写假数据按 0 起写，viewer 就显示成「第 2 页」，单测却全绿）。
 * 这里只信真实产出。
 *
 * 诚实声明：同 preview-viewers-ssr —— 没有 DOM / 布局，虚拟列表里的行、拖拽缩放、编辑光标都不在这里验证。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { LocalFilePreviewBody } from "@/components/ui/local-file-preview-body";
import { DialogProvider } from "@/hooks/use-dialog";
import { readLocalFileForPreview } from "@/lib/server/local-file-read";

import { buildPptx, buildZip } from "./helpers/zip-builder";

let TMP = "";
beforeAll(async () => {
  TMP = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flowship-read-to-viewer-")));
});
afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const put = async (name: string, data: string | Buffer): Promise<string> => {
  const p = path.join(TMP, name);
  await fs.writeFile(p, data);
  return p;
};

/** 读真实文件 → 渲染预览正文。editable 模拟 route 的补充字段（route 另有测试覆盖） */
const previewHtml = async (
  file: string,
  opts: { sheet?: number; editable?: boolean; line?: number } = {},
): Promise<string> => {
  const payload = await readLocalFileForPreview(file, { sheet: opts.sheet });
  const data = { ...payload, editable: opts.editable ?? false } as Parameters<typeof LocalFilePreviewBody>[0]["data"];
  // 给 Virtuoso 的 initialTopMostItemIndex（tail / line）一个 rAF，真实环境只在浏览器里挂载
  vi.stubGlobal("requestAnimationFrame", () => 0);
  try {
    return renderToStaticMarkup(
      createElement(DialogProvider, null, createElement(LocalFilePreviewBody, { data, loading: false, error: null, line: opts.line })),
    );
  } finally {
    vi.unstubAllGlobals();
  }
};

describe("真实文件 → 各 viewer", () => {
  it("pptx：页码按放映序号（1 起）显示，按 presentation.xml 顺序", async () => {
    const f = await put("deck.pptx", buildPptx([{ title: "文件1" }, { title: "文件2" }, { title: "文件3" }], [3, 1, 2]));
    const html = await previewHtml(f);
    expect(html).toContain("第 1 / 3 页");
    // 放映顺序第一页是文件3
    expect(html).toMatch(/<h2[^>]*>文件3<\/h2>/);
  });

  it("pptx：正文要点、备注、图片数都带出来", async () => {
    const f = await put("deck2.pptx", buildPptx([{ title: "复盘", body: ["增长 20%"], notes: "先讲结论", pictures: 3 }]));
    const html = await previewHtml(f);
    expect(html).toContain("增长 20%");
    expect(html).toContain("先讲结论");
    expect(html).toContain("3 个图片 / 图表");
  });

  it("旧版 .ppt：给具体原因，不白屏", async () => {
    const f = await put("old.ppt", Buffer.from("not a zip"));
    expect(await previewHtml(f)).toContain("旧版");
  });

  it("csv：表格视图 + 行列统计 + 分隔符", async () => {
    const f = await put("t.csv", "name,qty\napple,3\npear,12\n");
    const html = await previewHtml(f);
    expect(html).toMatch(/aria-selected="true"[^>]*>表格</);
    expect(html).toContain("2 行 × 2 列");
    expect(html).toContain("分隔符 ,");
  });

  it("tsv 的分隔符显示成 Tab", async () => {
    const f = await put("t.tsv", "a\tb\n1\t2\n");
    expect(await previewHtml(f)).toContain("分隔符 Tab");
  });

  it("xlsx：多 sheet 页签；&sheet=1 读到第二张", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "汇总");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"], ["y"], ["z"]]), "明细");
    const f = await put("book.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

    const first = await previewHtml(f);
    expect(first).toContain('aria-label="工作表"');
    expect(first).toMatch(/aria-selected="true"[^>]*>汇总</);
    expect(first).toContain("1 行 × 2 列");

    const second = await previewHtml(f, { sheet: 1 });
    expect(second).toMatch(/aria-selected="true"[^>]*>明细</);
    expect(second).toContain("2 行 × 1 列");
  });

  it("zip：压缩包目录汇总", async () => {
    const f = await put("a.zip", buildZip([
      { name: "src/", data: "" },
      { name: "src/a.ts", data: "export const a = 1;\n", deflate: true },
      { name: "README.md", data: "# hi" },
    ]));
    const html = await previewHtml(f);
    expect(html).toContain("2 个文件");
    expect(html).toContain("按路径过滤");
  });

  it("json：合法 → 树；非法 → 源码 + 原因", async () => {
    const ok = await put("ok.json", '{"a":{"b":[1,2,3]}}');
    expect(await previewHtml(ok)).toContain("个可见节点");
    const bad = await put("bad.json", '{"a":');
    expect(await previewHtml(bad)).toContain("无法解析为树");
  });

  it("markdown：预览页签 + front matter 属性卡", async () => {
    const f = await put("skill.md", "---\nname: demo\nowner: me\n---\n\n# 标题\n");
    const html = await previewHtml(f);
    expect(html).toMatch(/aria-selected="true"[^>]*>预览</);
    expect(html).toContain("属性（2）");
  });

  it("svg：渲染前先是占位；超大 / 空 svg 只给源码", async () => {
    const f = await put("a.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>");
    const html = await previewHtml(f);
    expect(html).not.toContain("LF · UTF-8"); // 首帧没有渲染源码工具栏
    const empty = await put("empty.svg", "");
    expect(await previewHtml(empty)).toContain("只提供源码视图");
  });

  it("日志：tail 模式的说明与行数；可编辑文本显示「编辑」，只读显示「只读」", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `2026-11-06 10:00:0${i} INFO line ${i}`).join("\n");
    const f = await put("app.log", lines);
    const editable = await previewHtml(f, { editable: true });
    expect(editable).toContain("5 行");
    expect(editable).toContain("编辑");
    const readonly = await previewHtml(f, { editable: false });
    expect(readonly).toContain("只读");
  });

  it("CRLF + BOM 的文本：工具栏标出，且文本里没有残留的 \\r 或 BOM", async () => {
    const f = await put("win.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n")]));
    const html = await previewHtml(f, { editable: true });
    expect(html).toContain("CRLF · UTF-8 BOM");
    expect(html).toContain("3 行");
  });
});
