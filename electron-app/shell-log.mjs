/**
 * 壳日志 main.log 的写入器（R14 B2-4b / Q15-03）：写流错误兜底 + 按大小轮转。
 * 只依赖 node:fs / node:path；fs、console、时钟都可注入，vitest 直接测（不用起 Electron）。
 *
 * 为什么要有它——旧实现（main.js 里内联的 log()）有三个洞：
 *   1. `createWriteStream(main.log, { flags: "a" })` 没挂 `error` 监听：磁盘满 / 权限被收 / 目录被删时流会异步 emit 'error'，
 *      没人接 → 主进程 uncaughtException（弹「A JavaScript error occurred in the main process」）。
 *      log() 里的 try/catch 只挡得住同步异常，挡不住异步的 error 事件；
 *   2. 没有轮转：一份文件一直长（实测 83.9MB / 4.5 个月），而诊断包只取尾部 300KB，其余全是占盘；
 *   3. 出错后没有退路：流销毁后再 write 不会成功，日志从此静默丢失、也没有任何线索。
 *
 * 现在：
 *   - 流上挂了 error 监听，任何写入失败都不会抛到调用方、更不会变成未捕获异常；
 *   - 失败后丢弃坏流、下一行日志重新打开（自愈：目录被删后重建、临时占用后恢复）；连续失败 errorsBeforeDegrade 次进入「降级」：
 *     暂停落盘 degradeRetryMs（日志暂存在内存里、有上限，超出丢最旧的并计数），到点再试：写得进去就把暂存的补写进文件、并留一行说明丢了多少；
 *     到点这一次盘仍然写不进去，则这一批暂存（最多 maxQueuedLines 行）已经整批交给新流、随它一起丢失——这部分不计入丢弃数，随即再次降级。
 *     所以降级期间的日志只是「尽力而为」：恢复得比较快才补得全（B2-4b 终审 P3-3：已知局限；要做到不整批丢，备选「探路写」见 HANDOFF）；
 *   - 轮转：文件 ≥ maxBytes 就把 main.log → main.log.1（保留 keep 份，最老的删掉）。**先 end() 等流真正 close 再 rename**
 *     （Windows 上打开着的文件 rename 会 EBUSY）；轮转期间新来的行进内存队列、新文件打开后按顺序写入，不丢；
 *     rename 失败（EBUSY / EPERM：杀软或用户的编辑器占着）→ 放弃这次、继续往原文件追加、rotateRetryMs 内不再重试；
 *   - 启动时（第一次打开前）也检查一次：上一次运行遗留的超限文件在这时就轮转掉；
 *   - 「超限」按本进程累计写入的字节判断（打开时 stat 一次作起点），不是每隔一段 stat：stat 只看得到已落盘的部分，
 *     突发写入时远远滞后（首版用 stat、真实文件系统的突发测试里主文件长到 77KB 才被发现）。
 * 不用定时器（不保活事件循环）：降级后的重试、轮转都由下一行日志触发——壳的日志足够频繁。
 */
import * as nodeFs from "node:fs";
import path from "node:path";

/** 单个文件上限：诊断包只取尾部 300KB，历史价值低；保留 1 份 ⇒ 磁盘上限约 2 × 20MB */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** 保留的历史份数（main.log.1 … main.log.N） */
export const DEFAULT_KEEP = 1;
/** 连续这么多次写入失败 → 降级（暂停落盘） */
export const DEFAULT_ERRORS_BEFORE_DEGRADE = 3;
/** 降级后多久再试一次 */
export const DEFAULT_DEGRADE_RETRY_MS = 60_000;
/** 轮转失败后多久内不再重试 */
export const DEFAULT_ROTATE_RETRY_MS = 10 * 60_000;
/** 内存里最多暂存多少行（降级 / 轮转期间）；超出丢最旧的并计数 */
export const DEFAULT_MAX_QUEUED_LINES = 1000;

/**
 * @param {object} opts
 * @param {() => string} opts.getLogFile main.log 的完整路径（每次打开时现取：app.getPath 不必在创建时就可用）
 * @param {Pick<typeof import("node:fs"), "mkdirSync" | "createWriteStream" | "renameSync" | "rmSync" | "statSync" | "appendFileSync">} [opts.fs]
 * @param {Pick<Console, "log" | "warn">} [opts.console]
 * @param {() => number} [opts.nowMs]
 * @param {() => string} [opts.stamp] 行首时间戳（默认 ISO 字符串，与改前同格式）
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.keep]
 * @param {number} [opts.errorsBeforeDegrade]
 * @param {number} [opts.degradeRetryMs]
 * @param {number} [opts.rotateRetryMs]
 * @param {number} [opts.maxQueuedLines]
 */
