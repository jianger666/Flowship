/**
 * closed shadow root 下的「敏感字段」判定补强（E2·P10 / C7）。**只服务读取侧**（录屏遇到可见 / 聚焦的敏感输入框就丢帧）；AI 往敏感框里输入不受限制。
 *
 * # 漏洞（真机证明过）
 * 页内焦点探针靠 `el.shadowRoot.activeElement` 逐层下钻——**只认 open shadow root**。
 * `attachShadow({mode:"closed"})` 时 `host.shadowRoot === null`：`document.activeElement` 停在 host 上，host 自己不是密码框，
 * 探针就判 `safe`，于是录屏会把 closed 里正在输入的密码框画面写进磁盘。
 *
 * # 修法（只升级、不降级）
 * 原页内探针先跑；它给出 `safe` 时，这里再用 **CDP** 穿透 closed root 复核——
 * `DOM.describeNode{objectId}` 会列出 host 的 `shadowRoots`（含 closed，且带 `shadowRootType`），
 * `DOM.resolveNode{backendNodeId: shadowRoot}` 拿到 ShadowRoot 对象本身的引用（closed 只是不经 `host.shadowRoot` 暴露，
 * 引用拿到了照样能读 `activeElement` / `elementFromPoint`），逐层下钻到真正的焦点 / 落点元素，最后用统一的
 * `SECRET_ELEMENT_PROBE_SOURCE` 判它自己（不依赖 shadowRoot 遍历）。任何一步出错 / 层数耗尽 → `unknown`（调用方按「不确定」处理，fail-closed）。
 *
 * 不引入新的主世界注入：这些函数都是 `Runtime.callFunctionOn` 的一次性函数体，用完 `releaseObjectGroup`。
 * 与已知缺口一致（§14.9）：主世界探针能被「覆盖 ShadowRoot.prototype.activeElement 的页面」骗，这条路挡不住。
 */
import { FRAME_TAG_FN_SOURCE, SECRET_ELEMENT_PROBE_SOURCE } from "./secret-field.mjs";

const GROUP = "flowship-closed-shadow-probe";
/**
 * 每次探测独占一个 objectGroup（带递增后缀）。以前所有探测共用一个固定 group：并发的两次探测（录屏每帧的焦点复核 vs. AI 的 type / click 的焦点复核）
 * 里任何一个先跑完 `releaseObjectGroup`，另一个手里的 objectId 就失效（"Could not find object with given id"）→ 探针抛错 → unknown → 误拒（fail-closed 没漏，但会误伤）。
 */
let groupSeq = 0;
const newGroup = () => `${GROUP}-${++groupSeq}`;
/** 下钻层数上限：与页内探针同口径（超过 20 层 shadow / iframe 嵌套 = 探不到最深处 → unknown） */
export const MAX_SHADOW_DEPTH = 20;

/** 沿 open shadow root / 同源框架（iframe / frame / object / embed / fencedframe，R6-36）取下一层焦点元素；没有更深一层 / contentDocument 读不进返回 null */
export const NEXT_FOCUS_OPEN_FN = `function () {
  ${FRAME_TAG_FN_SOURCE}
  try {
    var el = this;
    var sr = el.shadowRoot;
    if (sr && sr.activeElement) return sr.activeElement;
    var tag = String(el.localName || el.tagName || '').toLowerCase();
    if (isFrameLikeTag(tag)) {
      var d = null;
      try { d = el.contentDocument; } catch (e) { d = null; }
      if (d && d.activeElement) return d.activeElement;
    }
  } catch (e) {}
  return null;
}`;

/** this = ShadowRoot 对象：它的焦点元素（焦点不在这个 root 里时是 null） */
export const ROOT_ACTIVE_FN = `function () { try { return this.activeElement || null; } catch (e) { return null; } }`;

/** this = 任意元素：它所在 document 的 activeElement */
const DOC_ACTIVE_FN = `function () { try { return (this.ownerDocument || document).activeElement || null; } catch (e) { return null; } }`;

const isNodeRef = (r) => !!r && r.subtype === "node" && typeof r.objectId === "string" && r.objectId !== "";

/**
 * 从 `DOM.describeNode` 的结果里挑出 closed shadow root 的 backendNodeId（纯函数，有单测）。
 * 只认 shadowRootType === "closed"：open 的已由页内探针 / NEXT_*_OPEN_FN 处理。
 * @param {any} describeResult
 * @returns {number[]}
 */
