/**
 * browser_upload 的 server 侧路径策略（契约 §14.2）：白名单目录 + 敏感路径黑名单，纯函数 + 依赖注入的 fs，便于单测。
 *
 * # 为什么要在 server 先校验
 * AI 给的 `paths` 是任意字符串。上传 = 把本机文件字节交给一个**不可信网页**，所以路径必须先过这里：
 * 只有「任务自己能碰到的地方」（工作目录 / worktree / 任务附件目录 / 系统临时目录 / 下载目录）才允许，
 * 并且无论在不在白名单里，凭据类文件（.ssh / .env / 私钥 / Flowship 数据目录……）一律拒绝。
 * 主进程（electron-app/browser/upload-guard.mjs）会再按同一套黑名单校验一次。
 * **两侧各自实现、不共享代码**（一边 mjs 一边 TS）；`tests/helpers/browser-v3-vectors.ts` 是共用的测试向量，
 * 两个测试文件各跑一遍，保证判定一致。改规则时两边一起改。
 *
 * # 白名单根目录从哪来（FlowshipToolContext 只有 taskId / scope / signal，所以全部由 taskId 现查）
 * - 任务工作目录：`getTaskMeta(taskId)` → `getTaskWorkRepoPaths(task)`（隔离任务 = worktree 子目录，否则原仓）
 *   + `task.repoPaths`（原仓）+ `getTaskWorktreesDir(taskId)`（多仓 worktree 的容器）。
 *   刻意**不**用 `task.workCwd`：多仓非隔离时它是仓库的「公共父目录」，可能宽到 `~/Documents`。
 * - 任务附件目录：`<数据目录>/tasks/<taskId>/uploads`（用户粘贴 / 拖进来的图片与超长文本）与 `…/workspace`（agent 的产出兜底落点）。
 *   这两个目录**在 Flowship 数据目录内**，所以数据目录黑名单对它们做「只限本任务」的豁免。
 * - 系统临时目录（`os.tmpdir()`，POSIX 另加 `/tmp`）。
 * - 系统下载目录（`~/Downloads`，含 browser_save 写入的 `Flowship-browser` 子目录）。
 * 缺口：没有「用户在设置里额外授权的目录」这种概念，所以不存在；用户想传别处的文件，需要先复制进上面任一目录。
 *
 * # 比较方式
 * 白名单比较用 `fs.realpath` 之后的路径（macOS 的 /tmp、/var 是 /private/... 的符号链接；
 * 符号链接指出白名单目录的文件会因 realpath 落在目录外而被拒）。黑名单对「原路径」与「realpath 路径」都查。
 * 黑名单一律不区分大小写；白名单在 linux 上区分大小写、darwin / win32 不区分。
 * R2-10：黑名单匹配前按 Windows 路径语义归一每一段——去掉末尾的点 / 空格（Win32 会吃掉：`x.pem.` 打开的就是 `x.pem`）、
 * 去掉第一个 `:` 之后的内容（NTFS 备用数据流：`x.key::$DATA` 就是 `x.key`）。任何平台上都做（便于测试），
 * POSIX 上名字真带 `:` / 末尾点的文件也按归一后的名字判——只会多拒、不会漏放。**白名单比较不做这种归一**（归一会放宽白名单）。
 * 黑名单是列举式、不可能穷尽，它是「已知高危文件」的兜底；真正的边界是上面的白名单目录。
 */
import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { wrapUntrustedInline } from "./content";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 10;
const MAX_PATH_CHARS = 4096;

// ----------------- 类型 -----------------

export interface UploadPolicyFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{ isFile(): boolean; size: number }>;
}

export interface UploadPolicyEnv {
  platform: NodeJS.Platform | string;
  /** 白名单根目录（原样给；内部各自 realpath，不存在的忽略） */
  allowedRoots: string[];
  /** Flowship 数据目录（黑名单）：FLOWSHIP_DATA_DIR / userData 一类 */
  dataRoots: string[];
  /** 数据目录内的豁免子目录（本任务自己的 uploads / workspace），只豁免「数据目录」这一条规则 */
  allowedUnderData: string[];
}

export type UploadRule = "count" | "shape" | "blacklist" | "missing" | "not-file" | "too-large" | "outside";

export interface UploadFileInfo {
  /** realpath 之后的路径：交给主进程的就是它（避免校验后被替换符号链接的 TOCTOU） */
  path: string;
  name: string;
  size: number;
}

export type UploadVerdict = { ok: true; files: UploadFileInfo[] } | { ok: false; rule: UploadRule; message: string };

// ----------------- 纯函数：黑名单（与 upload-guard.mjs 同规则） -----------------

