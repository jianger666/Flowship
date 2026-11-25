/**
 * C# 5 语法门禁（给 tests/desktop-win-helper-protocol.test.ts 用）。
 *
 * Windows PowerShell 5.1 的 `Add-Type` 用 .NET Framework 自带的 csc（C# 5）编译 FlowshipUnlockHelper.cs；
 * C# 6 / 7 的写法在那里直接编译失败 = 解锁组件装不上。这里对「剥掉注释 / 字符串之后的代码」做语法**特征扫描**。
 *
 * 它是扫描器、不是编译器：认不出的写法（局部函数、构造函数的表达式体……）会漏。真正的编译证据是
 * docs/COMPUTER-USE.md §6 的 Roslyn（C# 5）手工检查。为了让这些正则不是「自己说了算」，下面两份样例集都用同一个 Roslyn 验证过：
 * 违规样例 `CSHARP5_VIOLATION_SAMPLES` 每条确实编不过，合法样例 `CSHARP5_LEGAL_SAMPLES` 每条确实能编过。
 * 改规则或样例之后要重做一遍（做法见该节「验证门禁本身」）。
 *
 * 第四轮评审指出旧门禁的洞：表达式体**属性**（旧正则要求 `)` 紧跟 `=>`）、内联 `out T x`、`is T x` 模式都漏。
 *
 * 本文件不 import 任何东西：Node 22 可以直接 `import()` 它（导出样例给 Roslyn 用）。
 */

export interface Csharp5Rule {
  /** 稳定 id：违规样例按它声明「我应该被哪条规则抓住」 */
  id: string;
  label: string;
  /** 输入是 stripCSharp 之后的代码；返回命中的片段（空数组 = 没有） */
  find: (code: string) => string[];
}

const KEYWORDS_NOT_TYPE =
  "return|else|throw|await|yield|case|goto|var|using|if|while|for|foreach|switch|lock|new|do|in|is|as";
const MODIFIERS =
  "internal|public|private|protected|static|extern|unsafe|override|virtual|abstract|sealed|new|partial|readonly|delegate|async|volatile";
/** 简单类型名：可带命名空间、泛型实参（尖括号里允许逗号 / 空格）、数组维度；不含括号 */
const TYPE = "[A-Za-z_][\\w.]*(?:<[^<>()]*>)?(?:\\[[,\\s]*\\])*";
const NOT_KEYWORD = `(?!(?:${KEYWORDS_NOT_TYPE})\\b)`;
const NAME = "[A-Za-z_]\\w*(?:<[^<>()]*>)?";

const hitsOf =
  (re: RegExp) =>
  (code: string): string[] =>
    [...code.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))].map((m) =>
      m[0].trim(),
    );

/** 一个括号前面的「语句头」是不是成员 / 委托 / P-Invoke 的声明头：[特性] 修饰符* 类型 名字（行内，语句边界之后） */
const DECL_HEAD = new RegExp(
  `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:${MODIFIERS})\\s+)*${NOT_KEYWORD}${TYPE}\\??\\s+${NAME}\\s*$`,
);
const OUT_DECL = new RegExp(`\\bout\\s+(?!var\\b)${TYPE}\\s+[A-Za-z_]\\w*\\s*(?=[,)]|$)`, "g");

/**
 * 内联 `out T x`（调用处声明变量，C# 7）。方法 / P-Invoke / 委托**声明**里的 `out T x` 是合法 C# 5，要放过：
 * 逐个看 `(`，前面的语句头是声明头（`[特性] 修饰符 类型 名字`）就整个括号跳过，否则（调用）检查括号内有没有 `out 类型 名字`。
 */
const inlineOutDeclarations = (code: string): string[] => {
  const hits = new Set<string>();
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== "(") continue;
    const from = Math.max(
      code.lastIndexOf(";", i - 1),
      code.lastIndexOf("{", i - 1),
      code.lastIndexOf("}", i - 1),
      code.lastIndexOf("\n", i - 1),
    );
    if (DECL_HEAD.test(code.slice(from + 1, i))) continue;
    let depth = 0;
    let j = i;
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    for (const m of code.slice(i + 1, j).matchAll(OUT_DECL)) hits.add(m[0].trim());
  }
  return [...hits];
};

