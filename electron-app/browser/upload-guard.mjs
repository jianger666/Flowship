/**
 * upload 的路径守卫（契约 §14.1 / §14.2 / §14.5）：纯函数 + 依赖注入的 fs，主进程这一侧的「最后一道闸」。
 *
 * 分工：白名单目录由 server 侧（src/lib/server/browser/upload-policy.ts）负责——它知道任务的工作目录 / 附件目录；
 * 主进程不知道任务目录，只做两件事：①路径形状（绝对、无 `..`、存在、普通文件、≤100MB）②敏感路径黑名单。
 * 黑名单规则两侧各自实现、**不共享代码**（一边 mjs 一边 TS），用同一组测试向量
 * （tests/helpers/browser-v3-vectors.ts）各测一遍，保证两侧判定一致。改规则时两边一起改。
 *
 * 为什么主进程还要再校验：server 与主进程之间是 ipc 通道，AI 的参数经过 server 才到这里；
 * 万一 server 侧的校验被绕过 / 将来有别的调用方，主进程自己仍然不会把 ~/.ssh/id_rsa 交给页面。
 *
 * 黑名单一律不区分大小写（macOS / Windows 文件系统默认不区分；宁可错拒，不可漏放）。
 * R2-10：匹配前按 Windows 路径语义归一每一段——去掉末尾的点 / 空格（Win32 会吃掉：`x.pem.` 打开的就是 `x.pem`）、
 * 去掉第一个 `:` 之后的内容（NTFS 备用数据流：`x.key::$DATA` 就是 `x.key`）。这一步在任何平台上都做（便于测试），
 * 代价是 POSIX 上名字真带 `:` / 末尾点的文件也按「去掉后的名字」判（只会多拒，不会漏放）。
 * 黑名单是列举式、不可能穷尽——它是「已知高危文件」的兜底，真正的边界是 server 侧的白名单目录（upload-policy.ts）。
 */
import path from "node:path";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 10;
const MAX_PATH_CHARS = 4096;

/** 路径里任一段命中即拒的目录 / 文件名（凭据类）。R1-27 补：`.password-store`（pass 密码库） */
const SENSITIVE_SEGMENTS = Object.freeze([
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".npmrc", ".netrc", ".azure", ".password-store",
  ".mozilla", // R2-10：Linux 的 Firefox profile（logins.json / key4.db / cookies.sqlite 都在里面）
  "bravesoftware", // R2-10：Brave 的 profile 根（Windows `AppData\Local\BraveSoftware`、macOS `Application Support/BraveSoftware`）
]);
/**
 * 连续两段：`.config/gcloud`；R1-27 补 `.config/gh`（GitHub CLI 的 hosts.yml 里有 oauth token）；
 * R2-10 补：`.git/config`（remote URL 里常内嵌 token）、`.config/rclone`（云盘凭据）、浏览器 profile
 * （Chrome / Edge 的 `Google/Chrome`、`Microsoft/Edge`、Linux 的 `.config/google-chrome|chromium|microsoft-edge`、macOS 的 `Application Support/Firefox`）。
 */
const SENSITIVE_SEGMENT_PAIRS = Object.freeze([
  [".config", "gcloud"],
  [".config", "gh"],
  [".config", "rclone"],
  [".config", "google-chrome"],
  [".config", "chromium"],
  [".config", "microsoft-edge"],
  [".git", "config"],
  ["google", "chrome"],
  ["microsoft", "edge"],
  ["application support", "firefox"],
]);
/**
 * 文件名（小写后）匹配即拒：
 * `.env*` `id_rsa*` `id_ed25519*` `*.pem` `*.key` `*.p12` `*.pfx` `*.keychain*` `credentials*`；
 * R1-27 补：`id_ecdsa*` `id_dsa*`（SSH 私钥其余算法）、`.git-credentials` `.pgpass` `.pypirc` `.htpasswd` `.dockercfg` `.s3cfg`
 * `.vault-token` `.my.cnf` `.mylogin.cnf`（明文凭据文件）、`*.ppk`（PuTTY 私钥）、`*.kdbx` / `*.kdb`（KeePass 库）、
 * `*.jks` / `*.keystore`（Java 密钥库）、`*.p8`（Apple / APNs 私钥）。
 * R2-10 补：`.yarnrc*`（`npmAuthToken`）、`*_history`（`.bash_history` / `.zsh_history` / `.psql_history` … 里常有命令行密码）、
 * `*.tfstate*`（Terraform state 含明文资源密钥）、`secrets.*`、浏览器登录库 / cookie 库（`Login Data*`、`logins.json`、
 * `key3.db` / `key4.db`、`Cookies` / `cookies.sqlite`、`Web Data`）。
 */
