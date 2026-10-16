/**
 * 更新 manifest 验签的纯函数部分（R9-01：mac dmg 与 Windows exe 共用同一套）
 *
 * 为什么抽出来：mac 链路（CR-02）早就有完整验签，但 Windows 走 electron-updater、只信 latest.yml
 * 里的 sha512——谁能改 GitHub release 谁就能推恶意 exe。exe 目前没有代码签名证书，
 * 所以改成「把 exe 也签进同一份 update-manifest.json」，Windows 下载完成后与安装前都走这里。
 * 抽成不依赖 electron 的纯函数，是为了能用真实 Ed25519 密钥对直接单测（main.js 一 import electron 就没法测）。
 *
 * IO（读公钥 / fetch manifest / stat / 流式 SHA-256）仍在 main.js 的 verifyDownloadedUpdate，
 * 这里只做「拿到数据之后的判定」。
 *
 * **fail-closed**：任何一步不过一律 throw Error（中文文案直接可展示给用户），没有「跳过」分支。
 *
 * **失败分三类（N2-02 + M3-03）**——都拒绝安装，区别在「已下载的安装包要不要删」「要不要引导去发布页」：
 * - UpdateVerifyMismatchError    确定不符（签名 / version / 条目缺失 / size / sha256）：证据确凿，删缓存包 + 引导去发布页；
 * - UpdateVerifyUnavailableError 暂时无法校验（5xx / 限流 / 超时 / 网络 / 公钥读不了 / 本地读文件失败 /
 *   200 却不是清单形态的 JSON，如 `{}` `{"message":…}` 缺 version·files·signature——F1-04）：
 *   这些跟安装包本身无关，删掉 112MB 的包只会让用户白下一遍——保留缓存、回 available，下次点徽标重新验；
 *   不开发布页（网络好了点徽标就能成，没必要把人往外赶）。
 * - UpdateVerifyManifestMissingError（Unavailable 的子类）这个 release 压根没带 manifest（HTTP 404 / 410）：
 *   缓存处置与上一类一致（保留），但**重试一万次也不会有清单**，所以必须给手动下载入口（弹框 + 开发布页），
 *   否则用户会永远卡在「请检查网络后重试」。仍然 fail-closed：没有 manifest 绝不自动安装。
 * 调用方按**类型**（isDefinitiveVerifyFailure / isManifestMissingFailure）分流，不要匹配 message 文案
 * （文案随时会改、也可能撞词）。
 */
import { createPublicKey, verify } from "node:crypto";
import path from "node:path";

/**
 * 验签「确定不符」：清单 / 安装包与签名对不上，说明包被换 / 被改 / 被重放，或本就不是这次发布的包。
 * `code`：signature | version | entry-missing | size | sha256 | pending-file（待装文件与已验签文件不一致，K3-11，由 win-pending-verify.mjs 抛）。
 * 不用于分流（删不删缓存 / 开不开发布页只看类型），**只**用来让弹框正文说对「哪一步没过」——
 * 清单级（signature / version / entry-missing）与文件级（size / sha256 / pending-file）的措辞不同，见 buildVerifyRejectionNotice。
 */
export class UpdateVerifyMismatchError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = "UpdateVerifyMismatchError";
    this.code = code;
  }
}

/**
 * 验签「暂时无法完成」：没拿到可用的清单，或壳自己这边读不了公钥 / 安装包。
 * 它**不能**证明安装包有问题，所以安装仍要拒绝（fail-closed）、但不该删缓存。
 * `code`：manifest-network | manifest-http | manifest-parse | manifest-too-large | manifest-invalid | public-key | local-io
 * （子类 UpdateVerifyManifestMissingError 的 code 固定为 manifest-missing）。
 */
export class UpdateVerifyUnavailableError extends Error {
  /** @param {string} message @param {string} code @param {{ cause?: unknown }} [options] */
  constructor(message, code, options) {
    super(message, options);
    this.name = "UpdateVerifyUnavailableError";
    this.code = code;
  }
}

