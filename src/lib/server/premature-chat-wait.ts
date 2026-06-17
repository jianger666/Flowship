/**
 * 兜底 A：chat「没把回答写成正文就想挂等」的纯判定（无 IO、便于单测）。
 *
 * 背景：composer-2.5 等模型在 chat 模式有时查完代码 / 只 thinking 就直接调 wait_for_user、
 * 不把结论写成正文 → 用户看到「空白回复」。提示词防不住、由服务端在 wait_for_user handler
 * 调本判定硬拦（见 chat-mcp.ts 的 isPrematureChatWaitOnce / wait_for_user）。
 *
 * 抽成独立模块（对齐 shell-guard-rules / submit-mr-guard 的「guard 纯逻辑 + 配套单测」惯例）：
 * 协议兜底逻辑分支多、typecheck/lint 只证语法不证协议、必须喂事件数组测边界。
 */
import type { TaskEvent } from "@/lib/types";

// 兜底 A 需要完整轮次边界；0 是 task-fs.readRecentEvents 的「读全量」约定。
export const PREMATURE_CHAT_WAIT_EVENT_LIMIT = 0;

// ---- 「纯宣告 / 预告」正文识别（V0.8.4、reviewAI 拍板的极窄启发式）----
// 背景：弱模型（composer-2.5）会发一句「我先写一篇…写完后进入等待你的下一条消息」当回答、
// 紧接着就挂等——这条**是**正文（lastAnswerIdx≥0）、wait-ack 又不算干活、原判定直接放行。
// 但它描述的是「将来要做」、不是「本轮成品」、用户看到的就是一句预告 + 空白。
// 纯 prompt 防不住（已修 7 处仍复现、是模型「知道却没执行」），由这道窄判定硬拦。
//
// 设计「宁漏不误」（误拦还有 chat-mcp 的 CAP=2 兜底、但第一版宁可漏一点）：两档信号——
//   - 强信号：短正文里出现「内部等待机制」词——这类话本就违反「对用户透明」、
//     短正文只有它、没成品 → 判宣告。注意别把普通「等你」写宽（单独「我在这等你」不拦）。
//     ⚠️ 不收裸 `curl`：用户在 chat 里完全可能问「curl 调接口示例」、agent 正常答里就含 curl、
//     会被误拦（reviewAI P1）。靠 进入等待/挂等/wait_for_user/监听你下一 已够抓内部机制泄漏。
//   - 组合信号：短正文**同时**命中「将来式计划 + 交付动词 + 延后/未完成语义」三件套（缺一不算）。
//     三件套缺一不可、是为了区分「我先给你结论：可以」（已交付、不拦）和
//     「我先写…写完后再发」（未交付、拦）。
const ANNOUNCE_INTERNAL_RE = /进入等待|挂等|wait_for_user|监听你的?下一/;
const ANNOUNCE_PLAN_RE =
  /我先|我会|我这就|我准备|接下来|马上|稍[后候]|这就|下面我(将|来)/;
const ANNOUNCE_DELIVER_RE = /写|整理|生成|输出|给你|提供|查|看|起草|拟|总结/;
const ANNOUNCE_DEFER_RE =
  /写完(后|了)|整理好后|完成后|稍[后候](发|给|再)|再发|等会|待会|后面再|然后再|(查|看|写|整理|总结|生成)一下/;

// 强信号放宽到 200、组合信号收紧到 120：真·成品（文章 / 代码 / 方案）通常远超此长度。
const PURE_ANNOUNCE_STRONG_MAXLEN = 200;
const PURE_ANNOUNCE_COMBO_MAXLEN = 120;

/**
 * 一条正文是不是「纯宣告 / 预告」（只说将来要做、没摆出本轮成品）。
 * 反例护栏：长正文（真文章 / 代码）超阈值 → 不判；「我先给你结论：可以」缺延后语义 → 不判。
 */