const SENSITIVE_FILE_PATTERNS = Object.freeze([
  /^\.env/,
  /^id_rsa/,
  /^id_ed25519/,
  /^id_ecdsa/,
  /^id_dsa/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.ppk$/,
  /\.kdbx?$/,
  /\.jks$/,
  /\.keystore$/,
  /\.p8$/,
  /\.keychain/,
  /^credentials/,
  /^\.git-credentials/,
  /^\.pgpass/,
  /^\.pypirc/,
  /^\.htpasswd/,
  /^\.dockercfg/,
  /^\.s3cfg/,
  /^\.vault-token/,
  /^\.my\.cnf/,
  /^\.mylogin\.cnf/,
  /^\.yarnrc/,
  /_history$/,
  /\.tfstate/,
  /^secrets(\.|$)/,
  /^login data/,
  /^logins\.json$/,
  /^key[34]\.db$/,
  /^cookies(\.sqlite)?$/,
  /^web data$/,
]);

/** 桌面包 userData 目录名（与 src/lib/server/app-data-dir.ts 同源：`<appData>/fe-ai-flow[-test]`） */
const APP_USER_DIR_NAMES = new Set(["fe-ai-flow", "fe-ai-flow-test"]);
const APP_DATA_ROOT_TAILS = Object.freeze([["library", "application support"], ["appdata", "roaming"], [".config"]]);

