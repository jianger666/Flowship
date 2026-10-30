/**
 * 「纯图标按钮必须有可访问名」契约（R14 B6-4 / Q19-01）
 *
 * 只有图标、靠 Tooltip 说明语义的按钮，对读屏用户是一个没有名字的「按钮」——Tooltip 只在 hover 时才有，
 * 读屏读不到。改前全仓恰有 17 处（工作区操作条 7、公司环境卡 4、动作布局 2、产物面板 2、仓库卡 1、WK 设置 1）。
 *
 * 做法（同 ime-enter-contract）：用 TypeScript AST 扫 `src/**\/*.tsx` 里每个目标标签
 * （Button / button / a / Link / 任何 `*Trigger`），满足以下全部条件就算违规：
 *  1. 它的子节点里有 lucide 图标，且没有任何文字（JsxText、动态表达式、sr-only 文字、未知组件都当「可能有文字」放过）；
 *  2. 自己没有 aria-label / aria-labelledby，也没有 `{...spread}`（展开可能带名字，保守放过）；
 *  3. `render={<X aria-label=… />}` 里没有名字、最近的 `*Trigger` 祖先也没有名字。
 * 不是纯图标按钮、或确有理由的，只能在 EXEMPT 里按「文件 + 标签」登记并写原因。
 *
 * 局限：图标经变量动态取（`const Icon = x.icon; <Icon />`）的认不出来（按「可能有文字」放过）；
 * 这条契约只保证「有名字」，名字写得好不好（带不带序号 / 仓名）靠下面几条针对性用例。
 * 读屏实际读什么、Windows / macOS 真机表现无法在 CI 验证。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

interface ExemptEntry {
  /** 相对 src 的路径 */
  file: string;
  /** 目标标签名 */
  tag: string;
  reason: string;
}

/** 永久豁免：这处纯图标按钮确有理由不需要名字（目前没有——17 处全部补了 aria-label） */
const EXEMPT: ExemptEntry[] = [];

const NAME_ATTRS = new Set(["aria-label", "aria-labelledby"]);
const PLAIN_TAGS = new Set(["Button", "button", "a", "Link"]);
const isTargetTag = (tag: string): boolean => PLAIN_TAGS.has(tag) || tag.endsWith("Trigger");

type JsxEl = ts.JsxElement | ts.JsxSelfClosingElement;
const isJsxEl = (n: ts.Node): n is JsxEl => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);
const openingOf = (n: JsxEl): ts.JsxOpeningLikeElement => (ts.isJsxElement(n) ? n.openingElement : n);
const tagOf = (n: JsxEl): string => openingOf(n).tagName.getText();
const attrsOf = (n: JsxEl): readonly ts.JsxAttributeLike[] => openingOf(n).attributes.properties;

const getAttr = (n: JsxEl, name: string): ts.JsxAttribute | undefined => {
  for (const a of attrsOf(n)) {
    if (ts.isJsxAttribute(a) && a.name.getText() === name) return a;
  }
  return undefined;
};
/**
 * `aria-label=""` / `aria-label="  "` / 没写值，不算名字——否则随手糊一个空串就能绕过这条契约。
 * 值是表达式（`{`删除 ${i}`}`、`{label}`）当作有名字：运行期是否为空无法静态判定（局限，见文件头）。
 */
const isBlankName = (a: ts.JsxAttribute): boolean => {
  const init = a.initializer;
  if (!init) return true;
  if (ts.isStringLiteral(init)) return init.text.trim() === "";
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text.trim() === "";
  }
  return false;
};
const hasNameAttr = (n: JsxEl): boolean =>
  attrsOf(n).some((a) => ts.isJsxAttribute(a) && NAME_ATTRS.has(a.name.getText()) && !isBlankName(a));
const hasSpread = (n: JsxEl): boolean => attrsOf(n).some((a) => ts.isJsxSpreadAttribute(a));

const classNameText = (n: JsxEl): string => getAttr(n, "className")?.initializer?.getText() ?? "";

/** `import { A, B as C } from "lucide-react"` 的本地名 */
const lucideNames = (sf: ts.SourceFile): Set<string> => {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "lucide-react") continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.add(el.name.text);
  }
  return names;
};

type Kind = "icon" | "empty" | "text";

const merge = (kinds: Kind[]): Kind => {
  if (kinds.includes("text")) return "text";
  return kinds.includes("icon") ? "icon" : "empty";
};

