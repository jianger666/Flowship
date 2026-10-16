/**
 * kill-orphans 的「cwd 是否在工作目录 / worktree 根之下」判定与 lsof 解析的边界（真实临时目录 + mock ps / lsof）
 *
 * 钉死的缺陷（都是「保护悄悄失灵 → 漏杀孤儿」方向，事故原型：停止后 `ng lint --fix` 继续改写整个仓库）：
 *  1. lsof 只要有一个 pid 在 ps 与 lsof 之间退出就**非零退出**、但仍会打印其余 pid 的 cwd；
 *     旧实现 catch 里整个丢掉 stdout，一次竞态就让本轮所有候选都查不到 cwd、一个都不杀；
 *  2. lsof 报的 cwd 永远是 realpath（软链摊平、macOS 还是磁盘上的真实大小写），旧实现拿 `path.resolve` 的字面量路径
 *     去比：数据目录 / 工作目录经软链访问（换盘）、或大小写与磁盘不一致时，前缀永远对不上；
 *  3. `isUnder` 用 `rel.startsWith("..")` 判「跑到外面去了」，名字以 `..` 开头的普通子目录被当成外面。
 *
 * 全程 mock：`ps` / `lsof` 输出由 child_process.exec mock 提供、process.kill 被 spy 吞掉——绝不真杀进程。
 * 目录全建在 os.tmpdir() 的临时目录里（realpath 需要真实存在的目录），不碰真实数据目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

const SIG =
  "/bin/zsh -c IFS= builtin read -r -d '' __cursor_command <&5; exec 5<&-; " +
  'builtin set -- "$__cursor_command"; builtin unset __cursor_command; ' +
  "snap=$(command cat <&3); builtin unsetopt aliases 2>/dev/null";

type PsRow = { pid: number; ppid: number; command: string };
type LsofResult = { stdout: string; fail: boolean };

let psRows: PsRow[] = [];
// 默认 lsof：每个 pid 一段 `p<pid>\nn<cwd>\n`（真 lsof -Fpn 的格式，行行以换行结尾）；个别用例整体替换
let lsofImpl: (pids: number[]) => LsofResult = () => ({ stdout: "", fail: false });

vi.mock("node:child_process", () => {
  const exec = (
    cmd: string,
    _opts: unknown,
    cb: (
      err: (Error & { stdout?: string; stderr?: string }) | null,
      res?: { stdout: string; stderr: string },
    ) => void,
  ) => {
    if (cmd.startsWith("ps ")) {
      cb(null, {
        stdout: psRows.map((r) => `${r.pid} ${r.ppid} ${r.command}`).join("\n"),
        stderr: "",
      });
      return;
    }
    const pids = (cmd.split("-p ")[1] ?? "").split(",").map(Number);
    const { stdout, fail } = lsofImpl(pids);
    if (fail) {
      // 跟 promisify(exec) 对非零退出的行为一致：reject 的 Error 上挂着 stdout / stderr
      cb(Object.assign(new Error("Command failed: lsof (exit 1)"), { code: 1, stdout, stderr: "" }));
      return;
    }
    cb(null, { stdout, stderr: "" });
  };
  const execFile = (
    _file: string,
    _args: unknown,
    _opts: unknown,
    cb: (err: Error | null) => void,
  ) => cb(new Error("execFile 在本测试里不应被调用"));
  return { exec, execFile, default: { exec, execFile } };
});

import { __killOrphansInReposForTest } from "@/lib/server/kill-orphans";

// realpath 一次：macOS 的 os.tmpdir() 自带 /var → /private/var 软链，后面「软链」都是用例自己造的
const TMP = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "fe-kill-orphans-paths-")),
);

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 在 TMP 下建一个互不干扰的子目录（每个用例独占一份，避免软链 / 大小写互相污染） */
let caseSeq = 0;
const mkCaseDir = (): string => {
  const dir = path.join(TMP, `c${++caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const cwdLsof =
  (cwdByPid: Record<number, string>) =>
  (pids: number[]): LsofResult => ({
    stdout: pids
      .filter((p) => cwdByPid[p])
      .map((p) => `p${p}\nn${cwdByPid[p]}\n`)
      .join(""),
    fail: false,
  });

describe.skipIf(process.platform === "win32")(
  "kill-orphans 路径判定与 lsof 解析（真实目录）",
  () => {
    let killSpy: MockInstance<typeof process.kill>;
    let prevDataDir: string | undefined;
    beforeEach(() => {
      psRows = [];
      lsofImpl = () => ({ stdout: "", fail: false });
      prevDataDir = process.env.FLOWSHIP_DATA_DIR;
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

    describe("lsof 部分失败（有 pid 已退出 → 非零退出但其余 pid 仍有输出）", () => {
      it("活着的候选照样拿到 cwd 并被收走，不因一个 pid 退出就整轮放弃", async () => {
        const work = path.join(mkCaseDir(), "repo");
        fs.mkdirSync(work, { recursive: true });
        psRows = [
          { pid: 1001, ppid: 1, command: SIG }, // 已退出（lsof 查不到、触发非零退出）
          { pid: 1002, ppid: 1, command: SIG }, // 活着、cwd 在工作目录里
          { pid: 1003, ppid: 1002, command: "ng lint --fix=true" },
        ];
        lsofImpl = (pids) => ({
          stdout: cwdLsof({ 1002: work })(pids).stdout,
          fail: pids.includes(1001),
        });
        await __killOrphansInReposForTest([work]);
        expect(killed()).toEqual([1002, 1003]);
      });

      it("失败时输出被截断的最后一行（没有结尾换行）不采信——截成「前缀正好是工作目录」的路径会误圈进来", async () => {
        const base = mkCaseDir();
        const work = path.join(base, "repo");
        fs.mkdirSync(work, { recursive: true });
        psRows = [{ pid: 1101, ppid: 1, command: SIG }];
        // 真实 cwd 是 <base>/repo-evil（不在工作目录里），输出被截断成 `<base>/repo`——字面上恰好等于工作目录
        lsofImpl = () => ({ stdout: `p1101\nn${work}`, fail: true });
        await __killOrphansInReposForTest([work]);
        expect(killed()).toEqual([]);
      });

      it("失败且输出完整（结尾有换行）的行照常采信", async () => {
        const work = path.join(mkCaseDir(), "repo");
        fs.mkdirSync(work, { recursive: true });
        psRows = [{ pid: 1201, ppid: 1, command: SIG }];
        lsofImpl = () => ({ stdout: `p1201\nn${work}\n`, fail: true });
        await __killOrphansInReposForTest([work]);
        expect(killed()).toEqual([1201]);
      });
    });

    describe("lsof 报 realpath、调用方给的是软链 / 大小写不同的路径", () => {
      it("工作目录经软链访问（换盘）：签名 shell 的 cwd 是真实路径，仍在圈定范围内", async () => {
        const base = mkCaseDir();
        const real = path.join(base, "ssd", "repo");
        fs.mkdirSync(path.join(real, "src"), { recursive: true });
        const link = path.join(base, "link-to-ssd");
        fs.symlinkSync(path.join(base, "ssd"), link);
        psRows = [
          { pid: 2001, ppid: 1, command: SIG },
          { pid: 2002, ppid: 2001, command: "npm run lint" },
        ];
        lsofImpl = cwdLsof({ 2001: path.join(real, "src") }); // lsof 永远报 realpath
        await __killOrphansInReposForTest([path.join(link, "repo")]);
        expect(killed()).toEqual([2001, 2002]);
      });

      it("数据目录经软链访问：worktree 根下 ppid=1 的无签名孤儿 node 仍被收走", async () => {
        const base = mkCaseDir();
        const realData = path.join(base, "ssd-data");
        const work = path.join(realData, "worktrees", "t1", "repo");
        fs.mkdirSync(work, { recursive: true });
        const linkData = path.join(base, "data");
        fs.symlinkSync(realData, linkData);
        process.env.FLOWSHIP_DATA_DIR = linkData; // Flowship 看到的数据目录是软链
        psRows = [{ pid: 2101, ppid: 1, command: "node ./lint-worker.js" }];
        lsofImpl = cwdLsof({ 2101: work });
        // 调用方（getTaskWorkRepoPaths）算出的 workDir 同样经过软链
        await __killOrphansInReposForTest([
          path.join(linkData, "worktrees", "t1", "repo"),
        ]);
        expect(killed()).toEqual([2101]);
      });

      // 大小写不敏感文件系统（macOS APFS 默认）上：路径大小写与磁盘不一致，lsof 报磁盘上的真实大小写
      const caseInsensitiveFs = ((): boolean => {
        const probe = path.join(TMP, "CaseProbe");
        fs.mkdirSync(probe, { recursive: true });
        return fs.existsSync(path.join(TMP, "caseprobe"));
      })();
      it.skipIf(!caseInsensitiveFs)(
        "大小写与磁盘不一致的工作目录（大小写不敏感文件系统）：仍认得出 cwd 在里面",
        async () => {
          const base = mkCaseDir();
          const work = path.join(base, "Projects", "App");
          fs.mkdirSync(work, { recursive: true });
          psRows = [{ pid: 2201, ppid: 1, command: SIG }];
          lsofImpl = cwdLsof({ 2201: work }); // 磁盘上的真实大小写
          await __killOrphansInReposForTest([path.join(base, "projects", "app")]);
          expect(killed()).toEqual([2201]);
        },
      );
    });

    describe("展开 realpath 不能放宽保护范围（反例）", () => {
      it("worktree 根下的软链指向用户原仓：原仓里 ppid=1 的无签名孤儿 node 仍不碰", async () => {
        const base = mkCaseDir();
        const data = path.join(base, "data");
        const userRepo = path.join(base, "user-projects", "app");
        fs.mkdirSync(userRepo, { recursive: true });
        fs.mkdirSync(path.join(data, "worktrees", "t1"), { recursive: true });
        // <dataRoot>/worktrees/t1/repo → 用户的原仓（非隔离 / 软链接入的场景）
        fs.symlinkSync(userRepo, path.join(data, "worktrees", "t1", "repo"));
        process.env.FLOWSHIP_DATA_DIR = data;
        psRows = [{ pid: 3001, ppid: 1, command: "node ./user-daemon.js" }];
        lsofImpl = cwdLsof({ 3001: userRepo }); // 真实位置在 worktree 根之外
        await __killOrphansInReposForTest([path.join(data, "worktrees", "t1", "repo")]);
        expect(killed()).toEqual([]);
      });

      it("前缀相似的 <dataRoot>/worktrees-evil 不算 worktree 根下（真实目录）", async () => {
        const base = mkCaseDir();
        const data = path.join(base, "data");
        const evil = path.join(data, "worktrees-evil", "t1", "repo");
        fs.mkdirSync(evil, { recursive: true });
        fs.mkdirSync(path.join(data, "worktrees"), { recursive: true });
        process.env.FLOWSHIP_DATA_DIR = data;
        psRows = [{ pid: 3101, ppid: 1, command: "node ./orphan.js" }];
        lsofImpl = cwdLsof({ 3101: evil });
        await __killOrphansInReposForTest([evil]);
        expect(killed()).toEqual([]);
      });

      it("`..` 回溯出工作目录的 cwd 不算在里面", async () => {
        const base = mkCaseDir();
        const work = path.join(base, "repo");
        fs.mkdirSync(work, { recursive: true });
        psRows = [{ pid: 3201, ppid: 1, command: SIG }];
        lsofImpl = cwdLsof({ 3201: path.join(base, "repo-sibling") });
        await __killOrphansInReposForTest([work]);
        expect(killed()).toEqual([]);
      });

      it("工作目录不存在（realpath 取不到）：退回字面量路径，不抛、也不放宽", async () => {
        const base = mkCaseDir();
        const gone = path.join(base, "gone", "repo"); // 没建
        psRows = [
          { pid: 3301, ppid: 1, command: SIG },
          { pid: 3302, ppid: 1, command: SIG },
        ];
        lsofImpl = cwdLsof({ 3301: gone, 3302: path.join(base, "other") });
        await __killOrphansInReposForTest([gone]);
        expect(killed()).toEqual([3301]);
      });
    });

    it("名字以 `..` 开头的普通子目录（`<repo>/..cache`）算在工作目录里，不是「跑到外面」", async () => {
      const base = mkCaseDir();
      const work = path.join(base, "repo");
      fs.mkdirSync(path.join(work, "..cache", "x"), { recursive: true });
      psRows = [{ pid: 4001, ppid: 1, command: SIG }];
      lsofImpl = cwdLsof({ 4001: path.join(work, "..cache", "x") });
      await __killOrphansInReposForTest([work]);
      expect(killed()).toEqual([4001]);
    });
  },
);
