/**
 * Windows 静默更新门禁（纯函数、无 electron 依赖，可被 vitest 直接单测）。
 *
 * 背景（更新完 App 没了的三连坑）：
 * 1. 曾手动传 /D= 钉安装目录，但 Node 给含空格路径自动加引号、旧 NSIS 取参不去引号
 *    → $INSTDIR 非法 → 旧目录已删、新文件写不进。现在不再传 /D=，用注册表
 *    InstallLocation（electron-updater 默认行为），这个 bug 类别直接消失。
 * 2. 但"删旧文件"永远由用户机器上旧版本的卸载器执行——旧卸载器可能带 /T 误杀
 *    安装器、或来自传 /D= 时代。因此只有"新安装器装的"才敢静默：新安装器在
 *    $INSTDIR 落 `.silent-update-ok` 标记；没标记 = 旧版本装的 → 必须手动过渡一次。
 * 3. 静默安装黑盒无回调：quitAndInstall 前写"墓碑"，下次启动核销——版本没变 =
 *    死半路了，弹框请手动装，不再无声消失。
 */
import path from "node:path";

/** 安装目录里的"新安装器"标记文件名（installer.nsh customInstall 落盘）。 */
export const SILENT_UPDATE_OK_MARKER = ".silent-update-ok";

/** userData 里的"更新墓碑"文件名（quitAndInstall 前写、启动时核销）。 */
export const WIN_UPDATE_ATTEMPT_FILE = "win-update-attempt.json";

/** 标记文件的完整路径（主进程：path.dirname(process.execPath) 即安装目录）。 */
export const silentUpdateMarkerPath = (installDir) =>
  path.join(String(installDir), SILENT_UPDATE_OK_MARKER);

/**
 * 有新安装器标记才敢静默更新。
 * @param {(p:string)=>boolean} existsSync 可注入（单测传 mock，主进程传 node:fs 的）
 */
export const hasSilentUpdateMarker = (installDir, existsSync) => {
  try {
    return existsSync(silentUpdateMarkerPath(installDir)) === true;
  } catch {
    return false;
  }
};

/** 墓碑内容：目标版本号 + 时间戳（quitAndInstall 前一刻写）。 */
export const buildWinUpdateAttempt = (version, now = Date.now()) => ({
  version,
  ts: now,
});

/**
 * 墓碑核销（启动时一次）：
 * - "none"：无墓碑 / 损坏 / 版本号怪异 → 不打扰；
 * - "success"：当前版本已 >= 目标版本 → 更新生效，静默销墓碑；
 * - "failed"：目标版本仍新于当前版本 → 死半路了，必须弹框请手动装。
 * @param {(a:string,b:string)=>boolean} isNewer 三段式版本比较（main.js 注入）。
 */
export const classifyWinUpdateAttempt = (attempt, currentVersion, isNewer) => {
  const want = attempt?.version;
  if (typeof want !== "string" || want === "") return "none";
  if (typeof currentVersion !== "string" || currentVersion === "") return "none";
  try {
    if (currentVersion === want || isNewer(currentVersion, want)) return "success";
    if (isNewer(want, currentVersion)) return "failed";
  } catch {
    return "none";
  }
  return "none";
};
