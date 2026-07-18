/**
 * feature 分支命名模板渲染（V0.6.7、client + server 共用、不依赖 node）
 *
 * 背景：原来 feature 分支名写死算法 `feature/<username>/<storyId>-<title>`
 * （见 task-runner.planBranchesForBuild 旧实现）。V0.6.7 改成用户可配模板字符串、
 * 支持占位符、前后端不同命名规范都能覆盖。
 *
 * 占位符：
 *   {storyId}     → 飞书 story id（从 feishuStoryUrl 抠 detail/<digits>）
 *   {taskTitle}   → task.title（自动转 branch-safe）
 *   {date:FORMAT} → 当前日期、FORMAT 支持 yyyy/yy/MM/dd/HH/mm/ss token（如 {date:MM-dd}）
 *   {username}    → 已废弃（V0.12.x 删除 settings.username、老配置迁移时已把名字烘焙进模板）；
 *                   老任务快照里残留的该占位符渲染为空段、由连续 `/` 清理兜住
 *
 * 渲染规则：
 *   - 每个占位符的值单独 sanitize（git 非法字符 + 路径分隔 `/` 都换成 -）、模板字面里的 `/` 保留
 *   - 渲染完清理连续 `/` + 首尾 `/`（防某占位符为空导致 `feature//xxx`）
 *   - 未知占位符原样保留（不报错、方便用户排查 typo）
 */

/** 内置兜底模板（模板留空时运行时回退用、不再预填进设置页） */
export const DEFAULT_BRANCH_TEMPLATE = "feature/{storyId}-{taskTitle}";

/**
 * 单段 branch-safe：保留中文 + 字母数字；空白 / 各种括号 / git 非法字符（~ ^ @ : ? * [ \ / < > | "）
 * 以及 shell 元字符（$ ` ; ! &）统一换 -；连续点折 -（git 禁 ..）；首尾 - 和 . 去掉。
 * 中间单点保留（如 v1.0）。
 *
 * 注意：`/` 也换成 -——变量值不该自带路径层级、层级由模板字面控制。
 */
export const sanitizeBranchSegment = (s: string): string =>
  s
    .trim()
    .replace(/[\s\\/:*?"<>|~^@`$!&;【】（）()\[\]{}]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

/**
 * 完整分支名清洗：按 `/` 分段走 sanitizeBranchSegment，保留路径分隔。
 * 用于模板字面量残留非法字符、或用户手填分支的兜底清洗。
 */
export const sanitizeBranchName = (s: string): string =>
  s
    .split("/")
    .map((seg) => sanitizeBranchSegment(seg))
    .filter((seg) => seg.length > 0)
    .join("/");

/**
 * 分支名是否可安全交给 git argv / 拼进 refs（拒空串、前导 -、空白、..、非法 ref 字符）。
 * worktree add / checkout / show-ref 前统一校验。
 */
export const isSafeBranchName = (name: string): boolean => {
  if (!name || name !== name.trim()) return false;
  if (name.startsWith("-") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//")) return false;
  // 与 sanitizeBranchSegment 同级字符集，额外允许 `/` 作层级分隔
  if (!/^[A-Za-z0-9\u4e00-\u9fa5._/-]+$/.test(name)) return false;
  // 分段不能为空、不能是 `.`、不能以 `.` 结尾（git 禁）
  for (const seg of name.split("/")) {
    if (!seg || seg === "." || seg.endsWith(".")) return false;
  }
  return true;
};

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
  const rendered = tpl
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
    .replace(/^\/+|\/+$/g, "");
  // 模板字面量也可能带非法字符（如 `feature$/{storyId}`）——整串再过一遍 branch-safe
  return sanitizeBranchName(rendered);
};

/**
 * 算「有效模板」：per-repo 覆盖 > 全局默认 > 内置默认
 */
export const resolveBranchTemplate = (
  repoTemplate: string | undefined,
  globalTemplate: string | undefined,
): string =>
  repoTemplate?.trim() || globalTemplate?.trim() || DEFAULT_BRANCH_TEMPLATE;

/** 合法的简单占位符（含已废弃的 username——历史配置可能残留、保存时不拦） */
const KNOWN_SIMPLE_PLACEHOLDERS = new Set([
  "storyId",
  "taskTitle",
  "username",
]);

/**
 * {date:FORMAT} 的 FORMAT 是否合法：非空、去掉 yyyy/yy/MM/dd/HH/mm/ss 后不再含字母。
 * 分隔符（-/_: 空格等）宽松放行；空格式 `{date:}` 与乱写 `{date:abc}` 拦下。
 */
const isValidDateFormat = (fmt: string): boolean => {
  if (!fmt) return false;
  let rest = fmt;
  // 长 token 在前（yyyy 先于 yy），避免 yy 把 yyyy 尾部吃掉后残留字母误判
  for (const token of ["yyyy", "yy", "MM", "dd", "HH", "mm", "ss"]) {
    rest = rest.split(token).join("");
  }
  return !/[a-zA-Z]/.test(rest);
};

/**
 * 找出模板里的未知占位符（返回原文如 "{yyMMdd}"；空数组 = 合法）。
 * 背景：renderBranchName 对未知占位符原样保留——同事写成 `{yyMMdd}`（正确是
 * `{date:yyMMdd}`）会建出字面分支名、被当垃圾删后任务卡死；保存入口必须先拦。
 */
export const findUnknownPlaceholders = (template: string): string[] => {
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(/\{[^}]*\}/g)) {
    const full = m[0];
    if (seen.has(full)) continue;
    const inner = full.slice(1, -1);
    const ok =
      KNOWN_SIMPLE_PLACEHOLDERS.has(inner) ||
      (inner.startsWith("date:") && isValidDateFormat(inner.slice("date:".length)));
    if (!ok) {
      seen.add(full);
      unknown.push(full);
    }
  }
  return unknown;
};

/**
 * 从飞书 story URL 抠 story id（V0.10 从 action-gates 抽出、worktree 分支命名共用）
 * 规则：优先 detail/<digits> 段、兜底最长一段 ≥6 位连续数字；抠不到返 null
 */
export const extractFeishuStoryId = (url: string | undefined): string | null => {
  if (!url || url.trim().length === 0) return null;
  const m = url.match(/detail\/(\d+)/) ?? url.match(/(\d{6,})/);
  return m ? m[1] : null;
};
