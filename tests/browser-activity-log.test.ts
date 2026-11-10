/**
 * 活动日志（electron-app/browser/activity-log.mjs）纯逻辑单测：契约 §4.4。
 * 覆盖合并 / 脱敏 / 滚动折叠 / 丢弃 / 环形溢出 / 游标 / summarize / URL 去 query / ai 丢弃 / 字符上限。
 */
import { describe, expect, it } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";

const TAB = "t1";
const URL_OK = "https://example.com/path/page?token=secret#frag";

function clickEvt(over: Record<string, unknown> = {}) {
  return {
    type: "click",
    ts: 1000,
    ai: false,
    url: URL_OK,
    frame: "main",
    tabId: TAB,
    target: { tag: "button", role: "button", name: "提交订单" },
    point: { x: 10, y: 20 },
    ...over,
  };
}

describe("ingest：点击与摘要", () => {
  it("点击按钮生成契约句式、URL 只留 origin+pathname、target 只留 role/name", () => {
    const log = createActivityLog();
    const e = log.ingest(clickEvt());
    expect(e).not.toBeNull();
    expect(e.actor).toBe("user");
    expect(e.kind).toBe("click");
    expect(e.summary).toBe("点击了按钮「提交订单」");
    expect(e.url).toBe("https://example.com/path/page");
    expect(e.target).toEqual({ role: "button", name: "提交订单" });
    expect(e.count).toBe(1);
  });

  it("双击 / 右键句式不同；无名称时只说控件类型", () => {
    const log = createActivityLog();
    expect(log.ingest(clickEvt({ type: "dblclick" })).summary).toBe("双击了按钮「提交订单」");
    expect(log.ingest(clickEvt({ type: "contextmenu" })).summary).toBe("右键点击了按钮「提交订单」");
    expect(
      log.ingest(clickEvt({ target: { tag: "div" } })).summary,
    ).toBe("点击了元素");
  });

  it("submit 与 select（下拉/复选/单选）句式", () => {
    const log = createActivityLog();
    expect(
      log.ingest({ type: "submit", ts: 1, tabId: TAB, url: URL_OK, target: { tag: "form", name: "搜索" } }).summary,
    ).toBe("提交了表单「搜索」");
    expect(
      log.ingest({ type: "select", ts: 2, tabId: TAB, url: URL_OK, target: { tag: "select", role: "combobox", name: "城市" } }).summary,
    ).toBe("选择了下拉框「城市」");
    expect(
      log.ingest({ type: "change", ts: 3, tabId: TAB, url: URL_OK, target: { tag: "input", inputType: "checkbox", role: "checkbox", name: "同意条款" } }).summary,
    ).toBe("切换了复选框「同意条款」");
  });
});

