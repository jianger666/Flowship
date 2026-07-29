/**
 * 团队 wk-harness 规范的**门禁执行**（Flowship 侧强制调，不靠 agent 自觉）
 *
 * # 为什么由我们调
 *
 * 规范定义了六类门禁，其中 `hook guard` 要 Cursor 的 hooks 机制；而我们起 SDK agent 时传
 * `settingSources: []`（为修 MCP 泄漏），hooks 完全不加载。于是走规范自己给的降级条款
 * （`references/command-contract.md:12` fallback preflight）：
 *
 * > hook 未启用或平台无法接入 hook 时，仍执行同一 command preflight。返回非 0 时必须停止，
 * > 不允许继续生成后续阶段产物、推进状态或修改业务代码。
 *
 * 有 hook 时六类里只有 hook guard 是平台强制的、其余五类靠 agent 自觉；改成流程节点强制调
 * 之后，那五类反而更可靠。
 *
 * # 挂在哪三个点（只对 wk 系 action 生效，普通 action / chat 完全不碰）
 *
 * | 时机 | 调什么 | 失败怎么办 |
 * |---|---|---|
 * | 推进前（task-runner.advanceTaskCore 准入之后、appendAction 之前） | `wk-context-init.py` | 只 warn（它自己对「业务级 status.yaml 还没有」返 1 = 跳过语义）；脚本不在这版团队库里则整步跳过 |
 * | 紧接着 | `doc-quality-gate.py --command wk:xxx` | **打出 FAIL 结论 = 硬拦**：不 append action、不起 agent、错误进事件流 |
 * | action 收尾（runActionCheck → 本模块 runWkPostStage） | `doc-quality-gate.py --stage <stage>` | 同上 → postCheck.passed=false（UI 红条） |
 * | 门禁过后 | `wk-delivery-sync.py` | 只 warn（没配 hub 时压根不调） |
 *
 * `wk-state.py transition` **仍由 agent 调**——它要带只有 agent 才知道的 reason /
 * target-status，我们不抢。
 *
 * # 降级原则
 *
 * 只有「preflight 打出结构化 FAIL 结论」才是有意的硬拦；其余一切异常（没配 doc_repo /
 * 没装 python3 / 团队库没同步到脚本 / 文档仓里没有该 REQ-ID 目录 / 脚本超时 /
 * **门禁脚本自己崩了**）都降级成事件流里一条可读提示，绝不阻塞主流程——
 * 门禁是质量闸门、不是可用性依赖，工具自身故障不该把用户的推进挡死。
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveReqId } from "@/lib/req-id";
import {
  wkCommandForAction,
  wkNeedsBizPath,
  wkNeedsRepoPath,
  wkScopeOf,
  wkStageOf,
  type WkCommand,
} from "@/lib/wk-command";
import { isWkTruthy, type WkConfig } from "@/lib/wk-config";
import { formatWkGateFailure, parseWkGateOutput } from "@/lib/wk-gate-output";
import type { ActionRecord, CustomActionDef, Task } from "@/lib/types";

import { getCustomAction } from "./custom-action-fs";
import {
  getTaskWorkRepoPaths,
  type WorktreeTaskLike,
} from "./task-worktrees";
import { getTeamLibraryKnowledgeSkillsDir } from "./team-library-paths";
import { readWkConfig } from "./wk-config";

/** python 解释器（允许用户机器上换路径；默认吃 PATH 里的 python3） */
const pythonBin = (): string => process.env.FLOWSHIP_PYTHON?.trim() || "python3";

