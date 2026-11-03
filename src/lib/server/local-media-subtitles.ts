/**
 * 字幕 sidecar：播放器自动挂上与媒体文件同目录、同名的 `.srt` / `.vtt`
 *
 * - 命名：`<媒体名>.srt` / `<媒体名>.vtt`，或带语言段 `<媒体名>.zh.srt` / `<媒体名>.zh-CN.vtt`
 * - srt 在这里转成 WebVTT（浏览器 `<track>` 只认 vtt）
 * - 编码：先按 UTF-8 严格解，失败再按 GB18030（国内字幕常见），都不行就按宽松 UTF-8
 * - 只读、有大小上限；守卫与媒体路由同口径（UNC / 绝对路径 / realpath 后复验扩展名）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { isSubtitlePath, mediaExtOf } from "@/lib/media/media-kind";
import { nonLocalPathReason } from "@/lib/unc-path";

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const MAX_SIDECARS = 6;
/** 目录里文件特别多时（下载目录之类）不无限扫 */
const MAX_DIR_ENTRIES = 20_000;

export interface SubtitleSidecar {
  /** 字幕文件绝对路径（再去 `/api/local-media/subtitle` 取 vtt） */
  path: string;
  /** 给人看的名字：语言段，没有就叫「字幕」 */
  label: string;
}

const LANG_LABELS: Record<string, string> = {
  zh: "中文",
  "zh-cn": "简体中文",
  "zh-hans": "简体中文",
  chs: "简体中文",
  "zh-tw": "繁体中文",
  "zh-hant": "繁体中文",
  cht: "繁体中文",
  en: "English",
  eng: "English",
  ja: "日本語",
  jp: "日本語",
  ko: "한국어",
};

const labelFromTag = (tag: string): string => {
  if (!tag) return "字幕";
  return LANG_LABELS[tag.toLowerCase()] ?? tag;
};

/**
 * 找出媒体文件旁边的字幕。`mediaReal` 是已经过 realpath 的媒体路径。
 * 排序：无语言段的在前，其次 vtt 在 srt 前，最后按文件名。
 */
export const findSidecarSubtitles = async (
  mediaReal: string,
): Promise<SubtitleSidecar[]> => {
  const dir = path.dirname(mediaReal);
  const mediaExt = mediaExtOf(mediaReal);
  const base = path.basename(mediaReal, path.extname(mediaReal));
  const prefix = `${base}.`.toLowerCase();
  let names: string[];
  try {
    names = (await fs.readdir(dir)).slice(0, MAX_DIR_ENTRIES);
  } catch {
    return [];
  }
  const hits: Array<{ name: string; tag: string; ext: string }> = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const ext = mediaExtOf(lower);
    if (ext !== "srt" && ext !== "vtt") continue;
    // 去掉 `<媒体名>.` 前缀和 `.ext` 后缀，剩下的是语言段（可能为空）
    const middle = name.slice(prefix.length, name.length - ext.length - 1);
    if (!/^[A-Za-z0-9_-]{0,16}$/.test(middle)) continue;
    // `video.mp4.srt` 这种把媒体扩展名带进去的命名：中间段就是 mp4，不是语言
    hits.push({ name, tag: middle.toLowerCase() === mediaExt ? "" : middle, ext });
  }
  hits.sort((a, b) => {
    if ((a.tag === "") !== (b.tag === "")) return a.tag === "" ? -1 : 1;
    if (a.ext !== b.ext) return a.ext === "vtt" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  // 按排序依次确认「是能读的普通文件」，凑够 MAX_SIDECARS 个就停：
  // 叫 `x.srt` 的目录 / 悬空软链列出来只会让播放器挂一条 404 的字幕轨（stat 跟随软链）
  const items: SubtitleSidecar[] = [];
  for (const h of hits) {
    if (items.length >= MAX_SIDECARS) break;
    const full = path.join(dir, h.name);
    try {
      if (!(await fs.stat(full)).isFile()) continue;
    } catch {
      continue;
    }
    items.push({ path: full, label: labelFromTag(h.tag) });
  }
  return items;
};

/**
 * SRT → WebVTT：补 `WEBVTT` 头、时间戳的逗号换成点、统一换行。已经是 WebVTT 的原样返回（只统一换行）。
 */
export const srtToVtt = (input: string): string => {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT/.test(text)) return text;
  // 只改时间行（含 `-->`）：台词里恰好写了 `10:20:30,5` 之类的文字不能被当成时间戳改掉
  const body = text
    .split("\n")
    .map((line) =>
      line.includes("-->")
        ? line.replace(
            /(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g,
            (_m, hms: string, ms: string) => `${hms}.${ms.padEnd(3, "0")}`,
          )
        : line,
    )
    .join("\n");
  return `WEBVTT\n\n${body.trim()}\n`;
};

/** 字节 → 文本：UTF-8 严格 → GB18030 → 宽松 UTF-8 */
export const decodeSubtitleBytes = (buf: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // 继续
  }
  try {
    return new TextDecoder("gb18030", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
};

export type ReadSubtitleResult =
  | { ok: true; vtt: string }
  | { ok: false; status: number; error: string };

/** 读一个字幕文件并转成 WebVTT 文本 */
export const readSubtitleAsVtt = async (
  rawInput: string,
): Promise<ReadSubtitleResult> => {
  const raw = rawInput.trim();
  if (!raw) return { ok: false, status: 400, error: "path 必填" };
  const nonLocal = nonLocalPathReason(raw);
  if (nonLocal) return { ok: false, status: 400, error: nonLocal };
  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return { ok: false, status: 400, error: "path 必须是绝对路径" };
  }
  if (!isSubtitlePath(raw)) {
    return { ok: false, status: 400, error: "只支持 .srt / .vtt 字幕" };
  }
  try {
    const real = await fs.realpath(raw);
    if (!isSubtitlePath(real)) return { ok: false, status: 404, error: "不是字幕文件" };
    const stat = await fs.stat(real);
    if (!stat.isFile()) return { ok: false, status: 404, error: "不是文件" };
    if (stat.size > MAX_SUBTITLE_BYTES) {
      return { ok: false, status: 413, error: "字幕文件过大（>2MB）" };
    }
    const buf = await fs.readFile(real);
    return { ok: true, vtt: srtToVtt(decodeSubtitleBytes(buf)) };
  } catch {
    return { ok: false, status: 404, error: "文件不存在或不可读" };
  }
};
