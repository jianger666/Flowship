/**
 * use-mr-inbox 里 N1-03 轮询器的三处接线契约（AST 版）。
 *
 * tick / 回前台补拉 / 发起时刻的**行为**在 `mr-inbox-poller.test.ts` 里用假定时器测；hook 里只剩三处接线，
 * 没有 jsdom 没法渲染它，只能对源码做静态断言。以前这里用整文件正则，只能证明「这串字出现在文件里」：
 * 把 `poller.noteFetchStarted();` 注释掉（文本还在）/ 挪进 `finally`（发起时刻被完成时刻覆盖）/ 挪到响应之后
 * （失败路径不记发起时刻，持续失败时每拍重试）/ 注释掉 effect，正则全都放行。
 * 现在用 TypeScript AST：注释不算、位置要对、数量要对。
 *
 * ⚠ 这仍是静态契约，不是行为证明——它证明「接线语句还在、位置对」，证明不了渲染 / 重渲染时的行为；
 * 行为由轮询器测试负责。契约只钉三件事：poller 的持有方式、发起时刻的记录位置、effect 的启动 / 停止接线。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HOOK_FILE = path.resolve(__dirname, "..", "src/hooks/use-mr-inbox.tsx");

const parse = (text: string): ts.SourceFile =>
  ts.createSourceFile("use-mr-inbox.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
};

const collect = <T extends ts.Node>(
  root: ts.Node,
  pred: (n: ts.Node) => n is T,
): T[] => {
  const out: T[] = [];
  walk(root, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
};

const isCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n);

const calleeText = (sf: ts.SourceFile, c: ts.CallExpression): string =>
  c.expression.getText(sf);

/** `poller.noteFetchStarted()` */
const isNoteCall = (sf: ts.SourceFile, n: ts.Node): boolean =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  n.expression.expression.getText(sf) === "poller" &&
  n.expression.name.text === "noteFetchStarted";

/** `const scanOnce = useCallback(async (...) => { ... }, [...])` 的函数体 */
const findScanOnceBody = (sf: ts.SourceFile): ts.Block | undefined => {
  let body: ts.Block | undefined;
  walk(sf, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "scanOnce" &&
      n.initializer &&
      ts.isCallExpression(n.initializer)
    ) {
      const fn = n.initializer.arguments[0];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) {
        body = fn.body;
      }
    }
  });
  return body;
};

