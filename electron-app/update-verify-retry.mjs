/**
 * mac 自动暂存「验签失败后何时允许再试」的策略（纯函数、不 import electron，可直接单测）
 *
 * 为什么存在（M3-04 → 第五轮 F1-01）：
 * mac 的 dmg 有 100MB+，自动路径（2h 轮询 / 设置页检查更新）若在验签失败后每次都重下，会白耗流量。
 * M3-04 的解法是「同一版本验签失败过就不再自动重下」，但它对**所有**验签类失败一视同仁地永久跳过——
 * 一次瞬时的 503 / 超时（UpdateVerifyUnavailableError）也让该版本在整个进程生命周期内不再自动暂存，
 * 而 2h 轮询「网络恢复后自愈」本来正是它的价值。所以按失败的**性质**分两类：
 *
 * - 永久（isPermanentVerifyFailure）：确定不符（Mismatch，证据确凿）与该 release 没带清单（404 / 410，
 *   重试一万次也不会有）——本进程内不再自动重下（沿用 macVerifyFailedVersion）；
 * - 其余**一律**按时间退避：首次失败后 VERIFY_RETRY_BASE_MS 内不自动重试，之后每再败一次加倍，封顶 VERIFY_RETRY_MAX_MS。
 *   （5xx / 限流 / 超时 / 网络 / 正文不是清单这类 Unavailable，以及 dmg 下载 502 / 不完整、hdiutil / ditto 失败、
 *   dmg 里没找到 .app 这类未归类错误。第七轮 P2-2 之前只有 Unavailable 退避，未归类错误既不登记也不弹框——
 *   每次轮询、每次设置页「检查更新」都重走一遍「清单 → 下载 100MB+ → 失败 → 删除」，用户还毫不知情。
 *   所以不再有单独的「暂时性」判定函数：「不是永久」就是「要退避」，main.js 的 catch 里是 if / else。）
 *
 * 连续失败次数就是退避记录里的 failures（同版本累计、换版本清零、成功暂存清掉）。同一版本达到 REPEATED_FAILURE_PROMPT_AFTER 次
 * 时，后台触发的失败会弹**一次**「自动更新多次失败」说明框（shouldPromptRepeatedFailure / buildRepeatedFailureNotice）——
 * 用独立的、按版本的进程内标记去重，**不**占用 wasPrompted：后者是「每版本一次」的持久名额，确定不符 / 没带清单的安全告警也用它，
 * 一旦被「多次失败」提示用掉，之后同版本真出现确定不符就会被静默。
 *
 * 用户点更新徽标（macSelfUpdate）永远不受这里约束——那是显式重试；它失败也照样累计退避。
 * 退避记录只在进程内存里：重启应用本身就是一次显式重试。
 *
 * **退避实际管得到谁（第六轮 R6-5 实证、第八轮 L2-04 订正——以前的措辞容易让人以为它在保护 2h 轮询、还写过「前 5 次必然放行」，两头都说过头）**：
 * 退避依次是 5 / 10 / 20 / 40 / 80 / 120 / 120 / 120… 分钟。放不放行轮询只取决于一个不等式：
 *   「最近一次失败发生的时刻 + 这次失败对应的退避」≤「下一次轮询到点的时刻」→ 放行；否则被挡一轮。
 * - 纯轮询、失败发生在触发之后 delta（取版本号 / 清单 / 下载要耗时）：第 k 次失败（k ≤ 5，退避 d_k < 2h）放行 ⇔ delta ≤ 2h − d_k，
 *   即 delta 超过 2h − d_k 就被挡（k=5 时只有 40 分钟：一次耗时超过 40 分钟的慢速失败就能挡住下一轮）。
 *   delta 是秒级 / 分钟级的常见情形下前 5 次确实放行，但这是「通常」、不是「必然」；
 * - 点徽标 / 设置页「检查更新」触发的失败可发生在两次轮询之间的任意时刻，同样累计 failures、同样把 notBefore 往后推：
 *   实证——5 次失败、最后一次发生在 45 分钟时（notBefore = 125 分钟），120 分钟的轮询仍被挡；
 * - 封顶之后（k ≥ 6，退避 = 120 分钟 = 轮询周期）：失败只要晚于轮询触发哪怕一点点，notBefore 就晚于下一次触发 →
 *   下一轮被挡，长故障期间轮询节奏变成「隔一轮试一次」（约 4 小时）。网络恢复后至多晚一轮自愈。已知局限、有意不改
 *   （调整封顶或加抖动是另一个决策）；
 * 以上全部是 tests/update-verify-retry.test.ts「轮询节奏 / L2-04」用真实函数算出来的（只有数值推演、没有起定时器）。
 * 结论：退避**不是**对轮询的保护——它只保证「短时间内反复触发」不会反复重下（设置页连点）；轮询靠的是下面的闸。
 *
 * **第八轮 L2-01：按 failures 设闸（`isCostlyStageFailure` / `nextCostlyFailureRecord` / `shouldGiveUpAutoStage`）**：
 * 退避只读 notBefore、不读 failures，所以「未归类失败」（dmg 下载 502 / 不完整、hdiutil / ditto 失败、找不到 .app……）
 * 在 2h 轮询下每一轮都放行、每一轮整包重下 100MB+。闸补的就是这一半：同一版本「会白下 dmg 的失败」累计（不要求严格连续，见下）达到
 * STAGE_GIVE_UP_AFTER（= REPEATED_FAILURE_PROMPT_AFTER = 3）次，main.js 登记 macStageGiveUpVersion，后台轮询遇到它就跳过自动暂存（只记一行日志）。
 * - 计数口径：**不分触发方式**（后台 / 设置页检查更新 / 点徽标的失败都计，与 failures 一致）；
 *   **只数会白下 dmg 的失败**：未归类错误，以及 Unavailable 里的 local-io（dmg 已下完才读盘失败）。
 *   其余 Unavailable（5xx / 限流 / 超时 / 网络 / 清单结构非法 / 公钥）发生在清单阶段、下载之前，只花几百字节——若也计入，
 *   3 次 503 就会停掉轮询、废掉 F1-01「网络恢复后自愈」；它们既不计数也不清零（穿插在中间不影响「连续」）。
 *   永久失败（Mismatch / 没带清单）另有 macVerifyFailedVersion，不进这个计数。
 * - 解除：换版本 / 成功暂存 / 重启（都在 main.js；内存变量）。用户手动检查与点徽标不看闸、照常发起尝试：成功则解除，失败则计数继续涨、闸保持登记
 *   （不会借一次手动尝试多放后台 3 次）。
 * - 与「多次失败」提示框的关系：用同一个阈值常量，但数的东西不同——提示框数 failures（含 Unavailable）、只在后台触发时弹，
 *   闸只数上面那一类、不分触发方式，所以两者不一定同一次失败触发（例如 3 次失败全是用户自己触发的，各自有反馈框、没有后台提示框）。
 *   闸本身不弹框：登记后轮询只记一行日志，用户想重试就点徽标（提示框文案说的正是这个）。
 * 所以暂时性失败对用户的实际打扰程度**不靠退避**、而由「后台触发的暂时性失败不弹框」保证
 * （见 update-manifest-verify.mjs 的 buildVerifyRejectionNotice）；连续失败 3 次后再给一次「多次失败」的说明（见上）。
 */
