/**
 * 端口被占时占用者身份判定（评审 P2：ensurePortFree 盲杀占用端口的任意进程）。
 */
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildForeignOwnerDialog,
  buildPidCommandQuery,
  buildServerPidRecord,
  classifyPortOwners,
  intersectPortOwners,
  isFlowshipServerCommand,
  isNextServerTitle,
  killPidList,
  parseServerPidRecord,
  planPortCleanup,
  shouldClearServerPidRecord,
} from "../electron-app/port-owner.mjs";
import { instantiate, mainSrc, sliceMainFn } from "./helpers/main-slice";

const OURS_MAC =
  "/Applications/Flowship.app/Contents/Frameworks/Flowship Helper.app/Contents/MacOS/Flowship Helper --max-old-space-size=4096 /Applications/Flowship.app/Contents/Resources/app-server/server.js";
const OURS_WIN =
  'C:\\Users\\a\\AppData\\Local\\Programs\\Flowship\\Flowship.exe --max-old-space-size=4096 "C:\\Users\\a\\AppData\\Local\\Programs\\Flowship\\resources\\app-server\\server.js"';
const DEV_SERVER = "node /Users/x/work/other/node_modules/.bin/next dev -p 8876";
// 真机 `ps -p <pid> -o command=` 的 server 输出（Next 改了 process.title，看不到 server.js 路径）
const OURS_MAC_REAL_PS = "next-server (v15.5.28)";

describe("isFlowshipServerCommand", () => {
  it("mac / win 打包后的 server 命令行、dev 的 dist/app-server 都认", () => {
    expect(isFlowshipServerCommand(OURS_MAC)).toBe(true);
    expect(isFlowshipServerCommand(OURS_WIN)).toBe(true);
    expect(isFlowshipServerCommand("node /repo/dist/app-server/server.js")).toBe(true);
  });
  it("别的程序 / 空 / 非字符串都不认", () => {
    expect(isFlowshipServerCommand(DEV_SERVER)).toBe(false);
    expect(isFlowshipServerCommand("")).toBe(false);
    expect(isFlowshipServerCommand(null)).toBe(false);
    expect(isFlowshipServerCommand(undefined)).toBe(false);
    // 只是路径里有 app-server 但不是它的入口
    expect(isFlowshipServerCommand("node /x/app-server-tools/run.js")).toBe(false);
  });

  // 评审 P3：正则以前没锚定，`webapp-server/server.js` 这类别人的命令行也命中、命中后还会整组 SIGKILL
  it("目录名只是「以 app-server 结尾」的别人的程序不命中（前缀没锚定的回归）", () => {
    for (const cmd of [
      "node /x/webapp-server/server.js",
      "node /x/my-app-server/server.js",
      "node /x/foo_app-server/server.js",
      "node /x/myapp-server/server.js",
      "node /x/2app-server/server.js",
      "node C:\\x\\webapp-server\\server.js",
      '"C:\\x\\my-app-server\\server.js"',
      "webapp-server/server.js", // 行首也一样：app-server 前面是别的字符
    ]) {
      expect(isFlowshipServerCommand(cmd), cmd).toBe(false);
    }
  });
  it("入口文件名只是以 server.js 开头的别的文件不命中（后缀没锚定）", () => {
    for (const cmd of [
      "node /x/app-server/server.json",
      "node /x/app-server/server.js.map",
      "node /x/app-server/server.jsx",
      "node /x/app-server/server.js~",
    ]) {
      expect(isFlowshipServerCommand(cmd), cmd).toBe(false);
    }
  });
  it("真实打包路径 / dev 路径 / Windows 路径（带空格、带引号、反斜杠、混合分隔符、大小写）都不能被误拒", () => {
    for (const cmd of [
      OURS_MAC,
      OURS_WIN,
      // 路径带空格（mac 的用户名 / Windows 的 Program Files），命令行里没有引号、server.js 后面还有参数
      "/Users/John Smith/Apps/Flowship.app/Contents/Resources/app-server/server.js --port 8876",
      "C:\\Program Files\\Flowship\\Flowship.exe C:\\Program Files\\Flowship\\resources\\app-server\\server.js",
      // 带引号：双引号 / 单引号包着整条路径，server.js 紧贴结尾引号
      '"C:\\Program Files\\Flowship\\Flowship.exe" "C:\\Program Files\\Flowship\\resources\\app-server\\server.js"',
      "node '/opt/Flowship test/resources/app-server/server.js'",
      // dev：相对路径、行首、dist 下
      "node dist/app-server/server.js",
      "app-server/server.js",
      "node /repo/dist/app-server/server.js",
      // 分隔符重复 / 混用 / 大小写不敏感 / 行尾带换行
      "node C:\\repo\\dist/app-server\\server.js",
      "node /x/app-server//server.js",
      "NODE C:\\X\\APP-SERVER\\SERVER.JS",
      "node /x/app-server/server.js\r\n",
    ]) {
      expect(isFlowshipServerCommand(cmd), cmd).toBe(true);
    }
  });
});

