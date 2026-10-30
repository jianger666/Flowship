/**
 * 工作台看板点已归档任务的那条排期：先恢复再进入（用户实测：归档了的需求还能从工作台点进去，
 * 进去能聊、但侧栏里没有它——它还是归档态）。
 *
 * 三层：
 *  1. planBoardOpen：点条目去哪（纯函数，表驱动）；
 *  2. openBoardItem：完整流程（依赖全部注入的假件，断言调用顺序——先标记 → PATCH → 回灌 → 提示 → 放闸 → 最后才跳转）；
 *  3. 接线：feishu-board 的点击回调必须走 openBoardItem、不能再绕过它直接 push 缓存里的任务。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  openBoardItem,
  planBoardOpen,
  type BoardOpenItem,
  type OpenBoardItemDeps,
} from "@/lib/board-open";
import type { Task } from "@/lib/types";
import type { ArchiveReport } from "@/lib/worktree-report";

const row = (
  id: string,
  over: { title?: string; pinned?: boolean; archived?: boolean } = {},
) => ({ id, title: over.title ?? `任务-${id}`, pinned: over.pinned, archived: over.archived });

const item = (over: Partial<BoardOpenItem> = {}): BoardOpenItem => ({
  id: "S1",
  name: "【数英满班率】组班",
  projectKey: "proj",
  url: "https://example.com/proj/story/detail/S1",
  task: { id: "t1" },
  ...over,
});

describe("planBoardOpen：点条目去哪", () => {
  const ok = { loaded: true, loadError: null };

  it("没挂任务 → 预览页", () => {
    expect(planBoardOpen({ task: null, liveTasks: [row("t1")], ...ok })).toEqual({ kind: "preview" });
    expect(planBoardOpen({ task: undefined, liveTasks: [row("t1")], ...ok })).toEqual({ kind: "preview" });
  });

  it("任务在实时列表里、未归档 → 直进", () => {
    expect(planBoardOpen({ task: { id: "t1" }, liveTasks: [row("t1")], ...ok })).toEqual({
      kind: "enter",
      taskId: "t1",
    });
    // archived 显式 false（后端清标记前的旧快照形态）也算未归档
    expect(
      planBoardOpen({ task: { id: "t1" }, liveTasks: [row("t1", { archived: false })], ...ok }),
    ).toEqual({ kind: "enter", taskId: "t1" });
  });

  it("任务在实时列表里、已归档 → 先恢复（带上标题 / 置顶，toast 与置顶序要用）", () => {
    const plan = planBoardOpen({
      task: { id: "t1" },
      liveTasks: [row("t0"), row("t1", { archived: true, title: "组班", pinned: true })],
      ...ok,
    });
    expect(plan).toEqual({
      kind: "restore",
      task: { id: "t1", title: "组班", pinned: true, archived: true },
    });
  });

  it("只认 id：别的任务归档了不影响这条", () => {
    expect(
      planBoardOpen({
        task: { id: "t1" },
        liveTasks: [row("t1"), row("t2", { archived: true })],
        ...ok,
      }),
    ).toEqual({ kind: "enter", taskId: "t1" });
  });

  it("不在实时列表里、列表已就绪 → 当任务已被删：预览页（不盲信缓存映射，盲跳会 404）", () => {
    expect(planBoardOpen({ task: { id: "gone" }, liveTasks: [row("t1")], ...ok })).toEqual({
      kind: "preview",
    });
    expect(planBoardOpen({ task: { id: "gone" }, liveTasks: [], ...ok })).toEqual({ kind: "preview" });
  });

  it("列表还没加载完 / 首拉失败（拿不到实时校验）→ 信缓存映射直进（旧行为保留）", () => {
    expect(
      planBoardOpen({ task: { id: "t1" }, liveTasks: [], loaded: false, loadError: null }),
    ).toEqual({ kind: "enter", taskId: "t1" });
    expect(
      planBoardOpen({ task: { id: "t1" }, liveTasks: [], loaded: true, loadError: "HTTP 500" }),
    ).toEqual({ kind: "enter", taskId: "t1" });
  });

  it("有旧数据时后台刷新失败仍按实时列表判（与 shouldTrustCachedTaskLink 同口径）", () => {
    expect(
      planBoardOpen({ task: { id: "gone" }, liveTasks: [row("t1")], loaded: true, loadError: "HTTP 500" }),
    ).toEqual({ kind: "preview" });
  });
});

// ---------- 流程 ----------

const makeTask = (id: string, over: Record<string, unknown> = {}): Task =>
  ({ id, title: `任务-${id}`, ...over }) as unknown as Task;

interface Rig {
  deps: OpenBoardItemDeps;
  log: string[];
}

const makeRig = (over: Partial<OpenBoardItemDeps> = {}): Rig => {
  const log: string[] = [];
  const deps: OpenBoardItemDeps = {
    push: (url) => {
      log.push(`push ${url}`);
    },
    setArchived: async (id, archived) => {
      log.push(`setArchived ${id} ${String(archived)}`);
      return { task: makeTask(id) };
    },
    markArchiving: (id, expectArchived) => {
      log.push(`mark ${id} ${String(expectArchived)}`);
    },
    unmarkArchiving: (id) => {
      log.push(`unmark ${id}`);
    },
    upsertTask: (t) => {
      log.push(`upsert ${t.id} archived=${String((t as { archived?: boolean }).archived)}`);
    },
    restorePinnedOrder: (id) => {
      log.push(`pin ${id}`);
    },
    notifySuccess: (m) => {
      log.push(`ok ${m}`);
    },
    notifyError: (m) => {
      log.push(`err ${m}`);
    },
    restoring: new Set(),
    ...over,
  };
  return { deps, log };
};

const archivedView = (over: { title?: string; pinned?: boolean } = {}) => ({
  tasks: [row("t1", { archived: true, title: over.title ?? "组班", pinned: over.pinned })],
  loaded: true,
  loadError: null,
});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("openBoardItem：已归档先恢复再进", () => {
  it("顺序：先标记「恢复中」→ PATCH archived:false → 回灌列表 → 提示 → 放闸 → 最后才跳转", async () => {
    const { deps, log } = makeRig();
    await openBoardItem(item(), archivedView(), deps);
    expect(log).toEqual([
      "mark t1 false",
      "setArchived t1 false",
      "upsert t1 archived=undefined",
      "ok 已恢复「组班」",
      "unmark t1",
      "push /tasks/t1",
    ]);
    expect(deps.restoring.size).toBe(0);
  });

  it("置顶任务：置顶序接回（紧跟回灌之后、提示之前）；没置顶不动置顶序", async () => {
    const pinned = makeRig();
    await openBoardItem(item(), archivedView({ pinned: true }), pinned.deps);
    expect(pinned.log.indexOf("pin t1")).toBe(pinned.log.indexOf("upsert t1 archived=undefined") + 1);
    expect(pinned.log.indexOf("pin t1")).toBeLessThan(pinned.log.findIndex((l) => l.startsWith("ok ")));

    const plain = makeRig();
    await openBoardItem(item(), archivedView(), plain.deps);
    expect(plain.log.some((l) => l.startsWith("pin "))).toBe(false);
  });

  it("服务端回报恢复了定时：提示里说出来（取服务端回报，不自己编）", async () => {
    const report: ArchiveReport = { cancelledSchedules: 0, restoredSchedules: 2 };
    const { deps, log } = makeRig({
      setArchived: async (id) => ({ task: makeTask(id), report }),
    });
    await openBoardItem(item(), archivedView(), deps);
    expect(log).toContain("ok 已恢复「组班」、2 个定时已恢复");
  });

  it("恢复失败：弹错、放闸、留在看板（不跳转、不回灌、不报成功），可以再点一次", async () => {
    const { deps, log } = makeRig({
      setArchived: async () => {
        throw new Error("boom");
      },
    });
    await openBoardItem(item(), archivedView(), deps);
    expect(log).toEqual(["mark t1 false", "err 恢复失败：boom", "unmark t1"]);
    expect(deps.restoring.size).toBe(0);

    // 再点一次：闸已放，请求会重新发出
    const second = makeRig({ restoring: deps.restoring });
    await openBoardItem(item(), archivedView(), second.deps);
    expect(second.log).toContain("push /tasks/t1");
  });

  it("恢复失败（非 Error 的拒因）也说得出原因", async () => {
    const { deps, log } = makeRig({
      setArchived: () => Promise.reject("nope"),
    });
    await openBoardItem(item(), archivedView(), deps);
    expect(log).toContain("err 恢复失败：nope");
    expect(log.some((l) => l.startsWith("push "))).toBe(false);
  });

  it("回灌 / 提示这类后续步骤抛错：同样当失败处理，闸必须放", async () => {
    const { deps, log } = makeRig({
      upsertTask: () => {
        throw new Error("upsert 炸了");
      },
    });
    await openBoardItem(item(), archivedView(), deps);
    expect(log).toContain("err 恢复失败：upsert 炸了");
    expect(log).toContain("unmark t1");
    expect(log.some((l) => l.startsWith("push "))).toBe(false);
    expect(deps.restoring.size).toBe(0);
  });

  it("请求在途时不跳转；连点同一条只发一次请求、只弹一次提示、只跳一次", async () => {
    const d = deferred<{ task: Task }>();
    const { deps, log } = makeRig({
      setArchived: (id) => {
        log.push(`setArchived ${id} false`);
        return d.promise;
      },
    });
    const first = openBoardItem(item(), archivedView(), deps);
    const second = openBoardItem(item(), archivedView(), deps);
    await second; // 第二下被闸拦住、立即结束
    expect(log).toEqual(["mark t1 false", "setArchived t1 false"]);
    expect(deps.restoring.has("t1")).toBe(true);

    d.resolve({ task: makeTask("t1") });
    await first;
    expect(log.filter((l) => l.startsWith("setArchived"))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("ok "))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("push "))).toEqual(["push /tasks/t1"]);
    expect(deps.restoring.size).toBe(0);
  });

  it("闸按任务 id 分：恢复 A 的途中点 B 不被拦", async () => {
    const d = deferred<{ task: Task }>();
    const { deps, log } = makeRig({
      setArchived: (id) => {
        log.push(`setArchived ${id} false`);
        return id === "t1" ? d.promise : Promise.resolve({ task: makeTask(id) });
      },
    });
    const view = {
      tasks: [row("t1", { archived: true, title: "A" }), row("t2", { archived: true, title: "B" })],
      loaded: true,
      loadError: null,
    };
    const a = openBoardItem(item({ task: { id: "t1" } }), view, deps);
    await openBoardItem(item({ id: "S2", task: { id: "t2" } }), view, deps);
    expect(log).toContain("push /tasks/t2");
    expect(log).not.toContain("push /tasks/t1");
    d.resolve({ task: makeTask("t1") });
    await a;
    expect(log).toContain("push /tasks/t1");
  });
});

describe("openBoardItem：不涉及归档的路径保持原样", () => {
  it("未归档的任务：直进，不发 PATCH、不动归档标记", async () => {
    const { deps, log } = makeRig();
    await openBoardItem(
      item(),
      { tasks: [row("t1")], loaded: true, loadError: null },
      deps,
    );
    expect(log).toEqual(["push /tasks/t1"]);
  });

  it("列表没就绪：信缓存映射直进，不发 PATCH（归档与否此刻不可知，详情页的归档提示条兜底）", async () => {
    const { deps, log } = makeRig();
    await openBoardItem(item(), { tasks: [], loaded: false, loadError: null }, deps);
    expect(log).toEqual(["push /tasks/t1"]);
  });

  it("没挂任务 / 任务已被删：进预览页，query 带上项目 / 名称 / 链接", async () => {
    const expected =
      "push /workitems/S1?project=proj&name=%E3%80%90%E6%95%B0%E8%8B%B1%E6%BB%A1%E7%8F%AD%E7%8E%87%E3%80%91%E7%BB%84%E7%8F%AD&url=https%3A%2F%2Fexample.com%2Fproj%2Fstory%2Fdetail%2FS1";
    const none = makeRig();
    await openBoardItem(item({ task: null }), { tasks: [row("t9")], loaded: true, loadError: null }, none.deps);
    expect(none.log).toEqual([expected]);

    const gone = makeRig();
    await openBoardItem(
      item({ task: { id: "gone" } }),
      { tasks: [row("t9")], loaded: true, loadError: null },
      gone.deps,
    );
    expect(gone.log).toEqual([expected]);
  });

  it("预览页链接：缺字段不带空 query；id 要转义", async () => {
    const { deps, log } = makeRig();
    await openBoardItem(
      { id: "a/b c", task: null },
      { tasks: [], loaded: true, loadError: null },
      deps,
    );
    expect(log).toEqual(["push /workitems/a%2Fb%20c?"]);
  });
});

describe("接线：feishu-board 的点击必须走 openBoardItem", () => {
  const board = readFileSync(
    path.join(process.cwd(), "src/components/feishu/feishu-board.tsx"),
    "utf8",
  );

  it("handleOpen 调 openBoardItem，不再自己拿缓存里的 task id 直接 push（那正是绕过恢复的老路径）", () => {
    expect(board).toMatch(/from "@\/lib\/board-open"/);
    expect(board).toMatch(/const handleOpen = useCallback\(\s*\(it: BoardItem\) => \{\s*void openBoardItem\(/);
    expect(board).not.toMatch(/router\.push\(`\/tasks\/\$\{it\.task\.id\}`\)/);
  });

  it("恢复要用的件都接上了：PATCH、归档标记、列表回灌、置顶序、提示、连点闸", () => {
    // 归档标记 / 回灌来自 useTaskList（不是空函数）、并原样交给 openBoardItem
    expect(board).toMatch(
      /const \{[^}]*\bupsertTask\b[^}]*\bmarkArchiving\b[^}]*\bunmarkArchiving\b[^}]*\} = useTaskList\(\);/,
    );
    expect(board).toMatch(
      /openBoardItem\([\s\S]*?setArchived: setTaskArchivedWithReport,\s*markArchiving,\s*unmarkArchiving,\s*upsertTask,/,
    );
    // 置顶序：读出来、没有才接回末尾
    expect(board).toMatch(
      /restorePinnedOrder: \(id\) => \{\s*const order = loadSidebarPinnedOrder\(\);\s*if \(!order\.includes\(id\)\) saveSidebarPinnedOrder\(\[\.\.\.order, id\]\);\s*\},/,
    );
    expect(board).toMatch(/notifySuccess: .*toast\.success/);
    expect(board).toMatch(/notifyError: .*toast\.error/);
    // 连点闸要跨点击存活（useRef 持有），不能每次点击新建
    expect(board).toMatch(/const restoringRef = useRef<Set<string>>\(new Set\(\)\);/);
    expect(board).toMatch(/restoring: restoringRef\.current,/);
  });
});
