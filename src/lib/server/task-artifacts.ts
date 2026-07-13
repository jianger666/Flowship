/**
 * task artifact / 附件层（V0.9.x 从 task-fs.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责（action artifact 文件 + 用户上传的读写）：
 *   - 用户上传图片（saveImageAttachments、uploads/ 目录）
 *   - artifact 读（readCurrentActionArtifact）
 *   - artifact 快照 revisions（snapshotActionArtifact / listActionRevisions /
 *     readActionRevisionContent / pruneIdenticalRevisions）
 *   - artifact 划除 / 恢复（setActionArtifactExcluded、.excluded/ 隐藏目录物理挪移）
 *
 * 依赖方向（保证无环）：只依赖 types / data-root / task-fs-core、不 import task-fs。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { ActionRecord, ArtifactRevision, Task } from "@/lib/types";
import { dataRoot } from "./data-root";
import {
  ACTIONS_DIR,
  EXCLUDED_SUBDIR,
  MAX_REVISIONS_PER_ACTION,
  REVISIONS_SUBDIR,
  actionArtifactFilename,
  exists,
  hydrateTask,
  readMetaV06,
  sanitizeId,
  taskDir,
  withTaskLock,
  writeMeta,
} from "./task-fs-core";

// ----------------- 用户上传图片（V0.5.4、V0.6 不变）-----------------

const UPLOADS_DIR = "uploads";

const ALLOWED_IMAGE_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// 单图 ≤ 10 MB（base64 解码后字节）
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const newAttachmentId = (): string =>
  `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export interface ImageAttachmentInput {
  data: string;
  mimeType: string;
  filename?: string;
}

export interface ImageAttachmentSaved {
  absPath: string;
  relPath: string;
  mimeType: string;
  bytes: number;
  filename?: string;
}

export const saveImageAttachments = async (
  taskId: string,
  images: ImageAttachmentInput[],
): Promise<ImageAttachmentSaved[]> => {
  if (images.length === 0) return [];
  sanitizeId(taskId);
  const uploadsDir = path.join(taskDir(taskId), UPLOADS_DIR);
  await fs.mkdir(uploadsDir, { recursive: true });

  const saved: ImageAttachmentSaved[] = [];
  for (const img of images) {
    const ext = ALLOWED_IMAGE_MIME[img.mimeType.toLowerCase()];
    if (!ext) {
      throw new Error(
        `不支持的图片 mimeType=${img.mimeType}（仅允许 ${Object.keys(
          ALLOWED_IMAGE_MIME,
        ).join(", ")}）`,
      );
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(img.data, "base64");
    } catch (err) {
      throw new Error(
        `图片 base64 解码失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (buf.length === 0) {
      throw new Error("图片解码后为空、检查上传数据");
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `图片过大：${(buf.length / 1024 / 1024).toFixed(2)} MB（上限 ${
          MAX_IMAGE_BYTES / 1024 / 1024
        } MB）`,
      );
    }
    const id = newAttachmentId();
    const filename = `${id}.${ext}`;
    const absPath = path.join(uploadsDir, filename);
    const relPath = path.relative(dataRoot(), absPath);
    await fs.writeFile(absPath, buf);
    saved.push({
      absPath,
      relPath,
      mimeType: img.mimeType.toLowerCase(),
      bytes: buf.length,
      filename: img.filename,
    });
  }
  return saved;
};

// ----------------- artifact 读 -----------------

/**
 * 读单条 action 的 artifact 内容
 * 返 null：文件不存在 / action 没 artifactPath
 */
const readActionArtifactRaw = async (
  taskId: string,
  action: ActionRecord,
): Promise<{ filename: string; content: string } | null> => {
  if (!action.artifactPath) return null;
  const absPath = path.join(taskDir(taskId), action.artifactPath);
  if (!(await exists(absPath))) return null;
  const content = await fs.readFile(absPath, "utf-8");
  return { filename: action.artifactPath, content };
};

// ----------------- artifact 快照（V0.5.12 → V0.6 改 actionId 维度）-----------------

const isoForFilename = (ts: number): string =>
  new Date(ts).toISOString().replace(/[:.]/g, "-");

/**
 * V0.6：snapshot 当前 action artifact、追加到对应 ActionRecord.revisions
 *
 * 触发时机：action-ack 路由 revise 分支、submitActionAck 调用前调一次。
 *
 * 行为：
 *   - action 没 artifactPath / 文件不存在 / 内容为空 → 返 null、不写、不污染 meta
 *   - 否则复制到 `actions/.revisions/<actionId>/<ISO>.md`、追加到 action.revisions 末尾
 *   - 超过 MAX_REVISIONS_PER_ACTION → GC 删最早（fs 文件 + meta 记录）
 *
 * 失败不抛：snapshot 是辅助、出错不能挡 revise 主流程
 */
