/**
 * git 子进程的执行环境与容量上限（R14 B5-1：Q10-04 / Q10-07 / Q10-02 收口）
 *
 * 背景：「怎么拉起一个 git 子进程」在仓库里有好几种 env 口径，修了一份漏另几份——
 *   · `task-worktrees.runGit`：剔宿主注入变量，没有 prompt 守卫，**不剔 GitLab PAT**（注释写「fetch 之类的 git 网络命令要靠它认证」）；
 *   · `git-branches.fetchRemoteRefs`：整份 `process.env` + `GIT_TERMINAL_PROMPT=0`（连宿主注入变量都没剔）；
 *   · `git-branches.checkoutGitBranch`：剔宿主注入变量，没有 prompt 守卫；
 *   · `testing-task-branches.execGit`：剔宿主注入变量 + prompt 守卫，**不剔 PAT**；
 *   · `wk-source-branch`：什么 env 都不传（整份继承），其中 `ls-remote` 还会联网。
 * 这里收成一个 {@link gitEnv}。
 *
 * 规则一：**GitLab PAT 不交给 git 子进程**（Q10-04）。
 *   `worktree add` / `checkout` 会触发用户仓的 post-checkout 等钩子（husky 里常有 `pnpm install` / node 脚本），
 *   `fetch` 会触发 reference-transaction 钩子——钩子整份继承 env 就拿得到 `FLOWSHIP_GITLAB_TOKEN`。
 *   原注释的理由（「git 网络命令要靠它认证」）不成立：git 本身不读这个变量——
 *   Flowship 自己调 GitLab API 走 `fetchWithGitToken`（可信 host 绑定）；团队库的 git 网络操作走 inline credential helper，
 *   token 在它自己的 `TL_GIT_TOKEN` 里（team-library.ts 的 buildAuthedGitArgs）；用户机器上的 git 凭据（keychain / GCM / ssh）原样可用。
 *   同口径的 `worktree-deps.runSetupCommand`、`preview-manager.buildPreviewEnv` 早就剔了它。
 *   取舍：agent shell 里有 PAT 是有意取舍（见 git-token-env.ts 头注释），钩子这条路没有这个需求；
 *   若真有人靠自己配的 credential helper 读该变量，应当加显式设置项、而不是默认暴露——本批没做，登记在 HANDOFF。
 *
 * 规则二：**永不等人输入**（Q10-07）。
 *   `GIT_TERMINAL_PROMPT=0`：没有凭据时立即失败。打包后的 App 没有控制终端、本来就不会阻塞，
 *   但 `pnpm dev:web` / 从终端拉起的壳有——git 会停在 `Username for …`，把 30s × N 的 fetch 卡满。
 *   `GCM_INTERACTIVE=never`：Git Credential Manager（Windows 默认自带）不弹窗——弹窗在 git 被杀后还会留在屏幕上。
 *   不按平台判断、一律设置：没有 GCM 的机器上这个变量没有副作用，少一个分支也就少一个只在 Windows 上才暴露的缺口。
 *   注意测试环境（tests/helpers/hermetic-env.ts）全局设了 `GIT_TERMINAL_PROMPT=0`，所以光看既有集成测试发现不了缺口——
 *   `tests/git-hook-env.test.ts` 在 `delete process.env.GIT_TERMINAL_PROMPT` 之后用真钩子验证。
 *
 * 容量：`GIT_MAX_BUFFER` 原来在 task-worktrees.ts，下沉到这里让 git-branches / wk-source-branch 共用
 * （Q10-02：Node execFile 默认 maxBuffer 只有 1MiB，远端 refs 过万就整体判成「非 git 仓」）；task-worktrees.ts 继续 re-export 原名。
 */
import { stripGitTokenEnv } from "./git-token-env";
import { stripHostInjectedEnv } from "./host-env";

/**
 * git 子进程 stdout / stderr 的容量上限（256MiB，只在真有输出时才占内存）。
 * 见 task-worktrees.runGit 里的注释：`status --porcelain=v2 -z --untracked-files=all` 数万文件轻松超 4MiB；
 * 列分支的 `for-each-ref`、`ls-remote --heads` 同理（约 1.2 万条远端 ref 就超 Node 默认的 1MiB）。
 */
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Windows 深路径：git for Windows 默认 `core.longpaths=false`，路径超过 260 字符时 `git worktree add` /
 * `git clone` 会报 `Filename too long`。Flowship 的 worktree 落在 `<userData>/worktrees/<taskId>/<repo>/…`，
 * 仓库自身再有几层目录（monorepo / node_modules 之外的深层源码）很容易越线。
 *
 * 只在 win32 给**这一次** git 调用加 `-c core.longpaths=true`——不写仓库 / 全局 git 配置（不改用户的环境），
 * 非 Windows 一律不加（那里没有这个限制，少一个参数也就少一个差异）。纯函数、平台可注入，方便测两个分支。
 * 注意是放在子命令之前（`git -c k=v worktree add …`），所以只用于「入参本身就是完整子命令参数」的调用点。
 */
export const gitLongPathsConfigArgs = (
  platform: NodeJS.Platform = process.platform,
): string[] => (platform === "win32" ? ["-c", "core.longpaths=true"] : []);

/** 在 git 参数前面按平台补 `-c core.longpaths=true`（非 Windows 原样返回同一份内容的新数组）。 */
export const withGitLongPaths = (
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] => [...gitLongPathsConfigArgs(platform), ...args];

