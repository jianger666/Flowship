/**
 * 音视频类型判定（media-kind）：扩展名白名单 / MIME / 字幕扩展名
 *
 * 这套判定是 `/api/local-media` 的白名单、路径 chip 是否变成播放入口、消息末尾媒体条的单一来源，
 * 判错一次要么放行了不该读的文件，要么漏掉了该能播的文件。
 */
import { describe, expect, it } from "vitest";

import {
  AUDIO_EXTS,
  MEDIA_MIME,
  SUBTITLE_EXTS,
  VIDEO_EXTS,
  detectMediaKind,
  isMediaPath,
  isSubtitlePath,
  mediaExtOf,
  mimeForMedia,
} from "@/lib/media/media-kind";

describe("mediaExtOf：取扩展名", () => {
  it("小写化、不带点", () => {
    expect(mediaExtOf("/a/b/clip.MP4")).toBe("mp4");
    expect(mediaExtOf("/a/b/Song.FlAc")).toBe("flac");
  });

  it("只看最后一段文件名：目录名里带点不算", () => {
    expect(mediaExtOf("/a/b.mp4/video")).toBe("");
    expect(mediaExtOf("/a/v1.2.3/clip.webm")).toBe("webm");
    expect(mediaExtOf("C:\\v1.mp4\\readme")).toBe("");
  });

  it("兼容 Windows 反斜杠路径与混用分隔符", () => {
    expect(mediaExtOf("C:\\Users\\me\\Videos\\demo.mov")).toBe("mov");
    expect(mediaExtOf("D:/mix\\path/a.m4a")).toBe("m4a");
  });

  it("没有扩展名 / 以点结尾 / 以分隔符结尾 → 空串", () => {
    expect(mediaExtOf("/a/b/video")).toBe("");
    expect(mediaExtOf("/a/b/clip.")).toBe("");
    expect(mediaExtOf("/a/b/")).toBe("");
    expect(mediaExtOf("")).toBe("");
    expect(mediaExtOf("   ")).toBe("");
  });

  it("多个点只取最后一段；首尾空白会被 trim", () => {
    expect(mediaExtOf("/a/archive.tar.gz")).toBe("gz");
    expect(mediaExtOf("  /a/b.mp3  ")).toBe("mp3");
  });

  it("裸扩展名（带不带点都行）原样返回小写", () => {
    expect(mediaExtOf("mp4")).toBe("mp4");
    expect(mediaExtOf(".MP4")).toBe("mp4");
    expect(mediaExtOf("Opus")).toBe("opus");
  });
});

describe("detectMediaKind / isMediaPath", () => {
  it("视频扩展名 → video，音频扩展名 → audio（逐个覆盖白名单）", () => {
    for (const ext of VIDEO_EXTS) expect(detectMediaKind(`/x/clip.${ext}`)).toBe("video");
    for (const ext of AUDIO_EXTS) expect(detectMediaKind(`/x/clip.${ext}`)).toBe("audio");
  });

  it("大小写不敏感", () => {
    expect(detectMediaKind("/x/CLIP.MOV")).toBe("video");
    expect(detectMediaKind("/x/Song.Mp3")).toBe("audio");
  });

  it("Windows 反斜杠路径", () => {
    expect(detectMediaKind("C:\\Users\\me\\a.webm")).toBe("video");
    expect(detectMediaKind("\\\\nas\\share\\a.wav")).toBe("audio");
  });

  it("`.ts` 不算视频（与 TypeScript 源码撞扩展名）", () => {
    expect(detectMediaKind("/repo/src/index.ts")).toBeNull();
    expect(isMediaPath("/repo/src/index.ts")).toBe(false);
    expect(detectMediaKind("ts")).toBeNull();
  });

  it("要转码才能播的容器不在白名单", () => {
    for (const ext of ["mkv", "avi", "wmv", "flv", "ts", "txt", "png", "srt"]) {
      expect(detectMediaKind(`/x/a.${ext}`)).toBeNull();
    }
  });

  it("没有扩展名 / 目录名带媒体扩展 → null", () => {
    expect(detectMediaKind("/x/a.mp4/readme")).toBeNull();
    expect(detectMediaKind("/x/mp4")).toBeNull();
    expect(detectMediaKind("")).toBeNull();
  });

  it("裸扩展名也能判（server 侧 / 菜单用）", () => {
    expect(detectMediaKind("mp4")).toBe("video");
    expect(detectMediaKind(".opus")).toBe("audio");
    expect(detectMediaKind("exe")).toBeNull();
  });

  it("isMediaPath 与 detectMediaKind 一致", () => {
    expect(isMediaPath("/a/b.mp4")).toBe(true);
    expect(isMediaPath("/a/b.flac")).toBe(true);
    expect(isMediaPath("/a/b.md")).toBe(false);
  });

  it("扩展名不会被前缀 / 后缀欺骗", () => {
    expect(detectMediaKind("/a/b.mp4x")).toBeNull();
    expect(detectMediaKind("/a/b.xmp4")).toBeNull();
    expect(detectMediaKind("/a/b.mp4.bak")).toBeNull();
  });
});

