/**
 * Windows 安装目录安全检查（Temp 兜底，仅剩的有效逻辑）。
 *
 * 历史：v1.9.13 起曾有“短路径优先传 /D=”策略（resolveWinInstallDirForUpdater +
 * getWinShortPathSync），vNext 已下线（主进程不再传 /D=，注册表路径为准）——
 * 相关函数已删除，短路径逻辑冻结不再调用。不要把 /D= 决议接回去（引号 bug 会回来）。
 *
 * Temp 兜底（D 盘用户更新完人没了）：当前目录一旦落在 %TEMP% / ns*.tmp /
 * old-install 里，说明当前进程本身就在 NSIS 备份里跑（上次失败的残留、或用户从
 * Temp 里拷出来直接跑），此时静默更新会往 Temp 里装、Temp 一清人就没了——
 * 直接拒绝自动更新、让用户手动重装（见 isUnsafeWinInstallDir）。
 *
 * 本文件是纯函数、无 electron 依赖，可被 vitest 直接单测。
 */
import os from "node:os";

/** 剥首尾空白 + 首尾成对引号，去尾部分隔符（保留盘符根如 `E:\`）。 */
export const normalizeWinInstallDir = (dir) => {
  if (typeof dir !== "string") return dir;
  let d = dir.trim();
  if (d.length >= 2) {
    const first = d[0];
    const last = d[d.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      d = d.slice(1, -1).trim();
    }
  }
  // 去尾部 \ /（保留 `X:\` 这类根）
  while (d.length > 3 && /[\\/]$/.test(d)) d = d.slice(0, -1);
  return d;
};

/**
 * 安装目录安全检查：落在 Temp 里就拒绝静默更新（v1.9.13、D 盘用户更新完人没了）。
 *
 * NSIS 更新是“先把旧文件搬到 Temp/ns*.tmp/old-install 备份、清空 $INSTDIR、再写新文件”。
 * 如果当前进程本身就在 Temp 里（上次失败的残留被用户直接点了、或 Temp 还没被清），
 * /D= 会指向 Temp——更新装进 Temp、Temp 一清（重启/磁盘清理）app 就彻底没了，
 * 而真正的安装目录（D:\dev\Flowship）还停留在被清空的状态。
 *
 * @param {string} dir 已归一化的安装目录
 * @param {string} [platform] 默认 process.platform（单测可注入 win32）
 * @param {string} [tmpdir] 默认 os.tmpdir()（单测可注入）
 * @returns {string|null} 安全返回 null；不安全返回原因文案（直接打日志/弹框）
 */
export const isUnsafeWinInstallDir = (
  dir,
  platform = process.platform,
  tmpdir = os.tmpdir(),
) => {
  if (typeof dir !== "string" || dir.trim() === "") return "安装目录为空";
  // 统一成反斜杠 + 小写再比对（Windows 路径大小写不敏感、斜杠混用常见）
  const norm = dir.replace(/\//g, "\\").toLowerCase();
  const segs = norm.split("\\").filter(Boolean);
  // NSIS 自解压/卸载器的临时目录特征：old-install 备份目录（名字独特、全局拦）+
  // ns*.tmp（NSIS 自解压名前缀、只在系统 Temp 下才算——用户正常目录 D:\nsBackup.tmp
  // 这类不在 Temp 里，不能误杀；正则 ns 后必须跟字母数字，顺手过滤掉零散的 ns.tmp）。
  if (segs.some((s) => s === "old-install")) return "安装目录在 NSIS 旧版备份里（old-install）";
  // 在系统 Temp 里（注册表装机路径正常情况下永远不会指向这里）；
  // ns*.tmp 只在 Temp 下才判——NSIS 临时目录一定在 %TEMP% 里，Temp 外的 ns*.tmp
  // 是用户自己的正常目录（如 D:\nsBackup.tmp\Flowship），放行。
  if (platform === "win32" && typeof tmpdir === "string" && tmpdir) {
    const t = tmpdir.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
    if (t && (norm === t || norm.startsWith(`${t}\\`))) {
      if (segs.some((s) => /^ns[a-z0-9]+\.tmp$/.test(s)))
        return "安装目录在 NSIS 临时目录里（ns*.tmp）";
      return "安装目录在系统临时目录里";
    }
  }
  return null;
};
