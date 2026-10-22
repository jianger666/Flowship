/**
 * 工具块折叠行的路径展示（纯函数、客户端可用）
 *
 * 为什么要拆：edit / write / read 的折叠摘要原来是「绝对路径 + ` +N/−M`」整串放进一个行尾 `truncate`
 * 的 span——task 事件流栏默认只有约 307px，业务仓绝对路径动辄 100+ 字，被吃掉的顺序是
 * 先 +N/−M、再文件名，用户看到的是一串没有意义的目录前缀（第二轮 review V4-07）。
 *
 * 做法（宽度自适应交给 CSS、这里只负责出「该显示什么」）：
 *   1. 剥 baseDir 前缀（agent 的工作目录；绝大多数路径都在它下面，前缀对用户是纯噪音）；
 *   2. 拆成「目录 / 文件名」：渲染层让目录段 `min-w-0 truncate`、文件名段 `shrink-0`，
 *      窄了先省略目录的尾部——视觉上就是「头 … 文件名」的中间省略，文件名始终可见；
 *      不在这里按字符数硬切：栏宽不是固定的（chat 宽列 / task 窄栏 / 抽屉），按字数切要么切多、要么还是溢出；
 *   3. +N/−M 单独一段（`shrink-0` 钉右）。
 * 完整绝对路径给 Tooltip。
 */

/** 路径分隔符：POSIX `/` 与 Windows `\` */
const isSep = (ch: string | undefined): boolean => ch === "/" || ch === "\\";

/** 盘符（`C:\` / `C:/`）或 UNC（`\\server`）——Windows 路径大小写不敏感 */
const isWindowsLikePath = (p: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);

/** `\` → `/`（逐字符 1:1 替换，长度不变——调用方靠它把归一化后的下标映射回原串） */
const toSlashes = (p: string): string => p.replace(/\\/g, "/");

/**
 * 路径在 baseDir 之下 → 返回相对路径（保留原路径的分隔符风格）；否则原样返回。
 *
 * 原样返回的情形：没有 baseDir / 不在它之下 / 不在目录边界上（`/repo-x` 不是 `/repo` 的子路径）/
 * 路径本身就是 baseDir（剥完是空串，没有信息量）/ baseDir 是根目录 `/`（所有绝对路径都会被剥光）。
 * Windows（盘符 / UNC）路径按大小写不敏感比较，POSIX 路径严格区分大小写。
 */
export const stripBaseDirPrefix = (
  p: string,
  baseDir?: string | null,
): string => {
  if (!p || !baseDir) return p;
  const base = toSlashes(baseDir).replace(/\/+$/, "");
  // 空串 = baseDir 本身就是根（`/`）
  if (!base) return p;
  const np = toSlashes(p);
  if (np.length <= base.length) return p;
  const head = np.slice(0, base.length);
  const same = isWindowsLikePath(baseDir)
    ? head.toLowerCase() === base.toLowerCase()
    : head === base;
  if (!same || np[base.length] !== "/") return p;
  let i = base.length;
  while (np[i] === "/") i++;
  // `/repo/`（只多一个尾斜杠）：剥完是空串，保持原样
  if (i >= np.length) return p;
  return p.slice(i);
};

/**
 * 拆成「目录（含末尾分隔符）」+「最后一段」，`dir + base === 原路径`。
 * 路径末尾带分隔符（目录）时，最后一段连同尾斜杠一起算 base（`src/lib/` → `src/` + `lib/`），不返回空 base。
 */
export const splitPathForDisplay = (
  p: string,
): { dir: string; base: string } => {
  let end = p.length;
  while (end > 0 && isSep(p[end - 1])) end--;
  let idx = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (isSep(p[i])) {
      idx = i;
      break;
    }
  }
  return { dir: p.slice(0, idx + 1), base: p.slice(idx + 1) };
};

