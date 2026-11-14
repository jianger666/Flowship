/**
 * 用户消息「原地编辑」里的图片：附件快照的 id 与清理（纯函数、不碰 React）
 *
 * 编辑框里能看到 / 删掉 / 新增图片，这组图和输入框里的附图是同一套机制（useImageAttach）。
 * 编辑行住在虚拟列表里、滚出视口就卸载，所以图片同样走「附件快照」（view-memory，模块级内存 Map）：
 * 行被卸载再挂回来，首帧从快照还原，用户删的 / 贴的都在。
 *
 * 要不要去读原消息的图，只看三样东西（挂载那一刻）：
 *  - 快照里有图 → 那是用户上次的编辑结果（删了几张 / 新贴的），以它为准，**不读原图**；
 *  - 快照里没图，但「用户亲手全删了」标记在（{@link USER_EDIT_IMAGES_CLEARED}）→ 就是要空的，**不读原图**；
 *  - 快照里没图、也没有这个标记 → 要读原图。这一条同时覆盖「还没读过」和「快照被全局 LRU 挤掉了」
 *    （附件快照是 reply / talk / ask / edit 共用的 20 条 / 100MB 上限，见 view-memory.ts）——
 *    挤掉之后宁可把原图读回来给用户看见，也不能静默地带着 0 张图发出去（原消息被回退删掉后图就找不回来了，评审 R18-03）。
 * 标记只在用户把最后一张图删掉那一下写入；快照和标记都不存在 = 没有任何东西会误导成「用户不要图」。
 *
 * 取消 / 发送成功 / 入口消失时调 {@link clearUserEditImages} 一并清掉，下次再点编辑从原消息的图重新开始。
 */

import { rowViewStateStore } from "@/lib/event-row-view-state";
import { userEditViewKeys } from "@/lib/row-view-keys";
import { clearAttachmentSnapshot } from "@/lib/view-memory";

/** 「用户亲手把编辑框里的图全删了」标记的值（存在 rowViewStateStore 里；没有这个值 = 没清空过） */
export const USER_EDIT_IMAGES_CLEARED = "cleared";

/** 附件快照的 id：taskId + 消息 id（换任务 / 换消息都不串） */
export const userEditImagesSnapshotId = (
  taskId: string,
  eventId: string,
): string => `${taskId}:${eventId}`;

/** 清掉这条消息编辑态的图片：快照 + 「用户全删了」标记。没有编辑态时调用是空操作。 */
export const clearUserEditImages = (taskId: string, eventId: string): void => {
  clearAttachmentSnapshot("edit", userEditImagesSnapshotId(taskId, eventId));
  rowViewStateStore.delete(userEditViewKeys(taskId, eventId).imagesCleared);
};

/**
 * 编辑框挂载时，是否还要去读原消息的图（纯函数：全部入参都是挂载那一刻能拿到的事实）。
 * - `originalCount`：原消息贴过几张图；
 * - `snapshotImageCount`：附件快照里现在有几张；
 * - `userCleared`：用户是否亲手把图全删过（标记）。
 */
export const shouldLoadOriginalImages = (input: {
  originalCount: number;
  snapshotImageCount: number;
  userCleared: boolean;
}): boolean =>
  input.originalCount > 0 && input.snapshotImageCount === 0 && !input.userCleared;
