/**
 * 「Enter 提交 / 确认」处必须带 IME 判断的契约（S14-01 / R7）
 *
 * 中文输入法选词时按 Enter 会触发 keydown（key === "Enter"），不判断就会把「选词」误当「提交」。
 * 口径统一走 `src/lib/ime.ts` 的 `isImeComposing`（同时看 isComposing 与 keyCode 229）。
 *
 * 做法：用 TypeScript AST 扫 src/components、src/hooks、src/lib 下**每一处** `xxx.key === "Enter"`
 * （含 !== / == / != 与 `case "Enter":`）比较，取其**最内层函数**（onKeyDown handler、判定 helper 等），
 * 要求**同一函数体内**出现 `isImeComposing(...)` 调用——别的 handler 里的守卫不算数。
 * 不是 IME 风险的、或已知缺口，只能在下方 EXEMPT / PENDING 里按「文件 + 函数名 + 比较表达式」逐条登记并写原因。
 * UI 在 node 环境跑不起来，靠 AST 契约守住。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

/** 只扫客户端代码（server 目录没有键盘事件） */
const SCAN_DIRS = ["components", "hooks", "lib"];
const SKIP_DIR_NAMES = new Set(["server"]);

interface ExemptEntry {
  /** 相对 src 的路径 */
  file: string;
  /** 最内层函数名（变量 / 属性 / JSX 属性名） */
  fn: string;
  /** Enter 比较的源码文本 */
  expr: string;
  reason: string;
}

/** 永久豁免：这处 Enter 判断不会把 IME 选词当提交 */
const EXEMPT: ExemptEntry[] = [
  {
    file: "components/ui/checkbox-row.tsx",
    fn: "onRowKeyDown",
    expr: 'e.key === "Enter"',
    reason: "复选行 Enter / Space 切换，不是文本输入、不会有 IME 组合",
  },
  {
    file: "components/composer-editor.tsx",
    fn: "onKeyDown",
    expr: 'e.key === "Enter"',
    reason:
      "这里是 `if (Enter) return;` 把 Enter 让给 Lexical KEY_ENTER_COMMAND；提交判定在 shouldSubmitNative（已带 isImeComposing）",
  },
];

/**
 * 待处理名单：文件有用户未提交改动、本轮不允许碰。**修好后必须从这里删掉**
 * （下面有用例保证名单里的条目确实仍违规，修了没删会报错提醒）。
 */
const PENDING: ExemptEntry[] = [];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIR_NAMES.has(name)) walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
};

type FnNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

const isFn = (n: ts.Node): n is FnNode =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);

/** 函数的「名字」：声明名 / 赋值的变量 / 对象属性 / JSX 属性（穿过 useCallback(...) 等包装） */
const fnName = (fn: FnNode): string => {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) {
    return fn.name.getText();
  }
  for (let p: ts.Node | undefined = fn.parent; p; p = p.parent) {
    if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) return p.name.getText();
    if (ts.isJsxAttribute(p)) return p.name.getText();
    if (isFn(p)) break;
  }
  return "<anonymous>";
};

