/**
 * 飞书回复里的 Mermaid：把 ```mermaid 围栏渲染成图片（纯逻辑，不碰进程 / 文件 / 网络）。
 *
 * 为什么要：飞书卡片的 markdown 不会渲染 Mermaid，围栏会原样显示成一段代码；而 app 内聊天里同一段是图。
 * 做法与本地图片一致：流式期间原样（回改已推前缀会破坏打字机），finalize 前一次性把围栏换成图 + 保留源码，再全量 PUT。
 *
 * 分工：
 *  - 本文件：找围栏、过安全闸、逐块「渲染 → 上传」、拼回正文。渲染（主进程隐藏窗口）与上传（lark-cli）都由调用方注入；
 *  - 渲染通道见 lib/server/mermaid-render.ts，主进程侧见 electron-app/mermaid-render.mjs，渲染页见 app/mermaid-render。
 *
 * 保守原则（任何一步不行，这一块就**原样保留成代码块**，不影响其它块、更不影响整条回复的发送）：
 *  - 源码命中 `scanMermaidSource`（含 `<img>` / `url()` / http(s) 等「渲染即外发请求」的构造）→ 不渲染（与 app 内聊天同一道闸）；
 *  - 渲染 / 上传失败、超时、通道不可用 → 保留；
 *  - 一条回复最多渲染 {@link MAX_MERMAID_BLOCKS} 块，多的保留；相同源码只渲染一次；
 *  - 只认「已闭合」的围栏（finalize 时都闭合了；没闭合的多半是被截断的半截，渲染只会报语法错）。
 *
 * 不认的写法（保留成代码块，不报错）：嵌在引用 / 列表项里的围栏、缩进 ≥ 4 格的围栏（CommonMark 里那是缩进代码块）。
 * 被更外层围栏包住的 ```mermaid（例如用 ````markdown 展示「怎么写 mermaid」的示例）**不会**被渲染——那是在讲源码，不是在出图。
 */

import { scanMermaidSource } from "@/lib/mermaid-source-gate";

/** 一条回复最多渲染几块（每块一次渲染 + 一次上传；再多说明模型在刷屏，保留成代码即可） */
export const MAX_MERMAID_BLOCKS = 6;

export interface MermaidFence {
  /** 围栏起始（开栏行行首）在正文里的下标 */
  start: number;
  /** 围栏结束（闭栏行行尾、不含换行）的下标 */
  end: number;
  /** 围栏原文（含开闭栏行） */
  text: string;
  /** 围栏内的源码（已去掉开栏缩进，行尾 `\r` 已去掉；不含开闭栏行） */
  source: string;
}

interface OpenFence {
  char: "`" | "~";
  len: number;
  indent: number;
  isMermaid: boolean;
  start: number;
  contentLines: string[];
}

const OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * 找出正文里全部已闭合的 mermaid 围栏（按 CommonMark 的围栏规则逐行扫，最外层围栏优先）。
 * 开栏的信息串第一个词（大小写不敏感）是 `mermaid` 才算；反引号围栏的信息串里不能再出现反引号。
 */
