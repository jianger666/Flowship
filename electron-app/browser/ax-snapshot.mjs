/**
 * 无障碍树 → Playwright 风格文本快照 + ref 表（契约 §3 / §4.3 snapshot）。
 *
 * 分两层：
 * - **纯函数层**（`formatAxSnapshot` / `collectSnapshotCandidates`）：吃「已取回的 AX 节点数组」，吐文本与 ref 映射，
 *   不碰 CDP、不碰 electron，可直接单测。
 * - **CDP 层**（`captureAxFrames`）：用 Accessibility.getFullAXTree 把「主 frame + 同进程子 frame + 跨站 OOPIF 子会话」
 *   的树都取回来，并记下每个 iframe 的「所有者节点」，好让纯函数层把子 frame 内容嵌在对应 iframe 行的下面。
 *
 * 为什么用 AX 树而不是自己扫 DOM：自定义 `role=button` 的 div、shadow DOM、label 关联、aria-* 命名都由浏览器按规范算好，
 * 与读屏软件看到的是同一份语义，页面里的 JS 也伪造不了（探针 T2 / T6 实测）。
 *
 * ref 的稳定性约定：编号在同一个 tab 上**单调递增**（由调用方传 `refStart`），这样「上一次 snapshot 的 e12」
 * 在新 snapshot 之后永远不会碰巧指向另一个元素——调用方据此区分 REF_STALE（编号小于当前代首号）与 REF_NOT_FOUND。
 */

import { SECRET_ELEMENT_PROBE_SOURCE } from "./secret-field.mjs";

// ───────────────────────── 角色分类 ─────────────────────────

// CDP 给的 role 名大小写不统一（`RootWebArea` / `StaticText` / `button`），统一小写后比对；少数旧名映射到现行 ARIA 名
const ROLE_ALIASES = new Map([
  ["popupbutton", "combobox"],
  ["disclosuretriangle", "button"],
  ["listboxoption", "option"],
  ["menulistoption", "option"],
  ["textfield", "textbox"],
  ["date", "textbox"],
  ["datetime", "textbox"],
  ["inputtime", "textbox"],
  ["month", "textbox"],
  ["week", "textbox"],
  ["image", "img"],
]);

// 带 ref 的「可交互」角色
const REF_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "option",
  "treeitem",
  "heading",
]);

// 名字来自内容的节点：它的 StaticText 子孙只是在重复 name，必须压掉，否则每个按钮都要出两行
const CONTENT_NAMED = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "option",
  "treeitem",
  "heading",
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
]);

// 保留为「结构行」的地标 / 容器（没有可保留的内容时整体剪掉）
const STRUCT_ROLES = new Set([
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "region",
  "article",
  "dialog",
  "alertdialog",
  "alert",
  "tablist",
  "toolbar",
  "menu",
  "menubar",
  "tree",
  "listbox",
  "table",
  "grid",
  "row",
  "list",
]);

// 整棵子树直接丢弃：文本框切片 / 列表符号 / 换行 / 分隔线 / 滚动条
const SKIP_ROLES = new Set(["inlinetextbox", "listmarker", "linebreak", "separator", "scrollbar", "splitter", "none", "presentation"]);

// 行内语义：不制造「块边界」，其文字与相邻文字合并成一行
const INLINE_ROLES = new Set(["strong", "emphasis", "mark", "code", "time", "abbr", "subscript", "superscript", "insertion", "deletion"]);

/** 同一份 CDP AX 节点的取值小工具 */
const roleOf = (node) => {
  const v = String(node?.role?.value ?? "").toLowerCase();
  return ROLE_ALIASES.get(v) ?? v;
};
const nameOf = (node) => String(node?.name?.value ?? "");
const propOf = (node, name) => {
  const props = node?.properties;
  if (!Array.isArray(props)) return undefined;
  for (const p of props) if (p?.name === name) return p.value?.value;
  return undefined;
};

const MAX_DEPTH = 160; // 防止病态深层嵌套（几千层 div）把递归栈打爆
const MAX_NAME_CHARS = 160;
const MAX_TEXT_CHARS = 300;
const MAX_SELECT_OPTIONS = 40;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const squash = (s) => s.replace(/[\s\u00a0]+/g, " ").trim();

/** 可见性表的键：同一个 backendNodeId 在不同会话里是不同节点，必须带会话 */
export const visibilityKey = (sessionId, backendNodeId) => `${sessionId ?? ""}:${backendNodeId}`;

// ───────────────────────── 阶段 1：AX 节点 → 视图节点 ─────────────────────────

/**
 * @typedef {{ key: string, sessionId: string | null, chain: Array<{ sessionId: string | null, backendNodeId: number }>,
 *   ownerSessionId?: string | null, ownerBackendNodeId?: number | null, nodes: any[],
 *   secretNodes?: Set<number>, secretUnchecked?: number, nodesTruncated?: boolean }} AxFrame
 *   secretUnchecked：本 frame 里因探测数量超限没检查、值被一律按敏感处理的节点数（R2-12，formatAxSnapshot 据此在结果里注明）。
 */

