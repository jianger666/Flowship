#!/usr/bin/env node
/**
 * 一条命令完成 FlowshipTest 打 test 包并重启（进程级，无 UI 自动化）：
 *
 *   BUILD_STANDALONE=1 pnpm build
 *   → pnpm electron:server
 *   → pnpm exec electron-builder 打 staging unpacked test 包（productName=FlowshipTest）
 *   → 确认 staging 产物存在
 *   → 精确退出旧 FlowshipTest 进程
 *   → 将 staging 部署到规范路径（失败则恢复上一可用包并尝试重启旧版）
 *   → 启动规范路径下的新 test 包
 *
 * 构建/打包失败：旧 FlowshipTest 保持运行，脚本非零退出。
 * 部署失败：尽力恢复备份并启动上一可用包，再非零退出。
 *
 * 用法：pnpm electron:test:restart
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildElectronBuilderDistTestSpawnSpec,
  buildLaunchTestAppSpec,
  buildPnpmSpawnSpec,
  buildQuitTestAppSpec,
  buildTestAppProcessProbeSpec,
  describeDeployPlan,
  isTestAppRunningFromProbe,
  resolveTestAppPaths,
} from "./lib/electron-test-restart.mjs";

const PREFIX = "[electron:test:restart]";

function log(phase, message) {
  console.log(`${PREFIX} ${phase}: ${message}`);
}

function runSpawn({ command, args }, { env, label, ignoreFailure = false, detached = false } = {}) {
  return new Promise((resolve, reject) => {
    log(label ?? "run", `${command} ${args.join(" ")}`.trim());

    const child = spawn(command, args, {
      stdio: detached ? "ignore" : "inherit",
      env: env ?? process.env,
      detached,
      shell: false,
    });

    let settled = false;

    if (detached) {
      child.once("spawn", () => {
        settled = true;
        child.unref();
        resolve();
      });
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label ?? command} 启动失败：${err.message}`));
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0 || ignoreFailure) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit ${code}`;
      reject(new Error(`${label ?? command} 失败（${detail}）`));
    });
  });
}

function runCapture({ command, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ exitCode: code ?? -1, stdout }));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTestAppState(platform, expectedRunning, timeoutMs = 15_000) {
  const probeSpec = buildTestAppProcessProbeSpec(platform);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCapture(probeSpec);
    if (isTestAppRunningFromProbe(platform, result) === expectedRunning) return;
    await delay(200);
  }
  throw new Error(
    expectedRunning
      ? "启动命令已返回，但 FlowshipTest 主进程未出现"
      : "退出命令已返回，但旧 FlowshipTest 主进程仍未结束",
  );
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeDirRecursive(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function moveDir(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(src, dest);
}

async function verifyArtifact(artifactPath, label) {
  if (!(await pathExists(artifactPath))) {
    throw new Error(`${label}不存在：${artifactPath}`);
  }
}

/**
 * 将 staging 平台目录提升到规范路径；失败时尽力把 backup 还原回去。
 * @returns {boolean} 是否成功完成部署
 */
async function deployStagingToCanonical(plan) {
  const {
    verifyStagingArtifactPath,
    backupSourceDir,
    backupTargetDir,
    promoteSourceDir,
    promoteTargetDir,
    verifyCanonicalArtifactPath,
    rollbackSourceDir,
    rollbackTargetDir,
  } = plan;

  await verifyArtifact(verifyStagingArtifactPath, "staging 产物");

  let backedUp = false;
  if (await pathExists(backupSourceDir)) {
    await removeDirRecursive(backupTargetDir);
    await moveDir(backupSourceDir, backupTargetDir);
    backedUp = true;
    log("deploy", `已备份上一版 → ${backupTargetDir}`);
  }

  try {
    if (!(await pathExists(promoteSourceDir))) {
      throw new Error(`staging 平台目录不存在：${promoteSourceDir}`);
    }
    await moveDir(promoteSourceDir, promoteTargetDir);
    await verifyArtifact(verifyCanonicalArtifactPath, "规范产物");
    log("deploy", `已部署 → ${promoteTargetDir}`);
    return true;
  } catch (err) {
    log("deploy", `部署失败：${err.message}`);
    if (backedUp && (await pathExists(rollbackSourceDir))) {
      try {
        await removeDirRecursive(rollbackTargetDir);
        await moveDir(rollbackSourceDir, rollbackTargetDir);
        log("deploy", `已从备份恢复上一可用包 → ${rollbackTargetDir}`);
      } catch (restoreErr) {
        throw new Error(
          `部署失败且无法恢复上一可用包：${err.message}；恢复错误：${restoreErr.message}`,
        );
      }
    }
    throw new Error(`部署到规范路径失败：${err.message}（已尝试恢复上一可用包）`);
  }
}

