/**
 * Windows 退出时「先礼后兵」地停 server（评审 R1-2；与 unix 的 SIGTERM → 2s → SIGKILL 对称）。
 *
 * 背景：unix 分支早已改成先 SIGTERM 让 server 跑优雅退出钩子（杀飞书 consumer / 停预览 dev server，见
 * src/lib/server/feishu-bridge/inbound.ts 的 ensureExitHook），Windows 分支却仍是直接 `taskkill /T /F`——
 * 钩子在 Windows 正常退出时从不执行。
 *
 * 为什么不能只发「不带 /F 的 taskkill」：Windows 没有 POSIX 信号。不带 /F 的 taskkill 只是给目标进程的
 * **窗口**投递 WM_CLOSE；server 是无窗口的后台进程（ELECTRON_RUN_AS_NODE + windowsHide），多半直接报
 * 「This process can only be terminated forcefully (with /F option)」、退出码 1——请求根本没送达。
 * 所以真正的优雅通道是 **stdin 管道关闭**（spawn 时给 server 一根 stdin 管道，退出时壳 end() 它，
 * server 侧在同一个 ensureExitHook 里监听 stdin 的 'end' → 走与 SIGTERM 同一个清理函数；esbuild / LSP 的惯用法）。
 * 为什么选它而不是 IPC / 本机 HTTP 停止端点：
 *   - IPC（stdio 的 "ipc" 通道）会让 Next 的 `process.send` 路径误以为有父进程可通信、且 IPC 句柄让事件循环常驻；
 *   - HTTP 停止端点要新增 API 路由 + 鉴权（本机任意网页可 fetch 127.0.0.1），攻击面与改动面都更大；
 *   - stdin 只是把现有 `"ignore"` 改成 `"pipe"`、server 侧一个 `once('end')`，由环境变量显式开启（只有壳会设），
 *     独立运行 / 测试 / 容器里 stdin 被关闭不会让 server 误退。壳崩溃时管道断开还会让 server 自己清理退出（顺带收益）。
 *
 * 流程（全部系统调用都经注入，单测用假 exec / 假时钟，不碰真 taskkill）：
 *   1. 请求关闭：同时做两件事——① 关 server 的 stdin（真通道）；② `taskkill /PID <pid> /T`（不带 /F，审查方建议的请求）。
 *   2. 在预算（默认 4s）内等 server 自己退出（以 ChildProcess 的 'exit' 事件 / exitCode 为准）。
 *      - 立即失效检测：若 ② 被拒（退出码非 0）且 ① 也没有可用通道（stdin 不可写）→ 没有任何优雅通道，
 *        不等预算、立刻强杀；② 被拒但 ① 仍可用时继续等（stdin 通道独立于 taskkill 是否生效）。
 *      - ② 返回 128（找不到进程）= 进程已不在：不强杀，只等 'exit' 事件落地。
 *   3. 超时 / 失效 → 强杀前再确认「仍是我们记录的那个 server」（句柄没退出 + pid 记录没被新实例覆盖），
 *      再发 `taskkill /PID <pid> /T /F`，之后短等回收（与 unix 的 SIGKILL 后等 1s 同款）。
 *
 * pid 复用的防线：只信 Node 持有的子进程句柄状态（Node 持有进程句柄期间 Windows 不会回收该 pid）；
 * 一旦观察到句柄已退出，绝不再对这个 pid 发任何 taskkill。重入 / 重复退出：同一个 proc 只会跑一次（WeakMap 复用同一个 Promise）。
 *
 * ⚠️ 优雅退出路径的「连进程树强杀」在哪（R8-4）：server 自己 process.exit(0) 之后，壳这边再没有可用的 `/T`（server 已死，
 * 对死 pid 发 `taskkill /T` 找不到根，事后补杀不可能）。所以树杀改由 **server 自己**在退出清理同步做完之后做：
 * 壳设了 FLOWSHIP_EXIT_ON_STDIN_EOF 的 stdin-EOF 分支里 `taskkill /PID <自己> /T /F`（src/lib/server/win-self-tree-kill.ts，
 * 仅 win32、可注入、清理完成之后才杀）。本文件的 /T /F 只在 server 不理会 EOF（超时 / 没有优雅通道）时才发。
 * 壳崩溃时管道断开 → server 收到 EOF → 同样走「清理 → 自杀整树」，不留孤儿。
 */

