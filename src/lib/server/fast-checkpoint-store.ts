/**
 * SDK JSONL store 的 checkpoints 子 store 快速实现。
 *
 * 背景：`@cursor/sdk` 的 `JsonlLocalAgentStore` 每次 get/create/update/list 都把
 * `checkpoints.ndjson` 整份读进内存、JSON.parse 每一行，写则整文件 tmp+fsync+rename，
 * 并且所有会话共用这一个文件、写入走进程级串行队列。文件越大（实测 66~210MB）、
 * 单次操作越慢（5~7s）、内存越高（约 28MB/MB 文件），队列里排着的 run 事件被一并卡住，
 * 表现为「越聊越卡 / 吐字像打字机 / 回车后一直 loading / 内存超限崩溃」。
 * 官方已复现、未修复（forum.cursor.com 的 "JsonlLocalAgentStore checkpoints.get
 * rescans whole file, making every send quadratic"），1.0.37 实现与 1.0.31 相同。
 *
 * 做法：只替换 checkpoints 这一层（占体积 99%），其余三个小文件仍用 SDK 自带实现，
 * 经 SDK 公开 API `composeLocalAgentStore` 组合。
 *   - 启动时流式扫描一次，建「(agentId, blobId) → 行偏移」内存索引（66MB / 4678 个 blob 约 20ms）；
 *   - 读：按偏移直接读一行；写：追加一行 + fsync；不再读写整文件、不再进全局队列；
 *   - **文件格式与 SDK 逐字节兼容**：不用迁移，SDK 原实现能读本实现写的文件（反之亦然），
 *     出问题时切回 `FLOWSHIP_SDK_STORE=sdk` 即可回滚。
 *
 * 不变式（review 时请逐条核对）：
 *   1. 单写者：同一目录同一时刻只允许一个 FastCheckpoints 实例写。Flowship 是单个 next-server
 *      进程 + globalThis 单例（见 sdk-agent-store.ts）。检测到外部追加会先追赶；追赶后
 *      仍对不上（并发写者 / 半行）则**抛错而不是修复**——绝不在运行时截断别人的数据。
 *   2. `size` 是「最后一个完整行之后」的逻辑文件尾，追加前必须与真实文件大小一致。
 *   3. 所有写（create/update/delete/重建）进同一个 Promise 队列串行；get 不进队列，
 *      读到的是索引快照，行内容与索引对不上时用 epoch 机制丢弃并重建（自愈，不返回脏数据）。
 *   4. 索引只收「完整、可解析」的行；与 SDK `find` 同语义：重复键取**第一个**。
 *   5. SDK 容忍的文件尾形态都兼容：最后一行缺换行但是完整 JSON（并入索引、追加时补换行）、
 *      最后一行是半行（首次追加前截掉）。中间的损坏行跳过并告警（SDK 会直接抛错，这里更宽容）。
 *
 * 平台硬化（Windows 的文件系统语义与 POSIX 不同，macOS 上用故障注入模拟，真机见 CI）：
 *   - open/rename/truncate 会被杀毒 / 索引器 / 云同步随机占用，报 EPERM/EACCES/EBUSY：
 *     统一指数退避 + 抖动重试；POSIX 上 EPERM/EACCES 是真权限错误，不重试（白等 10 秒没意义）；
 *   - 追加句柄（"a"）在 Windows 上没有 FILE_WRITE_DATA：不能 ftruncate、FlushFileBuffers
 *     也可能被拒。所以 fsync 与回滚截断一律另开 "r+" 句柄，不依赖追加句柄的能力；
 *   - 重写前先关掉自己持有的全部句柄再 rename，rename 失败清理 tmp 且原文件/索引保持原样；
 *   - 读写都循环读满/写满（短读/短写）；换行按 `\n` 切分、`\r` 随行保留（CRLF 文件可读）。
 */
import fsp from "node:fs/promises";
import path from "node:path";

import type {
  LocalAgentCheckpointFilter,
  LocalAgentStoreCheckpoints,
  LocalAgentStoreListResult,
} from "@cursor/sdk";

export const CHECKPOINTS_FILENAME = "checkpoints.ndjson";

