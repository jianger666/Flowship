/**
 * 桌面包数据目录识别（纯函数、零依赖）
 *
 * 桌面端（electron-app/main.js）把 userData 钉在 `<appData>/fe-ai-flow`（正式包）与
 * `<appData>/fe-ai-flow-test`（test 包 / `pnpm dev:web`），FLOWSHIP_DATA_DIR 指向其下的 `data`。
 * `<appData>` 是各系统的应用数据根：macOS `~/Library/Application Support`、
 * Windows `%APPDATA%`（…/AppData/Roaming）、Linux `~/.config`。
 * 这些目录里是用户的真实任务 / 聊天 / 配置——测试进程、临时脚本绝不能碰。
 *
 * 为什么要认「`<appData>` + 目录名」两段，而不是只认 `…/fe-ai-flow/data`：
 * 仓库被克隆成名叫 `fe-ai-flow` 的目录时，FLOWSHIP_DATA_DIR 缺省回落的 `process.cwd()/data`
 * 恰好也长成 `…/fe-ai-flow/data`，只认后缀会把开发目录误当成用户数据。
 *
 * 只做字符串判断，不碰文件系统（不 realpath、不 stat），所以任何平台都能用 mac 形状的假路径测试。
 * 认不出的路径一律当「不是」——调用方是防护层（认错只会退回没有防护的老行为），不是授权层。
 */

/** 桌面包 userData 目录名（electron-app/main.js: IS_TEST ? "fe-ai-flow-test" : "fe-ai-flow"） */
const APP_USER_DIR_NAMES: ReadonlySet<string> = new Set([
  "fe-ai-flow",
  "fe-ai-flow-test",
]);

/** `<appData>` 的路径尾巴（小写；逐段比较） */
const APP_DATA_ROOT_TAILS: readonly (readonly string[])[] = [
  ["library", "application support"], // macOS
  ["appdata", "roaming"], // Windows
  [".config"], // Linux
];

const endsWithTail = (
  segs: readonly string[],
  end: number,
  tail: readonly string[],
): boolean => {
  const start = end - tail.length;
  if (start < 0) return false;
  return tail.every((t, i) => segs[start + i] === t);
};

/**
 * `p` 是桌面包 userData 目录（`<appData>/fe-ai-flow[-test]`）本身，或其下任意路径？
 * FLOWSHIP_DATA_DIR（`<userData>/data`）、其下的 tasks / logs / config.json 都算。
 * 大小写不敏感（mac / Windows 文件系统默认如此），分隔符 `/` 与 `\` 都认。
 */
export const isAppUserDataPath = (p: string | null | undefined): boolean => {
  if (!p) return false;
  const segs = p
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  for (let i = 0; i < segs.length; i++) {
    if (!APP_USER_DIR_NAMES.has(segs[i])) continue;
    if (APP_DATA_ROOT_TAILS.some((tail) => endsWithTail(segs, i, tail))) {
      return true;
    }
  }
  return false;
};