async function main() {
  const platform = process.platform;
  const layout = resolveTestAppPaths();
  const deployPlan = describeDeployPlan(layout);

  log("1/6", "BUILD_STANDALONE=1 pnpm build");
  await runSpawn(buildPnpmSpawnSpec(["build"]), {
    label: "build",
    env: { ...process.env, BUILD_STANDALONE: "1" },
  });

  log("2/6", "pnpm electron:server");
  await runSpawn(buildPnpmSpawnSpec(["electron:server"]), { label: "electron:server" });

  log("3/6", "pnpm exec electron-builder 打 staging unpacked test 包");
  // electron-builder 默认会去 GitHub 下载/校验 Electron 运行时 zip；本地已有
  // node_modules/electron/dist 时直接指给它，test 打包完全离线（远程缺失时保留原行为）
  const localElectronDist = "node_modules/electron/dist";
  const electronDistPath = existsSync(localElectronDist) ? localElectronDist : undefined;
  await runSpawn(
    buildElectronBuilderDistTestSpawnSpec(platform, { electronDistPath }),
    { label: "electron:dist:test (staging)" },
  );

  log("4/6", `确认 staging 产物 ${layout.stagingArtifactPath}`);
  await verifyArtifact(layout.stagingArtifactPath, "staging 产物");

  const quitSpec = buildQuitTestAppSpec(platform);
  log("5/6", `退出旧 FlowshipTest：${quitSpec.command} ${quitSpec.args.join(" ")}`);
  await runSpawn(quitSpec, {
    label: "quit FlowshipTest",
    ignoreFailure: quitSpec.ignoreFailure,
  });
  await waitForTestAppState(platform, false);
  log("5/6", "旧 FlowshipTest 主进程已完全退出");

  try {
    await deployStagingToCanonical(deployPlan);
  } catch (deployErr) {
    const launchSpec = buildLaunchTestAppSpec(deployPlan.launchPath, platform);
    if (await pathExists(deployPlan.launchPath)) {
      log("5/6", "部署失败，尝试启动已恢复的上一可用包");
      try {
        await runSpawn(launchSpec, {
          label: "launch restored FlowshipTest",
          detached: launchSpec.detached,
        });
        await waitForTestAppState(platform, true);
      } catch (launchErr) {
        throw new Error(
          `${deployErr.message}；且无法启动已恢复的上一可用包：${launchErr.message}`,
        );
      }
    }
    throw deployErr;
  }

  const launchSpec = buildLaunchTestAppSpec(deployPlan.launchPath, platform);
  log("6/6", `启动新 test 包 ${launchSpec.command} ${launchSpec.args.join(" ")}`.trim());
  try {
    await runSpawn(launchSpec, {
      label: "launch FlowshipTest",
      detached: launchSpec.detached,
    });
    await waitForTestAppState(platform, true);
  } catch (launchErr) {
    throw new Error(
      `新包已部署到 ${deployPlan.verifyCanonicalArtifactPath}，但启动失败：${launchErr.message}`,
    );
  }

  log(
    "done",
    `${path.relative(process.cwd(), deployPlan.verifyCanonicalArtifactPath)}（主进程已确认运行）`,
  );
}

main().catch((err) => {
  console.error(`${PREFIX} 失败：${err.message}`);
  process.exit(1);
});
