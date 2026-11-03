/**
 * 播放器记忆（media-memory）：播放位置 / 偏好的 localStorage 持久化
 *
 * 用假 StorageLike（Map）注入，不依赖 DOM。重点是「读到坏数据不崩」「LRU 淘汰最久没碰的」
 * 「早期版本存下的 markers 字段读进来被清掉、不影响其余数据」。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREFS,
  MAX_MEDIA_FILES,
  MEDIA_MEMORY_KEY,
  RATES,
  RESUME_EDGE_SECONDS,
  createMediaMemory,
  resumePositionFor,
  type StorageLike,
} from "@/lib/media/media-memory";

interface FakeStorage extends StorageLike {
  map: Map<string, string>;
  writes: string[];
}

const makeStorage = (initial?: string): FakeStorage => {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(MEDIA_MEMORY_KEY, initial);
  const writes: string[] = [];
  return {
    map,
    writes,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
      writes.push(v);
    },
  };
};

/** 可手动推进的假时钟 */
const makeClock = (start = 1000) => {
  let t = start;
  return {
    now: () => t,
    tick: (n = 1) => {
      t += n;
    },
  };
};

/** 从假 storage 里读出已持久化的状态 */
const stored = (st: FakeStorage) =>
  JSON.parse(st.map.get(MEDIA_MEMORY_KEY) ?? "null") as {
    files: Record<string, { position: number; duration: number; touched: number }>;
    prefs: Record<string, unknown>;
  };

const memWith = (state: unknown) => createMediaMemory(makeStorage(JSON.stringify(state)));

describe("常量", () => {
  it("key / 上限 / 续播边界 / 倍速档位", () => {
    expect(MEDIA_MEMORY_KEY).toBe("flowship.media-memory.v1");
    expect(MAX_MEDIA_FILES).toBe(200);
    expect(RESUME_EDGE_SECONDS).toBe(3);
    expect([...RATES]).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]);
    expect(DEFAULT_PREFS).toEqual({
      rate: 1,
      volume: 1,
      muted: false,
      loop: "off",
      captions: true,
      dock: null,
    });
  });
});

describe("读写位置", () => {
  it("没记过的文件 → null", () => {
    expect(createMediaMemory(makeStorage()).getFile("/a.mp4")).toBeNull();
  });

  it("savePosition 后 getFile 读得到；touched = 当时时间", () => {
    const clk = makeClock(5000);
    const mem = createMediaMemory(makeStorage(), { now: clk.now });
    mem.savePosition("/a.mp4", 12.5, 100);
    expect(mem.getFile("/a.mp4")).toEqual({ position: 12.5, duration: 100, touched: 5000 });
    clk.tick(10);
    mem.savePosition("/a.mp4", 20, 100);
    expect(mem.getFile("/a.mp4")).toMatchObject({ position: 20, touched: 5010 });
  });

  it("写进 storage，新实例（同一个 storage）能读回来", () => {
    const st = makeStorage();
    createMediaMemory(st).savePosition("/a.mp4", 33, 120);
    expect(st.map.has(MEDIA_MEMORY_KEY)).toBe(true);
    const again = createMediaMemory(st);
    expect(again.getFile("/a.mp4")).toMatchObject({ position: 33, duration: 120 });
  });

  it("不同文件互不影响", () => {
    const mem = createMediaMemory(makeStorage());
    mem.savePosition("/a.mp4", 1, 10);
    mem.savePosition("/b.mp4", 2, 20);
    expect(mem.getFile("/a.mp4")?.position).toBe(1);
    expect(mem.getFile("/b.mp4")?.position).toBe(2);
  });

  it("位置 0 合法（会创建记录）", () => {
    const mem = createMediaMemory(makeStorage());
    mem.savePosition("/a.mp4", 0, 10);
    expect(mem.getFile("/a.mp4")?.position).toBe(0);
  });

  it("非法位置 / 空路径被忽略（不创建记录、不写 storage）", () => {
    const st = makeStorage();
    const mem = createMediaMemory(st);
    mem.savePosition("/a.mp4", -1, 10);
    mem.savePosition("/a.mp4", Number.NaN, 10);
    mem.savePosition("/a.mp4", Number.POSITIVE_INFINITY, 10);
    mem.savePosition("", 5, 10);
    expect(mem.getFile("/a.mp4")).toBeNull();
    expect(mem.getFile("")).toBeNull();
    expect(st.writes).toHaveLength(0);
  });

  it("duration 非法（0 / 负 / NaN）时保留旧值；合法时更新", () => {
    const mem = createMediaMemory(makeStorage());
    mem.savePosition("/a.mp4", 1, 100);
    mem.savePosition("/a.mp4", 2, 0);
    mem.savePosition("/a.mp4", 3, Number.NaN);
    mem.savePosition("/a.mp4", 4, -5);
    expect(mem.getFile("/a.mp4")).toMatchObject({ position: 4, duration: 100 });
    mem.savePosition("/a.mp4", 5, 200);
    expect(mem.getFile("/a.mp4")?.duration).toBe(200);
  });

  it("getFile 返回的是副本：改它不影响内部状态", () => {
    const mem = createMediaMemory(makeStorage());
    mem.savePosition("/a.mp4", 5, 10);
    const f = mem.getFile("/a.mp4")!;
    f.position = 999;
    const g = mem.getFile("/a.mp4")!;
    expect(g.position).toBe(5);
  });
});

