/**
 * 路径相关工具（客户端可用、不依赖 node:path）
 *
 * 抽出来的动机：
 * - `pathBasename` / `basename` 在 event-stream / artifact-panel 多个组件里各自定义、
 *   实现细节漂移（带不带「去尾 slash」逻辑）。一处抽完所有点都走它。
 * - `buildCursorLink` 在 artifact-panel 有完整版（拼 repoPath）、event-stream 有简化版
 *   （只接绝对路径）。合并成一个、repoPath 缺省时按已经是绝对路径走。
 * - `looksLikePath` 是 markdown 渲染时「这个 inline code 像不像文件路径」的启发式判断、
 *   未来文件 / 路径渲染逻辑可能复用、放这里收口。
 *
 * 注意：前端组件不能用 `node:path` / `node:url`、手写就行、量很小。
 */

/**
 * 取绝对 / 相对路径末尾段
 *
 * - 自动剥掉尾随 `/`（目录场景：`/foo/bar/` → `bar`）
 * - 没有 `/` 时返回原值（`abc.txt` → `abc.txt`）
 * - 全是 `/` 时返回 `/`（极端边界）
 */
export const pathBasename = (p: string): string => {
  if (!p) return p;
  const cleaned = p.replace(/\/+$/, "");
  if (cleaned.length === 0) return "/";
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) || cleaned : cleaned;
};

/**
 * 判断 inline code 内容像不像「文件路径」
 *
 * 启发式规则（求覆盖、不求精确）：
 *   - 含 `/`、且最后一段含 `.`（扩展名）
 *   - 不能含空格 / 反引号 / 引号（这些通常是表达式不是路径）
 *   - 长度合理（< 200、避免误判超长字符串）
 *
 * 不动 markdown 原文、只在视图层把长路径里的目录置灰、文件名加粗、且包成 deep link。
 * 用户切「原文」视图能看到原始 path、复制粘贴也是 plain string、下游兼容。
 */
export const looksLikePath = (s: string): boolean => {
  if (!s || s.length > 200) return false;
  if (/\s|"|'|`/.test(s)) return false;
  if (!s.includes("/")) return false;
  const lastSeg = s.slice(s.lastIndexOf("/") + 1);
  return lastSeg.length > 0 && lastSeg.includes(".");
};

/**
 * 把路径转成 cursor:// deep link（点击在 IDE 打开）
 *
 * - 已经是 url（http:// / cursor:// 等）→ 返 null（不动）
 * - 绝对路径（`/` 起手）→ 直接走、忽略 repoPath
 * - 相对路径 + 没传 repoPath → 返 null（拼不出绝对路径）
 * - 相对路径 + 有 repoPath → 跟 repoPath 拼绝对路径
 *
 * encode 防中文 / 空格炸：split + map(encodeURIComponent) + join
 * 协议格式：`cursor://file/<encoded-abs-path>`
 */
export const buildCursorLink = (
  pathLike: string,
  repoPath?: string,
): string | null => {
  if (!pathLike) return null;
  if (/^[a-z]+:\/\//i.test(pathLike)) return null;
  let absolute = pathLike;
  if (!pathLike.startsWith("/")) {
    if (!repoPath) return null;
    const base = repoPath.replace(/\/+$/, "");
    absolute = `${base}/${pathLike.replace(/^\.?\/+/, "")}`;
  }
  return `cursor://file${absolute.split("/").map(encodeURIComponent).join("/")}`;
};
