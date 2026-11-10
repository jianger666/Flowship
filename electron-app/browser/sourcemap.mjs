/**
 * Source Map v3 解析（增强包 E2 · B3，纯函数、零依赖）：VLQ 解码 + 位置二分查找 + sourcesContent。
 *
 * 输入是**页面可控的不可信数据**（map 文件由页面指向、内容任意）：所以这里的取舍一律偏「不崩、不卡、不吃内存」——
 *  - 文本 ≤ {@link MAX_MAP_BYTES}（5MB）；segment 总数 ≤ {@link MAX_SEGMENTS}、sources ≤ {@link MAX_SOURCES}，超限抛 {@link SourceMapError}；
 *  - VLQ 非法字符 / 位数过长 / 越界的 segment 直接跳过（计入 `skipped`），**不抛**——一个坏 segment 不该让整张 map 作废；
 *  - index map（`sections`）只展开一层：section 里的嵌套 `sections` 与 `url` 型 section 一律忽略（防环形引用 / 防二次取数）；
 *  - 所有循环都是对输入的单趟线性扫描，没有任何基于输入的递归，所以畸形输入不会死循环。
 *
 * 坐标约定：**行、列都是 0 起**（与 CDP 的 lineNumber / columnNumber 一致）；展示时再 +1 由调用方负责。
 */

export const MAX_MAP_BYTES = 5 * 1024 * 1024;
export const MAX_SEGMENTS = 2_000_000;
export const MAX_SOURCES = 5000;
/** 栈还原单次最多处理的帧数（console 条目本身已限帧，这里是第二道） */
export const MAX_RESOLVE_FRAMES = 20;

export class SourceMapError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceMapError";
  }
}

const B64 = (() => {
  const t = new Int8Array(128).fill(-1);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i;
  return t;
})();

/**
 * 解码一个 segment（逗号之间的那一段）里的全部 VLQ 值。
 * 非法字符 / 位数过长（> 7 位 base64 = 35 bit，正常 map 的值不会超过 32 bit）→ 返回 null。
 * @param {string} seg
 * @returns {number[] | null}
 */
export const decodeVlqSegment = (seg) => {
  const out = [];
  let result = 0;
  let shift = 0;
  for (let i = 0; i < seg.length; i++) {
    const code = seg.charCodeAt(i);
    const digit = code < 128 ? B64[code] : -1;
    if (digit < 0) return null;
    result += (digit & 31) * 2 ** shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      if (shift > 30) return null; // 连续 7 个续位 = 过长，视为畸形
      continue;
    }
    const neg = result % 2 === 1;
    const v = Math.floor(result / 2);
    out.push(neg ? -v : v);
    result = 0;
    shift = 0;
    if (out.length > 5) return null; // v3 的 segment 最多 5 个字段
  }
  // 以续位结尾（没有收尾字符）= 截断，畸形
  if (shift !== 0) return null;
  return out;
};

const isStr = (v) => typeof v === "string";

/** @param {unknown} s */
const joinRoot = (root, src) => {
  if (!isStr(src)) return "";
  if (!isStr(root) || root === "") return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/")) return src;
  return root.endsWith("/") ? root + src : `${root}/${src}`;
};

/**
 * 把一张标准（非 index）map 的 mappings 展开进 builder。
 * @param {any} raw
 * @param {{ lineOffset: number, colOffset: number }} offset section 偏移（标准 map = 0 / 0）
 * @param {any} b builder
 */
