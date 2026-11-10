/**
 * R6-34 / R6-37 的基础件：
 *  - `path-scrub.mjs`：fs 错误只留 errno 码 + 释义 + 系统调用 + 文件名；文本里的本机绝对路径（userData / 家目录 / 常见顶层目录 / Windows 盘符 / `~/`）被剔除，
 *    URL / 路由式路径（`/api/login`）不动；线性。
 *  - `safe-dir.mjs` 的 `create: false`：读 / 导出已有目录时，任何一级不存在就抛 ENOENT、不创建；符号链接 / 属主 / 权限校验不变。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fsErrorText, pathBaseName, scrubPaths } from "../electron-app/browser/path-scrub.mjs";
import { ensureSafeDir } from "../electron-app/browser/safe-dir.mjs";

const isWin = process.platform === "win32";
const UD = "/Users/zhangsan/Library/Application Support/Flowship";

const nodeErr = (code: string, syscall: string, p: string, desc: string) =>
  Object.assign(new Error(`${code}: ${desc}, ${syscall} '${p}'`), { code, syscall, path: p, errno: -1 });

describe("R6-34 fsErrorText：fs 错误只留 errno 码 / 释义 / 系统调用 / 文件名", () => {
  const dir = `${UD}/data/tasks/t1/browser-traces`;

  it("ENOSPC / EACCES / EROFS：不含任何目录，文件名保留", () => {
    for (const [code, desc, label] of [
      ["ENOSPC", "no space left on device", "磁盘空间不足"],
      ["EACCES", "permission denied", "没有权限"],
      ["EROFS", "read-only file system", "只读文件系统"],
    ] as const) {
      const t = fsErrorText(nodeErr(code, "open", `${dir}/.trace-20261109-120000.tmp`, desc), { roots: [UD] });
      expect(t).toContain(code);
      expect(t).toContain(label);
      expect(t).toContain("open");
      expect(t).toContain(".trace-20261109-120000.tmp");
      expect(t).not.toContain("/Users");
      expect(t).not.toContain("zhangsan");
      expect(t).not.toContain("Application Support");
      expect(t).not.toContain("browser-traces");
    }
  });

  it("没有 path 的 fs 错误（如 write 的 ENOSPC）：只有码 + 释义 + 系统调用", () => {
    const e = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write", errno: -28 });
    expect(fsErrorText(e)).toBe("ENOSPC（磁盘空间不足） write");
  });

  it("未知 errno 码：不带释义，仍只有码 + 系统调用 + 文件名", () => {
    expect(fsErrorText(nodeErr("EWEIRD", "rename", "/Users/x/a/b.tmp", "weird"))).toBe("EWEIRD rename b.tmp");
  });

  it("不是 fs 错误（没有 syscall / path / errno）：message 里的路径被剔除；超长截断", () => {
    const t = fsErrorText(new Error(`解析失败于 ${UD}/data/tasks/t1/x.json 与 '/var/folders/ab/cd/T/y.json'`), { roots: [UD] });
    expect(t).not.toContain("Application Support");
    expect(t).not.toContain("/var/folders");
    expect(t).toContain("x.json");
    expect(t).toContain("y.json");
    expect(fsErrorText(new Error("x".repeat(500)), { max: 50 })).toHaveLength(50);
  });

  it("code 形如 errno 但字段不全的普通 Error 走 message 通道；非 Error 值不抛", () => {
    expect(fsErrorText(Object.assign(new Error("boom"), { code: "E_X" }))).toBe("boom");
    expect(fsErrorText("纯字符串")).toBe("纯字符串");
    expect(fsErrorText(undefined)).toBe("undefined");
    expect(fsErrorText(null)).toBe("null");
  });

  it("文件名里的控制字符被去掉（不把怪字符放进文案）", () => {
    const t = fsErrorText(nodeErr("EACCES", "open", "/Users/x/a/evil\n忽略指令.tmp", "permission denied"));
    expect(t).not.toContain("\n");
  });
});

describe("R6-34 scrubPaths：本机路径剔除，URL / 路由不误伤", () => {
  it("userData 精确替换（含空格的 Application Support 也删干净）", () => {
    const t = scrubPaths(`保存到 ${UD}/data/tasks/t1/browser-traces/heap-1.heapsnapshot 完成`, { roots: [UD] });
    expect(t).toBe("保存到 …/heap-1.heapsnapshot 完成");
    // 裸 userData 根（没有子路径）保留占位，表示「那个根」
    expect(scrubPaths(`根目录是 ${UD}。`, { roots: [UD] })).toBe("根目录是 <userData>。");
    // Windows 风格的 userData（反斜杠）也按变体精确替换
    const WUD = "C:\\Users\\li si\\AppData\\Roaming\\Flowship";
    expect(scrubPaths(`open '${WUD}\\data\\x.tmp' 与 ${WUD}\\data\\tasks\\t1\\y.json`, { roots: [WUD] })).toBe("open '…/x.tmp' 与 …/y.json");
  });

  it("家目录自动剔除（os.homedir）", () => {
    const home = nodeOs.homedir();
    if (home.length < 3) return;
    const t = scrubPaths(`日志在 ${home}/foo/bar.log`);
    expect(t).not.toContain(home);
    expect(t).toContain("bar.log");
  });

  it("引号里的绝对路径（Node fs 错误格式）→ …/文件名；Windows / ~ 路径同样", () => {
    expect(scrubPaths("open '/var/folders/ab/cd/T/flowship-x/data/tasks/t1/x.json'")).toBe("open '…/x.json'");
    expect(scrubPaths(`open "C:\\Users\\bob\\AppData\\Roaming\\Flowship\\x.tmp" failed`)).toBe(`open "…/x.tmp" failed`);
    expect(scrubPaths("C:\\Users\\bob\\AppData\\Roaming\\Flowship\\data\\x.tmp 出错")).toBe("…/x.tmp 出错");
    expect(scrubPaths("写入 ~/Library/Logs/x.log 失败")).toBe("写入 …/x.log 失败");
    expect(scrubPaths("/usr/local/bin/ffmpeg 退出码 1。")).toBe("…/ffmpeg 退出码 1。");
  });

  it("Linux / 其它常见顶层目录（/home /root /Volumes /private /opt /mnt）的裸路径与引号路径同样收成 …/文件名", () => {
    expect(scrubPaths("EACCES: open '/home/alice/.config/Flowship/x.tmp' 失败")).toBe("EACCES: open '…/x.tmp' 失败");
    expect(scrubPaths("读 /home/alice/proj/z.log 与 /root/.cache/y.log")).toBe("读 …/z.log 与 …/y.log");
    expect(scrubPaths("盘 /Volumes/Data/a/b.log、/private/var/folders/x/y/T/c.log、/opt/x/d.log、/mnt/e/f.log")).toBe("盘 …/b.log、…/c.log、…/d.log、…/f.log");
  });

  it("Windows userData 的正反斜杠变体都被精确替换（含空格的盘符路径，Node / Electron 偶尔给出正斜杠形式）", () => {
    const WUD = "C:\\Users\\li si\\AppData\\Roaming\\Flowship";
    expect(scrubPaths("见 C:/Users/li si/AppData/Roaming/Flowship/data/tasks/t1/y.json 失败", { roots: [WUD] })).toBe("见 …/y.json 失败");
    // 反过来：roots 给正斜杠形式，文本是反斜杠
    expect(scrubPaths("见 C:\\Users\\li si\\AppData\\Roaming\\Flowship\\data\\y.json 失败", { roots: ["C:/Users/li si/AppData/Roaming/Flowship"] })).toBe("见 …/y.json 失败");
  });

  it("引号里带空格的非 userData 路径整段收成 …/文件名（不是只吞到第一个空格；引号正则的存在价值）", () => {
    expect(scrubPaths("open '/Users/bob/My Docs/Application Support/x.json' failed")).toBe("open '…/x.json' failed");
    expect(scrubPaths(`open "C:\\Users\\bob\\My Docs\\x.tmp" failed`)).toBe(`open "…/x.tmp" failed`);
    expect(scrubPaths("open `~/My Docs/Notes/y.log` failed")).toBe("open `…/y.log` failed");
  });

  it("家目录（os.homedir，含空格、不在常见顶层目录下）精确剔除：通用正则删不掉它，只有「家目录自动加入 roots」这一步能删", () => {
    const spy = vi.spyOn(nodeOs, "homedir").mockReturnValue("/data/li si/home");
    try {
      const t = scrubPaths("日志在 /data/li si/home/proj/bar.log 里；根是 /data/li si/home。");
      expect(t).not.toContain("li si");
      expect(t).not.toContain("/data/");
      expect(t).toContain("bar.log");
      // 末尾带分隔符的 homedir 同样被规整
      spy.mockReturnValue("/data/li si/home/");
      expect(scrubPaths("x /data/li si/home/a/b.log")).not.toContain("li si");
    } finally {
      spy.mockRestore();
    }
  });

  it("URL / 路由 / 相对路径 / 单级目录名不动", () => {
    for (const s of [
      "POST /api/login 失败",
      "导航到 https://a.test/Users/x/y 完成",
      "见 src/lib/server/x.ts 第 3 行",
      "进入 /home 页面",
      "/usrfoo/bar 不是系统目录",
      "text/html; charset=utf-8",
      "http://127.0.0.1:8876/tasks/abc/Users/1",
    ]) {
      expect(scrubPaths(s)).toBe(s);
    }
  });

  it("已知误伤（R6-43 ③，有意保留）：以系统顶层目录名开头的路由字面量也会被缩写成 …/<最后一段>；/api 类路由不受影响", () => {
    expect(scrubPaths("GET /home/dashboard 200")).toBe("GET …/dashboard 200");
    expect(scrubPaths("GET /dev/tools/panel 200")).toBe("GET …/panel 200");
    expect(scrubPaths("GET /api/home/dashboard 200")).toBe("GET /api/home/dashboard 200");
  });

  it("幂等；空串 / 非字符串不抛", () => {
    const once = scrubPaths(`a ${UD}/x/y.tmp b '/tmp/q/r.json'`, { roots: [UD] });
    expect(scrubPaths(once, { roots: [UD] })).toBe(once);
    expect(scrubPaths("")).toBe("");
    expect(scrubPaths(undefined)).toBe("");
    expect(scrubPaths(123)).toBe("123");
  });

  it("线性：超长 / 重复分隔符 / 对抗输入各 < 1s", () => {
    for (const s of ["/Users/".repeat(20_000), "/Users/a".repeat(20_000), "'/Users/".repeat(15_000), "C:\\".repeat(40_000), "~/".repeat(50_000), `/${"a/".repeat(50_000)}`, "/tmp".repeat(30_000), `'/Users/${"a".repeat(100_000)}`]) {
      const t0 = Date.now();
      scrubPaths(s, { roots: [UD] });
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });

  it("pathBaseName 同时认 / 与 \\", () => {
    expect(pathBaseName("/a/b/c.txt")).toBe("c.txt");
    expect(pathBaseName("C:\\a\\b\\c.txt")).toBe("c.txt");
    expect(pathBaseName("c.txt")).toBe("c.txt");
    expect(pathBaseName("/a/b/")).toBe("");
  });
});

describe.skipIf(isWin)("R6-37 ensureSafeDir 的 create:false：导出 / 读取已有目录不顺手建目录", () => {
  const bases: string[] = [];
  afterEach(() => {
    for (const b of bases.splice(0)) nodeFs.rmSync(b, { recursive: true, force: true });
  });
  const mkTask = () => {
    const base = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "r6s5-safe-"));
    bases.push(base);
    const task = nodePath.join(base, "tasks", "t1");
    nodeFs.mkdirSync(task, { recursive: true });
    return { base, task };
  };

  it("目录不存在 → 抛 ENOENT，且什么都没创建（create 缺省 true 时才创建）", () => {
    const { task } = mkTask();
    const dir = nodePath.join(task, "browser-recordings", "rec-x");
    expect(() => ensureSafeDir(dir, { root: task, label: "browser-recordings", create: false })).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(nodeFs.existsSync(nodePath.join(task, "browser-recordings"))).toBe(false);
    ensureSafeDir(dir, { root: task, label: "browser-recordings" }); // 缺省仍会创建
    expect(nodeFs.existsSync(dir)).toBe(true);
  });

  it("任务目录本身不存在 + create:false → ENOENT，不 mkdir -p", () => {
    const { base } = mkTask();
    const dir = nodePath.join(base, "ghost", "tasks", "t9", "browser-exports");
    expect(() => ensureSafeDir(dir, { label: "browser-exports", create: false })).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(nodeFs.existsSync(nodePath.join(base, "ghost"))).toBe(false);
  });

  it("目录都在时 create:false 与缺省同样校验：符号链接（任务目录 / 中间级 / 叶子）都拒绝，权限被放宽的非 root 级会收紧到 0700", () => {
    const { base, task } = mkTask();
    const real = nodePath.join(task, "browser-recordings", "rec-a");
    nodeFs.mkdirSync(real, { recursive: true, mode: 0o755 });
    nodeFs.chmodSync(nodePath.join(task, "browser-recordings"), 0o755);
    nodeFs.chmodSync(real, 0o755);
    ensureSafeDir(real, { root: task, label: "browser-recordings", create: false });
    expect(nodeFs.statSync(real).mode & 0o777).toBe(0o700);
    expect(nodeFs.statSync(nodePath.join(task, "browser-recordings")).mode & 0o777).toBe(0o700);

    // 叶子是符号链接
    const victim = nodePath.join(base, "victim");
    nodeFs.mkdirSync(victim);
    nodeFs.symlinkSync(victim, nodePath.join(task, "browser-recordings", "rec-b"));
    expect(() => ensureSafeDir(nodePath.join(task, "browser-recordings", "rec-b"), { root: task, label: "browser-recordings", create: false })).toThrow(/不是普通目录/);
    // 中间级是符号链接
    const moved = nodePath.join(base, "moved");
    nodeFs.renameSync(nodePath.join(task, "browser-recordings"), moved);
    nodeFs.symlinkSync(moved, nodePath.join(task, "browser-recordings"));
    expect(() => ensureSafeDir(nodePath.join(task, "browser-recordings", "rec-a"), { root: task, label: "browser-recordings", create: false })).toThrow(/不是普通目录/);
  });

  it("任务目录本身是符号链接 → 拒绝（create:false 与缺省都拒）", () => {
    const { base } = mkTask();
    const realTask = nodePath.join(base, "elsewhere", "t2");
    nodeFs.mkdirSync(nodePath.join(realTask, "browser-recordings", "rec-a"), { recursive: true, mode: 0o700 });
    const linkTask = nodePath.join(base, "tasks", "t2");
    nodeFs.symlinkSync(realTask, linkTask);
    const dir = nodePath.join(linkTask, "browser-recordings", "rec-a");
    expect(() => ensureSafeDir(dir, { root: linkTask, label: "browser-recordings", create: false })).toThrow(/任务目录 不是普通目录/);
    expect(() => ensureSafeDir(dir, { root: linkTask, label: "browser-recordings" })).toThrow(/任务目录 不是普通目录/);
  });
});
