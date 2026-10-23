/**
 * 改动面板文件树纯逻辑：分组 / 排序 / 目录压缩 / 汇总 / 拍平 / 导航顺序。
 * 守的核心语义：结果不依赖输入顺序；压缩链只改展示、不改汇总与相对顺序。
 */
import { describe, expect, it } from "vitest";

import {
  allDirIds,
  ancestorDirIds,
  buildFileTree,
  flattenFileTree,
  treeFileOrder,
  type DirNode,
  type FileTreeNode,
  type TreeItem,
} from "@/lib/changes/file-tree";

const item = (
  path: string,
  added: number | null = 1,
  removed: number | null = 0,
  key: string = path,
): TreeItem<string> => ({ key, path, added, removed, data: `d:${key}` });

/** 把树压成可读的「缩进 + 名字」文本，断言形状用 */
const shape = (nodes: readonly FileTreeNode<string>[], depth = 0): string[] =>
  nodes.flatMap((n) =>
    n.type === "dir"
      ? [`${"  ".repeat(depth)}${n.name}/`, ...shape(n.children, depth + 1)]
      : [`${"  ".repeat(depth)}${n.name}`],
  );

const asDir = (n: FileTreeNode<string>): DirNode<string> => {
  if (n.type !== "dir") throw new Error("expected dir");
  return n;
};

