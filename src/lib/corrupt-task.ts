/**
 * 「损坏的任务」的对外形状（服务端 listTasksWithCorrupt 产出、GET /api/tasks 的 `corrupt` 字段透传，
 * 前端侧栏 / 会话管理后续据此展示）。
 *
 * 为什么是独立数组、而不是塞进 TaskSummary[]：listTasks 的结果会被所有权 / boot recovery /
 * 飞书桥接 / 搜索等逻辑当「真任务」遍历，假任务混进去会被它们误当成真的。
 * 纯类型 + 纯函数（不依赖 server / React），client 与 server 共用。
 * 末尾的 normalizeCorruptTasks / sameCorruptTasks 是 client 拉列表时用的：响应来自网络、
 * 可能缺字段（旧服务端没有 corrupt）、也可能比本版本多出新类别，不能直接信 TypeScript 类型。
 */

/**
 * 损坏类别：
 * - empty：meta.json 是空文件（典型：崩溃 / 断电时 rename 已落盘、数据块没落盘）
 * - invalid_json：内容不是合法 JSON
 * - schema_mismatch：JSON 合法但不符合当前版本 schema（手改出错 / V0.5 残留 /
 *   新版写入了新枚举后回滚到旧版）
 * - read_error：读文件本身失败（EACCES / EIO 等），不一定是内容坏、可能是瞬时故障
 */
export type CorruptTaskKind =
  | "empty"
  | "invalid_json"
  | "schema_mismatch"
  | "read_error";

export interface CorruptTaskInfo {
  id: string;
  kind: CorruptTaskKind;
  /** 给人看的损坏原因（只含类别 / schema 出错字段路径 / errno，不回显文件内容） */
  reason: string;
  /** meta.json 绝对路径：用户手动修复 / 对照 .bak 时定位 */
  metaPath: string;
  /**
   * 同目录 meta.json.bak 是否存在且通过校验。
   * true = 重启应用时会自动用它恢复（见 task-fs restoreMetaFromBackup），不用手工修。
   */
  backupValid: boolean;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<CorruptTaskKind>([
  "empty",
  "invalid_json",
  "schema_mismatch",
  "read_error",
]);

/**
 * 把 GET /api/tasks 响应里的 `corrupt` 字段规整成 CorruptTaskInfo[]（永不抛、永不返回 undefined）。
 *
 * 容错口径（都按「宁可多提示、不可少提示、也不可多承诺」）：
 *  - 字段缺失 / 不是数组（旧服务端、没有损坏时服务端不带字段）→ []；
 *  - 条目不是对象、或 id 不是非空字符串 → 丢弃（没有 id 就没法告诉用户是哪个任务）；
 *  - kind 不认识（服务端比本版本新、加了新类别）→ 当 read_error 保留：它是语义最保守的一类
 *    （「不确定是不是内容坏」），展示端据此不会承诺「会自动恢复」；原因文案仍用服务端给的 reason；
 *  - backupValid 不是布尔 → false（不承诺自动恢复）；reason / metaPath 不是字符串 → 空串。
 */
export const normalizeCorruptTasks = (raw: unknown): CorruptTaskInfo[] => {
  if (!Array.isArray(raw)) return [];
  const out: CorruptTaskInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.trim() === "") continue;
    out.push({
      id: o.id,
      kind:
        typeof o.kind === "string" && KNOWN_KINDS.has(o.kind)
          ? (o.kind as CorruptTaskKind)
          : "read_error",
      reason: typeof o.reason === "string" ? o.reason : "",
      metaPath: typeof o.metaPath === "string" ? o.metaPath : "",
      backupValid: o.backupValid === true,
    });
  }
  return out;
};

/**
 * 两份损坏列表是否逐项相同。
 * 列表 hook 每次刷新（运行中每 2s 一次）都会拿到新数组，内容没变时沿用旧引用，
 * 免得侧栏底部的提示（及其展开的弹层）跟着白白重渲染。
 */
export const sameCorruptTasks = (
  a: readonly CorruptTaskInfo[],
  b: readonly CorruptTaskInfo[],
): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    return (
      x.id === y.id &&
      x.kind === y.kind &&
      x.reason === y.reason &&
      x.metaPath === y.metaPath &&
      x.backupValid === y.backupValid
    );
  });
