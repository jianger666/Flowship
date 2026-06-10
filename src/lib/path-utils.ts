/**
 * 路径相关工具（客户端可用、不依赖 node:path）
 *
 * 抽出来的动机：
 * - `pathBasename` / `basename` 在 event-stream / artifact-panel 多个组件里各自定义、
 *   实现细节漂移（带不带「去尾 slash」逻辑）。一处抽完所有点都走它。
 * - `buildCursorLink` 在 artifact-panel 有完整版（拼 repoPath）、event-stream 有简化版
 *   （只接绝对路径）。合并成一个、repoPath 缺省时按已经是绝对路径走。
 * - `looksLikePath` 是 markdown 渲染时「这个 inline code 像不像文件路径」的启发式判断、
 *   未来文件 / 路径渲染逻辑可能复用、放这里收口。
 * - `looksLikeArtifactRef`（V0.5.8 加）跟 `looksLikePath` 互斥：识别「inline code 是不是
 *   同 task 内 artifact 引用」（`01-plan.md` / `02-build.md` / `03-review.md`）、命中
 *   走 task 内 tab 切换、不走 cursor:// 跳转。
 *
 * 注意：前端组件不能用 `node:path` / `node:url`、手写就行、量很小。
 */

import { ACTION_TYPES, type ActionType } from "./types";

/**
 * 取绝对 / 相对路径末尾段
 *
 * - 自动剥掉尾随 `/`（目录场景：`/foo/bar/` → `bar`）
 * - 没有 `/` 时返回原值（`abc.txt` → `abc.txt`）
 * - 全是 `/` 时返回 `/`（极端边界）
 */
export const pathBasename = (p: string): string => {
  if (!p) return p;
  const cleaned = p.replace(/\/+$/, "");
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
 * 跟 `parsePathWithLine` 的区别：那个只取首段起始行（buildCursorLink 用）、
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
  if (!path.includes("/")) return false;
  const lastSeg = path.slice(path.lastIndexOf("/") + 1);
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
  const m = s.match(/^(?:actions\/)?(\d+)-([a-z]+)\.md$/);
  if (!m) return null;
  const n = Number(m[1]);
  const type = m[2];
  if (!Number.isFinite(n) || n < 1) return null;
  if (!(ACTION_TYPES as readonly string[]).includes(type)) return null;
  return { n, type: type as ActionType };
};

/**
 * 把路径转成 cursor:// deep link（点击在 IDE 打开）
 *
 * - 已经是 url（http:// / cursor:// 等）→ 返 null（不动）
 * - 末尾带 `:line` / `:line-line` 行号后缀 → 拆出来、cursor 协议拼 `:line`（起始行）
 * - 绝对路径（`/` 起手）→ 直接走、忽略 baseDir
 * - 相对路径 + 没传 baseDir → 返 null（拼不出绝对路径）
 * - 相对路径 + 有 baseDir → 跟 baseDir 拼绝对路径
 *
 * baseDir 语义（V0.5.9 改名、原叫 repoPath）：单仓 = 仓库路径、多仓 = 公共父目录（cwd）。
 * 多仓时 AI 写的路径首段是仓名（`projA/apps/foo/bar.vue`）、拼到 cwd 后就是绝对路径、跟单仓走同一套逻辑。
 *
 * encode 防中文 / 空格炸：split + map(encodeURIComponent) + join
 * 协议格式：`cursor://file/<encoded-abs-path>[:line]`
 *
 * 注意：`:line` 后缀不参与 encodeURIComponent、否则 `:` 会被 encode 成 `%3A`、Cursor 不认。
 */
export const buildCursorLink = (
  pathLike: string,
  baseDir?: string,
): string | null => {
  if (!pathLike) return null;
  if (/^[a-z]+:\/\//i.test(pathLike)) return null;
  const { path, line } = parsePathWithLine(pathLike);
  let absolute = path;
  if (!path.startsWith("/")) {
    if (!baseDir) return null;
    const base = baseDir.replace(/\/+$/, "");
    absolute = `${base}/${path.replace(/^\.?\/+/, "")}`;
  }
  const encodedPath = absolute
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return line !== undefined
    ? `cursor://file${encodedPath}:${line}`
    : `cursor://file${encodedPath}`;
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
 *
 * 注意：返值不带尾 slash（除非就是根目录 `/`）。
 */
const getCommonParentDir = (paths: string[]): string => {
  if (paths.length === 0) return "";
  if (paths.length === 1) return paths[0].replace(/\/+$/, "");
  const segArrays = paths.map((p) =>
    p.replace(/\/+$/, "").split("/"),
  );
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
  //   server 端 process.cwd() = fe-ai-flow 项目自己、agent 起在这里至少有合法 cwd
  if (repoPaths.length === 0) {
    return typeof process !== "undefined" ? process.cwd() : "";
  }
  if (repoPaths.length === 1) return repoPaths[0].replace(/\/+$/, "");
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
 */
const getRepoShortNames = (
  repoPaths: string[],
  cwd: string,
): string[] => {
  const base = cwd.replace(/\/+$/, "");
  return repoPaths.map((p) => {
    const clean = p.replace(/\/+$/, "");
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
 * 多仓 case：列公共父目录 + 每个仓的子目录路径 + 路径 / git 命令约束说明
 *
 * 输入空数组时返「（未指定仓库）」、上层保证不会到这步（API schema + UI 校验）。
 */
export const formatRepoSectionForPrompt = (repoPaths: string[]): string => {
  if (repoPaths.length === 0) return "（未指定仓库）";
  const cwd = getEffectiveCwd(repoPaths);
  if (repoPaths.length === 1) {
    return `仓库根目录（agent cwd）：\`${cwd}\``;
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