describe("mimeForMedia", () => {
  it("白名单里每个扩展名都有 MIME，且 MIME 类型前缀与 kind 一致", () => {
    for (const ext of VIDEO_EXTS) expect(mimeForMedia(`/a/x.${ext}`)).toMatch(/^video\//);
    for (const ext of AUDIO_EXTS) expect(mimeForMedia(`/a/x.${ext}`)).toMatch(/^audio\//);
  });

  it("MEDIA_MIME 表的键恰好等于两个白名单的并集（不漏不多）", () => {
    expect(Object.keys(MEDIA_MIME).sort()).toEqual([...VIDEO_EXTS, ...AUDIO_EXTS].sort());
  });

  it("具体映射（容易写错的几个）", () => {
    expect(mimeForMedia("/a/x.mp4")).toBe("video/mp4");
    expect(mimeForMedia("/a/x.m4v")).toBe("video/mp4");
    expect(mimeForMedia("/a/x.mov")).toBe("video/quicktime");
    expect(mimeForMedia("/a/x.webm")).toBe("video/webm");
    expect(mimeForMedia("/a/x.mp3")).toBe("audio/mpeg");
    expect(mimeForMedia("/a/x.m4a")).toBe("audio/mp4");
    expect(mimeForMedia("/a/x.aac")).toBe("audio/aac");
    expect(mimeForMedia("/a/x.wav")).toBe("audio/wav");
    expect(mimeForMedia("/a/x.flac")).toBe("audio/flac");
    expect(mimeForMedia("/a/x.ogg")).toBe("audio/ogg");
    // .opus 是 Ogg 封装的 Opus
    expect(mimeForMedia("/a/x.opus")).toBe("audio/ogg");
  });

  it("大小写不敏感；裸扩展名可用", () => {
    expect(mimeForMedia("/a/X.MP4")).toBe("video/mp4");
    expect(mimeForMedia("webm")).toBe("video/webm");
    expect(mimeForMedia(".MP3")).toBe("audio/mpeg");
  });

  it("不在白名单 / 没扩展名 → null", () => {
    expect(mimeForMedia("/a/x.mkv")).toBeNull();
    expect(mimeForMedia("/a/x.ts")).toBeNull();
    expect(mimeForMedia("/a/x")).toBeNull();
    expect(mimeForMedia("")).toBeNull();
  });
});

describe("isSubtitlePath", () => {
  it("只认 srt / vtt（大小写不敏感、裸扩展名可用）", () => {
    expect([...SUBTITLE_EXTS]).toEqual(["srt", "vtt"]);
    expect(isSubtitlePath("/a/x.srt")).toBe(true);
    expect(isSubtitlePath("/a/x.VTT")).toBe(true);
    expect(isSubtitlePath("C:\\a\\x.Srt")).toBe(true);
    expect(isSubtitlePath("vtt")).toBe(true);
    expect(isSubtitlePath(".srt")).toBe(true);
  });

  it("其它扩展名 / 没扩展名 / 目录名带点 → false", () => {
    expect(isSubtitlePath("/a/x.ass")).toBe(false);
    expect(isSubtitlePath("/a/x.mp4")).toBe(false);
    expect(isSubtitlePath("/a/x")).toBe(false);
    expect(isSubtitlePath("/a/x.srt/readme")).toBe(false);
    expect(isSubtitlePath("")).toBe(false);
  });

  it("字幕不是媒体，媒体不是字幕（两套白名单互斥）", () => {
    expect(isMediaPath("/a/x.srt")).toBe(false);
    expect(isSubtitlePath("/a/x.mp3")).toBe(false);
  });
});
