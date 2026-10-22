/**
 * S13-20：工作项预览外链只放行 http(s)；防重复按 id / 归一化链接。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  decideWorkitemGate,
  extractWorkitemIdFromUrl,
  findExistingWorkitemTask,
  normalizeWorkitemUrl,
  resolveTaskLookup,
  shouldTrustCachedTaskLink,
  safeHttpUrl,
} from "@/lib/workitem-link";

describe("safeHttpUrl", () => {
  it("放行 http / https", () => {
    expect(safeHttpUrl("https://project.feishu.cn/p/story/detail/123456")).toBe(
      "https://project.feishu.cn/p/story/detail/123456",
    );
    expect(safeHttpUrl("  http://a.com/x  ")).toBe("http://a.com/x");
  });

  it("拒绝 javascript: / data: / file: / 相对路径 / 空", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBe("");
    expect(safeHttpUrl("JaVaScRiPt:alert(1)")).toBe("");
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(safeHttpUrl("file:///etc/passwd")).toBe("");
    expect(safeHttpUrl("/relative/path")).toBe("");
    expect(safeHttpUrl("")).toBe("");
    expect(safeHttpUrl(null)).toBe("");
    expect(safeHttpUrl(undefined)).toBe("");
  });

  it("拒绝带账号密码的链接", () => {
    expect(safeHttpUrl("https://user:pw@evil.com/x")).toBe("");
  });
});

describe("normalizeWorkitemUrl", () => {
  it("忽略 query / hash / 尾斜杠 / host 大小写", () => {
    const a = normalizeWorkitemUrl("https://Project.Feishu.cn/p/story/detail/1/?x=1#h");
    const b = normalizeWorkitemUrl("https://project.feishu.cn/p/story/detail/1");
    expect(a).toBe(b);
    expect(a).not.toBe("");
  });
  it("非 http(s) → 空串，不参与比对", () => {
    expect(normalizeWorkitemUrl("javascript:1")).toBe("");
  });
});

describe("extractWorkitemIdFromUrl（只认详情路径里的 /detail/<id>）", () => {
  it("已知详情形态：/<空间>/<类型>/detail/<id>、带 query / 尾斜杠 / 多级前缀", () => {
    expect(
      extractWorkitemIdFromUrl("https://project.feishu.cn/sp/story/detail/6543210"),
    ).toBe("6543210");
    expect(
      extractWorkitemIdFromUrl("https://project.feishu.cn/sp/bug/detail/42/?x=1#h"),
    ).toBe("42");
    expect(
      extractWorkitemIdFromUrl(
        "https://meegle.example.com/sp/workitem/story/detail/777888?from=board",
      ),
    ).toBe("777888");
  });

  it("误命中样本：query / hash / 其它路径段里的长数字不取", () => {
    // query 里的时间戳
    expect(
      extractWorkitemIdFromUrl("https://p.cn/sp/board?ts=1700000000000"),
    ).toBeNull();
    // detail 段缺失，路径里是无关长数字
    expect(extractWorkitemIdFromUrl("https://p.cn/sp/view/20260101123456")).toBeNull();
    // hash 里的长数字
    expect(extractWorkitemIdFromUrl("https://p.cn/sp/story#1234567890")).toBeNull();
    // detail 后不是纯数字
    expect(extractWorkitemIdFromUrl("https://p.cn/sp/story/detail/abc123456")).toBeNull();
    // 数字只是更长 id 的一部分（detail/123abc）
    expect(extractWorkitemIdFromUrl("https://p.cn/sp/story/detail/123abc")).toBeNull();
  });

  it("detail 在 query 里不算；非法协议 / 空 → null", () => {
    expect(
      extractWorkitemIdFromUrl("https://p.cn/sp/board?next=/story/detail/123456"),
    ).toBeNull();
    expect(extractWorkitemIdFromUrl("javascript:/detail/123456")).toBeNull();
    expect(extractWorkitemIdFromUrl("")).toBeNull();
    expect(extractWorkitemIdFromUrl(undefined)).toBeNull();
  });
});

describe("findExistingWorkitemTask", () => {
  const tasks = [
    { id: "c", mode: "chat", feishuStoryUrl: "https://p.cn/x/story/detail/777777" },
    { id: "t1", mode: "task", feishuStoryUrl: "https://p.cn/x/story/detail/123456?from=board" },
    { id: "t2", mode: "task", feishuStoryUrl: "" },
  ];

  it("路由 id 命中", () => {
    expect(findExistingWorkitemTask(tasks, { id: "123456" })?.id).toBe("t1");
  });

  it("路由 id 不对、但链接里的 id 命中", () => {
    expect(
      findExistingWorkitemTask(tasks, {
        id: "999999",
        // 路径与任务链接不同、归一化链接对不上：只能靠链接里抠出的 id 命中
        url: "https://p.cn/other/story/detail/123456",
      })?.id,
    ).toBe("t1");
  });

  it("归一化后链接相同命中（任务链接没有可抠的 id 时）", () => {
    const ts = [{ id: "n", mode: "task", feishuStoryUrl: "https://P.cn/a/b/" }];
    expect(
      findExistingWorkitemTask(ts, { id: "x", url: "https://p.cn/a/b?z=1" })?.id,
    ).toBe("n");
  });

  it("chat 模式不算；子串不算", () => {
    expect(findExistingWorkitemTask(tasks, { id: "777777" })).toBeUndefined();
    expect(findExistingWorkitemTask(tasks, { id: "12345" })).toBeUndefined();
  });

  it("预览链接 query 里的时间戳 / 无关长数字撞上已有任务 id 也不命中", () => {
    // 任务 t1 的 id=123456；预览链接是别的工作项、只是 query 里带了同样的数字
    expect(
      findExistingWorkitemTask(tasks, {
        id: "999999",
        url: "https://p.cn/x/story/detail/888888?ts=123456",
      }),
    ).toBeUndefined();
    expect(
      findExistingWorkitemTask(tasks, {
        id: "999999",
        url: "https://p.cn/x/board?from=123456",
      }),
    ).toBeUndefined();
  });

  it("已有任务的链接 query 里带长数字，也不会被当成它的工作项 id", () => {
    const ts = [
      { id: "q", mode: "task", feishuStoryUrl: "https://p.cn/x/board?ts=555555" },
    ];
    expect(findExistingWorkitemTask(ts, { id: "555555" })).toBeUndefined();
  });

  it("非法 javascript: 链接不参与匹配", () => {
    expect(
      findExistingWorkitemTask(tasks, { id: "nope", url: "javascript:123456" }),
    ).toBeUndefined();
  });
});

describe("decideWorkitemGate（N9-02：任务列表没加载完不能放表单）", () => {
  const hit = { id: "t1" };

  it("没加载完：不管有没有 existing 都是 loading（此时 tasks 为空、existing 必然查不到）", () => {
    expect(decideWorkitemGate({ loaded: false, existing: undefined, forceNew: false })).toBe(
      "loading",
    );
    expect(decideWorkitemGate({ loaded: false, existing: hit, forceNew: false })).toBe("loading");
    // forceNew / formShown 也不能越过 loading
    expect(decideWorkitemGate({ loaded: false, existing: hit, forceNew: true })).toBe("loading");
    expect(
      decideWorkitemGate({ loaded: false, existing: undefined, forceNew: false, formShown: true }),
    ).toBe("loading");
  });

  it("加载完 + 没有已有任务 → 表单", () => {
    expect(decideWorkitemGate({ loaded: true, existing: undefined, forceNew: false })).toBe(
      "form",
    );
  });

  it("加载完 + 撞上已有任务 → 默认收起表单，点「仍要新建」（forceNew）才展开（上一轮设计）", () => {
    expect(decideWorkitemGate({ loaded: true, existing: hit, forceNew: false })).toBe("existing");
    expect(decideWorkitemGate({ loaded: true, existing: hit, forceNew: true })).toBe("form");
  });

  it("表单已放出过：之后才匹配到已有任务也不收回表单（防丢已填内容），无论 forceNew", () => {
    expect(
      decideWorkitemGate({ loaded: true, existing: hit, forceNew: false, formShown: true }),
    ).toBe("form");
    expect(
      decideWorkitemGate({ loaded: true, existing: hit, forceNew: true, formShown: true }),
    ).toBe("form");
  });

  it("首次加载时序：loading → 匹配上 → existing，全程没有出现过 form（表单不会先挂后卸）", () => {
    // 模拟页面逐帧：tasks 空未加载 → 加载完带回已有任务
    const frames = [
      { loaded: false, existing: undefined },
      { loaded: true, existing: hit },
    ].map((f) => decideWorkitemGate({ ...f, forceNew: false }));
    expect(frames).toEqual(["loading", "existing"]);
    expect(frames).not.toContain("form");
  });

  // ---- F3-03：列表加载失败（loaded 为 true、但没拉到）不能放表单 ----

  it("列表首拉失败（loaded + 没数据 + 有 loadError）→ error，不是 form（否则对已有任务的需求会重复启动）", () => {
    expect(
      decideWorkitemGate({
        loaded: true,
        existing: undefined,
        forceNew: false,
        loadError: "HTTP 503",
        taskCount: 0,
      }),
    ).toBe("error");
  });

  it("没有失败（loadError 为 null / 缺省）+ 列表真的为空 → 仍是 form", () => {
    expect(
      decideWorkitemGate({
        loaded: true,
        existing: undefined,
        forceNew: false,
        loadError: null,
        taskCount: 0,
      }),
    ).toBe("form");
    // 老调用方不传 loadError / taskCount：行为不变
    expect(decideWorkitemGate({ loaded: true, existing: undefined, forceNew: false })).toBe(
      "form",
    );
  });

  it("没加载完仍是 loading（loadError 不能越过 loading 抢先画失败）", () => {
    expect(
      decideWorkitemGate({
        loaded: false,
        existing: undefined,
        forceNew: false,
        loadError: "断网",
        taskCount: 0,
      }),
    ).toBe("loading");
  });

  it("已有旧数据时后台刷新失败 → 仍按 ready 走（口径同侧栏 / /chats：不拿失败态盖掉能用的旧列表）", () => {
    expect(
      decideWorkitemGate({
        loaded: true,
        existing: undefined,
        forceNew: false,
        loadError: "断网",
        taskCount: 5,
      }),
    ).toBe("form");
  });

  it("只传 loadError、忘了 taskCount：按 0 算、宁可挡住表单也不在失败时放行", () => {
    expect(
      decideWorkitemGate({
        loaded: true,
        existing: undefined,
        forceNew: false,
        loadError: "断网",
      }),
    ).toBe("error");
  });

  it("命中已有任务是正证据：即使 loadError 非空也走 existing / form（点「仍要新建」），不降成 error", () => {
    expect(
      decideWorkitemGate({
        loaded: true,
        existing: hit,
        forceNew: false,
        loadError: "断网",
        taskCount: 0,
      }),
    ).toBe("existing");
    expect(
      decideWorkitemGate({
        loaded: true,
        existing: hit,
        forceNew: true,
        loadError: "断网",
        taskCount: 0,
      }),
    ).toBe("form");
  });

  it("表单已放出过：之后后台刷新失败也不收回表单（防丢已填内容）", () => {
    expect(
      decideWorkitemGate({
        loaded: true,
        existing: undefined,
        forceNew: false,
        formShown: true,
        loadError: "断网",
        taskCount: 0,
      }),
    ).toBe("form");
  });

  it("时序：首拉失败 → 点重试成功（loadError 清掉）→ 表单放出；全程失败那一帧没有 form", () => {
    const frames = [
      { loaded: false, loadError: null, taskCount: 0 },
      { loaded: true, loadError: "HTTP 503", taskCount: 0 },
      { loaded: true, loadError: null, taskCount: 0 },
    ].map((f) => decideWorkitemGate({ ...f, existing: undefined, forceNew: false }));
    expect(frames).toEqual(["loading", "error", "form"]);
  });
});

describe("resolveTaskLookup（收件箱「改bug」等按已有任务分流的入口）", () => {
  it("没命中 + 没加载完 → pending（不能当成「没有」去引导新建）", () => {
    expect(resolveTaskLookup(false, undefined)).toBe("pending");
  });
  it("没命中 + 加载完 → miss；命中 → hit（命中是正证据，不管是否加载完）", () => {
    expect(resolveTaskLookup(true, undefined)).toBe("miss");
    expect(resolveTaskLookup(true, { id: "t" })).toBe("hit");
    expect(resolveTaskLookup(false, { id: "t" })).toBe("hit");
  });
  it("列表首拉失败（loaded=true、没数据、有 loadError）→ unknown，不当「没有」引导新建", () => {
    expect(resolveTaskLookup(true, undefined, { loadError: "HTTP 500", taskCount: 0 })).toBe("unknown");
  });
  it("失败但有旧数据 / 没失败 / 命中 → 与旧口径一致", () => {
    expect(resolveTaskLookup(true, undefined, { loadError: "HTTP 500", taskCount: 3 })).toBe("miss");
    expect(resolveTaskLookup(true, undefined, { loadError: null, taskCount: 0 })).toBe("miss");
    expect(resolveTaskLookup(true, { id: "t" }, { loadError: "HTTP 500", taskCount: 0 })).toBe("hit");
    expect(resolveTaskLookup(false, undefined, { loadError: "HTTP 500", taskCount: 0 })).toBe("pending");
  });
});

describe("shouldTrustCachedTaskLink（飞书看板点已有任务）", () => {
  it("没加载完 → 信缓存", () => {
    expect(shouldTrustCachedTaskLink({ loaded: false, taskCount: 0 })).toBe(true);
  });
  it("首拉失败（没数据 + 有失败）→ 信缓存，不被误导去预览页重复建任务", () => {
    expect(shouldTrustCachedTaskLink({ loaded: true, loadError: "HTTP 500", taskCount: 0 })).toBe(true);
  });
  it("有数据（含旧数据）/ 确实没有任务 → 用实时列表校验", () => {
    expect(shouldTrustCachedTaskLink({ loaded: true, loadError: "HTTP 500", taskCount: 2 })).toBe(false);
    expect(shouldTrustCachedTaskLink({ loaded: true, loadError: null, taskCount: 2 })).toBe(false);
    expect(shouldTrustCachedTaskLink({ loaded: true, loadError: null, taskCount: 0 })).toBe(false);
  });
});

describe("接线契约", () => {
  const read = (p: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", p), "utf-8");
  const parseTsx = (p: string): ts.SourceFile =>
    ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const walk = (root: ts.Node, visit: (n: ts.Node) => void) => {
    const go = (n: ts.Node) => {
      visit(n);
      ts.forEachChild(n, go);
    };
    go(root);
  };
  /** 取 `const { a, b: c } = useTaskList()` 解构出的「属性名 → 本地名」 */
  const useTaskListBindings = (sf: ts.SourceFile): Map<string, string> => {
    const out = new Map<string, string>();
    walk(sf, (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isObjectBindingPattern(n.name) &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        n.initializer.expression.getText(sf) === "useTaskList"
      ) {
        for (const el of n.name.elements) {
          const prop = (el.propertyName ?? el.name).getText(sf);
          out.set(prop, el.name.getText(sf));
        }
      }
    });
    return out;
  };

  it("预览页 / 手动建任务页 / 详情组件都过 safeHttpUrl", () => {
    expect(read("src/app/workitems/[id]/page.tsx")).toContain('safeHttpUrl(sp.get("url"))');
    expect(read("src/app/workitems/new/page.tsx")).toContain('safeHttpUrl(sp.get("bugUrl"))');
    expect(read("src/components/feishu/workitem-detail.tsx")).toContain("safeHttpUrl(rawUrl)");
  });

  it("预览页：loaded 真的喂给 decideWorkitemGate，且 TaskLaunchForm 只在 gate === \"form\" 下渲染", () => {
    const file = "src/app/workitems/[id]/page.tsx";
    const sf = parseTsx(file);

    // 1) 从 useTaskList() 取了 loaded
    const bindings = useTaskListBindings(sf);
    expect(bindings.get("loaded")).toBe("loaded");

    // 2) const gate = decideWorkitemGate({ loaded, ... })
    let gateCallArgs: ts.ObjectLiteralExpression | undefined;
    walk(sf, (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        n.name.getText(sf) === "gate" &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        n.initializer.expression.getText(sf) === "decideWorkitemGate"
      ) {
        const arg = n.initializer.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) gateCallArgs = arg;
      }
    });
    expect(gateCallArgs, "页面里必须有 const gate = decideWorkitemGate({...})").toBeDefined();
    const props = new Map<string, string>();
    for (const p of gateCallArgs!.properties) {
      if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.getText(sf), p.name.getText(sf));
      else if (ts.isPropertyAssignment(p)) props.set(p.name.getText(sf), p.initializer.getText(sf));
    }
    expect(props.get("loaded")).toBe("loaded");
    expect(props.get("existing")).toBe("existing");
    expect(props.get("forceNew")).toBe("forceNew");

    // 3) 页面里每一处 <TaskLaunchForm> 都是 `gate === "form" && (...)` 的右操作数——
    //    不能有绕过 gate 的渲染（旧写法 `(!existing || forceNew) &&` 就是这条红）
    const forms: ts.Node[] = [];
    walk(sf, (n) => {
      const tag = ts.isJsxSelfClosingElement(n)
        ? n.tagName
        : ts.isJsxOpeningElement(n)
          ? n.tagName
          : null;
      if (tag?.getText(sf) === "TaskLaunchForm") forms.push(n);
    });
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      let guard: string | null = null;
      for (let c: ts.Node = form, p = form.parent; p; c = p, p = p.parent) {
        if (
          ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          p.right === c
        ) {
          guard = p.left.getText(sf).replace(/\s+/g, "");
          break;
        }
      }
      expect(guard, "TaskLaunchForm 必须被 gate === \"form\" 守住").toBe('gate==="form"');
    }
  });

  it("收件箱「改bug」：任务列表没就绪时先挡住，再走「没找到 → 引导新建」", () => {
    const file = "src/components/mr-inbox/mr-inbox-panel.tsx";
    const sf = parseTsx(file);
    const bindings = useTaskListBindings(sf);
    // MyBugRow 里 loaded 绑定成 tasksLoaded（面板里别的组件没用 useTaskList）
    expect(bindings.get("loaded")).toBe("tasksLoaded");

    let handleFix: ts.ArrowFunction | undefined;
    walk(sf, (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        n.name.getText(sf) === "handleFix" &&
        n.initializer &&
        ts.isArrowFunction(n.initializer)
      ) {
        handleFix = n.initializer;
      }
    });
    expect(handleFix).toBeDefined();
    const body = handleFix!.body.getText(sf);
    const pendingAt = body.indexOf('lookup === "pending"');
    const unknownAt = body.indexOf('lookup === "unknown"');
    const guideAt = body.indexOf("新建改bug任务？");
    expect(body).toContain("resolveTaskLookup(tasksLoaded, hit, {");
    expect(pendingAt).toBeGreaterThan(-1);
    expect(unknownAt).toBeGreaterThan(-1);
    expect(guideAt).toBeGreaterThan(-1);
    // pending / unknown（列表首拉失败）拦截必须在「引导新建」的 confirm 之前
    expect(pendingAt).toBeLessThan(guideAt);
    expect(unknownAt).toBeLessThan(guideAt);
  });

  it("手动建任务页本身不做「已有任务」判断（分流在入口），不读 tasks，没有同类漏洞", () => {
    const sf = parseTsx("src/app/workitems/new/page.tsx");
    const bindings = useTaskListBindings(sf);
    expect([...bindings.keys()]).toEqual(["upsertTask"]);
  });
});
