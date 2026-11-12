/**
 * 会话缓存释放（2026-11-12：归档 = 这个会话不再「活着」，它占的缓存要放掉）。
 *
 * 背景：任务落盘的 `sessionAgentId` 是「下次操作 Agent.resume 接回会话」的锚点，空闲回收（12 分钟）只关内存、
 * **不清锚点**。可归档之后永远不会再 resume，锚点却一直在：
 *   - Cursor SDK：sdk-agent-store 的 GC 把「任何任务现行 sessionAgentId」当活会话保护，归档任务的 checkpoints
 *     因此永远不被回收（实测 3.2 GB 里 2.65 GB 属于已归档任务）；
 *   - 自定义提供方（pi）：会话文件落在 `<dataRoot>/pi-sessions/*.jsonl`，没有任何东西会删它
 *     （实测 182 个已归档任务的文件 254 MB，另有 496 个无任务指向的孤儿文件 716 MB）。
 *
 * 这里做三件事，全部 best-effort、绝不抛、绝不碰在忙的会话：
 *   1. {@link releaseTaskSessionCache}：归档时关掉空闲的内存会话 → 条件清盘上锚点 → 无人再引用就删 pi 会话文件；
 *   2. {@link listArchivedSessionHolders}：历史上已归档、却仍握着锚点的任务（会话管理页「清理无用缓存」用）；
 *   3. {@link listOrphanPiSessionFiles}：pi-sessions 里没有任何任务指向的孤儿文件（同上）。
 *
 * 为什么放心清：恢复（取消归档）后下一条消息拿不到锚点 → 起新会话、靠事件流回读上下文（与「回退」同一条降级路径）；
 * 事件流（events.jsonl）才是 UI 的数据源，会话缓存只是 agent 侧的上下文加速，丢了不丢任何用户可见内容。
 *
 * 为什么不在归档时顺手跑 SDK store GC：GC 有 10 分钟宽限（刚活动过的 agent 不动），刚归档的会话几乎必在宽限内，
 * 白跑；而对久未活动的会话它会整库流式重写——不该挂在一次归档点击上。空间在下次 boot / 水位触发的 GC 里回收，
 * 或由会话管理页的「清理无用缓存」显式触发。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { providerRestsOnAnchorOnly } from "@/lib/agent-provider";

import { dataRoot, stripBom } from "./data-root";
import { collectLiveAgentIds } from "./sdk-store-gc";
import { clearTaskSessionAgentIdIf, getTaskMeta } from "./task-fs";

/** 孤儿 pi 会话文件的宽限：刚写过的可能是还在跑的旁路会话（问一问 / 评审），不当孤儿 */
export const PI_SESSION_ORPHAN_GRACE_MS = 10 * 60 * 1000;

export const piSessionsDir = (): string => path.join(dataRoot(), "pi-sessions");

/**
 * 锚点是不是 pi-sessions 下的会话文件（自定义提供方的形态）：是 → 规整后的绝对路径；否 → null。
 * 只认「**直接**在 pi-sessions 目录里的 .jsonl」——锚点是数据里读出来的字符串，不能信到拿它去删任意路径；
 * 不接受子目录（`pi-sessions/sub/x.jsonl`）：删除只 lstat 末级，`sub` 若是软链就越界了（评审 R16-09）。
 */
export const piSessionFileOf = (anchor: string | undefined | null): string | null => {
  if (!anchor || !anchor.includes("pi-sessions")) return null;
  const abs = path.resolve(anchor);
  if (path.dirname(abs) !== path.resolve(piSessionsDir()) || !abs.endsWith(".jsonl")) return null;
  return abs;
};

/** 锚点字符串的末级文件名（不依赖路径写法：Windows 反斜杠 / 软链别名 / 数据目录搬过家都认得出） */
const anchorBasename = (anchor: string): string => anchor.split(/[\\/]/).pop() ?? "";

/** 删一个 pi 会话文件（只删普通文件、不跟 symlink）；返回释放的字节数，没删成返回 0。绝不抛。 */
export const deletePiSessionFile = async (file: string): Promise<number> => {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) return 0;
    await fs.rm(file, { force: true });
    return st.size;
  } catch {
    return 0;
  }
};