/** 行头最多看这么多字节来识别 agentId/blobId（id 再长就走整行解析的慢路径） */
const HEAD_BYTES = 320;
/** 扫描块大小：8MB，小文件按实际大小分配 */
const SCAN_CHUNK_BYTES = 8 << 20;
/** 文件尾「未换行」那一段允许整段解析的上限，超过直接当半行截掉 */
const MAX_TAIL_PARSE_BYTES = 256 << 20;
/** 并发读句柄上限：防止几百个并发 get 同时 open 撑爆句柄（macOS 默认 ulimit 才 256） */
const MAX_CONCURRENT_READS = 32;

/**
 * 行头：`{"agentId":"…","blobId":"…","dataBase64":"`，id 限定为可打印 ASCII 且不含 `"` / `\`。
 * 含非 ASCII / 需转义字符的 id 不匹配 → 走 JSON.parse 慢路径（避免 latin1 误解码出错 key）。
 */
const HEAD_RE =
  /^\{"agentId":"([\x20\x21\x23-\x5b\x5d-\x7e]*)","blobId":"([\x20\x21\x23-\x5b\x5d-\x7e]*)","dataBase64":"/;

const NEWLINE = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;
const RBRACE = 0x7d;

// ───────────────────────────── 文件系统抽象（便于故障注入） ─────────────────────────────

export interface FileHandleLike {
  stat(): Promise<{ size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  appendFile(data: Buffer): Promise<void>;
  sync(): Promise<void>;
  truncate(len: number): Promise<void>;
  close(): Promise<void>;
}

export interface FsLike {
  open(file: string, flags: string): Promise<FileHandleLike>;
  stat(file: string): Promise<{ size: number }>;
  mkdir(dir: string): Promise<void>;
  rm(file: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export const realFs: FsLike = {
  open: (file, flags) => fsp.open(file, flags),
  stat: (file) => fsp.stat(file),
  mkdir: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
  rm: (file) => fsp.rm(file, { force: true }),
  rename: (from, to) => fsp.rename(from, to),
};

// ───────────────────────────── 重试 ─────────────────────────────

/** Windows：杀毒 / 索引器 / 云同步会让 open/rename/truncate 随机报这些，稍等就好 */
const WIN_RETRY_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
  "EMFILE",
  "ENFILE",
]);
/** POSIX：EPERM/EACCES 是真权限问题，重试只会白等；仅句柄耗尽 / 设备忙才重试 */
const POSIX_RETRY_CODES: ReadonlySet<string> = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
]);

export interface RetryOptions {
  /** 默认取 process.platform，测试可注入 "win32" 模拟 */
  platform?: NodeJS.Platform;
  /** 退避等待（测试注入免真等） */
  sleep?: (ms: number) => Promise<void>;
  /** 累计等待预算，默认 10s；耗尽后抛出最后一次的原始错误 */
  budgetMs?: number;
  /** 抖动随机源，默认 Math.random */
  random?: () => number;
}

export const errCode = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  const code = (e as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 指数退避 10→20→40…封顶 400ms，±25% 抖动；只重试平台对应的瞬态错误码 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> => {
  const codes =
    (opts.platform ?? process.platform) === "win32"
      ? WIN_RETRY_CODES
      : POSIX_RETRY_CODES;
  const sleep = opts.sleep ?? realSleep;
  const budget = opts.budgetMs ?? 10_000;
  const random = opts.random ?? Math.random;
  let waited = 0;
  let delay = 10;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const code = errCode(e);
      if (!code || !codes.has(code) || waited >= budget) throw e;
      const d = Math.min(delay, 400) * (0.75 + random() * 0.5);
      await sleep(d);
      waited += d;
      delay *= 2;
    }
  }
};

// ───────────────────────────── 小工具 ─────────────────────────────

/** 读满 len 字节；遇到 EOF 返回 false（文件比预期短 = 索引过期） */
const readFully = async (
  fd: FileHandleLike,
  buf: Buffer,
  len: number,
  pos: number,
): Promise<boolean> => {
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fd.read(buf, got, len - got, pos + got);
    if (bytesRead === 0) return false;
    got += bytesRead;
  }
  return true;
};

/** 写满整个 buf（短写循环） */
const writeFully = async (
  fd: FileHandleLike,
  buf: Buffer,
  pos: number,
): Promise<void> => {
  let done = 0;
  while (done < buf.length) {
    const { bytesWritten } = await fd.write(
      buf,
      done,
      buf.length - done,
      pos + done,
    );
    if (bytesWritten === 0) throw new Error("short write on checkpoints.ndjson");
    done += bytesWritten;
  }
};

