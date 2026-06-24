/**
 * 仓库「确定性检查命令」自动检测（V0.6.26）
 *
 * 背景：V0.6.25 CheckRun 上线后、check 命令全靠用户在设置页 per-repo 手填。没填的仓 build 后
 * 记 not_configured（如 crm-web 明明有 lint/tsc 却显示「未配置」）、手动配置心智负担高、不符合
 * harness「降低流程负担」的目标。本模块在建 task 时按 repo 文件结构自动识别常见检查命令、快照进
 * task.repoCheckCommands——用户不配也能让 lint/typecheck 真正跑起来。
 *
 * 合并优先级（在 task-fs.createTask 实现）：manual override > auto detect > empty
 *   - 某 repo 有手动配置 → 用手动（标 source=manual）
 *   - 没手动配置 → 调本模块 detectRepoCheckCommands（标 source=auto）
 *
 * 第一版边界（保守、详见各 detect 函数注释）：
 *   - 只覆盖 Node / Maven / Gradle、只看 repo root（不做 monorepo workspace 粒度）
 *   - 只自动加入 lint / typecheck（Java 类为 compile）——最轻量稳定、最符合门禁初衷
 *   - required 分级：Node lint/typecheck + Maven compile = required（稳定可靠、挡 ship）；
 *     Gradle compileTestJava = required=false（Android/Kotlin 不通用、不自动挡 ship、用户可手动覆盖）
 *   - 不自动加 test（慢 / 依赖 DB·Redis / build 后置 check 期间会卡住用户）、不加重型 build
 *   - 命令只用「白名单 script 名」拼、不解析 scripts 内容二次拼复杂 shell（安全：不引入用户输入）
 *
 * 安全 / 健壮性：
 *   - repoPath 不存在 / 不可读 / package.json 破损 → 各 detect 兜底返 []、绝不抛错挡建 task
 *   - 本模块只「识别命令字符串」、不执行；执行在 action-checks.checkBuild 走 sh -c（已有环境兜底）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { CheckCommand } from "@/lib/types";

// Node lint/typecheck 给 120s（轻量）；Java 编译给 10min（多模块 / 首次拉依赖慢）
const NODE_CHECK_TIMEOUT_MS = 120_000;
const JAVA_CHECK_TIMEOUT_MS = 600_000;

// ----------------- fs helper -----------------

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

// 读 JSON、任何异常（不存在 / 非法 JSON / 权限）都吞掉返 null——detect 不能因单个文件破损挂掉
const readJsonSafe = async (p: string): Promise<unknown | null> => {
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// ----------------- Node / 前端仓 -----------------

type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/**
 * 按 lockfile 判包管理器（优先级 pnpm > yarn > bun > npm、没 lockfile 默认 npm）
 * 命令统一拼 `<pm> run <script>`——所有 pm 都支持 `run` 子命令、最稳
 */
const detectPackageManager = async (
  repoPath: string,
): Promise<PackageManager> => {
  if (await fileExists(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(repoPath, "yarn.lock"))) return "yarn";
  // bun.lockb（二进制、老）/ bun.lock（文本、bun 1.2+）都算
  if (await fileExists(path.join(repoPath, "bun.lockb"))) return "bun";
  if (await fileExists(path.join(repoPath, "bun.lock"))) return "bun";
  if (await fileExists(path.join(repoPath, "package-lock.json"))) return "npm";
  return "npm";
};

/**
 * 脚本命令是否 watch 模式（含独立 `-w` / `--watch` flag）
 *
 * V0.8.19：watch 模式编译/lint 完不退出、一直挂着监听文件——被当 check 跑必然撞满 timeout 被杀
 * （线上 cp-haomao 的 `"tsc": "node_modules/typescript/bin/tsc -w"` 被自动检测当 typecheck 拉进来、
 *  三次 build 全 `timed_out` ~120s；且当时这 120s 还同步卡死 wait_for_user、把 agent 整懵、踩过）。
 * 检测阶段就识别出 watch 脚本、不直接拿它当 check（typecheck 兜底换一次性命令、lint 直接跳过）。
 *
 * 匹配独立 token（前置行首/空白 + 词边界）、不误伤 `--ext .tsx` / `--noEmit` 这类含字母 w 的参数。
 */
export const isWatchScript = (script: string): boolean =>
  /(?:^|\s)(?:-w|--watch)\b/.test(script);

