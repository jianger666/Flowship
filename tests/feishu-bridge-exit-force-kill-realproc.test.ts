/**
 * 真进程用例（评审第 3 轮 P2：R1-9 在「Next 先 process.exit(0)」时仍残留）。
 *
 * Next 的 start-server 在 SIGTERM 上注册了 cleanup：`server.close()` → `nextServer.close()` → **无条件 `process.exit(0)`**，
 * 生产模式不 closeAllConnections；没有存活 SSE 连接时几毫秒就退出。我们写在 `runExitCleanup` 里
 * 「await race(优雅停, 1.5s) 之后再强杀」的那一步根本轮不到——进程在 Next 的监听器里就退了。
 * 修法：`ensureExitHook` 额外挂 `process.once("exit")` 同步强杀（exit 监听器同步、任何 process.exit 都会触发）。
 *
 * 本用例用真子进程复现：
 *   子进程（jiti 加载真实的 inbound.ts / kill-orphans.ts）里
 *   ① 先注册一个「SIGTERM 立刻 process.exit(0)」的监听器（模拟 Next 的 cleanup），
 *   ② 起一个忽略 SIGTERM 的 detached 子进程组并登记（带 forceKill），
 *   ③ 调 ensureBridgeRuntimePolling()（里面挂 ensureExitHook）。
 * 父进程给子进程发 SIGTERM → 子进程立刻 exit(0) → 断言忽略 TERM 的进程组已被杀。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const TMP = path.join(os.tmpdir(), `feishu-bridge-exit-realproc-${process.pid}-${Date.now()}`);

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

/** 子进程脚本：见文件头注释。`SIMULATE_EXIT_LISTENER=1` 才注册「立刻 exit(0)」的监听器 */
const childScript = (marker: string): string => `
const { createJiti } = require(${JSON.stringify(path.join(ROOT, "node_modules/jiti"))});
const { spawn } = require("node:child_process");
const jiti = createJiti(__filename, { alias: { "@": ${JSON.stringify(path.join(ROOT, "src"))} }, moduleCache: false });
(async () => {
  // ① 模拟 Next start-server 的 SIGTERM cleanup：监听器里直接 process.exit(0)
  process.on("SIGTERM", () => process.exit(0));
  const ko = await jiti.import(${JSON.stringify(path.join(ROOT, "src/lib/server/kill-orphans.ts"))});
  const inbound = await jiti.import(${JSON.stringify(path.join(ROOT, "src/lib/server/feishu-bridge/inbound.ts"))});
  // ② 忽略 SIGTERM 的独立进程组（像不合作的预览 dev server），登记优雅停 + 同步强杀
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
  // ③ 挂退出钩子（ensureBridgeRuntimePolling → ensureExitHook）
  inbound.ensureBridgeRuntimePolling();
  // 桥接的轮询定时器是 unref 的、什么都不留给事件循环——不自己撑住的话子进程会在启动完成后自然退出，
  // 退出钩子（正确地）把还没来得及装 trap 的 stubborn 一起杀掉，用例就成了随机红
  setInterval(() => {}, 1000);
  console.log("READY " + stubborn.pid);
})().catch((e) => { console.error("CHILD_ERR", e && e.stack || e); process.exit(2); });
`;

let child: ChildProcess | null = null;
let stubbornPgid = 0;

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  if (stubbornPgid > 0) {
    try {
      process.kill(-stubbornPgid, "SIGKILL");
    } catch {
      // 已死
    }
    stubbornPgid = 0;
  }
  await fs.rm(TMP, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("退出钩子：别的 SIGTERM 监听器先 process.exit(0) 时仍强杀残留进程组", () => {
  it("忽略 SIGTERM 的托管进程组在父进程 exit 后已被杀（旧实现：强杀排在 await race 之后，进程先退了 → 残留）", async () => {
    await fs.mkdir(TMP, { recursive: true });
    const marker = path.join(TMP, "stubborn-ready");
    const script = path.join(TMP, "child.cjs");
    await fs.writeFile(script, childScript(marker), "utf8");

    child = spawn(process.execPath, [script], {
      env: { ...process.env, FLOWSHIP_DATA_DIR: path.join(TMP, "data") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr!.on("data", (b: Buffer) => (err += b.toString()));
    const exited = new Promise<number | null>((resolve) => child!.on("exit", (code) => resolve(code)));

    // jiti 冷加载 inbound.ts 要几秒
    expect(await waitUntil(() => /READY \d+/.test(out) || /CHILD_ERR/.test(err), 30_000), `子进程没就绪：${err}`).toBe(true);
    const m = /READY (\d+)/.exec(out);
    expect(m, `子进程启动失败：${err}`).not.toBeNull();
    stubbornPgid = Number(m![1]);
    // 等 sh 里 trap 装好（marker 在 trap 之后才落）——否则 TERM 会在 trap 之前把 sh 默认杀掉、测不到「忽略 TERM」
    expect(await waitUntil(() => existsSync(marker), 10_000)).toBe(true);
    expect(groupAlive(stubbornPgid)).toBe(true);

    child.kill("SIGTERM"); // → 「Next」监听器立刻 process.exit(0)
    expect(await exited).toBe(0);

    // exit 钩子同步 SIGKILL：父进程退出时就已发出，只留内核回收的一点点时间
    expect(await waitUntil(() => !groupAlive(stubbornPgid), 1_000)).toBe(true);
  }, 60_000);
});
