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

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const mainSrc = read("electron-app/main.js");

/** 去掉整行注释与块注释（只用于「紧跟」这类按代码判断的断言） */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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
