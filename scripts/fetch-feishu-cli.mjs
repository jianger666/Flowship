/**
 * 打包前预取飞书 CLI（V0.13.x「CLI 内置进安装包」、用户拍板 +14MB 可接受）
 *
 * 下载 lark-cli / meegle 的**目标平台**二进制 + 两个仓库的官方 skills、
 * 落到 dist/feishu-tools/{bin,skills}——afterPack 拷进 resources/feishu-tools、
 * 运行时首次 boot 从 resources 种子拷贝到 data/tools/（见 feishu-cli.ts
 * seedFeishuToolsFromResources）。之后的版本更新仍走设置页在线增量下载。
 *
 * 用法：node scripts/fetch-feishu-cli.mjs --platform darwin-arm64|win32-x64
 * 失败语义：CLI 二进制任一下载失败 → 整体失败退非 0（CI 挡掉半残包）；
 * skills 拉取失败只 warn（运行时「更新」可补）。
 *
 * 下载逻辑与 src/lib/server/feishu-cli.ts 的 installLarkCli/installMeegle 同源
 * （URL 规则照抄官方 install.js）——改这里记得同步那边。
 */

import { execFile } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------- 参数 ----------
const platArg = process.argv.find((a) => a.startsWith("--platform"));
const platRaw = platArg?.includes("=")
  ? platArg.split("=")[1]
  : process.argv[process.argv.indexOf("--platform") + 1];
const target = platRaw || `${process.platform}-${process.arch}`;
const [plat, arch] = target.split("-");
if (!plat || !arch) {
  console.error(`--platform 非法：${target}（形如 darwin-arm64 / win32-x64）`);
  process.exit(1);
}
const isWin = plat === "win32";

const outDir = path.join(process.cwd(), "dist", "feishu-tools");
const binDir = path.join(outDir, "bin");
const skillsDir = path.join(outDir, "skills");

// ---------- 下载工具（同 feishu-cli.ts 口径） ----------
const downloadTo = async (url, dest) => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
};

const downloadFirstOk = async (urls, dest) => {
  let lastErr;
  for (const url of urls) {
    try {
      await downloadTo(url, dest);
      return url;
    } catch (err) {
      lastErr = err;
      console.warn(`  下载失败、试下一个源：${url}`);
    }
  }
  throw lastErr ?? new Error("全部下载源失败");
};

const fetchNpmLatestVersion = async (pkg) => {
  const encoded = pkg.replace("/", "%2F");
  for (const base of ["https://registry.npmjs.org", "https://registry.npmmirror.com"]) {
    try {
      const res = await fetch(`${base}/${encoded}/latest`, { redirect: "follow" });
      if (!res.ok) continue;
      const meta = await res.json();
      if (meta.version) return meta.version;
    } catch {
      // 换下一个源
    }
  }
  throw new Error(`拿不到 ${pkg} 的最新版本号`);
};

// tar 解压（mac/linux/win10+ 都自带 bsdtar、zip/tgz 通吃）
const extract = async (archive, destDir) => {
  await fs.mkdir(destDir, { recursive: true });
  await execFileP("tar", ["-xf", archive, "-C", destDir]);
};