export const CSHARP5_RULES: Csharp5Rule[] = [
  { id: "interpolation", label: '字符串插值 $"…"', find: hitsOf(/\$@?""/) },
  { id: "null-conditional", label: "空条件运算符 ?. / ?[", find: hitsOf(/[\w)\]]\?[.[]/) },
  { id: "nameof", label: "nameof(…)", find: hitsOf(/\bnameof\s*\(/) },
  { id: "out-var", label: "out var", find: hitsOf(/\bout\s+var\b/) },
  { id: "using-static", label: "using static", find: hitsOf(/\busing\s+static\b/) },
  {
    id: "expression-bodied",
    label: "表达式体成员（方法 / 属性：成员声明后面直接 =>）",
    find: hitsOf(
      new RegExp(
        `^[ \\t]*(?:(?:${MODIFIERS})\\s+)*${NOT_KEYWORD}${TYPE}\\??[ \\t]+${NAME}[ \\t]*(?:\\([^;{}]*\\))?[ \\t]*=>`,
        "gm",
      ),
    ),
  },
  { id: "readonly-auto-property", label: "只读自动属性 { get; }", find: hitsOf(/\{\s*get;\s*\}/) },
  { id: "auto-property-initializer", label: "自动属性初始化 { get; set; } =", find: hitsOf(/\{\s*get;\s*set;\s*\}\s*=/) },
  { id: "exception-filter", label: "异常过滤 catch … when", find: hitsOf(/\bcatch\b[^{]*\bwhen\b/) },
  {
    id: "throw-expression",
    label: "throw 表达式（?? throw / => throw / ? throw）",
    find: hitsOf(/(?:\?\?|=>)\s*throw\b|\?\s+throw\b/),
  },
  { id: "digit-separator", label: "数字分隔符 1_000", find: hitsOf(/\b0x[0-9A-Fa-f]*_|\b\d+_\d/) },
  { id: "nullable-directive", label: "#nullable", find: hitsOf(/#nullable/) },
  { id: "tuple-var", label: "元组 / 解构 var (a, b)", find: hitsOf(/\bvar\s*\(/) },
  { id: "inline-out", label: "内联 out 变量声明 out T x（调用处声明变量）", find: inlineOutDeclarations },
  {
    id: "is-pattern",
    label: "is 模式（is T x / is null / is not …）",
    find: (code) => [
      ...hitsOf(new RegExp(`\\bis\\s+(?!as\\b)${TYPE}\\s+(?!as\\b|is\\b)[A-Za-z_]\\w*`))(code),
      ...hitsOf(/\bis\s+(?:null|true|false|not)\b|\bis\s+-?\d|\bis\s+(?:""|'')/)(code),
    ],
  },
  { id: "case-when", label: "case … when", find: hitsOf(/\bcase\b[^:;{}]*\bwhen\b/) },
  { id: "switch-expression", label: "switch 表达式（switch 后面直接 {）", find: hitsOf(/\bswitch\s*\{/) },
  { id: "binary-literal", label: "二进制字面量 0b", find: hitsOf(/\b0[bB][01]/) },
  {
    id: "default-literal",
    label: "default 字面量（= default; / return default;）",
    find: hitsOf(/(?:=|\breturn|[(,])\s*default\s*(?=[;,)])/),
  },
  { id: "tuple-return", label: "元组返回 return (a, b);", find: hitsOf(/\breturn\s*\([^()]*,[^()]*\)\s*;/) },
  {
    id: "tuple-type",
    label: "元组类型 (int a, int b) / (int, int)",
    find: hitsOf(
      new RegExp(
        `^[ \\t]*(?:(?:${MODIFIERS})\\s+)*\\([ \\t]*${TYPE}[ \\t]+[A-Za-z_]\\w*[ \\t]*,|^[ \\t]*(?:(?:${MODIFIERS})\\s+)*\\([ \\t]*${TYPE}[ \\t]*,[ \\t]*${TYPE}[ \\t]*\\)[ \\t]+${NAME}[ \\t]*\\(`,
        "gm",
      ),
    ),
  },
  {
    id: "tuple-deconstruction",
    label: "解构赋值 (a, b) = …",
    find: hitsOf(/(?:^|[;{}])[ \t]*\([ \t]*[A-Za-z_]\w*[ \t]*,[^()\n]*\)[ \t]*=(?!=)/m),
  },
  { id: "index-initializer", label: "索引初始化器 { [k] = v }", find: hitsOf(/[{,]\s*\[[^\]\n]*\]\s*=(?!=)/) },
  {
    id: "ref-local",
    label: "ref 局部 / ref 返回",
    find: (code) => [
      ...hitsOf(new RegExp(`\\bref\\s+(?:readonly\\s+)?${TYPE}\\s+[A-Za-z_]\\w*\\s*=(?!=)`))(code),
      ...hitsOf(/\breturn\s+ref\b/)(code),
    ],
  },
  { id: "null-coalescing-assignment", label: "空合并赋值 ??=", find: hitsOf(/\?\?=/) },
];

/** 对 stripCSharp 之后的代码跑全部规则，返回命中的规则（没命中的不出现） */
export const csharp5Violations = (code: string): Array<{ id: string; label: string; hits: string[] }> =>
  CSHARP5_RULES.map((rule) => ({ id: rule.id, label: rule.label, hits: rule.find(code) })).filter(
    (r) => r.hits.length > 0,
  );

// ───────────────────────── 样例集（也是给 Roslyn 的验证输入） ─────────────────────────

/** stmt = 放进方法体；member = 放进类体；top = 放在文件顶层（using / 预处理指令） */
export type Csharp5SampleKind = "stmt" | "member" | "top";

export interface Csharp5Sample {
  kind: Csharp5SampleKind;
  code: string;
}

export interface Csharp5ViolationSample extends Csharp5Sample {
  /** 应该抓住它的规则 id */
  rule: string;
}

/** 把样例包成一份完整的 C# 源文件（给 Roslyn 编译用；规则本身只看片段） */
export const wrapCsharp5Sample = (s: Csharp5Sample): string => {
  if (s.kind === "top") return `${s.code}\nclass T { }\n`;
  if (s.kind === "member") return `using System;\nclass T {\n${s.code}\n}\n`;
  return `using System;\nclass T {\n  static void M() {\n${s.code}\n  }\n}\n`;
};

/** 每条都是 C# 6+ 的写法：门禁必须抓住，Roslyn（C# 5）必须编不过 */
export const CSHARP5_VIOLATION_SAMPLES: Csharp5ViolationSample[] = [
  { rule: "interpolation", kind: "stmt", code: 'string s = $"a{1}";' },
  { rule: "interpolation", kind: "stmt", code: 'string s = $@"a{1}";' },
  { rule: "null-conditional", kind: "stmt", code: "string s = null; int? n = s?.Length;" },
  { rule: "null-conditional", kind: "stmt", code: "int[] a = null; int? n = a?[0];" },
  { rule: "nameof", kind: "stmt", code: "string s = nameof(System.String);" },
  { rule: "out-var", kind: "stmt", code: 'int.TryParse("1", out var n);' },
  { rule: "using-static", kind: "top", code: "using static System.Math;" },
  { rule: "expression-bodied", kind: "member", code: "public int X => 1;" },
  { rule: "expression-bodied", kind: "member", code: "static int F(int a) => a;" },
  { rule: "expression-bodied", kind: "member", code: 'string Name => "x";' },
  { rule: "expression-bodied", kind: "member", code: "static T G<T>(T a) => a;" },
  { rule: "readonly-auto-property", kind: "member", code: "public int X { get; }" },
  { rule: "auto-property-initializer", kind: "member", code: "public int X { get; set; } = 1;" },
  { rule: "exception-filter", kind: "stmt", code: "try { } catch (System.Exception e) when (e != null) { }" },
  { rule: "throw-expression", kind: "stmt", code: "string s = null; string t = s ?? throw new System.Exception();" },
  { rule: "throw-expression", kind: "stmt", code: "System.Action a = () => throw new System.Exception();" },
  { rule: "digit-separator", kind: "stmt", code: "int n = 1_000;" },
  { rule: "nullable-directive", kind: "top", code: "#nullable enable" },
  { rule: "tuple-var", kind: "stmt", code: "var (a, b) = (1, 2);" },
  { rule: "inline-out", kind: "stmt", code: 'bool ok = long.TryParse("1", out long v);' },
  { rule: "inline-out", kind: "stmt", code: 'if (int.TryParse("1", out int n)) { }' },
  { rule: "inline-out", kind: "stmt", code: 'int.TryParse("1", out int n);' },
  {
    rule: "inline-out",
    kind: "stmt",
    code: "System.Collections.Generic.Dictionary<string, int> src = null;\n    System.Collections.Generic.Dictionary<string, int> dst = null;\n    bool ok = src != null && src.TryGetValue(\"a\", out int n);",
  },
  { rule: "is-pattern", kind: "stmt", code: "object o = 1; if (o is int i) { }" },
  { rule: "is-pattern", kind: "stmt", code: "object o = null; if (o is null) { }" },
  { rule: "is-pattern", kind: "stmt", code: "object o = null; if (o is not string) { }" },
  { rule: "case-when", kind: "stmt", code: "object o = 1; switch (o) { case int i when i > 0: break; }" },
  { rule: "switch-expression", kind: "stmt", code: "int x = 1; int y = x switch { 1 => 2, _ => 3 };" },
  { rule: "binary-literal", kind: "stmt", code: "int n = 0b101;" },
  { rule: "default-literal", kind: "stmt", code: "int n = default;" },
  { rule: "default-literal", kind: "member", code: "static string F() { return default; }" },
  { rule: "tuple-return", kind: "member", code: "static object F() { return (1, 2); }" },
  { rule: "tuple-type", kind: "member", code: "static (int a, int b) F() { throw new System.Exception(); }" },
  { rule: "tuple-type", kind: "member", code: "static (int, int) F() { throw new System.Exception(); }" },
  { rule: "tuple-deconstruction", kind: "stmt", code: "int a = 0; int b = 0; (a, b) = (b, a);" },
  {
    rule: "index-initializer",
    kind: "stmt",
    code: 'var d = new System.Collections.Generic.Dictionary<string, int> { ["a"] = 1 };',
  },
  { rule: "ref-local", kind: "stmt", code: "int x = 1; ref int y = ref x;" },
  { rule: "null-coalescing-assignment", kind: "stmt", code: 'string s = null; s ??= "a";' },
];

/** 每条都是合法 C# 5（含源码里真实出现的 out / ref 声明形态）：门禁必须零命中，Roslyn（C# 5）必须编得过 */
export const CSHARP5_LEGAL_SAMPLES: Csharp5Sample[] = [
  { kind: "member", code: "internal static bool TryGet(char c, out int v) { v = c; return true; }" },
  {
    kind: "member",
    code: '[System.Runtime.InteropServices.DllImport("kernel32.dll")] internal static extern bool GetExitCodeProcess(System.IntPtr process, out uint exitCode);',
  },
  {
    kind: "member",
    code: '[System.Runtime.InteropServices.DllImport("kernel32.dll")]\n    internal static extern bool Multi(\n        System.IntPtr a,\n        out uint b,\n        ref uint c);',
  },
  {
    kind: "member",
    code: "static bool Dict(out System.Collections.Generic.Dictionary<string, int> d) { d = null; return true; }",
  },
  { kind: "stmt", code: 'int n; bool ok = int.TryParse("1", out n);' },
  { kind: "stmt", code: 'int n; if (!int.TryParse("1", out n)) return;' },
  {
    kind: "stmt",
    code: 'long ticks; long.TryParse("1", System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out ticks);',
  },
  { kind: "stmt", code: "System.Func<int, int> f = x => x + 1; int y = f(1);" },
  { kind: "stmt", code: "System.Func<int, int> g = (x) => x + 1; int y = g(1);" },
  { kind: "stmt", code: "foreach (var x in new int[] { 1 }) { int z = x; }" },
  {
    kind: "stmt",
    code: 'object o = 1; if (o is int) { } bool b = !(o is string); string t = o is string ? "a" : "b"; if (o is int && b) { }',
  },
  { kind: "stmt", code: "switch (1) { case 1: break; default: break; }" },
  { kind: "stmt", code: "try { } catch (System.Exception ex) { string m = ex.Message; }" },
  { kind: "stmt", code: "int[] a = { 1, 2 }; int i = a[0 ^ 1];" },
  { kind: "stmt", code: "int h = 0x0b; int d = default(int);" },
  { kind: "stmt", code: "object o = null; if (o == null) { throw new System.Exception(); }" },
  { kind: "stmt", code: 'string s = "a" + (1 > 0 ? "b" : "c");' },
  { kind: "stmt", code: 'var d = new System.Collections.Generic.Dictionary<string, int>(); d["a"] = 1;' },
  { kind: "stmt", code: 'string a = "x"; string b = a != null ? a : "y";' },
  { kind: "stmt", code: "int x = 3; int y = (x > 1) ? 1 : 0; bool z = (x ^ y) != 0;" },
  { kind: "member", code: "public int X { get; set; }" },
  { kind: "member", code: "public int X { get; private set; }" },
  { kind: "member", code: "static int G<T>() where T : new() { return 1; }" },
  { kind: "member", code: "static int Neg(int a) { return (a); }" },
  { kind: "member", code: "static object Pair() { return System.Tuple.Create(1, 2); }" },
  { kind: "member", code: "static int Sw(int x) { switch (x) { case 1: return 1; default: return 0; } }" },
];