/** 并发闸：名额在唤醒时直接移交，不会因为「先释放再抢」而超发 */
class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/** 无歧义的复合键：长度前缀，id 里含任何字符都不会撞 */
const keyOf = (agentId: string, blobId: string): string =>
  `${agentId.length}:${agentId}${blobId}`;

/** 与 SDK 内部过滤同语义：无过滤→全匹配；agentIds / blobIds 非空则必须命中 */
export const matchesCheckpointFilter = (
  agentId: string,
  blobId: string,
  f: LocalAgentCheckpointFilter | undefined,
): boolean => {
  const agentIds = f?.agentIds;
  const blobIds = f?.blobIds;
  if (agentIds?.length && !agentIds.includes(agentId)) return false;
  if (blobIds?.length && !blobIds.includes(blobId)) return false;
  return true;
};

interface Entry {
  agentId: string;
  blobId: string;
  /** 行首偏移 */
  off: number;
  /** 行长，不含结尾的 `\n`（CRLF 文件里含 `\r`） */
  len: number;
}
type Index = Map<string, Entry>;

type TailState =
  | { kind: "clean" }
  /** 最后一行是写到一半的残行：首次追加前截到 at */
  | { kind: "torn"; at: number }
  /** 最后一行是完整 JSON 但没有结尾换行（SDK 能读）：已并入索引，追加时先补一个换行 */
  | { kind: "unterminated" };

const CLEAN: TailState = { kind: "clean" };

interface ScanResult {
  entries: Entry[];
  /** 逻辑文件尾：最后一个完整行之后的偏移 */
  end: number;
  /** 扫描时看到的真实文件大小 */
  seen: number;
  tail: TailState;
  /** 跳过的损坏行数 */
  corrupt: number;
}

const isBlank = (b: Buffer): boolean => b.toString("utf8").trim().length === 0;

const parseRecord = (
  b: Buffer,
): { agentId: string; blobId: string } | null => {
  try {
    const o = JSON.parse(b.toString("utf8")) as unknown;
    if (typeof o !== "object" || o === null) return null;
    const r = o as Record<string, unknown>;
    if (typeof r.agentId !== "string" || typeof r.blobId !== "string") {
      return null;
    }
    return { agentId: r.agentId, blobId: r.blobId };
  } catch {
    return null;
  }
};

/** 行尾必须是 `"}`（允许其后跟一个 `\r`）：校验后才信任「只看头」的快路径 */
const endsLikeRecord = (b: Buffer, end: number): boolean => {
  let e = end;
  if (e > 0 && b[e - 1] === CR) e -= 1;
  return e >= 2 && b[e - 1] === RBRACE && b[e - 2] === QUOTE;
};

/** 整行都在 view 内时的同步快路径；不满足返回 null（交给慢路径，不是「损坏」） */
const fastEntry = (
  view: Buffer,
  rel: number,
  len: number,
  off: number,
): Entry | null => {
  const m = HEAD_RE.exec(
    view.toString("latin1", rel, rel + Math.min(len, HEAD_BYTES)),
  );
  if (!m) return null;
  let end = rel + len;
  if (view[end - 1] === CR) end -= 1;
  // 头和尾不能重叠：行至少是 头 + `"}`
  if (end - 2 < rel + m[0].length) return null;
  if (view[end - 1] !== RBRACE || view[end - 2] !== QUOTE) return null;
  return { agentId: m[1], blobId: m[2], off, len };
};

// ───────────────────────────── 主体 ─────────────────────────────

export interface FastCheckpointsOptions {
  /** 仅测试：注入故障文件系统 */
  fs?: FsLike;
  /** 仅测试：模拟平台，决定重试哪些错误码 */
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  random?: () => number;
  /** 告警出口，默认 console.warn */
  onWarn?: (msg: string) => void;
}

export interface FastCheckpointsStats {
  blobs: number;
  /** 逻辑文件尾（字节） */
  bytes: number;
  creates: number;
  gets: number;
  catchUps: number;
  rebuilds: number;
  rewrites: number;
  updateNoop: number;
  updateWrite: number;
  /** 扫描时跳过的损坏行累计 */
  corruptSkipped: number;
  /** 扫描时遇到的重复键行累计（取第一个，与 SDK `find` 一致） */
  duplicateSkipped: number;
}

type PaginateFn = (
  blobIds: readonly string[],
  options?: Pick<LocalAgentCheckpointFilter, "cursor" | "limit">,
) => LocalAgentStoreListResult<string>;