describe("classifyPortOwners", () => {
  it("没查到占用者 → none（调用方保持原逻辑）", () => {
    expect(classifyPortOwners([]).kind).toBe("none");
    expect(classifyPortOwners(undefined as never).kind).toBe("none");
  });
  it("全是 Flowship 自己的 server → ours", () => {
    const r = classifyPortOwners([
      { pid: 11, command: OURS_MAC },
      { pid: 12, command: OURS_MAC },
    ]);
    expect(r).toEqual({ kind: "ours", ours: [11, 12], others: [] });
  });
  it("有确认不是 Flowship 的（拿到命令行但不匹配）→ foreign，others 含它", () => {
    const r = classifyPortOwners([
      { pid: 11, command: OURS_MAC },
      { pid: 99, command: DEV_SERVER },
    ]);
    expect(r.kind).toBe("foreign");
    expect(r.ours).toEqual([11]);
    expect(r.others).toEqual([{ pid: 99, command: DEV_SERVER }]);
  });
  it("读不到命令行（null / 空白）→ unknown：不当成自己人、也不武断说是别人", () => {
    expect(classifyPortOwners([{ pid: 5, command: null }]).kind).toBe("unknown");
    expect(classifyPortOwners([{ pid: 5, command: "  " }]).kind).toBe("unknown");
    // unknown + ours 混合仍是 unknown
    expect(
      classifyPortOwners([
        { pid: 5, command: null },
        { pid: 6, command: OURS_MAC },
      ]).kind,
    ).toBe("unknown");
  });
  it("foreign 优先于 unknown", () => {
    expect(
      classifyPortOwners([
        { pid: 5, command: null },
        { pid: 6, command: DEV_SERVER },
      ]).kind,
    ).toBe("foreign");
  });
});

describe("mac / Linux 真机：server 标题是 next-server (v…)（评审 N1）", () => {
  it("isNextServerTitle 只认 `next-server (v<数字>…` 开头", () => {
    expect(isNextServerTitle(OURS_MAC_REAL_PS)).toBe(true);
    expect(isNextServerTitle("  next-server (v16.0.0)  ")).toBe(true);
    expect(isNextServerTitle("node next-server (v15.5.28)")).toBe(false);
    expect(isNextServerTitle("next-server")).toBe(false);
    expect(isNextServerTitle(null)).toBe(false);
  });
  it("标题吻合 + pid 等于上次记录的 server pid → ours", () => {
    const r = classifyPortOwners([{ pid: 4242, command: OURS_MAC_REAL_PS }], {
      recordedServerPid: 4242,
    });
    expect(r).toEqual({ kind: "ours", ours: [4242], others: [] });
  });
  it("没有记录 / 记录的 pid 不同（别的项目的 next start 同样叫 next-server；也可能是升级后记录丢了的自家旧 server）→ 不当自己人，但也不武断说「不是 Flowship」：unknown", () => {
    expect(classifyPortOwners([{ pid: 4242, command: OURS_MAC_REAL_PS }]).kind).toBe("unknown");
    expect(
      classifyPortOwners([{ pid: 4242, command: OURS_MAC_REAL_PS }], { recordedServerPid: 2 }).kind,
    ).toBe("unknown");
    expect(
      classifyPortOwners([{ pid: 4242, command: OURS_MAC_REAL_PS }], { recordedServerPid: null }).kind,
    ).toBe("unknown");
    // unknown 的弹窗文案是「无法确认」、不说「不是 Flowship 的服务」，且列出 pid 与命令行让用户自己判断
    const d = buildForeignOwnerDialog(
      8876,
      classifyPortOwners([{ pid: 4242, command: OURS_MAC_REAL_PS }]),
    );
    expect(d.message).toContain("无法确认");
    expect(d.message).not.toContain("不是 Flowship 的服务");
    expect(d.detail).toContain("pid 4242：next-server (v15.5.28)");
    // 同时有别的确认不是 Flowship 的 → 仍是 foreign
    expect(
      classifyPortOwners([
        { pid: 4242, command: OURS_MAC_REAL_PS },
        { pid: 99, command: DEV_SERVER },
      ]).kind,
    ).toBe("foreign");
  });
  it("pid 对得上但命令行不是 next-server 标题（pid 被复用成别的程序）→ 不当自己人", () => {
    expect(
      classifyPortOwners([{ pid: 4242, command: DEV_SERVER }], { recordedServerPid: 4242 }).kind,
    ).toBe("foreign");
    expect(
      classifyPortOwners([{ pid: 4242, command: null }], { recordedServerPid: 4242 }).kind,
    ).toBe("unknown");
  });
  it("server-pid.json 往返：只认正整数 pid，坏数据 → null", () => {
    expect(parseServerPidRecord(buildServerPidRecord(777, 8876, 1))).toBe(777);
    for (const bad of ["", "not json", "{}", '{"pid":0}', '{"pid":1}', '{"pid":-3}', '{"pid":"x"}', '{"pid":1.5}']) {
      expect(parseServerPidRecord(bad)).toBeNull();
    }
  });
  it("记录的端口与当前端口不一致 → 记录不适用（null）；没传 port 时不校验", () => {
    const rec = buildServerPidRecord(777, 8876, 1);
    expect(parseServerPidRecord(rec, { port: 8876 })).toBe(777);
    expect(parseServerPidRecord(rec, { port: 8877 })).toBeNull();
    expect(parseServerPidRecord(rec)).toBe(777);
  });
});

