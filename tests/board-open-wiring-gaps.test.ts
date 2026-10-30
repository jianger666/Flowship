/**
 * X4 补洞：feishu-board 点击回调的接线里，审查 AI 的两条契约（tests/board-open.test.ts 末尾）没钉住的两处。
 *
 * 我自己对这批代码做 58 个变异时，下面 5 个在补这个文件之前存活（没有任何用例红）：
 *  - W9  传给 openBoardItem 的 loaded 写死 true
 *        列表还没回来（tasks 是空数组）也被当成「已加载的真列表」，缓存里挂着的、其实还在的任务被判成「已删」
 *        → 误去预览页，可能对同一个需求重复建任务；
 *  - W10 传给 openBoardItem 的 tasks 写成 []
 *        任何任务都查不到：已归档的不再恢复（本 bug 复发）；列表加载完后，所有已挂任务都被判成「已删」→ 预览页；
 *  - W11 传给 openBoardItem 的 loadError 写死 null
 *        列表首拉失败（没数据 + 有错）时不再回退信缓存，同样被判成「已删」；
 *  - W13 跳转换成 router.replace —— 工作台被从历史栈里换掉，返回键回不去；
 *  - W14 跳转换成空函数 —— 点了没反应。
 *
 * vitest 是 node 环境、没有 DOM，点不了真组件；按仓库惯例（*-wiring-contract）用源码契约钉。
 * 每条契约都带内存变异自检：把对应变异打到源码文本上，契约必须变红——防止正则写松了永远绿。
 *
 * 第 6 个存活的 W12（handleOpen 的依赖数组漏 tasks → 陈旧闭包）也钉在这里（契约 4）：
 * react-hooks/exhaustive-deps 在本仓库只是 warn（eslint-config-next 15.5.28 → react-hooks/recommended），
 * 而 `pnpm lint` = `eslint .`、没带 --max-warnings，CI 只看退出码——打上 W12 后实测是 1 条 warning、退出码 0，
 * 只有手敲 `--max-warnings 0` 才会红，挡不住真实门禁，所以用契约兜。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const board = readFileSync(
  path.join(process.cwd(), "src/components/feishu/feishu-board.tsx"),
  "utf8",
);

/** 契约 1：「列表视图」三件来自 useTaskList（tasks / loaded / loadError），不是别处拼的 */
const destructuresListView = (src: string): boolean =>
  /const \{\s*tasks,\s*loaded: tasksLoaded,\s*loadError: tasksLoadError,[\s\S]*?\} = useTaskList\(\);/.test(src);

/** 契约 2：把 { tasks, loaded, loadError } 原样交给 openBoardItem（第二个参数），不写死、不换空值 */
const passesListViewAsIs = (src: string): boolean =>
  /openBoardItem\(\s*it,\s*\{\s*tasks,\s*loaded: tasksLoaded,\s*loadError: tasksLoadError\s*\},/.test(src);

/** 契约 3：跳转是 router.push（工作台留在历史栈里、返回键回得去），不是 replace、不是空函数 */
const pushesWithRouterPush = (src: string): boolean =>
  /push: \(url(?:: string)?\) => router\.push\(url\),/.test(src);

/**
 * 契约 4：handleOpen 的 useCallback 依赖数组列全它闭包里用到的输入（W12：漏 tasks → 列表更新后仍用旧列表判「已删 / 已归档」）。
 * 锚点：依赖数组独占一行（4 空格缩进、`],` 收尾、下一行 `  );`）；handleOpen 函数体里没有这种行首的 `[`。
 */
const HANDLE_OPEN_DEPS = [
  "router",
  "tasks",
  "tasksLoaded",
  "tasksLoadError",
  "upsertTask",
  "markArchiving",
  "unmarkArchiving",
];
const handleOpenDeps = (src: string): string[] | null => {
  const m = /const handleOpen = useCallback\([\s\S]*?\n {4}\[([^\]\n]*)\],\n {2}\);/.exec(src);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
};
const handleOpenDepsComplete = (src: string): boolean => {
  const deps = handleOpenDeps(src);
  return deps !== null && HANDLE_OPEN_DEPS.every((d) => deps.includes(d));
};

const LIST_VIEW_ARG = "{ tasks, loaded: tasksLoaded, loadError: tasksLoadError },";
const PUSH_IMPL = "push: (url) => router.push(url),";
const DEPS_SRC = "[router, tasks, tasksLoaded, tasksLoadError, upsertTask, markArchiving, unmarkArchiving],";