/** 一个子节点渲染出什么：图标 / 什么都没有 / 可能有文字（保守） */
const classify = (node: ts.Node, lucide: Set<string>): Kind => {
  if (ts.isJsxText(node)) return node.text.trim() === "" ? "empty" : "text";
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    if (lucide.has(tagOf(node))) return "icon";
    // sr-only 里的文字就是名字
    if (/\bsr-only\b/.test(classNameText(node))) return "text";
    // 未知的自闭合组件：保守当「可能有文字」
    if (ts.isJsxSelfClosingElement(node)) return "text";
    return merge(node.children.map((c) => classify(c, lucide)));
  }
  if (ts.isJsxFragment(node)) return merge(node.children.map((c) => classify(c, lucide)));
  if (ts.isJsxExpression(node)) return node.expression ? classifyExpr(node.expression, lucide) : "empty";
  return "text";
};

const classifyExpr = (e: ts.Expression, lucide: Set<string>): Kind => {
  if (ts.isParenthesizedExpression(e)) return classifyExpr(e.expression, lucide);
  if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "empty";
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return classify(e, lucide);
  if (ts.isConditionalExpression(e)) {
    return merge([classifyExpr(e.whenTrue, lucide), classifyExpr(e.whenFalse, lucide)]);
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return classifyExpr(e.right, lucide);
  }
  return "text";
};

const isIconOnly = (n: JsxEl, lucide: Set<string>): boolean => {
  if (!ts.isJsxElement(n)) return false;
  return merge(n.children.map((c) => classify(c, lucide))) === "icon";
};

/** render={<X aria-label=… />}：名字挂在 render 出来的元素上 */
const renderNamed = (n: JsxEl): boolean => {
  const init = getAttr(n, "render")?.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return false;
  const re = init.expression;
  return isJsxEl(re) && hasNameAttr(re);
};

/** 最近的 `*Trigger` 祖先带名字（Button 作为 Trigger 的子元素 / render 目标时） */
const ancestorTriggerNamed = (n: JsxEl): boolean => {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (isJsxEl(p) && tagOf(p).endsWith("Trigger")) return hasNameAttr(p);
  }
  return false;
};

const isNamed = (n: JsxEl): boolean =>
  hasNameAttr(n) || hasSpread(n) || renderNamed(n) || ancestorTriggerNamed(n);

interface Offender {
  line: number;
  tag: string;
}

