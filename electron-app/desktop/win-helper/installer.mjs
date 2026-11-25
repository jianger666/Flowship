/**
 * Windows 解锁组件的状态 / 安装 / 卸载（只在 Windows 上有意义；其它平台一律「不需要」）。
 *
 * 安装 / 卸载要管理员权限，而 Flowship 本身是免管理员装在用户目录里的。做法：
 *   Flowship（普通权限）→ powershell「外层」→ Start-Process -Verb RunAs（系统弹一次管理员授权框，只有用户亲自点「是」才继续）
 *   → powershell「引导」（管理员）→ 把 install.ps1 / uninstall.ps1 读进内存、对 SHA-256 → 对得上才从内存里执行。
 * 拿不到提权进程的输出，所以结果靠退出码（protocol.mjs 的 ADMIN_EXIT）+ public\install.log 里的失败那一行。
 *
 * 为什么要先校验再执行：.cs / .ps1 随安装包放在用户可写的目录，普通进程改得动它们，而授权框只会写「Windows PowerShell」，
 * 用户看不出要执行的是什么。期望哈希写死在 protocol.mjs 里（见 scripts/lib/win-helper-hashes.mjs 的说明）；
 * 就「脚本文本」这一件事而言，校验和执行用的是同一份内存里的内容，没有「校验完被换掉」的空档。
 *
 * 但提权进程不只执行那份文本，它还会：按需从 PSModulePath 里加载模块、把源码写进 %TEMP% 交给 csc.exe 编译、在 CLR 启动时读 COR_* / COMPlus_* 环境变量、
 * 按 %ProgramFiles% 之类的变量决定装到哪——这些输入都是用户态可以预先布置的，哈希校验管不到。能钉死的这里（引导 / 外层）和 install.ps1 / uninstall.ps1 都钉死了：
 * 模块路径只留 PowerShell 自带目录、清掉 .NET 分析器 / 钩子类环境变量、系统目录和 Program Files / ProgramData 用系统接口取而不读环境变量、
 * 编译用的临时目录指到只有管理员能写的私有目录。这是纵深防御，不是「提权链完全不可篡改」。
 * 残留风险（如实记在 docs/COMPUTER-USE.md「已知边界」和 docs/HANDOFF.md）：已经能改写 Flowship 安装目录里全部文件的恶意程序，连期望哈希一起改了，这里挡不住；
 * 同一账户内的恶意进程本来就能干用户能干的一切（包括读 Flowship 的内存），也不在防护范围内。
 *
 * 依赖（spawn / fs / 管道客户端）全部可注入，单测不碰真 PowerShell。命令里不出现任何凭据，日志只记成败和退出码。
 */
import { spawn as nodeSpawn } from "node:child_process";
import nodeFs from "node:fs";
import nodePath from "node:path";

import {
  ADMIN_EXIT,
  ASSET_FILES,
  HELPER_ASSET_SHA256,
  HELPER_VERSION,
  PROTOCOL_VERSION,
  RESPONSE_CODES,
  assetSha256,
  describeAdminExit,
  helperPaths,
  parseStatusFields,
  responseText,
} from "./protocol.mjs";

/** 提权进程要等用户点授权框 + 编译 + 启动，给足时间 */
export const ADMIN_TIMEOUT_MS = 300_000;
export const SID_TIMEOUT_MS = 15_000;
export const READY_TIMEOUT_MS = 15_000;
/**
 * probe() 里「资源校验通过」结果的缓存时长。设置页每 3 秒轮询一次状态，每次状态要探测两遍（hasCredential + helperStatus），
 * 原来每次探测都在主进程上同步读三个文件、算三遍 SHA-256——文件小、单次不到 1ms，但读文件会被杀毒软件拖慢，主进程卡一下界面就跟着卡。
 */
export const ASSET_CHECK_TTL_MS = 60_000;
/** Windows 命令行最长 32767 个字符，留点余量 */
const MAX_COMMAND_CHARS = 30_000;

