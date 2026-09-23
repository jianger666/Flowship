import { describe, expect, it } from "vitest";

import {
  extractVideoFrame,
  previewTimestamps,
  probeVideoDurationSec,
} from "../src/lib/server/feishu-bridge/video-frames";

describe("previewTimestamps", () => {
  it("未知/非法时长 → 单帧 1s 兜底", () => {
    expect(previewTimestamps(null)).toEqual([1]);
    expect(previewTimestamps(0)).toEqual([1]);
    expect(previewTimestamps(-5)).toEqual([1]);
  });

  it("超短视频 → 中点单帧", () => {
    expect(previewTimestamps(1.2)).toEqual([0.6]);
  });

  it("正常视频 → 4 帧、避开头尾、递增", () => {
    const ts = previewTimestamps(125);
    expect(ts).toHaveLength(4);
    expect(ts[0]).toBeGreaterThan(0);
    expect(ts[ts.length - 1]!).toBeLessThan(125);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
    }
  });
});

describe("ffmpeg 缺失退化", () => {
  it("extractVideoFrame 二进制不存在 → false（不抛）", async () => {
    await expect(
      extractVideoFrame(
        "/tmp/definitely-no-such-ffmpeg-xyz",
        "/tmp/no-video.mp4",
        1,
        "/tmp/no-frame.jpg",
      ),
    ).resolves.toBe(false);
  }, 15000);

  it("probeVideoDurationSec 二进制不存在 → null（不抛）", async () => {
    await expect(
      probeVideoDurationSec("/tmp/definitely-no-such-ffprobe-xyz", "/tmp/no-video.mp4"),
    ).resolves.toBeNull();
  }, 15000);
});
