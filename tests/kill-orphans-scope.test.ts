/**
 * kill-orphans 判据收窄（S06-01）：
 * agent shell 签名 `command cat <&3` 必须同时「属于本 Flowship」（祖先链含本 server 进程 / 已 orphan ppid=1）
 * 才会被杀；用户在同目录用 Cursor IDE 自己起的 agent shell（祖先链不含本进程）不能被误杀。
 *
 * 夹具镜像真机拓扑：Flowship(Electron, ppid=1) → next-server(= process.pid) → /bin/zsh agent shell（ppid 直接是 server）；
 * 另保留「中间夹 agent-exec」的早期拓扑用例（祖先链判据对两种都成立）。
 *
 * 第二个 describe（N10-03）：无签名的 ppid=1 候选（命令名像 node / npm）没有任何「Flowship 拉起」的证据，
 * 只允许杀 Flowship 管理的 worktree 根（`<dataRoot>/worktrees`）下的；用户原仓目录里自己留下的孤儿 node 不碰。
 * 该组用真实的 `getTaskWorkRepoPaths` 推 workDirs（而不是手写路径），worktree 根的口径一旦在
 * task-worktrees 与本模块之间漂移，这组用例会直接红。
 *
 * 全程 mock：`ps` / `lsof` 输出由 child_process.exec mock 提供、process.kill 被 spy 吞掉——绝不真杀进程。
 */
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

const WORK_DIR = path.resolve("/tmp/fake-flowship-workdir/repo");
// 真机实测的 agent shell 命令行（macOS 打包版 + SDK 本地 agent，节选）：
// 签名 `command cat <&3` 夹在长命令中间、不是开头
const SIG =
  "/bin/zsh -c IFS= builtin read -r -d '' __cursor_command <&5; exec 5<&-; " +
  'builtin set -- "$__cursor_command"; builtin unset __cursor_command; ' +
  "snap=$(command cat <&3); builtin unsetopt aliases 2>/dev/null";

type PsRow = { pid: number; ppid: number; command: string };

// exec mock：根据命令返回伪造的 ps / lsof 输出（promisify 默认取回调第二个参数、故回 { stdout }）
let psRows: PsRow[] = [];
let cwdByPid: Record<number, string> = {};

vi.mock("node:child_process", () => {
  const exec = (
    cmd: string,
    _opts: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    let stdout = "";
    if (cmd.startsWith("ps ")) {
      stdout = psRows
        .map((r) => `${r.pid} ${r.ppid} ${r.command}`)
        .join("\n");
    } else if (cmd.startsWith("lsof ")) {
      const pids = (cmd.split("-p ")[1] ?? "").split(",").map(Number);
      stdout = pids
        .filter((p) => cwdByPid[p])
        .map((p) => `p${p}\nn${cwdByPid[p]}`)
        .join("\n");
    }
    cb(null, { stdout, stderr: "" });
  };
  // task-worktrees 在模块加载时 promisify(execFile)——mock 里必须有这个导出（本测试不会真调它）
  const execFile = (
    _file: string,
    _args: unknown,
    _opts: unknown,
    cb: (err: Error | null) => void,
  ) => cb(new Error("execFile 在本测试里不应被调用"));
  return { exec, execFile, default: { exec, execFile } };
});

import { __killOrphansInReposForTest } from "@/lib/server/kill-orphans";
import {
  getTaskWorkRepoPaths,
  getWorktreesRoot,
  type WorktreeTaskLike,
} from "@/lib/server/task-worktrees";

const SELF = process.pid;