/**
 * 本地 / 域 / Azure AD 的普通用户账户 SID（和 install.ps1 里的校验一致：内置组一律不收）。
 * 数字写 [0-9] 而不是 \d：.NET 的 \d 会匹配全角 / 阿拉伯数字，两边要同样严格；脚本里同一条把末尾的 $ 换成 \z（.NET 的 $ 放过尾随换行）。
 */
export const SID_RE = /^S-1-(5-21|12-1)(-[0-9]+){4}$/;

/**
 * PowerShell 单引号字符串字面量。单引号里一切字面，只有「引号字符」要翻倍——
 * PowerShell 把 ' ‘ ’ ‚ ‛ 四种都当单引号，所以弯引号也要转义。控制字符（换行等）直接拒绝。
 * @param {unknown} value
 */
export const psQuote = (value) => {
  const s = String(value);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error("PowerShell 参数里不能有控制字符");
  return `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`;
};

/** powershell.exe -EncodedCommand 要的格式：UTF-16LE 再 base64（没有空格和引号，不用操心命令行转义） */
export const toEncodedCommand = (script) => Buffer.from(script, "utf16le").toString("base64");

/**
 * 清掉 .NET 的「分析器 / 启动钩子 / 运行时选择」类环境变量（COR_PROFILER、COMPlus_*、DOTNET_STARTUP_HOOKS …）：
 * 同一账户能预先布置自己的环境变量，而这些变量会让 CLR 在启动时把别人的 DLL 加载进来——被加载的是一个管理员身份的进程。
 * 外层清一遍（提权进程默认继承它的环境），引导里再清一遍（保护它接下来拉起的 csc.exe 和 selftest）。
 * 用 .NET 的 Environment 类而不是 Get-ChildItem Env:：这是引导的第一件事，不能触发任何模块自动加载。
 */
const SCRUB_DOTNET_ENV_LINES = [
  "foreach ($name in @([Environment]::GetEnvironmentVariables().Keys)) {",
  "  if ($name -match '^(COR_|CORECLR_|COMPLUS_|DOTNET_)') { [Environment]::SetEnvironmentVariable($name, $null) }",
  "}",
];

/**
 * 把模块搜索路径钉死在 PowerShell 自带的目录：后面 Get-Acl / Get-ScheduledTask 这些命令是按需从 PSModulePath 里找模块的，
 * 而默认的 PSModulePath 里有用户可写的目录（Documents\WindowsPowerShell\Modules），同一账户的进程往里放一个同名模块，
 * 提权进程就会替它执行代码。必须在引导里任何一条命令之前设好。
 */
const PIN_MODULE_PATH_LINE = "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')";

/**
 * 「引导」：以管理员身份运行的第一段。把脚本文件读进内存 → 换行统一成 LF → 算 SHA-256 → 对得上才用同一份内存内容执行。
 * 脚本自己一定会 exit；最后那行兜底（脚本意外返回）按失败处理，不能当成功。
 * @param {{ scriptPath: string, scriptSha256: string, params?: Record<string, string> }} opts
 */
export const buildBootstrapScript = ({ scriptPath, scriptSha256, params = {} }) => {
  if (!/^[0-9A-Fa-f]{64}$/.test(scriptSha256)) throw new Error("脚本哈希不合法");
  const paramLines = Object.entries(params).map(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error(`非法的脚本参数名：${key}`);
    return `  ${key} = ${psQuote(value)}`;
  });
  return [
    "$ErrorActionPreference = 'Stop'",
    PIN_MODULE_PATH_LINE,
    ...SCRUB_DOTNET_ENV_LINES,
    "try {",
    `  $f = ${psQuote(scriptPath)}`,
    `  $want = ${psQuote(scriptSha256.toUpperCase())}`,
    "  $raw = [IO.File]::ReadAllBytes($f)",
    "  $text = [Text.Encoding]::UTF8.GetString($raw)",
    "  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }",
    '  $text = $text.Replace("`r`n", "`n")',
    "  $sha = [Security.Cryptography.SHA256]::Create()",
    "  $got = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '')",
    `  if ($got -ne $want) { exit ${ADMIN_EXIT.BOOTSTRAP_HASH} }`,
    "  $block = [ScriptBlock]::Create($text)",
    `} catch { exit ${ADMIN_EXIT.BOOTSTRAP_HASH} }`,
    "$params = @{",
    ...paramLines,
    "}",
    "& $block @params",
    `exit ${ADMIN_EXIT.OUTER_FAILED}`,
  ].join("\n");
};