/**
 * 脚本是否会「自动改写工作区源码」（含 --fix / --write / --apply 等修复 flag）
 *
 * V0.8.20：lint 脚本带 --fix（如 `ng lint --fix=true` / `eslint --fix` / `prettier --write`）
 * 会逐文件改写源码。被当后置 check 跑时有两个坑（线上 cp-admin 踩过）：
 *   ① 污染工作区——`mutatedWorktree` 事后判 failed = 误红（业务代码本没问题）；
 *   ② 用户本地若开着 dev server（`ng serve`/`vite` 等 watch），lint --fix 在跑的几十秒~数分钟里
 *      持续改文件 → dev server 连环热重载、终端看起来「一直重启」（实测 `ng lint --fix=true`
 *      跑满 120s 超时、期间 dev 每 3s 重编译一次）。
 * 这类「修复型」脚本本质不是只读校验、不该当 required check、检测阶段就识别出来、不拉进来。
 *
 * 匹配独立 token 的修复 flag：
 *   - `--fix` / `--fix=true`（eslint / ng lint）；用 negative-lookahead 排除 `--fix-dry-run`
 *     （eslint 只读预览、不落盘、不算改写）
 *   - `--write`（prettier）
 *   - `--apply` / `--apply-unsafe`（biome 旧版；新版 biome 也用 `--write`、已被上面覆盖）
 */
export const isMutatingScript = (script: string): boolean =>
  /(?:^|\s)(?:--fix(?!-dry-run)|--write|--apply)\b/.test(script);

/**
 * Node / 前端仓检测——读 package.json.scripts、按白名单 script 名识别
 *
 * 第一版只输出 required 的 lint + typecheck：
 *   - lint：scripts.lint 存在且非 watch → `<pm> run lint`
 *   - typecheck：scripts.typecheck 优先、否则 scripts.tsc → `<pm> run <typecheck|tsc>`
 *
 * V0.8.19 watch 防呆（不改变正常脚本的既有行为、只在脚本是 watch 时才走兜底分支）：
 *   - 选中的 typecheck 脚本是 watch（如 `tsc -w`）→ 不用脚本、兜底跑一次性 `npx tsc --noEmit`、
 *     且 required=false（这是我们替换猜的命令、不如项目脚本可信、降级只展示不挡 ship、沿用本模块
 *     「宁可少挡不误挡」哲学）。
 *   - lint 脚本是 watch → 直接跳过不加（watch 的 lint 罕见、且无标准一次性 fallback）。
 *
 * 故意不输出 test / build（第一版、用户拍板）：
 *   - test 慢 / 可能 watch / 依赖环境（DB·Redis）、且 CheckRun 跑期间 build 停在 running 会卡用户
 *   - build 成本高、每次 build 后再 build 太重
 *   后续要加 test 时：识别 scripts.test、过滤 placeholder（含 "no test specified" / "exit 1"
 *   的是 `npm init` 默认占位、不是真测试）、加 required:false。
 */
const detectNodeChecks = async (
  repoPath: string,
): Promise<CheckCommand[]> => {
  const pkg = await readJsonSafe(path.join(repoPath, "package.json"));
  if (!pkg || typeof pkg !== "object") return [];
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const scriptMap = scripts as Record<string, unknown>;
  // script 存在 = 值是非空字符串
  const has = (name: string): boolean => {
    const v = scriptMap[name];
    return typeof v === "string" && v.trim().length > 0;
  };
  // 取脚本命令体（非字符串归一空串、配合 isWatchScript 用）
  const body = (name: string): string => {
    const v = scriptMap[name];
    return typeof v === "string" ? v : "";
  };

  const pm = await detectPackageManager(repoPath);
  const cmds: CheckCommand[] = [];

  // lint 脚本只在「既非 watch、又不会自动改写源码」时才加：
  //   - watch（如 `eslint --watch`）：永不退出、当 check 必 timeout（V0.8.19）
  //   - mutating（如 `ng lint --fix=true` / `eslint --fix`）：会改源码、污染工作区误判 failed
  //     + 触发用户本地 dev server 连环热重载、终端「一直重启」（V0.8.20、线上 cp-admin 踩过）
  // 两类都不是只读门禁、且无通用「只读化」兜底（去 --fix 要解析 script 内部、本模块不做）、直接跳过不加。
  if (
    has("lint") &&
    !isWatchScript(body("lint")) &&
    !isMutatingScript(body("lint"))
  ) {
    cmds.push({
      name: "lint",
      cmd: `${pm} run lint`,
      kind: "lint",
      required: true,
      timeoutMs: NODE_CHECK_TIMEOUT_MS,
      source: "auto",
    });
  }

  // typecheck 优先 tsc——两者都没就不加（很多纯 JS 仓没类型检查）
  const typecheckScript = has("typecheck")
    ? "typecheck"
    : has("tsc")
      ? "tsc"
      : null;
  if (typecheckScript) {
    const tcBody = body(typecheckScript);
    if (isMutatingScript(tcBody)) {
      // 罕见：typecheck 脚本含 --fix/--write 会改写文件——同 lint、不当只读 check、跳过不加
      // （tsc 本身没 --fix、一般命中不了；防极个别项目把格式化 fix 塞进 typecheck 脚本、V0.8.20）
    } else if (isWatchScript(tcBody)) {
      // 选中的脚本是 watch（永不退出、当 check 必 timeout）→ 兜底跑一次性 tsc --noEmit、降级不挡 ship
      cmds.push({
        name: "typecheck",
        cmd: "npx tsc --noEmit",
        kind: "typecheck",
        required: false,
        timeoutMs: NODE_CHECK_TIMEOUT_MS,
        source: "auto",
      });
    } else {
      cmds.push({
        name: "typecheck",
        cmd: `${pm} run ${typecheckScript}`,
        kind: "typecheck",
        required: true,
        timeoutMs: NODE_CHECK_TIMEOUT_MS,
        source: "auto",
      });
    }
  }

  return cmds;
};

