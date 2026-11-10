/**
 * 增强包 E2 · C4 剪贴板策略（纯函数，无 electron 依赖）。
 *
 * 剪贴板是用户最私密的公共面（密码管理器、聊天里刚复制的内容都在里面），所以 AI 的读取被设计成「只能看到自己引起的变化」：
 *  - `watch_start`：记下**基线哈希**（SHA-256，只存哈希、不存明文、不回显内容），并开一个短窗口；
 *  - `read`：只有当前内容的哈希与基线**不同**才返回文本；没 watch / 窗口过期 / 没变化一律只给固定话，**绝不返回用户原有的内容**；
 *  - `write`：写入系统剪贴板；写入后（仅在 watch 生效时）把基线更新成新内容的哈希，所以 AI 自己写的内容不会被当成「变化」读回来。
 * 用户接管浏览器时（`controller === "user"`）watch 立即作废：这时发生的复制是用户的、不是 AI 引起的。
 *
 * R6-18：窗口不能等同「剪贴板监听」——
 *  - 变化必须发生在「AI 触发的页面动作（点击 / 按键，tab.withAiInput 入口）」之后：第一次 AI 动作到来时把基线**重定**为此刻剪贴板的哈希，
 *    动作之前用户复制的内容就被排除在外；窗口内没有任何 AI 动作 → 一律不返回（`no_ai_action`）；
 *  - 观察窗口（AI 动作之后）只有 {@link WATCH_WINDOW_MS}（5 秒）：用户在这几秒内恰好复制的东西仍有被误读的可能，所以窗口要尽量短；
 *  - 从 watch_start 到「第一次 AI 动作」的等待另有 {@link WATCH_ARM_TTL_MS}：模型一次思考 + 工具往返常常 > 5 秒，不放宽的话流程基本走不通；
 *    这段等待期不返回任何内容，也不拉长观察窗口，所以不增加泄漏面。
 *
 * R6-07：press_key 的粘贴键（Ctrl/Cmd+V / Shift+Insert）只允许粘「AI 最近一次 browser_clipboard write 写入的内容」——
 * 否则用户剪贴板里的内容（密码管理器复制的密码）能被贴进普通输入框、再靠 snapshot 的 value 读出。见 {@link createAiWriteLedger}。
 */
import { createHash } from "node:crypto";

/** 写入上限（字符）：再长的内容不是「给页面粘一段话」，而是想把剪贴板当传输通道 */
export const WRITE_MAX_CHARS = 100_000;
/** 读取返回上限（字符）：超出截断并注明 */
export const READ_MAX_CHARS = 50_000;
/** 观察窗口（毫秒，自第一次 AI 页面动作起算）：AI 的典型用法是「watch_start → 点页面上的复制按钮 → read」，复制后几秒内读；窗口外的变化不再认作 AI 引起的（R6-18：由 120s 缩到 5s） */
export const WATCH_WINDOW_MS = 5_000;
/** watch_start 之后等待「第一次 AI 页面动作」的最长时间（毫秒）：期间不返回任何内容，只是给模型留出思考 + 往返的时间 */
export const WATCH_ARM_TTL_MS = 30_000;

export const CLIPBOARD_ACTIONS = Object.freeze(["write", "watch_start", "read"]);

export const hashText = (text) => createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

/**
 * 一份会话级的 watch 状态：**只存哈希与到期时间**。序列化它不会出现任何剪贴板原文（有单测按这个断言）。
 * @param {{ now?: () => number, windowMs?: number, armTtlMs?: number }} [opts]
 */
export const createClipboardWatch = ({ now = Date.now, windowMs = WATCH_WINDOW_MS, armTtlMs = WATCH_ARM_TTL_MS } = {}) => {
  let baseline = null;
  /** 等第一次 AI 动作的截止时间；AI 动作到来后改看 observeUntil */
  let armUntil = 0;
  let observeUntil = 0;
  /** 窗口内是否已有 AI 触发的页面动作 */
  let aiActed = false;

  const end = () => (aiActed ? observeUntil : armUntil);
  const status = () => {
    if (baseline === null) return "not_armed";
    return now() > end() ? "expired" : "armed";
  };

  return {
    status,
    /** 以当前剪贴板内容的哈希为基线开 / 重开（等 AI 动作的）窗口 */
    arm(currentText) {
      baseline = hashText(currentText);
      armUntil = now() + armTtlMs;
      observeUntil = 0;
      aiActed = false;
    },
    /**
     * AI 即将向页面派发输入（点击 / 按键）：窗口内的**第一次**动作把基线重定为此刻内容、并起算观察窗口。
     * 之后的动作不再重定（否则「点复制 → 又点了别处 → read」会把真正的变化抹掉）。
     * @returns {boolean} 本次是否被记为「窗口内第一次 AI 动作」
     */
    noteAiAction(currentText) {
      if (status() !== "armed" || aiActed) return false;
      baseline = hashText(currentText);
      aiActed = true;
      observeUntil = now() + windowMs;
      return true;
    },
    /** AI 自己写入后：watch 生效时才更新基线（没 watch 时写入不会顺带开启读取能力） */
    afterWrite(writtenText) {
      if (status() !== "armed") return false;
      baseline = hashText(writtenText);
      return true;
    },
    /**
     * 对比当前内容：
     *  - not_armed / expired：不返回任何内容；
     *  - no_ai_action：窗口内还没有 AI 触发的页面动作（用户自己复制的内容一律不返回，也不推进基线）；
     *  - unchanged：哈希相同，不返回；
     *  - changed：返回可读，并把基线推进到当前（同一次变化只读一次，再读就是 unchanged）。
     * @returns {{ status: "not_armed"|"expired"|"no_ai_action"|"unchanged"|"changed" }}
     */
    compare(currentText) {
      const s = status();
      if (s !== "armed") return { status: s };
      if (!aiActed) return { status: "no_ai_action" };
      if (hashText(currentText) === baseline) return { status: "unchanged" };
      baseline = hashText(currentText);
      return { status: "changed" };
    },
    /** 用户接管 / 会话销毁：作废 */
    disarm() {
      baseline = null;
      armUntil = 0;
      observeUntil = 0;
      aiActed = false;
    },
    remainingMs: () => (status() === "armed" ? Math.max(0, end() - now()) : 0),
    toJSON: () => ({ armed: status() === "armed" }),
  };
};