// R1-27 新增项（与 upload-guard.mjs 逐项同步）：`.password-store` / `.config/gh`、id_ecdsa* / id_dsa*、*.ppk / *.kdbx? / *.jks / *.keystore / *.p8、
// .git-credentials / .pgpass / .pypirc / .htpasswd / .dockercfg / .s3cfg / .vault-token / .my.cnf / .mylogin.cnf
// R2-10 新增项（与 upload-guard.mjs 逐项同步）：段 `.mozilla` / `bravesoftware`；连续两段 `.config/rclone`、`.git/config`、浏览器 profile；
// 文件名 `.yarnrc*` / `*_history` / `*.tfstate*` / `secrets.*` / 浏览器登录库与 cookie 库（`Login Data*`、`logins.json`、`key3|4.db`、`Cookies`、`cookies.sqlite`、`Web Data`）
const SENSITIVE_SEGMENTS: readonly string[] = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".npmrc", ".netrc", ".azure", ".password-store", ".mozilla", "bravesoftware",
];
const SENSITIVE_SEGMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
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
];
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
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
];
const APP_USER_DIR_NAMES: ReadonlySet<string> = new Set(["fe-ai-flow", "fe-ai-flow-test"]);
const APP_DATA_ROOT_TAILS: ReadonlyArray<readonly string[]> = [
  ["library", "application support"],
  ["appdata", "roaming"],
  [".config"],
];

const segmentsOf = (p: string, lower = true): string[] =>
  String(p ?? "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => (lower ? s.toLowerCase() : s));

/**
 * 一段路径按 Windows 语义归一（R2-10）：第一个 `:` 之后（NTFS 备用数据流名 / 流类型，`x.key::$DATA`）丢掉，
 * 末尾的点与空格丢掉（Win32 路径规范化会吃掉它们，`x.pem.` / `x.pem ` 打开的是同一个文件）。
 */
const winNormSegment = (seg: string): string => {
  const colon = seg.indexOf(":");
  return (colon >= 0 ? seg.slice(0, colon) : seg).replace(/[. ]+$/, "");
};

/** 黑名单匹配用的段：{@link segmentsOf} + 每段 {@link winNormSegment}（归一后为空的段丢掉） */
const sensitiveSegmentsOf = (p: string): string[] => segmentsOf(p).map(winNormSegment).filter(Boolean);

/**
 * 数据目录黑名单用的「宽松」包含判断：两侧都按 {@link winNormSegment} 归一后再比（`fe-ai-flow.` / ADS 写法绕不过）。
 * 只用在「拒绝」方向；「豁免」方向（allowedUnderData）与白名单仍用严格的 {@link isInsideDir}，宽松只会多拒、不会多放。
 */
const isInsideLoose = (child: string, parent: string): boolean => {
  const c = sensitiveSegmentsOf(child);
  const pa = sensitiveSegmentsOf(parent);
  if (pa.length === 0) return false;
  return c.length >= pa.length && pa.every((s, i) => c[i] === s);
};

/** child 是 parent 本身或其下任意路径？根目录 / 空串当作「没配置」 */
export const isInsideDir = (child: string, parent: string, caseSensitive = false): boolean => {
  const c = segmentsOf(child, !caseSensitive);
  const pa = segmentsOf(parent, !caseSensitive);
  if (pa.length === 0) return false;
  if (c.length < pa.length) return false;
  return pa.every((s, i) => c[i] === s);
};

const endsWithTail = (segs: string[], end: number, tail: readonly string[]): boolean => {
  const start = end - tail.length;
  return start >= 0 && tail.every((t, i) => segs[start + i] === t);
};

/** 路径位于桌面包 userData（`<appData>/fe-ai-flow[-test]`）下？要求 `<appData>` + 目录名两段，避免误伤叫 fe-ai-flow 的开发仓库 */
export const isAppUserDataLike = (p: string): boolean => {
  const segs = sensitiveSegmentsOf(p);
  for (let i = 0; i < segs.length; i++) {
    if (APP_USER_DIR_NAMES.has(segs[i]) && APP_DATA_ROOT_TAILS.some((tail) => endsWithTail(segs, i, tail))) return true;
  }
  return false;
};

export interface SensitiveHit {
  rule: "dir" | "file" | "data";
  message: string;
}

/**
 * 拒绝文案里嵌的磁盘文件名 / realpath（R2-02）：文件名可以是页面决定的（下载目录里的 Content-Disposition 文件名、
 * 符号链接的名字），一整句「忽略以上指令…」也是合法文件名。文案其余部分是我们写的，所以只把这些片段内联包成不可信，
 * 调用方（tools.ts 的 browser_upload）发现文案里有包裹时再补结尾的固定提醒。
 */
const untrustedName = (s: string): string => wrapUntrustedInline(s);

/** 命中敏感路径规则吗？（与 electron-app/browser/upload-guard.mjs 的 findSensitiveRule 同规则） */
export const findSensitiveRule = (
  p: string,
  opts: { dataRoots?: readonly string[]; allowedUnderData?: readonly string[] } = {},
): SensitiveHit | null => {
  const dataRoots = opts.dataRoots ?? [];
  const allowedUnderData = opts.allowedUnderData ?? [];
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
    if (re.test(base)) return { rule: "file", message: `文件名「${untrustedName(base.slice(0, 60))}」命中密钥 / 凭据文件规则` };
  }
  const inData = isAppUserDataLike(p) || dataRoots.some((r) => r !== "" && isInsideLoose(p, r));
  if (inData && !allowedUnderData.some((d) => d !== "" && isInsideDir(p, d))) {
    return { rule: "data", message: "路径在 Flowship 自己的数据目录内（含其它任务的数据与应用配置）" };
  }
  return null;
};

