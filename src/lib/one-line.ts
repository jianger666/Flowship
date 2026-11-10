/**
 * 页面 / 服务器可控文字的「单行安全展示」（R3-09：从 components/browser/browser-status.ts 挪到 lib，状态条与系统通知共用同一口径）。
 * 纯函数，无依赖。
 */

/**
 * 展示前剥掉 Unicode 格式字符（\p{Cf}：零宽 / 方向控制 U+202A–202E、U+2066–2069 / BOM / Unicode tag U+E0000–E007F…）
 * 与控制字符（\p{Cc}）。页面标题、下载文件名是页面 / 服务器可控的：夹一个 U+202E 就能把「report.exe」显示成「reportexe.」
 * 之类，零宽字符还能让两个长得一样的文件名其实不同（R1-37）。
 * 注意这是**展示用**：会连 ZWJ（emoji 组合符）一起剥，组合 emoji 退化成并排的单个 emoji，可接受。
 *
 * R4 复审 R3-09：口径与 server `INVISIBLE_RE` / 前端 pick-compose 的 `HIDDEN_CLASS` 对齐，再追加 `\p{Default_Ignorable_Code_Point}` 与 `\p{Variation_Selector}`——
 * U+3164 / U+FFA0 / U+115F / U+1160（韩文填充符）/ U+034F / U+17B4–5 / VS1–256 都不是 Cf，但同样渲染成空白：
 * 服务器给的下载文件名 `x.pdf` + 一串 `\u3164` + `.exe` 能把真实后缀挤出可见区（「打开」按钮按真实后缀判断，所以只是展示欺骗）。
 * 注意：`electron-app/notify-target.mjs` 的 `cleanLine` 手抄了同一份正则（主进程不能 import `src`），改这里要一起改。
 */
export const stripFormatChars = (s: string): string =>
  s.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\u{E0000}-\u{E007F}]/gu, "");

/** 单行展示前剥格式字符、压平空白并截断（aiLabel / 提问内容 / 页面标题都可能带换行、很长或夹方向控制符） */
export const clipOneLine = (s: string, max = 120): string => {
  // 先把控制字符里的空白类（\n \t \r）按空白折叠，再剥其余的 Cc / Cf
  // BOM（U+FEFF）在 JS 里算 \s、实际是零宽字符：先删掉，免得它被折成一个空格
  const flat = stripFormatChars(s.replace(/\uFEFF/g, "").replace(/\s+/g, " ")).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};