describe("读到坏数据：逐字段清洗，不崩", () => {
  it("坏 JSON / 非对象 / 空串 → 当作空状态", () => {
    for (const bad of ["{not json", "", "null", "123", '"str"', "true", "[]", "{}", '{"files":"x"}', '{"files":null,"prefs":5}']) {
      const mem = createMediaMemory(makeStorage(bad));
      expect(mem.getFile("/a.mp4"), bad).toBeNull();
      expect(mem.getPrefs(), bad).toEqual(DEFAULT_PREFS);
    }
  });

  it("坏数据读完之后还能正常写", () => {
    const st = makeStorage("{broken");
    const mem = createMediaMemory(st);
    mem.savePosition("/a.mp4", 7, 70);
    expect(stored(st).files["/a.mp4"]?.position).toBe(7);
  });

  it("文件项不是对象 → 丢弃；是对象但字段坏 → 逐字段回落为 0", () => {
    const mem = memWith({
      files: {
        "/ok.mp4": { position: 5, duration: 60, touched: 7 },
        "/neg.mp4": { position: -5, duration: -1, touched: "x" },
        "/str.mp4": { position: "5", duration: null },
        "/null.mp4": null,
        "/num.mp4": 42,
        "/str2.mp4": "hello",
      },
    });
    expect(mem.getFile("/ok.mp4")).toEqual({ position: 5, duration: 60, touched: 7 });
    expect(mem.getFile("/neg.mp4")).toEqual({ position: 0, duration: 0, touched: 0 });
    expect(mem.getFile("/str.mp4")).toEqual({ position: 0, duration: 0, touched: 0 });
    expect(mem.getFile("/null.mp4")).toBeNull();
    expect(mem.getFile("/num.mp4")).toBeNull();
    expect(mem.getFile("/str2.mp4")).toBeNull();
  });

  it("早期版本留下的 markers / markersOpen 字段：读进来被清掉，位置等其余数据不受影响", () => {
    const st = makeStorage(
      JSON.stringify({
        files: { "/a.mp4": { position: 12, duration: 60, touched: 3, markers: [{ id: "m1", t: 5, note: "旧标记" }] } },
        prefs: { rate: 2, markersOpen: true },
      }),
    );
    const mem = createMediaMemory(st);
    expect(mem.getFile("/a.mp4")).toEqual({ position: 12, duration: 60, touched: 3 });
    expect(mem.getPrefs()).toEqual({ ...DEFAULT_PREFS, rate: 2 });
    // 下一次写回时旧字段随之消失
    mem.savePosition("/a.mp4", 13, 60);
    expect(JSON.stringify(stored(st))).not.toContain("markers");
    expect(JSON.stringify(stored(st))).not.toContain("markersOpen");
  });

  it("偏好清洗：rate 夹到 0.25–4、volume 夹到 0–1、布尔 / 枚举类型不对回落默认", () => {
    const mem = memWith({
      prefs: { rate: 10, volume: 5, muted: "yes", loop: "bogus", captions: null, dock: { x: 1, y: 2, w: 50, h: 50 } },
    });
    expect(mem.getPrefs()).toEqual({
      rate: 4,
      volume: 1,
      muted: false,
      loop: "off",
      captions: true,
      dock: null,
    });
    expect(memWith({ prefs: { rate: 0.01, volume: -3 } }).getPrefs()).toMatchObject({ rate: 0.25, volume: 0 });
    expect(memWith({ prefs: { rate: "2", volume: "x" } }).getPrefs()).toMatchObject({ rate: 1, volume: 1 });
  });

  it("偏好合法值原样保留", () => {
    const prefs = {
      rate: 1.5,
      volume: 0.4,
      muted: true,
      loop: "all",
      captions: false,
      dock: { x: 10, y: 20, w: 400, h: 300 },
    };
    expect(memWith({ prefs }).getPrefs()).toEqual(prefs);
    for (const loop of ["off", "one", "all"] as const) {
      expect(memWith({ prefs: { loop } }).getPrefs().loop).toBe(loop);
    }
  });

  it("prefs 不是对象 → 默认", () => {
    for (const prefs of [null, "x", 5, true]) {
      expect(memWith({ prefs }).getPrefs()).toEqual(DEFAULT_PREFS);
    }
  });

  it("悬浮窗位置清洗：字段缺失 / 非数字 / 太小 → null；100×60 恰好合法；多余字段不保留", () => {
    const dockOf = (dock: unknown) => memWith({ prefs: { dock } }).getPrefs().dock;
    expect(dockOf({ x: 10, y: 20, w: 100, h: 60 })).toEqual({ x: 10, y: 20, w: 100, h: 60 });
    expect(dockOf({ x: 10, y: 20, w: 99, h: 60 })).toBeNull();
    expect(dockOf({ x: 10, y: 20, w: 100, h: 59 })).toBeNull();
    expect(dockOf({ x: 10, w: 300, h: 200 })).toBeNull();
    expect(dockOf({ x: "10", y: 20, w: 300, h: 200 })).toBeNull();
    expect(dockOf({ x: null, y: 20, w: 300, h: 200 })).toBeNull();
    expect(dockOf("dock")).toBeNull();
    expect(dockOf(null)).toBeNull();
    expect(dockOf({ x: -5, y: -5, w: 300, h: 200, extra: 1 })).toEqual({ x: -5, y: -5, w: 300, h: 200 });
  });
});

