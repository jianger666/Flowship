/**
 * 媒体卡片元数据（时长 / 封面）的缓存与并发闸。纯逻辑、无 DOM，便于测试。
 *
 * - 缓存键 = `路径|ETag`：文件被原地重新生成（ETag 变了）自然换新，不会拿旧封面冒充新文件；
 * - LRU：最近用过的留下，封面是 data URL（≈10–30KB / 张），封顶 80 张；
 * - 并发闸：同时只解码 N 个文件的元数据，滚动一屏有十几条消息时不会同时拉起十几个解码器。
 */

export interface MediaCardMetaReady {
  status: "ready";
  duration: number;
  size: number;
  /** 视频封面（data URL）；音频 / 取帧失败为 undefined */
  poster?: string;
  width?: number;
  height?: number;
}

export interface MediaCardMetaError {
  status: "error";
  reason: string;
}

export type MediaCardMeta = { status: "loading" } | MediaCardMetaReady | MediaCardMetaError;

export const MEDIA_CARD_CACHE_MAX = 80;

export const mediaCardCacheKey = (path: string, etag: string): string => `${path}|${etag}`;

export interface MediaCardCache {
  get: (key: string) => MediaCardMetaReady | undefined;
  set: (key: string, value: MediaCardMetaReady) => void;
  size: () => number;
  clear: () => void;
}

export const createMediaCardCache = (max: number = MEDIA_CARD_CACHE_MAX): MediaCardCache => {
  const map = new Map<string, MediaCardMetaReady>();
  return {
    get: (key) => {
      const v = map.get(key);
      if (!v) return undefined;
      // 命中提到队尾（最近使用）
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set: (key, value) => {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    size: () => map.size,
    clear: () => map.clear(),
  };
};

export interface Limiter {
  run: <T>(task: () => Promise<T>) => Promise<T>;
  /** 正在跑 + 排队的总数（测试 / 诊断用） */
  pending: () => number;
}

/** 同时最多跑 `concurrency` 个任务，其余先进先出排队；任务抛错不影响队列 */
export const createLimiter = (concurrency: number): Limiter => {
  const limit = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= limit) return;
    const start = queue.shift();
    if (start) start();
  };
  return {
    run: <T,>(task: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const start = () => {
          active += 1;
          task().then(resolve, reject).finally(() => {
            active -= 1;
            next();
          });
        };
        queue.push(start);
        next();
      }),
    pending: () => active + queue.length,
  };
};

/** 封面取帧的时间点：避开片头常见的黑场，但不超过片长的 10% / 1 秒 */
export const posterSeekTime = (duration: number): number => {
  if (!(duration > 0)) return 0;
  return Math.min(1, duration * 0.1);
};