export class FastCheckpoints implements LocalAgentStoreCheckpoints {
  readonly file: string;
  private readonly dir: string;
  private readonly fs: FsLike;
  private readonly paginate: PaginateFn;
  private readonly retryOpts: RetryOptions;
  private readonly warn: (msg: string) => void;
  private readonly readGate = new Gate(MAX_CONCURRENT_READS);

  private index: Index | null = null;
  private loading: Promise<Index> | null = null;
  private catching: Promise<void> | null = null;
  private rebuilding: Promise<void> | null = null;
  /** 逻辑文件尾（见不变式 2） */
  private size = 0;
  /** 上次看到的真实文件大小，catchUp 以它为基准（torn 尾巴不会让 catchUp 空转） */
  private seen = 0;
  private tailState: TailState = CLEAN;
  /** 索引被整体替换 / 重建的代数：并发的 catchUp 发现代数变了就丢弃自己的扫描结果 */
  private epoch = 0;
  private writeTail: Promise<unknown> = Promise.resolve();
  private readonly touched = new Set<string>();
  private readonly counters = {
    creates: 0,
    gets: 0,
    catchUps: 0,
    rebuilds: 0,
    rewrites: 0,
    updateNoop: 0,
    updateWrite: 0,
    corruptSkipped: 0,
    duplicateSkipped: 0,
  };

  constructor(
    rootDir: string,
    paginate: PaginateFn,
    opts: FastCheckpointsOptions = {},
  ) {
    this.dir = rootDir;
    this.file = path.join(rootDir, CHECKPOINTS_FILENAME);
    this.paginate = paginate;
    this.fs = opts.fs ?? realFs;
    this.warn = opts.onWarn ?? ((msg) => console.warn(msg));
    this.retryOpts = {
      platform: opts.platform,
      sleep: opts.sleep,
      budgetMs: opts.budgetMs,
      random: opts.random,
    };
  }

  /** 组合进 worker IPC 的 JSON 往返时只留标识，别把内部状态序列化出去 */
  toJSON(): { kind: string; file: string } {
    return { kind: "fast-checkpoints", file: this.file };
  }

  // ───────── 对外：公开接口之外的诊断 / GC 钩子 ─────────

  /** 启动预热：建索引。失败抛错，调用方据此回退到 SDK 原实现（此时尚无任何写入） */
  async warmUp(): Promise<FastCheckpointsStats> {
    await this.ensure();
    return this.getStats();
  }

  getStats(): FastCheckpointsStats {
    return {
      blobs: this.index?.size ?? 0,
      bytes: this.size,
      ...this.counters,
    };
  }

  /** 本实例写过（create / update 成功）的 agentId。GC 据此保护「刚创建、meta 还没落盘」的会话 */
  touchedAgentIds(): ReadonlySet<string> {
    return this.touched;
  }

  /** 索引里出现过的全部 agentId（含 agents 表里已没有记录的残留） */
  async agentIds(): Promise<string[]> {
    await this.ensure();
    await this.catchUp();
    const idx = await this.ensure();
    const ids = new Set<string>();
    for (const e of idx.values()) ids.add(e.agentId);
    return [...ids];
  }

