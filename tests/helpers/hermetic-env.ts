/**
 * 测试进程的环境隔离（vitest setupFiles 用，见 tests/setup/hermetic-env.ts）
 *
 * 背景（2026-10-09 事故）：Cursor provider 的 agent shell 由 SDK 自己 spawn、环境原样继承
 * server 进程，于是 agent 在 Flowship 仓库里跑 vitest 时带着 `FLOWSHIP_DATA_DIR=<正式数据目录>`。
 * 而 `task-fs-core` 在**模块加载时**就用 `dataRoot()` 钉死 `DATA_DIR`，任何没自己改 env 的测试
 * 一 import task-fs、调用任一 API，就会触发惰性的 boot-recovery——把正式数据里所有 running 的聊天
 * 标成「已中断」、清 worktree、杀预览进程、GC SDK store。
 *
 * 所以隔离必须发生在测试文件 import 之前：
 *   1. 剔除宿主注入变量（FLOWSHIP_DATA_DIR / PORT / HOSTNAME / ELECTRON_RUN_AS_NODE …，
 *      与 agent shell 清洗用的同一份黑名单 HOST_INJECTED_ENV_KEYS）——测试结果不该取决于
 *      「谁启动了我」；
 *   2. FLOWSHIP_DATA_DIR 一律指向全新的临时目录（缺省回落的 `cwd/data` 也是个共享可变目录，
 *      同样不该让测试写）。需要自己数据目录的测试照旧在 import 前改 env，覆盖即可；
 *   3. git 配置隔离成空白（见下方 applyHermeticGitEnv）——真 git 测试不该取决于开发者本机的全局配置。
 */
import os from "node:os";

import { isAppUserDataPath } from "../../src/lib/server/app-data-dir";
import { GITLAB_TOKEN_ENV_NAME } from "../../src/lib/server/git-token-env";
import { HOST_INJECTED_ENV_KEYS } from "../../src/lib/server/host-env";

/**
 * 只读写 env 子集：`NodeJS.ProcessEnv` 在 Next 的类型补丁下把 NODE_ENV 变成必填键，
 * 单测传个 `{ FLOWSHIP_DATA_DIR: … }` 这样的普通对象会过不了 tsc。`process.env` 本身可直接赋给它。
 */
export type EnvBag = Record<string, string | undefined>;

/**
 * 真 git 测试的环境隔离（2026-10-20 review）：
 * 测试里大量 `git init` / `git commit` 的临时仓会继承开发者本机的全局 / 系统 git 配置——
 * 本机开了 `commit.gpgsign=true`（签名程序不可用 / 要交互）时，`git commit -m init` 当场失败，
 * 整个 chat-checkpoint 套件连一条用例都跑不起来（实测：全局配 gpgsign + 失败的 gpg.program，
 * 套件在 beforeAll 的 initRepo 就红）；全局 `core.excludesfile` / `commit.template` 之类还会悄悄改变
 * 快照、提交的结果，让同一条用例在不同机器上结论不同。
 * 所以让测试进程里所有 git 子进程看到同一份「空白」配置：
 *   - GIT_CONFIG_GLOBAL → os.devNull：不读 ~/.gitconfig 与 $XDG_CONFIG_HOME/git/config（git ≥ 2.32，
 *     更老的 git 会忽略这个变量、退化成没隔离但不会报错；用 os.devNull 让 mac / linux / win 同写法）；
 *   - GIT_CONFIG_NOSYSTEM=1：不读系统级配置（含 credential.helper 之类）；
 *   - GIT_TERMINAL_PROMPT=0：凭据 / 主机确认不许弹交互提示（会把测试挂住）。
 * 全局配置去掉后 git 没有提交身份了（Linux CI / 没配全局身份的机器上 `git commit` 会报
 * 「Please tell me who you are」），用环境变量兜底——与 .github/workflows/ci.yml 同一思路。
 * ⚠️ 环境变量优先于仓内 `git config user.name` 和命令行 `-c user.name=…`，所以测试里**不要断言提交作者**
 * （被测代码给 WIP 快照等 commit 配的 `flowship` 身份在测试进程里会被这里的值盖掉）。
 */
export const HERMETIC_GIT_IDENTITY = {
  name: "flowship-test",
  email: "flowship-test@example.invalid",
} as const;

/** 就地改写 env：把 git 配置隔离成空白，并给一个兜底提交身份（原因见上方注释）。 */
export const applyHermeticGitEnv = (env: EnvBag): void => {
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_AUTHOR_NAME = HERMETIC_GIT_IDENTITY.name;
  env.GIT_AUTHOR_EMAIL = HERMETIC_GIT_IDENTITY.email;
  env.GIT_COMMITTER_NAME = HERMETIC_GIT_IDENTITY.name;
  env.GIT_COMMITTER_EMAIL = HERMETIC_GIT_IDENTITY.email;
};

export interface HermeticEnvResult {
  /** 本进程这一份新建的临时数据目录 */
  dataDir: string;
  /** 进来时继承到的 FLOWSHIP_DATA_DIR（没有则 undefined） */
  inheritedDataDir: string | undefined;
  /** 继承到的是不是桌面包的数据目录（= 这次隔离确实挡住了一次事故） */
  inheritedAppData: boolean;
  /** 被剔除的宿主注入变量名 */
  stripped: string[];
}

/** 就地改写 env：剔除宿主注入变量，FLOWSHIP_DATA_DIR 指向 makeTempDir() 新建的目录。 */
export const applyHermeticEnv = (
  env: EnvBag,
  makeTempDir: () => string,
): HermeticEnvResult => {
  const inheritedDataDir = env.FLOWSHIP_DATA_DIR || undefined;
  const stripped = HOST_INJECTED_ENV_KEYS.filter((k) => env[k] !== undefined);
  for (const key of HOST_INJECTED_ENV_KEYS) delete env[key];
  // GitLab token 环境变量：agent shell 里跑 vitest 会继承到 server 注入的真实 PAT（git-token-env.ts）。
  // 它不算宿主注入变量（不进 HOST_INJECTED_ENV_KEYS、不计入 stripped），但测试进程里不该带着真 token：
  // 否则「没配 token → env 应为空」这类断言取决于谁启动了我，真 token 也可能被测试输出带出去。
  delete env[GITLAB_TOKEN_ENV_NAME];
  applyHermeticGitEnv(env);
  const dataDir = makeTempDir();
  env.FLOWSHIP_DATA_DIR = dataDir;
  return {
    dataDir,
    inheritedDataDir,
    inheritedAppData: isAppUserDataPath(inheritedDataDir),
    stripped: [...stripped],
  };
};

/**
 * 每个测试开始前检查：此刻的 FLOWSHIP_DATA_DIR 指向桌面包数据目录就直接抛错。
 * 兜的是「某个测试 / 模块显式把它写成了真实目录」——隔离只管得住继承来的值。
 */
export const assertEnvNotAppData = (env: EnvBag): void => {
  const dir = env.FLOWSHIP_DATA_DIR;
  if (!isAppUserDataPath(dir)) return;
  throw new Error(
    `[hermetic-env] 测试期间 FLOWSHIP_DATA_DIR 指向了桌面包的数据目录（${dir}）——` +
      "这里是用户的真实聊天 / 任务数据，测试一律不许碰。请改用 mkdtemp 出来的临时目录。",
  );
};