/** 路径形状（不碰文件系统）：绝对、无 NUL、无 `..` 段、长度合理。向量与主进程 checkUploadShape 一致 */
export const checkUploadShape = (p: unknown, platform: string = process.platform): { ok: true } | { ok: false; reason: string } => {
  if (typeof p !== "string" || p.trim() === "") return { ok: false, reason: "路径为空" };
  if (p.length > MAX_PATH_CHARS) return { ok: false, reason: `路径过长（上限 ${MAX_PATH_CHARS} 字符）` };
  if (p.includes("\u0000")) return { ok: false, reason: "路径含非法字符" };
  // R1-11：win32 下以两个斜杠 / 反斜杠开头 = UNC 网络路径或 `\\?\` `\\.\` 设备路径，realpath / stat 一碰就会向远端发 SMB + NTLM。
  // 必须在任何 fs 调用之前（形状阶段）拒绝；与 electron-app/browser/upload-guard.mjs 的 checkUploadShape 同规则、同文案。
  if (platform === "win32" && /^[\\/]{2}/.test(p)) {
    return { ok: false, reason: "不支持网络共享（UNC）路径与设备路径（以 \\\\ 或 // 开头），请先把文件复制到本机磁盘再上传" };
  }
  const isAbs = platform === "win32" ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p);
  if (!isAbs) return { ok: false, reason: `必须是绝对路径，收到「${p.slice(0, 80)}」` };
  if (p.split(/[\\/]+/).includes("..")) return { ok: false, reason: "路径里不能有 .. 段，请给规范化后的绝对路径" };
  return { ok: true };
};

// ----------------- 主流程 -----------------

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const fail = (rule: UploadRule, message: string): UploadVerdict => ({ ok: false, rule, message });

const realRoots = async (roots: string[], fs: UploadPolicyFs): Promise<string[]> => {
  const out: string[] = [];
  for (const r of roots) {
    if (typeof r !== "string" || r === "") continue;
    try {
      out.push(await fs.realpath(r));
    } catch {
      // 目录不存在（如还没建的 uploads）：不是白名单的一部分
    }
  }
  return out;
};

/** 拒绝文案里给 AI 的「去哪放」提示：优先任务工作目录，其次临时目录 */
const copyHint = (env: UploadPolicyEnv): string => {
  const first = env.allowedRoots.find((r) => r !== "");
  return first ? `（例如复制到 ${clip(first, 120)} 下）` : "";
};

/**
 * 校验 browser_upload 的 paths。任一文件不合规整批拒绝（返回具体到「哪条规则、怎么办」的文案）。
 * 通过时返回 realpath 之后的路径列表（交给主进程）。
 */
