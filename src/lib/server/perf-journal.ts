/**
 * 结构化性能日志：JSONL、按大小轮转（不截断）。
 *
 * 与 timing-log.ts 的分工：那个超 512KB 只留尾部 300 行，适合「只看最近几次慢发送」；
 * 这里的数据要长期积累、供 scripts/perf-report.mjs 做分布 / 趋势分析，所以轮转保留：
 * file、file.1 … file.(keep-1)，合计 ≤ keep × maxBytes（默认 16MB）。
 *
 * 只写结构化数字与 id，绝不写 prompt / 命令 / 工具参数 / 输出等内容——这是调用方的责任，
 * 本模块只保证「单条超大时降级为只留标识」，防一条异常数据撑爆轮转。
 *
 * 写入全部串行（一条链）：并发 append 的顺序 = 调用顺序，轮转不会和写入交错；
 * 链上永不 reject，一条写失败不拖累后面的。写失败只 debug 级别出声，绝不影响主流程。
 */
import path from "node:path";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";

import { dataRoot } from "./data-root";

export interface JournalOptions {
  /** 日志目录 */
  dir: string;
  /** 单文件上限：写入前发现会超就先轮转（默认 4MB） */
  maxBytes?: number;
  /** 保留文件数（含当前文件，默认 4） */
  keep?: number;
}

export interface Journal {
  /** 追加一条记录（自动补 ts）。永不 reject。 */
  append(file: string, record: Record<string, unknown>): Promise<void>;
  /** 等当前已排队的写入全部落盘（测试 / 退出前用） */
  flush(): Promise<void>;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_KEEP = 4;
/** 单条记录序列化后的上限：超出降级为只留标识 */
const MAX_LINE_BYTES = 32 * 1024;

const rotate = async (full: string, keep: number): Promise<void> => {
  if (keep <= 1) {
    await rm(full, { force: true });
    return;
  }
  // 删最老的、依次后移：file.(keep-2) → file.(keep-1) … file → file.1
  await rm(`${full}.${keep - 1}`, { force: true });
  for (let i = keep - 2; i >= 1; i--) {
    await rename(`${full}.${i}`, `${full}.${i + 1}`).catch(() => undefined);
  }
  await rename(full, `${full}.1`).catch(() => undefined);
};

const serialize = (record: Record<string, unknown>): string => {
  let line = JSON.stringify(record);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    line = JSON.stringify({
      ts: record.ts,
      truncated: true,
      keys: Object.keys(record).slice(0, 40),
      taskId: record.taskId,
    });
  }
  return line;
};

export const createJournal = (opts: JournalOptions): Journal => {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = opts.keep ?? DEFAULT_KEEP;
  let chain: Promise<void> = Promise.resolve();

  const write = async (
    file: string,
    record: Record<string, unknown>,
  ): Promise<void> => {
    const line = serialize({ ts: new Date().toISOString(), ...record }) + "\n";
    await mkdir(opts.dir, { recursive: true });
    const full = path.join(opts.dir, file);
    const st = await stat(full).catch(() => null);
    if (st && st.size > 0 && st.size + Buffer.byteLength(line) > maxBytes) {
      await rotate(full, keep);
    }
    await appendFile(full, line, "utf-8");
  };

  const append = (
    file: string,
    record: Record<string, unknown>,
  ): Promise<void> => {
    const task = chain.then(() => write(file, record));
    // 链上永不 reject：一条写失败不能让后面的全卡死
    chain = task.catch(() => undefined);
    return task.catch((err) => {
      // 与 timing-log 同口径：debug 级别、正常路径零噪音
      console.debug(`[perf-journal] 写入 ${file} 失败:`, err);
    });
  };

  return { append, flush: () => chain };
};

// ───────── 进程级默认实例 ─────────

const G = globalThis as unknown as { __fePerfJournal?: Journal };

/**
 * 默认实例会不会真落盘。单测内不落盘：防 data/ 污染 + 并行 worker 互扰
 * （vitest 置 NODE_ENV=test）。调用方可据此在「反正不会写」时跳过构建记录的开销。
 */
export const perfJournalEnabled = (): boolean =>
  !(process.env.NODE_ENV === "test" || process.env.VITEST);

/**
 * 默认实例（数据目录 / logs）——要测落盘行为请直接用 createJournal 指向临时目录。
 */
const defaultJournal = (): Journal | null => {
  if (!perfJournalEnabled()) return null;
  return (G.__fePerfJournal ??= createJournal({
    dir: path.join(dataRoot(), "logs"),
  }));
};

/** 火忘追加一条结构化记录（自动补 ts）。永不抛、永不阻塞调用方。 */
export const appendPerfRecord = (
  file: string,
  record: Record<string, unknown>,
): void => {
  void defaultJournal()?.append(file, record);
};
