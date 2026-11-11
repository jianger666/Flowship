/**
 * remark 插件：内容恰好是一个 http(s) 网址的「围栏代码块 / 行内代码」→ 渲染成可点链接（R11-01）
 *
 * 背景（用户实测）：AI 把很长的支付链接放进围栏代码块（带复制按钮、底部横向滚动条），用户还得自己复制粘贴。
 * 根因不是渲染缺陷——`MarkdownLink` 早已把 http(s) 链接渲染成可点；是模型习惯把长链接放进代码块图好复制，
 * 而代码块里的网址不会被 GFM autolink 识别。这里做渲染兜底：确定性生效，不靠模型自觉，历史消息重新渲染即生效。
 *
 * 行为（缺一不换，宁可不换也不误换）：
 * - `code`（围栏块）：语言为空 / text / txt / plain / plaintext / url，无 meta，内容去首尾空白后**整个就是一个网址**
 *   （无任何空白 ⇒ 必然只有一行）。**围栏必须在源码里真的闭合**（见下「流式」）；缩进式代码块不动。
 * - `inlineCode`：内容同样整个就是一个网址，源码是单反引号包的，且不在 `link` 里面。
 * - 换成 `link`（链接文字 = 网址本身，不会伪装成别的文字）；围栏块换成只含这个链接的段落。链接仍交给现有的
 *   `MarkdownLink`（只认 http(s)、内置浏览器打开、右键复制）；`harden` / `sanitize` 不动、不放宽。
 *
 * 网址判定 {@link URL_ONLY_RE}：http(s) 开头，之后是非空白、非 `<>{}`、非引号 / 反引号、非私有区字符的一串。
 * 带 `{id}` 之类占位符的不换（不是真网址）；`curl https://…` 夹带别的字不换；`file://` / `javascript:` / `ftp://` 不换。
 * 私有区字符排除：修订视图用私有区字符当 ins/del 哨兵（md-revision），混进网址的块不是「干净的网址」。
 *
 * 流式（Q7b-01 同类问题）：网址是逐字到达的，任何一帧都不能出现「href 是最终网址的真前缀」的链接。
 * - 围栏：remark 把未闭合的围栏也当代码块（内容 = 目前写到的半截网址）。**所以只换「源码里真有闭合围栏行」的**——
 *   `file.value` 是传给解析器的原文（react-markdown 里 = remend 补全后的文本，而 remend 不会替围栏补闭合）。
 * - 行内代码：remend 会把 `` `https://exa `` 补成 `` `https://exa` ``，补全后与「真写完」在文本上无法区分。
 *   这一段交给 `stripTrailingUnclosedUrlCode`（streamdown-options 里挂成 remend 的前置 handler）：补全之前先把
 *   尾部「写到一半的 `https://…」藏起来，写完那一帧再出现。
 * 没有 `file.value`（调用方没传原文）时一律不换（fail closed）。
 */