/** `/` 与 `\` 都当分隔符；去空段、全小写——两种平台形状的路径都能在任何平台上判定（便于测试） */
const segmentsOf = (p) =>
  String(p ?? "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());

/**
 * 一段路径按 Windows 语义归一（R2-10）：第一个 `:` 之后（NTFS 备用数据流名 / 流类型，`x.key::$DATA`）丢掉，
 * 末尾的点与空格丢掉（Win32 路径规范化会吃掉它们，`x.pem.` / `x.pem ` 打开的是同一个文件）。
 */
const winNormSegment = (seg) => {
  const colon = seg.indexOf(":");
  return (colon >= 0 ? seg.slice(0, colon) : seg).replace(/[. ]+$/, "");
};

/** 黑名单匹配用的段：{@link segmentsOf} + 每段 {@link winNormSegment}（归一后为空的段丢掉） */
const sensitiveSegmentsOf = (p) => segmentsOf(p).map(winNormSegment).filter(Boolean);

/** 规范化成「小写 + 正斜杠 + 无尾斜杠」的比较串 */
const normForCompare = (p) => `/${segmentsOf(p).join("/")}`;

/**
 * 数据目录黑名单用的「宽松」包含判断：两侧都按 {@link winNormSegment} 归一后再比（`fe-ai-flow.` / ADS 写法绕不过）。
 * 只用在「拒绝」方向；「豁免」方向（allowedUnderData）仍用严格的 {@link isInside}，宽松只会多拒、不会多放。
 */
const isInsideLoose = (child, parent) => {
  const c = sensitiveSegmentsOf(child);
  const pa = sensitiveSegmentsOf(parent);
  if (pa.length === 0) return false;
  return c.length >= pa.length && pa.every((s, i) => c[i] === s);
};

/** child 是 parent 本身或其下任意路径？ */
export const isInside = (child, parent) => {
  const c = normForCompare(child);
  const pa = normForCompare(parent);
  if (pa === "/") return false; // 空 / 根目录当作「没有配置」，不拿来做前缀判断
  return c === pa || c.startsWith(`${pa}/`);
};

const endsWithTail = (segs, end, tail) => {
  const start = end - tail.length;
  return start >= 0 && tail.every((t, i) => segs[start + i] === t);
};

/** 路径位于桌面包 userData（`<appData>/fe-ai-flow[-test]`）下？要求 `<appData>` + 目录名两段，避免误伤叫 fe-ai-flow 的开发仓库 */
export const isAppUserDataLike = (p) => {
  const segs = sensitiveSegmentsOf(p);
  for (let i = 0; i < segs.length; i++) {
    if (APP_USER_DIR_NAMES.has(segs[i]) && APP_DATA_ROOT_TAILS.some((tail) => endsWithTail(segs, i, tail))) return true;
  }
  return false;
};

/**
 * 路径形状校验（不碰文件系统）。
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export const checkUploadShape = (p, { platform = process.platform } = {}) => {
  if (typeof p !== "string" || p.trim() === "") return { ok: false, reason: "路径为空" };
  if (p.length > MAX_PATH_CHARS) return { ok: false, reason: `路径过长（上限 ${MAX_PATH_CHARS} 字符）` };
  if (p.includes("\u0000")) return { ok: false, reason: "路径含非法字符" };
  // R1-11：win32 下以两个斜杠 / 反斜杠开头的是 UNC 网络路径（`\\host\share`）或设备路径（`\\?\` / `\\.\`）。
  // 它们 isAbsolute 为 true、也没有 `..`，但后面的 realpath / stat 一碰就会向远端主机发 SMB 请求并带上 NTLM 凭据，
  // 所以必须在**任何** fs 调用之前、在形状阶段就拒绝（server 侧 upload-policy.ts 同步）。
  if (platform === "win32" && /^[\\/]{2}/.test(p)) {
    return { ok: false, reason: "不支持网络共享（UNC）路径与设备路径（以 \\\\ 或 // 开头），请先把文件复制到本机磁盘再上传" };
  }
  const isAbs = platform === "win32" ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p);
  if (!isAbs) return { ok: false, reason: `必须是绝对路径，收到「${p.slice(0, 80)}」` };
  if (p.split(/[\\/]+/).includes("..")) return { ok: false, reason: "路径里不能有 .. 段，请给规范化后的绝对路径" };
  return { ok: true };
};

/**
 * 命中敏感路径规则吗？
 * @param {string} p 路径（原样与 realpath 后的各调一次）
 * @param {{ dataRoots?: string[], allowedUnderData?: string[] }} [opts]
 *   dataRoots：Flowship 数据目录（userData / FLOWSHIP_DATA_DIR）；
 *   allowedUnderData：数据目录内的豁免子目录（本任务自己的 uploads / workspace，那是产品给 AI 存附件 / 产物的地方），
 *   只豁免「数据目录」这一条规则，凭据类规则仍然生效。
 * @returns {{ rule: "dir" | "file" | "data", message: string } | null}
 */
export const findSensitiveRule = (p, { dataRoots = [], allowedUnderData = [] } = {}) => {
  const segs = sensitiveSegmentsOf(p);
  for (const s of SENSITIVE_SEGMENTS) {
    if (segs.includes(s)) return { rule: "dir", message: `路径含凭据目录 / 文件「${s}」` };
  }
  for (const [a, b] of SENSITIVE_SEGMENT_PAIRS) {
    for (let i = 0; i + 1 < segs.length; i++) {
      if (segs[i] === a && segs[i + 1] === b) return { rule: "dir", message: `路径含凭据目录「${a}/${b}」` };
    }
  }
  const base = segs[segs.length - 1] ?? "";
  for (const re of SENSITIVE_FILE_PATTERNS) {
    if (re.test(base)) return { rule: "file", message: `文件名「${base.slice(0, 60)}」命中密钥 / 凭据文件规则` };
  }
  const inData = isAppUserDataLike(p) || dataRoots.some((r) => typeof r === "string" && r !== "" && isInsideLoose(p, r));
  if (inData && !allowedUnderData.some((d) => typeof d === "string" && d !== "" && isInside(p, d))) {
    return { rule: "data", message: "路径在 Flowship 自己的数据目录内（含其它任务的数据与应用配置）" };
  }
  return null;
};

/**
 * 校验一批要上传的文件：形状 → realpath → 普通文件 / 大小 → 黑名单（原路径与 realpath 都查，防符号链接绕过）。
 * 任一文件不合规整批拒绝（抛 Error，message 是给 AI 的具体文案）。
 *
 * 返回的每项带文件「指纹」`ino` / `dev` / `mtimeMs`（取自 stat；取不到就是 undefined）：调用方在真正把路径交给页面之前，
 * 用 {@link revalidateUploadFiles} 紧贴着再校验一次，防「校验之后、使用之前」被换成符号链接 / 别的文件（R1-27 TOCTOU）。
 *
 * @param {string[]} paths
 * @param {{
 *   fs: { realpath: (p: string) => Promise<string>, stat: (p: string) => Promise<{ isFile: () => boolean, size: number, ino?: number, dev?: number, mtimeMs?: number }> },
 *   platform?: string, dataRoots?: string[], allowedUnderData?: string[],
 * }} deps
 * @returns {Promise<Array<{ path: string, name: string, size: number, ino?: number, dev?: number, mtimeMs?: number }>>}
 */
export const validateUploadFiles = async (paths, deps) => {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("paths 至少要有 1 个文件");
  if (paths.length > MAX_UPLOAD_FILES) throw new Error(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件，收到 ${paths.length} 个`);
  const platform = deps.platform ?? process.platform;
  const out = [];
  for (const p of paths) {
    const shape = checkUploadShape(p, { platform });
    if (!shape.ok) throw new Error(`上传路径不合规：${shape.reason}`);
    const hitRaw = findSensitiveRule(p, deps);
    if (hitRaw) throw new Error(`出于安全考虑拒绝上传该文件：${hitRaw.message}`);
    let real;
    let st;
    try {
      real = await deps.fs.realpath(p);
      st = await deps.fs.stat(real);
    } catch {
      throw new Error(`文件不存在或无法访问：「${p.slice(0, 120)}」`);
    }
    if (!st.isFile()) throw new Error(`「${path.basename(real).slice(0, 60)}」不是普通文件（目录 / 设备不能上传）`);
    if (st.size > MAX_UPLOAD_BYTES) {
      throw new Error(`文件「${path.basename(real).slice(0, 60)}」超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限（${Math.ceil(st.size / 1024 / 1024)}MB）`);
    }
    const hitReal = findSensitiveRule(real, deps);
    if (hitReal) throw new Error(`出于安全考虑拒绝上传该文件（符号链接指向受保护位置）：${hitReal.message}`);
    out.push({ path: real, name: path.basename(real), size: st.size, ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs });
  }
  return out;
};

/** `ino` 有效：正的有限数（缺失 / NaN / 0 都视为「文件系统没给」——部分文件系统用 0 占位） */
const hasInode = (ino) => typeof ino === "number" && Number.isFinite(ino) && ino > 0;

/**
 * 没有有效 `ino` 时的退路：`size` 必须有且相等；`mtimeMs` 两次都有就必须相等，一次有一次没有算不一致，两次都没有只比 size。
 * 首次校验的结果里连 size 都没有（调用方传来的不是 validateUploadFiles 的返回值）→ 没东西可比，按不一致处理（fail-closed）。
 */
const sameSizeAndMtime = (before, now) => {
  if (!Number.isFinite(before.size) || before.size !== now.size) return false;
  const hadM = Number.isFinite(before.mtimeMs);
  const hasM = Number.isFinite(now.mtimeMs);
  if (hadM !== hasM) return false;
  return !hadM || before.mtimeMs === now.mtimeMs;
};

/**
 * R1-27 TOCTOU：把已通过 {@link validateUploadFiles} 的文件在**交给页面之前**紧贴着再校验一次。
 * 对每个文件重新 realpath + stat，要求：仍是普通文件、没超大小、realpath 之后的路径仍不命中黑名单、
 * 并且指纹与首次校验时一致：`ino` / `dev` 都可用时比 `ino` / `dev`（文件被删后换成硬链接 / 别的文件 / 指向别处的符号链接都会让指纹变）；
 * R2-10：文件系统不提供有效 `ino`（缺失 / 非数字 / 0）时，两次都没有就退回比 `size` + `mtimeMs`（旧版 `undefined !== undefined`
 * 为假，等于放行）；一次有、一次没有则按「变化」拒绝。
 * 任一不满足整批抛 Error（message 是给 AI 的具体文案，不含完整路径）。
 *
 * 已知限制：FUSE / SMB / 部分网络盘的 `ino` 可能每次 stat 都不同（动态分配），这类盘上会被误拒（报「文件标识变化」）——
 * 这是 fail-closed 的取舍，没有可靠办法在不放宽 TOCTOU 防护的前提下区分「ino 不稳」与「真被换了」；遇到时让 AI 重试
 * 或把文件复制到本机磁盘再上传（server 侧白名单本来就只放工作目录 / 临时目录 / 下载目录，通常在本机盘）。
 *
 * 局限（写在这里免得被当成「彻底解决」）：Chromium 拿到路径后是**稍后**才真正读文件内容的，
 * 本函数只能把「校验 → 使用」之间的窗口缩到一次 CDP 往返；彻底消除要把校验过的文件先复制到私有临时目录再上传。
 * 另外：首次校验之前就已存在、名字无害的硬链接（指向凭据文件）无法靠路径 / 指纹发现。
 *
 * @param {Array<{ path: string, name?: string, size?: number, ino?: number, dev?: number, mtimeMs?: number }>} files validateUploadFiles 的返回值
 * @param {Parameters<typeof validateUploadFiles>[1]} deps 与 validateUploadFiles 同一份（fs / dataRoots / allowedUnderData）
 * @returns {Promise<void>}
 */
export const revalidateUploadFiles = async (files, deps) => {
  for (const f of files) {
    const label = String(f.name ?? path.basename(String(f.path))).slice(0, 60);
    let real;
    let st;
    try {
      real = await deps.fs.realpath(f.path);
      st = await deps.fs.stat(real);
    } catch {
      throw new Error(`文件「${label}」在校验之后消失或无法访问，已取消上传`);
    }
    if (!st.isFile()) throw new Error(`「${label}」在校验之后变成了非普通文件，已取消上传`);
    const hadId = hasInode(f.ino);
    const hasId = hasInode(st.ino);
    if (hadId && hasId) {
      if (st.ino !== f.ino || st.dev !== f.dev) {
        throw new Error(`文件「${label}」在校验之后被替换（文件标识变化），出于安全考虑已取消上传，请确认文件后重新上传`);
      }
    } else if (hadId !== hasId) {
      // 一次有、一次没有：不是同一种取值方式（换了文件系统 / 挂载点），按变化处理，宁可错拒
      throw new Error(`文件「${label}」在校验之后被替换（文件标识变化），出于安全考虑已取消上传，请确认文件后重新上传`);
    } else if (!sameSizeAndMtime(f, st)) {
      // 两次都没有 ino（文件系统不提供）：退回比较 size + mtime，比 `undefined !== undefined` 的「恒放行」强
      throw new Error(`文件「${label}」在校验之后发生了变化（该文件系统不提供文件标识，按大小 / 修改时间比对不一致），出于安全考虑已取消上传，请确认文件后重新上传`);
    }
    if (st.size > MAX_UPLOAD_BYTES) {
      throw new Error(`文件「${label}」在校验之后变大并超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限，已取消上传`);
    }
    const hit = findSensitiveRule(real, deps);
    if (hit) throw new Error(`出于安全考虑已取消上传（「${label}」在校验之后指向了受保护位置）：${hit.message}`);
  }
};