export const isPureAnnouncement = (text: string): boolean => {
  const t = text.trim();
  if (t.length === 0) return false;
  // 强信号：内部等待机制泄漏
  if (t.length <= PURE_ANNOUNCE_STRONG_MAXLEN && ANNOUNCE_INTERNAL_RE.test(t)) {
    return true;
  }
  // 组合信号：将来式计划 + 交付动词 + 延后/未完成语义（三件套缺一不算）
  return (
    t.length <= PURE_ANNOUNCE_COMBO_MAXLEN &&
    ANNOUNCE_PLAN_RE.test(t) &&
    ANNOUNCE_DELIVER_RE.test(t) &&
    ANNOUNCE_DEFER_RE.test(t)
  );
};

/**
 * 判定一次 wait_for_user 是否 premature（= 该回答用户却没把回答写成正文就挂等）。
 *
 * 核心不变量：本轮 run 有没有「用户正在等的回答」（obligation），而不是「边界是哪类事件」。
 *  - run 起点 = 最后一条「Chat 任务启动」info；该 info 的 `meta.firstMessageEventId` 显式指向
 *    触发本轮的首条消息事件（chat-reply 启 run 前写 user_reply、把它的 id 塞进来、不靠位置推断）。
 *    旧日志无 meta 时、回退兼容「user_reply 紧贴 chat_start 前一格」（chat-reply 先写 user_reply
 *    再启 run、中间只做 MCP 探测不落事件）。
 *  - obligation 来源：轮内追问（`user_reply` 落在 chat_start 之后、优先）或触发本轮的首条消息。
 *  - 有 obligation：没把回答写成正文（含只 thinking / 只调工具）→ premature；本轮所有正文都只是
 *    「宣告 / 预告」（我先写…/进入等待…、见 isPureAnnouncement）→ premature；答了又干活没回报
 *    （最后一次工具调用晚于最后一条正文）→ premature。
 *  - 无 obligation（resume 起手、无人等回答）：一律放行——兜底只守「用户问题不能空白」、
 *    不拿 agent 内部自检（read/grep 历史）为难它。有副作用工具（write/shell）的安全是另一条规则、不掺这里。
 *  - 「干活的工具」排除「等待握手」类调用（wait_for_user 本身 + wait-ack 的 curl）——
 *    它们是挂等机制 / 当前被判定对象、不算干活；漏排会把「答完→调 wait_for_user」误判成 premature。
 */