export const closedRootIds = (describeResult) => {
  const roots = describeResult?.node?.shadowRoots;
  if (!Array.isArray(roots)) return [];
  const out = [];
  for (const r of roots) {
    if (r && r.shadowRootType === "closed" && Number.isInteger(r.backendNodeId)) out.push(r.backendNodeId);
  }
  return out;
};

const callFn = async (tab, sid, group, objectId, functionDeclaration, args = [], byValue = false) => {
  const res = await tab.send(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: byValue, awaitPromise: false, silent: true, objectGroup: group },
    sid,
    5000,
  );
  if (res?.exceptionDetails) throw new Error("closed-shadow probe exception");
  return res?.result;
};

/** 某元素的 closed shadow root 对象引用（可能多个：理论上一个元素只有一个 shadow root，这里不假设） */
const closedRootObjects = async (tab, sid, group, objectId) => {
  const desc = await tab.send("DOM.describeNode", { objectId, depth: 1 }, sid, 5000);
  const ids = closedRootIds(desc);
  const out = [];
  for (const backendNodeId of ids) {
    const r = await tab.send("DOM.resolveNode", { backendNodeId, objectGroup: group }, sid, 5000);
    const objectId2 = r?.object?.objectId;
    if (!objectId2) throw new Error("closed root resolve failed");
    out.push(objectId2);
  }
  return out;
};

/**
 * R6-03 / R6-36：this 是不是框架类元素（iframe / frame / object / embed / fencedframe）。返回 true 表示「是，或读不出来」（fail-closed：读不出来按框架处理）。
 * 为什么需要：closed root 里的框架元素本身不是输入框，SECRET_ELEMENT_PROBE_SOURCE 对它只会给 false → 误判 safe，
 * 而它里面（跨域 / 沙箱 / closed 内读不进的同站 frame；`<object type=text/html>` / `<embed>` / `<fencedframe>` 同理）可能就是密码框。
 */
export const IS_FRAME_FN = `function () {
  ${FRAME_TAG_FN_SOURCE}
  try {
    return isFrameLikeTag(this.localName || this.tagName);
  } catch (e) { return true; }
}`;

/** 穿透内嵌框架的层数上限（R6-03）：超过就当「没探到最深处」→ unknown */
export const MAX_FRAME_DEPTH = 8;

const isFrameEl = async (tab, sid, group, objectId) => {
  const r = await callFn(tab, sid, group, objectId, IS_FRAME_FN, [], true);
  return r?.value !== false; // 只有明确返回 false 才算「不是框架」
};

const finalVerdict = async (tab, sid, group, objectId) => {
  const r = await callFn(tab, sid, group, objectId, SECRET_ELEMENT_PROBE_SOURCE, [], true);
  return r?.value === true ? "secret" : r?.value === false ? "safe" : "unknown";
};

const release = (tab, sid, group) => tab.send("Runtime.releaseObjectGroup", { objectGroup: group }, sid, 3000).catch(() => {});

/**
 * 焦点复核：当前真正拿到焦点的元素（穿透 open + closed shadow root / 同源 iframe）是不是敏感字段。
 * @param {any} tab 带 `send(method, params, sessionId, timeoutMs)` 的 tab（或同形假对象）
 * @param {{ backendNodeId: number, sessionId?: string|null } | null} entry 有 ref 时在该元素所在 frame 里查（OOPIF 也行），否则查主页面
 * @returns {Promise<"secret"|"safe"|"unknown">}
 */
