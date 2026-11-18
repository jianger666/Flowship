/**
 * 飞书出站 finalize 里的 Mermaid 出图步骤（胶水层）：把 mermaid-blocks.ts 的纯逻辑接上
 * 「主进程隐藏窗口渲染」（lib/server/mermaid-render.ts）与「lark-cli 上传」。
 *
 * 位置：outbound.ts 的 finalize 里、本地图片换 image_key 之前。流式期间不动（回改已推前缀会破坏打字机）。
 *
 * 失败不影响发送：没有渲染能力（web 模式 / 旧壳）、超时、语法错、上传失败……任何情况都退回「原样的 mermaid 代码块」，
 * 也就是改动前的行为；本函数永不抛。
 *
 * 时间：渲染挂在 finalize 的关键路径上（卡片终稿要等它），所以有两道上限——
 *  - 本步骤总共最多 {@link MERMAID_PHASE_MAX_MS}；
 *  - 同时给卡片终稿 / 后续补发留出 {@link MERMAID_FINALIZE_RESERVE_MS}（从 finalize 总预算里扣）。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MermaidRenderError,
  isMermaidRenderAvailable,
  renderMermaidPng,
  type MermaidRenderOptions,
} from "@/lib/server/mermaid-render";

import { renderMermaidFencesInMarkdown } from "./mermaid-blocks";

/** 本步骤总时间上限 */
export const MERMAID_PHASE_MAX_MS = 30_000;
/** 从 finalize 总预算里留给「卡片终稿 + 补发」的时间 */
export const MERMAID_FINALIZE_RESERVE_MS = 20_000;
/** 剩余时间低于这个值就不再开始新的一块（渲一块至少要这么久） */
const MIN_BLOCK_BUDGET_MS = 1500;

export interface MermaidRendererLike {
  isAvailable: () => boolean;
  renderPng: (source: string, opts: MermaidRenderOptions) => Promise<{ png: Buffer }>;
}

const defaultRenderer: MermaidRendererLike = {
  isAvailable: isMermaidRenderAvailable,
  renderPng: (source, opts) => renderMermaidPng(source, opts),
};

let rendererImpl: MermaidRendererLike = defaultRenderer;

/** 单测替换渲染器 */
export const __setMermaidRendererForTest = (r: MermaidRendererLike | null): void => {
  rendererImpl = r ?? defaultRenderer;
};

const safeFilePart = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "task";

export interface RenderMermaidForFeishuOptions {
  taskId: string;
  /** 上传本地图片文件，返回 image_key（outbound 注入的 uploadImageImpl） */
  upload: (filePath: string) => Promise<string>;
  /** finalize 总预算里此刻还剩多少毫秒（outbound 算好传进来） */
  remainingBudgetMs: number;
  /** 单测注入时钟 */
  now?: () => number;
}

/**
 * 把 markdown 里的 ```mermaid 围栏换成「图 + 原围栏」。没有 mermaid 围栏 / 没有渲染能力 / 时间不够时原样返回。
 */
export const renderMermaidForFeishu = async (
  markdown: string,
  opts: RenderMermaidForFeishuOptions,
): Promise<string> => {
  try {
    // 快路径：绝大多数回复没有 mermaid，不做任何额外工作
    if (!markdown || !/mermaid/i.test(markdown)) return markdown;
    const now = opts.now ?? (() => performance.now());
    const phaseMs = Math.min(MERMAID_PHASE_MAX_MS, opts.remainingBudgetMs - MERMAID_FINALIZE_RESERVE_MS);
    if (phaseMs < MIN_BLOCK_BUDGET_MS) return markdown;
    if (!rendererImpl.isAvailable()) return markdown;
    const deadline = now() + phaseMs;
    const remaining = (): number => deadline - now();

    const result = await renderMermaidFencesInMarkdown(markdown, {
      shouldStop: () => remaining() < MIN_BLOCK_BUDGET_MS,
      renderPng: async (source) => {
        const out = await rendererImpl.renderPng(source, { timeoutMs: Math.max(MIN_BLOCK_BUDGET_MS, Math.floor(remaining())) });
        return out.png;
      },
      uploadPng: async (png) => {
        const dir = path.join(os.tmpdir(), "flowship-mermaid");
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${safeFilePart(opts.taskId)}-${randomUUID()}.png`);
        await fs.writeFile(file, png);
        try {
          return await opts.upload(file);
        } finally {
          await fs.rm(file, { force: true }).catch(() => {});
        }
      },
    });

    if (result.rendered > 0 || result.failures.length > 0) {
      // 日志只记计数与失败原因，不记源码
      const codes = result.failures.length ? `；未出图原因：${[...new Set(result.failures)].join(" | ")}` : "";
      console.info(`[feishu-bridge/mermaid] task=${opts.taskId} 出图 ${result.rendered} 块、保留代码 ${result.kept} 块${codes}`);
    }
    return result.markdown;
  } catch (err) {
    // 理论上不会走到这里（内部逐块 try/catch）；兜底保证 finalize 不被它拖垮
    console.warn(
      `[feishu-bridge/mermaid] task=${opts.taskId} 出图步骤异常，保持原样：`,
      err instanceof MermaidRenderError ? `${err.code} ${err.message}` : err instanceof Error ? err.message : err,
    );
    return markdown;
  }
};