// ----------------- Maven -----------------

/**
 * Maven 仓检测——有 pom.xml 即加 `mvn -DskipTests compile`
 *
 * 用 compile（编译主代码）而非 test：后端单测常依赖 DB / Redis / Nacos / profile、本地不一定能跑、
 * 默认跑 test 噪音大。compile 能稳定抓 Java 编译错误、最符合门禁初衷。
 * kind 复用 typecheck（没有 compile kind、编译≈类型检查语义最近、不为文案马上扩 enum）。
 */
const detectMavenChecks = async (
  repoPath: string,
): Promise<CheckCommand[]> => {
  if (!(await fileExists(path.join(repoPath, "pom.xml")))) return [];
  return [
    {
      name: "compile",
      cmd: "mvn -DskipTests compile",
      kind: "typecheck",
      required: true,
      timeoutMs: JAVA_CHECK_TIMEOUT_MS,
      source: "auto",
    },
  ];
};

// ----------------- Gradle -----------------

/**
 * Gradle 仓检测——有 build.gradle(.kts) / settings.gradle(.kts) 即加编译命令
 *
 * 命令选 `compileTestJava`（编译主 + 测试代码）而非 `compileJava` 或 `build -x test`：
 *   - compileJava：多模块项目里可能只编根项目、子模块漏检、误以为通过
 *   - build -x test：会触发 assemble 打包 + checkstyle/spotbugs 等、是重型构建、跟门禁「轻量」初衷拧
 *   - compileTestJava：gradle 自动传播到所有子模块、覆盖完整、不打包不跑 checkstyle、比 build 轻很多
 * 为何 required=false（V0.6.26 reviewer 拍板）：纯 Kotlin / Android 项目没有 compileTestJava task——
 *   Android 报 task not found → exit≠0 会**误报红挡 ship**；纯 Kotlin 该 task 存在但不编译 .kt → **假绿**。
 *   compileTestJava 不是足够通用的 required gate、故自动检测默认 required=false（只展示、不自动挡 ship）、
 *   第一版保守宁可少挡也不误挡；用户确认本仓可靠后可在设置页手动覆盖成 required=true。
 *
 * 优先用 wrapper `./gradlew`（锁版本、跟 CI 一致）、没有 wrapper 才退系统 `gradle`。
 */
const detectGradleChecks = async (
  repoPath: string,
): Promise<CheckCommand[]> => {
  const isGradle =
    (await fileExists(path.join(repoPath, "build.gradle"))) ||
    (await fileExists(path.join(repoPath, "build.gradle.kts"))) ||
    (await fileExists(path.join(repoPath, "settings.gradle"))) ||
    (await fileExists(path.join(repoPath, "settings.gradle.kts")));
  if (!isGradle) return [];

  const gradle = (await fileExists(path.join(repoPath, "gradlew")))
    ? "./gradlew"
    : "gradle";
  return [
    {
      name: "compile",
      cmd: `${gradle} compileTestJava`,
      kind: "typecheck",
      // V0.6.26 reviewer 拍板：Gradle 自动命令 required=false（只展示、不自动挡 ship）。
      // compileTestJava 在 Android（无此 task → 报错）/ 纯 Kotlin（不编译 .kt → 假绿）不够通用、
      // 多模块 / 插件差异大、不适合当自动 required gate。用户确认本仓可靠后可手动覆盖成 required=true。
      required: false,
      timeoutMs: JAVA_CHECK_TIMEOUT_MS,
      source: "auto",
    },
  ];
};

// ----------------- 主入口 -----------------

/**
 * 按 repo 文件结构自动检测确定性检查命令（建 task 时调、没手动配置才走这里）
 *
 * - 三类检测并行跑（各自只读几个文件、很快）、结果合并
 * - 混合仓（既有 package.json 又有 pom.xml、罕见）→ 各栈命令都加、由 createTask sanitize 兜数量上限
 * - 任何异常 → 返 []（绝不挡建 task；CheckRun 没命令的仓退回 not_configured / skipped 的现有语义）
 */
export const detectRepoCheckCommands = async (
  repoPath: string,
): Promise<CheckCommand[]> => {
  if (!repoPath || !repoPath.trim()) return [];
  try {
    const [node, maven, gradle] = await Promise.all([
      detectNodeChecks(repoPath),
      detectMavenChecks(repoPath),
      detectGradleChecks(repoPath),
    ]);
    return [...node, ...maven, ...gradle];
  } catch (err) {
    console.warn(
      `[repo-check-detect] 自动检测失败 repoPath=${repoPath}（按未配置处理）：`,
      err,
    );
    return [];
  }
};
