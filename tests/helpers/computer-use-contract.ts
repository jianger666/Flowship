/**
 * 「电脑操作」桥的契约解析（对账测试共用：tests/desktop-index.test.ts / tests/computer-use-card.test.ts）。
 *
 * 唯一权威是 electron-app/desktop/types.mjs 里 ComputerUseBridge 的 JSDoc；渲染端的 TS 类型（src/lib/computer-use-bridge.ts）
 * 和 preload.cjs 里手写的桥都要和它对得上。只比方法名不够：参数（个数 / 名字）、返回值的形状对不上，一样会在运行时才炸，
 * 更糟的是静默传错参数 / 调到别的通道。所以这里把每个方法解析成「名字 + 参数名 + 返回值形状」，preload 那份再带上通道名和转发的参数。
 *
 * 契约在注释里、TS 和 preload 在源码里，没有现成的解析器可用，所以按这三处的固定写法做最小的括号配对解析。
 * 写法变了解析会直接抛错（不会悄悄少解析几个方法）；调用方还应断言解析出的方法数不低于已知的下限。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface BridgeMethod {
  name: string;
  /** 参数名，按顺序 */
  params: string[];
  /** Promise<…> 里装的东西，归一后的形状（见 shapeOf） */
  result: string;
}

export interface PreloadBridgeMethod {
  name: string;
  params: string[];
  /** ipcRenderer.invoke 的通道名 */
  channel: string;
  /** 通道名后面转发出去的参数，按顺序 */
  forwarded: string[];
}

const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf-8");

const stripBlockComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

const OPENERS = "({[<";
const CLOSERS = ")}]>";

/** `src[open]` 是开括号：返回与它配对的闭括号下标。箭头 `=>` 里的 `>` 不算括号 */
const closeOf = (src: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (ch === ">" && src[i - 1] === "=") continue;
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`契约解析：括号没有配上：${src.slice(open, open + 60)}`);
};

