/**
 * 网络「记忆」卫生（R6-10 / R6-11）：Electron `session` 上有两类**不受 Flowship 决策表管**的状态——
 *  - 已建立的连接：证书错误被用户放行后，Chromium 对同 host:port 会复用那条连接，之后不再触发 `certificate-error`。
 *    决策表（net-guard 的例外表）清了、下一个任务同主机却既不询问、AI 也看不到「证书错误已被放行」的标注 → 必须 `closeAllConnections()` 断掉；
 *  - HTTP 认证缓存（Basic / Digest / NTLM，按服务器 + 路径前缀）：用户给任务 A 提交过凭据后留在持久 partition 里，任务 B 同服务器直接通过。
 *    Flowship 自己不记凭据，但「默认不记住」要对用户成立 → 任务结束时 `clearAuthCache()`。
 *
 * 全部**防御式**：fake session 没有这些方法就跳过；方法返回 Promise 就 await；抛错 / reject 一律吞掉只记日志——
 * 清理失败不能让「清除浏览数据 / 会话销毁 / 无痕 wipe」本身失败（wipe 失败会让 partition 退役，反而更糟）。
 * 不 import electron：单测用假 session 驱动。
 */

/**
 * 调 `ses[method]()`：函数才调；await 其结果；吞错并记日志。
 * @returns {Promise<boolean>} 真的调用并成功 = true
 */
const callSafe = async (ses, method, log, why) => {
  if (!ses || typeof ses[method] !== "function") return false;
  try {
    await ses[method]();
    return true;
  } catch (err) {
    try {
      log?.(`[browser] ${why}：${method} 失败（已忽略）：${err?.message || err}`);
    } catch {
      /* 日志函数自己出错也不能冒泡 */
    }
    return false;
  }
};

/** 断开该 session 上所有已建立的连接（含 keep-alive）；返回是否成功调用 */
export const closeConnectionsSafe = (ses, log, why = "清理网络连接") => callSafe(ses, "closeAllConnections", log, why);

/** 清 HTTP 认证缓存；返回是否成功调用 */
export const clearAuthCacheSafe = (ses, log, why = "清理认证缓存") => callSafe(ses, "clearAuthCache", log, why);

/**
 * 任务（browser session）结束时对**持久 partition** 的网络清理（R6-10 / R6-11）。
 *  - 认证缓存：无条件清（用户提交的 HTTP 凭据不跨任务）。取舍：同 partition 里**并发的另一任务**会被重新提示认证——这是安全侧取舍，凭据的便利让位于「默认不记住」；
 *  - 已建立的连接：只有「本会话里用户放行过该 partition 的证书例外」才断（没有例外就没有「被放行的坏证书连接」可复用；
 *    无条件断会打断并发任务里进行中的加载 / 下载，代价不对等）。
 *
 * 判断「是否有例外」必须在会话销毁（ext.dispose 清表）**之前**做——本函数在第一个 await 之前同步完成判断，所以调用方在 `session.destroy()` 之前调即可。
 *
 * @param {{
 *   netState?: { hasCertExceptions?: (partition: string) => boolean } | null,
 *   ses: any,
 *   partition: string,
 *   log?: (msg: string) => void,
 * }} p
 * @returns {Promise<{ authCleared: boolean, connectionsClosed: boolean }>} 永不 reject
 */
export const releaseSessionNetwork = async ({ netState, ses, partition, log }) => {
  let hadCertException = false;
  try {
    hadCertException = netState?.hasCertExceptions?.(partition) === true;
  } catch {
    hadCertException = true; // 判断出错按「有」处理：宁可多断一次连接
  }
  const authCleared = await clearAuthCacheSafe(ses, log, "任务结束清理认证缓存");
  const connectionsClosed = hadCertException ? await closeConnectionsSafe(ses, log, "任务结束清理已放行证书的连接") : false;
  return { authCleared, connectionsClosed };
};
