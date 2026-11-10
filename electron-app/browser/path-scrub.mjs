/**
 * 本机绝对路径清洗（R6-34 / 红线：userData 绝对路径不回流给模型）。
 *
 * 为什么需要：`<userData>/data/tasks/<taskId>/…` 里有操作系统用户名（`/Users/<name>/…` / `C:\Users\<name>\…`）。perf / record 的写盘失败文案
 * （`EACCES: permission denied, open '<绝对路径>'`）、录制期间的活动日志条目（会成为 `stop` 结果里的 `ai-action` 标记）、`export_activity` 导出的文件内容，
 * 都会以某种方式到达模型。**主路径是「源头不写」**（perf 的活动日志只写 `browser-traces` + 文件名）；这里的清洗是写盘 / 出站前的**第二道防线**：
 * 即便以后有人在某条文案里拼了路径，也到不了模型。
 *
 * - {@link fsErrorText}：fs 风格的错误（有 `code` + `syscall` / `path`）→ 只留 errno 码、中文释义、系统调用名和**文件名**（不含目录）；
 * - {@link scrubPaths}：任意文本里的本机路径 → 先精确替换 userData / 家目录（含空格的路径只有精确替换才删得干净），再把残余的绝对路径收成 `…/<文件名>`。
 *
 * 通用兜底只认「像本机路径」的形状（`/Users/…`、`/home/…`、`/var/…`、`/tmp/…` 等常见顶层目录，Windows 盘符，`~/…`），**不动**路由式的 `/api/users`：
 * 活动日志里常有「POST /api/login」这类文字，不能被误收。线性：每次迭代都以分隔符起头、字符类不含 `/`，没有嵌套量词。纯函数，无 Electron 依赖。
 *
 * **已知误伤（R6-43 ③，有意保留、不改代码）**：路由字面量只要以 `TOP` 里的系统顶层目录名开头（`/home` / `/dev` / `/run` / `/var` / `/etc` / `/opt` …），
 * 也会被当成本机路径缩写——`GET /home/dashboard 200` → `GET …/dashboard 200`。只影响标记 / 导出 / 错误文案的可读性，方向是「宁可多藏」；
 * 不把 `TOP` 限定成「仅在 roots 命中后才替换」是因为通用兜底的意义就是 roots 之外的路径（临时目录、别的用户目录）也要收。
 */
import nodeOs from "node:os";

const FS_CODE_TEXT = Object.freeze({
  ENOSPC: "磁盘空间不足",
  EDQUOT: "超出磁盘配额",
  EACCES: "没有权限",
  EPERM: "操作不被允许",
  EROFS: "只读文件系统",
  ENOENT: "路径不存在",
  EEXIST: "已存在",
  ENOTDIR: "不是目录",
  EISDIR: "是目录",
  EMFILE: "打开的文件过多",
  ENFILE: "系统打开的文件过多",
  EBUSY: "资源忙",
  ENAMETOOLONG: "路径过长",
  ELOOP: "符号链接层级过多",
  EIO: "I/O 错误",
  ENOMEM: "内存不足",
  EFBIG: "文件过大",
});

