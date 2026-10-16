/**
 * 入向「他人机器人交互卡片」文本净化（纯函数、零 IO、零业务 import）。
 *
 * 为什么：对方机器人（如后端自研「安若流年」）的卡片里夹着折叠面板（思考过程 / 工具执行）、
 * 页脚（模型名 · 耗时）、按钮文字。整块当正文喂给 agent，既白占 token（动辄几千字英文推理），
 * 又会把对方推理里的敏感措辞带进上下文触发模型厂商的使用政策拦截。
 * 这里只保留对方「真正说的话」。
 */

// lark-cli 历史接口把他人机器人卡片渲染成 `<card>…</card>` 外壳；页脚因此不在「文末」、剥不掉
const CARD_OPEN_RE = /^\s*<card(\s[^>]*)?>\s*/;
const CARD_CLOSE_TAG = "</card>";

/**
 * 去掉最外层 `<card>` / `</card>` 外壳（只剥首尾，正文里碰巧出现的不动）。
 *
 * 收尾那半不用 `/\s*<\/card>\s*$/`：这个正则没有起点锚，遇到一长串空白（后面不是 `</card>`）时
 * 每个空白位置都要把整串空白再扫一遍——实测 20 万个空格要 70 秒（第五轮 G1-07）。
 * trimEnd 与 `\s` 是同一套空白定义，语义不变；只在「去掉末尾空白后恰好以 </card> 结尾」时才改写，
 * 否则原样返回（连末尾空白也不动，与旧正则一致）。
 */
export const unwrapCardShell = (text: string): string => {
  const head = text.replace(CARD_OPEN_RE, "");
  const trimmed = head.trimEnd();
  if (!trimmed.endsWith(CARD_CLOSE_TAG)) return head;
  return trimmed.slice(0, trimmed.length - CARD_CLOSE_TAG.length).trimEnd();
};

const PANEL_HEAD_RE = /^\s*[▶▼](\s|$)/;
const PANEL_END_RE = /^\s*▲\s*$/;
/**
 * 「真面板头」的形态：标记后紧跟思考 / 工具执行类的图标或名称，如 `▶ 💭 思考了 0.3s`、
 * `▼ 🛠️ 工具执行 · 2 步`、`▶ 思考`。名称后不能再接字母 / 汉字（`▶ 思考一下方案` 是普通句子）。
 */
const PANEL_TITLE_RE =
  /^\s*[▶▼]\s+(?:[💭🛠🧠⚙🔧]\uFE0F?|(?:思考(?:了|中)?|工具执行|工具调用|Thinking|Tools?)(?![\u4e00-\u9fa5A-Za-z]))/u;

/**
 * 剥折叠面板：行首（允许缩进）`▶` / `▼` 起，到下一个单独成行的 `▲` 止（含两端）。
 * 孤立的 `▲` 行也清掉。面板外正文一字不动，仅把剥完后连续 3+ 个换行压成 2 个。
 *
 * 没有配对 `▲`（如流式卡被截断）→ 只剥「面板头 + 面板体」，不再一路剥到文末（H1-06）：
 * 面板体 = 紧跟面板头的**缩进行**（行首是 **ASCII 空格 / tab** 的非空行；真实卡片里面板体都是缩进的），体内的段间空行
 * （跳过空行后接着的还是缩进行）也算体内；遇到第一个不缩进的非空行、或后面不再有缩进行的空行就结束，
 * 那一行起照常输出。选「缩进」而不是「到下一个空行」/「限制行数」：要点列表
 * `本轮改动：\n▶ 🔧 修复登录\n▶ 🔧 补充测试\n请 review` 中间没有空行，按空行 / 行数截断都救不回「请 review」；
 * 缩进边界对它们都成立，也不会把推理里有空行的长面板体漏出去一半。
 * 缩进**只认 ASCII 空格 / tab**（K4-07）：全角空格 `\u3000` / NBSP 是人写中文段落的段首缩进（`\u3000\u3000请 review`），
 * 不是程序渲染的面板缩进，用 `\s` 判会把这种段落整段吞掉。
 * 已知局限（现状如此、不是规格）：`▶ 🔧 修复登录` 下面缩进的普通子项（`  - 改了 a.ts`）和真面板体形态上无法区分，
 * 仍会被剥掉——宁可多剥一个子项，也不把整段推理漏给 agent。
 * 有配对 `▲` 的面板照旧剥到 `▲`（含两端、不看缩进）。
 *
 * 为什么「`▶ ` 开头」还不够：对端机器人 / 人写的要点列表也爱用 `▶` 当项目符号
 * （`请看下面两点\n▶ A\n▶ B`），当面板头会一路剥到文末、只剩第一行。所以：
 * - 形态对（PANEL_TITLE_RE：思考 / 工具执行 / 💭🛠🧠⚙🔧）→ 一定是面板头（头那一行必剥）。有配对 ▲ 就剥到 ▲；
 *   没有配对 ▲ 就按上面的边界剥（头 + 紧跟的缩进体）。
 * - 形态不对 → 只有「后面有 ▲、且 ▲ 之前没有别的面板头」才当面板，否则保留。
 * - **「配对」对两种形态是同一条规则**（第八轮 L4-08）：▲ 之前出现别的面板头就不配对（面板不嵌套，中间又出现别的头说明
 *   它们是并列的、那个 ▲ 属于后面的头）。标题形态的头不配对时按「没有 ▲」处理。
 *   效果（实测，tests/inbound-card-sanitize-r8.test.ts）：`▶ 🔧 修复登录\n请 review\n▶ 💭 思考\n  x\n▲` 里「请 review」保留，
 *   头与缩进体照剥。此前标题形态只要后面任何位置有 ▲ 就一路剥到那个 ▲，把头与 ▲ 之间的正文一并吞掉。
 *   所以「`▶ 🔧 修复登录` 这种带图标的普通要点行被当面板头剥掉时不连累它后面的正文」成立的条件是：后面没有 ▲，或 ▲ 之前还有别的头；
 *   **不成立的情形**（有意保留的既有语义）：头之后恰好有一个 ▲、两者之间没有别的头——那就是配对的面板，
 *   `▶ 🔧 修复登录\n请 review\n▲` 照旧剥到 ▲、连「请 review」一起剥。
 */
