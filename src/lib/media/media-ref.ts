/**
 * 媒体引用：`路径#t=起[,止]` ——W3C Media Fragments 的时间片段写法。
 *
 * 为什么用标准写法而不是自创：
 * - AI 一眼认得（`#t=12.4,15` 就是「12.4 秒到 15 秒」），脚本里 `-ss 12.4 -to 15` 直接能用；
 * - 整段放进一个行内代码里，Flowship 把它渲染成可点的文件、点了从该时间开始播；
 * - 复制到别处（飞书 / 笔记）也是完整的路径，不依赖 Flowship 才看得懂。
 *
 * 播放器自己不生成这种引用，只负责认：AI 回复里写了就渲染成按钮。
 *
 * 单位固定是秒（可带小数）；`npt:` 前缀和 `1:02.5` 这类冒号写法也认。
 */

import { detectMediaKind } from "@/lib/media/media-kind";
import { formatClock, parseClock } from "@/lib/media/media-time";
import { isAbsolutePathLike, resolveIdeTarget } from "@/lib/path-utils";
import { fileUrlToLocalPath } from "@/lib/unc-path";

export interface MediaRef {
  /** 路径（绝对，或相对 baseDir；解析前保持原样） */
  path: string;
  /** 起点（秒） */
  start?: number;
  /** 终点（秒），只在有 start 时才有意义 */
  end?: number;
}

/**
 * 路径里空白之后紧跟：选项（`-i` / `--foo`）、另一个绝对路径（`/` / `~/` / 盘符）——
 * 说明这是个命令行（`/opt/bin/ffmpeg -i /a/in.mp4 out.mp4`）或一次列了几个文件，不是单个带空格的路径。
 * 选项只认「短横线 + 字母」：`Track - Remix.mp3` 里的 ` - `（后面是空格）是正常文件名。
 */
const SECOND_ARG_AFTER_SPACE_RE = /\s(?:--?[A-Za-z]|\/|~\/|[A-Za-z]:[\\/])/;

/** 行内代码里最多这么长才当媒体引用（正常路径 + 片段远小于此，防超长字符串） */
const MAX_TOKEN_LENGTH = 600;

/**
 * 解析 `t=...` 片段（不含 `#`）。
 * - `t=12.4`        → { start: 12.4 }
 * - `t=12.4,15`     → { start: 12.4, end: 15 }
 * - `t=,15`         → { start: 0, end: 15 }
 * - `t=npt:1:02,1:10` → 冒号写法同样认
 * 起点 > 终点、含非法数字 → null。
 */
export const parseMediaFragment = (
  fragment: string,
): { start: number; end?: number } | null => {
  const m = /^t=(?:npt:)?([^,]*)(?:,(.*))?$/i.exec(fragment.trim());
  if (!m) return null;
  const startText = (m[1] ?? "").trim();
  const endText = (m[2] ?? "").trim();
  if (!startText && !endText) return null;
  const start = startText ? parseClock(startText) : 0;
  if (start === null) return null;
  if (!endText) return { start };
  const end = parseClock(endText);
  if (end === null || end < start) return null;
  return { start, end };
};

/**
 * 解析一个行内代码 / 链接目标：是「音视频路径（可带 #t=）」就返回 MediaRef，否则 null。
 * 要求带路径分隔符（裸文件名 `a.mp4` 不认——和普通路径识别的口径一致，避免把示例文字当文件）。
 */
