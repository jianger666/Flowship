/**
 * 电脑操作的「会话事件」（主进程 → server，`evt desktop_session`）：让用户知道他的电脑刚刚发生了什么。
 *
 * 主进程的会话状态机（electron-app/desktop/session.mjs）在这些时刻发事件：
 * unlocking / unlocked / unlock_failed / user_took_over / relocked / relock_failed / session_ended，
 * 以及 Windows 锁屏后台档新增的 background_started（不解锁、直接操作已打开的窗口）/ foreground_started（后台档升级成解锁后的前台档）。
 * 这里把其中**用户需要知道**的几种翻译成一句中文，做两件事：
 *  1. 写进该任务的事件流（`info`，灰色居中细线）——Flowship 里回看这个任务就能看到「电脑什么时候被解锁、什么时候锁回去」；
 *  2. 飞书私聊推给属主（仅当飞书桥接开着）——用户不在电脑前时，这是他唯一能看到的地方：
 *     「已自动解锁」「已锁回去」「没能锁回去，请尽快手动锁屏」都不该悄悄发生。
 *
 * 哪些推飞书：unlocked / relocked / relock_failed / unlock_failed。user_took_over 一般不推（用户就在电脑前，他刚动的键鼠）；
 * 唯独「电脑原本是锁屏的、是我们解锁的」那一次要推——猫 / 路人 / 鼠标抖动也会触发接管，而我们不会再锁回去，
 * 用户人不在的话，电脑就这么敞着了，必须让他知道（`unlockedByUs`）。
 * session_ended 只在「异常结束」（空闲超时 / 到时间上限 / 总开关被关 / 后台操作时用户回来解了锁）时写任务流，不推飞书；
 * 唯独 secure_desktop（操作中弹出 UAC 等系统安全提示，AI 已停手）要推——这种弹窗只有用户本人能点。unlocking 是瞬态，不展示。
 * background_started 只写任务流（电脑一直是锁着的、没有解锁也没有遮罩，没什么需要用户马上处理的）；
 * foreground_started 不展示：后台档升级成前台档时，紧挨着它之前的 unlocked 事件已经说了「自动解锁」，不重复。
 *
 * 另外：这里还顺手维护「任务名下可能开着会话」的登记（open-sessions.ts）——会话结束类的事件到来就清掉，
 * 停止钩子才不会对一个早就没有会话的任务白发 cancel。
 *
 * # 为什么轻量
 * 注册由 `getDesktopTools` 触发（会话创建时必经），按 bridge 实例去重（同 settings-events.ts 的做法）；
 * 任务流 / 飞书这些重模块只在事件真的到来时才动态加载，注册本身只依赖 bridge.ts。
 * 注册前到达的事件由 bridge 的事件缓冲（20 条 / 60 秒）补发。
 *
 * 事件里的文字（error）来自主进程自己的步骤报告（不含屏幕内容 / 凭据），仍然单行化 + 限长后再展示。
 */

import { getBrowserBridge, type BrowserBridge } from "../browser/bridge";
import { markDesktopSessionClosed } from "./open-sessions";

/** 主进程发来的事件名 */
export const DESKTOP_SESSION_EVENT = "desktop_session";

/** 与主进程 / server 其它处同口径的 taskId 形态（字母数字 _ -，≤200）；`_` = 主进程没有归属任务的事件 */
const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;

