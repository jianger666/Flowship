"use client";

/**
 * 音视频播放器（悬浮窗）：时间流里点任何一个音视频路径 / 媒体卡片就在这里播。
 *
 * 为什么是悬浮窗、不是塞进时间流：时间流是虚拟列表，滚出视口的消息会被卸载、播放会断；
 * 弹窗又会挡住对话没法边看边回。这个窗挂在根 Provider 下，滚动 / 切任务都不打断，可拖、可缩、可收成一条。
 *
 * 一个 <video> 元素管所有（音频也用它，只是不显示画面）：换文件只换 src，全屏 / 画中画 / 系统媒体键都不断。
 * 播放位置、倍速、音量、窗口位置都记在本机（media-memory）。
 * 全屏时顶栏 / 控制区叠在画面上，鼠标几秒不动就收起（规则见 media-chrome）；窗口模式不自动隐藏。
 * 所有操作（按钮 / 键盘 / 系统媒体键）汇到 `exec(command)` 一个入口。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AudioLines,
  Film,
  Loader2,
  Maximize2,
  Minus,
  Pause,
  Play,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { getMediaMemory } from "@/components/media/media-memory-client";
import {
  BannerButton,
  DockBanner,
  GroupTabs,
  ResizeHandles,
  ShortcutHelp,
} from "@/components/media/media-dock-parts";
import { MediaSeekBar } from "@/components/media/media-seek-bar";
import { MediaTimelineRow } from "@/components/media/media-timeline-row";
import {
  MORE_ICONS,
  MediaTransport,
  type DockMode,
  type MoreAction,
} from "@/components/media/media-transport";
import { MediaWaveform } from "@/components/media/media-waveform";
import {
  useMediaElementState,
  type MediaErrorInfo,
} from "@/components/media/use-media-element-state";
import {
  describeMediaInfoFailure,
  useMediaFileInfo,
  versionFromEtag,
} from "@/components/media/use-media-file-info";
import { useIdleHide } from "@/components/media/use-idle-hide";
import { useMediaSession } from "@/components/media/use-media-session";
import { useSeekThumbnail } from "@/components/media/use-seek-thumbnail";
import { useWaveformPeaks } from "@/components/media/use-waveform-peaks";
import { PopupContainerProvider } from "@/components/ui/popup-container";
import { Tooltip } from "@/components/ui/tooltip";
import { useDialog } from "@/hooks/use-dialog";
import { requestOpenLocalPath, requestRevealLocalPath } from "@/lib/local-file-open";
import { IDLE_HIDE_MS, chromeVisible } from "@/lib/media/media-chrome";
import { DEFAULT_FPS, estimateFpsFromDeltas, stepFrameTarget } from "@/lib/media/media-frame";
import {
  DOCK_MARGIN,
  MINI_H,
  MINI_W,
  clampGeometry,
  defaultGeometry,
  moveGeometry,
  resizeGeometry,
  type ResizeEdge,
  type Viewport,
} from "@/lib/media/media-geometry";
import { detectMediaKind } from "@/lib/media/media-kind";
import { cycleIndex, decideEndAction, nextLoopMode, segmentStopAt } from "@/lib/media/media-loop";
import {
  resumePositionFor,
  type DockGeometry,
  type MediaPrefs,
} from "@/lib/media/media-memory";
import { watchUserSeek, type ResumeNoticeWatch } from "@/lib/media/media-resume-notice";
import {
  ESC_CLOSE_WINDOW_MS,
  decideEscapeClose,
  resolveMediaShortcut,
  stepRate,
  type MediaCommand,
} from "@/lib/media/media-shortcuts";
import { clampNumber, formatBytes, formatClock, parseClock } from "@/lib/media/media-time";
import { notifyOverlayLayoutChanged } from "@/lib/overlay-layout-event";
import { localMediaSubtitleUrl, localMediaSubtitlesUrl, localMediaUrl } from "@/lib/media/media-url";
import {
  reportPlaying,
  closeMedia,
  selectMediaIndex,
  type PlayerSession,
} from "@/lib/media/player-store";
import { pathBasename, shortenHomePathDisplay } from "@/lib/path-utils";
import { cn } from "@/lib/utils";

const NO_TRACKS: Array<{ path: string; label: string }> = [];
const FPS_SAMPLE_MAX = 40;

interface LoadState {
  path: string;
  /** URL 上的版本戳；空串 = 首次加载（还没探到 ETag） */
  version: string;
  /** 本次加载对应的文件 ETag；null = 还没探到 */
  etag: string | null;
  /** 手动 / 自动重载递增，仅用来触发 effect */
  reloadNonce: number;
}

interface PendingStart {
  time: number | "resume";
  play: boolean;
}

/**
 * 页面上「开着的」模态弹窗（确认框 / 输入框 / 设置…）：Esc 归它们，播放器不抢。
 * base-ui 关闭时先打 data-closed / data-ending-style、动画完才摘 DOM，这段时间不算开着。
 * 只认 dialog / alert-dialog：播放窗自己的快捷键帮助虽然也是 role="dialog"，但它走 showHelp 自己的 Esc 逻辑。
 */
const OPEN_MODAL_DIALOG_SELECTOR = [
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
]
  .map((sel) => `${sel}:not([data-closed]):not([data-ending-style])`)
  .join(",");

