/**
 * 预览窗里「能不能编辑 / 保存」的路径策略
 *
 * 读预览对任意本地绝对路径开放（loopback 单用户桌面端，见 read-local-file）；**写**不能同样放开——
 * 一个能把任意路径写成任意内容的 HTTP 接口，等于给本机上任何网页 / 进程一个写文件原语。
 * 所以写入范围收到「用户在 Flowship 里本来就在让 agent 改的那些地方」：
 *
 *   1. 任务关联仓库（任何任务的 repoPaths）里的文件；
 *   2. 任务隔离工作区（<数据目录>/worktrees/**）；
 *   3. 任务数据目录里只有 `actions/`（产物）与 `workspace/`（agent 的落点）——
 *      meta.json / events.jsonl 这类任务状态文件**不可编辑**，改坏会让任务无法加载；
 *   并且任何位置的 `.git/` 目录内文件一律不可编辑（hooks 改一下就是任意命令执行）。
 *
 * 路径比较统一用 realpath 之后的结果：symlink 指到范围外的文件会被挡住，指进来的会被放行（它就是范围内的文件）。
 * 范围外的文件照样能预览，只是没有「编辑」入口；真要改请用 IDE。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "@/lib/server/data-root";

export interface EditRoots {
  /** 数据根目录（realpath 后） */
  dataRoot: string;
  /** 任务关联仓库根（realpath 后，已去重） */
  repoRoots: string[];
}

/** 任务数据目录里允许编辑的子目录名（见文件头 3） */
const EDITABLE_TASK_SUBDIRS = new Set(["actions", "workspace"]);

/** darwin / win32 默认大小写不敏感：路径比较折叠大小写（Linux 区分大小写，不折叠） */
const foldCase = (p: string): string =>
  process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;

const isInside = (child: string, root: string): boolean => {
  const rel = path.relative(foldCase(root), foldCase(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** 纯函数：给定（已 realpath 的）文件路径与范围，返回不可编辑的原因；可编辑返回 null */
export const editBlockReason = (realFile: string, roots: EditRoots): string | null => {
  if (realFile.split(/[\\/]/).some((seg) => seg.toLowerCase() === ".git")) {
    return "不能编辑 .git 目录里的文件";
  }

  const tasksDir = path.join(roots.dataRoot, "tasks");
  if (isInside(realFile, tasksDir)) {
    const parts = path.relative(foldCase(tasksDir), foldCase(realFile)).split(path.sep);
    // parts = [任务id, 子目录, ...文件]：至少要落在某个允许的子目录之下
    if (parts.length >= 3 && EDITABLE_TASK_SUBDIRS.has(parts[1]!)) return null;
    return "任务状态文件不能在这里编辑（只有产物和 workspace 里的文件可以）";
  }
  if (isInside(realFile, path.join(roots.dataRoot, "worktrees"))) return null;
  if (isInside(realFile, roots.dataRoot)) return "应用数据目录里的这个文件不能在这里编辑";

  if (roots.repoRoots.some((r) => isInside(realFile, r))) return null;
  return "只能编辑任务关联仓库、任务工作区和产物里的文件，其它位置请用 IDE";
};

const realpathOrResolve = async (p: string): Promise<string> => {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
};

const ROOTS_TTL_MS = 5_000;
let cached: { at: number; roots: EditRoots } | null = null;
let override: (() => Promise<EditRoots>) | null = null;

/** 测试注入：绕开真实任务列表（传 null 恢复默认） */
export const __setEditRootsForTest = (fn: (() => Promise<EditRoots>) | null): void => {
  override = fn;
  cached = null;
};

/**
 * 当前的可编辑范围。任务列表要读盘，预览窗每次打开都问一遍太浪费，缓存 5 秒
 * （新建任务后最多 5 秒内它的仓库文件还不能编辑，换来不用每次 list 全部任务）。
 */
export const getEditRoots = async (): Promise<EditRoots> => {
  if (override) return override();
  const now = Date.now();
  if (cached && now - cached.at < ROOTS_TTL_MS) return cached.roots;
  // 动态 import：task-fs 是个很大的模块，只在真有人问「能不能编辑」时才加载
  const { listTasks } = await import("@/lib/server/task-fs");
  const tasks = await listTasks();
  const repoRoots = new Set<string>();
  for (const t of tasks) {
    for (const p of t.repoPaths ?? []) {
      if (typeof p === "string" && path.isAbsolute(p)) repoRoots.add(await realpathOrResolve(p));
    }
  }
  const roots: EditRoots = {
    dataRoot: await realpathOrResolve(dataRoot()),
    repoRoots: [...repoRoots],
  };
  cached = { at: now, roots };
  return roots;
};
