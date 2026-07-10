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
import { promises as fs, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { dataRoot } from "./data-root";

const execFileAsync = promisify(execFile);

// ----------------- 路径 -----------------

const isWin = process.platform === "win32";

export const getToolsDir = (): string => path.join(dataRoot(), "tools");
export const getToolsBinDir = (): string => path.join(getToolsDir(), "bin");
export const getToolsSkillsDir = (): string => path.join(getToolsDir(), "skills");

const larkCliBin = (): string =>
  path.join(getToolsBinDir(), isWin ? "lark-cli.exe" : "lark-cli");
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

// 下载到文件（跟随重定向；github 或 npm registry 都走这里）
const downloadTo = async (url: string, dest: string): Promise<void> => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // Web ReadableStream → Node stream、流式落盘（二进制 10-20MB、不进内存）
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    createWriteStream(dest),
  );
};

// 多源尝试下载（github 直连失败 fallback 镜像）
const downloadFirstOk = async (urls: string[], dest: string): Promise<string> => {
  let lastErr: unknown;
  for (const url of urls) {
    try {
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

// npm registry 拿包最新版本号（npmjs → npmmirror 兜底）
const fetchNpmLatestVersion = async (pkg: string): Promise<string> => {
  const encoded = pkg.replace("/", "%2F");
  for (const base of ["https://registry.npmjs.org", "https://registry.npmmirror.com"]) {
    try {
      const res = await fetch(`${base}/${encoded}/latest`, { redirect: "follow" });
      if (!res.ok) continue;
      const meta = (await res.json()) as { version?: string };
      if (meta.version) return meta.version;
    } catch {
      // 换下一个源
    }
  }
  throw new Error(`拿不到 ${pkg} 的最新版本号（npmjs / npmmirror 都失败）`);
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
  const version = await fetchNpmLatestVersion("@larksuite/cli");
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
  const tmp = path.join(os.tmpdir(), `fe-ai-flow-${archiveName}`);
  const used = await downloadFirstOk(urls, tmp);
  log(`已下载（${used.includes("npmmirror") ? "npmmirror 镜像" : "GitHub"}）、解包中…`);

  const staging = path.join(os.tmpdir(), `fe-ai-flow-lark-cli-${Date.now()}`);
  await extractArchive(tmp, staging);
  // 包里就是单个二进制（可能带一层目录）、递归找出来
  const binName = isWin ? "lark-cli.exe" : "lark-cli";
  const found = await findFileRecursive(staging, binName);
  if (!found) throw new Error(`解包后找不到 ${binName}`);
  await fs.mkdir(getToolsBinDir(), { recursive: true });
  await fs.copyFile(found, larkCliBin());
  if (!isWin) await fs.chmod(larkCliBin(), 0o755);
  await fs.rm(tmp, { force: true });
  await fs.rm(staging, { recursive: true, force: true });
  log(`lark-cli v${version} 安装完成`);
};

// ----------------- 安装：meegle -----------------

const installMeegle = async (log: (line: string) => void): Promise<void> => {
  const version = await fetchNpmLatestVersion("@lark-project/meegle");
  // 增量语义：已装且版本一致 → 跳过（同 installLarkCli）
  const installed = await probeVersion(meegleBin());
  if (installed === version) {
    log(`meegle v${version} 已是最新、跳过`);
    return;
  }
  log(`meegle 最新版本 v${version}、开始下载…`);
  const urls = [
    `https://registry.npmjs.org/@lark-project/meegle/-/meegle-${version}.tgz`,
    `https://registry.npmmirror.com/@lark-project/meegle/-/meegle-${version}.tgz`,
  ];
  const tmp = path.join(os.tmpdir(), `fe-ai-flow-meegle-${version}.tgz`);
  await downloadFirstOk(urls, tmp);
  log("已下载、解包中…");

  const staging = path.join(os.tmpdir(), `fe-ai-flow-meegle-${Date.now()}`);
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
  await fs.mkdir(getToolsBinDir(), { recursive: true });
  await fs.copyFile(src, meegleBin());
  if (!isWin) await fs.chmod(meegleBin(), 0o755);
  await fs.rm(tmp, { force: true });
  await fs.rm(staging, { recursive: true, force: true });
  log(`meegle v${version} 安装完成`);
};

// ----------------- 安装：官方 Agent Skills -----------------

// 两个仓库的 skills/ 目录随主分支 tarball 拉（codeload 直连、失败不阻断 CLI 安装）
const SKILLS_SOURCES = [
  {
    name: "lark-cli",
    tarball: "https://codeload.github.com/larksuite/cli/tar.gz/refs/heads/main",
    // tarball 顶层目录名（github 规则：<repo>-<ref>）
    topDir: "cli-main",
  },
  {
    name: "meegle",
    tarball: "https://codeload.github.com/larksuite/meegle-cli/tar.gz/refs/heads/main",
    topDir: "meegle-cli-main",
  },
] as const;

const installSkills = async (log: (line: string) => void): Promise<void> => {
  for (const srcDef of SKILLS_SOURCES) {
    try {
      const tmp = path.join(os.tmpdir(), `fe-ai-flow-${srcDef.name}-repo.tgz`);
      await downloadTo(srcDef.tarball, tmp);
      const staging = path.join(os.tmpdir(), `fe-ai-flow-${srcDef.name}-skills-${Date.now()}`);
      await extractArchive(tmp, staging);
      const skillsSrc = path.join(staging, srcDef.topDir, "skills");
      const entries = await fs.readdir(skillsSrc, { withFileTypes: true }).catch(() => []);
      let count = 0;
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const dest = path.join(getToolsSkillsDir(), ent.name);
        await fs.rm(dest, { recursive: true, force: true });
        await fs.cp(path.join(skillsSrc, ent.name), dest, { recursive: true });
        count += 1;
      }
      log(`${srcDef.name} skills 已装 ${count} 个`);
      await fs.rm(tmp, { force: true });
      await fs.rm(staging, { recursive: true, force: true });
    } catch (err) {
      // skills 拉不下来不阻断（CLI 本体已可用）、下次安装/更新会重试
      log(`${srcDef.name} skills 拉取失败（不影响 CLI 使用）：${err instanceof Error ? err.message : String(err)}`);
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
    }
  })();
  return true;
};

// ----------------- 登录（spawn 托管、抓授权 URL 给 UI 兜底） -----------------

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
    try {
      await execFileAsync(meegleBin(), ["config", "set", "host", host], { timeout: 15_000 });
    } catch (err) {
      // config.json 不存在时 set 可能失败、先 init 再 set
      try {
        await execFileAsync(meegleBin(), ["config", "init"], { timeout: 15_000 });
        await execFileAsync(meegleBin(), ["config", "set", "host", host], { timeout: 15_000 });
      } catch {
        state.running = false;
        state.error = `meegle host 配置失败：${err instanceof Error ? err.message : String(err)}`;
        return { ok: false, error: state.error };
      }
    }
    // 裸 auth login 走 Authorization Code flow、需要交互式浏览器回调——spawn 子进程
    // 环境跑不了（实测退出提示改用 device-code）。device-code flow 打印 verification
    // URL、正好接我们的「抓 URL 自动开浏览器」逻辑
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
        // 最多自动开 3 个不同 URL（两步流程足够）、防 CLI 输出里夹文档链接开一堆 tab
        if (m && m[0] !== state.authUrl && (state.openedUrls ?? 0) < 3) {
          state.openedUrls = (state.openedUrls ?? 0) + 1;
          state.authUrl = m[0];
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
        }
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("exit", (code) => {
      state.running = false;
      state.exitCode = code;
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

const probeVersion = async (bin: string): Promise<string | null> => {
  // lark-cli 认 `--version` flag；meegle（cobra CLI）只有 `version` 子命令、
  // 传 --version 报 unknown flag exit 1（实测踩过：装好了却被 UI 判「未安装」）——两种都试
  for (const args of [["--version"], ["version"]]) {
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

const probeLarkAuth = async (): Promise<{ loggedIn: boolean; detail?: string }> => {
  try {
    const { stdout } = await execFileAsync(larkCliBin(), ["auth", "status"], {
      timeout: 15_000,
    });
    // 输出 JSON：users / identities.user.available 非空即视为已登录
    const loggedIn = /"available":\s*true/.test(stdout) || /"users":\s*\[\s*\{/.test(stdout);
    const nameMatch = stdout.match(/"userName":\s*"([^"]+)"/);
    return { loggedIn, detail: nameMatch?.[1] };
  } catch (err) {
    return { loggedIn: false, detail: err instanceof Error ? err.message.slice(0, 80) : undefined };
  }
};

const probeMeegleAuth = async (): Promise<{ loggedIn: boolean; detail?: string }> => {
  try {
    // 官方文档：exit 0 = token 有效；1 = 未登录 / token 失效；2 = 网络不可达
    await execFileAsync(meegleBin(), ["auth", "status"], { timeout: 15_000 });
    return { loggedIn: true };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    const reason = typeof e.stdout === "string" ? e.stdout.match(/"reason":\s*"([^"]+)"/)?.[1] : undefined;
    return { loggedIn: false, detail: reason ?? (e.code === 2 ? "网络不可达" : "未登录") };
  }
};

export const getFeishuCliStatus = async (): Promise<{
  larkCli: CliToolStatus;
  meegle: CliToolStatus;
}> => {
  const [larkVer, meegleVer] = await Promise.all([
    probeVersion(larkCliBin()),
    probeVersion(meegleBin()),
  ]);
  const larkCli: CliToolStatus = { installed: !!larkVer, version: larkVer ?? undefined };
  const meegle: CliToolStatus = { installed: !!meegleVer, version: meegleVer ?? undefined };
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
  return { larkCli, meegle };
};
