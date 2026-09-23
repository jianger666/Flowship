/**
 * 收尾线①路由分叉（v3.1 接线层：flag-gated，默认关闭零行为变化）。
 *
 * - flag 关：调用方直接走老路径（本模块不碰，老行为逐字节不变）；
 * - flag 开：`placeWorkerForTask` 做 worker 落位——WorkerManager.spawn
 *  （epoch/crash report/PATH shim）+ ready 握手 + 自上报订阅（样本→task 映射）+
 *   registerFlipDeps 真实现（findOpenMR/isCommitPushed/registry-backed provider）；
 *   任一步失败抛错，调用方 catch 后降级老路径（fail-safe，不 crash 启动链）；
 * - SDK compute-plane（worker-entry 寄宿）握手成功即就绪，真机翻转见 LIVE_CHECKLIST §3；
 * - 本地写不落 intent、epoch 同 stateRoot 比较——约束见交接单 C，不重复。
 */

import { execFile } from "node:child_process";

import { queryOpenMR } from "./gitlab-client";
import { reportWorkerMemorySample, clearWorkerMemorySample } from "./session-rotate";
import { registerFlipDeps, registryPayloadProvider, hasFlipDeps, type FlipDeps } from "./worker-flip";
import { isWorkerIsolationEnabled } from "./worker-mode";
import { WorkerManager } from "./worker-manager";

let sharedManager: WorkerManager | null = null;

export const sharedWorkerManager = (): WorkerManager => {
  if (!sharedManager) sharedManager = new WorkerManager();
  return sharedManager;
};

/** 单测注入/隔离用。 */
export const resetSharedWorkerManager = (): void => {
  sharedManager = null;
};

export interface WorkerPlacement {
  workspace: string;
  epoch: number;
  via: "worker";
}

export interface PlaceWorkerInput {
  taskId: string;
  workspace: string;
  stateRoot?: string;
  gitHost: string | null;
  gitToken: string | undefined;
  workDir: string;
  manager?: WorkerManager;
  readyTimeoutMs?: number;
}