/**
 * 这个 release 没带 manifest（HTTP 404 / 410）——「取不到清单」里**唯一不会自愈**的一种。
 *
 * 为什么做成 Unavailable 的子类、而不是并列的第三个类：它对缓存的处置与暂时性失败完全一致（保留），
 * 子类关系让所有只关心「删不删缓存」的调用方（含将来新增的）按 Unavailable 处理就天然落在保守分支上；
 * 只有需要「额外开发布页」的地方才用 isManifestMissingFailure 去识别它。
 * 反过来，如果做成独立类，任何漏写一支分流的调用方会把它当「未归类错误」，行为不可预期。
 */
export class UpdateVerifyManifestMissingError extends UpdateVerifyUnavailableError {
  /** @param {string} message @param {string} [code] @param {{ cause?: unknown }} [options] */
  constructor(message, code = "manifest-missing", options) {
    super(message, code, options);
    this.name = "UpdateVerifyManifestMissingError";
  }
}

/**
 * 是否「确定不符」——**只有**这一类才允许删缓存包。
 * 未归类的错误 / 非 Error 值一律返回 false：删文件是破坏性动作，只在有确凿证据时做。
 */
export const isDefinitiveVerifyFailure = (err) => err instanceof UpdateVerifyMismatchError;

/** 是否「这个 release 没带 manifest」——只有它（与确定不符）才允许开发布页 */
export const isManifestMissingFailure = (err) => err instanceof UpdateVerifyManifestMissingError;

/**
 * 是否「验签类」失败 = 本模块抛出的两类错误之一（确定不符 / 暂时无法校验，含「没带 manifest」子类）。
 * 与「未归类错误」区分（dmg 下载 HTTP 502、不完整、hdiutil / ditto 失败、非常规安装位置……）：
 * 后者说的不是「校验」，套用「暂时无法校验更新包」的文案会误导——mac 的两个用户触发入口（点徽标的 macSelfUpdate、
 * 设置页「检查更新」的 handleMacStageFailure）只对验签类才取 buildVerifyRejectionNotice 的标题 / 正文，
 * 其余共用 buildGenericUpdateFailureNotice 的通用「自动更新失败」（第八轮 L2-02）。
 * 按类型判、不匹配 message，也不认 name / code 冒充的鸭子类型。
 */
export const isVerifyFailure = (err) =>
  err instanceof UpdateVerifyMismatchError || err instanceof UpdateVerifyUnavailableError;

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

// HTTP 404 / 410 = 服务端明确说「没有这个文件」，而不是「现在取不到」
const MANIFEST_MISSING_HTTP_STATUSES = new Set([404, 410]);

/**
 * 清单正文上限（字节）。真实清单是 2 枚 dmg + 1 枚 exe ≈ 600 字节，1 MiB 即使将来带上百个 asset 也远远够用；
 * 又能挡住「update-manifest.json 被换成几 GB 的响应」——以前是整个正文先读进内存再 JSON.parse，
 * 30s 超时只限时长、不限字节，千兆链路 30s 足够把主进程内存打爆。
 */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

const manifestTooLarge = (maxBytes) =>
  new UpdateVerifyUnavailableError(
    `更新 manifest 过大（超过 ${maxBytes} 字节）、已中止替换`,
    "manifest-too-large",
  );

