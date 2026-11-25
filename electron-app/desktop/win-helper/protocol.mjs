/**
 * Windows 解锁组件（win-helper）的协议与常量。
 *
 * 同一份约定在两处实现：这里（Flowship 主进程侧）和 assets/FlowshipUnlockHelper.cs（以 SYSTEM 身份运行的组件）。
 * 改任何一处都要同步改另一处——tests/desktop-win-helper-protocol.test.ts 会逐项对账
 * （版本号、键表、动词、结果码、文件路径、资源文件哈希），对不上测试直接红。
 *
 * 线路格式（命名管道，UTF-8，一行一条消息，LF 结尾）：
 *   请求  FS1<TAB>verb[<TAB>key=value]...      value 用百分号编码（encodeURIComponent，对端 Uri.UnescapeDataString）
 *   响应  FS1<TAB>ok|err<TAB>code=XXX[<TAB>key=value]...
 *
 * 本文件不做 IO，只有纯函数和常量；开机密码只出现在 encodeRequest 的入参里，这里没有任何日志。
 */
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * 组件版本：和 C# Const.Version 一致。不一致（装的是旧版）时设置页会提示重新安装。
 * v2：冷却恢复语义（读不了状态文件从修改时间起算、Clear 返回 bool、截止时刻远在未来时夹紧而不是封顶）、保存密码清不掉冷却时回
 * COOLDOWN_NOT_CLEARED（带 saved / wait）、删凭据 / 清冷却不再用 File.Exists 判断「有没有」。装着 v1 的机器必须重装一次。
 * v3：保存密码时冷却记录清不掉、但它已经过期（没有冷却在生效）→ 不再误报 COOLDOWN_NOT_CLEARED，回 OK；装着 v2 的机器要重装一次。
 * v4：凭据「有没有」（Exists / Load / Save）不再用 File.Exists（没权限时它把「看不见」当成「没有」）：直接取属性 / 直接读，只有文件 / 目录不存在才算没有，
 *     其余错误 Exists 按「可能有」回 true、Load 抛出去走「读不出来」分支；装着 v3 的机器要重装一次。
 */
export const HELPER_VERSION = 4;
/** 协议版本：和 C# Const.Proto 一致（v2：新增结果码 COOLDOWN_NOT_CLEARED 与 saved / wait 字段；v3：DoSet 只在冷却确实还在时才回 COOLDOWN_NOT_CLEARED；v4：协议本身没变，随组件版本同步升） */
export const PROTOCOL_VERSION = 4;
export const PROTOCOL_TAG = "FS1";
/** 开机密码最长字符数（和 C# Const.MaxPasswordLength 一致） */
export const MAX_PASSWORD_LENGTH = 127;
/** 解锁失败后组件自己的冷却秒数（和 C# Const.CooldownSeconds 一致；落盘，重启组件也不清零） */
export const COOLDOWN_SECONDS = 600;
/** 请求行最长字节数（和 C# Const.MaxLine 一致） */
export const MAX_LINE_BYTES = 4096;

/** 组件认识的动词（和 C# Service.HandleClient 的 switch 一致） */
export const VERBS = Object.freeze(["ping", "status", "set", "clear", "check", "unlock"]);

/**
 * 锁屏界面能输入的字符表（美式键盘）：字符 → 虚拟键码 + 是否按 Shift。
 * KEY_CHARS / SHIFT_CHARS / KEY_VKS 三者按下标一一对应；C# 里 Keymap 有同样的三张表，测试逐项对账。
 */
