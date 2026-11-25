/**
 * 用真正的 PowerShell 验证 Windows 解锁组件里的几段 PowerShell。
 *
 * 为什么要有这一组：install.ps1 / uninstall.ps1 和安装器生成的「外层 / 引导」脚本，是以管理员身份运行的，
 * 写错一个符号就是「装不上」或者更糟——而开发机是 macOS，没法在 Windows 上跑它们。
 * PowerShell 7（pwsh）有 macOS / Linux 版，能做三件有价值的事：
 *   1. 语法：用官方 Parser 解析每一个脚本，确认没有语法错误，也没有只在 PowerShell 7 才有的语法（目标是 Windows PowerShell 5.1）。
 *   2. 引导脚本的语义：「哈希对得上才执行 / 对不上一律 90 / 文件被改过、缺失、语法错误都不执行 / 参数值只当字面量」，
 *      这是整个提权链条的安全闸门，必须真跑。
 *   3. Remove-Tree 的关键性质：遇到符号链接只删链接、不进到目标里（防止「预先在目录里放个链接，让管理员脚本去删别处」）。
 *
 * 本机没有 pwsh 时「需要 pwsh」的整组跳过（不算失败，并打印一行提示）。本机想跑：把 PowerShell 7 解压后
 * `FLOWSHIP_PWSH=/path/to/pwsh pnpm test`。
 * CI 里不允许跳过：GitHub Actions 的 ubuntu runner 预装了 pwsh，发版流水线（ci.yml 门禁）上会真跑；万一哪天镜像里没有了，
 * 下面「CI 里必须找得到 pwsh」那条会红，而不是让 24 条真 PowerShell 用例静默跳过、门禁绿了却什么都没验过（第二轮评审）。
 *
 * 局限：pwsh 7 不是 Windows PowerShell 5.1，也不是 Windows。需要 Windows 才有的东西（ACL、计划任务、UAC、Winlogon 桌面）
 * 这里验证不了，那部分在 docs/windows-unlock-live-test.md 的 Windows 实测清单里，由同事在真机上过。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ASSET_FILES, assetSha256 } from "../electron-app/desktop/win-helper/protocol.mjs";
import { buildBootstrapScript, buildOuterScript, SID_RE } from "../electron-app/desktop/win-helper/installer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "electron-app", "desktop", "win-helper", "assets");
const INSTALL_PS1 = path.join(ASSETS, ASSET_FILES.install);
const UNINSTALL_PS1 = path.join(ASSETS, ASSET_FILES.uninstall);

const tmpDirs: string[] = [];
const mkTmp = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flowship-pwsh-${name}-`));
  tmpDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────── 找 pwsh ─────────────────────────

const PWSH_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  // 自包含的 pwsh 不需要 ICU；遥测 / 更新检查全关，免得测试里联网
  DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  POWERSHELL_TELEMETRY_OPTOUT: "1",
  POWERSHELL_UPDATECHECK: "Off",
};

const findPwsh = (): string | null => {
  const candidates = [process.env.FLOWSHIP_PWSH, "pwsh"].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
      timeout: 30_000,
      env: PWSH_ENV,
    });
    if (r.status === 0 && /^\d+$/.test(r.stdout.trim())) return candidate;
  }
  return null;
};

const PWSH = findPwsh();
const pwsh = (): string => PWSH as string;

if (PWSH === null && !process.env.CI) {
  console.warn(
    "[skip] 没找到 pwsh（PowerShell 7）：本文件里需要真 PowerShell 的用例（脚本语法 / 引导脚本哈希闸门 / Remove-Tree 等）将被跳过（本地）。" +
      "想跑：解压 PowerShell 7 后设 FLOWSHIP_PWSH=/path/to/pwsh",
  );
}

// 跳过只允许发生在本机：CI 的门禁绿了就意味着「这些用例真跑过」
describe("真 PowerShell 可用性（CI 门禁）", () => {
  it.skipIf(!process.env.CI)("CI 里必须找得到 pwsh：缺了就红，不让需要真 PowerShell 的用例静默跳过", () => {
    expect(
      PWSH,
      "CI 环境里找不到 pwsh（PowerShell 7）：本文件里需要真 PowerShell 的用例会被整组跳过，门禁就成了「绿但什么都没验」。" +
        "请在 CI 里安装 pwsh（GitHub 的 ubuntu runner 默认预装），或用 FLOWSHIP_PWSH 指向它",
    ).not.toBeNull();
  });
});

/** 只是「要额外塞给子进程的环境变量」：不用 NodeJS.ProcessEnv——本项目的类型扩展把 NODE_ENV 声明成了必填 */
type EnvVars = Record<string, string | undefined>;

const runFile = (file: string, args: string[] = [], extraEnv: EnvVars = {}) =>
  spawnSync(pwsh(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
    encoding: "utf8",
    timeout: 45_000,
    env: { ...PWSH_ENV, ...extraEnv },
  });

