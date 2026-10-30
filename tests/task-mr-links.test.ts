/**
 * 任务详情页头部的 MR 链接条（R14 Q3-01）
 *
 * v1.7.1 头部重构（74f8d71）整块删掉了页面上的 MR 链接，之后 `task.mrs` 在 UI 里只剩推进弹窗的
 * placeholder 在读——提了 MR 却没有地方点开，也没有任何测试发现。这里守三层：
 * ① 纯函数 buildMrViews：提测 / 联调、目标分支兜底、仓名、版本、链接白名单、tooltip 文案、不展示状态
 * ② 叶子组件的 SSR 渲染：链接属性、空渲染（重复 key 在这一层守不到，见 ① 里的 key 用例）
 * ③ 页面接线契约：page.tsx 里真的挂了它、紧跟 WorkspaceActions、只传该传的 props（不传整个 task）
 *
 * 不展示 MR 状态是有意的：`task.mrs[].status` 提交时固定写 "open"、之后全仓没人更新，
 * 展示「进行中 / 已合并 / 已关闭」只会给出错误陈述（审查 AI 的 F-P12-1）。要展示得先做状态同步。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskMrLinks, buildMrViews } from "@/components/tasks/task-mr-links";
import type { MRRecord } from "@/lib/types";

const URL_A = "https://gitlab.example.com/g/web-app/-/merge_requests/7";
const URL_B = "https://gitlab.example.com/g/web-app/-/merge_requests/8";
const STATUS_WORDS = /进行中|已合并|已关闭/;

const mr = (over: Partial<MRRecord> = {}): MRRecord => ({
  repoPath: "/work/web-app",
  targetBranch: "test",
  version: 1,
  url: URL_A,
  title: "feat: 新增登录",
  branch: "feat/login",
  status: "open",
  createdAt: 1,
  ...over,
});

const TEST = { "/work/web-app": "test" };
const DEV = { "/work/web-app": "dev" };

const viewOf = (m: MRRecord, test: Record<string, string> | undefined = TEST, dev?: Record<string, string>) =>
  buildMrViews([m], test, dev)[0]!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildMrViews · 提测 / 联调", () => {
  it("按目标分支区分：目标等于该仓 dev 分支才是联调，其余是提测", () => {
    const [a, b] = buildMrViews(
      [mr({ targetBranch: "test" }), mr({ targetBranch: "dev", url: URL_B })],
      TEST,
      DEV,
    );
    expect([a!.kindLabel, a!.target]).toEqual(["提测", "test"]);
    expect([b!.kindLabel, b!.target]).toEqual(["联调", "dev"]);
  });

  it("没配 dev 分支：一律算提测", () => {
    expect(viewOf(mr({ targetBranch: "dev" }), TEST, undefined).kindLabel).toBe("提测");
  });

  it("老记录缺 targetBranch：兜底该仓测试分支、当提测——不会因为配了 dev 分支就变成联调", () => {
    const v = viewOf(mr({ targetBranch: undefined }), { "/work/web-app": "release" }, DEV);
    expect(v.kindLabel).toBe("提测");
    expect(v.target).toBe("release");
    expect(v.tooltipLines[0]).toContain("→ release");
  });

  it("连测试分支快照都没有：目标分支兜底成 test", () => {
    expect(viewOf(mr({ targetBranch: undefined }), undefined, undefined).target).toBe("test");
  });

  it("同仓提测 + 联调并存：两个入口的 key 不同", () => {
    const [a, b] = buildMrViews(
      [mr({ targetBranch: "test" }), mr({ targetBranch: "dev", url: URL_B })],
      TEST,
      DEV,
    );
    expect(a!.key).not.toBe(b!.key);
  });

  // 重复 key 只能在这一层守：React 的 key 校验在 reconciler 里，服务端渲染（renderToStaticMarkup /
  // renderToString）遇到重复 key 一次 console.error 都不报（实测 react 19.2.5）；项目里又没有 DOM 测试环境，
  // 没法在渲染层检出——所以别在 SSR 用例里写「没有重复 key 警告」，那是空操作断言
  it("老数据里两条一模一样的记录（仓路径空、目标分支和版本都相同）：key 也不重复（末尾的位置兜底）", () => {
    const same = mr({ repoPath: "", targetBranch: "x" });
    const [a, b] = buildMrViews([same, same], {}, undefined);
    expect(a!.key).not.toBe(b!.key);
  });

  it("空数组 → 空数组", () => {
    expect(buildMrViews([], TEST, DEV)).toEqual([]);
  });
});

describe("buildMrViews · 仓名 / 版本 / tooltip", () => {
  it.each([
    ["/work/web-app", "web-app"],
    ["/work/web-app/", "web-app"],
    ["web-app", "web-app"],
    // 旧实现 split("/") 在 Windows 路径上会把整条路径当仓名
    ["C:\\a\\b", "b"],
    ["D:\\proj\\web-app\\", "web-app"],
  ])("仓名取路径最后一段：%s → %s", (repoPath, name) => {
    expect(viewOf(mr({ repoPath }), {}).repoLabel).toBe(name);
  });

  it("版本：大于 1 才带「 v2」，等于 1 不带；坏值不带也不崩", () => {
    expect(viewOf(mr({ version: 1 })).repoLabel).toBe("web-app");
    expect(viewOf(mr({ version: 3 })).repoLabel).toBe("web-app v3");
    expect(viewOf(mr({ version: Number.NaN })).repoLabel).toBe("web-app");
    expect(viewOf(mr({ version: undefined as unknown as number })).repoLabel).toBe("web-app");
    // NaN / undefined 对 `> 1` 本来就为假，钉不住 Number.isFinite；字符串和 Infinity 才能（去掉守卫后分别渲染成 v2 / vInfinity）
    expect(viewOf(mr({ version: "2" as unknown as number })).repoLabel).toBe("web-app");
    expect(viewOf(mr({ version: Number.POSITIVE_INFINITY })).repoLabel).toBe("web-app");
  });

  it("tooltip 三层：类型 → 目标分支 / 标题 / 地址", () => {
    expect(viewOf(mr()).tooltipLines).toEqual(["提测 → test", "feat: 新增登录", URL_A]);
  });

  // F-P12-1：status 提交后没人更新，展示它就是错误陈述——无论取什么值，派生数据里都不带状态
  it.each(["open", "merged", "closed", "weird", undefined])(
    "status=%s：派生数据里没有任何 MR 状态（不展示进行中 / 已合并 / 已关闭）",
    (status) => {
      const v = viewOf(mr({ status: status as MRRecord["status"] }));
      expect(JSON.stringify(v)).not.toMatch(STATUS_WORDS);
      expect(JSON.stringify(v)).not.toMatch(/merged|closed/);
    },
  );
});

describe("buildMrViews · 链接只认 http(s)", () => {
  it.each([
    ["", null],
    ["   ", null],
    // <a href=""> 点开会在新标签页里再打开一遍当前页面
    ["javascript:alert(1)", null],
    ["ftp://host/x", null],
    ["//gitlab.example.com/x", null],
    ["https:evil", null],
    ["gitlab.example.com/x", null],
    ["https://a/x", "https://a/x"],
    ["HTTP://A/X", "HTTP://A/X"],
    ["  https://a/x  ", "https://a/x"],
  ])("url %j → href %j", (url, href) => {
    expect(viewOf(mr({ url })).href).toBe(href);
  });

  it("不可点击的 url 仍写进 tooltip（便于排查这条记录是怎么回事），空串不写空行", () => {
    expect(viewOf(mr({ url: "javascript:alert(1)" })).tooltipLines).toContain("javascript:alert(1)");
    expect(viewOf(mr({ url: "" })).tooltipLines).toEqual(["提测 → test", "feat: 新增登录"]);
  });

  it("记录字段缺失的老数据不让头部渲染抛错：不出现 undefined、不能点", () => {
    const broken = mr({
      title: undefined as unknown as string,
      url: undefined as unknown as string,
      status: "weird" as MRRecord["status"],
      repoPath: undefined as unknown as string,
    });
    let v: ReturnType<typeof viewOf> | undefined;
    expect(() => {
      v = viewOf(broken, {});
    }).not.toThrow();
    expect(v!.href).toBeNull();
    expect(v!.tooltipLines.join("\n")).not.toContain("undefined");
    // 仓路径缺失：仓名是空串、key 里也不能冒出字面量 undefined（去掉 repoPath 的 typeof 守卫就会）
    expect(v!.repoLabel).toBe("");
    expect(v!.key).not.toContain("undefined");
    // repoPath 不是字符串（null / 数字）：不抛（数字会让 pathBasename 里的 replace 抛 TypeError），仓名同样是空串
    for (const bad of [null, 42]) {
      let bv: ReturnType<typeof viewOf> | undefined;
      expect(() => {
        bv = viewOf(mr({ repoPath: bad as unknown as string }), {});
      }).not.toThrow();
      expect(bv!.repoLabel).toBe("");
      expect(bv!.key).not.toContain("null");
    }
  });
});

describe("TaskMrLinks · SSR 渲染", () => {
  const render = (
    mrs: MRRecord[],
    branches: { repoTestBranches?: Record<string, string>; repoDevBranches?: Record<string, string> } = {},
  ): string => renderToStaticMarkup(createElement(TaskMrLinks, { mrs, ...branches }));
  const anchors = (html: string): string[] => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

  it("没有 MR：什么都不渲染（不留空容器）", () => {
    expect(render([])).toBe("");
  });

  it("mrs 缺失的老 meta：当作没有，不抛", () => {
    expect(render(undefined as unknown as MRRecord[])).toBe("");
  });

  it("单仓：一个在新标签页打开的链接，带提测标和仓名", () => {
    const html = render([mr()], { repoTestBranches: TEST });
    const [a, ...rest] = anchors(html);
    expect(rest).toHaveLength(0);
    expect(a).toContain(`href="${URL_A}"`);
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer"');
    expect(html).toContain("提测");
    expect(html).toContain("web-app");
    // 能点的才画外链图标（下面「不是 http(s)」那条断言它不出现，这里先证明这个检测不是空操作）
    expect(html).toContain("lucide-external-link");
  });

  it("多仓：每个 MR 一个入口，顺序和 mrs 一致", () => {
    const urls = [
      "https://gitlab.example.com/g/a/-/merge_requests/1",
      "https://gitlab.example.com/g/b/-/merge_requests/2",
      "https://gitlab.example.com/g/c/-/merge_requests/3",
    ];
    const html = render([
      mr({ repoPath: "/w/a", url: urls[0]! }),
      mr({ repoPath: "/w/b", url: urls[1]! }),
      mr({ repoPath: "/w/c", url: urls[2]! }),
    ]);
    const hrefs = anchors(html).map((a) => /href="([^"]*)"/.exec(a)?.[1]);
    expect(hrefs).toEqual(urls);
    expect(html.indexOf(">a<")).toBeLessThan(html.indexOf(">b<"));
  });

  // 这里的 console.error spy 抓得到「缺 key」之类的 React 开发期警告，抓不到「重复 key」（见 ① 里的 key 用例）
  it("同仓提测 + 联调并存：两个入口各带各的标，且没有 React 开发期警告（缺 key 等）", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = render(
      [mr({ targetBranch: "test" }), mr({ targetBranch: "dev", url: URL_B })],
      { repoTestBranches: TEST, repoDevBranches: DEV },
    );
    expect(anchors(html)).toHaveLength(2);
    expect(html.indexOf("提测")).toBeGreaterThan(-1);
    expect(html.indexOf("联调")).toBeGreaterThan(html.indexOf("提测"));
    expect(err).not.toHaveBeenCalled();
  });

  it("老数据里两条一模一样的记录：照样渲染两个入口、不抛", () => {
    const same = mr({ repoPath: "", targetBranch: "x" });
    expect(anchors(render([same, same]))).toHaveLength(2);
  });

  it.each(["open", "merged", "closed", "weird"])("status=%s：页面上不出现任何 MR 状态字样", (status) => {
    expect(render([mr({ status: status as MRRecord["status"] })])).not.toMatch(STATUS_WORDS);
  });

  it("url 不是 http(s)：不渲染成链接（没有 <a>、没有 href），但标和仓名还在", () => {
    for (const url of ["", "javascript:alert(1)"]) {
      const html = render([mr({ url })]);
      expect(html).not.toContain("<a");
      expect(html).not.toContain("href=");
      // 点不开的不画外链图标（画了就是在骗人）
      expect(html).not.toContain("lucide-external-link");
      expect(html).toContain("提测");
      expect(html).toContain("web-app");
    }
  });

  it("Windows 路径的仓：渲染出来的是末段，不是整条路径", () => {
    const html = render([mr({ repoPath: "C:\\a\\b" })]);
    expect(html).toContain(">b<");
    expect(html).not.toContain("C:\\a\\b");
  });
});

describe("页面接线契约", () => {
  const repoDir = path.resolve(import.meta.dirname, "..");
  const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");
  const page = read("src/app/tasks/[id]/page.tsx");
  const comp = read("src/components/tasks/task-mr-links.tsx");
  /** 去掉注释后的组件代码（注释里要解释「为什么不展示状态」，会出现 status 字样） */
  const compCode = comp.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const WS = "<WorkspaceActions task={task} />";

  it("page.tsx import 并挂了 TaskMrLinks，且紧跟在 WorkspaceActions 后面（v1.7.1 悄悄丢过一次）", () => {
    expect(page).toContain('import { TaskMrLinks } from "@/components/tasks/task-mr-links";');
    const ws = page.indexOf(WS);
    const ml = page.indexOf("<TaskMrLinks");
    expect(ws).toBeGreaterThan(-1);
    expect(ml).toBeGreaterThan(ws);
    // 两者之间只允许有注释
    const between = page.slice(ws + WS.length, ml).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(between.trim()).toBe("");
  });

  it("只传它需要的三个 props，不传整个 task（叶子只拿自己要的字段）", () => {
    const ml = page.indexOf("<TaskMrLinks");
    const tag = page.slice(ml, page.indexOf("/>", ml) + 2);
    expect(tag).toContain("mrs={task.mrs}");
    expect(tag).toContain("repoTestBranches={task.repoTestBranches}");
    expect(tag).toContain("repoDevBranches={task.repoDevBranches}");
    expect(tag).not.toMatch(/\btask=\{/);
  });

  it("组件导出的是 memo(...)", () => {
    expect(comp).toMatch(/export const TaskMrLinks = memo\(TaskMrLinksImpl\);/);
  });

  it("链接外面包了 Tooltip、内容来自 tooltipLines（hover 提示一律 Tooltip；弹层 SSR 里不渲染，只能守文本）", () => {
    expect(comp).toContain('import { Tooltip } from "@/components/ui/tooltip";');
    expect(comp).toMatch(/<Tooltip\b[^>]*\bkey=\{v\.key\}[\s\S]*?content=\{/);
    expect(comp).toContain("v.tooltipLines.map(");
  });

  it("组件代码里不读 MR 的 status（它提交后没人更新，别顺手加回来）", () => {
    expect(compCode).not.toMatch(/\bstatus\b/);
  });
});
