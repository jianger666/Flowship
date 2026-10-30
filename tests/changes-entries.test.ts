import { describe, expect, it } from "vitest";

import {
  entryKey,
  fileSignature,
  flattenEntries,
  nextUnviewed,
  orderedEntries,
  splitPath,
  stepEntry,
  viewedProgress,
  viewedSignature,
} from "@/lib/changes/entries";
import { parseFileQuery } from "@/lib/changes/file-filter";
import { isViewed, markViewed, type ViewedMap } from "@/lib/changes/viewed-store";
import type { TaskChangeFile, TaskRepoChanges } from "@/lib/types";

const file = (path: string, over: Partial<TaskChangeFile> = {}): TaskChangeFile => ({
  path,
  status: "modified",
  added: 1,
  removed: 0,
  binary: false,
  untracked: false,
  absolutePath: `/repo/${path}`,
  ...over,
});

const repo = (
  repoPath: string,
  files: TaskChangeFile[],
  over: Partial<TaskRepoChanges> = {},
): TaskRepoChanges => ({
  repoPath,
  shortName: repoPath.split("/").pop() ?? repoPath,
  workDir: repoPath,
  isolated: false,
  branch: "feat/x",
  base: { kind: "merge-base", label: "origin/main", shortSha: "abc1234" },
  files,
  totals: { files: files.length, added: 0, removed: 0 },
  ...over,
});

const paths = (list: { file: TaskChangeFile }[]) => list.map((e) => e.file.path);
const NO_TERMS: string[] = [];

describe("entryKey / signature", () => {
  it("entryKey：同一路径在不同仓里不撞", () => {
    expect(entryKey("/a", "x.ts")).not.toBe(entryKey("/b", "x.ts"));
    expect(entryKey("/a", "x.ts")).toBe(entryKey("/a", "x.ts"));
  });

  it("viewedSignature：状态 / 统计 / 空白-only 任一变化都换签名", () => {
    const base = viewedSignature(file("a.ts"));
    expect(viewedSignature(file("a.ts"))).toBe(base);
    expect(viewedSignature(file("a.ts", { status: "added" }))).not.toBe(base);
    expect(viewedSignature(file("a.ts", { added: 2 }))).not.toBe(base);
    expect(viewedSignature(file("a.ts", { removed: 1 }))).not.toBe(base);
    expect(viewedSignature(file("a.ts", { whitespaceOnly: true }))).not.toBe(base);
  });

  it("未跟踪 → 已跟踪（agent 对它 git add 了一下）：签名不变——内容没动，「已查看」就不该变黄（R14 Q4-02）", () => {
    const base = viewedSignature(file("a.ts"));
    expect(viewedSignature(file("a.ts", { untracked: true }))).toBe(base);
    // 带指纹时同理
    const fp = "-..aaaaaaaaaaaa";
    expect(viewedSignature(file("a.ts", { untracked: true, fingerprint: fp }))).toBe(
      viewedSignature(file("a.ts", { fingerprint: fp })),
    );
    // diff 缓存键（带路径）也不因此变：add 之后不会重拉 diff、展开状态保留
    expect(fileSignature("/r", file("a.ts", { untracked: true }))).toBe(fileSignature("/r", file("a.ts")));
  });

  it("签名格式固定为 6 段、第 4 段恒为 0：用户 localStorage 里已存的「已查看」靠它沿用（R14 Q4-02）", () => {
    expect(viewedSignature(file("a.ts", { fingerprint: "x..y" }))).toBe("modified:1:0:0:0:x..y");
    expect(viewedSignature(file("a.ts", { fingerprint: "x..y", whitespaceOnly: true }))).toBe(
      "modified:1:0:0:1:x..y",
    );
    expect(
      viewedSignature(file("n.ts", { status: "added", added: 3, untracked: true, fingerprint: "-..zzz" })),
    ).toBe("added:3:0:0:0:-..zzz");
    // 没有指纹也保持 6 段（末段为空）
    expect(viewedSignature(file("a.ts"))).toBe("modified:1:0:0:0:");
    // 存量标记（按这个 6 段格式存下的）与新签名逐字相同 → 升级后仍判「已查看」
    const key = entryKey("/r", "a.ts");
    const stored: ViewedMap = markViewed({}, key, "modified:1:0:0:0:x..y");
    expect(isViewed(stored, key, viewedSignature(file("a.ts", { fingerprint: "x..y" })))).toBe(true);
  });

  it("文件级指纹变了就换签名——哪怕状态和行数一模一样（切分支 / 等量替换）", () => {
    const a = file("a.ts", { fingerprint: "aaaaaaaaaaaa..bbbbbbbbbbbb" });
    const b = file("a.ts", { fingerprint: "aaaaaaaaaaaa..cccccccccccc" });
    expect([a.status, a.added, a.removed]).toEqual([b.status, b.added, b.removed]);
    expect(viewedSignature(a)).not.toBe(viewedSignature(b));
    expect(viewedSignature(a)).toBe(viewedSignature(file("a.ts", { fingerprint: a.fingerprint })));
    // diff 缓存键（带路径）同理：指纹不同就不会命中旧分支的 diff
    expect(fileSignature("/r", a)).not.toBe(fileSignature("/r", b));
  });

  it("没有指纹（服务端没取到）时照常出签名，且与有指纹的不同", () => {
    const none = viewedSignature(file("a.ts"));
    expect(none).toBeTruthy();
    expect(none).not.toBe(viewedSignature(file("a.ts", { fingerprint: "x..y" })));
  });

  it("viewedSignature 不带路径（路径已经是 viewed 记录的 key）", () => {
    expect(viewedSignature(file("a.ts"))).toBe(viewedSignature(file("b.ts")));
  });

  it("fileSignature 带路径与仓：跨仓 / 跨文件不撞", () => {
    expect(fileSignature("/a", file("x.ts"))).not.toBe(fileSignature("/b", file("x.ts")));
    expect(fileSignature("/a", file("x.ts"))).not.toBe(fileSignature("/a", file("y.ts")));
  });

  it("二进制 / 未统计（added=null）也能出签名", () => {
    expect(viewedSignature(file("a.png", { added: null, removed: null, binary: true }))).toContain(
      "null",
    );
  });
});

