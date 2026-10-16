/**
 * Windows 待装 exe 的「安装前验签」门禁（从 main.js 的 verifyWinPendingInstaller 机械抽出，依赖注入）
 *
 * 为什么抽出来：它是 quitAndInstall 之前的最后一道安全闸（R9-01），但全仓此前没有任何测试真调用过它，
 * 只靠对 main.js 源码字符串的顺序 grep——改个写法就能假绿，门禁被悄悄削弱也没人知道（第五轮审查 F1-02）。
 * 抽成不依赖 electron / 模块级变量的函数后，门禁顺序、验签失败不放行、错误类型原样透传都能被真调用测试钉死。
 *
 * 行为与抽取前一致（只是把三个外部依赖改成参数；第七轮 K3-11 起「库登记的待装文件 ≠ 已验签文件」改抛带类型的确定不符，
 * 这是收紧而不是放宽——以前它是普通 Error、被当「暂时性」处置），**没有任何放宽**：
 * - 门禁次序：先查 file / assetName → 再查版本号格式 → 再做「库登记的待装文件 = 已验签文件」交叉校验 → 最后才验签；
 *   前面任何一道不过就 throw，不会走到验签（也就不会去取 manifest / 读盘）；
 * - 验签（verifyDownloadedUpdate）的任何失败原样向上抛——错误类型决定调用方删不删缓存 / 开不开发布页，
 *   这里绝不 catch、包装或吞掉。
 *
 * 不 import electron、不碰模块级状态：winAutoUpdater 等运行时状态由调用方通过 getRunFile 惰性取。
 * （只 import 同目录的纯错误类 UpdateVerifyMismatchError，用来给「待装文件被换」抛带类型的确定不符。）
 */
import { UpdateVerifyMismatchError } from "./update-manifest-verify.mjs";

/**
 * 对待装 exe 做完整验签；失败 throw（由调用方决定怎么处置）。
 *
 * @param {{ version?: unknown, file?: string, assetName?: string } | null | undefined} pending
 *   待装 exe 的登记：version / file / assetName（assetName 取自 latest.yml，见 pickWinInstallerAssetName）
 * @param {object} deps
 * @param {() => unknown} deps.getRunFile
 *   取 electron-updater 内部登记的待装文件（downloadedUpdateHelper.file，quitAndInstall 将要拉起的那个）。
 *   必须是惰性取值（调用时才读 winAutoUpdater）：它在更新器初始化之后才存在、之后还会变
 * @param {(a: string, b: string) => boolean} deps.sameWinPath  Windows 路径比较（大小写不敏感）
 * @param {(version: string, file: string, assetName: string) => Promise<void>} deps.verifyDownloadedUpdate
 *   取 manifest + 验签 + 实测 size / SHA-256 的 IO 实现（main.js 的 verifyDownloadedUpdate）
 */
export const verifyWinPendingInstallerWith = async (
  pending,
  { getRunFile, sameWinPath, verifyDownloadedUpdate },
) => {
  if (!pending?.file || !pending?.assetName) {
    throw new Error("找不到已下载安装包的路径或它在 release 上的文件名、已中止安装");
  }
  // 版本号来自更新通道（latest.yml）、不可信：只收三段数字——既是 manifest 版本比对的前提，
  // 也避免它被原样拼进 manifest 下载 URL（路径注入）。mac 的版本号本来就是从 tag URL 里用同款正则抠的
  if (!/^\d+\.\d+\.\d+$/.test(String(pending.version))) {
    throw new Error(`更新版本号格式异常（${String(pending.version).slice(0, 32)}）、已中止安装`);
  }
  // 验的必须就是 quitAndInstall 将要拉起的那个文件：它读的是 electron-updater 内部的
  // downloadedUpdateHelper.file（与事件里的 downloadedFile 同源）。内部属性取不到就跳过这道
  // 交叉校验（不因库内部改名而误拦合法更新）；取到了却对不上则拒绝
  const runFile = getRunFile();
  if (typeof runFile === "string" && runFile && !sameWinPath(runFile, pending.file)) {
    // 带类型的「确定不符」（K3-11）：它说明库要装的文件 ≠ 我们验过的文件（被换 / 被改），是证据确凿的失败。
    // 以前抛普通 Error → 调用方把它当「未归类 = 暂时性」：保留缓存、弹「这不代表安装包有问题」，方向反了。
    // code 固定 "pending-file"：不属于清单级（它发生在已有安装包之后），文案走「安装包没通过校验」那一支。
    // 注意（第八轮 L2-05）：main.js 的 resumeRetainedWinInstaller 对**同一个条件**（库登记的待装文件 ≠ 我们记的那个）只是静默回落、
    // 不弹框不删文件——两处口径不同是有意的：那里还没有「已验签、等着装」的东西，这里已经是「验过、马上 quitAndInstall」，
    // 库要拉起的包没验过、没有安全的回落路径。原因与 helper.file / downloadedFile 的关系见 resumeRetainedWinInstaller 的注释。
    throw new UpdateVerifyMismatchError("待安装的文件与已验签的文件不一致、已中止安装", "pending-file");
  }
  await verifyDownloadedUpdate(pending.version, pending.file, pending.assetName);
};
