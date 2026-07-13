/**
 * 路径相关工具（客户端可用、不依赖 node:path）
 *
 * 抽出来的动机：
 * - `pathBasename` / `basename` 在 event-stream / artifact-panel 多个组件里各自定义、
 *   实现细节漂移（带不带「去尾 slash」逻辑）。一处抽完所有点都走它。
 * - `buildIdeLink`（原 buildCursorLink、2026-06-12 支持 IDEA 后改名）在 artifact-panel
 *   有完整版（拼 repoPath）、event-stream 有简化版（只接绝对路径）。合并成一个、
 *   repoPath 缺省时按已经是绝对路径走。
 * - `looksLikePath` 是 markdown 渲染时「这个 inline code 像不像文件路径」的启发式判断、
 *   未来文件 / 路径渲染逻辑可能复用、放这里收口。
 * - `looksLikeArtifactRef`（V0.5.8 加）跟 `looksLikePath` 互斥：识别「inline code 是不是
 *   同 task 内 artifact 引用」（`01-plan.md` / `02-build.md` / `03-review.md`）、命中
 *   走 task 内 tab 切换、不走 cursor:// 跳转。
 *
 * 注意：前端组件不能用 `node:path` / `node:url`、手写就行、量很小。
 *
 * Windows 适配（2026-06-11、用户同事 Windows 上路径不可点击跳转）：
 * - 业务仓库跑在 Windows 时、agent 写进 artifact 的路径是 `D:\IdeaProjects\...\Api.java`
 *   反斜杠 + 盘符形态、原实现全套只认 `/`、识别 / 链接 / basename / cwd 计算全部失效。
 * - 统一策略：**计算前把 `\` 归一化成 `/`**（Node / Cursor 协议在 Windows 都接受正斜杠）、
 *   盘符绝对路径（`D:/...`）视作绝对路径、cursor 链接拼成 `cursor://file/D:/...`
 *   （同 VS Code `vscode://file/c:/myfile.txt` 约定、盘符段的 `:` 不 encode）。
 */

import { ACTION_TYPES, type ActionType, type JumpIde } from "./types";

/** Windows 盘符绝对路径（`D:\...` / `D:/...`）。归一化前后都能判。 */
export const isWindowsAbsPath = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p);

/**
 * 跨平台绝对路径判断（CR-11、client / server route 共用单一源）：
 * - POSIX：`/...`（`//server/share` 正斜杠 UNC 也天然命中）
 * - Windows 盘符：`C:\...` / `C:/...`
 * - Windows UNC：`\\server\share\...`
 * 裸盘符 `C:`（盘相对路径）不算绝对。
 */
export const isAbsolutePathLike = (p: string): boolean =>
  p.startsWith("/") || isWindowsAbsPath(p) || /^\\\\[^\\]/.test(p);

/** 把 Windows 反斜杠分隔符归一化成 `/`（POSIX 路径原样返回） */
const normalizeSeparators = (p: string): string => p.replace(/\\/g, "/");

/**
 * 取绝对 / 相对路径末尾段
 *
 * - 自动剥掉尾随 `/`（目录场景：`/foo/bar/` → `bar`）
 * - 没有 `/` 时返回原值（`abc.txt` → `abc.txt`）
 * - 全是 `/` 时返回 `/`（极端边界）
 * - Windows 路径（`D:\a\b.java`）→ 反斜杠当分隔符、返 `b.java`
 */
export const pathBasename = (p: string): string => {
  if (!p) return p;
  const cleaned = normalizeSeparators(p).replace(/\/+$/, "");
  if (cleaned.length === 0) return "/";
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) || cleaned : cleaned;
};