export const classifyPrematureChatWait = (events: TaskEvent[]): boolean => {
  // run 起点（最后一条「Chat 任务启动」）+ 该事件本身 + 最后一条 user_reply 的下标
  let runStartIdx = -1;
  let runStartEvent: TaskEvent | undefined;
  let lastUserReplyIdx = -1;
  events.forEach((e, i) => {
    if (e.kind === "user_reply") lastUserReplyIdx = i;
    else if (e.kind === "info" && e.text.startsWith("Chat 任务启动")) {
      runStartIdx = i;
      runStartEvent = e;
    }
  });

  // 本轮 run 欠不欠用户一个回答（hasObligation）+ 从哪开始 scan 这一轮（turnStart）
  let hasObligation: boolean;
  let turnStart: number;
  if (lastUserReplyIdx > runStartIdx) {
    // 轮内追问 / 催促：以它为义务起点（它之前那条回答是答上一问的、不能算作本问的回答）
    hasObligation = true;
    turnStart = lastUserReplyIdx;
  } else {
    // 本轮无轮内追问：看本轮 run 是否由首条消息触发（meta 显式关联优先、相邻位置回退旧日志）
    const fmId =
      typeof runStartEvent?.meta?.firstMessageEventId === "string"
        ? runStartEvent.meta.firstMessageEventId
        : undefined;
    // 注意 lastUserReplyIdx >= 0 这个守卫：否则 runStartIdx=0（chat_start 是首事件、无 user_reply）时
    // -1 === 0-1 会假阳性判成「有首条消息」、把 resume 自检误拦
    const adjacentFirstMsg =
      lastUserReplyIdx >= 0 && lastUserReplyIdx === runStartIdx - 1;
    hasObligation = Boolean(fmId) || adjacentFirstMsg;
    // firstMessage 的 user_reply 落在 chat_start 之前、且本身既非正文也非工具、
    // 所以统一从 run 起点之后 scan 即可（不影响 lastAnswer / lastWorkTool 的统计）
    turnStart = runStartIdx;
  }

  // 连 run 起点都不在窗口里、又没轮内追问 → 没法可靠判定、fail-open 放行
  if (turnStart < 0) return false;

  // 「等待握手」类工具调用——不算「干活」。基于结构化 meta 字段判断、不用展示文本子串：
  // text.includes 太脆——agent 答完后 dogfood 本仓、grep 到 "wait_for_user" / "wait-ack"
  // 相关代码会被误排成握手 → 漏拦真·干活（reviewAI 拍板、2026-06-16）。
  //   - wait_for_user：MCP wrapper（meta.name="mcp" + innerToolName=wait_for_user）。
  //     源头修复后成功的 wait_for_user 已不写成 tool_call 事件（见 chat-runner）、此处是防御。
  //   - wait-ack 的 curl long-poll：必须 shell + curl + 命中 /api/tasks/.../wait-ack 端点
  //     （三条件一起、把「shell 搜代码碰巧含 /wait-ack」和「真·wait-ack 长连接」区分开）。
  // 不写旧日志 text 回退：本仓桌面单进程、重启即杀所有在跑 run、开发期不写向后兼容；
  // 且 work-scan 只扫本轮 run 起点之后的事件、都是新格式。
  const isWaitForUserName = (n: unknown): boolean =>
    n === "wait_for_user" || n === "Wait For User";
  const isWaitHandshakeTool = (e: TaskEvent): boolean => {
    const name = e.meta?.name;
    // wait_for_user：直发 name（SDK 不走 wrapper 的路径、防御一行成本）或 MCP wrapper
    // （跟 chat-runner 的 isWaitForUser 双判保持对称）
    if (isWaitForUserName(name)) return true;
    if (name === "mcp" && isWaitForUserName(e.meta?.innerToolName)) return true;
    if (
      name === "shell" &&
      /\bcurl\b/.test(e.text) &&
      e.text.includes("/api/tasks/") &&
      e.text.includes("/wait-ack")
    ) {
      return true;
    }
    return false;
  };

  let lastAssistantIdx = -1; // 最后一条非空正文（含纯宣告）
  let lastSubstantiveAnswerIdx = -1; // 最后一条「实质正文」（排除纯宣告 / 预告）
  let lastWorkToolIdx = -1; // 最后一次「干活的工具调用」（排除 wait 握手类）
  events.slice(turnStart + 1).forEach((e, i) => {
    if (e.kind === "assistant_message" && e.text.trim().length > 0) {
      lastAssistantIdx = i;
      // 纯宣告 / 预告不刷新「有效回答」位置——否则「答→查→只发个宣告」会绕过下面
      // 「实质正文之后又干活没回报」的判定（reviewAI P1）。
      if (!isPureAnnouncement(e.text)) lastSubstantiveAnswerIdx = i;
    } else if (e.kind === "tool_call" && !isWaitHandshakeTool(e)) {
      lastWorkToolIdx = i;
    }
  });

  // 无人等回答（resume 起手）：一律放行、不管 agent 内部自检
  if (!hasObligation) return false;

  // 有用户在等回答：
  if (lastAssistantIdx < 0) return true; // 压根没把回答写成正文（含只 thinking）→ premature
  // 本轮所有正文都只是「宣告 / 预告」（我先写…/我马上查…/进入等待…）、没摆出任何本轮成品 → premature。
  // 看「有没有任一实质正文」、不是「最后一条命中」——避免误伤「先交付长文、末尾附一句礼貌等待句」。
  if (lastSubstantiveAnswerIdx < 0) return true;
  if (lastWorkToolIdx < 0) return false; // 答了实质正文、之后没再干活 → 放行
  // 实质正文之后又干活、却没再补一条实质正文（哪怕补了也只是宣告）→ premature
  return lastWorkToolIdx > lastSubstantiveAnswerIdx;
};