const buildFrameIndex = (frame) => {
  const byId = new Map();
  for (const n of frame.nodes) byId.set(String(n.nodeId), n);
  // 根 = 没有（或找不到）父节点的节点；正常只有一个 RootWebArea
  let root = null;
  for (const n of frame.nodes) {
    if (n.parentId === undefined || !byId.has(String(n.parentId))) {
      root = n;
      break;
    }
  }
  return { byId, root: root ?? frame.nodes[0] ?? null };
};

const convertFrame = (frame, shared) => {
  const { byId, root } = buildFrameIndex(frame);
  if (!root) return [];
  const st = { frame, byId, shared, suppress: false, inSelect: false };
  return convertNode(root, st, 0);
};

const seesNode = (st, node) => {
  const id = node.backendDOMNodeId;
  if (st.shared.onCandidate && id !== undefined) st.shared.onCandidate(st.frame.sessionId, id);
  const visible = st.shared.visible;
  if (!visible) return true;
  return id !== undefined && visible.has(visibilityKey(st.frame.sessionId, id));
};

const convertChildren = (node, st, depth) => {
  const out = [];
  const ids = node.childIds;
  if (!Array.isArray(ids)) return out;
  for (const id of ids) {
    const child = st.byId.get(String(id));
    if (child) {
      for (const v of convertNode(child, st, depth + 1)) out.push(v);
    }
  }
  return mergeTexts(out);
};

/** 相邻文本合并：StaticText 本身带着前后空白（`段落 ` + `粗体` + ` 结尾`），直接拼起来再规整空白 */
const mergeTexts = (list) => {
  const out = [];
  for (const v of list) {
    const last = out[out.length - 1];
    if (v.t === "text" && last && last.t === "text") last.text += v.text;
    else out.push(v.t === "text" ? { ...v } : v);
  }
  return out;
};

const convertNode = (node, st, depth) => {
  if (depth > MAX_DEPTH) return [];
  const role = roleOf(node);
  if (SKIP_ROLES.has(role)) {
    // `none` 在被忽略时只是透明容器（body / 纯布局节点），子树里的文字要保留
    if (role === "none" || role === "presentation") return convertChildren(node, st, depth);
    return [];
  }
  // ignored 节点在树里仍带着 childIds：当透明容器穿过去（span 之类的纯行内包装就是这样）
  if (node.ignored) return convertChildren(node, st, depth);

  const name = squash(nameOf(node));

  switch (role) {
    case "rootwebarea":
      return convertChildren(node, st, depth);
    case "statictext": {
      if (st.suppress || !seesNode(st, node)) return [];
      return [{ t: "text", text: nameOf(node) }];
    }
    case "img": {
      if (st.suppress || name === "" || !seesNode(st, node)) return [];
      return [{ t: "img", name: clip(name, MAX_NAME_CHARS) }];
    }
    case "iframe":
    case "iframepresentational": {
      const id = node.backendDOMNodeId;
      const owned = id === undefined ? undefined : st.shared.ownerIndex.get(visibilityKey(st.frame.sessionId, id));
      const children = [];
      if (owned) for (const f of owned) for (const v of convertFrame(f, st.shared)) children.push(v);
      if (name === "" && children.length === 0) return [];
      return [{ t: "frame", name: clip(name, MAX_NAME_CHARS), children: mergeTexts(children) }];
    }
    case "menulistpopup": {
      // 原生 <select> 的弹层：里面的 option 作为只读行列在 combobox 下，不给 ref（折叠态点不到，要用 select 操作）
      return convertChildren(node, { ...st, inSelect: true, suppress: true }, depth);
    }
    default:
      break;
  }

  if (role === "option" && st.inSelect) {
    return [{ t: "option", name: clip(name, MAX_NAME_CHARS), selected: propOf(node, "selected") === true }];
  }

  if (REF_ROLES.has(role)) {
    const own = seesNode(st, node);
    const childSt = CONTENT_NAMED.has(role) ? { ...st, suppress: true } : st;
    const children = convertChildren(node, childSt, depth);
    if (!own) return children; // 视口外：节点行丢掉，但嵌套的可见子孙仍保留
    return [
      {
        t: "ref",
        role,
        name: clip(name, MAX_NAME_CHARS),
        backendNodeId: node.backendDOMNodeId,
        sessionId: st.frame.sessionId,
        chain: st.frame.chain,
        frameKey: st.frame.key,
        attrs: refAttrs(node, role),
        value: refValue(node, role, st.frame.secretNodes?.has(node.backendDOMNodeId) === true),
        children,
      },
    ];
  }

  if (STRUCT_ROLES.has(role)) {
    const children = convertChildren(node, st, depth);
    return children.length === 0 ? [] : [{ t: "struct", role, name: clip(name, MAX_NAME_CHARS), children }];
  }

  // 其余一律透明：行内语义直接并入父级文字流，块级（generic / paragraph / listitem / cell …）则各成一个块，
  // 块与块之间的文字不再合并
  const children = convertChildren(node, st, depth);
  if (children.length === 0) return [];
  return INLINE_ROLES.has(role) ? children : [{ t: "block", children }];
};

