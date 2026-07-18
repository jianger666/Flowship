/**
 * Next.js instrumentation：server 进程启动时跑一次（register 钩子、Next 15 默认加载）
 *
 * V0.6.12 用途：给 unhandledRejection 加进程级兜底。
 *
 * # 背景
 *
 * @cursor/sdk 在认证失败（unauthenticated）/ 连接中断时、内部后台 promise
 *（不是我们 await 的 run.stream / run.wait 主链、而是 SDK 自己挂的 status / keepalive 流）
 * 会 reject 并逃逸 task-runner 的 try/catch、变成 unhandledRejection。
 * Node 对未处理 rejection 默认直接退出进程——长跑 dev / 生产 server 不能因为
 * 一次 SDK 认证抖动整个挂掉。
 *
 * # 行为
 *
 * 兜底：记日志、不 re-throw、保进程存活。业务态（task 标 error）由 task-runner
 * 自己的 catch 处理、不依赖这里；这层只防「进程被一个逃逸的 rejection 带走」。
 *
 * 注意：全局兜底会吞掉所有 unhandledRejection（含潜在真 bug）、所以 handler 里
 * 打全量 reason 方便排查、不是无脑静默。uncaughtException 不在这兜——它是同步未捕获、
 * 兜了反而可能让进程带着脏状态硬撑、语义上该崩重启、不一刀切。
 */
export const register = (): void => {
  // 只在 nodejs runtime 装：edge runtime 没有完整 process、也不跑 SDK
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 防重复注册：dev HMR / 多次 register 时 listener 会累积、触发 MaxListenersExceededWarning
  // 跟 chat-mcp 一样用 globalThis 挂单例标记
  const g = globalThis as typeof globalThis & {
    __feAiFlowGlobalHandlers?: boolean;
  };
  if (g.__feAiFlowGlobalHandlers) return;
  g.__feAiFlowGlobalHandlers = true;

  process.on("unhandledRejection", (reason) => {
    console.error(
      "[instrumentation] 未处理的 Promise rejection（已兜底、进程不退）：",
      reason,
    );
  });

  // PATH 两步补全：
  // 1) 内置飞书 CLI（lark-cli / meegle）bin 目录**立即**注入（同以前、零等待）——
  //    不能排在登录 shell 探测之后：探测最长 10s、期间起的 agent 会缺 meegle（review 竞态）
  // 2) mac GUI 启动（Dock / 自更新重启）继承 launchd 精简 PATH、缺 nvm/homebrew/yarn——
  //    异步跑登录 shell 拿真实 PATH 合并进来（预览 dev server exit 127 的根因、2026-07-16）；
  //    合并是去重保序、不会把已注入的 tools/bin 丢掉
  void import("./lib/server/feishu-cli").then((m) => m.injectFeishuCliPath());
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

  // 收件箱二期：出厂预置「改bug」custom action + skill（各记一次、删过不重装）
  void import("./lib/server/preset-actions")
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

  // 飞书 chat 桥接出向：全局 tap 订阅 task-stream（幂等、开关关闭时事件内 no-op）
  void import("./lib/server/feishu-bridge/outbound")
    .then((m) => m.ensureFeishuOutboundRegistered())
    .catch((err) => {
      console.warn(
        "[instrumentation] 飞书桥接 outbound 注册失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });

  // 飞书 chat 桥接入向：event consume + keep-awake（30s 轮询、globalThis 幂等）
  void import("./lib/server/feishu-bridge/inbound")
    .then((m) => m.ensureBridgeRuntimePolling())
    .catch((err) => {
      console.warn(
        "[instrumentation] 飞书桥接 inbound runtime 启动失败（不阻断启动）:",
        err instanceof Error ? err.message : err,
      );
    });
};
