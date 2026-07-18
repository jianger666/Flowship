/**
 * 飞书官方 CLI 集成（V0.12 P0、用户拍板「内置两套 CLI、不强迫用户配 MCP」）
 *
 * 管两个官方 CLI 的 安装 / 登录 / 状态：
 * - **lark-cli**（github.com/larksuite/cli）：飞书开放平台 CLI、200+ 命令 + 官方 Agent Skills
 *   分发：GitHub Releases 平台二进制（中国网络 fallback npmmirror 二进制镜像、URL 规则
 *   照抄官方 npm wrapper 的 scripts/install.js）
 * - **meegle**（github.com/larksuite/meegle-cli）：飞书项目 CLI、16 业务域 50+ 命令
 *   分发：npm 包自带全平台 Go 二进制（bin/meegle-<platform>-<arch>）、解包挑当前平台的用
 *
 * 落盘布局（数据目录、随更新保留）：
 *   <dataRoot>/tools/bin/       lark-cli(.exe)、meegle(.exe)
 *   <dataRoot>/tools/skills/    两个仓库的官方 Agent Skills（skills-loader 额外扫这里）
 *
 * agent 怎么用上：server 启动时把 tools/bin 注进 process.env.PATH（injectFeishuCliPath、
 * instrumentation 调）、SDK agent 是本进程子进程、继承 PATH 后 shell 直接调 `lark-cli` / `meegle`。
 *
 * 登录：CLI 自己的 OAuth（会自动开浏览器、桌面端天然可用）——这里 spawn 托管进程、
 * 抓输出里的授权 URL 给 UI 兜底展示、UI 轮询状态。
 */

import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { dataRoot } from "./data-root";
import { enqueueMeegle } from "./meegle-queue";

const execFileAsync = promisify(execFile);

// ----------------- 路径 -----------------

const isWin = process.platform === "win32";

export const getToolsDir = (): string => path.join(dataRoot(), "tools");
export const getToolsBinDir = (): string => path.join(getToolsDir(), "bin");
export const getToolsSkillsDir = (): string => path.join(getToolsDir(), "skills");

/** lark-cli 二进制路径（`<dataRoot>/tools/bin/lark-cli[.exe]`）——桥接 / 安装链共用 */
export const getLarkCliBin = (): string =>
  path.join(getToolsBinDir(), isWin ? "lark-cli.exe" : "lark-cli");
/** @deprecated 用 getLarkCliBin；内部旧调用保留别名避免大面积改名 */
const larkCliBin = (): string => getLarkCliBin();
export const meegleBin = (): string =>
  path.join(getToolsBinDir(), isWin ? "meegle.exe" : "meegle");

/**
 * 把 tools/bin 注进本进程 PATH（幂等）——SDK agent 子进程继承后 shell 直呼两个 CLI。
 * server 启动（instrumentation）+ 安装完成后各调一次。
 */
export const injectFeishuCliPath = (): void => {
  const bin = getToolsBinDir();
  const cur = process.env.PATH ?? "";
  if (cur.split(path.delimiter).includes(bin)) return;
  process.env.PATH = `${bin}${path.delimiter}${cur}`;
  console.log(`[feishu-cli] PATH 已注入：${bin}`);
};

// ----------------- 下载 / 解包工具 -----------------

/** 下载整包超时（二进制 / tarball） */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** registry 元数据超时 */
const META_FETCH_TIMEOUT_MS = 10_000;
/** 单次下载体积上限（Content-Length 或累计字节） */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

// 私有临时目录（CR-05）：os.tmpdir 是共享可写目录、可预测文件名有 symlink / 抢占
// 风险——统一用 mkdtemp 拿带随机后缀的私有目录、下载 / 解包全在里面做
const makePrivateTmpDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `fe-ai-flow-${label}-`));

/** 流式计数：超 MAX_DOWNLOAD_BYTES 中止（防无 Content-Length 的无限流） */
const createByteLimitTransform = (): Transform => {
  let downloaded = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      downloaded += (chunk as Buffer).length;
      if (downloaded > MAX_DOWNLOAD_BYTES) {
        cb(
          new Error(
            `下载体积超限（累计 ${downloaded} > ${MAX_DOWNLOAD_BYTES} bytes）`,
          ),
        );
        return;
      }
      cb(null, chunk);
    },
  });
};

// 下载到文件（跟随重定向；github 或 npm registry 都走这里）
const downloadTo = async (url: string, dest: string): Promise<void> => {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  }
  const cl = res.headers.get("content-length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `下载体积超限（Content-Length ${n} > ${MAX_DOWNLOAD_BYTES}）`,
      );
    }
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // Web ReadableStream → Node stream、流式落盘（二进制 10-20MB、不进内存）
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    createByteLimitTransform(),
    createWriteStream(dest, { flags: "wx" }), // 排他创建：dest 已存在（被抢占）直接失败
  );
};

