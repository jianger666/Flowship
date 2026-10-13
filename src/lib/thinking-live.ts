/**
 * 思考实时态（`thinking_delta` 帧）在前端的聚合。
 *
 * 背景（2026-10-10 实测）：服务端把一整段思考攒到段结束才落一条 `thinking` 事件，
 * 期间界面上没有任何东西。一段 65s 的思考（模型第 6s 就开始了）= 用户对着
 * 「等待模型响应… 已等待 62s」干等 70s——而服务端口径的 firstDeltaMs 只有 6s，
 * 指标看起来一切正常，用户却觉得 AI 卡死。
 *
 * 现在服务端在思考进行中推 `thinking_delta`（纯内存、不落盘；首帧零延迟、其后 250ms 节流，
 * 节流只合并、不丢字）。前端把它累积成「这一段思考的原文」（本文件），
 * 再由 use-smooth-thinking 摊成逐帧匀速吐出（lib/smooth-reveal），
 * 合成一条 `thinking` 事件放进「工作过程」流程（chat-turns.ts 的 attachLiveThinking），
 * 由**已有的思考行**（rows.tsx 的 ProcessEventRow）渲染。
 *
 * 合成事件的 id = 落盘后那条 thinking 事件的 id（服务端第一个 chunk 时预定、每帧带上、落盘时复用），
 * 所以思考落盘那一刻是同一个 React 节点：用户手动展开着读的内容不会被收起，位置也不动。
 *
 * 2026-10-12 的改动：
 *  - 不再有「最近一行」摘要（原 thinkingTextToLine）。它同时被组内思考行和输入框上方的状态行
 *    各用一次——同一行字上下各出现一遍（用户截图指出的重复）；而且它取的是行尾 80 字，
 *    每个新字符都让整行向左滑一格，眼睛没法跟读。现在原文只在组内的思考行里展示
 *    （限高、贴底、顶部渐隐的实时文本区），状态行只说「思考中 · 12s」。
 *  - LiveThinking 多了累计总数 total：保留窗口截尾后 text 的下标会漂移，吐字位置要用不漂移的坐标。
 *
 * 2026-10-13 的改动（用户反馈「首轮思考很长，我切窗口再切回来，思考好像又是从第一个字开始吐」）：
 *  实时思考原来只活在 ChatView 的本地 state 里，服务端的 thinking_delta 又是纯内存、从不回放——
 *  任何「重新订阅」都等于从零开始：切到别的对话再切回来（组件卸载重挂）、SSE 断流自动重连
 *  （bootstrap 回放历史事件时「落盘事件到达 = 思考结束」的规则把它清掉），文本区都只剩
 *  重连之后新到的字、从头重新长，之前累积的几千字全没了。
 *  现在服务端记住「进行中的那一段」，每次新订阅 bootstrap 补一帧 thinking_snapshot；
 *  本文件负责把快照并回实时态（applyThinkingSnapshot），并保证「快照里已有的内容直接显示、
 *  不再演一遍」（LiveThinking.base）。回到前台（rAF 在后台暂停期间积压的字）同理（skipLiveReveal）。
 */

import { revealLength, type Revealer } from "@/lib/smooth-reveal";

/** 状态行 / 折叠组头的主文案（行内的标签沿用已有思考行的「思考」） */
export const THINKING_LIVE_LABEL = "思考中";

/**
 * 一段思考在前端最多保留多少字（保留尾部）。
 * 实测一段 65s 的思考约 7.8K 字；上限只防超长思考无限增长——实时文本区本来就只是
 * 「看一眼最近在想什么」，完整内容等落盘后在 thinking 行里看。
 */
export const THINKING_TEXT_MAX = 20_000;

/**
 * 前端维护的实时思考态。
 * `id` = 这段思考落盘后那条 thinking 事件的 id（服务端预定、同一段内每帧相同；变了 = 新的一段）；
 * `text` = 本段累积的思考原文（超过 THINKING_TEXT_MAX 只留尾部）；
 * `since` = 收到首帧的时刻（ms epoch）——合成事件的 ts（行上 hover 显示的时间）、状态行「思考中 · 12s」的起点；
 * `total` = 本段累计收到的总字符数（含 text 前面被截掉的部分），缺省 = text.length；
 * `base` = 累计坐标：这个位置之前的字「不用演」，直接显示（缺省 = 0，即全部都演）。
 *   只有从服务端快照重建的实时态才有——快照里的字用户之前已经看过（切走前）或根本没在看（后台），
 *   重新一个字一个字吐一遍就是「又从第一个字开始」。同一段内追加 / 同段重连快照都原样保留它。
 */