describe("buildForeignOwnerDialog", () => {
  it("列出 pid 与命令行（超长截断）、默认按钮是「退出」、关闭需明确点第二个按钮", () => {
    const long = `node ${"x".repeat(500)}`;
    const d = buildForeignOwnerDialog(
      8876,
      classifyPortOwners([
        { pid: 99, command: long },
        { pid: 100, command: null },
      ]),
    );
    expect(d.message).toContain("8876");
    expect(d.message).toContain("其他程序");
    expect(d.detail).toContain("pid 99");
    expect(d.detail).toContain("pid 100：（读不到命令行）");
    expect(d.detail).not.toContain("x".repeat(200));
    expect(d.buttons).toEqual(["退出", "仍然关闭它"]);
    expect(d.defaultId).toBe(0);
    expect(d.cancelId).toBe(0);
  });
  it("无法确认身份时文案不武断地说「不是 Flowship」", () => {
    const d = buildForeignOwnerDialog(8876, classifyPortOwners([{ pid: 5, command: null }]));
    expect(d.message).toContain("无法确认");
    expect(d.message).not.toContain("不是 Flowship 的服务");
  });
});

describe("buildPidCommandQuery（读 pid 命令行的外部命令）", () => {
  it("unix：ps -p <pid> -o command=", () => {
    expect(buildPidCommandQuery(1234, "darwin")).toEqual({
      cmd: "ps",
      args: ["-p", "1234", "-o", "command="],
    });
    expect(buildPidCommandQuery("4321", "linux")?.args).toEqual(["-p", "4321", "-o", "command="]);
  });
  it("win32：PowerShell CIM 只取 CommandLine，pid 以数字拼入", () => {
    const q = buildPidCommandQuery(77, "win32");
    expect(q?.cmd).toBe("powershell.exe");
    expect(q?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(q?.args[3]).toBe('(Get-CimInstance Win32_Process -Filter "ProcessId=77").CommandLine');
  });
  it("pid 不是正整数（含试图注入的字符串）→ null，不拼进脚本", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "1; calc", "", null, undefined]) {
      expect(buildPidCommandQuery(bad as never, "win32")).toBeNull();
      expect(buildPidCommandQuery(bad as never, "darwin")).toBeNull();
    }
  });
  it("main.js 自己不内联 PowerShell CIM（startup-boot-contract 的约束），只经 buildPidCommandQuery", () => {
    expect(mainSrc).not.toContain("Get-CimInstance");
    expect(sliceMainFn("getPidCommand")).toContain("buildPidCommandQuery(pid)");
  });
});

