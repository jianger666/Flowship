/**
 * FlowshipTest 打 test 包并重启：平台路径、命令解析与 staging 部署布局（可单测）
 */
import path from "node:path";

export const TEST_PRODUCT_NAME = "FlowshipTest";
export const ELECTRON_OUTPUT_DIR = "dist/electron";
/** electron-builder 临时输出，避免覆盖正在运行的规范产物 */
export const STAGING_SUBDIR = ".test-restart-staging";
/** 部署前备份上一版规范产物，失败时可恢复 */
export const BACKUP_SUBDIR = ".test-restart-backup";

/** Node process.arch → electron-builder mac 输出目录后缀 */
export function mapNodeArchToElectronMacArch(nodeArch) {
  if (nodeArch === "arm64") return "arm64";
  if (nodeArch === "x64") return "x64";
  throw new Error(`不支持的 mac 架构：${nodeArch}`);
}

function resolvePlatformLayout(platform, arch, root) {
  const stagingRoot = path.join(root, ELECTRON_OUTPUT_DIR, STAGING_SUBDIR);
  const canonicalRoot = path.join(root, ELECTRON_OUTPUT_DIR);
  const backupRoot = path.join(root, ELECTRON_OUTPUT_DIR, BACKUP_SUBDIR);

  if (platform === "darwin") {
    const macArch = mapNodeArchToElectronMacArch(arch);
    const platformDirName = `mac-${macArch}`;
    const appBundleName = `${TEST_PRODUCT_NAME}.app`;
    return {
      platform,
      macArch,
      platformDirName,
      appEntryName: appBundleName,
      canonicalPlatformDir: path.join(canonicalRoot, platformDirName),
      stagingPlatformDir: path.join(stagingRoot, platformDirName),
      backupPlatformDir: path.join(backupRoot, platformDirName),
      canonicalArtifactPath: path.join(canonicalRoot, platformDirName, appBundleName),
      stagingArtifactPath: path.join(stagingRoot, platformDirName, appBundleName),
      canonicalLaunchPath: path.join(canonicalRoot, platformDirName, appBundleName),
      stagingOutputDir: stagingRoot,
    };
  }

  if (platform === "win32") {
    const platformDirName = "win-unpacked";
    const exeName = `${TEST_PRODUCT_NAME}.exe`;
    return {
      platform,
      macArch: null,
      platformDirName,
      appEntryName: exeName,
      canonicalPlatformDir: path.join(canonicalRoot, platformDirName),
      stagingPlatformDir: path.join(stagingRoot, platformDirName),
      backupPlatformDir: path.join(backupRoot, platformDirName),
      canonicalArtifactPath: path.join(canonicalRoot, platformDirName, exeName),
      stagingArtifactPath: path.join(stagingRoot, platformDirName, exeName),
      canonicalLaunchPath: path.join(canonicalRoot, platformDirName, exeName),
      stagingOutputDir: stagingRoot,
    };
  }

  throw new Error(
    `electron:test:restart 仅支持 macOS 与 Windows，当前 platform=${platform}`,
  );
}

/**
 * 解析规范产物与 staging 布局（构建写 staging，部署后启动规范路径）。
 * @returns {ReturnType<typeof resolvePlatformLayout>}
 */
export function resolveTestAppPaths({
  platform = process.platform,
  arch = process.arch,
  root = process.cwd(),
} = {}) {
  return resolvePlatformLayout(platform, arch, root);
}

/** @deprecated 使用 resolveTestAppPaths */
export function resolveTestAppArtifact(options = {}) {
  const layout = resolveTestAppPaths(options);
  return {
    platform: layout.platform,
    artifactPath: layout.canonicalArtifactPath,
    launchPath: layout.canonicalLaunchPath,
  };
}

/**
 * 通过 Node 官方 execPath + npm_execpath 调用 pnpm（跨平台、无 shell 拼接）。
 */
export function buildPnpmSpawnSpec(
  pnpmArgs,
  { execPath = process.execPath, npmExecPath = process.env.npm_execpath } = {},
) {
  if (!execPath) {
    throw new Error("electron:test:restart 缺少 process.execPath");
  }
  if (!npmExecPath) {
    throw new Error(
      "electron:test:restart 需在 pnpm 环境下运行（缺少 npm_execpath，请用 pnpm electron:test:restart）",
    );
  }
  return {
    command: execPath,
    args: [npmExecPath, ...pnpmArgs],
  };
}