/** 只在括号外（depth 0）按分隔符切开，去空白、丢空段 */
const splitTop = (src: string, separators: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (ch === ">" && src[i - 1] === "=") continue;
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) depth -= 1;
    else if (depth === 0 && separators.includes(ch)) {
      parts.push(src.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(src.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
};

/** 参数名（`kind: 'a'|'b'` / `input: { password: string }` / `kind`（JS 没有类型）都取开头那个标识符） */
const paramNames = (paramsText: string): string[] =>
  splitTop(paramsText, ",").map((param) => {
    const name = /^(\w+)\??\s*(?::|$)/.exec(param)?.[1];
    if (!name) throw new Error(`契约解析：认不出参数「${param}」`);
    return name;
  });

/**
 * Promise<…> 里装的东西，归一成能直接比较的字符串：
 * 对象字面量 → `{字段,字段}`（排序、去掉可选标记）；具名类型 → 先看 resolve 能不能展开成字段表（TS 把返回值写成具名接口、契约里内联），展不开就用名字本身
 */
const shapeOf = (payload: string, resolve: (typeName: string) => string[] | null): string => {
  const text = payload.trim();
  if (text.startsWith("{")) {
    const keys = splitTop(text.slice(1, -1), ",;").map((entry) => {
      const key = /^(\w+)\??\s*:/.exec(entry)?.[1];
      if (!key) throw new Error(`契约解析：认不出字段「${entry}」`);
      return key;
    });
    return `{${keys.sort().join(",")}}`;
  }
  const keys = resolve(text);
  return keys ? `{${[...keys].sort().join(",")}}` : text;
};

/** `Promise<…>` 的内容（tail 是参数括号之后的那一段） */
const promisePayload = (tail: string): string => {
  const at = tail.indexOf("Promise<");
  if (at < 0) throw new Error(`契约解析：返回值不是 Promise：${tail.slice(0, 60)}`);
  const lt = at + "Promise".length;
  return tail.slice(lt + 1, closeOf(tail, lt));
};

/** 契约（types.mjs 的 JSDoc）里的桥方法 */
export const contractBridgeMethods = (): BridgeMethod[] => {
  const contract = read("electron-app/desktop/types.mjs");
  const block = /@typedef \{Object\} ComputerUseBridge\b([\s\S]*?)\*\//.exec(contract)?.[1];
  if (!block) throw new Error("契约里找不到 ComputerUseBridge");
  const methods: BridgeMethod[] = [];
  for (const m of block.matchAll(/^ \* @property \{/gm)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(block, open);
    const type = block.slice(open + 1, close);
    const name = /^\s+(\w+)/.exec(block.slice(close + 1))?.[1];
    if (!name) throw new Error(`契约解析：认不出方法名：${block.slice(close + 1, close + 40)}`);
    if (!type.startsWith("(")) throw new Error(`契约解析：${name} 的类型不是函数：${type}`);
    const paramsClose = closeOf(type, 0);
    methods.push({
      name,
      params: paramNames(type.slice(1, paramsClose)),
      result: shapeOf(promisePayload(type.slice(paramsClose + 1)), () => null),
    });
  }
  return methods;
};

/** TS 里 `export interface X { … }` 的第一层成员名（两空格缩进） */
const tsInterfaceBody = (src: string, iface: string): string => {
  const body = new RegExp(`export interface ${iface} \\{\\n([\\s\\S]*?)\\n\\}`).exec(src)?.[1];
  if (!body) throw new Error(`TS 里找不到 ${iface}`);
  return body;
};

/** 渲染端 TS 类型（src/lib/computer-use-bridge.ts）里的桥方法 */
export const tsBridgeMethods = (): BridgeMethod[] => {
  const src = read("src/lib/computer-use-bridge.ts");
  const body = stripBlockComments(tsInterfaceBody(src, "ComputerUseBridge"));
  // 返回值写成具名接口的（LockedAccessTestResult）展开成字段表，才能和契约里内联的对象字面量比；ComputerUseStatus 在两边都是名字，保持名字
  const resolve = (typeName: string): string[] | null => {
    if (typeName === "ComputerUseStatus" || typeName === "void") return null;
    try {
      return [...tsInterfaceBody(src, typeName).matchAll(/^ {2}(\w+)\??[:(]/gm)].map((member) => member[1] as string);
    } catch {
      return null;
    }
  };
  const methods: BridgeMethod[] = [];
  for (const m of body.matchAll(/^ {2}(\w+)\(/gm)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(body, open);
    methods.push({
      name: m[1] as string,
      params: paramNames(body.slice(open + 1, close)),
      result: shapeOf(promisePayload(body.slice(close + 1, body.indexOf("\n", close))), resolve),
    });
  }
  return methods;
};

/** preload.cjs 里手写的 `window.__computerUse`：每个方法是 `name: (参数) => ipcRenderer.invoke("通道", 转发的参数…)` */
export const preloadBridgeMethods = (): PreloadBridgeMethod[] => {
  // 先整体去掉块注释：JSDoc 里的 `{Promise<…>}` / `<` 之类不能混进括号配对
  const preload = stripBlockComments(read("electron-app/preload.cjs"));
  const at = preload.indexOf('exposeInMainWorld("__computerUse"');
  if (at < 0) throw new Error("preload 里找不到 __computerUse");
  const open = preload.indexOf("{", at);
  const body = preload.slice(open + 1, closeOf(preload, open));
  const methods: PreloadBridgeMethod[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const m = /^\s*(\w+): \(([^)]*)\) => ipcRenderer\.invoke\("([^"]+)"(?:,\s*([^)]*))?\),?\s*$/.exec(line);
    if (!m) throw new Error(`契约解析：preload 桥里有一行认不出：${line.trim()}`);
    methods.push({
      name: m[1] as string,
      params: paramNames(m[2] as string),
      channel: m[3] as string,
      forwarded: m[4] ? splitTop(m[4], ",") : [],
    });
  }
  return methods;
};