// 不引 mdast 类型包（传递依赖、pnpm isolated 下不可直接 import）、自描述最小类型
interface MdNode {
  type: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/** 整串就是一个 http(s) 网址：不含空白 / `<>{}` / 引号 / 反引号 / 私有区字符（修订哨兵） */
export const URL_ONLY_RE = /^https?:\/\/[^\s<>{}"'`\uE000-\uF8FF]+$/;

/** 当「纯文本」围栏看待的语言标记（其它语言——bash / js / json 等——里的网址是代码的一部分，不动） */
const PLAIN_FENCE_LANGS: ReadonlySet<string> = new Set(["", "text", "txt", "plain", "plaintext", "url"]);

const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// 闭合围栏所在行：允许 blockquote 的 `>` 前缀 / 列表缩进（容器内的围栏，后续行带前缀）
const CLOSE_FENCE_LINE_RE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/** 围栏块在源码里是否真的有闭合围栏行（开头围栏符与结尾同种、不短于它） */
const isFenceClosedInSource = (slice: string): boolean => {
  const lines = slice.replace(/\s+$/, "").split("\n");
  if (lines.length < 3) return false; // 至少 开 / 内容 / 闭 三行
  const open = OPEN_FENCE_RE.exec(lines[0]!);
  if (!open) return false; // 缩进式代码块（没有围栏）：不换
  const close = CLOSE_FENCE_LINE_RE.exec(lines[lines.length - 1]!);
  if (!close) return false;
  const o = open[1]!;
  const c = close[1]!;
  return c[0] === o[0] && c.length >= o.length;
};

const makeLink = (url: string): MdNode => ({
  type: "link",
  url,
  title: null,
  children: [{ type: "text", value: url }],
});

export const remarkUrlCodeLink = () => (tree: MdNode, file?: { value?: unknown }) => {
  const source = typeof file?.value === "string" ? file.value : undefined;
  // 没有原文就确认不了围栏是否闭合、也确认不了行内代码的定界符：一律不换
  if (source === undefined) return;

  const sliceOf = (node: MdNode): string | undefined => {
    const s = node.position?.start?.offset;
    const e = node.position?.end?.offset;
    return typeof s === "number" && typeof e === "number" && e > s ? source.slice(s, e) : undefined;
  };

  const walk = (node: MdNode, insideLink: boolean) => {
    const children = node.children;
    if (!children) return;
    const nowInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
    for (let i = 0; i < children.length; i++) {
      const cur = children[i]!;
      if (cur.type === "code") {
        // 链接里不会有块级代码；这里只管围栏块自己
        const lang = (cur.lang ?? "").trim().toLowerCase();
        const url = (cur.value ?? "").trim();
        if (PLAIN_FENCE_LANGS.has(lang) && !cur.meta && URL_ONLY_RE.test(url)) {
          const slice = sliceOf(cur);
          if (slice !== undefined && isFenceClosedInSource(slice)) {
            children[i] = { type: "paragraph", children: [makeLink(url)] };
          }
        }
        continue;
      }
      if (cur.type === "inlineCode") {
        const url = cur.value ?? "";
        if (!nowInsideLink && URL_ONLY_RE.test(url)) {
          const slice = sliceOf(cur);
          // 只认单反引号包的：`` `https://x` ``（双反引号等少见写法不动，也避开 remend 对它们的补全差异）
          if (slice !== undefined && /^`[^`]/.test(slice) && /[^`]`$/.test(slice)) {
            children[i] = makeLink(url);
          }
        }
        continue;
      }
      walk(cur, nowInsideLink);
    }
  };
  walk(tree, false);
};

/**
 * 流式前置处理（挂成 remend 的 handler，优先级低于它自带的 inlineCode 补全）：
 * 文本末尾若有一段**没闭合**的 `` `https://… ``（单反引号、开着、不在围栏里），先把这一段藏起来。
 * 否则 remend 会把半截网址补成 `` `https://exa` ``，渲染出 href 是最终网址「真前缀」的链接（点开 404 / 打开错的域名）。
 * 写完（闭合反引号到达）那一帧整段才出现。别的未闭合行内代码（不是网址开头）不动，仍由 remend 照常补全。
 */
export const stripTrailingUnclosedUrlCode = (text: string): string => {
  const i = text.lastIndexOf("`");
  if (i < 0) return text;
  // 只管「单个反引号紧跟 http(s)://」：前一个字符也是反引号 = 双反引号 / 围栏的一部分
  if (i > 0 && text[i - 1] === "`") return text;
  const tail = text.slice(i + 1);
  if (!/^https?:\/\/[^\s<>{}"'`\uE000-\uF8FF]*$/.test(tail)) return text;

  // 这个反引号必须是「开」：它之前（围栏外）的行内反引号个数是偶数；在围栏里面也不管
  let inFence = false;
  let fenceCh = "";
  let fenceLen = 0;
  let ticks = 0;
  for (const line of text.slice(0, i).split("\n")) {
    const m = /^[ \t>]*(`{3,}|~{3,})/.exec(line);
    if (m) {
      const run = m[1]!;
      if (!inFence) {
        inFence = true;
        fenceCh = run[0]!;
        fenceLen = run.length;
        continue;
      }
      if (run[0] === fenceCh && run.length >= fenceLen && CLOSE_FENCE_LINE_RE.test(line)) {
        inFence = false;
        continue;
      }
    }
    if (!inFence) for (const ch of line) if (ch === "`") ticks++;
  }
  if (inFence || ticks % 2 === 1) return text;
  return text.slice(0, i);
};