/** electron-builder 打 unpacked test 包到 staging 目录的 CLI 参数 */
export function buildDistTestArgs(
  platform = process.platform,
  { stagingOutputRelative = path.join(ELECTRON_OUTPUT_DIR, STAGING_SUBDIR) } = {},
) {
  const productNameFlag = `-c.productName=${TEST_PRODUCT_NAME}`;
  const outputFlag = `-c.directories.output=${stagingOutputRelative}`;

  if (platform === "darwin") {
    return ["--mac", "--dir", productNameFlag, outputFlag];
  }
  if (platform === "win32") {
    return ["--win", "--dir", productNameFlag, outputFlag];
  }

  throw new Error(
    `electron:test:restart 仅支持 macOS 与 Windows，当前 platform=${platform}`,
  );
}

/** 经 pnpm exec electron-builder 打 staging test 包 */
export function buildElectronBuilderDistTestSpawnSpec(
  platform = process.platform,
  options = {},
) {
  return buildPnpmSpawnSpec(
    ["exec", "electron-builder", ...buildDistTestArgs(platform, options)],
    options,
  );
}

/**
 * 精确退出 FlowshipTest 测试进程（不影响正式 Flowship）。
 * ignoreFailure：进程未运行时不视为错误。
 */
export function buildQuitTestAppSpec(platform = process.platform) {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", `tell application "${TEST_PRODUCT_NAME}" to quit`],
      ignoreFailure: true,
    };
  }
  if (platform === "win32") {
    return {
      command: "taskkill",
      args: ["/IM", `${TEST_PRODUCT_NAME}.exe`, "/F"],
      ignoreFailure: true,
    };
  }

  throw new Error(
    `electron:test:restart 仅支持 macOS 与 Windows，当前 platform=${platform}`,
  );
}

/** 查询 FlowshipTest 主进程；只匹配测试应用的精确进程名。 */
export function buildTestAppProcessProbeSpec(platform = process.platform) {
  if (platform === "darwin") {
    return { command: "pgrep", args: ["-x", TEST_PRODUCT_NAME] };
  }
  if (platform === "win32") {
    return {
      command: "tasklist",
      args: ["/FI", `IMAGENAME eq ${TEST_PRODUCT_NAME}.exe`, "/NH", "/FO", "CSV"],
    };
  }
  throw new Error(
    `electron:test:restart 仅支持 macOS 与 Windows，当前 platform=${platform}`,
  );
}

/** 将平台进程探测结果统一解释成“测试主进程是否存在”。 */
export function isTestAppRunningFromProbe(
  platform,
  { exitCode, stdout },
) {
  if (platform === "darwin") return exitCode === 0;
  if (platform === "win32") {
    return stdout.toLowerCase().includes(`"${TEST_PRODUCT_NAME.toLowerCase()}.exe"`);
  }
  throw new Error(
    `electron:test:restart 仅支持 macOS 与 Windows，当前 platform=${platform}`,
  );
}

/** 启动规范路径下的 unpacked test 包 */
export function buildLaunchTestAppSpec(launchPath, platform = process.platform) {
  if (platform === "darwin") {
    // -n 强制 LaunchServices 创建新实例，避免请求被仍在退出的旧实例吞掉。
    return { command: "open", args: ["-n", launchPath], detached: false };
  }
  if (platform === "win32") {
    return { command: launchPath, args: [], detached: true };
  }

  throw new Error(
    `electron:test:restart 仅支持 macOS 与 Windows，当前 platform=${platform}`,
  );
}

/**
 * staging → 规范路径的原子部署步骤（供主脚本与单测断言顺序/路径）。
 * 仅在 staging 产物已存在且构建成功后执行；失败时主脚本应 restoreBackupToCanonical。
 */
export function describeDeployPlan(layout) {
  return {
    verifyStagingArtifactPath: layout.stagingArtifactPath,
    backupSourceDir: layout.canonicalPlatformDir,
    backupTargetDir: layout.backupPlatformDir,
    promoteSourceDir: layout.stagingPlatformDir,
    promoteTargetDir: layout.canonicalPlatformDir,
    verifyCanonicalArtifactPath: layout.canonicalArtifactPath,
    launchPath: layout.canonicalLaunchPath,
    rollbackSourceDir: layout.backupPlatformDir,
    rollbackTargetDir: layout.canonicalPlatformDir,
  };
}