/** 契约断言本体：对任意源码文本跑（便于对「被改坏的文本」自测，见最后一个 describe） */
const checkHookWiring = (text: string): string[] => {
  const sf = parse(text);
  const problems: string[] = [];

  // ① poller 由 useState 持有（稳定对象；useMemo / useRef 都不行：useMemo 只是性能提示，lastFetchAt 会清零）
  const holders = collect(sf, ts.isVariableDeclaration).filter(
    (d) =>
      ts.isArrayBindingPattern(d.name) &&
      d.name.elements.length >= 1 &&
      ts.isBindingElement(d.name.elements[0]) &&
      d.name.elements[0].name.getText(sf) === "poller",
  );
  if (holders.length !== 1) {
    problems.push(`应恰好一处 const [poller] = useState(...)，实际 ${holders.length} 处`);
  } else {
    const init = holders[0].initializer;
    const arg = init && ts.isCallExpression(init) && calleeText(sf, init) === "useState" ? init.arguments[0] : undefined;
    const okArg =
      !!arg &&
      ((ts.isIdentifier(arg) && arg.text === "createDomInboxPoller") ||
        (ts.isArrowFunction(arg) &&
          arg.parameters.length === 0 &&
          ts.isCallExpression(arg.body) &&
          arg.body.expression.getText(sf) === "createDomInboxPoller" &&
          arg.body.arguments.length === 0));
    if (!okArg) problems.push("poller 必须由 useState(createDomInboxPoller) 或 useState(() => createDomInboxPoller()) 持有");
  }

  // ② 发起时刻：poller.noteFetchStarted() 是 scanOnce 函数体第一层的一条语句、在 try（含 await fetch）之前，全文件只一处
  const body = findScanOnceBody(sf);
  if (!body) {
    problems.push("找不到 const scanOnce = useCallback(async …)");
  } else {
    const stmts = body.statements;
    const noteIdx = stmts.findIndex((s) => ts.isExpressionStatement(s) && isNoteCall(sf, s.expression));
    const tryIdx = stmts.findIndex((s) => ts.isTryStatement(s));
    if (noteIdx < 0) problems.push("scanOnce 第一层语句里没有 poller.noteFetchStarted()");
    if (tryIdx < 0) problems.push("scanOnce 里没有 try");
    if (noteIdx >= 0 && tryIdx >= 0 && noteIdx > tryIdx) {
      problems.push("poller.noteFetchStarted() 必须在 try（发请求）之前：失败路径也要记发起时刻");
    }
  }
  let noteCount = 0;
  walk(sf, (n) => {
    if (isNoteCall(sf, n)) noteCount += 1;
  });
  if (noteCount !== 1) {
    problems.push(`poller.noteFetchStarted() 应全文件恰好一处（finally / 外层 refresh 里不能再记），实际 ${noteCount} 处`);
  }

  // ③ effect：useEffect(() => poller.start(refresh 或 () => void refresh()), [poller, refresh])，且 start 的返回值（停止函数）被 effect 返回
  const effects = collect(sf, isCall).filter((c) => calleeText(sf, c) === "useEffect");
  const wired = effects.filter((c) => {
    const fn = c.arguments[0];
    if (!fn || !ts.isArrowFunction(fn)) return false;
    const startCall = (e: ts.Node | undefined): ts.CallExpression | undefined =>
      e &&
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.expression.getText(sf) === "poller" &&
      e.expression.name.text === "start"
        ? e
        : undefined;
    let call: ts.CallExpression | undefined;
    if (ts.isBlock(fn.body)) {
      const ret = fn.body.statements.find(ts.isReturnStatement);
      call = startCall(ret?.expression);
    } else {
      call = startCall(fn.body);
    }
    if (!call) return false;
    const a = call.arguments[0];
    const okStartArg =
      !!a &&
      ((ts.isIdentifier(a) && a.text === "refresh") ||
        (ts.isArrowFunction(a) &&
          a.parameters.length === 0 &&
          /^void\s+refresh\(\)$/.test(a.body.getText(sf).trim())));
    if (!okStartArg) return false;
    const deps = c.arguments[1];
    if (!deps || !ts.isArrayLiteralExpression(deps)) return false;
    const names = deps.elements.map((e) => e.getText(sf));
    return names.includes("poller") && names.includes("refresh");
  });
  if (wired.length !== 1) {
    problems.push(
      `应恰好一个 useEffect(() => poller.start(refresh…), [poller, refresh]) 并返回停止函数，实际 ${wired.length} 个`,
    );
  }
  // 上面只数「返回 poller.start 的那个 effect」；全文件再数一遍 start 调用：多一个（比如不返回停止函数的 effect）就是双启动 + 泄漏
  const startCalls = collect(sf, isCall).filter(
    (c) =>
      ts.isPropertyAccessExpression(c.expression) &&
      c.expression.expression.getText(sf) === "poller" &&
      c.expression.name.text === "start",
  );
  if (startCalls.length !== 1) {
    problems.push(`poller.start(...) 应全文件恰好一处调用，实际 ${startCalls.length} 处（再多一个 effect 就是双启动 / 泄漏）`);
  }

  // ④ hook 不再自带 tick / 可见性监听 / 发起时刻 ref（AST 层面：注释里写不算）
  // 含 window. / globalThis. / self. 前缀：`window.setInterval(...)` 与裸 `setInterval(...)` 是同一回事
  const setIntervals = collect(sf, isCall).filter((c) => /(^|\.)setInterval$/.test(calleeText(sf, c)));
  if (setIntervals.length > 0) problems.push("hook 里不应再有 setInterval（节拍在轮询器里）");
  const visibilityListeners = collect(sf, isCall).filter(
    (c) =>
      calleeText(sf, c).endsWith("addEventListener") &&
      c.arguments[0] !== undefined &&
      ts.isStringLiteralLike(c.arguments[0]) &&
      c.arguments[0].text === "visibilitychange",
  );
  if (visibilityListeners.length > 0) problems.push("hook 里不应再监听 visibilitychange（补拉在轮询器里）");
  const legacyRefs = collect(sf, ts.isIdentifier).filter((i) => i.text === "lastFetchAtRef");
  if (legacyRefs.length > 0) problems.push("hook 里不应再有 lastFetchAtRef（发起时刻在轮询器里）");

  return problems;
};

describe("use-mr-inbox 接线 AST 契约（现版源码）", () => {
  it("poller 持有方式 / 发起时刻位置 / effect 接线 / 不带旧写法 —— 全部满足", () => {
    expect(checkHookWiring(readFileSync(HOOK_FILE, "utf8"))).toEqual([]);
  });
});