/**
 * 流式读正文并限额：累计字节一超上限就 cancel（让底层连接立刻断开、不再收数据）并抛 manifest-too-large。
 * 为什么不直接用 res.json()：它没法在读的途中设上限。解码交给 TextDecoder——与 Response.json() 同口径
 * （UTF-8、剥掉开头 BOM），多字节字符被 chunk 边界切开也没事（先拼完整再解码）。
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
const readBodyTextCapped = async (res, maxBytes) => {
  // 响应头已声明超限：连正文都不用读（没声明 / 声明撒谎的由下面的流式累计兜底）
  const declared = res.headers?.get?.("content-length");
  if (declared != null && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw manifestTooLarge(maxBytes);
  }
  const reader = res.body?.getReader?.();
  // 没有可流式读取的正文（空响应）：没有大量数据可读，退回整读，交给后面的 JSON.parse 报错
  if (!reader) return res.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw manifestTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
};

/**
 * 拉取 update-manifest.json 并解析。网络 / 超时 / 5xx / 限流 / 正文不是 JSON / 正文过大归 Unavailable——
 * 这些都只说明「这次没拿到清单」（GitHub 抖动、强制门户、代理错误页），不说明安装包有问题；
 * 唯独 404 / 410 归 UpdateVerifyManifestMissingError：该 release 漏带了 manifest，重试不会好（M3-03）。
 *
 * 超时用 AbortSignal.timeout：原先没有超时，网络黑洞时验签会一直挂着、用户点了徽标没有任何反馈。
 * 正文大小另有上限（maxBytes，默认 MAX_MANIFEST_BYTES）：超时只限时长、不限字节。
 *
 * @param {object} args
 * @param {string} args.url
 * @param {(url: string, init: { signal: AbortSignal }) => Promise<Response>} [args.fetchImpl]
 *   测试注入；默认全局 fetch（只用到 url + signal 两个入参、类型收窄到实际用法，stub 不必实现整个 fetch 签名）
 * @param {number} [args.timeoutMs]
 * @param {number} [args.maxBytes]
 */
export const fetchUpdateManifest = async ({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  maxBytes = MAX_MANIFEST_BYTES,
}) => {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UpdateVerifyUnavailableError(
      `更新 manifest 下载失败：${errMessage(err)}、已中止替换`,
      "manifest-network",
      { cause: err },
    );
  }
  if (!res.ok) {
    // 先判「服务端明说没有这个文件」：这个 release 漏带了 manifest，点多少次徽标都不会有清单，
    // 必须与「暂时取不到」区分开（后者让用户重试、前者要给手动下载入口）
    if (MANIFEST_MISSING_HTTP_STATUSES.has(res.status)) {
      throw new UpdateVerifyManifestMissingError(
        `该版本没有附带更新校验清单（update-manifest.json，HTTP ${res.status}）、已中止替换`,
        "manifest-missing",
      );
    }
    throw new UpdateVerifyUnavailableError(
      `更新 manifest 下载失败 HTTP ${res.status}、已中止替换`,
      "manifest-http",
    );
  }
  try {
    return JSON.parse(await readBodyTextCapped(res, maxBytes));
  } catch (err) {
    // 超限已经是带类型的 Unavailable（manifest-too-large），原样抛出、别被下面包成「解析失败」
    if (err instanceof UpdateVerifyUnavailableError) throw err;
    // 读正文中途断开 / 超时 abort / 正文不是 JSON：统一算「这次没拿到可用清单」
    throw new UpdateVerifyUnavailableError(
      `更新 manifest JSON 解析失败：${errMessage(err)}、已中止替换`,
      "manifest-parse",
      { cause: err },
    );
  }
};

/**
 * 清单级的「确定不符」code：签名 / version / 条目缺失——都是对着**清单**判的，在 mac 上发生在下载 dmg 之前
 * （main.js 的 loadSignedManifest 先于下载），那时根本没有已下载的文件。其余 code（size / sha256 / pending-file）
 * 是对着安装包本身判的。用 Set 显式列举：新增 code 时默认落在「文件级」（保留原有「已清除」的措辞），不会悄悄少说。
 */
const MANIFEST_LEVEL_MISMATCH_CODES = new Set(["signature", "version", "entry-missing"]);

/**
 * 「已下载的安装包此刻怎么样了」——文案里「清除 / 保留」两句话必须对得上真实动作（K3-06）：
 * - "cleared" 刚被删除；"kept" 仍留在磁盘上；"none" 没有这个文件（没下载过 / 调用方没有 file）。
 *   （删除失败的文件仍在磁盘上，所以那种情形调用方传 "kept"——文案此时既不说「已清除」，对确定不符也不说「已保留」。）
 * 调用方没传（或传了不认识的值）时按 **mac 口径**推：mac 暂存失败后 dmg 在 finally 里一定被删、不会保留，
 * 清单级失败时更是压根没下载——所以缺省下：文件级确定不符 → cleared，清单级确定不符 → none，暂时性 → none。
 * Windows 的缓存包真实去留只有 rejectUnverifiedWinUpdate 知道（确定不符且 rm 成功才是 cleared；暂时性才是 kept），由它显式传。
 */