/**
 * 读「当前分支」的 git 参数：`rev-parse --symbolic-full-name HEAD`。
 *
 * 为什么不是 `rev-parse --abbrev-ref HEAD`：分支 `foo` 与标签 `foo` 并存时它输出 `heads/foo`（git 为消歧义缩短 ref），
 * 调用方按名字比对（占用检查排除自己的分支、`b === current` 豁免、`branch === baseName`）全部对不上。
 * 也不是 `symbolic-ref --short`：它同样会缩成 `heads/foo`（实测）。完整 ref 去掉 `refs/heads/` 才是精确名。
 *
 * 失败语义与旧版逐项一致（调用方依赖它）：
 * - unborn（空仓、HEAD 指向还没有提交的分支）：命令失败（退出码 128）；
 * - detached HEAD：成功，输出字面量 `HEAD`；
 * - 非 git 目录 / spawn 失败：命令失败。
 * 用 `symbolic-ref` 反而会让 unborn 「成功返回 main」、需要再多 spawn 一次验证分支是否存在，行为也得另外补齐。
 */
export const CURRENT_BRANCH_ARGS: readonly string[] = ["rev-parse", "--symbolic-full-name", "HEAD"];

/**
 * 解析 {@link CURRENT_BRANCH_ARGS} 的 stdout：`refs/heads/<名>` → 精确分支名；
 * detached（`HEAD`）/ 空 / 不是 `refs/heads/` 下的 ref → null。纯函数。
 */
export const parseCurrentBranchOutput = (stdout: string): string | null => {
  const ref = stdout.trim();
  const PREFIX = "refs/heads/";
  return ref.startsWith(PREFIX) && ref.length > PREFIX.length ? ref.slice(PREFIX.length) : null;
};

/**
 * win32 下用环境变量给 git 子进程统一补 `core.longpaths=true`（`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`，git ≥ 2.31；
 * 更老的 git 会直接忽略这组变量、等于没加，不会报错）。
 *
 * 为什么放 env 而不是只靠 {@link withGitLongPaths} 的 `-c`：深路径问题不只出在 `worktree add` / `clone`——
 * `reset --hard` / `clean -fd` / `add -A` / `worktree remove` / `checkout` 碰到超长文件名一样 `Filename too long`。
 * 这些调用点都已经走 {@link gitEnv}，在这一处注入就一次覆盖全部，不用逐个改命令行参数。
 *
 * 规则：
 * - 非 win32 原样返回（同一个对象、一个字都不加）；
 * - **不覆盖调用方 / 宿主已经设置的 `GIT_CONFIG_*`**：已有 `GIT_CONFIG_COUNT=n` 时追加到下标 n、COUNT 改成 n+1，原有 0..n-1 号条目一概不动；
 * - 调用方 / 宿主已经显式配了 `core.longpaths`（不论值）→ 尊重、不再追加；
 * - 已有的 `GIT_CONFIG_COUNT` 不是非负整数（git 自己会报 `bogus count`）→ 原样返回，不在一份坏配置上叠加；
 * - env 名按大小写不敏感查（Windows 环境变量不区分大小写，`{...process.env}` 展开后可能保留原始大小写）。
 * 纯函数、不改入参、平台可注入（mac 上也能测 win32 分支）。
 */
export function withGitLongPathsEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const find = (name: string): string | undefined =>
    Object.keys(env).find((k) => k.toUpperCase() === name);
  const countKey = find("GIT_CONFIG_COUNT");
  const rawCount = countKey === undefined ? undefined : env[countKey];
  let n = 0;
  if (rawCount !== undefined) {
    if (!/^\d+$/.test(rawCount.trim())) return env;
    n = Number.parseInt(rawCount.trim(), 10);
  }
  for (let i = 0; i < Math.min(n, 1000); i++) {
    const keyName = find(`GIT_CONFIG_KEY_${i}`);
    if (keyName !== undefined && env[keyName]?.trim().toLowerCase() === "core.longpaths") return env;
  }
  const out: NodeJS.ProcessEnv = { ...env };
  if (countKey !== undefined) delete out[countKey]; // 名字大小写不同时避免留下两个 COUNT
  out.GIT_CONFIG_COUNT = String(n + 1);
  out[`GIT_CONFIG_KEY_${n}`] = "core.longpaths";
  out[`GIT_CONFIG_VALUE_${n}`] = "true";
  return out;
}

/**
 * 交给 git 子进程的 env：剔宿主注入变量 + 剔 GitLab PAT + 不等人输入，再叠 `extra`（如 WIP 快照用的 `GIT_INDEX_FILE`）。
 *
 * - 不改 process.env、不改入参；
 * - `extra` 叠在最后（调用方可以显式覆盖 prompt 守卫），但 PAT 无论从哪来都在最外层再剔一遍——
 *   出口契约是「这份 env 里没有 PAT」，不依赖调用方自觉；
 * - PAT 变量名按大小写不敏感剔（Windows 的 env 名不区分大小写，见 `stripGitTokenEnv`）；
 * - win32 下统一补 `core.longpaths=true`（见 {@link withGitLongPathsEnv}，不覆盖已有 `GIT_CONFIG_*`）；`platform` 仅为单测注入。
 */
export function gitEnv(
  extra?: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return stripGitTokenEnv(
    withGitLongPathsEnv(
      {
        ...stripHostInjectedEnv(),
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        ...(extra ?? {}),
      },
      platform,
    ),
  );
}
