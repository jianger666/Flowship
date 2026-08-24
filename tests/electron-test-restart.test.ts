import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BACKUP_SUBDIR,
  buildDistTestArgs,
  buildElectronBuilderDistTestSpawnSpec,
  buildLaunchTestAppSpec,
  buildPnpmSpawnSpec,
  buildQuitTestAppSpec,
  buildTestAppProcessProbeSpec,
  describeDeployPlan,
  ELECTRON_OUTPUT_DIR,
  mapNodeArchToElectronMacArch,
  isTestAppRunningFromProbe,
  resolveTestAppPaths,
  STAGING_SUBDIR,
  TEST_PRODUCT_NAME,
} from "../scripts/lib/electron-test-restart.mjs";

const ROOT = "/repo/root";
const EXEC_PATH = "/usr/bin/node";
const NPM_EXECPATH = "/usr/lib/node_modules/pnpm/bin/pnpm.cjs";

describe("mapNodeArchToElectronMacArch", () => {
  it("映射 arm64 / x64", () => {
    expect(mapNodeArchToElectronMacArch("arm64")).toBe("arm64");
    expect(mapNodeArchToElectronMacArch("x64")).toBe("x64");
  });

  it("未知架构抛错", () => {
    expect(() => mapNodeArchToElectronMacArch("ia32")).toThrow(/不支持的 mac 架构/);
  });
});

describe("resolveTestAppPaths", () => {
  it("macOS arm64 规范与 staging 路径", () => {
    const layout = resolveTestAppPaths({ platform: "darwin", arch: "arm64", root: ROOT });
    expect(layout).toMatchObject({
      platform: "darwin",
      platformDirName: "mac-arm64",
      canonicalArtifactPath: path.join(ROOT, "dist/electron/mac-arm64/FlowshipTest.app"),
      canonicalLaunchPath: path.join(ROOT, "dist/electron/mac-arm64/FlowshipTest.app"),
      stagingArtifactPath: path.join(
        ROOT,
        "dist/electron/.test-restart-staging/mac-arm64/FlowshipTest.app",
      ),
      stagingOutputDir: path.join(ROOT, "dist/electron/.test-restart-staging"),
      canonicalPlatformDir: path.join(ROOT, "dist/electron/mac-arm64"),
      stagingPlatformDir: path.join(ROOT, "dist/electron/.test-restart-staging/mac-arm64"),
      backupPlatformDir: path.join(ROOT, "dist/electron/.test-restart-backup/mac-arm64"),
    });
  });

  it("macOS x64 规范与 staging 路径", () => {
    const layout = resolveTestAppPaths({ platform: "darwin", arch: "x64", root: ROOT });
    expect(layout.canonicalArtifactPath).toBe(
      path.join(ROOT, "dist/electron/mac-x64/FlowshipTest.app"),
    );
    expect(layout.stagingArtifactPath).toBe(
      path.join(ROOT, "dist/electron/.test-restart-staging/mac-x64/FlowshipTest.app"),
    );
  });

  it("Windows 规范与 staging 路径", () => {
    const layout = resolveTestAppPaths({ platform: "win32", arch: "x64", root: ROOT });
    expect(layout).toMatchObject({
      platform: "win32",
      platformDirName: "win-unpacked",
      canonicalArtifactPath: path.join(ROOT, "dist/electron/win-unpacked/FlowshipTest.exe"),
      canonicalLaunchPath: path.join(ROOT, "dist/electron/win-unpacked/FlowshipTest.exe"),
      stagingArtifactPath: path.join(
        ROOT,
        "dist/electron/.test-restart-staging/win-unpacked/FlowshipTest.exe",
      ),
      canonicalPlatformDir: path.join(ROOT, "dist/electron/win-unpacked"),
      stagingPlatformDir: path.join(ROOT, "dist/electron/.test-restart-staging/win-unpacked"),
      backupPlatformDir: path.join(ROOT, "dist/electron/.test-restart-backup/win-unpacked"),
    });
  });
});

describe("describeDeployPlan", () => {
  it("部署步骤指向 staging → backup → canonical", () => {
    const layout = resolveTestAppPaths({ platform: "win32", arch: "x64", root: ROOT });
    expect(describeDeployPlan(layout)).toEqual({
      verifyStagingArtifactPath: layout.stagingArtifactPath,
      backupSourceDir: layout.canonicalPlatformDir,
      backupTargetDir: layout.backupPlatformDir,
      promoteSourceDir: layout.stagingPlatformDir,
      promoteTargetDir: layout.canonicalPlatformDir,
      verifyCanonicalArtifactPath: layout.canonicalArtifactPath,
      launchPath: layout.canonicalLaunchPath,
      rollbackSourceDir: layout.backupPlatformDir,
      rollbackTargetDir: layout.canonicalPlatformDir,
    });
  });
});