import { isStageNoSpaceError } from "./disk-space.mjs";
import {
  UpdateVerifyManifestMissingError,
  UpdateVerifyMismatchError,
  UpdateVerifyUnavailableError,
  isVerifyFailure,
} from "./update-manifest-verify.mjs";

/** 首次暂时性失败后，多久之内不自动重试（5 分钟：够网络抖动恢复、又不会让用户觉得「很久不重试」） */
export const VERIFY_RETRY_BASE_MS = 5 * 60 * 1000;

/**
 * 退避上限（2 小时）。与轮询周期（UPDATE_POLL_MS = 2h）同量级：再往上加没有意义——
 * 轮询本身最多每 2h 触发一次，上限只是防止连续失败很多次后「几乎不再重试」。
 * 注意：上限恰好等于轮询周期，封顶后会让轮询偶尔被多跳一轮（原因与影响见文件头「退避实际管得到谁」）。
 */
export const VERIFY_RETRY_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * 确定性失败：本进程内不再自动重下（Mismatch / 没带 manifest）。其余类型一律 false——
 * 「永久跳过」是破坏性强的处置（该版本整个进程内不再自动暂存），宁可少登记也不乱登记。
 * 注意 false ≠「不登记任何东西」：非永久失败（含未归类错误 / 非 Error 值）由调用方登记时间退避（见文件头）。
 */