describe("flattenEntries", () => {
  it("保持服务端顺序、带仓信息", () => {
    const entries = flattenEntries([
      repo("/r/web", [file("b.ts"), file("a.ts")]),
      repo("/r/api", [file("c.ts")]),
    ]);
    expect(paths(entries)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(entries.map((e) => e.repoShortName)).toEqual(["web", "web", "api"]);
    expect(entries[0].key).toBe(entryKey("/r/web", "b.ts"));
  });

  it("读不到的仓（unavailable）整个跳过", () => {
    const entries = flattenEntries([
      repo("/r/web", [file("a.ts")]),
      repo("/r/gone", [file("ghost.ts")], { unavailable: "not_git" }),
    ]);
    expect(paths(entries)).toEqual(["a.ts"]);
  });

  it("空输入 → 空数组", () => {
    expect(flattenEntries([])).toEqual([]);
  });
});

describe("orderedEntries", () => {
  const files = [file("z.ts"), file("src/b.ts"), file("src/a.ts"), file("lib/x.ts"), file("a.ts")];

  it("flat：服务端顺序原样", () => {
    const out = orderedEntries([repo("/r", files)], { treeMode: "flat", terms: NO_TERMS });
    expect(paths(out)).toEqual(["z.ts", "src/b.ts", "src/a.ts", "lib/x.ts", "a.ts"]);
  });

  it("tree：目录在前（自然排序）、文件在后——与文件树显示一致", () => {
    const out = orderedEntries([repo("/r", files)], { treeMode: "tree", terms: NO_TERMS });
    expect(paths(out)).toEqual(["lib/x.ts", "src/a.ts", "src/b.ts", "a.ts", "z.ts"]);
  });

  it("tree：结果不依赖服务端顺序", () => {
    const shuffled = [...files].reverse();
    const a = orderedEntries([repo("/r", files)], { treeMode: "tree", terms: NO_TERMS });
    const b = orderedEntries([repo("/r", shuffled)], { treeMode: "tree", terms: NO_TERMS });
    expect(paths(a)).toEqual(paths(b));
  });

  it("搜索过滤：多个词 AND、大小写不敏感", () => {
    const out = orderedEntries([repo("/r", files)], {
      treeMode: "flat",
      terms: parseFileQuery("SRC a"),
    });
    expect(paths(out)).toEqual(["src/a.ts"]);
  });

  it("过滤后什么都不剩 → 空数组", () => {
    const out = orderedEntries([repo("/r", files)], {
      treeMode: "tree",
      terms: parseFileQuery("nonexistent"),
    });
    expect(out).toEqual([]);
  });

  it("多仓：仓之间保持服务端顺序、仓内各自排序；unavailable 仓跳过", () => {
    const out = orderedEntries(
      [
        repo("/r/web", [file("b.ts"), file("dir/a.ts")]),
        repo("/r/bad", [file("ghost.ts")], { unavailable: "git_error" }),
        repo("/r/api", [file("z.ts"), file("a.ts")]),
      ],
      { treeMode: "tree", terms: NO_TERMS },
    );
    expect(out.map((e) => `${e.repoShortName}:${e.file.path}`)).toEqual([
      "web:dir/a.ts",
      "web:b.ts",
      "api:a.ts",
      "api:z.ts",
    ]);
  });

  it("同名文件在不同仓里各自保留（key 不撞）", () => {
    const out = orderedEntries(
      [repo("/r/web", [file("index.ts")]), repo("/r/api", [file("index.ts")])],
      { treeMode: "tree", terms: NO_TERMS },
    );
    expect(out).toHaveLength(2);
    expect(new Set(out.map((e) => e.key)).size).toBe(2);
  });

  it("条目携带的 file 对象就是服务端那一个（不复制）", () => {
    const f = file("a.ts");
    const out = orderedEntries([repo("/r", [f])], { treeMode: "flat", terms: NO_TERMS });
    expect(out[0].file).toBe(f);
  });
});

describe("stepEntry", () => {
  const order = flattenEntries([repo("/r", [file("a.ts"), file("b.ts"), file("c.ts")])]);
  const key = (p: string) => entryKey("/r", p);

  it("下一个 / 上一个", () => {
    expect(stepEntry(order, key("a.ts"), 1)?.file.path).toBe("b.ts");
    expect(stepEntry(order, key("c.ts"), -1)?.file.path).toBe("b.ts");
  });

  it("边界不回绕", () => {
    expect(stepEntry(order, key("c.ts"), 1)).toBeNull();
    expect(stepEntry(order, key("a.ts"), -1)).toBeNull();
  });

  it("当前文件不在顺序里：下一个 = 第一个、上一个 = 最后一个", () => {
    expect(stepEntry(order, "nope", 1)?.file.path).toBe("a.ts");
    expect(stepEntry(order, "nope", -1)?.file.path).toBe("c.ts");
    expect(stepEntry(order, null, 1)?.file.path).toBe("a.ts");
    expect(stepEntry(order, null, -1)?.file.path).toBe("c.ts");
  });

  it("空顺序 → null", () => {
    expect(stepEntry([], null, 1)).toBeNull();
    expect(stepEntry([], "x", -1)).toBeNull();
  });
});

describe("nextUnviewed / viewedProgress", () => {
  const order = flattenEntries([
    repo("/r", [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")]),
  ]);
  const key = (p: string) => entryKey("/r", p);
  const mark = (map: ViewedMap, ...ps: string[]): ViewedMap => {
    let m = map;
    for (const p of ps) {
      const e = order.find((x) => x.file.path === p);
      if (e) m = markViewed(m, e.key, e.viewedSig);
    }
    return m;
  };

  it("当前之后第一个没看过的", () => {
    const viewed = mark({}, "b.ts");
    expect(nextUnviewed(order, key("a.ts"), viewed)?.file.path).toBe("c.ts");
  });

  it("走到末尾回绕到开头继续找", () => {
    const viewed = mark({}, "d.ts", "a.ts");
    // 当前在 c：往后 d 已看 → 回绕 a 已看 → b 没看
    expect(nextUnviewed(order, key("c.ts"), viewed)?.file.path).toBe("b.ts");
  });

  it("全部看过（包括当前）→ null", () => {
    const viewed = mark({}, "a.ts", "b.ts", "c.ts", "d.ts");
    expect(nextUnviewed(order, key("b.ts"), viewed)).toBeNull();
  });

  it("只剩自己没看过：自己不算「下一个」→ null", () => {
    const viewed = mark({}, "a.ts", "c.ts", "d.ts");
    expect(nextUnviewed(order, key("b.ts"), viewed)).toBeNull();
  });

  it("看过之后又改了（签名变化）算没看过", () => {
    const stale = markViewed({}, key("b.ts"), "modified:99:99:0:0");
    expect(nextUnviewed(order, key("a.ts"), stale)?.file.path).toBe("b.ts");
  });

  it("当前文件不在顺序里：从头找第一个没看过的", () => {
    const viewed = mark({}, "a.ts");
    expect(nextUnviewed(order, "nope", viewed)?.file.path).toBe("b.ts");
    expect(nextUnviewed(order, null, viewed)?.file.path).toBe("b.ts");
  });

  it("空顺序 → null", () => {
    expect(nextUnviewed([], null, {})).toBeNull();
  });

  it("viewedProgress：只数签名对得上的", () => {
    const viewed = markViewed(mark({}, "a.ts", "b.ts"), key("c.ts"), "stale-sig");
    expect(viewedProgress(order, viewed)).toEqual({ viewed: 2, total: 4 });
    expect(viewedProgress([], viewed)).toEqual({ viewed: 0, total: 0 });
  });
});

describe("splitPath", () => {
  it("目录带尾斜杠、文件名非空", () => {
    expect(splitPath("src/lib/a.ts")).toEqual({ dir: "src/lib/", name: "a.ts" });
    expect(splitPath("a.ts")).toEqual({ dir: "", name: "a.ts" });
  });
});