export interface ReleaseDeps {
  /** 同步关掉**空闲**的内存会话（不清盘上锚点）。在忙（有 run / 后台子代理 / 排队 / 待答 …）返回 "busy"，什么都不动 */
  closeIdleSession: (taskId: string) => "busy" | "closed" | "none";
  /** 内存里是否还有该任务的会话——条件清锚点的守卫（有了就说明被别的流程接管，不能清） */
  hasLiveSession: (taskId: string) => boolean;
}

export interface ReleaseOptions {
  /**
   * 释放那一刻（锁内）复核任务**仍是已归档**，不是就不动（status=kept）。
   * 「清理缓存」这类先列名单、再逐个释放的批量路径必须开：窗口里用户可能已把某个任务取消归档。
   * 归档流程自己调用时不能开——它在「落 archived 标记」之前就释放（见 archiveWorktreeTaskLocked）。
   */
  requireArchived?: boolean;
}

export interface ReleaseResult {
  /**
   * - released：锚点已不再指向任何会话（我清的 / 别处已清）
   * - busy：会话在忙，没动
   * - kept：想清但条件不符（内存里又有会话了 / 盘上锚点已换），没动
   * - legacy：老任务（没有 provider 字段、锚点是自定义形态）——锚点是它「用哪家提供方」的唯一证据，保留（评审 R16-03）
   * - none：任务本来就没有锚点
   */
  status: "released" | "busy" | "kept" | "legacy" | "none";
  /** 顺带删掉的 pi 会话文件字节数 */
  piBytes: number;
}

/**
 * 释放一个任务的会话缓存。调用方负责「该不该释放」（已归档）；本函数负责「现在能不能动」。
 * `task.sessionAgentId` 取调用方手里那份 meta 快照即可：盘上的锚点已变则条件清自然 no-op（kept）。
 */
export const releaseTaskSessionCache = async (
  task: { id: string; sessionAgentId?: string },
  deps: ReleaseDeps,
  opts: ReleaseOptions = {},
): Promise<ReleaseResult> => {
  try {
    // 先看一眼（省得对已被取消归档 / 要保留锚点的任务白关一次空闲会话）；真正的复核在下面锁内的条件清里
    const pre = await getTaskMeta(task.id);
    if (opts.requireArchived && pre?.archived !== true) {
      return { status: "kept", piBytes: 0 };
    }
    const anchor = task.sessionAgentId;
    if (anchor && providerRestsOnAnchorOnly({ provider: pre?.provider, sessionAgentId: anchor })) {
      return { status: "legacy", piBytes: 0 };
    }
    if (deps.closeIdleSession(task.id) === "busy") return { status: "busy", piBytes: 0 };
    if (!anchor) return { status: "none", piBytes: 0 };

    await clearTaskSessionAgentIdIf(task.id, anchor, () => !deps.hasLiveSession(task.id), {
      requireArchived: opts.requireArchived,
      keepProviderEvidence: true,
    });
    // 不管是我清的、还是别处（停止路径的 fire-and-forget 清锚点）先清的：以盘上现状为准。
    // 盘上还有锚点（原样 = 条件不符没清成；换成别的 = 有流程装了新会话）一律不算释放，也不碰文件
    const fresh = await getTaskMeta(task.id);
    if (fresh?.sessionAgentId) {
      // 锁内复核发现「没有 provider 且锚点是自定义形态」（预检之后才变成这样）也算 legacy，不当成「正忙 / 被接管」
      return { status: providerRestsOnAnchorOnly(fresh) ? "legacy" : "kept", piBytes: 0 };
    }

    let piBytes = 0;
    const file = piSessionFileOf(anchor);
    if (file) {
      // 文件只在「没有任何任务再指向它」时删（fork 等路径可能让两个任务共用一条锚点）
      const live = await collectLiveAgentIds();
      if (live && !live.has(anchor)) piBytes = await deletePiSessionFile(file);
    }
    return { status: "released", piBytes };
  } catch (err) {
    console.warn(`[session-cache-release] 释放失败（忽略）task=${task.id}`, err);
    return { status: "kept", piBytes: 0 };
  }
};