/**
 * 「外层」：普通权限的 PowerShell，用 Start-Process -Verb RunAs 拉起管理员的引导（系统在这里弹授权框）。
 * 用户点「否」时 .NET 抛的是 Win32Exception(1223)，按错误号判断，不依赖系统语言的文案。
 * @param {string} bootstrapScript
 */
export const buildOuterScript = (bootstrapScript) =>
  [
    "$ErrorActionPreference = 'Stop'",
    ...SCRUB_DOTNET_ENV_LINES,
    "try {",
    // 系统目录用接口取（GetSystemDirectory），不读 %SystemRoot%：环境变量能被同一账户预先改写，而这里决定了「以管理员身份运行的是哪个 powershell.exe」
    "  $ps = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'",
    `  $psArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${toEncodedCommand(bootstrapScript)}')`,
    "  $p = Start-Process -FilePath $ps -ArgumentList $psArgs -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
    "  exit $p.ExitCode",
    "} catch {",
    "  $cause = $_.Exception.InnerException",
    `  if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq ${ADMIN_EXIT.UAC_CANCELLED}) { exit ${ADMIN_EXIT.UAC_CANCELLED} }`,
    `  exit ${ADMIN_EXIT.OUTER_FAILED}`,
    "}",
  ].join("\n");

/** 这些退出码是「安装过程中某一步失败」，install.log 里有那一步的详情，值得带给用户看 */
const CODES_WITH_LOG_DETAIL = new Set([
  ADMIN_EXIT.DIR_CLEANUP_FAILED,
  ADMIN_EXIT.DIR_ACL_FAILED,
  ADMIN_EXIT.COMPILE_FAILED,
  ADMIN_EXIT.SELFTEST_FAILED,
  ADMIN_EXIT.TASK_FAILED,
  ADMIN_EXIT.SERVICE_NOT_READY,
  ADMIN_EXIT.OLD_NOT_STOPPED,
  ADMIN_EXIT.INSTALL_UNEXPECTED,
]);

const BUSY_TEXT = "正在处理上一次安装 / 卸载请求，请稍等它结束";
const NOT_WINDOWS_TEXT = "当前系统不需要安装解锁组件";

/**
 * @param {{
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   spawn?: typeof nodeSpawn,
 *   fs?: Pick<typeof nodeFs, "readFileSync" | "existsSync" | "promises">,
 *   assetsDir: string,
 *   expectedHashes?: Record<string, string>,
 *   client: { status: () => Promise<{ ok: boolean, code: string, fields: Record<string, string> }> },
 *   log?: (msg: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   timeouts?: Partial<{ admin: number, sid: number, ready: number }>,
 * }} deps
 */
