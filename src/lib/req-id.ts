/**
 * REQ-ID 派生（团队 wk-harness 规范的需求主键）
 *
 * 推进 task 时注入 agent 上下文，让 wk:* 系 action 无感拿到默认编号；
 * 用户描述里另行指定了 REQ-ID 时以用户的为准（见 super prompt 注入行说明）。
 *
 * 规则：
 *   - 绑了飞书需求链接且能抠出 story 数字 id → `REQ-<storyId>`
 *   - 否则 → `REQ-TASK-<task id 最后一段大写>`（如 `t_…_hr7qin` → `REQ-TASK-HR7QIN`）
 *
 * story URL 解析复用 `extractFeishuStoryId`（branch-template / 分支命名 / mr-inbox 同一套）。
 */

import { extractFeishuStoryId } from "./branch-template";

/** deriveReqId 只需 id + 可选飞书链接，避免强绑完整 Task */
export type ReqIdTaskFields = {
  id: string;
  feishuStoryUrl?: string;
};

/**
 * 从 task 派生默认 REQ-ID（纯函数、client/server 通用）
 */
export const deriveReqId = (task: ReqIdTaskFields): string => {
  const storyId = extractFeishuStoryId(task.feishuStoryUrl);
  if (storyId) return `REQ-${storyId}`;

  // task id 形如 t_<ts>_<suffix>——取最后一段大写；缺段时兜底整段 id
  const lastSeg = task.id.split("_").pop()?.trim();
  const suffix =
    lastSeg && lastSeg.length > 0 ? lastSeg : task.id.trim() || "UNKNOWN";
  return `REQ-TASK-${suffix.toUpperCase()}`;
};