export const snapshotActionArtifact = async (
  taskId: string,
  actionId: string,
): Promise<ArtifactRevision | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;

    const action = meta.actions.find((a) => a.id === actionId);
    if (!action || !action.artifactPath) return null;

    const currentAbsPath = path.join(taskDir(taskId), action.artifactPath);
    let content: string;
    try {
      content = await fs.readFile(currentAbsPath, "utf-8");
    } catch {
      return null;
    }
    if (content.trim().length === 0) return null;

    // 最新一份 revision 已与即将快照内容相同 → 跳过写入。
    // 场景：产出审阅中连续插话、AI 没改正文，避免堆一串零差异快照。
    const list = action.revisions ?? [];
    if (list.length > 0) {
      const newest = list[list.length - 1]!;
      try {
        const newestContent = await fs.readFile(
          path.join(taskDir(taskId), newest.path),
          "utf-8",
        );
        if (newestContent === content) return null;
      } catch {
        // 读不到 tail 就继续写新快照（不因坏文件挡主流程）
      }
    }

    const now = Date.now();
    const revRelPath = path.join(
      ACTIONS_DIR,
      REVISIONS_SUBDIR,
      actionId,
      `${isoForFilename(now)}.md`,
    );
    const revAbsPath = path.join(taskDir(taskId), revRelPath);
    await fs.mkdir(path.dirname(revAbsPath), { recursive: true });
    await fs.writeFile(revAbsPath, content, "utf-8");

    const rev: ArtifactRevision = {
      timestamp: now,
      path: revRelPath,
      size: Buffer.byteLength(content, "utf-8"),
    };

    const next = [...list, rev];

    while (next.length > MAX_REVISIONS_PER_ACTION) {
      const oldest = next.shift();
      if (oldest) {
        await fs
          .unlink(path.join(taskDir(taskId), oldest.path))
          .catch(() => {});
      }
    }
    action.revisions = next;
    meta.updatedAt = now;
    await writeMeta(meta);
    return rev;
  });

/**
 * list action-revisions 时是否允许跑 pruneIdenticalRevisions（闸在 route、本函数纯判定）。
 *
 * 时序竞态：question 先 snapshot（此刻快照 === 正文）→ agent 开始改 → 面板刷新触发
 * GET action-revisions → 若立刻 prune，会把这份「暂时相同」的快照当垃圾删掉 → AI 改完后
 * 没快照可比、修订开关不亮。agent 活跃期间（task / 该 action 为 running）只列不清。
 */
export const shouldPruneIdenticalRevisionsOnList = (
  task: Pick<Task, "runStatus" | "actions">,
  actionId: string,
): boolean => {
  if (task.runStatus === "running") return false;
  const action = task.actions.find((a) => a.id === actionId);
  if (action?.status === "running") return false;
  return true;
};

/**
 * 清掉「尾部与当前正文完全相同」的 revision 快照（文件 + meta）。
 *
 * 背景：question 路由对任何插话都先 snapshot（分不清问/改）——用户只问句、AI 没改
 * artifact → 快照 === 正文 → UI 修订开关/红点误亮、打开零差异。
 *
 * 语义：只清尾部连续相同（从最新往旧走、遇第一份不同就停）。历史中间的不同快照
 * 一律保留——那是真改过的版本；多份连续相同一并清（连续插话堆出来的）。
 *
 * 当前 artifact 读不到 / 无 revisions → no-op。走 withTaskLock，与 snapshot / GC 同锁。
 * 调用方（action-revisions GET）须先过 shouldPruneIdenticalRevisionsOnList，running 时勿调。
 */
export const pruneIdenticalRevisions = async (
  taskId: string,
  actionId: string,
): Promise<void> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return;

    const action = meta.actions.find((a) => a.id === actionId);
    if (!action?.revisions?.length || !action.artifactPath) return;

    let current: string;
    try {
      current = await fs.readFile(
        path.join(taskDir(taskId), action.artifactPath),
        "utf-8",
      );
    } catch {
      // 当前 artifact 读不到 → 无法判定相同、不动 revisions
      return;
    }

    // 升序后从尾部 pop：只动「最新往旧」的连续相同段
    const kept = [...action.revisions].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    let removed = false;

    while (kept.length > 0) {
      const newest = kept[kept.length - 1]!;
      let revContent: string;
      try {
        revContent = await fs.readFile(
          path.join(taskDir(taskId), newest.path),
          "utf-8",
        );
      } catch {
        // 文件缺失无法比内容 → 停下，避免误删更早的真历史
        break;
      }
      if (revContent !== current) break;

      await fs
        .unlink(path.join(taskDir(taskId), newest.path))
        .catch(() => {});
      kept.pop();
      removed = true;
    }

    if (!removed) return;

    action.revisions = kept;
    meta.updatedAt = Date.now();
    await writeMeta(meta);
  });