const isEnterLiteral = (n: ts.Node): boolean =>
  (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "Enter";

/** `.key` / 裸 `key` 标识符——只认键盘事件的 key，避免误抓别的 "Enter" 字符串比较 */
const isKeyRef = (n: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(n) && n.name.text === "key") ||
  (ts.isIdentifier(n) && n.text === "key");

const EQ_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const hasImeGuardCall = (fn: FnNode): boolean => {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (name === "isImeComposing") {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
};

interface EnterSite {
  fn: string;
  expr: string;
  line: number;
  guarded: boolean;
}

/** 枚举源码里每一处 key === "Enter" 比较，及其最内层函数里有没有 isImeComposing( 调用 */
const findEnterSites = (text: string, fileName = "x.tsx"): EnterSite[] => {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: EnterSite[] = [];
  const record = (node: ts.Node, expr: string) => {
    let fn: FnNode | undefined;
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (isFn(p)) {
        fn = p;
        break;
      }
    }
    sites.push({
      fn: fn ? fnName(fn) : "<module>",
      expr,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      guarded: fn ? hasImeGuardCall(fn) : false,
    });
  };
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) &&
      EQ_OPS.has(n.operatorToken.kind) &&
      ((isEnterLiteral(n.right) && isKeyRef(n.left)) || (isEnterLiteral(n.left) && isKeyRef(n.right)))
    ) {
      record(n, n.getText(sf));
    } else if (
      ts.isCaseClause(n) &&
      isEnterLiteral(n.expression) &&
      ts.isSwitchStatement(n.parent.parent) &&
      isKeyRef(n.parent.parent.expression)
    ) {
      record(n, `case "Enter"`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
};

const files = SCAN_DIRS.flatMap((d) => walk(path.join(srcDir, d))).map((f) => ({
  abs: f,
  rel: path.relative(srcDir, f).split(path.sep).join("/"),
}));

const sitesByFile = new Map(
  files.map((f) => [f.rel, findEnterSites(readFileSync(f.abs, "utf8"), f.abs)] as const),
);

const matches = (e: ExemptEntry, rel: string, s: EnterSite): boolean =>
  e.file === rel && e.fn === s.fn && e.expr === s.expr;

describe("Enter 提交 / 确认处必须带 IME 判断（AST：同一函数体内）", () => {
  it("没有遗漏的 Enter 处理（逐条登记的豁免 / 待处理除外）", () => {
    const offenders: string[] = [];
    for (const [rel, sites] of sitesByFile) {
      for (const s of sites) {
        if (s.guarded) continue;
        if ([...EXEMPT, ...PENDING].some((e) => matches(e, rel, s))) continue;
        offenders.push(`${rel}:${s.line} (${s.fn}) ${s.expr}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("豁免名单每条都写了原因，且仍对应真实存在的 Enter 判断（代码改没了要清名单）", () => {
    for (const e of [...EXEMPT, ...PENDING]) {
      expect(e.reason.trim().length, `${e.file} 缺原因`).toBeGreaterThan(0);
      const sites = sitesByFile.get(e.file) ?? [];
      expect(
        sites.some((s) => matches(e, e.file, s)),
        `${e.file}::${e.fn}::${e.expr} 在源码里已找不到，请从名单删除`,
      ).toBe(true);
    }
  });

  it("待处理名单里的条目确实仍缺判断（修好了要从名单删掉）", () => {
    for (const e of PENDING) {
      const sites = (sitesByFile.get(e.file) ?? []).filter((s) => matches(e, e.file, s));
      expect(sites.length, `${e.file} 找不到条目`).toBeGreaterThan(0);
      for (const s of sites) {
        expect(s.guarded, `${e.file}:${s.line} 已修好、请移出 PENDING`).toBe(false);
      }
    }
  });

  it("永久豁免项没有多余：已带守卫的条目不该留在豁免名单里", () => {
    for (const e of EXEMPT) {
      const sites = (sitesByFile.get(e.file) ?? []).filter((s) => matches(e, e.file, s));
      for (const s of sites) {
        expect(s.guarded, `${e.file}:${s.line} 已带守卫、无需豁免`).toBe(false);
      }
    }
  });

  it("检测器自检：别的 handler 里的守卫不算、同函数内守卫才算、注释里的 Enter 不算", () => {
    const sites = findEnterSites(`
      // 注释里的 "Enter" 不算
      const a = (e) => { if (e.key === "Enter") submit(); };
      const b = (e) => { if (isImeComposing(e)) return; if (e.key === "Enter") submit(); };
      const c = (e) => { if (e.key !== "Enter" || isImeComposing(e)) return; submit(); };
      const guardOnlyHere = (e) => isImeComposing(e);
      const d = (e) => { switch (e.key) { case "Enter": submit(); } };
      const outer = (e) => {
        if (isImeComposing(e)) return;
        items.forEach((x) => { if (x.key === 'Enter') submit(); });
      };
    `);
    expect(sites.map((s) => [s.fn, s.guarded])).toEqual([
      ["a", false],
      ["b", true],
      ["c", true],
      ["d", false],
      ["<anonymous>", false],
    ]);
  });

  it("此前缺判断的几处现在都走共享 helper", () => {
    const mustUseHelper = [
      "hooks/use-dialog.tsx",
      "components/tasks/requirement-group-dialog.tsx",
      "components/tasks/chat-queue-banner.tsx",
      "components/tasks/event-stream-search-bar.tsx",
    ];
    for (const rel of mustUseHelper) {
      const src = readFileSync(path.join(srcDir, rel), "utf8");
      expect(src, rel).toMatch(/import \{ isImeComposing \} from "@\/lib\/ime"/);
      expect(src, rel).toMatch(/isImeComposing\(e\)/);
    }
  });
});
