/**
 * 「已从上次的 X 继续 · 从头播放」提示：用户自己动了进度（任何一次手动拖动）就应该自己消失。
 *
 * 演进：
 * - 第一版（2026-11-06 上午）：只在落点回到开头（<= 3 秒）时收；
 * - 现在（用户：「任何手动拖动都收」）：除了续播自己的那一跳，任何一次 seeked 都收。
 *
 * 没有 jsdom / 浏览器：真实 <video> 的 seeked 事件、进度条拖动手感不在这里验证（靠手测）；
 * 这里钉的是「seeked 监听的判定」「续播那一跳的排除」「监听的接线与取消」「dock 里确实接了它」。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resumePositionFor } from "@/lib/media/media-memory";
import {
  RESUME_JUMP_TOLERANCE_SECONDS,
  watchUserSeek,
  type SeekedSource,
} from "@/lib/media/media-resume-notice";

/** 最小的假 media 元素：能手动设 currentTime、触发 seeked */
const makeVideo = () => {
  const listeners = new Map<string, Set<() => void>>();
  const video = {
    currentTime: 0,
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  const seek = (t: number) => {
    video.currentTime = t;
    for (const fn of listeners.get("seeked") ?? []) fn();
  };
  const count = (type: string) => listeners.get(type)?.size ?? 0;
  return { video: video as unknown as SeekedSource, seek, count };
};

describe("watchUserSeek：任何手动拖动都收", () => {
  it("拖回开头（0 秒）：收", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    watchUserSeek(video, onSeek);
    seek(0);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("没拖到精确的 0（1.7 秒）：收", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    watchUserSeek(video, onSeek);
    seek(1.7);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("拖到中间别处（从 12:30 拖到 5:00 / 拖到更后面）：也收——这是这次新增的行为", () => {
    for (const to of [300, 60, 900, 3600]) {
      const { video, seek } = makeVideo();
      const onSeek = vi.fn();
      watchUserSeek(video, onSeek);
      seek(to);
      expect(onSeek, `落点 ${to}`).toHaveBeenCalledTimes(1);
    }
  });

  it("没有登记续播那一跳时，任何 seeked 都算用户动的（含恰好落在「上次位置」附近）", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    watchUserSeek(video, onSeek);
    seek(750);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("返回的 stop 会取消监听：卸载后再 seek 不再回调", () => {
    const { video, seek, count } = makeVideo();
    const onSeek = vi.fn();
    const watch = watchUserSeek(video, onSeek);
    expect(count("seeked")).toBe(1);
    watch.stop();
    expect(count("seeked")).toBe(0);
    seek(0);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("只监听 seeked（不碰 timeupdate：正常播放的位置更新不该触发）", () => {
    const { video, count } = makeVideo();
    watchUserSeek(video, () => {});
    expect(count("seeked")).toBe(1);
    expect(count("timeupdate")).toBe(0);
  });
});

describe("watchUserSeek：续播自己的那一跳不收，之后的用户拖动才收", () => {
  it("登记了续播目标 750 秒：紧随其后落在 750 的 seeked 不收；之后的拖动收", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    const watch = watchUserSeek(video, onSeek);
    watch.expectResumeJump(750);
    seek(750);
    expect(onSeek).not.toHaveBeenCalled();
    seek(300);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("浏览器把 seek 吸附到相邻帧（750.4）：仍算续播自己的那一跳", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    const watch = watchUserSeek(video, onSeek);
    watch.expectResumeJump(750);
    seek(750 + RESUME_JUMP_TOLERANCE_SECONDS - 0.1);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("容差本身：恰好等于容差仍算续播那一跳（边界含），容差是个「相邻帧」量级的小数而不是随便多大", () => {
    expect(RESUME_JUMP_TOLERANCE_SECONDS).toBeGreaterThanOrEqual(0.5);
    expect(RESUME_JUMP_TOLERANCE_SECONDS).toBeLessThanOrEqual(3);
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    const watch = watchUserSeek(video, onSeek);
    watch.expectResumeJump(750);
    seek(750 + RESUME_JUMP_TOLERANCE_SECONDS);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("绝对值对照：目标 750、用户落在 755（差 5 秒）一定是用户拖动，不依赖容差常量", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    const watch = watchUserSeek(video, onSeek);
    watch.expectResumeJump(750);
    seek(755);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("落点离目标超过容差：不是续播那一跳，按用户拖动收", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    const watch = watchUserSeek(video, onSeek);
    watch.expectResumeJump(750);
    seek(750 + RESUME_JUMP_TOLERANCE_SECONDS + 0.5);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("登记只管下一次 seeked：它命中后清掉，再次落在 750（用户又拖回这里）要收", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    const watch = watchUserSeek(video, onSeek);
    watch.expectResumeJump(750);
    seek(750);
    expect(onSeek).not.toHaveBeenCalled();
    seek(750);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("登记后第一次 seeked 就是用户拖到别处（续播那一跳没触发 seeked）：登记不会吞掉它，且之后也清掉", () => {
    const { video, seek } = makeVideo();
    const onSeek = vi.fn();
    const watch = watchUserSeek(video, onSeek);
    watch.expectResumeJump(750);
    seek(20);
    expect(onSeek).toHaveBeenCalledTimes(1);
    seek(750);
    expect(onSeek).toHaveBeenCalledTimes(2);
  });

  it("登记非法时间（NaN / Infinity）等于没登记：不会吞掉任何 seeked", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { video, seek } = makeVideo();
      const onSeek = vi.fn();
      const watch = watchUserSeek(video, onSeek);
      watch.expectResumeJump(bad);
      seek(0);
      expect(onSeek).toHaveBeenCalledTimes(1);
    }
  });

  it("与续播判定的关系：会触发续播的位置（>3 秒）正是需要登记排除的那一跳", () => {
    for (const position of [3.01, 12.5, 750]) {
      expect(resumePositionFor({ position }, 3600)).toBe(position);
      const { video, seek } = makeVideo();
      const onSeek = vi.fn();
      const watch = watchUserSeek(video, onSeek);
      watch.expectResumeJump(position);
      seek(position);
      expect(onSeek, `位置 ${position}`).not.toHaveBeenCalled();
    }
  });
});

describe("dock 接线", () => {
  const src = readFileSync(
    path.join(path.resolve(import.meta.dirname, ".."), "src", "components", "media", "media-player-dock.tsx"),
    "utf-8",
  );

  it("用 watchUserSeek 监听 <video>：任何 seek 都把 resumedFrom 清掉，stop 作为 effect 清理，ref 随之置空", () => {
    expect(src).toContain('from "@/lib/media/media-resume-notice"');
    expect(src).toMatch(/const watch = watchUserSeek\(v, \(\) => setResumedFrom\(null\)\);/);
    expect(src).toMatch(/resumeWatchRef\.current = watch;/);
    expect(src).toMatch(/watch\.stop\(\);\s*resumeWatchRef\.current = null;/);
  });

  it("监听是 layout effect、且排在「元数据到了」那个 layout effect 之前（赶在 loadedmetadata 触发续播之前就位）", () => {
    const watchAt = src.indexOf("const watch = watchUserSeek(");
    const metaAt = src.indexOf('v.addEventListener("loadedmetadata", onMeta);');
    expect(watchAt).toBeGreaterThan(0);
    expect(metaAt).toBeGreaterThan(watchAt);
    // watchUserSeek 所在的 effect 是 useLayoutEffect
    const head = src.slice(src.lastIndexOf("use", watchAt - 200 < 0 ? 0 : watchAt - 200), watchAt);
    expect(head).toContain("useLayoutEffect(");
  });

  it("续播那一跳：先 expectResumeJump(t)、再 v.currentTime = t；只对续播（p.time === \"resume\"）登记", () => {
    expect(src).toMatch(
      /if \(p\.time === "resume"\) resumeWatchRef\.current\?\.expectResumeJump\(t\);\s*v\.currentTime = t;/,
    );
  });

  it("原有的「从头播放」按钮与「×」仍在", () => {
    expect(src).toContain("从头播放");
    expect(src).toMatch(/onDismiss=\{\(\) => setResumedFrom\(null\)\}/);
  });

  it("旧的「只在拖回开头时收」已移除（isBackAtStart / watchBackAtStart 不再被使用）", () => {
    expect(src).not.toContain("watchBackAtStart");
    expect(src).not.toContain("isBackAtStart");
  });
});