/** 超长截断：返回 { text, truncated } */
export const clipReadText = (text, max = READ_MAX_CHARS) => {
  const s = String(text ?? "");
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
};

// ───────────────────────── R6-07：粘贴键只放行「AI 本轮自己写入」的剪贴板内容 ─────────────────────────

/**
 * 这个按键组合是「粘贴」吗？（纯函数，入参是 actions.parseKeyCombo 的结果）
 * 宽容写法：大小写 / 修饰键顺序不影响（parseKeyCombo 已归一）；宁可多拦——Ctrl/Cmd+V 不论有没有 Alt / Shift（含「粘贴并匹配样式」）、
 * Shift+Insert 都算；Linux 的 PRIMARY 选区粘贴走鼠标中键，在 browser_mouse 那边拦（R6-30）。
 * @param {{ key?: string, modifierList?: string[], commands?: string[] } | null | undefined} parsed
 */
export const isPasteCombo = (parsed) => {
  if (!parsed) return false;
  if (Array.isArray(parsed.commands) && parsed.commands.some((c) => typeof c === "string" && c.toLowerCase().startsWith("paste"))) return true;
  const key = String(parsed.key ?? "").toLowerCase();
  const mods = Array.isArray(parsed.modifierList) ? parsed.modifierList : [];
  if (key === "v" && (mods.includes("Control") || mods.includes("Meta"))) return true;
  if (key === "insert" && mods.includes("Shift")) return true;
  return false;
};

/**
 * 「AI 最近一次通过 browser_clipboard write 写入的内容」的账本：**只存 SHA-256 摘要**（序列化不含原文，有单测）。
 * 用户接管 / 会话销毁时清空——这之后的剪贴板就不再是「AI 本轮」的了。
 */
export const createAiWriteLedger = () => {
  let digest = null;
  return {
    record(text) {
      digest = hashText(text);
    },
    clear() {
      digest = null;
    },
    /** 当前系统剪贴板文本是不是 AI 最近一次写入的那份（从未写入 → false） */
    matches(currentText) {
      return digest !== null && typeof currentText === "string" && hashText(currentText) === digest;
    },
    hasWritten: () => digest !== null,
    toJSON: () => ({ written: digest !== null }),
  };
};

/** 取 / 建会话级账本（存在 session.ext 里；接管时清空，会话销毁时 dispose）。session 不支持 getExt（异常环境 / 旧测试夹具）→ null，调用方按「没写过」处理 */
export const aiWriteLedgerOf = (session) => {
  if (!session || typeof session.getExt !== "function") return null;
  return session.getExt("clipboard-ai-write", () => {
    const ledger = createAiWriteLedger();
    const off = session.onControllerChange?.((next) => {
      if (next === "user") ledger.clear();
    });
    return Object.assign(ledger, {
      dispose() {
        ledger.clear();
        try {
          off?.();
        } catch {
          /* 取消订阅失败无所谓 */
        }
      },
    });
  });
};

/** press_key 粘贴被拒：系统剪贴板不是 AI 本轮写入的内容 */
export const PASTE_NOT_AI_CLIPBOARD_MESSAGE =
  "系统剪贴板不是你本轮写入的内容，已拒绝粘贴以保护用户剪贴板（用户复制的内容不能被你贴进页面）。往输入框填字请用 browser_type；确实要粘贴就先 browser_clipboard write 写入要粘贴的文字，再按粘贴键";
/** 读不到系统剪贴板（环境没提供）：同样拒绝，不放行 */
export const PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE = "当前环境读不到系统剪贴板，无法确认粘贴的是你本轮写入的内容，已拒绝粘贴。往输入框填字请用 browser_type";

/**
 * 粘贴裁决（纯函数，有单测）：返回 null = 放行；否则是要抛给模型的拒绝文案。
 * @param {{ matches: (t: string) => boolean } | null} ledger
 * @param {string | undefined} currentText 系统剪贴板当前文本（读不到传 undefined）
 */
export const pasteRejection = (ledger, currentText) => {
  if (typeof currentText !== "string") return PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE;
  if (!ledger || !ledger.matches(currentText)) return PASTE_NOT_AI_CLIPBOARD_MESSAGE;
  return null;
};
