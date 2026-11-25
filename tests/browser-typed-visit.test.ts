/**
 * 「用户敲的网址有没有成功打开」的判定（src/components/browser/typed-visit.ts）。
 * 每个用例对应真机（Electron 42）实测过的一种导航结果下渲染侧能看到的标签状态：
 *   打开了 / 404 → url=敲的地址、loading=false；重定向 → url=最终地址；
 *   打不开（连接被拒）→ url **仍是敲的地址**（不是 chrome-error://）、loading=false、loadFailed=true；
 *   下载 / 被拦 → url 没变；页面挂着一个永远不返回的子资源 → 新页面已提交、loading 一直 true。
 */
import { describe, expect, it } from "vitest";

import {
  decideTypedVisit,
  nextTypedVisitCheckAt,
  TYPED_VISIT_LOADING_GRACE_MS,
  TYPED_VISIT_TTL_MS,
  type PendingTypedVisit,
  type TypedVisitVerdict,
} from "@/components/browser/typed-visit";
import type { TabInfo } from "@/lib/browser-bridge-types";

const T0 = 1_000_000;
const START = "https://start.example/home";
const TYPED = "https://example.com/a";

const pend = (over: Partial<PendingTypedVisit> = {}): PendingTypedVisit => ({ url: TYPED, tabId: "t1", startUrl: START, startedAt: T0, ...over });
const tab = (over: Partial<TabInfo> = {}): TabInfo => ({
  id: "t1",
  url: START,
  title: "",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true,
  ...over,
});
const decide = (pending: PendingTypedVisit, tabs: TabInfo[], dt = 100): TypedVisitVerdict => decideTypedVisit(pending, tabs, T0 + dt);
const record = (title = "", url = TYPED): TypedVisitVerdict => ({ action: "record", url, title });
const drop = (reason: string) => ({ action: "drop", reason });
const WAIT = { action: "wait" };

describe("打开了：记下用户敲的地址", () => {
  it("url = 敲的地址、loading=false → 记，标题取页面标题", () => {
    expect(decide(pend(), [tab({ url: TYPED, title: "Example A" })])).toEqual(record("Example A"));
  });

  it("HTTP 404 / 500 页面也是「打开了」（没有 loadFailed）：Chrome 同样会记", () => {
    expect(decide(pend(), [tab({ url: TYPED, title: "Not Found Title" })])).toEqual(record("Not Found Title"));
  });

  it("重定向到同站（http→https、加 www）：记的是用户敲的地址，标题保留（标题属于同一个站）", () => {
    const p = pend({ url: "http://github.com/" });
    expect(decide(p, [tab({ url: "https://www.github.com/", title: "GitHub" })])).toEqual(record("GitHub", "http://github.com/"));
  });

  it("重定向到别的站（短链 → 目标站）：仍记用户敲的地址，但目标站的标题不记（标题留空，联想里显示主机名）", () => {
    const p = pend({ url: "https://t.co/xyz" });
    expect(decide(p, [tab({ url: "https://twitter.com/someone", title: "Someone / X" })])).toEqual(record("", "https://t.co/xyz"));
  });

  it("页面没有 <title>：webContents 给的是「去掉协议的 URL」，那不是标题，不记", () => {
    expect(decide(pend({ url: "http://127.0.0.1:8080/page" }), [tab({ url: "http://127.0.0.1:8080/page", title: "127.0.0.1:8080/page" })])).toEqual(
      record("", "http://127.0.0.1:8080/page"),
    );
    expect(decide(pend({ url: "http://127.0.0.1:8080/" }), [tab({ url: "http://127.0.0.1:8080/", title: "127.0.0.1:8080" })])).toEqual(record("", "http://127.0.0.1:8080/"));
    expect(decide(pend({ url: "https://Example.COM/" }), [tab({ url: "https://example.com/", title: "EXAMPLE.com" })])).toEqual(record("", "https://Example.COM/"));
  });

  it("标题首尾空白去掉；全是空白 = 没有标题", () => {
    expect(decide(pend(), [tab({ url: TYPED, title: "  Hi  " })])).toEqual(record("Hi"));
    expect(decide(pend(), [tab({ url: TYPED, title: "   " })])).toEqual(record(""));
  });

  it("只改了 #hash 的地址（同文档导航）：标签地址带上 #hash 就算打开", () => {
    const p = pend({ url: "https://example.com/p#frag", startUrl: "https://example.com/p" });
    expect(decide(p, [tab({ url: "https://example.com/p#frag", title: "P" })])).toEqual(record("P", "https://example.com/p#frag"));
  });
});