const MAX_ERROR_CHARS = 120;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const cleanError = (v: unknown): string => {
  const flat = String(v ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}…` : flat;
};

export interface DesktopSessionNotice {
  /** 写进任务事件流的文案 */
  text: string;
  /** 推给飞书的文案（`{task}` 占位由调用方换成「（任务「xxx」）」或空）；null = 不推 */
  feishu: string | null;
}

const TASK_MARK = "{task}";

/**
 * 纯函数：主进程的会话事件 → 展示文案。不需要展示的事件（unlocking / 正常结束 / 不认识的）返回 null。
 * @param data 事件载荷（`{ kind, reason?, error?, ... }`）
 */
export const describeDesktopSessionEvent = (data: unknown): DesktopSessionNotice | null => {
  if (!isRecord(data) || typeof data.kind !== "string") return null;
  const error = cleanError(data.error);
  switch (data.kind) {
    case "unlocked":
      return {
        text: "🔓 这台电脑原本是锁屏的，已按你的设置自动解锁；操作期间屏幕上会盖一层遮罩，做完会自动锁回去。",
        feishu: `🔓 为了操作电脑，Flowship 已按你的设置自动解锁了这台电脑${TASK_MARK}。操作期间屏幕上会盖一层遮罩，做完会自动锁回去。`,
      };
    case "background_started":
      return {
        text: "🔒 电脑仍是锁屏状态：AI 正在用「锁屏后台模式」操作你已经打开的应用窗口（不解锁、不盖遮罩，也用不到开机密码）。",
        feishu: null,
      };
    case "foreground_started":
      // 升级前的解锁已经发过 unlocked（含飞书推送）：这里不重复说
      return null;
    case "relocked":
      // 解锁之后没能盖上遮罩：主进程不让 AI 在「解着锁、没遮罩、人又不在」的状态下干活，当场锁回去并中止——
      // 用户只看到一句「已锁回去」会一头雾水，这次到底干没干成
      if (data.reason === "overlay_failed") {
        return {
          text: "🔒 解锁之后没能盖上屏幕遮罩（旁人可能看到屏幕），为了安全 AI 没有操作电脑，已把电脑锁回去。",
          feishu: `🔒 Flowship 解锁电脑后没能盖上屏幕遮罩，为了安全没有继续操作，已把电脑锁回去${TASK_MARK}。`,
        };
      }
      return { text: "🔒 电脑已自动锁回去。", feishu: `🔒 电脑已自动锁回去${TASK_MARK}。` };
    case "relock_failed":
      return {
        text: `⚠️ 电脑没能自动锁回去${error ? `（${error}）` : ""}，请尽快手动锁屏。`,
        feishu: `⚠️ 电脑没能自动锁回去${TASK_MARK}${error ? `：${error}` : ""}。请尽快手动锁屏！`,
      };
    case "unlock_failed":
      // 没输过开机密码的失败（没权限 / 读不到密码 / 密码里有输入不了的字符 / 用户自己解开了）不进冷却：别让用户白等 10 分钟
      if (data.cooldown === false) {
        return {
          text: `⚠️ 自动解锁没有成功${error ? `（${error}）` : ""}。没有输入过开机密码，已停手；处理好之后再让 AI 试一次即可。`,
          feishu: `⚠️ 没能自动解锁电脑${TASK_MARK}${error ? `：${error}` : ""}。没有输入过开机密码，已停手；处理好之后再让 AI 试一次即可。`,
        };
      }
      return {
        text: `⚠️ 自动解锁没有成功${error ? `（${error}）` : ""}，已停手；10 分钟内不会再试。请检查「设置 → 电脑操作」里保存的开机密码。`,
        feishu: `⚠️ 没能自动解锁电脑${TASK_MARK}${error ? `：${error}` : ""}。已停手，10 分钟内不会再试。请检查「设置 → 电脑操作」里保存的开机密码。`,
      };
    case "user_took_over":
      // 电脑原本是锁屏的、是我们解锁的：接管之后我们不会再锁回去（用户可能正在用，也可能是猫 / 路人 / 鼠标抖动）。
      // 用户人不在的话，电脑就这么敞着了——必须让他知道，并且给出该做什么
      if (data.unlockedByUs === true) {
        return {
          text: "🖐 检测到键盘 / 鼠标有动静，AI 已暂停对电脑的操作。注意：这台电脑原本是锁屏的，是 AI 自动解锁的，现在没有重新锁上——如果不是你本人在用，请尽快手动锁屏。",
          feishu: `🖐 电脑上有人动了键盘 / 鼠标，AI 已让位${TASK_MARK}。这台电脑原本是锁屏的、是 Flowship 自动解锁的，现在没有重新锁上——如果不是你本人在用，请尽快手动锁屏！`,
        };
      }
      return { text: "🖐 检测到你在操作键盘 / 鼠标，AI 已暂停对电脑的操作。", feishu: null };
    case "session_ended": {
      // 正常结束（AI 自己结束 / 任务停止）不打扰；只有「异常结束」说一声，免得用户不明白遮罩为什么消失
      switch (data.reason) {
        case "idle":
          return { text: "电脑操作因为长时间没有新动作，已自动结束。", feishu: null };
        case "max_duration":
          return { text: "电脑操作达到单次会话的时长上限（15 分钟），已自动结束。", feishu: null };
        case "disabled":
          return { text: "你在设置里关闭了「电脑操作」，这次操作已结束。", feishu: null };
        case "unlocked_externally":
          // 锁屏后台操作进行中，用户回来解了锁：后台档的前提没了，会话收掉（下一次调用会按「没锁屏」正常开始）
          return { text: "你解锁了电脑，锁屏后台操作已结束。", feishu: null };
        case "overlay_incomplete":
          // 操作进行中显示器配置变了（接入新显示器 / 改分辨率）、有一块屏幕的遮罩没能建出来：那块屏幕是裸的，旁人看得见 AI 在干什么。
          // 主进程已经结束会话并锁回去（没锁成会另有 relock_failed 的提醒，那条才推飞书）；AI 下一次调用会重新开始、重新盖遮罩。
          return {
            text: "操作过程中显示器配置变了（接入了新的显示器或分辨率变了），有一块屏幕没能盖上遮罩，为安全起见 AI 已暂停对电脑的操作" +
              (data.relocked === true ? "，并把电脑锁回去了。" : "。"),
            feishu: null,
          };
        case "secure_desktop":
          // 操作进行中屏幕上弹出了系统安全提示（Windows UAC 权限确认等）：AI 已停手交还用户，也没有锁屏。
          // 这种弹窗只有用户本人能点，用户不在电脑前就会一直挂着——必须推给他；电脑是我们解锁的话，还要说清「没有锁回去」（同 user_took_over）
          if (data.unlockedByUs === true) {
            return {
              text: "⚠️ 屏幕上弹出了需要你亲自处理的系统安全提示（如 UAC 权限确认），AI 已暂停对电脑的操作。注意：这台电脑原本是锁屏的，是 AI 自动解锁的，现在没有重新锁上——请尽快回到电脑前处理，或手动锁屏。",
              feishu: `⚠️ 电脑上弹出了需要你亲自处理的系统安全提示（如 UAC 权限确认）${TASK_MARK}，AI 已暂停操作，也不会替你点。注意：这台电脑原本是锁屏的、是 Flowship 自动解锁的，现在没有重新锁上——请尽快回到电脑前处理，或手动锁屏！`,
            };
          }
          return {
            text: "⚠️ 屏幕上弹出了需要你亲自处理的系统安全提示（如 UAC 权限确认），AI 已暂停对电脑的操作，也不会替你点。",
            feishu: `⚠️ 电脑上弹出了需要你亲自处理的系统安全提示（如 UAC 权限确认）${TASK_MARK}，AI 已暂停操作，也不会替你点。请回到电脑前处理后再让 AI 继续。`,
          };
        default:
          return null;
      }
    }
    default:
      return null;
  }
};

/**
 * 这条事件是否意味着「该任务名下的电脑操作会话没了」（登记要清掉）：正常 / 异常结束、用户接管、解锁没成功（会话根本没开起来），
 * 以及开会话中途被撤销（遮罩没盖上 / 解锁时被取消——这两种之后没有 session_ended，所以按 reason 认）。
 */
const endsSession = (data: Record<string, unknown>): boolean => {
  switch (data.kind) {
    case "session_ended":
    case "user_took_over":
    case "unlock_failed":
      return true;
    case "relocked":
    case "relock_failed":
      return data.reason === "overlay_failed" || data.reason === "cancelled";
    default:
      return false;
  }
};

export interface DesktopSessionEventDeps {
  /** 任务标题；任务不存在返回 null（不往不存在的任务里写事件） */
  taskTitle: (taskId: string) => Promise<string | null>;
  /** 往任务事件流写一条 info */
  writeTaskEvent: (taskId: string, text: string, meta: Record<string, unknown>) => Promise<void>;
  /** 给属主发飞书私聊（飞书桥接没开 / 没配置时由实现自己静默跳过） */
  notifyOwner: (text: string) => Promise<void>;
  warn?: (msg: string) => void;
}

/** 处理一次 desktop_session 事件：翻译 → 写任务流 → 推飞书。永不抛，任何一步失败只记 warn、不影响另一步 */
export const handleDesktopSessionEvent = async (
  taskId: unknown,
  data: unknown,
  deps: DesktopSessionEventDeps,
): Promise<void> => {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return;
  // 先同步更新登记（在第一个 await 之前）：后面不展示的事件（正常结束）也要清，且必须赶在该任务下一次开会话的登记之前
  if (taskId !== "_" && isRecord(data) && endsSession(data)) markDesktopSessionClosed(taskId);
  const notice = describeDesktopSessionEvent(data);
  if (!notice) return;
  const kind = (data as Record<string, unknown>).kind as string;

  let title: string | null = null;
  const hasTask = taskId !== "_";
  if (hasTask) {
    try {
      title = await deps.taskTitle(taskId);
    } catch (err) {
      warn(`[desktop-session-event] 读取任务标题失败 task=${taskId}：${err instanceof Error ? err.message : String(err)}`);
    }
    if (title !== null) {
      try {
        await deps.writeTaskEvent(taskId, notice.text, { source: "desktop", subkind: kind });
      } catch (err) {
        warn(`[desktop-session-event] 写任务事件失败 task=${taskId}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (notice.feishu === null) return;
  // 没有归属任务（`_`）或任务已不存在时，安全相关的提醒（锁不回去 / 解锁失败）仍然要发；只是不带任务名
  const taskMark = title ? `（任务「${title.replace(/[\r\n]+/g, " ").slice(0, 40)}」）` : "";
  try {
    await deps.notifyOwner(notice.feishu.split(TASK_MARK).join(taskMark));
  } catch (err) {
    warn(`[desktop-session-event] 飞书通知失败：${err instanceof Error ? err.message : String(err)}`);
  }
};

