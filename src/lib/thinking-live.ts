/**
 * 思考实时态（`thinking_delta` 帧）在前端的聚合与展示切片。
 *
 * 背景（2026-10-10 实测）：服务端把一整段思考攒到段结束才落一条 `thinking` 事件，
 * 期间界面上没有任何东西。一段 65s 的思考（模型第 6s 就开始了）= 用户对着
 * 「等待模型响应… 已等待 62s」干等 70s——而服务端口径的 firstDeltaMs 只有 6s，
 * 指标看起来一切正常，用户却觉得 AI 卡死。
 *
 * 现在服务端在思考进行中推 `thinking_delta`（纯内存、不落盘；首帧零延迟、其后 250ms 节流，
 * 节流只合并、不丢字）。前端把它累积成「这一段思考的原文」，合成一条 `thinking` 事件放进
 * 「工作过程」流程（chat-turns.ts 的 attachLiveThinking），由**已有的思考行**
 * （rows.tsx 的 ProcessEventRow）渲染：外观、默认折叠、点开看斜体正文，都和落盘后的思考行一样；
 * 只多两处——进行中有个转圈、折叠摘要显示最新一行。
 *
 * 合成事件的 id = 落盘后那条 thinking 事件的 id（服务端第一个 chunk 时预定、每帧带上、落盘时复用），
 * 所以思考落盘那一刻是同一个 React 节点：用户点开着读的内容不会被收起，位置也不动。
 *
 * 为什么摘要取行尾而不是行首：思考常是一整行几百字的长段落，取行首在整段期间纹丝不动，
 * 看起来像卡死；取行尾才是「正在往下写」。（已有思考行的 summarize 取行首——落盘后是静态摘要，
 * 那样没问题；进行中才需要这个。）
 */

/** 状态行 / 折叠组头的主文案（行内的标签沿用已有思考行的「思考」） */
export const THINKING_LIVE_LABEL = "思考中";

/**
 * 一段思考在前端最多保留多少字（保留尾部）。
 * 实测一段 65s 的思考约 7.8K 字；上限只防超长思考无限增长——展开区本来就只是「看一眼
 * 最近在想什么」，完整内容等落盘后在 thinking 行里看。
 */
export const THINKING_TEXT_MAX = 20_000;

/** 提取「最近一行」时只看尾部这么多字：最近一行远短于此，没必要对全文 split */
export const THINKING_TAIL_MAX = 600;

/** 摘要行最大字数（行尾截断） */
export const THINKING_LINE_MAX = 80;

/**
 * 前端维护的实时思考态。
 * `id` = 这段思考落盘后那条 thinking 事件的 id（服务端预定、同一段内每帧相同；变了 = 新的一段）；
 * `text` = 本段累积的思考原文；
 * `since` = 收到首帧的时刻（ms epoch）——合成事件的 ts（行上 hover 显示的时间）。
 */
export interface LiveThinking {
  id: string;
  text: string;
  since: number;
}

/** 切点落在 emoji 等代理对中间会剩一个孤立的低代理项，显示成 �——丢掉它 */
const dropLeadingLowSurrogate = (s: string): string => {
  const first = s.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? s.slice(1) : s;
};

/** 把新增 chunk 并进本段文本；超过 THINKING_TEXT_MAX 只保留尾部 */
export const appendThinkingText = (text: string, chunk: string): string => {
  const next = text + chunk;
  if (next.length <= THINKING_TEXT_MAX) return next;
  return dropLeadingLowSurrogate(next.slice(next.length - THINKING_TEXT_MAX));
};

/**
 * 文本尾部 → 展示用的「最后一行」：取最后一个非空行、压空白、超长取行尾并加前缀省略号。
 * 一行都还没有（空 / 全空白）返回 ""——调用方据此展示「思考中」而不带细节。
 */
export const thinkingTailToLine = (
  tail: string,
  max: number = THINKING_LINE_MAX,
): string => {
  const lines = tail.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const flat = lines[i]!.replace(/\s+/g, " ").trim();
    if (flat) {
      last = flat;
      break;
    }
  }
  if (last.length <= max) return last;
  return `…${dropLeadingLowSurrogate(last.slice(last.length - max))}`;
};

/**
 * 整段累积文本 → 「最后一行」。先只截尾部再 split：文本可能有上万字、每 250ms 算一次。
 * 截尾不改变结果：最后一个非空行就在文本末尾；比窗口长的行本来就只取行尾 THINKING_LINE_MAX 字。
 * 唯一的例外是末尾连续 THINKING_TAIL_MAX 个字符全是空白（窗口里找不到非空行）——会得到 ""，
 * 等同「在思考、暂无可展示的行」，无害。
 */
export const thinkingTextToLine = (
  text: string,
  max: number = THINKING_LINE_MAX,
): string =>
  thinkingTailToLine(
    text.length > THINKING_TAIL_MAX
      ? text.slice(text.length - THINKING_TAIL_MAX)
      : text,
    max,
  );
