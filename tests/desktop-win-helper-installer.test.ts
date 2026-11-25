/**
 * Windows 解锁组件的安装器（electron-app/desktop/win-helper/installer.mjs）——假 spawn / 假 fs / 假管道客户端 / 虚拟时钟。
 *
 * 安装要弹一次系统管理员授权框、以管理员身份运行 PowerShell 脚本，是整套里最敏感的一步。这里钉死的是：
 * - 提权前的把关：资源文件哈希对不上不运行；当前账户的 SID 必须是普通用户账户（内置组一律拒绝），拿不到就不提权
 * - 命令构造：所有拼进 PowerShell 的值都经 psQuote（四种单引号字符全转义、控制字符直接拒绝），
 *   引导脚本「读一遍 → 校验 → 用同一份内存执行」，没有第二次读盘
 * - 结果判定：退出码 → 中文说明（用户点了「否」、编译失败……）；安装日志里只摘「失败」那一行；超时 / 起不来 / 装完连不上都如实说
 * - 不会并发安装；非 Windows 平台一律「不需要」；日志里没有账户 / 路径
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWin32Unlocker } from "../electron-app/desktop/unlockers/win32.mjs";
import { HelperClientError } from "../electron-app/desktop/win-helper/client.mjs";
import {
  ADMIN_TIMEOUT_MS,
  ASSET_CHECK_TTL_MS,
  SID_RE,
  buildBootstrapScript,
  buildOuterScript,
  createHelperInstaller,
  psQuote,
  toEncodedCommand,
} from "../electron-app/desktop/win-helper/installer.mjs";
import {
  ADMIN_EXIT,
  ASSET_FILES,
  HELPER_ASSET_SHA256,
  HELPER_VERSION,
  PROTOCOL_VERSION,
  RESPONSE_CODES,
  describeAdminExit,
  helperPaths,
} from "../electron-app/desktop/win-helper/protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "electron-app", "desktop", "win-helper", "assets");
const ENV = { SystemRoot: "C:\\Windows", ProgramData: "C:\\ProgramData", ProgramW6432: "C:\\Program Files" };
const PATHS = helperPaths(ENV);
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

const tmpDirs: string[] = [];
const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-installer-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  vi.useRealTimers();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 复制一份资源目录（可对内容做手脚） */
const copyAssets = (mutate?: (name: string, bytes: Buffer) => Buffer): string => {
  const dir = mkTmp();
  for (const name of Object.values(ASSET_FILES)) {
    const bytes = fs.readFileSync(path.join(ASSETS, name));
    fs.writeFileSync(path.join(dir, name), mutate ? mutate(name, bytes) : bytes);
  }
  return dir;
};

// ───────────────────────── PowerShell 文本的小工具 ─────────────────────────

const PS_QUOTES = "'\u2018\u2019\u201a\u201b";

