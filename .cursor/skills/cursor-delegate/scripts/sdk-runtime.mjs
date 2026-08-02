import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const CURSOR_SDK_VERSION = "1.0.26";

const platformPackage = {
  "darwin-arm64": "@cursor/sdk-darwin-arm64",
  "darwin-x64": "@cursor/sdk-darwin-x64",
  "linux-arm64": "@cursor/sdk-linux-arm64",
  "linux-x64": "@cursor/sdk-linux-x64",
  "win32-x64": "@cursor/sdk-win32-x64",
}[`${process.platform}-${process.arch}`];

function cacheRoot() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches");
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

const NEUTRAL_SDK_RUNTIME_DIRECTORY = join(
  cacheRoot(),
  "cursor-delegate",
  "runtime",
);

// macOS/Linux 旧版本把 runtime 放在 Codex 命名空间；已安装用户继续复用，
// 新安装统一使用宿主无关目录。Windows 旧路径本来就是中立的。
const LEGACY_SDK_RUNTIME_DIRECTORY =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Caches", "Codex", "cursor-delegate", "runtime")
    : process.platform === "linux"
      ? join(
          process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
          "codex",
          "cursor-delegate",
          "runtime",
        )
      : NEUTRAL_SDK_RUNTIME_DIRECTORY;

export const SDK_RUNTIME_DIRECTORY = existsSync(
  NEUTRAL_SDK_RUNTIME_DIRECTORY,
)
  ? NEUTRAL_SDK_RUNTIME_DIRECTORY
  : existsSync(LEGACY_SDK_RUNTIME_DIRECTORY)
    ? LEGACY_SDK_RUNTIME_DIRECTORY
    : NEUTRAL_SDK_RUNTIME_DIRECTORY;

function resolveRuntimePackage(packageName) {
  const require = createRequire(import.meta.url);
  return require.resolve(packageName, { paths: [SDK_RUNTIME_DIRECTORY] });
}

function platformBinaryPath(binaryName) {
  if (!platformPackage) return undefined;

  const packageJson = resolveRuntimePackage(`${platformPackage}/package.json`);
  const filename = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  const candidate = join(dirname(packageJson), "bin", filename);
  return existsSync(candidate) ? candidate : undefined;
}

function configureRuntimeBinaries() {
  const ripgrepPath = platformBinaryPath("rg");
  if (ripgrepPath && !process.env.CURSOR_RIPGREP_PATH) {
    process.env.CURSOR_RIPGREP_PATH = ripgrepPath;
  }
}

// Cursor SDK 1.0.x 没有公开 sandbox binary path 配置；它会从
// process.argv[1] 向上查找平台包。把入口临时指向独立 runtime，既能让 SDK
// 找到随包安装的 cursorsandbox，也不会污染调用方后续的 argv。
export async function withCursorSdkRuntimeEntrypoint(callback) {
  const previousEntrypoint = process.argv[1];
  process.argv[1] = join(SDK_RUNTIME_DIRECTORY, "cursor-delegate-runtime.mjs");
  try {
    return await callback();
  } finally {
    process.argv[1] = previousEntrypoint;
  }
}

async function importRuntimePackage(packageName) {
  const entrypoint = resolveRuntimePackage(packageName);
  return import(pathToFileURL(entrypoint).href);
}

export async function loadCursorSdk() {
  configureRuntimeBinaries();
  // 从 cache 目录动态 import 时，CJS 包常落在 module.default 上；
  // 直接解构 { Agent } 会拿到 undefined，Agent.create 随之炸掉。
  const mod = await importRuntimePackage("@cursor/sdk");
  const sdk = mod?.Agent ? mod : mod?.default;
  if (!sdk?.Agent) {
    throw new Error(
      "@cursor/sdk loaded but Agent export is missing (check runtime install)",
    );
  }
  if (platformPackage) {
    resolveRuntimePackage(`${platformPackage}/package.json`);
  }
  return sdk;
}

export async function ensureCursorSdkInstalled() {
  try {
    await loadCursorSdk();
    return { installed: false, runtimeDirectory: SDK_RUNTIME_DIRECTORY };
  } catch {
    // Install the exact SDK version for this operating system below.
  }

  mkdirSync(SDK_RUNTIME_DIRECTORY, { recursive: true });
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    [
      "install",
      "--no-save",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      `@cursor/sdk@${CURSOR_SDK_VERSION}`,
    ],
    {
      cwd: SDK_RUNTIME_DIRECTORY,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install exited with ${result.status}`);

  await loadCursorSdk();
  return { installed: true, runtimeDirectory: SDK_RUNTIME_DIRECTORY };
}