/** 把一段 PowerShell 写进临时文件（不用 -Command：避开命令行转义） */
const writeScript = (dir: string, name: string, text: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

// ───────────────────────── 不需要 pwsh 的静态检查 ─────────────────────────

describe("PowerShell 脚本：Windows PowerShell 5.1 兼容（静态）", () => {
  // 目标运行环境是 Windows 自带的 PowerShell 5.1，这些是 PowerShell 6/7 才有的参数 / 语法
  const PS7_ONLY = [
    /-AsByteStream\b/,
    /-AdditionalChildPath\b/,
    /-AsHashtable\b/,
    /-Parallel\b/,
    /-ThrottleLimit\b/,
    /-SkipHttpErrorCheck\b/,
    /\$IsWindows\b/,
    /\$IsLinux\b/,
    /\$IsMacOS\b/,
  ];

  for (const file of [INSTALL_PS1, UNINSTALL_PS1]) {
    it(`${path.basename(file)} 没有用 PowerShell 6/7 才有的参数 / 变量`, () => {
      const text = fs.readFileSync(file, "utf8");
      for (const re of PS7_ONLY) expect(text, String(re)).not.toMatch(re);
    });
  }

  it("引导 / 外层脚本也没有", () => {
    const boot = buildBootstrapScript({ scriptPath: "C:\\x\\install.ps1", scriptSha256: "A".repeat(64), params: { Sid: "S-1-5-21-1-2-3-4" } });
    const outer = buildOuterScript(boot);
    for (const text of [boot, outer]) for (const re of PS7_ONLY) expect(text, String(re)).not.toMatch(re);
  });
});

// ───────────────────────── 需要 pwsh 的验证 ─────────────────────────

const describeWithPwsh = describe.skipIf(PWSH === null);
// 创建符号链接在 Windows 上需要特权，Remove-Tree 那一组只在 macOS / Linux 上跑
const describeWithPwshPosix = describe.skipIf(PWSH === null || process.platform === "win32");

describeWithPwsh("PowerShell 脚本：用官方 Parser 解析（语法）", () => {
  const PARSE_PS1 = [
    "param([string]$ListFile)",
    "$ErrorActionPreference = 'Stop'",
    "$ps7Kinds = @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr')",
    "$items = @()",
    "foreach ($f in (Get-Content -LiteralPath $ListFile)) {",
    "  if (-not $f) { continue }",
    "  $tokens = $null",
    "  $errors = $null",
    "  $ast = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)",
    "  $ps7 = @()",
    "  foreach ($t in $tokens) { if ($ps7Kinds -contains [string]$t.Kind) { $ps7 += [string]$t.Kind } }",
    "  foreach ($n in $ast.FindAll({ param($x) $x.GetType().Name -match 'Ternary|PipelineChain' }, $true)) { $ps7 += $n.GetType().Name }",
    "  $msgs = @()",
    "  foreach ($e in $errors) { $msgs += ('L' + $e.Extent.StartLineNumber + ': ' + $e.Message) }",
    "  $items += [pscustomobject]@{ file = $f; errors = $msgs; ps7 = $ps7 }",
    "}",
    "ConvertTo-Json -InputObject @($items) -Depth 4 -Compress",
    "",
  ].join("\n");

  it("install.ps1 / uninstall.ps1 / 引导 / 外层：没有语法错误，也没有 PowerShell 7 才有的语法", () => {
    const dir = mkTmp("parse");
    const params = { Source: "C:\\Program Files\\Flowship\\unlock\\FlowshipUnlockHelper.cs", SourceSha: "AB".repeat(32), Sid: "S-1-5-21-1-2-3-1001" };
    const bootInstall = buildBootstrapScript({ scriptPath: "C:\\Program Files\\Flowship\\resources\\win-helper\\install.ps1", scriptSha256: "CD".repeat(32), params });
    const bootUninstall = buildBootstrapScript({ scriptPath: "C:\\Program Files\\Flowship\\resources\\win-helper\\uninstall.ps1", scriptSha256: "EF".repeat(32) });
    // 路径里带各种单引号也要能解析（psQuote 的转义是否真的成立）
    const bootQuirky = buildBootstrapScript({
      scriptPath: "C:\\Users\\O'Brien \u2018x\u2019 \u201a\u201b\\install.ps1",
      scriptSha256: "01".repeat(32),
      params: { Sid: "S-1-5-21-1-2-3-1001" },
    });
    const files = [
      INSTALL_PS1,
      UNINSTALL_PS1,
      writeScript(dir, "boot-install.ps1", bootInstall),
      writeScript(dir, "boot-uninstall.ps1", bootUninstall),
      writeScript(dir, "boot-quirky.ps1", bootQuirky),
      writeScript(dir, "outer.ps1", buildOuterScript(bootInstall)),
    ];
    const list = writeScript(dir, "files.txt", files.join("\n"));
    const parser = writeScript(dir, "parse.ps1", PARSE_PS1);
    const r = runFile(parser, ["-ListFile", list]);
    expect(r.status, r.stderr).toBe(0);
    const results = JSON.parse(r.stdout.trim()) as Array<{ file: string; errors: string[]; ps7: string[] }>;
    expect(results.map((x) => path.basename(x.file))).toEqual(files.map((f) => path.basename(f)));
    for (const x of results) {
      expect(x.errors, `${path.basename(x.file)} 的语法错误`).toEqual([]);
      expect(x.ps7, `${path.basename(x.file)} 里的 PowerShell 7 语法`).toEqual([]);
    }
  }, 60_000);

  it("Parser 确实能抓到错误（防止上面的检查形同虚设）", () => {
    const dir = mkTmp("parse-bad");
    const bad = writeScript(dir, "bad.ps1", "if ($true) {\n  Write-Output 'x'\n");
    const tern = writeScript(dir, "tern.ps1", "$x = $true ? 1 : 2\n");
    const list = writeScript(dir, "files.txt", [bad, tern].join("\n"));
    const parser = writeScript(dir, "parse.ps1", PARSE_PS1);
    const r = runFile(parser, ["-ListFile", list]);
    expect(r.status, r.stderr).toBe(0);
    const results = JSON.parse(r.stdout.trim()) as Array<{ errors: string[]; ps7: string[] }>;
    expect(results[0].errors.length).toBeGreaterThan(0);
    expect(results[1].ps7.length).toBeGreaterThan(0);
  }, 60_000);
});

describeWithPwsh("引导脚本：哈希对得上才执行（提权链条的安全闸门）", () => {
  const PAYLOAD = [
    "param([string]$Source, [string]$SourceSha, [string]$Sid)",
    "Write-Output ('ran:' + $Source + '|' + $SourceSha + '|' + $Sid)",
    "exit 42",
    "",
  ].join("\n");
  const PARAMS = { Source: "C:\\a b\\x.cs", SourceSha: "AB".repeat(32), Sid: "S-1-5-21-1-2-3-1001" };

  /**
   * 在临时目录里写好 payload（disk=null 表示不创建文件）、生成引导脚本（期望哈希按 hashOf 算）、用 pwsh 运行
   */
  const runBootstrap = (opts: { disk: string | Buffer | null; hashOf?: string; dirName?: string; params?: Record<string, string>; env?: EnvVars }) => {
    const base = mkTmp("boot");
    const dir = opts.dirName ? path.join(base, opts.dirName) : base;
    fs.mkdirSync(dir, { recursive: true });
    const scriptPath = path.join(dir, "payload.ps1");
    if (opts.disk !== null) fs.writeFileSync(scriptPath, opts.disk);
    const hashSource = opts.hashOf ?? (typeof opts.disk === "string" ? opts.disk : opts.disk?.toString("utf8")) ?? "";
    const bootstrap = buildBootstrapScript({
      scriptPath,
      scriptSha256: assetSha256(Buffer.from(hashSource, "utf8")),
      params: opts.params ?? PARAMS,
    });
    return runFile(writeScript(base, "bootstrap.ps1", bootstrap), [], opts.env);
  };

  it("哈希对得上：执行脚本，参数原样传入，脚本的 exit 码就是进程退出码", () => {
    const r = runBootstrap({ disk: PAYLOAD });
    expect(r.status, r.stderr).toBe(42);
    expect(r.stdout).toContain(`ran:${PARAMS.Source}|${PARAMS.SourceSha}|${PARAMS.Sid}`);
  }, 60_000);

  it("文件被改过哪怕一个字节：退出码 90，脚本一行都没执行", () => {
    const r = runBootstrap({ disk: PAYLOAD.replace("exit 42", "exit 43"), hashOf: PAYLOAD });
    expect(r.status, r.stderr).toBe(90);
    expect(r.stdout).not.toContain("ran:");
  }, 60_000);

  it("文件不存在：退出码 90", () => {
    const r = runBootstrap({ disk: null, hashOf: PAYLOAD });
    expect(r.status, r.stderr).toBe(90);
    expect(r.stdout).not.toContain("ran:");
  }, 60_000);

  it("换行被 git 转成 CRLF：规范化之后哈希照样对得上", () => {
    const r = runBootstrap({ disk: PAYLOAD.replace(/\n/g, "\r\n"), hashOf: PAYLOAD });
    expect(r.status, r.stderr).toBe(42);
    expect(r.stdout).toContain("ran:");
  }, 60_000);

  it("文件带 UTF-8 BOM（有些编辑器会加）：规范化之后哈希照样对得上", () => {
    const r = runBootstrap({ disk: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PAYLOAD, "utf8")]), hashOf: PAYLOAD });
    expect(r.status, r.stderr).toBe(42);
    expect(r.stdout).toContain("ran:");
  }, 60_000);

  it("哈希对得上但脚本有语法错误：退出码 90（不执行）", () => {
    const bad = "param(\nif (";
    const r = runBootstrap({ disk: bad });
    expect(r.status, r.stderr).toBe(90);
  }, 60_000);

  it("脚本意外地没有 exit 就返回：兜底按失败处理（80），不能当成功", () => {
    const r = runBootstrap({ disk: "Write-Output 'finished without exit'\n" });
    expect(r.status, r.stderr).toBe(80);
    expect(r.stdout).toContain("finished without exit");
  }, 60_000);

  it("脚本里 try 里 exit：不会被 catch 吞掉（install.ps1 的 Fail 依赖这一点）", () => {
    const r = runBootstrap({ disk: "try { exit 33 } catch { exit 99 }\n" });
    expect(r.status, r.stderr).toBe(33);
  }, 60_000);

  it("脚本里普通异常能被它自己的 catch 接住", () => {
    const r = runBootstrap({ disk: "try { throw 'boom' } catch { exit 44 }\n" });
    expect(r.status, r.stderr).toBe(44);
  }, 60_000);

  it("脚本抛出没人接的异常：进程以非零退出，绝不是 0", () => {
    const r = runBootstrap({ disk: "throw 'boom'\n" });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
  }, 60_000);

  it("路径里有单引号、弯引号和空格：照样找得到文件并执行（psQuote 的转义成立）", () => {
    const r = runBootstrap({ disk: PAYLOAD, dirName: "O'Brien \u2018x\u2019 y" });
    expect(r.status, r.stderr).toBe(42);
    expect(r.stdout).toContain("ran:");
  }, 60_000);

  it("参数值是注入载荷：只当字面量，不会被执行或展开", () => {
    const evil = {
      Source: "$(exit 5)",
      SourceSha: "AB".repeat(32),
      Sid: "S-1-5-21-1-2-3-1001'; exit 0; '",
    };
    const r = runBootstrap({ disk: PAYLOAD, params: evil });
    // 如果载荷被执行了，退出码会是 5 或 0；字面量传入则是脚本自己的 42
    expect(r.status, r.stderr).toBe(42);
    expect(r.stdout).toContain(`ran:${evil.Source}|${evil.SourceSha}|${evil.Sid}`);
  }, 60_000);

  // ───── 纵深防御：提权进程继承来的 PSModulePath / .NET 钩子类环境变量，不能传给被执行的脚本 ─────
  // 哈希校验只保护「脚本文本」；提权进程还会从 PSModulePath 按需加载模块、在 CLR 启动时读 COR_* / COMPlus_* / DOTNET_* ——这些是同一账户能预先布置的输入。

  describe("提权进程的环境（PSModulePath / .NET 钩子类变量）", () => {
    // 变量名刻意取「匹配前缀、但运行时本身不认」的：真设成 COR_PROFILER / DOTNET_STARTUP_HOOKS 会让 pwsh 自己出问题
    const HOOK_VARS: Record<string, string> = {
      COR_FLOWSHIP_TEST_MARK: "hook-1",
      CORECLR_FLOWSHIP_TEST_MARK: "hook-2",
      COMPlus_FlowshipTestMark: "hook-3",
      complus_flowship_test_lower: "hook-4", // 小写：-match 不分大小写，Windows 的环境变量名本来也不分
      DOTNET_FLOWSHIP_TEST_MARK: "hook-5",
    };
    const KEEP_VARS: Record<string, string> = {
      CORPORATE_FLOWSHIP_TEST: "keep-1", // 以 COR 开头，但不是 COR_
      DOTNETFLOWSHIPTEST: "keep-2", // 以 DOTNET 开头，但没有下划线
      FLOWSHIP_TEST_KEEP: "keep-3",
    };
    const ALL_NAMES = [...Object.keys(HOOK_VARS), ...Object.keys(KEEP_VARS)];
    const PRINT_ENV = [
      `$names = @(${ALL_NAMES.map((n) => `'${n}'`).join(", ")})`,
      "foreach ($n in $names) { Write-Output ($n + '=[' + [Environment]::GetEnvironmentVariable($n) + ']') }",
    ];
    const parsePrinted = (stdout: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^([A-Za-z_]+)=\[(.*)\]$/.exec(line);
        if (m) out[m[1]] = m[2];
      }
      return out;
    };

    it("引导：先清掉 COR_ / CORECLR_ / COMPlus_ / DOTNET_ 开头的变量，再执行脚本；别的（包括名字长得像的）原样保留", () => {
      const r = runBootstrap({ disk: [...PRINT_ENV, "exit 0", ""].join("\n"), params: {}, env: { ...HOOK_VARS, ...KEEP_VARS } });
      expect(r.status, r.stderr).toBe(0);
      const seen = parsePrinted(r.stdout);
      for (const name of Object.keys(HOOK_VARS)) expect(seen[name], `${name} 应当被清掉`).toBe("");
      for (const [name, value] of Object.entries(KEEP_VARS)) expect(seen[name], `${name} 不该被清`).toBe(value);
    }, 60_000);

    it("对照组：不经引导直接跑同一段脚本，这些变量确实都在（说明上面的「被清掉」是引导做的，不是测试环境没把变量传进去）", () => {
      const dir = mkTmp("env-control");
      const file = writeScript(dir, "print.ps1", [...PRINT_ENV, "exit 0", ""].join("\n"));
      const r = runFile(file, [], { ...HOOK_VARS, ...KEEP_VARS });
      expect(r.status, r.stderr).toBe(0);
      const seen = parsePrinted(r.stdout);
      for (const [name, value] of Object.entries({ ...HOOK_VARS, ...KEEP_VARS })) expect(seen[name], name).toBe(value);
    }, 60_000);

    it("外层：提权之前同样先清一遍（提权进程默认继承外层的环境）——跑外层脚本里「清环境」那一段", () => {
      const outer = buildOuterScript(buildBootstrapScript({ scriptPath: "C:\\x\\install.ps1", scriptSha256: "A".repeat(64) }));
      // 外层 try { 之前就是「设错误策略 + 清环境」；接上打印，真跑一遍（try 之后是 Windows 专用的 Start-Process，这里跑不了）
      const preamble = outer.slice(0, outer.indexOf("try {"));
      expect(preamble).toContain("SetEnvironmentVariable");
      const dir = mkTmp("outer-preamble");
      const file = writeScript(dir, "outer-preamble.ps1", [preamble, ...PRINT_ENV, "exit 0", ""].join("\n"));
      const r = runFile(file, [], { ...HOOK_VARS, ...KEEP_VARS });
      expect(r.status, r.stderr).toBe(0);
      const seen = parsePrinted(r.stdout);
      for (const name of Object.keys(HOOK_VARS)) expect(seen[name], `${name} 应当被清掉`).toBe("");
      for (const [name, value] of Object.entries(KEEP_VARS)) expect(seen[name], `${name} 不该被清`).toBe(value);
    }, 60_000);

    /** 在 evil 目录里放一个模块，导出 Invoke-FlowshipHijackProbe（被调用就写标记文件） */
    const plantHijackModule = () => {
      const evil = mkTmp("evil-modules");
      const moduleDir = path.join(evil, "FlowshipHijackProbe");
      fs.mkdirSync(moduleDir, { recursive: true });
      const marker = path.join(evil, "hijacked.txt");
      const fn = `function Invoke-FlowshipHijackProbe { Set-Content -LiteralPath '${marker}' -Value 'hijacked'; Write-Output 'probe-ran' }`;
      fs.writeFileSync(path.join(moduleDir, "FlowshipHijackProbe.psm1"), `${fn}\nExport-ModuleMember -Function Invoke-FlowshipHijackProbe\n`);
      fs.writeFileSync(
        path.join(moduleDir, "FlowshipHijackProbe.psd1"),
        "@{ RootModule = 'FlowshipHijackProbe.psm1'; ModuleVersion = '1.0'; FunctionsToExport = @('Invoke-FlowshipHijackProbe') }\n",
      );
      // PSModulePath 里用户可写的目录排在最前面（和默认的 Documents\WindowsPowerShell\Modules 同一个位置关系）
      const polluted = { PSModulePath: [evil, process.env.PSModulePath ?? ""].filter(Boolean).join(path.delimiter) };
      return { marker, polluted };
    };
    const PROBE_PAYLOAD = "try { Invoke-FlowshipHijackProbe | Write-Output; exit 0 } catch { Write-Output 'probe-not-found'; exit 55 }\n";

    it("对照组：PSModulePath 里有同名模块，不经引导直接跑——按需加载会把它找出来并执行（说明这个攻击面是真的）", () => {
      const { marker, polluted } = plantHijackModule();
      const dir = mkTmp("hijack-control");
      const r = runFile(writeScript(dir, "probe.ps1", PROBE_PAYLOAD), [], polluted);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("probe-ran");
      expect(fs.existsSync(marker)).toBe(true);
    }, 60_000);

    it("引导钉死模块搜索路径：同样的环境、同样的脚本，同名模块找不到、不会被执行", () => {
      const { marker, polluted } = plantHijackModule();
      const r = runBootstrap({ disk: PROBE_PAYLOAD, params: {}, env: polluted });
      expect(r.status, r.stderr + r.stdout).toBe(55);
      expect(r.stdout).toContain("probe-not-found");
      expect(r.stdout).not.toContain("probe-ran");
      expect(fs.existsSync(marker)).toBe(false);
    }, 60_000);

    it("钉死之后 PowerShell 自带的、要按需加载的模块照样能用（钉到了真正装着内置模块的目录）", () => {
      const payload = [
        // 引导脚本把 $ErrorActionPreference 设成了 Stop。本文件拿 PowerShell 7 当代理（目标是 Windows PowerShell 5.1），而 PWSH_ENV 为了让自包含的
        // pwsh 在没装 ICU 的机器上也能起来，设了 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1：invariant 模式下 pwsh 7 加载带本地化资源（en-US）的模块时
        // 会抛一个**非终止**的 CultureNotFoundException（"Only the invariant culture is supported"），默认的 Continue 偏好把它吞了、命令照样找到，
        // 引导的 Stop 偏好却把它升级成终止错误、命令发现中断，报「找不到 Compress-Archive」（第四轮评审要求在真 pwsh 上跑这些用例时才暴露）。
        // 这是代理环境的伪影——5.1 / .NET Framework 没有 invariant 模式——和被测的「钉死模块路径」无关，所以这条用例的 payload 把偏好调回 Continue。
        // 实测（macOS + pwsh 7.5.4）：只写局部的 `$ErrorActionPreference = 'Continue'` 压不住（命令发现读不到脚本块的局部变量），写 `$global:`（或 `$script:`）才有效；
        // 只给 Get-Command 加 -ErrorAction SilentlyContinue、或先 Import-Module 都不行。
        // 钉死那一行仍由引导执行，下面的 pinned= 断言照样检查它；引导里删掉钉死、或钉错目录，这条用例照样红
        "$global:ErrorActionPreference = 'Continue'",
        "$pinned = ($env:PSModulePath -eq [IO.Path]::Combine($PSHOME, 'Modules'))",
        "Write-Output ('pinned=' + $pinned)",
        // Microsoft.PowerShell.Archive 不是预加载的核心模块，要靠 PSModulePath 现找（Windows PowerShell 5.1 的 ScheduledTasks / Security 同理，都在 $PSHOME\\Modules 下）
        "Write-Output ('found=' + (Get-Command Compress-Archive -ErrorAction Stop).Name)",
        "exit 0",
        "",
      ].join("\n");
      const r = runBootstrap({ disk: payload, params: {}, env: { PSModulePath: "/nonexistent-evil-dir" } });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("pinned=True");
      expect(r.stdout).toContain("found=Compress-Archive");
    }, 60_000);
  });
});

