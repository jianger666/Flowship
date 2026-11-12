/**
 * 会话管理页「清理缓存」的类型与文案（纯逻辑，client / server 共用；单测见 tests/cache-cleanup-text.test.ts）。
 * 接口见 app/api/system/storage/caches/route.ts，清理逻辑见 server/session-cache-release.ts。
 */

/** GET /api/system/storage/caches */
export interface CachesSummary {
  /** 已归档、却仍握着会话锚点的任务数（**可清理的**：不含下面保留的老任务） */
  archivedHolders: number;
  /**
   * 老任务（没有 provider 字段、锚点是自定义形态）：锚点是它「用哪家提供方」的唯一证据，不清（评审 R16-03）。
   * 可缺省（老版本接口 / 测试夹具没有这个字段）= 0。
   */
  legacyKept?: number;
  /** 其中自定义提供方会话文件的总字节（Cursor 会话在共享 store 里、量不出按任务的大小） */
  archivedPiBytes: number;
  /** 无任务引用的孤儿会话文件 */
  orphanFiles: number;
  orphanBytes: number;
  /** 活名单读不出（某个任务 meta 坏了）→ 孤儿文件这一类本轮不动、也没法数 */
  orphanSkipped: boolean;
}

/** POST /api/system/storage/caches */
export interface CachesCleanupResult {
  ok: true;
  /** 放掉会话缓存的已归档任务数 */
  released: number;
  /** 会话在忙 / 有收尾流程在管，这次没动的 */
  skippedBusy: number;
  /** 想放但条件不符（又被接管了）没动的 */
  skippedKept: number;
  /** 老任务（没有 provider 字段、锚点是自定义形态）保留了锚点、没动的（R16-03）。可缺省 = 0 */
  skippedLegacy?: number;
  /** 已归档任务名下顺带删掉的会话文件字节 */
  piBytesFreed: number;
  orphanFilesDeleted: number;
  orphanBytesFreed: number;
  orphanSkipped: boolean;
  /** 是否触发了 SDK store GC（实际回收看它自己的宽限 / 下限） */
  gcTriggered: boolean;
}

export const formatCacheBytes = (n: number): string => {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

/** 活名单读不出时的说明：孤儿文件这一类没法判断（宁可少清不误删），不是「没有」 */
const ORPHAN_SKIPPED_NOTE = "有会话的数据读不出来，没引用的对话文件这次不动";

/** 老任务保留锚点的说明：为什么没清、清了会怎样 */
const legacyKeptNote = (n: number): string =>
  `${n} 个较早创建的会话没有记录提供方、要靠这份缓存判断用哪家模型，已保留`;

/**
 * 没有任何**可清理**的东西（按钮点下去先问一句，没东西就别弹确认框）。
 * 注意：`orphanSkipped` 时孤儿那一类是「没法判断」而不是「没有」——这里仍判 true（没有已知可清的），
 * 但提示语必须用 {@link buildNothingToCleanMessage}，别直接说「没有需要清理的缓存」（评审 R15-16）。
 */
export const isNothingToClean = (s: CachesSummary): boolean =>
  s.archivedHolders === 0 && s.orphanFiles === 0;

/** 「没东西可清」时给用户的话：区分「确实没有」与「有一类没法判断」 */
export const buildNothingToCleanMessage = (s: CachesSummary): string => {
  const base = s.orphanSkipped
    ? `已归档的会话没有缓存可放；${ORPHAN_SKIPPED_NOTE}（并不是确认没有）`
    : "没有需要清理的缓存";
  return s.legacyKept ? `${base}（另有 ${legacyKeptNote(s.legacyKept)}）` : base;
};

/** 确认框正文：说清清什么、不清什么、后果是什么 */
export const buildCachesConfirmDescription = (s: CachesSummary): string => {
  const parts: string[] = [];
  if (s.archivedHolders > 0) {
    const size = s.archivedPiBytes > 0 ? `，其中会话文件约 ${formatCacheBytes(s.archivedPiBytes)}` : "";
    parts.push(`${s.archivedHolders} 个已归档的会话还占着对话缓存${size}`);
  }
  if (s.orphanFiles > 0) {
    parts.push(`${s.orphanFiles} 个没有任何会话引用的对话文件（约 ${formatCacheBytes(s.orphanBytes)}）`);
  }
  const head = `将清理：${parts.join("；")}。`;
  const tail =
    "会话内容、事件记录和代码都不受影响；已归档的会话取消归档后，下一条消息会从事件记录重新接上对话。" +
    "对话缓存占的空间由后台回收，不一定立刻变小。";
  const notes = [
    s.orphanSkipped ? `${ORPHAN_SKIPPED_NOTE}。` : "",
    s.legacyKept ? `另有 ${legacyKeptNote(s.legacyKept)}。` : "",
  ].filter(Boolean);
  return `${head}${tail}${notes.length > 0 ? `（${notes.join("")}）` : ""}`;
};

/** 清理完的 toast：只说实际做了什么；在忙的跳过要如实说 */
export const buildCachesCleanedToast = (r: CachesCleanupResult): string => {
  const parts: string[] = [];
  if (r.released > 0) {
    parts.push(
      `已放掉 ${r.released} 个已归档会话的缓存${r.piBytesFreed > 0 ? `（释放 ${formatCacheBytes(r.piBytesFreed)}）` : ""}`,
    );
  }
  if (r.orphanFilesDeleted > 0) {
    parts.push(`删除 ${r.orphanFilesDeleted} 个无引用的对话文件（${formatCacheBytes(r.orphanBytesFreed)}）`);
  }
  const skipped = r.skippedBusy + r.skippedKept;
  if (skipped > 0) parts.push(`${skipped} 个会话正忙或刚被接管、这次没动`);
  if (r.skippedLegacy) parts.push(legacyKeptNote(r.skippedLegacy));
  // 孤儿那类没法判断时必须说出来：不然用户会以为「没引用的对话文件」已经检查过、没有
  if (r.orphanSkipped) parts.push(ORPHAN_SKIPPED_NOTE);
  if (parts.length === 0) return "没有需要清理的缓存";
  return parts.join("、");
};
