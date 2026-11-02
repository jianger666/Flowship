/**
 * 真进程用例（评审 R1-2）：server 侧的 stdin EOF 优雅退出通道——Windows 没有 POSIX 信号，壳退出时关 server 的 stdin 管道来请它优雅退出。
 * 这个通道与平台无关（管道 EOF），所以在 mac / Linux 上也能用真子进程验证 server 侧这一半；壳侧（win32 的 spawn / taskkill）见
 * tests/electron-win-graceful-stop.test.ts，**整条 Windows 链路未在 Windows 实机验证**。
 *
 * 子进程（jiti 加载真实的 inbound.ts / kill-orphans.ts，同 feishu-bridge-exit-force-kill-realproc.test.ts）：
 *   - 登记一个忽略 SIGTERM 的托管进程组（像不合作的预览 dev server），再调 ensureBridgeRuntimePolling()（里面挂 ensureExitHook）。
 *   A：带 FLOWSHIP_EXIT_ON_STDIN_EOF=1 → 父进程 end() 它的 stdin → 子进程跑与 SIGTERM 同一个清理（托管进程组被强杀）并以 0 退出
 *   B：不带该环境变量 → stdin 被关闭**不会**让进程退出（独立运行 / 容器里 stdin 被关闭不能误退）
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const TMP = path.join(os.tmpdir(), `feishu-bridge-exit-stdin-eof-${process.pid}-${Date.now()}`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
};
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const childScript = (marker: string): string => `
const { createJiti } = require(${JSON.stringify(path.join(ROOT, "node_modules/jiti"))});
const { spawn } = require("node:child_process");
const jiti = createJiti(__filename, { alias: { "@": ${JSON.stringify(path.join(ROOT, "src"))} }, moduleCache: false });
(async () => {
  const ko = await jiti.import(${JSON.stringify(path.join(ROOT, "src/lib/server/kill-orphans.ts"))});
  const inbound = await jiti.import(${JSON.stringify(path.join(ROOT, "src/lib/server/feishu-bridge/inbound.ts"))});
  const stubborn = spawn("sh", ["-c", "trap '' TERM; touch '" + ${JSON.stringify(marker)} + "'; while :; do sleep 1; done"], {
    detached: true,
    stdio: "ignore",
  });
  stubborn.unref();
  ko.registerManagedChild("test:stubborn", {
    label: "stubborn",
    stop: () => { try { process.kill(-stubborn.pid, "SIGTERM"); } catch {} },
    forceKill: () => { try { process.kill(-stubborn.pid, "SIGKILL"); } catch {} },
  });
  inbound.ensureBridgeRuntimePolling();
  setInterval(() => {}, 1000);
  // 环境变量必须在挂钩子时被摘掉（别让子孙进程继承）
  console.log("READY " + stubborn.pid + " envLeft=" + (process.env.FLOWSHIP_EXIT_ON_STDIN_EOF === undefined ? "gone" : "still"));
})().catch((e) => { console.error("CHILD_ERR", e && e.stack || e); process.exit(2); });
`;

interface Run {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exited: Promise<number | null>;
  stubbornPgid: () => number;
}
const runs: Run[] = [];

const start = async (name: string, withEnv: boolean): Promise<Run> => {
  await fs.mkdir(TMP, { recursive: true });
  const marker = path.join(TMP, `${name}-stubborn-ready`);
  const script = path.join(TMP, `${name}.cjs`);
  await fs.writeFile(script, childScript(marker), "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env, FLOWSHIP_DATA_DIR: path.join(TMP, `${name}-data`) };
  delete env.FLOWSHIP_EXIT_ON_STDIN_EOF;
  if (withEnv) env.FLOWSHIP_EXIT_ON_STDIN_EOF = "1";
  const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
  child.stderr!.on("data", (b: Buffer) => (err += b.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const run: Run = {
    child,
    out: () => out,
    err: () => err,
    exited,
    stubbornPgid: () => Number(/READY (\d+)/.exec(out)?.[1] ?? 0),
  };
  runs.push(run);
  // jiti 冷加载 inbound.ts 要几秒
  expect(await waitUntil(() => /READY \d+/.test(out) || /CHILD_ERR/.test(err), 40_000), `子进程没就绪：${err}`).toBe(true);
  expect(/READY \d+/.test(out), `子进程启动失败：${err}`).toBe(true);
  // 等 sh 里 trap 装好——否则 TERM 会在 trap 之前把 sh 默认杀掉、测不到「忽略 TERM」
  expect(await waitUntil(() => existsSync(marker), 10_000)).toBe(true);
  return run;
};

afterEach(async () => {
  for (const r of runs.splice(0)) {
    r.child.kill("SIGKILL");
    const pgid = r.stubbornPgid();
    if (pgid > 0) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // 已死
      }
    }
  }
  await fs.rm(TMP, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("server 侧 stdin EOF 优雅退出（win32 壳关 stdin 管道的对端）", () => {
  it("A：设了 FLOWSHIP_EXIT_ON_STDIN_EOF=1 → 关 stdin 后跑退出清理（托管进程组被强杀）并以 0 退出；环境变量已被摘掉", async () => {
    const r = await start("a", true);
    expect(r.out()).toContain("envLeft=gone");
    expect(groupAlive(r.stubbornPgid())).toBe(true);

    r.child.stdin!.end(); // 壳在 Windows 上做的就是这一步
    expect(await Promise.race([r.exited, sleep(15_000).then(() => "timeout" as const)])).toBe(0);
    expect(await waitUntil(() => !groupAlive(r.stubbornPgid()), 3_000)).toBe(true);
  }, 90_000);

  it("B：没设环境变量 → stdin 被关闭不会让进程退出（独立运行 / 容器 / 测试里 stdin 关闭不能误退）", async () => {
    const r = await start("b", false);
    r.child.stdin!.end();
    expect(await Promise.race([r.exited.then(() => "exited" as const), sleep(2_500).then(() => "alive" as const)])).toBe("alive");
    expect(groupAlive(r.stubbornPgid())).toBe(true);
  }, 90_000);
});