export const listActionRevisions = async (
  taskId: string,
  actionId: string,
): Promise<ArtifactRevision[]> => {
  const meta = await readMetaV06(taskId);
  if (!meta) return [];
  const action = meta.actions.find((a) => a.id === actionId);
  if (!action?.revisions) return [];
  return [...action.revisions].sort((a, b) => a.timestamp - b.timestamp);
};

export const readActionRevisionContent = async (
  taskId: string,
  actionId: string,
  timestamp: number,
): Promise<{ content: string; revision: ArtifactRevision } | null> => {
  const meta = await readMetaV06(taskId);
  if (!meta) return null;
  const action = meta.actions.find((a) => a.id === actionId);
  if (!action?.revisions) return null;
  const rev = action.revisions.find((r) => r.timestamp === timestamp);
  if (!rev) return null;
  const absPath = path.join(taskDir(taskId), rev.path);
  try {
    const content = await fs.readFile(absPath, "utf-8");
    return { content, revision: rev };
  } catch {
    return null;
  }
};

export const readCurrentActionArtifact = async (
  taskId: string,
  actionId: string,
): Promise<{ content: string; filename: string } | null> => {
  const meta = await readMetaV06(taskId);
  if (!meta) return null;
  const action = meta.actions.find((a) => a.id === actionId);
  if (!action) return null;
  return await readActionArtifactRaw(taskId, action);
};

// ----------------- artifact 划除 / 恢复（V0.8.16）-----------------

/**
 * 划除 / 恢复单条 action 的 artifact（软删的「物理落地」、V0.8.16）
 *
 * 背景：光翻 ActionRecord.excluded 这个 flag 挡不住 agent——renderActionHistorySection 虽然
 * 不再把划除的 action 列进 prompt、但 artifact 文件还物理躺在 actions/ 目录里。plan prompt 明确
 * 引导 agent「第 N 次 plan 先 read 上一次 plan artifact」、agent 自己 ls actions / 按编号拼
 * `actions/<n>-plan.md` 就能把划除的旧方案翻出来读（用户实测：划掉 #2 后跑 #3、agent 旁白
 * 「已有 2-plan.md 初稿」——划除根本没挡住它）。
 *
 * 治本：划除时把 artifact 物理挪进 actions/.excluded/ 隐藏子目录（agent ls / rg 默认扫不到）、
 * 恢复时移回。同步把 ActionRecord.artifactPath 改成新位置——UI 读 artifact 走 artifactPath 字段
 *（readActionArtifactRaw）、跟着隐藏路径仍能正常查看 / 恢复。文件不存在（agent 没写成）只翻 flag。
 */
export const setActionArtifactExcluded = async (
  taskId: string,
  actionId: string,
  excluded: boolean,
): Promise<Task | null> =>
  withTaskLock(taskId, async () => {
    const meta = await readMetaV06(taskId);
    if (!meta) return null;
    const idx = meta.actions.findIndex((a) => a.id === actionId);
    if (idx < 0) return null;
    const action = meta.actions[idx]!;

    let nextArtifactPath = action.artifactPath;
    // 有 artifact 记录就同步挪文件 + 改字段；目标位置 = 隐藏子目录（划除）或正常目录（恢复）
    if (action.artifactPath) {
      const filename = actionArtifactFilename(action.n, action.type);
      const targetRel = excluded
        ? `${ACTIONS_DIR}/${EXCLUDED_SUBDIR}/${filename}`
        : `${ACTIONS_DIR}/${filename}`;
      if (action.artifactPath !== targetRel) {
        const fromAbs = path.join(taskDir(taskId), action.artifactPath);
        const toAbs = path.join(taskDir(taskId), targetRel);
        // 文件可能不存在（agent 没写成功）——只改字段、不报错
        if (await exists(fromAbs)) {
          await fs.mkdir(path.dirname(toAbs), { recursive: true });
          await fs.rename(fromAbs, toAbs);
        }
        nextArtifactPath = targetRel;
      }
    }

    meta.actions = [
      ...meta.actions.slice(0, idx),
      { ...action, excluded, artifactPath: nextArtifactPath },
      ...meta.actions.slice(idx + 1),
    ];
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    return await hydrateTask(meta);
  });
