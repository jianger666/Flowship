/**
 * SDK store 旁路目录 `.quarantine/`：从主文件里挪出来的 run_events 内容（只作取证 / 回滚用）。
 *
 * 两类来源，同一目录、同一命名 `run_events-<13 位毫秒时间戳>.ndjson`、同一份保留策略（最近 5 份）：
 *   1. GC 自愈隔离走的坏记录（sdk-store-gc.ts → healRunEventsFile）；
 *   2. 改用内存版 run_events（memory-run-events.ts）后，首次打开 store 时把旧的
 *      `run_events.ndjson` 整个挪进来（本文件 archiveLegacyRunEvents）。
 *
 * 独立成叶子模块：sdk-agent-store.ts 要调归档，而 sdk-store-gc.ts 又依赖 sdk-agent-store.ts，
 * 放在 GC 里会形成循环依赖。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { withRetry, type RetryOptions } from "./fast-checkpoint-store";

export const RUN_EVENTS_FILENAME = "run_events.ndjson";

/** 被挪出的 run_events 内容放这个子目录（SDK 只读固定文件名，不会扫到它） */
export const QUARANTINE_DIRNAME = ".quarantine";
/** 旁路文件最多留几份（只作取证用，不无限堆） */
export const KEEP_QUARANTINE = 5;

/** 旁路文件名带 13 位毫秒时间戳，字典序即时间序 */
export const quarantineFileName = (now: number): string =>
  `run_events-${now}.ndjson`;

/** 只留最新 KEEP_QUARANTINE 份；尽力而为，失败不影响调用方 */
export const pruneQuarantine = async (qDir: string): Promise<void> => {
  try {
    const names = (await fs.readdir(qDir))
      .filter((n) => n.startsWith("run_events-") && n.endsWith(".ndjson"))
      .sort();
    while (names.length > KEEP_QUARANTINE) {
      await fs.rm(path.join(qDir, names.shift()!), { force: true });
    }
  } catch {
    /* best-effort */
  }
};

export interface LegacyRunEventsArchiveResult {
  /**
   * none     = 没有旧文件 / 是空文件，什么都没动；
   * archived = 已整个挪进 `.quarantine/`；
   * skipped  = 想挪但失败了（旧文件保持原样，调用方照常往下走）。
   */
  status: "none" | "archived" | "skipped";
  /** 被挪走的字节数（仅 archived） */
  bytes?: number;
  /** 旁路文件绝对路径（仅 archived） */
  file?: string;
  reason?: string;
}

export interface LegacyRunEventsArchiveOptions {
  /** 覆盖当前时间（单测用，决定旁路文件名） */
  now?: number;
  /** 覆盖 rename 的重试参数（单测注入平台 / 免真等；生产不传） */
  retry?: RetryOptions;
}

/**
 * 把旧的 `<dir>/run_events.ndjson` 整个挪进 `<dir>/.quarantine/run_events-<ts>.ndjson`。
 *
 * 为什么要挪：SDK 自带实现对这个文件的**每次** append / list 都是「整文件读入 + 逐行 JSON.parse
 * + 整文件重写」（O(文件大小)），实测 18.5MB 时单次 append 243ms。改用内存版以后这个文件
 * 不会再被追加，里面只剩历史流式增量（SDK 回放 run 用的衍生数据，Flowship 不读，会话恢复走
 * events.jsonl）；留着只会让 `runs.delete` 经 SDK 自带 `runEvents.delete` 去整文件重写它。
 * 挪走而不是删：可逆（切回 `FLOWSHIP_SDK_RUN_EVENTS=file` 并把文件放回去即可）。
 *
 * 绝不抛：失败 = `skipped`，旧文件保持原样（最坏回到「SDK 自带实现读写它」之前的行为）。
 */
export const archiveLegacyRunEvents = async (
  dir: string,
  opts?: LegacyRunEventsArchiveOptions,
): Promise<LegacyRunEventsArchiveResult> => {
  const file = path.join(dir, RUN_EVENTS_FILENAME);
  try {
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      return { status: "none" };
    }
    // 空文件：SDK 的 runs.delete 会顺手建一个空的，没必要挪
    if (size === 0) return { status: "none" };

    const qDir = path.join(dir, QUARANTINE_DIRNAME);
    await fs.mkdir(qDir, { recursive: true, mode: 0o700 });
    const dest = path.join(qDir, quarantineFileName(opts?.now ?? Date.now()));
    await withRetry(() => fs.rename(file, dest), opts?.retry);
    await pruneQuarantine(qDir);
    return { status: "archived", bytes: size, file: dest };
  } catch (err) {
    console.warn("[sdk-store] 旧 run_events.ndjson 归档失败（保持原样，不影响使用）:", err);
    return {
      status: "skipped",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
