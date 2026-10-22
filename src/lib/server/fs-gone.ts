/**
 * 「目录被并发删掉了」的错误判定（第五轮 Q3-08）。
 *
 * 背景：迟到的落盘（DELETE 已返回 200，chat-runner / 回退收尾还在写 `checkpoints/`、`tool-outputs/` 等）约定在
 * 任务目录缺失时降级为「不写」。第四轮只认 `ENOENT`——但 **macOS 上并发删除时 `rename` 会抛 `EINVAL`**
 * （目录正在被拆除、目标目录项已无效），不是 `ENOENT`。复审在 macOS 上实测 16 次红 10 次（本机 12 次红 11 次），
 * 而 CI 只有 ubuntu，抓不到。
 *
 * 口径：`ENOENT` 一律算「已不在」（沿用旧行为，不再 stat）；`EINVAL` / `ENOTDIR` 含义宽泛（也可能是真参数错），
 * **只有确认目录真的不在了才算**——先 stat、仍在就短暂退避再看几次（并发 rm 可能还在拆）；一直在 → 当真错误抛回去。
 */
import { promises as fs } from "node:fs";

/** 值得「再确认目录是否已被删」的歧义 errno（真实删除竞态里 macOS / Windows 会抛这些，而不是 ENOENT） */
const AMBIGUOUS_GONE_CODES: ReadonlySet<string> = new Set(["EINVAL", "ENOTDIR"]);

/** 重新确认目录是否还在的退避（ms）：总共 ≤ 100ms，只在出错路径上花 */
const RECHECK_DELAYS_MS = [0, 10, 30, 60] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isAbsent = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(p);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
  }
};

/**
 * `err` 是否表示「`dir`（任务目录 / checkpoints 目录等）已被并发删掉」。
 * @param dir 判断「已被删」所依据的目录（通常是被写入的那层目录；它不在 = 其父任务目录也必然在拆）
 */
export const isDirGoneError = async (err: unknown, dir: string): Promise<boolean> => {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  if (code === "ENOENT") return true;
  if (!code || !AMBIGUOUS_GONE_CODES.has(code)) return false;
  for (const delay of RECHECK_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    if (await isAbsent(dir)) return true;
  }
  return false;
};
