/**
 * 大视频抽帧预览（best-effort）。
 *
 * 背景：飞书 media 视频可能几个 GB，50MB 附件上限装不下、模型也看不了本体。
 * 策略：ffprobe 取时长 → ffmpeg 按比例抽 4 帧（640 宽 jpg）→ agent 看画面听交代。
 * ffmpeg 不存在 / 抽帧失败一律返回 null（调用方退化成封面 + 文字说明，不报错）。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type VideoPreview = {
  /** 抽出的帧文件绝对路径（调用方转 base64 后自行删除） */
  framePaths: string[];
  /** 时长（秒），取不到为 null */
  durationSec: number | null;
};

const runBin = (
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout ?? ""));
      },
    );
  });

/** PATH 找不到时再试的固定位置（mac brew / linux 系；Windows 只走 PATH，找不到就退化） */
const BIN_SEARCH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

const findBin = async (name: string): Promise<string | null> => {
  try {
    await runBin(name, ["-version"], 5000);
    return name;
  } catch {
    /* PATH 没有，往固定位置找 */
  }
  for (const d of BIN_SEARCH_DIRS) {
    const abs = path.join(d, name);
    try {
      await runBin(abs, ["-version"], 5000);
      return abs;
    } catch {
      /* 继续下一个 */
    }
  }
  return null;
};

// 进程级缓存：每次大视频都跑 2~8 次 -version 太贵；路径中途不会变
let binsCache: Promise<{
  ffmpeg: string;
  ffprobe: string;
} | null> | null = null;

export const findFfmpegBins = async (): Promise<{
  ffmpeg: string;
  ffprobe: string;
} | null> => {
  if (!binsCache) {
    binsCache = (async () => {
      const [ffmpeg, ffprobe] = await Promise.all([
        findBin("ffmpeg"),
        findBin("ffprobe"),
      ]);
      if (!ffmpeg || !ffprobe) return null;
      return { ffmpeg, ffprobe };
    })();
  }
  return binsCache;
};

export const probeVideoDurationSec = async (
  ffprobeBin: string,
  absPath: string,
): Promise<number | null> => {
  try {
    const out = await runBin(
      ffprobeBin,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        absPath,
      ],
      15000,
    );
    const v = Number.parseFloat(out.trim());
    if (!Number.isFinite(v) || v <= 0) return null;
    return v;
  } catch {
    return null;
  }
};

const FRAME_COUNT = 4;

/** 抽帧时间点（秒）：避开片头黑帧、首尾留余；短视频/未知时长退化为单帧 */
export const previewTimestamps = (durationSec: number | null): number[] => {
  if (durationSec === null || !(durationSec > 0)) return [1];
  if (durationSec < 2) return [Math.max(0.1, Math.round((durationSec / 2) * 10) / 10)];
  const out = new Set<number>();
  for (const f of [0.08, 0.36, 0.62, 0.86]) {
    out.add(Math.round(durationSec * f * 10) / 10);
  }
  return [...out].slice(0, FRAME_COUNT);
};

export const extractVideoFrame = async (
  ffmpegBin: string,
  absPath: string,
  sec: number,
  outPath: string,
): Promise<boolean> => {
  try {
    await runBin(ffmpegBin, frameArgs(absPath, sec, outPath), 30000);
    return true;
  } catch {
    // 失败时 ffmpeg 可能已建出 0 字节 outPath——删掉，别在 tmpdir 堆积
    await fs.unlink(outPath).catch(() => undefined);
    return false;
  }
};

/**
 * 抽帧参数纯函数（单测锁定 H.264 偶数尺寸：
 * `scale=640:-1` 在竖屏视频上算出奇数高度会抽帧失败，必须用 `-2`）。
 */
export const frameArgs = (
  absPath: string,
  sec: number,
  outPath: string,
): string[] => [
  "-y",
  "-v",
  "error",
  "-ss",
  String(sec),
  "-i",
  absPath,
  "-frames:v",
  "1",
  "-q:v",
  "5",
  "-vf",
  "scale=640:-2",
  outPath,
];

export const defaultExtractVideoPreview = async (
  absPath: string,
): Promise<VideoPreview | null> => {
  const bins = await findFfmpegBins();
  if (!bins) return null;
  const durationSec = await probeVideoDurationSec(bins.ffprobe, absPath);
  const framePaths: string[] = [];
  const stamps = previewTimestamps(durationSec);
  for (let i = 0; i < stamps.length; i++) {
    const out = path.join(
      os.tmpdir(),
      `feishu-frame-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}.jpg`,
    );
    if (await extractVideoFrame(bins.ffmpeg, absPath, stamps[i]!, out)) {
      framePaths.push(out);
    }
  }
  if (framePaths.length === 0) return null;
  return { framePaths, durationSec };
};
