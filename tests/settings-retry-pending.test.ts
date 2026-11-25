/**
 * R20-11：设置保存首次失败、正在自动重试的那段时间（约 40 秒），浮顶栏里挂一条常驻提示
 * （src/lib/settings-retry-pending.ts + src/hooks/use-settings.ts + src/app/settings/page.tsx）。
 *
 * 背景：saveFieldValue 乐观更新——开关一点界面就显示新值；5xx / 断网时首次保存失败，按 2 / 8 / 30 秒退避重试，这段时间界面是新值、磁盘是旧值。
 * 对「收紧」方向的开关这是误导（以为已收紧、实际还放着），原来只有一条几秒后消失的 toast。
 * 决定：页面级常驻提示，列出还没存进去的字段，重试成功 / 被拒 / 放弃 / 又被改 / 又发起新保存时才消失；对所有字段一视同仁。
 *
 * 三层：① 纯函数（集合增减 / 文案 / 标签表覆盖）；② use-settings.ts 的接线（五个出口都清、失败时才标、卸载后不 setState）；③ page.tsx 的挂载位置（浮顶栏里）。
 * 看不到真实的 React 重渲染（没有 jsdom 渲染 hook）；真 UI 要在 Electron 里手点（让 PUT /api/settings 一直回 500，看浮顶栏出现 / 重试成功后消失）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  describeRetryPending,
  RETRY_WINDOW_NOTE,
  SETTING_FIELD_LABELS,
  withRetryPending,
} from "@/lib/settings-retry-pending";
import { DEFAULT_RETRY_DELAYS_MS } from "@/lib/save-retry";

describe("withRetryPending：集合增减", () => {
  it("加入 / 移出；状态没变时返回同一个引用（setState 据此跳过重渲染）；不改入参", () => {
    const empty: ReadonlySet<string> = new Set();
    const a = withRetryPending(empty, "feishuGroupNonOwnerGuard", true);
    expect([...a]).toEqual(["feishuGroupNonOwnerGuard"]);
    expect(empty.size).toBe(0); // 入参不被改
    expect(withRetryPending(a, "feishuGroupNonOwnerGuard", true)).toBe(a); // 已在 → 同一个引用
    const b = withRetryPending(a, "computerUse", true);
    expect([...b].sort()).toEqual(["computerUse", "feishuGroupNonOwnerGuard"]);
    const c = withRetryPending(b, "feishuGroupNonOwnerGuard", false);
    expect([...c]).toEqual(["computerUse"]);
    expect(b.has("feishuGroupNonOwnerGuard")).toBe(true); // 入参不被改
    expect(withRetryPending(empty, "x", false)).toBe(empty); // 本来就不在 → 同一个引用
  });
});

describe("describeRetryPending：浮顶栏文案", () => {
  it("没有待重试字段 → null（不渲染）", () => {
    expect(describeRetryPending(new Set())).toBeNull();
  });

  it("点名字段（用设置页上的标签）、说清「界面是新值、实际生效的仍是旧值」与最长等多久", () => {
    const r = describeRetryPending(new Set(["feishuGroupNonOwnerGuard"]))!;
    expect(r.headline).toBe("「限制群里非宿主成员」还没存进去，正在自动重试");
    expect(r.detail).toContain("界面上是你刚改的值，实际生效的仍是旧值");
    expect(r.detail).toContain(RETRY_WINDOW_NOTE);
    expect(r.detail).toContain("成功后这条提示自动消失");
  });

  it("超过 3 项折成「等 N 项」；未知字段退回原始 key（不抛）", () => {
    const four = describeRetryPending(new Set(["computerUse", "browserEvaluateEnabled", "browserStorageAccess", "browserPagePermissions"]))!;
    expect(four.headline).toBe("「电脑操作」「允许 AI 执行页面脚本」「允许 AI 读写登录态」 等 4 项还没存进去，正在自动重试");
    expect(describeRetryPending(new Set(["someFutureField"]))!.headline).toBe("「someFutureField」还没存进去，正在自动重试");
  });

  it("「最多约 40 秒」与 save-retry 的退避总和一致（2 + 8 + 30 秒）——退避表改了，这句话要跟着改", () => {
    const total = DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe(40_000);
    expect(RETRY_WINDOW_NOTE).toBe("最多约 40 秒");
  });
});

const ROOT = path.resolve(import.meta.dirname, "..");
const hookSrc = readFileSync(path.join(ROOT, "src/hooks/use-settings.ts"), "utf8");
const pageSrc = readFileSync(path.join(ROOT, "src/app/settings/page.tsx"), "utf8");

/** use-settings.ts 的 FIELD_EQ_KIND 的字段名 */
const fieldKeys = ((): string[] => {
  const body = /const FIELD_EQ_KIND = \{([\s\S]*?)\} as const satisfies/.exec(hookSrc)?.[1];
  expect(body, "找不到 FIELD_EQ_KIND（表的写法变了？）").toBeTruthy();
  return [...body!.matchAll(/^\s*(\w+):\s*"(\w+)",?\s*$/gm)].map((m) => m[1]!);
})();

describe("标签表覆盖每个设置字段（编译期 satisfies + 运行期对账）", () => {
  it("SETTING_FIELD_LABELS 的键 = FIELD_EQ_KIND 的键，标签都非空", () => {
    expect(Object.keys(SETTING_FIELD_LABELS).sort()).toEqual([...fieldKeys].sort());
    for (const [k, v] of Object.entries(SETTING_FIELD_LABELS)) expect(v.trim().length, k).toBeGreaterThan(0);
  });
});