/**
 * 把「path:行号后缀」拆成 { path, line }
 *
 * AI 写 plan 时常用 `apps/foo/bar.vue:271-279` 表达「这段在 271-279 行」、Cursor 协议
 * 只支持 `:line` / `:line:column`、不支持范围、所以这里取**起始行**作为 cursor 跳转目标、
 * 用户点击跳到第 271 行、范围尾部用户在 IDE 自己看（差几行容易判断）。
 *
 * - `bar.vue` → { path: "bar.vue", line: undefined }
 * - `bar.vue:271` → { path: "bar.vue", line: 271 }
 * - `bar.vue:271-279` → { path: "bar.vue", line: 271 }
 * - `bar.vue:271:5`（line:col）→ { path: "bar.vue", line: 271 }（暂时忽略 col、Cursor 跳行就够）
 * - `bar.vue:54,81-84,99`（逗号分隔多段、agent 实际会写出来）→ { path: "bar.vue", line: 54 }
 * - `bar.vue:20-88, 189-210, 830-878`（逗号 + 空格、agent 也会写）→ { path: "bar.vue", line: 20 }
 * - `bar.vue:147-154、1350-1363`（中文顿号）→ { path: "bar.vue", line: 147 }
 * - 非数字后缀（如 `foo.vue:next`）→ 不拆、保留原样：{ path: "foo.vue:next", line: undefined }
 *
 * 多段行号必须能解析——否则整个后缀被当成文件名、生成的 cursor:// 链接指向
 * `index.tsx:54,81-84,99` 这种不存在的文件、用户点了 Cursor 报「路径不存在」（实测踩过、
 * prompt 约束了「每段补完整 path」（_shared.md 路径硬约束第 4 条）但 agent 写多段引用时
 * 仍会用逗号 / 顿号裸续接、防不住、前端宽容解析才稳）。
 * 分隔符宽容支持：半角逗号 / 中文顿号 / 连字符范围 / 冒号列号、分隔符后可带空格。
 */
const parsePathWithLine = (
  s: string,
): { path: string; line: number | undefined } => {
  const parsed = parsePathSegments(s);
  if (!parsed) return { path: s, line: undefined };
  return { path: parsed.path, line: parsed.segments[0].line };
};

/**
 * 单段行号引用：`text` 是原文段（如 `147-175`）、`line` 是该段起始行（147）、
 * `sep` 是该段**前面**的分隔符原文（首段为 `""`、后续段如 `、` / `, `）——
 * 渲染层按 sep + text 原样拼回、保证视觉跟 artifact 原文逐字一致。
 */
export interface PathLineSegment {
  text: string;
  line: number;
  sep: string;
}

export interface ParsedPathSegments {
  path: string;
  segments: PathLineSegment[];
}

/**
 * 把「path:多段行号」完整拆解（V0.6.28 加、配合 artifact-panel 多段分链接渲染）
 *
 * 跟 `parsePathWithLine` 的区别：那个只取首段起始行（buildIdeLink 用）、
 * 这个把**每一段**都拆出来——`studentSituation.vue:147-175、341-370、485-508`
 * 渲染成 3 个独立 cursor:// 链接、用户点哪段跳哪段（只能跳首段是用户实测痛点）。
 *
 * - `bar.vue:147-175、341-370` → { path: "bar.vue", segments: [{147-175 / 147 / ""}, {341-370 / 341 / "、"}] }
 * - `bar.vue:271` → { path: "bar.vue", segments: [{271 / 271 / ""}] }（单段、调用方走原单链接渲染）
 * - `bar.vue` / `bar.vue:next` → null（无行号后缀）
 */
export const parsePathSegments = (s: string): ParsedPathSegments | null => {
  // 首段允许 `271` / `271-279` / `271:5`（列号）、后续段用逗号 / 顿号分隔（后可带空格）
  const m = s.match(/^(.+?):(\d+(?:[-:]\d+)?(?:[,、]\s*\d+(?:[-:]\d+)?)*)$/);
  if (!m) return null;
  // split 保留分隔符捕获组：["147-175", "、", "341-370", ", ", "485-508"]
  const parts = m[2].split(/([,、]\s*)/);
  const segments: PathLineSegment[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    segments.push({
      text: parts[i],
      line: Number.parseInt(parts[i], 10),
      sep: i === 0 ? "" : parts[i - 1],
    });
  }
  return { path: m[1], segments };
};

/**
 * 判断 inline code 内容像不像「文件路径」
 *
 * 启发式规则（求覆盖、不求精确）：
 *   - 含 `/`、且最后一段含 `.`（扩展名）
 *   - 路径部分不能含空格 / 反引号 / 引号（这些通常是表达式不是路径）
 *   - 长度合理（< 200、避免误判超长字符串）
 *   - 末尾的行号后缀（含 `:20-88, 189-210` 这种逗号 + 空格多段）**不影响**识别——
 *     先剥掉再判断、空格校验只作用于剥完后的路径部分（否则多段行号引用整条丢失链接）
 *
 * 不动 markdown 原文、只在视图层把长路径里的目录置灰、文件名加粗、且包成 deep link。
 * 用户切「原文」视图能看到原始 path、复制粘贴也是 plain string、下游兼容。
 */
