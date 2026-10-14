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
const CARD_CLOSE_RE = /\s*<\/card>\s*$/;

/** 去掉最外层 `<card>` / `</card>` 外壳（只剥首尾，正文里碰巧出现的不动）。 */
export const unwrapCardShell = (text: string): string =>
  text.replace(CARD_OPEN_RE, "").replace(CARD_CLOSE_RE, "");

const PANEL_HEAD_RE = /^\s*[▶▼](\s|$)/;
const PANEL_END_RE = /^\s*▲\s*$/;

/**
 * 剥折叠面板：行首（允许缩进）`▶` / `▼` 起，到下一个单独成行的 `▲` 止（含两端）。
 * 没有配对 `▲`（如流式卡被截断）→ 从面板头剥到文末。孤立的 `▲` 行也清掉。
 * 面板外正文一字不动，仅把剥完后连续 3+ 个换行压成 2 个。
 */
export const stripAgentPanels = (text: string): string => {
  const out: string[] = [];
  let inPanel = false;
  for (const line of text.split("\n")) {
    if (inPanel) {
      if (PANEL_END_RE.test(line)) inPanel = false;
      continue;
    }
    if (PANEL_END_RE.test(line)) continue; // 孤立 ▲
    if (PANEL_HEAD_RE.test(line)) {
      inPanel = true;
      continue;
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
const NAMED_OPEN_ID_RE = /@([^\s@()（）]+)[(（]ou_[^)）\s]*[)）]/g;
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