const refAttrs = (node, role) => {
  const attrs = [];
  if (role === "heading") {
    const level = propOf(node, "level");
    if (level !== undefined) attrs.push(`level=${level}`);
  }
  if (propOf(node, "disabled") === true) attrs.push("disabled");
  const checked = propOf(node, "checked");
  if (checked === "true" || checked === true) attrs.push("checked");
  else if (checked === "mixed") attrs.push("checked=mixed");
  const pressed = propOf(node, "pressed");
  if (pressed === "true" || pressed === true) attrs.push("pressed");
  else if (pressed === "mixed") attrs.push("pressed=mixed");
  if (propOf(node, "expanded") === true) attrs.push("expanded");
  if (propOf(node, "selected") === true) attrs.push("selected");
  if (propOf(node, "required") === true) attrs.push("required");
  if (propOf(node, "readonly") === true) attrs.push("readonly");
  return attrs;
};

const VALUE_ROLES = new Set(["textbox", "searchbox", "spinbutton", "slider", "combobox"]);
/** 敏感字段在快照里的固定占位：不暴露内容，也不暴露长度 */
export const SECRET_VALUE_TEXT = "[已隐藏]";
/**
 * ref 行末尾的当前值。R1-25：`secret` 为 true（captureAxFrames 在页内用 secret-field.mjs 的统一规则探测过：
 * password / one-time-code / cc-* / -webkit-text-security）时只给占位；
 * 兜底：AX 没有探测信息（纯函数单测 / 探测被跳过）时，仍按「全圆点值」判密码框。
 */
const refValue = (node, role, secret = false) => {
  if (!VALUE_ROLES.has(role)) return undefined;
  const raw = node.value?.value;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw);
  if (secret === true || /^[•●·]+$/.test(s)) return SECRET_VALUE_TEXT;
  return clip(squash(s), 120);
};

// ───────────────────────── 阶段 2：清理 + 序列化 ─────────────────────────

/** 规整文字、剪掉空块 / 空容器；返回新树（不改入参） */
const clean = (nodes) => {
  const out = [];
  for (const v of nodes) {
    switch (v.t) {
      case "text": {
        const s = squash(v.text);
        // 纯标点 / 符号（分隔符、图标字体）没有信息量
        if (s !== "" && /[\p{L}\p{N}]/u.test(s)) out.push({ t: "text", text: clip(s, MAX_TEXT_CHARS) });
        break;
      }
      case "block": {
        // 块本身不输出，只是隔开文字合并；展开到当前层级
        for (const c of clean(v.children)) out.push(c);
        break;
      }
      case "struct":
      case "ref":
      case "frame": {
        const children = clean(v.children);
        if (v.t === "struct" && children.length === 0) break;
        out.push({ ...v, children });
        break;
      }
      default:
        out.push(v);
    }
  }
  return out;
};

const quote = (s) => JSON.stringify(s);

/**
 * 把节点列表序列化成缩进文本，同时分配 ref。预算（元素数 / 字符数）用尽立即停止，并标记 truncated。
 */