export const createShellLogger = ({
  getLogFile,
  fs: fsx = nodeFs,
  console: consoleImpl = console,
  nowMs = Date.now,
  stamp = () => new Date().toISOString(),
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  errorsBeforeDegrade = DEFAULT_ERRORS_BEFORE_DEGRADE,
  degradeRetryMs = DEFAULT_DEGRADE_RETRY_MS,
  rotateRetryMs = DEFAULT_ROTATE_RETRY_MS,
  maxQueuedLines = DEFAULT_MAX_QUEUED_LINES,
}) => {
  /** 待写入的行（流不可用 / 降级 / 轮转期间在这里排队；写进流之后就出队） */
  /** @type {string[]} */
  let queue = [];
  let dropped = 0;
  /** @type {import("node:stream").Writable | null} */
  let stream = null;
  let rotating = false;
  let consecutiveErrors = 0;
  /** @type {number | null} 降级到何时（毫秒时间戳）；null = 没降级 */
  let degradedUntil = null;
  let rotateBackoffUntil = 0;
  /** 当前文件的大小：打开时 stat 一次，之后按本进程写入的字节累计（stat 只看得到已落盘的部分，突发写入时严重滞后——见 HANDOFF B2-4b） */
  let fileBytes = 0;
  /** @type {string | null} */
  let lastErrorCode = null;
  let wasDegraded = false;

  const noteLine = (msg) => `[${stamp()}] [shell-log] ${msg}`;

  const enqueue = (line, { front = false } = {}) => {
    if (front) queue.unshift(line);
    else queue.push(line);
    if (queue.length > maxQueuedLines) {
      // 超限丢最旧的（崩溃前后的日志恰是最有用的，所以留新的）；front 插入的提示行排在最前，丢的是它后面那条最旧的普通行
      queue.splice(front ? 1 : 0, 1);
      dropped += 1;
    }
  };

  const safeConsole = (method, line) => {
    try {
      consoleImpl[method](line);
    } catch {
      // stdout / stderr 是个坏管道（EPIPE）也不能影响落盘
    }
  };

  const codeOf = (err) => (typeof err?.code === "string" ? err.code : "UNKNOWN");

  const registerFailure = (err) => {
    consecutiveErrors += 1;
    lastErrorCode = codeOf(err);
    if (consecutiveErrors >= errorsBeforeDegrade && degradedUntil === null) {
      degradedUntil = nowMs() + degradeRetryMs;
      wasDegraded = true;
      const note = noteLine(
        `main.log 连续 ${consecutiveErrors} 次写入失败（${lastErrorCode}）、暂停落盘 ${Math.round(degradeRetryMs / 1000)}s；日志暂存内存（上限 ${maxQueuedLines} 行）`,
      );
      safeConsole("warn", note);
      enqueue(note); // 恢复写入后补进文件：事后能看出这一段是补写的
    }
  };

  /** 已经记过账的坏流：同一条流的 error 事件 + write 回调 / 同步抛错只算一次失败 */
  const failedStreams = new WeakSet();
  const onStreamError = (s, err) => {
    if (failedStreams.has(s)) return;
    failedStreams.add(s);
    if (s === stream) stream = null;
    try {
      s.destroy();
    } catch {
      // 已销毁
    }
    registerFailure(err);
  };

  const open = () => {
    try {
      const file = getLogFile();
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      prepareFile(file);
      const s = fsx.createWriteStream(file, { flags: "a" });
      s.on("error", (err) => onStreamError(s, err));
      stream = s;
      return true;
    } catch (err) {
      registerFailure(err);
      return false;
    }
  };

  /** 把 main.log → .1 → … → .keep 依次后移，最老的一份先删。某一份不存在就跳过；其它错误抛给调用方。 */
  const shiftBackups = (file) => {
    for (let i = keep; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      if (i === keep) fsx.rmSync(to, { force: true });
      try {
        fsx.renameSync(from, to);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
  };

  const rotatedNote = () =>
    noteLine(`main.log 已轮转（单文件上限 ${Math.round(maxBytes / 1048576)}MB、保留 ${keep} 份）`);
  const rotateFailedNote = (err) =>
    noteLine(
      `main.log 轮转失败（${codeOf(err)}）：继续追加原文件，${Math.round(rotateRetryMs / 60_000)} 分钟内不再重试`,
    );

  const sizeOf = (file) => {
    try {
      return fsx.statSync(file).size;
    } catch {
      return 0; // 文件还不存在 / 量不到：按 0 起算（量不到时写入多半也会失败，由写入错误那条路处理）
    }
  };

  /** 启动 / 重新打开之前：量一次大小；超限就先轮转（此时没有打开的流，同步做完）。fileBytes 在这里对齐磁盘。 */
  const prepareFile = (file) => {
    let size = sizeOf(file);
    if (size >= maxBytes && nowMs() >= rotateBackoffUntil) {
      try {
        shiftBackups(file);
        rotateBackoffUntil = 0;
        enqueue(rotatedNote(), { front: true });
        size = 0;
      } catch (err) {
        rotateBackoffUntil = nowMs() + rotateRetryMs;
        enqueue(rotateFailedNote(err), { front: true });
      }
    }
    fileBytes = size;
  };

  /** 运行中的轮转：先 end() 等流 close（Windows 上打开着的文件不能 rename），再后移备份、重开。期间新行排队。 */
  const rotate = () => {
    if (rotating || !stream) return;
    rotating = true;
    const old = stream;
    stream = null;
    const finish = () => {
      try {
        shiftBackups(getLogFile());
        rotateBackoffUntil = 0;
        enqueue(rotatedNote(), { front: true });
      } catch (err) {
        rotateBackoffUntil = nowMs() + rotateRetryMs;
        enqueue(rotateFailedNote(err), { front: true });
      }
      rotating = false;
      drain();
    };
    if (old.closed || old.destroyed) {
      finish();
      return;
    }
    old.once("close", finish);
    try {
      old.end();
    } catch {
      // end 抛了（极少见）：当它已坏、直接往下走
      old.removeListener("close", finish);
      finish();
    }
  };

  const maybeRotate = () => {
    if (rotating || !stream) return;
    if (fileBytes < maxBytes) return;
    if (nowMs() < rotateBackoffUntil) return;
    rotate();
  };

  function drain() {
    if (rotating || queue.length === 0) return;
    if (degradedUntil !== null) {
      if (nowMs() < degradedUntil) return;
      degradedUntil = null; // 到点：再试一次
    }
    // 流已被销毁（写失败后 error 事件还在路上）：别往里写——那一行会被悄悄吞掉；当它不存在、换新流（失败由 error 事件记账）
    if (stream?.destroyed) stream = null;
    if (!stream && !open()) return; // 打开失败：行留在队列里，registerFailure 已记账
    if (dropped > 0 && wasDegraded) {
      queue.unshift(noteLine(`main.log 降级期间有 ${dropped} 行日志因超出暂存上限被丢弃`));
      dropped = 0;
    }
    while (queue.length > 0) {
      const line = queue.shift();
      const current = stream;
      if (!current) {
        queue.unshift(line);
        return;
      }
      try {
        current.write(`${line}\n`, (err) => {
          // 失败由 'error' 事件那条路记账；这里只在成功时清零连续失败数，并在从降级中恢复时留一行
          if (err) return;
          if (consecutiveErrors > 0) {
            consecutiveErrors = 0;
            if (wasDegraded) {
              wasDegraded = false;
              enqueue(noteLine("main.log 已恢复写入"));
            }
          }
        });
      } catch (err) {
        queue.unshift(line);
        onStreamError(current, err);
        return;
      }
      fileBytes += Buffer.byteLength(line) + 1;
    }
    maybeRotate();
  }

  /** 与改前 `log(...args)` 同签名同格式：先回显 console（dev 看终端），再落盘；任何失败都不抛 */
  const log = (...args) => {
    const line = `[${stamp()}] ${args.join(" ")}`;
    safeConsole("log", line);
    enqueue(line);
    drain();
  };

  /**
   * 致命路径用（uncaughtException 之类）：同步追加一行到当前 main.log，不经队列 / 流——进程可能下一刻就没了，异步写不一定来得及。
   * 失败（磁盘满 / 目录没了）静默，致命路径里不能再抛；与流的异步写入互不等待（行首有时间戳，顺序以时间戳为准）。
   */
  const logSync = (...args) => {
    const line = `[${stamp()}] ${args.join(" ")}`;
    safeConsole("log", line);
    try {
      const file = getLogFile();
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      fsx.appendFileSync(file, `${line}\n`);
    } catch {
      // 写不进去就算了
    }
  };

  const state = () => ({
    queued: queue.length,
    dropped,
    degraded: degradedUntil !== null,
    consecutiveErrors,
    lastErrorCode,
    rotating,
    hasStream: stream !== null,
    rotateBackoffUntil,
    fileBytes,
  });

  return { log, logSync, state };
};