export const findMermaidFences = (markdown: string): MermaidFence[] => {
  const out: MermaidFence[] = [];
  if (!markdown || !/mermaid/i.test(markdown)) return out;

  let open: OpenFence | null = null;
  let offset = 0;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const lineStart = offset;
    const lineEnd = offset + rawLine.length; // 不含 "\n"
    offset = lineEnd + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (!open) {
      const m = OPEN_RE.exec(line);
      if (!m) continue;
      const fence = m[2]!;
      const info = (m[3] ?? "").trim();
      const char = fence[0] as "`" | "~";
      if (char === "`" && info.includes("`")) continue; // 行内代码，不是围栏
      const lang = info.split(/\s+/, 1)[0] ?? "";
      open = {
        char,
        len: fence.length,
        indent: m[1]!.length,
        isMermaid: lang.toLowerCase() === "mermaid",
        start: lineStart,
        contentLines: [],
      };
      continue;
    }

    // 闭栏：同字符、至少同长度、前面最多 3 格缩进、后面只能是空白
    const trimmedStart = line.replace(/^ {0,3}/, "");
    const closeRe = open.char === "`" ? /^(`{3,})\s*$/ : /^(~{3,})\s*$/;
    const cm = closeRe.exec(trimmedStart);
    if (cm && cm[1]!.length >= open.len && line.length - trimmedStart.length <= 3) {
      if (open.isMermaid) {
        out.push({
          start: open.start,
          // 闭栏行行尾（不含换行；CRLF 的 \r 也不含，免得原文末尾带 \r 留在围栏文本里）
          end: lineStart + line.length,
          text: markdown.slice(open.start, lineStart + line.length),
          source: open.contentLines.join("\n"),
        });
      }
      open = null;
      continue;
    }
    // 围栏内容行：去掉至多 open.indent 格的前导空格
    let strip = 0;
    while (strip < open.indent && line[strip] === " ") strip++;
    open.contentLines.push(line.slice(strip));
  }
  return out;
};

export interface RenderMermaidDeps {
  /** 把一块源码渲染成 PNG；失败请抛错（该块保留成代码） */
  renderPng: (source: string) => Promise<Buffer>;
  /** 上传 PNG，返回飞书 image_key；失败请抛错（该块保留成代码） */
  uploadPng: (png: Buffer) => Promise<string>;
  /** 返回 true 就不再处理后面的块（总时间预算用尽）；缺省不限 */
  shouldStop?: () => boolean;
  /** 最多渲染几块（缺省 {@link MAX_MERMAID_BLOCKS}） */
  maxBlocks?: number;
}

export interface RenderMermaidResult {
  markdown: string;
  /** 换成图的块数 */
  rendered: number;
  /** 保留成代码的块数（被闸拦 / 超上限 / 失败 / 超时） */
  kept: number;
  /** 失败原因（只用于日志，不含源码） */
  failures: string[];
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 把正文里的 mermaid 围栏换成「图 + 原围栏」。
 * 图在上、源码在下（与 app 内「看图、可复制源码」一致；渲染失败的块完全不动）。
 * 永不抛：任何一块出错都只影响这一块。
 */
export const renderMermaidFencesInMarkdown = async (
  markdown: string,
  deps: RenderMermaidDeps,
): Promise<RenderMermaidResult> => {
  const fences = findMermaidFences(markdown);
  if (fences.length === 0) return { markdown, rendered: 0, kept: 0, failures: [] };

  const maxBlocks = deps.maxBlocks ?? MAX_MERMAID_BLOCKS;
  const failures: string[] = [];
  /** 相同源码只渲染 / 上传一次：key = 源码，value = image_key（失败也记，免得同一份坏源码重复试） */
  const cache = new Map<string, string | null>();
  const keys: Array<string | null> = [];
  let attempted = 0;

  for (const fence of fences) {
    const source = fence.source;
    if (!source.trim()) {
      keys.push(null);
      continue;
    }
    if (cache.has(source)) {
      keys.push(cache.get(source) ?? null);
      continue;
    }
    if (attempted >= maxBlocks) {
      failures.push("超过单条回复的渲染上限");
      keys.push(null);
      continue;
    }
    if (deps.shouldStop?.()) {
      failures.push("渲染总时间已用尽");
      keys.push(null);
      continue;
    }
    const verdict = scanMermaidSource(source);
    if (verdict.blocked) {
      // 与 app 内聊天同一道闸：含外部资源引用的源码不交给渲染（渲染即外发请求）
      failures.push(`安全预扫拦截（${verdict.reasons.join("/")}）`);
      cache.set(source, null);
      keys.push(null);
      continue;
    }
    attempted++;
    try {
      const png = await deps.renderPng(source);
      const key = await deps.uploadPng(png);
      cache.set(source, key);
      keys.push(key);
    } catch (err) {
      failures.push(errMsg(err).slice(0, 200));
      cache.set(source, null);
      keys.push(null);
    }
  }

  // 从后往前替换，避免下标漂移
  let out = markdown;
  let rendered = 0;
  for (let i = fences.length - 1; i >= 0; i--) {
    const key = keys[i];
    if (!key) continue;
    const fence = fences[i]!;
    const before = out.slice(0, fence.start);
    // 图是行内元素：紧跟在上一段文字后面会被并进同一段，所以保证它前面是空行（或正文开头）
    const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    out = `${before}${lead}![Mermaid 图](${key})\n\n${fence.text}${out.slice(fence.end)}`;
    rendered++;
  }
  return { markdown: out, rendered, kept: fences.length - rendered, failures };
};
