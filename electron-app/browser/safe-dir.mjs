/**
 * 写盘目录的统一安全校验（R6-15 / 红线 §15.3-8）：trace / 录制 / HAR / storage 导出共用同一套口径。
 *
 * 为什么要抽出来：`browser-traces` / `browser-recordings` 原先只做 `mkdir -p` + `chmod`。agent 有 shell 时能把这个目录换成符号链接，
 * 之后的 `chmod`、大文件写入、`prunePerfDir` 的删除都会落到链接目标上（任意目录被改权限 / 灌文件 / 删文件）。HAR / storage 早就有 lstat 校验，
 * 这里把它做成一个函数，perf / record 都走它，不再各写各的。
 *
 * 校验（逐级，从 root 起到 dir 为止，每一级都做）：
 *  1. `dir` 必须位于 `root`（任务目录）之下，路径规范化后判前缀——`..` 逃逸直接拒；
 *  2. 每一级 `lstat`：符号链接 / 非目录 → 拒绝（不存在就以 0700 创建，创建后再 `lstat` 一次，防「刚创建就被换」）；
 *  3. 属主必须是当前用户（POSIX；别人建的目录里放我们的敏感文件没有意义）；
 *  4. root 之下的目录权限必须是 0700：被放宽（如 0755）就 `chmod` 修正并复核，修正不了则拒绝。root 自身（任务目录）权限不归这里管，只校验类型与属主。
 * 残余风险（报告里写明）：lstat 与后续 open 之间仍有竞态窗口——文件写入一律用 `wx`（O_EXCL，不跟随末级符号链接）收窄；中间级被并发换成符号链接
 * 需要攻击者与我们同一用户且精确卡点，纯 fs 层无法彻底消除。
 *
 * fs 可注入（单测用真实临时目录即可，不需要 fake）；纯同步、无 Electron 依赖。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";

const unixMode = () => process.platform !== "win32";

const assertRealDir = (fs, p, label, { isRoot }) => {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${label} 不是普通目录（符号链接或文件），拒绝使用`);
  if (unixMode()) {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && Number.isInteger(st.uid) && st.uid !== uid) throw new Error(`${label} 的属主不是当前用户，拒绝使用`);
    if (!isRoot && Number.isInteger(st.mode) && (st.mode & 0o077) !== 0) {
      fs.chmodSync(p, 0o700);
      const again = fs.lstatSync(p);
      if (again.isSymbolicLink() || !again.isDirectory()) throw new Error(`${label} 在修正权限时被替换，拒绝使用`);
      if (Number.isInteger(again.mode) && (again.mode & 0o077) !== 0) throw new Error(`${label} 权限无法收紧到 0700，拒绝使用`);
    }
  }
};

/**
 * 确保 `dir` 存在且安全（见文件头）；返回规范化后的绝对路径。不安全时抛 Error（中文，不含完整路径）。
 * @param {string} dir 目标目录
 * R6-37：`create: false` 用于「读 / 导出已有目录」——任何一级不存在就把 ENOENT 原样抛出（不创建），其余校验（符号链接 / 属主 / 0700 / 前缀）不变。
 * @param {{ fs?: typeof nodeFs, root?: string, label?: string, create?: boolean }} [opts]  root 缺省取 dir 的父目录（即 `tasks/<taskId>`）；label 只用于错误文案；create 缺省 true
 * @returns {string}
 */
export const ensureSafeDir = (dir, { fs = nodeFs, root, label = "目录", create = true } = {}) => {
  if (typeof dir !== "string" || dir === "") throw new Error(`${label} 路径为空`);
  const resolved = nodePath.resolve(dir);
  const rootR = nodePath.resolve(root ?? nodePath.dirname(resolved));
  if (resolved !== rootR && !resolved.startsWith(rootR + nodePath.sep)) throw new Error(`${label} 不在任务目录之下，拒绝使用`);

  try {
    fs.lstatSync(rootR);
  } catch (err) {
    if (err?.code !== "ENOENT" || !create) throw err;
    fs.mkdirSync(rootR, { recursive: true, mode: 0o700 });
  }
  assertRealDir(fs, rootR, "任务目录", { isRoot: true });

  const rel = nodePath.relative(rootR, resolved);
  let cur = rootR;
  for (const part of rel === "" ? [] : rel.split(nodePath.sep)) {
    cur = nodePath.join(cur, part);
    try {
      fs.lstatSync(cur);
    } catch (err) {
      if (err?.code !== "ENOENT" || !create) throw err;
      fs.mkdirSync(cur, { mode: 0o700 });
    }
    assertRealDir(fs, cur, label, { isRoot: false }); // 创建后同样再 lstat 一次（assertRealDir 内部就是 lstat）
  }
  return resolved;
};
