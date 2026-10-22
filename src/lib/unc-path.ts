/**
 * UNC / 网络共享路径形态判定（纯函数；前端图片改写与服务端读文件路由共用）
 *
 * 为什么要：Windows 上对 `\\host\share\x` / `//host/share/x` 做任何文件系统调用（realpath / stat / open）
 * 都会让系统主动发起 SMB 连接，默认带 NTLM 凭据。markdown 里一行 `![](//attacker/share/a.png)`
 * 原先会被改写成 `/api/local-image?path=//attacker/share/a.png`，渲染即触发（无需点击）。
 * 所以「看起来像 UNC」的输入必须在碰文件系统之前就挡掉。
 *
 * 判定 = 去掉首尾空白与 `file://` 前缀后，以两个及以上的 `/` 或 `\`（可混用）开头。
 * 这一条同时覆盖：
 *  - `\\host\share`、`//host/share`、`\/host/share`、`/\host\share`
 *  - 扩展长度 / 设备命名空间 `\\?\UNC\host\share`、`\\.\pipe\x`（都以双斜杠开头）
 *  - `file:////host/share`（去掉 `file://` 后剩 `//host/share`）
 * 不误伤：盘符路径（`C:\x`、`C:/x`）、mac/linux 绝对路径（`/Users/x`）、`file:///C:/x`、`file:///Users/x`、
 * 站内路径（`/api/...`）、http(s)、相对路径。
 *
 * 与平台无关地判：posix 上 `//x/y.png` 本来就等价 `/x/y.png`、没人这么写，宁可误拒也不让 Windows 漏过。
 *
 * 这里是全仓**唯一**的 UNC 判定（R12-05）：`local-file-os.ts` 的 `isWindowsUncPath`、`path-utils.ts` 的
 * shellQuotePath / isAbsolutePathLike 都复用它，不再各抄一套正则（曾经四套口径并存，
 * 其中两套不认 `\/`、`/\`、`///`）。新增路径入口请直接用 {@link nonLocalPathReason}（含 Windows 白名单）。
 */
