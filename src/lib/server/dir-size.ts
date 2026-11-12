/**
 * 目录占用字节数（会话管理页「占用」统计用）。
 *
 * 优先 `du -sk`（块大小 1KB → ×1024 得字节）；mac/linux 才走。
 * 为什么：前端仓 worktree 里 node_modules 几十万文件，Node readdir 递归要分钟级，
 * du 走内核元数据、秒级（但 3~8GB 的工作区实测仍要 5~19 秒、同时吃满磁盘——所以调用方必须缓存，
 * 见 storage-size-cache.ts；每次打开页面都量一遍会把整台机器拖慢）。
 *
 * 失败语义（评审 R15-02）：
 * - `du` 遇到不可读 / 被并发删掉的文件（活 worktree 里 agent 正在装依赖 / 构建 / 删文件，很常见）会**输出合计并以退出码 1 结束**。
 *   promisify(execFile) 因此抛错、合计在 `err.stdout` 里——先捞出来用，不能丢掉再去走更慢的路。
 * - `du` 在但没量成（超时 / 被杀 / 没有任何输出）：返回 `null`（量不出），**不回退**无超时的逐文件遍历——
 *   几十万文件要分钟级，单路后台队列会被它堵死。调用方保留旧值并按「量不出」处理。
 * - 只有 `du` 根本不存在（ENOENT）或 Windows 才走 Node 遍历，且带整体期限（超时同样返回 null）。
 *
 * 注意口径：`du -sk` 是磁盘块占用；Node 遍历累加的是文件表观大小（pnpm 硬链接还会重复计）。
 * 两条路径的数字不可直接比较——所以同一个 key 不会在两条路径间来回切换（有 du 就只用 du）。
 *
 * 从 /api/system/storage 路由抽出来：路由与后台量尺队列共用同一份实现。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `du -sk` 超时（大仓偶发慢、别无限挂） */
const DU_TIMEOUT_MS = 120_000;
/**
 * Node 遍历整体期限（只有没有 du / Windows 才会走到；超了放弃、返回 null）。
 * 评审 R16-06：Windows 上遍历是串行 `fs.stat`，十几万文件的 node_modules 可能超过 2 分钟，超时 → 记失败 →
 * 5 分钟后重试同样超时，永远没有数字。放宽到 5 分钟；不再放宽是因为后台量尺是**单路队列**，
 * 一个超大目录会堵住排在它后面的所有工作区。真量不完的目录仍返回 null（页面显示「量不出」、不影响其它行）。
 * 没有在真 Windows 上量过实际耗时。
 */
export const WALK_DEADLINE_MS = 300_000;

class WalkDeadlineError extends Error {}

// 递归算目录字节数（软链不跟、避免环）——du 不可用时的回退。超过 deadline（Date.now() 毫秒）抛 WalkDeadlineError
const dirSizeWalk = async (dir: string, deadline: number): Promise<number> => {
  if (Date.now() > deadline) throw new WalkDeadlineError();
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (Date.now() > deadline) throw new WalkDeadlineError();
    const p = path.join(dir, e.name);
    try {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        total += await dirSizeWalk(p, deadline);
      } else if (e.isFile()) {
        total += (await fs.stat(p)).size;
      }
    } catch (err) {
      if (err instanceof WalkDeadlineError) throw err;
      /* 单个文件读不到不挡整表 */
    }
  }
  return total;
};

/** 解析 du 输出（形如 "12345\t/path" 或 "12345 /path"）→ KB；解析不了 = null */
const parseDuKb = (stdout: string): number | null => {
  const kb = parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
  return Number.isFinite(kb) && kb >= 0 ? kb : null;
};

/**
 * 目录字节数；目录不存在 = 0；**量不出 = null**（见文件头「失败语义」）。
 * `walkDeadlineMs` 仅测试注入（缩短 Node 遍历期限）。
 */
export const dirSize = async (
  dir: string,
  opts: { walkDeadlineMs?: number } = {},
): Promise<number | null> => {
  // 目录不存在直接 0（任务没建过 worktree 很常见）
  try {
    await fs.access(dir);
  } catch {
    return 0;
  }
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileAsync("du", ["-sk", dir], {
        timeout: DU_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      const kb = parseDuKb(stdout);
      if (kb !== null) return kb * 1024;
      return null; // du 正常退出却没有可解析的输出：当量不出
    } catch (err) {
      const e = err as { code?: unknown; stdout?: unknown };
      // 非 0 退出但合计已经输出了（遇到不可读 / 被并发删掉的文件）：用它
      const salvaged = parseDuKb(typeof e.stdout === "string" ? e.stdout : "");
      if (salvaged !== null) return salvaged * 1024;
      // du 在、但没量成（超时 / 被杀 / 无权限且无输出）：不回退无超时的逐文件遍历
      if (e.code !== "ENOENT") return null;
      // du 没装：走下面的 Node 遍历
    }
  }
  try {
    return await dirSizeWalk(dir, Date.now() + (opts.walkDeadlineMs ?? WALK_DEADLINE_MS));
  } catch (err) {
    if (err instanceof WalkDeadlineError) return null;
    throw err;
  }
};

/** 简易并发池：对 items 跑 fn、最多 concurrency 路同时跑；结果按入参顺序对应（不受完成先后影响） */
export const mapPool = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (idx < items.length) {
        const cur = idx++;
        out[cur] = await fn(items[cur]);
      }
    },
  );
  if (items.length > 0) await Promise.all(workers);
  return out;
};
