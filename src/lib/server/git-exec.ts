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
 * 交给 git 子进程的 env：剔宿主注入变量 + 剔 GitLab PAT + 不等人输入，再叠 `extra`（如 WIP 快照用的 `GIT_INDEX_FILE`）。
 *
 * - 不改 process.env、不改入参；
 * - `extra` 叠在最后（调用方可以显式覆盖 prompt 守卫），但 PAT 无论从哪来都在最外层再剔一遍——
 *   出口契约是「这份 env 里没有 PAT」，不依赖调用方自觉；
 * - PAT 变量名按大小写不敏感剔（Windows 的 env 名不区分大小写，见 `stripGitTokenEnv`）。
 */
export function gitEnv(
  extra?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return stripGitTokenEnv({
    ...stripHostInjectedEnv(),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    ...(extra ?? {}),
  });
}