describe("打不开：不记", () => {
  it("连接被拒 / DNS 失败：url 仍是敲的地址、loading=false，但 loadFailed=true → 放弃", () => {
    expect(decide(pend(), [tab({ url: TYPED, title: "example.com", loadFailed: true })])).toEqual(drop("failed"));
  });

  it("失败页提交时 loading 可能还没落回 false：已经 loadFailed 就不必再等", () => {
    expect(decide(pend(), [tab({ url: TYPED, loading: true, loadFailed: true })])).toEqual(drop("failed"));
  });

  it("没有 loadFailed 的老壳 / 老状态也不会误记：url 没变就是等", () => {
    expect(decide(pend(), [tab({ url: START })])).toEqual(WAIT);
  });
});

describe("还没看出结果：等；等太久作废", () => {
  it("状态推送还没带上导航（标签仍显示出发地址）→ 等", () => {
    expect(decide(pend(), [tab({ url: START, loading: false })])).toEqual(WAIT);
    expect(decide(pend(), [tab({ url: START, loading: true })])).toEqual(WAIT);
  });

  it("变成下载 / 被 URL 策略拦下（标签地址一直是出发地址）→ 一直等，到期作废、不记", () => {
    expect(decide(pend(), [tab({ url: START })], TYPED_VISIT_TTL_MS)).toEqual(WAIT); // 恰好 TTL 还没过期
    expect(decide(pend(), [tab({ url: START })], TYPED_VISIT_TTL_MS + 1)).toEqual(drop("expired"));
  });

  it("过期优先于一切：到期后即使状态看起来成功了也不记（太久之前的敲击，页面可能早被别的操作换掉）", () => {
    expect(decide(pend(), [tab({ url: TYPED, title: "x" })], TYPED_VISIT_TTL_MS + 1)).toEqual(drop("expired"));
  });

  it("新页面已提交但还在加载：等；加载完再记", () => {
    expect(decide(pend(), [tab({ url: TYPED, loading: true, title: "T" })])).toEqual(WAIT);
    expect(decide(pend(), [tab({ url: TYPED, loading: false, title: "T" })])).toEqual(record("T"));
  });

  it("页面里有个永远不返回的子资源（loading 一直 true）：新页面提交后超过宽限就按已打开算", () => {
    const t = tab({ url: TYPED, loading: true, title: "Hang Title" });
    expect(decide(pend(), [t], TYPED_VISIT_LOADING_GRACE_MS - 1)).toEqual(WAIT);
    expect(decide(pend(), [t], TYPED_VISIT_LOADING_GRACE_MS)).toEqual(record("Hang Title"));
  });

  it("宽限只对「已离开出发地」的页面生效：url 没变就算 loading 很久也不记（那可能是挂住的下载 / 请求）", () => {
    expect(decide(pend(), [tab({ url: START, loading: true })], TYPED_VISIT_LOADING_GRACE_MS + 5000)).toEqual(WAIT);
  });

  it("宽限不会放过失败页：loadFailed 照样放弃", () => {
    expect(decide(pend(), [tab({ url: TYPED, loading: true, loadFailed: true })], TYPED_VISIT_LOADING_GRACE_MS + 1)).toEqual(drop("failed"));
  });
});

describe("跳到了非网页地址：放弃", () => {
  it.each(["chrome-error://chromewebdata/", "file:///etc/hosts", "about:srcdoc", "data:text/html,hi", "javascript:void(0)"])("%s → not-web", (url) => {
    expect(decide(pend(), [tab({ url })])).toEqual(drop("not-web"));
  });

  it("空白页不算「离开了出发地」：等（会话刚建时标签显示的就是 about:blank / 空串）", () => {
    expect(decide(pend({ startUrl: "" }), [tab({ url: "about:blank" })])).toEqual(WAIT);
    expect(decide(pend({ startUrl: "" }), [tab({ url: "" })])).toEqual(WAIT);
    expect(decide(pend({ startUrl: "https://x.example/" }), [tab({ url: "about:blank" })])).toEqual(WAIT); // 被后置拦截退回空白页：不记，等到期
  });
});