const FILE_STATES = new Set(["cleared", "kept", "none"]);
const resolveFileState = (fileState, definitiveCode) => {
  if (FILE_STATES.has(fileState)) return fileState;
  if (definitiveCode !== undefined) return MANIFEST_LEVEL_MISMATCH_CODES.has(definitiveCode) ? "none" : "cleared";
  return "none";
};

/**
 * 按错误**类型**分三类，给出提示文案 + 「这一类要不要给手动下载入口」（与触发方式无关的那一半）。
 * 触发方式相关的处置（弹不弹框 / 要不要去重）由 buildVerifyRejectionNotice 在此基础上叠加。
 *
 * 文案按**真实动作**写（K3-06）：确定不符的正文由 code 决定「哪一步没过」（清单 / 安装包），
 * 由 fileState 决定「已下载的文件怎么样了」——不再恒说「已清除下载的文件」。
 */
const classifyVerifyRejection = (err, fileState) => {
  const reason = errMessage(err);
  if (isDefinitiveVerifyFailure(err)) {
    const manifestLevel = MANIFEST_LEVEL_MISMATCH_CODES.has(err.code);
    const cleared = resolveFileState(fileState, err.code) === "cleared";
    const subject = manifestLevel
      ? "新版本的更新校验清单没有通过完整性校验"
      : "新版本的安装包没有通过完整性校验";
    return {
      definitive: true,
      manifestMissing: false,
      openReleasePage: true,
      reason,
      title: "自动更新已中止",
      body: `${reason}\n\n${subject}，已取消自动安装${cleared ? "并清除下载的文件" : ""}。\n将打开下载页、请手动下载安装。`,
    };
  }
  if (isManifestMissingFailure(err)) {
    // 文案刻意不说「检查网络 / 重试」：没带清单是该版本发布时的问题，用户这边怎么重试都不会好；
    // 也不说「清除」：缓存是保留的（便宜且安全），只是不会被自动安装
    return {
      definitive: false,
      manifestMissing: true,
      openReleasePage: true,
      reason,
      title: "该版本暂不支持自动校验",
      body: `${reason}\n\n该版本没有附带更新校验清单，无法确认安装包的完整性，已取消自动安装。\n将打开下载页、请手动下载安装。`,
    };
  }
  // 「已下载的安装包已保留」只在真的保留了（Windows 缓存包）时才说；mac 的 dmg 不保留，说了就是假话
  const kept = resolveFileState(fileState) === "kept";
  return {
    definitive: false,
    manifestMissing: false,
    openReleasePage: false,
    reason,
    title: "暂时无法校验更新包",
    body: `${reason}\n\n这不代表安装包有问题——${kept ? "已下载的安装包已保留，" : ""}请检查网络后在更新徽标上重试。`,
  };
};

