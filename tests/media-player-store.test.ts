/**
 * 播放器会话 store（player-store）：模块级单例，useSyncExternalStore 订阅
 *
 * 每个用例前 resetPlayerStoreForTests()：回到关闭态、nonce 归零、清掉所有订阅。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  closeMedia,
  getPlayerSnapshot,
  getServerPlayerSnapshot,
  openMedia,
  reportPlaying,
  resetPlayerStoreForTests,
  selectMediaIndex,
  subscribePlayer,
  type MediaItem,
} from "@/lib/media/player-store";

const A: MediaItem = { path: "/m/a.mp4" };
const B: MediaItem = { path: "/m/b.mp4" };
const C: MediaItem = { path: "/m/c.mp3" };

const paths = () => getPlayerSnapshot().session?.items.map((i) => i.path);

beforeEach(() => {
  resetPlayerStoreForTests();
});

describe("初始状态与服务端快照", () => {
  it("初始：没有会话、没有在播、没有当前项", () => {
    expect(getPlayerSnapshot()).toEqual({ session: null, playingPath: null, currentPath: null });
  });

  it("没有变化时 getPlayerSnapshot 返回同一个引用（useSyncExternalStore 的要求）", () => {
    expect(getPlayerSnapshot()).toBe(getPlayerSnapshot());
    openMedia([A]);
    expect(getPlayerSnapshot()).toBe(getPlayerSnapshot());
  });

  it("服务端快照：恒为关闭态（SSR / hydration 阶段不能带会话），且引用稳定", () => {
    expect(getServerPlayerSnapshot()).toEqual({ session: null, playingPath: null, currentPath: null });
    expect(getServerPlayerSnapshot()).toBe(getServerPlayerSnapshot());
    openMedia([A, B]);
    reportPlaying(A.path);
    expect(getServerPlayerSnapshot()).toEqual({ session: null, playingPath: null, currentPath: null });
    expect(getServerPlayerSnapshot()).not.toBe(getPlayerSnapshot());
  });

  it("关闭态的快照是冻结的（防止有人改共享的 CLOSED 常量）", () => {
    const closed = getServerPlayerSnapshot();
    expect(Object.isFrozen(closed)).toBe(true);
    expect(() => {
      (closed as { playingPath: string | null }).playingPath = "/x.mp4";
    }).toThrow();
    expect(getServerPlayerSnapshot().playingPath).toBeNull();
  });
});

describe("openMedia：开会话", () => {
  it("单个文件：session 里有这一项，index 0，当前路径对上，reqNonce = 1", () => {
    openMedia([{ path: "/m/a.mp4", start: 12.4, end: 15 }]);
    const snap = getPlayerSnapshot();
    expect(snap.session).toEqual({
      items: [{ path: "/m/a.mp4", start: 12.4, end: 15 }],
      index: 0,
      reqNonce: 1,
    });
    expect(snap.currentPath).toBe("/m/a.mp4");
    expect(snap.playingPath).toBeNull();
  });

  it("过滤非音视频路径与空路径", () => {
    openMedia([{ path: "/m/readme.md" }, A, { path: "" }, { path: "/m/x.ts" }, C, { path: "/m/noext" }]);
    expect(paths()).toEqual([A.path, C.path]);
  });

  it("全被过滤 / 空列表：忽略，状态与订阅都不动", () => {
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    const before = getPlayerSnapshot();
    openMedia([]);
    openMedia([{ path: "/m/readme.md" }, { path: "" }]);
    expect(getPlayerSnapshot()).toBe(before);
    expect(calls).toBe(0);
    // 被忽略的调用不消耗 nonce：下一次有效调用仍是 1
    openMedia([A]);
    expect(getPlayerSnapshot().session?.reqNonce).toBe(1);
  });

  it("index 缺省为 0；夹进 [0, 最后一项]", () => {
    openMedia([A, B, C]);
    expect(getPlayerSnapshot().session?.index).toBe(0);
    openMedia([A, B, C], { index: 2 });
    expect(getPlayerSnapshot().session?.index).toBe(2);
    resetPlayerStoreForTests();
    openMedia([A, B, C], { index: -5 });
    expect(getPlayerSnapshot().session?.index).toBe(0);
    resetPlayerStoreForTests();
    openMedia([A, B, C], { index: 99 });
    expect(getPlayerSnapshot().session?.index).toBe(2);
    expect(getPlayerSnapshot().currentPath).toBe(C.path);
  });

  it("index 是小数 / NaN：不崩，落到合法的项上", () => {
    expect(() => openMedia([A, B, C], { index: Number.NaN })).not.toThrow();
    expect(getPlayerSnapshot().session?.index).toBe(0);
    resetPlayerStoreForTests();
    expect(() => openMedia([A, B, C], { index: 1.5 })).not.toThrow();
    // 小数向下取整
    expect(getPlayerSnapshot().session?.index).toBe(1);
    expect(getPlayerSnapshot().currentPath).toBe(B.path);
  });

  it("index 是 ±Infinity：照旧夹到最后 / 最前一项", () => {
    openMedia([A, B, C], { index: Number.POSITIVE_INFINITY });
    expect(getPlayerSnapshot().currentPath).toBe(C.path);
    resetPlayerStoreForTests();
    openMedia([A, B, C], { index: Number.NEGATIVE_INFINITY });
    expect(getPlayerSnapshot().currentPath).toBe(A.path);
    openMedia([A, B, C], { index: 1 });
    selectMediaIndex(Number.POSITIVE_INFINITY);
    expect(getPlayerSnapshot().currentPath).toBe(C.path);
    selectMediaIndex(Number.NEGATIVE_INFINITY);
    expect(getPlayerSnapshot().currentPath).toBe(A.path);
  });

  it("index 指的是调用方传入列表里的位置：前面有被过滤掉的项时不能错位", () => {
    // 调用方点的是第 2 项（a.mp4），过滤掉前面的 notes.md 后它是第 1 项
    openMedia([{ path: "/m/notes.md" }, A, B], { index: 1 });
    expect(getPlayerSnapshot().session?.index).toBe(0);
    expect(getPlayerSnapshot().currentPath).toBe(A.path);
    resetPlayerStoreForTests();
    openMedia([{ path: "/m/notes.md" }, A, { path: "/m/log.txt" }, B], { index: 3 });
    expect(getPlayerSnapshot().currentPath).toBe(B.path);
  });

  it("点到的那项恰好被过滤掉：落到它后面第一个有效项；后面没有就取最后一个", () => {
    openMedia([A, { path: "/m/notes.md" }, B], { index: 1 });
    expect(getPlayerSnapshot().currentPath).toBe(B.path);
    resetPlayerStoreForTests();
    openMedia([A, B, { path: "/m/notes.md" }], { index: 2 });
    expect(getPlayerSnapshot().currentPath).toBe(B.path);
  });

  it("不修改调用方传入的数组 / 对象", () => {
    const input: MediaItem[] = [{ path: "/m/readme.md" }, { path: "/m/a.mp4", start: 3 }];
    const copy = JSON.parse(JSON.stringify(input));
    openMedia(input);
    expect(input).toEqual(copy);
  });

  it("start / end 随项保存（A-B 区间的起点终点）", () => {
    openMedia([{ path: "/m/a.mp4", start: 3, end: 9 }, B], { index: 0 });
    expect(getPlayerSnapshot().session?.items[0]).toEqual({ path: "/m/a.mp4", start: 3, end: 9 });
  });

  it("每次 openMedia 都让 reqNonce 加一（同一个文件再点一次也算新请求）", () => {
    openMedia([A]);
    expect(getPlayerSnapshot().session?.reqNonce).toBe(1);
    openMedia([A]);
    expect(getPlayerSnapshot().session?.reqNonce).toBe(2);
    openMedia([B]);
    expect(getPlayerSnapshot().session?.reqNonce).toBe(3);
  });

  it("开会话不会清掉「正在播放」的上报", () => {
    openMedia([A]);
    reportPlaying(A.path);
    openMedia([A, B], { index: 1 });
    expect(getPlayerSnapshot().playingPath).toBe(A.path);
  });
});

describe("openMedia：同一组文件再点 vs 不同组", () => {
  it("同一组文件（路径序列相同）：只换当前项，reqNonce 递增，被点那项的起止更新", () => {
    openMedia([A, B, C], { index: 0 });
    openMedia([{ ...A }, { ...B, start: 20, end: 30 }, { ...C }], { index: 1 });
    const s = getPlayerSnapshot().session!;
    expect(s.index).toBe(1);
    expect(s.reqNonce).toBe(2);
    expect(s.items.map((i) => i.path)).toEqual([A.path, B.path, C.path]);
    expect(s.items[1]).toEqual({ path: B.path, start: 20, end: 30 });
    expect(getPlayerSnapshot().currentPath).toBe(B.path);
  });

  it("同一组文件再点：其它项已有的起止保留，不会因为再点一次就丢掉", () => {
    openMedia(
      [
        { path: A.path, start: 5 },
        { path: B.path, start: 7, end: 9 },
        { path: C.path },
      ],
      { index: 0 },
    );
    // 再点第 3 项（不带起止）：第 1、2 项各自的起止还在
    openMedia([{ path: A.path }, { path: B.path }, { path: C.path, start: 1 }], { index: 2 });
    const items = getPlayerSnapshot().session!.items;
    expect(items[0]).toEqual({ path: A.path, start: 5 });
    expect(items[1]).toEqual({ path: B.path, start: 7, end: 9 });
    expect(items[2]).toEqual({ path: C.path, start: 1 });
  });

  it("同一组文件再点同一项：该项用新的起止（从指定时间重播）", () => {
    openMedia([{ path: A.path, start: 5 }, B], { index: 0 });
    openMedia([{ path: A.path, start: 40 }, B], { index: 0 });
    expect(getPlayerSnapshot().session!.items[0]).toEqual({ path: A.path, start: 40 });
    expect(getPlayerSnapshot().session!.reqNonce).toBe(2);
  });

  it("同一组文件再点同一项且不带起止：被点那项的旧起止被清掉（从头播）", () => {
    openMedia([{ path: A.path, start: 5, end: 8 }, B], { index: 0 });
    openMedia([A, B], { index: 0 });
    expect(getPlayerSnapshot().session!.items[0]).toEqual({ path: A.path });
  });

  it("不同组（文件不同 / 数量不同 / 顺序不同）：开新会话，items 整体替换", () => {
    openMedia([A, B], { index: 1 });
    openMedia([A, C]);
    expect(paths()).toEqual([A.path, C.path]);
    expect(getPlayerSnapshot().session?.index).toBe(0);
    openMedia([A]);
    expect(paths()).toEqual([A.path]);
    openMedia([B, A]);
    openMedia([A, B]);
    expect(paths()).toEqual([A.path, B.path]);
    expect(getPlayerSnapshot().session?.reqNonce).toBe(5);
  });

  it("不同组时新会话不继承旧会话的起止", () => {
    openMedia([{ path: A.path, start: 5 }, B]);
    openMedia([A, C]);
    expect(getPlayerSnapshot().session!.items[0]).toEqual({ path: A.path });
  });

  it("过滤发生在比较之前：过滤后相同就是同一组", () => {
    openMedia([A, B], { index: 0 });
    openMedia([A, { path: "/m/readme.md" }, B], { index: 2 });
    expect(getPlayerSnapshot().session!.reqNonce).toBe(2);
    expect(paths()).toEqual([A.path, B.path]);
    expect(getPlayerSnapshot().session!.index).toBe(1);
  });

  it("会话关闭之后再开：永远是新会话", () => {
    openMedia([{ path: A.path, start: 5 }, B]);
    closeMedia();
    openMedia([A, B]);
    expect(getPlayerSnapshot().session!.items[0]).toEqual({ path: A.path });
  });
});

describe("selectMediaIndex", () => {
  it("没有会话：忽略，不通知", () => {
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    selectMediaIndex(1);
    expect(getPlayerSnapshot().session).toBeNull();
    expect(calls).toBe(0);
  });

  it("切换当前项：index / currentPath 更新，reqNonce 递增", () => {
    openMedia([A, B, C]);
    selectMediaIndex(2);
    const snap = getPlayerSnapshot();
    expect(snap.session?.index).toBe(2);
    expect(snap.session?.reqNonce).toBe(2);
    expect(snap.currentPath).toBe(C.path);
    expect(snap.session?.items.map((i) => i.path)).toEqual([A.path, B.path, C.path]);
  });

  it("越界夹值", () => {
    openMedia([A, B, C]);
    selectMediaIndex(99);
    expect(getPlayerSnapshot().session?.index).toBe(2);
    selectMediaIndex(-3);
    expect(getPlayerSnapshot().session?.index).toBe(0);
    expect(getPlayerSnapshot().currentPath).toBe(A.path);
  });

  it("切到当前已选中的项：什么都不发生（不通知、nonce 不变）", () => {
    openMedia([A, B]);
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    const before = getPlayerSnapshot();
    selectMediaIndex(0);
    selectMediaIndex(-10);
    expect(getPlayerSnapshot()).toBe(before);
    expect(calls).toBe(0);
    expect(getPlayerSnapshot().session?.reqNonce).toBe(1);
  });

  it("夹值后正好等于当前项也不通知", () => {
    openMedia([A, B], { index: 1 });
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    selectMediaIndex(50);
    expect(calls).toBe(0);
  });

  it("被切到的那项的起止被清掉（切换不是「从引用时间重播」），其它项的保留", () => {
    openMedia([{ path: A.path, start: 5 }, { path: B.path, start: 7, end: 9 }, { path: C.path, start: 1 }], { index: 0 });
    selectMediaIndex(1);
    const items = getPlayerSnapshot().session!.items;
    expect(items[0]).toEqual({ path: A.path, start: 5 });
    expect(items[1]).toEqual({ path: B.path });
    expect(items[2]).toEqual({ path: C.path, start: 1 });
  });

  it("不改变 playingPath", () => {
    openMedia([A, B]);
    reportPlaying(A.path);
    selectMediaIndex(1);
    expect(getPlayerSnapshot().playingPath).toBe(A.path);
  });

  it("index 是 NaN：不崩，也不改变当前项", () => {
    openMedia([A, B, C], { index: 1 });
    expect(() => selectMediaIndex(Number.NaN)).not.toThrow();
    expect(getPlayerSnapshot().currentPath).toBe(B.path);
  });

  it("index 是小数：向下取整落到合法项", () => {
    openMedia([A, B, C]);
    expect(() => selectMediaIndex(1.7)).not.toThrow();
    expect(getPlayerSnapshot().session?.index).toBe(1);
  });

  it("不修改旧快照里的 session（快照不可变）", () => {
    openMedia([A, B]);
    const before = getPlayerSnapshot();
    selectMediaIndex(1);
    expect(before.session?.index).toBe(0);
    expect(before.currentPath).toBe(A.path);
  });
});

describe("reportPlaying", () => {
  it("设置 / 清除正在播放的路径", () => {
    openMedia([A, B]);
    reportPlaying(B.path);
    expect(getPlayerSnapshot().playingPath).toBe(B.path);
    reportPlaying(null);
    expect(getPlayerSnapshot().playingPath).toBeNull();
  });

  it("和当前项是两回事：暂停也算当前项，但不算在播", () => {
    openMedia([A, B]);
    expect(getPlayerSnapshot().currentPath).toBe(A.path);
    expect(getPlayerSnapshot().playingPath).toBeNull();
    reportPlaying(A.path);
    selectMediaIndex(1);
    expect(getPlayerSnapshot().currentPath).toBe(B.path);
    expect(getPlayerSnapshot().playingPath).toBe(A.path);
  });

  it("重复上报同一个值：不产生新快照、不通知", () => {
    openMedia([A]);
    reportPlaying(A.path);
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    const before = getPlayerSnapshot();
    reportPlaying(A.path);
    expect(getPlayerSnapshot()).toBe(before);
    expect(calls).toBe(0);
    reportPlaying(null);
    reportPlaying(null);
    expect(calls).toBe(1);
  });

  it("不改变 session（同一个引用）", () => {
    openMedia([A, B]);
    const session = getPlayerSnapshot().session;
    reportPlaying(A.path);
    expect(getPlayerSnapshot().session).toBe(session);
  });

  it("初始态上报 null 不通知", () => {
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    reportPlaying(null);
    expect(calls).toBe(0);
  });
});

describe("closeMedia", () => {
  it("清掉会话、当前项和在播状态，回到关闭态", () => {
    openMedia([A, B]);
    reportPlaying(A.path);
    closeMedia();
    expect(getPlayerSnapshot()).toEqual({ session: null, playingPath: null, currentPath: null });
  });

  it("已经是关闭态：不通知", () => {
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    closeMedia();
    expect(calls).toBe(0);
    openMedia([A]);
    closeMedia();
    closeMedia();
    expect(calls).toBe(2);
  });

  it("只上报了播放、没有会话时 close 也会清掉在播状态", () => {
    reportPlaying("/m/a.mp4");
    expect(getPlayerSnapshot().playingPath).toBe("/m/a.mp4");
    closeMedia();
    expect(getPlayerSnapshot().playingPath).toBeNull();
  });

  it("关闭后重新开：reqNonce 继续递增（不回到 1，避免与旧请求撞号）", () => {
    openMedia([A]);
    openMedia([A]);
    closeMedia();
    openMedia([A]);
    expect(getPlayerSnapshot().session?.reqNonce).toBe(3);
  });

  it("关闭后 selectMediaIndex 忽略", () => {
    openMedia([A, B]);
    closeMedia();
    selectMediaIndex(1);
    expect(getPlayerSnapshot().session).toBeNull();
  });
});

describe("subscribePlayer", () => {
  it("openMedia / selectMediaIndex / reportPlaying / closeMedia 各通知一次", () => {
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    openMedia([A, B]);
    expect(calls).toBe(1);
    selectMediaIndex(1);
    expect(calls).toBe(2);
    reportPlaying(B.path);
    expect(calls).toBe(3);
    closeMedia();
    expect(calls).toBe(4);
  });

  it("通知时拿到的已经是最新快照", () => {
    const seen: Array<string | null> = [];
    subscribePlayer(() => seen.push(getPlayerSnapshot().currentPath));
    openMedia([A, B], { index: 1 });
    selectMediaIndex(0);
    closeMedia();
    expect(seen).toEqual([B.path, A.path, null]);
  });

  it("退订后不再通知；重复退订安全", () => {
    let calls = 0;
    const unsubscribe = subscribePlayer(() => (calls += 1));
    openMedia([A]);
    expect(calls).toBe(1);
    unsubscribe();
    openMedia([B]);
    reportPlaying(B.path);
    expect(calls).toBe(1);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("多个订阅者都收到通知；退订其中一个不影响其它", () => {
    const log: string[] = [];
    const offA = subscribePlayer(() => log.push("a"));
    subscribePlayer(() => log.push("b"));
    openMedia([A]);
    expect(log).toEqual(["a", "b"]);
    offA();
    reportPlaying(A.path);
    expect(log).toEqual(["a", "b", "b"]);
  });

  it("同一个函数重复订阅只算一个（Set 语义），退订一次就彻底取消", () => {
    let calls = 0;
    const fn = () => {
      calls += 1;
    };
    subscribePlayer(fn);
    const off = subscribePlayer(fn);
    openMedia([A]);
    expect(calls).toBe(1);
    off();
    reportPlaying(A.path);
    expect(calls).toBe(1);
  });

  it("订阅者在回调里退订自己 / 别人：本轮遍历不被打乱，其它订阅者照常收到", () => {
    const log: string[] = [];
    const offs: Array<() => void> = [];
    offs.push(
      subscribePlayer(() => {
        log.push("a");
        offs[0]!();
        offs[1]!();
      }),
    );
    offs.push(subscribePlayer(() => log.push("b")));
    offs.push(subscribePlayer(() => log.push("c")));
    openMedia([A]);
    // 本轮遍历用的是订阅者快照：a 退订了 b，b 这一轮仍会被调用；c 照常
    expect(log).toEqual(["a", "b", "c"]);
    reportPlaying(A.path);
    // 下一轮：a、b 都已退订
    expect(log).toEqual(["a", "b", "c", "c"]);
  });

  it("订阅者在回调里发起新的 store 变更：嵌套通知也能到达，最终快照正确", () => {
    const seen: Array<string | null> = [];
    let once = true;
    subscribePlayer(() => {
      seen.push(getPlayerSnapshot().playingPath);
      if (once) {
        once = false;
        reportPlaying("/m/a.mp4");
      }
    });
    openMedia([A]);
    expect(getPlayerSnapshot().playingPath).toBe("/m/a.mp4");
    // 第一次通知（openMedia）时还没在播；回调里的 reportPlaying 触发第二次通知
    expect(seen).toEqual([null, "/m/a.mp4"]);
  });

  it("resetPlayerStoreForTests 会清掉订阅与 nonce", () => {
    let calls = 0;
    subscribePlayer(() => (calls += 1));
    openMedia([A]);
    expect(calls).toBe(1);
    resetPlayerStoreForTests();
    expect(getPlayerSnapshot()).toEqual({ session: null, playingPath: null, currentPath: null });
    openMedia([A]);
    expect(calls).toBe(1);
    expect(getPlayerSnapshot().session?.reqNonce).toBe(1);
  });
});