/** 按 PowerShell 的规则解析一个单引号字符串字面量：任一「单引号字符」后面紧跟另一个就是转义，否则字符串结束 */
const parsePsSingleQuoted = (text: string): { value: string; end: number } => {
  if (!PS_QUOTES.includes(text[0])) throw new Error("不是单引号字符串");
  let i = 1;
  let value = "";
  while (i < text.length) {
    const c = text[i];
    if (PS_QUOTES.includes(c)) {
      if (i + 1 < text.length && PS_QUOTES.includes(text[i + 1])) {
        value += c;
        i += 2;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += c;
    i++;
  }
  throw new Error("字符串没有结束");
};

const decodeEncoded = (args: string[]): string => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
const innerBootstrap = (outer: string): string => {
  const m = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(outer);
  if (!m) throw new Error("外层脚本里找不到内层的 -EncodedCommand");
  return Buffer.from(m[1], "base64").toString("utf16le");
};

// ───────────────────────── psQuote / 编码 ─────────────────────────

describe("psQuote：拼进 PowerShell 的任何值都要过它", () => {
  it("普通字符串：用单引号包起来", () => {
    expect(psQuote("C:\\Program Files\\a b\\c.ps1")).toBe("'C:\\Program Files\\a b\\c.ps1'");
    expect(psQuote("")).toBe("''");
    expect(psQuote(123)).toBe("'123'");
  });

  it("四种单引号字符（' ‘ ’ ‚ ‛）全部翻倍：PowerShell 把它们都当作字符串边界", () => {
    expect(psQuote("a'b")).toBe("'a''b'");
    expect(psQuote("a\u2018b")).toBe("'a\u2018\u2018b'");
    expect(psQuote("a\u2019b")).toBe("'a\u2019\u2019b'");
    expect(psQuote("a\u201ab")).toBe("'a\u201a\u201ab'");
    expect(psQuote("a\u201bb")).toBe("'a\u201b\u201bb'");
  });

  it("其它特殊字符在单引号里本来就是字面的：原样保留", () => {
    for (const s of ["$env:Path", "`n", '"x"', "$(calc)", "a;b", "a|b", "中文 路径", "{}()[]", "%TEMP%", "a&b", "a#b"]) {
      expect(psQuote(s)).toBe(`'${s}'`);
    }
  });

  it("控制字符（换行 / 回车 / 制表 / NUL / DEL 等）直接拒绝", () => {
    for (const s of ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u001fb", "a\u007fb"]) expect(() => psQuote(s), JSON.stringify(s)).toThrow(/控制字符/);
  });

  it("注入尝试：输出仍是恰好一个完整的字符串字面量，解析回来等于原值", () => {
    const payloads = [
      "x'; Remove-Item C:\\ -Recurse -Force; '",
      "x\u2019; calc; \u2018",
      "x\u201a; calc; \u201b",
      "''",
      "'",
      "\u2018\u2019\u201a\u201b'",
      "a'b''c'''d",
      "'; $(Start-Process calc); '",
    ];
    for (const payload of payloads) {
      const quoted = psQuote(payload);
      const parsed = parsePsSingleQuoted(quoted);
      expect(parsed.end, JSON.stringify(payload)).toBe(quoted.length);
      expect(parsed.value, JSON.stringify(payload)).toBe(payload);
    }
  });
});

describe("toEncodedCommand", () => {
  it("UTF-16LE 再 base64：能原样解回，中文也行；输出里只有 base64 字符（命令行里不需要任何引号）", () => {
    for (const script of ["Write-Host 'hi'", "中文路径 C:\\用户\\陈\\x.ps1", "a\nb\r\nc"]) {
      const encoded = toEncodedCommand(script);
      expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
    }
  });
});

// ───────────────────────── 引导 / 外层脚本 ─────────────────────────

describe("buildBootstrapScript（以管理员身份运行的第一段）", () => {
  const SHA = "ab".repeat(32);
  const build = (over: Partial<{ scriptPath: string; scriptSha256: string; params: Record<string, string> }> = {}) =>
    buildBootstrapScript({ scriptPath: "C:\\App\\install.ps1", scriptSha256: SHA, params: { Source: "C:\\App\\x.cs", Sid: SID }, ...over });

  it("读一遍文件 → 去 BOM、换行统一成 LF → 算 SHA-256 → 对得上才用同一份内存内容执行", () => {
    const script = build();
    expect(script).toContain("$f = 'C:\\App\\install.ps1'");
    expect(script).toContain(`$want = '${SHA.toUpperCase()}'`);
    expect(script).toContain("[IO.File]::ReadAllBytes($f)");
    expect(script).toContain("0xFEFF");
    expect(script).toContain('$text.Replace("`r`n", "`n")');
    expect(script).toContain("[ScriptBlock]::Create($text)");
    expect(script).toContain("& $block @params");
    // 校验在创建脚本块之前
    expect(script.indexOf("$got -ne $want")).toBeLessThan(script.indexOf("[ScriptBlock]::Create($text)"));
  });

  it("只读一次磁盘：校验用的就是执行用的那份内存（没有「校验完被换掉」的空档）", () => {
    const script = build();
    expect(script.match(/ReadAllBytes/g)).toHaveLength(1);
    for (const forbidden of [/Get-Content/i, /ReadAllText/i, /Invoke-Expression/i, /\biex\b/i, /\s-File\b/i, /^\s*\.\s+\$f/m, /Import-Module/i]) {
      expect(script).not.toMatch(forbidden);
    }
  });

  it("哈希对不上 / 校验过程出错 → 退出码 90，不运行任何脚本；脚本意外返回 → 80（不当成功）", () => {
    const script = build();
    expect(script.match(new RegExp(`exit ${ADMIN_EXIT.BOOTSTRAP_HASH}`, "g"))).toHaveLength(2);
    const lines = script.split("\n");
    expect(lines.at(-1)).toBe(`exit ${ADMIN_EXIT.OUTER_FAILED}`);
    expect(script).not.toMatch(/exit 0\b/);
  });

  it("开头只有三件事：设错误策略、钉死模块搜索路径、清 .NET 钩子类环境变量；没有任何命令（cmdlet），第一个命令必须排在它们之后", () => {
    // 任何 cmdlet 调用都可能触发模块自动加载，而默认的 PSModulePath 里有用户可写的目录——所以钉死 PSModulePath 必须是第一件事，
    // 之前不能有 cmdlet；后面的 try 块里（Get-* 之类可以随意用）才开始读文件、算哈希
    const script = build();
    const preamble = script.slice(0, script.indexOf("try {"));
    expect(preamble.split("\n").filter(Boolean)).toEqual([
      "$ErrorActionPreference = 'Stop'",
      "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')",
      "foreach ($name in @([Environment]::GetEnvironmentVariables().Keys)) {",
      "  if ($name -match '^(COR_|CORECLR_|COMPLUS_|DOTNET_)') { [Environment]::SetEnvironmentVariable($name, $null) }",
      "}",
    ]);
    // 引导里没有 Import-Module / Get-Module / Get-ChildItem Env: 之类会碰模块路径或环境变量提供程序的命令（$env:X 这种变量写法不算）
    expect(script).not.toMatch(/Import-Module|Get-Module|Get-ChildItem|\bgci\b|(?<!\$)\bEnv:/i);
  });

  it("参数按名字传（哈希表 splat），值都经 psQuote", () => {
    const script = build();
    expect(script).toContain("  Source = 'C:\\App\\x.cs'");
    expect(script).toContain(`  Sid = '${SID}'`);
    expect(script).toContain("$params = @{");
  });

  it("没有参数（卸载）：空哈希表", () => {
    const script = buildBootstrapScript({ scriptPath: "C:\\App\\uninstall.ps1", scriptSha256: SHA });
    expect(script).toContain("$params = @{\n}");
  });

  it("路径里有单引号（用户名 O'Brien）：转义后解析回原值，不会截断字符串", () => {
    const evil = "C:\\Users\\O'Brien\\x'; calc; '\\install.ps1";
    const script = build({ scriptPath: evil });
    const line = script.split("\n").find((l) => l.startsWith("  $f = "))!;
    const parsed = parsePsSingleQuoted(line.slice("  $f = ".length));
    expect(parsed.value).toBe(evil);
    expect(parsed.end).toBe(line.length - "  $f = ".length);
  });

  it("小写哈希转大写；不合法的哈希 / 参数名 / 参数值直接抛", () => {
    expect(build({ scriptSha256: "cd".repeat(32) })).toContain(`$want = '${"CD".repeat(32)}'`);
    expect(() => build({ scriptSha256: "abc" })).toThrow(/哈希不合法/);
    expect(() => build({ scriptSha256: "zz".repeat(32) })).toThrow(/哈希不合法/);
    expect(() => build({ params: { "bad name": "x" } })).toThrow(/非法的脚本参数名/);
    expect(() => build({ params: { "a;b": "x" } })).toThrow(/非法的脚本参数名/);
    expect(() => build({ params: { "1a": "x" } })).toThrow(/非法的脚本参数名/);
    expect(() => build({ params: { Sid: "S-1\nRemove-Item" } })).toThrow(/控制字符/);
    expect(() => build({ scriptPath: "C:\\a\nb.ps1" })).toThrow(/控制字符/);
  });
});

describe("buildOuterScript（普通权限的外层：弹系统管理员授权框）", () => {
  const bootstrap = "Write-Host 'hello'; exit 7";
  const outer = buildOuterScript(bootstrap);

  it("用 Start-Process -Verb RunAs 拉起管理员的 PowerShell，等它结束并把退出码带出来", () => {
    expect(outer).toContain("Start-Process");
    expect(outer).toContain("-Verb RunAs");
    expect(outer).toContain("-Wait -PassThru");
    expect(outer).toContain("exit $p.ExitCode");
    expect(outer).toContain("'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'");
  });

  // 扫描用：把嵌进去的 base64（引导脚本）抹掉，免得随机的 base64 字符碰巧撞上某个词
  const outerText = outer.replace(/'[A-Za-z0-9+/=]{16,}'/, "''");

  it("以管理员身份运行的 powershell.exe 路径用系统接口取（GetSystemDirectory），整段外层不读任何环境变量", () => {
    // %SystemRoot% 能被同一账户预先改写：读它就等于让别人决定「以管理员身份运行的是哪个 powershell.exe」
    expect(outer).toContain("Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'");
    expect(outerText).not.toMatch(/\$env:/i);
    expect(outerText).not.toMatch(/SystemRoot|windir/i);
  });

  it("提权之前先清掉 .NET 分析器 / 钩子类环境变量（提权进程默认继承外层的环境）", () => {
    expect(outer).toContain("[Environment]::GetEnvironmentVariables().Keys");
    expect(outer).toContain("'^(COR_|CORECLR_|COMPLUS_|DOTNET_)'");
    expect(outer).toContain("[Environment]::SetEnvironmentVariable($name, $null)");
    expect(outer.indexOf("SetEnvironmentVariable")).toBeGreaterThan(-1);
    expect(outer.indexOf("SetEnvironmentVariable")).toBeLessThan(outer.indexOf("Start-Process"));
    // 清环境本身不能触发模块自动加载：用 .NET 的 Environment 类，不用 Get-ChildItem Env: 之类的 cmdlet
    expect(outerText).not.toMatch(/Get-ChildItem|\bgci\b|\bdir\b|Env:/i);
  });

  it("引导脚本以 base64 嵌进去，能原样解回；明文不出现在外层里", () => {
    expect(innerBootstrap(outer)).toBe(bootstrap);
    expect(outer).not.toContain("hello");
  });

  it("用户点了「否」（Win32 错误 1223）按错误号判断、不依赖系统语言；其它失败 80", () => {
    expect(outer).toContain("[System.ComponentModel.Win32Exception]");
    expect(outer).toContain(`NativeErrorCode -eq ${ADMIN_EXIT.UAC_CANCELLED}) { exit ${ADMIN_EXIT.UAC_CANCELLED} }`);
    expect(outer).toContain(`exit ${ADMIN_EXIT.OUTER_FAILED}`);
  });
});

// ───────────────────────── 假的 spawn / fs / 管道客户端 ─────────────────────────

class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  kill = vi.fn();
}

type Plan = { stdout?: string; code?: number | null; error?: Error; hang?: boolean; throws?: Error };
type SpawnCall = { exe: string; args: string[]; opts: unknown };

const isSidCall = (c: SpawnCall) => c.args.includes("-Command");

const makeSpawn = (decide: (call: SpawnCall, index: number) => Plan) => {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = vi.fn((exe: string, args: string[], opts: unknown) => {
    const call = { exe, args, opts };
    const plan = decide(call, calls.length);
    calls.push(call);
    if (plan.throws) throw plan.throws;
    const child = new FakeChild();
    children.push(child);
    if (!plan.hang) {
      // microtask：早于任何定时器（包括虚拟定时器），晚于 spawn 返回后同步挂上的监听
      queueMicrotask(() => {
        if (plan.error) child.emit("error", plan.error);
        else {
          if (plan.stdout !== undefined) child.stdout.emit("data", plan.stdout);
          // 注意区分「没写 = 0」和「null = 被信号结束、没有退出码」
          child.emit("close", plan.code === undefined ? 0 : plan.code);
        }
      });
    }
    return child;
  });
  return { spawn, calls, children };
};

// proto 也跟着常量走：以前写死 "1"，升协议版本时「版本正常的组件」就成了「协议不一致」
const okFields = (over: Record<string, string> = {}) => ({ proto: String(PROTOCOL_VERSION), ver: String(HELPER_VERSION), has: "0", cool: "0", console: "1", client: "1", ...over });
const okResp = (over: Record<string, string> = {}) => ({ ok: true, code: "OK", fields: okFields(over) });

type StatusStep = "down" | "ok" | "old";
const statusSequence = (...steps: StatusStep[]) => {
  let i = 0;
  return vi.fn(async () => {
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step === "down") throw new HelperClientError("NOT_RUNNING", "没在运行");
    if (step === "old") return okResp({ ver: "0" });
    return okResp();
  });
};

type Opts = {
  platform?: string;
  exeExists?: boolean;
  installLog?: string | Error;
  decide?: (call: SpawnCall, index: number) => Plan;
  status?: ReturnType<typeof vi.fn>;
  assetsDir?: string;
  expectedHashes?: Record<string, string>;
  timeouts?: Partial<{ admin: number; sid: number; ready: number }>;
  readFileSync?: (file: string) => Buffer;
};

const makeInstaller = (o: Opts = {}) => {
  const { spawn, calls, children } = makeSpawn(o.decide ?? ((c) => (isSidCall(c) ? { stdout: `${SID}\r\n`, code: 0 } : { code: 0 })));
  const status = o.status ?? vi.fn(async () => okResp());
  const client = { status };
  let now = 0;
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  /** 手动拨虚拟时钟（可以为负：模拟系统时间被往回调） */
  const advance = (ms: number) => {
    now += ms;
  };
  const logs: string[] = [];
  const readLog = vi.fn(async (file: string) => {
    void file;
    if (o.installLog instanceof Error) throw o.installLog;
    return o.installLog ?? "";
  });
  const fsFake = {
    readFileSync: o.readFileSync ?? ((file: string) => fs.readFileSync(file)),
    existsSync: (p: string) => (p === PATHS.exe ? (o.exeExists ?? false) : fs.existsSync(p)),
    promises: { readFile: readLog },
  };
  const installer = createHelperInstaller({
    platform: o.platform ?? "win32",
    env: ENV,
    spawn: spawn as never,
    fs: fsFake as never,
    assetsDir: o.assetsDir ?? ASSETS,
    ...(o.expectedHashes ? { expectedHashes: o.expectedHashes } : {}),
    client: client as never,
    log: (m: string) => logs.push(m),
    sleep,
    now: () => now,
    timeouts: { ready: 2000, ...(o.timeouts ?? {}) },
  });
  return { installer, spawn, calls, children, status, readLog, logs, sleep, advance };
};

// ───────────────────────── 非 Windows ─────────────────────────

describe("非 Windows 平台：一律「不需要」，什么都不碰", () => {
  it("probe / status / install / uninstall", async () => {
    const fx = makeInstaller({ platform: "darwin" });
    await expect(fx.installer.probe()).resolves.toMatchObject({ installed: false, canInstall: false, running: false, exeExists: false, detail: expect.stringContaining("不需要") });
    await expect(fx.installer.status()).resolves.toEqual({ installed: false, canInstall: false, detail: expect.stringContaining("不需要") });
    await expect(fx.installer.install()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("不需要") });
    await expect(fx.installer.uninstall()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("不需要") });
    expect(fx.spawn).not.toHaveBeenCalled();
    expect(fx.status).not.toHaveBeenCalled();
  });
});

