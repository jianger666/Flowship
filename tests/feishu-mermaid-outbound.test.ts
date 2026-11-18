/**
 * 飞书出站 Mermaid 出图胶水（src/lib/server/feishu-bridge/mermaid-outbound.ts）：
 * 快路径 / 不可用 / 预算 / 临时文件清理 / 永不抛。纯围栏逻辑见 tests/feishu-mermaid-blocks.test.ts。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MERMAID_FINALIZE_RESERVE_MS,
  MERMAID_PHASE_MAX_MS,
  __setMermaidRendererForTest,
  renderMermaidForFeishu,
} from "@/lib/server/feishu-bridge/mermaid-outbound";
import { MermaidRenderError } from "@/lib/server/mermaid-render";

const FENCE = "```mermaid\ngraph TD\n  A-->B\n```";
const MD = `说明\n\n${FENCE}\n\n结束`;
const BIG_BUDGET = 60_000;

const makeRenderer = (over: Partial<{ available: boolean }> = {}) => {
  const state = { available: over.available ?? true };
  const renderPng = vi.fn<(source: string, opts: { timeoutMs?: number }) => Promise<{ png: Buffer }>>(async () => ({
    png: Buffer.from("PNGDATA"),
  }));
  return {
    state,
    renderPng,
    impl: { isAvailable: () => state.available, renderPng },
  };
};

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  __setMermaidRendererForTest(null);
  infoSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("renderMermaidForFeishu", () => {
  it("没有 mermaid 字样：原样返回，连「是否可用」都不查", async () => {
    const r = makeRenderer();
    const isAvailable = vi.spyOn(r.impl, "isAvailable");
    __setMermaidRendererForTest(r.impl);
    const upload = vi.fn();
    const md = "普通回复\n\n```js\nconst a = 1\n```";
    expect(await renderMermaidForFeishu(md, { taskId: "t1", upload, remainingBudgetMs: BIG_BUDGET })).toBe(md);
    expect(isAvailable).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("渲染能力不可用（web 模式 / 旧壳）：原样返回（= 改动前的行为，代码块照旧）", async () => {
    const r = makeRenderer({ available: false });
    __setMermaidRendererForTest(r.impl);
    const upload = vi.fn();
    expect(await renderMermaidForFeishu(MD, { taskId: "t1", upload, remainingBudgetMs: BIG_BUDGET })).toBe(MD);
    expect(r.renderPng).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("成功：渲染 → 写临时 PNG → 上传 → 换成「图 + 原围栏」；上传的是本地绝对路径，上传后临时文件被删", async () => {
    const r = makeRenderer();
    __setMermaidRendererForTest(r.impl);
    let uploadedPath = "";
    let content = "";
    const upload = vi.fn(async (p: string) => {
      uploadedPath = p;
      content = await fs.readFile(p, "utf8");
      return "img_v3_abc";
    });
    const out = await renderMermaidForFeishu(MD, { taskId: "t_abc/../x", upload, remainingBudgetMs: BIG_BUDGET });
    expect(out).toBe(`说明\n\n![Mermaid 图](img_v3_abc)\n\n${FENCE}\n\n结束`);
    expect(content).toBe("PNGDATA");
    expect(path.isAbsolute(uploadedPath)).toBe(true);
    expect(uploadedPath.startsWith(path.join(os.tmpdir(), "flowship-mermaid"))).toBe(true);
    // 任务 id 里的路径分隔符不能进文件名
    expect(path.basename(uploadedPath)).toMatch(/^t_abc____x-[0-9a-f-]{36}\.png$/);
    await expect(fs.access(uploadedPath)).rejects.toThrow();
    expect(infoSpy).toHaveBeenCalled();
    // 日志只含计数 / 原因，不含源码
    expect(infoSpy.mock.calls.flat().join(" ")).not.toContain("graph TD");
  });

  it("上传失败：临时文件也要删；该块保留成代码、整体不抛", async () => {
    const r = makeRenderer();
    __setMermaidRendererForTest(r.impl);
    let uploadedPath = "";
    const upload = vi.fn(async (p: string) => {
      uploadedPath = p;
      throw new Error("upload fail");
    });
    const out = await renderMermaidForFeishu(MD, { taskId: "t1", upload, remainingBudgetMs: BIG_BUDGET });
    expect(out).toBe(MD);
    await expect(fs.access(uploadedPath)).rejects.toThrow();
  });

  it("渲染失败（语法错 / 超时 / 太大）：该块保留成代码、整体不抛", async () => {
    const r = makeRenderer();
    __setMermaidRendererForTest(r.impl);
    for (const code of ["RENDER_FAILED", "TIMEOUT", "TOO_LARGE", "UNSUPPORTED"] as const) {
      r.renderPng.mockRejectedValueOnce(new MermaidRenderError(code, `err ${code}`));
      const upload = vi.fn();
      const out = await renderMermaidForFeishu(MD, { taskId: "t1", upload, remainingBudgetMs: BIG_BUDGET });
      expect(out, code).toBe(MD);
      expect(upload).not.toHaveBeenCalled();
    }
  });

  it("安全预扫命中的源码：不交给渲染器", async () => {
    const r = makeRenderer();
    __setMermaidRendererForTest(r.impl);
    const evil = "```mermaid\ngraph TD\n  A[\"<img src='https://evil.example/p.png'>\"] --> B\n```";
    const out = await renderMermaidForFeishu(evil, { taskId: "t1", upload: vi.fn(), remainingBudgetMs: BIG_BUDGET });
    expect(out).toBe(evil);
    expect(r.renderPng).not.toHaveBeenCalled();
  });

  it("预算：finalize 总预算里要给卡片终稿留 reserve；剩余不够就整个跳过（不渲染）", async () => {
    const r = makeRenderer();
    __setMermaidRendererForTest(r.impl);
    // 剩余预算 ≤ reserve + 最小块预算 → 跳过
    const out = await renderMermaidForFeishu(MD, {
      taskId: "t1",
      upload: vi.fn(),
      remainingBudgetMs: MERMAID_FINALIZE_RESERVE_MS + 1000,
    });
    expect(out).toBe(MD);
    expect(r.renderPng).not.toHaveBeenCalled();
    expect(await renderMermaidForFeishu(MD, { taskId: "t1", upload: vi.fn(), remainingBudgetMs: 0 })).toBe(MD);
    expect(await renderMermaidForFeishu(MD, { taskId: "t1", upload: vi.fn(), remainingBudgetMs: -5000 })).toBe(MD);
  });

  it("单块渲染的超时 = 本步骤剩余时间（不超过阶段上限，也不超过 finalize 预算扣掉 reserve）", async () => {
    const r = makeRenderer();
    __setMermaidRendererForTest(r.impl);
    const upload = vi.fn(async () => "img_1");
    // 预算充足：阶段上限封顶
    await renderMermaidForFeishu(MD, { taskId: "t1", upload, remainingBudgetMs: BIG_BUDGET * 10, now: () => 0 });
    expect(r.renderPng.mock.calls[0]![1].timeoutMs).toBe(MERMAID_PHASE_MAX_MS);
    // 预算紧张：只给扣掉 reserve 后剩下的
    r.renderPng.mockClear();
    await renderMermaidForFeishu(MD, { taskId: "t1", upload, remainingBudgetMs: MERMAID_FINALIZE_RESERVE_MS + 8000, now: () => 0 });
    expect(r.renderPng.mock.calls[0]![1].timeoutMs).toBe(8000);
  });

  it("总时间用尽：后面的块不再开始（保留成代码）", async () => {
    const r = makeRenderer();
    __setMermaidRendererForTest(r.impl);
    let t = 0;
    r.renderPng.mockImplementation(async () => {
      t += MERMAID_PHASE_MAX_MS; // 第一块「用掉」整个阶段预算
      return { png: Buffer.from("x") };
    });
    const md = `${FENCE}\n\n中间\n\n\`\`\`mermaid\ngraph TD\n  C-->D\n\`\`\``;
    const out = await renderMermaidForFeishu(md, {
      taskId: "t1",
      upload: vi.fn(async () => "img_1"),
      remainingBudgetMs: BIG_BUDGET * 10,
      now: () => t,
    });
    expect(r.renderPng).toHaveBeenCalledTimes(1);
    expect(out.match(/!\[Mermaid 图\]/g)).toHaveLength(1);
    expect(out).toContain("graph TD\n  C-->D"); // 第二块仍是代码
  });

  it("渲染器自己抛同步异常 / isAvailable 抛错：兜底返回原文，不抛", async () => {
    __setMermaidRendererForTest({
      isAvailable: () => {
        throw new Error("boom");
      },
      renderPng: async () => ({ png: Buffer.from("x") }),
    });
    expect(await renderMermaidForFeishu(MD, { taskId: "t1", upload: vi.fn(), remainingBudgetMs: BIG_BUDGET })).toBe(MD);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("多块 + 相同源码：只渲染一次、临时文件都清理干净", async () => {
    const r = makeRenderer();
    __setMermaidRendererForTest(r.impl);
    const paths: string[] = [];
    const upload = vi.fn(async (p: string) => {
      paths.push(p);
      return `img_${paths.length}`;
    });
    const md = `${FENCE}\n\n中间\n\n${FENCE}`;
    const out = await renderMermaidForFeishu(md, { taskId: "t1", upload, remainingBudgetMs: BIG_BUDGET });
    expect(r.renderPng).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(out.match(/!\[Mermaid 图\]\(img_1\)/g)).toHaveLength(2);
    for (const p of paths) await expect(fs.access(p)).rejects.toThrow();
  });
});