const serialize = (nodes, { maxChars, maxElements, refStart }) => {
  const lines = [];
  const refs = new Map();
  let chars = 0;
  let nextRef = refStart;
  let refCount = 0;
  let truncated = false;
  // 给截断提示留位置：提示行本身不能把总量顶过上限
  const TRAILER = "- …（内容已截断：可调小范围——scroll 后重新 snapshot，或 viewportOnly:true）";
  const budget = Math.max(0, maxChars - TRAILER.length - 1);

  const emit = (depth, text) => {
    const line = `${"  ".repeat(depth)}${text}`;
    if (chars + line.length + 1 > budget) {
      truncated = true;
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };

  const walk = (list, depth) => {
    for (const v of list) {
      if (truncated) return;
      switch (v.t) {
        case "text":
          if (!emit(depth, `- text: ${v.text}`)) return;
          break;
        case "img":
          if (!emit(depth, `- img ${quote(v.name)}`)) return;
          break;
        case "option":
          if (!emit(depth, `- option ${quote(v.name)}${v.selected ? " [selected]" : ""}`)) return;
          break;
        case "frame": {
          const head = `- iframe${v.name ? ` ${quote(v.name)}` : ""}`;
          if (!emit(depth, v.children.length > 0 ? `${head}:` : head)) return;
          walk(v.children, depth + 1);
          break;
        }
        case "struct": {
          if (!emit(depth, `- ${v.role}${v.name ? ` ${quote(v.name)}` : ""}:`)) return;
          walk(v.children, depth + 1);
          break;
        }
        case "ref": {
          const canRef = v.backendNodeId !== undefined;
          if (canRef && refCount >= maxElements) {
            truncated = true;
            return;
          }
          let head = `- ${v.role}${v.name ? ` ${quote(v.name)}` : ""}`;
          for (const a of v.attrs) head += ` [${a}]`;
          let ref = null;
          if (canRef) {
            ref = `e${nextRef}`;
            head += ` [ref=${ref}]`;
          }
          if (v.value !== undefined) head += `: ${quote(v.value)}`;
          else if (v.children.length > 0) head += ":";
          // 先尝试输出再登记 ref：行放不下时这个 ref 不能存在（否则表里有、文本里没有）
          if (!emit(depth, head)) return;
          if (ref) {
            nextRef += 1;
            refCount += 1;
            refs.set(ref, {
              ref,
              role: v.role,
              name: v.name,
              backendNodeId: v.backendNodeId,
              sessionId: v.sessionId,
              frameKey: v.frameKey,
              chain: v.chain,
            });
          }
          // 原生 select 的 option 行数封顶，免得一个国家下拉框吃掉半个预算
          let kids = v.children;
          const optionCount = kids.filter((k) => k.t === "option").length;
          if (optionCount > MAX_SELECT_OPTIONS) {
            let seen = 0;
            kids = kids.filter((k) => k.t !== "option" || ++seen <= MAX_SELECT_OPTIONS);
            kids.push({ t: "text", text: `…（另有 ${optionCount - MAX_SELECT_OPTIONS} 个选项未列出）` });
          }
          walk(kids, depth + 1);
          break;
        }
        default:
          break;
      }
    }
  };

  walk(nodes, 0);
  if (truncated) lines.push(TRAILER);
  return { text: lines.join("\n"), refs, refCount, truncated, nextRef };
};

// ───────────────────────── 对外：纯函数入口 ─────────────────────────

const buildShared = (frames, { visible = null, onCandidate = null } = {}) => {
  const ownerIndex = new Map();
  for (const f of frames) {
    if (f.ownerBackendNodeId === undefined || f.ownerBackendNodeId === null) continue;
    const k = visibilityKey(f.ownerSessionId ?? null, f.ownerBackendNodeId);
    const list = ownerIndex.get(k);
    if (list) list.push(f);
    else ownerIndex.set(k, [f]);
  }
  return { ownerIndex, visible, onCandidate };
};

const rootFrameOf = (frames) =>
  frames.find((f) => f.ownerBackendNodeId === undefined || f.ownerBackendNodeId === null) ?? frames[0];

/**
 * 树 → 文本 + ref 表。
 *
 * @param {{ frames: AxFrame[], maxChars?: number, maxElements?: number, refStart?: number, visible?: Set<string> | null, query?: string }} input
 *   frames：第一个（无 owner 的）是主 frame；其余按 owner 嵌进对应的 iframe 行。
 *   visible：viewportOnly 时由调用方算好的可见节点集合（键见 visibilityKey），不传则不过滤。
 * @returns {{ text: string, refs: Map<string, { ref: string, role: string, name: string, backendNodeId: number, sessionId: string | null, frameKey: string, chain: Array<{ sessionId: string | null, backendNodeId: number }> }>, refCount: number, truncated: boolean, nextRef: number }}
 */
export const formatAxSnapshot = ({ frames, maxChars = 30000, maxElements = 1500, refStart = 1, visible = null, query }) => {
  const root = rootFrameOf(frames);
  if (!root) return { text: "", refs: new Map(), refCount: 0, truncated: false, nextRef: refStart };
  const shared = buildShared(frames, { visible });
  const tree = clean(convertFrame(root, shared));
  const wantQuery = typeof query === "string" && query.trim() !== "";
  // query 模式：先用大预算序列化出「完整」快照再过滤。预算若直接按 maxChars 截断，命中行可能恰好落在被截掉的后半段，
  // 模型就会得到「没有匹配」的误导结论；ref 仍按完整快照的顺序登记，所以和不带 query 时的编号一致。
  const full = serialize(tree, {
    maxChars: Math.max(200, wantQuery ? Math.max(maxChars, QUERY_SOURCE_MAX_CHARS) : maxChars),
    maxElements: Math.max(1, wantQuery ? Math.max(maxElements, QUERY_SOURCE_MAX_ELEMENTS) : maxElements),
    refStart,
  });
  // R1-29：AX 树节点数超上限（captureAxFrames 截掉了尾部）时必须在结果里说清楚，免得模型把「没列出」当成「页面没有」
  if (frames.some((f) => f.nodesTruncated === true)) {
    full.truncated = true;
    if (!full.text.includes(AX_TRUNCATE_NOTE)) full.text = full.text ? `${full.text}\n${AX_TRUNCATE_NOTE}` : AX_TRUNCATE_NOTE;
  }
  // R2-12：有带值节点因探测数量超限没检查（值一律隐藏）时必须注明，免得模型把「[已隐藏]」当成「页面没有值」。
  // 说明行放在 query 过滤之后追加（过滤只认 SNAPSHOT_TRUNCATE_MARK 开头的说明行，放进 full.text 会被当成普通行参与匹配）。
  const unchecked = frames.reduce((sum, f) => sum + (typeof f.secretUnchecked === "number" ? f.secretUnchecked : 0), 0);
  const withSecretNote = (text) => (unchecked > 0 ? (text ? `${text}\n${secretUncheckedNote(unchecked)}` : secretUncheckedNote(unchecked)) : text);
  if (!wantQuery) return { ...full, text: withSecretNote(full.text) };
  const filtered = filterSnapshotText(full.text, query, { total: full.refCount, maxChars, sourceTruncated: full.truncated });
  return { ...full, text: withSecretNote(filtered.text), truncated: filtered.truncated };
};

// ───────────────────────── query 过滤（V1，纯函数） ─────────────────────────

/** query 模式下过滤前的完整快照预算（与 normalize 允许的最大 maxChars / maxElements 对齐） */
const QUERY_SOURCE_MAX_CHARS = 300_000;
const QUERY_SOURCE_MAX_ELEMENTS = 5000;
const QUERY_CONTEXT_LINES = 2;
const SNAPSHOT_TRUNCATE_MARK = "- …（内容已截断";
/** AX 树节点数超上限被截断的提示行（以 SNAPSHOT_TRUNCATE_MARK 开头：query 过滤时按「来源被截断」处理） */
export const AX_TRUNCATE_NOTE = `${SNAPSHOT_TRUNCATE_MARK}：页面节点过多，AX 树只读取了前部分节点，后面的内容与元素没有列出，可 scroll 后重新 snapshot 或用 query 缩小范围）`;
const REF_TAG_RE = / \[ref=e\d+\]/g;

const lineDepth = (line) => Math.floor((/^( *)/.exec(line)?.[1].length ?? 0) / 2);

/**
 * 快照文本按 query 过滤：只留「命中行 + 祖先链 + 前后各 2 行上下文」，ref 保持不变（行文本原样保留）。
 *
 * - 匹配：大小写不敏感的子串，范围是整行（角色 / 名称 / 属性 / 值）；行尾的 `[ref=eN]` 标记不参与匹配
 *   （否则搜 `ref` 会命中所有可交互元素）。query 本身形如 `e12` 时改为精确匹配该 ref 标记，方便「看看 e12 周围是什么」。
 * - 祖先链：沿缩进往上找每一级父行，让命中行带着它所在的区域 / 列表 / 表单一起出现。
 * - 头部写「命中 N 行 / 共 M 个可交互元素」；无命中时明确说「没有匹配」并给出下一步建议，而不是返回空串。
 * - 结果超过 maxChars 时截断并说明；来源快照本身被截断时也要如实提示（命中可能不全）。
 *
 * @returns {{ text: string, hits: number, truncated: boolean }}
 */
export const filterSnapshotText = (text, query, { total = 0, maxChars = 30000, sourceTruncated = false } = {}) => {
  const q = String(query ?? "").trim();
  const shown = q.length > 60 ? `${q.slice(0, 60)}…` : q;
  const lines = String(text ?? "").split("\n");
  const body = lines.filter((l) => !l.startsWith(SNAPSHOT_TRUNCATE_MARK));
  const refQuery = /^e\d+$/i.test(q) ? `[ref=${q.toLowerCase()}]` : null;
  const needle = q.toLowerCase();
  const hitIdx = [];
  body.forEach((line, i) => {
    const l = line.toLowerCase();
    const ok = refQuery ? l.includes(refQuery) : l.replace(REF_TAG_RE, "").includes(needle);
    if (ok) hitIdx.push(i);
  });
  const srcNote = sourceTruncated ? "（注意：页面太大，原始快照已被截断，命中可能不全）" : "";
  if (hitIdx.length === 0) {
    return {
      text: `没有匹配「${shown}」的行（页面共 ${total} 个可交互元素）。${srcNote}匹配范围是元素角色 / 名称 / 属性 / 值，大小写不敏感；可换个关键词，或不带 query 重新 snapshot。`,
      hits: 0,
      truncated: sourceTruncated,
    };
  }
  const keep = new Set();
  for (const i of hitIdx) {
    keep.add(i);
    // 祖先链：缩进更浅的最近一行，逐级向上
    let need = lineDepth(body[i]);
    for (let j = i - 1; j >= 0 && need > 0; j--) {
      const d = lineDepth(body[j]);
      if (d < need) {
        keep.add(j);
        need = d;
      }
    }
    for (let k = Math.max(0, i - QUERY_CONTEXT_LINES); k <= Math.min(body.length - 1, i + QUERY_CONTEXT_LINES); k++) keep.add(k);
  }
  const header = `筛选「${shown}」：命中 ${hitIdx.length} 行 / 共 ${total} 个可交互元素（ref 与完整快照一致）${srcNote}`;
  const out = [header];
  let chars = header.length + 1;
  let truncated = sourceTruncated;
  let prev = -1;
  const sorted = [...keep].sort((a, b) => a - b);
  for (const i of sorted) {
    // 被略去的区间要标出来（含首尾）：让模型知道上下还有内容，没有误以为页面就这么点
    const gap = i - prev - 1;
    const chunk = gap > 0 ? [prev < 0 ? `…（上方省略 ${gap} 行）` : `…（省略 ${gap} 行）`, body[i]] : [body[i]];
    const size = chunk.reduce((n, l) => n + l.length + 1, 0);
    if (chars + size > maxChars) {
      out.push("- …（筛选结果已截断：请换更精确的 query）");
      truncated = true;
      break;
    }
    out.push(...chunk);
    chars += size;
    prev = i;
  }
  if (!truncated && body.length - 1 - prev > 0) out.push(`…（下方省略 ${body.length - 1 - prev} 行）`);
  return { text: out.join("\n"), hits: hitIdx.length, truncated };
};

/**
 * viewportOnly 的前置：枚举「会被输出」的节点（会话 + backendNodeId），调用方据此做几何可见性探测。
 * 与 formatAxSnapshot 走同一套转换，保证候选集合与最终输出一致。
 *
 * @param {{ frames: AxFrame[] }} input
 * @returns {Array<{ sessionId: string | null, backendNodeId: number }>}
 */
export const collectSnapshotCandidates = ({ frames }) => {
  const root = rootFrameOf(frames);
  if (!root) return [];
  const seen = new Set();
  const list = [];
  const shared = buildShared(frames, {
    onCandidate: (sessionId, backendNodeId) => {
      const k = visibilityKey(sessionId, backendNodeId);
      if (seen.has(k)) return;
      seen.add(k);
      list.push({ sessionId, backendNodeId });
    },
  });
  convertFrame(root, shared);
  return list;
};

// ───────────────────────── CDP 层：取回各 frame 的 AX 树 ─────────────────────────

const isGone = (err) => /Session with given id not found|Target closed|detached|not found/i.test(String(err?.message ?? err));

/**
 * 取回「主 frame + 同进程子 frame + OOPIF 子会话」的 AX 树。
 *
 * 为什么这么绕：getFullAXTree 默认只给「当前 frame 的文档」——同源 / 同站 iframe 的内容要带 frameId 单独取，
 * 跨站 iframe（OOPIF）在父树里只有一个空的 Iframe 节点，内容在它自己的子会话里（探针 T6）。
 *
 * @param {{
 *   send: (method: string, params?: object, sessionId?: string | null) => Promise<any>,
 *   childSessions: Array<{ sessionId: string, targetId: string, parentSessionId: string | null }>,
 *   maxFrames?: number,
 *   maxNodesPerTree?: number,
 *   maxNodesTotal?: number,
 * }} deps
 * @returns {Promise<AxFrame[]>}
 */
export const captureAxFrames = async ({ send, childSessions, maxFrames = 24, maxNodesPerTree = MAX_AX_NODES_PER_TREE, maxNodesTotal = MAX_AX_NODES_TOTAL }) => {
  /** @type {AxFrame[]} */
  const frames = [];
  const enabled = new Set();
  // R1-29：getFullAXTree 一次返回整棵树，病态页面（几十万节点）会把后面的转换 / 清理 / 序列化拖垮。
  // 单棵与总量都封顶：超了就丢尾部，并在 frame 上标 nodesTruncated，formatAxSnapshot 据此在结果里注明。
  let nodesLeft = maxNodesTotal;

  const ensureAx = async (sessionId) => {
    const k = sessionId ?? "";
    if (enabled.has(k)) return;
    enabled.add(k);
    await send("Accessibility.enable", {}, sessionId).catch(() => {});
  };

  const fetchTree = async (sessionId, frameId) => {
    await ensureAx(sessionId);
    const r = await send("Accessibility.getFullAXTree", frameId ? { frameId } : {}, sessionId);
    const all = Array.isArray(r?.nodes) ? r.nodes : [];
    const cap = Math.max(0, Math.min(maxNodesPerTree, nodesLeft));
    if (all.length <= cap) {
      nodesLeft -= all.length;
      return { nodes: all, truncated: false };
    }
    nodesLeft -= cap;
    return { nodes: all.slice(0, cap), truncated: true };
  };

  const ownerOf = async (sessionId, frameId) => {
    try {
      const r = await send("DOM.getFrameOwner", { frameId }, sessionId);
      return typeof r?.backendNodeId === "number" ? r.backendNodeId : null;
    } catch {
      return null;
    }
  };

  /**
   * 收一个会话里的全部本地 frame。
   * @param rootInfo 该会话根 frame 的挂接信息（主会话为 null）
   */
  const collectSession = async (sessionId, rootFrameId, rootInfo, baseChain) => {
    if (frames.length >= maxFrames) return;
    let tree;
    try {
      tree = (await send("Page.getFrameTree", {}, sessionId))?.frameTree;
    } catch (err) {
      if (!isGone(err)) throw err;
      return;
    }
    if (!tree?.frame) return;
    const sKey = sessionId ?? "main";

    // DFS 本会话内的本地 frame（OOPIF 不在这棵树里，它们走子会话）
    const walk = async (node, isRoot) => {
      if (frames.length >= maxFrames) return;
      const frameId = isRoot ? (rootFrameId ?? node.frame.id) : node.frame.id;
      let nodes;
      let truncated = false;
      try {
        ({ nodes, truncated } = await fetchTree(sessionId, isRoot ? null : frameId));
      } catch (err) {
        if (!isGone(err)) throw err;
        nodes = [];
      }
      if (nodes.length > 0) {
        const f = { key: `${sKey}:${frameId}`, sessionId, chain: baseChain, nodes };
        if (truncated) f.nodesTruncated = true;
        if (isRoot) {
          if (rootInfo) {
            f.ownerSessionId = rootInfo.ownerSessionId;
            f.ownerBackendNodeId = rootInfo.ownerBackendNodeId;
          }
        } else {
          const owner = await ownerOf(sessionId, frameId);
          if (owner !== null) {
            f.ownerSessionId = sessionId;
            f.ownerBackendNodeId = owner;
          }
        }
        // 主会话根 frame 必须排第一（formatAxSnapshot 以它为入口）
        frames.push(f);
      }
      for (const child of node.childFrames ?? []) await walk(child, false);
    };
    await walk(tree, true);

    // 本会话的 OOPIF 子会话
    for (const child of childSessions) {
      if (child.parentSessionId !== sessionId) continue;
      if (frames.length >= maxFrames) return;
      const owner = await ownerOf(sessionId, child.targetId);
      const info = { ownerSessionId: sessionId, ownerBackendNodeId: owner };
      const chain = owner === null ? baseChain : [...baseChain, { sessionId, backendNodeId: owner }];
      await collectSession(child.sessionId, child.targetId, info, chain);
    }
  };

  await collectSession(null, null, null, []);
  await markSecretNodes(send, frames);
  return frames;
};

/** getFullAXTree 的节点数上限：单棵 / 全部 frame 合计（正常页面几千到几万；超过的是病态页面） */
export const MAX_AX_NODES_PER_TREE = 50_000;
export const MAX_AX_NODES_TOTAL = 120_000;
/**
 * 一次 snapshot 里最多**完整探测**（resolveNode + callFunctionOn + releaseObject，三次往返）多少个「带值的输入框」是否敏感；
 * 超出的一律按敏感处理（fail closed），并在快照里注明个数（R2-12）。
 * 取舍：400 个 × 3 次往返、8~16 并发，本机 CDP 约几百毫秒；再往上换来的只是极端页面（几百个带值输入框）更多的值，不值得拖慢每次 snapshot。
 */
export const MAX_SECRET_PROBES = 400;
/** 非文本框类（combobox / slider / spinbutton）带值节点的预检（DOM.describeNode，一次往返）上限；超出的不预检，直接排进完整探测队列 */
export const MAX_SECRET_PRECHECKS = 1000;

/** 值有「用户自己敲字」可能的角色：最可能是密码 / 验证码 / 卡号，完整探测里排最前 */
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox"]);

/** 因探测数量超限没检查的带值节点的说明行（挂在快照末尾）；不以 SNAPSHOT_TRUNCATE_MARK 开头——它不是「内容被截断」 */
const secretUncheckedNote = (n) =>
  `- …（值已隐藏：另有 ${n} 个带值的输入框 / 下拉框因数量超限（单次快照最多检查 ${MAX_SECRET_PROBES} 个是否为密码 / 验证码类字段）没有检查，` +
  "它们的值一律显示为「[已隐藏]」——不是页面没有值；确实需要某个值时请让用户确认，或在已开启「允许 AI 执行页面脚本」时用 browser_evaluate 读取该元素）";

/**
 * 预检结果分类（DOM.describeNode 返回的 node）：
 * - "safe"：底层是 `<select>` 或 `<input type=range>`——值来自页面预设的选项 / 滑块位置，不是用户敲的字，天然不可能是密码 / 卡号，免完整探测；
 * - "input"：底层是 input / textarea（含 ARIA role 被改成 combobox / spinbutton 的 `<input type=password>`）——按文本框同级优先探测；
 * - "other"：其它（自定义 div role=combobox 等）/ 信息不全——保持默认优先级，仍要完整探测。
 * 注意 `<input type=number>` 不算 safe：数字框常被拿来装卡号 / PIN（甚至带 -webkit-text-security），必须探。
 */
const classifyDescribedNode = (node) => {
  const name = String(node?.nodeName ?? node?.localName ?? "").toUpperCase();
  if (name === "SELECT") return "safe";
  if (name !== "INPUT" && name !== "TEXTAREA") return "other";
  let type = "";
  const attrs = Array.isArray(node?.attributes) ? node.attributes : [];
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (String(attrs[i]).toLowerCase() === "type") {
      type = String(attrs[i + 1]).trim().toLowerCase();
      break;
    }
  }
  return name === "INPUT" && type === "range" ? "safe" : "input";
};

