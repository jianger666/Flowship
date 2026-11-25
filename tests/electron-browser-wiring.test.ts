/**
 * 内置浏览器的 main.js 接线契约（docs/BROWSER-AUTOMATION.md §8.1 / §8.2）。
 *
 * main.js 是 Electron 入口，不能 import 进 vitest，所以读源码字面钉住「接线点」：
 * - server spawn 的 stdio 末尾是 "ipc"、spawn 之后**紧跟** attachServerChannel(proc)（每次 spawn 含重启）、不碰 stdout/stderr 处理
 * - createBrowserManager 的 deps 齐全；registerIpc 在 whenReady 里、建窗口之前被调用
 * - 退出链：window-all-closed 忽略停车场窗口（并在「只剩停车场」时补发）、before-quit 里 destroy()
 * - 打包：electron-app/browser/** 进安装包（未配置 files 白名单 = 整个 app 目录；将来加了白名单必须覆盖）
 * - electron-app/browser/index.mjs（A 组）里每个 ipcMain.handle/on("browser:…") 的 handler 第一件事过 isTrustedIpcSender
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 去掉所有注释（整行的、块的、跟在代码后面的 `// …`），只用于按「代码」判断的断言：被注释掉的字样不能再让断言通过。
// 用仓库共用的 helper（一遍扫描分出 代码 / 注释 / 字面量，认字符串、模板字符串、正则里的双斜杠与斜杠加星号；注释换成同样多的空格，下标 / 行号与原文一一对应），已用 acorn 取注释位置作基准在 main.js 与 browser 目录的几份 mjs 上逐字核对过。
// 本文件以前自己有一份正则版：不认行尾注释，还把 main.js 里 URL 通配模板字符串末尾的斜杠加星号当成块注释起点，把它之后到下一个块注释结束符之间的一大段代码一并删掉——断言看到的「代码」与真实代码不一样（R23-8）。
import { stripComments } from "./helpers/source-text";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const mainSrc = read("electron-app/main.js");

/** 从 `start` 之后第一个 `{` 起，配对大括号，返回整段（含括号）；字符串里的括号不处理（main.js 这几段够用） */
const braceBlock = (src: string, start: number): string => {
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("大括号不配对");
};

/** `start` 之后第一个配对大括号块「之后」的源码（用于断言 try { … } 后面紧跟 catch） */
const blockAfter = (src: string, start: number): string => {
  const open = src.indexOf("{", start);
  return src.slice(open + braceBlock(src, start).length);
};

describe("stripComments 看到的是真实代码（R23-8）", () => {
  it("main.js 里 URL 通配模板字符串（以斜杠加星号结尾）之后的代码还在——旧的正则版把它当块注释起点、删掉了后面一大段；行尾注释剥掉、字符串里的双斜杠保留", () => {
    const code = stripComments(mainSrc);
    // 通配模板字符串本身是代码里的字符串，原样保留
    expect(code).toContain("urls: [`${BASE_URL}/*`]");
    // 它后面紧跟的几行代码没有被当成注释吞掉
    expect(code).toMatch(/ses\.webRequest\.onSendHeaders\(filter, \(d\) => requestRecorder\.start\(d\.id, d\.url, d\.resourceType\)\);/);
    expect(code).toContain("requestRecorder.responseStarted(d.id, d.statusCode, d.fromCache)");
    // 行尾注释被剥掉：被注释掉的调用不能再让断言通过（这一行本身不在 main.js 里，合成一段做对照）
    const synthetic = stripComments('const a = "http://x.test/*"; // browserManager.destroy()\nfoo(); /* proc.on("message") */ bar();\n');
    expect(synthetic).toContain('"http://x.test/*"');
    expect(synthetic).not.toContain("browserManager.destroy()");
    expect(synthetic).not.toContain('proc.on("message")');
    expect(synthetic).toContain("foo();");
    expect(synthetic).toContain("bar();");
  });
});

