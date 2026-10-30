/**
 * 「这个群还绑着别的任务」的提示文案（第四轮 B4-4 / Q12b-02，手动绑定成功后的弹窗 toast 用）
 *
 * 一个群可以同时被多个任务绑，群里的 @ 却只会进其中一个（路由规则见 server 侧 group-task-binding：
 * 正在运行 / 等用户回答的优先，同档取最近更新的）。绑定成功后服务端会把「这个群上还有哪些别的任务」带回来，
 * 这里把它整理成一句人话：不阻止绑定（绑多个是合法用法，比如拆分任务），只是让用户知道群消息不会广播给它们。
 *
 * 纯函数、无 React / 服务端依赖，可在 node 里测。
 */

/** 服务端回的同群任务简况 */
export interface AlsoBoundTask {
  id: string;
  title: string;
}

/** 最多列几个标题，其余折成「等 N 个任务」 */
export const ALSO_BOUND_TITLES_SHOWN = 3;
/** 单个标题最多显示多少个字（按码点，不切开 emoji） */
export const ALSO_BOUND_TITLE_CLIP = 20;

const clipTitle = (s: string): string => {
  const chars = Array.from(s);
  return chars.length > ALSO_BOUND_TITLE_CLIP
    ? `${chars.slice(0, ALSO_BOUND_TITLE_CLIP).join("")}…`
    : s;
};

/** 空数组 = 没有别的任务，调用方不该弹提示（返回空串兜底） */
export const describeAlsoBoundBy = (others: readonly AlsoBoundTask[]): string => {
  if (others.length === 0) return "";
  const shown = others
    .slice(0, ALSO_BOUND_TITLES_SHOWN)
    .map((t) => `「${clipTitle(t.title.trim() || t.id)}」`)
    .join("");
  const rest =
    others.length > ALSO_BOUND_TITLES_SHOWN ? `等 ${others.length} 个任务` : "";
  return (
    `这个群还绑着${shown}${rest}。群里的 @ 只会进其中一个（优先选正在运行 / 等你回答的，同档选最近更新的）；` +
    "想让群只对应一个任务，请到那边的「需求群」弹窗取消关联或换绑"
  );
};

/** 解析服务端响应里的 alsoBoundBy：不是数组 / 条目残缺的一律丢弃（提示是增强信息，宁可少说不能出错） */
export const parseAlsoBoundBy = (raw: unknown): AlsoBoundTask[] => {
  if (!Array.isArray(raw)) return [];
  const out: AlsoBoundTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, title } = item as { id?: unknown; title?: unknown };
    if (typeof id !== "string" || !id) continue;
    out.push({ id, title: typeof title === "string" ? title : "" });
  }
  return out;
};