describe("ensurePortFree 接线（源码）", () => {
  const body = sliceMainFn("ensurePortFree");
  // 行为（谁组杀 / 谁单杀 / 弹窗期间 pid 变化）在下面「ensurePortFree 行为测试」里真跑函数体；这里只钉接线契约
  it("先查占用者命令行并交给 planPortCleanup 决策，别的程序 / 无法确认走独立弹窗，只有点第二个按钮才继续杀", () => {
    expect(body).toContain("planPortCleanup(owners, { recordedServerPid: readRecordedServerPid() })");
    expect(body).toContain("getPidCommand(pid)");
    expect(body).toContain('plan.dialog !== "ours"');
    expect(body).toContain("if (response !== 1) return false;");
  });
  it("killPids 之前一定已经过身份判定（不再在弹窗前后盲目 findPortPids → killPids）", () => {
    expect(body.indexOf("planPortCleanup(owners")).toBeLessThan(body.indexOf("await killPids("));
    expect(mainSrc).toContain('from "./port-owner.mjs"');
  });
  it("杀人名单只来自 planPortCleanup 的 groupKill / singleKill 与弹窗后重查的交集；killPids 恰好两处调用、只有 groupKill 带 group:true", () => {
    expect(body).toContain("intersectPortOwners(plan.groupKill, livePids)");
    expect(body).toContain("intersectPortOwners(plan.singleKill, livePids)");
    expect(body).toContain("await killPids(groupKill, { group: true });");
    expect(body).toContain("await killPids(singleKill);");
    // 不能再有第三处杀法（比如把 rawPids 整个丢进 group:true）
    expect(body.match(/killPids\(/g)).toHaveLength(2);
    expect(body.match(/group: true/g)).toHaveLength(1);
    expect(body).not.toMatch(/killPids\(\s*rawPids/);
    // 重查（livePids）一定发生在最后一个弹窗之后、第一次 killPids 之前
    const lastDialog = body.lastIndexOf("dialog.showMessageBox(");
    const recheck = body.indexOf("livePids = await findPortPids()");
    expect(lastDialog).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(lastDialog);
    expect(recheck).toBeLessThan(body.indexOf("await killPids("));
    // killPids 本身只是 killPidList 的薄包装（杀法在 killPidList 的行为测试里）
    const kp = sliceMainFn("killPids");
    expect(kp).toContain("killPidList(pids");
    expect(kp).toContain("group,");
  });
  it("拉起 server 后写 pid 记录（下次端口被占时核对身份）；server 退出时清掉「记录的 pid 就是它」的记录", () => {
    const ss = sliceMainFn("startServer");
    expect(ss).toContain("writeServerPidRecord(proc.pid)");
    expect(ss).toContain("clearServerPidRecord(proc.pid)");
    // 读记录时带当前端口校验
    expect(sliceMainFn("readRecordedServerPid")).toContain("{ port: PORT }");
    // 原子写：tmp + rename
    const w = sliceMainFn("writeServerPidRecord");
    expect(w).toContain("renameSync(tmp, file)");
  });
  it("clearServerPidRecord 的「该不该清」判定走 shouldClearServerPidRecord（行为见下面的 clearServerPidRecord 行为测试）", () => {
    expect(sliceMainFn("clearServerPidRecord")).toContain("shouldClearServerPidRecord(recorded, pid)");
    expect(mainSrc).not.toContain("recorded === pid");
  });
});

describe("killPidList（行为测试：注入 kill / taskkill，不碰真进程）", () => {
  const mk = (platform: NodeJS.Platform, killImpl?: (pid: number, sig: string) => void) => {
    const kills: Array<[number, string]> = [];
    const taskkills: string[][] = [];
    return {
      kills,
      taskkills,
      deps: {
        platform,
        kill: (pid: number, sig: string) => {
          kills.push([pid, sig]);
          killImpl?.(pid, sig);
        },
        taskkill: async (args: string[]) => {
          taskkills.push(args);
        },
      },
    };
  };

  it("unix group=true：先 kill(-pid) 按进程组杀，成功就不再单杀", async () => {
    const { kills, deps } = mk("darwin");
    await killPidList([100, 200], { group: true, ...deps });
    expect(kills).toEqual([
      [-100, "SIGKILL"],
      [-200, "SIGKILL"],
    ]);
  });
  it("unix group=true 但 pid 不是组长（ESRCH）：退回单 pid SIGKILL", async () => {
    const { kills, deps } = mk("linux", (pid) => {
      if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    await killPidList([100], { group: true, ...deps });
    expect(kills).toEqual([
      [-100, "SIGKILL"],
      [100, "SIGKILL"],
    ]);
  });
  it("unix group=false（别人 / 不明占用者）：只杀被点名的那一个 pid，绝不发负 pid", async () => {
    const { kills, deps } = mk("darwin");
    await killPidList([100], { group: false, ...deps });
    expect(kills).toEqual([[100, "SIGKILL"]]);
    const dflt = mk("darwin");
    await killPidList([7], { ...dflt.deps });
    expect(dflt.kills).toEqual([[7, "SIGKILL"]]);
  });
  it("单 pid 也已不在：吞掉，继续处理后面的", async () => {
    const { kills, deps } = mk("darwin", (pid) => {
      if (pid === 100) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    await killPidList([100, 200], { group: false, ...deps });
    expect(kills).toEqual([
      [100, "SIGKILL"],
      [200, "SIGKILL"],
    ]);
  });
  it("pid ≤ 1 / 非整数一律跳过（kill(-1) / kill(0) / kill(1) 的语义是所有进程 / 本组 / init）", async () => {
    const { kills, taskkills, deps } = mk("darwin");
    await killPidList([-1, 0, 1, 1.5, Number.NaN, 100], { group: true, ...deps });
    expect(kills).toEqual([[-100, "SIGKILL"]]);
    const w = mk("win32");
    await killPidList([0, 1, 5], { group: true, ...w.deps });
    expect(w.taskkills).toEqual([["/PID", "5", "/T", "/F"]]);
    expect(taskkills).toEqual([]);
  });
  it("win32：group=true 才带 /T（连进程树）；别的占用者只 /F 那一个进程", async () => {
    const g = mk("win32");
    await killPidList([42], { group: true, ...g.deps });
    expect(g.taskkills).toEqual([["/PID", "42", "/T", "/F"]]);
    const f = mk("win32");
    await killPidList([42], { group: false, ...f.deps });
    expect(f.taskkills).toEqual([["/PID", "42", "/F"]]);
    expect(f.kills).toEqual([]);
  });
  it("win32 taskkill 失败（进程已不在 / 无权限）：吞掉、继续下一个（调用方随后轮询端口是否释放）", async () => {
    const kills: string[][] = [];
    await killPidList([42, 43], {
      group: false,
      platform: "win32",
      kill: () => {},
      taskkill: async (args) => {
        kills.push(args);
        if (args[1] === "42") throw new Error("not found");
      },
    });
    expect(kills.map((a) => a[1])).toEqual(["42", "43"]);
  });
});

describe("intersectPortOwners（弹窗前后两次占用者取交集：pid 在弹窗期间可能已退出并被复用）", () => {
  it("只留弹窗前确认过、且现在仍在监听的 pid；保持弹窗前的顺序", () => {
    expect(intersectPortOwners([300, 100, 200], [200, 300, 400])).toEqual([300, 200]);
  });
  it("弹窗期间新冒出来的监听者（只在 after）不杀——用户没看过、没确认过", () => {
    expect(intersectPortOwners([100], [100, 999])).toEqual([100]);
    expect(intersectPortOwners([], [999])).toEqual([]);
  });
  it("都已退出（after 为空 / 不是数组）→ 谁也不杀", () => {
    expect(intersectPortOwners([100, 200], [])).toEqual([]);
    expect(intersectPortOwners([100, 200], undefined as never)).toEqual([]);
    expect(intersectPortOwners(undefined as never, [100])).toEqual([]);
  });
  it("去重；pid ≤ 1 / 非整数永远进不了名单（kill(-1) / kill(0) / kill(1) 的语义是所有进程 / 本组 / init）", () => {
    expect(intersectPortOwners([100, 100, 100], [100])).toEqual([100]);
    expect(intersectPortOwners([-1, 0, 1, 1.5, Number.NaN, 100], [-1, 0, 1, 1.5, Number.NaN, 100])).toEqual([100]);
  });
});

describe("planPortCleanup（占用者 + 记录 pid → 弹哪种窗 / 哪些组杀 / 哪些单杀）", () => {
  it("全是自家 server：全部组杀、没有单杀、老文案弹窗", () => {
    const p = planPortCleanup([
      { pid: 11, command: OURS_MAC },
      { pid: 12, command: OURS_WIN },
    ]);
    expect(p).toMatchObject({ dialog: "ours", groupKill: [11, 12], singleKill: [] });
    expect(p.classification.kind).toBe("ours");
  });
  it("自家 + 别人混合：只有自家的组杀，别人只单杀（不会因为同一次清理被连带整组杀）", () => {
    const p = planPortCleanup([
      { pid: 11, command: OURS_MAC },
      { pid: 99, command: DEV_SERVER },
      { pid: 100, command: null },
    ]);
    expect(p).toMatchObject({ dialog: "foreign", groupKill: [11], singleKill: [99, 100] });
  });
  it("全是别人 / 无法确认：一个都不组杀", () => {
    expect(planPortCleanup([{ pid: 99, command: DEV_SERVER }])).toMatchObject({
      dialog: "foreign",
      groupKill: [],
      singleKill: [99],
    });
    expect(planPortCleanup([{ pid: 5, command: null }])).toMatchObject({
      dialog: "unknown",
      groupKill: [],
      singleKill: [5],
    });
  });
  it("webapp-server/server.js 这类目录名恰好以 app-server 结尾的别人的程序：不组杀（正则锚定的端到端效果）", () => {
    expect(planPortCleanup([{ pid: 77, command: "node /x/webapp-server/server.js" }])).toMatchObject({
      dialog: "foreign",
      groupKill: [],
      singleKill: [77],
    });
  });
  it("mac 真机：next-server 标题 + pid 等于记录 → 组杀；没有记录 / 记录对不上 → 单杀（unknown 弹窗）", () => {
    const owners = [{ pid: 4242, command: OURS_MAC_REAL_PS }];
    expect(planPortCleanup(owners, { recordedServerPid: 4242 })).toMatchObject({
      dialog: "ours",
      groupKill: [4242],
      singleKill: [],
    });
    for (const opts of [{}, { recordedServerPid: null }, { recordedServerPid: 4243 }]) {
      expect(planPortCleanup(owners, opts)).toMatchObject({
        dialog: "unknown",
        groupKill: [],
        singleKill: [4242],
      });
    }
  });
  it("没查到占用者：沿用老弹窗、两个名单都空（调用方照常等端口释放）", () => {
    expect(planPortCleanup([])).toMatchObject({ dialog: "ours", groupKill: [], singleKill: [] });
    expect(planPortCleanup(undefined as never)).toMatchObject({ dialog: "ours", groupKill: [], singleKill: [] });
  });
  it("不变量：groupKill 与 singleKill 不相交、并集 = 去重后的有效 pid；pid ≤ 1 / 重复不进名单", () => {
    const owners = [
      { pid: 11, command: OURS_MAC },
      { pid: 11, command: OURS_MAC },
      { pid: 0, command: OURS_MAC },
      { pid: 1, command: DEV_SERVER },
      { pid: -5, command: null },
      { pid: 12, command: DEV_SERVER },
    ];
    const p = planPortCleanup(owners);
    expect(p.groupKill).toEqual([11]);
    expect(p.singleKill).toEqual([12]);
    expect(p.groupKill.filter((x: number) => p.singleKill.includes(x))).toEqual([]);
  });
});

describe("planPortCleanup × 真实 `ps` 样本（自己起的临时子进程，用完 SIGKILL 清理，不碰别的进程）", () => {
  const children: Array<ReturnType<typeof spawn>> = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
  });

  /** 起一个纯 node 空转子进程：可改 process.title（Next 的 start-server 就是这么把自己改名成 next-server (v…) 的）、可带只做 argv 展示的额外参数 */
  const spawnDummy = async (opts: { title?: string; extraArg?: string } = {}) => {
    const script =
      (opts.title ? `process.title=${JSON.stringify(opts.title)};` : "") +
      'process.stdout.write("ready\\n");setInterval(()=>{},1000);';
    const child = spawn(process.execPath, ["-e", script, ...(opts.extraArg ? ["--", opts.extraArg] : [])], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("临时子进程提前退出")));
      child.stdout!.once("data", () => resolve());
    });
    return child;
  };
  /** 与 main.js getPidCommand 同一条命令（buildPidCommandQuery）读 `ps -p <pid> -o command=`；title 改写是异步生效的，轮询到包含 want 为止 */
  const psCommand = async (pid: number, want?: string): Promise<string | null> => {
    const q = buildPidCommandQuery(pid)!;
    let last: string | null = null;
    for (let i = 0; i < 40; i++) {
      last = await new Promise<string | null>((resolve) => {
        execFile(q.cmd, q.args, (err, out) => resolve(err ? null : String(out).trim() || null));
      });
      if (!want || last?.includes(want)) return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    return last;
  };

  it.skipIf(process.platform === "win32")(
    "next-server 标题 + 记录 pid → 组杀；同端口上 webapp-server 冒牌货 / 普通 node → 只单杀；带真实 app-server/server.js 命令行 → 组杀",
    async () => {
      const title = "next-server (v15.5.28)";
      const ours = await spawnDummy({ title });
      const decoy = await spawnDummy({ extraArg: "/tmp/some/webapp-server/server.js" });
      const plain = await spawnDummy();
      const bundled = await spawnDummy({ extraArg: "/Applications/Flowship.app/Contents/Resources/app-server/server.js" });
      const owners = [
        { pid: ours.pid!, command: await psCommand(ours.pid!, title) },
        { pid: decoy.pid!, command: await psCommand(decoy.pid!, "webapp-server") },
        { pid: plain.pid!, command: await psCommand(plain.pid!) },
        { pid: bundled.pid!, command: await psCommand(bundled.pid!, "app-server") },
      ];
      // 样本确实是 ps 读出来的真东西
      expect(owners[0]!.command).toContain(title);
      expect(owners[1]!.command).toContain("webapp-server/server.js");
      expect(owners[3]!.command).toContain("Resources/app-server/server.js");

      const withRecord = planPortCleanup(owners, { recordedServerPid: ours.pid! });
      expect(withRecord.dialog).toBe("foreign");
      expect(withRecord.groupKill).toEqual([ours.pid!, bundled.pid!]);
      expect(withRecord.singleKill).toEqual([decoy.pid!, plain.pid!]);

      // 没有记录：标题吻合也不能当自己人（别的 Next 项目的 next start 同样叫这个标题）
      const noRecord = planPortCleanup(owners);
      expect(noRecord.groupKill).toEqual([bundled.pid!]);
      expect(noRecord.singleKill).toEqual([ours.pid!, decoy.pid!, plain.pid!]);
    },
    20_000,
  );
});

describe("ensurePortFree 行为测试（真跑 main.js 里的函数体：注入假的端口 / 弹窗 / kill，不碰真进程）", () => {
  type Owner = { pid: number; command: string | null };
  type World = {
    /** 当前仍在监听端口的 pid → 命令行 */
    listeners: Map<number, string | null>;
    /** 模拟 pid 在弹窗期间退出（并可能被无关进程复用——复用后的进程不监听这个端口，所以就是「不在 listeners 里」） */
    exit: (pid: number) => void;
    /** 模拟弹窗期间有新的监听者冒出来 */
    listen: (pid: number, command: string | null) => void;
  };
  const setup = (
    initial: Owner[],
    opts: {
      recorded?: number | null;
      /** 弹窗按钮：默认「ours 弹窗点确定(0) / foreign·unknown 弹窗点仍然关闭它(1)」 */
      response?: number;
      /** 用户还没点按钮时世界发生的变化 */
      duringDialog?: (w: World) => void;
      /** 用户点完之后的重查（第 2 次起的 findPortPids）抛错 */
      recheckThrows?: boolean;
    } = {},
  ) => {
    const listeners = new Map<number, string | null>(initial.map((o) => [o.pid, o.command]));
    let busy = true;
    const world: World = {
      listeners,
      exit: (pid) => {
        listeners.delete(pid);
        busy = listeners.size > 0;
      },
      listen: (pid, command) => {
        listeners.set(pid, command);
        busy = true;
      },
    };
    const killCalls: Array<{ pids: number[]; group: boolean }> = [];
    const dialogTitles: string[] = [];
    let findCalls = 0;
    const showErrorBox = vi.fn();
    const log = vi.fn();
    const deps = {
      PORT: 8876,
      isPortBusy: async () => busy,
      findPortPids: async () => {
        findCalls++;
        if (opts.recheckThrows && findCalls > 1) throw new Error("lsof 炸了");
        return [...listeners.keys()];
      },
      getPidCommand: async (pid: number) => listeners.get(pid) ?? null,
      readRecordedServerPid: () => opts.recorded ?? null,
      // 纯函数用真实实现（决策逻辑错了这里会红），只有副作用（弹窗 / kill / 日志 / sleep）是替身
      planPortCleanup,
      intersectPortOwners,
      buildForeignOwnerDialog,
      killPids: async (pids: number[], o: { group?: boolean } = {}) => {
        killCalls.push({ pids: [...pids], group: o.group === true });
        for (const pid of pids) listeners.delete(pid);
        busy = listeners.size > 0;
      },
      dialog: {
        showMessageBox: async (o: { title: string; buttons: string[] }) => {
          dialogTitles.push(o.title);
          opts.duringDialog?.(world);
          // ours 弹窗按钮是 ["确定","退出"]（0 = 继续）；foreign / unknown 弹窗是 ["退出","仍然关闭它"]（1 = 继续）
          return { response: opts.response ?? (o.buttons[0] === "确定" ? 0 : 1) };
        },
        showErrorBox,
      },
      log,
      sleep: async () => {},
    };
    const run = instantiate<() => Promise<boolean>>("ensurePortFree", deps);
    /** 只看真正杀了谁（killPids 对空名单也会被调用，不算） */
    const kills = () => killCalls.filter((c) => c.pids.length > 0);
    return { run, world, kills, dialogTitles, showErrorBox, log, findCalls: () => findCalls };
  };

  it("端口没被占：直接 true，不查占用者、不弹窗、不杀", async () => {
    const s = setup([]);
    // setup 初始 busy=true；这里要「没被占」：让唯一一次弹窗都不会出现——先把监听者清掉
    s.world.exit(0);
    await expect(s.run()).resolves.toBe(true);
    expect(s.dialogTitles).toEqual([]);
    expect(s.kills()).toEqual([]);
  });

  it("自家 server：整组杀（group:true）、没有单杀；老文案弹窗", async () => {
    const s = setup([
      { pid: 100, command: OURS_MAC },
      { pid: 101, command: OURS_WIN },
    ]);
    await expect(s.run()).resolves.toBe(true);
    expect(s.dialogTitles).toEqual(["端口被占用"]);
    expect(s.kills()).toEqual([{ pids: [100, 101], group: true }]);
  });

  it("别人的 / 身份不明的占用者：只单杀（绝不 group:true）；自家 + 别人混合时各走各的", async () => {
    const foreign = setup([{ pid: 200, command: DEV_SERVER }]);
    await expect(foreign.run()).resolves.toBe(true);
    expect(foreign.kills()).toEqual([{ pids: [200], group: false }]);

    const unknown = setup([{ pid: 201, command: null }]);
    await expect(unknown.run()).resolves.toBe(true);
    expect(unknown.kills()).toEqual([{ pids: [201], group: false }]);

    const mixed = setup([
      { pid: 100, command: OURS_MAC },
      { pid: 200, command: DEV_SERVER },
      { pid: 201, command: null },
    ]);
    await expect(mixed.run()).resolves.toBe(true);
    expect(mixed.kills()).toEqual([
      { pids: [100], group: true },
      { pids: [200, 201], group: false },
    ]);
    expect(mixed.dialogTitles).toEqual(["端口被占用"]);
  });

  it("webapp-server/server.js 冒牌货：不当自家 server、不整组杀", async () => {
    const s = setup([{ pid: 77, command: "node /x/webapp-server/server.js" }]);
    await expect(s.run()).resolves.toBe(true);
    expect(s.kills()).toEqual([{ pids: [77], group: false }]);
  });

  it("mac 真机 next-server 标题：pid 等于记录 → 整组杀；没有记录 → 只单杀", async () => {
    const withRecord = setup([{ pid: 4242, command: OURS_MAC_REAL_PS }], { recorded: 4242 });
    await expect(withRecord.run()).resolves.toBe(true);
    expect(withRecord.kills()).toEqual([{ pids: [4242], group: true }]);

    const noRecord = setup([{ pid: 4242, command: OURS_MAC_REAL_PS }]);
    await expect(noRecord.run()).resolves.toBe(true);
    expect(noRecord.kills()).toEqual([{ pids: [4242], group: false }]);
  });

  it("用户点「退出」：返回 false、不杀、也不再重查", async () => {
    const foreign = setup([{ pid: 200, command: DEV_SERVER }], { response: 0 });
    await expect(foreign.run()).resolves.toBe(false);
    expect(foreign.kills()).toEqual([]);
    expect(foreign.findCalls()).toBe(1);

    const ours = setup([{ pid: 100, command: OURS_MAC }], { response: 1 });
    await expect(ours.run()).resolves.toBe(false);
    expect(ours.kills()).toEqual([]);
    expect(ours.findCalls()).toBe(1);
  });

  it("没查到占用者但端口被占（lsof 失败 / 进程刚退）：弹老窗、不杀任何人、端口释放就放行", async () => {
    const s = setup([]);
    await expect(s.run()).resolves.toBe(true);
    expect(s.dialogTitles).toEqual(["端口被占用"]);
    expect(s.kills()).toEqual([]);
  });

  describe("弹窗期间 pid 可能已退出并被复用（评审 P3）：点按钮后重查，只杀仍在监听的", () => {
    it("自家 server(100) 在弹窗期间退出：不再对它 kill(-100)；仍在监听的别人(200) 照常单杀", async () => {
      const s = setup(
        [
          { pid: 100, command: OURS_MAC },
          { pid: 200, command: DEV_SERVER },
        ],
        { duringDialog: (w) => w.exit(100) },
      );
      await expect(s.run()).resolves.toBe(true);
      expect(s.kills()).toEqual([{ pids: [200], group: false }]);
      expect(s.findCalls()).toBe(2); // 弹窗前一次 + 点按钮后重查一次
      expect(s.log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("不再监听、不杀");
    });

    it("全部在弹窗期间退出：谁也不杀，端口已空就放行", async () => {
      const s = setup(
        [
          { pid: 100, command: OURS_MAC },
          { pid: 200, command: DEV_SERVER },
        ],
        { duringDialog: (w) => (w.exit(100), w.exit(200)) },
      );
      await expect(s.run()).resolves.toBe(true);
      expect(s.kills()).toEqual([]);
    });

    it("弹窗期间新冒出来的监听者(999)：用户没看过、没确认过，不杀；端口仍被它占着 → 明确报错而不是硬杀", async () => {
      const s = setup([{ pid: 100, command: OURS_MAC }], {
        duringDialog: (w) => w.listen(999, "node /x/other.js"),
      });
      await expect(s.run()).resolves.toBe(false);
      expect(s.kills()).toEqual([{ pids: [100], group: true }]);
      expect([...s.world.listeners.keys()]).toEqual([999]);
      expect(s.showErrorBox).toHaveBeenCalledTimes(1);
    });

    it("重查本身失败（findPortPids 抛错）：拿不准就不动手——不杀任何进程，端口没释放则明确报错", async () => {
      const s = setup([{ pid: 100, command: OURS_MAC }], { recheckThrows: true });
      await expect(s.run()).resolves.toBe(false);
      expect(s.kills()).toEqual([]);
      expect(s.showErrorBox).toHaveBeenCalledTimes(1);
      expect(s.log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("重查占用者失败");
    });
  });
});

describe("shouldClearServerPidRecord / clearServerPidRecord（只清「记录的 pid 就是正在退出的这个」）", () => {
  it("纯函数：recorded === exiting 才清；记录缺失 / 损坏(null)、pid 缺失(undefined)、不一致都不清", () => {
    expect(shouldClearServerPidRecord(4242, 4242)).toBe(true);
    expect(shouldClearServerPidRecord(4242, 4243)).toBe(false);
    expect(shouldClearServerPidRecord(null, 4242)).toBe(false);
    expect(shouldClearServerPidRecord(undefined, 4242)).toBe(false);
    expect(shouldClearServerPidRecord(4242, undefined)).toBe(false);
    expect(shouldClearServerPidRecord(null, null)).toBe(false); // null === null 不能算「相等」
    expect(shouldClearServerPidRecord(undefined, undefined)).toBe(false);
    expect(shouldClearServerPidRecord(Number.NaN, Number.NaN)).toBe(false);
    expect(shouldClearServerPidRecord("4242" as never, 4242)).toBe(false);
  });

  const setup = (file: string | null, unlinkImpl?: () => void) => {
    const unlinks: string[] = [];
    const deps = {
      readFileSync: () => {
        if (file === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return file;
      },
      unlinkSync: (p: string) => {
        unlinks.push(p);
        unlinkImpl?.();
      },
      serverPidRecordPath: () => "/userData/server-pid.json",
      // 纯函数用真实实现
      parseServerPidRecord,
      shouldClearServerPidRecord,
    };
    return { clear: instantiate<(pid: unknown) => void>("clearServerPidRecord", deps), unlinks };
  };

  it("记录的 pid 就是退出的这个 → 删记录", () => {
    const s = setup(buildServerPidRecord(4242, 8876, 1));
    s.clear(4242);
    expect(s.unlinks).toEqual(["/userData/server-pid.json"]);
  });
  it("迟到的旧 exit：自动重启后记录已是新 server 的 pid → 不能把新记录删了", () => {
    const s = setup(buildServerPidRecord(5555, 8876, 2));
    s.clear(4242);
    expect(s.unlinks).toEqual([]);
  });
  it("没有记录文件 / 记录损坏 / 退出的 server 没有 pid（spawn 失败）→ 不删、也不抛", () => {
    expect(() => setup(null).clear(4242)).not.toThrow();
    expect(setup(null).unlinks).toEqual([]);
    for (const bad of ["", "not json", "{}", '{"pid":"x"}', '{"pid":0}']) {
      const s = setup(bad);
      expect(() => s.clear(4242), bad).not.toThrow();
      expect(s.unlinks, bad).toEqual([]);
    }
    const noPid = setup(buildServerPidRecord(4242, 8876, 1));
    noPid.clear(undefined);
    expect(noPid.unlinks).toEqual([]);
  });
  it("删除本身失败（已被别人清了 / 无权限）：吞掉", () => {
    const s = setup(buildServerPidRecord(4242, 8876, 1), () => {
      throw new Error("EPERM");
    });
    expect(() => s.clear(4242)).not.toThrow();
    expect(s.unlinks).toHaveLength(1);
  });
});

describe("writeServerPidRecord（原子写；失败不留 .tmp.<pid>、错误照旧吞掉）", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const mkDir = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "flowship-pidrec-"));
    dirs.push(d);
    return d;
  };
  const realFs = { writeFileSync, renameSync, unlinkSync };
  const build = (deps: Record<string, unknown>) =>
    instantiate<(pid: number) => void>("writeServerPidRecord", {
      PORT: 8876,
      buildServerPidRecord,
      ...deps,
    });
  const tmpLeftovers = (dir: string) => readdirSync(dir).filter((n) => n.includes(".tmp."));

  it("成功：记录可被读回，没有 tmp 残留", () => {
    const dir = mkDir();
    const file = path.join(dir, "server-pid.json");
    build({ ...realFs, serverPidRecordPath: () => file })(4242);
    expect(parseServerPidRecord(readFileSync(file, "utf8"), { port: 8876 })).toBe(4242);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("rename 真的失败（目标是个非空目录）：不抛、tmp 被清掉", () => {
    const dir = mkDir();
    const file = path.join(dir, "server-pid.json");
    mkdirSync(file);
    writeFileSync(path.join(file, "x"), "x");
    const write = build({ ...realFs, serverPidRecordPath: () => file });
    expect(() => write(4242)).not.toThrow();
    expect(tmpLeftovers(dir)).toEqual([]);
    expect(existsSync(path.join(file, "x"))).toBe(true); // 没误伤目标
  });

  it("注入失败：rename 抛 → 对「写过的那个 tmp」调 unlink；write 抛 → 同样尝试清；清理本身失败也吞掉", () => {
    const calls: string[] = [];
    const written: string[] = [];
    const file = "/ud/server-pid.json";
    const renameFail = build({
      serverPidRecordPath: () => file,
      writeFileSync: (p: string) => written.push(p),
      renameSync: () => {
        throw new Error("EBUSY");
      },
      unlinkSync: (p: string) => calls.push(p),
    });
    expect(() => renameFail(1234)).not.toThrow();
    expect(written).toHaveLength(1);
    expect(written[0]!.startsWith(`${file}.tmp.`)).toBe(true);
    expect(calls).toEqual(written);

    const writeFail = build({
      serverPidRecordPath: () => file,
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
      renameSync: () => {
        throw new Error("不该走到 rename");
      },
      unlinkSync: (p: string) => {
        calls.push(p);
        throw new Error("ENOENT"); // tmp 根本没写出来：清理失败照吞
      },
    });
    expect(() => writeFail(1234)).not.toThrow();
    expect(calls).toHaveLength(2);

    // 连路径都拿不到（userData 取不到）：没有 tmp 可清，也不抛
    const noPath = build({
      serverPidRecordPath: () => {
        throw new Error("app not ready");
      },
      writeFileSync: () => {},
      renameSync: () => {},
      unlinkSync: (p: string) => calls.push(p),
    });
    expect(() => noPath(1234)).not.toThrow();
    expect(calls).toHaveLength(2);
  });
});