const execGit = (workDir: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", workDir, ...args], { timeout: 15000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });

/**
 * git-push 对账默认实现：fetch 后 `rev-parse origin/<branch>` == localCommit
 * 即已推（同 commit 重推 = 空操作）；force-push 意图一律返回 null（调用方 abandoned 人工）。
 * 任何 git 错误 → false（not-present 语义，不抛）。
 */
export const defaultIsCommitPushed = async (p: {
  workDir: string;
  branch: string;
  commit: string;
}): Promise<boolean | null> => {
  try {
    await execGit(p.workDir, ["fetch", "origin", p.branch]);
    const remote = await execGit(p.workDir, ["rev-parse", `origin/${p.branch}`]);
    return remote === p.commit;
  } catch {
    return false;
  }
};

/**
 * task 级 flip 真实现装配（读侧；写执行仍走原工具路径，恢复才走 handler）。
 * task-runner 启动链与 placeWorkerForTask 共用同一实现（单点，不漂移）。
 */
export const buildTaskFlipDeps = (input: {
  gitHost: string | null;
  gitToken: string | undefined;
  workDir: string;
}): FlipDeps => {
  const { gitHost, gitToken, workDir } = input;
  return {
    payloadProvider: registryPayloadProvider,
    findOpenMergeRequest: async ({ projectPath, sourceBranch, targetBranch }) => {
      if (!gitHost || !gitToken) return { found: false };
      const r = await queryOpenMR({
        config: { host: gitHost, token: gitToken },
        projectPath,
        sourceBranch,
        targetBranch,
      });
      // 查询失败 ≠ 确认没有：found:false 会进 not-present→executor 分流；
      // 可重试类当场重调一次，at-most-once/仍失败进 abandoned（§5.1）。
      return { found: r.ok && !!r.mr };
    },
    isCommitPushed: async ({ branch, commit }) => {
      const r = await defaultIsCommitPushed({ workDir, branch, commit });
      return r === true;
    },
    workDirOf: () => workDir,
  };
};

/** ③修复：per-workspace 单监听注册表（重落位先 off 旧监听 + 清旧 task 样本）。 */
const workspaceSubscriptions = new Map<string, { unsub: () => void; taskId: string }>();

export const resetWorkspaceSubscriptions = (): void => {
  for (const { unsub } of workspaceSubscriptions.values()) {
    try { unsub(); } catch { /* ignore */ }
  }
  workspaceSubscriptions.clear();
};

export const placeWorkerForTask = async (
  input: PlaceWorkerInput,
): Promise<WorkerPlacement> => {
  if (!isWorkerIsolationEnabled()) {
    throw new Error("[worker-route] flag 关闭时不应调用 placeWorkerForTask");
  }
  const manager = input.manager ?? sharedWorkerManager();
  const rec = await manager.spawn(input.workspace, input.stateRoot);
  // ③修复：同 workspace 重落位先 off 旧监听、清旧 task 样本（防泄漏 + 错映射）。
  // 订阅必须在 ready 握手之前——握手用的首份自上报同样要进 relay 落样本。
  const prev = workspaceSubscriptions.get(input.workspace);
  if (prev) {
    try { prev.unsub(); } catch { /* ignore */ }
    if (prev.taskId !== input.taskId) clearWorkerMemorySample(prev.taskId);
    workspaceSubscriptions.delete(input.workspace);
  }
  const taskId = input.taskId;
  const workspace = input.workspace;
  const unsub = manager.onSelfReport((msg) => {
    if (msg.workspace !== workspace) return;
    // ①修复：透传 worker 实测 old-space/heapRatio（双 guard 全线生效）。
    reportWorkerMemorySample(taskId, {
      oldSpaceBytes: msg.oldSpaceBytes,
      heapRatio: msg.heapRatio,
      rssBytes: msg.rssBytes,
    });
  });
  workspaceSubscriptions.set(input.workspace, { unsub, taskId });
  // 新建 worker 等首份自上报（worker-entry 启动即报）做握手；复用跳过。
  // 握手失败回滚本轮订阅（不留孤儿监听），调用方 catch 后降级老路径。
  if (rec.fresh) {
    try {
      await awaitWorkerReady(manager, rec.workspace, rec.epoch, input.readyTimeoutMs ?? 10000);
    } catch (err) {
      unsub();
      workspaceSubscriptions.delete(input.workspace);
      throw err;
    }
  }
  // flip 真实现注册（读侧；写执行仍走原工具路径，恢复才走 handler）。
  // task-runner 启动链若已注册全配版则保留（hasFlipDeps 守卫，不用空配覆盖实配）。
  const { gitHost, gitToken, workDir } = input;
  if (!hasFlipDeps()) {
    registerFlipDeps(buildTaskFlipDeps({ gitHost, gitToken, workDir }));
  }
  return { workspace: rec.workspace, epoch: rec.epoch, via: "worker" };
};

/**
 * ready 握手：订阅等该 workspace+epoch 的首份自上报（worker-entry 启动即报），超时抛错走降级。
 * 无存量预查——调用点只在 rec.fresh（新建）时调；复用沿用首次落位结论（见 placeWorkerForTask）。
 */
export const awaitWorkerReady = async (
  manager: WorkerManager,
  workspace: string,
  epoch: number,
  timeoutMs = 10000,
): Promise<void> => {
  // 只订阅等首份自上报（无存量预查——调用点仅在 rec.fresh 新建时调，复用沿用首次落位结论）。
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`[worker-route] worker ready 超时 workspace=${workspace} epoch=${epoch}`));
    }, timeoutMs);
    const off = manager.onSelfReport((msg) => {
      if (msg.workspace === workspace && msg.epoch === epoch) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
};