// ───────────────────────── 资源校验（canInstall） ─────────────────────────

describe("资源文件把关：缺 / 被改 / 没登记哈希都不让装", () => {
  const probeNoExe = (o: Opts) => makeInstaller({ exeExists: false, ...o }).installer.probe();

  it("真实资源 + 登记的哈希：可以安装，没有多余的 detail", async () => {
    const p = await probeNoExe({});
    expect(p).toEqual({ installed: false, canInstall: true, running: false, exeExists: false });
  });

  it("资源目录不存在 / 缺文件：canInstall=false，说明缺哪个", async () => {
    const p = await probeNoExe({ assetsDir: path.join(mkTmp(), "nope") });
    expect(p.canInstall).toBe(false);
    expect(p.detail).toContain("缺少");
    expect(p.detail).toContain(ASSET_FILES.source);
  });

  it("文件被改过一个字节：canInstall=false，说明对不上", async () => {
    const dir = copyAssets((name, bytes) => (name === ASSET_FILES.install ? Buffer.concat([bytes, Buffer.from("# tampered\n")]) : bytes));
    const p = await probeNoExe({ assetsDir: dir });
    expect(p.canInstall).toBe(false);
    expect(p.detail).toContain("对不上");
    expect(p.detail).toContain(ASSET_FILES.install);
  });

  it("哈希还是占位的全零 / 某个文件没登记：不让装（开发者忘了写回哈希）", async () => {
    const zero = Object.fromEntries(Object.values(ASSET_FILES).map((n) => [n, "0".repeat(64)]));
    expect((await probeNoExe({ expectedHashes: zero })).detail).toContain("还没有登记校验值");
    const missing = { ...HELPER_ASSET_SHA256 } as Record<string, string>;
    delete missing[ASSET_FILES.uninstall];
    expect((await probeNoExe({ expectedHashes: missing })).detail).toContain("还没有登记校验值");
  });

  it("换行被 git 改成 CRLF / 开头多了 BOM：规范化之后哈希不变，照样可以装", async () => {
    const crlf = copyAssets((_n, bytes) => Buffer.from(bytes.toString("utf8").replace(/\n/g, "\r\n"), "utf8"));
    expect((await probeNoExe({ assetsDir: crlf })).canInstall).toBe(true);
    const bom = copyAssets((_n, bytes) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
    expect((await probeNoExe({ assetsDir: bom })).canInstall).toBe(true);
  });
});

// ───────────────────────── 资源校验的缓存（设置页 3 秒一轮询） ─────────────────────────

/**
 * 设置页每 3 秒轮询一次状态，每次状态要探测两遍（hasCredential + helperStatus）；原来每次探测都在主进程上同步读三个文件、算三遍 SHA-256。
 * 单次不到 1ms，但读文件会被杀毒软件拖慢，主进程卡一下界面就卡。所以 probe() 里「校验通过」的结果短时间复用——
 * 但缓存只能影响设置页「能不能安装」的提示：install / uninstall 动手前必须重新校验（不然一份被改过的文件会被拿去执行）。
 */
describe("probe 里资源校验的缓存：通过的结果短时间复用；没通过的不缓存；install / uninstall 永远重新校验", () => {
  /** 记下每次读了哪个资源文件；tamper() 之后 install.ps1 的内容会多一行（哈希对不上） */
  const counting = () => {
    const reads: string[] = [];
    let tampered = false;
    let locked = false;
    const readFileSync = (file: string): Buffer => {
      const name = path.basename(file);
      if (locked && name === ASSET_FILES.install) throw new Error("文件被杀毒软件占用");
      reads.push(name);
      const bytes = fs.readFileSync(file);
      return tampered && name === ASSET_FILES.install ? Buffer.concat([bytes, Buffer.from("# tampered\n")]) : bytes;
    };
    return {
      reads,
      readFileSync,
      tamper: () => {
        tampered = true;
      },
      lock: (v: boolean) => {
        locked = v;
      },
    };
  };

  it("默认缓存 60 秒", () => {
    expect(ASSET_CHECK_TTL_MS).toBe(60_000);
  });

  it("通过的结果在 TTL 内复用（probe / status 混着调也不再读文件）；到点（差 1ms 还不算）才重新校验", async () => {
    const c = counting();
    const fx = makeInstaller({ exeExists: false, readFileSync: c.readFileSync });
    expect(await fx.installer.probe()).toMatchObject({ canInstall: true });
    expect(c.reads).toHaveLength(3);
    await fx.installer.probe();
    expect(await fx.installer.status()).toEqual({ installed: false, canInstall: true });
    expect(c.reads).toHaveLength(3);
    fx.advance(ASSET_CHECK_TTL_MS - 1);
    await fx.installer.probe();
    expect(c.reads).toHaveLength(3);
    fx.advance(1);
    expect(await fx.installer.probe()).toMatchObject({ canInstall: true });
    expect(c.reads).toHaveLength(6);
    // 新的一轮从重新校验的时刻重新计时
    fx.advance(ASSET_CHECK_TTL_MS - 1);
    await fx.installer.probe();
    expect(c.reads).toHaveLength(6);
  });

  it("系统时间被往回调：缓存按过期算（不会因为「年龄是负数」而一直复用）", async () => {
    const c = counting();
    const fx = makeInstaller({ exeExists: false, readFileSync: c.readFileSync });
    fx.advance(10 * 60_000);
    await fx.installer.probe();
    expect(c.reads).toHaveLength(3);
    fx.advance(-5 * 60_000);
    await fx.installer.probe();
    expect(c.reads).toHaveLength(6);
  });

  it("没通过的不缓存：读不到文件时每次都重查，条件恢复后下一次就看到可以安装（不用等 TTL）", async () => {
    const c = counting();
    c.lock(true);
    const fx = makeInstaller({ exeExists: false, readFileSync: c.readFileSync });
    const bad = await fx.installer.probe();
    expect(bad.canInstall).toBe(false);
    expect(bad.detail).toContain("缺少");
    expect((await fx.installer.probe()).canInstall).toBe(false);
    c.lock(false);
    expect((await fx.installer.probe()).canInstall).toBe(true);
    // 通过之后才开始缓存
    const before = c.reads.length;
    await fx.installer.probe();
    expect(c.reads).toHaveLength(before);
  });

  it("缓存只影响提示：TTL 内文件被改了，状态里仍是通过；但 install / uninstall 动手前重新校验，对不上就不提权、不起 PowerShell", async () => {
    const c = counting();
    const fx = makeInstaller({ exeExists: false, readFileSync: c.readFileSync });
    expect((await fx.installer.probe()).canInstall).toBe(true);
    c.tamper();
    expect((await fx.installer.probe()).canInstall).toBe(true); // 缓存里的旧结论
    const install = await fx.installer.install();
    expect(install).toMatchObject({ ok: false, error: expect.stringContaining("对不上") });
    expect(install.error).toContain(ASSET_FILES.install);
    const uninstall = await fx.installer.uninstall();
    expect(uninstall).toMatchObject({ ok: false, error: expect.stringContaining("对不上") });
    expect(fx.spawn).not.toHaveBeenCalled();
    // 到点之后状态也跟上了
    fx.advance(ASSET_CHECK_TTL_MS);
    const after = await fx.installer.probe();
    expect(after.canInstall).toBe(false);
    expect(after.detail).toContain("对不上");
  });

  it("install / uninstall 每次都自己读文件，不吃 probe 的缓存（也不去喂它）", async () => {
    const c = counting();
    const fx = makeInstaller({ exeExists: false, readFileSync: c.readFileSync });
    await fx.installer.probe();
    expect(c.reads).toHaveLength(3);
    await fx.installer.install(); // 这里只关心读文件的次数：安装本身成不成功无所谓（装完等组件就绪时的 probe 走缓存，不再读）
    expect(c.reads.length).toBeGreaterThanOrEqual(6);
    const afterInstall = c.reads.length;
    await fx.installer.uninstall();
    expect(c.reads.length).toBeGreaterThanOrEqual(afterInstall + 3);
  });
});

// ───────────────────────── probe 状态机 ─────────────────────────

describe("probe / status：组件装没装、在不在运行、版本对不对", () => {
  it("没有 exe：不用去连管道", async () => {
    const fx = makeInstaller({ exeExists: false });
    expect(await fx.installer.probe()).toMatchObject({ installed: false, running: false, exeExists: false });
    expect(fx.status).not.toHaveBeenCalled();
  });

  const down = (code: ConstructorParameters<typeof HelperClientError>[0]) =>
    vi.fn(async () => {
      throw new HelperClientError(code, "x");
    });

  it("管道连不上：按原因给提示，exe 在（exeExists=true）但 running=false", async () => {
    const notRunning = await makeInstaller({ exeExists: true, status: down("NOT_RUNNING") }).installer.probe();
    expect(notRunning).toMatchObject({ installed: false, running: false, exeExists: true });
    expect(notRunning.detail).toContain("没有在运行");

    const denied = await makeInstaller({ exeExists: true, status: down("DENIED") }).installer.probe();
    expect(denied.detail).toBe(RESPONSE_CODES.DENIED);

    for (const code of ["BAD_RESPONSE", "TIMEOUT", "IO"] as const) {
      const p = await makeInstaller({ exeExists: true, status: down(code) }).installer.probe();
      expect(p.detail, code).toContain("没有正常回应");
    }
    const plain = await makeInstaller({
      exeExists: true,
      status: vi.fn(async () => {
        throw new Error("boom");
      }),
    }).installer.probe();
    expect(plain.detail).toContain("没有正常回应");
  });

  it("组件回了失败 / 回了看不懂的状态：installed=false 但 running=true", async () => {
    const err = await makeInstaller({ exeExists: true, status: vi.fn(async () => ({ ok: false, code: "DENIED", fields: {} })) }).installer.probe();
    expect(err).toMatchObject({ installed: false, running: true });
    expect(err.detail).toBe(RESPONSE_CODES.DENIED);

    const unknown = await makeInstaller({ exeExists: true, status: vi.fn(async () => ({ ok: false, code: "WHAT", fields: {} })) }).installer.probe();
    expect(unknown.detail).toBe("解锁组件返回了错误");

    const garbled = await makeInstaller({ exeExists: true, status: vi.fn(async () => ({ ok: true, code: "OK", fields: { proto: "1" } })) }).installer.probe();
    expect(garbled).toMatchObject({ installed: false, running: true });
    expect(garbled.detail).toContain("看不懂");
  });

  it("已装的组件比这版要的旧（组件版本 / 协议更低）：installed=false，说明装的是哪版、需要哪版，点「安装」就是升级", async () => {
    for (const over of [{ ver: "1" }, { proto: "1" }] as Array<Record<string, string>>) {
      const p = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp(over)) }).installer.probe();
      expect(p).toMatchObject({ installed: false, running: true, exeExists: true });
      expect(p.detail).toContain(`v${HELPER_VERSION}`);
      expect(p.detail).toContain("升级");
    }
    const old = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ ver: "1" })) }).installer.probe();
    expect(old.version).toBe(1);
    expect(old.detail).toContain("v1");
  });

  // 第五轮评审：以前用不等号比较，装过新版 Flowship 再回退旧版（或正式版与 test 版共用同一份组件）时，
  // 较新的组件也被判成要升级，用户点安装就被这版自带的旧组件覆盖（降级），新版 Flowship 随后又提示升级，来回覆盖
  it("协议相同、已装的组件版本比要的更高（回退过 Flowship / 两个实例共用一份组件）：能用，不提示升级", async () => {
    const newer = HELPER_VERSION + 4;
    const p = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ ver: String(newer), has: "1", cool: "120" })) }).installer.probe();
    expect(p).toEqual({ installed: true, canInstall: true, running: true, exeExists: true, version: newer, hasCredential: true, cooldownSeconds: 120 });
    const s = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ ver: String(newer) })) }).installer.status();
    expect(s).toEqual({ installed: true, canInstall: true });
  });

  it("通信协议比这版 Flowship 的新：仍然 installed=false（两边对不上），但文案如实说是「比这版新 / 换回自带版会覆盖」，不叫「升级」", async () => {
    const newerProto = String(PROTOCOL_VERSION + 6);
    for (const over of [{ proto: newerProto }, { proto: newerProto, ver: String(HELPER_VERSION + 4) }] as Array<Record<string, string>>) {
      const p = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp(over)) }).installer.probe();
      expect(p).toMatchObject({ installed: false, running: true, exeExists: true });
      expect(p.detail).toContain(`v${HELPER_VERSION}`);
      expect(p.detail).toContain("比这版 Flowship");
      expect(p.detail).toContain("覆盖");
      expect(p.detail).not.toContain("升级一次");
    }
  });

  // 第六轮评审 P2-1：以前这两种「版本对不上」的 installed=false 都不带 hasCredential，设置页于是既看不到「已保存」、也清不掉已保存的开机密码
  // （组件还在运行、密码就存在里面，clearCredential 也没有版本闸，只是界面够不到它）
  it("版本对不上（组件更旧 / 协议更旧 / 协议更新）：installed=false，但组件还在运行、回了看得懂的状态，所以带上 hasCredential；不带冷却秒数", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["组件版本更旧", { ver: "1" }],
      ["协议更旧", { proto: "1" }],
      ["协议更新", { proto: String(PROTOCOL_VERSION + 6) }],
    ];
    for (const [name, over] of cases) {
      for (const has of ["1", "0"]) {
        const p = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ ...over, has, cool: "300" })) }).installer.probe();
        expect(p, `${name} / has=${has}`).toMatchObject({ installed: false, running: true, exeExists: true, hasCredential: has === "1" });
        // 旧版的冷却恢复语义和这版不同，剩几秒当不得真，不往外给
        expect(p, `${name} / has=${has}`).not.toHaveProperty("cooldownSeconds");
      }
    }
  });

  it("没装 / 没在运行 / 回了失败 / 状态看不懂：installed=false 且不带 hasCredential（拿不到「存着没」的可靠答案，就别装作知道）", async () => {
    const probes = [
      await makeInstaller({ exeExists: false }).installer.probe(),
      await makeInstaller({ exeExists: true, status: down("NOT_RUNNING") }).installer.probe(),
      await makeInstaller({ exeExists: true, status: vi.fn(async () => ({ ok: false, code: "DENIED", fields: {} })) }).installer.probe(),
      await makeInstaller({ exeExists: true, status: vi.fn(async () => ({ ok: true, code: "OK", fields: { proto: "1" } })) }).installer.probe(),
    ];
    for (const p of probes) {
      expect(p.installed).toBe(false);
      expect(p).not.toHaveProperty("hasCredential");
    }
  });

  // 第七轮评审 P3：hasStoredCredential 的「服务停止」分支缺一条连起来的断言——win32 解锁器那边的用例喂的是手写的探测对象，
  // 这里（installer）只断言「不带 hasCredential」，两层之间没有对上。这里用真 installer 的 probe 接真解锁器：
  // 任何一层在「服务停止 / 状态不可信」时误带「存着」、或在「服务在运行」时又去看版本，设置页都会显示一个不可靠的「已保存」/ 看不到真的已保存
  it("真 installer 接真解锁器：服务停止 / 没装 / 回了失败 / 状态看不懂 → hasStoredCredential 为 false；服务在运行时不看版本（旧版 / 协议更新、里面存着 → true）", async () => {
    const unlockerOf = (fx: ReturnType<typeof makeInstaller>) =>
      createWin32Unlocker({ driver: {} as never, installer: fx.installer, client: {} as never }) as Required<ReturnType<typeof createWin32Unlocker>>;
    const cases: Array<[string, ReturnType<typeof makeInstaller>, boolean]> = [
      ["服务停止（管道连不上）", makeInstaller({ exeExists: true, status: down("NOT_RUNNING") }), false],
      ["管道拒绝访问", makeInstaller({ exeExists: true, status: down("DENIED") }), false],
      ["没装（exe 都没有）", makeInstaller({ exeExists: false }), false],
      ["组件回了失败", makeInstaller({ exeExists: true, status: vi.fn(async () => ({ ok: false, code: "DENIED", fields: {} })) }), false],
      ["状态看不懂", makeInstaller({ exeExists: true, status: vi.fn(async () => ({ ok: true, code: "OK", fields: { proto: "1" } })) }), false],
      ["版本旧、里面存着密码", makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ ver: "1", has: "1" })) }), true],
      ["协议比这版新、里面存着密码", makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ proto: String(PROTOCOL_VERSION + 6), has: "1" })) }), true],
      ["版本旧、里面没存", makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ ver: "1", has: "0" })) }), false],
      ["一切正常、存着", makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ has: "1" })) }), true],
      ["一切正常、没存", makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ has: "0" })) }), false],
    ];
    for (const [name, fx, expected] of cases) {
      await expect(unlockerOf(fx).hasStoredCredential(), name).resolves.toBe(expected);
    }
  });

  it("装完之后组件的版本比要的更高（协议相同）：install 的就绪确认照样通过，不会因此卡到超时", async () => {
    const fx = makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ ver: String(HELPER_VERSION + 4) })) });
    await expect(fx.installer.install()).resolves.toEqual({ ok: true });
  });

  it("一切正常：installed=true，带上有没有保存开机密码、冷却剩几秒", async () => {
    const a = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ has: "1", cool: "0" })) }).installer.probe();
    expect(a).toEqual({ installed: true, canInstall: true, running: true, exeExists: true, version: HELPER_VERSION, hasCredential: true, cooldownSeconds: 0 });
    const b = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ has: "0", cool: "300" })) }).installer.probe();
    expect(b).toMatchObject({ installed: true, hasCredential: false, cooldownSeconds: 300 });
  });

  it("status() 只给设置页需要的三项（installed / canInstall / detail），不带出密码状态、冷却等", async () => {
    const ok = await makeInstaller({ exeExists: true, status: vi.fn(async () => okResp({ has: "1", cool: "300" })) }).installer.status();
    expect(ok).toEqual({ installed: true, canInstall: true });
    const bad = await makeInstaller({ exeExists: true, status: down("NOT_RUNNING") }).installer.status();
    expect(Object.keys(bad).sort()).toEqual(["canInstall", "detail", "installed"]);
  });
});