describe("出发地是空白页 / 未知（新会话、新标签）", () => {
  it("出发地址 about:blank：敲的网址打开后记", () => {
    expect(decide(pend({ startUrl: "about:blank" }), [tab({ url: TYPED, title: "A" })])).toEqual(record("A"));
  });

  it("出发地址未知（提交时会话还没有标签：tabId=null、startUrl=''）：按「此刻的活动标签」判断", () => {
    const p = pend({ tabId: null, startUrl: "" });
    expect(decide(p, [tab({ id: "t1", url: "about:blank" })])).toEqual(WAIT);
    expect(decide(p, [tab({ id: "t1", url: TYPED, title: "A" })])).toEqual(record("A"));
    expect(decide(p, [tab({ id: "t1", isActive: false, url: TYPED }), tab({ id: "t2", isActive: true, url: "about:blank" })])).toEqual(WAIT);
  });

  it("tabId=null 且一个活动标签都没有 → 标签没了，放弃", () => {
    expect(decide(pend({ tabId: null }), [tab({ isActive: false })])).toEqual(drop("gone"));
    expect(decide(pend({ tabId: null }), [])).toEqual(drop("gone"));
  });
});

describe("盯的是提交时的那个标签，不是此刻的活动标签", () => {
  it("提交后用户切到了别的标签：照样盯着原来的标签", () => {
    const tabs = [tab({ id: "t1", isActive: false, url: TYPED, title: "A" }), tab({ id: "t2", isActive: true, url: "https://other.example/" })];
    expect(decide(pend({ tabId: "t1" }), tabs)).toEqual(record("A"));
  });

  it("原来的标签关了 → 放弃", () => {
    expect(decide(pend({ tabId: "t1" }), [tab({ id: "t2" })])).toEqual(drop("gone"));
    expect(decide(pend({ tabId: "t1" }), [])).toEqual(drop("gone"));
  });
});

describe("无痕标签：一律不记", () => {
  it("无痕标签里敲的网址：放弃（即使打开了）", () => {
    expect(decide(pend(), [tab({ url: TYPED, title: "A", incognito: true })])).toEqual(drop("incognito"));
    expect(decide(pend(), [tab({ url: START, incognito: true })])).toEqual(drop("incognito"));
  });

  it("incognito: false 等同普通标签", () => {
    expect(decide(pend(), [tab({ url: TYPED, title: "A", incognito: false })])).toEqual(record("A"));
  });
});

describe("重敲当前页的地址（回车 = 重新加载）：出发地址 = 敲的地址", () => {
  const same = (over: Partial<PendingTypedVisit> = {}) => pend({ startUrl: TYPED, ...over });

  it("页面已在、没失败、没在加载 → 记（不必等地址变化）", () => {
    expect(decide(same(), [tab({ url: TYPED, title: "A" })])).toEqual(record("A"));
  });

  it("重新加载在途 → 等；加载完 → 记", () => {
    expect(decide(same(), [tab({ url: TYPED, loading: true, title: "A" })])).toEqual(WAIT);
    expect(decide(same(), [tab({ url: TYPED, loading: false, title: "A" })])).toEqual(record("A"));
  });

  it("重新加载一直挂着：超过宽限按已打开算（页面之前就是打开着的）", () => {
    expect(decide(same(), [tab({ url: TYPED, loading: true, title: "A" })], TYPED_VISIT_LOADING_GRACE_MS)).toEqual(record("A"));
  });

  it("标签显示的是上一次失败留下的错误页（loadFailed）：不能立刻放弃——可能是残留，新一轮加载还没开始；只能等", () => {
    expect(decide(same(), [tab({ url: TYPED, loadFailed: true })])).toEqual(WAIT);
  });

  it("重敲一个刚才失败的地址，这回打开了：先看到残留的失败态（等），再看到成功态 → 记", () => {
    const p = same();
    expect(decide(p, [tab({ url: TYPED, loadFailed: true })], 10)).toEqual(WAIT);
    expect(decide(p, [tab({ url: TYPED, loadFailed: true, loading: true })], 30)).toEqual(WAIT);
    expect(decide(p, [tab({ url: TYPED, title: "Back Online" })], 200)).toEqual(record("Back Online"));
  });

  it("重敲一个失败的地址，这回又失败了：一直是失败态 → 到期作废、不记", () => {
    const p = same();
    expect(decide(p, [tab({ url: TYPED, loadFailed: true })], 200)).toEqual(WAIT);
    expect(decide(p, [tab({ url: TYPED, loadFailed: true })], TYPED_VISIT_TTL_MS + 1)).toEqual(drop("expired"));
  });

  it("地址比较按规整后的口径：大小写 / 默认端口不同也算同一个地址", () => {
    const p = pend({ url: "https://EXAMPLE.com:443/a", startUrl: "https://example.com/a" });
    expect(decide(p, [tab({ url: "https://example.com/a", title: "A" })])).toEqual(record("A", "https://EXAMPLE.com:443/a"));
  });
});