/**
 * 把验签失败翻成「给用户看的提示 + 处置标志」——「失败类型 → 处置」的**唯一**来源（第六轮 R6-5）。
 * 纯函数：Windows 的 rejectUnverifiedWinUpdate 与 mac 的 runUpdateCheck（自动暂存失败）都只读它的返回值，
 * 不再各自猜类型 / 各写一份文案；放在这里也是为了能脱离 electron 单测处置分流。
 *
 * 类型决定「证据有多硬、要不要给手动下载入口」（三类定义见文件头）；
 * 触发方式（opts.trigger）决定「有没有人在等结果」：
 * - "user"（默认）：用户点了更新徽标触发的流程（Windows 的下载 / 验签 / 安装全程都是——autoDownload=false）。
 *   用户在等结果，所以**三类都弹框**（暂时性失败也要告诉他「没成、可重试」）；不走「每版本只提示一次」的去重；
 * - "background"：2h 轮询 / 启动检查触发的 mac 自动暂存，没人在等。
 *   - 暂时性失败（5xx / 限流 / 超时 / 网络 / 未归类）：**不弹框、不开发布页、不消耗提示名额**——
 *     一次 503 不该让用户看到误导性弹框，更不能把该版本唯一一次提示用掉（之后真出现确定不符就弹不出了）；
 *     错误文案写进 updateState.error，由 2h 轮询自愈、点徽标可立即重试；
 *   - 确定不符 / 没带清单：弹框 + 开发布页 + 记提示；同一版本只提示一次（opts.alreadyPrompted 为 true 时全部静默）。
 * 不认识的 trigger（含不传）一律按 "user" 处理——保守：宁可多反馈一次，也不静默吞掉用户在等的错误。
 *
 * 返回值标志位的分工（调用方只读这些、不再自己猜类型）：
 * - `definitive`      true = 确定不符 → 允许删缓存包（只有这一类；与触发方式无关）；
 * - `manifestMissing` true = 这个 release 没带 manifest（404 / 410）；
 * - `showDialog`      要不要弹错误框；
 * - `openReleasePage` 要不要打开发布页（= 该类型需要手动下载入口 && 这次真的弹框）；
 * - `markPrompted`    要不要把该版本记为「已提示」（仅 background 且这次真的弹了框）；
 * - `stateError`      写进 updateState.error 的文案（= reason；徽标 / 排障取用，三类、两种触发一致）；
 * - `reason` / `title` / `body` 原始错误文案 / 弹框标题 / 弹框正文。
 *
 * 文案里关于「已下载的安装包」的两句话（清除 / 保留）由 `opts.fileState` 决定，见 resolveFileState；
 * 它只影响 `body` 的措辞，**不影响**上面任何标志位（删不删缓存由调用方读 `definitive`，不读 fileState）。
 *
 * @param {unknown} err
 * @param {{
 *   trigger?: "user" | "background",
 *   alreadyPrompted?: boolean,
 *   fileState?: "cleared" | "kept" | "none",
 * } | null} [opts]
 * @returns {{
 *   definitive: boolean,
 *   manifestMissing: boolean,
 *   showDialog: boolean,
 *   openReleasePage: boolean,
 *   markPrompted: boolean,
 *   stateError: string,
 *   reason: string,
 *   title: string,
 *   body: string,
 * }}
 */
export const buildVerifyRejectionNotice = (err, opts) => {
  const { trigger, alreadyPrompted, fileState } = opts ?? {};
  const base = classifyVerifyRejection(err, fileState);
  const background = trigger === "background";
  // 这一类要不要「打扰用户」：user 触发一律要；background 只有需要手动下载入口的两类才值得打扰，且每版本一次
  const showDialog = background ? base.openReleasePage && !alreadyPrompted : true;
  return {
    ...base,
    showDialog,
    openReleasePage: showDialog && base.openReleasePage,
    markPrompted: background && showDialog,
    stateError: base.reason,
  };
};

/**
 * 非验签类失败（dmg 下载 502 / 不完整、hdiutil / ditto 失败、找不到 .app、套用失败……）的**通用**用户提示——第八轮 L2-02。
 * 与 buildVerifyRejectionNotice 同形（调用方读同一组标志位），但说的不是「校验」：
 * 不套「暂时无法校验更新包 / 这不代表安装包有问题——请检查网络后重试」（对「磁盘满」这类失败是误导），
 * 而是「自动更新失败 + 原因 + 将打开下载页、请手动下载安装」，并且**真的开发布页**（文案说了要打开）。
 *
 * mac 的两个用户触发入口共用它、不再各抄一份文案：点徽标的 macSelfUpdate 通用分支、
 * 设置页「检查更新」触发暂存失败的 handleMacStageFailure（trigger="user" 且 `!isVerifyFailure(err)`）。
 * **后台触发**的非验签类失败不走这里——那是没人在等的自动暂存，仍按 R6-5 / P2-2 静默（见 buildVerifyRejectionNotice）。
 * Windows 也不走这里：它的未归类错误（找不到文件名 / 版本号异常）有自己既有的口径（保留缓存、不开发布页），由
 * buildVerifyRejectionNotice 的「暂时无法校验」分支给出，tests/update-verify-disposition.test.ts 钉着它。
 *
 * 原因取法 `err?.message || err` 与 macSelfUpdate 原先写的完全一致（非 Error 值、空 message 退回 String(err)，不会只剩「将打开下载页」）。
 *
 * @param {unknown} err
 * @returns {{
 *   definitive: boolean,
 *   manifestMissing: boolean,
 *   showDialog: boolean,
 *   openReleasePage: boolean,
 *   markPrompted: boolean,
 *   stateError: string,
 *   reason: string,
 *   title: string,
 *   body: string,
 * }}
 */
