"use client";

/**
 * 音频波形峰值：整文件取回 → Web Audio 解码 → 压成固定桶数的峰值。
 *
 * 内存护栏：先看文件大小（来自 HEAD）与时长，过大 / 过长就直接放弃（退回普通进度条）；
 * 解码用 8kHz 的 OfflineAudioContext——波形不需要音质，8kHz 让 15 分钟立体声也只占 ~60MB。
 * 结果按「路径 + 版本」缓存（最多 24 份），同一个文件反复打开 / 切换对比组不重复解码。
 */

import { useEffect, useState } from "react";

import { computePeaks, shouldComputeWaveform } from "@/lib/media/media-peaks";
import { localMediaUrl } from "@/lib/media/media-url";

export const WAVEFORM_BUCKETS = 1200;
const DECODE_SAMPLE_RATE = 8000;
const CACHE_MAX = 24;

const cache = new Map<string, Float32Array>();

const remember = (key: string, peaks: Float32Array) => {
  cache.delete(key);
  cache.set(key, peaks);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

export type WaveformState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; peaks: Float32Array }
  | { status: "skipped"; reason: string }
  | { status: "error" };

interface Slot {
  key: string;
  state: WaveformState;
}

/**
 * @param path    音频绝对路径；null = 不算
 * @param version 文件版本（ETag 去引号）；未知时不算——避免用旧版本的峰值冒充新文件
 * @param size    文件字节数（HEAD 的 Content-Length）
 * @param duration 时长（秒，可选，元数据到了才有）
 */
export const useWaveformPeaks = (
  path: string | null,
  version: string | null,
  size: number,
  duration: number,
): WaveformState => {
  const key = path && version ? `${path}|${version}` : "";
  const [slot, setSlot] = useState<Slot>({ key: "", state: { status: "idle" } });

  const skip = !key
    ? null
    : !shouldComputeWaveform(size, duration > 0 ? duration : undefined)
      ? "文件太大 / 太长，不画波形"
      : null;

  // 时长还没拿到（元数据没到）时先不解码：>20 分钟的长音频靠时长拦，拦之前就开解会白占几百 MB
  const durationKnown = duration > 0;

  useEffect(() => {
    if (!key || !path || skip || !durationKnown) return;
    const cached = cache.get(key);
    if (cached) {
      setSlot({ key, state: { status: "ready", peaks: cached } });
      return;
    }
    let cancelled = false;
    setSlot({ key, state: { status: "loading" } });
    void (async () => {
      try {
        const res = await fetch(localMediaUrl(path, version ?? undefined), { cache: "force-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const Ctor =
          window.OfflineAudioContext ??
          (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
            .webkitOfflineAudioContext;
        if (!Ctor) throw new Error("no OfflineAudioContext");
        const ctx = new Ctor(2, 1, DECODE_SAMPLE_RATE);
        const audio = await ctx.decodeAudioData(buf);
        if (cancelled) return;
        const channels: Float32Array[] = [];
        for (let i = 0; i < audio.numberOfChannels; i++) channels.push(audio.getChannelData(i));
        const peaks = computePeaks(channels, WAVEFORM_BUCKETS);
        remember(key, peaks);
        if (!cancelled) setSlot({ key, state: { status: "ready", peaks } });
      } catch {
        if (!cancelled) setSlot({ key, state: { status: "error" } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, path, version, skip, durationKnown]);

  if (!key) return { status: "idle" };
  if (skip) return { status: "skipped", reason: skip };
  // 路径 / 版本切换的那一帧：旧 slot 还没被新 effect 覆盖，别把旧结果当新的
  if (slot.key !== key) {
    const cached = cache.get(key);
    return cached ? { status: "ready", peaks: cached } : { status: "loading" };
  }
  return slot.state;
};