/** 枚举一段 tsx 源码里的「纯图标且没有可访问名」的目标标签 */
const findOffenders = (text: string, fileName = "x.tsx"): Offender[] => {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lucide = lucideNames(sf);
  const found: Offender[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && isTargetTag(tagOf(n)) && isIconOnly(n, lucide) && !isNamed(n)) {
      found.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, tag: tagOf(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
};

/** 全仓扫描结果（只算一次，几个用例共用） */
let cached: Map<string, Offender[]> | null = null;
const scanAll = (): Map<string, Offender[]> => {
  if (cached) return cached;
  const m = new Map<string, Offender[]>();
  for (const file of walk(srcDir)) {
    const hits = findOffenders(readFileSync(file, "utf8"), file);
    if (hits.length > 0) m.set(path.relative(srcDir, file).split(path.sep).join("/"), hits);
  }
  cached = m;
  return m;
};

const IMPORT = 'import { Trash2, Loader2, Play, Eye } from "lucide-react";\n';
const count = (jsx: string): number => findOffenders(`${IMPORT}const A = () => (${jsx});`).length;

// ---------------------------------------------------------------------- 全仓契约

describe("纯图标按钮必须有可访问名（Q19-01）", { timeout: 60_000 }, () => {
  it("全仓 src/**/*.tsx：没有无名的纯图标按钮（豁免见 EXEMPT）", () => {
    const offenders: string[] = [];
    for (const [file, hits] of scanAll()) {
      for (const h of hits) {
        if (EXEMPT.some((x) => x.file === file && x.tag === h.tag)) continue;
        offenders.push(`${file}:${h.line} <${h.tag}>`);
      }
    }
    expect(offenders, "这些按钮只有图标、读屏读不出名字：加 aria-label（动作 + 序号 / 仓名），别用 title=").toEqual([]);
  });

  it("EXEMPT 的每一条都写了理由，并且确实还有对应的无名纯图标按钮（修了没删会在这里提醒）", () => {
    for (const x of EXEMPT) {
      expect(x.reason.trim().length, `${x.file} <${x.tag}> 缺豁免理由`).toBeGreaterThan(0);
      const hits = scanAll().get(x.file) ?? [];
      expect(hits.some((h) => h.tag === x.tag), `${x.file} <${x.tag}> 已经不违规了，从 EXEMPT 里删掉`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------- 扫描器自检

describe("扫描器自检：认得出违规、也不乱报（防这条契约悄悄哑掉）", () => {
  it("无名纯图标按钮 → 违规；带 aria-label / aria-labelledby → 放过", () => {
    expect(count("<Button><Trash2 className='size-4' /></Button>")).toBe(1);
    expect(count("<button type='button'><Trash2 /></button>")).toBe(1);
    expect(count("<a href='/x'><Eye /></a>")).toBe(1);
    expect(count("<Button aria-label='删除'><Trash2 /></Button>")).toBe(0);
    expect(count("<Button aria-labelledby='t'><Trash2 /></Button>")).toBe(0);
    expect(count("<Button aria-label={`删除 ${i}`}><Trash2 /></Button>")).toBe(0);
    // title= 不算名字（全仓约定不用原生 title）
    expect(count("<Button title='删除'><Trash2 /></Button>")).toBe(1);
  });

  it("aria-label 写成空串 / 纯空白 / 没有值，仍算没有名字（防止随手糊一个空串绕过）", () => {
    expect(count("<Button aria-label=''><Trash2 /></Button>")).toBe(1);
    expect(count("<Button aria-label='  '><Trash2 /></Button>")).toBe(1);
    expect(count("<Button aria-label={''}><Trash2 /></Button>")).toBe(1);
    expect(count("<Button aria-label={``}><Trash2 /></Button>")).toBe(1);
    expect(count("<Button aria-label><Trash2 /></Button>")).toBe(1);
    expect(count("<Button aria-labelledby=''><Trash2 /></Button>")).toBe(1);
    // render 元素 / Trigger 祖先上的空名字同理
    expect(count("<Button render={<a aria-label='' href='/x' />}><Eye /></Button>")).toBe(1);
    expect(count("<PopoverTrigger aria-label=''><Eye /></PopoverTrigger>")).toBe(1);
    // 非空（字面量或表达式）仍然放过
    expect(count("<Button aria-label='删'><Trash2 /></Button>")).toBe(0);
    expect(count("<Button aria-label={label}><Trash2 /></Button>")).toBe(0);
  });

  it("条件图标（loading ? 转圈 : 播放）算纯图标；任何一支可能是文字就放过", () => {
    expect(count("<Button>{busy ? <Loader2 /> : <Play />}</Button>")).toBe(1);
    expect(count("<Button>{busy && <Loader2 />}</Button>")).toBe(1);
    expect(count("<Button>{busy ? <Loader2 /> : '保存'}</Button>")).toBe(0);
    expect(count("<Button>{label}</Button>")).toBe(0);
    expect(count("<Button><Play />{label}</Button>")).toBe(0);
  });

  it("有文字 / sr-only 文字 / 未知组件 / 空按钮 / 展开属性 → 放过", () => {
    expect(count("<Button><Play /> 启动</Button>")).toBe(0);
    expect(count("<Button><Play /><span className='sr-only'>启动</span></Button>")).toBe(0);
    expect(count("<Button><Play /><Spinner /></Button>")).toBe(0);
    expect(count("<Button />")).toBe(0);
    expect(count("<Button>{children}</Button>")).toBe(0);
    expect(count("<button {...props}><Trash2 /></button>")).toBe(0);
    // 图标外面套一层无文字的 span 仍是纯图标
    expect(count("<Button><span className='inline-flex'><Trash2 /></span></Button>")).toBe(1);
  });

  it("render={<X />}：名字挂在 render 元素上才算；render 里的展开属性（如 <a {...anchor} />）不算名字", () => {
    expect(count("<Button render={<a aria-label='打开' href='/x' />}><Eye /></Button>")).toBe(0);
    expect(count("<Button render={<a {...anchor} className='no-underline' />}><Eye /></Button>")).toBe(1);
    expect(count("<Button render={<a href='/x' />}><Eye /></Button>")).toBe(1);
  });

  it("*Trigger：自己 / 祖先 Trigger 带名字放过；Trigger 自闭合 + render 里的 Button 无名 → 违规", () => {
    expect(count("<PopoverTrigger><Eye /></PopoverTrigger>")).toBe(1);
    expect(count("<PopoverTrigger aria-label='更多'><Eye /></PopoverTrigger>")).toBe(0);
    expect(count("<DropdownMenuTrigger aria-label='更多'><Button><Eye /></Button></DropdownMenuTrigger>")).toBe(0);
    expect(count("<PopoverTrigger render={<Button><Eye /></Button>} />")).toBe(1);
    expect(count("<PopoverTrigger render={<Button aria-label='输出'><Eye /></Button>} />")).toBe(0);
  });

  it("不是目标标签的组件不管（比如自带名字逻辑的封装）", () => {
    expect(count("<IconButton><Trash2 /></IconButton>")).toBe(0);
    expect(count("<div><Trash2 /></div>")).toBe(0);
  });
});

// ---------------------------------------------------------------------- 名字写得好不好（针对性）

const ariaLabelValues = (file: string): string[] => {
  const text = readFileSync(path.join(srcDir, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && n.name.getText() === "aria-label") {
      out.push(n.initializer?.getText() ?? "");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};

/**
 * 取出文件里顶层 `const <name> = …;` 并真跑：把模块私有的纯函数（不依赖别的符号）转译成 CJS 后放进 vm 执行。
 * 用来验证名字的生成逻辑本身（序号从几开始、环境怎么拼），而不是只读源码文本。
 */
const loadPureFn = <F extends (...args: never[]) => unknown>(file: string, name: string): F => {
  const text = readFileSync(path.join(srcDir, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!st.declarationList.declarations.some((d) => d.name.getText() === name)) continue;
    const code = ts.transpileModule(`${st.getText(sf)}\nexports.fn = ${name};`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exp: { fn?: F } = {};
    vm.runInNewContext(code, { exports: exp });
    if (typeof exp.fn !== "function") throw new Error(`${file} 里的 ${name} 不是函数`);
    return exp.fn;
  }
  throw new Error(`${file} 里没找到顶层的 ${name}`);
};

describe("工作区操作条：纯图标按钮的名字都带仓名（Q19-01）", () => {
  const FILE = "components/tasks/workspace-actions.tsx";

  it("workspace-actions.tsx 里每个 aria-label 都经 iconLabel（动作 +（仓名））生成，共 7 个", () => {
    const labels = ariaLabelValues(FILE);
    expect(labels).toHaveLength(7);
    for (const v of labels) expect(v, v).toContain("iconLabel(");
  });

  it("iconLabel 真跑：动作 +（仓名），仓名原样放进全角括号", () => {
    const iconLabel = loadPureFn<(action: string, repoName: string) => string>(FILE, "iconLabel");
    expect(iconLabel("复制工作区路径", "Flowship")).toBe("复制工作区路径（Flowship）");
    expect(iconLabel("停止预览 dev server", "group/projA")).toBe("停止预览 dev server（group/projA）");
  });

  it("7 个名字的动作文案与仓名来源逐个钉住（与各自 Tooltip 同文；「启动预览」例外：Tooltip 是命令本身，名字补了动词）", () => {
    expect(ariaLabelValues(FILE)).toEqual([
      "{iconLabel(`打开 ${mine.url}`, repoName)}",
      '{iconLabel("停止预览 dev server", repoName)}',
      '{iconLabel("用同一命令重新启动预览", repoName)}',
      "{iconLabel(`启动预览:${c.command}`, repoName)}",
      '{iconLabel("在 IDE 打开项目", t.shortName)}',
      '{iconLabel("复制工作区路径", t.shortName)}',
      '{iconLabel("查看 dev server 最近输出", repoName)}',
    ]);
  });

  it("PreviewLogPopover 的两处调用都传了 repoName（漏传 tsc 也会报，这里再钉一道）", () => {
    const text = readFileSync(path.join(srcDir, FILE), "utf8");
    expect(text.match(/<PreviewLogPopover\b/g)).toHaveLength(2);
    expect(text.match(/<PreviewLogPopover slot=\{mine\} repoName=\{repoName\} \/>/g)).toHaveLength(2);
  });

  it("名字里的仓名来源：与卡片上显示的是同一个 shortName，只有对不上的孤儿仓才回退到路径末段", () => {
    const text = readFileSync(path.join(srcDir, FILE), "utf8");
    const at = text.indexOf("const repoNameOf = ");
    expect(at).toBeGreaterThan(-1);
    const body = text.slice(at, text.indexOf(";", at) + 1).replace(/\s+/g, " ");
    expect(body).toContain("ideTargets.find((t) => t.repoPath === repoPath)");
    expect(body).toContain("?.shortName");
    expect(body).toContain("?? repoTail(repoPath)");
  });
});

describe("公司环境卡：删除键的名字（Q19-01）", () => {
  const FILE = "components/settings/company-env-card.tsx";
  const text = readFileSync(path.join(srcDir, FILE), "utf8");

  it("名字里不放用户填的地址 / 账号 / 凭证（host、baseUrl、endpoint、project、username、password、token……）", () => {
    const labels = ariaLabelValues(FILE);
    expect(labels.length).toBeGreaterThan(0);
    for (const v of labels) {
      expect(v, v).not.toMatch(/\.(host|baseUrl|endpoint|project|username|password|secret|token|accessKey\w*)\b/);
    }
  });

  it("removeInstanceLabel 真跑：删除 <类型> 第 N 项（<环境>）；序号从 1 数、环境去首尾空白、没填环境就不写括号", () => {
    const f = loadPureFn<(kind: string, index: number, env: string) => string>(FILE, "removeInstanceLabel");
    expect(f("PostgreSQL 实例", 0, "test")).toBe("删除 PostgreSQL 实例 第 1 项（test）");
    expect(f("Redis 实例", 2, "  prod ")).toBe("删除 Redis 实例 第 3 项（prod）");
    expect(f("服务器", 1, "")).toBe("删除 服务器 第 2 项");
    expect(f("服务器", 1, "   ")).toBe("删除 服务器 第 2 项");
  });

  it("字符串列表的删除键：名字 =「删除<itemName> N」，默认叫「项」；Nacos 的命名空间那一处传了「命名空间」", () => {
    expect(text).toContain('itemName = "项"');
    expect(text).toContain("aria-label={`删除${itemName} ${i + 1}`}");
    expect(text.match(/itemName="命名空间"/g)).toHaveLength(1);
  });

  it("InstanceRowEnd 的 removeLabel 是必填 prop，5 个实例卡（PG / Redis / Nacos / ELK / SLS）都经 removeInstanceLabel 传入", () => {
    expect(text).toMatch(/\bremoveLabel:\s*string;/);
    expect(text).not.toMatch(/\bremoveLabel\?:/);
    const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const values: string[] = [];
    const visit = (n: ts.Node) => {
      if (isJsxEl(n) && tagOf(n) === "InstanceRowEnd") {
        values.push(getAttr(n, "removeLabel")?.initializer?.getText() ?? "");
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(values).toHaveLength(5);
    for (const v of values) expect(v, v).toContain("removeInstanceLabel(");
    // 读屏念出来的第一个词：5 个类型名逐个钉住（按源码顺序）
    expect(values.map((v) => /removeInstanceLabel\("([^"]+)"/.exec(v)?.[1])).toEqual([
      "PostgreSQL 实例",
      "Redis 实例",
      "Nacos 集群",
      "ELK 实例",
      "SLS 实例",
    ]);
  });

  it("服务器 / XXL-Job 两处删除键不经 InstanceRowEnd，直接带名字（类型 + 序号 + 环境）", () => {
    const labels = ariaLabelValues(FILE);
    expect(labels).toContain('{removeInstanceLabel("服务器", i, s.env)}');
    expect(labels).toContain('{removeInstanceLabel("XXL-Job 环境", i, x.env)}');
  });
});

describe("其余 4 个文件里新加的纯图标按钮名字：文案逐个钉住（Q19-01）", () => {
  const has = (file: string, expr: string) => expect(ariaLabelValues(file), `${file} 缺 ${expr}`).toContain(expr);

  it("动作布局：行拖拽手柄 / 组头拖拽手柄（与同文件已有的「上移 …」「上移分组 …」同构）", () => {
    has("components/custom-actions/action-layout-config.tsx", "{`拖拽排序 ${label}`}");
    has("components/custom-actions/action-layout-config.tsx", "{`拖拽调整组顺序 ${ACTION_GROUP_LABEL[groupKey]}`}");
  });

  it("产物面板：上一处 / 下一处改动", () => {
    has("components/tasks/artifact-panel.tsx", '"上一处改动"');
    has("components/tasks/artifact-panel.tsx", '"下一处改动"');
  });

  it("仓库卡：删除仓库（名字可以被用户清空，所以要回退到路径）；WK 设置：选择产出目录", () => {
    has("components/settings/repo-card.tsx", "{`删除仓库 ${r.name || r.path}`}");
    has("components/settings/wk-harness-card.tsx", '"选择 WK 产出目录"');
  });
});