export interface ArchivedSessionHolder {
  id: string;
  title: string;
  mode: "chat" | "task";
  sessionAgentId: string;
  /** pi 会话文件大小（Cursor SDK 的会话在共享 store 里、没法按任务拆开量，记 null） */
  piBytes: number | null;
  /**
   * 老任务（没有 provider 字段、锚点是自定义形态）：锚点是它「用哪家提供方」的唯一证据，**不放**（评审 R16-03）。
   * 名单里仍列出（调用方据此数「保留了几个」），但不计入「可清理」。
   */
  keepsProviderEvidence: boolean;
}

/** 已归档、却仍握着会话锚点的任务。读不出 meta 的目录跳过（宁可少列，不误动）。 */
export const listArchivedSessionHolders = async (): Promise<ArchivedSessionHolder[]> => {
  const tasksDir = path.join(dataRoot(), "tasks");
  let names: string[];
  try {
    names = (await fs.readdir(tasksDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: ArchivedSessionHolder[] = [];
  for (const name of names) {
    let meta: {
      archived?: unknown;
      sessionAgentId?: unknown;
      title?: unknown;
      mode?: unknown;
      provider?: unknown;
    };
    try {
      meta = JSON.parse(stripBom(await fs.readFile(path.join(tasksDir, name, "meta.json"), "utf8")));
    } catch {
      continue;
    }
    if (meta.archived !== true) continue;
    if (typeof meta.sessionAgentId !== "string" || !meta.sessionAgentId) continue;
    const file = piSessionFileOf(meta.sessionAgentId);
    let piBytes: number | null = null;
    if (file) {
      try {
        piBytes = (await fs.stat(file)).size;
      } catch {
        piBytes = 0;
      }
    }
    out.push({
      id: name,
      title: typeof meta.title === "string" && meta.title ? meta.title : name,
      mode: meta.mode === "chat" ? "chat" : "task",
      sessionAgentId: meta.sessionAgentId,
      piBytes,
      keepsProviderEvidence: providerRestsOnAnchorOnly({
        provider: typeof meta.provider === "string" ? meta.provider : undefined,
        sessionAgentId: meta.sessionAgentId,
      }),
    });
  }
  return out;
};

export interface OrphanPiFile {
  file: string;
  bytes: number;
}

/**
 * pi-sessions 里没有任何任务的现行 sessionAgentId 指向的文件（旁路会话 / 换新会话后留下的旧文件 / 已删任务的遗留）。
 * 返回 null = 活名单读不出（某个 meta 坏了）→ 整轮不动，宁可少清不误删（口径同 sdk-store-gc）。
 * 最近写过的（宽限内）不算：可能是还在跑的旁路会话。
 */
export const listOrphanPiSessionFiles = async (
  opts: { now?: number; graceMs?: number } = {},
): Promise<OrphanPiFile[] | null> => {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? PI_SESSION_ORPHAN_GRACE_MS;
  const live = await collectLiveAgentIds();
  if (!live) return null;
  const liveFiles = new Set<string>();
  // 再按**文件名**记一份（评审 R16-05）：锚点是创建当时写进 meta 的绝对路径字符串，与当前 `<dataRoot>/pi-sessions` 的写法
  // 对不上时（符号链接别名 / FLOWSHIP_DATA_DIR 前后写法不同 / 数据目录搬过家 / Windows 盘符大小写）`piSessionFileOf`
  // 返回 null，活名单里就没有它——仍被引用的会话文件超过宽限就会被当孤儿删。「读不出 meta」有整体跳过的保护，
  // 「读得出但路径对不上」以前没有。pi 会话文件名是随机的，按文件名并集只会多留、不会误删。
  const liveNames = new Set<string>();
  for (const id of live) {
    const f = piSessionFileOf(id);
    if (f) liveFiles.add(f);
    if (id.includes("pi-sessions")) liveNames.add(anchorBasename(id));
  }
  const dir = path.resolve(piSessionsDir());
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: OrphanPiFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    if (liveFiles.has(file) || liveNames.has(name)) continue;
    try {
      const st = await fs.lstat(file);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < graceMs) continue;
      out.push({ file, bytes: st.size });
    } catch {
      /* 刚被删 / 无权限：跳过 */
    }
  }
  return out;
};