/**
 * 单次脚本超时，按「这条命令会不会走网络」分三档。
 *
 * ① **纯本地校验** 10s：`doc-quality-gate.py --stage`（`main` 的 stage 分支在读
 *    delivery 配置之前就 return 了、**保证不联网**）、`wk-context-init.py`（写两个 json +
 *    两条 `git config/branch`）、以及没开 baseline 的 preflight。全是 fs 读写、正常几百 ms。
 *
 * ② **preflight 且会去 Hub 拉 baseline** 45s：`doc-quality-gate.py --command` 此时会
 *    `subprocess.run` 起 `wk-delivery-baseline.py --pull`（第二个 python 冷启动），对
 *    `COMMAND_BASELINE_PATHS[command]` 里每个产物的每个候选 stage 各发一次
 *    `artifact-state` GET —— `wk:repo-execute` 约 37 次、`wk:biz-verify` 约 50 次，串行、
 *    每次自带脚本级 15s 超时，命中新版本还要再下载文件。健康局域网 hub 合计 1~5s、
 *    慢 hub（0.5s/次）约 25s，都在 45s 内；hub 黑洞掉包时每个产物卡满 15s
 *    （biz-verify 16 个产物 = 240s），45s 把这种等待封在 3 次脚本级超时以内。
 *    ⚠️ 上一轮按「纯本地」给 10s 是漏算了这一跳——正常的拉取会被拦腰砍断。
 *
 * ③ **Hub 同步** 30s：`wk-delivery-sync.py` 对 `STAGE_FILES[stage]` 逐个上传
 *    （`biz-analyze` 9 个）再 POST 一次 manifest = 最多 10 次串行请求、同样各自 15s。
 *    旧的 20s 是按「一次请求 + 5s 余量」算的、同样漏了请求条数。
 *
 * ⚠️ 别再往回放宽：后置门禁挂在「action 从 running 翻 awaiting_ack」的必经路径上，
 * 阶段门禁 + Hub 同步串行——hub 挂死时用户要盯着「运行中」干等这两个数之和
 * （10+30=40s；更早是 20+40=60s）。要再降就得把 Hub 同步改成不阻塞状态翻转。
 */
const LOCAL_TIMEOUT_MS = 10_000;
const BASELINE_PULL_TIMEOUT_MS = 45_000;
const DELIVERY_SYNC_TIMEOUT_MS = 30_000;

/** 单次输出上限：门禁明细最多几十行，1MB 足够且防脚本失控刷屏打爆内存 */
const OUTPUT_MAX_BUFFER = 1024 * 1024;

// ----------------- 脚本执行底座 -----------------

/** unavailable 的细分：起不动解释器 vs 脚本压根不在盘上（两种降级文案不一样） */
export type WkScriptUnavailableReason = "no-python" | "no-script";

export interface WkScriptResult {
  /** ok=退出 0；failed=退出非 0；unavailable=跑不起来（没装 python3 / 脚本不在盘上）；timeout=超时被杀 */
  outcome: "ok" | "failed" | "unavailable" | "timeout";
  /** stdout + stderr 合并（脚本 PASS/FAIL 走 stdout、python 报错走 stderr） */
  output: string;
  exitCode: number | null;
  /** 仅 outcome=unavailable 时有值 */
  reason?: WkScriptUnavailableReason;
}

/**
 * python 找不到脚本文件的形态：退 2 + stderr「python3: can't open file '…': [Errno 2] …」。
 *
 * 必须跟「门禁真的没过」分开：团队库版本差异（如 `wk-context-init.py` 是 2026-07-27
 * 才加的）会让某个脚本缺席，归成 failed 的话事件流每次推进都刷一条假告警。
 *
 * 只认解释器那句 `can't open file`（不认宽泛的 `No such file or directory`）——
 * 后者可能出现在门禁自己打的明细里，误判会把「preflight 硬拦」降级放行。
 */
const looksLikeMissingScript = (exitCode: number, output: string): boolean =>
  exitCode === 2 && /can't open file/i.test(output);

/**
 * 超时到点时**连同子孙进程一起收走**。
 *
 * 为什么不能只杀直接子进程：`doc-quality-gate.py` 自己会 `subprocess.run` 起
 * `wk-delivery-baseline.py`——只杀父 python 的话，孙子进程照样在跑（继续往 hub 发请求、
 * 往产物目录写 `.baseline` 文件），而且它攥着继承来的 stdout 管道不放：管道不 close、
 * `close` 事件就不触发，外层这个 await 会一直挂着，超时形同虚设。
 *
 * `detached: true`（spawn 时给）让子进程自成进程组，`kill(-pid)` 才能整组带走。
 * ⚠️ 这也是这里不用 `execFile` 的原因：它压根不把 `detached` 透传给 spawn
 * （Node 只转 cwd/env/uid/gid/shell/signal/windowsHide 几项），子进程留在我们自己的
 * 进程组里，`kill(-pid)` 要么打空要么打到不该打的东西。
 *
 * 跟 `preview-manager` 那个同名函数不共用是因为策略不同：那边杀的是 dev server、
 * 要先 SIGTERM 留 2s 优雅退出窗口（释放端口）；这里的进程已经超了预算、直接 KILL。
 */
