/**
 * feature 分支命名模板渲染（V0.6.7、client + server 共用、不依赖 node）
 *
 * 背景：原来 feature 分支名写死算法 `feature/<username>/<storyId>-<title>`
 * （见 task-runner.planBranchesForBuild 旧实现）。V0.6.7 改成用户可配模板字符串、
 * 支持占位符、前后端不同命名规范都能覆盖。
 *
 * 占位符：
 *   {username}    → settings.username
 *   {storyId}     → 飞书 story id（从 feishuStoryUrl 抠 detail/<digits>）
 *   {taskTitle}   → task.title（自动转 branch-safe）
 *   {date:FORMAT} → 当前日期、FORMAT 支持 yyyy/yy/MM/dd/HH/mm/ss token（如 {date:MM-dd}）
 *
 * 渲染规则：
 *   - 每个占位符的值单独 sanitize（git 非法字符 + 路径分隔 `/` 都换成 -）、模板字面里的 `/` 保留
 *     → 这样 `feature/{username}/...` 的层级 `/` 保留、但变量值里混进的 `/` 不会撑出多余层级
 *   - 渲染完清理连续 `/` + 首尾 `/`（防某占位符为空导致 `feature//xxx`）
 *   - 未知占位符原样保留（不报错、方便用户排查 typo）
 */

/** 内置默认模板（settings.branchTemplate 没配 / 为空时回退、跟 V0.6.6 前的写死算法一致） */
export const DEFAULT_BRANCH_TEMPLATE = "feature/{username}/{storyId}-{taskTitle}";

/**
 * 单段 branch-safe：保留中文 + 字母数字；空白 / 各种括号 / git 非法字符（~ ^ @ : ? * [ \ / < > | "）
 * 统一换 -；连续点折 -（git 禁 ..）；首尾 - 和 . 去掉（git 禁 ref 以 . 结尾）。中间单点保留（如 v1.0）
 *
 * 注意：`/` 也换成 -——变量值不该自带路径层级、层级由模板字面控制。
 */
export const sanitizeBranchSegment = (s: string): string =>
  s
    .trim()
    .replace(/[\s\\/:*?"<>|~^@【】（）()\[\]{}]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

/**
 * 日期格式化：支持 yyyy/yy/MM/dd/HH/mm/ss token（区分大小写、MM=月 mm=分）
 * 长 token 在前替换（yyyy 先于 yy）、避免 yy 把 yyyy 的尾部吃掉。
 */
const formatDate = (fmt: string, d: Date): string => {
  const pad = (n: number, len = 2): string => String(n).padStart(len, "0");
  const tokens: Array<[string, string]> = [
    ["yyyy", String(d.getFullYear())],
    ["yy", pad(d.getFullYear() % 100)],
    ["MM", pad(d.getMonth() + 1)],
    ["dd", pad(d.getDate())],
    ["HH", pad(d.getHours())],
    ["mm", pad(d.getMinutes())],
    ["ss", pad(d.getSeconds())],
  ];
  let out = fmt;
  for (const [token, val] of tokens) {
    out = out.split(token).join(val);
  }
  return out;
};

export interface BranchTemplateVars {
  username?: string;
  storyId?: string;
  taskTitle?: string;
}

/**
 * 渲染 feature 分支名
 * @param now 注入当前时间（默认 new Date()、测试可控）
 */
export const renderBranchName = (
  template: string,
  vars: BranchTemplateVars,
  now: Date = new Date(),
): string => {
  const tpl = template.trim() || DEFAULT_BRANCH_TEMPLATE;
  return (
    tpl
      // {date:FORMAT} 先处理（FORMAT 里可能含其它字母、不能跟普通占位符正则混）
      .replace(/\{date:([^}]*)\}/g, (_, fmt: string) =>
        sanitizeBranchSegment(formatDate(fmt, now)),
      )
      .replace(/\{(username|storyId|taskTitle)\}/g, (_, key: string) => {
        const raw =
          key === "username"
            ? vars.username
            : key === "storyId"
              ? vars.storyId
              : vars.taskTitle;
        return sanitizeBranchSegment(raw ?? "");
      })
      // 清理：连续 / 折成单个、去首尾 /（防占位符为空撑出 // 或首尾 /）
      .replace(/\/{2,}/g, "/")
      .replace(/^\/+|\/+$/g, "")
  );
};

/**
 * 算「有效模板」：per-repo 覆盖 > 全局默认 > 内置默认
 */
export const resolveBranchTemplate = (
  repoTemplate: string | undefined,
  globalTemplate: string | undefined,
): string =>
  repoTemplate?.trim() || globalTemplate?.trim() || DEFAULT_BRANCH_TEMPLATE;

/**
 * 从飞书 story URL 抠 story id（V0.10 从 action-gates 抽出、worktree 分支命名共用）
 * 规则：优先 detail/<digits> 段、兜底最长一段 ≥6 位连续数字；抠不到返 null
 */
export const extractFeishuStoryId = (url: string | undefined): string | null => {
  if (!url || url.trim().length === 0) return null;
  const m = url.match(/detail\/(\d+)/) ?? url.match(/(\d{6,})/);
  return m ? m[1] : null;
};
