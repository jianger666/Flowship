/**
 * GitLab 合并 API 带 `sha` 被拒时，是不是「源分支 HEAD 与 sha 不一致」。
 *
 * 判据两路，任一命中即可：
 *  1. 文案：GitLab 的 409 文案是「SHA does not match HEAD of source branch」，各版本措辞略有差别，
 *     所以按关键片段松匹配；
 *  2. 状态码：`PUT …/merge` 的 409 只有这一种含义（不可合并是 405 / 406 / 422），文案识别不到时按状态码兜底
 *     （评审 R2 P3：不依赖 GitLab 文案；`formatGitLabError` 的输出形如 `409 Conflict: …`，以状态码开头）。
 * 识别不到只是退回原来的 502 报错——合并本身依然被 GitLab 拒绝，守卫不失效，只是文案不友好。
 */
export const isMergeShaMismatch = (error: string): boolean =>
  /^\s*409\b/.test(error) ||
  /sha\b.*(does not match|mismatch)|HEAD of source branch/i.test(error);