export const buildGenericUpdateFailureNotice = (err) => {
  const reason = String(
    /** @type {{ message?: unknown } | null | undefined} */ (err)?.message || err,
  );
  return {
    definitive: false,
    manifestMissing: false,
    showDialog: true,
    openReleasePage: true,
    markPrompted: false,
    stateError: reason,
    reason,
    title: "自动更新失败",
    body: `${reason}\n\n将打开下载页、请手动下载安装。`,
  };
};

/**
 * 清单「形态完整」：非数组对象 + version 为非空字符串 + files 为数组 + signature 为字符串（允许空串，空串会在验签处判 Mismatch）。
 * 只看顶层三个必需字段的类型，不看条目内容——条目是否被改由签名覆盖，条目缺失是 Mismatch(entry-missing)。
 * 顶层的额外字段不拦（壳从不读它们、前向兼容）。
 */
const hasCompleteManifestShape = (manifest) =>
  !!manifest &&
  typeof manifest === "object" &&
  !Array.isArray(manifest) &&
  typeof manifest.version === "string" &&
  manifest.version !== "" &&
  Array.isArray(manifest.files) &&
  typeof manifest.signature === "string";

/**
 * 前三道廉价检查：签名 → version → 按 assetName 找条目；通过返回该条目。
 *
 * 单独导出的原因：mac 的 dmg 有 100MB+，main.js 要保持「manifest 有问题就别白算 SHA-256」的
 * 原有顺序（先过这三道、再读盘算哈希），算完再交给 verifyManifestEntry 做最终裁决。
 */
