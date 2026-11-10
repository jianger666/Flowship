/**
 * V3 下载登记表（electron-app/browser/downloads.mjs）：状态机 / 容量 / url 脱敏 / waitSettled 语义。纯逻辑，无 Electron。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DOWNLOADS,
  createDownloadRegistry,
  sanitizeDownloadUrl,
} from "../electron-app/browser/downloads.mjs";

const mk = (reg: ReturnType<typeof createDownloadRegistry>, name = "a.pdf", extra: Record<string, unknown> = {}) =>
  reg.addStarted({ fileName: name, path: `/dl/${name}`, url: `https://x.test/${name}`, ...extra })!;

describe("sanitizeDownloadUrl", () => {
  it("去掉 query / hash / userinfo", () => {
    expect(sanitizeDownloadUrl("https://u:p@x.test/a/b.pdf?token=SECRET&x=1#frag")).toBe("https://x.test/a/b.pdf");
  });
  it("data: 只留协议；blob: 去 query；非法 URL 手工截 ? #", () => {
    expect(sanitizeDownloadUrl("data:text/plain;base64,AAAA")).toBe("data:");
    expect(sanitizeDownloadUrl("not a url?secret=1#h")).toBe("not a url");
    expect(sanitizeDownloadUrl(undefined)).toBe("");
  });
});

describe("登记表：id 与状态机", () => {
  it("id 单调递增；新项是 progressing、有 startedAt、tabId 可选", () => {
    let t = 1000;
    const reg = createDownloadRegistry({ now: () => t++ });
    const a = mk(reg, "a.pdf", { tabId: "t2" });
    const b = mk(reg, "b.pdf");
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a).toMatchObject({ state: "progressing", receivedBytes: 0, totalBytes: 0, tabId: "t2", url: "https://x.test/a.pdf" });
    expect(a.startedAt).toBe(1000);
    expect("tabId" in b).toBe(false);
  });

  it("progressing → completed：写 endedAt，totalBytes 至少等于 receivedBytes", () => {
    const reg = createDownloadRegistry({ now: () => 5 });
    const a = mk(reg);
    expect(reg.update(a.id, { receivedBytes: 40, totalBytes: 100 })).toMatchObject({ receivedBytes: 40, totalBytes: 100 });
    const done = reg.finish(a.id, "completed", { receivedBytes: 120, totalBytes: 100 })!;
    expect(done).toMatchObject({ state: "completed", receivedBytes: 120, totalBytes: 120, endedAt: 5 });
  });

  it("cancelled / interrupted 也是终态；非法 state 当 interrupted", () => {
    const reg = createDownloadRegistry();
    const a = mk(reg, "a");
    const b = mk(reg, "b");
    const c = mk(reg, "c");
    expect(reg.finish(a.id, "cancelled")!.state).toBe("cancelled");
    expect(reg.finish(b.id, "interrupted")!.state).toBe("interrupted");
    expect(reg.finish(c.id, "weird")!.state).toBe("interrupted");
  });

  it("终态不可再变：晚到的 update / finish 被忽略（返回 null，不改记录）", () => {
    const reg = createDownloadRegistry();
    const a = mk(reg);
    reg.finish(a.id, "completed", { receivedBytes: 10 });
    expect(reg.update(a.id, { receivedBytes: 999 })).toBeNull();
    expect(reg.finish(a.id, "cancelled")).toBeNull();
    expect(reg.get(a.id)).toMatchObject({ state: "completed", receivedBytes: 10 });
  });

  it("未知 id 与垃圾数值不抛错", () => {
    const reg = createDownloadRegistry();
    expect(reg.update(99, { receivedBytes: 1 })).toBeNull();
    expect(reg.finish(99, "completed")).toBeNull();
    const a = mk(reg);
    reg.update(a.id, { receivedBytes: Number.NaN, totalBytes: -5 });
    expect(reg.get(a.id)).toMatchObject({ receivedBytes: 0, totalBytes: 0 });
  });

  it("recent 最新在前；list 给全部；hasPath 能避开在途同名路径", () => {
    const reg = createDownloadRegistry();
    for (let i = 1; i <= 12; i++) mk(reg, `f${i}.txt`);
    expect(reg.recent(10).map((d) => d.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(reg.list()).toHaveLength(12);
    expect(reg.hasPath("/dl/f3.txt")).toBe(true);
    expect(reg.hasPath("/dl/nope.txt")).toBe(false);
  });

  it("返回的是副本：改它不影响登记表", () => {
    const reg = createDownloadRegistry();
    const a = mk(reg);
    a.fileName = "hacked";
    reg.list()[0].state = "completed";
    expect(reg.get(a.id)).toMatchObject({ fileName: "a.pdf", state: "progressing" });
  });
});

describe("登记表：容量上限", () => {
  it("超过 50 条丢最旧；id 不回收", () => {
    const reg = createDownloadRegistry();
    for (let i = 0; i < MAX_DOWNLOADS + 5; i++) reg.finish(mk(reg, `f${i}`).id, "completed");
    expect(reg.size).toBe(MAX_DOWNLOADS);
    const ids = reg.list().map((d) => d.id);
    expect(ids[0]).toBe(MAX_DOWNLOADS + 5);
    expect(ids[ids.length - 1]).toBe(6);
    expect(mk(reg, "next").id).toBe(MAX_DOWNLOADS + 6);
  });

  it("满了优先丢已结束的：在途的老下载不被挤掉", () => {
    const reg = createDownloadRegistry({ max: 3 });
    const live = mk(reg, "live"); // id1 一直在途
    reg.finish(mk(reg, "b").id, "completed"); // id2
    reg.finish(mk(reg, "c").id, "completed"); // id3
    mk(reg, "d"); // id4 → 丢 id2（最旧的已结束）
    expect(reg.list().map((d) => d.id).sort()).toEqual([1, 3, 4]);
    expect(reg.get(live.id)!.state).toBe("progressing");
  });

  it("全在途时才丢最旧的在途项，之后它的 update 被忽略", () => {
    const reg = createDownloadRegistry({ max: 2 });
    const a = mk(reg, "a");
    mk(reg, "b");
    mk(reg, "c");
    expect(reg.list().map((d) => d.id)).toEqual([3, 2]);
    expect(reg.update(a.id, { receivedBytes: 1 })).toBeNull();
  });
});

describe("waitSettled", () => {
  it("没有任何下载也没在途：立即返回空且 timedOut:false", async () => {
    const reg = createDownloadRegistry();
    await expect(reg.waitSettled({ timeoutMs: 5000 })).resolves.toEqual({ downloads: [], timedOut: false });
  });

  it("等当前在途下载结束；结果最新在前", async () => {
    const reg = createDownloadRegistry();
    const a = mk(reg, "a");
    const b = mk(reg, "b");
    const p = reg.waitSettled({ timeoutMs: 2000 });
    reg.finish(a.id, "completed", { receivedBytes: 1 });
    let settled = false;
    void p.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // b 还没结束
    reg.finish(b.id, "cancelled");
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.downloads.map((d: { id: number; state: string }) => [d.id, d.state])).toEqual([
      [2, "cancelled"],
      [1, "completed"],
    ]);
  });

  it("不给 sinceId 时目标集合在调用当下固定：之后新开的下载不拖延返回", async () => {
    const reg = createDownloadRegistry();
    const a = mk(reg, "a");
    const p = reg.waitSettled({ timeoutMs: 2000 });
    mk(reg, "late"); // 之后才开始、一直不结束
    reg.finish(a.id, "completed");
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.downloads.map((d: { id: number }) => d.id)).toEqual([1]);
  });

  it("到 timeoutMs 仍有在途 → timedOut:true，返回当前快照", async () => {
    const reg = createDownloadRegistry();
    mk(reg, "slow");
    const r = await reg.waitSettled({ timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].state).toBe("progressing");
  });

  it("sinceId：只等 id 大于它的下载；已结束的新下载立即返回，旧的不算", async () => {
    const reg = createDownloadRegistry({ startGraceMs: 0 });
    mk(reg, "old"); // id1 在途但在 sinceId 之前
    const n = mk(reg, "new"); // id2
    reg.finish(n.id, "completed");
    const r = await reg.waitSettled({ sinceId: 1, timeoutMs: 2000 });
    expect(r.timedOut).toBe(false);
    expect(r.downloads.map((d: { id: number }) => d.id)).toEqual([2]);
  });

  it("sinceId 且暂时没有新下载：给宽限等它冒出来，之后等它结束", async () => {
    const reg = createDownloadRegistry({ startGraceMs: 200 });
    const p = reg.waitSettled({ sinceId: 0, timeoutMs: 2000 });
    setTimeout(() => {
      const d = mk(reg, "late");
      setTimeout(() => reg.finish(d.id, "completed", { receivedBytes: 3 }), 30);
    }, 40);
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].state).toBe("completed");
  });

  it("sinceId 宽限用完仍没有下载 → 返回空（不是 timedOut）", async () => {
    const reg = createDownloadRegistry({ startGraceMs: 30 });
    const t0 = Date.now();
    const r = await reg.waitSettled({ sinceId: 0, timeoutMs: 5000 });
    expect(r).toEqual({ downloads: [], timedOut: false });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("signal 能打断：reject signal.reason，且不留监听", async () => {
    const reg = createDownloadRegistry();
    mk(reg);
    const ac = new AbortController();
    const reason = new Error("stopped");
    const p = reg.waitSettled({ timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(reason), 10);
    await expect(p).rejects.toBe(reason);
    // 打断后再结束下载不会出问题
    expect(() => reg.finish(1, "completed")).not.toThrow();
  });

  it("signal 已经 aborted：立即 reject", async () => {
    const reg = createDownloadRegistry();
    mk(reg);
    const ac = new AbortController();
    ac.abort(new Error("pre"));
    await expect(reg.waitSettled({ signal: ac.signal })).rejects.toThrow("pre");
  });

  it("dispose（会话销毁）：等待者以 CANCELLED 结束；之后拒绝新登记与新等待", async () => {
    const reg = createDownloadRegistry();
    mk(reg);
    const p = reg.waitSettled({ timeoutMs: 60_000 });
    reg.dispose();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    expect(reg.addStarted({ fileName: "x", path: "/x" })).toBeNull();
    await expect(reg.waitSettled()).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
