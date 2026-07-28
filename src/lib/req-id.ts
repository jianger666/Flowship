/**
 * REQ-ID（团队 wk-harness 规范的需求主键）——**只认用户手填、绝不猜**
 *
 * 推进 task 时注入 agent 上下文、wk 门禁拼 `requirements/<REQ-ID>` 路径时都取这里。
 *
 * ⚠️ 这里曾经有一条「派生链」（飞书链接 → `REQ-<storyId>`、再兜底 `REQ-TASK-<task id 末段>`），
 * 已整条删除：REQ-ID 是需求 owner 跑完 `wk:biz-confirm` 后分发给前后端的标识，规范
 * （wk-harness `SKILL.md:49`）明文要求「如果用户没有提供 REQ-ID，必须先要求补充，不要猜测」。
 * 我们凭飞书链接或 task id 造一个 = 伪造团队流程里不存在的标识、还会在 WK 产出目录里
 * 留下空壳目录。没有就是没有：门禁跳过、prompt 不注入，由 agent 按规范找用户要。
 */

/**
 * REQ-ID 字面合法性：首字符字母数字、其后允许 `_ . -`。
 * 口径对齐官方脚本 `wk-context-init.py` 的 `REQ_ID_RE`；同时天然拒绝
 * `/` `\` `..` 等路径穿越字符（REQ-ID 会被拼进 `requirements/<REQ-ID>`）。
 */
const REQ_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const isValidReqId = (raw: string): boolean =>
  REQ_ID_PATTERN.test(raw.trim());

/** 去空白 + 校验；空 / 非法一律 undefined（调用方据此当「没有编号」处理） */
export const normalizeReqId = (raw: string | undefined): string | undefined => {
  const v = (raw ?? "").trim();
  return v && isValidReqId(v) ? v : undefined;
};

/**
 * 最终生效的 REQ-ID：只有用户手填的那一个，没填 / 填了非法字面 → `null`。
 *
 * 门禁与 prompt 注入都必须走这个函数（别各自读 `task.reqId`），
 * 免得哪天又有人在某一处「顺手补个默认值」。
 */
export const resolveReqId = (task: { reqId?: string }): string | null =>
  normalizeReqId(task.reqId) ?? null;

/**
 * 表单提交时该往 `task.reqId` 落什么——新建表单与编辑弹窗共用这一份判定。
 *
 * 语义就一句：**填了什么存什么、空就是 `null`**（`null` = 清空、这个 task 没有 REQ-ID）。
 *
 * 这里故意**不做字面校验**：非法字面要原样送到服务端换一个 400 提示
 * （见 `POST /api/tasks` 与 `PATCH /api/tasks/[id]`），静默吞掉的话用户以为存上了。
 */
export const reqIdPatchValue = (draft: string): string | null =>
  draft.trim() || null;