// ───────────────────────── 安装 ─────────────────────────

describe("install：成功路径", () => {
  it("读 SID（普通权限）→ 提权跑 install.ps1（带校验过的参数）→ 亲自连一下确认组件就绪", async () => {
    const fx = makeInstaller({ exeExists: true });
    await expect(fx.installer.install()).resolves.toEqual({ ok: true });
    expect(fx.spawn).toHaveBeenCalledTimes(2);

    const [sidCall, adminCall] = fx.calls;
    expect(sidCall.exe).toBe(POWERSHELL);
    expect(sidCall.args).toEqual(["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"]);
    expect(sidCall.opts).toMatchObject({ windowsHide: true });

    expect(adminCall.exe).toBe(POWERSHELL);
    expect(adminCall.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    const outer = decodeEncoded(adminCall.args);
    expect(outer).toContain("-Verb RunAs");
    const bootstrap = innerBootstrap(outer);
    expect(bootstrap).toContain(`$f = '${path.join(ASSETS, "install.ps1")}'`);
    expect(bootstrap).toContain(`$want = '${HELPER_ASSET_SHA256["install.ps1"]}'`);
    expect(bootstrap).toContain(`  Source = '${path.join(ASSETS, "FlowshipUnlockHelper.cs")}'`);
    expect(bootstrap).toContain(`  SourceSha = '${HELPER_ASSET_SHA256["FlowshipUnlockHelper.cs"]}'`);
    expect(bootstrap).toContain(`  Sid = '${SID}'`);
    expect(fx.status).toHaveBeenCalled();
    expect(fx.logs).toEqual(["[desktop] 解锁组件已安装"]);
  });

  it("组件要过一会儿才就绪：轮询（每 500ms 一次）直到连得上", async () => {
    const fx = makeInstaller({ exeExists: true, status: statusSequence("down", "down", "ok") });
    await expect(fx.installer.install()).resolves.toEqual({ ok: true });
    expect(fx.status).toHaveBeenCalledTimes(3);
    expect(fx.sleep.mock.calls.map((c) => c[0])).toEqual([500, 500]);
  });

  it("升级：旧版组件在运行（版本对不上）时再次安装，等到新版就绪才算成功", async () => {
    const fx = makeInstaller({ exeExists: true, status: statusSequence("old", "ok") });
    await expect(fx.installer.install()).resolves.toEqual({ ok: true });
  });

  it("接受 Azure AD 账户的 SID；SID 输出带 CRLF / 空白也行", async () => {
    const aad = "S-1-12-1-1111111111-2222222222-3333333333-4444444444";
    const fx = makeInstaller({ exeExists: true, decide: (c) => (isSidCall(c) ? { stdout: `  ${aad} \r\n`, code: 0 } : { code: 0 }) });
    await expect(fx.installer.install()).resolves.toEqual({ ok: true });
    expect(innerBootstrap(decodeEncoded(fx.calls[1].args))).toContain(`Sid = '${aad}'`);
  });
});

describe("install：提权之前的把关（任何一项不过都不会弹授权框）", () => {
  it("资源缺失 / 被改：直接返回原因，不读 SID、不提权", async () => {
    const missing = makeInstaller({ assetsDir: path.join(mkTmp(), "nope") });
    await expect(missing.installer.install()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("缺少") });
    expect(missing.spawn).not.toHaveBeenCalled();

    const tampered = makeInstaller({ assetsDir: copyAssets((n, b) => (n === ASSET_FILES.source ? Buffer.concat([b, Buffer.from("//x")]) : b)) });
    await expect(tampered.installer.install()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("对不上") });
    expect(tampered.spawn).not.toHaveBeenCalled();
  });

  const sidRejected = async (stdout: string, code = 0) => {
    const fx = makeInstaller({ decide: (c) => (isSidCall(c) ? { stdout, code } : { code: 0 }) });
    const r = await fx.installer.install();
    return { r, fx };
  };

  it("读不到 SID（PowerShell 失败 / 没输出 / 乱码）：不提权", async () => {
    for (const [stdout, code] of [["", 1], ["", 0], ["garbage", 0], [SID, 1]] as const) {
      const { r, fx } = await sidRejected(stdout, code);
      expect(r, `${stdout}/${code}`).toMatchObject({ ok: false, error: expect.stringContaining("读不到当前 Windows 账户") });
      expect(fx.spawn, `${stdout}/${code}`).toHaveBeenCalledTimes(1);
    }
  });

  it("不是普通用户账户的 SID（内置组 / 系统账户 / 段数不对 / 夹带命令）一律拒绝，不提权", async () => {
    const bad = [
      "S-1-5-32-544", // Administrators
      "S-1-5-32-545", // Users
      "S-1-1-0", // Everyone
      "S-1-5-18", // SYSTEM
      "S-1-5-11", // Authenticated Users
      "S-1-5-21-1-2-3", // 段数不够
      "S-1-5-21-1-2-3-4-5", // 段数太多
      `${SID}'; calc.exe; '`,
      `${SID}\nS-1-1-0`,
      `${SID} extra`,
    ];
    for (const sid of bad) {
      const { r, fx } = await sidRejected(sid);
      expect(r.ok, sid).toBe(false);
      expect(fx.spawn, sid).toHaveBeenCalledTimes(1);
    }
    expect(SID_RE.test(SID)).toBe(true);
    expect(SID_RE.test("S-1-12-1-1-2-3-4")).toBe(true);
  });

  it("读 SID 时 spawn 抛异常 / 子进程出错：同样不提权", async () => {
    const thrown = makeInstaller({ decide: () => ({ throws: new Error("ENOENT powershell") }) });
    await expect(thrown.installer.install()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("读不到当前 Windows 账户") });
    const errored = makeInstaller({ decide: () => ({ error: new Error("spawn failed") }) });
    await expect(errored.installer.install()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("读不到当前 Windows 账户") });
  });
});

