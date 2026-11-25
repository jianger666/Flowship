/**
 * 从 TSX 源码里取出 `hint={…}` 表达式的「静态可见文字」，给 tests/settings-hint-brevity.test.ts 量字数用（R20-13）。
 *
 * 为什么要有它：以前那条字数测试只认 `hint="…"` 这种单行字符串字面量和提成数据的文案，`hint={<>…</>}` 的 JSX 写法整个漏掉——
 * 实际就漏过「解锁组件（可选）」那一行（静态文字约 72 字，超过 HINT_MAX = 68）。
 *
 * 取什么 / 不取什么（只量「写死在源码里的那句说明」，运行时才有的文字量不了）：
 * - 整个表达式就是字符串 / 模板字面量：取内容（模板里的 `${…}` 丢掉）；
 * - 整个表达式是同一个文件里 `const NAME = "…";` 定义的字符串常量名：取那个常量的内容；
 * - 整个表达式是 JSX：标签丢掉，**顶层**的字面文字留下；`{"…"}` 取字符串内容；`{NAME}`（同文件字符串常量）取常量内容；
 *   其它 `{…}`（条件 / 变量 / 动态提示 / 嵌套元素）整个丢掉——它们是运行时才出现的状态提示，不算那一句 hint；
 * - 其余写法（三元 / `||` / 函数调用 / 别处 import 的常量）→ 不量（返回 null），测试里单独计数，别让扫描器空转。
 *
 * 这是**字符级的小扫描器，不是 JSX 解析器**：认得字符串、行注释与块注释、花括号嵌套，仅此而已。
 * 模板字符串里的 `${…}` 再嵌引号这类写法它不处理（源码里没有）；它的边界在 tests/settings-hint-brevity.test.ts 的自检里列着。
 */

/** s[i] 是引号（" ' `）：返回闭合引号之后的下标（跳过反斜杠转义） */
const skipString = (s: string, i: number): number => {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === "\\" ? 2 : 1;
  return j + 1;
};

/** s[i] 是 `{`：返回与它匹配的 `}` 之后的下标。字符串里的花括号、行注释与块注释里的内容都不计 */
const skipBraces = (s: string, i: number): number => {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j]!;
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(s, j);
      continue;
    }
    if (c === "/" && s[j + 1] === "/") {
      const nl = s.indexOf("\n", j);
      j = nl < 0 ? s.length : nl + 1;
      continue;
    }
    if (c === "/" && s[j + 1] === "*") {
      const end = s.indexOf("*/", j + 2);
      j = end < 0 ? s.length : end + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return s.length;
};

/** 同一个文件里 `const NAME = "…";` / `const NAME =\n  "…";` 定义的字符串常量（只认单个字面量，拼接 / 模板不认） */
export const stringConstants = (source: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*;/g)) {
    out.set(m[1]!, m[2]!.slice(1, -1));
  }
  return out;
};

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 一个 `hint={…}` 的表达式文本 → 静态可见文字；不属于上面几种可量的写法 → null */
export const jsxStaticText = (expr: string, consts: ReadonlyMap<string, string> = new Map()): string | null => {
  const e = expr.trim();
  if (e === "") return null;
  const q = e[0]!;
  if (q === '"' || q === "'" || q === "`") {
    const end = skipString(e, 0);
    // 整个表达式必须就是这一个字面量（`"a" + b` / `"a" || x` 这种拼接 / 兜底不量）
    if (e.slice(end).trim() !== "") return null;
    return normalize(e.slice(1, end - 1).replace(/\$\{[^}]*\}/g, ""));
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e)) return consts.has(e) ? normalize(consts.get(e)!) : null;
  if (q !== "<") return null;

  let out = "";
  let i = 0;
  while (i < e.length) {
    const c = e[i]!;
    if (c === "<") {
      // 标签（含 `<>` / `</x>`）：跳到它的 `>`；属性值 / 属性里的 `{…}` 里的 `>` 不算
      let j = i + 1;
      while (j < e.length && e[j] !== ">") {
        if (e[j] === "{") j = skipBraces(e, j);
        else if (e[j] === '"' || e[j] === "'") j = skipString(e, j);
        else j++;
      }
      i = j + 1;
      // 标签两侧不是同一段文字：留个空格，免得 `a<br/>b` 被粘成 `ab`
      out += " ";
      continue;
    }
    if (c === "{") {
      const end = skipBraces(e, i);
      const inner = e.slice(i + 1, end - 1).trim();
      const lit = /^(["'])((?:[^"'\\]|\\.)*)\1$/.exec(inner);
      if (lit) out += lit[2];
      else if (/^[A-Za-z_$][\w$]*$/.test(inner) && consts.has(inner)) out += consts.get(inner)!;
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return normalize(out);
};

export interface JsxHint {
  /** `hint={` 在源码里的下标（报错时用来算行号） */
  index: number;
  /** 表达式原文（截断，仅报错用） */
  expr: string;
  /** 静态可见文字；这一处不是可量的写法 → null */
  text: string | null;
}

/** 源码里所有 `hint={…}`（含嵌套在别的表达式里的）：各自的静态可见文字 */
export const extractJsxHints = (source: string): JsxHint[] => {
  const consts = stringConstants(source);
  const out: JsxHint[] = [];
  for (const m of source.matchAll(/\bhint=\{/g)) {
    const open = m.index! + m[0].length - 1;
    const end = skipBraces(source, open);
    const expr = source.slice(open + 1, end - 1);
    out.push({ index: m.index!, expr: expr.slice(0, 60), text: jsxStaticText(expr, consts) });
  }
  return out;
};
