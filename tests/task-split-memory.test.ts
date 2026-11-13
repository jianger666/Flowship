/**
 * 任务页左右分栏「哪一栏被收起」的记忆（2026-11-12 用户：「这个展开收起的状态麻烦也记一下，不然每次切回来就又展开了」）。
 *
 * ① 纯逻辑（lib/task-split-memory）：只存被收起的那一栏、展开就删、上限、脏值 / storage 抛错都不抛、
 *    从 onLayoutChanged 的布局判定哪一栏收起（残缺布局不下结论）、按记忆收起那一栏（句柄用假的，任何一步抛错都吞）
 * ② 页面接线契约（page.tsx 是 1900 行的客户端页面，没法 SSR 整页，只能守源码文本）：
 *    - 写记忆只发生在**用户动作**里（分栏按钮 / 放大 / 拖分隔条 / 用户动作造成的展开），任务切换时的复位不写；
 *    - 恢复：useLayoutEffect、任务已加载 + 分栏已挂 + 两个句柄都在、每个任务一次、事件流收起遇到待回答提问不收；
 *    - 左栏标签恢复遇到「产物栏被收起」时 keepCollapsed，不替用户展开。
 *
 * 诚实声明：真窗口里的实际表现（库在挂载后命令式 collapse 的时序、一帧闪动）这里测不到——真库的部分由
 * scripts/browser-e2e/r17-task-split-restore.cjs 在无头 Electron 里验证（见该脚本头注释）；本文件证明的是：
 * 记忆读写正确、接线没有漏掉任何一个用户动作入口、恢复条件齐全。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyTaskSplitRestore,
  collapsedPaneFromLayout,
  forgetTaskSplit,
  readTaskSplit,
  TASK_SPLIT_KEY,
  TASK_SPLIT_MAX_ENTRIES,
  writeTaskSplit,
  type CollapsiblePanelHandle,
} from "@/lib/task-split-memory";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  let writes = 0;
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      writes += 1;
      data.set(k, v);
    },
    data,
    writeCount: () => writes,
  };
};

const table = (s: ReturnType<typeof memoryStorage>): Record<string, string> =>
  JSON.parse(s.data.get(TASK_SPLIT_KEY) ?? "{}") as Record<string, string>;

describe("readTaskSplit / writeTaskSplit", () => {
  it("没记过 → null（两栏都展开）", () => {
    expect(readTaskSplit("t1", memoryStorage())).toBeNull();
  });

  it("记产物栏收起 / 事件流收起，各任务互不影响；落在固定 key（flowship. 前缀）上", () => {
    const s = memoryStorage();
    expect(TASK_SPLIT_KEY.startsWith("flowship.")).toBe(true);
    expect(writeTaskSplit("t1", "artifact", s)).toBe(true);
    expect(writeTaskSplit("t2", "event-stream", s)).toBe(true);
    expect(readTaskSplit("t1", s)).toBe("artifact");
    expect(readTaskSplit("t2", s)).toBe("event-stream");
    expect(readTaskSplit("t3", s)).toBeNull();
    expect(table(s)).toEqual({ t1: "artifact", t2: "event-stream" });
  });

  it("同一个任务从一种收起态换到另一种：覆盖，不会两种同时存在", () => {
    const s = memoryStorage();
    writeTaskSplit("t1", "artifact", s);
    writeTaskSplit("t1", "event-stream", s);
    expect(readTaskSplit("t1", s)).toBe("event-stream");
    expect(Object.keys(table(s))).toEqual(["t1"]);
  });

  it("展开（null）= 删掉那条记录（默认值不占位置）；别的任务的记录不动", () => {
    const s = memoryStorage();
    writeTaskSplit("t1", "artifact", s);
    writeTaskSplit("t2", "artifact", s);
    expect(writeTaskSplit("t1", null, s)).toBe(true);
    expect(readTaskSplit("t1", s)).toBeNull();
    expect(readTaskSplit("t2", s)).toBe("artifact");
    expect(table(s)).toEqual({ t2: "artifact" });
  });

  it("没有变化时不写盘（本来就没记 → 写 null；已经是最新一条且值相同 → 重复写）", () => {
    const s = memoryStorage();
    expect(writeTaskSplit("t1", null, s)).toBe(true);
    expect(s.writeCount()).toBe(0);
    writeTaskSplit("t1", "artifact", s);
    expect(s.writeCount()).toBe(1);
    expect(writeTaskSplit("t1", "artifact", s)).toBe(true);
    expect(s.writeCount()).toBe(1);
  });

  it("再次写入会把这个任务挪到「最新」：满额淘汰的是最久没动过的那条，不是刚用过的", () => {
    const s = memoryStorage();
    for (let i = 0; i < TASK_SPLIT_MAX_ENTRIES; i++) writeTaskSplit(`t${i}`, "artifact", s);
    expect(Object.keys(table(s))).toHaveLength(TASK_SPLIT_MAX_ENTRIES);
    // t0 是最老的；把它再写一次（值不同）挪到最新，然后加一个新任务 → 被淘汰的应该是 t1
    writeTaskSplit("t0", "event-stream", s);
    writeTaskSplit("tNew", "artifact", s);
    const t = table(s);
    expect(Object.keys(t)).toHaveLength(TASK_SPLIT_MAX_ENTRIES);
    expect(t.t0).toBe("event-stream");
    expect(t.t1).toBeUndefined();
    expect(t.tNew).toBe("artifact");
  });

  it("forgetTaskSplit 等价于写回展开", () => {
    const s = memoryStorage();
    writeTaskSplit("t1", "artifact", s);
    expect(forgetTaskSplit("t1", s)).toBe(true);
    expect(readTaskSplit("t1", s)).toBeNull();
    expect(table(s)).toEqual({});
  });

  it("空 taskId：读 → null，写 → false，不会写出一个空 key", () => {
    const s = memoryStorage();
    expect(readTaskSplit("", s)).toBeNull();
    expect(writeTaskSplit("", "artifact", s)).toBe(false);
    expect(s.writeCount()).toBe(0);
  });

  it("不是合法栏名的值（类型被绕过时）→ 拒写，不污染存储", () => {
    const s = memoryStorage();
    expect(writeTaskSplit("t1", "both" as never, s)).toBe(false);
    expect(s.writeCount()).toBe(0);
  });
});

describe("脏数据 / 异常 storage 不抛", () => {
  it.each([
    ["不是 JSON", "{oops"],
    ["是数组", '["t1"]'],
    ["是 null", "null"],
    ["是数字", "42"],
    ["值不是合法栏名", '{"t1":"left","t2":1,"t3":null,"t4":true}'],
    ["空串", ""],
  ])("存的内容%s → 当没有记忆", (_name, raw) => {
    const s = memoryStorage({ [TASK_SPLIT_KEY]: raw });
    expect(readTaskSplit("t1", s)).toBeNull();
    expect(readTaskSplit("t2", s)).toBeNull();
  });

  it("脏表里混着一条合法记录：合法的保留、脏的忽略；之后写入会把脏条目清掉", () => {
    const s = memoryStorage({ [TASK_SPLIT_KEY]: '{"t1":"artifact","t2":"nope","":"artifact"}' });
    expect(readTaskSplit("t1", s)).toBe("artifact");
    expect(readTaskSplit("t2", s)).toBeNull();
    writeTaskSplit("t3", "event-stream", s);
    expect(table(s)).toEqual({ t1: "artifact", t3: "event-stream" });
  });

  it("storage 为 null（SSR / 隐私模式）：读 → null，写 → false", () => {
    expect(readTaskSplit("t1", null)).toBeNull();
    expect(writeTaskSplit("t1", "artifact", null)).toBe(false);
  });

  it("storage 读 / 写抛错：读 → null，写 → false", () => {
    const boom = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readTaskSplit("t1", boom)).toBeNull();
    expect(writeTaskSplit("t1", "artifact", boom)).toBe(false);
    const readOk = { getItem: () => null, setItem: boom.setItem };
    expect(writeTaskSplit("t1", "artifact", readOk)).toBe(false);
  });

  it("「__proto__」之类的特殊 key 不会污染原型、也能正常读写", () => {
    const s = memoryStorage();
    expect(writeTaskSplit("__proto__", "artifact", s)).toBe(true);
    expect(readTaskSplit("__proto__", s)).toBe("artifact");
    expect(({} as Record<string, unknown>).artifact).toBeUndefined();
    expect(readTaskSplit("t1", s)).toBeNull();
  });
});

describe("collapsedPaneFromLayout：从 onLayoutChanged 的整份布局判定哪一栏收起", () => {
  it.each<[string, Record<string, number>, string]>([
    ["两栏都有宽度 → none", { artifact: 60, "event-stream": 40 }, "none"],
    ["产物栏 0 → artifact", { artifact: 0, "event-stream": 100 }, "artifact"],
    ["事件流 0 → event-stream", { artifact: 100, "event-stream": 0 }, "event-stream"],
    ["刚好 1%（不算收起：与 isArtifactCollapsedSize 同口径 < 1）", { artifact: 1, "event-stream": 99 }, "none"],
    ["0.4%（浮点残差也算收起）", { artifact: 0.4, "event-stream": 99.6 }, "artifact"],
    ["两栏同时 < 1%（库没定义的状态）→ unknown", { artifact: 0, "event-stream": 0 }, "unknown"],
    ["缺事件流栏 → unknown", { artifact: 0 }, "unknown"],
    ["缺产物栏 → unknown", { "event-stream": 0 }, "unknown"],
    ["空布局 → unknown", {}, "unknown"],
    ["NaN → unknown", { artifact: Number.NaN, "event-stream": 50 }, "unknown"],
    ["Infinity → unknown", { artifact: 50, "event-stream": Number.POSITIVE_INFINITY }, "unknown"],
  ])("%s", (_name, layout, expected) => {
    expect(collapsedPaneFromLayout(layout)).toBe(expected);
  });

  it("null / undefined 布局 → unknown（不抛）", () => {
    expect(collapsedPaneFromLayout(null)).toBe("unknown");
    expect(collapsedPaneFromLayout(undefined)).toBe("unknown");
  });

  it("面板 id 与页面里 ResizablePanel 的 id 一致（键错了 = 永远 unknown、记忆永远不更新）", () => {
    const page = readFileSync(path.resolve(import.meta.dirname, "..", "src/app/tasks/[id]/page.tsx"), "utf-8");
    expect(page).toMatch(/<ResizablePanel\s+id="artifact"/);
    expect(page).toMatch(/<ResizablePanel\s+id="event-stream"/);
  });
});

describe("applyTaskSplitRestore：分栏挂好后按记忆把那一栏收起", () => {
  const makeHandle = (opts: { collapsed?: boolean; collapseWorks?: boolean; throwOn?: "isCollapsed" | "collapse" } = {}) => {
    let collapsed = opts.collapsed ?? false;
    const calls: string[] = [];
    const handle: CollapsiblePanelHandle = {
      isCollapsed: () => {
        calls.push("isCollapsed");
        if (opts.throwOn === "isCollapsed") throw new Error("Group 还没挂好");
        return collapsed;
      },
      collapse: () => {
        calls.push("collapse");
        if (opts.throwOn === "collapse") throw new Error("约束冲突");
        if (opts.collapseWorks !== false) collapsed = true;
      },
    };
    return { handle, calls };
  };

  it("记忆 = artifact：只收产物栏，事件流栏一个方法都不碰", () => {
    const a = makeHandle();
    const e = makeHandle();
    expect(applyTaskSplitRestore("artifact", { artifact: a.handle, eventStream: e.handle })).toBe(true);
    expect(a.calls).toEqual(["isCollapsed", "collapse", "isCollapsed"]);
    expect(e.calls).toEqual([]);
  });

  it("记忆 = event-stream：只收事件流栏，产物栏一个方法都不碰", () => {
    const a = makeHandle();
    const e = makeHandle();
    expect(applyTaskSplitRestore("event-stream", { artifact: a.handle, eventStream: e.handle })).toBe(true);
    expect(e.calls).toEqual(["isCollapsed", "collapse", "isCollapsed"]);
    expect(a.calls).toEqual([]);
  });

  it("没有记忆 → 什么都不做、返回 false（展开是默认态，不需要恢复）", () => {
    const a = makeHandle();
    const e = makeHandle();
    expect(applyTaskSplitRestore(null, { artifact: a.handle, eventStream: e.handle })).toBe(false);
    expect(a.calls).toEqual([]);
    expect(e.calls).toEqual([]);
  });

  it("那一栏本来就是收起的 → 不再 collapse，返回 true", () => {
    const a = makeHandle({ collapsed: true });
    expect(applyTaskSplitRestore("artifact", { artifact: a.handle, eventStream: null })).toBe(true);
    expect(a.calls).toEqual(["isCollapsed"]);
  });

  it("collapse 没生效（回读仍是展开）→ 返回 false，不假装成功", () => {
    const a = makeHandle({ collapseWorks: false });
    expect(applyTaskSplitRestore("artifact", { artifact: a.handle, eventStream: null })).toBe(false);
  });

  it("句柄缺失（null / undefined）→ false，不抛", () => {
    expect(applyTaskSplitRestore("artifact", { artifact: null, eventStream: makeHandle().handle })).toBe(false);
    expect(applyTaskSplitRestore("event-stream", { artifact: makeHandle().handle, eventStream: undefined })).toBe(false);
  });

  it("任何一步抛错（isCollapsed / collapse）都吞掉 → false", () => {
    expect(applyTaskSplitRestore("artifact", { artifact: makeHandle({ throwOn: "isCollapsed" }).handle, eventStream: null })).toBe(false);
    expect(applyTaskSplitRestore("artifact", { artifact: makeHandle({ throwOn: "collapse" }).handle, eventStream: null })).toBe(false);
  });
});

describe("页面接线契约（task 详情页分栏收起态记忆）", () => {
  const repoDir = path.resolve(import.meta.dirname, "..");
  const raw = readFileSync(path.join(repoDir, "src/app/tasks/[id]/page.tsx"), "utf-8");
  /** 去掉 JSX 注释与行注释：断言「代码」而不是被注释里的字样骗过 */
  const code = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /** 取 `const name = useCallback(` 起、到配对括号结束的整段 */
  const callbackBody = (name: string): string => {
    const start = code.indexOf(`const ${name} = useCallback(`);
    expect(start, `找不到 ${name}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = code.indexOf("useCallback(", start); i < code.length; i++) {
      const c = code[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return code.slice(start, i + 1);
    }
    throw new Error(`${name} 括号不配对`);
  };

  it("rememberSplit = 按当前路由任务写记忆（和 switchLeftTab 同一个取 id 的口径）", () => {
    expect(code).toMatch(
      /const rememberSplit = useCallback\(\(pane: CollapsedPane \| null\) => \{\s*writeTaskSplit\(routeIdRef\.current, pane\);\s*\}, \[\]\);/,
    );
  });

  it("头部分栏按钮：收起产物栏 → 记 artifact；两种展开 → 记 null；句柄没挂好时不写", () => {
    const body = callbackBody("toggleSplitLayout");
    expect(body).toMatch(/eventStream\?\.expand\(\);\s*if \(eventStream\) rememberSplit\(null\);/);
    expect(body).toMatch(/artifact\?\.expand\(\);\s*if \(artifact\) rememberSplit\(null\);/);
    expect(body).toMatch(/artifact\?\.collapse\(\);\s*if \(artifact\) rememberSplit\("artifact"\);/);
    expect(body).toContain("rememberSplit]");
  });

  it("浏览器「放大」：折叠事件流 → 记 event-stream；再点还原 → 记 null", () => {
    const body = callbackBody("toggleBrowserMaximize");
    expect(body).toMatch(/eventStream\.expand\(\);\s*rememberSplit\(null\);/);
    expect(body).toMatch(/eventStream\.collapse\(\);\s*rememberSplit\("event-stream"\);/);
  });

  it("「放大造成的折叠」被还原（关浏览器 / 切回产物 / 新提问）→ 记 null；只在真的展开了的时候记", () => {
    const body = callbackBody("restoreEventStreamFromMaximize");
    expect(body).toMatch(
      /if \(eventStreamPanelRef\.current\?\.isCollapsed\(\)\) \{\s*eventStreamPanelRef\.current\.expand\(\);\s*rememberSplit\(null\);\s*\}/,
    );
  });

  it("showBrowserPane：keepCollapsed 时不展开栏；其余入口栏是收起的就展开，并把『产物栏收起』的记忆撤掉；换标签仍只有这一处", () => {
    const body = callbackBody("showBrowserPane");
    expect(body).toContain("opts?: { keepCollapsed?: boolean }");
    expect(body).toMatch(
      /if \(!opts\?\.keepCollapsed\) \{\s*const entry = prepareBrowserPaneEntry\(artifactPanelRef\.current, mainElRef\.current\?\.clientWidth\);\s*if \(entry\.expanded\) rememberSplit\(null\);\s*\}\s*switchLeftTab\("browser"\);/,
    );
    expect(code.match(/switchLeftTab\("browser"\)/g) ?? []).toHaveLength(1);
  });

  it("用户拖分隔条：onLayoutChanged 里按整份布局判定哪一栏收起，且和宽度回写同一个『只认用户意图』的闸；残缺布局不写", () => {
    expect(code).toMatch(/const collapsedPane = collapsedPaneFromLayout\(layout\);/);
    expect(code).toMatch(
      /if \(collapsedPane !== "unknown" && userResizeIntentRef\.current\.isActive\(Date\.now\(\)\)\) \{\s*rememberSplit\(collapsedPane === "none" \? null : collapsedPane\);\s*\}/,
    );
  });

  it("记忆只在用户动作里写：writeTaskSplit 只出现在 rememberSplit 一处；rememberSplit 不出现在 onResize 回调 / 任务切换复位里", () => {
    expect(code.match(/\bwriteTaskSplit\(/g) ?? []).toHaveLength(1);
    // onResize（库的尺寸回调，含自动折叠）只回写 state，不写记忆
    const resizeHandlers = [...code.matchAll(/onResize=\{[\s\S]{0,400}?\}\s*(?=>|\n\s*(?:style|>))/g)].map((m) => m[0]);
    expect(resizeHandlers.length).toBeGreaterThan(0);
    for (const h of resizeHandlers) expect(h).not.toContain("rememberSplit");
    // 任务切换时的复位 effect：只复位 state + 清恢复标记，不写记忆
    const reset = code.slice(code.indexOf("setArtifactCollapsed(false);"), code.indexOf("}, [id, clearStreaming]);"));
    expect(reset).toContain("restoredSplitFor.current = null;");
    expect(reset).not.toContain("rememberSplit(");
    expect(reset).not.toContain("writeTaskSplit(");
  });

  it("恢复 effect：useLayoutEffect；任务已加载 + 分栏已挂 + 两个句柄都在；每个任务只恢复一次；与浏览器桥无关", () => {
    const start = code.indexOf("const restoredSplitFor = useRef<string | null>(null);");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("}, [task?.id, mainWidth, artifactPanelRef, eventStreamPanelRef]);", start);
    expect(end).toBeGreaterThan(start);
    const effect = code.slice(start, end);
    expect(effect).toContain("useLayoutEffect(() => {");
    expect(effect).toMatch(/if \(!taskId \|\| mainWidth == null\) return;\s*if \(restoredSplitFor\.current === taskId\) return;/);
    // 句柄没挂好时先 return、**之后**才置标记（没挂好的那次不能算「已恢复」）
    expect(effect).toMatch(/if \(!artifact \|\| !eventStream\) return;\s*restoredSplitFor\.current = taskId;/);
    expect(effect).toContain("readTaskSplit(taskId)");
    expect(effect).toContain("applyTaskSplitRestore(pane, { artifact, eventStream })");
    expect(effect).not.toContain("browserAvailable");
  });

  it("事件流收起遇到待回答的提问就不收（答题卡在事件流里，useRevealOnNewAsk 只认新出现的）", () => {
    expect(code).toMatch(/const pendingAskIdRef = useRef\(pendingAskId\);\s*pendingAskIdRef\.current = pendingAskId;/);
    expect(code).toMatch(/if \(!pane \|\| \(pane === "event-stream" && pendingAskIdRef\.current\)\) return;/);
    // 只有「事件流」的收起才受这条限制：产物栏收起不挡
    expect(code).not.toMatch(/pane === "artifact" && pendingAskIdRef/);
  });

  it("停在浏览器标签上被收起的事件流 = 放大：恢复成功后记成放大，关浏览器 / 切回产物才会替他还原", () => {
    expect(code).toMatch(
      /if \(collapsed && pane === "event-stream" && readTaskLeftTab\(taskId\) === "browser"\) \{\s*browserMaximizedRef\.current = true;\s*\}/,
    );
    // browserMaximizedRef 在恢复 effect 之前声明（闭包里用，但保持阅读顺序）
    expect(code.indexOf("const browserMaximizedRef = useRef")).toBeLessThan(code.indexOf("const restoredSplitFor = useRef"));
  });

  it("恢复 effect 在 pendingAskId 之后声明（读它的 ref 初值在渲染期求值，放前面会踩 TDZ）", () => {
    expect(code.indexOf("const pendingAskId = useMemo")).toBeGreaterThan(-1);
    expect(code.indexOf("const pendingAskIdRef = useRef(pendingAskId)")).toBeGreaterThan(code.indexOf("const pendingAskId = useMemo"));
  });

  it("左栏标签恢复：产物栏是用户收起的 → keepCollapsed（只把标签放回浏览器、不展开）；否则照旧", () => {
    expect(code).toMatch(
      /if \(readTaskLeftTab\(browserTaskId\) === "browser"\) \{\s*showBrowserPane\(\{ keepCollapsed: readTaskSplit\(browserTaskId\) === "artifact" \}\);\s*\}/,
    );
  });

  it("任务被删除时顺手忘掉它的记忆", () => {
    expect(code).toMatch(/forgetTaskLeftTab\(deletedId\);\s*forgetTaskSplit\(deletedId\);/);
  });
});
