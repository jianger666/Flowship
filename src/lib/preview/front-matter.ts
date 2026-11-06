/**
 * markdown 开头的 YAML front matter 拆分（纯函数）
 *
 * skills / plan / 文档产物里到处是 `---\nname: x\ndescription: y\n---`，直接丢给 markdown 渲染会变成一条横线加一段乱码。
 * 这里只做「展示用」的轻量拆分：顶层 `key: value` 取成键值对（多行 / 列表值原样拼回去），不是 YAML 解析器，也不改源文件。
 * 判不准就当没有 front matter（宁可原样渲染，也不吞用户的正文）。
 */

export interface FrontMatterEntry {
  key: string;
  value: string;
}

export interface FrontMatterSplit {
  entries: FrontMatterEntry[] | null;
  /** 去掉 front matter 之后的正文（没有 front matter 时就是原文） */
  body: string;
}

const MAX_FRONT_MATTER_LINES = 80;
const KEY_LINE = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*)|$)/;

export const splitFrontMatter = (text: string): FrontMatterSplit => {
  const none: FrontMatterSplit = { entries: null, body: text };
  if (!text.startsWith("---")) return none;
  const lines = text.split("\n");
  if (lines[0]!.trimEnd() !== "---") return none;

  let close = -1;
  for (let i = 1; i < Math.min(lines.length, MAX_FRONT_MATTER_LINES + 1); i++) {
    if (lines[i]!.trimEnd() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return none;

  const entries: FrontMatterEntry[] = [];
  for (let i = 1; i < close; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = KEY_LINE.exec(line);
    if (m) {
      entries.push({ key: m[1]!, value: (m[2] ?? "").trim() });
      continue;
    }
    // 续行（缩进 / 列表项）：拼到上一个键的值里；还没有任何键就说明这不是 front matter
    if (/^(\s+|- )/.test(line) && entries.length > 0) {
      const last = entries[entries.length - 1]!;
      last.value = last.value ? `${last.value}\n${line.trim()}` : line.trim();
      continue;
    }
    return none;
  }
  if (entries.length === 0) return none;

  const body = lines.slice(close + 1).join("\n").replace(/^\n+/, "");
  return { entries, body };
};