describe("从出发地出来后的失败：再重敲别的地址", () => {
  it("在失败页上敲别的地址：失败页的 loadFailed 残留不影响新地址——新页面打开了（地址变了）就记", () => {
    // 出发地 = 失败页（url=X, loadFailed）；敲 TYPED
    const p = pend({ startUrl: "https://dead.example/" });
    expect(decide(p, [tab({ url: "https://dead.example/", loadFailed: true })])).toEqual(WAIT);
    expect(decide(p, [tab({ url: TYPED, title: "A" })])).toEqual(record("A"));
  });

  it("在失败页上敲别的地址、这个也失败了：地址变了且 loadFailed → 放弃", () => {
    const p = pend({ startUrl: "https://dead.example/" });
    expect(decide(p, [tab({ url: TYPED, loadFailed: true })])).toEqual(drop("failed"));
  });
});

describe("入参不被改动 / 防御", () => {
  it("不改入参", () => {
    const p = pend();
    const tabs = [tab({ url: TYPED, title: "A" })];
    const before = JSON.stringify({ p, tabs });
    decide(p, tabs);
    expect(JSON.stringify({ p, tabs })).toBe(before);
  });

  it("待判定的地址本身不是网页（理论上主进程已过策略）→ not-web，不记", () => {
    expect(decide(pend({ url: "javascript:alert(1)" }), [tab({ url: TYPED })])).toEqual(drop("not-web"));
    expect(decide(pend({ url: "about:blank" }), [tab({ url: TYPED })])).toEqual(drop("not-web"));
  });
});

describe("nextTypedVisitCheckAt：光靠时间流逝，判定下一次可能变化的时刻", () => {
  it("刚提交：先到宽限、再到 TTL（只给最近的那个）", () => {
    expect(nextTypedVisitCheckAt(pend(), T0)).toBe(T0 + TYPED_VISIT_LOADING_GRACE_MS);
    expect(nextTypedVisitCheckAt(pend(), T0 + 1)).toBe(T0 + TYPED_VISIT_LOADING_GRACE_MS);
  });

  it("过了宽限：下一个是 TTL 到期（TTL 判的是「严格超过」，所以是 +1ms）", () => {
    expect(nextTypedVisitCheckAt(pend(), T0 + TYPED_VISIT_LOADING_GRACE_MS)).toBe(T0 + TYPED_VISIT_TTL_MS + 1);
    expect(nextTypedVisitCheckAt(pend(), T0 + TYPED_VISIT_TTL_MS)).toBe(T0 + TYPED_VISIT_TTL_MS + 1);
  });

  it("两个时刻都过了：之后光靠时间不会再变 → null", () => {
    expect(nextTypedVisitCheckAt(pend(), T0 + TYPED_VISIT_TTL_MS + 1)).toBeNull();
    expect(nextTypedVisitCheckAt(pend(), T0 + TYPED_VISIT_TTL_MS + 10_000)).toBeNull();
  });

  it("和判定本身对得上：给出的时刻到了，结论确实会变（挂着子资源的新页面 → 到宽限就算打开了 → 到 TTL 作废）", () => {
    const p = pend();
    const tabs = [tab({ url: TYPED, title: "Slow", loading: true })];
    const grace = nextTypedVisitCheckAt(p, T0)!;
    expect(decideTypedVisit(p, tabs, grace - 1)).toEqual(WAIT);
    expect(decideTypedVisit(p, tabs, grace)).toEqual(record("Slow"));

    // 一直在等的（出发地没变、也不是敲的地址）：到了 TTL 那一刻才作废
    const stuck = [tab({ url: START })];
    const ttl = nextTypedVisitCheckAt(p, grace)!;
    expect(decideTypedVisit(p, stuck, ttl - 1)).toEqual(WAIT);
    expect(decideTypedVisit(p, stuck, ttl)).toEqual(drop("expired"));
  });
});