const ingestStandard = (raw, offset, b) => {
  if (!raw || typeof raw !== "object" || !isStr(raw.mappings)) throw new SourceMapError("不是有效的 source map（缺少 mappings 字符串）");
  const srcList = Array.isArray(raw.sources) ? raw.sources : [];
  const contentList = Array.isArray(raw.sourcesContent) ? raw.sourcesContent : [];
  const names = Array.isArray(raw.names) ? raw.names : [];
  const srcBase = b.sources.length;
  const nameBase = b.names.length;
  for (let i = 0; i < srcList.length; i++) {
    if (b.sources.length >= MAX_SOURCES) throw new SourceMapError(`sources 过多（> ${MAX_SOURCES}）`);
    b.sources.push(joinRoot(raw.sourceRoot, srcList[i]));
    b.sourcesContent.push(isStr(contentList[i]) ? contentList[i] : null);
  }
  for (let i = 0; i < names.length; i++) b.names.push(isStr(names[i]) ? names[i] : "");

  const lines = raw.mappings.split(";");
  let src = 0;
  let oLine = 0;
  let oCol = 0;
  let nameIdx = 0;
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    if (text === "") continue;
    let gCol = 0;
    const genLine = li + offset.lineOffset;
    const extraCol = li === 0 ? offset.colOffset : 0;
    const segs = text.split(",");
    for (let si = 0; si < segs.length; si++) {
      if (segs[si] === "") continue;
      const f = decodeVlqSegment(segs[si]);
      if (f === null || f.length === 0) {
        b.skipped++;
        continue;
      }
      gCol += f[0];
      if (f.length < 4) continue; // 只有生成列（无源位置）的 segment：不参与查询
      src += f[1];
      oLine += f[2];
      oCol += f[3];
      let name = -1;
      if (f.length === 5) {
        nameIdx += f[4];
        name = nameIdx;
      }
      if (gCol < 0 || src < 0 || src >= srcList.length || oLine < 0 || oCol < 0) {
        b.skipped++;
        continue;
      }
      if (b.n >= MAX_SEGMENTS) throw new SourceMapError(`mappings 过大（segment > ${MAX_SEGMENTS}）`);
      b.push(genLine, gCol + extraCol, src + srcBase, oLine, oCol, name >= 0 && name < names.length ? name + nameBase : -1);
    }
  }
};

const createBuilder = () => {
  let cap = 1024;
  let gl = new Int32Array(cap);
  let gc = new Int32Array(cap);
  let sr = new Int32Array(cap);
  let ol = new Int32Array(cap);
  let oc = new Int32Array(cap);
  let nm = new Int32Array(cap);
  const grow = () => {
    cap *= 2;
    const g = (a) => {
      const n = new Int32Array(cap);
      n.set(a);
      return n;
    };
    gl = g(gl);
    gc = g(gc);
    sr = g(sr);
    ol = g(ol);
    oc = g(oc);
    nm = g(nm);
  };
  const b = {
    sources: [],
    sourcesContent: [],
    names: [],
    skipped: 0,
    n: 0,
    push(a, c, s, l, o, name) {
      if (b.n >= cap) grow();
      gl[b.n] = a;
      gc[b.n] = c;
      sr[b.n] = s;
      ol[b.n] = l;
      oc[b.n] = o;
      nm[b.n] = name;
      b.n++;
    },
    arrays: () => ({ gl, gc, sr, ol, oc, nm }),
  };
  return b;
};

/**
 * 解析 source map（JSON 文本或已解析对象）。
 * @param {string | object} input
 * @param {{ maxBytes?: number }} [opts]
 */