describe("输入合并与脱敏", () => {
  const inputEvt = (ts: number, over: Record<string, unknown> = {}) => ({
    type: "input",
    ts,
    ai: false,
    url: URL_OK,
    tabId: TAB,
    target: { tag: "input", role: "textbox", name: "手机号", inputType: "text", fieldName: "phone" },
    valueLength: 1,
    ...over,
  });

  it("同一目标 1.5 秒内连续输入合并：id 不变、count 递增、summary 按最新长度", () => {
    const log = createActivityLog();
    const a = log.ingest(inputEvt(1000, { valueLength: 1 }));
    const b = log.ingest(inputEvt(1800, { valueLength: 5 }));
    const c = log.ingest(inputEvt(2400, { valueLength: 11 }));
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(c.count).toBe(3);
    expect(c.summary).toBe("在文本框「手机号」输入了 11 个字符");
    expect(log.list()).toHaveLength(1);
  });

  it("超过 1.5 秒、换目标、换 tab 都不合并", () => {
    const log = createActivityLog();
    const a = log.ingest(inputEvt(1000, { valueLength: 1 }));
    const b = log.ingest(inputEvt(2600, { valueLength: 2 }));
    expect(b.id).not.toBe(a.id);
    const c = log.ingest(
      inputEvt(2700, { target: { tag: "input", role: "textbox", name: "验证码", fieldName: "code" }, valueLength: 1 }),
    );
    expect(c.id).not.toBe(b.id);
    const d = log.ingest(inputEvt(2800, { tabId: "t2", valueLength: 1 }));
    expect(d.id).not.toBe(c.id);
    expect(log.list()).toHaveLength(4);
  });

  it("中间插入别的事件后不再合并（只跟最后一条比）", () => {
    const log = createActivityLog();
    log.ingest(inputEvt(1000, { valueLength: 1 }));
    log.ingest(clickEvt({ ts: 1100 }));
    const after = log.ingest(inputEvt(1200, { valueLength: 2 }));
    expect(log.list()).toHaveLength(3);
    expect(after.count).toBe(1);
  });

  it("密码框永不记值：recordInputValues 开着、raw 带 value 也只记隐藏句式", () => {
    const log = createActivityLog({ recordInputValues: true });
    const e = log.ingest(
      inputEvt(1000, {
        target: { tag: "input", role: "textbox", name: "密码", inputType: "password", isPassword: true },
        value: "s3cret-PASSWORD",
        valueLength: 15,
      }),
    );
    expect(e.summary).toBe("在密码框「密码」中输入（内容已隐藏）");
    expect(JSON.stringify(log.list())).not.toContain("s3cret");
    // 光靠 inputType=password 也要拦（防御页内漏标 isPassword）
    const e2 = log.ingest(
      inputEvt(5000, {
        target: { tag: "input", role: "textbox", name: "密码", inputType: "password" },
        value: "hunter2",
        valueLength: 7,
      }),
    );
    expect(e2.summary).not.toContain("hunter2");
  });

  it("非密码框只有 recordInputValues=true 才带值；运行时开关只影响之后", () => {
    const log = createActivityLog();
    const a = log.ingest(inputEvt(1000, { value: "138", valueLength: 3 }));
    expect(a.summary).toBe("在文本框「手机号」输入了 3 个字符");
    log.setRecordInputValues(true);
    const b = log.ingest(inputEvt(5000, { value: "hello", valueLength: 5 }));
    expect(b.summary).toBe("在文本框「手机号」输入了「hello」");
    log.setRecordInputValues(false);
    const c = log.ingest(inputEvt(9000, { value: "world", valueLength: 5 }));
    expect(c.summary).toBe("在文本框「手机号」输入了 5 个字符");
  });
});

describe("滚动折叠 / 按键过滤 / 丢弃规则", () => {
  it("同一 tab 连续滚动折叠为一条、更新百分比；换 tab 不折叠", () => {
    const log = createActivityLog();
    const a = log.ingest({ type: "scroll", ts: 100, tabId: TAB, url: URL_OK, scroll: { x: 0, y: 100, ratio: 0.2 } });
    const b = log.ingest({ type: "scroll", ts: 200, tabId: TAB, url: URL_OK, scroll: { x: 0, y: 900, ratio: 0.624 } });
    expect(b.id).toBe(a.id);
    expect(b.count).toBe(2);
    expect(b.summary).toBe("滚动页面到约 62%");
    const c = log.ingest({ type: "scroll", ts: 300, tabId: "t2", url: URL_OK, scroll: { x: 0, y: 0, ratio: 0 } });
    expect(c.id).not.toBe(a.id);
    expect(log.list()).toHaveLength(2);
  });

  it("按键只记 Enter/Escape/Tab 与修饰键组合，普通字符键与 Shift+字母丢弃", () => {
    const log = createActivityLog();
    expect(log.ingest({ type: "key", ts: 1, tabId: TAB, url: URL_OK, key: "a" })).toBeNull();
    expect(log.ingest({ type: "key", ts: 2, tabId: TAB, url: URL_OK, key: "A", modifiers: ["Shift"] })).toBeNull();
    expect(log.ingest({ type: "key", ts: 3, tabId: TAB, url: URL_OK, key: "Enter" }).summary).toBe("按下了 Enter");
    expect(log.ingest({ type: "key", ts: 4, tabId: TAB, url: URL_OK, key: "Escape" }).summary).toBe("按下了 Escape");
    expect(
      log.ingest({ type: "key", ts: 5, tabId: TAB, url: URL_OK, key: "a", modifiers: ["Control"] }).summary,
    ).toBe("按下了 Control+a");
    expect(
      log.ingest({ type: "key", ts: 6, tabId: TAB, url: URL_OK, key: "Tab", modifiers: ["Shift"] }).summary,
    ).toBe("按下了 Shift+Tab");
  });

  it("focus / mousemove / 未知类型丢弃；ai:true 丢弃；坏数据丢弃", () => {
    const log = createActivityLog();
    expect(log.ingest({ type: "focus", ts: 1, tabId: TAB, url: URL_OK })).toBeNull();
    expect(log.ingest({ type: "mousemove", ts: 1, tabId: TAB, url: URL_OK })).toBeNull();
    expect(log.ingest({ type: "mouseover", ts: 1, tabId: TAB, url: URL_OK })).toBeNull();
    expect(log.ingest({ type: "whatever", ts: 1, tabId: TAB, url: URL_OK })).toBeNull();
    expect(log.ingest(clickEvt({ ai: true }))).toBeNull();
    expect(log.ingest(null)).toBeNull();
    expect(log.ingest("click")).toBeNull();
    expect(log.ingest({})).toBeNull();
    expect(log.list()).toHaveLength(0);
  });
});