describe("install：失败路径如实说原因", () => {
  const adminPlan = (plan: Plan) => (c: SpawnCall): Plan => (isSidCall(c) ? { stdout: SID, code: 0 } : plan);

  it("用户在授权框里点了「否」（1223）：说明白，不去等组件就绪，日志里只有退出码", async () => {
    const fx = makeInstaller({ decide: adminPlan({ code: ADMIN_EXIT.UAC_CANCELLED }) });
    const r = await fx.installer.install();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("选了「否」") });
    expect(fx.status).not.toHaveBeenCalled();
    expect(fx.logs).toEqual([`[desktop] 解锁组件安装失败（退出码 ${ADMIN_EXIT.UAC_CANCELLED}）`]);
  });

  it("安装过程中某一步失败（编译失败 14）：附上 install.log 里「失败（退出码…」那一行，不带其它行（账户名等）", async () => {
    const log = [
      "2026-11-21 10:00:00 开始安装。PowerShell 5.1.22621.4391，系统 Microsoft Windows NT 10.0.22631.0，64 位系统=True",
      "2026-11-21 10:00:00 登记账户：DESKTOP-ABC\\chen",
      "2026-11-21 10:00:03 源码校验通过",
      "2026-11-21 10:00:05 失败（退出码 14）：编译失败：error CS0246: 找不到类型",
      "",
    ].join("\r\n");
    const fx = makeInstaller({ decide: adminPlan({ code: ADMIN_EXIT.COMPILE_FAILED }), installLog: log });
    const r = await fx.installer.install();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(describeAdminExit(ADMIN_EXIT.COMPILE_FAILED));
    expect(r.error).toContain("失败（退出码 14）：编译失败：error CS0246: 找不到类型");
    expect(r.error).not.toContain("DESKTOP-ABC");
    expect(r.error).not.toContain("登记账户");
    expect(fx.readLog).toHaveBeenCalledWith(PATHS.installLog, "utf8");
  });

  it("install.log 读不了 / 里面没有失败那一行：只给基础说明", async () => {
    const unreadable = makeInstaller({ decide: adminPlan({ code: ADMIN_EXIT.COMPILE_FAILED }), installLog: new Error("EACCES") });
    expect((await unreadable.installer.install()).error).toBe(describeAdminExit(ADMIN_EXIT.COMPILE_FAILED));
    const noLine = makeInstaller({ decide: adminPlan({ code: ADMIN_EXIT.COMPILE_FAILED }), installLog: "2026 开始安装\r\n2026 源码校验通过\r\n" });
    expect((await noLine.installer.install()).error).toBe(describeAdminExit(ADMIN_EXIT.COMPILE_FAILED));
  });

  it("日志里的失败行很长：截断到 500 字符", async () => {
    const line = `2026-11-21 10:00:05 失败（退出码 14）：${"x".repeat(2000)}`;
    const fx = makeInstaller({ decide: adminPlan({ code: ADMIN_EXIT.COMPILE_FAILED }), installLog: line });
    const r = await fx.installer.install();
    expect(r.error).toContain("x".repeat(400));
    expect(r.error).not.toContain("x".repeat(600));
  });

  it("只有「安装过程中某一步失败」的退出码才去读日志（脚本哈希不符 / 被取消等不读）", async () => {
    for (const code of [ADMIN_EXIT.BOOTSTRAP_HASH, ADMIN_EXIT.UAC_CANCELLED, ADMIN_EXIT.OUTER_FAILED, ADMIN_EXIT.NOT_ADMIN, ADMIN_EXIT.LANGUAGE_MODE]) {
      const fx = makeInstaller({ decide: adminPlan({ code }), installLog: "2026 失败（退出码 14）：不该被读到" });
      const r = await fx.installer.install();
      expect(r.error, String(code)).toBe(describeAdminExit(code));
      expect(fx.readLog, String(code)).not.toHaveBeenCalled();
    }
  });

  it("不认识的退出码 / 没有退出码（被信号结束）：兜底说明", async () => {
    const odd = makeInstaller({ decide: adminPlan({ code: 77 }) });
    expect((await odd.installer.install()).error).toContain("77");
    const none = makeInstaller({ decide: adminPlan({ code: null }) });
    expect((await none.installer.install()).error).toContain("中断");
  });

  it("起不来 PowerShell（spawn 抛 / 子进程 error）：说明没能启动", async () => {
    const thrown = makeInstaller({ decide: (c) => (isSidCall(c) ? { stdout: SID, code: 0 } : { throws: new Error("EPERM") }) });
    expect((await thrown.installer.install()).error).toContain("没能启动 PowerShell：EPERM");
    const errored = makeInstaller({ decide: adminPlan({ error: new Error("spawn UNKNOWN") }) });
    expect((await errored.installer.install()).error).toContain("没能启动 PowerShell：spawn UNKNOWN");
  });

  it("等授权框 / 安装太久（默认 5 分钟）：结束进程，说明等了多久", async () => {
    vi.useFakeTimers();
    const fx = makeInstaller({ decide: adminPlan({ hang: true }) });
    const pending = fx.installer.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(ADMIN_TIMEOUT_MS);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("等了 5 分钟") });
    expect(fx.children[1].kill).toHaveBeenCalled();
  });

  it("脚本说装好了，但管道一直连不上：如实说，带上最后一次探测的原因", async () => {
    const fx = makeInstaller({ exeExists: true, status: statusSequence("down") });
    const r = await fx.installer.install();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("安装脚本报告成功，但连不上解锁组件");
    expect(r.error).toContain("没有在运行");
    expect(fx.logs).toEqual(["[desktop] 解锁组件安装脚本成功，但连不上组件"]);
  });

  it("命令行太长（Flowship 装在异常深的路径下）：不去启动提权进程", async () => {
    const longDir = `/${"a".repeat(9000)}`;
    const fx = makeInstaller({
      assetsDir: longDir,
      readFileSync: (file) => fs.readFileSync(path.join(ASSETS, path.basename(file))),
    });
    const r = await fx.installer.install();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("命令太长") });
    expect(fx.spawn).toHaveBeenCalledTimes(1); // 只读了 SID
  });
});

