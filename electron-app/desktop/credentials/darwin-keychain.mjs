/**
 * macOS 凭据存储：开机密码放进 Flowship 自己的一个「专用钥匙串文件」，不放登录钥匙串。
 * （koffi → Security.framework 的 legacy 钥匙串 API）
 *
 * 为什么不放登录钥匙串（macOS 27.2 实测，只用假密码的临时条目）：
 * - 登录钥匙串里的条目除了「哪些程序读得了」（按程序签名的指定要求：身份 + 证书，同一张证书重新打包不变），
 *   还带一份「分区列表」。我们用的是自签证书（没有开发者团队号），列表里写的是创建者那一版的代码哈希（cdhash:…）。
 *   每次升级 / 重新打包代码哈希都会变，新版读不出旧版存的条目（-25293）——用户每升级一次就得重新输入开机密码。
 *   改这份列表要用登录钥匙串的口令，而我们没有它（开机密码正是要存的东西）。
 * - 自己建的钥匙串文件没有这一层：条目只认「创建它的程序的签名要求」。
 *   同一张证书、同一个 bundle id 签出来的任何一版都读得出（升级 / 重新打包不用重存）；
 *   别的签名身份读不出（实测都是 -25293）：同一张证书但 bundle id 不同的 App、换了证书的程序、ad-hoc 签名的程序。
 *   删除不受这个限制（和登录钥匙串一样），所以「保存」仍然做「删掉重建」，让条目绑给现在这一版的签名身份。
 * - 顺带的好处：锁屏 / 睡眠之后登录钥匙串可能也被锁住，放在里面的密码恰好在最需要自动解锁的时候读不出来；
 *   专用钥匙串每次都用自己的口令解锁，不依赖登录钥匙串当时的状态。
 *
 * 为什么不用 `security` 命令行 / Electron safeStorage：
 * - `security` 命令行建 / 读做不到「只有 Flowship 能读」；
 * - 正式包给 Chromium 开了 use-mock-keychain，safeStorage 的密钥是固定值，等于明文。
 *
 * 诚实的边界（别在界面 / 文档里说得比这更满）：
 * - 专用钥匙串要能无人值守地解锁，口令就不可能是用户输入的——这里用「本机硬件标识」派生，**不是秘密**。
 *   真正的防线是条目的访问控制（读它要有 Flowship 的签名身份），不是文件加密：
 *   拿到这个文件却不在这台电脑上的人（备份 / 同步 / 误发出去的数据目录）打不开它；
 *   这台电脑上的其它程序走系统接口读，会被拒（或弹授权框）；但能以 Flowship 的身份运行代码的程序，
 *   或者自己解析文件又知道口令派生方式的程序，读得到。
 *   和登录钥匙串相比，这是拿「离线解析要登录密码」换「升级不用重存、锁屏时读得出」：对同一账户下存心去解析文件的恶意程序，防护更弱一档。
 * - 只有用固定证书签名的包，「升级不用重存」才成立；ad-hoc 签名（没有证书时的退路）每个版本身份都不同，照旧要重存。
 *
 * 安全约定：
 * - 密码只出现在 set() 的入参和 get() 的返回值里；本模块不打印、不记录、不放进错误信息。has() 只确认「读得出来」，不把密码取进 JS。
 *   set() 里原生层抛的异常文字（写日志之前）和返回给调用方的错误文字，再过一遍 redactSecret 把整串密码抹掉——
 *   现有错误本来就不带密码，这是防将来有人把入参回显进错误里（单测用「把密码回显进异常」的假原生层逼着它成立）。
 * - 读 / 写期间临时关闭钥匙串的 UI 交互（SecKeychainSetUserInteractionAllowed(false)），结束后恢复原值：
 *   这样 ACL 不匹配（例如签名证书变了）时直接返回错误，而不是弹窗把主进程同步阻塞住。
 * - get() 用到的原生缓冲区读完立即清零 / 释放；返回的 JS 字符串无法清零，调用方用完就丢引用。
 *
 * 注意：这里的 get() 是同步 FFI，只能在主进程里被 unlocker 调用；绝不能通过 IPC / 事件把结果传出去。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { redactSecret } from "../redact-secret.mjs";

const requireFromHere = createRequire(import.meta.url);

const SECURITY_PATH = "/System/Library/Frameworks/Security.framework/Security";
const CF_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

const ERR_NOT_FOUND = -25300;
const ERR_AUTH_FAILED = -25293;
const ERR_INVALID_KEYCHAIN = -25295;
const ERR_NO_KEYCHAIN = -25294;
const ERR_NO_DEFAULT_KEYCHAIN = -25307;
const ERR_INTERACTION_NOT_ALLOWED = -25308;
const ERR_USER_CANCELED = -128;

const MAX_SECRET_BYTES = 256;

/** 专用钥匙串口令的派生串（改了它 = 所有已存的密码都打不开，别改） */
const PASSPHRASE_SALT = "flowship.computer-use.keychain.v1";