describe("LRU 淘汰", () => {
  const filesOf = (st: FakeStorage) => Object.keys(stored(st).files).sort();

  it("超出上限：淘汰最久没碰的", () => {
    const clk = makeClock();
    const st = makeStorage();
    const mem = createMediaMemory(st, { now: clk.now, maxFiles: 3 });
    for (const p of ["/a.mp4", "/b.mp4", "/c.mp4", "/d.mp4"]) {
      mem.savePosition(p, 1, 10);
      clk.tick();
    }
    expect(filesOf(st)).toEqual(["/b.mp4", "/c.mp4", "/d.mp4"]);
    expect(mem.getFile("/a.mp4")).toBeNull();
  });

  it("「最久没碰」按 touched 算：再碰一次的文件被保住", () => {
    const clk = makeClock();
    const st = makeStorage();
    const mem = createMediaMemory(st, { now: clk.now, maxFiles: 3 });
    for (const p of ["/a.mp4", "/b.mp4", "/c.mp4"]) {
      mem.savePosition(p, 1, 10);
      clk.tick();
    }
    mem.savePosition("/a.mp4", 2, 10); // a 刷新成最新
    clk.tick();
    mem.savePosition("/d.mp4", 1, 10);
    expect(filesOf(st)).toEqual(["/a.mp4", "/c.mp4", "/d.mp4"]);
  });

  it("没超上限：什么都不删（恰好等于上限也不删）", () => {
    const clk = makeClock();
    const st = makeStorage();
    const mem = createMediaMemory(st, { now: clk.now, maxFiles: 3 });
    for (const p of ["/a.mp4", "/b.mp4", "/c.mp4"]) {
      mem.savePosition(p, 1, 10);
      clk.tick();
    }
    expect(filesOf(st)).toEqual(["/a.mp4", "/b.mp4", "/c.mp4"]);
  });

  it("默认上限 200：写第 201 个时淘汰最旧的", () => {
    const clk = makeClock();
    const st = makeStorage();
    const mem = createMediaMemory(st, { now: clk.now });
    for (let i = 0; i < MAX_MEDIA_FILES + 1; i++) {
      mem.savePosition(`/f${i}.mp4`, 1, 10);
      clk.tick();
    }
    const files = filesOf(st);
    expect(files).toHaveLength(MAX_MEDIA_FILES);
    expect(files).not.toContain("/f0.mp4");
    expect(files).toContain("/f1.mp4");
    expect(files).toContain(`/f${MAX_MEDIA_FILES}.mp4`);
  });

});