export const stripAgentPanels = (text: string): string => {
  const lines = text.split("\n");
  const n = lines.length;
  // 从后往前一遍扫出「i 行及之后最近的 ▲ 行 / 面板头行 / 非空行」，判定时 O(1) 查，总体线性
  const nextEnd = new Array<number>(n + 1).fill(-1);
  const nextHead = new Array<number>(n + 1).fill(-1);
  const nextNonBlank = new Array<number>(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    nextEnd[i] = PANEL_END_RE.test(lines[i]) ? i : nextEnd[i + 1];
    nextHead[i] = PANEL_HEAD_RE.test(lines[i]) ? i : nextHead[i + 1];
    nextNonBlank[i] = lines[i].trim() === "" ? nextNonBlank[i + 1] : i;
  }
  const isIndented = (line: string): boolean => /^[ \t]/.test(line);
  /**
   * 第 i 行（已知满足 PANEL_HEAD_RE）作为面板头怎么处理：
   * - closed：后面有配对 ▲——**▲ 之前没有别的面板头**（面板不嵌套，中间又出现别的头说明那个 ▲ 属于后面的头）——剥到 ▲；
   * - open：形态对（标题形态）、但没有配对 ▲（后面没有 ▲，或 ▲ 之前还隔着别的头）——只剥头本身 + 紧跟的缩进体；
   * - none：形态不对、又没有配对 ▲ → 普通行，保留。
   * 第八轮 L4-08：标题形态的头也套「▲ 之前出现别的头就不配对」。此前它只要后面任何位置有 ▲ 就按 closed，
   * `▶ 🔧 修复登录\n请 review\n▶ 💭 思考\n  x\n▲` 会一路剥到后面那个头的 ▲、把「请 review」吞掉。
   */
  const panelModeOf = (i: number): "none" | "closed" | "open" => {
    const end = nextEnd[i + 1];
    if (end !== -1) {
      const head = nextHead[i + 1];
      if (head === -1 || head > end) return "closed";
    }
    return PANEL_TITLE_RE.test(lines[i]) ? "open" : "none";
  };

  const out: string[] = [];
  // closed = 后面有配对 ▲，剥到 ▲；open = 没有配对 ▲，只剥缩进的面板体
  let panel: "none" | "closed" | "open" = "none";
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (panel === "closed") {
      if (PANEL_END_RE.test(line)) panel = "none";
      continue;
    }
    if (panel === "open") {
      if (line.trim() === "") {
        const next = nextNonBlank[i];
        if (next < n && isIndented(lines[next])) continue; // 面板体里的段间空行
        panel = "none"; // 面板体到此结束；这行空行照常输出
      } else if (isIndented(line)) {
        continue;
      } else {
        panel = "none"; // 第一个不缩进的非空行：面板体结束，这一行照常处理（可能是下一个面板头）
      }
    }
    if (PANEL_END_RE.test(line)) continue; // 孤立 ▲
    if (PANEL_HEAD_RE.test(line)) {
      const mode = panelModeOf(i);
      if (mode !== "none") {
        panel = mode;
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
};

const SEPARATOR_RE = /^\s*-{3,}\s*$/;
// 耗时形态：12s / 0.3s / 250ms / 5m14s / 2min / 1h；末尾 \b 防止误吞 "5mb" 之类
const DURATION_RE = /\d+(\.\d+)?\s*(ms|min|s|m|h)\b|\d+m\d+s/;
const BUTTON_ROW_RE = /^(\[[^\]\n]*\]\s*)+$/;
const FOOTER_LINE_MAX = 80;
const BUTTON_ROW_MAX = 30;

/**
 * 只剥**文末**页脚与按钮行：
 * - 末尾 `---` 分隔行 + 其后 1~2 行短文本，且最后一行含耗时形态 → 整段剥掉；
 * - 末尾整行形如 `[✕ 关闭]` / `[xxx]`（≤30 字符）的按钮行剥掉。
 * 正文中间的 `---`、以及 `---` 后的业务状态行（无耗时形态）一律保留。
 */
export const stripCardFooter = (text: string): string => {
  const lines = text.split("\n");
  const lastNonBlank = (end: number): number => {
    let i = end;
    while (i >= 0 && lines[i].trim() === "") i--;
    return i;
  };
  let end = lines.length - 1; // 含，最后一个有效行下标
  let progressed = true;
  while (progressed) {
    progressed = false;
    end = lastNonBlank(end);
    if (end < 0) break;
    const t = lines[end].trim();
    // 按钮行
    if (t.length <= BUTTON_ROW_MAX && BUTTON_ROW_RE.test(t)) {
      end--;
      progressed = true;
      continue;
    }
    // 页脚：最后一行是耗时 / 模型名
    if (t.length > FOOTER_LINE_MAX || !DURATION_RE.test(t)) break;
    const p1 = lastNonBlank(end - 1);
    if (p1 < 0) break;
    if (SEPARATOR_RE.test(lines[p1])) {
      end = p1 - 1;
      progressed = true;
      continue;
    }
    if (lines[p1].trim().length > FOOTER_LINE_MAX) break;
    const p2 = lastNonBlank(p1 - 1);
    if (p2 >= 0 && SEPARATOR_RE.test(lines[p2])) {
      end = p2 - 1;
      progressed = true;
    }
  }
  return lines.slice(0, end + 1).join("\n");
};

// 已带名字：@李安(ou_dd96…) / @李安（ou_dd96…）
// id 段排除 `@`（G1-07）：真实 open_id 里没有 `@`；不排除的话重复的 `@a(ou_`（没有 `)` 也没有空白）
// 会让每个 `@` 都扫一遍到文末（二次型），排除后每次尝试最多扫到下一个 `@`，总量线性
const NAMED_OPEN_ID_RE = /@([^\s@()（）]+)[(（]ou_[^)）\s@]*[)）]/g;
// 富文本 at 标签：<at user_id="ou_xxx">名字</at>（名字可能为空——我们自己发的就是空标签）
const AT_TAG_RE = /<at\s+user_id="([^"]*)"\s*>([^<]*)<\/at>/g;
// 裸占位：@ou_ + 20 位以上字母数字
const BARE_OPEN_ID_RE = /@(ou_[0-9a-zA-Z]{20,})/g;