/** 本机硬件标识（IOPlatformUUID，系统给的写法就是大写，原样用）。读不到就抛错 */
const readHardwareUuid = () => {
  const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const m = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(out);
  if (!m) throw new Error("读不到本机硬件标识");
  return m[1];
};

/** 钥匙串错误码 → 能照着做的中文 */
const describeStatus = (status) => {
  switch (status) {
    case ERR_INTERACTION_NOT_ALLOWED:
      return "钥匙串需要你本人授权才能读取（常见原因：Flowship 的签名变了）。请到设置的「电脑操作」里重新保存开机密码";
    case ERR_AUTH_FAILED:
      return "钥匙串认证失败";
    case ERR_USER_CANCELED:
      return "钥匙串授权被取消";
    case ERR_NO_KEYCHAIN:
    case ERR_NO_DEFAULT_KEYCHAIN:
    case ERR_INVALID_KEYCHAIN:
      return "找不到 Flowship 保存开机密码用的钥匙串（文件不存在或已损坏）";
    default:
      return `钥匙串返回了错误（代码 ${status}）`;
  }
};

/**
 * 读取失败的提示。实测（macOS 27.2）：条目是「别的签名身份」存的，当前这一版读它得到 -25293（认证失败）。
 * 同一张证书签的新版读得出旧版存的条目，所以走到这里一般意味着换过签名证书、或这一版没有用固定证书签名——重新保存一次即可。
 */
const describeReadFailure = (status) =>
  status === ERR_AUTH_FAILED || status === ERR_INTERACTION_NOT_ALLOWED
    ? "钥匙串不让这一版 Flowship 读取之前保存的开机密码（保存它的那一版和现在这一版的签名身份不一样，比如换了签名证书）。请到设置的「电脑操作」里重新保存一次开机密码"
    : describeStatus(status);

const KEYCHAIN_UNUSABLE =
  "保存开机密码用的钥匙串打不开（文件损坏，或者数据是从别的电脑带过来的）。请到设置的「电脑操作」里重新保存一次开机密码";

/**
 * @param {{
 *   service: string,
 *   account: string,
 *   path: string,                 专用钥匙串文件的位置（放在 userData 下自己的文件夹里；文件夹不存在会建）
 *   koffi?: any,
 *   platform?: string,
 *   log?: (msg: string) => void,
 *   fs?: Pick<typeof nodeFs, "existsSync" | "mkdirSync" | "chmodSync" | "rmSync">,
 *   machineId?: () => string,     本机硬件标识（单测注入；缺省读 IOPlatformUUID）
 * }} deps
 */
