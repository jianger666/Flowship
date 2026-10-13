/**
 * 启动诊断在 electron-app/main.js 里的接线契约（字符串级：能防回退 / 防改坏，不能证明 Windows 运行时行为）。
 * 核心原则：诊断只观察、不改行为——不拦请求、不挡启动、不在启动关键路径上跑 PowerShell。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const main = readFileSync(path.join(root, "electron-app/main.js"), "utf8");

const sliceBetween = (from: string, to: string): string => {
  const a = main.indexOf(from);
  expect(a, `找不到 ${from}`).toBeGreaterThanOrEqual(0);
  const b = main.indexOf(to, a + from.length);
  expect(b, `找不到 ${to}`).toBeGreaterThan(a);
  return main.slice(a, b);
};

describe("导入与模块", () => {
  it("三个纯函数模块都被 main.js 引入", () => {
    for (const mod of ["./boot-diag.mjs", "./env-probe.mjs", "./boot-prefetch.mjs"]) {
      expect(main, mod).toContain(`from "${mod}"`);
    }
    for (const name of [
      "createBootTimeline",
      "createLagMonitor",
      "createRequestRecorder",
      "formatLagSummary",
      "formatRequestSummary",
      "buildEnvProbeScript",
      "parseEnvProbe",
      "describeEnvProbe",
      "driveLetterOf",
      "runReadProbe",
      "formatReadProbe",
    ]) {
      expect(main, name).toContain(name);
    }
  });
});

describe("时间线里程碑", () => {
  it("关键里程碑都打了点：appReady / splash / winCreated / serverSpawn / serverReady / domReady / loadDone / reveal / prefetchDone", () => {
    for (const m of [
      "appReady",
      "splash",
      "winCreated",
      "serverSpawn",
      "serverReady",
      "domReady",
      "loadDone",
      "reveal",
      "prefetchDone",
    ]) {
      expect(main, m).toContain(`bootTimeline.mark("${m}")`);
    }
  });

  it("appReady 是 whenReady 回调里的第一件事（基准 = 主进程启动，数值本身 = 点图标到第一行代码）", () => {
    const body = sliceBetween("app.whenReady().then(async () => {", "log(`[main] app 启动");
    expect(body).toContain('bootTimeline.mark("appReady")');
    expect(body).toContain("lagMonitor.start()");
  });

  it("serverReady 在 markFirstBootDone 之前（打点不能依赖后面的步骤）；loadDone 在 loadURL 之后、domReady 监听在 loadURL 之前", () => {
    const ready = main.indexOf('bootTimeline.mark("serverReady")');
    expect(ready).toBeGreaterThan(0);
    expect(ready).toBeLessThan(main.indexOf("markFirstBootDone();", ready));
    const dom = main.indexOf('webContents.once("dom-ready"');
    const load = main.indexOf("await mainWindow.loadURL(BASE_URL)");
    const done = main.indexOf('bootTimeline.mark("loadDone")');
    expect(dom).toBeGreaterThan(0);
    expect(dom).toBeLessThan(load);
    expect(load).toBeLessThan(done);
  });

  it("prefetchDone 放在 finally 里（预读成功 / 失败 / 没清单都要打点）", () => {
    expect(main).toMatch(/\} finally \{\s*bootTimeline\.mark\("prefetchDone"\);\s*\}/);
  });
});

describe("首页请求记录器：被动通知、绝不拦截请求", () => {
  const body = sliceBetween("const installRequestRecorder = () => {", "// Windows 机器环境");

  it("只挂四个无回调的通知事件；刻意不用 onBeforeRequest / onHeadersReceived 等要主进程回调放行的事件", () => {
    for (const ev of ["onSendHeaders", "onResponseStarted", "onCompleted", "onErrorOccurred"]) {
      expect(body, ev).toContain(`webRequest.${ev}(`);
    }
    for (const ev of ["onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived", "onBeforeRedirect"]) {
      expect(body, ev).not.toContain(ev);
    }
  });

  it("只监听本机 server 的请求（BASE_URL），装失败只记日志、不抛", () => {
    expect(body).toContain("urls: [`${BASE_URL}/*`]");
    expect(body).toMatch(/catch \(err\) \{\s*log\(`\[boot\] 请求记录器安装失败（忽略）/);
  });

  it("在主窗创建之后、server 起之前装好（首页的第一个请求就要能记到）", () => {
    const create = main.indexOf("await createWindow();");
    const install = main.indexOf("    installRequestRecorder();", create);
    const start = main.indexOf("    startServer();", create);
    expect(create).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(create);
    expect(install).toBeLessThan(start);
  });
});

describe("启动报告：首页亮出后一次性、每块互不影响", () => {
  const body = sliceBetween("const emitBootReport = async (revealSource) => {", "// ---------- 端口冲突处理 ----------");

  it("由 revealMainWindow 触发、只触发一次（幂等标志 + 延迟定时器）", () => {
    const reveal = sliceBetween("const revealMainWindow = (source) => {", "ipcMain.on(\"app-content-ready\"");
    expect(reveal).toContain("bootReportScheduled");
    expect(reveal).toContain("setTimeout(() => void emitBootReport(source), BOOT_REPORT_DELAY_MS)");
    expect(main).toMatch(/const BOOT_REPORT_DELAY_MS = \d[\d_]*;/);
    expect(body).toMatch(/if \(bootReported\) return;\s*bootReported = true;/);
  });

  it("报告内容：时间线 / 主线程卡顿 / 请求明细 / GPU / 进程指标 / 杀软 / 机器环境", () => {
    for (const part of [
      "[boot] timeline",
      "formatLagSummary(lagMonitor.snapshot())",
      "formatRequestSummary(requestRecorder.snapshot())",
      "app.getGPUFeatureStatus()",
      ".getAppMetrics()",
      'logSecurityProducts("first-boot")',
      "await logEnvProbe()",
    ]) {
      expect(body, part).toContain(part);
    }
  });

  it("每一块各自 try/catch：任何一块出错不影响其它块，也不让报告函数 reject", () => {
    expect((body.match(/\btry \{/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((body.match(/\bcatch\b/g) ?? []).length).toBe((body.match(/\btry \{/g) ?? []).length);
  });

  it("PowerShell 取证放在页面亮出之后、串行、且只有 Windows（不跟首页渲染抢 CPU / 磁盘）", () => {
    expect(main).toMatch(/const logEnvProbe = async \(\) => \{\s*if \(process\.platform !== "win32"\) return;/);
    expect(main).toMatch(/const logSecurityProducts = async \(why = "slow-boot"\) => \{\s*if \(process\.platform !== "win32"\) return;/);
    // 取证调用只出现在 emitBootReport 和（原有的）慢启动分支里
    const callers = [...main.matchAll(/logEnvProbe\(\)/g)].length;
    expect(callers).toBe(1);
  });

  it("环境取证只在「首次启动 / 这次启动偏慢」时跑：过 decideEnvProbe 门禁、用亮窗时刻与慢阈值判定，跳过时留一行日志", () => {
    // 不能无条件每次启动都拉 PowerShell：应用没签名，公司电脑的杀软 / EDR 可能报警
    expect(body).toMatch(/const envProbe = decideEnvProbe\(\{[\s\S]*?\}\);/);
    expect(body).toContain("firstBoot: bootIsFirst");
    expect(body).toContain('revealSeconds: bootTimeline.get("reveal")');
    expect(body).toContain("slowMs: SLOW_BOOT_PROBE_MS");
    // 真正的调用只挂在门禁分支上
    expect(body).toMatch(/if \(envProbe\.run\) await logEnvProbe\(\);/);
    expect(body).not.toMatch(/(?<!if \(envProbe\.run\) )await logEnvProbe\(\)/);
    // 跳过 / 触发各留一行，日志里才分得清「没跑」和「没查到」
    expect(body).toContain("[boot] env 探测跳过");
    expect(body).toContain("[boot] env 探测 trigger=");
  });

  it("杀软探测幂等（慢启动路径与首次启动路径同一次运行只查一次），原有的慢启动调用语句一字不改", () => {
    expect(main).toContain("let securityProbeStarted = false;");
    expect(main).toMatch(/if \(securityProbeStarted\) return;\s*securityProbeStarted = true;/);
    expect(main).toContain("if (bootElapsedMs > SLOW_BOOT_PROBE_MS) void logSecurityProducts()");
  });

  it("环境探测的盘符取自安装目录 / 用户数据目录 / 临时目录，且超时用常量", () => {
    const probe = sliceBetween("const logEnvProbe = async () => {", "// 一次性启动报告");
    expect(probe).toContain("process.execPath");
    expect(probe).toContain('app.getPath("userData")');
    expect(probe).toContain("os.tmpdir()");
    expect(probe).toContain("timeout: ENV_PROBE_TIMEOUT_MS");
    expect(probe).toContain("windowsHide: true");
  });
});

describe("读延迟探针：预读之前、失败不影响预读", () => {
  const block = sliceBetween("shouldPrefetch({", "// mac 自定义应用菜单");

  it("先 runReadProbe、后 runPrefetch；探针有独立 try/catch（探针失败不能让预读被跳过）", () => {
    const probe = block.indexOf("await runReadProbe(");
    const prefetch = block.indexOf("await runPrefetch(");
    expect(probe).toBeGreaterThan(0);
    expect(prefetch).toBeGreaterThan(probe);
    expect(block).toMatch(/try \{\s*const probe = await runReadProbe[\s\S]*?catch \(err\) \{\s*log\(`\[boot\] readProbe 异常（忽略）/);
  });

  it("探针与预读共用同一个 firstBoot 门禁（只在 Windows 首次启动才跑），不另开一套条件", () => {
    expect(block).toContain("void (async () => {");
    expect(block.match(/runReadProbe\(/g)).toHaveLength(1);
  });
});