const hasOpenModalDialog = (): boolean => document.querySelector(OPEN_MODAL_DIALOG_SELECTOR) !== null;

const isEditableTarget = (t: EventTarget | null): boolean => {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    // range / checkbox 等不吃字符键，不算「在打字」
    return !["range", "checkbox", "radio", "button"].includes(type);
  }
  return false;
};

const errorText = (kind: MediaErrorInfo["kind"]): string => {
  switch (kind) {
    case "unsupported":
      return "这个文件的格式或编码浏览器播不了（常见于 HEVC / mkv / 还没写完的文件）。";
    case "decode":
      return "解码失败：文件可能损坏，或者还在被写入。";
    case "network":
      return "读取中断了：文件可能正在被改写。";
    case "aborted":
      return "加载被中断了。";
    default:
      return "播放出错了。";
  }
};

const copyText = async (text: string, okMsg: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
  } catch {
    toast.error("复制失败");
  }
};

export const MediaPlayerDock = ({ session }: { session: PlayerSession }) => {
  const item = session.items[session.index]!;
  const path = item.path;
  const kind = detectMediaKind(path) ?? "video";
  const isVideo = kind === "video";
  const memory = useMemo(() => getMediaMemory(), []);
  const { prompt } = useDialog();

  const rootRef = useRef<HTMLDivElement>(null);
  // 全屏时浮层（菜单 / 提示）要挂进全屏元素才看得见，所以除了 ref 还要把根元素放进 state 里传给 Provider
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
  }, []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const state = useMediaElementState(videoRef);

  // ---------- 偏好 / 窗口 ----------
  const [prefs, setPrefsState] = useState<MediaPrefs>(() => memory.getPrefs());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const patchPrefs = useCallback(
    (patch: Partial<MediaPrefs>) => {
      const next = memory.setPrefs(patch);
      prefsRef.current = next;
      setPrefsState(next);
    },
    [memory],
  );

  const [mode, setMode] = useState<DockMode>("float");
  const [userGeo, setUserGeo] = useState<DockGeometry | null>(() => memory.getPrefs().dock);
  const [vp, setVp] = useState<Viewport>(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // 倍速 / 「更多」菜单是否展开：全屏控件不自动收起、Esc 归菜单都要用（键盘 effect 在下面，所以声明放这里）
  const [menuOpen, setMenuOpen] = useState(false);
  // 「再按一次 Esc 关闭」是否在提示中（只管界面；真正的时间窗口由 escArmedAtRef + decideEscapeClose 判）
  const [escArmed, setEscArmed] = useState(false);
  // 第一下 Esc 的时间（performance.now）；null = 没上膛
  const escArmedAtRef = useRef<number | null>(null);
  // 提示自动消失的计时器
  const escTimerRef = useRef<number | null>(null);
  // 最近一次退出全屏的时间（performance.now）：退出后的缓冲期内 Esc 不算，见 ESC_AFTER_FULLSCREEN_GRACE_MS
  const fullscreenExitedAtRef = useRef<number | null>(null);

  // 清掉 Esc 上膛状态与提示（其它键 / Esc 归别人 / 超时 / 真关闭时都走这里）
  const disarmEsc = useCallback(() => {
    escArmedAtRef.current = null;
    if (escTimerRef.current !== null) {
      window.clearTimeout(escTimerRef.current);
      escTimerRef.current = null;
    }
    setEscArmed(false);
  }, []);
  // 卸载时清计时器（不 setState，避免卸载后更新）
  useEffect(
    () => () => {
      if (escTimerRef.current !== null) window.clearTimeout(escTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const onResize = () => setVp({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onFs = () => {
      const fs = document.fullscreenElement === rootRef.current;
      // 非全屏的变化（含退出）都记一笔：只会让「退出后短暂不认 Esc」宁多勿少
      if (!fs) fullscreenExitedAtRef.current = performance.now();
      setIsFullscreen(fs);
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const aspect = isVideo && state.videoWidth > 0 && state.videoHeight > 0 ? state.videoWidth / state.videoHeight : null;
  const autoGeo = useMemo(() => defaultGeometry(kind, aspect, vp), [kind, aspect, vp]);
  const floatGeo = userGeo ? clampGeometry(userGeo, vp) : autoGeo;
  const rect: DockGeometry =
    mode === "mini"
      ? { x: vp.width - MINI_W - DOCK_MARGIN, y: vp.height - MINI_H - DOCK_MARGIN, w: MINI_W, h: MINI_H }
      : floatGeo;

  // 内置浏览器是原生视图、永远压在 HTML 之上：播放器与浏览器视口相交时得让浏览器换成截图占位（use-overlay-cover）。
  // 播放器不在 body 直下、位置靠 style 变，MutationObserver 看不到，这里在「出现 / 挪位 / 改尺寸 / 全屏切换」时主动通知
  useLayoutEffect(() => {
    notifyOverlayLayoutChanged();
  }, [rect.x, rect.y, rect.w, rect.h, isFullscreen]);
  // 关闭播放器：DOM 摘掉后再评估一次，浏览器才能从截图占位恢复成真页面（通知本身是 50ms 去抖、评估时 DOM 已移除）
  useEffect(
    () => () => {
      notifyOverlayLayoutChanged();
    },
    [],
  );

  // 拖动 / 缩放
  const dragRef = useRef<{
    kind: "move" | "resize";
    edge?: ResizeEdge;
    startX: number;
    startY: number;
    start: DockGeometry;
    latest: DockGeometry;
  } | null>(null);

  const beginDrag = (
    dragKind: "move" | "resize",
    e: ReactPointerEvent<HTMLElement>,
    edge?: ResizeEdge,
  ) => {
    if (e.button !== 0 || isFullscreen) return;
    if (mode === "mini") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind: dragKind,
      edge,
      startX: e.clientX,
      startY: e.clientY,
      start: floatGeo,
      latest: floatGeo,
    };
  };
  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const next =
      d.kind === "move"
        ? moveGeometry(d.start, dx, dy, vp)
        : resizeGeometry(d.start, d.edge ?? "corner", dx, dy, vp);
    d.latest = next;
    setUserGeo(next);
  };
  const onDragEnd = () => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    // 指针捕获在 pointerup 时由浏览器自动释放
    patchPrefs({ dock: d.latest });
  };

  // ---------- 文件加载状态 ----------
  const [load, setLoad] = useState<LoadState>({ path, version: "", etag: null, reloadNonce: 0 });
  if (load.path !== path) setLoad({ path, version: "", etag: null, reloadNonce: 0 });
  const src = localMediaUrl(path, load.path === path ? load.version : "");

  const { info, refresh } = useMediaFileInfo(path, true);
  useEffect(() => {
    if (info?.ok && load.etag === null) setLoad((l) => (l.path === path && l.etag === null ? { ...l, etag: info.etag } : l));
  }, [info, load.etag, path]);
  const fileChanged = !!info?.ok && load.etag !== null && info.etag !== load.etag;
  const infoFailure = info && !info.ok ? describeMediaInfoFailure(info.status) : null;

  const pendingRef = useRef<PendingStart | null>(null);
  const carryRef = useRef<{ time: number; play: boolean } | null>(null);
  const lastPathRef = useRef<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  // 「已从上次位置继续」提示的 seek 监听器：续播自己的那一跳要在它这儿登记，别把刚出现的提示收掉
  const resumeWatchRef = useRef<ResumeNoticeWatch | null>(null);
  // `path#t=起,止` 带终点的引用：播到终点就停。用户自己拖进度 / 键盘跳转 = 接管，取消这个终点
  const [segEnd, setSegEnd] = useState<number | null>(null);

  // 新请求（点了卡片 / 路径 / 切对比组）：决定从哪里开始播。
  // 用 layout effect：待办起点必须赶在 loadedmetadata 之前就位（passive effect 可能晚于一次很快的元数据事件）
  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const it = session.items[session.index]!;
    const isNewPath = lastPathRef.current !== it.path;
    lastPathRef.current = it.path;
    const carry = carryRef.current;
    carryRef.current = null;
    if (isNewPath) {
      if (carry) {
        pendingRef.current = { time: carry.time, play: carry.play };
        setSegEnd(null);
      } else {
        pendingRef.current = { time: it.start !== undefined ? it.start : "resume", play: true };
        setSegEnd(it.start !== undefined && it.end !== undefined && it.end > it.start ? it.end : null);
      }
      setResumedFrom(null);
    } else {
      if (it.start !== undefined) {
        v.currentTime = it.start;
        setSegEnd(it.end !== undefined && it.end > it.start ? it.end : null);
        void v.play().catch(() => {});
      } else {
        setSegEnd(null);
        if (v.paused) void v.play().catch(() => {});
      }
    }
    // 只在新请求时触发；items / index 变化一定伴随 reqNonce 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.reqNonce]);

  // 「已从上次位置继续」的提示：用户自己动了进度（拖进度条 / 键盘跳转 / 跳转到… / 媒体键）后它就不再描述现状，收掉。
  // 用 layout effect 且排在下面「元数据到了」那个 effect 之前：监听必须赶在 loadedmetadata 触发续播那一跳之前就位
  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const watch = watchUserSeek(v, () => setResumedFrom(null));
    resumeWatchRef.current = watch;
    return () => {
      watch.stop();
      resumeWatchRef.current = null;
    };
  }, []);

  // 元数据到了：套用待办的起点（续播 / 指定时间 / 对比组切换保持进度）、播放
  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      const p = pendingRef.current;
      pendingRef.current = null;
      const prefsNow = prefsRef.current;
      v.defaultPlaybackRate = prefsNow.rate;
      v.playbackRate = prefsNow.rate;
      if (!p) return;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      let t = 0;
      if (p.time === "resume") {
        t = resumePositionFor(memory.getFile(pathRef.current), dur);
        if (t > 0) setResumedFrom(t);
      } else {
        t = clampNumber(p.time, 0, dur > 0 ? Math.max(0, dur - 0.05) : p.time);
      }
      if (t > 0) {
        // 续播这一跳不是用户动的进度：先登记，紧随其后的 seeked 不收提示
        if (p.time === "resume") resumeWatchRef.current?.expectResumeJump(t);
        v.currentTime = t;
      }
      if (p.play) void v.play().catch(() => {});
    };
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [memory]);

  // 倍速 / 音量 / 静音落到元素
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.defaultPlaybackRate = prefs.rate;
    v.playbackRate = prefs.rate;
    v.volume = prefs.volume;
    v.muted = prefs.muted;
  }, [prefs.rate, prefs.volume, prefs.muted, src]);

  // ---------- 字幕 sidecar ----------
  const [captionSlot, setCaptionSlot] = useState<{ path: string; tracks: Array<{ path: string; label: string }> }>({
    path: "",
    tracks: [],
  });
  const [trackIndex, setTrackIndex] = useState(0);
  useEffect(() => {
    if (!isVideo) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(localMediaSubtitlesUrl(path), { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { items?: Array<{ path: string; label: string }> };
        if (!cancelled) {
          setCaptionSlot({ path, tracks: json.items ?? [] });
          setTrackIndex(0);
        }
      } catch {
        // 没字幕就算了
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, isVideo, load.reloadNonce]);
  const tracks = captionSlot.path === path ? captionSlot.tracks : NO_TRACKS;
  const captionsOn = prefs.captions && tracks.length > 0;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        const t = v.textTracks[i]!;
        t.mode = captionsOn && i === trackIndex ? "showing" : "hidden";
      }
    };
    apply();
    v.textTracks.addEventListener("addtrack", apply);
    return () => v.textTracks.removeEventListener("addtrack", apply);
  }, [tracks, captionsOn, trackIndex]);

  // ---------- 帧率估算（rVFC 采样相邻帧的媒体时间差） ----------
  const [fps, setFps] = useState<{ value: number; estimated: boolean }>({ value: DEFAULT_FPS, estimated: false });
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isVideo || typeof v.requestVideoFrameCallback !== "function") return;
    const deltas: number[] = [];
    let last: number | null = null;
    let handle = 0;
    let stopped = false;
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      if (stopped) return;
      if (last !== null) {
        const d = Math.abs(meta.mediaTime - last);
        if (d > 0) deltas.push(d);
      }
      last = meta.mediaTime;
      if (deltas.length >= 8 && deltas.length <= FPS_SAMPLE_MAX) {
        const est = estimateFpsFromDeltas(deltas);
        if (est !== null) setFps((f) => (f.value === est && f.estimated ? f : { value: est, estimated: true }));
      }
      if (deltas.length < FPS_SAMPLE_MAX) handle = v.requestVideoFrameCallback(onFrame);
    };
    const reset = () => {
      deltas.length = 0;
      last = null;
      setFps({ value: DEFAULT_FPS, estimated: false });
      if (handle) v.cancelVideoFrameCallback(handle);
      handle = v.requestVideoFrameCallback(onFrame);
    };
    v.addEventListener("loadstart", reset);
    handle = v.requestVideoFrameCallback(onFrame);
    return () => {
      stopped = true;
      v.removeEventListener("loadstart", reset);
      if (handle) v.cancelVideoFrameCallback(handle);
    };
  }, [isVideo]);

  // ---------- 片段到点停（rAF 精确到帧级，不靠 4Hz 的 timeupdate；没有片段时不跑） ----------
  useEffect(() => {
    if (state.paused || segEnd === null) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const stopAt = v ? segmentStopAt(segEnd, v.currentTime) : null;
      if (v && stopAt !== null) {
        v.pause();
        v.currentTime = stopAt;
        setSegEnd(null);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.paused, segEnd]);

  // ---------- 位置记忆 ----------
  const liveRef = useRef({ path, time: 0, duration: 0, ready: false });
  useEffect(() => {
    liveRef.current = { path, time: state.time, duration: state.duration, ready: state.ready };
  });
  const savePositionNow = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 1) return;
    memory.savePosition(pathRef.current, v.currentTime, Number.isFinite(v.duration) ? v.duration : 0);
  }, [memory]);
  useEffect(() => {
    if (state.paused) return;
    const id = window.setInterval(savePositionNow, 2000);
    return () => window.clearInterval(id);
  }, [state.paused, savePositionNow]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.addEventListener("pause", savePositionNow);
    window.addEventListener("beforeunload", savePositionNow);
    return () => {
      v.removeEventListener("pause", savePositionNow);
      window.removeEventListener("beforeunload", savePositionNow);
    };
  }, [savePositionNow]);
  // 换文件 / 关窗：用最后一次已知位置存一次（此时元素可能已经在加载新 src）
  useEffect(
    () => () => {
      const l = liveRef.current;
      if (l.ready && l.path) memory.savePosition(l.path, l.time, l.duration);
    },
    [path, memory],
  );

  // 对外报告「正在播放」（媒体卡片 / 路径 chip 高亮用）；卸载时清掉并收拾画中画 / 全屏
  const playing = !state.paused && !state.ended;
  useEffect(() => {
    reportPlaying(playing ? path : null);
  }, [playing, path]);
  useEffect(() => {
    const v = videoRef.current;
    const root = rootRef.current;
    return () => {
      reportPlaying(null);
      if (v && document.pictureInPictureElement === v) void document.exitPictureInPicture().catch(() => {});
      if (root && document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  // ---------- 文件重新生成：自动 / 手动重载 ----------
  const reload = useCallback(async () => {
    const v = videoRef.current;
    const latest = await refresh();
    if (!latest?.ok) {
      toast.error(describeMediaInfoFailure(latest?.status ?? 0));
      return;
    }
    pendingRef.current = { time: v ? v.currentTime : 0, play: v ? !v.paused : false };
    setLoad((l) => ({
      path: pathRef.current,
      version: versionFromEtag(latest.etag),
      etag: latest.etag,
      reloadNonce: l.reloadNonce + 1,
    }));
  }, [refresh]);

  // 重试 / 重载：src 没变（比如出错后原样再试）时浏览器不会自己重新加载，显式 load() 一次
  useEffect(() => {
    if (load.reloadNonce > 0) videoRef.current?.load();
  }, [load.reloadNonce]);

  // 播放失败后文件又变了（多半是写完了）：自动重试一次，不用用户点
  const autoRetriedEtagRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.error && fileChanged && info && autoRetriedEtagRef.current !== info.etag) {
      autoRetriedEtagRef.current = info.etag;
      void reload();
    }
  }, [state.error, fileChanged, info, reload]);

  // ---------- 命令执行 ----------
  const live = useRef({ state, prefs, tracks, trackIndex, session });
  live.current = { state, prefs, tracks, trackIndex, session };

  const setRate = useCallback((rate: number) => patchPrefs({ rate }), [patchPrefs]);
  const setVolume = useCallback(
    (volume: number) => patchPrefs({ volume: clampNumber(volume, 0, 1), muted: false }),
    [patchPrefs],
  );

  const exec = useCallback(
    (cmd: MediaCommand) => {
      const v = videoRef.current;
      if (!v) return;
      const cur = live.current;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const seek = (t: number) => {
        setSegEnd(null);
        v.currentTime = clampNumber(t, 0, dur > 0 ? dur : Math.max(0, t));
      };
      switch (cmd.type) {
        case "toggle": {
          if (v.paused || v.ended) {
            if (v.ended) v.currentTime = 0;
            void v.play().catch(() => {});
          } else {
            v.pause();
          }
          break;
        }
        case "seekBy":
          seek(v.currentTime + cmd.seconds);
          break;
        case "seekStart":
          seek(0);
          break;
        case "seekEnd":
          seek(Math.max(0, dur - 0.1));
          break;
        case "seekPercent":
          if (dur > 0) seek((dur * cmd.percent) / 100);
          break;
        case "frame":
          setSegEnd(null);
          v.pause();
          v.currentTime = stepFrameTarget(v.currentTime, fpsRef.current.value, cmd.dir, dur);
          break;
        case "rateStep":
          setRate(stepRate(cur.prefs.rate, cmd.dir));
          break;
        case "rateReset":
          setRate(1);
          break;
        case "volumeBy":
          setVolume((cur.prefs.muted ? 0 : cur.prefs.volume) + cmd.delta);
          break;
        case "mute":
          patchPrefs({ muted: !cur.prefs.muted });
          break;
        case "loop":
          patchPrefs({ loop: nextLoopMode(cur.prefs.loop) });
          break;
        case "captions":
          patchPrefs({ captions: !cur.prefs.captions });
          break;
        case "pip": {
          void (async () => {
            try {
              if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
              else await v.requestPictureInPicture();
            } catch {
              toast.error("这个环境不支持画中画");
            }
          })();
          break;
        }
        case "fullscreen": {
          const root = rootRef.current;
          if (!root) break;
          if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
          else void root.requestFullscreen().catch(() => toast.error("无法进入全屏"));
          break;
        }
        case "item": {
          carryRef.current = { time: v.currentTime, play: !v.paused };
          selectMediaIndex(cmd.index);
          break;
        }
        case "prev":
        case "next": {
          const n = cur.session.items.length;
          if (n < 2) break;
          const idx = cycleIndex(cur.session.index, n, cmd.type === "next" ? 1 : -1);
          carryRef.current = { time: v.currentTime, play: !v.paused };
          selectMediaIndex(idx);
          break;
        }
        case "help":
          setShowHelp((s) => !s);
          break;
        case "gotoTime": {
          void (async () => {
            // 对话框挂在 <body> 上，全屏时会被盖在全屏元素下面看不见：先退出全屏再弹
            if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
            const input = await prompt({
              title: "跳转到",
              description: "输入秒数或时间，例如 90、1:30、1m30s",
              placeholder: "1:30",
              confirmLabel: "跳转",
              validate: (val) => (val.trim() && parseClock(val) === null ? "格式不对，例如 90 / 1:30 / 1m30s" : ""),
            });
            if (input === null || !input.trim()) return;
            const t = parseClock(input);
            if (t !== null) seek(t);
          })();
          break;
        }
      }
    },
    [patchPrefs, prompt, setRate, setVolume],
  );

  // 播放结束：单个循环 / 整组循环
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnded = () => {
      const { prefs: p, session: s } = live.current;
      const action = decideEndAction(p.loop, s.index, s.items.length);
      if (action.type === "restart") {
        v.currentTime = action.to;
        void v.play().catch(() => {});
      } else if (action.type === "next-item") {
        // 整组循环：下一个从头播（不续播上次的位置）
        carryRef.current = { time: 0, play: true };
        selectMediaIndex(action.index);
      }
    };
    v.addEventListener("ended", onEnded);
    return () => v.removeEventListener("ended", onEnded);
  }, []);

  // ---------- 键盘 ----------
  const hoverRef = useRef(false);
  const groupSize = session.items.length;
  useEffect(() => {
    const active = () => {
      const root = rootRef.current;
      if (!root) return false;
      return hoverRef.current || root.contains(document.activeElement);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!active() || isEditableTarget(e.target)) return;
      if (e.key === "Escape") {
        // Esc 先关帮助（全屏的 Esc 由浏览器自己处理）
        if (showHelp) {
          setShowHelp(false);
          disarmEsc();
          e.preventDefault();
          return;
        }
        // 连按两次 Esc 关闭播放器：第一下上膛 + 提示，窗口内第二下才关；不吞事件，Esc 照样传给侧栏 / 菜单
        const decision = decideEscapeClose(e, {
          now: performance.now(),
          armedAt: escArmedAtRef.current,
          fullscreen: isFullscreen,
          fullscreenExitedAt: fullscreenExitedAtRef.current,
          menuOpen,
          modalOpen: hasOpenModalDialog(),
        });
        if (decision === "reset") disarmEsc();
        else if (decision === "close") {
          disarmEsc();
          closeMedia();
        } else if (decision === "arm") {
          escArmedAtRef.current = performance.now();
          setEscArmed(true);
          if (escTimerRef.current !== null) window.clearTimeout(escTimerRef.current);
          escTimerRef.current = window.setTimeout(disarmEsc, ESC_CLOSE_WINDOW_MS);
        }
        return;
      }
      // 上膛后按了别的键 = 不是要关，取消「再按一次」
      disarmEsc();
      const cmd = resolveMediaShortcut(e, { groupSize, kind });
      if (!cmd) return;
      if (e.repeat && cmd.type === "toggle") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      exec(cmd);
    };
    // 空格键落在按钮上时，浏览器会在 keyup 再触发一次点击：我们已经在 keydown 处理了，这里吞掉
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && active() && !isEditableTarget(e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [exec, groupSize, kind, showHelp, isFullscreen, menuOpen, disarmEsc]);

  // ---------- 系统媒体键 ----------
  useMediaSession({
    title: pathBasename(path),
    playing,
    duration: state.duration,
    position: state.time,
    rate: prefs.rate,
    onPlay: () => {
      const v = videoRef.current;
      if (v?.paused) exec({ type: "toggle" });
    },
    onPause: () => {
      const v = videoRef.current;
      if (v && !v.paused) exec({ type: "toggle" });
    },
    onSeekBy: (s) => exec({ type: "seekBy", seconds: s }),
    onSeekTo: (t) => {
      const v = videoRef.current;
      if (v) {
        setSegEnd(null);
        v.currentTime = t;
      }
    },
    onPrev: groupSize > 1 ? () => exec({ type: "prev" }) : undefined,
    onNext: groupSize > 1 ? () => exec({ type: "next" }) : undefined,
  });

  // ---------- 进度条 / 波形 ----------
  const { thumb, request: requestThumb } = useSeekThumbnail(isVideo ? src : null, mode !== "mini");
  const version = info?.ok ? versionFromEtag(info.etag) : null;
  const wave = useWaveformPeaks(isVideo ? null : path, version, info?.size ?? 0, state.duration);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    setSegEnd(null);
    v.currentTime = clampNumber(t, 0, Number.isFinite(v.duration) ? v.duration : t);
  }, []);

  const timelineProps = {
    time: state.time,
    duration: state.duration,
    onSeek: seekTo,
    disabled: !state.ready || !!state.error,
  };

  const moreActions: MoreAction[] = [
    ...tracks.map(
      (t, i) =>
        ({
          key: `track-${t.path}`,
          label: `字幕：${t.label}${captionsOn && i === trackIndex ? "  ✓" : ""}`,
          icon: MORE_ICONS.captions,
          onClick: () => {
            setTrackIndex(i);
            patchPrefs({ captions: true });
          },
        }) satisfies MoreAction,
    ),
    { key: "reload", label: "重新加载（保留位置）", icon: MORE_ICONS.reload, onClick: () => void reload() },
    {
      key: "reveal",
      label: "在文件夹中显示",
      icon: MORE_ICONS.reveal,
      onClick: () =>
        void requestRevealLocalPath(path).catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : "在文件夹中显示失败"),
        ),
    },
    {
      key: "external",
      label: "用系统播放器打开",
      icon: MORE_ICONS.external,
      onClick: () =>
        void requestOpenLocalPath(path).catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : "打开失败"),
        ),
    },
    { key: "copy-path", label: "复制路径", icon: MORE_ICONS.copy, onClick: () => void copyText(path, "已复制路径") },
  ];

  const title = pathBasename(path);
  const KindIcon = isVideo ? Film : AudioLines;
  const showSpinner = !state.error && !infoFailure && (!state.ready || state.waiting);
  const errorMessage = state.error ? (infoFailure ?? errorText(state.error.kind)) : infoFailure;

  // 全屏：鼠标几秒不动就收起顶栏 / 控制区 / 鼠标指针；暂停、开着菜单 / 帮助 / 有报错时不收
  const { idle, onPointerMove: onIdleMove } = useIdleHide(isFullscreen, IDLE_HIDE_MS);
  const chromeShown = chromeVisible({
    fullscreen: isFullscreen,
    paused: !playing,
    idle,
    pinned: menuOpen || showHelp || !!errorMessage,
  });
  const chromeHidden = isFullscreen && !chromeShown;
  // 全屏时顶栏 / 控制区绝对定位叠在画面上（画面铺满，没有白边）；窗口模式用 contents 让子元素照旧参与纵向排布
  const overlay = (edge: "top" | "bottom"): string =>
    cn(
      isFullscreen
        ? cn(
            "dark absolute inset-x-0 z-20 flex flex-col text-foreground transition-opacity duration-200 motion-reduce:transition-none",
            edge === "top" ? "top-0" : "bottom-0",
          )
        : "contents",
      chromeHidden && "pointer-events-none opacity-0",
    );

  return (
    <PopupContainerProvider value={isFullscreen ? (rootEl ?? undefined) : undefined}>
      <div
        ref={attachRoot}
        role="region"
        aria-label={`播放器：${title}`}
        tabIndex={-1}
        data-media-dock=""
        onPointerEnter={() => {
          hoverRef.current = true;
        }}
        onPointerLeave={() => {
          hoverRef.current = false;
        }}
        // 拖动 / 缩放时指针被捕获在顶栏或把手上，事件冒泡到这里统一处理；全屏下同一个事件顺便喂给「静止计时」
        onPointerMove={(e) => {
          onDragMove(e);
          onIdleMove(e);
        }}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className={cn(
          "fixed z-40 flex flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl outline-none",
          "ring-1 ring-foreground/5",
          isFullscreen && "rounded-none border-0 bg-black shadow-none ring-0",
          chromeHidden && "cursor-none",
        )}
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        <div className={overlay("top")}>
          {isFullscreen && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[calc(100%+2rem)] bg-linear-to-b from-black/80 via-black/45 to-transparent"
            />
          )}
          {/* 顶栏：拖动把手 + 标题 + 窗口按钮（收起成条时兼做迷你控制条） */}
          <div
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              beginDrag("move", e);
            }}
            className={cn(
              "flex shrink-0 items-center gap-1.5 px-2",
              mode === "mini"
                ? "h-full"
                : cn("h-9", isFullscreen ? "bg-transparent" : "border-b border-border/70 bg-muted/30"),
              mode === "float" && !isFullscreen ? "cursor-grab active:cursor-grabbing" : "",
            )}
          >
            {mode === "mini" ? (
              <button
                type="button"
                aria-label={playing ? "暂停" : "播放"}
                onClick={() => exec({ type: "toggle" })}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-px" />}
              </button>
            ) : (
              <KindIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <Tooltip content={path}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium leading-tight">{title}</div>
                {/* 第二行平时是大小 / 路径（收成一条时是时间）；按过第一下 Esc 时临时换成提示（不新增行、窗口不抖，收成一条时也看得见） */}
                <div
                  aria-live="polite"
                  className={cn(
                    "truncate text-[11px] leading-tight",
                    escArmed ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {escArmed
                    ? "再按一次 Esc 关闭播放器"
                    : mode === "mini"
                      ? `${formatClock(state.time)} / ${formatClock(state.duration)}`
                      : [
                          formatBytes(info?.size ?? 0),
                          shortenHomePathDisplay(path.slice(0, Math.max(0, path.length - title.length - 1))),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                </div>
              </div>
            </Tooltip>
            {!isFullscreen && (
              <Tooltip content={mode === "mini" ? "展开" : "收成一条（继续播放）"}>
                <button
                  type="button"
                  aria-label={mode === "mini" ? "展开播放器" : "收成一条"}
                  onClick={() => setMode(mode === "mini" ? "float" : "mini")}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {mode === "mini" ? <Maximize2 className="size-3.5" /> : <Minus className="size-3.5" />}
                </button>
              </Tooltip>
            )}
            <Tooltip content="关闭（连按两次 Esc）">
              <button
                type="button"
                aria-label="关闭播放器"
                onClick={() => closeMedia()}
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  // 上膛中：关闭按钮跟着亮起来，和旁边的提示文字呼应
                  escArmed && "bg-muted text-foreground",
                )}
              >
                <X className="size-4" />
              </button>
            </Tooltip>
          </div>

          {mode !== "mini" && groupSize > 1 && (
            <GroupTabs
              items={session.items}
              index={session.index}
              playingPath={playing ? path : null}
              onSelect={(i) => exec({ type: "item", index: i })}
            />
          )}

          {mode !== "mini" && fileChanged && !state.error && (
            <DockBanner
              tone="warning"
              actions={<BannerButton onClick={() => void reload()}>重新加载</BannerButton>}
            >
              文件已更新（可能刚被重新生成）。重新加载会保留当前位置。
            </DockBanner>
          )}
          {mode !== "mini" && errorMessage && (
            <DockBanner
              tone="error"
              actions={
                <>
                  <BannerButton onClick={() => void reload()}>重试</BannerButton>
                  <BannerButton
                    onClick={() =>
                      void requestOpenLocalPath(path).catch((e: unknown) =>
                        toast.error(e instanceof Error ? e.message : "打开失败"),
                      )
                    }
                  >
                    系统播放器打开
                  </BannerButton>
                  <BannerButton
                    onClick={() =>
                      void requestRevealLocalPath(path).catch((e: unknown) =>
                        toast.error(e instanceof Error ? e.message : "在文件夹中显示失败"),
                      )
                    }
                  >
                    在文件夹显示
                  </BannerButton>
                </>
              }
            >
              {errorMessage}
            </DockBanner>
          )}
          {mode !== "mini" && resumedFrom !== null && !errorMessage && (
            <DockBanner
              tone="info"
              onDismiss={() => setResumedFrom(null)}
              actions={
                <BannerButton
                  onClick={() => {
                    seekTo(0);
                    setResumedFrom(null);
                  }}
                >
                  从头播放
                </BannerButton>
              }
            >
              已从上次的 {formatClock(resumedFrom)} 继续。
            </DockBanner>
          )}
        </div>

        {/* 画面区：<video> 常驻（音频不显示画面、收成一条时隐藏），换文件只换 src；全屏时铺满整个屏幕，顶栏 / 控制区叠在上面 */}
        <div
          className={cn(
            "overflow-hidden",
            isFullscreen ? "absolute inset-0" : "relative min-h-0 flex-1",
            mode === "mini" && "hidden",
            isVideo ? "bg-black" : "bg-muted/30",
          )}
        >
          <video
            ref={videoRef}
            src={src}
            preload="metadata"
            playsInline
            className={cn(isVideo ? "size-full object-contain" : "hidden")}
            onClick={() => exec({ type: "toggle" })}
            onDoubleClick={() => isVideo && exec({ type: "fullscreen" })}
          >
            {isVideo &&
              tracks.map((t) => (
                <track
                  key={t.path}
                  kind="subtitles"
                  label={t.label}
                  src={localMediaSubtitleUrl(t.path)}
                />
              ))}
          </video>
          {!isVideo && (
            <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center">
              <AudioLines className={cn("size-10 text-primary opacity-70", playing && "animate-pulse motion-reduce:animate-none")} />
              <div className="line-clamp-2 text-sm font-medium wrap-anywhere">{title}</div>
              {groupSize > 1 && (
                <div className="text-xs text-muted-foreground tabular-nums">
                  {session.index + 1} / {groupSize}（数字键 1–{Math.min(9, groupSize)} 切换对比）
                </div>
              )}
            </div>
          )}
          {isVideo && state.paused && state.ready && !state.pip && !state.error && (
            <button
              type="button"
              aria-label="播放"
              onClick={() => exec({ type: "toggle" })}
              className="absolute top-1/2 left-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white outline-none backdrop-blur-sm transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Play className="size-6 translate-x-0.5" />
            </button>
          )}
          {showSpinner && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Loader2 className={cn("size-6 animate-spin", isVideo ? "text-white/80" : "text-muted-foreground")} />
            </div>
          )}
          {isVideo && state.pip && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black text-xs text-white/80">
              画中画播放中
              <BannerButton onClick={() => exec({ type: "pip" })}>回到这里</BannerButton>
            </div>
          )}
        </div>

        <div className={overlay("bottom")}>
          {isFullscreen && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[calc(100%+3rem)] bg-linear-to-t from-black/85 via-black/55 to-transparent"
            />
          )}
          {mode !== "mini" && (
            <MediaTimelineRow
              time={state.time}
              duration={state.duration}
              isVideo={isVideo}
              fps={fps}
              onGotoTime={() => exec({ type: "gotoTime" })}
            >
              {isVideo || wave.status === "skipped" || wave.status === "error" ? (
                <MediaSeekBar
                  {...timelineProps}
                  thumbnail={thumb}
                  onHoverTime={(t) => {
                    if (t !== null) requestThumb(t);
                  }}
                />
              ) : (
                <MediaWaveform
                  {...timelineProps}
                  peaks={wave.status === "ready" ? wave.peaks : null}
                />
              )}
            </MediaTimelineRow>
          )}

          {mode !== "mini" && (
            // @container：按控制区自身的宽度（不是屏幕宽度）决定音量滑块等是否出现，见 media-transport
            <div className="@container shrink-0 px-2 pt-0.5 pb-2">
              <MediaTransport
                kind={kind}
                state={state}
                rate={prefs.rate}
                volume={prefs.volume}
                muted={prefs.muted}
                loop={prefs.loop}
                groupSize={groupSize}
                hasCaptionTracks={tracks.length > 0}
                captionsOn={captionsOn}
                pipSupported={typeof document !== "undefined" && document.pictureInPictureEnabled === true}
                isFullscreen={isFullscreen}
                onCommand={exec}
                onSetRate={setRate}
                onSetVolume={setVolume}
                moreActions={moreActions}
                onMenuOpenChange={setMenuOpen}
              />
            </div>
          )}
        </div>

        {mode === "float" && !isFullscreen && <ResizeHandles onStart={(edge, e) => beginDrag("resize", e, edge)} />}
        {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
      </div>
    </PopupContainerProvider>
  );
};
