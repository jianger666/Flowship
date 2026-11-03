/**
 * 音频波形：从解码后的采样里算出每个桶的峰值（0..1），画 canvas 用。
 *
 * 解码是整文件进内存，所以先过 {@link shouldComputeWaveform}：太大 / 太长的文件不画波形，
 * 退回普通进度条，不拿内存冒险。
 */

/** 超过这个大小的音频文件不解码画波形 */
export const MAX_WAVEFORM_BYTES = 40 * 1024 * 1024;
/** 超过这个时长（秒）的不画 */
export const MAX_WAVEFORM_SECONDS = 20 * 60;

export const shouldComputeWaveform = (sizeBytes: number, durationSeconds?: number): boolean => {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_WAVEFORM_BYTES) return false;
  if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > MAX_WAVEFORM_SECONDS) {
    return false;
  }
  return true;
};

/**
 * 把多声道采样压成 `buckets` 个峰值：每个桶取所有声道里绝对值的最大值，
 * 最后按全局最大值归一（整段几乎静音时不放大噪声：全局峰值 < 0.01 就不归一）。
 */
export const computePeaks = (
  channels: ReadonlyArray<ArrayLike<number>>,
  buckets: number,
): Float32Array => {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(n);
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  if (length === 0 || channels.length === 0) return out;
  const per = length / n;
  let globalMax = 0;
  for (let b = 0; b < n; b++) {
    const from = Math.floor(b * per);
    // 最后一个桶直接收到末尾：`n * (length / n)` 在浮点下可能是 length - ε，floor 后会漏掉最后一个（些）采样
    const to =
      b === n - 1 ? length : Math.min(length, Math.max(from + 1, Math.floor((b + 1) * per)));
    let peak = 0;
    for (const ch of channels) {
      const end = Math.min(to, ch.length);
      for (let i = from; i < end; i++) {
        const v = Math.abs(ch[i]!);
        if (v > peak) peak = v;
      }
    }
    out[b] = peak;
    if (peak > globalMax) globalMax = peak;
  }
  if (globalMax >= 0.01) {
    for (let b = 0; b < n; b++) out[b] = Math.min(1, out[b]! / globalMax);
  }
  return out;
};
