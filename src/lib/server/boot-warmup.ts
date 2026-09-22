/**
 * 启动后预热（server 就绪后由壳调 `/api/boot-warmup` 触发一次，fire-and-forget）。
 *
 * 从 `instrumentation-node.ts` 搬出来：这些全是网络 / 拉 shell / 全量迁移，
 * 和框架冷加载抢同一扇冷盘 + Defender 首扫窗口（Windows 首次启动超 30s 的主因之一）。
 * 搬到就绪后——此时用户还在看 splash/首页加载，磁盘和 CPU 正好空出来。
 *
 * 安全边界（搬家没动）：
 * - PATH 注入（feishu-cli / sdk rg）仍在 instrumentation（agent 起前必须 pin 好）；
 * - 密钥文件权限收紧仍在 instrumentation（安全项不等）；
 * - custom-actions 迁移 → 预置安装的先后链保持（串行、禁并行）；
 * - 每一项各自捕获、失败只 warn 不阻断；幂等，可重入（globalThis 单例防 doppelt）。
 */
const STARTED_KEY = "__flowshipBootWarmupStartedV1__";

// globalThis 单例：dev 下改到本文件触发 HMR 会重跑模块顶层，普通 let 会重置
// started 导致预热重跑一次（各项幂等、无害，但跟仓里惯例对齐）。
type StartedBox = Record<string, boolean | undefined>;
const startedBox = (): StartedBox =>
  globalThis as unknown as StartedBox;
const isStarted = (): boolean => startedBox()[STARTED_KEY] === true;
const markStarted = (): void => {
  startedBox()[STARTED_KEY] = true;
};

export const runBootWarmup = (): void => {
  if (isStarted()) return;
  markStarted();
  const t0 = Date.now();
  console.log(
    `[boot] warmup start uptime=${Math.round(process.uptime() * 1000)}ms`,
  );
  const done = (): void => {
    console.log(
      `[boot] warmup dispatched in ${Date.now() - t0}ms uptime=${Math.round(process.uptime() * 1000)}ms（各项各自后台跑）`,
    );
  };

  // PATH 补全后半段：登录 shell 合并（spawn shell 最长 10s）——前半段 pin 仍在 instrumentation
  void import("./login-shell-path")
    .then((m) => m.mergeLoginShellPath())
    .catch((err) => {
      console.warn(
        "[boot-warmup] 登录 shell PATH 合并失败（不阻断）:",
        err instanceof Error ? err.message : err,
      );
    });

  // M2：清历史 task meta 里 repoBranchTemplates 的 {username} 残留（幂等）
  void import("./migrate-username-templates")
    .then((m) => m.migrateUsernameBranchTemplates())
    .catch((err) => {
      console.warn(
        "[boot-warmup] username 模板迁移失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // 自定义 action → skill 托管迁移（幂等）须在预置安装前跑（链式串行、禁止并行竞态）
  void import("./custom-action-fs")
    .then((m) => m.migrateCustomActionsToSkillHosted())
    .catch((err) => {
      console.warn(
        "[boot-warmup] custom-actions → skill 托管迁移失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    })
    .then(() => import("./preset-actions"))
    .then((m) => m.ensureBuiltinFixBugPreset())
    .catch((err) => {
      console.warn(
        "[boot-warmup] 预置改bug 安装失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // Windows：按设置把 SHELL 指到 Git Bash（绕开 SDK PowerShell 挂死 bug）
  void import("./agent-shell")
    .then((m) => m.applyAgentShellPreference())
    .catch((err) => {
      console.warn(
        "[boot-warmup] 应用 Agent shell 偏好失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // 组共享库：启动自动 sync（没配 gitToken 内部静默跳过；失败只 warn）
  void import("./team-library")
    .then((m) => m.syncTeamLibrary({ silentWithoutToken: true }))
    .then((r) => {
      if (r.skipped) return;
      if (!r.ok) {
        console.warn("[boot-warmup] 组共享库 sync 失败:", r.error);
      }
    })
    .catch((err) => {
      console.warn(
        "[boot-warmup] 组共享库 sync 异常（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // models.dev 目录预热：约 4MB、现拉最长 20s——就绪后异步拉，首次开设置页即命中缓存
  void import("./models-dev-catalog")
    .then((m) => m.getModelsDevIndex())
    .catch((err) => {
      console.warn(
        "[boot-warmup] models.dev 目录预热失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  done();
};
