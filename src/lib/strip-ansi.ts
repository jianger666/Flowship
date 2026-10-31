/**
 * 剥掉终端控制序列（颜色 / 光标移动 / 终端超链接），只留可读文本（Q13-09）。
 *
 * 为什么需要：预览 dev server 的输出走管道、不是终端，按理不该带颜色，但 `FORCE_COLOR=0` 管不住所有工具——
 * vite 用的 picocolors 判断的是 `!!env.FORCE_COLOR`，字符串 `"0"` 是真值，反而把颜色打开；端口再单独加粗，
 * 输出就成了 `http://localhost:ESC[1m5173ESC[22m/`，靠正则从原文里找 `localhost:\d+` 的探测落空，
 * `logTail` 里也全是转义乱码；整段 URL 上色时，尾部的 `ESC[39m` 还会被 `[^\s'"]*` 吃进地址。
 *
 * 覆盖三类（ECMA-48）：
 *  - CSI：ESC `[` + 参数字节（0x30–0x3F）+ 中间字节（0x20–0x2F）+ 终止字节（0x40–0x7E）——颜色（SGR，`ESC[36m`）、清行、移动光标；
 *  - OSC：ESC `]` … 以 BEL 或 ESC `\` 结束——终端超链接（OSC 8）、窗口标题；**必须有结束符才剥**；
 *  - 其余 ESC 序列：ESC + 若干中间字节 + 一个终止字节（`ESC c` 重置、`ESC 7` / `ESC 8` 存取光标、`ESC ( B` 选字符集）；
 *    终止字节不含 `[` / `]`，免得把没写完的 CSI / OSC 剥成半截。
 *
 * ⚠️ 不完整的序列（被切到下一个 chunk 的另一半、没有结束符的 OSC）**原样保留、不瞎剥**——剥错会吃掉正文，比剥漏更糟。
 * 因此转义序列恰好被切在两个 chunk 之间时，残留的半截不会被剥掉（只影响那一行的外观 / 探测）。
 * 三条正则各段的字符类互不重叠、没有嵌套量词，线性时间（没有结束符的 OSC 最多扫到下一个 ESC 就停）。
 */

const ESC = "\u001b";
const BEL = "\u0007";

const ANSI_RE = new RegExp(
  [
    // CSI：ESC [ 参数 中间 终止
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    // OSC：ESC ] 内容（不含 BEL / ESC）+ BEL 或 ESC \
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    // 其余：ESC 中间字节* 终止字节（0x30–0x7E，去掉 [ 和 ]）
    `${ESC}[ -/]*[0-Z\\\\^-~]`,
  ].join("|"),
  "g",
);

/** 剥掉文本里的 ANSI 转义序列；没有 ESC 字符时原样返回（热路径：dev server 的每个输出块都过这里） */
export const stripAnsi = (text: string): string =>
  text.includes(ESC) ? text.replace(ANSI_RE, "") : text;