export const looksLikePath = (s: string): boolean => {
  if (!s || s.length > 200) return false;
  const { path } = parsePathWithLine(s);
  if (/\s|"|'|`/.test(path)) return false;
  // Windows 反斜杠路径（`D:\a\b.java` / `src\foo.ts`）归一化后按同一套规则判
  const normalized = normalizeSeparators(path);
  if (!normalized.includes("/")) return false;
  const lastSeg = normalized.slice(normalized.lastIndexOf("/") + 1);
  return lastSeg.length > 0 && lastSeg.includes(".");
};

/**
 * 判断 inline code 是不是「同 task 内 action artifact 引用」
 *
 * V0.6 命名约定（task-fs.ts 的 actionArtifactFilename）：`<N>-<actionType>.md`、N 是
 * ActionRecord.n 累计序号（不前导 0）、actionType 是 ActionType 枚举值。
 *
 * 命中返 `{ n, type }`、让调用方切到对应 action tab；不命中返 null。
 *
 * V0.6.0.1 加：允许可选的 `actions/` 前缀——因为 prompt 强约束 review / build agent 写
 * 「actions/<N>-<type>.md」相对路径形式（_super.md「Artifact 文件路径」段）、review artifact
 * 的「plan 拍板口径复核」表格列「plan 位置」普遍写成 `actions/5-plan.md`、不带前缀的也得支持
 * 兼容老用法。前缀只允许 `actions/`、其它前缀（如 `data/tasks/.../actions/...`）一律不命中、
 * 走 `looksLikePath`（fs 绝对路径场景）。
 *
 * 例：
 *   - `1-plan.md` → { n: 1, type: "plan" }
 *   - `actions/5-plan.md` → { n: 5, type: "plan" }（V0.6.0.1 新支持）
 *   - `2-build.md` → { n: 2, type: "build" }
 *   - `5-build.md` → { n: 5, type: "build" }（同 task 内多次 build）
 *   - `actions/4-ship.md` → { n: 4, type: "ship" }
 *   - `build #18` / `build#18` → { n: 18, type: "build" }（V0.6.29、「沿用 build #18」场景可点击跳转）
 *   - `apps/foo/bar.vue` → null（业务仓库文件路径、走 looksLikePath）
 *   - `data/tasks/xxx/actions/5-plan.md` → null（fs 绝对路径形式、走 looksLikePath）
 *   - `report.md` → null（无 N- 前缀）
 *   - `99-unknown.md` → null（type 不在 ACTION_TYPES）
 */
export interface ActionArtifactRef {
  n: number;
  type: ActionType;
}

export const looksLikeArtifactRef = (s: string): ActionArtifactRef | null => {
  if (!s || s.length > 60) return null;
  // 形态 1：artifact 文件名（`5-plan.md` / `actions/5-plan.md`）
  // 形态 2（V0.6.29）：`<type> #<n>` 口语引用（`build #18`、增量 build「沿用」清单用）
  let n: number;
  let type: string;
  const fileForm = s.match(/^(?:actions\/)?(\d+)-([a-z]+)\.md$/);
  if (fileForm) {
    n = Number(fileForm[1]);
    type = fileForm[2]!;
  } else {
    const refForm = s.match(/^([a-z]+) ?#(\d+)$/);
    if (!refForm) return null;
    type = refForm[1]!;
    n = Number(refForm[2]);
  }
  if (!Number.isFinite(n) || n < 1) return null;
  if (!(ACTION_TYPES as readonly string[]).includes(type)) return null;
  return { n, type: type as ActionType };
};

/**
 * 把路径转成 IDE deep link（点击在 IDE 打开、2026-06-12 起支持 Cursor / IDEA 双协议）
 *
 * - 已经是 url（http:// / cursor:// 等）→ 返 null（不动）
 * - 末尾带 `:line` / `:line-line` 行号后缀 → 拆出来、拼进协议（起始行）
 * - 绝对路径（`/` 起手、或 Windows 盘符 `D:\` / `D:/` 起手）→ 直接走、忽略 baseDir
 * - 相对路径 + 没传 baseDir → 返 null（拼不出绝对路径）
 * - 相对路径 + 有 baseDir → 跟 baseDir 拼绝对路径（baseDir 也可以是 Windows 路径）
 *
 * baseDir 语义（V0.5.9 改名、原叫 repoPath）：单仓 = 仓库路径、多仓 = 公共父目录（cwd）。
 * 多仓时 AI 写的路径首段是仓名（`projA/apps/foo/bar.vue`）、拼到 cwd 后就是绝对路径、跟单仓走同一套逻辑。
 *
 * encode 防中文 / 空格炸：split + map(encodeURIComponent) + join
 * 协议格式（ide 参数切换、默认 cursor）：
 * - cursor：`cursor://file/<encoded-abs-path>[:line]`（`:line` 不 encode、`%3A` Cursor 不认）
 * - idea：`idea://open?file=<encoded-abs-path>[&line=<line>]`（JetBrains Toolbox / IDE 内建协议）
 * Windows：`cursor://file/D:/IdeaProjects/...`（同 VS Code `vscode://file/c:/...` 约定、
 *   盘符段的 `:` 必须保留不 encode、否则 IDE 不认）
 */
/**
 * 把「路径（可带行号后缀）+ baseDir」解析成绝对路径 + 起始行（V0.11.8 从 buildIdeLink 抽出）。
 * deep link（buildIdeLink）和后端拉起（open-in-ide、JetBrains 系）共用同一套解析。
 * 解析不出（相对路径没 baseDir / 本身是 url）返 null。
 */
export const resolveIdeTarget = (
  pathLike: string,
  baseDir?: string,
): { absolute: string; line?: number } | null => {
  if (!pathLike) return null;
  if (/^[a-z]+:\/\//i.test(pathLike)) return null;
  const { path, line } = parsePathWithLine(pathLike);
  const normalized = normalizeSeparators(path);
  let absolute = normalized;
  if (!normalized.startsWith("/") && !isWindowsAbsPath(normalized)) {
    if (!baseDir) return null;
    const base = normalizeSeparators(baseDir).replace(/\/+$/, "");
    absolute = `${base}/${normalized.replace(/^\.?\/+/, "")}`;
  }
  return { absolute, line };
};

export const buildIdeLink = (
  pathLike: string,
  baseDir?: string,
  ide: JumpIde = "cursor",
  opts?: {
    /** 强制新窗口（开工作区目录用；文件跳转别传、应复用项目已开的窗口） */
    newWindow?: boolean;
  },
): string | null => {
  const target = resolveIdeTarget(pathLike, baseDir);
  if (!target) return null;
  const { absolute, line } = target;
  const encodedPath = absolute
    .split("/")
    // 首段是盘符（`D:`）时保留原样、`:` encode 了 IDE 不认
    .map((seg, i) =>
      i === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg),
    )
    .join("/");
  // POSIX 绝对路径自带前导 `/`、Windows 盘符路径要手动补一个（`cursor://file/D:/...`）
  const prefix = encodedPath.startsWith("/") ? "" : "/";
  if (ide === "idea" || ide === "webstorm") {
    // 注：JetBrains 协议只有装了 Toolbox 才注册——渲染层对 JetBrains 系应改走
    // 后端拉起（见 ide-open.ts getIdeAnchorProps）、这里保留仅作 fallback
    return line !== undefined
      ? `${ide}://open?file=${prefix}${encodedPath}&line=${line}`
      : `${ide}://open?file=${prefix}${encodedPath}`;
  }
  // cursor / vscode 同一套 `<scheme>://file/<path>[:line]` 约定；
  // windowId=_blank = VS Code 系 URL handler 的「新窗口」参数——不带的话打开目录
  // 会把当前活跃窗口的工作区直接换掉（用户实测点了正干活的窗口没了）
  const scheme = ide === "vscode" ? "vscode" : "cursor";
  const suffix = opts?.newWindow ? "?windowId=_blank" : "";
  return line !== undefined
    ? `${scheme}://file${prefix}${encodedPath}:${line}${suffix}`
    : `${scheme}://file${prefix}${encodedPath}${suffix}`;
};

/**
 * 多仓 task：判断「相对路径首段是不是任务里的某个仓」（2026-06-12 加）
 *
 * 背景：多仓 task 的 cursor 链接 = cwd（公共父目录）+ 相对路径、约定首段是仓名。
 * agent 偶发漏写仓名前缀（实测：ship artifact 写 `apps/...`、拼出 `wukong/apps/...`、
 * 点击弹「路径不存在」）——必 404 的链接比没有链接更误导（同 markdown-link 对幻觉链接的处理）、
 * 渲染层命中该情况时降级纯文本。
 *
 * - 绝对路径（POSIX / Windows 盘符）→ true（不参与本校验、baseDir 不参与拼接）
 * - repoShortNames 空 / undefined（单仓、调用方不传）→ true（不校验）
 * - 相对路径以任一 `<shortName>/` 开头（shortName 可多层、如 `group/projA`）→ true
 * - 其余 → false（视作漏了仓名前缀、调用方不渲染链接）
 */
export const hasValidRepoPrefix = (
  pathLike: string,
  repoShortNames: string[] | undefined,
): boolean => {
  if (!repoShortNames || repoShortNames.length === 0) return true;
  const { path } = parsePathWithLine(pathLike);
  const normalized = normalizeSeparators(path).replace(/^\.\/+/, "");
  if (normalized.startsWith("/") || isWindowsAbsPath(normalized)) return true;
  return repoShortNames.some(
    (name) => name !== "." && normalized.startsWith(`${name}/`),
  );
};

/**
 * 算多个绝对路径的公共父目录（V0.5.9 加）
 *
 * 实现：按 `/` 切段、取最长共同前缀段、再拼回。
 *
 * - 0 个 path → 返 `""`（调用方自己 fallback）
 * - 1 个 path → 返这个 path 本身（不上溯到父目录、给 `getEffectiveCwd` 提供原子语义）
 * - 2+ paths → 真正算公共目录
 *   - `['/a/b/c', '/a/b/d']` → `/a/b`
 *   - `['/a/b', '/a/b/c']` → `/a/b`
 *   - `['/a/x', '/b/y']` → `/`（极端、跨 home 的 case、宽松不报错）
 *   - `['D:\\a\\x', 'D:\\a\\y']` → `D:/a`（Windows、输出统一正斜杠）
 *   - `['C:\\x', 'D:\\y']` → `""`（跨盘符无公共目录、调用方 fallback）
 *
 * 注意：返值不带尾 slash（除非就是根目录 `/`、或裸盘符 `D:/`）。
 */
const getCommonParentDir = (paths: string[]): string => {
  if (paths.length === 0) return "";
  const norm = paths.map((p) =>
    normalizeSeparators(p).replace(/\/+$/, ""),
  );
  if (norm.length === 1) return norm[0];
  const segArrays = norm.map((p) => p.split("/"));
  const minLen = Math.min(...segArrays.map((arr) => arr.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const seg = segArrays[0][i];
    if (segArrays.every((arr) => arr[i] === seg)) {
      common.push(seg);
    } else {
      break;
    }
  }
  // 形如 ['', 'a', 'b'] → '/a/b'；['', ''] → '/'；[] → ''
  if (common.length === 0) return "";
  if (common.length === 1 && common[0] === "") return "/";
  // Windows 极端：只剩裸盘符（['D:']）→ 补 `/`、`D:` 是盘相对路径语义、当 cwd 会出错
  if (common.length === 1 && /^[a-zA-Z]:$/.test(common[0])) {
    return `${common[0]}/`;
  }
  return common.join("/");
};

/**
 * 算 task 的「effective cwd」——SDK Run 起 agent 用的 cwd（V0.5.9 加）
 *
 * - 单仓（repoPaths.length === 1）→ 仓库自身、保留 V0.5.9 前的行为（AI 写 `apps/foo/...` 从仓库根起算）
 * - 多仓 → `getCommonParentDir(repoPaths)`、AI 视角下面挂 N 个 git 仓子目录、写路径首段是仓名
 *
 * 空数组 fallback 返 `""`、调用方应该在更上层校验非空（API schema / UI 必填）。
 */
export const getEffectiveCwd = (repoPaths: string[]): string => {
  // V0.6：repoPaths 空（自由聊 / 调研类 task）→ fallback process.cwd()
  //   server 端 process.cwd() = ai-flow 项目自己、agent 起在这里至少有合法 cwd
  if (repoPaths.length === 0) {
    return typeof process !== "undefined" ? process.cwd() : "";
  }
  // Windows 路径归一化成正斜杠（Node spawn cwd / prompt 展示都接受、且下游
  // getRepoShortNames / buildIdeLink 的字符串比对全按 `/` 走、必须统一）
  if (repoPaths.length === 1) {
    return normalizeSeparators(repoPaths[0]).replace(/\/+$/, "");
  }
  return getCommonParentDir(repoPaths);
};

/**
 * 算每个 repo 相对 effective cwd 的「短名」（V0.5.9 加、多仓 prompt 用）
 *
 * 例：
 *   repoPaths = ['/Users/foo/work/projA', '/Users/foo/work/projB']
 *   cwd = '/Users/foo/work'
 *   → ['projA', 'projB']
 *
 * 单仓不调这个（cwd 就是仓库自身、短名等于 "."、prompt 也不用列）。
 * export 给 task 详情页算 ArtifactPanel 的 repoShortNames（多仓路径前缀校验）用。
 */
/**
 * 逐仓算「目录短名」= basename、重名追加序号去重（V0.10、client + server 共用）
 *
 * 语义：task 隔离工作区（git worktree）里每个仓的子目录名——
 * server 端 task-worktrees 用它定 worktree 路径、client 端 task 详情页用它做
 * 多仓 artifact 路径前缀校验（隔离 task 的 cwd 是 worktrees/<taskId>、原仓库路径
 * 不在其下、getRepoShortNames 算不出短名）。确定性：只由 repoPaths 顺序决定。
 */
export const getUniqueRepoDirNames = (repoPaths: string[]): string[] => {
  // 探重循环而不是「第 N 次出现拼 -N」：后者会跟真实目录名撞车
  //（如 [web, web, web-2] → web / web-2 / web-2、两仓映射同一目录）
  const taken = new Set<string>();
  return repoPaths.map((p) => {
    const base =
      normalizeSeparators(p).replace(/\/+$/, "").split("/").filter(Boolean).pop() ||
      "repo";
    let name = base;
    let i = 2;
    while (taken.has(name)) name = `${base}-${i++}`;
    taken.add(name);
    return name;
  });
};

/**
 * 逐仓算「IDE 该打开的项目目录」（V0.12.3、client 用）
 *
 * 背景：任务页「在 IDE 打开」原来传 task.workCwd——多仓任务时那是**公共父目录**
 * （如 D:/IdeaProjects），IDEA 会把整个父目录当一个项目打开（同事 Windows 实测）。
 * 正确语义是逐仓打开各自的项目根：
 * - 隔离 task 多仓：worktrees/<taskId>/<仓短名>（跟 server 端 worktree 布局一致）
 * - 隔离 task 单仓：workCwd 自身就是该仓 worktree
 * - 非隔离：原仓库路径本身（多仓时绝不给公共父目录）
 * - 非 git 目录（读 nonGitRepoPaths 快照）：隔离与否都直接用原路径、不拼进 workCwd
 *
 * @param nonGitRepoPaths 任务落库的非 git 清单；undefined = 全 git（老任务）
 */
export const getRepoWorkDirs = (
  repoPaths: string[],
  workCwd: string,
  isolated: boolean,
  nonGitRepoPaths?: readonly string[],
): Array<{ repoPath: string; workDir: string; shortName: string }> => {
  const names = getUniqueRepoDirNames(repoPaths);
  const base = normalizeSeparators(workCwd).replace(/\/+$/, "");
  const nonGitSet = new Set(nonGitRepoPaths ?? []);
  // 隔离 cwd 只对 git 仓聚合：唯一 git 仓时 workCwd = 该 worktree 自身（不是容器）
  const gitCount = repoPaths.filter((p) => !nonGitSet.has(p)).length;
  return repoPaths.map((repoPath, i) => {
    const shortName = names[i];
    const original = normalizeSeparators(repoPath).replace(/\/+$/, "");
    let workDir: string;
    if (nonGitSet.has(repoPath)) {
      // 非 git：不参与 worktree 布局、IDE 直接开原目录
      workDir = original;
    } else if (!isolated) {
      workDir = repoPaths.length === 1 ? base : original;
    } else if (gitCount <= 1) {
      // 隔离且至多一个 git 仓：workCwd 就是该 worktree
      workDir = base;
    } else {
      workDir = `${base}/${names[i]}`;
    }
    return { repoPath, shortName, workDir };
  });
};

export const getRepoShortNames = (
  repoPaths: string[],
  cwd: string,
): string[] => {
  const base = normalizeSeparators(cwd).replace(/\/+$/, "");
  return repoPaths.map((p) => {
    const clean = normalizeSeparators(p).replace(/\/+$/, "");
    if (clean === base) return ".";
    if (clean.startsWith(`${base}/`)) return clean.slice(base.length + 1);
    // 极端：repoPath 不在 cwd 之下（跨父目录场景）、直接给绝对路径、让 AI 自己适配
    return clean;
  });
};

/**
 * 渲染「任务输入 - 仓库段」给 super-prompt 用（V0.5.9 加、plan/chat-runner 共用）
 *
 * 单仓 case：一行「仓库根目录（agent cwd）：xxx」
 * 多仓纯 git / 纯非 git：列公共父目录 + 每个仓路径 + 路径 / git 命令约束（现状不变）
 * 混合（git + 非 git）：先说明 agentCwd（调用方应传 getTaskCwd）、再逐仓绝对路径并标注种类
 *
 * 输入空数组时返「（未指定仓库）」、上层保证不会到这步（API schema + UI 校验）。
 *
 * @param opts.agentCwd 覆盖自动聚合的 cwd（混合隔离必传、否则 workPaths 会聚到 $HOME）
 * @param opts.nonGitRepoPaths 非 git 原路径清单
 * @param opts.originalRepoPaths 与 repoPaths 一一对应的原仓路径（隔离时 repoPaths 已是 workPaths）
 */
export const formatRepoSectionForPrompt = (
  repoPaths: string[],
  opts?: {
    agentCwd?: string;
    nonGitRepoPaths?: readonly string[];
    originalRepoPaths?: readonly string[];
  },
): string => {
  if (repoPaths.length === 0) return "（未指定仓库）";
  const originals = opts?.originalRepoPaths ?? repoPaths;
  const nonGitSet = new Set(opts?.nonGitRepoPaths ?? []);
  const isNonGitAt = (i: number): boolean =>
    nonGitSet.has(originals[i] ?? "");
  const hasNonGit = originals.some((_, i) => isNonGitAt(i));
  const hasGit = originals.some((_, i) => !isNonGitAt(i));
  // 混合：不能再用「公共父下挂 N 个 git 子目录」模板（父会漂到 $HOME）
  const mixed = repoPaths.length > 1 && hasNonGit && hasGit;
  const cwd = opts?.agentCwd ?? getEffectiveCwd(repoPaths);

  if (repoPaths.length === 1) {
    return `仓库根目录（agent cwd）：\`${cwd}\``;
  }

  if (mixed) {
    return [
      `**agent cwd**：\`${cwd}\``,
      "",
      // 标注用中性的「git 仓库」：chat / 非隔离任务也走本模板、路径是原仓不是隔离工作区、别写死「隔离」误导
      `**绑定 ${repoPaths.length} 个目录**（混合：git 仓库 + 非 git 目录；非 git 请用绝对路径访问）：`,
      ...repoPaths.map((p, i) => {
        const kind = isNonGitAt(i) ? "非 git 目录" : "git 仓库";
        return `  - \`${p}\`（${kind}）`;
      }),
      "",
      "**路径写法**：git 仓内文件可相对 agent cwd / 该仓根目录；非 git 目录一律用绝对路径。",
      "",
      "**git 命令**：只在标注为 git 仓库的目录里跑；非 git 目录无分支 / 无 git。",
    ].join("\n");
  }

  const shortNames = getRepoShortNames(repoPaths, cwd);
  const sampleRepo = shortNames[0] ?? "projA";
  return [
    `**agent cwd**：\`${cwd}\`（⚠️ 这是公共父目录、本身不是 git 仓库、跑 \`git\` 命令必报错）`,
    "",
    `**下挂 ${repoPaths.length} 个 git 仓库子目录**：`,
    ...repoPaths.map((p, i) => `  - \`${shortNames[i]}\` → \`${p}\``),
    "",
    `**路径写法约束（V0.5.9 多仓场景）**：所有 file path 从 cwd 起算、首段是仓子目录名（例 \`${sampleRepo}/path/to/file.vue\`）；不要从仓自身根起算（少了仓名前缀、cursor 链接定位错）。`,
    "",
    `**git 命令必须 cd 到对应仓子目录**：例 \`cd ${sampleRepo} && git diff HEAD\`、不要在 cwd 直接跑（公共父目录不是 git 仓库）。`,
  ].join("\n");
};