describe("addAI / addSystem / 系统事件 ingest", () => {
  it("addAI actor=ai 且不算未读；addSystem 与 type:system ingest 都算未读", () => {
    const log = createActivityLog();
    const ai = log.addAI({ kind: "click", tabId: TAB, url: URL_OK, summary: "点击 按钮「登录」" });
    expect(ai.actor).toBe("ai");
    expect(ai.url).toBe("https://example.com/path/page");
    const sys = log.addSystem({ kind: "tab_open", tabId: TAB, url: URL_OK });
    expect(sys.actor).toBe("system");
    expect(sys.summary).toBe("打开了新标签页");
    const viaIngest = log.ingest({ type: "system", kind: "handback", tabId: TAB, url: URL_OK, summary: "交还了" });
    expect(viaIngest.actor).toBe("system");
    expect(log.pendingCount()).toBe(2);
    expect(log.unseenUserEntries().map((e) => e.id)).toEqual([sys.id, viaIngest.id]);
  });
});

describe("环形缓冲 / 游标 / 查询", () => {
  it("超过 max 丢最旧、id 仍单调递增", () => {
    const log = createActivityLog({ max: 3 });
    for (let i = 0; i < 5; i++) log.ingest(clickEvt({ ts: 1000 + i }));
    const all = log.list();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it("默认上限 500", () => {
    const log = createActivityLog();
    for (let i = 0; i < 520; i++) log.ingest(clickEvt({ ts: 1000 + i }));
    expect(log.list()).toHaveLength(500);
    expect(log.list()[0].id).toBe(21);
  });

  it("markSeen 推进游标、返回游标，之后新条目重新计数；游标不后退", () => {
    const log = createActivityLog();
    log.ingest(clickEvt({ ts: 1 }));
    log.addAI({ kind: "click", tabId: TAB, url: URL_OK, summary: "AI 点了" });
    log.addSystem({ kind: "load", tabId: TAB, url: URL_OK });
    expect(log.pendingCount()).toBe(2); // AI 条目不算
    const cursor = log.markSeen();
    expect(cursor).toBe(3);
    expect(log.pendingCount()).toBe(0);
    expect(log.markSeen()).toBe(3);
    log.ingest(clickEvt({ ts: 2 }));
    expect(log.pendingCount()).toBe(1);
    expect(log.unseenUserEntries()[0].kind).toBe("click");
  });

  it("list 支持 sinceId / actors / limit（取最近）", () => {
    const log = createActivityLog();
    log.ingest(clickEvt({ ts: 1 }));
    log.addAI({ kind: "click", tabId: TAB, url: URL_OK, summary: "AI" });
    log.ingest(clickEvt({ ts: 2 }));
    expect(log.list({ sinceId: 1 }).map((e) => e.id)).toEqual([2, 3]);
    expect(log.list({ actors: ["ai"] }).map((e) => e.id)).toEqual([2]);
    expect(log.list({ limit: 2 }).map((e) => e.id)).toEqual([2, 3]);
    expect(log.list({ limit: 0 })).toEqual([]);
    expect(log.recent(2).map((e) => e.id)).toEqual([2, 3]);
    expect(log.recent()).toHaveLength(3);
  });

  it("clear 清空条目与游标、id 重新从 1 开始", () => {
    const log = createActivityLog();
    log.ingest(clickEvt());
    log.markSeen();
    log.clear();
    expect(log.list()).toEqual([]);
    expect(log.pendingCount()).toBe(0);
    expect(log.ingest(clickEvt()).id).toBe(1);
  });
});

describe("summarize 与字符上限", () => {
  it("每条一行、以「· 」开头；空数组给空串", () => {
    const log = createActivityLog();
    log.ingest(clickEvt());
    log.ingest({ type: "scroll", ts: 1, tabId: TAB, url: URL_OK, scroll: { x: 0, y: 1, ratio: 0.5 } });
    expect(log.summarize(log.list())).toBe("· 点击了按钮「提交订单」\n· 滚动页面到约 50%");
    expect(log.summarize([])).toBe("");
  });

  it("summary 单条 ≤160：超长名称/值被截断且以 … 收尾", () => {
    const log = createActivityLog({ recordInputValues: true });
    const longName = "名".repeat(200);
    const e = log.ingest(clickEvt({ target: { tag: "button", role: "button", name: longName } }));
    expect(e.summary.length).toBeLessThanOrEqual(160);
    const v = log.ingest({
      type: "input",
      ts: 1,
      tabId: TAB,
      url: URL_OK,
      target: { tag: "input", role: "textbox", name: "备注" },
      value: "长".repeat(400),
      valueLength: 400,
    });
    expect(v.summary.length).toBeLessThanOrEqual(160);
    expect(v.summary.endsWith("…")).toBe(true);
    const ai = log.addAI({ kind: "click", tabId: TAB, url: URL_OK, summary: "x".repeat(500) });
    expect(ai.summary.length).toBeLessThanOrEqual(160);
  });

  it("URL 清洗：无 query/hash、about:blank 保留、坏 URL 粗暴切 query", () => {
    const log = createActivityLog();
    expect(log.addSystem({ kind: "load", tabId: TAB, url: "about:blank" }).url).toBe("about:blank");
    expect(log.addSystem({ kind: "load", tabId: TAB, url: "https://a.cn/p?q=1#f" }).url).toBe("https://a.cn/p");
    expect(log.addSystem({ kind: "load", tabId: TAB, url: "not a url?token=1" }).url).toBe("not a url");
    expect(log.addSystem({ kind: "load", tabId: TAB, url: "" }).url).toBe("");
  });
});

// ───────────────────────── R1-03：按键事件不得泄漏字符 / 敏感目标整条丢弃 ─────────────────────────

describe("R1-03 key 事件：敏感目标丢弃、Alt / AltGr / 单字符不带字符", () => {
  const keyEvt = (key: string, modifiers: string[] | undefined, target: Record<string, unknown> | undefined, ts = 1) => ({
    type: "key",
    ts,
    tabId: TAB,
    url: URL_OK,
    key,
    ...(modifiers ? { modifiers } : {}),
    ...(target ? { target } : {}),
  });
  const PWD = { tag: "input", role: "textbox", name: "密码", inputType: "password", isPassword: true };

  it.each([
    ["recordInputValues 关闭", false],
    ["recordInputValues 开启", true],
  ])("密码目标 + Alt+@（德语 Mac 的 Option 输入）不产生条目——%s", (_label, recordInputValues) => {
    const log = createActivityLog({ recordInputValues });
    expect(log.ingest(keyEvt("@", ["Alt"], PWD))).toBeNull();
    expect(log.ingest(keyEvt("|", ["Alt"], PWD, 2))).toBeNull();
    // Windows 的 AltGr = Ctrl+Alt（页内标 AltGraph / 或 Control+Alt 同时出现）
    expect(log.ingest(keyEvt("€", ["Control", "Alt"], PWD, 3))).toBeNull();
    expect(log.ingest(keyEvt("{", ["AltGraph"], PWD, 4))).toBeNull();
    expect(log.list()).toEqual([]);
  });

  it("敏感目标上连 Enter / Tab / Ctrl+a 这类白名单键也整条丢弃（不留「在密码框里按过什么」的痕迹）", () => {
    const log = createActivityLog({ recordInputValues: true });
    expect(log.ingest(keyEvt("Enter", undefined, PWD))).toBeNull();
    expect(log.ingest(keyEvt("Tab", undefined, PWD, 2))).toBeNull();
    expect(log.ingest(keyEvt("a", ["Control"], PWD, 3))).toBeNull();
    expect(log.list()).toEqual([]);
  });

  it.each([
    ["inputType=password", { inputType: "password" }],
    ["autocomplete=one-time-code", { inputType: "text", autocomplete: "one-time-code" }],
    ["autocomplete=cc-number", { inputType: "text", autocomplete: "cc-number" }],
    ["autocomplete=cc-exp（R1-25：cc-* 全家）", { inputType: "text", autocomplete: "cc-exp" }],
    ["autocomplete=section-x new-password", { inputType: "text", autocomplete: "section-x new-password" }],
    ["-webkit-text-security: disc（R1-25）", { inputType: "text", textSecurity: "disc" }],
  ])("敏感判定覆盖 %s：key 丢弃，且 input 摘要不带值", (_label, extra) => {
    const log = createActivityLog({ recordInputValues: true });
    const target = { tag: "input", role: "textbox", name: "字段", ...extra };
    expect(log.ingest(keyEvt("Enter", undefined, target))).toBeNull();
    const e = log.ingest({ type: "input", ts: 5, tabId: TAB, url: URL_OK, target, value: "SECRET-VALUE", valueLength: 12 });
    expect(e.summary).toBe("在密码框「字段」中输入（内容已隐藏）");
    expect(JSON.stringify(log.list())).not.toContain("SECRET-VALUE");
  });

  it("非敏感目标：Alt / AltGr 组合与单字符键一律不带字符，recordInputValues 开着也一样", () => {
    for (const recordInputValues of [false, true]) {
      const log = createActivityLog({ recordInputValues });
      const text = { tag: "input", role: "textbox", name: "备注", inputType: "text" };
      expect(log.ingest(keyEvt("@", ["Alt"], text))).toBeNull();
      expect(log.ingest(keyEvt("@", ["Control", "Alt"], text, 2))).toBeNull();
      expect(log.ingest(keyEvt("@", ["AltGraph"], text, 3))).toBeNull();
      expect(log.ingest(keyEvt("l", ["Alt", "Shift"], text, 4))).toBeNull();
      expect(log.ingest(keyEvt("x", undefined, text, 5))).toBeNull();
      expect(log.ingest(keyEvt("X", ["Shift"], text, 6))).toBeNull();
      expect(log.ingest(keyEvt("@", ["Shift"], text, 7))).toBeNull();
      expect(log.list()).toEqual([]);
    }
  });

  it("白名单：Enter / Escape / Tab（可带 Shift）与 Ctrl|Meta+字母；Ctrl+符号 / Ctrl+数字 / 方向键不记", () => {
    const log = createActivityLog();
    const text = { tag: "input", role: "textbox", name: "备注", inputType: "text" };
    expect(log.ingest(keyEvt("Enter", undefined, text))?.summary).toBe("按下了 Enter");
    expect(log.ingest(keyEvt("Escape", undefined, text, 2))?.summary).toBe("按下了 Escape");
    expect(log.ingest(keyEvt("Tab", ["Shift"], text, 3))?.summary).toBe("按下了 Shift+Tab");
    expect(log.ingest(keyEvt("c", ["Meta"], text, 4))?.summary).toBe("按下了 Meta+c");
    expect(log.ingest(keyEvt("a", ["Control"], text, 5))?.summary).toBe("按下了 Control+a");
    expect(log.ingest(keyEvt("Z", ["Control", "Shift"], text, 6))?.summary).toBe("按下了 Control+Shift+Z");
    expect(log.ingest(keyEvt("@", ["Control"], text, 7))).toBeNull();
    expect(log.ingest(keyEvt("1", ["Meta"], text, 8))).toBeNull();
    expect(log.ingest(keyEvt("ArrowDown", undefined, text, 9))).toBeNull();
    expect(log.ingest(keyEvt("ArrowDown", ["Shift"], text, 10))).toBeNull();
    expect(log.list()).toHaveLength(6);
  });
});