// 多源尝试下载（github 直连失败 fallback 镜像）
const downloadFirstOk = async (urls: string[], dest: string): Promise<string> => {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      await fs.rm(dest, { force: true }); // 上一个源写了半截、清掉再试（wx 排他）
      await downloadTo(url, dest);
      return url;
    } catch (err) {
      lastErr = err;
      console.warn(`[feishu-cli] 下载失败、试下一个源：${url}`, err instanceof Error ? err.message : err);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};

// 系统 tar 解包（mac/linux 自带；Windows 10+ 的 bsdtar 同时吃 tar.gz 和 zip）
const extractArchive = async (archive: string, destDir: string): Promise<void> => {
  await fs.mkdir(destDir, { recursive: true });
  await execFileAsync("tar", ["-xf", archive, "-C", destDir], {
    timeout: 120_000,
  });
};

// 流式算文件哈希（sha512 / sha1、验 npm integrity 用）
const hashFile = (file: string, algo: "sha512" | "sha1"): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash(algo);
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("base64")));
    stream.on("error", reject);
  });

/**
 * 验 npm 包 tarball 完整性（CR-05）：对照 registry metadata 的 `dist.integrity`
 * （SRI 格式 `sha512-<base64>`）或旧式 `dist.shasum`（sha1 hex）。
 * 镜像只当字节源——摘要跟 tarball 同一个 registry 响应给出、至少保证
 * 「装的字节 = registry 元数据声明的字节」、传输被改 / 镜像内容错位直接拒。
 * 两个字段都没有（异常 registry）→ 拒装、不静默放行。
 * （export 仅为回归测试、业务只在 installMeegle 内用）
 */
export const verifyNpmTarball = async (
  file: string,
  dist: { integrity?: string; shasum?: string },
  label: string,
): Promise<void> => {
  if (dist.integrity) {
    const m = dist.integrity.match(/^sha512-(.+)$/);
    if (!m) throw new Error(`${label} 的 integrity 格式不认识：${dist.integrity}`);
    const actual = await hashFile(file, "sha512");
    if (actual !== m[1]) {
      throw new Error(`${label} tarball SHA-512 校验失败（内容被篡改 / 传输损坏）、已中止安装`);
    }
    return;
  }
  if (dist.shasum) {
    const actual = Buffer.from(await hashFile(file, "sha1"), "base64").toString("hex");
    if (actual !== dist.shasum) {
      throw new Error(`${label} tarball SHA-1 校验失败、已中止安装`);
    }
    return;
  }
  throw new Error(`${label} 的 registry 元数据没有 integrity/shasum、拒绝安装`);
};

// npm 包 latest 元数据（版本号 + dist 摘要；npmjs → npmmirror 兜底）
interface NpmLatestMeta {
  version: string;
  dist: { integrity?: string; shasum?: string };
}