/** 确定性洗牌（线性同余），避免测试随机 */
const shuffle = <T>(arr: readonly T[], seed: number): T[] => {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

describe("buildFileTree：分组与排序", () => {
  it("空输入返回空数组", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("按目录分组，同层目录在前、文件在后", () => {
    const tree = buildFileTree([
      item("README.md"),
      item("src/a.ts"),
      item("src/b.ts"),
      item("docs/x.md"),
      item("src/lib/c.ts"),
    ]);
    expect(shape(tree)).toEqual([
      "docs/",
      "  x.md",
      "src/",
      "  lib/",
      "    c.ts",
      "  a.ts",
      "  b.ts",
      "README.md",
    ]);
  });

  it("自然排序：a2 在 a10 前，且大小写不敏感", () => {
    const tree = buildFileTree([item("a10.ts"), item("a2.ts"), item("B.ts"), item("a1.ts")]);
    expect(shape(tree)).toEqual(["a1.ts", "a2.ts", "a10.ts", "B.ts"]);
  });

  it("目录同样自然排序", () => {
    const tree = buildFileTree([
      item("d10/x.ts"),
      item("d10/y.ts"),
      item("d2/x.ts"),
      item("d2/y.ts"),
    ]);
    expect(shape(tree).filter((l) => l.endsWith("/"))).toEqual(["d2/", "d10/"]);
  });

  it("根目录文件排在所有根目录之后", () => {
    const tree = buildFileTree([item("z.ts"), item("a/b.ts"), item("a/c.ts"), item("m.ts")]);
    expect(tree.map((n) => n.type)).toEqual(["dir", "file", "file"]);
    expect(tree.map((n) => n.name)).toEqual(["a", "m.ts", "z.ts"]);
  });

  it("文件节点 id = key、name = basename、item 原样透传", () => {
    const it1 = item("src/deep/f.ts", 3, 4, "repo1:src/deep/f.ts");
    const tree = buildFileTree([it1, item("src/deep/g.ts")]);
    const file = asDir(tree[0]).children[0];
    expect(file.type).toBe("file");
    expect(file.id).toBe("repo1:src/deep/f.ts");
    expect(file.name).toBe("f.ts");
    if (file.type === "file") expect(file.item).toBe(it1);
  });

  it("容忍多余斜杠", () => {
    const tree = buildFileTree([item("a//b.ts"), item("a/c.ts")]);
    expect(shape(tree)).toEqual(["a/", "  b.ts", "  c.ts"]);
  });
});

describe("buildFileTree：目录压缩", () => {
  it("单链压缩成 a/b/c，id 取最深目录完整路径", () => {
    const tree = buildFileTree([item("a/b/c/f.ts")]);
    expect(tree).toHaveLength(1);
    const dir = asDir(tree[0]);
    expect(dir.name).toBe("a/b/c");
    expect(dir.id).toBe("a/b/c");
    expect(dir.children.map((c) => c.name)).toEqual(["f.ts"]);
  });

  it("链中某层有文件则不压缩", () => {
    const tree = buildFileTree([item("a/x.ts"), item("a/b/c/f.ts")]);
    expect(shape(tree)).toEqual(["a/", "  b/c/", "    f.ts", "  x.ts"]);
    const a = asDir(tree[0]);
    expect(a.id).toBe("a");
    expect(asDir(a.children[0]).id).toBe("a/b/c");
  });

  it("链中有分叉则不压缩", () => {
    const tree = buildFileTree([item("a/b/x.ts"), item("a/c/y.ts")]);
    expect(shape(tree)).toEqual(["a/", "  b/", "    x.ts", "  c/", "    y.ts"]);
  });

  it("链顶压缩后再遇分叉：压缩只发生在无文件的单子目录链上", () => {
    const tree = buildFileTree([item("a/b/c/x.ts"), item("a/b/d/y.ts")]);
    const top = asDir(tree[0]);
    expect(top.name).toBe("a/b");
    expect(top.id).toBe("a/b");
    expect(top.children.map((c) => c.name)).toEqual(["c", "d"]);
  });

  it("压缩不改变同层目录的相对顺序（按链首目录名排序）", () => {
    const tree = buildFileTree([item("a/z/z/f.ts"), item("b/f.ts"), item("b/g.ts")]);
    expect(tree.map((n) => n.name)).toEqual(["a/z/z", "b"]);
  });
});

describe("buildFileTree：汇总", () => {
  it("目录合计 fileCount / added / removed 为整棵子树之和，null 当 0", () => {
    const tree = buildFileTree([
      item("src/a.ts", 10, 2),
      item("src/lib/b.ts", 5, 1),
      item("src/lib/bin.png", null, null),
      item("src/lib/c.ts", 1, null),
    ]);
    const src = asDir(tree[0]);
    expect(src.id).toBe("src");
    expect(src.fileCount).toBe(4);
    expect(src.added).toBe(16);
    expect(src.removed).toBe(3);
    const lib = asDir(src.children[0]);
    expect(lib.fileCount).toBe(3);
    expect(lib.added).toBe(6);
    expect(lib.removed).toBe(1);
  });

  it("压缩后的目录合计与未压缩时一致", () => {
    const tree = buildFileTree([item("a/b/c/x.ts", 3, 1), item("a/b/c/y.ts", 4, null)]);
    const dir = asDir(tree[0]);
    expect(dir.name).toBe("a/b/c");
    expect(dir.fileCount).toBe(2);
    expect(dir.added).toBe(7);
    expect(dir.removed).toBe(1);
  });
});

describe("buildFileTree：输入顺序无关与重复 path", () => {
  const sample = [
    item("src/lib/a.ts"),
    item("src/lib/a10.ts"),
    item("src/lib/a2.ts"),
    item("src/app/page.tsx"),
    item("src/app/deep/x/y/z.ts"),
    item("README.md"),
    item("package.json"),
    item("tests/a.test.ts"),
    item("tests/B.test.ts"),
    item("docs/one/two/three.md"),
  ];

  it("打乱输入顺序，结果完全相同", () => {
    const base = buildFileTree(sample);
    for (const seed of [1, 7, 42, 1234, 99999]) {
      expect(buildFileTree(shuffle(sample, seed))).toEqual(base);
    }
  });

  it("仅大小写不同的名字也有稳定顺序", () => {
    const xs = [item("A.ts"), item("a.ts")];
    const forward = shape(buildFileTree(xs));
    const backward = shape(buildFileTree([...xs].reverse()));
    expect(forward).toEqual(backward);
  });

  it("同一 path 出现两次：都保留、不抛错，靠 key 区分且顺序稳定", () => {
    const a = item("src/x.ts", 1, 0, "k1");
    const b = item("src/x.ts", 2, 0, "k2");
    const t1 = buildFileTree([a, b]);
    const t2 = buildFileTree([b, a]);
    expect(treeFileOrder(t1).map((i) => i.key)).toEqual(["k1", "k2"]);
    expect(treeFileOrder(t2).map((i) => i.key)).toEqual(["k1", "k2"]);
    expect(asDir(t1[0]).fileCount).toBe(2);
  });
});

describe("flattenFileTree", () => {
  const tree = buildFileTree([
    item("src/a.ts"),
    item("src/lib/b.ts"),
    item("src/lib/c.ts"),
    item("top.ts"),
  ]);

  it("无折叠时先序展开，depth 从 0 起", () => {
    const rows = flattenFileTree(tree, new Set());
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:src",
      "1:lib",
      "2:b.ts",
      "2:c.ts",
      "1:a.ts",
      "0:top.ts",
    ]);
  });

  it("折叠目录：自身仍输出一行，子孙不输出", () => {
    const rows = flattenFileTree(tree, new Set(["src/lib"]));
    expect(rows.map((r) => r.node.name)).toEqual(["src", "lib", "a.ts", "top.ts"]);
  });

  it("折叠外层目录，内层折叠态不影响输出", () => {
    const rows = flattenFileTree(tree, new Set(["src", "src/lib"]));
    expect(rows.map((r) => r.node.name)).toEqual(["src", "top.ts"]);
  });

  it("压缩链算一层深度，按最深目录 id 折叠", () => {
    const t = buildFileTree([item("a/b/c/x.ts"), item("a/b/c/y.ts"), item("z.ts")]);
    expect(flattenFileTree(t, new Set()).map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:a/b/c",
      "1:x.ts",
      "1:y.ts",
      "0:z.ts",
    ]);
    // 用中间层 id（压缩链里不存在）折叠无效
    expect(flattenFileTree(t, new Set(["a/b"])).length).toBe(4);
    expect(flattenFileTree(t, new Set(["a/b/c"])).map((r) => r.node.name)).toEqual(["a/b/c", "z.ts"]);
  });

  it("空树返回空数组", () => {
    expect(flattenFileTree([], new Set())).toEqual([]);
  });
});

