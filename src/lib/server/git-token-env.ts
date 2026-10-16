/**
 * GitLab PAT 的环境变量通道（S03-04 根治）
 *
 * 背景：以前「GitLab 访问」提示让 agent 自己用 jq 去读数据目录里 config.json 的 gitToken 字段取 token——
 *   1. agent 得去打开含 apiKey / 公司环境密码的 config.json；
 *   2. token 一旦出现在命令文本 / 命令输出里，就进了模型上下文和 Cursor SDK 自己的会话存储
 *      （SDK 存储我们脱敏不到；事件落盘的精确值脱敏只管 events.jsonl，见 event-secret-redact.ts）。
 *
 * 现在：server 把 token 放进自己的 `process.env.FLOWSHIP_GITLAB_TOKEN`，agent 的命令里只写
 * `"$FLOWSHIP_GITLAB_TOKEN"`——token 值不进命令文本、不用打开 config.json（只是这两点；不是「agent 拿不到」，见下方取舍）。
 * 为什么放 process.env 就够用：
 *   - Cursor provider 的本地 agent shell 由 SDK 拉起，**原样继承** server 的整份 process.env（AGENTS.md 已实测）；
 *   - pi provider 的 shell 工具用 `stripHostInjectedEnv()`，只剔 `HOST_INJECTED_ENV_KEYS` 黑名单——
 *     本变量**不在**黑名单里（host-env.ts 有注释 + 单测钉住），所以也能继承到。
 *
 * 取舍 / 局限（别误以为这是「agent 拿不到 token」）：
 *   - agent 仍然能读到这个变量（echo / printenv / 把它塞进 curl 发给任意地址）——产品口径本来就是
 *     「本地单机、接受 token 进 agent shell」；本模块只解决「不用读 config.json」与「token 不进命令文本」。
 *     真正防外发的是服务端侧的可信 host 绑定（trusted-git-host.ts），它只管 server 自己发的请求。
 *   - process.env 是进程级全局：所有 task / chat 共用同一个值（本来就是同一个 settings.gitToken）。
 *     子进程（lark-cli、meegle…）若原样继承 env 也会看到它（MCP stdio 走 SDK 默认的白名单 env、不继承）。
 *   - **无身份会话也看得到它（N3-01）**：需求群的「非属主答疑旁路」（restricted-question.ts）是工具全开的
 *     honor-system agent（不传 callerToken），群里任何能 @ 机器人的人让它 `printenv` 就能拿到 PAT。
 *     收口情况按 provider 不同：
 *       - pi provider：旁路显式传 `omitGitToken: true`（agent-backend → custom-agent-backend → pi-coding-tools），
 *         shell 工具与 `task` 子代理的 bash 都用摘掉本变量的 env（见 stripGitTokenEnv）——
 *         **只摘环境变量、不阻止读文件**：pi 的 `read` / shell 照样能读 config.json 里的 gitToken（M1-02）；
 *       - **Cursor provider：摘不掉**——本地 agent 的 shell 由 SDK 拉起、原样继承 server 的 process.env，
 *         SDK（1.0.37）没有给本地 agent 的 env 选项；而 process.env 是进程全局，临时删它会把属主并行会话也弄坏。
 *         所以 Cursor 路径的无身份旁路**会继承这个变量**、`printenv` 仍能拿到 PAT——这条无身份通道沿用上面的局限。
 *         **已拍板不采用 `disallowedTools` / `local.customTools` 换掉内置 shell**：理由是 Cursor 的 `read`
 *         同样能读 config.json，换 shell 并没有形成真边界；而替换内置 shell 会影响工具块展示、有回归风险，得不偿失。
 *     旁路本来就能读 config.json（含 PAT / apiKey / 公司环境密码）、~/.ssh 等属主 OS 用户能读的一切——
 *     环境变量只是最显眼的一条路，不是唯一一条；所以旁路只适合只有可信同事的内部群。
 *     属主自己的无身份通道（startOneShotQuestion，无 callerToken 但是全权限属主通道）不传该标记、照常继承。
 *   - 无 token 时必须 delete（不是留空串）：空串变量会让 `[ -n "$FLOWSHIP_GITLAB_TOKEN" ]` 之类判断误判「已配置」。
 */

import type { SettingsReadResult } from "./settings-fs";

/** agent shell 里引用 token 的环境变量名（prompt 文案 / 测试 / 脱敏注释都引这一个常量） */
export const GITLAB_TOKEN_ENV_NAME = "FLOWSHIP_GITLAB_TOKEN";

/**
 * 把 token 同步进 server 的 process.env。
 * trim 后非空 → 写入；空串 / 纯空白 / 非字符串 / undefined → 删除。
 * 同步函数：调用点在 Agent.create / resume 之前，不能引入新的 await 窗口。
 * 日志只记「有 / 无」，绝不打印值。
 */
export const syncGitTokenEnv = (token: unknown): void => {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (trimmed) {
    process.env[GITLAB_TOKEN_ENV_NAME] = trimmed;
  } else {
    delete process.env[GITLAB_TOKEN_ENV_NAME];
  }
};

/**
 * 返回摘掉 GitLab token 变量的 env 浅拷贝（不改入参、不碰 process.env）。
 * 给「手里不该有 GitLab 凭证」的 pi 会话（旁路答疑）的 shell / 子代理 bash 用。
 * 只摘环境变量、不阻止读文件（config.json 里的 gitToken 照样读得到，见头部）。
 * 变量名按大小写不敏感摘：Windows 的 env 名不区分大小写，`{ ...process.env }` 之后的普通对象却区分，
 * 只 delete 精确名可能漏掉大小写不同的同名变量。
 */
export const stripGitTokenEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const target = GITLAB_TOKEN_ENV_NAME.toUpperCase();
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (key.toUpperCase() === target) delete cleaned[key];
  }
  return cleaned;
};

/**
 * 按 settings 读取结果同步 env（启动 / 聊天会话启动 / 设置保存共用）：
 *   - ok：以盘上 gitToken 为准；
 *   - missing（首次安装、没有 config.json）：确定没有 token → 清掉；
 *   - error（损坏 / 权限等瞬时读失败）：**不动 env**——读不到不等于用户清空了 token，
 *     此时清掉会让正在跑的会话下一条命令莫名拿不到凭据。
 */
export const syncGitTokenEnvFromSettingsResult = (
  result: SettingsReadResult,
): void => {
  if (result.status === "error") return;
  syncGitTokenEnv(
    result.status === "ok" ? result.settings.gitToken : undefined,
  );
};