export const parseSourceMap = (input, opts = {}) => {
  const maxBytes = opts.maxBytes ?? MAX_MAP_BYTES;
  let raw = input;
  if (isStr(input)) {
    if (input.length > maxBytes) throw new SourceMapError(`source map 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
    // 兼容 XSSI 前缀 `)]}'`
    const text = input.startsWith(")]}'") ? input.slice(input.indexOf("\n") + 1) : input;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SourceMapError("source map 不是合法 JSON");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SourceMapError("source map 顶层必须是对象");
  if (raw.version !== undefined && raw.version !== 3) throw new SourceMapError(`不支持的 source map 版本：${String(raw.version).slice(0, 10)}（只支持 v3）`);

  const b = createBuilder();
  if (Array.isArray(raw.sections)) {
    // index map：只展开一层；section 的偏移要求递增，乱序的 section 忽略（二分查找依赖全局有序）
    let lastLine = -1;
    let lastCol = -1;
    for (const sec of raw.sections.slice(0, 2000)) {
      const off = sec?.offset;
      const map = sec?.map;
      if (!map || typeof map !== "object" || Array.isArray(map.sections)) continue; // 无内嵌 map（url 型）/ 嵌套 index：不跟随
      const line = Number.isInteger(off?.line) && off.line >= 0 ? off.line : -1;
      const col = Number.isInteger(off?.column) && off.column >= 0 ? off.column : -1;
      if (line < 0 || col < 0 || line < lastLine || (line === lastLine && col <= lastCol)) {
        b.skipped++;
        continue;
      }
      lastLine = line;
      lastCol = col;
      ingestStandard(map, { lineOffset: line, colOffset: col }, b);
    }
  } else {
    ingestStandard(raw, { lineOffset: 0, colOffset: 0 }, b);
  }

  const { gl, gc, sr, ol, oc, nm } = b.arrays();
  const n = b.n;
  const sources = b.sources;
  const sourcesContent = b.sourcesContent;
  const names = b.names;

  /** 生成位置 (line, col) 的二分查找：最后一个 ≤ 它的 segment 下标（同一生成行内才算命中）；没有 = -1 */
  const lowerBound = (line, col) => {
    let lo = 0;
    let hi = n - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (gl[mid] < line || (gl[mid] === line && gc[mid] <= col)) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  return {
    sources,
    sourcesContent,
    names,
    segmentCount: n,
    skipped: b.skipped,

    /**
     * 生成位置 → 原始位置（0 起）。同一生成行里取「列 ≤ 给定列」的最近 segment；该行没有 segment 返回 null。
     * @returns {{ source: string, line: number, column: number, name?: string } | null}
     */
    originalPositionFor(line, column) {
      if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) return null;
      const i = lowerBound(line, column);
      if (i < 0 || gl[i] !== line) return null;
      return { source: sources[sr[i]] ?? "", line: ol[i], column: oc[i], ...(nm[i] >= 0 && names[nm[i]] ? { name: names[nm[i]] } : {}) };
    },

    /**
     * 原始位置 → 生成位置（0 起）：找该源文件里「(line, col) 之后最近」的 segment（同行优先）；
     * 线性扫描（只给 AI 偶发使用，不值得为它再建一份索引）。
     * @param {{ source: string, line: number, column?: number }} p
     * @returns {{ line: number, column: number } | null}
     */
    generatedPositionFor(p) {
      const si = sources.indexOf(p?.source);
      if (si < 0 || !Number.isInteger(p.line) || p.line < 0) return null;
      const col = Number.isInteger(p.column) && p.column >= 0 ? p.column : 0;
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (sr[i] !== si || ol[i] !== p.line) continue;
        // 同一原始行里优先「列 ≥ 目标列」中最小的；都没有就取列最大的（≤）
        if (oc[i] >= col) {
          if (best < 0 || oc[best] < col || oc[i] < oc[best]) best = i;
        } else if (best < 0 || (oc[best] < col && oc[i] > oc[best])) {
          best = i;
        }
      }
      return best < 0 ? null : { line: gl[best], column: gc[best] };
    },

    /** 源文件内容（map 内嵌的 sourcesContent）；缺失返回 null */
    sourceContentFor(source) {
      const i = sources.indexOf(source);
      return i < 0 ? null : (sourcesContent[i] ?? null);
    },
  };
};

/**
 * `data:` 型 sourceMappingURL 的内联 map 解码；不是 data: 返回 undefined；超限 / 坏编码抛 SourceMapError。
 * 支持 `;base64,` 与 URL 编码两种。
 * @param {string} url
 * @returns {string | undefined}
 */
