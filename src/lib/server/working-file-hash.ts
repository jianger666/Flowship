/**
 * 工作区文件内容指纹的「成本控制」（纯函数，无 IO，可直接测）。
 *
 * 清单会被 4 秒一次地轮询，而「有未暂存改动的文件」要读盘算内容哈希。不加控制，
 * 最坏每次读 100 个 × 20MB = 2GB。所以：
 * - planHashing：每次最多哈希多少个文件、单个多大、一共多少字节——超出的退回「大小:修改时间」；
 * - HashCache：磁盘状态（路径 + 大小 + mtime + ctime + inode）没变就不重复读盘。
 *   「刚改过」的文件不缓存（racy：同一时刻内再次写入可能让 mtime 不变），和 git 对 racily-clean 的处理同理；
 *   key 里带 ctime / inode：内容被改写后即使用 `touch -r` / `cp -p` 把 mtime 还原，ctime 也会前进。
 */

/** 一次清单里最多对多少个文件按内容哈希（再多的退回大小 + mtime，免得大改动时轮询变重） */
export const MAX_HASH_FILES = 100;
/** 单个文件超过这个大小不哈希 */
export const MAX_HASH_FILE_BYTES = 20 * 1024 * 1024;
/** 一次清单里哈希的字节总预算（缓存没命中的才算）：封住最坏情况的读盘量 */
export const MAX_HASH_TOTAL_BYTES = 64 * 1024 * 1024;
/** 哈希缓存最多留多少条（满了先进先出） */
export const HASH_CACHE_MAX = 4000;
/** 文件最后一次变动离现在不足这么久，就不进缓存（racy 保护） */
export const HASH_CACHE_MIN_AGE_MS = 2000;

export interface HashLimits {
  /** 一次最多哈希几个文件 */
  maxFiles: number;
  /** 单个文件超过这个大小不哈希 */
  maxFileBytes: number;
  /** 一次哈希的字节总预算 */
  maxTotalBytes: number;
}

export const DEFAULT_HASH_LIMITS: HashLimits = {
  maxFiles: MAX_HASH_FILES,
  maxFileBytes: MAX_HASH_FILE_BYTES,
  maxTotalBytes: MAX_HASH_TOTAL_BYTES,
};

export interface HashCandidate {
  rel: string;
  size: number;
}

export interface HashPlan {
  /** 要真去哈希的（保持输入顺序） */
  hash: string[];
  /** 超出限制、退回「大小:修改时间」的 */
  fallback: string[];
}

/**
 * 决定哪些文件真的去哈希。按输入顺序逐个看：个数、单个大小、累计字节都在限制内才选中，
 * 否则退回——某个超大文件被跳过不影响后面的小文件继续入选（用 continue 而不是 break）。
 */
export const planHashing = (
  candidates: readonly HashCandidate[],
  limits: HashLimits = DEFAULT_HASH_LIMITS,
): HashPlan => {
  const hash: string[] = [];
  const fallback: string[] = [];
  let total = 0;
  for (const c of candidates) {
    const fits =
      hash.length < limits.maxFiles &&
      c.size <= limits.maxFileBytes &&
      total + c.size <= limits.maxTotalBytes;
    if (fits) {
      hash.push(c.rel);
      total += c.size;
    } else {
      fallback.push(c.rel);
    }
  }
  return { hash, fallback };
};

export interface FileStamp {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

/** 缓存键：同一份磁盘状态（路径 + 大小 + mtime + ctime + inode）才算同一个文件 */
export const hashCacheKey = (root: string, rel: string, st: FileStamp): string =>
  `${root}\0${rel}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}`;

export interface HashCache {
  get: (key: string) => string | undefined;
  /** 写入；文件刚改过（mtime / ctime 离现在不足 minAgeMs）的不缓存，返回是否真的写了 */
  set: (key: string, value: string, mtimeMs: number, ctimeMs: number) => boolean;
  clear: () => void;
  size: () => number;
  stats: () => { hits: number; misses: number };
}

export const createHashCache = (opts: {
  max: number;
  minAgeMs: number;
  /** 时钟（测试注入）；缺省每次现读 Date.now（别在创建时捕获函数引用，假时钟才改得动它） */
  now?: () => number;
}): HashCache => {
  const map = new Map<string, string>();
  let hits = 0;
  let misses = 0;
  const now = opts.now ?? (() => Date.now());
  return {
    get: (key) => {
      const v = map.get(key);
      if (v === undefined) misses += 1;
      else hits += 1;
      return v;
    },
    set: (key, value, mtimeMs, ctimeMs) => {
      if (now() - Math.max(mtimeMs, ctimeMs) < opts.minAgeMs) return false;
      if (!map.has(key) && map.size >= opts.max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, value);
      return true;
    },
    clear: () => {
      map.clear();
      hits = 0;
      misses = 0;
    },
    size: () => map.size,
    stats: () => ({ hits, misses }),
  };
};

/** 进程内唯一的工作区文件哈希缓存（清单读取共用） */
export const workingHashCache = createHashCache({
  max: HASH_CACHE_MAX,
  minAgeMs: HASH_CACHE_MIN_AGE_MS,
});

// ---------- 未跟踪文件的「读盘摘要」 ----------
// 未跟踪文件没有 git 给的 oid，要读内容才知道「几行 / 是不是二进制 / 内容哈希」。读一次就缓存摘要，
// 磁盘状态没变的轮询不再重读；没缓存的也走同一份字节预算（见 task-changes 的 statUntrackedBatch）。

/** 一个未跟踪文件读盘后的摘要（缓存的值） */
export interface UntrackedSummary {
  /** 新增行数；二进制 = null */
  added: number | null;
  binary: boolean;
  /** 内容的 git blob oid 前缀 */
  oid: string;
}

/** 编码成缓存里的字符串：`<行数|n>:<0|1>:<oid>`（行数 null 写 n） */
export const encodeUntrackedSummary = (s: UntrackedSummary): string =>
  `${s.added === null ? "n" : s.added}:${s.binary ? 1 : 0}:${s.oid}`;

/** 解码；格式不对（被污染 / 格式变了）返回 null，调用方当没命中、重新读 */
export const decodeUntrackedSummary = (raw: string): UntrackedSummary | null => {
  const m = /^(n|\d+):([01]):([0-9a-f]+)$/.exec(raw);
  if (!m) return null;
  const added = m[1] === "n" ? null : Number(m[1]);
  if (added !== null && !Number.isSafeInteger(added)) return null;
  return { added, binary: m[2] === "1", oid: m[3] };
};

/**
 * 未跟踪文件摘要缓存。与 workingHashCache **分开**：同一路径可能先后以「未跟踪」和
 * 「tracked 且有未暂存改动」出现（用户 `git add` 之后），两边缓存的值格式不同，共用一个键空间会互相误读。
 */
export const untrackedSummaryCache = createHashCache({
  max: HASH_CACHE_MAX,
  minAgeMs: HASH_CACHE_MIN_AGE_MS,
});
