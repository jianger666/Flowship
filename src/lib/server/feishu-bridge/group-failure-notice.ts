/**
 * 回群 / 发群失败 → 在任务事件流里留一条 info，让属主看得见（所有「往群里发」的出口共用这一个）。
 *
 * 为什么要有：群里文字现在都是卡片（建卡实体 → 发 interactive），依赖 `cardkit:card:write`；
 * 权限缺失 / cardkit 接口故障时，连「缺机器人权限：xxx」这种提示自己也发不出去，群里一片沉默，
 * 而失败原先只有一条 console.warn、得翻日志才知道。留在事件流里，属主打开任务就能看到「这条没发出去 + 为什么」。
 *
 * 原先只有入向回执（group-route 的 `replyToGroup`）会留；出向（答疑回复 / 推进回执 / 问群卡）和
 * 卡片回调（旧卡点击后的回执）发不出去时仍然只 warn——2026-10-17 复审指出「只在一处对属主可见」，
 * 现在它们都走这里。
 *
 * 刻意不做的：不加纯文本降级出口——「群里别再新加 text / post 出口」是已定的决定（docs/feishu-group-collab.md），
 * 这里只让失败可见、不改发送方式。
 *
 * - 同一个群一分钟只记一条（各出口共用同一个节流 key）：连发的回执全挂时不刷屏；
 * - 永不抛：它跑在「已经出错」的路径上，不能把原本只 warn 的失败变成抛错、打断原有流程；
 * - info 事件不会被出向 tap 回灌进群（tap 只认 ask / 回答 / 产物这几类），不存在「失败 → 回执 → 再失败」的环。
 */

import { describeScopeShortage } from "@/lib/server/route-helpers";
import { writeOwnedEventAndPublish } from "@/lib/server/task-stream";

import { throttleOncePerMinute } from "./group-shared";
import { describeLarkError, LarkApiError } from "./types";

const LOG = "[feishu-bridge/group-failure-notice]";

/** 同一个群这条提示的节流 key（入向 / 出向 / 卡片回调共用，合起来一分钟一条） */
const throttleKeyOf = (chatId: string): string => `group-reply-failed:${chatId}`;

/** 事件正文里「原因」部分的最大长度 */
const REASON_MAX = 300;

/** Node `execFile` 失败时的 message 形如 `Command failed: <完整命令行>\n<stderr>`——命令行里是本机 lark-cli 路径 + 整个请求体 */
const CLI_FAILURE_PREFIX = /^Command failed:/;

const firstNonEmptyLine = (s: string): string =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? "";

/**
 * 把一次发群失败整理成「读得出原因」的一行话。
 *
 * - 缺 scope：翻成人话（缺哪个 scope + 去哪开），scope 文案可能只出现在 stderr 里，所以三处一起看；
 * - 传输层失败且解析不出 JSON（`Command failed: <命令行>…`）：只取 stderr 首行——命令行会把 300 字占满、
 *   把真正的原因和飞书码 / log_id 截掉，还带着本机路径和请求体；没有 stderr 就说「没有错误输出」；
 * - CLI 层面的失败（`raw` 是 `{stdout, stderr}`）里 `code` 是进程退出码 / 系统错误名，不是飞书错误码——不当「飞书 N」展示；
 * - 其它错误（含已解析出飞书错误码的）：带上飞书错误码 / 接口 / log_id 方便定位。
 *
 * `cardkitRelated`：这次失败看起来跟卡片实体（cardkit）有关——决定要不要附「文字走卡片、需要 cardkit:card:write」的说明
 * （机器人不在群 / 限流 / 超时也这么写会误导排查方向）。
 */
export const describeGroupSendFailure = (
  err: unknown,
): { reason: string; cardkitRelated: boolean } => {
  const message = err instanceof Error ? err.message : String(err);
  const larkErr = err instanceof LarkApiError ? err : null;
  const rawObj =
    larkErr?.raw && typeof larkErr.raw === "object"
      ? (larkErr.raw as { stdout?: unknown; stderr?: unknown })
      : undefined;
  const stderr = typeof rawObj?.stderr === "string" ? rawObj.stderr : "";
  const stdout = typeof rawObj?.stdout === "string" ? rawObj.stdout : "";
  // 解析成功的飞书错误，raw 是响应体本身；解析不出来 / 超时的才是 { stdout, stderr }
  const isCliFailure = !!rawObj && ("stdout" in rawObj || "stderr" in rawObj);

  const scope = describeScopeShortage([message, stderr, stdout].join("\n"));

  let base = message;
  if (CLI_FAILURE_PREFIX.test(message)) {
    const tail = stderr || message.split(/\r?\n/).slice(1).join("\n");
    base = firstNonEmptyLine(tail) || "lark-cli 调用失败（没有错误输出）";
  }

  let reason: string;
  if (scope) {
    reason = scope;
  } else if (larkErr) {
    reason = describeLarkError(
      new LarkApiError(base, {
        code: isCliFailure ? undefined : larkErr.code,
        api: larkErr.api,
        logId: larkErr.logId,
        fieldViolations: larkErr.fieldViolations,
      }),
    );
  } else {
    reason = base;
  }

  const cardkitRelated =
    /cardkit/i.test(larkErr?.api ?? "") ||
    /cardkit/i.test(base) ||
    /cardkit/i.test(stderr);
  return { reason: reason.slice(0, REASON_MAX), cardkitRelated };
};

/**
 * 记一条「群里有一条消息没发出去」。
 * @param taskId 要写事件的任务（调用方已知；找不到任务的入向路径先自己 resolve、没有就不调本函数）
 * @param what   可选：是哪类消息没发出去（「答疑回复」「问群卡」……），写进文案方便定位
 */
export const noteGroupSendFailure = async (
  taskId: string,
  chatId: string,
  err: unknown,
  what?: string,
): Promise<void> => {
  try {
    if (!taskId) return;
    if (!throttleOncePerMinute(throttleKeyOf(chatId))) return;
    const { reason, cardkitRelated } = describeGroupSendFailure(err);
    const subject = what ? `群里${what}没发出去` : "群里有一条回复没发出去";
    const hint = cardkitRelated
      ? "群里的文字走卡片发送（需要 cardkit:card:write），权限或接口异常时会这样；可到设置页飞书桥接检查"
      : "可到设置页飞书桥接检查，详情见应用日志";
    await writeOwnedEventAndPublish(taskId, () => true, {
      kind: "info",
      text: `${subject}：${reason}。${hint}`,
    });
  } catch (noteErr) {
    console.warn(
      `${LOG} 记录发群失败时出错 chat=${chatId}:`,
      noteErr instanceof Error ? noteErr.message : noteErr,
    );
  }
};
