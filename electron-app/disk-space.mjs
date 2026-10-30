/**
 * 磁盘剩余空间的换算（纯函数、无 electron 依赖，可被 vitest 直接单测）。
 *
 * 为什么单独抽出来：这几个数是「静默更新预检」和排障日志的依据，单位写错的后果很重——
 * 差 1024 倍（MB 写成 GB / KB）会让几乎所有人被静默拦截、或让预检形同虚设，而且日志里的数字也会
 * 把排障引到错的方向。换算埋在 main.js 里只能靠肉眼看；statfs 由调用方注入后，在 Mac 上就能用
 * 假数据把每个边界测掉（单测传假的 statfs、主进程传 node:fs 的 statfsSync）。
 */

/** 1 MB = 1024 × 1024 字节。与 packaging/installer.nsh 里 `System::Int64Op $1 / 1048576` 同源（测试对账）。 */
export const BYTES_PER_MB = 1048576;

/** 1 GB = 1024³ 字节（日志里给人看的单位）。 */
export const BYTES_PER_GB = 1073741824;

/**
 * 目录所在盘「对当前用户可用」的字节数。取不到（目录不存在 / UNC / 无权限 / 数值异常）→ null。
 * 用 bavail 不用 bfree：bfree 含非特权用户用不了的保留块，预检要的是「我这个用户实际还能写多少」。
 * @param {string} dir
 * @param {(dir: string) => { bavail: number | bigint, bsize: number | bigint }} statfs 可注入
 * @returns {number | null}
 */
export const freeBytes = (dir, statfs) => {
  try {
    const s = statfs(dir);
    const bytes = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
};

/** 字节 → MB（向下取整）。与 NSIS `Int64Op /` 的整除语义一致：安装器和主进程对「剩余多少 MB」的结论不能差 1。 */
export const bytesToMB = (bytes) => Math.floor(bytes / BYTES_PER_MB);

/** 字节 → GB 文案（一位小数），日志 / 弹框用。 */
export const formatGB = (bytes) => (bytes / BYTES_PER_GB).toFixed(1);

/** 目录所在盘的剩余空间（GB、一位小数）；取不到记 "?"。 */
export const formatFreeGB = (dir, statfs) => {
  const bytes = freeBytes(dir, statfs);
  return bytes === null ? "?" : formatGB(bytes);
};

/**
 * 静默更新需要的 %TEMP% 所在盘剩余空间（MB）。
 *
 * 唯一的 JS 侧来源——主进程预检、弹框文案都读它，不再各写一个 "800"；
 * packaging/installer.nsh 的 FLOWSHIP_MIN_TEMP_FREE_MB 必须与它相等（测试对账，包体增长要改两处时
 * 漏一处会红）。
 * 由来（v1.9.29 实测包）：7z 载荷 118MB 先落到 %TEMP%，再解压 447MB，峰值约 565MB，留余量取 800MB。
 */
export const MIN_TEMP_FREE_MB = 800;

/**
 * 静默更新预检：%TEMP% 所在盘够不够装。
 * 口径与安装器 .onInit 完全一致：向下取整到 MB、严格小于阈值才算不够；量不到（UNC / 无权限）放行，
 * 交给安装器兜底——宁可少拦也不能在量不准时把人挡在更新之外。
 * @param {string} tmpDir 一般传 os.tmpdir()
 * @param {(dir: string) => { bavail: number | bigint, bsize: number | bigint }} statfs 可注入
 * @param {number} [minMB]
 * @returns {{ enough: boolean, freeMB: number | null, minMB: number }}
 */
export const checkUpdateTempSpace = (tmpDir, statfs, minMB = MIN_TEMP_FREE_MB) => {
  const bytes = freeBytes(tmpDir, statfs);
  if (bytes === null) return { enough: true, freeMB: null, minMB };
  const freeMB = bytesToMB(bytes);
  return { enough: freeMB >= minMB, freeMB, minMB };
};

/**
 * mac 暂存更新需要的剩余空间（MB）：下载 dmg 和展开 .app 两份会同时在盘上（dmg 要到暂存结束的 finally 才删）。
 * 依据：dmg 约 118–122MB（v1.9.37 的 GitHub release 资产大小：mac arm64 118.4MB / x64 122.4MB）+ 展开后的 Flowship.app 约 410MB
 * （R14 B2-4 在开发机上 `du -sh /Applications/Flowship.app` 实测）≈ 530MB，留约 12–13% 余量取 600MB。
 * 只用于**下载之前**的预检（downloadAndStageMacUpdateInner）；
 * 量不到放行（口径同 checkUpdateTempSpace：宁可少拦也不能在量不准时把人挡在更新之外）。
 * 包体明显增长时改这一处即可（弹框文案也读它）。
 */
export const MIN_MAC_STAGE_FREE_MB = 600;

/** 空间文案：≥ 1GB 用 GB（一位小数），否则 MB。更新预检（StageNoSpaceError）和低磁盘通知（disk-watch.mjs）共用这一处。 */
export const formatMB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

/**
 * mac 暂存因磁盘剩余空间不足而被预检拦下。按**类型**判（isStageNoSpaceError），不匹配文案。
 * 它发生在下载 dmg 之前、没花流量——重试 / 弹框策略据此区分于「下完才失败」的那类（见 update-verify-retry.mjs isCostlyStageFailure）。
 */
export class StageNoSpaceError extends Error {
  /** @param {{ freeMB: number | null, minMB: number }} space */
  constructor(space) {
    super(
      `磁盘剩余空间不足（约 ${formatMB(space.freeMB ?? 0)}），暂存更新至少需要 ${formatMB(space.minMB)}。请清理磁盘后再试。`,
    );
    this.name = "StageNoSpaceError";
    this.code = "STAGE_NO_SPACE";
    this.freeMB = space.freeMB;
    this.minMB = space.minMB;
  }
}

/** @param {unknown} err */
export const isStageNoSpaceError = (err) => err instanceof StageNoSpaceError;

/**
 * mac 暂存的下载前预检：updates 目录所在盘不够 → 抛 StageNoSpaceError；够 / 量不到 → 返回量到的结果（给日志用）。
 * @param {string} dir 一般传 updatesDirPath()（须已存在，statfs 才量得到）
 * @param {(dir: string) => { bavail: number | bigint, bsize: number | bigint }} statfs 可注入
 * @param {number} [minMB]
 * @returns {{ enough: boolean, freeMB: number | null, minMB: number }}
 */
export const assertMacStageSpace = (dir, statfs, minMB = MIN_MAC_STAGE_FREE_MB) => {
  const space = checkUpdateTempSpace(dir, statfs, minMB);
  if (!space.enough) throw new StageNoSpaceError(space);
  return space;
};
