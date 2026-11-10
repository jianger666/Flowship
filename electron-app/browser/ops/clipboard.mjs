/**
 * 增强包 E2 · C4 剪贴板 op `clipboard`：write / watch_start / read。
 *
 * 隐私设计（策略在 ../clipboard-policy.mjs，纯函数有单测）：AI 能写，但读只限「自 watch_start 以来发生的变化」，
 * 绝不返回用户原有的剪贴板内容；基线只存 SHA-256 哈希；用户接管时 watch 作废、三个动作一律 USER_CONTROL
 * （这时的复制 / 粘贴是用户的，AI 往用户剪贴板里写东西也会打扰用户）。
 * 写入 / watch / 读取都记一条 actor:"ai" 的活动记录（只记字数，不记内容）。
 *
 * 不走 runAction：剪贴板与页面主线程无关，也不该把整个会话切成「AI 操作中」。
 */
import { CLIPBOARD_ACTIONS, WATCH_WINDOW_MS, WRITE_MAX_CHARS, aiWriteLedgerOf, clipReadText, createClipboardWatch } from "../clipboard-policy.mjs";
import { BrowserError } from "../server-channel.mjs";

export const OPS = Object.freeze(["clipboard"]);

export const normalize = (op, args, h) => {
  switch (op) {
    case "clipboard": {
      const action = h.reqEnum(args, "action", CLIPBOARD_ACTIONS);
      if (action === "write") {
        return { action, text: h.reqStr(args, "text", { max: WRITE_MAX_CHARS }) };
      }
      return { action };
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

const USER_CONTROL_MESSAGE =
  "用户正在接管浏览器，此时不能读写剪贴板（剪贴板是用户的）。请调用 ask_user_to_act 请用户处理，或等用户点「交还给 AI」后再继续";

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖；本模块用 electron.clipboard、ensureSession、now（测试注入）
 */
export const createHandlers = (deps) => {
  const getClipboard = () => {
    const cb = deps.electron?.clipboard;
    if (!cb || typeof cb.readText !== "function" || typeof cb.writeText !== "function") {
      throw new BrowserError("UNSUPPORTED", "当前环境没有可用的系统剪贴板");
    }
    return cb;
  };

  /** 会话级 watch：存在 session.ext 里，会话销毁时 dispose 清空；用户接管时作废 */
  const watchOf = (session) =>
    session.getExt("clipboard", () => {
      const watch = createClipboardWatch({ now: deps.now ?? Date.now });
      const off = session.onControllerChange?.((next) => {
        if (next === "user") watch.disarm();
      });
      // R6-18：AI 即将向页面派发输入（点击 / 按键）时，窗口内第一次动作把基线重定为「动作之前」的剪贴板——
      // 之前用户复制的内容不算「AI 引起的变化」；没有这个信号（窗口内没 AI 动作）read 一律不返回内容。
      const offAi = session.onAiInput?.(() => {
        if (watch.status() !== "armed" || session.controller === "user") return;
        try {
          watch.noteAiAction(getClipboard().readText());
        } catch {
          /* 读不到剪贴板：不记 AI 动作 → read 保持 no_ai_action（fail-closed） */
        }
      });
      return Object.assign(watch, {
        dispose() {
          watch.disarm();
          try {
            off?.();
            offAi?.();
          } catch {
            /* 取消订阅失败无所谓 */
          }
        },
      });
    });

  const logAi = (session, summary) => {
    try {
      const tab = session.tabs?.find((t) => t.id === session.activeTabId);
      session.activityLog.addAI({ kind: "clipboard", tabId: tab?.id ?? session.activeTabId ?? "", url: tab?.url ?? "", summary });
    } catch (err) {
      deps.log?.(`[browser] 剪贴板活动日志写入失败：${err?.message || err}`);
    }
  };

  return {
    clipboard: async (taskId, a) => {
      const cb = getClipboard();
      const session = deps.getSession?.(taskId) ?? deps.ensureSession(taskId, { initialTab: false });
      if (session.controller === "user") throw new BrowserError("USER_CONTROL", USER_CONTROL_MESSAGE);
      const watch = watchOf(session);

      switch (a.action) {
        case "write": {
          cb.writeText(a.text);
          // R6-07：记下「AI 本轮写入内容」的摘要，press_key 的粘贴键只放行与它一致的剪贴板
          aiWriteLedgerOf(session)?.record(a.text);
          const armed = watch.afterWrite(a.text);
          logAi(session, `写入了剪贴板（${a.text.length} 个字符）`);
          return { action: "write", length: a.text.length, watching: armed };
        }
        case "watch_start": {
          // 只为取哈希读一次：内容留在主进程里，不进结果 / 日志 / 状态
          watch.arm(cb.readText());
          logAi(session, "开始观察剪贴板变化（不读取现有内容）");
          // windowSec = 触发复制（第一次 AI 页面动作）之后的有效观察秒数；armSec = 等这次动作的最长秒数
          return { action: "watch_start", armed: true, windowSec: Math.round(WATCH_WINDOW_MS / 1000), armSec: Math.round(watch.remainingMs() / 1000) };
        }
        case "read": {
          // 只读一次：比较与返回用同一份快照，避免「比较通过、返回时内容又被换成别的」
          const current = cb.readText();
          const verdict = watch.compare(current);
          if (verdict.status !== "changed") return { action: "read", status: verdict.status };
          const { text, truncated } = clipReadText(current);
          logAi(session, `读取了剪贴板的变化（${text.length} 个字符${truncated ? "，已截断" : ""}）`);
          return { action: "read", status: "changed", text, length: text.length, truncated };
        }
        default:
          throw new BrowserError("BAD_ARGS", `未知的 clipboard action：${String(a.action).slice(0, 40)}`);
      }
    },
  };
};