/**
 * 优雅等待预算：必须容纳 server 侧「退出清理上限 1.5s（inbound.ts 的 EXIT_HOOK_CLEANUP_CAP_MS）+ 自杀整树的同步 taskkill 2s
 * （src/lib/server/win-self-tree-kill.ts 的 WIN_SELF_TREEKILL_TIMEOUT_MS）= 3.5s」并留余量；同时必须小于壳侧退出看门狗（WIN_QUIT_WATCHDOG_MS）。
 */
export const WIN_STOP_GRACE_MS = 4000;
/** 轮询间隔（也是「失效 / 退出」被察觉的最大延迟） */
export const WIN_STOP_POLL_MS = 100;
/** 强杀后等 'exit' 事件回收的上限（与 unix SIGKILL 后的 1s 同款） */
export const WIN_FORCE_REAP_MS = 1000;
/**
 * 「请求」那次 taskkill（不带 /F）的超时：它与等待并行、不叠加进总耗时，且多半立刻以 1（只能强制终止）失败，1.5s 足够。
 */
export const WIN_TASKKILL_TIMEOUT_MS = 1500;
/**
 * 带 /F（连进程树强杀）的 taskkill 超时：R8-4 前与请求共用 1.5s——大进程树 / Defender 扫描下 1.5s 会把 taskkill 自己掐掉、
 * 树只杀一半；旧的 before-quit 同步强杀是 5s。现在单独给 4.5s（落在审查方建议的 4–5s 内，略小于旧的 5s）。
 * 用在：stopWinServer 的 /F（main.js 的 taskkillWin 按参数里有没有 /F 选）与退出看门狗的同步强杀（killServerTreeSync）。
 */
export const WIN_FORCE_TASKKILL_TIMEOUT_MS = 4500;
/**
 * 退出看门狗（win32）：必须大于 stopWinServer 的最坏总耗时、再留余量，否则看门狗会抢在正常收尾前放行。
 * 最坏总耗时 = 优雅预算 4s + 强杀的 taskkill ≤4.5s + 回收 1s = 9.5s（请求那次 taskkill 与等待并行、不叠加）；
 * 看门狗 = 9.5s + 余量 1.5s = 11s。看门狗到点后自己还要同步强杀一次（killServerTreeSync，最多再 4.5s、阻塞主进程），
 * 所以「异步强杀与 server 同时卡死」的绝对最坏 = 11s + 4.5s = 15.5s 才 app.quit()（只在 taskkill 本身挂住时才会发生；常态是毫秒级）。
 * unix 不受影响（main.js 里 unix 仍是 7s）。
 */
export const WIN_QUIT_WATCHDOG_MS = 11000;

/** 按 taskkill 参数选超时：带 /F（强杀整树）用 WIN_FORCE_TASKKILL_TIMEOUT_MS，其余（优雅请求）用 WIN_TASKKILL_TIMEOUT_MS */
export const taskkillTimeoutFor = (args) =>
  Array.isArray(args) && args.includes("/F") ? WIN_FORCE_TASKKILL_TIMEOUT_MS : WIN_TASKKILL_TIMEOUT_MS;

/**
 * server 的 stdin-EOF 优雅退出开关（与 src/lib/server/feishu-bridge/inbound.ts 的 STDIN_EOF_EXIT_ENV 同名）：
 * **只有 win32** 才设成壳的值 "1"；其它平台一律**显式删掉**——用户环境里若 export 了它，unix 分支 stdin 是 "ignore"（/dev/null，立即 EOF），
 * server 一启动就会走优雅退出（R8-7）。win32 无论用户环境里原来是什么都被覆盖成 "1"（该平台壳给的是真管道）。
 * 纯函数、不改入参。
 * @param {Record<string, string | undefined>} env
 * @param {NodeJS.Platform | string} platform
 */
