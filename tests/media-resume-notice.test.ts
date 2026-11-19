/**
 * 「已从上次的 X 继续 · 从头播放」提示：用户自己动了进度（任何一次手动拖动）就应该自己消失。
 *
 * 另一条：续播后实际播放满几秒也自己收（watchPlayedFor）。
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
  RESUME_NOTICE_PLAYED_SECONDS,
  watchPlayedFor,
  watchUserSeek,
  type PlaybackSource,
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

/** 能模拟播放进度的假 media 元素：play(秒数) 按 0.25s 一帧走 timeupdate，seek(t) 按真实顺序发 seeking → timeupdate → seeked */
const makePlayer = () => {
  const listeners = new Map<string, Set<() => void>>();
  const emit = (type: string) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
  const video = {
    currentTime: 0,
    paused: false,
    playbackRate: 1,
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  const play = (seconds: number, frame = 0.25) => {
    const frames = Math.round(seconds / frame);
    for (let i = 0; i < frames; i++) {
      video.currentTime += frame;
      emit("timeupdate");
    }
  };
  /** 位置前进 delta 秒并发一次 timeupdate（不受 paused 影响，用来模拟暂停瞬间 / 位置不动时的偶发 timeupdate） */
  const tick = (delta: number) => {
    video.currentTime += delta;
    emit("timeupdate");
  };
  const seek = (t: number) => {
    emit("seeking");
    video.currentTime = t;
    emit("timeupdate");
    emit("seeked");
  };
  const count = (type: string) => listeners.get(type)?.size ?? 0;
  return {
    video: video as unknown as PlaybackSource & { currentTime: number; paused: boolean; playbackRate: number },
    play,
    tick,
    seek,
    count,
  };
};

describe("watchPlayedFor：续播后实际播放满几秒，提示自己收", () => {
  it("默认阈值是「几秒」量级（用户说的是播了好几秒）", () => {
    expect(RESUME_NOTICE_PLAYED_SECONDS).toBeGreaterThanOrEqual(3);
    expect(RESUME_NOTICE_PLAYED_SECONDS).toBeLessThanOrEqual(10);
  });

  it("播满阈值才调、且只调一次；没播满不调", () => {
    const { video, play } = makePlayer();
    const onElapsed = vi.fn();
    watchPlayedFor(video, 5, onElapsed);
    play(4.75);
    expect(onElapsed).not.toHaveBeenCalled();
    play(0.25);
    expect(onElapsed).toHaveBeenCalledTimes(1);
    play(10);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("倍速下按用户实际看的时长算：2x 要位置走 10 秒才满 5 秒、不是 5 秒", () => {
    const { video, play } = makePlayer();
    const onElapsed = vi.fn();
    video.playbackRate = 2;
    watchPlayedFor(video, 5, onElapsed);
    play(9.5); // 位置走了 9.5 秒 = 墙钟 4.75 秒
    expect(onElapsed).not.toHaveBeenCalled();
    play(0.5);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("倍速中途变了也按当时的倍速折算（1x 播 2 秒 + 4x 播 12 秒 = 2 + 3 = 5 秒）", () => {
    const { video, play } = makePlayer();
    const onElapsed = vi.fn();
    watchPlayedFor(video, 5, onElapsed);
    play(2);
    expect(onElapsed).not.toHaveBeenCalled();
    video.playbackRate = 4;
    play(11.5); // +2.875 秒
    expect(onElapsed).not.toHaveBeenCalled();
    play(0.5); // +0.125 秒 → 5.0
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("慢速（0.5x）下同样折算：位置走 2.5 秒 = 墙钟 5 秒", () => {
    const { video, play } = makePlayer();
    const onElapsed = vi.fn();
    video.playbackRate = 0.5;
    watchPlayedFor(video, 5, onElapsed);
    play(2.25);
    expect(onElapsed).not.toHaveBeenCalled();
    play(0.25);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("高倍速下 timeupdate 晚到（位置一步走了 6 秒 = 墙钟 1.5 秒）：算正常播放、不被当成 seek 丢掉；真 seek 级别的跳变仍不算", () => {
    // tick = 一次 timeupdate 里位置直接前进 delta（play 是按 0.25 秒一帧发的，测不到「一步走很远」）
    const { video, tick } = makePlayer();
    const onElapsed = vi.fn();
    video.playbackRate = 4;
    watchPlayedFor(video, 5, onElapsed);
    tick(6); // 4x：墙钟 1.5 秒（原先按位置比 6 > 5 会整步丢掉）
    tick(6); // 3.0
    tick(6); // 4.5
    expect(onElapsed).not.toHaveBeenCalled();
    tick(2); // 5.0
    expect(onElapsed).toHaveBeenCalledTimes(1);

    // 对照：同倍速下位置一步走 60 秒（墙钟 15 秒）仍按 seek 处理、不累计
    const p2 = makePlayer();
    const onElapsed2 = vi.fn();
    p2.video.playbackRate = 4;
    watchPlayedFor(p2.video, 5, onElapsed2);
    p2.tick(60);
    p2.tick(19); // 只累计这一步 4.75 秒 → 还没满
    expect(onElapsed2).not.toHaveBeenCalled();
    p2.tick(1);
    expect(onElapsed2).toHaveBeenCalledTimes(1);
  });

  it("倍速取值不合法（0 / 负数 / NaN）按 1x 算：不会停摆也不会炸成 Infinity 瞬间收掉", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { video, play } = makePlayer();
      const onElapsed = vi.fn();
      video.playbackRate = bad;
      watchPlayedFor(video, 5, onElapsed);
      play(4.75);
      expect(onElapsed).not.toHaveBeenCalled();
      play(0.25);
      expect(onElapsed).toHaveBeenCalledTimes(1);
    }
  });

  it("暂停期间不累计：暂停 N 秒（位置不动 / 偶发 timeupdate）不会收；恢复播放后接着累计", () => {
    const { video, play, tick } = makePlayer();
    const onElapsed = vi.fn();
    watchPlayedFor(video, 5, onElapsed);
    play(3);
    video.paused = true;
    tick(0.25); // 暂停瞬间位置还会走一帧，但 paused 为真、不计
    tick(0);
    tick(0);
    video.paused = false;
    play(1.75);
    expect(onElapsed).not.toHaveBeenCalled();
    play(0.25);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("累计的是总量、不要求连续：播 3 秒、暂停、再播 2 秒也算满", () => {
    const { video, play, tick } = makePlayer();
    const onElapsed = vi.fn();
    watchPlayedFor(video, 5, onElapsed);
    play(3);
    video.paused = true;
    tick(0);
    video.paused = false;
    play(2);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("拖进度那一跳不算播放：从 0:04 一把拖到 10:00 不会被当成「播了 10 分钟」", () => {
    const { video, play, seek } = makePlayer();
    const onElapsed = vi.fn();
    watchPlayedFor(video, 5, onElapsed);
    play(1);
    seek(600);
    expect(onElapsed).not.toHaveBeenCalled();
    // 拖完之后的正常播放照常从新位置重新累计
    play(3.75);
    expect(onElapsed).not.toHaveBeenCalled();
    play(0.25);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("往回拖也不算（位置倒退不是播放）", () => {
    const { video, play, seek } = makePlayer();
    video.currentTime = 100;
    const onElapsed = vi.fn();
    watchPlayedFor(video, 5, onElapsed);
    play(2);
    seek(10);
    play(2);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("只靠位置差兜底的大跳变（没发 seeking 的异常情形）也不记入：单次前进超过上限不算", () => {
    const { video, play, tick } = makePlayer();
    const onElapsed = vi.fn();
    watchPlayedFor(video, 5, onElapsed);
    play(0.25);
    tick(600); // 没有 seeking / seeked 的跳变
    play(0.25);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("stop 会取消全部监听，之后再播也不回调；重建一个监听就是重新计时", () => {
    const { video, play, count } = makePlayer();
    const onElapsed = vi.fn();
    const watch = watchPlayedFor(video, 5, onElapsed);
    expect(count("timeupdate")).toBe(1);
    expect(count("seeking")).toBe(1);
    expect(count("seeked")).toBe(1);
    play(4);
    watch.stop();
    expect(count("timeupdate")).toBe(0);
    expect(count("seeking")).toBe(0);
    expect(count("seeked")).toBe(0);
    play(10);
    expect(onElapsed).not.toHaveBeenCalled();

    const again = vi.fn();
    watchPlayedFor(video, 5, again);
    play(4.75);
    expect(again).not.toHaveBeenCalled();
    play(0.25);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("高倍速（每帧前进 1 秒）：按媒体前进量累计，同样满阈值就收", () => {
    const { video, play } = makePlayer();
    const onElapsed = vi.fn();
    watchPlayedFor(video, 5, onElapsed);
    play(4, 1);
    expect(onElapsed).not.toHaveBeenCalled();
    play(1, 1);
    expect(onElapsed).toHaveBeenCalledTimes(1);
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

  it("续播提示出现后用 watchPlayedFor 计时：播满阈值就 setResumedFrom(null)；依赖 resumedFrom（每次新提示重新计时），stop 作为清理", () => {
    expect(src).toMatch(/watchPlayedFor\(v, RESUME_NOTICE_PLAYED_SECONDS, \(\) => setResumedFrom\(null\)\)/);
    expect(src).toMatch(/if \(resumedFrom === null\) return;/);
    expect(src).toMatch(/return \(\) => watch\.stop\(\);\s*\}, \[resumedFrom\]\);/);
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
