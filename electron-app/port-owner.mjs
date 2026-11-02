/**
 * 端口被占时「占用者是谁」的判定与文案（纯函数、无 electron 依赖，可被 vitest 直接单测）。
 *
 * 背景（评审 P2）：ensurePortFree 以前只要端口（8876 / 测试包 8776）被占就弹「检测到旧版服务占用了端口」、
 * 用户点「确定」就按 lsof / netstat 查到的 pid 盲杀——从不核实占用者是不是 Flowship 自己的 server。
 * 开发者本机 8876 上跑着自己的 dev server / 别的工具时，一句固定文案会把人带去杀掉不相干的进程。
 *
 * 判定：Flowship 的 server 总是 `<…>/app-server/server.js`（打包：resources/app-server；dev：dist/app-server），
 * 命令行里能看到这个路径就认「是我们的旧实例」；查不到命令行（进程刚退 / 权限 / 命令超时）按「无法确认」处理、
 * 与「确认是别人」同样不盲杀，只是文案不同。
 */

/**
 * Flowship server 的命令行特征：任意安装位置下的 app-server/server.js（正反斜杠都认、大小写不敏感）。
 * 两端都要锚定边界（命中后 ensurePortFree 会按进程组 SIGKILL，宁可漏认——漏认只是多弹一次确认框）：
 * - 前：`app-server` 之前必须是行首 / 路径分隔符（/ \）/ 引号 / 空白——`webapp-server/server.js`、`my-app-server/server.js`
 *   这类「目录名恰好以 app-server 结尾」的别人的程序不命中；
 * - 后：`server.js` 之后必须是行尾 / 引号 / 空白——`server.json`、`server.js.map`、`server.jsx` 不命中。
 * 带空格的安装路径（`C:\Program Files\…\app-server\server.js`）、带引号的写法（Windows 命令行里路径被引号包着）都能命中。
 */