export const findSignedManifestEntry = ({ manifest, publicKeyPem, version, assetName }) => {
  if (!hasCompleteManifestShape(manifest)) {
    // 拿到的东西不像我们产出的清单（强制门户 / 代理 / GitHub 的 JSON 错误体 `{"message":"…"}` 也是 200 + 合法 JSON）：
    // 它证明不了「安装包有问题」，所以只拒绝安装、不能落进验签失败的 Mismatch 分支去删 112MB 缓存包 + 开发布页（F1-04）。
    // 只有形态完整、签名却验不过，才有「被换 / 被改 / 被重放」的证据
    throw new UpdateVerifyUnavailableError("更新 manifest 结构非法、已中止替换", "manifest-invalid");
  }
  // 验签 payload 只覆盖 version + files、跟 scripts/generate-update-manifest.mjs 同序重建
  // （JSON.stringify 的字段顺序即签名内容，换序 = 验签必挂）
  const payload = JSON.stringify({ version: manifest.version, files: manifest.files });
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (err) {
    // 公钥是壳自带的：解析不了是我们这边的问题（打包错 / 文件损坏），不能算「安装包不符」
    throw new UpdateVerifyUnavailableError(
      `更新验签公钥无法解析：${errMessage(err)}、已中止替换`,
      "public-key",
      { cause: err },
    );
  }
  const ok = verify(
    null, // Ed25519 内建 digest
    Buffer.from(payload, "utf8"),
    key,
    Buffer.from(String(manifest.signature ?? ""), "base64"),
  );
  if (!ok) throw new UpdateVerifyMismatchError("更新 manifest 签名校验失败、已中止替换", "signature");
  // 签名通过才信 manifest 里的字段：version 必须等于本次要装的版本，
  // 否则攻击者可以把「旧版本的合法 manifest + 合法安装包」重放成新版本
  if (manifest.version !== version) {
    throw new UpdateVerifyMismatchError(
      `manifest 版本不符（${manifest.version} ≠ ${version}）、已中止替换`,
      "version",
    );
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const entry = files.find((f) => f?.name === assetName);
  if (!entry) {
    throw new UpdateVerifyMismatchError(
      `manifest 里没有 ${assetName} 的摘要、已中止替换`,
      "entry-missing",
    );
  }
  return entry;
};

/**
 * 完整验证：签名 → version → 条目 → size → sha256，任一失败 throw。
 *
 * @param {object} args
 * @param {object} args.manifest      update-manifest.json 解析后的对象 { version, files, signature }
 * @param {string} args.publicKeyPem  壳内置公钥（electron-app/update-manifest-public-key.pem）
 * @param {string} args.version       本次要装的版本号（来自更新通道、不可信，必须与签名里的 version 相等）
 * @param {string} args.assetName     GitHub release 上的真实 asset 名（如 fe-ai-flow-1.2.3-win-x64.exe）
 * @param {number} args.size          本地文件**实测**字节数（stat）
 * @param {string} args.sha256        本地文件**实测** SHA-256（小写 hex）
 */
export const verifyManifestEntry = ({ manifest, publicKeyPem, version, assetName, size, sha256 }) => {
  const entry = findSignedManifestEntry({ manifest, publicKeyPem, version, assetName });
  if (size !== entry.size) {
    throw new UpdateVerifyMismatchError(
      `安装包大小不符（${size} ≠ ${entry.size}）、已中止替换`,
      "size",
    );
  }
  if (sha256 !== entry.sha256) {
    throw new UpdateVerifyMismatchError(
      "安装包 SHA-256 校验失败（内容被篡改 / 传输损坏）、已中止替换",
      "sha256",
    );
  }
};

// 解析 asset 名时的虚拟基址：只用来让 `new URL(相对路径, base)` 与 electron-updater 同口径地解码，
// 不会发起任何请求
const ASSET_URL_BASE = "https://github.com/jianger666/Flowship/releases/download/v0.0.0/";

/**
 * Windows：从 electron-updater 的 `update-downloaded` 事件（= latest.yml 解析结果）里
 * 挑出 GitHub release 上真实的 exe asset 名，用来去 manifest 里找条目。
 *
 * 为什么取自 latest.yml 的 `files[].url`（缺省退到 `path`）、而不是事件里的 `downloadedFile` 本地文件名：
 * - latest.yml 是 electron-builder 按 artifactName 生成的，`url` 就是该 asset 在 release 上的文件名，
 *   electron-updater 也正是用它拼下载地址（GitHubProvider：`<release>/download/<tag>/<url>`）；
 * - `downloadedFile` 是本地缓存路径：上次启动留下的缓存会读 `update-info.json` 里的 fileName、
 *   空格会被换成 `-`，它是「本地状态」而非「release 上的事实」，不该拿来当签名清单的查找键；
 * - 选择规则镜像 electron-updater 的 findFile：只看 `.exe`，同时有多个时优先文件名含当前架构的，
 *   保证这里选中的 = 它实际下载的那个。
 *
 * 取不到返回 null（调用方按拒绝处理）。
 *
 * @param {{ files?: Array<{ url?: string }>, path?: string } | null | undefined} info
 * @param {string} [arch]
 * @returns {string | null}
 */
export const pickWinInstallerAssetName = (info, arch = process.arch) => {
  const urls =
    Array.isArray(info?.files) && info.files.length > 0
      ? info.files.map((f) => f?.url)
      : [info?.path];
  const names = urls
    .map((raw) => {
      if (typeof raw !== "string" || !raw) return null;
      try {
        // 与 electron-updater 同口径：空格换 `-`、按 URL 解析后取 pathname 的 basename（解码）
        const { pathname } = new URL(raw.replace(/ /g, "-"), ASSET_URL_BASE);
        return path.posix.basename(decodeURIComponent(pathname));
      } catch {
        return null;
      }
    })
    .filter((n) => typeof n === "string" && n.toLowerCase().endsWith(".exe"));
  return names.find((n) => n.includes(arch)) ?? names[0] ?? null;
};