// ─────────────── use-settings.ts 接线 ───────────────

const sf = ts.createSourceFile("use-settings.ts", hookSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const propsNamed = (name: string): string[] => {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === name) out.push(n.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};

describe("use-settings.ts：常驻提示的集合由五个出口维护", () => {
  it("markRetryPending 是稳定的 useCallback（空依赖），卸载后不 setState", () => {
    const m = /const markRetryPending = useCallback\(([\s\S]*?)\n  \}, \[\]\);/.exec(hookSrc);
    expect(m, "markRetryPending 不是「useCallback(…, [])」的写法（依赖变了会让惰性创建的重试器闭包拿到旧函数）").toBeTruthy();
    expect(m![1]).toContain("if (!mountedRef.current) return;");
    expect(m![1]).toContain("setRetryPending((prev) => withRetryPending(prev, key, pending))");
  });

  it("首次保存失败（确实会重试）时才标上：saveFieldValue 的 onFailed 里 markRetryPending(key, true)；被拒的 onRejected 不标", () => {
    const failed = propsNamed("onFailed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("markRetryPending(key, true)");
    for (const p of propsNamed("onRejected")) expect(p, p).not.toContain("markRetryPending(key, true)");
    for (const p of propsNamed("onRecovered")) expect(p, p).not.toContain("markRetryPending(key, true)");
  });

  it("重试器的三个出口（成功 / 放弃 / 被拒）都用它收到的 key 清掉", () => {
    const recovered = propsNamed("onRecovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatch(/onRecovered:\s*\(key\)\s*=>/);
    expect(recovered[0]).toContain("markRetryPending(key, false)");
    const giveUp = propsNamed("onGiveUp");
    expect(giveUp).toHaveLength(1);
    expect(giveUp[0]).toContain("markRetryPending(key, false)");
    const retrierRejected = propsNamed("onRejected").find((p) => /onRejected:\s*\(key,\s*status\)/.test(p));
    expect(retrierRejected, "找不到重试器的 onRejected").toBeTruthy();
    expect(retrierRejected).toContain("markRetryPending(key, false)");
  });

  it("新的保存取代旧的待重试：saveFieldValue 在 canPersistSettings 之后、saveWithRetry 之前先清掉；草稿被改（update）也清", () => {
    const from = hookSrc.indexOf("const saveFieldValue = ");
    expect(from).toBeGreaterThan(-1);
    const body = hookSrc.slice(from, hookSrc.indexOf("// 离页前拦截", from));
    const guard = body.indexOf("canPersistSettings(");
    const clear = body.indexOf("markRetryPending(key, false);");
    const call = body.indexOf("saveWithRetry({");
    expect(guard).toBeGreaterThan(-1);
    expect(clear, "saveFieldValue 里没有「开始时清」").toBeGreaterThan(guard);
    expect(call).toBeGreaterThan(clear);
    const updAt = hookSrc.indexOf("const update = ");
    expect(updAt).toBeGreaterThan(-1);
    const upd = hookSrc.slice(updAt, hookSrc.indexOf("// 即时存某字段的指定值", updAt));
    expect(upd).toContain("retrierRef.current?.dropPending(key);");
    expect(upd).toContain("markRetryPending(key, false);");
  });

  it("hook 把 retryPending 交出去（类型 + 返回值）", () => {
    expect(hookSrc).toMatch(/retryPending: ReadonlySet<string>;/);
    expect(hookSrc).toMatch(/hasUnsaved,\s*retryPending,\s*update,\s*saveFieldValue,\s*\};/);
  });
});

// ─────────────── page.tsx 挂载位置 ───────────────

describe("page.tsx：提示挂在浮顶栏里（滚到哪都看得见）", () => {
  it("从 useSettings 取 retryPending、用 describeRetryPending 生成文案", () => {
    // dirty 紧跟在 retryPending 之后：第二十轮 R20-15 起页面还要它来判断「飞书桥开关是否已落盘」（见 feishu-bridge-block-refresh.test.ts）
    expect(pageSrc).toMatch(/retryPending,\s*dirty,\s*update,\s*saveFieldValue,\s*\} = useSettings\(\);/);
    expect(pageSrc).toContain("const retryNotice = describeRetryPending(retryPending);");
  });

  it("提示在浮顶栏（sticky top-0 z-20）那个 div 里面、早于「加载失败」那条横幅；role=status", () => {
    const sticky = pageSrc.indexOf('className="sticky top-0 z-20');
    const notice = pageSrc.indexOf("{retryNotice && (");
    const loadFail = pageSrc.indexOf("{loadFailureText && (");
    expect(sticky).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(sticky);
    expect(loadFail).toBeGreaterThan(notice);
    // 浮顶栏 div 的收尾在提示之后、「加载失败」横幅之前：提示块之后紧跟 `</div>` 关浮顶栏
    const between = pageSrc.slice(notice, loadFail);
    expect(between).toContain('role="status"');
    expect(between.trimEnd().endsWith("</div>")).toBe(true);
    const tail = between.slice(between.indexOf("          )}\n") + "          )}\n".length);
    expect(tail.trim(), "提示块之后只能是关闭浮顶栏的 </div>").toBe("</div>");
  });
});