describeWithPwsh("正则：install.ps1 里的校验和 JS 里的口径一致", () => {
  /** 把 PowerShell 的 -cmatch 结果和 JS 的结果放在一起比（一次 pwsh 调用评估一批样本） */
  const evaluate = (pattern: string, samples: string[]): boolean[] => {
    const dir = mkTmp("regex");
    const samplesFile = writeScript(dir, "samples.json", JSON.stringify(samples));
    const script = writeScript(
      dir,
      "eval.ps1",
      [
        "param([string]$SamplesFile, [string]$Pattern)",
        "$ErrorActionPreference = 'Stop'",
        "$samples = [IO.File]::ReadAllText($SamplesFile, [Text.Encoding]::UTF8) | ConvertFrom-Json",
        "$out = @()",
        "foreach ($s in $samples) { $out += [bool]([string]$s -cmatch $Pattern) }",
        "ConvertTo-Json -InputObject @($out) -Compress",
        "",
      ].join("\n"),
    );
    const r = runFile(script, ["-SamplesFile", samplesFile, "-Pattern", pattern]);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim()) as boolean[];
  };

  /** 从 install.ps1 里把某个变量的校验正则抠出来（就是脚本真正在用的那一条） */
  const patternOf = (variable: string): string => {
    const text = fs.readFileSync(INSTALL_PS1, "utf8");
    const m = new RegExp(`\\$${variable} -cnotmatch '([^']+)'`).exec(text);
    if (!m) throw new Error(`install.ps1 里找不到 $${variable} 的校验正则`);
    return m[1];
  };

  it("账户 SID：合法的收、内置组 / 畸形的一律拒，PowerShell 和 JS 结论完全一致", () => {
    const samples: Array<[string, boolean]> = [
      ["S-1-5-21-1-2-3-1001", true],
      ["S-1-5-21-1111111111-2222222222-3333333333-1001", true],
      ["S-1-12-1-1-2-3-4", true],
      ["S-1-5-21-1-2-3-1001\n", false], // .NET 的 $ 会放过尾随换行，\z 不会
      ["S-1-5-21-1-2-3-1001\r\n", false],
      ["s-1-5-21-1-2-3-1001", false], // -match 默认不分大小写，-cmatch 分
      ["S-1-5-21-1-2-3-\u0661\u0660\u0660\u0661", false], // 阿拉伯-印度数字：\d 会放过，[0-9] 不会
      ["S-1-5-21-1-2-3-\uff11\uff10\uff10\uff11", false], // 全角数字
      ["S-1-5-21-1-2-3", false], // 段数不够
      ["S-1-5-21-1-2-3-4-5", false], // 段数过多
      ["S-1-5-32-544", false], // Administrators
      ["S-1-5-32-545", false], // Users
      ["S-1-1-0", false], // Everyone
      ["S-1-5-18", false], // SYSTEM
      [" S-1-5-21-1-2-3-4", false],
      ["S-1-5-21-1-2-3-4 ", false],
      ["S-1-5-21-1-2-3-4'", false],
      ["S-1-5-21-1-2-3-4; exit 0", false],
      ["", false],
    ];
    const psPattern = patternOf("Sid");
    // 对账：脚本里的正则 = JS 的 SID_RE，只是末尾的 $ 换成 \z
    expect(psPattern).toBe(SID_RE.source.replace(/\$$/, "\\z"));
    const ps = evaluate(
      psPattern,
      samples.map(([s]) => s),
    );
    samples.forEach(([sample, expected], i) => {
      expect(SID_RE.test(sample), `JS：${JSON.stringify(sample)}`).toBe(expected);
      expect(ps[i], `PowerShell：${JSON.stringify(sample)}`).toBe(expected);
    });
  }, 60_000);

  it("源码哈希：只收 64 位十六进制，尾随换行 / 全角字母 / 长度不对都拒", () => {
    const hex = "0123456789abcdefABCDEF0123456789abcdefABCDEF0123456789abcdefABCD";
    expect(hex.length).toBe(64);
    const samples: Array<[string, boolean]> = [
      [hex, true],
      ["A".repeat(64), true],
      [hex + "\n", false],
      [hex.slice(1), false],
      [hex + "0", false],
      ["G" + hex.slice(1), false],
      ["\uff21" + hex.slice(1), false], // 全角 A
      ["", false],
    ];
    const psPattern = patternOf("SourceSha");
    const jsRe = new RegExp(psPattern.replace(/\\z$/, "$"));
    const ps = evaluate(
      psPattern,
      samples.map(([s]) => s),
    );
    samples.forEach(([sample, expected], i) => {
      expect(jsRe.test(sample), `JS：${JSON.stringify(sample)}`).toBe(expected);
      expect(ps[i], `PowerShell：${JSON.stringify(sample)}`).toBe(expected);
    });
    // 引导脚本生成器里那条同样严格（它只收 JS 正则，拒绝不合法的哈希）
    expect(() => buildBootstrapScript({ scriptPath: "C:\\x", scriptSha256: hex + "\n" })).toThrow();
  }, 60_000);
});