export const isPermanentVerifyFailure = (err) =>
  err instanceof UpdateVerifyMismatchError || err instanceof UpdateVerifyManifestMissingError;

/** 同一版本连续失败多少次后，后台触发弹一次「自动更新多次失败」说明框 */
export const REPEATED_FAILURE_PROMPT_AFTER = 3;

/**
 * 此刻要不要弹「多次失败」说明框：该版本的连续失败次数（退避记录的 failures）已达阈值，且这个版本还没弹过。
 * `promptedVersion` 是调用方自己的进程内标记（弹之前就置位）——按版本去重、换版本自动失效，与 wasPrompted 无关。
 * 调用方负责只在「后台触发 + 这次失败不是永久失败」时才问它（永久失败自己就有弹框）。
 *
 * @param {{ version: string, failures: number, notBefore: number } | null | undefined} retry
 * @param {string} version
 * @param {string | null | undefined} promptedVersion
 */
export const shouldPromptRepeatedFailure = (retry, version, promptedVersion) =>
  !!retry &&
  retry.version === version &&
  retry.failures >= REPEATED_FAILURE_PROMPT_AFTER &&
  promptedVersion !== version;

/**
 * 同一版本「会白下 dmg 的失败」累计多少次后，后台轮询放弃自动暂存（第八轮 L2-01）。
 * 「累计」不是严格连续：成功暂存 / 换版本才清零，期间的 503 等清单阶段失败既不累计也不重置——
 * 「2 次未归类 + 5 个 503 + 1 次未归类」就会触发（第九轮复核实测；此前注释与文档写的「连续 3 次」不准确）。
 * 刻意复用 REPEATED_FAILURE_PROMPT_AFTER：闸与「多次失败」提示框是同一个阈值——提示框文案说的「可点徽标重试或手动下载」
 * 正是闸登记之后唯一的重试入口，两个数不该各自漂移。
 */
export const STAGE_GIVE_UP_AFTER = REPEATED_FAILURE_PROMPT_AFTER;

/**
 * 这次失败要不要计入「放弃自动暂存」闸（第八轮 L2-01）= 是不是**会白下 dmg** 的失败。
 * - 永久失败（Mismatch / 没带清单）：false——它们走 macVerifyFailedVersion 永久跳过，不归这个闸管；
 * - 磁盘空间不足（StageNoSpaceError，R14 B2-4 / Q15-01）：false——下载前的预检就拦下了、没花任何流量；
 *   计入的话 3 次空间不足就会停掉轮询、用户腾出空间后也不再自动暂存（只剩点徽标）；
 * - 未归类错误 / 非 Error 值：true——dmg 下载 502 / 不完整、hdiutil / ditto 失败、找不到 .app 都发生在整包下载之后（或之中）；
 * - Unavailable：false——清单阶段（5xx / 限流 / 超时 / 网络 / 正文不是清单 / 过大 / 结构非法 / 公钥）在下载 dmg **之前**就败了、
 *   只花几百字节；计入的话 3 次 503 就会停掉轮询、废掉 F1-01「网络恢复后自愈」。
 *   唯一的例外是 `local-io`：dmg 已下完才 stat / 算哈希失败（main.js 的 verifyDownloadedUpdate 在下载之后调用），花掉过一次整包下载。
 * 按类型 / code 判、不匹配 message（与 isPermanentVerifyFailure 同口径）。
 */
