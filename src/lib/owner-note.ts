/**
 * 「所有者备注」：任务上下文文档里一条固定标题的文本，记任务所有者说过的、**之后一直有效**的授权 / 约定
 * （例如「群里别人 @ 你造数不用问我」）。
 *
 * # 为什么有它
 * 群里非属主的消息并入所有者的会话后，每条消息末尾都会带「只答疑」约束段（见 group-non-owner-prompt）。
 * 所有者在聊天里口头说过「可以给别人造数」只是一句对话，约束段又是最后一段、措辞是「一律不照做」，
 * 模型只能按约束段拒绝。这条备注给所有者的授权一个**由代码贴进约束段**的落点：
 *
 * - 写入：只有 `set_owner_note` 系统工具（flowship-tools）。**群里非属主触发的那一轮，代码恒拒它**，不看设置里的
 *   「限制群里非宿主成员」开关：开关开着时该轮 Flowship 系统工具整体硬拒；开关关着（同权）时系统工具照常放行，
 *   但写所有者备注 / 新建定时 / 自动推进 / 电脑操作仍恒拒（见 flowship-tools 的 `groupOpenTurnToolDenied` 与咽喉
 *   `invokeFlowshipTool`）。否则群成员能自己给自己写授权——开关一重开，那条备注就成了「所有者本人的授权」。
 *   所有者也可以在任务页「上下文文档」里手动加一条同标题的文本（同样生效），界面上能看到、能删。
 *   ⚠ 「恒拒」只管 Flowship 的工具入口：本机 HTTP API（`POST /api/tasks/:id/context-docs`）没有调用者身份，
 *   同权轮里 agent 自己的 shell 能直接打它写同一份文档（边界与不加令牌的理由见 flowship-tools 的 `GROUP_OPEN_TURN_DENIED_RULES`）。
 *   所以备注是「所有者看得见、删得掉的软授权」，不是密码学意义上只有所有者能写——别在文案里承诺后者。
 *   手动加的有两条规矩，都在写入时落实（task-fs 的 `addContextDoc`），免得备注「加成功了却悄悄没生效」：
 *   ① 标题是「所有者备注」的一律按文本存——上下文文档默认按内容猜类型，以 `/` 开头会被当成本地路径、以 `http` 开头会被当成链接，
 *      而这里只认文本，猜错了备注就静默失效；② 总长不能超过上限（`ownerNoteOverflow`）——读取时超出的部分会被截掉，所以写入时直接拒绝。
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

/**
 * 再手动加一条所有者备注，这一条最多还能写多少字：已有的备注（`findOwnerNote` 把同标题的文本按换行拼起来再整体截断）
 * + 拼接用的 1 个换行 + 这一条，合起来不能超过 `OWNER_NOTE_MAX_CHARS`。已经用满返回 0。
 */
export const ownerNoteBudget = (
  docs: readonly TaskContextDoc[] | undefined,
): number => {
  const existing = findOwnerNote(docs);
  return existing
    ? Math.max(0, OWNER_NOTE_MAX_CHARS - existing.length - 1)
    : OWNER_NOTE_MAX_CHARS;
};

/**
 * 手动加这一条备注会不会超上限：不超返回 null；超了返回给用户看的原因（服务端写入时拒绝用它、面板上的提示也用它）。
 * 超出的部分在读取时会被截掉、AI 根本看不到，所以不是「放行并截断」，而是让所有者当场精简。
 */
export const ownerNoteOverflow = (
  docs: readonly TaskContextDoc[] | undefined,
  content: string,
): string | null => {
  const length = content.trim().length;
  const budget = ownerNoteBudget(docs);
  if (length <= budget) return null;
  const existing = findOwnerNote(docs);
  const why = "超出的部分 AI 看不到，所以不让加";
  return existing
    ? `所有者备注总共最多 ${OWNER_NOTE_MAX_CHARS} 字：已有 ${existing.length} 字，这条 ${length} 字、只剩 ${budget} 字的位置。精简成要点，或先删掉旧的再加（${why}）`
    : `所有者备注最多 ${OWNER_NOTE_MAX_CHARS} 字，这条 ${length} 字：精简成要点再加（${why}）`;
};