export interface LiveThinking {
  id: string;
  text: string;
  since: number;
  total?: number;
  base?: number;
}

/**
 * 服务端的思考快照（SSE `thinking_snapshot` 帧里的 live）：此刻「已发出的」进行中那一段。
 * 字段口径与 LiveThinking 一致：`text` 是尾部窗口（服务端同样按 THINKING_TEXT_MAX 截尾），
 * `total` 是本段累计已发出的字符数（含被截掉的前缀），`since` 是首帧发出的时刻。
 */
export interface ThinkingSnapshot {
  id: string;
  text: string;
  total: number;
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

/** 本段累计总字符数（缺省按 text.length——没截过尾时两者相等） */
export const liveThinkingTotal = (live: LiveThinking): number =>
  live.total ?? live.text.length;

/**
 * text 前面被截掉的字符数 = 累计总数 − 现存长度（精确值：total 是累计收到的数，
 * 差值恰好等于已丢弃的数量，连 dropLeadingLowSurrogate 多丢的那一个也算在内）。
 * 吐字位置用「累计坐标」，换算成 text 下标要减掉它：text[i] 的累计坐标 = offset + i。
 */
export const liveThinkingOffset = (live: LiveThinking): number =>
  liveThinkingTotal(live) - live.text.length;

/**
 * 吐字位置的下限（累计坐标）：窗口起点（更前面的字已被截掉、没法显示）与 base（不用演的前缀）取大，
 * 夹在 [0, 累计总数]。位置永远不该低于它——新挂载 / 新一段的初始位置也从它起步，
 * 所以快照重建的实时态第一帧就是整段内容，而不是空的、再一个字一个字重新长。
 * 脏值不扩散：base 为 NaN / 非数字当没有、负数被 offset 盖住、超过总数夹到总数；总数非有限当 0。
 */
export const liveThinkingFloor = (live: LiveThinking): number => {
  const total = liveThinkingTotal(live);
  if (!Number.isFinite(total)) return 0;
  const base =
    typeof live.base === "number" && !Number.isNaN(live.base) ? live.base : 0;
  return Math.min(Math.max(liveThinkingOffset(live), base), total);
};

/**
 * 收到一帧 `thinking_delta`：把 chunk 并进实时态，返回新的实时态。
 *
 * 同一段（id 相同）才累积；id 变了 = 新的一段——上一段没来得及清掉的文本不能接在前面。
 * `since` 取本段首帧的时刻，同一段内不变；`base`（快照重建时才有）同段内原样带着，换段不带。
 * 纯函数（now 由调用方传入），chat-view 的 pushThinkingDelta 只是它外面套一层 state。
 */
export const advanceLiveThinking = (
  prev: LiveThinking | null,
  id: string,
  chunk: string,
  now: number,
): LiveThinking => {
  const sameSegment = prev !== null && prev.id === id;
  return {
    id,
    text: appendThinkingText(sameSegment ? prev.text : "", chunk),
    total: (sameSegment ? liveThinkingTotal(prev) : 0) + chunk.length,
    since: sameSegment ? prev.since : now,
    ...(sameSegment && prev.base !== undefined ? { base: prev.base } : {}),
  };
};

/**
 * 收到服务端的思考快照（bootstrap 补发的 `thinking_snapshot` 帧）：返回新的实时态。
 *
 * 服务端的快照是「订阅那一刻之前已发出的全部」，之后的实时帧都排在它后面——所以它既是
 * 「切走再切回 / 重连」后重建实时态的唯一来源，也是对齐的权威：
 *  - `snap` 为 null = 服务端说「此刻没有进行中的思考」→ 清（重连期间这段思考已经落盘了）；
 *  - 本地没有、或本地是另一段：整段按快照重建，起点用服务端的首帧时刻（「思考中 · 42s」不归零），
 *    `base` = 快照末尾——这些字之前已经看过 / 没在看，直接显示、不再演一遍；
 *  - 同一段（同页重连，组件没卸载）：本地不比服务端旧就原样返回（引用稳定、位置不回拨）；
 *    否则换成服务端更全的文本与累计数，但起点和 base 沿用本地——显示位置不动，
 *    断线期间缺的字作为积压追上去，不会回到开头。
 * 脏值不扩散：累计数非有限 / 比文本短 → 按文本长度；起点非有限 → now；文本超过保留上限 → 只留尾部。
 */
export const applyThinkingSnapshot = (
  prev: LiveThinking | null,
  snap: ThinkingSnapshot | null,
  now: number,
): LiveThinking | null => {
  if (snap === null) return null;
  const text =
    snap.text.length > THINKING_TEXT_MAX
      ? dropLeadingLowSurrogate(
          snap.text.slice(snap.text.length - THINKING_TEXT_MAX),
        )
      : snap.text;
  const total = Number.isFinite(snap.total)
    ? Math.max(snap.total, text.length)
    : text.length;
  if (prev !== null && prev.id === snap.id) {
    if (liveThinkingTotal(prev) >= total) return prev;
    return {
      id: snap.id,
      text,
      total,
      since: prev.since,
      ...(prev.base !== undefined ? { base: prev.base } : {}),
    };
  }
  return {
    id: snap.id,
    text,
    total,
    since: Number.isFinite(snap.since) ? snap.since : now,
    base: total,
  };
};

/**
 * 吐字推进一帧：把推进器走到 now，返回新的显示位置（累计坐标、取整）与是否已追平。
 *
 * 即 use-smooth-thinking 的 rAF 回调里除了 setState 与排下一帧之外的全部逻辑——
 * 抽成纯函数是为了不起 DOM 也能测（见 tests/thinking-reveal-integration.test.ts）：
 *  - 目标是累计总数（total）、不是 text.length：保留窗口截尾后 text.length 会回落，位置会倒退；
 *  - 窗口起点跑到了位置前面（头部没来得及显示就被截尾丢了，比如标签页在后台时一口气来了很多批）
 *    → 位置直接跳到起点，不去「吐」已经不存在的字；
 *  - 位置低于 base（快照重建的实时态，base 之前的字不用演）→ 同样直接跳过去（下限见 liveThinkingFloor）；
 *  - `done` = 位置已到目标。位置恒为有限数（脏位置 / 脏目标由推进器规范化，见 smooth-reveal 的 stepReveal），
 *    所以追平后循环一定会停，不会空转 rAF。
 */
export const stepLiveReveal = (
  revealer: Revealer,
  live: LiveThinking,
  now: number,
): { len: number; done: boolean } => {
  const target = liveThinkingTotal(live);
  const floor = liveThinkingFloor(live);
  if (revealer.position < floor) revealer.seek(floor);
  const pos = revealer.advance(target, now);
  return { len: Math.floor(pos), done: !(pos < target) };
};

/**
 * 回到前台：位置直接到最新，已追平。
 *
 * 标签页 / 窗口在后台时 rAF 暂停，但 SSE 照常到——回来时积压了几百上千字。不跳的话，推进器会把它当
 * 「大积压」快速追赶：先一帧刷出一大块、再以几倍于正常的速度滚几秒，和「没在看的时候长出来的字
 * 不用演」相反（浏览器实测：积压 2400 字，回前台 250ms 内跳 1560 字、之后高速追了 5 秒）。
 * 只动位置、不碰速率估计与「已见到的目标」——下一帧推进器会把这一大块当作突发（不计入到达速率），
 * 之后新到的字照常匀速吐。
 * 脏目标（非有限）按 0，不让 NaN 进位置。
 */
export const skipLiveReveal = (
  revealer: Revealer,
  live: LiveThinking,
): { len: number; done: true } => {
  const target = liveThinkingTotal(live);
  const pos = Number.isFinite(target) ? target : 0;
  revealer.seek(pos);
  return { len: Math.floor(pos), done: true };
};

/**
 * 吐字平滑的输出：按「累计坐标下已显示到哪里」切出要给界面看的那一份。
 *
 * `revealed` 是累计坐标（含被截掉的前缀），所以先减去 offset 换算成 text 下标。
 *  - 已显示的部分 ≥ 现存全部 → 原对象原样返回（引用稳定，下游 memo 不必重算）；
 *  - 窗口起点跑到了显示位置前面（没来得及显示的头部被截尾丢了）→ 当作 0，下一帧位置会跳到起点；
 *  - 切点不落在 emoji 等代理对中间（见 revealLength）；
 *  - 非有限数（脏值）一律按 0——宁可少显示，也不让 NaN 渗进文本切片与坐标。
 * 输出的 `total` 保持「offset + 已显示长度」，坐标不变量（offset = total − text.length）对下游仍然成立。
 */
export const revealLiveThinking = (
  live: LiveThinking,
  revealed: number,
): LiveThinking => {
  const offset = liveThinkingOffset(live);
  const safe = Number.isFinite(revealed) ? revealed : 0;
  const inWindow = Math.min(Math.max(safe - offset, 0), live.text.length);
  const shown = revealLength(inWindow, live.text);
  if (shown >= live.text.length) return live;
  return { ...live, text: live.text.slice(0, shown), total: offset + shown };
};