export const isUncLikePath = (input: string): boolean => {
  let s = input.trim();
  // 只剥恰好 `file://`：`file:///C:/x` 剥完是 `/C:/x`（不是 UNC），`file:////h/s` 剥完是 `//h/s`（是）
  if (/^file:\/\//i.test(s)) {
    s = s.slice("file://".length);
    // `file://host/share/x`（authority 非空且不是 localhost / 盘符）：Windows 上就是 `\\host\share\x`（Q4-06 同族）
    if (/^(?!localhost(?:[\\/]|$))[^\\/:?#]+[\\/]/i.test(s)) return true;
  }
  return /^[\\/]{2}/.test(s);
};

/** 服务端读文件路由拒绝 UNC 时统一的提示（400） */
export const UNC_REJECT_MESSAGE = "出于安全考虑，不支持读取网络共享（UNC）路径";

/**
 * `file://host/share/…` 形态（authority 非空：第一段不是斜杠）的补充提示（第五轮 P4）。
 * 这种写法按标准就是网络共享（Windows 上 = `\\host\share\…`），我们照拒；但最常见的真实来源是**少写了一个斜杠**的本机路径
 * `file://Users/x/y.png`（应为 `file:///Users/x/y.png`）。拒绝文案里给出改写后的写法，别让人对着「不支持 UNC」猜半天。
 * 非该形态返回 null。
 */
export const fileUrlHostHint = (input: string): string | null => {
  const s = input.trim();
  if (!/^file:\/\//i.test(s)) return null;
  const rest = s.slice("file://".length);
  // 「第一个分隔符是 `\`」时不给提示：少写斜杠的本机路径写的是 `file://Users/x/y`（或干脆没有分隔符的 `file://Users`）；
  // `file://host\share`（反斜杠）是 Windows 习惯的 UNC 写法，「请写成 file:///host\share」只会误导
  if (!/^[^\\/]+(?:\/|$)/.test(rest)) return null;
  const shown = rest.length > 120 ? `${rest.slice(0, 120)}…` : rest;
  return `如果这是本机路径，请写成 file:///${shown}（file:// 后面是三个斜杠）`;
};

/** Windows 上不是「盘符绝对路径」（又不是 UNC 形态）时的提示：NT 命名空间 / 根相对 / 盘相对等 */
export const NON_LOCAL_PATH_MESSAGE = "出于安全考虑，只支持本机磁盘（带盘符）的绝对路径";

/**
 * 路径入口的统一**白名单**守卫（第三轮 review R12-01…05；所有会把用户 / AI 给的路径递给
 * 文件系统、git、spawn 的入口共用这一个判定）。
 *
 * - 任何平台：{@link isUncLikePath} 命中 → 拒（UNC / 设备命名空间；平台无关，mac 上也能测全）。
 * - Windows：只放行盘符绝对路径 `^[A-Za-z]:[\\/]`（及 `file:///C:/…`，剥掉 `file://` 后多出的前导 `/`）。
 *   不再逐个枚举「哪些怪形态是 UNC」：`\??\UNC\host\share`（NT 对象命名空间前缀）不以双分隔符开头，
 *   黑名单放过它，而 Win32 是否把它当 `\\?\UNC\…` 直通无法在这里验证——白名单下它与 `/C:/x`、`\Windows\x`、
 *   `C:relative` 一样直接拒绝，不去赌它们的解析语义。
 * - posix：只拦 UNC 形态；是否绝对路径由各路由自己的既有校验负责（不改变它们原有的错误文案）。
 *
 * @param platform 默认当前平台；测试里注入 "win32" 即可在 mac / linux 上验证 Windows 语义
 * @returns null = 放行；string = 400 的用户可读原因
 */
export const nonLocalPathReason = (
  input: string,
  platform: string = process.platform,
): string | null => {
  if (isUncLikePath(input)) {
    const hint = fileUrlHostHint(input);
    return hint ? `${UNC_REJECT_MESSAGE}。${hint}` : UNC_REJECT_MESSAGE;
  }
  if (platform !== "win32") return null;
  let s = input.trim();
  const hadFileScheme = /^file:\/\//i.test(s);
  if (hadFileScheme) s = s.slice("file://".length);
  // `file:///C:/x` 剥完是 `/C:/x`：这是 file URL 的标准写法，去掉前导 `/` 就是盘符绝对路径（R12-04）
  if (hadFileScheme && /^\/[A-Za-z]:[\\/]/.test(s)) return null;
  return /^[A-Za-z]:[\\/]/.test(s) ? null : NON_LOCAL_PATH_MESSAGE;
};

/**
 * `file://` URL → 本地路径：剥 `file://`；`file:///C:/x` 剥完的 `/C:/x` 再去掉前导 `/`（Windows 盘符的标准 file URL 写法）。
 * 非 `file://` 输入原样返回。仅做字符串变换、不判 UNC（调用方先 {@link isUncLikePath}）。
 */
export const fileUrlToLocalPath = (input: string): string => {
  if (!/^file:\/\//i.test(input)) return input;
  const rest = input.slice("file://".length);
  return /^\/[A-Za-z]:[\\/]/.test(rest) ? rest.slice(1) : rest;
};

/**
 * 一批仓库路径里第一条不被接受的（UNC / WSL / 非本机磁盘形态）：登记入口、`POST /api/tasks` 共用（Q4-01）。
 * 仓库登记处就拒收并写原因，别等下游 `repo-branches` 回 400 后被前端吞成「非 git 仓库」。
 * @returns null = 全部放行；否则 `{ path, reason }`，`reason` 是可直接给用户看的完整一句话
 */
export const firstNonLocalRepoPath = (
  paths: readonly string[],
  platform: string = process.platform,
): { path: string; reason: string } | null => {
  for (const p of paths) {
    const why = nonLocalPathReason(p, platform);
    if (why) {
      return {
        path: p,
        reason: `仓库路径「${p}」不可用：${why}。网络共享（UNC）/ WSL 路径暂不支持作为仓库，请改用本机磁盘上的目录`,
      };
    }
  }
  return null;
};

/**
 * 批量探测（`/api/repo-remote-meta` 等「任一路径非本机就整体 400」的接口）前先过滤掉 UNC / WSL 仓，
 * 别让一个不受支持的仓把同任务里的本地仓连坐（Q4-01）。保持原顺序。
 */
export const filterProbeableRepoPaths = (
  paths: readonly string[],
  platform: string = process.platform,
): string[] => paths.filter((p) => nonLocalPathReason(p, platform) === null);