describe("treeFileOrder / ancestorDirIds / allDirIds", () => {
  const tree = buildFileTree([
    item("src/lib/b.ts", 1, 0, "k-b"),
    item("src/a.ts", 1, 0, "k-a"),
    item("src/lib/deep/c.ts", 1, 0, "k-c"),
    item("src/lib/deep/d.ts", 1, 0, "k-d"),
    item("x/y/only.ts", 1, 0, "k-only"),
    item("root.ts", 1, 0, "k-root"),
  ]);

  it("treeFileOrder：先序、忽略折叠态，目录在前文件在后", () => {
    expect(treeFileOrder(tree).map((i) => i.key)).toEqual([
      "k-c",
      "k-d",
      "k-b",
      "k-a",
      "k-only",
      "k-root",
    ]);
  });

  it("treeFileOrder 与未折叠的 flatten 中文件出现顺序一致", () => {
    const fromFlat = flattenFileTree(tree, new Set())
      .map((r) => r.node)
      .flatMap((n) => (n.type === "file" ? [n.item.key] : []));
    expect(treeFileOrder(tree).map((i) => i.key)).toEqual(fromFlat);
  });

  it("ancestorDirIds：从根到文件的全部祖先目录 id", () => {
    expect(ancestorDirIds(tree, "k-c")).toEqual(["src", "src/lib", "src/lib/deep"]);
    expect(ancestorDirIds(tree, "k-a")).toEqual(["src"]);
  });

  it("ancestorDirIds：压缩链只返回一个 id", () => {
    expect(ancestorDirIds(tree, "k-only")).toEqual(["x/y"]);
  });

  it("ancestorDirIds：根文件与找不到都返回 []", () => {
    expect(ancestorDirIds(tree, "k-root")).toEqual([]);
    expect(ancestorDirIds(tree, "nope")).toEqual([]);
    expect(ancestorDirIds([], "k-a")).toEqual([]);
  });

  it("ancestorDirIds：传入目录 id 不会被当成文件", () => {
    expect(ancestorDirIds(tree, "src")).toEqual([]);
  });

  it("allDirIds：全部目录 id，先序", () => {
    expect(allDirIds(tree)).toEqual(["src", "src/lib", "src/lib/deep", "x/y"]);
    expect(allDirIds([])).toEqual([]);
  });
});