const SERVER_CMD_RE = /(?:^|[\\/"'\s])app-server[\\/]+server\.js(?=$|["'\s])/i;

/** 命令行是不是 Flowship 自己的 server */
export const isFlowshipServerCommand = (command) =>
  typeof command === "string" && SERVER_CMD_RE.test(command);

/**
 * mac / Linux 上 `ps -o command=` 看到的 Flowship server **不含** `app-server/server.js`：
 * Next 的 start-server 把 `process.title` 改成了 `next-server (v<版本>)`（2026-11 本机实测 `next-server (v15.5.28)`）。
 * 这个标题本身不足以证明是我们的（开发者别的 Next 项目 `next start` 同样是这个标题），
 * 所以只有「标题吻合 且 pid 就是上次本机记录的 server pid」才算我们的（见 classifyPortOwners 的 recordedServerPid）。
 */
const NEXT_SERVER_TITLE_RE = /^next-server \(v\d/;
export const isNextServerTitle = (command) =>
  typeof command === "string" && NEXT_SERVER_TITLE_RE.test(command.trim());

/** 壳每次拉起 server 后记下 pid（userData/server-pid.json），下次启动端口被占时据此核对身份 */
export const buildServerPidRecord = (pid, port, now = Date.now()) =>
  JSON.stringify({ pid: Number(pid), port: Number(port), startedAt: now });

/**
 * 解析 server-pid.json：只认 > 1 的安全整数 pid（0 / 1 / 负数在 kill 语义里是「整个进程组 / 所有进程」，绝不能当 pid 用），
 * 其余（坏 JSON / 缺字段 / 非数字）一律返回 null。
 * 传了 `port` 时还要求记录里的 port 与之一致（记录是为这个端口上的 server 写的；端口配置变了 = 记录不适用）。
 * @param {string} text
 * @param {{port?: number}} [opts]
 * @returns {number|null}
 */
export const parseServerPidRecord = (text, opts = {}) => {
  try {
    const o = JSON.parse(String(text));
    const pid = Number(o?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    if (opts?.port !== undefined && Number(o?.port) !== Number(opts.port)) return null;
    return pid;
  } catch {
    return null;
  }
};

/**
 * 读某个 pid「完整命令行」的外部命令（身份判定用）：返回 `{ cmd, args }`，由调用方 execFile 执行。
 * - unix：`ps -p <pid> -o command=`
 * - win32：PowerShell 的 CIM 查询（只在端口冲突这条罕见路径上才拉起，不影响常规启动）
 * 放在这个纯模块里而不是 main.js：main.js 有契约测试禁止内联 PowerShell CIM 命令（OEM 代码页乱码那类问题，
 * 见 startup-boot-contract）；这里只取 CommandLine 一个字段、输出是进程自己的命令行文本，不是本地化的 displayName。
 * pid 一律 Number() 化后才拼进脚本，非整数 / 非正数返回 null（调用方当「读不到」）。
 * @param {number|string} pid
 * @param {NodeJS.Platform} [platform]
 * @returns {{cmd: string, args: string[]} | null}
 */
export const buildPidCommandQuery = (pid, platform = process.platform) => {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${n}").CommandLine`,
      ],
    };
  }
  return { cmd: "ps", args: ["-p", String(n), "-o", "command="] };
};

/**
 * 把「占用端口的进程们」分成三类。
 * @param {{pid:number, command:string|null}[]} owners
 * @param {{recordedServerPid?: number|null}} [opts] 上次本机记录的 server pid（见 buildServerPidRecord）：
 *   命令行是 `next-server (v…)` 标题（mac / Linux 看不到 server.js 路径）且 pid 与记录一致时也认「ours」
 * @returns {{kind: "none"|"ours"|"foreign"|"unknown", ours: number[], others: {pid:number, command:string|null}[]}}
 * - none：没查到任何占用者（lsof / netstat 失败或进程刚退）——交给调用方按原逻辑处理
 * - ours：全部是 Flowship 自己的 server
 * - foreign：至少一个**确认**不是 Flowship 的（命令行拿到了、但不匹配）
 * - unknown：没有确认是别人的，但至少一个拿不到命令行、无法确认身份
 * others 里是所有「不是确认 ours」的进程（foreign + unknown）。
 */
export const classifyPortOwners = (owners, opts = {}) => {
  const list = Array.isArray(owners) ? owners : [];
  if (list.length === 0) return { kind: "none", ours: [], others: [] };
  const recorded = Number.isSafeInteger(opts?.recordedServerPid) ? opts.recordedServerPid : null;
  const ours = [];
  const others = [];
  let sawForeign = false;
  for (const o of list) {
    if (
      isFlowshipServerCommand(o.command) ||
      (recorded !== null && o.pid === recorded && isNextServerTitle(o.command))
    ) {
      ours.push(o.pid);
    } else {
      others.push(o);
      // 标题是 `next-server (v…)` 但 pid 对不上记录：可能是升级后首次启动 / 记录丢了而它确实是我们的旧 server，
      // 也可能是别的项目的 next start——不武断说「不是 Flowship 的服务」，按「无法确认」处理（列出 pid 与命令行让用户自己判断）
      if (typeof o.command === "string" && o.command.trim() !== "" && !isNextServerTitle(o.command)) {
        sawForeign = true;
      }
    }
  }
  if (others.length === 0) return { kind: "ours", ours, others };
  return { kind: sawForeign ? "foreign" : "unknown", ours, others };
};

/** 去重 + 只留 > 1 的安全整数 pid（保序）；pid ≤ 1 在 kill 语义里是「所有进程 / 本组 / init」，绝不进入任何杀进程名单 */
const uniqueSafePids = (list) => {
  const seen = new Set();
  const out = [];
  for (const pid of Array.isArray(list) ? list : []) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
};

/**
 * 弹窗前后两次「谁在监听端口」取交集：只留**弹窗前确认过、且现在仍在监听**的 pid（保序、去重，以 `before` 的顺序为准）。
 *
 * 为什么要有：ensurePortFree 弹「检测到端口被占用 / 仍然关闭」时用户可能放着不管很久，这段时间里弹窗前拿到的 pid
 * 可能已经退出、并被系统复用给毫不相干的进程——直接按旧列表 kill（尤其是按进程组 kill(-pid)）会误杀。
 * 用户点了按钮之后重查一次监听者，pid 已经不在监听该端口的（退了 / 被复用成了别的进程）一律不杀；
 * 弹窗期间新冒出来的监听者（只在 `after`、不在 `before`）也不杀——用户没看过、没确认过它。
 * @param {number[]} before 弹窗前的占用者 pid
 * @param {number[]} after 用户确认后重查到的占用者 pid
 * @returns {number[]}
 */
export const intersectPortOwners = (before, after) => {
  const live = new Set(Array.isArray(after) ? after : []);
  return uniqueSafePids(before).filter((pid) => live.has(pid));
};

/**
 * 端口被占时的处置决策（纯函数）：输入占用者（pid + 命令行）与上次记录的 server pid，
 * 输出「弹哪种窗、哪些 pid 按进程组杀、哪些只杀单个 pid」。
 * - `groupKill`：**只**含确认是 Flowship 自己 server 的占用者（命令行含 app-server/server.js，
 *   或 `next-server (v…)` 标题且 pid 等于记录）——它们才配按进程组（unix kill(-pid) / win32 taskkill /T）清；
 * - `singleKill`：其余（别的程序 / 身份不明）——用户明确点了「仍然关闭它」才杀，且只杀被点名的那个 pid（不带进程组 / 进程树）；
 * - `dialog`：`"ours"` 全是自家的（老文案、点确定即清）；`"foreign"` 至少一个确认不是 Flowship；`"unknown"` 没确认是别人但有读不到命令行的。
 *   没查到任何占用者（kind none）沿用 `"ours"` 的老弹窗（groupKill / singleKill 都为空，调用方照常等端口释放）。
 * @param {{pid:number, command:string|null}[]} owners
 * @param {{recordedServerPid?: number|null}} [opts]
 * @returns {{classification: ReturnType<typeof classifyPortOwners>, dialog: "ours"|"foreign"|"unknown", groupKill: number[], singleKill: number[]}}
 */
export const planPortCleanup = (owners, opts = {}) => {
  const classification = classifyPortOwners(owners, opts);
  const oursSet = new Set(classification.ours);
  const pids = uniqueSafePids((Array.isArray(owners) ? owners : []).map((o) => o?.pid));
  return {
    classification,
    dialog: classification.kind === "foreign" || classification.kind === "unknown" ? classification.kind : "ours",
    groupKill: pids.filter((p) => oursSet.has(p)),
    singleKill: pids.filter((p) => !oursSet.has(p)),
  };
};

/**
 * server 退出时要不要清 server-pid.json：只有「记录里的 pid 就是正在退出的这个」才清。
 * 自动重启后新 server 已写了新记录，迟到的旧 exit 事件（recorded ≠ exitingPid）不能把新记录删了；
 * 没有记录 / 记录损坏（recordedPid 为 null）/ spawn 失败没有 pid（undefined）一律不清。
 * @param {number|null|undefined} recordedPid parseServerPidRecord 的结果
 * @param {number|null|undefined} exitingPid 正在退出的 server 的 pid
 */
export const shouldClearServerPidRecord = (recordedPid, exitingPid) =>
  Number.isSafeInteger(recordedPid) && recordedPid === exitingPid;

/** 命令行截断到弹窗放得下的长度（保留头部：可执行文件 + 关键参数在前面） */
const clip = (s, max = 140) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** 「别的程序占了端口」弹窗的文案（`ours` 的老文案由调用方保留） */
export const buildForeignOwnerDialog = (port, classification) => {
  const lines = classification.others.map((o) =>
    o.command ? `· pid ${o.pid}：${clip(o.command)}` : `· pid ${o.pid}：（读不到命令行）`,
  );
  const foreign = classification.kind === "foreign";
  return {
    title: "端口被占用",
    message: foreign
      ? `${port} 端口被其他程序占用（不是 Flowship 的服务）`
      : `${port} 端口被占用，无法确认占用者是不是 Flowship 的旧服务`,
    detail:
      `${lines.join("\n")}\n\n` +
      "Flowship 默认不会替你关掉它。请先自行关闭占用端口的程序后重新打开应用；" +
      "确认它可以关闭的话，也可以点「仍然关闭它」。",
    buttons: ["退出", "仍然关闭它"],
    defaultId: 0,
    cancelId: 0,
  };
};

/**
 * 按 pid 列表杀进程（unix SIGKILL / win32 taskkill）；系统调用都经注入的 `kill` / `taskkill`，方便单测不碰真进程。
 * - `group=true`（只给「已确认是 Flowship 自己的 server」的占用者用）：
 *   - unix：先 `kill(-pid)` 按进程组杀，连孙进程（agent shell 的 pnpm / dev server 等）一起清；pid 不是组长时会 ESRCH，退回单 pid；
 *   - win32：`taskkill /T /F`（连进程树）。
 * - `group=false`（别的程序 / 身份不明的占用者）：只杀被点名的那一个 pid——unix 单 pid SIGKILL；win32 `taskkill /F` **不带 /T**，
 *   不顺手杀它的子进程树。
 * - pid ≤ 1 / 非安全整数一律跳过：`kill(-1)` / `kill(0)` / `kill(1)` 的语义是「所有进程 / 本组 / init」，绝不能被一条坏数据触发。
 * @param {number[]} pids
 * @param {{group?: boolean, platform: NodeJS.Platform, kill: (pid:number, sig:string)=>void, taskkill: (args:string[])=>Promise<unknown>}} deps
 */
export const killPidList = async (pids, { group = false, platform, kill, taskkill }) => {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (platform === "win32") {
      try {
        await taskkill(["/PID", String(pid), ...(group ? ["/T"] : []), "/F"]);
      } catch {
        // 进程已不在 / 无权限：吞掉，调用方随后会轮询端口是否释放、没释放会明确报「端口仍被占用」
      }
      continue;
    }
    let groupKilled = false;
    if (group) {
      try {
        kill(-pid, "SIGKILL");
        groupKilled = true;
      } catch {
        // 不是组长 / 组已不在：走单 pid
      }
    }
    if (!groupKilled) {
      try {
        kill(pid, "SIGKILL");
      } catch {
        // 进程已不在、忽略
      }
    }
  }
};