const fetchNpmLatestMeta = async (pkg: string): Promise<NpmLatestMeta> => {
  const encoded = pkg.replace("/", "%2F");
  for (const base of ["https://registry.npmjs.org", "https://registry.npmmirror.com"]) {
    try {
      const res = await fetch(`${base}/${encoded}/latest`, {
        redirect: "follow",
        signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const meta = (await res.json()) as {
        version?: string;
        dist?: { integrity?: string; shasum?: string };
      };
      if (meta.version) return { version: meta.version, dist: meta.dist ?? {} };
    } catch {
      // 换下一个源
    }
  }
  throw new Error(`拿不到 ${pkg} 的最新版本号（npmjs / npmmirror 都失败）`);
};

// 二进制原子就位（CR-05）：先拷到 bin 目录内的临时名、chmod 后 rename 到最终名
// （同目录 rename 原子）——安装失败绝不把已装好的旧版本覆盖成半截
const installBinaryAtomic = async (src: string, dest: string): Promise<void> => {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const staged = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.copyFile(src, staged);
    if (!isWin) await fs.chmod(staged, 0o755);
    await fs.rename(staged, dest);
  } catch (err) {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw err;
  }
};

// ----------------- 安装：lark-cli -----------------

// 官方二进制资产命名（照抄官方 install.js 的映射）
const LARK_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
const LARK_ARCH: Partial<Record<string, string>> = {
  x64: "amd64",
  arm64: "arm64",
};

const installLarkCli = async (log: (line: string) => void): Promise<void> => {
  const platform = LARK_PLATFORM[process.platform];
  const arch = LARK_ARCH[process.arch];
  if (!platform || !arch) {
    throw new Error(`lark-cli 不支持当前平台：${process.platform}/${process.arch}`);
  }
  const { version } = await fetchNpmLatestMeta("@larksuite/cli");
  // 增量语义（用户踩过：已装 v 最新还整包重下）：已装且版本一致 → 跳过
  const installed = await probeVersion(larkCliBin());
  if (installed === version) {
    log(`lark-cli v${version} 已是最新、跳过`);
    return;
  }
  log(`lark-cli 最新版本 v${version}、开始下载…`);
  const ext = isWin ? ".zip" : ".tar.gz";
  const archiveName = `lark-cli-${version}-${platform}-${arch}${ext}`;
  const urls = [
    `https://github.com/larksuite/cli/releases/download/v${version}/${archiveName}`,
    // 中国网络兜底：npmmirror 的二进制镜像（官方 install.js 同款路径）
    `https://registry.npmmirror.com/-/binary/lark-cli/v${version}/${archiveName}`,
  ];
  // ⚠️ 剩余风险（CR-05）：GitHub Release / npmmirror 二进制镜像官方都不发 checksum、
  // 这条链只能信 TLS + 版本固定；能做的加固（私有 mkdtemp + 排他写 + 原子替换）已做——
  // 官方哪天发 checksum / signature、在这里补校验
  const tmpDir = await makePrivateTmpDir("lark-cli");
  try {
    const tmp = path.join(tmpDir, archiveName);
    const used = await downloadFirstOk(urls, tmp);
    log(`已下载（${used.includes("npmmirror") ? "npmmirror 镜像" : "GitHub"}）、解包中…`);

    const staging = path.join(tmpDir, "extract");
    await extractArchive(tmp, staging);
    // 包里就是单个二进制（可能带一层目录）、递归找出来
    const binName = isWin ? "lark-cli.exe" : "lark-cli";
    const found = await findFileRecursive(staging, binName);
    if (!found) throw new Error(`解包后找不到 ${binName}`);
    // staging + 同目录 rename 原子就位——失败不碰已装旧版
    await installBinaryAtomic(found, larkCliBin());
    log(`lark-cli v${version} 安装完成`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};

// ----------------- 安装：meegle -----------------

const installMeegle = async (log: (line: string) => void): Promise<void> => {
  const { version, dist } = await fetchNpmLatestMeta("@lark-project/meegle");
  // 增量语义：已装且版本一致 → 跳过（同 installLarkCli）
  // 版本探测走 meegle 串行队列，避免与看板 / auth status 并发撞凭据
  const installed = await enqueueMeegle(() =>
    probeVersion(meegleBin(), { preferSubcommand: true }),
  );
  if (installed === version) {
    log(`meegle v${version} 已是最新、跳过`);
    return;
  }
  log(`meegle 最新版本 v${version}、开始下载…`);
  const urls = [
    `https://registry.npmjs.org/@lark-project/meegle/-/meegle-${version}.tgz`,
    `https://registry.npmmirror.com/@lark-project/meegle/-/meegle-${version}.tgz`,
  ];
  const tmpDir = await makePrivateTmpDir("meegle");
  try {
    const tmp = path.join(tmpDir, `meegle-${version}.tgz`);
    await downloadFirstOk(urls, tmp);
    // CR-05：对照 registry metadata 的 dist.integrity 验 tarball（镜像只当字节源）
    await verifyNpmTarball(tmp, dist, `meegle v${version}`);
    log("已下载并通过完整性校验、解包中…");

    const staging = path.join(tmpDir, "extract");
    await extractArchive(tmp, staging);
    // npm 包自带全平台 Go 二进制（bin/meegle-<platform>-<arch>[.exe]）、挑当前平台的拷出来
    const platArch = `${process.platform}-${process.arch}`;
    const binName = `meegle-${platArch}${isWin ? ".exe" : ""}`;
    const src = path.join(staging, "package", "bin", binName);
    try {
      await fs.access(src);
    } catch {
      throw new Error(`meegle 包里没有当前平台二进制：${binName}`);
    }
    await installBinaryAtomic(src, meegleBin());
    log(`meegle v${version} 安装完成`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};

// ----------------- 安装：官方 Agent Skills -----------------

// 两个官方仓的 skills/ 目录、**钉 commit SHA 拉**（v1.0.x 供应链加固、用户拍板「风险点处理掉」）：
// 官方不打 tag、原来跟可变 main——仓库/账号被攻破时注入内容会直接进 agent prompt（持久
// 供应链面）。钉 SHA = 内容不可变（commit sha 即内容哈希）、每次升级由我们人工审后改这里。
// 升级方式：确认新 commit 内容 OK → 更新 commit 字段 → 用户点「检查更新」重装 skills。
const SKILLS_SOURCES = [
  {
    name: "lark-cli",
    repo: "larksuite/cli",
    // 2026-07-10 main（人工核过 skills/ 目录内容）
    commit: "452734f82443f9decd8a7a34f17ae169c7ae2b50",
  },
  {
    name: "meegle",
    repo: "larksuite/meegle-cli",
    // 2026-07-07 main（人工核过 skills/ 目录内容）
    commit: "674042f0f58b62962103aff91598c9bc85ccb138",
  },
] as const;

// 解包后动态找顶层目录（github tarball 顶层名 = <repo>-<sha>、不再硬编码）
const findSingleTopDir = async (staging: string): Promise<string | null> => {
  const entries = await fs.readdir(staging, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory());
  return dirs.length === 1 ? path.join(staging, dirs[0].name) : null;
};

const installSkills = async (log: (line: string) => void): Promise<void> => {
  // 供应链加固（CR-05 收尾）：钉 commit SHA 拉（不可变）+ 私有 mkdtemp 下载解包 +
  // staging 后原子替换（不会装半截）。官方开始发 tag 后可改为跟版本 tag。
  for (const srcDef of SKILLS_SOURCES) {
    const tmpDir = await makePrivateTmpDir(`${srcDef.name}-skills`);
    try {
      const tmp = path.join(tmpDir, "repo.tgz");
      await downloadTo(
        `https://codeload.github.com/${srcDef.repo}/tar.gz/${srcDef.commit}`,
        tmp,
      );
      const staging = path.join(tmpDir, "extract");
      await extractArchive(tmp, staging);
      const topDir = await findSingleTopDir(staging);
      if (!topDir) throw new Error("tarball 结构异常：顶层不是单目录");
      const skillsSrc = path.join(topDir, "skills");
      const entries = await fs.readdir(skillsSrc, { withFileTypes: true }).catch(() => []);
      let count = 0;
      await fs.mkdir(getToolsSkillsDir(), { recursive: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const dest = path.join(getToolsSkillsDir(), ent.name);
        // staging 拷到 skills 目录内的临时名、再原子 rename 就位——
        // 中途失败留下的是 .tmp- 前缀目录、skills-loader 不认、旧版本不受损
        const staged = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          await fs.cp(path.join(skillsSrc, ent.name), staged, { recursive: true });
          await fs.rm(dest, { recursive: true, force: true });
          await fs.rename(staged, dest);
          count += 1;
        } catch (err) {
          await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
      }
      log(`${srcDef.name} skills 已装 ${count} 个`);
    } catch (err) {
      // skills 拉不下来不阻断（CLI 本体已可用）、下次安装/更新会重试
      log(`${srcDef.name} skills 拉取失败（不影响 CLI 使用）：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
};

// 递归找文件（解包目录层级不确定时用）
const findFileRecursive = async (dir: string, name: string): Promise<string | null> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isFile() && ent.name === name) return abs;
    if (ent.isDirectory()) {
      const found = await findFileRecursive(abs, name);
      if (found) return found;
    }
  }
  return null;
};

// ----------------- 安装任务编排（单例、防并发重入） -----------------

interface InstallState {
  running: boolean;
  // 追加式日志（UI 轮询展示）
  log: string[];
  error?: string;
  finishedAt?: number;
}

const G = globalThis as unknown as {
  __feishuCliInstall?: InstallState;
  __feishuCliLogins?: Map<string, LoginState>;
  // 状态快照缓存 + 后台刷新 single-flight（v1.1.x 启动提速、见「状态探测」节）
  __feishuStatusCache?: StatusSnapshot | null;
  __feishuStatusRefreshing?: Promise<StatusSnapshot> | null;
  // 缓存代数（蓝军 P1）：invalidate 递增、in-flight 探测落盘前核对——
  // 失效前发起的旧探测结果不写回缓存（否则装完/登完立刻被旧快照覆盖）
  __feishuStatusGen?: number;
};

/**
 * 卸载（V0.14.x 用户点名「万一想卸载后重装」）：删 bin（两个 CLI 二进制）+ skills
 *（官方技能）+ HOME 级配置 / 登录态（~/.lark-cli、~/.meegle）。
 * 配置一并删是用户拍板（2026-07-10）：同事踩过「半截坏配置卸载重装也修不好」
 *（卸载保留配置 → 重装后 auth login 仍拿坏配置直接退 code=3）——卸载语义就该彻底。
 */
export const uninstallFeishuTools = async (): Promise<void> => {
  if (getInstallState().running) {
    throw new Error("安装进行中、等安装完成后再卸载");
  }
  await fs.rm(getToolsBinDir(), { recursive: true, force: true });
  await fs.rm(getToolsSkillsDir(), { recursive: true, force: true });
  await fs.rm(path.join(os.homedir(), ".lark-cli"), { recursive: true, force: true });
  await fs.rm(path.join(os.homedir(), ".meegle"), { recursive: true, force: true });
  invalidateStatusCache();
  console.log("[feishu-cli] 已卸载（bin + skills + 配置/登录态 全部删除）");
};

export const getInstallState = (): InstallState =>
  (G.__feishuCliInstall ??= { running: false, log: [] });

/** 一键安装 / 更新两个 CLI + 官方 skills（后台跑、UI 轮询 getInstallState） */
export const startInstall = (): boolean => {
  const state = getInstallState();
  if (state.running) return false;
  state.running = true;
  state.log = [];
  state.error = undefined;
  const log = (line: string) => {
    state.log.push(line);
    console.log(`[feishu-cli] ${line}`);
  };
  void (async () => {
    try {
      await installLarkCli(log);
      await installMeegle(log);
      await installSkills(log);
      injectFeishuCliPath();
      log("全部完成");
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      log(`安装失败：${state.error}`);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
      // 装完状态一定变了：失效缓存、设置页下一次 GET 拿真值
      invalidateStatusCache();
    }
  })();
  return true;
};

// ----------------- 登录（spawn 托管、抓授权 URL 给 UI 兜底） -----------------

/**
 * 登录 stdout 里抓到的 URL 是否允许自动 open。
 * 只放行飞书系域名（feishu.cn / larksuite.com / feishu-boe.cn），其余只记录不打开。
 */
export const isTrustedFeishuAuthUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "feishu.cn" || host.endsWith(".feishu.cn")) return true;
    if (host === "larksuite.com" || host.endsWith(".larksuite.com")) return true;
    // 飞书 BOE / 预发：精确注册域及子域，禁止 substring 匹配
    if (host === "feishu-boe.cn" || host.endsWith(".feishu-boe.cn")) return true;
    return false;
  } catch {
    return false;
  }
};

interface LoginState {
  running: boolean;
  // 输出里抓到的最后一个 https URL（CLI 自己会开浏览器、这里给 UI 兜底展示）
  authUrl?: string;
  // 已自动开过浏览器的 URL 计数（两步流程会先后出两个 URL、上限 3 防误开一堆 tab）
  openedUrls?: number;
  tail: string[];
  error?: string;
  exitCode?: number | null;
}

const getLogins = (): Map<string, LoginState> => (G.__feishuCliLogins ??= new Map());

export const getLoginState = (tool: string): LoginState | null =>
  getLogins().get(tool) ?? null;

/**
 * 发起登录（后台 spawn、UI 轮询 getLoginState + 状态接口收敛）：
 * - lark-cli：没配置过 → `config init --new`（浏览器建应用 + 授权）；有配置 → `auth login --recommend`
 * - meegle：先 `config set host`（幂等）、再 `auth login`（浏览器 OAuth）
 */
export const startLogin = async (
  tool: "lark-cli" | "meegle",
  opts: { meegleHost?: string } = {},
): Promise<{ ok: boolean; error?: string }> => {
  const logins = getLogins();
  const existing = logins.get(tool);
  if (existing?.running) return { ok: false, error: "登录流程已在进行中" };

  const state: LoginState = { running: true, tail: [] };
  logins.set(tool, state);

  let cmd: string;
  let args: string[];
  if (tool === "lark-cli") {
    cmd = larkCliBin();
    const hasConfig = await fs
      .access(path.join(os.homedir(), ".lark-cli", "config.json"))
      .then(() => true)
      .catch(() => false);
    // --new：官方引导式建应用 + 授权（阻塞到用户在浏览器完成）；已有配置直接登录
    args = hasConfig ? ["auth", "login", "--recommend"] : ["config", "init", "--new"];
  } else {
    cmd = meegleBin();
    const host = opts.meegleHost?.trim() || "project.feishu.cn";
    // config set/init 是短命调用 → 入 meegle 串行队列（防与看板探测并发撞凭据）
    try {
      await enqueueMeegle(() =>
        execFileAsync(meegleBin(), ["config", "set", "host", host], {
          timeout: 15_000,
        }),
      );
    } catch (err) {
      // config.json 不存在时 set 可能失败、先 init 再 set（整段仍在队列内串行）
      try {
        await enqueueMeegle(async () => {
          await execFileAsync(meegleBin(), ["config", "init"], {
            timeout: 15_000,
          });
          await execFileAsync(meegleBin(), ["config", "set", "host", host], {
            timeout: 15_000,
          });
        });
      } catch {
        state.running = false;
        state.error = `meegle host 配置失败：${err instanceof Error ? err.message : String(err)}`;
        return { ok: false, error: state.error };
      }
    }
    // 裸 auth login 走 Authorization Code flow、需要交互式浏览器回调——spawn 子进程
    // 环境跑不了（实测退出提示改用 device-code）。device-code flow 打印 verification
    // URL、正好接我们的「抓 URL 自动开浏览器」逻辑。
    // ⚠️ auth login 长驻交互进程不占队列槽：用户显式低频操作、会挂很久；
    // 占槽会阻塞看板 / auth status 探测。短命调用（config / status / version）已入队。
    args = ["auth", "login", "--device-code", "--host", host];
  }

  try {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    const onChunk = (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        state.tail.push(trimmed);
        if (state.tail.length > 50) state.tail.shift();
        // 抓授权 URL（CLI 会打印）。用户实测 CLI 不一定自动开浏览器（spawn 子进程环境）——
        // 服务端主动开系统浏览器；UI 同时展示链接 + 二维码兜底。
        // V0.14.x：lark-cli `config init --new` 是**两步**（建应用 → 授权）、CLI 会先后
        // 打印两个不同 URL——**每个新 URL 都要开**（原来只开第一个、用户卡在第二步
        // 授权不知道要操作、只能靠 AI 聊天时提醒）
        const m = trimmed.match(/https:\/\/\S+/);
        // 抓到新 URL 一律记录给 UI；只对已知飞书域自动 open（防 stdout 任意 https 被开浏览器）
        if (m && m[0] !== state.authUrl) {
          state.authUrl = m[0];
          if (
            isTrustedFeishuAuthUrl(m[0]) &&
            (state.openedUrls ?? 0) < 3
          ) {
            state.openedUrls = (state.openedUrls ?? 0) + 1;
            const opener =
              process.platform === "darwin"
                ? ["open", [m[0]]]
                : process.platform === "win32"
                  ? ["cmd", ["/c", "start", "", m[0]]]
                  : ["xdg-open", [m[0]]];
            try {
              spawn(opener[0] as string, opener[1] as string[], {
                detached: true,
                stdio: "ignore",
              }).unref();
            } catch {
              // 打不开就靠 UI 链接 / 二维码
            }
          } else if (!isTrustedFeishuAuthUrl(m[0])) {
            console.log(
              `[feishu-cli] 登录输出含非飞书域 URL、仅记录不打开：${m[0]}`,
            );
          }
        }
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("exit", (code) => {
      state.running = false;
      state.exitCode = code;
      // 登录态可能变了（成功 / 失效都算）：失效状态缓存、下一次 GET 拿真值
      invalidateStatusCache();
      if (code !== 0) {
        // 带上 CLI 输出尾部（真实报错在这）——只给 code 用户和维护者都没法排查
        //（同事实测「code=3」猜不出原因）；完整 tail 落 main.log、诊断包可取
        const tailText = state.tail.slice(-3).join(" | ");
        state.error = `登录进程退出 code=${code}${tailText ? `：${tailText}` : ""}`;
        console.warn(
          `[feishu-cli] ${tool} 登录失败 code=${code}、CLI 输出尾部：\n${state.tail.join("\n")}`,
        );
      }
    });
    child.on("error", (err) => {
      state.running = false;
      state.error = err.message;
      // spawn 失败也可能是环境变了（bin 被删等）：一并失效状态缓存（蓝军 P2）
      invalidateStatusCache();
    });
    return { ok: true };
  } catch (err) {
    state.running = false;
    state.error = err instanceof Error ? err.message : String(err);
    return { ok: false, error: state.error };
  }
};

// ----------------- 状态探测 -----------------

export interface CliToolStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  // 登录账号 / 失败原因等一行摘要
  authDetail?: string;
}

// 两个 CLI 的状态快照（缓存 / 接口返回的最小单元）
export interface StatusSnapshot {
  larkCli: CliToolStatus;
  meegle: CliToolStatus;
}

const probeVersion = async (
  bin: string,
  opts: { preferSubcommand?: boolean } = {},
): Promise<string | null> => {
  // lark-cli 认 `--version` flag；meegle（cobra CLI）只有 `version` 子命令、
  // 传 --version 报 unknown flag exit 1（实测踩过：装好了却被 UI 判「未安装」）——两种都试。
  // preferSubcommand：meegle 先试 `version`、省一次必败的 spawn（每次白等一轮进程起落）
  const forms = opts.preferSubcommand
    ? [["version"], ["--version"]]
    : [["--version"], ["version"]];
  for (const args of forms) {
    try {
      const { stdout } = await execFileAsync(bin, args, { timeout: 10_000 });
      // 形如 "lark-cli version 1.0.66" / 裸 "1.0.16"、抓第一个语义化版本号
      const m = stdout.match(/\d+\.\d+\.\d+/);
      return m ? m[0] : stdout.trim().slice(0, 40);
    } catch {
      // 换下一种形态
    }
  }
  return null;
};

/** auth 探测内部结果：transient 只在探测→合并缓存流转、不进对外 StatusSnapshot */
interface AuthProbeResult {
  loggedIn: boolean;
  detail?: string;
  /** 瞬态失败（超时 / 网络抖）——合并缓存时不得把已登录降成未登录 */
  transient?: boolean;
}

/** execFile 超时被 kill / 带 signal → 瞬态（不是「确定未登录」） */
const isExecTransient = (err: unknown): boolean => {
  const e = err as { killed?: boolean; signal?: string | null };
  return e.killed === true || (typeof e.signal === "string" && e.signal.length > 0);
};

const probeLarkAuth = async (): Promise<AuthProbeResult> => {
  try {
    const { stdout } = await execFileAsync(larkCliBin(), ["auth", "status"], {
      timeout: 15_000,
    });
    // 有 stdout 且能按现有正则解析 → 结果算确定
    const loggedIn = /"available":\s*true/.test(stdout) || /"users":\s*\[\s*\{/.test(stdout);
    const nameMatch = stdout.match(/"userName":\s*"([^"]+)"/);
    // 有输出但两个正则都没命中 → 仍算确定「未登录」（CLI 明确回了状态）
    return { loggedIn, detail: nameMatch?.[1] };
  } catch (err) {
    // 超时 kill / 完全无 stdout → 瞬态；别把已登录缓存打成未登录
    const e = err as { stdout?: string; message?: string };
    const hasOut = typeof e.stdout === "string" && e.stdout.trim().length > 0;
    const transient = isExecTransient(err) || !hasOut;
    return {
      loggedIn: false,
      detail: err instanceof Error ? err.message.slice(0, 80) : undefined,
      transient,
    };
  }
};

const probeMeegleAuth = async (): Promise<AuthProbeResult> =>
  // auth status 短命 → 入 meegle 串行队列（与 meegle-cli / 版本探测互斥）
  enqueueMeegle(async () => {
    try {
      // 官方文档：exit 0 = token 有效；1 = 未登录 / token 失效；2 = 网络不可达
      await execFileAsync(meegleBin(), ["auth", "status"], { timeout: 15_000 });
      return { loggedIn: true };
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      const reason =
        typeof e.stdout === "string"
          ? e.stdout.match(/"reason":\s*"([^"]+)"/)?.[1]
          : undefined;
      // exit 1 = 确定未登录；exit 2 / 超时 kill / 未知错误 = 瞬态
      const transient =
        e.code === 2 || isExecTransient(err) || (e.code !== 0 && e.code !== 1);
      return {
        loggedIn: false,
        detail: reason ?? (e.code === 2 ? "网络不可达" : "未登录"),
        transient,
      };
    }
  });

// 二进制文件是否存在（探测版本失败时的兜底判「已安装」）
const binExists = async (p: string): Promise<boolean> =>
  !!(await fs.stat(p).catch(() => null));

/** 真探测内部结果：带 auth probe（含 transient），落缓存前由 merge 剥掉 */
interface ProbedStatus {
  snapshot: StatusSnapshot;
  larkAuth: AuthProbeResult | null;
  meegleAuth: AuthProbeResult | null;
}

// 真探测（4 个子进程 + auth status 打网络验 token、Windows Defender 首扫下可拖数秒~十几秒）
const probeStatusNow = async (): Promise<ProbedStatus> => {
  const [larkVer, meegleVer, larkOnDisk, meegleOnDisk] = await Promise.all([
    probeVersion(larkCliBin()),
    // meegle 版本探测入串行队列；lark-cli 不动队列
    enqueueMeegle(() =>
      probeVersion(meegleBin(), { preferSubcommand: true }),
    ),
    binExists(larkCliBin()),
    binExists(meegleBin()),
  ]);
  // installed 判定 = 版本探测成功 **或 文件在盘上**——同事实测踩过：Windows 首次起动
  // Defender 扫描让 spawn 超时、探测失败被判「未安装」、点一次安装才「检测出来」。
  // 文件在就是装了、版本号探不出来先空着（下轮 / 装完再补）。
  const larkCli: CliToolStatus = {
    installed: !!larkVer || larkOnDisk,
    version: larkVer ?? undefined,
  };
  const meegle: CliToolStatus = {
    installed: !!meegleVer || meegleOnDisk,
    version: meegleVer ?? undefined,
  };
  // 已安装才探登录态（并行）
  const [larkAuth, meegleAuth] = await Promise.all([
    larkCli.installed ? probeLarkAuth() : Promise.resolve(null),
    meegle.installed ? probeMeegleAuth() : Promise.resolve(null),
  ]);
  if (larkAuth) {
    larkCli.loggedIn = larkAuth.loggedIn;
    larkCli.authDetail = larkAuth.detail;
  }
  if (meegleAuth) {
    meegle.loggedIn = meegleAuth.loggedIn;
    meegle.authDetail = meegleAuth.detail;
  }
  return { snapshot: { larkCli, meegle }, larkAuth, meegleAuth };
};

// ----------------- 状态缓存（v1.1.x、同事实测「启动很慢」根因） -----------------
//
// 根因链：首页就绪清单 gate 阻塞在 /api/system/feishu-cli GET、而状态探测每次都
// 真 spawn 4 个子进程（version ×2 + auth status ×2）——Windows Defender 首扫二进制
// 可拖数秒、`auth status` 还要打网络验 token → 每次启动首页 loading 都卡这一截。
//
// 修法 stale-while-revalidate：内存 + 磁盘双缓存、有缓存**立即返回**、后台 single-flight
// 真探测刷新（首页 3s 轮询下一轮拿到新值）；全新用户没缓存时真探测本身很快
//（bin 不存在 execFile 立即 ENOENT）、不受影响。安装 / 登录 / 卸载后主动失效、
// 设置页操作完拿到的一定是真值。
//
// 瞬态失败不降级（v1.x）：auth 超时 / meegle exit 2 / 网络抖 不得把已登录快照写成
// 未登录落盘——见 refreshStatusCache 写缓存前的 mergeAuthPreserve。

const statusCacheFile = (): string => path.join(getToolsDir(), "status-cache.json");

/**
 * 合并 auth：新探测「未登录且 transient」而旧缓存该工具已登录 → 保留旧 loggedIn / authDetail。
 * 避免超时 / 网络抖把已登录快照写成未登录落盘、首页就绪清单闪一下。
 * transient 只在探测内部流转、落缓存的 StatusSnapshot 不含该字段。
 */
const mergeAuthPreserve = (
  next: CliToolStatus,
  prev: CliToolStatus | undefined,
  probe: AuthProbeResult | null,
): CliToolStatus => {
  if (probe?.transient && !probe.loggedIn && prev?.loggedIn === true) {
    return {
      ...next,
      loggedIn: true,
      authDetail: prev.authDetail,
    };
  }
  return next;
};

/** 写缓存前：用旧缓存护住瞬态「未登录」、产出对外干净的 StatusSnapshot */
const mergeProbedWithCache = (
  probed: ProbedStatus,
  prev: StatusSnapshot | null | undefined,
): StatusSnapshot => ({
  larkCli: mergeAuthPreserve(probed.snapshot.larkCli, prev?.larkCli, probed.larkAuth),
  meegle: mergeAuthPreserve(probed.snapshot.meegle, prev?.meegle, probed.meegleAuth),
});

// 后台真探测 + 落双缓存（single-flight：并发 GET 只探一次）
const refreshStatusCache = (): Promise<StatusSnapshot> => {
  if (G.__feishuStatusRefreshing) return G.__feishuStatusRefreshing;
  const gen = (G.__feishuStatusGen ??= 0);
  const flight: Promise<StatusSnapshot> = (async () => {
    try {
      // 探测前快照旧缓存（合并用）——probe 期间别读可能被并发改的引用
      const prev = G.__feishuStatusCache;
      const probed = await probeStatusNow();
      // 瞬态失败不降级已登录：合并后再写内存 + 磁盘（剥掉 transient）
      const snap = mergeProbedWithCache(probed, prev);
      // 探测期间被 invalidate（装/登/卸完成）→ 本结果基于旧世界、丢弃不落盘
      if (G.__feishuStatusGen === gen) {
        G.__feishuStatusCache = snap;
        try {
          await fs.mkdir(getToolsDir(), { recursive: true });
          await fs.writeFile(statusCacheFile(), JSON.stringify(snap));
        } catch {
          /* 缓存写不进不影响功能 */
        }
      }
      return snap;
    } finally {
      // 条件注销（按代数比对）：没被 invalidate 时当前 flight 只有自己、清掉；
      // 被 invalidate 过则引用已被清（可能已有新 flight 顶上）、不动别人的
      if (G.__feishuStatusGen === gen) G.__feishuStatusRefreshing = null;
    }
  })();
  G.__feishuStatusRefreshing = flight;
  return flight;
};

// meegle 身份缓存失效回调（meegle-cli 模块加载时注册；避免 feishu↔meegle 循环 import）
let meegleIdentityCacheInvalidator: (() => void) | null = null;

/** 供 meegle-cli 注册：登录/登出/卸载清状态缓存时一并清 me/identity */
export const registerMeegleIdentityCacheInvalidator = (
  fn: () => void,
): void => {
  meegleIdentityCacheInvalidator = fn;
};

// 安装 / 登录 / 卸载后调：下一次 GET 走真探测（用户正守着设置页、等真值可接受）
const invalidateStatusCache = (): void => {
  G.__feishuStatusGen = (G.__feishuStatusGen ?? 0) + 1;
  G.__feishuStatusCache = null;
  // 放弃 in-flight（其结果代数已过期、落盘会被上面的核对拦住；引用清空让下次真探）
  G.__feishuStatusRefreshing = null;
  void fs.rm(statusCacheFile(), { force: true }).catch(() => {});
  // 换账号后旧 user_key / 姓名不能继续用（审查发现：只清状态缓存会扫错人）
  meegleIdentityCacheInvalidator?.();
};

export const getFeishuCliStatus = async (): Promise<StatusSnapshot> => {
  // 内存缓存：立即返回、后台刷新
  if (G.__feishuStatusCache) {
    void refreshStatusCache().catch(() => {});
    return G.__feishuStatusCache;
  }
  // 磁盘缓存（上次进程的快照、跨重启生效——启动提速的主力）：立即返回、后台刷新
  try {
    const raw = await fs.readFile(statusCacheFile(), "utf8");
    const snap = JSON.parse(raw) as StatusSnapshot;
    if (snap?.larkCli && snap?.meegle) {
      G.__feishuStatusCache = snap;
      void refreshStatusCache().catch(() => {});
      return snap;
    }
  } catch {
    /* 没缓存 / 缓存坏 → 真探测 */
  }
  return refreshStatusCache();
};