describe("server 子进程：第 4 路 ipc 通道", () => {
  const spawnAt = mainSrc.indexOf("const proc = spawn(serverNodeBin()");
  const attachAt = mainSrc.indexOf("browserManager.attachServerChannel(proc)");

  it("stdio 末尾追加 \"ipc\"（unix [\"ignore\",\"pipe\",\"pipe\",\"ipc\"] / win32 [\"pipe\",\"pipe\",\"pipe\",\"ipc\"]），前三路不变", () => {
    expect(spawnAt).toBeGreaterThan(0);
    expect(mainSrc).toContain('stdio: [process.platform === "win32" ? "pipe" : "ignore", "pipe", "pipe", "ipc"],');
    // spawn 只有这一处（重启也走 startServer）
    expect(mainSrc.match(/\bspawn\(serverNodeBin\(\)/g)?.length).toBe(1);
    // 旧的三路写法不能残留
    expect(mainSrc).not.toContain('"ignore", "pipe", "pipe"],');
  });

  it("spawn 之后紧跟 attachServerChannel(proc)：中间只隔 serverProc = proc 与注释 / try 包裹", () => {
    expect(attachAt).toBeGreaterThan(spawnAt);
    const between = stripComments(mainSrc.slice(spawnAt, attachAt));
    // spawn 调用结束（`});`）之后到 attach 之前，只允许出现 `serverProc = proc;` 和 `try {`
    const afterSpawn = between.slice(between.indexOf("\n  });") + "\n  });".length).replace(/\s+/g, " ").trim();
    expect(afterSpawn).toBe("serverProc = proc; try {");
    // 在 error / exit 监听、pid 记录之前
    expect(attachAt).toBeLessThan(mainSrc.indexOf('proc.on("error"', spawnAt));
    expect(attachAt).toBeLessThan(mainSrc.indexOf("writeServerPidRecord(proc.pid)", spawnAt));
  });

  it("挂通道失败只记日志、不挡 server 启动（try/catch 包裹）", () => {
    const tryAt = mainSrc.lastIndexOf("try {", attachAt);
    expect(braceBlock(mainSrc, tryAt)).toContain("browserManager.attachServerChannel(proc)");
    expect(blockAfter(mainSrc, tryAt).slice(0, 200)).toMatch(/^\s*catch \(err\) \{\s*log\(/);
  });

  it("proc.on(\"message\") 不出现在 main.js（只给 bridge 用）；stdout / stderr 的处理原样保留", () => {
    expect(stripComments(mainSrc)).not.toContain('proc.on("message"');
    expect(mainSrc).toContain('proc.stdout.on("data", (d) => log(`[server] ${d}`.trimEnd()));');
    expect(mainSrc).toContain('proc.stderr.on("data", (d) => log(`[server:err] ${d}`.trimEnd()));');
  });
});

describe("BrowserManager 创建与 registerIpc", () => {
  it("从 ./browser/index.mjs 引入 createBrowserManager，从 ./browser/app-origin.mjs 引入 createIsAppUrl", () => {
    expect(mainSrc).toContain('import { createBrowserManager } from "./browser/index.mjs";');
    expect(mainSrc).toContain('import { createIsAppUrl } from "./browser/app-origin.mjs";');
    expect(existsSync(path.join(ROOT, "electron-app/browser/app-origin.mjs"))).toBe(true);
  });

  it("electron 的 session / WebContentsView 已从 \"electron\" 引入", () => {
    const imp = mainSrc.slice(mainSrc.indexOf("import {\n  app,"), mainSrc.indexOf('} from "electron";'));
    expect(imp).toMatch(/\bsession,/);
    expect(imp).toMatch(/\bWebContentsView,/);
    expect(imp).toMatch(/\bnativeImage,/);
  });

  it("createBrowserManager 的 deps 与契约 §8.2 一致", () => {
    const at = mainSrc.indexOf("const browserManager = createBrowserManager(");
    expect(at).toBeGreaterThan(0);
    const deps = braceBlock(mainSrc, at);
    for (const key of [
      "app,",
      "BrowserWindow,",
      "WebContentsView,",
      "session,",
      "ipcMain,",
      "nativeImage,",
      "getMainWindow: () => mainWindow,",
      "log,",
    ]) {
      expect(deps, key).toContain(key);
    }
    // isAppUrl 必须是「回环别名 + 自己的端口」，不是所有 localhost（用户预览自己项目的 localhost:3000 必须放行）
    expect(deps).toContain("isAppUrl: createIsAppUrl(() => PORT),");
    // isTrustedIpcSender 复用壳里那一份（只认本应用 origin）
    expect(deps).toMatch(/isTrustedIpcSender: \(e, channel\) => isTrustedIpcSender\(e, channel \?\? "browser:\*"\),/);
  });

  it("第二十一轮：系统层授权状态的接线——main.js 把 systemPreferences 注入 createBrowserManager，index.mjs 把它的 getMediaAccessStatus 接进 createPermissionGate（取不到 = \"unknown\"）", () => {
    // 先剥注释再匹配（R22-5：之前在原文上匹配，把 `systemPreferences,` 注释掉后注释里的字样仍然满足正则，这个断言不会变红）
    const code = stripComments(mainSrc);
    const at = code.indexOf("const browserManager = createBrowserManager(");
    expect(at, "main.js 应有 createBrowserManager 调用").toBeGreaterThan(0);
    expect(braceBlock(code, at)).toMatch(/\bsystemPreferences,/);
    // systemPreferences 已从 electron 引入（否则 main.js 里是个未定义标识符，createBrowserManager 一调用就 ReferenceError）
    // 按语义找 `import { app, … } from "electron"`（不绑换行 / 缩进 / 引号格式；格式变了也不该让断言因为「找不到 import」而误报）
    const electronImport = /import\s*\{([^}]*)\}\s*from\s*["']electron["']/.exec(code);
    expect(electronImport, "main.js 应有 `import { …, systemPreferences, … } from \"electron\"`——找不到整条 import 时先看格式 / 引入方式变了没，不要直接删这条断言").not.toBeNull();
    expect(electronImport?.[1] ?? "", "main.js 从 electron 引入的名字里应含 systemPreferences（没引入 = createBrowserManager 一调用就 ReferenceError）").toMatch(/\bsystemPreferences\b/);
    const indexSrc = stripComments(read("electron-app/browser/index.mjs"));
    const gateAt = indexSrc.indexOf("createPermissionGate({");
    expect(gateAt).toBeGreaterThan(0);
    // 语义而不是格式：getMediaAccessStatus 这一项的箭头函数里调用了 deps.systemPreferences 的同名方法并把 kind 传下去（空白 / 是否带兜底值都不绑）
    expect(braceBlock(indexSrc, gateAt)).toMatch(/getMediaAccessStatus\s*:\s*\(\s*kind\s*\)\s*=>[^,\n]*deps\.systemPreferences\?\.getMediaAccessStatus\?\.\(\s*kind\s*\)/);
  });

  it("第二十六轮 X-3：index.mjs 的 createTab 里 `permissionGate.bindTab(tab)` 全文恰好一处、落在 `new BrowserTab(` 之后、`return tab` 之前——收养的 window.open 弹窗在构造里就同步跑完了早钩子那一批，页内权限桩全靠 bindTab 之后的补调；这一行被删 / 挪到构造之前，门的单测照样全绿，只有真 Electron 的 r21（S10）会红", () => {
    // 先剥注释再匹配：被注释掉的 bindTab 不算数（与上一条同一做法）
    const code = stripComments(read("electron-app/browser/index.mjs"));
    expect(code.match(/permissionGate\.bindTab\(tab\)/g), "全文只在 createTab 里 bindTab 一次").toHaveLength(1);
    const head = /createTab\s*:\s*\(\{[^}]*\}\)\s*=>\s*/.exec(code);
    expect(head, "index.mjs 应有 `createTab: ({ … }) => { … }`——找不到时先看写法变了没，不要直接删这条断言").not.toBeNull();
    const body = braceBlock(code, head!.index + head![0].length); // 参数解构的花括号已跳过：这是函数体
    const ctorAt = body.indexOf("new BrowserTab(");
    const bindAt = body.indexOf("permissionGate.bindTab(tab)");
    const returnAt = body.lastIndexOf("return tab");
    expect(ctorAt, "createTab 里应有 new BrowserTab(").toBeGreaterThan(-1);
    expect(bindAt, "createTab 里应有 permissionGate.bindTab(tab)").toBeGreaterThan(-1);
    expect(ctorAt, "bindTab 要在构造之后（构造期间 tab 还没造好）").toBeLessThan(bindAt);
    expect(returnAt, "bindTab 要在 return tab 之前").toBeGreaterThan(bindAt);
  });

  it("registerIpc 在 app.whenReady 里、创建 splash / 主窗口之前被调用（失败不挡启动）", () => {
    const readyAt = mainSrc.indexOf("app.whenReady().then(async () => {");
    const regAt = mainSrc.indexOf("browserManager.registerIpc()");
    const winAt = mainSrc.indexOf("await createWindow();", readyAt);
    expect(readyAt).toBeGreaterThan(0);
    expect(regAt).toBeGreaterThan(readyAt);
    expect(regAt).toBeLessThan(winAt);
    expect(mainSrc.match(/browserManager\.registerIpc\(\)/g)?.length).toBe(1);
    const tryAt = mainSrc.lastIndexOf("try {", regAt);
    expect(blockAfter(mainSrc, tryAt).trimStart()).toMatch(/^catch \(err\) \{/);
  });

  it("main.js 本身不注册任何 browser:* IPC（全部在 index.mjs、由 isTrustedIpcSender 守门）", () => {
    expect(mainSrc).not.toMatch(/ipcMain\.(on|handle|once)\("browser:/);
  });
});

describe("退出链：停车场窗口不拖住退出", () => {
  const wacAt = mainSrc.indexOf('app.on("window-all-closed", async');
  const wacBody = braceBlock(mainSrc, wacAt);

  it("hasUserWindows 忽略停车场窗口（isParkingWindow）与已销毁窗口", () => {
    const m = /const hasUserWindows = \(\) =>\s*([\s\S]*?);\n/.exec(mainSrc);
    expect(m, "main.js 应有 const hasUserWindows").not.toBeNull();
    expect(m![1]).toContain("BrowserWindow.getAllWindows()");
    expect(m![1]).toContain("!w.isDestroyed()");
    expect(m![1]).toContain("!browserManager.isParkingWindow(w)");
  });

  it("window-all-closed：还有用户窗口就不退；其余原有退出逻辑（停 server + quit）不变", () => {
    expect(wacBody.indexOf("if (hasUserWindows()) return;")).toBeGreaterThan(0);
    expect(wacBody.indexOf("if (hasUserWindows()) return;")).toBeLessThan(wacBody.indexOf("quitting = true;"));
    expect(wacBody).toContain("quitting = true;");
    expect(wacBody).toContain("await stopServer();");
    expect(wacBody).toContain("app.quit();");
  });

  it("停车场常驻时 Electron 不会自己发 window-all-closed：窗口 closed 时「只剩停车场」→ 手动补发（真退出 / 无窗口时不补发）", () => {
    const at = mainSrc.indexOf('app.on("browser-window-created"');
    expect(at).toBeGreaterThan(wacAt);
    const body = braceBlock(mainSrc, at);
    expect(body).toContain('win.once("closed"');
    expect(body).toContain("if (quitting || hasUserWindows()) return;");
    expect(body).toContain("getAllWindows().every((w) => w.isDestroyed())");
    expect(body).toContain('app.emit("window-all-closed");');
  });

  it("will-quit：browserManager.destroy() 只做一次；before-quit 里不再销毁（它不可逆，而 before-quit 可被 preventDefault，评审 R1-32）", () => {
    const bqAt = mainSrc.indexOf('app.on("before-quit"');
    const bqBody = mainSrc.slice(bqAt, mainSrc.indexOf("\n  });\n}", bqAt));
    expect(stripComments(bqBody)).not.toContain("browserManager.destroy()");
    // 防后台节流的 powerSaveBlocker.stop 与优雅停 server 仍在 before-quit
    expect(bqBody.indexOf("powerSaveBlocker.stop(appNapBlockerId)")).toBeGreaterThan(0);
    expect(bqBody).toContain("void stopServer()");

    const wqAt = mainSrc.indexOf('app.on("will-quit", ');
    expect(wqAt, "main.js 应有 app.on(\"will-quit\")").toBeGreaterThan(0);
    const body = braceBlock(mainSrc, wqAt);
    expect(body).toContain("if (browserManagerDestroyed) return;");
    expect(body).toContain("browserManagerDestroyed = true;");
    expect(body.match(/browserManager\.destroy\(\)/g)?.length).toBe(1);
    expect(mainSrc).toContain("let browserManagerDestroyed = false;");
    // destroy 出错也不挡退出
    const destroyAt = body.indexOf("browserManager.destroy()");
    const tryAt = body.lastIndexOf("try {", destroyAt);
    expect(blockAfter(body, tryAt).trimStart()).toMatch(/^catch \(err\) \{/);
    // main.js 全文只有这一处 destroy 调用
    expect(stripComments(mainSrc).match(/browserManager\.destroy\(\)/g)?.length).toBe(1);
  });

  /**
   * app.exit() 不触发 before-quit / will-quit（Electron 文档）。电脑操作的收尾（撤遮罩 + 把 AI 解锁过的电脑锁回去）原来只在 will-quit 里：
   * mac 套用暂存更新的两条路径都以 app.exit(0) 收尾，会把它整个绕过去——遮罩随进程消失，而电脑还开着没锁，用户又不在场。
   * main.js 不能 import 进 vitest（真路径要打包过的 mac 应用 + 一份暂存更新才走得到），所以读源码字面钉住接线点。
   */
  it("电脑操作的退出收尾（destroyDesktop）：will-quit 里一次；两条以 app.exit(0) 收尾的路径（立即更新的 relaunch / 退出时套用暂存）也各自在 exit 之前做", () => {
    const code = stripComments(mainSrc);

    // 唯一的实现：try/catch 包着 desktop?.destroy()，出错只记日志、不挡退出；main.js 里 desktop?.destroy() 只此一处
    const defAt = code.indexOf("const destroyDesktop = () => {");
    expect(defAt, "main.js 应有 const destroyDesktop").toBeGreaterThan(0);
    const def = braceBlock(code, defAt);
    expect(def).toContain("desktop?.destroy();");
    expect(def).toMatch(/catch \(err\) \{\s*log\(/);
    expect(code.match(/desktop\?\.destroy\(\)/g)?.length).toBe(1);

    // will-quit：在浏览器 / Mermaid 销毁之前（和原来一样先收尾电脑操作）
    const wq = braceBlock(code, code.indexOf('app.on("will-quit", '));
    expect(wq).toContain("destroyDesktop();");
    expect(wq.indexOf("destroyDesktop();")).toBeLessThan(wq.indexOf("browserManager.destroy()"));

    // 路径 A：applyStagedUpdate 的 relaunch 分支——替换成功、退出已确定之后、app.exit(0) 之前。
    // 不能放在函数开头（那时替换还可能失败、应用继续跑，destroy 会摘掉设置页用的 IPC）
    const fn = code.slice(code.indexOf("const applyStagedUpdate = async"), code.indexOf("const tryApplyStagedUpdateOnLaunch"));
    const exitA = fn.lastIndexOf("app.exit(0);");
    const destroyA = fn.lastIndexOf("destroyDesktop();");
    expect(fn.match(/destroyDesktop\(\);/g)?.length).toBe(1);
    expect(fn.indexOf("await fs.rm(stagedMetaFile()")).toBeGreaterThan(0);
    expect(destroyA).toBeGreaterThan(fn.indexOf("await fs.rm(stagedMetaFile()")); // 套用（改盘）已经完成、暂存元信息已消费
    expect(destroyA).toBeGreaterThan(fn.lastIndexOf("browserManager.setQuitting(false)")); // 失败回滚分支（应用继续跑）之后
    expect(destroyA).toBeLessThan(exitA);

    // 路径 B：before-quit 的暂存更新分支——app.exit(0) 在 finally 里无条件执行，退出板上钉钉，所以在开始套用之前就做
    const bq = code.slice(code.indexOf('app.on("before-quit"'));
    const applyAt = bq.indexOf("applyingStagedOnQuit = true");
    const destroyB = bq.indexOf("destroyDesktop();", applyAt);
    expect(applyAt).toBeGreaterThan(0);
    expect(destroyB).toBeGreaterThan(applyAt);
    expect(destroyB).toBeLessThan(bq.indexOf("applyStagedUpdateOnQuit()", applyAt));
    expect(bq.slice(applyAt, bq.indexOf("app.exit(0)", applyAt))).toContain(".finally(() => {");

    // 对账：main.js 里 app.exit( 恰好这两处。再加一条 app.exit 路径时这里会红——提醒你给它也配上 destroyDesktop()（绕过 will-quit 的都要）
    expect(code.match(/\bapp\.exit\(/g)?.length).toBe(2);
  });

  it("退出途中不新建原生窗口（评审 R1-32 复审）：before-quit 最终通过时 setQuitting(true)，被推迟 / 取消的每条路径都复位，app.exit 路径保持置位", () => {
    const bqAt = mainSrc.indexOf('app.on("before-quit"');
    const bqBody = mainSrc.slice(bqAt, mainSrc.indexOf("\n  });\n}", bqAt));
    const code = stripComments(bqBody);
    // 置位在 before-quit 开头（先于任何 preventDefault / 关窗）
    expect(code.indexOf("browserManager.setQuitting(true)")).toBeGreaterThan(0);
    expect(code.indexOf("browserManager.setQuitting(true)")).toBeLessThan(code.indexOf("event.preventDefault()"));
    // 优雅停 server 的推迟分支：preventDefault 之后立刻复位（推迟期间浏览器照常可用，app.quit() 再来一次时重新置位）
    const deferAt = code.indexOf("event.preventDefault()");
    expect(code.slice(deferAt, deferAt + 120)).toContain("browserManager.setQuitting(false)");
    // mac 暂存更新分支以 app.exit(0) 收尾：不复位（app.exit 先销毁窗口，此时新建停车场窗口 = SIGTRAP）
    const applyAt = code.indexOf("applyingStagedOnQuit = true");
    expect(applyAt).toBeGreaterThan(deferAt);
    expect(code.slice(applyAt - 200, applyAt + 200)).not.toContain("setQuitting(false)");
    // main.js 里所有把 quitting 置回 false 的地方（更新失败的回滚路径）都同步复位浏览器的标志
    const resets = [...stripComments(mainSrc).matchAll(/\n(\s*)quitting = false;\n(\s*)([^\n]*)/g)];
    expect(resets.length).toBeGreaterThanOrEqual(2);
    for (const m of resets) expect(m[3], `quitting = false 之后应紧跟 browserManager.setQuitting(false)：${m[0]}`).toContain("browserManager.setQuitting(false)");
  });

  it("mac 关窗不退出 / 点 X 二次确认 / Cmd+W 收托盘的既有逻辑原样保留（close 拦截仍靠 quitting 放行）", () => {
    expect(mainSrc).toContain("if (quitting) return;\n    event.preventDefault();");
    expect(mainSrc).toContain('mainWindow.webContents.send("app-close-confirm", {');
    expect(mainSrc).toContain("const hideMainWindowToTray = () => {");
    expect(mainSrc).toContain("const quitAppForReal = () => {\n  quitting = true;\n  app.quit();\n};");
  });
});

describe("打包：electron-app/browser/** 进安装包", () => {
  it("main.js 引入的 ./browser/*.mjs 都真实存在（index.mjs 由 A 组交付，缺失时这里会红——集成前提醒）", () => {
    const rels = [...mainSrc.matchAll(/from\s+"(\.\/browser\/[^"]+)"/g)].map((m) => m[1]!);
    expect(rels.length).toBeGreaterThanOrEqual(2);
    for (const rel of rels) {
      expect(existsSync(path.join(ROOT, "electron-app", rel)), rel).toBe(true);
    }
  });

  it("electron-builder 未配置 files 白名单（directories.app=electron-app → 整个目录含 browser/ 默认进包）；将来加了白名单必须覆盖 browser/**", () => {
    const yml = read("electron-builder.yml");
    expect(yml).toMatch(/^\s{2}app: electron-app\s*$/m);
    const pkg = JSON.parse(read("electron-app/package.json")) as { build?: { files?: string[] } };
    const covers = (patterns: string[]) =>
      patterns.some((p) => ["**/*", "**", "browser/**", "browser/**/*", "browser/*.mjs", "**/*.mjs"].includes(p));
    if (pkg.build?.files) expect(covers(pkg.build.files), "electron-app/package.json build.files 未覆盖 browser/**").toBe(true);
    // yml 顶层 files: 同理（有则必须覆盖；没有 = 默认全带）
    const ymlFiles = /^files:\s*\n((?:\s+- .*\n?)+)/m.exec(yml);
    if (ymlFiles) {
      const patterns = [...ymlFiles[1]!.matchAll(/^\s+- "?([^"\n]+)"?\s*$/gm)].map((m) => m[1]!);
      expect(covers(patterns), "electron-builder.yml files 未覆盖 browser/**").toBe(true);
    }
    // 没有会把 .mjs / browser 目录排除在外的 asar / ignore 配置
    expect(yml).not.toMatch(/^\s*-\s*"?!.*browser/m);
  });
});

describe("index.mjs（A 组）：每个 browser:* IPC 入口第一件事过 isTrustedIpcSender", () => {
  const indexPath = path.join(ROOT, "electron-app/browser/index.mjs");
  const INBOUND = [
    "attach",
    "setBounds",
    "detach",
    "setCovered",
    "navigate",
    "back",
    "forward",
    "reload",
    "stop",
    "newTab",
    "selectTab",
    "closeTab",
    "takeover",
    "handback",
    "answerAsk",
    "startPick",
    "cancelPick",
    "getState",
    "clearBrowsingData",
    // 增强包 E2（契约 §15.1）：通用扩展通道（名字白名单在主进程 extHandlers）
    "ext",
    // R7：本地 HTML → 一次性 token 的 loopback URL（local-html-server.mjs；行为见 tests/browser-r7-local-html-ipc.test.ts）
    "serveLocalHtml",
    // 用户侧「新建无痕标签页」（面板「更多」菜单；行为见 tests/browser-e2-p2-incognito.test.ts「用户侧 browser:newIncognitoTab」）
    "newIncognitoTab",
  ].map((n) => `browser:${n}`);

  if (!existsSync(indexPath)) {
    // A 组还没交付 index.mjs：先对「文件不存在」宽容（集成后这些用例会真正生效，见交付报告）
    it.skip("index.mjs 尚未交付 → 跳过（集成后自动生效）", () => {});
    return;
  }
  // 去掉注释再分析（注释里常写 ipcMain.handle(...) 之类的说明）
  const src = stripComments(readFileSync(indexPath, "utf8"));

  /** 函数体最前面的一段代码（跳过空白）；gate 必须是第一条语句：if (!isTrustedIpcSender(<第一个形参>…)) … */
  const assertGateFirst = (bodyStart: number, params: string, label: string) => {
    const first = params.split(",")[0]!.trim();
    expect(first, `${label}：第一个形参应是 event 对象`).toMatch(/^[A-Za-z_]\w*$/);
    const head = src.slice(bodyStart).replace(/^\s+/, "").slice(0, 240);
    const gate = new RegExp(`^if\\s*\\(\\s*!\\s*(?:deps\\.)?isTrustedIpcSender\\(\\s*${first}\\b`);
    expect(head, `${label}：函数体第一条语句应是 if (!isTrustedIpcSender(${first}…))，实际：${head.slice(0, 120)}`).toMatch(gate);
  };

  // 所有 ipcMain.handle / on / once 的原始注册：inline 箭头函数，或具名监听
  const raw = [
    ...src.matchAll(/\bipcMain\.(handle|on|once)\(\s*([^,\n]+?)\s*,\s*(?:async\s*)?(?:\(([^)]*)\)\s*=>\s*\{|([A-Za-z_]\w*)\s*\))/g),
  ];

  it("index.mjs 里有 IPC 注册（防正则失效而空过）", () => {
    expect(raw.length).toBeGreaterThanOrEqual(3);
  });

  for (const m of raw) {
    const [whole, kind, arg, inlineParams, namedHandler] = m;
    it(`ipcMain.${kind}(${arg}, ${namedHandler ?? "inline"})：handler 体第一条语句是 isTrustedIpcSender 闸`, () => {
      if (inlineParams !== undefined) {
        assertGateFirst(m.index! + whole.length, inlineParams, `ipcMain.${kind}(${arg})`);
        return;
      }
      const def = new RegExp(`const ${namedHandler} = (?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*\\{`).exec(src);
      expect(def, `找不到具名 handler ${namedHandler} 的定义`).not.toBeNull();
      assertGateFirst(def!.index + def![0].length, def![1]!, `handler ${namedHandler}`);
    });
  }

  it("ipcMain 注册的通道只会是 browser:* 字面量，或 helper 里的 name（helper 所有调用点都传 browser:* 字面量）", () => {
    for (const m of raw) {
      const arg = m[2]!;
      expect(/^["'`]browser:[\w:]+["'`]$/.test(arg) || arg === "name", `ipcMain 注册参数异常：${arg}`).toBe(true);
    }
    // 凡是用 name 当通道的，必定在某个 helper（const x = (name, fn) =>）里；找出 helper 名，检查所有调用点
    const helpers = [...src.matchAll(/const (\w+) = \(name, fn\) => \{/g)].map((m) => m[1]!);
    if (raw.some((m) => m[2] === "name")) expect(helpers.length).toBeGreaterThan(0);
    for (const h of helpers) {
      const calls = [...src.matchAll(new RegExp(`(?<![.\\w])${h}\\(([^,)]+)`, "g"))].map((m) => m[1]!.trim());
      expect(calls.length, `${h} 至少被调用一次`).toBeGreaterThan(0);
      for (const c of calls) expect(/^["']browser:[\w:]+["']$/.test(c), `${h}(${c}…) 必须传 browser:* 字面量`).toBe(true);
    }
  });

  it("契约 §8.2 的 19 个请求通道都在 index.mjs 注册（经 helper 或 ipcMain.on 直连），没有多余的 browser:* 通道", () => {
    const registered = new Set(
      [...src.matchAll(/\b(?:handle|handleOrSend|ipcMain\.on|ipcMain\.handle)\(\s*["'](browser:\w+)["']/g)].map((m) => m[1]!),
    );
    for (const ch of INBOUND) expect(registered.has(ch), `${ch} 未在 index.mjs 注册`).toBe(true);
    for (const ch of registered) expect(INBOUND.includes(ch), `index.mjs 多注册了契约外的通道 ${ch}`).toBe(true);
  });

  it("setBounds 是高频 send（ipcMain.on，没有 handle），有返回值的通道是 handle（preload 用 invoke）", () => {
    expect(src).toMatch(/ipcMain\.on\("browser:setBounds", onSetBounds\)/);
    expect(src).not.toMatch(/ipcMain\.handle\("browser:setBounds"/);
    for (const ch of ["attach", "setCovered", "navigate", "newTab", "getState", "clearBrowsingData", "serveLocalHtml"]) {
      expect(src, `browser:${ch}`).toMatch(new RegExp(`\\bhandle\\("browser:${ch}"`));
    }
  });

  it("对外接口齐全：attachServerChannel / registerIpc / isParkingWindow / destroy（main.js 接线依赖）", () => {
    // 不再锚定「文件末尾」：index.mjs 工厂之后可能还有别的 export（V1 加了 createIdleTracker），改为找含 attachServerChannel 的那个 return { … }
    const ret = /return \{([^}]*\battachServerChannel\b[\s\S]*?)\};\s*\n\};?/.exec(src)?.[1] ?? src;
    for (const name of ["attachServerChannel", "registerIpc", "isParkingWindow", "destroy"]) {
      expect(ret, name).toContain(name);
    }
  });
});
