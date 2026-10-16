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
 *      同样不该让测试写）。需要自己数据目录的测试照旧在 import 前改 env，覆盖即可。
 */
import { isAppUserDataPath } from "../../src/lib/server/app-data-dir";
import { GITLAB_TOKEN_ENV_NAME } from "../../src/lib/server/git-token-env";
import { HOST_INJECTED_ENV_KEYS } from "../../src/lib/server/host-env";

/**
 * 只读写 env 子集：`NodeJS.ProcessEnv` 在 Next 的类型补丁下把 NODE_ENV 变成必填键，
 * 单测传个 `{ FLOWSHIP_DATA_DIR: … }` 这样的普通对象会过不了 tsc。`process.env` 本身可直接赋给它。
 */
export type EnvBag = Record<string, string | undefined>;

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