const killProcessGroup = (child: ChildProcess): void => {
  const { pid } = child;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Windows 没有负号进程组语义、`kill(-pid)` 直接抛——`taskkill /T` 才连子孙一起收
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 组不存在（进程已自己退出 / setsid 还没生效）→ 兜底拍一次直接子进程
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经没了 */
    }
  }
};

/**
 * 跑一个 wk 脚本。**永不抛**——任何异常都归一成 outcome，调用方按降级策略处理。
 *
 * 注意 `doc-quality-gate.py` / `wk-delivery-sync.py` 内部 `from gates.runner import ...`，
 * 依赖「脚本自身目录进 sys.path」——直接 `python3 <绝对路径>` 就满足（sys.path[0] = 脚本目录），
 * 不需要设 PYTHONPATH。
 *
 * export 是给单测直接压超时用的（三个挂钩点的预算都是 10s 起、走上层跑不动这条路径）。
 */
export const runWkScript = async (
  scriptAbsPath: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<WkScriptResult> =>
  new Promise((resolve) => {
    // stdout / stderr 按到达顺序攒一坨（脚本 PASS/FAIL 走 stdout、python 报错走 stderr）
    let output = "";
    // 非 null = 是我们主动掐的：超时到点 / 输出超限，两者对外都归成 timeout
    let aborted: "timeout" | "overflow" | null = null;
    let settled = false;

    const child = spawn(pythonBin(), [scriptAbsPath, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      // 自成进程组：超时才能连它 spawn 的 python 孙子进程一起收走（见 killProcessGroup）
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => {
      aborted = "timeout";
      killProcessGroup(child);
    }, opts.timeoutMs);

    // error 之后可能再来一发 close——只认第一次
    const settle = (result: WkScriptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const collect = (chunk: unknown): void => {
      if (aborted) return;
      output += String(chunk);
      // 失控脚本刷屏会打爆内存：攒到上限就截断 + 掐掉进程（旧 execFile maxBuffer 的语义）
      if (output.length > OUTPUT_MAX_BUFFER) {
        output = output.slice(0, OUTPUT_MAX_BUFFER);
        aborted = "overflow";
        killProcessGroup(child);
      }
    };
    // 按 utf8 解码再交给 collect：裸 Buffer 逐块 String() 会把跨块的中文字符切碎
    // （门禁明细里带的是文档仓绝对路径、用户目录名可能是中文）
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    // spawn 起不来（没装 python3 / 没权限）——这条路径不会再有 close
    child.on("error", (err) => {
      settle({
        outcome: "unavailable",
        output: output || err.message,
        exitCode: null,
        reason: "no-python",
      });
    });

    child.on("close", (code) => {
      if (aborted) {
        settle({ outcome: "timeout", output, exitCode: null });
        return;
      }
      if (code === 0) {
        settle({ outcome: "ok", output, exitCode: 0 });
        return;
      }
      // 被信号打死时 code 为 null（不是我们干的、当失败处理）
      const exitCode = code ?? 1;
      // 脚本不在盘上（团队库版本差异 / 探测后被删的竞态）不是「门禁未过」
      if (looksLikeMissingScript(exitCode, output)) {
        settle({
          outcome: "unavailable",
          output,
          exitCode,
          reason: "no-script",
        });
        return;
      }
      settle({ outcome: "failed", output, exitCode });
    });
  });

/**
 * 非 0 退出到底是「门禁没过」还是「门禁工具自己坏了」。
 *
 * 官方脚本每条非 0 返回前都先打一行 `FAIL: …`、明细走 `- ` 行；而脚本崩了
 * （python traceback）、参数不认（argparse 的 `usage: … error: …`，多半是脚本换了签名
 * 或我们拼错）都没有这个结构。所以「输出没有门禁结构」= 工具自身故障。
 *
 * ⚠️ 别再退回「只认解释器那句 can't open file」：那条只覆盖「脚本文件不在盘上」，
 * 崩溃 / 参数不认照样落进 failed → 硬拦，等于门禁工具坏了却把用户的推进挡死。
 */
const looksLikeToolSelfFailure = (result: WkScriptResult): boolean =>
  !parseWkGateOutput(result.output).structured;

// ----------------- 门禁计划（跑不跑 / 拿什么参数跑） -----------------

/** 不跑门禁的原因——除 not-wk 外都会在事件流留一条可读提示 */
export type WkGateSkipReason =
  | "not-wk"
  | "no-req-id"
  | "no-doc-repo"
  | "no-repo"
  | "no-scripts"
  | "no-req-dir";

export interface WkGatePlanActive {
  applies: true;
  command: WkCommand;
  /** 后置门禁的 stage 名（`wk:repo-design` → `repo-design`） */
  stage: string;
  /** 用户手填的 REQ-ID（没填的话压根走不到 active、见 no-req-id 降级） */
  reqId: string;
  /** 文档仓根目录（`~/.wk/config.yaml` 的 doc_repo.local_path） */
  docRepoPath: string;
  /** 业务级产物目录：`<docRepo>/requirements/<REQ-ID>` */
  bizDir: string;
  /** 仓库级产物目录：`<repoRoot>/wk-doc/requirements/<REQ-ID>` */
  repoDir: string;
  /** 主工作仓（隔离任务是 worktree 路径）——脚本 cwd + context-init 的仓库根 */
  repoRoot: string;
  /**
   * 这版团队库里有没有 `wk-context-init.py`（2026-07-27 才加的新脚本、老镜像没有）。
   * false = 推进前跳过初始化这一步、连提示都不给（缺席对老版本是正常态）。
   */
  hasContextInit: boolean;
  /**
   * preflight 会不会内部再去 hub 拉一趟产物（决定超时给 10s 还是 45s、见文件顶部三档预算）。
   * 判据见 `detectBaselinePull`。
   */
  pullsBaseline: boolean;
  /** Delivery Hub 上的 repo 名（用原仓库目录名、worktree 名会带 task 后缀） */
  repoName: string;
  /** wk-harness 的 scripts/ 绝对路径 */
  scriptsDir: string;
  /** Delivery Hub 地址；空 = 没接入、不调 delivery sync */
  hubBaseUrl: string;
}

export interface WkGatePlanSkip {
  applies: false;
  reason: WkGateSkipReason;
  /** 给用户看的一句话（not-wk 无需提示、为空串） */
  message: string;
}

export type WkGatePlan = WkGatePlanActive | WkGatePlanSkip;

const skip = (reason: WkGateSkipReason, message = ""): WkGatePlanSkip => ({
  applies: false,
  reason,
  message,
});

/**
 * planWkGate 需要的最小 task 面：手填 REQ-ID + 工作仓映射。
 * 不强绑完整 Task，单测拼 fixture 便宜。
 */
export type WkGateTaskLike = WorktreeTaskLike & Pick<Task, "reqId">;

const dirExists = async (p: string): Promise<boolean> => {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
};

const fileExists = async (p: string): Promise<boolean> => {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
};

/**
 * wk-harness 的 scripts/ 目录（团队库知识镜像里、七个门禁脚本都在这）。
 *
 * ⚠️ 不是 `knowledge/scripts/`——那边放的是知识库维护脚本（`kb_refresh.sh` /
 * `pull_*_repos.sh`），跟门禁无关。
 */
export const wkScriptsDir = (): string =>
  path.join(getTeamLibraryKnowledgeSkillsDir(), "global", "wk-harness", "scripts");

/**
 * 「WK 产出目录里没有这个需求目录」的两种语境——旧文案混成一句、还一律诱导用户去改编号。
 * `wk:biz-analyze` 正是建这个目录的指令，首次跑目录本来就不该存在；其余指令走到这里
 * 才真的可能是「前置没跑」或「编号填错了」。
 */
const missingReqDirMessage = (command: WkCommand, reqId: string): string =>
  command === "wk:biz-analyze"
    ? `${reqId} 的需求目录还没建（本次 wk:biz-analyze 跑完才有）、跳过 wk 门禁`
    : `WK产出目录里没有 ${reqId} 的需求目录、本次跳过 wk 门禁（先跑 wk:biz-analyze、编号填错了可在任务详情页改）`;

/**
 * preflight 会不会走网络：`doc-quality-gate.py --command` 在 delivery 配置的
 * `require_baseline` 为真时，内部起 `wk-delivery-baseline.py --pull` 去 hub 拉产物。
 *
 * 三个来源都算数（对齐脚本自己的 `read_delivery_config` 读取顺序）：
 * 1. `~/.wk/config.yaml`——我们管的那份，设置页填了 Delivery Hub 地址就恒为真（固定写 true）
 * 2. 仓库级 `.wk/config.yaml` / `.wk/delivery-hub.json`——同事手配的，我们不解析内容、
 *    **存在即当会拉**（宁可高估）
 * 3. 环境变量 `WK_REQUIRE_DELIVERY_BASELINE`——脚本里优先级最高，而我们把 `process.env`
 *    整份传给了子进程
 *
 * 判不准时一律往「会走网络」判：高估只是多留几秒余量（本地脚本几百 ms 就返回、根本用不到），
 * 低估会把正常的产物拉取拦腰砍断、门禁白跑一趟。
 */
const detectBaselinePull = async (
  cfg: WkConfig,
  repoRoot: string,
): Promise<boolean> => {
  if (isWkTruthy(process.env.WK_REQUIRE_DELIVERY_BASELINE)) return true;
  if (cfg.requireBaseline && cfg.hubBaseUrl) return true;
  const repoWkDir = path.join(repoRoot, ".wk");
  return (
    (await fileExists(path.join(repoWkDir, "config.yaml"))) ||
    (await fileExists(path.join(repoWkDir, "delivery-hub.json")))
  );
};

/** preflight 的超时预算：只有「会拉 baseline」那档要给足网络时间 */
export const preflightTimeoutMs = (plan: WkGatePlanActive): number =>
  plan.pullsBaseline ? BASELINE_PULL_TIMEOUT_MS : LOCAL_TIMEOUT_MS;

/**
 * 判断本次 action 要不要跑 wk 门禁、要跑的话参数怎么拼。
 *
 * 逐条降级（顺序即优先级，先判最便宜的）：
 * 1. 不是 wk 系 action → not-wk（静默、连事件都不写）
 * 2. 任务没填 REQ-ID → no-req-id（**不猜**，见 req-id.ts 顶部）
 * 3. 任务没绑仓库 → no-repo
 * 4. 没配 doc_repo → no-doc-repo（提示去设置页配）
 * 5. 团队库里没有 wk-harness 脚本 → no-scripts（提示去同步团队库）
 * 6. 文档仓里没有 `requirements/<REQ-ID>` 目录 → no-req-dir
 *    —— **新需求第一次跑 `wk:biz-analyze` 就落这里**（目录本来就要靠这条指令创建、
 *    先拦住等于永远起不了步）；其余指令落这里多半是编号填错 / 前置没跑。
 */
export const planWkGate = async (
  task: WkGateTaskLike,
  def: Pick<CustomActionDef, "skill" | "order"> | undefined | null,
): Promise<WkGatePlan> => {
  const command = wkCommandForAction(def);
  if (!command) return skip("not-wk");

  // 没有 REQ-ID 就没有 `requirements/<REQ-ID>` 可查——不拿假 ID 去撞目录。
  // 编号由需求 owner 分发，agent 拿到 wk skill 后会自己按规范找用户要。
  const reqId = resolveReqId(task);
  if (!reqId) {
    return skip("no-req-id", "任务没填需求编号（REQ-ID）、本次跳过 wk 门禁");
  }

  const repoRoot = getTaskWorkRepoPaths(task)[0];
  if (!repoRoot) {
    return skip("no-repo", "任务没绑仓库、跳过 wk 门禁");
  }

  const cfg = await readWkConfig();
  if (!cfg.docRepoPath) {
    return skip(
      "no-doc-repo",
      "没配 WK产出目录（设置页 → 团队 wk 流程）、本次跳过 wk 门禁",
    );
  }

  const scriptsDir = wkScriptsDir();
  if (!(await fileExists(path.join(scriptsDir, "doc-quality-gate.py")))) {
    return skip(
      "no-scripts",
      "团队库里没找到 wk-harness 门禁脚本（去能力页同步团队库）、本次跳过 wk 门禁",
    );
  }

  const bizDir = path.join(cfg.docRepoPath, "requirements", reqId);
  if (!(await dirExists(bizDir))) {
    return skip("no-req-dir", missingReqDirMessage(command, reqId));
  }

  return {
    applies: true,
    command,
    stage: wkStageOf(command),
    reqId,
    docRepoPath: cfg.docRepoPath,
    bizDir,
    repoDir: path.join(repoRoot, "wk-doc", "requirements", reqId),
    repoRoot,
    // 老版本团队库没这个脚本——探不到就整步跳过（硬跑 = python 退 2、
    // 每次推进往事件流刷一条「上下文初始化未完成」的假告警）
    hasContextInit: await fileExists(
      path.join(scriptsDir, "wk-context-init.py"),
    ),
    pullsBaseline: await detectBaselinePull(cfg, repoRoot),
    repoName:
      (task.repoPaths[0] ?? repoRoot).split(/[\\/]/).filter(Boolean).pop() ??
      "repo",
    scriptsDir,
    hubBaseUrl: cfg.hubBaseUrl,
  };
};

/** 后置门禁按 action 记录反查定义（advance 侧已有 def、不走这条） */
export const planWkGateForAction = async (
  task: Task,
  action: ActionRecord,
): Promise<WkGatePlan> => {
  if (action.type !== "custom" || !action.customActionId) return skip("not-wk");
  const def = await getCustomAction(action.customActionId);
  return planWkGate(task, def);
};

// ----------------- 参数拼装（纯函数、单测直接断言） -----------------

/**
 * `wk-context-init.py --req-id <REQ-ID> --cwd <repoRoot>`
 * 幂等初始化仓库级 `.wk/current.json` + `wk-doc/requirements/<REQ-ID>/status.yaml`。
 */
export const buildContextInitArgs = (plan: WkGatePlanActive): string[] => [
  "--req-id",
  plan.reqId,
  "--cwd",
  plan.repoRoot,
];

/**
 * `doc-quality-gate.py --command wk:xxx [--biz-path …] [--repo-path …]`
 * 传哪些 path 对齐 command hard gate 与 delivery baseline 的合并口径
 * （见 wk-command.ts 的两张表）。
 */
export const buildPreflightArgs = (plan: WkGatePlanActive): string[] => {
  const args = ["--command", plan.command];
  if (wkNeedsBizPath(plan.command)) args.push("--biz-path", plan.bizDir);
  if (wkNeedsRepoPath(plan.command)) args.push("--repo-path", plan.repoDir);
  return args;
};

/** 后置门禁的产物目录：仓库级指令看 repoDir、业务级看 bizDir */
export const wkStageArtifactDir = (plan: WkGatePlanActive): string =>
  wkScopeOf(plan.command) === "repo" ? plan.repoDir : plan.bizDir;

/** `doc-quality-gate.py --stage <stage> --path <artifact-dir>` */
export const buildStageArgs = (plan: WkGatePlanActive): string[] => [
  "--stage",
  plan.stage,
  "--path",
  wkStageArtifactDir(plan),
];

/** `wk-delivery-sync.py --command … --biz-path … [--repo-path … --repo-name …] --hub-url …` */
export const buildDeliverySyncArgs = (plan: WkGatePlanActive): string[] => {
  const args = ["--command", plan.command, "--biz-path", plan.bizDir];
  if (wkScopeOf(plan.command) === "repo") {
    args.push("--repo-path", plan.repoDir, "--repo-name", plan.repoName);
  }
  args.push("--hub-url", plan.hubBaseUrl);
  return args;
};

/**
 * 脚本环境：显式喂 `WK_DOC_ROOT` / `WK_REQ_ID`。
 * 两个脚本都优先读这两个环境变量（`wk-context-init.resolve_doc_root` /
 * `infer_req_id`），不喂的话会退到脚本里 hardcode 的作者本机路径。
 */
const scriptEnv = (plan: WkGatePlanActive): NodeJS.ProcessEnv => ({
  ...process.env,
  WK_DOC_ROOT: plan.docRepoPath,
  WK_REQ_ID: plan.reqId,
  PYTHONIOENCODING: "utf-8",
});

// ----------------- 三个挂钩点 -----------------

/** 门禁结论：blocked 只有 preflight 会返、其余一律 pass / warn */
export type WkGateVerdict = "pass" | "blocked" | "warn";

export interface WkGateReport {
  verdict: WkGateVerdict;
  /** 给用户看的一句话 / 多行明细（pass 时为简短确认语） */
  message: string;
}

/** 脚本起不来 / 超时 → 统一降级文案（绝不阻塞主流程） */
const degradedMessage = (
  label: string,
  result: WkScriptResult,
): string | null => {
  if (result.outcome === "unavailable") {
    return result.reason === "no-script"
      ? `${label}跳过：团队库里没有这个脚本（去能力页同步团队库）`
      : `${label}跳过：本机起不动 ${pythonBin()}`;
  }
  if (result.outcome === "timeout") {
    return `${label}跳过：脚本超时未返回（或输出过大被中断）`;
  }
  return null;
};

/**
 * 推进前置：context-init（warn-only）+ command preflight（硬拦）。
 *
 * 返回 blocked 时调用方必须**不启动 agent**；message 已是人可读形态。
 */
export const runWkPreflight = async (
  plan: WkGatePlanActive,
): Promise<WkGateReport> => {
  const env = scriptEnv(plan);
  const notes: string[] = [];

  // ① 幂等初始化仓库级上下文。它对「业务级 status.yaml 还不存在」也返 1（skip 语义、
  //    自己打 "WK context bootstrap skipped: …"），所以一律只 warn——真正该拦的由 preflight 说了算。
  //    脚本不在这版团队库里（plan 已探过）就整步跳过、不提示：老镜像缺席是正常态。
  if (plan.hasContextInit) {
    const init = await runWkScript(
      path.join(plan.scriptsDir, "wk-context-init.py"),
      buildContextInitArgs(plan),
      // 它自己不联网（写两个 json + 两条 git 查询）、跟着本地档走
      { cwd: plan.repoRoot, env, timeoutMs: LOCAL_TIMEOUT_MS },
    );
    if (init.outcome === "unavailable" && init.reason === "no-python") {
      // 跑不了 python3 → 第二个脚本必然同样跑不了，省一次 spawn、也免得同一句话说两遍
      return {
        verdict: "warn",
        message: degradedMessage(`${plan.command} 门禁`, init)!,
      };
    }
    if (init.outcome !== "ok") {
      notes.push(
        degradedMessage("wk 上下文初始化", init) ??
          formatWkGateFailure("wk 上下文初始化未完成", init.output),
      );
    }
  }

  // ② command preflight —— 规范的 fallback preflight：打出 FAIL 结论就必须停
  //    （非 0 但没有门禁结构的那种是工具自己坏了、见下面的降级分支）
  const pre = await runWkScript(
    path.join(plan.scriptsDir, "doc-quality-gate.py"),
    buildPreflightArgs(plan),
    { cwd: plan.repoRoot, env, timeoutMs: preflightTimeoutMs(plan) },
  );

  const degraded = degradedMessage(`${plan.command} 执行前门禁`, pre);
  if (degraded) {
    // 脚本本身跑不起来不算「门禁未过」——降级放行、只提示
    return { verdict: "warn", message: [...notes, degraded].join("\n") };
  }
  if (pre.outcome === "failed") {
    // 门禁工具自己坏了（traceback / 参数不认）同样不算「门禁未过」：
    // 硬拦是给「产物 / 状态没补齐」准备的，工具故障把人挡死是把 fail-closed 记在用户头上
    if (looksLikeToolSelfFailure(pre)) {
      return {
        verdict: "warn",
        message: [
          ...notes,
          formatWkGateFailure(
            `${plan.command} 执行前门禁跳过：门禁脚本自身报错`,
            pre.output,
          ),
        ].join("\n"),
      };
    }
    return {
      verdict: "blocked",
      message: [
        ...notes,
        // 脚本说什么就展示什么：不按根因改写成中文、不替它补「下一步」建议
        // （用户拍板；团队脚本的输出是同事之间沟通用的那份原文）
        formatWkGateFailure(`${plan.command} 执行前门禁未过`, pre.output),
      ].join("\n"),
    };
  }

  return {
    verdict: notes.length > 0 ? "warn" : "pass",
    message: [...notes, `${plan.command} 执行前门禁已通过`].join("\n"),
  };
};

/** 门禁往事件流写提示的出口（task-runner 注入带 lease 的 writer） */
export type WkGateEventSink = (
  kind: "info" | "error",
  text: string,
) => Promise<void>;

/**
 * 推进前门禁的完整决策（判定 + 跑脚本 + 提示落事件流）。
 *
 * 决策只有两种：
 * - `proceed`：放行。降级 / warn 时已写过一条 info 事件说明原因
 * - `block`：preflight 非 0。已写过一条 error 事件；调用方必须抛错、
 *   **不 append action、不启动 agent**
 *
 * 门禁自身异常（读盘炸 / 依赖缺失）一律 proceed——它是质量闸门、不是可用性依赖。
 */
export const evaluateWkAdvanceGate = async (
  task: WkGateTaskLike,
  def: Pick<CustomActionDef, "skill" | "order"> | undefined | null,
  writeEvent: WkGateEventSink,
): Promise<{ decision: "proceed" | "block"; message: string }> => {
  // 写事件失败不改变决策——门禁结论已经定了，别让日志问题反过来改判。
  // 也不能让它冒到下面的外层 catch：那条 catch 是给「门禁自身异常」准备的、
  // 吞了写事件的错就会把已经算出来的 skip 提示一起丢掉。
  const notify = async (kind: "info" | "error", text: string): Promise<void> => {
    try {
      await writeEvent(kind, text);
    } catch (err) {
      console.warn(`[wk-gate] 门禁提示写事件流失败 task=${task.id}：`, err);
    }
  };

  let report: WkGateReport;
  try {
    const plan = await planWkGate(task, def);
    if (!plan.applies) {
      // not-wk 完全静默；其余降级写一条提示、让用户知道门禁为什么没跑
      if (plan.reason !== "not-wk") await notify("info", plan.message);
      return { decision: "proceed", message: plan.message };
    }
    report = await runWkPreflight(plan);
  } catch (err) {
    console.warn(`[wk-gate] 推进前门禁异常 task=${task.id}：`, err);
    return { decision: "proceed", message: "" };
  }

  if (report.verdict === "blocked") {
    await notify("error", report.message);
    return { decision: "block", message: report.message };
  }
  // pass 不写事件——agent 起来本身就是回执，成功刷屏没意义
  if (report.verdict === "warn") await notify("info", report.message);
  return { decision: "proceed", message: report.message };
};

/**
 * action 收尾：post-stage 门禁 + （过了才）delivery sync。
 *
 * 门禁未过 → warn 级别的 blocked？不——后置这里返 "blocked" 表示
 * 「标记问题」：调用方（action-checks）把它并进 postCheck.passed=false，
 * UI 挂红条、用户能看到该修什么。delivery sync 失败只追加一行提示。
 */
export const runWkPostStage = async (
  plan: WkGatePlanActive,
): Promise<WkGateReport> => {
  const env = scriptEnv(plan);

  const stage = await runWkScript(
    path.join(plan.scriptsDir, "doc-quality-gate.py"),
    buildStageArgs(plan),
    // `--stage` 分支在读 delivery 配置前就 return 了、保证不联网 → 本地档
    { cwd: plan.repoRoot, env, timeoutMs: LOCAL_TIMEOUT_MS },
  );

  const degraded = degradedMessage(`${plan.command} 阶段门禁`, stage);
  if (degraded) return { verdict: "warn", message: degraded };

  if (stage.outcome === "failed") {
    // 同 preflight：工具自身报错不当「门禁未过」，不然 UI 挂一条红条冤枉用户的产物。
    // 结论未知就不往 Delivery Hub 推——跟上面 degraded 那条一个口径
    if (looksLikeToolSelfFailure(stage)) {
      return {
        verdict: "warn",
        message: formatWkGateFailure(
          `${plan.command} 阶段门禁跳过：门禁脚本自身报错`,
          stage.output,
        ),
      };
    }
    return {
      verdict: "blocked",
      message: formatWkGateFailure(
        `${plan.command} 阶段门禁未过`,
        stage.output,
      ),
    };
  }

  // 门禁过了才推 Delivery Hub；没配地址直接不调（脚本没 hub-url 会打 FAIL、白吓人）
  const notes = [`${plan.command} 阶段门禁已通过`];
  if (plan.hubBaseUrl) {
    const sync = await runWkScript(
      path.join(plan.scriptsDir, "wk-delivery-sync.py"),
      buildDeliverySyncArgs(plan),
      { cwd: plan.repoRoot, env, timeoutMs: DELIVERY_SYNC_TIMEOUT_MS },
    );
    if (sync.outcome !== "ok") {
      notes.push(
        degradedMessage("Delivery Hub 同步", sync) ??
          formatWkGateFailure("Delivery Hub 同步失败（不影响产物）", sync.output),
      );
      return { verdict: "warn", message: notes.join("\n") };
    }
    notes.push("已同步 Delivery Hub");
  }

  return { verdict: "pass", message: notes.join("\n") };
};
