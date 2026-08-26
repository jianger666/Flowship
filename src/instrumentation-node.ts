/**
 * Node-only 启动钩子（由 `instrumentation.ts` 在 NEXT_RUNTIME=nodejs 时动态加载）。
 *
 * 拆出来是为了不让 Turbopack 把 `process.on` / `node:*` 编进 Edge graph——
 * turbo 会编译 instrumentation 给 Edge，静态 import 会把整棵 server 模块树拖进去刷警告。
 */

export const registerNode = (): void => {
  // 防重复注册：dev HMR / 多次 register 时 listener 会累积、触发 MaxListenersExceededWarning
  // 跟 chat-mcp 一样用 globalThis 挂单例标记
  const g = globalThis as typeof globalThis & {
    __flowshipGlobalHandlers?: boolean;
  };
  if (g.__flowshipGlobalHandlers) return;
  g.__flowshipGlobalHandlers = true;

  process.on("unhandledRejection", (reason) => {
    console.error(
      "[instrumentation] 未处理的 Promise rejection（已兜底、进程不退）：",
      reason,
    );
  });

  // test 实例的 lark-cli 配置隔离（2026-07-19 用户拍板）：
  // lark-cli 默认读全局 ~/.lark-cli/config.json——test 和正式会绑同一个飞书机器人、
  // 事件互抢。test 实例把配置目录指到独立目录（绑独立机器人）；
  // 正式实例不动（继续用全局配置）。放 instrumentation 最早期、先于一切 lark-cli spawn。
  //
  // ⚠️ 目录不能放数据目录（Application Support）下：路径带空格会触发 lark-cli
  // 1.0.68 event bus daemon fork bug（daemon 秒挂、bus.log 空、consume 报
  // 「bus did not become ready within 3s」——2026-07-19 无空格路径对照实验实锤），
  // 所以放 home 下无空格的 ~/.lark-cli-flowship-test。
  {
    const dataDir = process.env.FLOWSHIP_DATA_DIR ?? "";
    const isTest =
      process.env.FLOWSHIP_TEST === "1" || dataDir.includes("fe-ai-flow-test");
    if (isTest && !process.env.LARKSUITE_CLI_CONFIG_DIR) {
      // HOME 在 mac/linux 恒有；兜底 USERPROFILE 兼容 Windows
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      if (home) {
        process.env.LARKSUITE_CLI_CONFIG_DIR = `${home}/.lark-cli-flowship-test`;
        console.log(
          `[instrumentation] test 实例 lark-cli 配置隔离 → ${process.env.LARKSUITE_CLI_CONFIG_DIR}`,
        );
      }
    }
  }

  // PATH 补全（注入必须立刻发生、不能等登录 shell 探测：探测最长 10s、期间起的
  // agent 会缺 meegle / rg；login 合并是去重保序 + pin 已注入前缀）：
  // 1) 内置飞书 CLI（lark-cli / meegle）bin
  // 2) SDK 平台包里的 rg（自定义提供方 pi grep 用、避免 GitHub 下载）
  // 3) mac GUI 启动继承 launchd 精简 PATH、缺 nvm/homebrew/yarn——异步合并登录 shell PATH
  void import("./lib/server/feishu-cli").then((m) => m.injectFeishuCliPath());
  void import("./lib/server/sdk-platform-bin").then((m) => m.injectSdkRgPath());
  void import("./lib/server/login-shell-path").then((m) =>
    m.mergeLoginShellPath(),
  );

  // P0-02：启动幂等收紧密钥文件权限（config.json 0600 / mcp-oauth 0700+0600）
  // 失败只 warn、不阻断启动；日志不含文件内容
  void import("./lib/server/settings-fs").then((m) => m.hardenConfigFilePerms());
  void import("./lib/server/mcp-oauth").then((m) => m.hardenMcpOAuthPerms());

  // M2：清历史 task meta 里 repoBranchTemplates 的 {username} 残留（幂等、失败不阻断启动）
  void import("./lib/server/migrate-username-templates")
    .then((m) => m.migrateUsernameBranchTemplates())
    .catch((err) => {
      console.warn(
        "[instrumentation] username 模板迁移失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // 自定义 action → skill 托管迁移（幂等）须在预置安装前跑、把旧 builtin-fix-bug 迁成 app:fix-bug；
  // 再 ensureBuiltinFixBugPreset。错误各自捕获、不阻断启动（链式串行、禁止并行竞态）。
  void import("./lib/server/custom-action-fs")
    .then((m) => m.migrateCustomActionsToSkillHosted())
    .catch((err) => {
      console.warn(
        "[instrumentation] custom-actions → skill 托管迁移失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    })
    .then(() => import("./lib/server/preset-actions"))
    .then((m) => m.ensureBuiltinFixBugPreset())
    .catch((err) => {
      console.warn(
        "[instrumentation] 预置改bug 安装失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // Windows：按设置把 SHELL 指到 Git Bash（绕开 SDK PowerShell 挂死 bug）；失败不阻断启动
  void import("./lib/server/agent-shell")
    .then((m) => m.applyAgentShellPreference())
    .catch((err) => {
      console.warn(
        "[instrumentation] 应用 Agent shell 偏好失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // 组共享库：启动自动 sync（没配 gitToken 内部静默跳过；失败只 warn）
  // 注：cleanup-fe-hooks 挂在 task-runner 非启动链，故同步挂在本 instrumentation 启动 fire-and-forget 段
  void import("./lib/server/team-library")
    .then((m) => m.syncTeamLibrary({ silentWithoutToken: true }))
    .then((r) => {
      if (r.skipped) return;
      if (!r.ok) {
        console.warn("[instrumentation] 组共享库 sync 失败:", r.error);
      }
    })
    .catch((err) => {
      console.warn(
        "[instrumentation] 组共享库 sync 异常（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // models.dev 目录预热（fire-and-forget）：目录约 4MB、现拉最长 20s——启动时异步拉好，
  // 之后首次自定义 provider 调用 / 打开设置页即命中 24h 缓存。refreshIndexes 内部
  // 自带失败冷却 + 空表兜底（离线也不影响启动），这里只兜动态 import 本身的失败。
  void import("./lib/server/models-dev-catalog")
    .then((m) => m.getModelsDevIndex())
    .catch((err) => {
      console.warn(
        "[instrumentation] models.dev 目录预热失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // ⚠️ 飞书桥接 bootstrap **不能**挂这里（2026-07-19 dev 冒烟踩过）：
  // bridge 模块图经 router/card-action → chat-inject → chat-runner 静态引到 @cursor/sdk，
  // 而 instrumentation 的 webpack bundle 不吃 serverExternalPackages——SDK 的
  // `lazy ^./` 动态导入会让 webpack 去解析 dist 里的 .d.ts.map、ModuleParseError
  // 毒化整个 server 编译（所有路由 500、build 同挂）。
  // → bootstrap 改挂在 route 模块加载时（见 /api/tasks 与 /api/feishu-bridge/status），
  //   route bundle 吃 serverExternalPackages、SDK 保持 external。
};
