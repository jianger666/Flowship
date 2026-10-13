#!/usr/bin/env node
/**
 * 生成 app-server/boot-manifest.json：server 冷启动到「首页可用」要读的文件清单（按首次访问顺序）。
 * 壳在 Windows 首次启动时按它并行预读（见 electron-app/boot-prefetch.mjs），把杀软对这批文件的
 * 串行「首次放行」延迟摊成并发。
 *
 * 用法：
 *   node scripts/gen-boot-manifest.mjs --server-dir dist/app-server
 *   node scripts/gen-boot-manifest.mjs --server-dir <已解开的安装包>/resources/app-server --out /tmp/boot-manifest.json
 *
 * 做法（和真实冷启动同一条路径，只是把「读了什么」录下来）：
 *   1. 用临时数据目录、随机端口起 server（`node --require boot-trace-preload.cjs server.js`）；
 *   2. 等 /api/readyz 200（壳判定就绪的同一个探针）；
 *   3. GET /（首页 SSR），再按 HTML 里引用的 /_next/static 资源逐个 GET（浏览器开窗后会立刻请求）；
 *   4. 壳就绪后会 fire-and-forget 打的两个接口（/api/boot-warmup、/api/feishu-bridge/status）各打一次（失败忽略）；
 *   5. 合并录到的路径 + `.next/server/**`（API 路由 / 页面 chunk 的超集，467 个文件 21MB，客户端打 API 时会冷读）+ `.next/*.json`；
 *   6. 写清单。
 *
 * ⚠️ 本脚本**没有接进发版链**（release.yml / assemble 脚本都没动）：先在 Windows 真机验证预读确有收益再接。
 * 可跨平台跑（只用 Node 内置模块）；录制的是「这台机器上 server 实际读到的路径」，所以要在目标平台的构建机上生成。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildManifest,
  extractStaticAssetUrls,
  listTree,
  mergeUnique,
  toRelativePosix,
} from "./lib/boot-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, "lib", "boot-trace-preload.cjs");

const parseArgs = (argv) => {
  const args = { timeoutMs: 120_000, runAsNode: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server-dir") args.serverDir = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--node") args.node = argv[++i];
    else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (a === "--run-as-node") args.runAsNode = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (!args.serverDir) throw new Error("缺少 --server-dir");
  return args;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  return { status: res.status, body };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const serverDir = path.resolve(args.serverDir);
  if (!existsSync(path.join(serverDir, "server.js"))) {
    throw new Error(`没找到 ${path.join(serverDir, "server.js")}`);
  }
  const outFile = path.resolve(args.out ?? path.join(serverDir, "boot-manifest.json"));
  const tmp = mkdtempSync(path.join(os.tmpdir(), "flowship-bootgen-"));
  const traceFile = path.join(tmp, "trace.json");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // 干净环境：不继承宿主注入的 PORT / FLOWSHIP_DATA_DIR / __NEXT_PRIVATE_* 等（见 AGENTS.md「agent shell 环境坑」）
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: tmp,
    USERPROFILE: tmp,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(args.runAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    FLOWSHIP_DATA_DIR: path.join(tmp, "data"),
    FLOWSHIP_BOOT_TRACE_OUT: traceFile,
  };

  const child = spawn(args.node ?? process.execPath, ["--require", PRELOAD, "server.js"], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  child.stdout.on("data", () => {});
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const cleanup = () => {
    if (!exited) child.kill();
    rmSync(tmp, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + args.timeoutMs;
    let ready = false;
    while (Date.now() < deadline && !exited) {
      try {
        const r = await get(`${base}/api/readyz`, 2000);
        if (r.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // 还没起来
      }
      await sleep(300);
    }
    if (!ready) {
      throw new Error(`server 在 ${args.timeoutMs}ms 内没就绪（exited=${exited}）\n${stderrTail}`);
    }

    // 首页 SSR + 浏览器会立刻请求的静态资源
    const home = await get(`${base}/`, 60_000);
    const assets = extractStaticAssetUrls(home.body);
    for (const url of assets) {
      try {
        await get(`${base}${url}`, 15_000);
      } catch {
        // 单个资源失败不影响清单
      }
    }
    // 壳就绪后会 fire-and-forget 打的两个接口（失败 / 超时都无所谓，只为让它们的依赖被读一遍）
    for (const url of ["/api/boot-warmup", "/api/feishu-bridge/status"]) {
      try {
        await get(`${base}${url}`, 8_000);
      } catch {
        // ignore
      }
    }
    await sleep(800); // 等录制器落盘（300ms 一轮）
    if (!existsSync(traceFile)) throw new Error("录制器没有产出 trace（--require 没生效？）");

    const traced = JSON.parse(readFileSync(traceFile, "utf8")).files ?? [];
    const roots = [serverDir, realpathSync(serverDir)];
    const tracedRel = toRelativePosix(roots, traced);

    const nextServerAll = listTree(serverDir, ".next/server", { readdirSync });
    const nextRootJson = readdirSync(path.join(serverDir, ".next"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `.next/${e.name}`);
    const files = mergeUnique(tracedRel, nextRootJson, nextServerAll).filter((rel) => {
      try {
        return statSync(path.join(serverDir, ...rel.split("/"))).isFile();
      } catch {
        return false;
      }
    });
    let totalBytes = 0;
    for (const rel of files) totalBytes += statSync(path.join(serverDir, ...rel.split("/"))).size;

    const manifest = buildManifest({
      files,
      totalBytes,
      meta: { source: `traced=${tracedRel.length} staticAssets=${assets.length}` },
    });
    writeFileSync(outFile, JSON.stringify(manifest));
    console.log(
      `boot-manifest：${files.length} 个文件 / ${(totalBytes / 1048576).toFixed(1)}MB ` +
        `（录到 ${tracedRel.length}、首页静态资源 ${assets.length}）→ ${outFile}`,
    );
  } finally {
    cleanup();
  }
};

main().catch((err) => {
  console.error(`gen-boot-manifest 失败：${err?.message ?? err}`);
  process.exit(1);
});