describe("buildDistTestArgs", () => {
  it("mac / win 各带 productName 与 staging output", () => {
    const stagingOut = path.join(ELECTRON_OUTPUT_DIR, STAGING_SUBDIR);
    expect(buildDistTestArgs("darwin")).toEqual([
      "--mac",
      "--dir",
      `-c.productName=${TEST_PRODUCT_NAME}`,
      `-c.directories.output=${stagingOut}`,
    ]);
    expect(buildDistTestArgs("win32")).toEqual([
      "--win",
      "--dir",
      `-c.productName=${TEST_PRODUCT_NAME}`,
      `-c.directories.output=${stagingOut}`,
    ]);
  });

  it("指定 electronDistPath 时复用本地 Electron 运行时", () => {
    const stagingOut = path.join(ELECTRON_OUTPUT_DIR, STAGING_SUBDIR);
    expect(buildDistTestArgs("darwin", { electronDistPath: "node_modules/electron/dist" })).toEqual([
      "--mac",
      "--dir",
      `-c.productName=${TEST_PRODUCT_NAME}`,
      `-c.directories.output=${stagingOut}`,
      "-c.electronDist=node_modules/electron/dist",
    ]);
  });
});

describe("buildPnpmSpawnSpec", () => {
  it("Windows 与 Unix 均用 execPath + npm_execpath（无 .cmd / shell）", () => {
    const spec = buildPnpmSpawnSpec(["build"], {
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs",
    });
    expect(spec).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs",
        "build",
      ],
    });
  });

  it("缺少 npm_execpath 时抛错", () => {
    expect(() => buildPnpmSpawnSpec(["build"], { execPath: EXEC_PATH, npmExecPath: "" })).toThrow(
      /npm_execpath/,
    );
  });
});

describe("buildElectronBuilderDistTestSpawnSpec", () => {
  it("经 pnpm exec electron-builder 调用 builder", () => {
    expect(
      buildElectronBuilderDistTestSpawnSpec("win32", {
        execPath: EXEC_PATH,
        npmExecPath: NPM_EXECPATH,
        electronDistPath: "node_modules/electron/dist",
      }),
    ).toEqual({
      command: EXEC_PATH,
      args: [
        NPM_EXECPATH,
        "exec",
        "electron-builder",
        "--win",
        "--dir",
        `-c.productName=${TEST_PRODUCT_NAME}`,
        `-c.directories.output=${path.join(ELECTRON_OUTPUT_DIR, STAGING_SUBDIR)}`,
        "-c.electronDist=node_modules/electron/dist",
      ],
    });
  });
});

describe("buildQuitTestAppSpec", () => {
  it("mac 用 osascript 精确 quit", () => {
    expect(buildQuitTestAppSpec("darwin")).toEqual({
      command: "osascript",
      args: ["-e", 'tell application "FlowshipTest" to quit'],
      ignoreFailure: true,
    });
  });

  it("Windows 用 taskkill 精确匹配 exe 名", () => {
    expect(buildQuitTestAppSpec("win32")).toEqual({
      command: "taskkill",
      args: ["/IM", "FlowshipTest.exe", "/F"],
      ignoreFailure: true,
    });
  });
});

describe("buildLaunchTestAppSpec", () => {
  it("mac 直启二进制（不走 open，避免宿主链路拉起静默早退）", () => {
    const app = "/tmp/FlowshipTest.app";
    expect(buildLaunchTestAppSpec(app, "darwin")).toEqual({
      command: "/tmp/FlowshipTest.app/Contents/MacOS/FlowshipTest",
      args: [],
      detached: true,
    });
  });

  it("Windows 直接启动 exe", () => {
    const exe = "C:\\dist\\FlowshipTest.exe";
    expect(buildLaunchTestAppSpec(exe, "win32")).toEqual({
      command: exe,
      args: [],
      detached: true,
    });
  });
});

describe("FlowshipTest 主进程探测", () => {
  it("macOS 用 pgrep 精确匹配主进程", () => {
    expect(buildTestAppProcessProbeSpec("darwin")).toEqual({
      command: "pgrep",
      args: ["-x", "FlowshipTest"],
    });
    expect(
      isTestAppRunningFromProbe("darwin", { exitCode: 0, stdout: "123\n" }),
    ).toBe(true);
    expect(
      isTestAppRunningFromProbe("darwin", { exitCode: 1, stdout: "" }),
    ).toBe(false);
  });

  it("Windows 只认 FlowshipTest.exe 的 tasklist 行", () => {
    expect(buildTestAppProcessProbeSpec("win32")).toEqual({
      command: "tasklist",
      args: ["/FI", "IMAGENAME eq FlowshipTest.exe", "/NH", "/FO", "CSV"],
    });
    expect(
      isTestAppRunningFromProbe("win32", {
        exitCode: 0,
        stdout: '"FlowshipTest.exe","4242","Console","1","100,000 K"\r\n',
      }),
    ).toBe(true);
    expect(
      isTestAppRunningFromProbe("win32", {
        exitCode: 0,
        stdout: "INFO: No tasks are running which match the specified criteria.\r\n",
      }),
    ).toBe(false);
  });
});

describe("staging 常量", () => {
  it("staging / backup 子目录名固定", () => {
    expect(STAGING_SUBDIR).toBe(".test-restart-staging");
    expect(BACKUP_SUBDIR).toBe(".test-restart-backup");
  });
});