/** 默认依赖：重模块全部动态加载（事件到来时才用） */
export const defaultDesktopSessionEventDeps = (): DesktopSessionEventDeps => ({
  taskTitle: async (taskId) => {
    const { getTask } = await import("../task-fs");
    const task = await getTask(taskId);
    return task ? String(task.title ?? "") : null;
  },
  writeTaskEvent: async (taskId, text, meta) => {
    const { writeEventAndPublish } = await import("../task-stream");
    await writeEventAndPublish(taskId, { kind: "info", text, meta });
  },
  notifyOwner: async (text) => {
    const { isFeishuChatBridgeEnabled } = await import("../feishu-bridge/bridge-config");
    if (!(await isFeishuChatBridgeEnabled())) return;
    const { getBotAppInfo, sendTextMessage } = await import("../feishu-bridge/lark-api");
    const info = await getBotAppInfo();
    await sendTextMessage(info.ownerOpenId, text);
  },
});

const registeredBridges = new WeakSet<BrowserBridge>();

/**
 * 挂上 `evt desktop_session` 处理器（按 bridge 实例幂等）。没有桥（无 IPC 通道）什么都不做，之后有了还能再挂。
 * @param deps 仅测试注入；生产走 {@link defaultDesktopSessionEventDeps}
 */
export const ensureDesktopSessionEventsRegistered = (deps?: DesktopSessionEventDeps): void => {
  const bridge = getBrowserBridge();
  if (!bridge || registeredBridges.has(bridge)) return;
  registeredBridges.add(bridge);
  const d = deps ?? defaultDesktopSessionEventDeps();
  bridge.onEvent(DESKTOP_SESSION_EVENT, ({ taskId, data }) => handleDesktopSessionEvent(taskId, data, d));
};