export const withStdinEofExitEnv = (env, platform) => {
  const out = { ...env };
  delete out.FLOWSHIP_EXIT_ON_STDIN_EOF;
  if (platform === "win32") out.FLOWSHIP_EXIT_ON_STDIN_EOF = "1";
  return out;
};

/** taskkill 的退出码：0 = 成功；128 = 找不到进程；其它非 0（典型 1）= 失败（含「只能强制终止」） */
const TASKKILL_NOT_FOUND = 128;

/**
 * 把一次 taskkill 的结果归类。exec 约定返回 `{ code }`（0 = 成功）；reject / 抛错 / 没有 code 一律算失败。
 * @param {{ code?: number | string | null } | null | undefined} res
 * @returns {"ok" | "not-found" | "rejected"}
 */
export const classifyTaskkill = (res) => {
  // 注意：Number(null) === 0——超时 / 起不来时 code 是 null，绝不能被当成「退出码 0 = 成功」
  const raw = res && typeof res === "object" ? res.code : undefined;
  const code = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : Number.NaN;
  if (code === 0) return "ok";
  if (code === TASKKILL_NOT_FOUND) return "not-found";
  return "rejected";
};

/**
 * pid 复用 / 被接管的判定（stopServer 注入给 confirmIdentity）：server-pid.json 里的记录若是「别的 pid」，
 * 说明已经有新实例覆盖了记录、手上这个 pid 不能再强杀；没有记录（写失败 / 已清）视为兼容、照常（句柄状态才是主防线）。
 * @param {number|null|undefined} recordedPid parseServerPidRecord 的结果
 * @param {number} pid 要强杀的 server pid
 */
export const isRecordCompatibleWithPid = (recordedPid, pid) =>
  recordedPid === null || recordedPid === undefined || recordedPid === pid;

/** 关 server 的 stdin（EOF = 请 server 自己走优雅退出）；返回通道是否真的送出了 */
const closeStdin = (proc) => {
  const s = proc.stdin;
  if (!s || s.destroyed || s.writableEnded || s.writable === false) return false;
  try {
    s.end();
    return true;
  } catch {
    return false;
  }
};

const inflight = new WeakMap();

/**
 * @typedef {{ outcome: "no-pid" | "already-exited" | "graceful" | "pid-gone" | "identity-mismatch" | "forced",
 *             reason?: "timeout" | "no-channel", stdin?: boolean, request?: string, waitedMs?: number, exited?: boolean }} WinStopResult
 */

/**
 * @param {{
 *   proc: import("node:events").EventEmitter & { pid?: number, exitCode?: number | null, signalCode?: string | null, stdin?: any },
 *   exec: (args: string[]) => Promise<{ code?: number | string | null }>,
 *   sleep: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 *   graceMs?: number, pollMs?: number, reapMs?: number,
 *   confirmIdentity?: (pid: number) => boolean,
 * }} deps
 * @returns {Promise<WinStopResult>}
 */
export const stopWinServer = (deps) => {
  const { proc } = deps;
  if (proc && typeof proc === "object") {
    const running = inflight.get(proc);
    if (running) return running; // 重入 / 重复退出：同一个 server 只停一次
    const p = runStop(deps);
    inflight.set(proc, p);
    return p;
  }
  return Promise.resolve({ outcome: "no-pid" });
};