export const createHelperInstaller = (deps) => {
  const {
    platform = process.platform,
    env = process.env,
    spawn = nodeSpawn,
    fs = nodeFs,
    assetsDir,
    // 期望哈希默认取 protocol.mjs 里写死的那份；只有单测会换掉它
    expectedHashes = HELPER_ASSET_SHA256,
    client,
    log = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = deps;
  const timeouts = { admin: ADMIN_TIMEOUT_MS, sid: SID_TIMEOUT_MS, ready: READY_TIMEOUT_MS, ...(deps.timeouts ?? {}) };
  const paths = helperPaths(env);
  const powershellExe = nodePath.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let busy = false;

  /**
   * 三个资源文件都在、内容和期望哈希一致，才允许安装 / 卸载。
   * 每次调用都重新读文件、重新算哈希——install / uninstall 动手前必须用这个（不能用下面 probe 的缓存版）。
   */
  const assetState = () => {
    /** @type {Record<string, string>} */
    const files = {};
    for (const [key, name] of Object.entries(ASSET_FILES)) {
      const file = nodePath.join(assetsDir, name);
      let bytes;
      try {
        bytes = fs.readFileSync(file);
      } catch {
        return { ok: false, reason: `安装包里缺少解锁组件的文件（${name}），请重新安装 Flowship` };
      }
      const expected = expectedHashes[name];
      // 全零 = 开发者改了资源文件却忘了跑 scripts/win-helper-hashes.mjs 写回哈希：宁可不让装
      if (!expected || /^0+$/.test(expected)) return { ok: false, reason: "这个版本的解锁组件还没有登记校验值，暂时不能安装" };
      if (assetSha256(bytes) !== expected) return { ok: false, reason: `安装包里的解锁组件文件（${name}）和期望的内容对不上（可能被改动或损坏），请重新安装 Flowship` };
      files[key] = file;
    }
    return { ok: true, files };
  };

  /** probe() 里「校验通过」的资源结果（及它的时间），没有 = 还没验过 / 上次没通过 */
  let verifiedAssets = null;
  /**
   * probe() 用的资源校验：校验通过的结果在 ASSET_CHECK_TTL_MS 内直接复用（时钟倒拨按过期算）；没通过的不缓存，每次重查。
   * 只给 probe() 用——install / uninstall 动手前永远走上面没有缓存的 assetState()，所以缓存只会影响设置页「能不能安装」的提示，
   * 不会让一份被改过的文件被拿去执行（执行前引导脚本自己还会再核对一遍哈希）。
   */
  const assetStateForProbe = () => {
    if (verifiedAssets) {
      const age = now() - verifiedAssets.at;
      if (age >= 0 && age < ASSET_CHECK_TTL_MS) return verifiedAssets.state;
    }
    const state = assetState();
    verifiedAssets = state.ok ? { state, at: now() } : null;
    return state;
  };

  /** @param {unknown} err */
  const describeProbeFailure = (err) => {
    const code = /** @type {any} */ (err)?.code;
    if (code === "DENIED") return RESPONSE_CODES.DENIED;
    if (code === "NOT_RUNNING") return "解锁组件已经装上，但没有在运行。点「安装」重新安装一次即可（也可以在 Windows 的「任务计划程序」里手动运行「Flowship Unlock Helper」）";
    return "解锁组件没有正常回应。点「安装」重新安装一次试试";
  };

  /**
   * 详细探测（内部用）：组件在不在、版本对不对、有没有保存开机密码、冷却剩多久。
   * 版本不对 / 没在运行都算 installed:false 并说明原因——设置页只在 installed=false 时给「安装」按钮，点它就是升级 / 重装。
   * 版本对不上（比要的旧 / 比要的新）时组件仍在运行、回了看得懂的状态，所以这两种 installed:false 仍带 hasCredential：
   * 「组件里存着没存着一份密码」跟版本无关，设置页要靠它让用户看得到、清得掉（unlocker.hasStoredCredential；第六轮评审 P2-1）。
   * 解锁用的 hasCredential() 仍要求 installed——版本对不上的组件不拿来解锁。冷却秒数不带：旧版的冷却恢复语义和这版不同，当不得真。
   */
  const probe = async () => {
    if (platform !== "win32") return { installed: false, canInstall: false, running: false, exeExists: false, detail: NOT_WINDOWS_TEXT };
    const assets = assetStateForProbe();
    const canInstall = assets.ok;
    const assetNote = assets.ok ? undefined : assets.reason;
    if (!fs.existsSync(paths.exe)) return { installed: false, canInstall, running: false, exeExists: false, ...(assetNote ? { detail: assetNote } : {}) };
    let resp;
    try {
      resp = await client.status();
    } catch (err) {
      return { installed: false, canInstall, running: false, exeExists: true, detail: describeProbeFailure(err) };
    }
    if (!resp.ok) return { installed: false, canInstall, running: true, exeExists: true, detail: responseText(resp.code) ?? "解锁组件返回了错误" };
    const info = parseStatusFields(resp.fields);
    if (!info) return { installed: false, canInstall, running: true, exeExists: true, detail: "解锁组件回了看不懂的状态（版本不一致？），点「安装」重新安装一次" };
    // 通信协议比这版 Flowship 的新：两边说的话对不上（见下面的文案）
    if (info.proto > PROTOCOL_VERSION) {
      return {
        installed: false,
        canInstall,
        running: true,
        exeExists: true,
        version: info.ver,
        hasCredential: info.hasCredential,
        detail: `已装的解锁组件是 v${info.ver}（通信协议 v${info.proto}），比这版 Flowship 要的 v${HELPER_VERSION}（协议 v${PROTOCOL_VERSION}）新，两边对不上。请把 Flowship 更新到新版；或者点「安装」换回这版自带的 v${HELPER_VERSION}（会覆盖掉较新的组件）`,
      };
    }
    // 只有「已装的比要的旧」才提示升级；协议相同、组件版本更高（只是内部修复）时照样能用；旧写法是不相等就提示，会把较新的组件降级
    if (info.proto < PROTOCOL_VERSION || info.ver < HELPER_VERSION) {
      return {
        installed: false,
        canInstall,
        running: true,
        exeExists: true,
        version: info.ver,
        hasCredential: info.hasCredential,
        detail: `已装的解锁组件是 v${info.ver}，和这版 Flowship 要的 v${HELPER_VERSION} 不一致。点「安装」升级一次`,
      };
    }
    return { installed: true, canInstall, running: true, exeExists: true, version: info.ver, hasCredential: info.hasCredential, cooldownSeconds: info.cooldownSeconds };
  };

  /** 设置页看的版本：只有 installed / canInstall / detail */
  const status = async () => {
    const p = await probe();
    return { installed: p.installed, canInstall: p.canInstall, ...(p.detail ? { detail: p.detail } : {}) };
  };

  /**
   * 跑一次 powershell.exe。capture=true 时收 stdout（上限 4KB）。
   * @param {string[]} psArgs
   * @param {{ capture?: boolean, timeoutMs: number }} opts
   * @returns {Promise<{ code: number | null, stdout: string, timedOut?: boolean, error?: string }>}
   */
  const runPowerShell = (psArgs, { capture = false, timeoutMs }) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(powershellExe, psArgs, { windowsHide: true, stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"] });
      } catch (err) {
        resolve({ code: null, stdout: "", error: String(/** @type {any} */ (err)?.message || err).slice(0, 160) });
        return;
      }
      let out = "";
      let done = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已经退出 */
        }
        finish({ code: null, stdout: out, timedOut: true });
      }, timeoutMs);
      if (capture && child.stdout) {
        child.stdout.setEncoding?.("utf8");
        child.stdout.on("data", (d) => {
          if (out.length < 4096) out += String(d);
        });
      }
      child.once("error", (err) => finish({ code: null, stdout: out, error: String(/** @type {any} */ (err)?.message || err).slice(0, 160) }));
      child.once("close", (code) => finish({ code, stdout: out }));
    });

  /** 当前 Windows 账户的 SID（要登记进组件：只有这个账户能连它）。读不到 / 不是普通用户账户返回 null */
  const readCurrentSid = async () => {
    const r = await runPowerShell(["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], {
      capture: true,
      timeoutMs: timeouts.sid,
    });
    if (r.code !== 0) return null;
    const sid = r.stdout.trim();
    return SID_RE.test(sid) ? sid : null;
  };

  /** install.log 里「失败（退出码 N）：…」那一行（不含账户名等其它行），截断后带给用户 */
  const readFailureLine = async () => {
    try {
      const text = await fs.promises.readFile(paths.installLog, "utf8");
      const line = text
        .split(/\r?\n/)
        .reverse()
        .find((l) => l.includes("失败（退出码"));
      if (!line) return "";
      return line.slice(line.indexOf("失败（退出码")).slice(0, 500);
    } catch {
      return "";
    }
  };

  /**
   * 跑「外层 → 管理员引导 → 脚本」，把结果翻成给用户看的错误文案；成功返回 null。
   * @param {string} bootstrap
   * @param {string} doing  「安装」/「卸载」
   */
  const runElevated = async (bootstrap, doing) => {
    const outer = buildOuterScript(bootstrap);
    const encoded = toEncodedCommand(outer);
    if (encoded.length > MAX_COMMAND_CHARS) return { error: `${doing}失败：命令太长（Flowship 的安装路径异常长？）`, code: null };
    const r = await runPowerShell(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { timeoutMs: timeouts.admin });
    if (r.timedOut) return { error: `${doing}等了 ${Math.round(timeouts.admin / 60_000)} 分钟还没结束。如果系统的管理员授权框还开着，请处理后再试一次`, code: null };
    if (r.error) return { error: `没能启动 PowerShell：${r.error}`, code: null };
    if (r.code === 0) return { error: null, code: 0 };
    let error = describeAdminExit(r.code);
    if (r.code !== null && CODES_WITH_LOG_DETAIL.has(r.code)) {
      const line = await readFailureLine();
      if (line) error = `${error}（${line}）`;
    }
    return { error, code: r.code };
  };

  /** 脚本说装好了之后，再亲自连一下确认组件真的在应答、版本对得上 */
  const waitReady = async () => {
    const deadline = now() + timeouts.ready;
    for (;;) {
      const p = await probe();
      if (p.installed) return { ok: true, detail: "" };
      if (now() >= deadline) return { ok: false, detail: p.detail ?? "组件还没有就绪" };
      await sleep(500);
    }
  };

  /** 安装 / 升级。会弹系统的管理员授权框，只能由用户在设置页亲自触发 */
  const install = async () => {
    if (platform !== "win32") return { ok: false, error: NOT_WINDOWS_TEXT };
    if (busy) return { ok: false, error: BUSY_TEXT };
    busy = true;
    try {
      const assets = assetState();
      if (!assets.ok) return { ok: false, error: assets.reason };
      const sid = await readCurrentSid();
      if (!sid) return { ok: false, error: "读不到当前 Windows 账户的标识，没法登记给解锁组件（PowerShell 不可用，或当前不是普通用户账户）" };
      const bootstrap = buildBootstrapScript({
        scriptPath: assets.files.install,
        scriptSha256: expectedHashes[ASSET_FILES.install],
        params: { Source: assets.files.source, SourceSha: expectedHashes[ASSET_FILES.source], Sid: sid },
      });
      const run = await runElevated(bootstrap, "安装");
      if (run.error) {
        log(`[desktop] 解锁组件安装失败（退出码 ${run.code ?? "无"}）`);
        return { ok: false, error: run.error };
      }
      const ready = await waitReady();
      if (!ready.ok) {
        log("[desktop] 解锁组件安装脚本成功，但连不上组件");
        return { ok: false, error: `安装脚本报告成功，但连不上解锁组件：${ready.detail}` };
      }
      log("[desktop] 解锁组件已安装");
      return { ok: true };
    } finally {
      busy = false;
    }
  };

  /** 卸载组件，同时清掉它保存的（加密的）开机密码。会弹系统的管理员授权框 */
  const uninstall = async () => {
    if (platform !== "win32") return { ok: false, error: NOT_WINDOWS_TEXT };
    if (busy) return { ok: false, error: BUSY_TEXT };
    busy = true;
    try {
      const assets = assetState();
      if (!assets.ok) {
        return { ok: false, error: `${assets.reason}。也可以手动卸载：在「任务计划程序」里删除「Flowship\\Flowship Unlock Helper」，再删除 ${paths.installDir} 和 ${paths.dataDir}` };
      }
      const bootstrap = buildBootstrapScript({ scriptPath: assets.files.uninstall, scriptSha256: expectedHashes[ASSET_FILES.uninstall] });
      const run = await runElevated(bootstrap, "卸载");
      if (run.error) {
        log(`[desktop] 解锁组件卸载失败（退出码 ${run.code ?? "无"}）`);
        return { ok: false, error: run.error };
      }
      if (fs.existsSync(paths.exe)) return { ok: false, error: "卸载脚本报告成功，但组件的程序文件还在，重启电脑后再试一次" };
      log("[desktop] 解锁组件已卸载");
      return { ok: true };
    } finally {
      busy = false;
    }
  };

  return { probe, status, install, uninstall, paths };
};