describe.skipIf(process.platform === "win32")(
  "kill-orphans agent shell 签名收窄（S06-01）",
  () => {
    let killSpy: MockInstance<typeof process.kill>;
    beforeEach(() => {
      psRows = [];
      cwdByPid = {};
      killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((() => true) as typeof process.kill);
      vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const killed = (): number[] =>
      killSpy.mock.calls.map((c) => c[0] as number).sort((a, b) => a - b);

    it("用户 IDE 在同目录自起的 agent shell（祖先链不含本 server、ppid≠1）不被杀", async () => {
      psRows = [
        { pid: 500, ppid: 1, command: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
        { pid: 501, ppid: 500, command: "agent-exec" },
        { pid: 502, ppid: 501, command: SIG },
        { pid: 503, ppid: 502, command: "node ./dev-server.js" },
      ];
      cwdByPid = { 502: WORK_DIR };
      await __killOrphansInReposForTest([WORK_DIR]);
      expect(killed()).toEqual([]);
    });

    it("真机拓扑：Electron → server(本进程) → zsh agent shell（ppid 直连 server）→ 连子树一起杀", async () => {
      psRows = [
        { pid: 590, ppid: 1, command: "/Applications/Flowship.app/Contents/MacOS/Flowship" },
        { pid: SELF, ppid: 590, command: "next-server (v15.5.20)" },
        { pid: 601, ppid: SELF, command: SIG },
        { pid: 602, ppid: 601, command: "npm run lint" },
        { pid: 603, ppid: 602, command: "ng lint --fix=true" },
      ];
      cwdByPid = { 601: path.join(WORK_DIR, "sub") };
      await __killOrphansInReposForTest([WORK_DIR]);
      expect(killed()).toEqual([601, 602, 603]);
    });

    it("真机拓扑下同机并存的别人 shell（Cursor IDE 自起、同目录）不被误杀，只杀本 server 名下那个", async () => {
      psRows = [
        { pid: 590, ppid: 1, command: "/Applications/Flowship.app/Contents/MacOS/Flowship" },
        { pid: SELF, ppid: 590, command: "next-server (v15.5.20)" },
        { pid: 601, ppid: SELF, command: SIG },
        { pid: 602, ppid: 601, command: "npm run lint" },
        { pid: 500, ppid: 1, command: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
        { pid: 502, ppid: 500, command: SIG },
        { pid: 503, ppid: 502, command: "node ./dev-server.js" },
      ];
      cwdByPid = { 601: WORK_DIR, 502: WORK_DIR };
      await __killOrphansInReposForTest([WORK_DIR]);
      expect(killed()).toEqual([601, 602]);
    });

    it("早期拓扑：server → agent-exec → shell（中间夹一层）同样命中祖先链", async () => {
      psRows = [
        { pid: 600, ppid: SELF, command: "agent-exec" },
        { pid: 601, ppid: 600, command: SIG },
        { pid: 602, ppid: 601, command: "npm run lint" },
      ];
      cwdByPid = { 601: path.join(WORK_DIR, "sub") };
      await __killOrphansInReposForTest([WORK_DIR]);
      expect(killed()).toEqual([601, 602]);
    });

    it("已 orphan（ppid=1）的签名 shell → 杀（agent 已死的真孤儿）", async () => {
      psRows = [
        { pid: 700, ppid: 1, command: SIG },
        { pid: 701, ppid: 700, command: "ng lint --fix=true" },
      ];
      cwdByPid = { 700: WORK_DIR };
      await __killOrphansInReposForTest([WORK_DIR]);
      expect(killed()).toEqual([700, 701]);
    });

    it("本 server 后代 shell 但 cwd 在工作目录之外 → 不杀（cwd 圈定仍生效）", async () => {
      psRows = [{ pid: 800, ppid: SELF, command: SIG }];
      cwdByPid = { 800: path.resolve("/tmp/other-place") };
      await __killOrphansInReposForTest([WORK_DIR]);
      expect(killed()).toEqual([]);
    });

    it("ppid 成环 / 祖先链不含本进程时不死循环、不杀", async () => {
      psRows = [
        { pid: 900, ppid: 901, command: SIG },
        { pid: 901, ppid: 900, command: "weird" },
      ];
      cwdByPid = { 900: WORK_DIR };
      await __killOrphansInReposForTest([WORK_DIR]);
      expect(killed()).toEqual([]);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "kill-orphans 无签名 orphan 分支只认 worktree 根（N10-03）",
  () => {
    const DATA_DIR = path.resolve("/tmp/fake-flowship-data");
    // 用户自己的原仓（不在 Flowship 数据目录里）
    const USER_REPO = path.resolve("/tmp/fake-user-projects/app");
    const READONLY_REPO = path.resolve("/tmp/fake-user-projects/docs-repo");

    const makeTask = (patch: Partial<WorktreeTaskLike> = {}): WorktreeTaskLike => ({
      id: "t_1700000000001_orph",
      mode: "task",
      repoPaths: [USER_REPO],
      isolateWorktree: true,
      ...patch,
    });

    let killSpy: MockInstance<typeof process.kill>;
    let prevDataDir: string | undefined;
    beforeEach(() => {
      psRows = [];
      cwdByPid = {};
      // dataRoot 读环境变量：钉死成固定假目录，worktree 根 = <DATA_DIR>/worktrees
      prevDataDir = process.env.FLOWSHIP_DATA_DIR;
      process.env.FLOWSHIP_DATA_DIR = DATA_DIR;
      killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((() => true) as typeof process.kill);
      vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => {
      if (prevDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prevDataDir;
      vi.restoreAllMocks();
    });

    const killed = (): number[] =>
      killSpy.mock.calls.map((c) => c[0] as number).sort((a, b) => a - b);

    it("口径自检：隔离任务的 workDir 确实落在 getWorktreesRoot() 之下（防 worktree 根两边漂移）", () => {
      expect(getWorktreesRoot()).toBe(path.join(DATA_DIR, "worktrees"));
      const [workDir] = getTaskWorkRepoPaths(makeTask());
      expect(workDir.startsWith(`${getWorktreesRoot()}${path.sep}`)).toBe(true);
    });

    it("非隔离任务：用户原仓目录里 ppid=1 的 node（含其子进程）不被杀", async () => {
      const workDirs = getTaskWorkRepoPaths(makeTask({ isolateWorktree: false }));
      expect(workDirs).toEqual([USER_REPO]);
      psRows = [
        // 用户自己 nohup 起的 / daemon 化的 node：reparent 到 init、cwd 在原仓里
        { pid: 1000, ppid: 1, command: "node /Users/me/app/node_modules/.bin/nx-daemon.js" },
        { pid: 1001, ppid: 1000, command: "node ./worker.js" },
        // 同样 ppid=1 的 npm（用户关掉终端后残留的 dev server）
        { pid: 1010, ppid: 1, command: "npm run dev" },
      ];
      cwdByPid = {
        1000: path.join(USER_REPO, "packages", "x"),
        1001: USER_REPO,
        1010: USER_REPO,
      };
      await __killOrphansInReposForTest(workDirs);
      expect(killed()).toEqual([]);
    });

    it("隔离任务：Flowship worktree 下 ppid=1 的真孤儿 node 仍被杀（连子树）", async () => {
      const workDirs = getTaskWorkRepoPaths(makeTask());
      const [workDir] = workDirs;
      psRows = [
        { pid: 1100, ppid: 1, command: "node /x/node_modules/.bin/ng lint --fix=true" },
        { pid: 1101, ppid: 1100, command: "node ./lint-worker.js" },
        { pid: 1110, ppid: 1, command: "npm run lint" },
        // 无关的 ppid=1 进程（cwd 不在 workDir）不受牵连
        { pid: 1120, ppid: 1, command: "node /elsewhere/server.js" },
      ];
      cwdByPid = {
        1100: path.join(workDir, "src"),
        1101: path.join(workDir, "src"),
        1110: workDir,
        1120: USER_REPO,
      };
      await __killOrphansInReposForTest(workDirs);
      expect(killed()).toEqual([1100, 1101, 1110]);
    });

    it("隔离任务的 worktree 下、但有父进程（ppid≠1）的 node 不被杀（用户在里面自己开的终端）", async () => {
      const workDirs = getTaskWorkRepoPaths(makeTask());
      const [workDir] = workDirs;
      psRows = [
        { pid: 1200, ppid: 1, command: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
        { pid: 1201, ppid: 1200, command: "-zsh" },
        { pid: 1202, ppid: 1201, command: "node ./dev-server.js" },
      ];
      cwdByPid = { 1201: workDir, 1202: workDir };
      await __killOrphansInReposForTest(workDirs);
      expect(killed()).toEqual([]);
    });

    it("别的任务的 worktree 里的孤儿不被本任务的收割波及（workDirs 圈定仍生效）", async () => {
      const mine = getTaskWorkRepoPaths(makeTask());
      const [other] = getTaskWorkRepoPaths(makeTask({ id: "t_1700000000002_other" }));
      psRows = [{ pid: 1300, ppid: 1, command: "node ./other-task-lint.js" }];
      cwdByPid = { 1300: other };
      await __killOrphansInReposForTest(mine);
      expect(killed()).toEqual([]);
    });

    it("前缀相似的目录（<dataRoot>/worktrees-old/…）不算 worktree 根下", async () => {
      const lookalike = path.join(DATA_DIR, "worktrees-old", "t_1700000000003_x", "app");
      psRows = [{ pid: 1400, ppid: 1, command: "node ./orphan.js" }];
      cwdByPid = { 1400: lookalike };
      // 调用方（假设）把这个目录当 workDir 传进来：cwd 圈定命中，但不在真 worktree 根下 → 仍不杀
      await __killOrphansInReposForTest([lookalike]);
      expect(killed()).toEqual([]);
    });

    it("混合隔离任务（git 仓进 worktree、只读仓原地）：只杀 worktree 里的孤儿，只读原仓里的不杀", async () => {
      const workDirs = getTaskWorkRepoPaths(
        makeTask({
          repoPaths: [USER_REPO, READONLY_REPO],
          readonlyRepoPaths: [READONLY_REPO],
        }),
      );
      expect(workDirs[1]).toBe(READONLY_REPO);
      psRows = [
        { pid: 1500, ppid: 1, command: "node ./wt-orphan.js" },
        { pid: 1510, ppid: 1, command: "node ./user-docs-watcher.js" },
      ];
      cwdByPid = { 1500: workDirs[0], 1510: READONLY_REPO };
      await __killOrphansInReposForTest(workDirs);
      expect(killed()).toEqual([1500]);
    });

    it("签名分支行为不变：原仓目录里 ppid=1 的签名 shell / 本 server 名下的签名 shell 照杀（连子树）", async () => {
      const workDirs = getTaskWorkRepoPaths(makeTask({ isolateWorktree: false }));
      psRows = [
        // a1：agent 已死、签名 shell 被 reparent 到 init
        { pid: 1600, ppid: 1, command: SIG },
        { pid: 1601, ppid: 1600, command: "ng lint --fix=true" },
        // a2：agent 还活着、签名 shell 挂在本 server 名下
        { pid: 1610, ppid: SELF, command: SIG },
        { pid: 1611, ppid: 1610, command: "npm run lint" },
        // 同目录、无签名的用户孤儿 node——不被 b 分支误杀
        { pid: 1620, ppid: 1, command: "node ./user-daemon.js" },
      ];
      cwdByPid = { 1600: USER_REPO, 1610: USER_REPO, 1620: USER_REPO };
      await __killOrphansInReposForTest(workDirs);
      expect(killed()).toEqual([1600, 1601, 1610, 1611]);
    });
  },
);