export const probeFocusSecretCdp = async (tab, entry) => {
  const sid = entry?.sessionId ?? null;
  const group = newGroup();
  try {
    let cur;
    if (entry) {
      const r = await tab.send("DOM.resolveNode", { backendNodeId: entry.backendNodeId, objectGroup: group }, sid, 5000);
      const base = r?.object?.objectId;
      if (!base) return "unknown";
      cur = await callFn(tab, sid, group, base, DOC_ACTIVE_FN);
    } else {
      const r = await tab.send("Runtime.evaluate", { expression: "document.activeElement", returnByValue: false, silent: true, objectGroup: group }, null, 5000);
      cur = r?.result;
    }
    if (!isNodeRef(cur)) return "safe"; // 没有焦点元素：与页内探针同口径
    let frameHops = 0;
    for (let depth = 0; depth < MAX_SHADOW_DEPTH; depth++) {
      // R6-03 / R6-36：焦点元素是框架类元素（iframe / frame / object / embed / fencedframe）时，只有「同站且 contentDocument 读得进、里面有 activeElement」才能继续往里走；
      // 其余（跨域 / 沙箱 / closed root 里读不进的 frame；embed / fencedframe 没有 contentDocument）一律 unknown，绝不拿框架元素自己去判 safe（它不是输入框，必然 safe）。
      if (await isFrameEl(tab, sid, group, cur.objectId)) {
        if (++frameHops > MAX_FRAME_DEPTH) return "unknown";
        const inner = await callFn(tab, sid, group, cur.objectId, NEXT_FOCUS_OPEN_FN);
        if (isNodeRef(inner)) {
          cur = inner;
          continue;
        }
        return "unknown";
      }
      const nextOpen = await callFn(tab, sid, group, cur.objectId, NEXT_FOCUS_OPEN_FN);
      if (isNodeRef(nextOpen)) {
        cur = nextOpen;
        continue;
      }
      let moved = false;
      for (const rootObj of await closedRootObjects(tab, sid, group, cur.objectId)) {
        const act = await callFn(tab, sid, group, rootObj, ROOT_ACTIVE_FN);
        if (isNodeRef(act)) {
          cur = act;
          moved = true;
          break;
        }
      }
      if (!moved) return await finalVerdict(tab, sid, group, cur.objectId);
    }
    return "unknown"; // 层数耗尽：没探到最深处，宁可拒绝
  } catch {
    return "unknown";
  } finally {
    await release(tab, sid, group);
  }
};

// ───────────────────────── closed shadow 里的可见文字（wait_for text / read 补充） ─────────────────────────

/** getDocument 树的遍历预算：节点数 / 输出字符数，超了截断（只影响「能不能看见 closed 里的文字」，不影响安全判定） */
export const SHADOW_TEXT_MAX_NODES = 60_000;
export const SHADOW_TEXT_MAX_CHARS = 200_000;
/** 这些元素里的文字不采：脚本 / 样式 / 模板，以及表单控件（textarea 的默认内容、select 的选项）——与 read「表单控件值一概不读」同口径 */
const SHADOW_TEXT_SKIP = new Set(["script", "style", "noscript", "template", "textarea", "input", "select", "option", "iframe", "frame", "object", "embed"]);

/**
 * 从 `DOM.getDocument{depth:-1, pierce:true}` 的树里收集**位于 closed shadow root 内**的文字节点（纯函数，有单测）。
 * open root 里的文字页内脚本已经覆盖（`el.shadowRoot` 能读），这里不重复；open 套在 closed 里的算 closed 内。
 * 迭代栈而不是递归：病态深层嵌套不会爆调用栈；超预算就截断。
 * @param {any} root getDocument 返回的 root 节点
 * @returns {{ text: string, truncated: boolean }}
 */
export const closedShadowTextFromTree = (root, { maxNodes = SHADOW_TEXT_MAX_NODES, maxChars = SHADOW_TEXT_MAX_CHARS } = {}) => {
  const out = [];
  let chars = 0;
  let visited = 0;
  let truncated = false;
  const stack = [{ node: root, inClosed: false }];
  while (stack.length > 0) {
    const { node, inClosed } = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (++visited > maxNodes) {
      truncated = true;
      break;
    }
    if (node.nodeType === 3) {
      if (!inClosed) continue;
      const t = String(node.nodeValue ?? "").replace(/\s+/g, " ").trim();
      if (t === "") continue;
      if (chars + t.length > maxChars) {
        truncated = true;
        break;
      }
      chars += t.length + 1;
      out.push(t);
      continue;
    }
    if (node.nodeType === 1 && SHADOW_TEXT_SKIP.has(String(node.nodeName ?? "").toLowerCase())) continue;
    const next = [];
    if (Array.isArray(node.shadowRoots)) {
      for (const sr of node.shadowRoots) next.push({ node: sr, inClosed: inClosed || sr?.shadowRootType === "closed" });
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) next.push({ node: c, inClosed });
    }
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
  }
  return { text: out.join("\n"), truncated };
};

/**
 * 取主 frame 里 closed shadow root 内的文字（CDP 的 pierce 取整棵树；失败返回空串，不影响调用方）。
 * 注意这是**整树序列化**：大页面上比页内脚本贵，调用方要限频（tab.closedShadowText 带 1s 缓存），read 只在整页读取时调一次。
 * @param {any} tab
 * @returns {Promise<string>}
 */
export const collectClosedShadowText = async (tab) => {
  try {
    const r = await tab.send("DOM.getDocument", { depth: -1, pierce: true }, null, 15_000);
    return closedShadowTextFromTree(r?.root).text;
  } catch {
    return "";
  }
};