const runInBatches = async (list, size, fn) => {
  for (let i = 0; i < list.length; i += size) await Promise.all(list.slice(i, i + size).map(fn));
};

/**
 * R1-25：AX 树里只有「全圆点」的密码框看得出来，OTP / 银行卡 / `-webkit-text-security` 字段的值是明文。
 * 对「带非空值的输入类节点」到页内用统一规则（secret-field.mjs）探测，命中的 backendNodeId 记到 frame.secretNodes，
 * refValue 据此只给「[已隐藏]」。探测失败 / 节点解析不了 / 超出 MAX_SECRET_PROBES 一律按敏感处理——宁可遮多了，也不漏。
 * 只探测带值的节点：没有值就没有可泄漏的东西，绝大多数页面一次也不会探。
 *
 * R2-12：预算有限时先探「风险高」的，免得文档靠前的一堆正常 select / 数字框把预算吃光、靠后的值全丢：
 * ① 预检（一次往返）：combobox / slider / spinbutton 先 DOM.describeNode 看底层——`<select>` / `<input type=range>` 判 safe 免完整探测
 *    （不占预算），底层是 input / textarea（role 被改写）的升到文本框同级；预检失败 / 不支持则保持原样，只是不能免探，不影响正确性；
 * ② 完整探测队列按风险排序：textbox / searchbox（及预检出的 input）在前，其余在后，同级保持文档序；
 * ③ 超出 MAX_SECRET_PROBES 的节点值照旧隐藏（fail closed），个数记到 frame.secretUnchecked，formatAxSnapshot 在结果里注明。
 */