/**
 * 把 open_id 占位换成人话：裸 `@ou_xxx` → `@名字`（解析不出 → `@某成员`，比一串 id 对模型友好）；
 * 已带名字的 `@名字(ou_…)` 去掉括号里的 id 只留 `@名字`。
 */
export const replaceOpenIdPlaceholders = (
  text: string,
  resolve: (openId: string) => string | undefined,
): string =>
  text
    .replace(AT_TAG_RE, (_m, id: string, inner: string) => {
      const shown = inner.trim().replace(/^@/, "");
      if (shown) return `@${shown}`;
      if (id === "all") return "@所有人";
      let name: string | undefined;
      try {
        name = resolve(id)?.trim();
      } catch {
        name = undefined;
      }
      return `@${name ? name.replace(/^@/, "") : "某成员"}`;
    })
    .replace(NAMED_OPEN_ID_RE, "@$1")
    .replace(BARE_OPEN_ID_RE, (_m, openId: string) => {
      let name: string | undefined;
      try {
        name = resolve(openId)?.trim();
      } catch {
        name = undefined;
      }
      return `@${name ? name.replace(/^@/, "") : "某成员"}`;
    });

/** 组合：拆 `<card>` 外壳 → 剥面板 → 剥页脚 → 换 open_id / at 标签 → trim；都剥空返回 ""。 */
export const sanitizeInboundCardText = (
  raw: string,
  opts?: { resolveOpenId?: (openId: string) => string | undefined },
): string => {
  const noPanel = stripAgentPanels(unwrapCardShell(raw ?? ""));
  const noFooter = stripCardFooter(noPanel);
  return replaceOpenIdPlaceholders(
    noFooter,
    opts?.resolveOpenId ?? (() => undefined),
  ).trim();
};