export const isCostlyStageFailure = (err) => {
  if (isPermanentVerifyFailure(err)) return false;
  if (isStageNoSpaceError(err)) return false;
  if (!isVerifyFailure(err)) return true;
  return err instanceof UpdateVerifyUnavailableError && err.code === "local-io";
};

/**
 * 记一次失败到「会白下 dmg 的失败」计数，返回新记录 `{ version, count }`（同版本累计、换版本从 1 重来）。
 * 不计入的失败（见 isCostlyStageFailure）**原样返回 prev**——既不 +1 也不清零：连续性只被「成功暂存」和「换版本」打断，
 * 与退避记录里的 failures 同口径（那边也不会被一次 503 清零）。
 *
 * @param {{ version: string, count: number } | null | undefined} prev
 * @param {string} version
 * @param {unknown} err
 * @returns {{ version: string, count: number } | null | undefined}
 */
export const nextCostlyFailureRecord = (prev, version, err) => {
  if (!isCostlyStageFailure(err)) return prev;
  const count = prev && prev.version === version ? prev.count + 1 : 1;
  return { version, count };
};

/**
 * 此刻要不要对这个版本放弃自动暂存（后台轮询用）：计数记录是这个版本的、且已达 STAGE_GIVE_UP_AFTER。
 *
 * @param {{ version: string, count: number } | null | undefined} record
 * @param {string} version
 */
export const shouldGiveUpAutoStage = (record, version) =>
  !!record && record.version === version && record.count >= STAGE_GIVE_UP_AFTER;

/**
 * 「多次失败」说明框的标题 / 正文。只提示、不开发布页（调用方也不该开）：
 * 失败原因可能是网络、磁盘满、发布物不完整……不一定是「该去发布页」；用户想自己处理，徽标可重试、也可手动下载。
 *
 * @param {{ version: string, failures: number, reason: string }} args
 */
export const buildRepeatedFailureNotice = ({ version, failures, reason }) => ({
  title: "自动更新多次失败",
  body: `v${version} 的自动更新已连续失败 ${failures} 次，最近一次的原因：\n${reason}\n\n可点更新徽标重试，或到发布页手动下载安装。`,
});

/** 第 failures 次连续失败后的退避时长：BASE × 2^(failures-1)，封顶 MAX（failures < 1 当 1） */
export const verifyRetryDelayMs = (failures) => {
  const n = Math.max(1, Math.floor(Number(failures)) || 1);
  // 指数过大会得到 Infinity，Math.min 照样收敛到上限
  return Math.min(VERIFY_RETRY_BASE_MS * 2 ** (n - 1), VERIFY_RETRY_MAX_MS);
};

/**
 * 记一次暂时性失败，返回新的退避记录 `{ version, failures, notBefore }`。
 * 同版本连续失败累计次数；换了版本从 1 重新算（旧版本的失败不该拖累新版本）。
 *
 * @param {{ version: string, failures: number, notBefore: number } | null | undefined} prev
 * @param {string} version
 * @param {number} now 毫秒时间戳（Date.now()，调用方注入以便测试）
 */
export const nextVerifyRetry = (prev, version, now) => {
  const failures = prev && prev.version === version ? prev.failures + 1 : 1;
  return { version, failures, notBefore: now + verifyRetryDelayMs(failures) };
};

/**
 * 此刻是否还在该版本的退避期内（true = 自动路径应跳过暂存）。
 *
 * 剩余时间超过上限视为「系统时钟被往回拨过」：退避记录是用旧的 now 算出来的，时钟回拨后
 * `notBefore - now` 会远大于任何合法退避——这时放行，别因为时钟漂移把自动更新卡死几小时 / 几天。
 *
 * @param {{ version: string, failures: number, notBefore: number } | null | undefined} retry
 * @param {string} version
 * @param {number} now
 */
export const isVerifyRetryBlocked = (retry, version, now) => {
  if (!retry || retry.version !== version) return false;
  const remaining = retry.notBefore - now;
  return remaining > 0 && remaining <= VERIFY_RETRY_MAX_MS;
};