describe("偏好", () => {
  it("默认值；getPrefs 返回副本", () => {
    const mem = createMediaMemory(makeStorage());
    expect(mem.getPrefs()).toEqual(DEFAULT_PREFS);
    const p = mem.getPrefs();
    p.rate = 3;
    expect(mem.getPrefs().rate).toBe(1);
    expect(DEFAULT_PREFS.rate).toBe(1);
  });

  it("setPrefs：rate 夹到 0.25–4", () => {
    const mem = createMediaMemory(makeStorage());
    expect(mem.setPrefs({ rate: 10 }).rate).toBe(4);
    expect(mem.setPrefs({ rate: 0.1 }).rate).toBe(0.25);
    expect(mem.setPrefs({ rate: 2.5 }).rate).toBe(2.5);
    expect(mem.setPrefs({ rate: 0.25 }).rate).toBe(0.25);
    expect(mem.setPrefs({ rate: 4 }).rate).toBe(4);
    expect(mem.getPrefs().rate).toBe(4);
  });

  it("setPrefs：volume 夹到 0–1", () => {
    const mem = createMediaMemory(makeStorage());
    expect(mem.setPrefs({ volume: 1.5 }).volume).toBe(1);
    expect(mem.setPrefs({ volume: -1 }).volume).toBe(0);
    expect(mem.setPrefs({ volume: 0.35 }).volume).toBe(0.35);
    expect(mem.setPrefs({ volume: 0 }).volume).toBe(0);
    expect(mem.setPrefs({ volume: 1 }).volume).toBe(1);
  });

  it("setPrefs 是合并：没提到的字段保持原值", () => {
    const mem = createMediaMemory(makeStorage());
    mem.setPrefs({ rate: 2 });
    mem.setPrefs({ volume: 0.5 });
    mem.setPrefs({ muted: true, loop: "one" });
    expect(mem.getPrefs()).toEqual({ ...DEFAULT_PREFS, rate: 2, volume: 0.5, muted: true, loop: "one" });
  });

  it("setPrefs 返回的是更新后的完整偏好", () => {
    const mem = createMediaMemory(makeStorage());
    const out = mem.setPrefs({ captions: false, rate: 2 });
    expect(out).toEqual({ ...DEFAULT_PREFS, captions: false, rate: 2 });
  });

  it("setPrefs 持久化：新实例读到", () => {
    const st = makeStorage();
    createMediaMemory(st).setPrefs({ rate: 1.5, volume: 0.2, loop: "all", dock: { x: 1, y: 2, w: 300, h: 200 } });
    expect(createMediaMemory(st).getPrefs()).toEqual({
      ...DEFAULT_PREFS,
      rate: 1.5,
      volume: 0.2,
      loop: "all",
      dock: { x: 1, y: 2, w: 300, h: 200 },
    });
    expect(stored(st).prefs.rate).toBe(1.5);
  });

  it("dock：合法保存；太小被清成 null；null 可以清空；getPrefs / setPrefs 返回的 dock 是副本", () => {
    const mem = createMediaMemory(makeStorage());
    const set = mem.setPrefs({ dock: { x: 10, y: 20, w: 400, h: 300 } });
    expect(set.dock).toEqual({ x: 10, y: 20, w: 400, h: 300 });
    set.dock!.x = 999;
    const got = mem.getPrefs();
    expect(got.dock).toEqual({ x: 10, y: 20, w: 400, h: 300 });
    got.dock!.w = 1;
    expect(mem.getPrefs().dock!.w).toBe(400);
    expect(mem.setPrefs({ dock: { x: 0, y: 0, w: 50, h: 50 } }).dock).toBeNull();
    mem.setPrefs({ dock: { x: 10, y: 20, w: 400, h: 300 } });
    expect(mem.setPrefs({ dock: null }).dock).toBeNull();
    expect(mem.getPrefs().dock).toBeNull();
  });

  it("setPrefs 不影响已记的文件", () => {
    const mem = createMediaMemory(makeStorage());
    mem.savePosition("/a.mp4", 5, 10);
    mem.setPrefs({ rate: 2 });
    expect(mem.getFile("/a.mp4")?.position).toBe(5);
  });

  it("文件记录与偏好共用同一个 key：互相写入不会覆盖对方", () => {
    const st = makeStorage();
    const mem = createMediaMemory(st);
    mem.setPrefs({ rate: 2 });
    mem.savePosition("/a.mp4", 5, 10);
    const s = stored(st);
    expect(s.prefs.rate).toBe(2);
    expect(s.files["/a.mp4"]!.position).toBe(5);
    expect([...st.map.keys()]).toEqual([MEDIA_MEMORY_KEY]);
  });
});