export const decodeDataUrlMap = (url) => {
  if (!isStr(url) || !/^data:/i.test(url)) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) throw new SourceMapError("data: 型 sourceMappingURL 格式不对（缺少逗号）");
  const head = url.slice(5, comma).toLowerCase();
  if (!/^(application\/(json|octet-stream)|text\/plain)?(;[^,]*)?$/.test(head)) throw new SourceMapError("data: 型 sourceMappingURL 的类型不是 JSON");
  const body = url.slice(comma + 1);
  // base64 解码后约 3/4，URL 编码后 ≤ 原长：先按原长粗卡，再按解码后精卡
  if (body.length > MAX_MAP_BYTES * 2) throw new SourceMapError("内联 source map 过大");
  let text;
  try {
    text = head.includes(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
  } catch {
    throw new SourceMapError("内联 source map 解码失败");
  }
  if (text.length > MAX_MAP_BYTES) throw new SourceMapError("内联 source map 超过 5MB 上限");
  return text;
};

/**
 * 相对 sourceMappingURL 按脚本 URL 解析成绝对地址；解析不了返回 null。data: 原样返回。
 * @param {string} mapUrl
 * @param {string} scriptUrl
 */
export const resolveMapUrl = (mapUrl, scriptUrl) => {
  if (!isStr(mapUrl) || mapUrl === "" || mapUrl.length > 8192) return null;
  if (/^data:/i.test(mapUrl)) return mapUrl;
  try {
    return new URL(mapUrl, isStr(scriptUrl) && scriptUrl !== "" ? scriptUrl : undefined).href;
  } catch {
    return null;
  }
};

/** console 条目保留的结构化栈：最多帧数 / 函数名长度 / URL 长度（采集在 tab.mjs，页面可控 → 限量） */
export const STACK_MAX_FRAMES = 10;
const STACK_FN_MAX = 80;
const STACK_URL_MAX = 400;

/**
 * CDP `StackTrace.callFrames` → 精简帧 `[{functionName,url,line,column}]`（line / column 沿用 CDP 的 0 起）。
 * URL 先过 `redactUrl`（?token= 之类）再截长；帧缺 / 坐标非法的丢掉；一帧都没有返回 undefined（条目就不带 stack 字段）。
 * @param {unknown} callFrames
 * @param {(u: string) => string} [redactUrl]
 */
export const compactStackFrames = (callFrames, redactUrl = (u) => u) => {
  if (!Array.isArray(callFrames)) return undefined;
  const out = [];
  for (const f of callFrames) {
    if (out.length >= STACK_MAX_FRAMES) break;
    if (!f || typeof f !== "object") continue;
    const line = f.lineNumber;
    const column = f.columnNumber;
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(column) || column < 0) continue;
    const url = isStr(f.url) ? redactUrl(f.url).slice(0, STACK_URL_MAX) : "";
    out.push({ functionName: isStr(f.functionName) ? f.functionName.slice(0, STACK_FN_MAX) : "", url, line, column });
  }
  return out.length > 0 ? out : undefined;
};

/**
 * 把一组栈帧经 sourcemap 还原。纯函数：`getMap(url)` 由调用方提供（返回已解析的 map 或 null/undefined），
 * 失败 / 没有 map 的帧原样保留（不加 original 字段）——降级为原栈，绝不因为还原失败丢帧。
 * 帧坐标约定同 CDP：line / column 为 **0 起**（console 条目里存的是 1 起行号的话由调用方先换算）。
 * @param {Array<{ functionName?: string, url?: string, line: number, column: number }>} frames
 * @param {(url: string) => ReturnType<typeof parseSourceMap> | null | undefined} getMap
 */
export const resolveStackFrames = (frames, getMap) => {
  if (!Array.isArray(frames)) return [];
  return frames.slice(0, MAX_RESOLVE_FRAMES).map((f) => {
    if (!f || !isStr(f.url) || f.url === "") return f;
    let map = null;
    try {
      map = getMap(f.url) ?? null;
    } catch {
      map = null;
    }
    if (!map) return f;
    let pos = null;
    try {
      pos = map.originalPositionFor(f.line, f.column);
    } catch {
      pos = null;
    }
    return pos ? { ...f, original: pos } : f;
  });
};