const findFileRecursive = async (dir, name) => {
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

// ---------- lark-cli ----------
const LARK_PLATFORM = { darwin: "darwin", linux: "linux", win32: "windows" };
const LARK_ARCH = { x64: "amd64", arm64: "arm64" };

const fetchLarkCli = async () => {
  const version = await fetchNpmLatestVersion("@larksuite/cli");
  const ext = isWin ? ".zip" : ".tar.gz";
  const archiveName = `lark-cli-${version}-${LARK_PLATFORM[plat]}-${LARK_ARCH[arch]}${ext}`;
  console.log(`lark-cli v${version}（${archiveName}）下载中…`);
  const tmp = path.join(os.tmpdir(), `fetch-${archiveName}`);
  await downloadFirstOk(
    [
      `https://github.com/larksuite/cli/releases/download/v${version}/${archiveName}`,
      `https://registry.npmmirror.com/-/binary/lark-cli/v${version}/${archiveName}`,
    ],
    tmp,
  );
  const staging = path.join(os.tmpdir(), `fetch-lark-cli-${Date.now()}`);
  await extract(tmp, staging);
  const binName = isWin ? "lark-cli.exe" : "lark-cli";
  const found = await findFileRecursive(staging, binName);
  if (!found) throw new Error(`解包后找不到 ${binName}`);
  await fs.mkdir(binDir, { recursive: true });
  await fs.copyFile(found, path.join(binDir, binName));
  if (!isWin) await fs.chmod(path.join(binDir, binName), 0o755);
  await fs.rm(tmp, { force: true });
  await fs.rm(staging, { recursive: true, force: true });
  console.log(`lark-cli v${version} 就绪`);
};

// ---------- meegle ----------
const fetchMeegle = async () => {
  const version = await fetchNpmLatestVersion("@lark-project/meegle");
  console.log(`meegle v${version} 下载中…`);
  const tmp = path.join(os.tmpdir(), `fetch-meegle-${version}.tgz`);
  await downloadFirstOk(
    [
      `https://registry.npmjs.org/@lark-project/meegle/-/meegle-${version}.tgz`,
      `https://registry.npmmirror.com/@lark-project/meegle/-/meegle-${version}.tgz`,
    ],
    tmp,
  );
  const staging = path.join(os.tmpdir(), `fetch-meegle-${Date.now()}`);
  await extract(tmp, staging);
  const srcName = `meegle-${plat}-${arch}${isWin ? ".exe" : ""}`;
  const src = path.join(staging, "package", "bin", srcName);
  await fs.access(src).catch(() => {
    throw new Error(`meegle 包里没有目标平台二进制：${srcName}`);
  });
  const destName = isWin ? "meegle.exe" : "meegle";
  await fs.mkdir(binDir, { recursive: true });
  await fs.copyFile(src, path.join(binDir, destName));
  if (!isWin) await fs.chmod(path.join(binDir, destName), 0o755);
  await fs.rm(tmp, { force: true });
  await fs.rm(staging, { recursive: true, force: true });
  console.log(`meegle v${version} 就绪`);
};

// ---------- 官方 skills（失败只 warn、不阻断打包） ----------
const SKILLS_SOURCES = [
  { name: "lark-cli", tarball: "https://codeload.github.com/larksuite/cli/tar.gz/refs/heads/main", topDir: "cli-main" },
  { name: "meegle", tarball: "https://codeload.github.com/larksuite/meegle-cli/tar.gz/refs/heads/main", topDir: "meegle-cli-main" },
];

const fetchSkills = async () => {
  for (const srcDef of SKILLS_SOURCES) {
    try {
      const tmp = path.join(os.tmpdir(), `fetch-${srcDef.name}-repo.tgz`);
      await downloadTo(srcDef.tarball, tmp);
      const staging = path.join(os.tmpdir(), `fetch-${srcDef.name}-skills-${Date.now()}`);
      await extract(tmp, staging);
      const skillsSrc = path.join(staging, srcDef.topDir, "skills");
      const entries = await fs.readdir(skillsSrc, { withFileTypes: true }).catch(() => []);
      let count = 0;
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const dest = path.join(skillsDir, ent.name);
        await fs.rm(dest, { recursive: true, force: true });
        await fs.cp(path.join(skillsSrc, ent.name), dest, { recursive: true });
        count += 1;
      }
      console.log(`${srcDef.name} skills 就绪 ${count} 个`);
      await fs.rm(tmp, { force: true });
      await fs.rm(staging, { recursive: true, force: true });
    } catch (err) {
      console.warn(`${srcDef.name} skills 拉取失败（不阻断打包、运行时可在线补）：${err?.message ?? err}`);
    }
  }
};

// ---------- 主流程 ----------
await fs.rm(outDir, { recursive: true, force: true });
await fetchLarkCli();
await fetchMeegle();
await fetchSkills();
console.log(`feishu-tools 预取完成：${outDir}`);