describeWithPwshPosix("Remove-Tree：遇到链接只删链接，绝不进到目标里", () => {
  const RUNNER_PS1 = [
    "param([string]$ScriptFile, [string]$TargetsFile)",
    "$ErrorActionPreference = 'Stop'",
    "Set-StrictMode -Version 2.0",
    "$tokens = $null",
    "$errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptFile, [ref]$tokens, [ref]$errors)",
    "$names = @('Test-Exists', 'Remove-Tree')",
    "$defs = $ast.FindAll({ param($n) ($n -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($names -contains $n.Name) }, $true)",
    "if (@($defs).Count -ne 2) { throw ('没有提取到 Test-Exists / Remove-Tree：' + @($defs).Count) }",
    "foreach ($d in $defs) { . ([ScriptBlock]::Create($d.Extent.Text)) }",
    "$items = @()",
    "foreach ($t in (Get-Content -LiteralPath $TargetsFile)) {",
    "  if (-not $t) { continue }",
    "  $before = Test-Exists $t",
    "  $err = ''",
    "  if ($before) { try { Remove-Tree $t } catch { $err = $_.Exception.Message } }",
    "  $items += [pscustomobject]@{ target = $t; before = $before; error = $err; after = (Test-Exists $t) }",
    "}",
    "ConvertTo-Json -InputObject @($items) -Depth 3 -Compress",
    "",
  ].join("\n");

  const buildFixture = () => {
    const base = mkTmp("tree");
    const victimDir = path.join(base, "victim-dir");
    fs.mkdirSync(path.join(victimDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(victimDir, "keep.txt"), "keep");
    fs.writeFileSync(path.join(victimDir, "nested", "keep2.txt"), "keep2");
    const victimFile = path.join(base, "victim-file.txt");
    fs.writeFileSync(victimFile, "keep");

    // 1. 普通的树：多层目录 + 只读文件
    const plain = path.join(base, "plain");
    fs.mkdirSync(path.join(plain, "sub", "deep"), { recursive: true });
    fs.writeFileSync(path.join(plain, "a.txt"), "a");
    fs.writeFileSync(path.join(plain, "sub", "deep", "b.txt"), "b");
    fs.chmodSync(path.join(plain, "a.txt"), 0o444);

    // 2. 树里藏着指向外部目录 / 文件的链接（攻击者预先放进去的）
    const withLinks = path.join(base, "with-links");
    fs.mkdirSync(path.join(withLinks, "sub"), { recursive: true });
    fs.writeFileSync(path.join(withLinks, "own.txt"), "own");
    fs.symlinkSync(victimDir, path.join(withLinks, "sub", "to-dir"), "dir");
    fs.symlinkSync(victimFile, path.join(withLinks, "to-file"));

    // 3. 要删的目标本身就是指向外部目录的链接
    const linkAsTarget = path.join(base, "link-as-target");
    fs.symlinkSync(victimDir, linkAsTarget, "dir");

    // 4. 悬空链接
    const dangling = path.join(base, "dangling");
    fs.symlinkSync(path.join(base, "no-such-place"), dangling);

    // 5. 空目录；6. 根本不存在
    const empty = path.join(base, "empty");
    fs.mkdirSync(empty);
    const missing = path.join(base, "missing");

    return { base, victimDir, victimFile, plain, withLinks, linkAsTarget, dangling, empty, missing };
  };

  const lexists = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  for (const script of [INSTALL_PS1, UNINSTALL_PS1]) {
    it(`${path.basename(script)}：链接只删链接，目标原封不动`, () => {
      const f = buildFixture();
      const targets = [f.plain, f.withLinks, f.linkAsTarget, f.dangling, f.empty, f.missing];
      const targetsFile = writeScript(f.base, "targets.txt", targets.join("\n"));
      const runner = writeScript(f.base, "runner.ps1", RUNNER_PS1);
      const r = runFile(runner, ["-ScriptFile", script, "-TargetsFile", targetsFile]);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const results = JSON.parse(r.stdout.trim()) as Array<{ target: string; before: boolean; error: string; after: boolean }>;
      const byTarget = new Map(results.map((x) => [x.target, x]));

      for (const t of [f.plain, f.withLinks, f.linkAsTarget, f.dangling, f.empty]) {
        const x = byTarget.get(t);
        expect(x, t).toBeDefined();
        expect(x?.before, `${path.basename(t)} 删之前应当存在`).toBe(true);
        expect(x?.error, `${path.basename(t)} 的错误`).toBe("");
        expect(x?.after, `${path.basename(t)} 删之后应当不在了`).toBe(false);
        expect(lexists(t), `${path.basename(t)} 在磁盘上应当已经没有`).toBe(false);
      }
      // 不存在的目标：Test-Exists 说没有（脚本里调用方都是先问一句再删）
      expect(byTarget.get(f.missing)?.before).toBe(false);

      // 关键：链接指向的外部目录 / 文件完好无损，内容也没变
      expect(fs.readFileSync(path.join(f.victimDir, "keep.txt"), "utf8")).toBe("keep");
      expect(fs.readFileSync(path.join(f.victimDir, "nested", "keep2.txt"), "utf8")).toBe("keep2");
      expect(fs.readFileSync(f.victimFile, "utf8")).toBe("keep");
    }, 60_000);
  }
});

// ───────────────────────── C# 解锁冷却：真实的 Cooldown 类在 .NET 里真跑 ─────────────────────────
// 第三轮评审 P1-5：状态文件读不了时冷却曾恒回整段（永不倒计时）、清不掉却照样回「已保存」。C# 在开发机上跑不了，
// 但 pwsh 自带 .NET + Roslyn：把 FlowshipUnlockHelper.cs 里真实的 Cooldown 类抠出来，配上最小桩（Const / Paths / Log），
// 用 POSIX 文件权限模拟「读不了 / 删不掉 / 改不了」真跑一遍状态机。只验 Cooldown 自己的逻辑，Windows 专有的部分（ACL / 管道 / Winlogon）仍要真机。
// 以 root 身份跑（比如某些 Docker CI）时权限位不起作用，整组跳过。
// 第六轮评审 P2-3：同一个 harness 也把真实的 CredStore 类抠出来（DPAPI 换成恒等桩）真跑，验「有没有 / 读 / 写 / 删」的文件系统语义：
// 没有 / 目录不存在 = 没有；看不见 / 读不了 ≠ 没有（Exists 回 true、读抛）；Replace 失败而目标在时 Save 抛、不覆盖。加密本身（DPAPI）要真机。

const describeCooldownRealRun = describe.skipIf(PWSH === null || process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0));