describe("契约自测：被改坏的源码文本必须被拦下（等价写法不能误杀）", () => {
  const good = readFileSync(HOOK_FILE, "utf8");
  const mutate = (from: string | RegExp, to: string): string => {
    const next = good.replace(from, to);
    expect(next, `变异没有命中：${String(from)}`).not.toBe(good);
    return next;
  };

  it("注释掉 noteFetchStarted（文本还在）→ 拦下", () => {
    const bad = mutate(/\n(\s*)poller\.noteFetchStarted\(\);/, "\n$1// poller.noteFetchStarted();");
    expect(checkHookWiring(bad).join("\n")).toMatch(/没有 poller\.noteFetchStarted\(\)|恰好一处/);
  });

  it("noteFetchStarted 挪进 finally（发起时刻被完成时刻覆盖）→ 拦下", () => {
    const bad = mutate(/\n(\s*)poller\.noteFetchStarted\(\);/, "").replace(
      /(\} finally \{\n)/,
      "$1      poller.noteFetchStarted();\n",
    );
    expect(checkHookWiring(bad).length).toBeGreaterThan(0);
  });

  it("noteFetchStarted 挪到响应之后（失败路径不记发起时刻）→ 拦下", () => {
    const moved = mutate(/\n(\s*)poller\.noteFetchStarted\(\);/, "").replace(
      /(\n\s*const fresh: MrInboxData = \{)/,
      "\n      poller.noteFetchStarted();$1",
    );
    expect(moved).toContain("poller.noteFetchStarted();\n      const fresh");
    expect(checkHookWiring(moved).length).toBeGreaterThan(0);
  });

  it("noteFetchStarted 多记一次（finally 里再记）→ 拦下", () => {
    const bad = mutate(/(\} finally \{\n)/, "$1      poller.noteFetchStarted();\n");
    expect(checkHookWiring(bad).join("\n")).toMatch(/恰好一处/);
  });

  it("useState 改成 useMemo / useRef 持有 → 拦下", () => {
    expect(
      checkHookWiring(mutate("const [poller] = useState(createDomInboxPoller);", "const poller = useMemo(createDomInboxPoller, []);")).join("\n"),
    ).toMatch(/useState/);
    expect(
      checkHookWiring(mutate("const [poller] = useState(createDomInboxPoller);", "const poller = useRef(createDomInboxPoller()).current;")).join("\n"),
    ).toMatch(/useState/);
  });

  it("effect 被注释掉 / 不返回停止函数 / 依赖少 poller → 拦下", () => {
    const line = "useEffect(() => poller.start(() => void refresh()), [poller, refresh]);";
    expect(good).toContain(line);
    expect(checkHookWiring(mutate(line, `// ${line}`)).join("\n")).toMatch(/useEffect/);
    expect(
      checkHookWiring(mutate(line, "useEffect(() => { poller.start(() => void refresh()); }, [poller, refresh]);")).join("\n"),
    ).toMatch(/useEffect/);
    expect(
      checkHookWiring(mutate(line, "useEffect(() => poller.start(() => void refresh()), [refresh]);")).join("\n"),
    ).toMatch(/useEffect/);
  });

  it("hook 又自带 setInterval / visibilitychange 监听 / lastFetchAtRef → 拦下", () => {
    const line = "useEffect(() => poller.start(() => void refresh()), [poller, refresh]);";
    expect(checkHookWiring(mutate(line, `${line}\n  useEffect(() => { const i = setInterval(() => void refresh(), 1); return () => clearInterval(i); }, [refresh]);`)).join("\n")).toMatch(/setInterval/);
    expect(checkHookWiring(mutate(line, `${line}\n  useEffect(() => { document.addEventListener("visibilitychange", () => undefined); }, []);`)).join("\n")).toMatch(/visibilitychange/);
    expect(checkHookWiring(mutate(line, `${line}\n  const lastFetchAtRef = { current: 0 };`)).join("\n")).toMatch(/lastFetchAtRef/);
  });

  it("带前缀的 window.setInterval / globalThis.setInterval 也算 → 拦下", () => {
    const line = "useEffect(() => poller.start(() => void refresh()), [poller, refresh]);";
    for (const callee of ["window.setInterval", "globalThis.setInterval", "self.setInterval"]) {
      const bad = mutate(
        line,
        `${line}\n  useEffect(() => { const t = ${callee}(() => void refresh(), 1); return () => clearInterval(t); }, [refresh]);`,
      );
      expect(checkHookWiring(bad).join("\n"), callee).toMatch(/setInterval/);
    }
  });

  it("多一个 poller.start 的 effect（不返回停止函数 → 双启动 + 泄漏）→ 拦下", () => {
    const line = "useEffect(() => poller.start(() => void refresh()), [poller, refresh]);";
    const bad = mutate(line, `${line}\n  useEffect(() => { poller.start(refresh); }, [poller, refresh]);`);
    expect(checkHookWiring(bad).join("\n")).toMatch(/恰好一处调用/);
  });

  it("等价写法不误杀：useState(() => createDomInboxPoller()) / poller.start(refresh) / effect 写成块体 return", () => {
    expect(
      checkHookWiring(mutate("const [poller] = useState(createDomInboxPoller);", "const [poller] = useState(() => createDomInboxPoller());")),
    ).toEqual([]);
    const line = "useEffect(() => poller.start(() => void refresh()), [poller, refresh]);";
    expect(checkHookWiring(mutate(line, "useEffect(() => poller.start(refresh), [poller, refresh]);"))).toEqual([]);
    expect(
      checkHookWiring(mutate(line, "useEffect(() => {\n    return poller.start(() => void refresh());\n  }, [refresh, poller]);")),
    ).toEqual([]);
  });

  it("注释里提到旧写法不算（只看 AST）", () => {
    const line = "useEffect(() => poller.start(() => void refresh()), [poller, refresh]);";
    expect(
      checkHookWiring(mutate(line, `// 以前这里是 setInterval(tick) + document.addEventListener("visibilitychange") + lastFetchAtRef\n  ${line}`)),
    ).toEqual([]);
  });
});
