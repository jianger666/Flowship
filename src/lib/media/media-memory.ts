/**
 * 播放器的「记忆」：每个文件的播放位置，以及全局偏好（倍速 / 音量 / 循环 / 窗口位置…）。
 *
 * 存 localStorage 的一个 key 里（JSON）。纯逻辑 + 注入 Storage，单测不用 DOM。
 * - 按文件绝对路径记；文件被覆盖重渲后路径不变，位置还在
 * - 文件数有上限（LRU）：淘汰最久未用的
 * - 读到坏数据（手改 / 旧版本，含早期版本留下的 markers 字段）逐字段清洗，宁可丢也不让播放器因此崩
 */

import { clampNumber } from "@/lib/media/media-time";

export const MEDIA_MEMORY_KEY = "flowship.media-memory.v1";

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface MediaFileMemory {
  position: number;
  duration: number;
  touched: number;
}

export type LoopMode = "off" | "one" | "all";

export interface DockGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MediaPrefs {
  rate: number;
  volume: number;
  muted: boolean;
  loop: LoopMode;
  /** 字幕默认开不开 */
  captions: boolean;
  /** 悬浮窗位置大小；null = 用默认（按视频比例算） */
  dock: DockGeometry | null;
}

export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;

export const DEFAULT_PREFS: MediaPrefs = {
  rate: 1,
  volume: 1,
  muted: false,
  loop: "off",
  captions: true,
  dock: null,
};

export const MAX_MEDIA_FILES = 200;
/** 距开头 / 结尾不到这么多秒就不续播（已经看完 / 刚开始，从头播更合理） */
export const RESUME_EDGE_SECONDS = 3;

interface MemoryState {
  files: Record<string, MediaFileMemory>;
  prefs: MediaPrefs;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const sanitizeDock = (raw: unknown): DockGeometry | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) return null;
  if (r.w < 100 || r.h < 60) return null;
  return { x: r.x, y: r.y, w: r.w, h: r.h };
};

const sanitizePrefs = (raw: unknown): MediaPrefs => {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    rate: finite(r.rate) ? clampNumber(r.rate, 0.25, 4) : DEFAULT_PREFS.rate,
    volume: finite(r.volume) ? clampNumber(r.volume, 0, 1) : DEFAULT_PREFS.volume,
    muted: typeof r.muted === "boolean" ? r.muted : DEFAULT_PREFS.muted,
    loop: r.loop === "one" || r.loop === "all" || r.loop === "off" ? r.loop : DEFAULT_PREFS.loop,
    captions: typeof r.captions === "boolean" ? r.captions : DEFAULT_PREFS.captions,
    dock: sanitizeDock(r.dock),
  };
};

const sanitizeFile = (raw: unknown): MediaFileMemory | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    position: finite(r.position) && r.position >= 0 ? r.position : 0,
    duration: finite(r.duration) && r.duration >= 0 ? r.duration : 0,
    touched: finite(r.touched) ? r.touched : 0,
  };
};

const parseState = (text: string | null): MemoryState => {
  const empty: MemoryState = { files: {}, prefs: { ...DEFAULT_PREFS } };
  if (!text) return empty;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object") return empty;
    const r = raw as Record<string, unknown>;
    const files: Record<string, MediaFileMemory> = {};
    if (r.files && typeof r.files === "object") {
      for (const [path, v] of Object.entries(r.files as Record<string, unknown>)) {
        const f = sanitizeFile(v);
        if (f) files[path] = f;
      }
    }
    return { files, prefs: sanitizePrefs(r.prefs) };
  } catch {
    return empty;
  }
};

/** 续播位置：太靠近开头 / 结尾、或者时长未知却记着很大的位置 → 0（从头播） */
export const resumePositionFor = (
  mem: Pick<MediaFileMemory, "position"> | null,
  duration: number,
): number => {
  if (!mem || !finite(mem.position)) return 0;
  if (mem.position <= RESUME_EDGE_SECONDS) return 0;
  if (finite(duration) && duration > 0 && mem.position >= duration - RESUME_EDGE_SECONDS) return 0;
  return mem.position;
};

export interface MediaMemory {
  getFile: (path: string) => MediaFileMemory | null;
  savePosition: (path: string, position: number, duration: number) => void;
  getPrefs: () => MediaPrefs;
  setPrefs: (patch: Partial<MediaPrefs>) => MediaPrefs;
}

export const createMediaMemory = (
  storage: StorageLike | null,
  opts: { now?: () => number; maxFiles?: number } = {},
): MediaMemory => {
  const now = opts.now ?? (() => Date.now());
  const maxFiles = opts.maxFiles ?? MAX_MEDIA_FILES;
  let state: MemoryState | null = null;

  const load = (): MemoryState => {
    if (state) return state;
    let text: string | null = null;
    try {
      text = storage ? storage.getItem(MEDIA_MEMORY_KEY) : null;
    } catch {
      text = null;
    }
    state = parseState(text);
    return state;
  };

  const evict = (s: MemoryState) => {
    const paths = Object.keys(s.files);
    if (paths.length <= maxFiles) return;
    // 最久没碰的先淘汰
    const order = paths.sort((a, b) => s.files[a]!.touched - s.files[b]!.touched);
    for (const p of order.slice(0, paths.length - maxFiles)) delete s.files[p];
  };

  const persist = (s: MemoryState) => {
    if (!storage) return;
    try {
      storage.setItem(MEDIA_MEMORY_KEY, JSON.stringify(s));
    } catch {
      // 配额满 / 隐私模式：记忆是锦上添花，写不进去就算了
    }
  };

  const ensureFile = (s: MemoryState, path: string): MediaFileMemory => {
    const cur = s.files[path];
    if (cur) return cur;
    const fresh: MediaFileMemory = { position: 0, duration: 0, touched: now() };
    s.files[path] = fresh;
    return fresh;
  };

  const commit = (s: MemoryState) => {
    evict(s);
    persist(s);
  };

  return {
    getFile: (path) => {
      const f = load().files[path];
      return f ? { ...f } : null;
    },
    savePosition: (path, position, duration) => {
      if (!path || !finite(position) || position < 0) return;
      const s = load();
      const f = ensureFile(s, path);
      f.position = position;
      if (finite(duration) && duration > 0) f.duration = duration;
      f.touched = now();
      commit(s);
    },
    getPrefs: () => ({ ...load().prefs, dock: load().prefs.dock ? { ...load().prefs.dock! } : null }),
    setPrefs: (patch) => {
      const s = load();
      s.prefs = sanitizePrefs({ ...s.prefs, ...patch });
      persist(s);
      return { ...s.prefs, dock: s.prefs.dock ? { ...s.prefs.dock } : null };
    },
  };
};