/** 取路径的最后一段（同时认 `/` 与 `\`）；末尾是分隔符 → 空串 */
export const pathBaseName = (p) => {
  const s = String(p ?? "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i < 0 ? s : s.slice(i + 1);
};

/** 文件名只留可打印的短串（控制字符 → 空；限长） */
const cleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").slice(0, 80);

// POSIX 常见的「本机目录」顶层名：只认这些，`/api/users` 这类路由不算路径
const TOP = "Users|home|root|var|private|tmp|opt|mnt|Volumes|Library|Applications|System|usr|etc|srv|run|proc|dev|snap|nix";
// 裸路径的字符类：排除空白 / 引号 / 常见结尾标点（含全角），避免把句号、括号一起吞掉；不含 `/` 与 `\`，每次迭代由分隔符起头，边界唯一
const STOP = String.raw`\s'"\`<>|*?,;，。；：、（）「」`;
const QUOTED_ABS_RE = new RegExp(String.raw`(['"\`])((?:\/(?:${TOP})\/|[A-Za-z]:[\\/]|~[\\/])[^'"\`\r\n]{0,400})\1`, "g");
const POSIX_ABS_RE = new RegExp(String.raw`(?<![\w:/.~-])\/(?:${TOP})(?![\w.-])(?:\/[^${STOP}\/\\]+)+\/?`, "g");
const HOME_ABS_RE = new RegExp(String.raw`(?<![\w])~[\\/](?:[^${STOP}\/\\]+[\\/]?)+`, "g");
const WIN_ABS_RE = new RegExp(String.raw`(?<![\w])[A-Za-z]:[\\/](?:[^${STOP}\/\\]+[\\/]?)*`, "g");
// 精确替换之后留下的 `<userData>/data/tasks/<id>/x.log`：目录结构 + taskId 也没必要给，收成 `…/x.log`（裸 `<userData>` 保留，表示「那个根」）
const LABELED_SUB_RE = new RegExp(String.raw`<userData>(?:[\\/][^${STOP}\/\\]+)+[\\/]?`, "g");

const homeDir = () => {
  try {
    return nodeOs.homedir().replace(/[\\/]+$/, "");
  } catch {
    return "";
  }
};

const asRoots = (roots) => {
  const out = new Set();
  const add = (r) => {
    if (typeof r !== "string") return;
    const t = r.replace(/[\\/]+$/, "");
    if (t.length >= 3) out.add(t);
  };
  for (const r of roots ?? []) add(r);
  add(homeDir());
  return [...out].sort((a, b) => b.length - a.length);
};

const tail = (p) => {
  const name = cleanName(pathBaseName(String(p).replace(/[\\/]+$/, "")));
  return name === "" ? "…" : `…/${name}`;
};

/**
 * 把文本里的本机绝对路径去掉。`roots`：额外要精确剔除的根（一般传 userData）；家目录自动加入。
 * 1. 精确替换：root（及其 `\` ↔ `/` 变体）→ `<userData>`（家目录 → `~`），其后的子路径收成 `…/<文件名>`。含空格的路径（macOS 的 `Application Support`）靠这一步删干净；
 * 2. 引号包起来的绝对路径（Node 的 fs 错误就是 `open '<path>'`）→ `…/<文件名>`；
 * 3. 其余裸绝对路径（常见顶层目录的 POSIX 路径 / Windows 盘符 / `~/…`）→ `…/<文件名>`。URL（`https://host/a/b`）不动：路径前面是 `\w` / `:` / `/` 时不匹配。
 * @param {unknown} text
 * @param {{ roots?: string[] }} [opts]
 * @returns {string}
 */
export const scrubPaths = (text, { roots } = {}) => {
  let s = String(text ?? "");
  if (s === "") return s;
  const home = homeDir();
  for (const r of asRoots(roots)) {
    const label = r === home ? "~" : "<userData>";
    for (const variant of new Set([r, r.replace(/\\/g, "/"), r.replace(/\//g, "\\")])) {
      if (variant !== "" && s.includes(variant)) s = s.split(variant).join(label);
    }
  }
  s = s.replace(LABELED_SUB_RE, (m) => tail(m));
  s = s.replace(QUOTED_ABS_RE, (_m, q, p) => `${q}${tail(p)}${q}`);
  s = s.replace(WIN_ABS_RE, (m) => tail(m));
  s = s.replace(HOME_ABS_RE, (m) => tail(m));
  s = s.replace(POSIX_ABS_RE, (m) => tail(m));
  return s;
};

/**
 * 错误 → 可以进结果 / 错误文案 / 日志的短文本，**不含目录路径**。
 *  - Node fs 错误（`code` 形如 `ENOSPC`，且有 `syscall` / `path` / `errno`）：`ENOSPC（磁盘空间不足） open .trace-….tmp`——errno 码 + 释义 + 系统调用 + 文件名；
 *  - 其它错误：message 过 {@link scrubPaths}。
 * @param {unknown} err
 * @param {{ roots?: string[], max?: number }} [opts]
 * @returns {string}
 */
export const fsErrorText = (err, { roots, max = 160 } = {}) => {
  const e = /** @type {any} */ (err);
  const code = typeof e?.code === "string" && /^E[A-Z0-9_]{2,}$/.test(e.code) ? e.code : null;
  if (code && (typeof e?.syscall === "string" || typeof e?.path === "string" || typeof e?.errno === "number")) {
    const label = FS_CODE_TEXT[code];
    const syscall = typeof e.syscall === "string" ? e.syscall.replace(/[^a-z_]/gi, "").slice(0, 20) : "";
    const target = typeof e.path === "string" ? cleanName(pathBaseName(e.path)) : "";
    return `${code}${label ? `（${label}）` : ""}${syscall ? ` ${syscall}` : ""}${target ? ` ${target}` : ""}`.slice(0, max);
  }
  return scrubPaths(String(e?.message ?? err), { roots }).slice(0, max);
};
