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