describeCooldownRealRun("C# 解锁冷却状态机（真实 Cooldown 类 + pwsh / .NET 真跑）", () => {
  const HARNESS = path.join(ROOT, "tests", "helpers", "win-helper-cooldown-harness.ps1");
  const HELPER_CS = path.join(ASSETS, ASSET_FILES.source);

  type HarnessCheck = { id: string; ok: boolean; detail: string };
  const runHarness = (source: string): HarnessCheck[] => {
    const work = mkTmp("cooldown");
    const r = spawnSync(pwsh(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HARNESS, "-Source", source, "-WorkDir", work], {
      encoding: "utf8",
      timeout: 100_000,
      env: PWSH_ENV,
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT_JSON:"));
    expect(line, r.stdout).toBeDefined();
    return JSON.parse((line as string).slice("RESULT_JSON:".length)) as HarnessCheck[];
  };
  const failed = (checks: HarnessCheck[]) => checks.filter((c) => !c.ok).map((c) => `${c.id}（${c.detail}）`);

  it("真实源码：54 项场景全过（读不了 → 倒计时 / 过期；删不掉 → 改写 0 标记；改不了 → 返回 false 且冷却照旧；乱码 → 从修改时间起算；内存冷却；日志只记一次；远未来 → 夹紧后倒计时 / 结束 / Start、Clear 后重新夹 / 时钟回拨后压回去；目录看不见 → 有冷却、Clear 返回 false；v3：Clear 失败后 StillBlockedSeconds——未来时间戳 / 读不了 > 0，已过期 = 0；v4：凭据存取——没有 / 目录不存在 = 没有，看不见 / 读不了 ≠ 没有，Replace 失败而目标在时 Save 抛）", () => {
    const checks = runHarness(HELPER_CS);
    expect(checks.length).toBeGreaterThanOrEqual(54); // 防止脚本悄悄少跑
    expect(failed(checks)).toEqual([]);
  }, 120_000);

  it("对照组（咬得住）：把 C# 改回旧语义——读不了恒回整段、清不掉不改写——同一套场景必须红在对应的几项上", () => {
    const original = fs.readFileSync(HELPER_CS, "utf8");
    const basis = "return Longer(fromMemory, LeftUntil(UnreadableBasis().AddSeconds(Const.CooldownSeconds)));";
    const overwrite = 'File.WriteAllText(Paths.State, "0");\n                    return true;';
    expect(original, "源码里找不到「读不了按修改时间起算」那一行：Cooldown 改过的话，这里的对照改写要跟着改").toContain(basis);
    expect(original, "源码里找不到「删不掉就改写成 0 标记」那一段：Cooldown 改过的话，这里的对照改写要跟着改").toContain(overwrite);
    const mutant = original.replace(basis, "return Longer(fromMemory, TimeSpan.FromSeconds(Const.CooldownSeconds));").replace(overwrite, "return false;");
    const mutantFile = path.join(mkTmp("cooldown-mutant"), "FlowshipUnlockHelper.mutant.cs");
    fs.writeFileSync(mutantFile, mutant);
    const failedIds = runHarness(mutantFile)
      .filter((c) => !c.ok)
      .map((c) => c.id);
    expect(failedIds).toEqual(
      expect.arrayContaining(["unreadable-counts-down-from-mtime", "unreadable-keeps-counting-down", "unreadable-expires", "clear-overwrites-marker-returns-true", "marker-means-no-cooldown"]),
    );
  }, 120_000);

  // 下面几组对照（第四轮评审）都是「把真实源码改坏一处，同一套场景必须红在对应的几项上」：证明新增的场景咬得住对应的修复，不是怎么写都绿。
  // 锚点必须逐字出现在源码里（守卫会先查）：Cooldown 改过的话，这里的对照改写要跟着改
  const mutateAndRun = (edits: Array<{ anchor: string; replacement: string; why: string }>): string[] => {
    let mutant = fs.readFileSync(HELPER_CS, "utf8");
    for (const { anchor, replacement, why } of edits) {
      expect(mutant, `源码里找不到锚点（${why}）`).toContain(anchor);
      mutant = mutant.replace(anchor, replacement);
    }
    const mutantFile = path.join(mkTmp("cooldown-mutant"), "FlowshipUnlockHelper.mutant.cs");
    fs.writeFileSync(mutantFile, mutant);
    return runHarness(mutantFile)
      .filter((c) => !c.ok)
      .map((c) => c.id);
  };

  // 注意：变异体必须还能编译。pwsh 的 Add-Type 把编译器警告也当错误——字段只赋值不读会触发 CS0414，所以下面的改写都保留对 clampedUntilTicks 的读取
  it("对照组（封顶）：把夹紧改回旧的「超过一整段就回一整段」——远未来的截止时刻永远回满格，「倒计时」「结束」两项必须红", () => {
    const failedIds = mutateAndRun([
      {
        anchor: "if (clampedUntilTicks == 0 || clampedUntilTicks > cap.Ticks) clampedUntilTicks = cap.Ticks;\n                untilUtc = new DateTime(clampedUntilTicks, DateTimeKind.Utc);",
        replacement: "untilUtc = new DateTime(clampedUntilTicks == 0 ? cap.Ticks : cap.Ticks, DateTimeKind.Utc);",
        why: "LeftUntil 的夹紧",
      },
    ]);
    expect(failedIds).toEqual(expect.arrayContaining(["clamped-keeps-counting-down", "clamped-expires"]));
  }, 120_000);

  it("对照组（回拨）：夹紧值不再跟着「现在 + 一整段」压回去——时钟往回拨后冷却被拉长，「重新压到新窗口」必须红", () => {
    const failedIds = mutateAndRun([
      {
        anchor: "if (clampedUntilTicks == 0 || clampedUntilTicks > cap.Ticks) clampedUntilTicks = cap.Ticks;",
        replacement: "if (clampedUntilTicks == 0) clampedUntilTicks = cap.Ticks;",
        why: "LeftUntil 的回拨分支",
      },
    ]);
    expect(failedIds).toContain("rewind-reclamps-to-new-window");
  }, 120_000);

  it("对照组（File.Exists）：Remaining / Clear 改回先问 File.Exists——目录看不见时少冷却、Clear 谎报成功，两项必须红", () => {
    const failedIds = mutateAndRun([
      {
        anchor: "string content;\n",
        replacement: "if (!File.Exists(Paths.State)) { ForgetUnreadable(); return fromMemory; }\n                    string content;\n",
        why: "Remaining 的读取",
      },
      {
        anchor: "File.Delete(Paths.State);",
        replacement: "if (!File.Exists(Paths.State)) return true;\n                        File.Delete(Paths.State);",
        why: "Clear 的删除",
      },
    ]);
    expect(failedIds).toEqual(expect.arrayContaining(["hidden-state-file-still-cools-down", "hidden-state-file-clear-returns-false"]));
  }, 120_000);

  // v3（DoSet 误报）：DoSet 靠 StillBlockedSeconds 判断「Clear 失败后冷却到底还在不在」。两个方向的变异都要被抓到：
  // 永远返回 1 = 退回「清不掉就当冷却还在」（已过期也误报）；永远返回 0 = 反过来把真有的冷却当成没有（少冷却 / 谎报已恢复）
  it("对照组（StillBlockedSeconds）：永远返回 1 → 「已过期 = 0」必须红；永远返回 0 → 「未来时间戳 / 读不了 > 0」必须红", () => {
    const body = "return (int)Math.Ceiling(Remaining().TotalSeconds);";
    const always1 = mutateAndRun([{ anchor: body, replacement: "return Remaining().TotalSeconds >= 0 ? 1 : 1;", why: "StillBlockedSeconds 的返回值" }]);
    expect(always1).toContain("clear-stuck-expired-still-blocked-is-zero");
    const always0 = mutateAndRun([{ anchor: body, replacement: "return Remaining().TotalSeconds >= 0 ? 0 : 0;", why: "StillBlockedSeconds 的返回值" }]);
    expect(always0).toEqual(expect.arrayContaining(["clear-stuck-future-still-blocked-positive", "hidden-state-file-still-blocked-positive"]));
    expect(always0).not.toContain("clear-stuck-expired-still-blocked-is-zero");
  }, 240_000);

  it("对照组（重置）：Start / Clear 不再重置夹紧的记忆——旧的、已过期的夹紧值把新的冷却当场判成已结束，各自对应的「重新夹紧」必须红", () => {
    const noStartReset = mutateAndRun([
      {
        anchor: "                // 新一轮冷却：之前夹过的记忆作废（旧的、已过期的夹紧值会把新的冷却当场判成「已结束」）\n                clampedUntilTicks = 0;\n",
        replacement: "",
        why: "Start 的重置",
      },
    ]);
    expect(noStartReset).toContain("clamp-rearms-after-start");
    const noClearReset = mutateAndRun([{ anchor: "memoryUntilTicks = 0;\n                clampedUntilTicks = 0;\n", replacement: "memoryUntilTicks = 0;\n", why: "Clear 的重置" }]);
    expect(noClearReset).toContain("clamp-rearms-after-clear");
  }, 240_000);

  // ── 第六轮评审 P2-3：凭据存取不再用 File.Exists（v4）。同样「把真实源码改坏一处，同一套场景必须红在对应的几项上」──
  // 下面三组的锚点都逐字出现在 CredStore 里（守卫会先查）。Save 里「不再按 File.Exists 挑 Replace / Move」没有对照组：
  // 它在 POSIX 权限下造不出行为差异（见 harness 里的说明），只由 protocol 测试的结构断言守着。
  it("对照组（凭据 Exists）：改回 File.Exists / 其余错误当没有 / 不再认「文件不存在」——「看不见」「没有」各自对应的项必须红", () => {
    const backToFileExists = mutateAndRun([{ anchor: "File.GetAttributes(Paths.Cred);", replacement: "if (!File.Exists(Paths.Cred)) return false;", why: "CredStore.Exists 的取属性" }]);
    expect(backToFileExists).toContain("cred-hidden-exists-true");
    const otherErrorsMeanAbsent = mutateAndRun([
      { anchor: "catch (Exception)\n            {\n                return true;\n            }", replacement: "catch (Exception)\n            {\n                return false;\n            }", why: "CredStore.Exists 的兜底（可能有）" },
    ]);
    expect(otherErrorsMeanAbsent).toContain("cred-hidden-exists-true");
    const notFoundUnrecognised = mutateAndRun([
      {
        anchor: "catch (FileNotFoundException)\n            {\n                return false;\n            }\n            catch (DirectoryNotFoundException)",
        replacement: "catch (DirectoryNotFoundException)",
        why: "CredStore.Exists 认「文件不存在」",
      },
    ]);
    expect(notFoundUnrecognised).toEqual(expect.arrayContaining(["cred-none-exists-false", "cred-delete-removes"]));
  }, 360_000);

  it("对照组（凭据读）：Load 先问 File.Exists / ReadSealed 把其余错误也当没有——看不见、读不了时必须抛而不是回 null", () => {
    const loadAsksFileExists = mutateAndRun([
      { anchor: "byte[] sealedBytes = ReadSealed();", replacement: "if (!File.Exists(Paths.Cred)) return null;\n            byte[] sealedBytes = ReadSealed();", why: "CredStore.Load 的读取" },
    ]);
    expect(loadAsksFileExists).toContain("cred-hidden-load-throws");
    expect(loadAsksFileExists).not.toContain("cred-hidden-read-throws"); // ReadSealed 本身没动：红得精确
    const readSwallowsEverything = mutateAndRun([
      {
        anchor: "catch (DirectoryNotFoundException)\n            {\n                return null;\n            }",
        replacement: "catch (DirectoryNotFoundException)\n            {\n                return null;\n            }\n            catch (Exception)\n            {\n                return null;\n            }",
        why: "CredStore.ReadSealed 的异常分类",
      },
    ]);
    expect(readSwallowsEverything).toEqual(expect.arrayContaining(["cred-hidden-read-throws", "cred-hidden-load-throws", "cred-unreadable-file-load-throws"]));
  }, 360_000);

  it("对照组（凭据写）：WriteSealed 吞掉异常（谎报成功）——第一次保存没落盘、目标在却不抛，必须红", () => {
    const swallowsFailure = mutateAndRun([
      { anchor: "catch (Exception)\n            {\n                File.Move(temp, Paths.Cred);\n            }", replacement: "catch (Exception)\n            {\n            }", why: "CredStore.WriteSealed 的 Move" },
    ]);
    expect(swallowsFailure).toEqual(expect.arrayContaining(["cred-first-save-exists", "cred-save-onto-existing-throws"]));
  }, 240_000);
});
