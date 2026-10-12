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
 * 只看「文件在不在」：标记内容（安装器写入的版本号）仅供人排障时看「这份安装是哪个版本落的」，
 * 门禁不读它、也不拿它当最低版本门槛——要引入门槛时再补读取逻辑，别默认内容有人在校验。
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

/**
 * 在 installer.log（安装器追加写、只含 ASCII）里找「目标版本」最近一次的预检拦截记录。
 * 行格式由 packaging/installer.nsh 的 ABORT 日志决定（测试用安装器源码里的模板对账，改一边漏一边会红）：
 *   [ts=<unix 秒>] ABORT v<版本> tempFreeMB=<剩余 MB> < <阈值 MB> old install untouched
 * 日志是追加的、同一版本可能被拦过多次 → 取最后一条（最近一次的数字）。
 * 读取方传 latin1 解码后的文本即可（全是 ASCII，字节不会丢）；调用方可以只传尾部若干 KB，
 * 被截断的第一行因为锚定了行首 `[ts=` 不会误匹配。
 * @param {string} logText
 * @param {string} version 目标版本号（与墓碑里的 version 同格式、无前缀 v）
 * @returns {{ freeMB: number, minMB: number } | null}
 */
export const findInstallerAbort = (logText, version) => {
  if (typeof logText !== "string" || typeof version !== "string" || version === "") return null;
  let found = null;
  for (const line of logText.split(/\r?\n/)) {
    const m = /^\[ts=\d+\]\s+ABORT v(\S+) tempFreeMB=(\d+) < (\d+)(?:\s|$)/.exec(line);
    if (m && m[1] === version) found = { freeMB: Number(m[2]), minMB: Number(m[3]) };
  }
  return found;
};

/**
 * 主进程预检拦下时的文案（拉起安装器之前、App 还开着）。
 * 不引导去发布页：手动装同样要这些空间，把人往那边送只会重蹈覆辙。
 * @returns {{ reason: string, title: string, body: string }}
 */
export const buildSpaceBlockedMessage = ({ freeMB, minMB }) => {
  const reason = `系统盘（临时目录所在盘）剩余约 ${freeMB}MB，低于更新所需的 ${minMB}MB`;
  return {
    reason,
    title: "磁盘空间不足，暂不更新",
    body:
      `${reason}。\n\n` +
      "请先清理系统盘（清空回收站、删临时文件、卸载不用的软件），腾出空间后再点「更新」。\n\n" +
      "本次没有做任何改动，当前版本照常使用。",
  };
};

/**
 * 墓碑核销判定「上次更新没装上」后的弹框文案。
 * - 有 ABORT 记录：安装器是因为空间不足主动退出的 → 针对性说明，先让用户清理；
 *   不再引导去发布页（原有安装没动、手动装也要同样空间）。
 * - 没有：通用文案，但把「清理系统盘」放在「手动安装」前面（原先顺序反了）。
 * @param {{
 *   wantVersion: string, currentVersion: string,
 *   abort: { freeMB: number, minMB: number } | null,
 *   tempFreeMB: number | null, minTempFreeMB: number,
 *   installerLogPath: string,
 * }} p
 * @returns {{ title: string, body: string, offerReleasePage: boolean }}
 */
export const buildUpdateFailedMessage = ({
  wantVersion,
  currentVersion,
  abort,
  tempFreeMB,
  minTempFreeMB,
  installerLogPath,
}) => {
  const logLine = `安装过程记录在：\n${installerLogPath}`;
  if (abort) {
    return {
      title: "上次更新被取消：磁盘空间不足",
      body:
        `目标 v${wantVersion} 没装上，当前仍是 v${currentVersion}。\n\n` +
        `原因：安装器启动时发现系统盘（临时目录所在盘）只剩约 ${abort.freeMB}MB，` +
        `不够更新所需的 ${abort.minMB}MB，已主动退出——原有安装没有被改动，数据也不受影响。\n\n` +
        `请先清理系统盘（清空回收站、删临时文件、卸载不用的软件），腾出 ${abort.minMB}MB 以上后再点「更新」重试。` +
        "手动下载安装包同样需要这些空间，所以也请先清理再装。\n\n" +
        logLine,
      offerReleasePage: false,
    };
  }
  const nowFree = typeof tempFreeMB === "number" ? `（现在约剩 ${tempFreeMB}MB）` : "";
  return {
    title: "上次更新没有装上",
    body:
      `目标 v${wantVersion} 没装上、当前还是 v${currentVersion}。\n\n` +
      "最常见的两个原因：\n" +
      `1. 系统盘（临时目录所在盘）剩余空间不足 ${minTempFreeMB}MB${nowFree}——请先清理系统盘；\n` +
      "2. 杀毒软件拦截了安装器——请把 Flowship 的安装目录加入白名单后重试。\n\n" +
      "处理后可以再点「更新」；也可以去发布页手动下载安装包、装到原目录（数据不受影响）。\n\n" +
      logLine,
    offerReleasePage: true,
  };
};