  // ───────── 句柄 / 重试 ─────────

  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, this.retryOpts);
  }

  private open(file: string, flags: string): Promise<FileHandleLike> {
    return this.retry(() => this.fs.open(file, flags));
  }

  /**
   * 截断到 len：必须用独立的 "r+" 句柄——Windows 的 "a" 句柄没有写数据权限，ftruncate 会失败。
   */
  private async truncateTo(len: number): Promise<void> {
    const w = await this.open(this.file, "r+");
    try {
      await this.retry(() => w.truncate(len));
    } finally {
      await w.close();
    }
  }

  /** fsync：同样另开 "r+" 句柄（Windows 的 FlushFileBuffers 要求写权限，追加句柄不一定有） */
  private async syncFile(): Promise<void> {
    const w = await this.open(this.file, "r+");
    try {
      await w.sync();
    } finally {
      await w.close();
    }
  }

  // ───────── 扫描 ─────────

  /**
   * 从 startOff 流式扫描到文件尾，只读、不修复。返回完整行列表与文件尾形态，
   * 由调用方在**同步段**里应用到索引（避免 await 之间状态被别的操作改掉）。
   */
  private async scan(startOff: number): Promise<ScanResult> {
    let fd: FileHandleLike;
    try {
      fd = await this.open(this.file, "r"); // 只读打开：文件只读 / 被别的程序占用时仍能读
    } catch (e) {
      if (errCode(e) === "ENOENT") {
        return { entries: [], end: startOff, seen: startOff, tail: CLEAN, corrupt: 0 };
      }
      throw e;
    }
    const entries: Entry[] = [];
    let corrupt = 0;
    try {
      const { size } = await fd.stat();
      const buf = Buffer.allocUnsafe(
        Math.max(1, Math.min(SCAN_CHUNK_BYTES, size - startOff)),
      );
      let chunkStart = startOff;
      let lineStart = startOff;
      while (chunkStart < size) {
        const want = Math.min(buf.length, size - chunkStart);
        const { bytesRead: n } = await fd.read(buf, 0, want, chunkStart);
        if (n === 0) break;
        const view = buf.subarray(0, n);
        let from = 0;
        for (;;) {
          const nl = view.indexOf(NEWLINE, from);
          if (nl === -1) break;
          const lineEnd = chunkStart + nl;
          const len = lineEnd - lineStart;
          if (len > 0) {
            // 行起点在当前块内才能走同步快路径；跨块的行（大 blob）走慢路径只读头尾
            const hit =
              (lineStart >= chunkStart
                ? fastEntry(view, lineStart - chunkStart, len, lineStart)
                : null) ?? (await this.slowEntry(fd, lineStart, len));
            if (hit === "bad") corrupt += 1;
            else if (hit) entries.push(hit);
          }
          lineStart = lineEnd + 1;
          from = nl + 1;
        }
        chunkStart += n;
      }

      // 文件尾没有换行的那一段：完整 JSON → 并入索引并记 unterminated；否则是半行 → torn
      let end = lineStart;
      let tail: TailState = CLEAN;
      if (lineStart < size) {
        const tl = size - lineStart;
        let rec: { agentId: string; blobId: string } | null = null;
        if (tl <= MAX_TAIL_PARSE_BYTES) {
          const tb = Buffer.allocUnsafe(tl);
          if (await readFully(fd, tb, tl, lineStart)) rec = parseRecord(tb);
        }
        if (rec) {
          entries.push({ ...rec, off: lineStart, len: tl });
          end = size;
          tail = { kind: "unterminated" };
        } else {
          tail = { kind: "torn", at: lineStart };
        }
      }
      return { entries, end, seen: size, tail, corrupt };
    } finally {
      await fd.close();
    }
  }

  /** 快路径放弃的行：先只读头尾（避免对 MB 级大行整行解析），不行再整行 parse */
  private async slowEntry(
    fd: FileHandleLike,
    start: number,
    len: number,
  ): Promise<Entry | "bad" | null> {
    const hb = Buffer.allocUnsafe(Math.min(len, HEAD_BYTES));
    if (!(await readFully(fd, hb, hb.length, start))) {
      throw new Error("checkpoints.ndjson shrank while scanning");
    }
    const m = HEAD_RE.exec(hb.toString("latin1"));
    if (m) {
      const tn = Math.min(len, 3);
      const tb = Buffer.allocUnsafe(tn);
      if (!(await readFully(fd, tb, tn, start + len - tn))) {
        throw new Error("checkpoints.ndjson shrank while scanning");
      }
      if (len >= m[0].length + 2 && endsLikeRecord(tb, tn)) {
        return { agentId: m[1], blobId: m[2], off: start, len };
      }
    }
    const lb = Buffer.allocUnsafe(len);
    if (!(await readFully(fd, lb, len, start))) {
      throw new Error("checkpoints.ndjson shrank while scanning");
    }
    if (isBlank(lb)) return null;
    const rec = parseRecord(lb);
    return rec ? { ...rec, off: start, len } : "bad";
  }

  /** 把扫描到的行并入索引：重复键取第一个（与 SDK `find` 一致） */
  private absorb(idx: Index, entries: Entry[]): void {
    for (const e of entries) {
      const key = keyOf(e.agentId, e.blobId);
      if (idx.has(key)) this.counters.duplicateSkipped += 1;
      else idx.set(key, e);
    }
  }

  private ensure(): Promise<Index> {
    if (this.index) return Promise.resolve(this.index);
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<Index> {
    try {
      const r = await this.scan(0);
      const idx: Index = new Map();
      this.absorb(idx, r.entries);
      this.index = idx;
      this.size = r.end;
      this.seen = r.seen;
      this.tailState = r.tail;
      this.epoch += 1;
      this.counters.corruptSkipped += r.corrupt;
      if (r.corrupt > 0) {
        this.warn(
          `[fast-checkpoints] 跳过 ${r.corrupt} 条损坏的 checkpoint 行（SDK 原实现遇到会直接抛错）：${this.file}`,
        );
      }
      return idx;
    } finally {
      this.loading = null;
    }
  }

  /** 文件被别的实例追加过？把新增的完整行并入索引（扫描结果在同步段应用，代数变了就丢弃） */
  private catchUp(): Promise<void> {
    this.catching ??= this.doCatchUp().finally(() => {
      this.catching = null;
    });
    return this.catching;
  }

  private async doCatchUp(): Promise<void> {
    const idx = this.index;
    if (!idx) return;
    const epoch = this.epoch;
    let st: { size: number };
    try {
      st = await this.fs.stat(this.file);
    } catch {
      return;
    }
    if (st.size <= this.seen) return;
    this.counters.catchUps += 1;
    const r = await this.scan(this.size);
    if (this.index !== idx || this.epoch !== epoch) return; // 期间被重写 / 重建过
    this.absorb(idx, r.entries);
    this.size = Math.max(this.size, r.end);
    this.seen = Math.max(this.seen, r.seen);
    // 追赶时的 torn 尾巴可能是别人正在写，不当成可修复的残行；unterminated 则要补换行
    this.tailState =
      r.tail.kind === "unterminated" ? r.tail : this.tailState.kind === "torn" ? this.tailState : CLEAN;
  }

  /** 丢弃索引并整体重扫。进写队列，和追加 / 重写互斥 */
  private rebuild(): Promise<void> {
    this.rebuilding ??= this.enqueue(async () => {
      this.counters.rebuilds += 1;
      this.index = null;
      this.epoch += 1;
      await this.ensure();
    }).finally(() => {
      this.rebuilding = null;
    });
    return this.rebuilding;
  }

  // ───────── 读 ─────────

  private readAt(e: Entry): Promise<Buffer | null> {
    return this.readGate.run(async () => {
      let fd: FileHandleLike;
      try {
        fd = await this.open(this.file, "r");
      } catch (err) {
        if (errCode(err) === "ENOENT") return null; // 文件被外部删了 = 索引过期，交给重建
        throw err;
      }
      try {
        const b = Buffer.allocUnsafe(e.len);
        return (await readFully(fd, b, e.len, e.off)) ? b : null;
      } finally {
        await fd.close();
      }
    });
  }

  /** 解码一行；校验行内 agentId/blobId 与索引一致，不一致说明索引过期 / 错位 */
  private decode(b: Buffer | null, agentId: string, blobId: string): Buffer | null {
    if (!b) return null;
    const m = HEAD_RE.exec(
      b.toString("latin1", 0, Math.min(b.length, HEAD_BYTES)),
    );
    if (m) {
      if (m[1] !== agentId || m[2] !== blobId) return null;
      let end = b.length;
      if (b[end - 1] === CR) end -= 1;
      if (end - 2 < m[0].length) return null;
      if (b[end - 1] !== RBRACE || b[end - 2] !== QUOTE) return null;
      return Buffer.from(b.toString("latin1", m[0].length, end - 2), "base64");
    }
    try {
      const o = JSON.parse(b.toString("utf8")) as Record<string, unknown>;
      if (o.agentId !== agentId || o.blobId !== blobId) return null;
      if (typeof o.dataBase64 !== "string") return null;
      return Buffer.from(o.dataBase64, "base64");
    } catch {
      return null;
    }
  }

  async get(input: {
    readonly agentId: string;
    readonly blobId: string;
  }): Promise<Uint8Array | null> {
    const { agentId, blobId } = input;
    this.counters.gets += 1;
    const key = keyOf(agentId, blobId);
    for (let attempt = 0; attempt < 2; attempt++) {
      let idx = await this.ensure();
      let e = idx.get(key);
      if (!e) {
        await this.catchUp(); // 未命中：看看是不是别的实例刚追加的
        idx = await this.ensure();
        e = idx.get(key);
        if (!e) return null;
      }
      const data = this.decode(await this.readAt(e), agentId, blobId);
      if (data) return data;
      // 行内容和索引对不上（文件被外部改写 / 索引错位）：重建一次，仍不行才报错，绝不返回脏数据
      await this.rebuild();
    }
    throw new Error(
      `Corrupt local agent checkpoint index for blob ${blobId} (agent ${agentId})`,
    );
  }

  // ───────── 写 ─────────

  /** 所有写进同一队列串行；前一个失败不影响后一个 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.writeTail.then(fn, fn);
    this.writeTail = r.then(
      () => undefined,
      () => undefined,
    );
    return r;
  }

  private encodeLine(agentId: string, blobId: string, data: Uint8Array): Buffer {
    return Buffer.from(
      JSON.stringify({
        agentId,
        blobId,
        dataBase64: Buffer.from(data).toString("base64"),
      }),
      "utf8",
    );
  }

  private async append(
    idx: Index,
    agentId: string,
    blobId: string,
    data: Uint8Array,
  ): Promise<void> {
    const body = this.encodeLine(agentId, blobId, data);
    const needsNewline = this.tailState.kind === "unterminated";
    const payload = Buffer.concat([
      needsNewline ? Buffer.from("\n") : Buffer.alloc(0),
      body,
      Buffer.from("\n"),
    ]);
    await this.fs.mkdir(this.dir);

    // 上次崩溃遗留的半行：追加前截掉。截不掉就抛错（不能往半行后面接）
    if (this.tailState.kind === "torn") {
      await this.truncateTo(this.tailState.at);
      this.tailState = CLEAN;
      this.seen = this.size;
    }

    const before = this.size;
    const fd = await this.open(this.file, "a");
    let started = false;
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await fd.close();
    };
    try {
      // 单写者约束：追加前文件尾必须和内存一致。别的实例追加了完整行 → 先追赶；
      // 追赶后仍不一致（有并发写者 / 别人的半行）→ 抛错，绝不在运行时截断别人的数据。
      // 这一步在 try 里但在 started 之前失败：不回滚，因为我们什么都没写。
      let { size } = await fd.stat();
      if (size !== this.size) {
        await this.catchUp();
        ({ size } = await fd.stat());
        if (size !== this.size) {
          throw new Error(
            "checkpoints.ndjson tail mismatch (concurrent writer or torn tail)",
          );
        }
      }
      const start = this.size;
      started = true;
      await fd.appendFile(payload);
      await closeOnce(); // close 失败也算追加失败（NFS 等会在 close 时才报写回错误），走回滚
      await this.syncFile(); // 对齐 SDK 原实现的耐久性：blob 落盘后调用方才会去更新指向它的 agents 指针
      const off = start + (needsNewline ? 1 : 0);
      idx.set(keyOf(agentId, blobId), { agentId, blobId, off, len: body.length });
      this.size = off + body.length + 1;
      this.seen = this.size;
      this.tailState = CLEAN;
      return;
    } catch (err) {
      if (started) {
        // 可能已经写进去一部分：这是我们自己刚写的半行（单写者、在写队列内），回滚到追加之前。
        // 回滚也失败 → 丢弃索引，下次访问整体重扫（重扫会识别并截掉半行）
        try {
          await this.truncateTo(before);
        } catch {
          this.index = null;
          this.epoch += 1;
        }
      }
      throw err;
    } finally {
      await closeOnce().catch(() => undefined);
    }
  }

  create(input: {
    readonly agentId: string;
    readonly blobId: string;
    readonly data: Uint8Array;
  }): Promise<void> {
    const { agentId, blobId, data } = input;
    return this.enqueue(async () => {
      let idx = await this.ensure();
      await this.catchUp();
      idx = await this.ensure();
      if (idx.has(keyOf(agentId, blobId))) {
        throw new Error(
          `Checkpoint blob ${blobId} already exists for agent ${agentId}`,
        );
      }
      await this.append(idx, agentId, blobId, data);
      this.counters.creates += 1;
      this.touched.add(agentId);
    });
  }

  update(input: {
    readonly agentId: string;
    readonly blobId: string;
    readonly data: Uint8Array;
  }): Promise<void> {
    const { agentId, blobId, data } = input;
    return this.enqueue(async () => {
      await this.ensure();
      await this.catchUp();
      const idx = await this.ensure();
      const key = keyOf(agentId, blobId);
      const e = idx.get(key);
      if (!e) {
        throw new Error(
          `Checkpoint blob ${blobId} not found for agent ${agentId}`,
        );
      }
      const next = Buffer.from(data);
      const cur = this.decode(await this.readAt(e), agentId, blobId);
      if (!cur) {
        throw new Error(
          `Corrupt local agent checkpoint index for blob ${blobId} (agent ${agentId})`,
        );
      }
      if (Buffer.compare(cur, next) === 0) {
        // blob 是内容寻址的：同 id 同内容，重写没有意义。SDK 原实现这里会整文件重写
        this.counters.updateNoop += 1;
        this.touched.add(agentId);
        return;
      }
      this.counters.updateWrite += 1;
      const line = this.encodeLine(agentId, blobId, next);
      await this.rewrite((k) => (k === key ? line : undefined));
      this.touched.add(agentId);
    });
  }

  async list(input?: {
    readonly filter?: LocalAgentCheckpointFilter;
  }): Promise<LocalAgentStoreListResult<string>> {
    await this.ensure();
    await this.catchUp();
    const idx = await this.ensure();
    const f = input?.filter;
    const ids: string[] = [];
    for (const e of idx.values()) {
      if (matchesCheckpointFilter(e.agentId, e.blobId, f)) ids.push(e.blobId);
    }
    return this.paginate(ids, f);
  }

  delete(input: { readonly filter: LocalAgentCheckpointFilter }): Promise<void> {
    const { filter } = input;
    return this.enqueue(async () => {
      await this.ensure();
      await this.catchUp();
      const idx = await this.ensure();
      const doomed = new Set<string>();
      for (const [key, e] of idx) {
        if (matchesCheckpointFilter(e.agentId, e.blobId, filter)) doomed.add(key);
      }
      if (doomed.size === 0) return; // SDK 原实现无匹配也会白重写一遍整文件，这里直接跳过
      await this.rewrite((key) => (doomed.has(key) ? null : undefined));
    });
  }

  /**
   * 流式重写：transform(key) → null 丢弃 / undefined 原样保留 / Buffer 替换成新行。
   * 写 tmp → fsync → 关闭全部自有句柄 → rename 覆盖。内存 O(索引条目) 而非 O(文件)。
   * 任何一步失败：清理 tmp，原文件与索引保持原样。必须在写队列内调用。
   */
  private async rewrite(
    transform: (key: string) => Buffer | null | undefined,
  ): Promise<void> {
    const idx = this.index;
    if (!idx) throw new Error("fast-checkpoints: rewrite without index");
    const entries = [...idx.entries()].sort((x, y) => x[1].off - y[1].off);
    const tmp = `${this.file}.compact-tmp`;
    await this.fs.mkdir(this.dir);
    const out = await this.open(tmp, "w"); // 上次崩溃遗留的 tmp 直接覆盖
    let src: FileHandleLike;
    try {
      src = await this.open(this.file, "r");
    } catch (e) {
      await out.close().catch(() => undefined);
      await this.fs.rm(tmp).catch(() => undefined);
      throw e;
    }
    const next: Index = new Map();
    let pos = 0;
    try {
      for (const [key, e] of entries) {
        const r = transform(key);
        if (r === null) continue;
        let line: Buffer;
        if (r === undefined) {
          // 原样拷贝：读 len 字节再补 `\n`（最后一行可能本来就没有换行，不能读 len+1）
          line = Buffer.allocUnsafe(e.len + 1);
          if (!(await readFully(src, line, e.len, e.off))) {
            throw new Error("checkpoints.ndjson shrank during rewrite");
          }
          line[e.len] = NEWLINE;
        } else {
          line = Buffer.concat([r, Buffer.from("\n")]);
        }
        await writeFully(out, line, pos);
        next.set(key, {
          agentId: e.agentId,
          blobId: e.blobId,
          off: pos,
          len: line.length - 1,
        });
        pos += line.length;
      }
      await out.sync();
    } catch (e) {
      await Promise.allSettled([src.close(), out.close()]);
      await this.fs.rm(tmp).catch(() => undefined);
      throw e;
    }
    // rename 之前必须先关掉自己持有的句柄（Windows 上占用目标文件会让 rename 失败）
    await Promise.all([src.close(), out.close()]);
    try {
      await this.retry(() => this.fs.rename(tmp, this.file));
    } catch (e) {
      await this.fs.rm(tmp).catch(() => undefined); // 原文件与索引保持原样
      throw e;
    }
    this.counters.rewrites += 1;
    this.index = next;
    this.size = pos;
    this.seen = pos;
    this.tailState = CLEAN;
    this.epoch += 1;
  }
}
