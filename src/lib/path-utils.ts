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

import { PHASE_IDS, type PhaseId } from "./types";

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
 * 把「path[:line[-endLine]]」拆成 { path, line }
 *
 * AI 写 plan 时常用 `apps/foo/bar.vue:271-279` 表达「这段在 271-279 行」、Cursor 协议
 * 只支持 `:line` / `:line:column`、不支持范围、所以这里取**起始行**作为 cursor 跳转目标、
 * 用户点击跳到第 271 行、范围尾部用户在 IDE 自己看（差几行容易判断）。
 *
 * - `bar.vue` → { path: "bar.vue", line: undefined }
 * - `bar.vue:271` → { path: "bar.vue", line: 271 }
 * - `bar.vue:271-279` → { path: "bar.vue", line: 271 }
 * - `bar.vue:271:5`（line:col）→ { path: "bar.vue", line: 271 }（暂时忽略 col、Cursor 跳行就够）
 * - 非数字后缀（如 `foo.vue:next`）→ 不拆、保留原样：{ path: "foo.vue:next", line: undefined }
 *
 * 只匹配最后一个冒号段、避免误伤路径中间的冒号（Windows `C:` 之类、虽然这套 codebase 走 unix）
 */
const parsePathWithLine = (
  s: string,
): { path: string; line: number | undefined } => {
  const m = s.match(/^(.+?):(\d+)(?:[-:]\d+)?$/);
  if (!m) return { path: s, line: undefined };
  return { path: m[1], line: Number(m[2]) };
};

/**
 * 判断 inline code 内容像不像「文件路径」
 *
 * 启发式规则（求覆盖、不求精确）：
 *   - 含 `/`、且最后一段含 `.`（扩展名）
 *   - 不能含空格 / 反引号 / 引号（这些通常是表达式不是路径）
 *   - 长度合理（< 200、避免误判超长字符串）
 *   - 末尾的 `:line` / `:line-line` 行号后缀**不影响**识别——先剥掉再判断
 *
 * 不动 markdown 原文、只在视图层把长路径里的目录置灰、文件名加粗、且包成 deep link。
 * 用户切「原文」视图能看到原始 path、复制粘贴也是 plain string、下游兼容。
 */
export const looksLikePath = (s: string): boolean => {
  if (!s || s.length > 200) return false;
  if (/\s|"|'|`/.test(s)) return false;
  if (!s.includes("/")) return false;
  const { path } = parsePathWithLine(s);
  const lastSeg = path.slice(path.lastIndexOf("/") + 1);
  return lastSeg.length > 0 && lastSeg.includes(".");
};

/**
 * 判断 inline code 是不是「同 task 内 artifact 引用」
 *
 * 命名约定（task-fs.ts 的 phaseArtifactFilename）：`<NN>-<phaseId>.md`、NN 是 phase 在
 * workflow 里的位置（2 位补零）、phaseId 是 PhaseId 枚举值。
 *
 * 命中返 PhaseId（让调用方切到对应 phase tab）、不命中返 null。
 *
 * 返 phaseId 而不返序号——序号会随 workflow 增删 phase 漂移、phaseId 是稳态锚点。
 * AI prompt 里写 `02-build.md` 引用 build artifact、用户切 tab 时按 phaseId 找就好、
 * 序号 02 只参与正则匹配、不暴露给调用方。
 *
 * 例：
 *   - `01-plan.md` → "plan"
 *   - `02-build.md` → "build"
 *   - `03-review.md` → "review"
 *   - `apps/foo/bar.vue` → null（含 / 是文件路径、走 looksLikePath）
 *   - `report.md` → null（无 NN- 前缀）
 *   - `99-unknown.md` → null（phaseId 不在 PHASE_IDS 里）
 */
export const looksLikeArtifactRef = (s: string): PhaseId | null => {
  if (!s || s.length > 50) return null;
  const m = s.match(/^\d{2}-([a-z]+)\.md$/);
  if (!m) return null;
  const phaseId = m[1];
  return (PHASE_IDS as readonly string[]).includes(phaseId)
    ? (phaseId as PhaseId)
    : null;
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
export const getCommonParentDir = (paths: string[]): string => {
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
  if (repoPaths.length === 0) return "";
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
export const getRepoShortNames = (
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