describe("install / uninstall 互斥：同一时间只处理一个请求", () => {
  it("第一个还没结束时，再来 install / uninstall 立刻被拒；结束后又能用", async () => {
    const fx = makeInstaller({ exeExists: false, decide: (c, i) => (i === 0 && isSidCall(c) ? { hang: true } : isSidCall(c) ? { stdout: SID, code: 0 } : { code: 0 }) });
    const first = fx.installer.install();
    await vi.waitFor(() => expect(fx.children).toHaveLength(1));
    await expect(fx.installer.install()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("正在处理") });
    await expect(fx.installer.uninstall()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("正在处理") });
    expect(fx.spawn).toHaveBeenCalledTimes(1);

    // 放行第一个（读到 SID → 提权脚本成功 → 但 exe 不存在 → 探测不到组件）
    fx.children[0].stdout.emit("data", SID);
    fx.children[0].emit("close", 0);
    const r = await first;
    expect(r.ok).toBe(false); // exe 不存在，waitReady 超时

    await expect(fx.installer.uninstall()).resolves.toEqual({ ok: true });
  });
});

// ───────────────────────── 卸载 ─────────────────────────

describe("uninstall", () => {
  it("提权跑 uninstall.ps1（没有任何参数）；脚本成功且 exe 已经没了 → 成功", async () => {
    const fx = makeInstaller({ exeExists: false });
    await expect(fx.installer.uninstall()).resolves.toEqual({ ok: true });
    expect(fx.spawn).toHaveBeenCalledTimes(1); // 卸载不需要读 SID
    const outer = decodeEncoded(fx.calls[0].args);
    expect(outer).toContain("-Verb RunAs");
    const bootstrap = innerBootstrap(outer);
    expect(bootstrap).toContain(`$f = '${path.join(ASSETS, "uninstall.ps1")}'`);
    expect(bootstrap).toContain(`$want = '${HELPER_ASSET_SHA256["uninstall.ps1"]}'`);
    expect(bootstrap).toContain("$params = @{\n}");
    expect(bootstrap).not.toContain("Sid");
    expect(fx.logs).toEqual(["[desktop] 解锁组件已卸载"]);
  });

  it("脚本说成功了但程序文件还在：提示重启电脑后再试", async () => {
    const fx = makeInstaller({ exeExists: true });
    const r = await fx.installer.uninstall();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("重启电脑") });
  });

  it("资源缺失（装坏了的 Flowship）：不提权，给出手动卸载的办法", async () => {
    const fx = makeInstaller({ assetsDir: path.join(mkTmp(), "nope") });
    const r = await fx.installer.uninstall();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("任务计划程序");
    expect(r.error).toContain("Flowship\\Flowship Unlock Helper");
    expect(r.error).toContain(PATHS.installDir);
    expect(r.error).toContain(PATHS.dataDir);
    expect(fx.spawn).not.toHaveBeenCalled();
  });

  it("授权框点了「否」/ 目录删不干净（32）：如实说；卸载失败不去读 install.log", async () => {
    const cancelled = makeInstaller({ decide: () => ({ code: ADMIN_EXIT.UAC_CANCELLED }) });
    expect((await cancelled.installer.uninstall()).error).toContain("选了「否」");
    const busy = makeInstaller({ decide: () => ({ code: ADMIN_EXIT.REMOVE_DIR_FAILED }), installLog: "2026 失败（退出码 14）：不该被读到" });
    const r = await busy.installer.uninstall();
    expect(r.error).toBe(describeAdminExit(ADMIN_EXIT.REMOVE_DIR_FAILED));
    expect(busy.readLog).not.toHaveBeenCalled();
    expect(busy.logs).toEqual([`[desktop] 解锁组件卸载失败（退出码 ${ADMIN_EXIT.REMOVE_DIR_FAILED}）`]);
  });
});

describe("日志隐私", () => {
  it("安装 / 卸载（成功和失败）写的日志里没有账户 SID、路径、脚本内容", async () => {
    const all: string[] = [];
    const ok = makeInstaller({ exeExists: true });
    await ok.installer.install();
    all.push(...ok.logs);
    const fail = makeInstaller({ decide: (c) => (isSidCall(c) ? { stdout: SID, code: 0 } : { code: ADMIN_EXIT.COMPILE_FAILED }), installLog: `失败（退出码 14）：${SID}` });
    await fail.installer.install();
    all.push(...fail.logs);
    const un = makeInstaller({ exeExists: false });
    await un.installer.uninstall();
    all.push(...un.logs);
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const line of all) {
      expect(line).not.toContain(SID);
      expect(line).not.toContain("Program Files");
      expect(line).not.toContain(".ps1");
      expect(line).not.toContain(ASSETS);
    }
  });
});