export const createDarwinKeychain = (deps) => {
  const { service, account, path: keychainPath, platform = process.platform, log = () => {}, fs: fsx = nodeFs, machineId = readHardwareUuid } = deps;
  const serviceLen = Buffer.byteLength(service, "utf8");
  const accountLen = Buffer.byteLength(account, "utf8");

  /** @type {null | { koffi: any, create: Function, open: Function, unlock: Function, removeKeychain: Function, add: Function, find: Function, findItem: Function, del: Function, freeContent: Function, setInteract: Function, getInteract: Function, release: Function }} */
  let api = null;
  let initError = null;

  const init = () => {
    if (api || initError) return;
    if (platform !== "darwin") {
      initError = "仅 macOS 可用";
      return;
    }
    if (typeof keychainPath !== "string" || keychainPath === "") {
      initError = "没有指定保存开机密码的钥匙串位置";
      return;
    }
    try {
      const koffi = deps.koffi ?? requireFromHere("koffi");
      const sec = koffi.load(SECURITY_PATH);
      const cf = koffi.load(CF_PATH);
      api = {
        koffi,
        // 专用钥匙串文件：建 / 开 / 解锁 / 删（口令不弹窗：promptUser=false、usePassword=true）
        create: sec.func("int SecKeychainCreate(const char *path, uint32 pl, const void *pw, bool promptUser, void *initialAccess, _Out_ void **keychain)"),
        open: sec.func("int SecKeychainOpen(const char *path, _Out_ void **keychain)"),
        unlock: sec.func("int SecKeychainUnlock(void *keychain, uint32 pl, const void *pw, bool usePassword)"),
        removeKeychain: sec.func("int SecKeychainDelete(void *keychain)"),
        add: sec.func("int SecKeychainAddGenericPassword(void *keychain, uint32 sl, const char *service, uint32 al, const char *account, uint32 pl, const void *pw, _Out_ void **itemRef)"),
        // 读密码：长度 / 数据 / 条目引用都是输出参数
        find: sec.func("int SecKeychainFindGenericPassword(void *keychainOrArray, uint32 sl, const char *service, uint32 al, const char *account, _Out_ uint32 *pl, _Out_ void **pw, _Out_ void **itemRef)"),
        // 只取条目引用（不取密码数据，不触发 ACL 的「读数据」授权）
        findItem: sec.func("int SecKeychainFindGenericPassword(void *keychainOrArray, uint32 sl, const char *service, uint32 al, const char *account, uint32 *pl, void **pw, _Out_ void **itemRef)"),
        del: sec.func("int SecKeychainItemDelete(void *itemRef)"),
        freeContent: sec.func("int SecKeychainItemFreeContent(void *attrList, void *data)"),
        setInteract: sec.func("int SecKeychainSetUserInteractionAllowed(bool state)"),
        getInteract: sec.func("int SecKeychainGetUserInteractionAllowed(_Out_ bool *state)"),
        release: cf.func("void CFRelease(void *cf)"),
      };
    } catch (err) {
      initError = `钥匙串组件加载失败：${err?.message || err}`;
      log(`[desktop-keychain] ${initError}`);
    }
  };

  /** 临时关掉钥匙串的 UI 交互（进程级全局状态，用完恢复原值） */
  const withoutInteraction = (body) => {
    const prev = [true];
    const hadPrev = api.getInteract(prev) === 0;
    api.setInteract(false);
    try {
      return body();
    } finally {
      if (hadPrev) api.setInteract(prev[0]);
    }
  };

  const available = () => {
    init();
    return api !== null;
  };

  const unavailableReason = () => {
    init();
    return api ? null : initError;
  };

  /**
   * 专用钥匙串的口令（本机硬件标识派生；不是秘密，见文件头）。
   * @returns {{ value: string } | { error: string }}
   */
  let passphraseCache = null;
  const passphrase = () => {
    if (passphraseCache === null) {
      let id;
      try {
        id = machineId();
      } catch {
        id = null;
      }
      if (typeof id !== "string" || id === "") return { error: "读不到本机硬件标识，没法打开保存开机密码用的钥匙串" };
      passphraseCache = createHash("sha256").update(`${PASSPHRASE_SALT}\n${id}`).digest("hex");
    }
    return { value: passphraseCache };
  };

  /** 解锁失败的日志只在状态变化时记一次：设置页会反复查状态，数据拷到别的电脑后每次都失败，不能每次都刷一行 */
  let lastUnlockFailure = null;

  /**
   * 打开专用钥匙串并解锁（已解锁也行）。
   * - 文件不存在：create=false → { missing }；create=true → 建一个（文件 0600、文件夹 0700）
   * - 打不开 / 口令不对（文件损坏、别的电脑带来的）→ { unusable }，调用方决定是删掉重建还是报错
   * 返回的 kc 用完必须 release。
   * @returns {{ kc: any } | { missing: true } | { unusable: true } | { error: string }}
   */
  const openKeychain = ({ create }) => {
    let exists;
    try {
      exists = fsx.existsSync(keychainPath);
    } catch (err) {
      return { error: `读不了保存开机密码用的钥匙串文件：${err?.message || err}` };
    }
    if (!exists && !create) return { missing: true };
    const pass = passphrase();
    if ("error" in pass) return { error: pass.error };
    const bytes = Buffer.from(pass.value, "utf8");
    try {
      const out = [null];
      if (!exists) {
        try {
          const dir = path.dirname(keychainPath);
          fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fsx.chmodSync(dir, 0o700);
        } catch (err) {
          return { error: `没能创建保存开机密码的文件夹：${err?.message || err}` };
        }
        const st = api.create(keychainPath, bytes.length, bytes, false, null, out);
        if (st !== 0 || !out[0]) return { error: describeStatus(st) };
        try {
          fsx.chmodSync(keychainPath, 0o600);
        } catch {
          /* 权限没收紧不影响使用：里面的内容有口令加密 + 条目访问控制 */
        }
        return { kc: out[0] };
      }
      const opened = api.open(keychainPath, out);
      if (opened !== 0 || !out[0]) return { unusable: true };
      const st = api.unlock(out[0], bytes.length, bytes, true);
      if (st !== 0) {
        api.release(out[0]);
        if (st !== lastUnlockFailure) log(`[desktop-keychain] 专用钥匙串解锁失败（代码 ${st}）`);
        lastUnlockFailure = st;
        return { unusable: true };
      }
      lastUnlockFailure = null;
      return { kc: out[0] };
    } finally {
      bytes.fill(0);
    }
  };

  /** 把专用钥匙串文件整个删掉（打不开的残骸 / 清除时不留空壳）。返回文件是否已不存在 */
  const deleteKeychainFile = () => {
    const ref = [null];
    try {
      if (api.open(keychainPath, ref) === 0 && ref[0]) api.removeKeychain(ref[0]);
    } catch (err) {
      log(`[desktop-keychain] 删除钥匙串出错：${err?.message || err}`);
    } finally {
      if (ref[0]) api.release(ref[0]);
    }
    try {
      if (fsx.existsSync(keychainPath)) fsx.rmSync(keychainPath, { force: true });
      return !fsx.existsSync(keychainPath);
    } catch (err) {
      log(`[desktop-keychain] 删除钥匙串文件出错：${err?.message || err}`);
      return false;
    }
  };

  /**
   * 清掉旧存法（开机密码放在登录钥匙串里）留下的同名条目：那种存法每次升级都读不出来，留着只会多一份没人用的密码副本。
   * 尽力而为，失败不影响调用方；等旧存法的条目不可能再出现了，这段可以整个删掉。
   */
  const removeLegacyLoginItem = () => {
    const item = [null];
    try {
      const st = api.findItem(null, serviceLen, service, accountLen, account, null, null, item);
      if (st === 0 && item[0]) api.del(item[0]);
    } catch (err) {
      log(`[desktop-keychain] 清理旧条目出错：${err?.message || err}`);
    } finally {
      if (item[0]) api.release(item[0]);
    }
  };

  /**
   * 「已保存」要指「这一版读得出来」：真读一次但不把密码取进 JS，原生缓冲立刻释放。
   * 文件都不存在时直接 false，连钥匙串组件都不加载（没开过这个功能的人完全不碰钥匙串）。
   */
  let lastHasStatus = null;
  const has = () => {
    try {
      if (!fsx.existsSync(keychainPath ?? "")) return false;
    } catch {
      return false;
    }
    init();
    if (!api) return false;
    try {
      return withoutInteraction(() => {
        const opened = openKeychain({ create: false });
        if (!opened.kc) return false;
        try {
          const len = [0];
          const data = [null];
          const item = [null];
          const st = api.find(opened.kc, serviceLen, service, accountLen, account, len, data, item);
          if (st === 0 && data[0]) api.freeContent(null, data[0]);
          if (item[0]) api.release(item[0]);
          if (st !== 0 && st !== ERR_NOT_FOUND && st !== lastHasStatus) log(`[desktop-keychain] 已保存的开机密码这一版读不出（代码 ${st}）`);
          lastHasStatus = st;
          return st === 0;
        } finally {
          api.release(opened.kc);
        }
      });
    } catch (err) {
      log(`[desktop-keychain] 查询出错：${err?.message || err}`);
      return false;
    }
  };

  /**
   * 在已打开的专用钥匙串里「删掉旧条目、新建」。
   * 为什么不原地更新：条目的访问权限在创建时绑给「当时那一版的签名身份」，原地改只改内容、不换这个绑定。
   * 实测（macOS 27.2，临时条目、假密码）：换了签名身份后原地改返回「成功」，但新身份照样读不出来。
   * 删了重建（删除不受那个绑定限制），新条目就绑给现在这个签名身份——这样「重新保存一次」才是可靠的一步修复。
   * @returns {{ ok: true } | { ok: false, error: string } | { stuck: true, status: number }}  stuck = 旧条目删不掉
   */
  const replaceItem = (kc, bytes) => {
    const item = [null];
    const found = api.findItem(kc, serviceLen, service, accountLen, account, null, null, item);
    let replaced = false;
    if (found === 0) {
      const deleted = api.del(item[0]);
      api.release(item[0]);
      if (deleted !== 0) return { stuck: true, status: deleted };
      replaced = true;
    } else {
      if (item[0]) api.release(item[0]);
      if (found !== ERR_NOT_FOUND) return { ok: false, error: describeStatus(found) };
    }
    const created = [null];
    const st = api.add(kc, serviceLen, service, accountLen, account, bytes.length, bytes, created);
    if (created[0]) api.release(created[0]);
    if (st === 0) return { ok: true };
    return { ok: false, error: replaced ? `${describeStatus(st)}（钥匙串里旧的开机密码已经清掉了，请再保存一次）` : describeStatus(st) };
  };

  /**
   * 保存（已有则删掉重建）。
   * 专用钥匙串里只有这一条，所以「打不开」「旧条目删不掉」这类异常一律整个删掉重建，不让用户卡在「保存不了、清除不了」。
   * @param {string} password
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  const setUnscrubbed = (password) => {
    init();
    if (!api) return { ok: false, error: initError ?? "钥匙串不可用" };
    if (typeof password !== "string" || password.length === 0) return { ok: false, error: "密码不能为空" };
    const bytes = Buffer.from(password, "utf8");
    try {
      if (bytes.length > MAX_SECRET_BYTES) return { ok: false, error: `密码太长了（最多 ${MAX_SECRET_BYTES} 字节）` };
      return withoutInteraction(() => {
        const stuckAdvice = `请退出 Flowship，把「${path.dirname(keychainPath)}」文件夹删掉后重新打开，再保存一次`;
        let opened = openKeychain({ create: true });
        if (opened.unusable) {
          // 整个删掉，再 openKeychain({ create: true }) 会新建
          if (!deleteKeychainFile()) return { ok: false, error: `保存开机密码用的钥匙串打不开，旧文件也没能删掉。${stuckAdvice}` };
          opened = openKeychain({ create: true });
        }
        if (!opened.kc) return { ok: false, error: opened.error ?? KEYCHAIN_UNUSABLE };
        let result;
        try {
          result = replaceItem(opened.kc, bytes);
        } finally {
          api.release(opened.kc);
        }
        if ("stuck" in result && deleteKeychainFile()) {
          // 旧条目动不了：专用钥匙串里只有这一条，整个删掉重建
          const again = openKeychain({ create: true });
          if (!again.kc) return { ok: false, error: again.error ?? KEYCHAIN_UNUSABLE };
          try {
            result = replaceItem(again.kc, bytes);
          } finally {
            api.release(again.kc);
          }
        }
        if ("stuck" in result) return { ok: false, error: `没能替换保存开机密码用的钥匙串里的旧条目（${describeStatus(result.status)}）。${stuckAdvice}` };
        if (result.ok) removeLegacyLoginItem();
        return result;
      });
    } catch (err) {
      // 原生层的异常文字可能回显了入参（koffi 的参数类型报错之类）：写日志前把整串密码抹掉
      log(`[desktop-keychain] 保存出错：${redactSecret(err?.message || err, password)}`);
      return { ok: false, error: "保存到钥匙串时出错" };
    } finally {
      bytes.fill(0);
    }
  };

  /**
   * 保存的对外入口：密码在手上的最后一层，返回给调用方的错误文字也过一遍抹密码
   * （现有错误都是我们写的中文 / 系统错误码 / 路径，不带密码；这是防将来有人把入参回显进错误里）。
   * @param {string} password
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  const set = (password) => {
    const r = setUnscrubbed(password);
    return r.ok === true || typeof r.error !== "string" ? r : { ok: false, error: redactSecret(r.error, password) };
  };

  /**
   * 读取。没保存返回 null；读不了（ACL 不匹配 / 钥匙串异常）抛带中文提示的错误。
   * 只给主进程内部的 unlocker 用。
   * @returns {string | null}
   */
  const get = () => {
    init();
    if (!api) throw new Error(initError ?? "钥匙串不可用");
    return withoutInteraction(() => {
      const opened = openKeychain({ create: false });
      if (opened.missing) return null;
      if (opened.unusable) throw new Error(KEYCHAIN_UNUSABLE);
      if (!opened.kc) throw new Error(opened.error ?? KEYCHAIN_UNUSABLE);
      try {
        const len = [0];
        const data = [null];
        const item = [null];
        const st = api.find(opened.kc, serviceLen, service, accountLen, account, len, data, item);
        try {
          if (st === ERR_NOT_FOUND) return null;
          if (st !== 0) throw new Error(describeReadFailure(st));
          const raw = api.koffi.decode(data[0], "uint8_t", len[0]);
          const buf = Buffer.from(raw);
          raw.fill?.(0);
          const text = buf.toString("utf8");
          buf.fill(0);
          return text;
        } finally {
          if (st === 0 && data[0]) api.freeContent(null, data[0]);
          if (item[0]) api.release(item[0]);
        }
      } finally {
        api.release(opened.kc);
      }
    });
  };

  /** 删除（连专用钥匙串文件一起，不留空壳）；本来就没有也算成功。返回「现在确实没有保存的密码了」 */
  const remove = () => {
    init();
    if (!api) return false;
    try {
      return withoutInteraction(() => {
        removeLegacyLoginItem();
        if (!fsx.existsSync(keychainPath)) return true;
        // 专用钥匙串里只有这一条：整个文件删掉就是最干净的「清除」（打不开的残骸也一样）
        return deleteKeychainFile();
      });
    } catch (err) {
      log(`[desktop-keychain] 删除出错：${err?.message || err}`);
      return false;
    }
  };

  return { available, unavailableReason, has, set, get, remove };
};