const markSecretNodes = async (send, frames) => {
  /** @type {Array<{ frame: AxFrame, backendNodeId: number, risky: boolean, safe: boolean }>} */
  const jobs = [];
  for (const f of frames) {
    for (const n of f.nodes) {
      if (n.ignored || typeof n.backendDOMNodeId !== "number") continue;
      const role = roleOf(n);
      if (!VALUE_ROLES.has(role)) continue;
      const raw = n.value?.value;
      if (raw === undefined || raw === null || raw === "") continue;
      jobs.push({ frame: f, backendNodeId: n.backendDOMNodeId, risky: TEXT_ENTRY_ROLES.has(role), safe: false });
    }
  }
  if (jobs.length === 0) return;
  const markSecret = (frame, backendNodeId) => {
    if (!frame.secretNodes) frame.secretNodes = new Set();
    frame.secretNodes.add(backendNodeId);
  };

  // ① 预检
  const precheck = jobs.filter((j) => !j.risky).slice(0, MAX_SECRET_PRECHECKS);
  await runInBatches(precheck, 32, async (job) => {
    try {
      const r = await send("DOM.describeNode", { backendNodeId: job.backendNodeId }, job.frame.sessionId);
      const kind = classifyDescribedNode(r?.node);
      if (kind === "safe") job.safe = true;
      else if (kind === "input") job.risky = true;
    } catch {
      /* 预检失败：留给完整探测（fail closed 的责任在完整探测上） */
    }
  });

  // ② 排序（稳定：同级保持文档序）
  const queue = jobs.filter((j) => !j.safe);
  const ordered = [...queue.filter((j) => j.risky), ...queue.filter((j) => !j.risky)];

  // ③ 超限：fail closed + 计数
  const within = ordered.slice(0, MAX_SECRET_PROBES);
  for (const over of ordered.slice(MAX_SECRET_PROBES)) {
    markSecret(over.frame, over.backendNodeId);
    over.frame.secretUnchecked = (over.frame.secretUnchecked ?? 0) + 1;
  }
  const probe = async ({ frame, backendNodeId }) => {
    let objectId;
    let secret = true;
    try {
      const r = await send("DOM.resolveNode", { backendNodeId }, frame.sessionId);
      objectId = r?.object?.objectId;
      if (objectId) {
        const res = await send(
          "Runtime.callFunctionOn",
          { objectId, functionDeclaration: SECRET_ELEMENT_PROBE_SOURCE, returnByValue: true, awaitPromise: false, silent: true },
          frame.sessionId,
        );
        if (!res?.exceptionDetails && typeof res?.result?.value === "boolean") secret = res.result.value;
      }
    } catch {
      secret = true;
    } finally {
      if (objectId) void Promise.resolve(send("Runtime.releaseObject", { objectId }, frame.sessionId)).catch(() => {});
    }
    if (secret) markSecret(frame, backendNodeId);
  };
  await runInBatches(within, 16, probe);
};
