/**
 * 输入条乐观提交（chat 输入岛 / task 跟 AI 说共用）。
 *
 * 背景：两个输入框各手写了一遍“快照→秒清→占位→失败恢复”，改一次要改两处
 *（秒清、乐观占位都是这么欠下的）。模式收敛到这里，调用方只剩：
 * 取快照、调本函数、按结果做各通道自己的映射（toast / onTaskUpdate / ledger 仲裁）。
 *
 * 语义（与原来两处逐行对齐）：
 * 1. 先 reset（输入框秒清），再 send；气泡靠 SSE 真事件补；
 * 2. send 抛错、或 isFailure 判失败 → restore 快照（正文+路径+图片；
 *    图片由 upload payload 合成 PendingImage，File 用空占位——重发读的是 base64，见 restoreOptimisticDraft）；
 * 3. 占位行（传了 onPendingAdd/Remove 才管）：发前加、落定（成功/失败）即撤，
 *    真气泡随后经 SSE 接替；chat 通道占位走 ledger，不过这里。
 */
import type { RichInputPayload } from "./rich-input-payload";
import type { ImagePayload } from "./task-store";

/** 占位幂等键：nonce 区分同文案连发（同 ms 同长度不同文案也会撞，只靠 text 不够）。 */
export interface OptimisticPendingKey {
  taskId: string;
  text: string;
  displayText: string;
  nonce: string;
}

/** pending 占位 nonce（进程内唯一即可，不进服务端）。 */
export const allocPendingNonce = (): string =>
  `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export type OptimisticSubmitResult<T> =
  | { ok: true; result: T }
  | { ok: false; error?: unknown };

export const runOptimisticSubmit = async <T>(opts: {
  /** 已快照的 payload（快照动作本身由调用方做，失败恢复时原样用它） */
  payload: RichInputPayload;
  /** 秒清输入框（含草稿快照清理，各自 rich.reset 语义） */
  reset: () => void;
  /** 失败时恢复（正文+路径，各自 rich 语义） */
  restore: (p: RichInputPayload) => void;
  /** 占位行键（不传则不管占位，如 chat 通道走 ledger） */
  pendingKey?: OptimisticPendingKey;
  onPendingAdd?: (p: OptimisticPendingKey) => void;
  onPendingRemove?: (p: { taskId: string; nonce: string }) => void;
  /** 真正的发送（各通道自己的 POST） */
  send: () => Promise<T>;
  /** 结果判失败（如 chat 通道返 false=失败；不传则只认抛错） */
  isFailure?: (result: T) => boolean;
}): Promise<OptimisticSubmitResult<T>> => {
  const { payload, reset, restore, pendingKey, onPendingAdd, onPendingRemove } =
    opts;
  reset();
  // 按 (taskId, nonce) 幂等——并发被各通道自己的飞行锁拦住，nonce 防同文案连发互撤。
  if (pendingKey) onPendingAdd?.(pendingKey);
  const dropPending = (): void => {
    if (pendingKey) {
      onPendingRemove?.({ taskId: pendingKey.taskId, nonce: pendingKey.nonce });
    }
  };
  try {
    const result = await opts.send();
    if (opts.isFailure?.(result)) {
      restore(payload);
      dropPending();
      return { ok: false };
    }
    dropPending();
    return { ok: true, result };
  } catch (error) {
    restore(payload);
    dropPending();
    return { ok: false, error };
  }
};

/**
 * 两处统一的失败恢复：正文 + 路径 + 图片。
 * 图片可恢复：upload payload（data/mimeType/filename）合成 PendingImage
 *（File 用空占位，content 只读 name/type——与快照恢复同构，见 use-image-attach fromStored）。
 * 缺字段的图片跳过（不断整条恢复）。
 */
export const restoreOptimisticDraft = (
  p: RichInputPayload,
  setValue: (text: string) => void,
  replacePaths: (paths: string[]) => void,
  replaceImages?: (images: PendingUploadImage[]) => void,
): void => {
  try {
    setValue(p.text);
    if (p.attachments && p.attachments.length > 0) {
      replacePaths(p.attachments);
    }
    if (replaceImages && p.images && p.images.length > 0) {
      const pendings = uploadPayloadsToPending(p.images);
      if (pendings.length > 0) replaceImages(pendings);
    }
  } catch {
    /* 恢复失败不盖掉原错 */
  }
};

/** PendingImage 结构子集（use-image-attach 未导出该类型，按结构传参即可）。 */
export interface PendingUploadImage {
  id: string;
  file: File;
  dataUrl: string;
  data: string;
  mimeType: string;
}

/** ImagePayload → PendingImage（缺 data/mimeType 的跳过）。 */
export const uploadPayloadsToPending = (
  images: ImagePayload[],
): PendingUploadImage[] => {
  const out: PendingUploadImage[] = [];
  for (const img of images) {
    const data = img.data;
    const mimeType = img.mimeType;
    if (!data || !mimeType) continue;
    const filename = img.filename ?? "";
    out.push({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      file: new File([], filename, { type: mimeType }),
      dataUrl: `data:${mimeType};base64,${data}`,
      data,
      mimeType,
    });
  }
  return out;
};
