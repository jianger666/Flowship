/**
 * vitest setupFiles：每个测试文件在 import 任何被测模块之前先把进程环境隔离干净。
 * 逻辑与原因见 tests/helpers/hermetic-env.ts（文件名故意不带 .test，不会被当成测试收集）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect } from "vitest";

import { applyHermeticEnv, assertEnvNotAppData } from "../helpers/hermetic-env";

// 模块加载时（任何用例装假定时器之前）就抓住真 setTimeout：用了 `vi.useFakeTimers()` 的文件，
// 收尾时全局 setTimeout 已是假的、永远不触发，下面的让出会把 afterAll 卡到 hook 超时。
const realSetTimeout = globalThis.setTimeout;

// 每个测试文件一个私有 tmp 根：TMPDIR / TEMP / TMP 指过去后，测试里 `os.tmpdir()` + mkdtemp 建的目录全落在它里面，
// 文件收尾整棵删。以前各测试各自 mkdtemp、各自（常常忘了）清，系统 tmp 里累积了上千个 `fe-*` / `sdk-gc-test-*` /
// `feishu-bridge-*` 残留目录，每跑一遍全量 vitest 就再添几百个。
// 名字取短（`fvt-`）：macOS 的 unix socket 路径上限 104 字节，/var/folders/…/T/ 前缀本身已占约 50 字节。
// 必须在改 env 之前先取真 tmpdir，且发生在被测模块 import 之前（setupFiles 保证）。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fvt-"));
process.env.TMPDIR = tmpRoot;
process.env.TEMP = tmpRoot;
process.env.TMP = tmpRoot;

const { dataDir } = applyHermeticEnv(process.env, () =>
  fs.mkdtempSync(path.join(tmpRoot, "flowship-vitest-data-")),
);

// 家目录也隔离：HOME / USERPROFILE（`os.homedir()` 的来源）指向 tmp 根里的空目录。
// 以前测试里凡是读 `~/.cursor/*`、`~/.lark-cli` 的代码读到的是开发者本机的真文件——结果取决于「谁在跑测试」；
// 事件脱敏现在会读 `~/.cursor/mcp.json`（里面是真凭据），测试更不该在不知情时把本机真值拉进值集合。
// 需要自己家目录的测试（config-read-fallback / bom-config-reads / feishu-cli-*）照旧在用例里改 HOME 覆盖即可。
const fakeHome = path.join(tmpRoot, "home");
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
if (process.env.APPDATA !== undefined) process.env.APPDATA = path.join(fakeHome, "AppData", "Roaming");

// 兜底：afterAll 没机会跑到时（超时 / 被打断，或整个文件的用例全被 skip——vitest 不跑全 skip 文件的 hook）也不留 tmp 根。
// 两个触发点：worker 正常退出（`exit`），以及池回收 worker 时发来的 SIGTERM（全 skip 的文件就是这么收场的、不会走 exit）。
// 一个进程只挂一组监听（globalThis 上登记所有根），别让每个测试文件各挂一组。SIGKILL 的 worker 兜不住。
const fvtRoots = ((globalThis as { __fvtRoots?: Set<string> }).__fvtRoots ??= new Set<string>());
if (fvtRoots.size === 0) {
  const removeRoots = () => {
    for (const dir of fvtRoots) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
  process.once("exit", removeRoots);
  // 收到 SIGTERM：先同步删根，再把信号原样补发给自己（once 已摘掉本监听，补发走默认的「终止进程」），不改变池对 worker 的回收语义
  process.once("SIGTERM", () => {
    removeRoots();
    process.kill(process.pid, "SIGTERM");
  });
}
fvtRoots.add(tmpRoot);

// 万一还是留下了残留根：里面有个标记文件写着是哪个测试文件建的，排查时看它就行（正常收尾整棵删掉）
let ownerMarked = false;
beforeEach(() => {
  if (!ownerMarked) {
    ownerMarked = true;
    try {
      fs.writeFileSync(path.join(tmpRoot, ".owner-test-file"), `${expect.getState().testPath ?? "unknown"}\n`);
    } catch {
      /* ignore */
    }
  }
  assertEnvNotAppData(process.env);
});

afterAll(async () => {
  // 文件收尾先让出一小段：测试里没人 await 的 fire-and-forget 写盘（appendEvent 的 meta touch、事件 / seq sidecar、
  // 飞书桥的落盘……）常在最后一个用例之后才落完。这时目录一被下面删掉，它们就 ENOENT、各打一条 console.warn，
  // 而这条日志常落在文件收尾之后——vitest 关 worker 的 rpc 时还有一条没送完，整次运行报
  // `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`、退出码 1（Linux CI 上红过一次）。
  // 这是时间裕量、不是同步点：只覆盖「落盘链在 50ms 内走完」的常见情形；各文件自己清目录前该等的锁仍要自己等。
  await new Promise<void>((r) => realSetTimeout(r, 50));
  // 尽力清理：个别测试的异步写入可能还在落盘，清不掉就留给系统清 tmp，别让清理失败拖红测试
  // （tmpRoot 包含 dataDir，一棵树一起删；dataDir 单独再删一次兜 tmpRoot 删到一半失败的情形）
  for (const dir of [tmpRoot, dataDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  }
});