describe("storage 不可用 / 出错：不崩", () => {
  it("storage 为 null：全部操作可用，只是只存在内存里", () => {
    const mem = createMediaMemory(null);
    expect(() => {
      mem.savePosition("/a.mp4", 5, 10);
      mem.setPrefs({ rate: 2 });
    }).not.toThrow();
    expect(mem.getFile("/a.mp4")).toMatchObject({ position: 5 });
    expect(mem.getPrefs().rate).toBe(2);
    expect(mem.getFile("/none.mp4")).toBeNull();
  });

  it("setItem 抛错（配额满 / 隐私模式）：不崩，内存状态照常更新", () => {
    const st = makeStorage();
    st.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const mem = createMediaMemory(st);
    expect(() => {
      mem.savePosition("/a.mp4", 5, 10);
      mem.setPrefs({ volume: 0.5 });
    }).not.toThrow();
    expect(mem.getFile("/a.mp4")).toMatchObject({ position: 5 });
    expect(mem.getPrefs().volume).toBe(0.5);
  });

  it("getItem 抛错：当作没有数据，之后照常工作", () => {
    const st = makeStorage();
    st.getItem = () => {
      throw new Error("SecurityError");
    };
    const mem = createMediaMemory(st);
    expect(mem.getFile("/a.mp4")).toBeNull();
    expect(mem.getPrefs()).toEqual(DEFAULT_PREFS);
    mem.savePosition("/a.mp4", 3, 9);
    expect(mem.getFile("/a.mp4")?.position).toBe(3);
  });

  it("只在第一次访问时读 storage（之后用内存状态，不反复解析）", () => {
    const st = makeStorage();
    let reads = 0;
    const base = st.getItem;
    st.getItem = (k) => {
      reads += 1;
      return base(k);
    };
    const mem = createMediaMemory(st);
    expect(reads).toBe(0);
    mem.getFile("/a.mp4");
    mem.savePosition("/a.mp4", 1, 2);
    mem.getPrefs();
    mem.setPrefs({ rate: 2 });
    expect(reads).toBe(1);
  });
});

describe("resumePositionFor", () => {
  it("没有记录 / 位置非法 → 0", () => {
    expect(resumePositionFor(null, 100)).toBe(0);
    expect(resumePositionFor({ position: Number.NaN }, 100)).toBe(0);
    expect(resumePositionFor({ position: Number.POSITIVE_INFINITY }, 100)).toBe(0);
    expect(resumePositionFor({ position: -5 }, 100)).toBe(0);
  });

  it("靠近开头（<= 3 秒）不续播：恰好 3 秒也算，刚过 3 秒才续播", () => {
    expect(resumePositionFor({ position: 0 }, 100)).toBe(0);
    expect(resumePositionFor({ position: 2.9 }, 100)).toBe(0);
    expect(resumePositionFor({ position: 3 }, 100)).toBe(0);
    expect(resumePositionFor({ position: 3.01 }, 100)).toBe(3.01);
  });

  it("靠近结尾（距结尾 <= 3 秒）不续播：恰好 duration - 3 也算，再早一点才续播", () => {
    expect(resumePositionFor({ position: 96.99 }, 100)).toBe(96.99);
    expect(resumePositionFor({ position: 97 }, 100)).toBe(0);
    expect(resumePositionFor({ position: 99.9 }, 100)).toBe(0);
    expect(resumePositionFor({ position: 100 }, 100)).toBe(0);
  });

  it("记着的位置超过当前时长（文件被换成更短的）→ 0", () => {
    expect(resumePositionFor({ position: 150 }, 100)).toBe(0);
  });

  it("中间位置原样续播", () => {
    expect(resumePositionFor({ position: 50 }, 100)).toBe(50);
    expect(resumePositionFor({ position: 12.5 }, 600)).toBe(12.5);
  });

  it("时长未知（0 / NaN / Infinity / 负数）：没法判断结尾，只按开头规则", () => {
    for (const d of [0, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(resumePositionFor({ position: 50 }, d), String(d)).toBe(50);
      expect(resumePositionFor({ position: 2 }, d), String(d)).toBe(0);
    }
  });

  it("很短的文件（< 6 秒）：开头与结尾区间重叠，任何位置都从头播", () => {
    for (const p of [0.5, 2, 3.5, 4, 5.5]) {
      expect(resumePositionFor({ position: p }, 6), String(p)).toBe(0);
    }
  });

  it("接受完整的 MediaFileMemory", () => {
    const mem = createMediaMemory(makeStorage());
    mem.savePosition("/a.mp4", 40, 100);
    expect(resumePositionFor(mem.getFile("/a.mp4"), 100)).toBe(40);
  });
});