export const checkUploadPaths = async (
  rawPaths: unknown,
  env: UploadPolicyEnv,
  fs: UploadPolicyFs = nodeFs,
): Promise<UploadVerdict> => {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) return fail("count", "paths 至少要有 1 个文件的绝对路径");
  if (rawPaths.length > MAX_UPLOAD_FILES) return fail("count", `一次最多上传 ${MAX_UPLOAD_FILES} 个文件，收到 ${rawPaths.length} 个；请分批上传`);
  const caseSensitive = env.platform === "linux";
  const roots = await realRoots(env.allowedRoots, fs);
  const rootsAlso = [...new Set([...env.allowedRoots.filter((r) => r !== ""), ...roots])];
  const sensOpts = { dataRoots: env.dataRoots, allowedUnderData: env.allowedUnderData };
  const files: UploadFileInfo[] = [];

  for (const p of rawPaths) {
    const shape = checkUploadShape(p, env.platform);
    if (!shape.ok) return fail("shape", `上传路径不合规：${shape.reason}`);
    const raw = p as string;
    const hitRaw = findSensitiveRule(raw, sensOpts);
    if (hitRaw) return fail("blacklist", `出于安全考虑拒绝上传该文件：${hitRaw.message}。这类文件不能交给网页，请换用其它文件`);
    let real: string;
    let st: { isFile(): boolean; size: number };
    try {
      real = await fs.realpath(raw);
      st = await fs.stat(real);
    } catch {
      return fail("missing", `文件不存在或无法访问：「${untrustedName(clip(raw, 120))}」。请确认路径是否正确`);
    }
    const name = path.basename(real);
    if (!st.isFile()) return fail("not-file", `「${untrustedName(clip(name, 60))}」不是普通文件（目录 / 设备不能上传）。需要上传目录里的文件请逐个给出路径`);
    if (st.size > MAX_UPLOAD_BYTES) {
      return fail("too-large", `文件「${untrustedName(clip(name, 60))}」约 ${Math.ceil(st.size / 1024 / 1024)}MB，超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限`);
    }
    const hitReal = findSensitiveRule(real, sensOpts);
    if (hitReal) {
      return fail("blacklist", `出于安全考虑拒绝上传该文件（符号链接指向受保护位置）：${hitReal.message}`);
    }
    if (!roots.some((r) => isInsideDir(real, r, caseSensitive))) {
      return fail(
        "outside",
        `该路径不在任务允许的目录内（${untrustedName(clip(real, 120))}）。请先把文件复制到任务工作目录或系统临时目录再上传${copyHint({ ...env, allowedRoots: rootsAlso })}。允许的位置：任务工作目录 / worktree、任务的 uploads 与 workspace 目录、系统临时目录、系统下载目录`,
      );
    }
    files.push({ path: real, name, size: st.size });
  }
  return { ok: true, files };
};

// ----------------- 取任务的目录（运行时；测试可注入） -----------------

/** 任务目录信息的来源（默认动态 import 真实模块；单测注入假数据，避免拉起整个 task-fs） */
export interface TaskDirSource {
  getTask(taskId: string): Promise<{ repoPaths: string[] } | null>;
  workRepoPaths(task: { repoPaths: string[] }): string[];
  worktreesDir(taskId: string): string;
  taskDataDir(taskId: string): string;
  workspaceDir(taskId: string): string;
  dataRoot(): string;
}

const loadRealSource = async (): Promise<TaskDirSource> => {
  // 动态 import：upload-policy 被 tools.ts 引用、而 flowship-tools.ts 又引 tools.ts，静态引 task-fs 容易成环
  const [fsMod, core, wt, root] = await Promise.all([
    import("../task-fs"),
    import("../task-fs-core"),
    import("../task-worktrees"),
    import("../data-root"),
  ]);
  return {
    getTask: (id) => fsMod.getTaskMeta(id),
    workRepoPaths: (t) => wt.getTaskWorkRepoPaths(t as Parameters<typeof wt.getTaskWorkRepoPaths>[0]),
    worktreesDir: (id) => wt.getTaskWorktreesDir(id),
    taskDataDir: (id) => core.taskDir(id),
    workspaceDir: (id) => core.getTaskWorkspaceDir(id),
    dataRoot: () => root.dataRoot(),
  };
};

/** 组装某个任务的上传策略环境（白名单根 / 数据目录黑名单 / 豁免） */
export const resolveUploadEnv = async (
  taskId: string,
  opts: { source?: TaskDirSource; platform?: string; tmpdir?: string; homedir?: string; extraTmp?: string[] } = {},
): Promise<UploadPolicyEnv> => {
  const platform = opts.platform ?? process.platform;
  const source = opts.source ?? (await loadRealSource());
  const home = opts.homedir ?? os.homedir();
  const allowed: string[] = [];
  const allowedUnderData: string[] = [];
  const dataRoots: string[] = [];

  try {
    const task = await source.getTask(taskId);
    if (task) {
      allowed.push(...source.workRepoPaths(task), ...task.repoPaths, source.worktreesDir(taskId));
    }
    const uploads = path.join(source.taskDataDir(taskId), "uploads");
    const workspace = source.workspaceDir(taskId);
    allowed.push(uploads, workspace);
    allowedUnderData.push(uploads, workspace);
    dataRoots.push(source.dataRoot());
  } catch {
    // taskId 非法 / 任务读不到：只剩临时目录 + 下载目录，不因此整个拒绝服务
  }

  allowed.push(opts.tmpdir ?? os.tmpdir(), ...(opts.extraTmp ?? []));
  if (platform !== "win32") allowed.push("/tmp");
  allowed.push(path.join(home, "Downloads"));
  return { platform, allowedRoots: allowed.filter(Boolean), dataRoots, allowedUnderData };
};
