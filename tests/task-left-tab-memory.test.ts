/**
 * 任务页左栏「产物 | 浏览器」标签的记忆：切走（别的任务 / 对话页）再切回来，定位到上次的标签。
 *
 * ① 纯逻辑（lib/task-left-tab-memory）：只存「浏览器」、切回产物就删、上限、脏值 / storage 抛错都不抛
 * ② 页面接线契约（page.tsx 是 1800 行的客户端页面，没法 SSR 整页，只能守源码文本）：
 *    - 所有用户 / 自动展开造成的标签切换走 switchLeftTab（切 state + 写记忆）；
 *    - 任务切换时的复位（setLeftTab("artifact")）**不写记忆**——否则一进别的任务就把上一个任务的记忆冲成「产物」；
 *    - 恢复 effect：任务已加载 + 分栏已挂（mainWidth）+ 有浏览器桥才恢复，每个任务只恢复一次，走 showBrowserPane。
 *
 * 诚实声明：真窗口里「切走再切回」的实际表现没有验证（规则：不操作 App 界面）；
 * 这里证明的是：记忆读写正确、接线没有漏掉任何一个切换入口、恢复条件齐全。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  TASK_LEFT_TAB_KEY,
  TASK_LEFT_TAB_MAX_ENTRIES,
  forgetTaskLeftTab,
  readTaskLeftTab,
  writeTaskLeftTab,
} from "@/lib/task-left-tab-memory";

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
  JSON.parse(s.data.get(TASK_LEFT_TAB_KEY) ?? "{}") as Record<string, string>;

describe("readTaskLeftTab / writeTaskLeftTab", () => {
  it("没记过 → 产物（默认值）", () => {
    expect(readTaskLeftTab("t1", memoryStorage())).toBe("artifact");
  });

  it("写浏览器再读 → 浏览器；落在固定 key（flowship. 前缀）上；别的任务不受影响", () => {
    const s = memoryStorage();
    expect(writeTaskLeftTab("t1", "browser", s)).toBe(true);
    expect(TASK_LEFT_TAB_KEY.startsWith("flowship.")).toBe(true);
    expect(readTaskLeftTab("t1", s)).toBe("browser");
    expect(readTaskLeftTab("t2", s)).toBe("artifact");
    expect(table(s)).toEqual({ t1: "browser" });
  });

  it("切回产物 = 删掉那条记录（默认值不占位置），读出来是产物", () => {
    const s = memoryStorage();
    writeTaskLeftTab("t1", "browser", s);
    writeTaskLeftTab("t2", "browser", s);
    expect(writeTaskLeftTab("t1", "artifact", s)).toBe(true);
    expect(readTaskLeftTab("t1", s)).toBe("artifact");
    expect(table(s)).toEqual({ t2: "browser" });
  });

  it("没有变化时不写盘（本来就没记 → 写产物；已经是最新一条 → 重复写浏览器）", () => {
    const s = memoryStorage();
    expect(writeTaskLeftTab("t1", "artifact", s)).toBe(true);
    expect(s.writeCount()).toBe(0);
    writeTaskLeftTab("t1", "browser", s);
    expect(s.writeCount()).toBe(1);
    expect(writeTaskLeftTab("t1", "browser", s)).toBe(true);
    expect(s.writeCount()).toBe(1);
  });

  it("再次写浏览器会把这个任务挪到「最新」：满额淘汰的是最久没动过的那条，不是刚用过的", () => {
    const s = memoryStorage();
    for (let i = 0; i < TASK_LEFT_TAB_MAX_ENTRIES; i += 1) writeTaskLeftTab(`t${i}`, "browser", s);
    // t0 是最老的；碰一下它，让 t1 成为最老
    writeTaskLeftTab("t0", "browser", s);
    writeTaskLeftTab("new", "browser", s);
    expect(Object.keys(table(s))).toHaveLength(TASK_LEFT_TAB_MAX_ENTRIES);
    expect(readTaskLeftTab("t1", s)).toBe("artifact"); // 被淘汰
    expect(readTaskLeftTab("t0", s)).toBe("browser"); // 刚用过的还在
    expect(readTaskLeftTab("new", s)).toBe("browser");
  });

  it("forgetTaskLeftTab 等价于写回产物", () => {
    const s = memoryStorage();
    writeTaskLeftTab("t1", "browser", s);
    forgetTaskLeftTab("t1", s);
    expect(readTaskLeftTab("t1", s)).toBe("artifact");
  });

  it("空 taskId：读 → 产物，写 → false，不会写出一个空 key", () => {
    const s = memoryStorage();
    expect(readTaskLeftTab("", s)).toBe("artifact");
    expect(writeTaskLeftTab("", "browser", s)).toBe(false);
    expect(s.data.size).toBe(0);
  });
});

describe("脏数据 / 异常 storage 不抛", () => {
  it.each([
    ["非 JSON", "not-json{"],
    ["null", "null"],
    ["数组", '["t1"]'],
    ["数字", "42"],
    ["字符串", '"browser"'],
    ["值不是 browser", '{"t1":"artifact","t2":1,"t3":null,"t4":true}'],
    ["空串", ""],
  ])("%s → 当没有记忆（产物）", (_name, raw) => {
    const s = memoryStorage({ [TASK_LEFT_TAB_KEY]: raw });
    expect(readTaskLeftTab("t1", s)).toBe("artifact");
    expect(readTaskLeftTab("t2", s)).toBe("artifact");
  });

  it("脏表里混着一条合法记录：合法的保留、脏的忽略；之后写入会把脏条目清掉", () => {
    const s = memoryStorage({ [TASK_LEFT_TAB_KEY]: '{"good":"browser","bad":"artifact","worse":7}' });
    expect(readTaskLeftTab("good", s)).toBe("browser");
    expect(readTaskLeftTab("bad", s)).toBe("artifact");
    writeTaskLeftTab("other", "browser", s);
    expect(table(s)).toEqual({ good: "browser", other: "browser" });
  });

  it("storage 为 null（SSR / 隐私模式）：读 → 产物，写 → false", () => {
    expect(readTaskLeftTab("t1", null)).toBe("artifact");
    expect(writeTaskLeftTab("t1", "browser", null)).toBe(false);
  });

  it("storage 读 / 写抛错：读 → 产物，写 → false", () => {
    const boom = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readTaskLeftTab("t1", boom)).toBe("artifact");
    expect(writeTaskLeftTab("t1", "browser", boom)).toBe(false);
  });

  it("「__proto__」之类的特殊 key 不会污染原型、也能正常读写", () => {
    const s = memoryStorage();
    writeTaskLeftTab("__proto__", "browser", s);
    expect(readTaskLeftTab("__proto__", s)).toBe("browser");
    expect(({} as Record<string, unknown>).browser).toBeUndefined();
  });
});

describe("页面接线契约（task 详情页左栏标签记忆）", () => {
  const repoDir = path.resolve(import.meta.dirname, "..");
  const page = readFileSync(path.join(repoDir, "src/app/tasks/[id]/page.tsx"), "utf-8");
  /** 去掉 JSX 注释与行注释：断言「代码」而不是被注释里的字样骗过 */
  const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("switchLeftTab = 切 state + 按当前路由任务写记忆", () => {
    expect(code).toMatch(
      /const switchLeftTab = useCallback\(\(tab: LeftPaneTab\) => \{\s*setLeftTab\(tab\);\s*writeTaskLeftTab\(routeIdRef\.current, tab\);\s*\}, \[\]\);/,
    );
  });

  it("三个切换入口（进浏览器 / 关浏览器 / 分段切换回产物）都走 switchLeftTab，没有漏的", () => {
    expect(code.match(/switchLeftTab\("browser"\)/g)).toHaveLength(1); // showBrowserPane（头部入口 / 自动展开 / 在内置浏览器打开 / 恢复 共用）
    expect(code.match(/switchLeftTab\("artifact"\)/g)).toHaveLength(1); // closeBrowserPane
    expect(code.match(/switchLeftTab\(tab\)/g)).toHaveLength(1); // 分段切换回产物
  });

  it("裸 setLeftTab 只剩两处：switchLeftTab 内部 + 任务切换时的复位（复位不写记忆）", () => {
    expect(code.match(/\bsetLeftTab\(/g)).toHaveLength(2);
    // 复位那处紧挨着 marker 清零，且不写记忆
    expect(code).toMatch(/setLeftTab\("artifact"\);\s*restoredLeftTabFor\.current = null;/);
    expect(code).not.toMatch(/setLeftTab\("artifact"\);\s*writeTaskLeftTab/);
  });

  it("恢复 effect：任务已加载 + 分栏已挂 + 有浏览器桥才恢复；每个任务只恢复一次；走 showBrowserPane", () => {
    expect(code).toMatch(/const browserAvailable = useBrowserAvailable\(\);/);
    expect(code).toMatch(
      /if \(!browserTaskId \|\| mainWidth == null \|\| !browserAvailable\) return;\s*if \(restoredLeftTabFor\.current === browserTaskId\) return;\s*restoredLeftTabFor\.current = browserTaskId;\s*if \(readTaskLeftTab\(browserTaskId\) === "browser"\) showBrowserPane\(\);/,
    );
    expect(code).toMatch(/\}, \[browserTaskId, mainWidth, browserAvailable, showBrowserPane\]\);/);
  });

  it("恢复 effect 声明在 browserTaskId 之后（依赖数组在渲染期求值，放前面会踩 TDZ）", () => {
    const decl = code.indexOf("const browserTaskId = ");
    const effect = code.indexOf("const restoredLeftTabFor = useRef");
    expect(decl).toBeGreaterThan(-1);
    expect(effect).toBeGreaterThan(decl);
  });

  it("任务被删除时顺手忘掉它的记忆", () => {
    expect(code).toMatch(/commitTaskDeleted\(deletedId\);\s*forgetTaskLeftTab\(deletedId\);/);
  });
});