export const parseMediaRefToken = (token: string): MediaRef | null => {
  const text = token.trim();
  if (!text || text.length > MAX_TOKEN_LENGTH) return null;
  if (/[`"'\n\r]/.test(text)) return null;
  const hashAt = text.indexOf("#");
  const pathPart = hashAt >= 0 ? text.slice(0, hashAt) : text;
  const fragment = hashAt >= 0 ? text.slice(hashAt + 1) : "";
  if (!pathPart || !/[\\/]/.test(pathPart)) return null;
  // `~/Movies/a.mp4`：波浪号在这里没人展开，当相对路径拼会拼成 `<baseDir>/~/Movies/a.mp4`、必然 404，不认
  if (pathPart.startsWith("~")) return null;
  if (!detectMediaKind(pathPart)) return null;
  if (/\s/.test(pathPart)) {
    // 相对路径带空格多半不是干净路径（与 looksLikePath 同口径）；绝对路径放行
    if (!isAbsolutePathLike(pathPart)) return null;
    // 但「绝对路径开头的整条命令」不是路径：空白后面跟着选项（` -i`）或另一个路径（` /b.mp4` / ` ~/` / ` D:\`）
    if (SECOND_ARG_AFTER_SPACE_RE.test(pathPart)) return null;
  }
  if (!fragment) return { path: pathPart };
  const parsed = parseMediaFragment(fragment);
  // 片段写坏了：当普通媒体路径处理（从头播），别把整条引用丢掉
  if (!parsed) return { path: pathPart };
  return { path: pathPart, start: parsed.start, end: parsed.end };
};

/** 引用在界面上的短标注：`00:12.4` / `00:12.4–00:15.0`（给人看的时钟，不含路径） */
export const formatMediaRefRange = (start?: number, end?: number): string => {
  if (start === undefined) return "";
  const a = formatClock(start, { digits: 1, pad: true });
  if (end === undefined || end <= start) return a;
  return `${a}–${formatClock(end, { digits: 1, pad: true })}`;
};

/**
 * 解析成绝对路径 + 起止；相对路径要 baseDir，拼不出 → null。
 * 路径不做 realpath（那是 server 的事），这里只做字符串层面的归一。
 */
export const resolveMediaRef = (
  ref: MediaRef,
  baseDir?: string,
): (MediaRef & { absolute: string }) | null => {
  const target = resolveIdeTarget(ref.path, baseDir);
  if (!target) return null;
  // resolveIdeTarget 会把 `:行号` 后缀拆掉；拆完不再是音视频（`a.mp4:12` 之类）就不认
  if (!detectMediaKind(target.absolute)) return null;
  return { ...ref, absolute: target.absolute };
};

/** 一段 markdown 里最多收几个媒体（再多的是清单，不是「这条消息的产物」） */
export const MAX_MEDIA_REFS_PER_MESSAGE = 12;

export interface ResolvedMediaRef extends MediaRef {
  absolute: string;
}

// 围栏行：最多缩进 3 格 + 3 个以上同种围栏字符 + 其后的说明文字（CommonMark 的 info string）
// 说明文字用 [^\n]* 而不是 .*：CRLF 文本按 \n 切行后行尾还带着 \r，`.` 不匹配 \r 会让整行不认
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})([^\n]*)$/;
// 行内代码：单反引号包裹、同一行内（Streamdown 的行内 code 同口径）
const INLINE_CODE_RE = /`([^`\n]{1,600})`/g;
// markdown 链接目标：[文字](目标) —— 只取以 / 或盘符开头的本地路径（带空格的写 <...>）
const LINK_TARGET_RE = /\]\((<[^>\n]{1,600}>|[^)\s\n]{1,600})\)/g;

/**
 * 从一段 markdown 里按出现顺序提取媒体引用（行内代码 + 本地链接），去掉围栏代码块里的内容，
 * 同一个文件只保留第一次出现（卡片按文件算，不按片段算）。最多 {@link MAX_MEDIA_REFS_PER_MESSAGE} 个。
 */
export const extractMediaRefsFromMarkdown = (
  text: string,
  baseDir?: string,
): ResolvedMediaRef[] => {
  if (!text || !/\.(mp4|m4v|mov|webm|mp3|m4a|aac|wav|flac|ogg|opus)/i.test(text)) return [];
  const out: ResolvedMediaRef[] = [];
  const seen = new Set<string>();

  const push = (token: string) => {
    if (out.length >= MAX_MEDIA_REFS_PER_MESSAGE) return;
    const ref = parseMediaRefToken(token);
    if (!ref) return;
    const resolved = resolveMediaRef(ref, baseDir);
    if (!resolved) return;
    if (seen.has(resolved.absolute)) return;
    seen.add(resolved.absolute);
    out.push(resolved);
  };

  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = FENCE_RE.exec(line);
    if (f) {
      const marker = f[1]!;
      const info = f[2]!;
      if (fence === null) {
        // 反引号围栏的说明文字里不能有反引号：```/a/b.mp4``` 是行内代码，不是围栏的开头
        if (marker[0] !== "`" || !info.includes("`")) {
          fence = marker;
          continue;
        }
      } else {
        // 关闭围栏：同种字符、不短于开启围栏、后面只能是空白——```js 是嵌套示例里的新开头，不是结尾
        if (marker[0] === fence[0] && marker.length >= fence.length && info.trim() === "") fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    if (out.length >= MAX_MEDIA_REFS_PER_MESSAGE) break;
    // 先拿链接目标，再拿行内代码：同一行里两者的出现顺序不影响「按文件去重」，但要保证都扫到
    const hits: Array<{ index: number; token: string }> = [];
    for (const m of line.matchAll(INLINE_CODE_RE)) hits.push({ index: m.index ?? 0, token: m[1]! });
    for (const m of line.matchAll(LINK_TARGET_RE)) {
      const raw = m[1]!;
      const token = raw.startsWith("<") ? raw.slice(1, -1) : raw;
      // file:///C:/x/a.mp4 剥掉协议头后是 /C:/x/a.mp4，盘符前多出来的 / 要一并去掉，否则成了不存在的 POSIX 路径
      const clean = fileUrlToLocalPath(token);
      hits.push({ index: m.index ?? 0, token: clean });
    }
    hits.sort((a, b) => a.index - b.index);
    for (const h of hits) push(h.token);
  }
  return out;
};