const MUTANTS: Array<{
  name: string;
  holds: (src: string) => boolean;
  from: string;
  to: string;
}> = [
  {
    name: "W9 loaded 写死 true",
    holds: passesListViewAsIs,
    from: LIST_VIEW_ARG,
    to: "{ tasks, loaded: true, loadError: tasksLoadError },",
  },
  {
    name: "W9′ loaded 写死 false",
    holds: passesListViewAsIs,
    from: LIST_VIEW_ARG,
    to: "{ tasks, loaded: false, loadError: tasksLoadError },",
  },
  {
    name: "W10 tasks 写成空数组",
    holds: passesListViewAsIs,
    from: LIST_VIEW_ARG,
    to: "{ tasks: [], loaded: tasksLoaded, loadError: tasksLoadError },",
  },
  {
    name: "W11 loadError 写死 null",
    holds: passesListViewAsIs,
    from: LIST_VIEW_ARG,
    to: "{ tasks, loaded: tasksLoaded, loadError: null },",
  },
  {
    name: "W11′ loadError 写成 undefined",
    holds: passesListViewAsIs,
    from: LIST_VIEW_ARG,
    to: "{ tasks, loaded: tasksLoaded, loadError: undefined },",
  },
  {
    name: "W13 跳转换成 router.replace",
    holds: pushesWithRouterPush,
    from: PUSH_IMPL,
    to: "push: (url) => router.replace(url),",
  },
  {
    name: "W14 跳转换成空函数",
    holds: pushesWithRouterPush,
    from: PUSH_IMPL,
    to: "push: () => {},",
  },
  {
    name: "W14′ 跳转写成固定地址（不用传入的 url）",
    holds: pushesWithRouterPush,
    from: PUSH_IMPL,
    to: 'push: (url) => router.push("/"),',
  },
  {
    name: "W12 依赖数组漏 tasks（陈旧闭包）",
    holds: handleOpenDepsComplete,
    from: DEPS_SRC,
    to: "[router, tasksLoaded, tasksLoadError, upsertTask, markArchiving, unmarkArchiving],",
  },
  {
    name: "W12′ 依赖数组漏 tasksLoaded",
    holds: handleOpenDepsComplete,
    from: DEPS_SRC,
    to: "[router, tasks, tasksLoadError, upsertTask, markArchiving, unmarkArchiving],",
  },
  {
    name: "W12″ 依赖数组漏 tasksLoadError",
    holds: handleOpenDepsComplete,
    from: DEPS_SRC,
    to: "[router, tasks, tasksLoaded, upsertTask, markArchiving, unmarkArchiving],",
  },
  {
    name: "W12‴ 依赖数组写成空（回调只在首次渲染建一次）",
    holds: handleOpenDepsComplete,
    from: DEPS_SRC,
    to: "[],",
  },
  // 解构里的写法独占一行（行尾是逗号 + 换行）；传参那处 `loaded: tasksLoaded, loadError` 逗号后是空格，不会混
  {
    name: "解构里 loaded 换了来源",
    holds: destructuresListView,
    from: "loaded: tasksLoaded,\n",
    to: "loaded: tasksLoadedStale,\n",
  },
  {
    name: "解构里 loadError 换了来源",
    holds: destructuresListView,
    from: "loadError: tasksLoadError,\n",
    to: "loadError: tasksLoadErrorStale,\n",
  },
];

describe("接线补洞：feishu-board 交给 openBoardItem 的列表视图与跳转", () => {
  it("列表视图的三件（tasks / loaded / loadError）来自 useTaskList", () => {
    expect(destructuresListView(board)).toBe(true);
  });

  it("handleOpen 把 { tasks, loaded, loadError } 原样交给 openBoardItem：不写死、不换空值", () => {
    expect(passesListViewAsIs(board)).toBe(true);
  });

  it("跳转是 router.push(url)：工作台留在历史栈里、返回键回得去；不是 replace、不是空函数", () => {
    expect(pushesWithRouterPush(board)).toBe(true);
  });

  it("handleOpen 的依赖数组含 tasks / tasksLoaded / tasksLoadError 等全部闭包输入：防陈旧闭包（lint 只是 warn，挡不住）", () => {
    expect(handleOpenDeps(board)).not.toBeNull();
    expect(handleOpenDepsComplete(board)).toBe(true);
  });

  describe("内存变异自检（契约必须抓得住）", () => {
    it.each(MUTANTS)("$name → 契约变红", ({ holds, from, to }) => {
      // 变异必须真的打得上：old 在源码里恰好出现 1 次，否则这条自检是空转
      expect(board.split(from).length - 1).toBe(1);
      // 对照：未变异时契约成立
      expect(holds(board)).toBe(true);
      expect(holds(board.replace(from, to))).toBe(false);
    });
  });
});
