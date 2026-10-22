/**
 * F3-02「损坏任务只暴露不展示」：把 GET /api/tasks 的 `corrupt` 字段真正展示给用户。
 *
 * 链路：服务端 listTasksWithCorrupt → 路由 `corrupt` 字段 → task-store.fetchTaskList（规整）
 *      → useTaskList().corrupt → 侧栏底部 <CorruptTasksNotice>（文案来自 describeCorruptTask）。
 * 行为靠纯函数测（normalizeCorruptTasks / sameCorruptTasks / describeCorruptTask）；
 * 接线靠源码契约钉（UI 在 node 环境跑不起来）。弱保护：没有在浏览器里看过实际样子。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  normalizeCorruptTasks,
  sameCorruptTasks,
  type CorruptTaskInfo,
} from "@/lib/corrupt-task";
import {
  CORRUPT_REASON_MAX_CHARS,
  corruptSummaryText,
  describeCorruptTask,
} from "@/lib/corrupt-task-display";

const META = "/data/tasks/t-1/meta.json";
const mk = (over: Partial<CorruptTaskInfo> = {}): CorruptTaskInfo => ({
  id: "t-1",
  kind: "invalid_json",
  reason: "meta.json 不是合法 JSON（位置 12）",
  metaPath: META,
  backupValid: false,
  ...over,
});

describe("normalizeCorruptTasks：响应里的 corrupt 字段 → 数组（永不抛）", () => {
  it("字段缺失 / null / 非数组（旧服务端、没有损坏时服务端不带字段）→ []", () => {
    expect(normalizeCorruptTasks(undefined)).toEqual([]);
    expect(normalizeCorruptTasks(null)).toEqual([]);
    expect(normalizeCorruptTasks({})).toEqual([]);
    expect(normalizeCorruptTasks("oops")).toEqual([]);
    expect(normalizeCorruptTasks([])).toEqual([]);
  });

  it("完整合法的条目原样保留", () => {
    const item = mk({ kind: "empty", backupValid: true });
    expect(normalizeCorruptTasks([item])).toEqual([item]);
  });

  it("没有 id 的条目丢弃（没法告诉用户是哪个任务）；非对象条目丢弃；其余不受影响", () => {
    const good = mk({ id: "ok" });
    expect(
      normalizeCorruptTasks([null, 1, "x", {}, { id: "" }, { id: "   " }, { id: 5 }, good]),
    ).toEqual([good]);
  });

  it("kind 不认识（服务端比本版本新）→ 当 read_error 保留，原因文案仍用服务端的", () => {
    const [x] = normalizeCorruptTasks([
      { id: "t", kind: "brand_new_kind", reason: "新类别的原因", metaPath: META, backupValid: true },
    ]);
    expect(x!.kind).toBe("read_error");
    expect(x!.reason).toBe("新类别的原因");
  });

  it("backupValid 不是布尔 → false（不承诺自动恢复）；reason / metaPath 缺失 → 空串", () => {
    const [x] = normalizeCorruptTasks([{ id: "t", kind: "empty", backupValid: "true" }]);
    expect(x).toEqual({
      id: "t",
      kind: "empty",
      reason: "",
      metaPath: "",
      backupValid: false,
    });
  });
});

describe("sameCorruptTasks：内容没变就沿用旧引用（轮询不白白重渲染）", () => {
  it("逐项相同 → true；空对空 → true", () => {
    expect(sameCorruptTasks([], [])).toBe(true);
    expect(sameCorruptTasks([mk()], [mk()])).toBe(true);
  });

  it("长度 / 任一字段不同 → false", () => {
    expect(sameCorruptTasks([mk()], [])).toBe(false);
    expect(sameCorruptTasks([mk()], [mk({ id: "t-2" })])).toBe(false);
    expect(sameCorruptTasks([mk()], [mk({ kind: "empty" })])).toBe(false);
    expect(sameCorruptTasks([mk()], [mk({ reason: "别的原因" })])).toBe(false);
    expect(sameCorruptTasks([mk()], [mk({ metaPath: "/x" })])).toBe(false);
    expect(sameCorruptTasks([mk()], [mk({ backupValid: true })])).toBe(false);
  });

  it("顺序不同也算不同（列表按服务端顺序展示）", () => {
    const a = mk({ id: "a" });
    const b = mk({ id: "b" });
    expect(sameCorruptTasks([a, b], [b, a])).toBe(false);
  });
});

describe("corruptSummaryText", () => {
  it("「N 个任务数据损坏」", () => {
    expect(corruptSummaryText(1)).toBe("1 个任务数据损坏");
    expect(corruptSummaryText(3)).toBe("3 个任务数据损坏");
  });
});

describe("describeCorruptTask：损坏条目 → 展示文案", () => {
  it("备份有效（内容损坏的三类）→ auto：说「重启应用会自动用备份恢复」、不给路径（别引导去手改）", () => {
    for (const kind of ["empty", "invalid_json", "schema_mismatch"] as const) {
      const d = describeCorruptTask(mk({ kind, backupValid: true }));
      expect(d.recoveryKind).toBe("auto");
      expect(d.recovery).toBe("重启应用会自动用备份恢复");
      expect(d.metaPath).toBeNull();
      expect(d.id).toBe("t-1");
    }
  });

  it("没有可用备份 → manual：说明要手动修复，并给出 metaPath", () => {
    for (const kind of ["empty", "invalid_json", "schema_mismatch"] as const) {
      const d = describeCorruptTask(mk({ kind, backupValid: false }));
      expect(d.recoveryKind).toBe("manual");
      expect(d.recovery).toContain("没有可用备份");
      expect(d.recovery).toContain("手动修复");
      expect(d.metaPath).toBe(META);
    }
  });

  it("read_error → retry：可能只是暂时故障，给路径；不说「自动恢复」", () => {
    const d = describeCorruptTask(
      mk({ kind: "read_error", reason: "读取 meta.json 失败（EACCES）", backupValid: false }),
    );
    expect(d.recoveryKind).toBe("retry");
    expect(d.recovery).toContain("暂时");
    expect(d.recovery).not.toContain("自动");
    expect(d.metaPath).toBe(META);
    expect(d.reason).toBe("读取 meta.json 失败（EACCES）");
  });

  it("read_error 即便 backupValid 被误标 true 也不承诺自动恢复（服务端不据此恢复，见 restoreMetaFromBackup）", () => {
    const d = describeCorruptTask(mk({ kind: "read_error", backupValid: true }));
    expect(d.recoveryKind).toBe("retry");
    expect(d.recovery).not.toContain("自动");
  });

  it("原因：压成单行；超长截断并以「…」收尾；不超过上限", () => {
    const multi = describeCorruptTask(mk({ reason: "第一行\n\n  第二行\t第三行" }));
    expect(multi.reason).toBe("第一行 第二行 第三行");

    const long = describeCorruptTask(
      mk({ kind: "schema_mismatch", reason: `meta.json 不符合当前 schema：${"a.b: Invalid; ".repeat(50)}` }),
    );
    expect(Array.from(long.reason)).toHaveLength(CORRUPT_REASON_MAX_CHARS);
    expect(long.reason.endsWith("…")).toBe(true);

    // 恰好等于上限不截
    const exact = "字".repeat(CORRUPT_REASON_MAX_CHARS);
    expect(describeCorruptTask(mk({ reason: exact })).reason).toBe(exact);
  });

  it("原因：服务端没给（空 / 全空白）→ 按类别兜底，永不为空", () => {
    expect(describeCorruptTask(mk({ kind: "empty", reason: "" })).reason).toBe("meta.json 是空文件");
    expect(describeCorruptTask(mk({ kind: "invalid_json", reason: "  " })).reason).toBe(
      "meta.json 不是合法 JSON",
    );
    expect(describeCorruptTask(mk({ kind: "schema_mismatch", reason: "" })).reason).toContain(
      "不符合当前版本",
    );
    expect(describeCorruptTask(mk({ kind: "read_error", reason: "" })).reason).toContain("读取");
  });

  it("需要路径但 metaPath 缺失（空串）→ null，不画空路径", () => {
    expect(describeCorruptTask(mk({ metaPath: "", backupValid: false })).metaPath).toBeNull();
    expect(describeCorruptTask(mk({ metaPath: "   ", backupValid: false })).metaPath).toBeNull();
  });

  it("不回显文件内容之外的东西：reason 原样来自服务端（只含类别 / 字段路径 / errno）", () => {
    const d = describeCorruptTask(mk({ reason: "meta.json 不符合当前 schema：repoStatus: Invalid option" }));
    expect(d.reason).toBe("meta.json 不符合当前 schema：repoStatus: Invalid option");
  });
});

// ---- 接线契约 ----

const repoDir = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("corrupt 接线契约：服务端 → 前端 → 侧栏", () => {
  it("路由：GET /api/tasks 把 corrupt 透传进响应（有损坏才带字段）", () => {
    const route = stripComments(read("src/app/api/tasks/route.ts"));
    expect(route).toMatch(/listed\.corrupt\.length > 0 \? \{ corrupt: listed\.corrupt \} : \{\}/);
  });

  it("task-store：fetchTaskList 返回 { tasks, corrupt } 且经 normalizeCorruptTasks 规整；fetchTasks 只是它的薄包装", () => {
    const store = stripComments(read("src/lib/task-store.ts"));
    expect(store).toContain("export const fetchTaskList");
    expect(store).toContain("normalizeCorruptTasks(data.corrupt)");
    expect(store).toMatch(/export const fetchTasks = async \(\): Promise<TaskSummary\[\]> =>\s*\(await fetchTaskList\(\)\)\.tasks/);
  });

  it("列表 hook：refresh 拉 fetchTaskList、成功时更新 corrupt（内容没变沿用旧引用）、失败分支不动它、context 导出 corrupt", () => {
    const hook = stripComments(read("src/hooks/use-task-list.tsx"));
    expect(hook).toContain("await fetchTaskList()");
    expect(hook).not.toContain("await fetchTasks()");
    expect(hook).toMatch(/setCorrupt\(\(prev\) =>\s*sameCorruptTasks\(prev, corruptList\) \? prev : corruptList/);
    // setCorrupt 只出现在 try 分支（紧邻 setLoadError(null)）——catch 里不许清空
    const catchIdx = hook.indexOf("} catch (err) {", hook.indexOf("await fetchTaskList()"));
    expect(catchIdx).toBeGreaterThan(-1);
    const afterCatch = hook.slice(catchIdx, hook.indexOf("} finally {", catchIdx));
    expect(afterCatch).not.toContain("setCorrupt");
    expect(hook).toMatch(/value=\{\{[\s\S]*\bcorrupt,/);
    expect(hook).toMatch(/\n\s*corrupt: CorruptTaskInfo\[\];/);
  });

  it("侧栏：从 useTaskList 取 corrupt，并在滚动区 <nav> 之后渲染 <CorruptTasksNotice corrupt={corrupt} listTrusted=… />", () => {
    const sidebar = stripComments(read("src/components/app-sidebar.tsx"));
    expect(sidebar).toMatch(/\bcorrupt,\s*\n[\s\S]*?\} = useTaskList\(\)/);
    expect(sidebar).toContain('import { CorruptTasksNotice } from "@/components/corrupt-tasks-notice"');
    const navEnd = sidebar.indexOf("</nav>");
    // Q8-04：同时传 listTrusted={loaded && !loadError}（空列表可信才清忽略记录）
    const noticeAt = sidebar.indexOf("<CorruptTasksNotice corrupt={corrupt} listTrusted={loaded && !loadError} />");
    expect(navEnd).toBeGreaterThan(-1);
    // 在 nav 之后（不随长列表滚走），且只渲染一处
    expect(noticeAt).toBeGreaterThan(navEnd);
    expect(sidebar.match(/<CorruptTasksNotice\b/g)).toHaveLength(1);
  });

  it("提示组件：没有损坏时 return null；文案走纯函数；用 Popover、不是红色大块", () => {
    const raw = read("src/components/corrupt-tasks-notice.tsx");
    const comp = stripComments(raw);
    // R9a-04：「全被忽略」也算没有（visible 是 corrupt 去掉已忽略的）
    expect(comp).toMatch(/if \(visible\.length === 0\) return null/);
    expect(comp).toContain("visibleCorruptTasks(corrupt, dismissed)");
    expect(comp).toContain("corruptSummaryText(items.length)");
    expect(comp).toContain("describeCorruptTask(info)");
    expect(comp).toContain("<Popover>");
    expect(comp).toContain("<PopoverContent");
    // 克制：警示只落在小图标上（warning 语义 token），不用 destructive / 裸红 / 整块底色
    expect(comp).not.toMatch(/destructive|red-\d|bg-warning|bg-destructive|border-warning/);
    // 需要手动处理时给路径 + 复制
    expect(comp).toContain("d.metaPath");
    expect(comp).toContain("<CopyButton");
    // R9a-04：可忽略（单条 + 全部）+ 能在文件夹中显示
    expect(comp).toContain("全部忽略");
    expect(comp).toContain("requestRevealLocalPath(");
  });
});

// ---- F3-02 尾巴：详情页 ----
//
// 事实核对（读码）：损坏 meta 的任务，详情接口 GET /api/tasks/[id]?tail=N 回的是 **503**，不是 404——
//   getTaskWithTailEvents → assertTaskReadable(id) 为 false（evaluateTaskVisibility：删除证据都明确非终态、
//   但 meta 读 unknown → "unavailable"）→ 返回 null → 路由走 taskVisibilityErrorResponse → unavailable ⇒ 503 temporarily_unavailable。
// 前端 classifyTaskDetailResult 把 503 归 error（不是 notFound），所以损坏任务落在页面的「加载失败」分支，
// 而不是「任务不存在」分支。联动因此接在 error 分支：命中 corrupt 时用损坏原因 + 恢复说明替换那句干巴巴的
// 「加载任务失败：temporarily_unavailable」。notFound（404 / 410 = 服务端确定没有 / 已删）不接——
// 那里再查 corrupt 列表，会让一条过期的损坏记录盖过服务端「确定已删」的结论。

describe("详情页接线：损坏任务不再下「不存在 / 加载失败」的泛泛结论（F3-02 尾巴）", () => {
  it("事实：损坏 → 503 → 归 error 分支；404 / 410 才是 notFound", async () => {
    const { classifyLoadError, classifyTaskDetailResult } = await import("@/lib/load-outcome");
    expect(classifyLoadError({ status: 503, message: "temporarily_unavailable" }).kind).toBe("error");
    expect(classifyLoadError({ status: 404 }).kind).toBe("notFound");
    expect(classifyLoadError({ status: 410 }).kind).toBe("notFound");
    expect(classifyTaskDetailResult({ task: null }).kind).toBe("notFound");
  });

  it("事实：服务端对「meta 损坏」的任务确实回 503（visibility=unavailable → 503），而不是 404", () => {
    const fs = stripComments(read("src/lib/server/task-fs.ts"));
    // meta 读 unknown → unavailable（metaUnknown=true 正是 listTasksWithCorrupt 暴露 corrupt 的判据）
    expect(fs).toMatch(/if \(meta\.kind === "unknown"\) \{[\s\S]*?return \{ visibility: "unavailable", metaUnknown: true \};/);
    // unavailable → 503
    expect(fs).toMatch(/if \(v === "unavailable"\) \{\s*return NextResponse\.json\(\s*\{ error: "temporarily_unavailable" \},\s*\{ status: 503 \}/);
    // 详情路由：读不到（含不可读）→ taskVisibilityErrorResponse
    const route = stripComments(read("src/app/api/tasks/[id]/route.ts"));
    expect(route).toMatch(/if \(!task\) \{\s*return taskVisibilityErrorResponse\(id\);/);
  });

  it("页面：从 useTaskList 取 corrupt，在「加载失败」分支用 corrupt.find(c => c.id === id) 命中 → describeCorruptTask", () => {
    const page = stripComments(read("src/app/tasks/[id]/page.tsx"));
    expect(page).toMatch(/const \{ upsertTask, corrupt \} = useTaskList\(\);/);
    expect(page).toContain('import { describeCorruptTask } from "@/lib/corrupt-task-display"');
    expect(page).toMatch(/corrupt\.find\(\(c\) => c\.id === id\)/);

    const failAt = page.indexOf("if (!task && loadFailure) {");
    const notFoundAt = page.indexOf("if (!task) {", failAt + 10);
    expect(failAt).toBeGreaterThan(-1);
    expect(notFoundAt).toBeGreaterThan(failAt);
    const failBranch = page.slice(failAt, notFoundAt);
    expect(failBranch).toContain("describeCorruptTask(corruptInfo)");
    // 命中时画原因 + 恢复说明；需要手动修复 / 排查时给 metaPath + 复制（与侧栏弹层同口径）
    expect(failBranch).toContain("corruptView.reason");
    expect(failBranch).toContain("corruptView.recovery");
    expect(failBranch).toContain("corruptView.metaPath");
    expect(failBranch).toContain("<CopyButton");
    // 命中时不再说「加载任务失败：」
    expect(failBranch).toMatch(/corruptView \? \(/);
    expect(failBranch).toContain("加载任务失败：");
  });

  it("页面：notFound 分支（404 / 410 确定没有）不查 corrupt，仍是「任务不存在或已删除」", () => {
    const page = stripComments(read("src/app/tasks/[id]/page.tsx"));
    const notFoundAt = page.indexOf("if (!task) {", page.indexOf("if (!task && loadFailure) {") + 10);
    const branch = page.slice(notFoundAt, notFoundAt + 600);
    expect(branch).toContain("任务不存在或已删除");
    expect(branch).not.toContain("corrupt");
  });
});