export type ToolPathRowParts = {
  /** 目录段（含末尾分隔符；已剥 baseDir 前缀）——渲染层允许省略 */
  dir: string;
  /** 文件名段——渲染层钉住 */
  base: string;
  /** `+N/−M`（edit 有 diff 时）；没有 → null */
  stats: string | null;
  /** 未剥前缀的完整路径，给 Tooltip */
  full: string;
};

/**
 * 非路径行（shell 命令 / grep 模式等）的摘要短于这个字数就不挂 Tooltip：
 * 最窄的 task 事件流栏（≈307px，去掉箭头 / 图标 / 工具名后 mono 12px 约放得下 30 字）里也不会被截断，
 * 弹一遍同样的原文只是噪音（同 `OverflowTooltip`「短文案不挂气泡」的取舍；这里量不到真实溢出，用字数近似）。
 */
export const ROW_TOOLTIP_MIN_CHARS = 32;

/**
 * 工具行整行 Tooltip 的内容；空串 = 不挂（Tooltip 组件 content 为空时直接 `return children`）。
 *  - 路径行：完整路径——折叠行显示的已经剥掉了 baseDir 前缀、目录段还可能被省略，全路径只能靠它看；
 *    统计 +N/−M 一直钉在行上可见，不重复进气泡；
 *  - 其它行：摘要够长才挂。
 *
 * **刻意不看折叠 / 展开、不看直播尾行**：Tooltip 在「content 为空 → 直接返回 children」和
 * 「content 非空 → 包 Provider/Root/Trigger」之间切换会改变元素树形状，行按钮会被卸载重挂——
 * 键盘用户按回车展开 / 折叠后焦点就丢了。所以内容只取随折叠状态不变的量（路径、摘要）。
 */
export const toolRowTooltipText = (input: {
  summary: string;
  pathParts: ToolPathRowParts | null;
}): string => {
  if (input.pathParts) return input.pathParts.full;
  return input.summary.length >= ROW_TOOLTIP_MIN_CHARS ? input.summary : "";
};

/**
 * 整行 Tooltip 的「挂不挂」要**跨渲染稳定**（R7-03）：{@link toolRowTooltipText} 看的 summary 对「未映射工具」
 * （submit_mr / MCP）会在完成那一刻变——运行中是 `调用 x:{json…}`（≥32 字 → 有 Tooltip），
 * 完成后变输出首行 `ok`（<32 → 无）→ Tooltip 包装在「包」与「不包」间切换，行按钮被卸载重挂、键盘焦点丢。
 *
 * 规则：运行中的行一律挂（运行中的行很少，多一层包装不构成 D5-02 的性能问题）；
 * 挂过的行不再摘——内容空了就回落到摘要 / 工具名，保证 content 恒非空。
 * 从没运行过、一上来就是完成态且内容为空的行（占绝大多数）不挂，D5-02 的省法保持。
 *
 * @param mounted 这一行此前是否已经挂过（组件用 ref 记）
 * @returns content：传给 Tooltip 的文案（空串 = 不挂）；mounted：新的「已挂过」闩锁
 */
export const resolveRowTooltip = (input: {
  summary: string;
  pathParts: ToolPathRowParts | null;
  /** 工具还在跑（status=running 或后台运行中） */
  running: boolean;
  mounted: boolean;
  /** 兜底文案（工具名）：保证挂了就非空 */
  fallback: string;
}): { content: string; mounted: boolean } => {
  const base = toolRowTooltipText(input);
  const mounted = input.mounted || input.running || base !== "";
  if (!mounted) return { content: "", mounted: false };
  return { content: base || input.summary.trim() || input.fallback || "工具", mounted: true };
};

/** 折叠行路径摘要的三段 + Tooltip 全文 */
export const toolPathRowParts = (input: {
  filePath: string;
  baseDir?: string | null;
  stats?: { added: number; removed: number } | null;
}): ToolPathRowParts => {
  const { dir, base } = splitPathForDisplay(
    stripBaseDirPrefix(input.filePath, input.baseDir),
  );
  return {
    dir,
    base,
    stats: input.stats
      ? `+${input.stats.added}/−${input.stats.removed}`
      : null,
    full: input.filePath,
  };
};