const runStop = async ({
  proc,
  exec,
  sleep,
  now = () => Date.now(),
  log = () => {},
  graceMs = WIN_STOP_GRACE_MS,
  pollMs = WIN_STOP_POLL_MS,
  reapMs = WIN_FORCE_REAP_MS,
  confirmIdentity = () => true,
}) => {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1) return { outcome: "no-pid" };
  // 先挂 exit 监听再判断，避免「判断完、挂监听前」那一瞬间的退出丢失
  let exited = false;
  const exitP = new Promise((resolve) => {
    proc.once("exit", () => {
      exited = true;
      resolve("exited");
    });
  });
  // 句柄状态是唯一可信的存活判据（pid 复用防线，见文件头）
  const hasExited = () =>
    exited || (proc.exitCode ?? null) !== null || (proc.signalCode ?? null) !== null;
  if (hasExited()) return { outcome: "already-exited" };

  const pid = proc.pid;
  const startedAt = now();
  const deadline = startedAt + graceMs;
  const waited = () => now() - startedAt;

  // 1) 请求关闭：stdin EOF（真通道）+ 不带 /F 的 taskkill（请求；多半「只能强制」而被拒）
  const stdinSent = closeStdin(proc);
  let request = "pending";
  const requestP = Promise.resolve()
    .then(() => exec(["/PID", String(pid), "/T"]))
    .then(classifyTaskkill, () => "rejected")
    .then((r) => {
      request = r;
      return r;
    });

  // 2) 在预算内等 server 自己退
  let forceReason = "timeout";
  for (;;) {
    if (hasExited()) return { outcome: "graceful", stdin: stdinSent, request, waitedMs: waited() };
    if (request === "not-found") {
      // 进程已不在（taskkill 找不到）：不强杀，只等 'exit' 事件落地（pid 可能已被复用，绝不能再对它发 /F）
      const reapDeadline = now() + reapMs;
      while (!hasExited() && now() < reapDeadline) await Promise.race([exitP, sleep(pollMs)]);
      log(`[main] win32 停 server：pid=${pid} 已不在（taskkill 找不到）、不强杀`);
      return { outcome: "pid-gone", stdin: stdinSent, request, waitedMs: waited(), exited: hasExited() };
    }
    if (request === "rejected" && !stdinSent) {
      // 没有任何可用的优雅通道（stdin 不可写 + taskkill 被拒）：白等满预算没有意义、立刻强杀
      forceReason = "no-channel";
      log(`[main] win32 停 server：优雅请求无效（taskkill 被拒、stdin 不可用）、立即强杀 pid=${pid}`);
      break;
    }
    if (now() >= deadline) {
      log(`[main] win32 停 server：${graceMs}ms 内未退出（taskkill=${request} stdin=${stdinSent}）、强杀 pid=${pid}`);
      break;
    }
    const pending = [exitP, sleep(pollMs)];
    if (request === "pending") pending.push(requestP); // 仅在未落定时参与竞速，否则已 resolve 的 promise 会让循环空转
    await Promise.race(pending);
  }

  // 3) 强杀：再确认「仍是我们记录的那个 server」
  if (hasExited()) return { outcome: "graceful", stdin: stdinSent, request, waitedMs: waited() };
  let identityOk = true;
  try {
    identityOk = confirmIdentity(pid) !== false;
  } catch {
    identityOk = true; // 读记录出错不能挡住强杀（最坏退回旧行为）
  }
  if (!identityOk) {
    log(`[main] win32 停 server：pid=${pid} 的 server-pid 记录已被新实例覆盖、不强杀（避免误杀复用的 pid）`);
    return { outcome: "identity-mismatch", stdin: stdinSent, request, waitedMs: waited() };
  }
  try {
    await exec(["/PID", String(pid), "/T", "/F"]);
  } catch {
    // 进程恰好已退 / 无权限：忽略，下面等 exit 事件看结果
  }
  const reapDeadline = now() + reapMs;
  while (!hasExited() && now() < reapDeadline) await Promise.race([exitP, sleep(pollMs)]);
  return {
    outcome: "forced",
    reason: forceReason,
    stdin: stdinSent,
    request,
    waitedMs: waited(),
    exited: hasExited(),
  };
};
