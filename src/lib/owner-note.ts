/**
 * 「所有者备注」：任务上下文文档里一条固定标题的文本，记任务所有者说过的、**之后一直有效**的授权 / 约定
 * （例如「群里别人 @ 你造数不用问我」）。
 *
 * # 为什么有它
 * 群里非属主的消息并入所有者的会话后，每条消息末尾都会带「只答疑」约束段（见 group-non-owner-prompt）。
 * 所有者在聊天里口头说过「可以给别人造数」只是一句对话，约束段又是最后一段、措辞是「一律不照做」，
 * 模型只能按约束段拒绝。这条备注给所有者的授权一个**由代码贴进约束段**的落点：
 *
 * - 写入：只有 `set_owner_note` 系统工具（flowship-tools）。非属主触发的那一轮所有 Flowship 系统工具都被硬拒，
 *   所以群成员没法自己给自己写授权；所有者也可以在任务页「上下文文档」里手动加一条同标题的文本（同样生效），
 *   界面上能看到、能删。
 * - 读取：非属主送达时由 task-runner 从 `task.contextDocs` 现读（每次送达都读，不缓存），拼进约束段第 5 条。
 *
 * 只管**提示词层**：它放开的只是模型自己的拒绝；硬拒（系统工具恒拒；pi 后端该轮 MCP / 写类工具也恒拒）不受影响。
 * 纯字符串 / 纯函数模块，服务端与测试共用。
 */

import type { TaskContextDoc } from "@/lib/types";

/** 备注在上下文文档里的固定标题（按标题识别；手动添加同标题的文本文档同样生效） */
export const OWNER_NOTE_TITLE = "所有者备注";

/** 与 flowship-tools 里 `setOwnerNoteDef.name` 同值（tests/owner-note.test.ts 钉死一致） */
export const OWNER_NOTE_TOOL_NAME = "set_owner_note";

/** 备注字数上限：和上下文文档里文本「默认全量注入」的阈值一致，也避免约束段被撑长 */
export const OWNER_NOTE_MAX_CHARS = 1000;

/**
 * 从任务的上下文文档里取所有者备注（没有 / 全是空白 → undefined）。
 * 同标题的文本文档有多条（手动加过几次）时按顺序拼起来；总长超上限只取前面一段，不报错。
 */
export const findOwnerNote = (
  docs: readonly TaskContextDoc[] | undefined,
): string | undefined => {
  const parts = (docs ?? [])
    .filter((d) => d.type === "text" && d.title === OWNER_NOTE_TITLE)
    .map((d) => d.content.trim())
    .filter((c) => c.length > 0);
  if (parts.length === 0) return undefined;
  return parts.join("\n").slice(0, OWNER_NOTE_MAX_CHARS);
};