export const KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789 ;=,-./`[\\]'";
export const SHIFT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ)!@#$%^&*( :+<_>?~{|}\"";
export const KEY_VKS = Object.freeze([
  0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d,
  0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a,
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x20,
  0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xdb, 0xdc, 0xdd, 0xde,
]);

const TYPEABLE = new Set([...KEY_CHARS, ...SHIFT_CHARS]);

/**
 * 这段开机密码在锁屏界面「打得出来」吗？返回 null = 可以；否则是原因枚举。
 * 逐个 UTF-16 单元检查（和 C# 的 char[] 一致）：中文、emoji、少见符号都不在表里。
 * @param {unknown} password
 * @returns {null | "empty" | "too_long" | "untypeable"}
 */
export const passwordProblem = (password) => {
  if (typeof password !== "string" || password.length === 0) return "empty";
  if (password.length > MAX_PASSWORD_LENGTH) return "too_long";
  for (let i = 0; i < password.length; i++) {
    if (!TYPEABLE.has(password[i])) return "untypeable";
  }
  return null;
};

export const NOT_TYPEABLE_HINT =
  "锁屏界面只认真实键码，自动解锁目前只能输入英文字母、数字和常见符号（中文、emoji、少见符号都不行）";

/** @param {"empty"|"too_long"|"untypeable"} problem */
export const describePasswordProblem = (problem) => {
  if (problem === "empty") return "密码不能为空";
  if (problem === "too_long") return `开机密码太长了（最多 ${MAX_PASSWORD_LENGTH} 个字符）`;
  return `${NOT_TYPEABLE_HINT}。这个开机密码里有输入不了的字符，所以没有保存。可以把开机密码改成只含英文字母、数字和常见符号的，或者只在电脑没锁屏时使用电脑操作`;
};

// ───────────────────────── 线路编解码 ─────────────────────────

/**
 * 编一条请求（含结尾 LF）。fields 的 key 只允许小写字母；value 一律百分号编码（制表符 / 换行也会被编掉，不会破坏分行）。
 * @param {string} verb
 * @param {Record<string, string>} [fields]
 */
export const encodeRequest = (verb, fields = {}) => {
  if (!VERBS.includes(verb)) throw new Error(`未知的组件动词：${verb}`);
  const parts = [PROTOCOL_TAG, verb];
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-z]+$/.test(key)) throw new Error(`非法的字段名：${key}`);
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return `${parts.join("\t")}\n`;
};

/**
 * 解一条响应。格式不对返回 null（调用方当「组件回了不认识的东西」处理）。
 * @param {string} line  可带结尾的 CR / LF
 * @returns {{ ok: boolean, code: string, fields: Record<string, string> } | null}
 */
export const parseResponse = (line) => {
  if (typeof line !== "string") return null;
  const parts = line.replace(/[\r\n]+$/, "").split("\t");
  if (parts.length < 3 || parts[0] !== PROTOCOL_TAG) return null;
  if (parts[1] !== "ok" && parts[1] !== "err") return null;
  /** @type {Record<string, string>} */
  const fields = {};
  for (let i = 2; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq <= 0) return null;
    try {
      fields[parts[i].slice(0, eq)] = decodeURIComponent(parts[i].slice(eq + 1));
    } catch {
      return null;
    }
  }
  const code = fields.code;
  if (typeof code !== "string" || code === "") return null;
  delete fields.code;
  return { ok: parts[1] === "ok", code, fields };
};

/**
 * 解 status 响应里的字段。任何一项读不出来都返回 null（组件版本太旧 / 回了奇怪的东西）。
 * @param {Record<string, string>} fields
 * @returns {{ proto: number, ver: number, hasCredential: boolean, cooldownSeconds: number, consoleSession: number, clientSession: number } | null}
 */
export const parseStatusFields = (fields) => {
  const int = (v) => (typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : null);
  const proto = int(fields.proto);
  const ver = int(fields.ver);
  const cool = int(fields.cool);
  const consoleSession = int(fields.console);
  const clientSession = int(fields.client);
  if (proto === null || ver === null || cool === null || consoleSession === null || clientSession === null) return null;
  if (fields.has !== "0" && fields.has !== "1") return null;
  return { proto, ver, hasCredential: fields.has === "1", cooldownSeconds: cool, consoleSession, clientSession };
};

// ───────────────────────── 结果码 ─────────────────────────

/**
 * 组件可能回的所有结果码和对应的中文说明（给用户和 AI 看）。
 * 对账：C# 里每一个 Respond(...) 用到的码都必须在这里；这里每一个码也必须在 C# 里出现过（不留死文案）。
 */
export const RESPONSE_CODES = Object.freeze({
  PONG: "组件在运行",
  OK: "成功",
  UNLOCKED: "已解锁",
  BAD_REQUEST: "解锁组件没看懂 Flowship 发来的请求（两边版本可能不一致），请到设置的「电脑操作」里重新安装解锁组件",
  DENIED: "解锁组件只接受安装时登记的那个 Windows 账户，而现在登录的不是它。请换回安装组件时的账户，或到设置里卸载后用当前账户重新安装",
  INTERNAL: "解锁组件内部出错了。它的日志在 C:\\ProgramData\\Flowship\\unlock\\public\\helper.log（里面没有开机密码），可以发给开发者排查",
  NOT_TYPEABLE: `${NOT_TYPEABLE_HINT}。保存的开机密码里有输入不了的字符，请换成可输入的密码重新保存`,
  STORE_FAILED: "解锁组件没能保存或删除开机密码（磁盘权限问题？）。可以重新安装解锁组件后再试",
  NO_CREDENTIAL: "还没有保存开机密码，请到设置的「电脑操作」里保存",
  CRED_UNREADABLE: "解锁组件读不出已保存的开机密码（可能换过电脑或重装过系统），请到设置里重新保存",
  NO_CONSOLE_SESSION: "找不到本机屏幕前的登录会话（电脑可能正在注销或切换用户）",
  NOT_CONSOLE_CLIENT: "Flowship 不在本机屏幕前的桌面会话里（比如正通过远程桌面使用），解锁组件只能解锁本机屏幕前的锁屏界面",
  COOLDOWN: "刚刚自动解锁失败过，为避免连续输错密码导致账户被锁定，解锁组件暂停了自动解锁；重新保存开机密码可立即恢复",
  COOLDOWN_NOT_CLEARED:
    "开机密码已经保存好了，但上一次自动解锁失败留下的冷却记录没能清掉（解锁组件改不动它的状态文件，可能被安全软件占着）：冷却结束之前仍不会自动解锁",
  LAUNCH_FAILED: "解锁组件没能在登录界面上启动输入程序（需要重新安装，或被安全软件拦住了）",
  TIMEOUT: "解锁组件等了太久也没等到结果，不知道密码有没有输进去，为安全起见已进入冷却",
  NOT_LOCKED: "电脑当前并不是锁屏状态",
  SECURE_DESKTOP:
    "屏幕上现在是 Windows 的系统安全提示（比如 UAC 权限确认），不是锁屏；解锁组件没有往里输入任何东西（把开机密码连同回车打进去，可能被当成「同意」），这种提示只能由用户本人处理",
  DESKTOP_ERROR: "解锁组件读不到当前的屏幕状态，为安全起见没有输入任何东西",
  INPUT_FAILED: "解锁组件往锁屏界面输入时失败了",
  STILL_LOCKED:
    "提交密码后电脑仍然是锁屏状态：可能是保存的开机密码不对；或者锁屏界面默认的登录方式是 PIN / 指纹 / 人脸（微软账号开启了「仅允许 Windows Hello 登录」时，登录界面根本没有密码入口）；也可能是界面没有接收输入",
});

/**
 * 结果码 → 中文说明；不认识的码返回 undefined。
 * resp.code 是管道对端发来的字符串：只认 RESPONSE_CODES 自己的键，"constructor" / "toString" 这类原型链上的名字不算命中
 * （直接 RESPONSE_CODES[code] 会取到一个函数，当文案往下传）。
 * @param {string} code
 * @returns {string | undefined}
 */
export const responseText = (code) => (Object.prototype.hasOwnProperty.call(RESPONSE_CODES, code) ? RESPONSE_CODES[code] : undefined);

/**
 * 组件的失败码 → 解锁器契约里的 code（不在表里的一律 UNLOCK_FAILED）：
 * - NOT_LOCKED：唤醒后发现输入桌面已经是 Default = 用户很可能刚好自己解开了，和 macOS 的「USER_PRESENT」同一个语义，session 按「用户接管」处理；
 * - SECURE_DESKTOP：输入桌面是 UAC 之类的系统安全桌面（会话没锁），组件拒绝输入，session 按 SECURE_DESKTOP 交还用户。
 * 用 Map：resp.code 是外部来的字符串，普通对象会把 "constructor" 之类的名字当成命中。
 */
const UNLOCK_FAILURE_CODES = new Map([
  ["NOT_LOCKED", "USER_PRESENT"],
  ["SECURE_DESKTOP", "SECURE_DESKTOP"],
]);

/**
 * 把 unlock 响应翻译成解锁器契约要的 { ok, code, error, attempted }。
 * attempted：组件有没有真的把密码输进去过（响应里的 attempted 字段；缺省按「试过」处理——宁可进冷却也不多输一次）。
 * @param {{ ok: boolean, code: string, fields: Record<string, string> }} resp
 * @returns {{ ok: boolean, code?: string, error?: string, attempted: boolean }}
 */
export const unlockResultFromResponse = (resp) => {
  const attempted = resp.fields.attempted !== "0";
  if (resp.ok && resp.code === "UNLOCKED") return { ok: true, attempted: true };
  if (resp.ok) return { ok: false, code: "UNLOCK_FAILED", error: `解锁组件回了意料之外的成功码：${resp.code.slice(0, 40)}`, attempted };
  let error = responseText(resp.code) ?? `解锁组件返回了不认识的结果码 ${resp.code.slice(0, 40)}`;
  if (resp.code === "COOLDOWN") {
    const wait = Number(resp.fields.wait);
    if (Number.isFinite(wait) && wait > 0) {
      error = `刚刚自动解锁失败过，为避免连续输错密码导致账户被锁定，解锁组件暂停了自动解锁，约 ${Math.max(1, Math.ceil(wait / 60))} 分钟后恢复；重新保存开机密码可立即恢复`;
    }
  }
  if (resp.code === "LAUNCH_FAILED" && resp.fields.detail) error = `${error}（${resp.fields.detail.slice(0, 120)}）`;
  if (resp.code === "INTERNAL" && resp.fields.detail) error = `${error}（${resp.fields.detail.slice(0, 120)}）`;
  const code = UNLOCK_FAILURE_CODES.get(resp.code) ?? "UNLOCK_FAILED";
  return { ok: false, code, error, attempted };
};

/**
 * set（保存开机密码）失败时给用户看的文案。
 * COOLDOWN_NOT_CLEARED 是「密码已经存好，只是上一次失败留下的冷却记录没清掉」：响应里带 wait（还剩几秒）时给出分钟数，
 * 让用户知道不是密码没存上、也不是永远解不了——等冷却结束（或排除占用状态文件的原因后再点一次保存）就行。
 * @param {{ code: string, fields: Record<string, string> }} resp
 * @param {string} fallback 码不认识时的兜底文案
 * @returns {string}
 */
export const describeSetFailure = (resp, fallback) => {
  const base = responseText(resp.code) ?? fallback;
  if (resp.code === "COOLDOWN_NOT_CLEARED") {
    const wait = Number(resp.fields.wait);
    if (Number.isFinite(wait) && wait > 0) return `${base}，约 ${Math.max(1, Math.ceil(wait / 60))} 分钟后恢复；也可以稍后再点一次「保存」`;
  }
  return base;
};

// ───────────────────────── 安装位置与资源 ─────────────────────────

export const EXE_NAME = "FlowshipUnlockHelper.exe";
/** 计划任务所在的文件夹和名字（以 SYSTEM 开机启动 service） */
export const TASK_FOLDER = "\\Flowship\\";
export const TASK_NAME = "Flowship Unlock Helper";

/**
 * 组件在磁盘上的位置（和 C# Paths 及 install.ps1 一致）：
 * - 程序放 Program Files（普通用户不可写：放在用户可写的目录等于给了提权入口）；
 * - 数据放 ProgramData\Flowship\unlock（加密后的开机密码等，只有 SYSTEM / 管理员能读），其中 public 子目录普通用户可读（管道名、日志）。
 * @param {Record<string, string | undefined>} [env]
 */
export const helperPaths = (env = process.env) => {
  const w = path.win32;
  const programData = env.ProgramData || env.ALLUSERSPROFILE || "C:\\ProgramData";
  const programFiles = env.ProgramW6432 || env.ProgramFiles || "C:\\Program Files";
  const dataDir = w.join(programData, "Flowship", "unlock");
  const pubDir = w.join(dataDir, "public");
  const installDir = w.join(programFiles, "Flowship", "unlock");
  return {
    dataDir,
    pubDir,
    pipeFile: w.join(pubDir, "pipe.txt"),
    helperLog: w.join(pubDir, "helper.log"),
    installLog: w.join(pubDir, "install.log"),
    installDir,
    exe: w.join(installDir, EXE_NAME),
  };
};

/** 随安装包带的资源文件（resources/win-helper/ 下；开发时在 electron-app/desktop/win-helper/assets/） */
export const ASSET_FILES = Object.freeze({
  source: "FlowshipUnlockHelper.cs",
  install: "install.ps1",
  uninstall: "uninstall.ps1",
});

/**
 * 安装 / 卸载（以管理员身份运行的 PowerShell）的退出码。拿不到它们的输出（提权进程没法重定向），只能靠退出码 + install.log 说话。
 * 对账：install.ps1 / uninstall.ps1 里每个 `Fail N` 的 N 必须在这里；这里除了「外层 / 引导」那几个，每个码也必须在脚本里出现过。
 */
export const ADMIN_EXIT = Object.freeze({
  OK: 0,
  // 外层 / 引导（installer.mjs 生成的那段 PowerShell）
  UAC_CANCELLED: 1223,
  OUTER_FAILED: 80,
  BOOTSTRAP_HASH: 90,
  // install.ps1
  SOURCE_UNREADABLE: 10,
  SOURCE_HASH: 11,
  DIR_CLEANUP_FAILED: 12,
  DIR_ACL_FAILED: 13,
  COMPILE_FAILED: 14,
  SELFTEST_FAILED: 15,
  TASK_FAILED: 16,
  SERVICE_NOT_READY: 17,
  OLD_NOT_STOPPED: 18,
  INSTALL_UNEXPECTED: 19,
  // uninstall.ps1
  REMOVE_TASK_FAILED: 31,
  REMOVE_DIR_FAILED: 32,
  // 两个脚本共用
  NOT_ADMIN: 91,
  BAD_ARGUMENT: 92,
  LANGUAGE_MODE: 93,
});

/** 由外层 / 引导产生、不在 .ps1 脚本里出现的退出码 */
export const BOOTSTRAP_ONLY_EXITS = Object.freeze([ADMIN_EXIT.OK, ADMIN_EXIT.UAC_CANCELLED, ADMIN_EXIT.OUTER_FAILED, ADMIN_EXIT.BOOTSTRAP_HASH]);

const ADMIN_EXIT_MESSAGES = Object.freeze({
  [ADMIN_EXIT.UAC_CANCELLED]: "你在系统的管理员授权框里选了「否」（或把它关掉了），所以没有执行。需要时再点一次，在授权框里选「是」",
  [ADMIN_EXIT.OUTER_FAILED]: "没能拉起系统的管理员授权框（PowerShell 无法启动提权进程）",
  [ADMIN_EXIT.BOOTSTRAP_HASH]: "安装包里的脚本文件和期望的内容对不上（可能被改动或损坏），为安全起见没有运行。请重新安装 Flowship",
  [ADMIN_EXIT.SOURCE_UNREADABLE]: "安装包里缺少解锁组件的源码文件，请重新安装 Flowship",
  [ADMIN_EXIT.SOURCE_HASH]: "解锁组件的源码文件和期望的内容对不上（可能被改动或损坏），为安全起见没有安装。请重新安装 Flowship",
  [ADMIN_EXIT.DIR_CLEANUP_FAILED]: "电脑上已有的解锁组件目录不可信，而且自动清理没成功。请以管理员身份手动删除 C:\\ProgramData\\Flowship 后再试",
  [ADMIN_EXIT.DIR_ACL_FAILED]: "没能给解锁组件的目录设置访问权限",
  [ADMIN_EXIT.COMPILE_FAILED]: "编译解锁组件失败（系统自带的 C# 编译器不可用，或被安全软件拦住了）",
  [ADMIN_EXIT.SELFTEST_FAILED]:
    "解锁组件编译完成后自检没有通过（可能被安全软件拦住了；也可能是这台电脑读不出「当前是否锁屏」，那样即使装上也无法安全解锁。详情见 C:\\ProgramData\\Flowship\\unlock\\public\\helper.log 里的 selftest 记录）",
  [ADMIN_EXIT.TASK_FAILED]: "没能创建让解锁组件开机启动的计划任务",
  [ADMIN_EXIT.SERVICE_NOT_READY]: "解锁组件装好了，但启动后一直没有就绪",
  [ADMIN_EXIT.OLD_NOT_STOPPED]: "旧版解锁组件没能停下来，无法升级。重启电脑后再试一次",
  [ADMIN_EXIT.INSTALL_UNEXPECTED]: "安装解锁组件时出现了意料之外的错误",
  [ADMIN_EXIT.REMOVE_TASK_FAILED]: "没能删除解锁组件的计划任务",
  [ADMIN_EXIT.REMOVE_DIR_FAILED]: "没能删干净解锁组件的文件（可能被占用），重启电脑后再试一次",
  [ADMIN_EXIT.NOT_ADMIN]: "没有拿到管理员权限",
  [ADMIN_EXIT.BAD_ARGUMENT]: "安装参数不合法（要登记的 Windows 账户不是普通用户账户？）",
  [ADMIN_EXIT.LANGUAGE_MODE]: "这台电脑的策略把 PowerShell 限制成了受限模式（常见于公司电脑），没法安装解锁组件",
});

/**
 * 管理员脚本退出码 → 给用户看的话。
 * @param {number | null} code  null = 进程被信号结束 / 没拿到退出码
 */
export const describeAdminExit = (code) => {
  if (code === null || code === undefined) return "管理员脚本被意外中断了，没有拿到结果";
  return ADMIN_EXIT_MESSAGES[code] ?? `管理员脚本以意料之外的退出码 ${code} 结束`;
};

/**
 * 资源文件按「换行统一成 LF 的 UTF-8 字节」算 SHA-256：git 在 Windows 上可能把 LF 换成 CRLF，不能让哈希跟着换行变。
 * install.ps1 / uninstall.ps1 的引导程序做同样的规范化。
 * @param {Buffer} bytes
 */
export const normalizeAssetBytes = (bytes) => {
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return Buffer.from(text, "utf8");
};

/** @param {Buffer} bytes */
export const assetSha256 = (bytes) => createHash("sha256").update(normalizeAssetBytes(bytes)).digest("hex").toUpperCase();

/**
 * 三个资源文件的期望哈希：以管理员身份运行它们之前，引导程序会先对一遍（对不上就不运行）。
 * 不要手改：改了 .cs / .ps1 之后运行 `node scripts/win-helper-hashes.mjs` 自动写回；单测会拦住忘记更新的情况。
 */
// <asset-hashes:begin>
export const HELPER_ASSET_SHA256 = Object.freeze({
  "FlowshipUnlockHelper.cs": "31CE2321F732D34D00D7BDF8FA769BCAA14F3DC85B2B5BB7DED7A7AEBB738EA2",
  "install.ps1": "01671B9396976845273A47465E460244077075A9F8B175B558DFB8B5F06377AD",
  "uninstall.ps1": "2C8222B563128242E894C0F30A620A15FAE5B81BF5E5A3260C3C5E4AF575AF7E",
});
// <asset-hashes:end>
