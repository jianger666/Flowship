/**
 * 改动面板左侧文件栏（FileList）的 SSR 冒烟：树 / 平铺、目录折叠、搜索高亮、已查看状态、
 * 选中标记、仓头部的基线与范围说明、各类「读不到」文案。
 *
 * 不验证视觉，只守结构契约——这些文案和属性就是用户能看到的信息，改坏了不会有人报错、只会悄悄看不懂。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { dirCollapseKey, FileList, type FileListProps } from "@/components/tasks/changes/file-list";
import { UNAVAILABLE_TEXT } from "@/components/tasks/changes/shared";
import { entryKey, viewedSignature } from "@/lib/changes/entries";
import { markViewed } from "@/lib/changes/viewed-store";
import type { TaskRepoChanges } from "@/lib/types";

import { makeFile, makeRepo } from "./helpers/changes-fixtures";

const REPO = "/work/app";
const FILES = [
  makeFile({ path: "src/components/a.tsx", added: 10, removed: 2 }),
  makeFile({ path: "src/lib/b.ts", status: "added", added: 5, removed: 0 }),
  makeFile({ path: "README.md", status: "deleted", added: 0, removed: 4 }),
];

const render = (over: Partial<FileListProps> = {}): string =>
  renderToStaticMarkup(
    createElement(FileList, {
      repos: [makeRepo({ files: FILES })],
      scopeKind: "branch",
      chat: false,
      treeMode: "tree",
      search: "",
      onSearchChange: () => {},
      searchRef: { current: null },
      selectedKey: null,
      onSelect: () => {},
      viewed: {},
      collapsed: new Set<string>(),
      onCollapsedChange: () => {},
      progress: { viewed: 0, total: 3 },
      error: null,
      ...over,
    }),
  );

const repoWith = (over: Partial<TaskRepoChanges>): TaskRepoChanges => makeRepo({ files: FILES, ...over });

describe("FileList：目录树", () => {
  const html = render();

  it("目录行 + 文件行：目录在前、文件名按文件显示", () => {
    expect(html).toContain(">src<");
    expect(html).toContain(">components<");
    expect(html).toContain(">lib<");
    expect(html).toContain(">a.tsx<");
    expect(html).toContain(">b.ts<");
    expect(html).toContain(">README.md<");
    // 目录排在根下的文件前
    expect(html.indexOf(">src<")).toBeLessThan(html.indexOf(">README.md<"));
  });

  it("三个目录行都是展开态，且各有可访问的展开状态", () => {
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(3);
    expect(html).not.toContain('aria-expanded="false"');
  });

  it("文件行带状态徽标（A / M / D）和增删统计", () => {
    expect(html).toContain(">M<");
    expect(html).toContain(">A<");
    expect(html).toContain(">D<");
    expect(html).toContain("+10");
    expect(html).toContain("−2");
  });

  it("折叠一个目录：它里面的文件不渲染，别处不受影响", () => {
    const folded = render({ collapsed: new Set([dirCollapseKey(REPO, "src")]) });
    expect(folded.match(/aria-expanded="false"/g)).toHaveLength(1);
    expect(folded).not.toContain(">a.tsx<");
    expect(folded).not.toContain(">b.ts<");
    expect(folded).toContain(">README.md<");
  });

  it("折叠状态按「仓 + 目录」存：另一个仓同名目录的折叠不会误伤这个仓", () => {
    const folded = render({ collapsed: new Set([dirCollapseKey("/work/other", "src")]) });
    expect(folded).toContain(">a.tsx<");
    expect(folded).not.toContain('aria-expanded="false"');
  });

  it("树模式有「展开 / 折叠全部目录」两个按钮", () => {
    expect(html).toContain('aria-label="展开全部目录"');
    expect(html).toContain('aria-label="折叠全部目录"');
  });
});

describe("FileList：平铺", () => {
  const html = render({ treeMode: "flat" });

  it("没有目录行、没有折叠按钮；文件名后面带目录", () => {
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain('aria-label="展开全部目录"');
    expect(html).toContain(">a.tsx<");
    expect(html).toContain("src/components");
    expect(html).toContain("src/lib");
  });

  it("根目录的文件没有目录后缀", () => {
    // README.md 在仓根：它的文件名 span 后面不会跟目录 span
    const i = html.indexOf(">README.md<");
    expect(i).toBeGreaterThan(-1);
    expect(html.slice(i, i + 80)).not.toContain("shrink-[100]");
  });
});

describe("FileList：筛选", () => {
  it("输入框有可访问名称与提示；有内容才出现「清空」", () => {
    const empty = render();
    expect(empty).toContain('aria-label="筛选文件"');
    expect(empty).toContain("按 / 聚焦");
    expect(empty).not.toContain('aria-label="清空筛选"');
    expect(render({ search: "tsx" })).toContain('aria-label="清空筛选"');
  });

  it("只留命中的文件，命中的字符加高亮", () => {
    const html = render({ search: "tsx" });
    expect(html).toContain(">a.");
    expect(html).toContain("<mark");
    expect(html).toContain("tsx</mark>");
    expect(html).not.toContain(">b.ts<");
    expect(html).not.toContain(">README.md<");
  });

  it("平铺模式下目录部分的命中也高亮", () => {
    const html = render({ treeMode: "flat", search: "comp" });
    expect(html).toContain("<mark");
    expect(html).toContain("comp</mark>onents");
  });

  it("搜索中目录强制展开：折叠着的目录里藏着命中项不能让人以为没搜到", () => {
    const html = render({ search: "tsx", collapsed: new Set([dirCollapseKey(REPO, "src")]) });
    expect(html).toContain("tsx</mark>");
    expect(html).not.toContain('aria-expanded="false"');
  });

  it("没有命中：提示「没有匹配的文件」", () => {
    expect(render({ search: "zzzz-not-exist" })).toContain("没有匹配的文件");
  });
});

describe("FileList：选中与已查看", () => {
  it("选中项带 data-selected + aria-current，且只有它一个", () => {
    const html = render({ selectedKey: entryKey(REPO, "src/lib/b.ts") });
    expect(html.match(/data-selected/g)).toHaveLength(1);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("多仓同名文件：key 带仓路径，选中其中一个不会连带点亮另一个", () => {
    const a = makeRepo({ repoPath: "/w/a", shortName: "a", files: [makeFile({ path: "x.ts" })] });
    const b = makeRepo({ repoPath: "/w/b", shortName: "b", files: [makeFile({ path: "x.ts" })] });
    const html = render({ repos: [a, b], selectedKey: entryKey("/w/a", "x.ts") });
    expect(html.match(/>x\.ts</g)).toHaveLength(2);
    expect(html.match(/data-selected/g)).toHaveLength(1);
  });

  it("已查看：显示对勾；没标记的没有", () => {
    const key = entryKey(REPO, "src/lib/b.ts");
    const viewed = markViewed({}, key, viewedSignature(FILES[1]));
    const html = render({ viewed });
    expect(html.match(/lucide-circle-check/g)).toHaveLength(1);
    expect(render()).not.toContain("lucide-circle-check");
  });

  it("标记之后文件又变了：显示警示图标而不是对勾（要重新看）", () => {
    const key = entryKey(REPO, "src/lib/b.ts");
    const html = render({ viewed: markViewed({}, key, "旧签名-已经对不上") });
    expect(html).toContain("lucide-circle-alert");
    expect(html).not.toContain("lucide-circle-check");
  });

  it("进度：文字 + 可读屏进度条；没有文件时不画进度条", () => {
    const html = render({ progress: { viewed: 1, total: 3 } });
    expect(html).toContain("已查看 1/3");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-valuemax="3"');
    expect(html).toContain("width:33%");
    expect(render({ repos: [makeRepo()], progress: { viewed: 0, total: 0 } })).not.toContain("progressbar");
  });
});

describe("FileList：文件行的特殊状态", () => {
  const one = (f: Parameters<typeof makeFile>[0]) => render({ repos: [makeRepo({ files: [makeFile(f)] })] });

  it("忽略空白后只剩空白改动：标「仅空白」而不是 0 行统计", () => {
    const html = one({ path: "a.ts", whitespaceOnly: true, added: 0, removed: 0 });
    expect(html).toContain("仅空白");
  });

  it("二进制：标「二进制」，没有 +/− 数字", () => {
    const html = one({ path: "logo.png", binary: true, added: null, removed: null });
    expect(html).toContain("二进制");
    expect(html).not.toContain("+null");
  });

  it("嵌套仓库：树视图与平铺视图里文件名都在（不是空的）、标「嵌套仓库」、没有 +/− 数字", () => {
    const nested = {
      path: "sub/nested",
      status: "added" as const,
      added: null,
      removed: 0,
      untracked: true,
      nestedRepo: true,
    };
    for (const treeMode of ["tree", "flat"] as const) {
      const html = render({ treeMode, repos: [makeRepo({ files: [makeFile(nested)] })] });
      expect(html, treeMode).toContain("嵌套仓库");
      expect(html, treeMode).not.toContain("+null");
      // 文件名那一格（font-medium）里要有「nested」——路径带尾斜杠时拆出来的文件名是空串
      expect(html, treeMode).toMatch(/font-mono font-medium[^"]*"[^>]*>(?:<[^>]+>)*nested/);
    }
    // 普通文件不带这个标注
    expect(one({ path: "a.ts" })).not.toContain("嵌套仓库");
  });
});

describe("FileList：仓头部", () => {
  it("基线行：相对谁的分叉点、领先 / 落后", () => {
    const html = render({ repos: [repoWith({ aheadOfBase: 2, behindBase: 3 })] });
    expect(html).toContain("相对 origin/main 的分叉点（abc1234）");
    expect(html).toContain("· 领先 2");
    expect(html).toContain("· 落后 3");
  });

  it("领先 / 落后为 0 就不显示", () => {
    const html = render({ repos: [repoWith({ aheadOfBase: 0, behindBase: 0 })] });
    expect(html).not.toContain("领先");
    expect(html).not.toContain("落后");
  });

  it("detached HEAD：显示「游离 HEAD」；有分支名时显示分支名", () => {
    expect(render({ repos: [repoWith({ branch: null })] })).toContain("游离 HEAD");
    const named = render({ repos: [repoWith({ branch: "feat/diff" })] });
    expect(named).toContain("feat/diff");
    expect(named).not.toContain("游离 HEAD");
  });

  it("降级成 HEAD（没找到线上分支）：基线行如实说只含未提交", () => {
    const html = render({
      repos: [repoWith({ base: { kind: "head", label: "HEAD", shortSha: "abc1234" } })],
    });
    expect(html).toContain("相对 HEAD · 未找到线上分支，只含未提交的改动");
  });

  it("手动基线失效：警告并说明已回落自动探测", () => {
    const html = render({
      repos: [repoWith({ baseOverride: { requested: "release/9", applied: false } })],
    });
    expect(html).toContain("手动选的基线 release/9 不可用");
    expect(html).toContain("已回落成自动探测");
    expect(render({ repos: [repoWith({ baseOverride: { requested: "release/9", applied: true } })] })).not.toContain(
      "不可用",
    );
  });

  it("多仓：每个仓都有自己的头部", () => {
    const a = makeRepo({ repoPath: "/w/a", shortName: "alpha", files: [makeFile({ path: "x.ts" })] });
    const b = makeRepo({ repoPath: "/w/b", shortName: "beta", files: [makeFile({ path: "y.ts" })] });
    const html = render({ repos: [a, b] });
    expect(html).toContain(">alpha<");
    expect(html).toContain(">beta<");
  });
});

describe("FileList：范围说明（仓头部下面那行小字）", () => {
  const note = (over: Partial<TaskRepoChanges>, props: Partial<FileListProps> = {}) =>
    render({ repos: [repoWith(over)], ...props });

  it("单个提交 / 仅未提交：直接说清范围", () => {
    expect(note({}, { scopeKind: "commit" })).toContain("只显示这个提交自己的改动");
    expect(note({}, { scopeKind: "uncommitted" })).toContain("只显示还没提交的改动");
  });

  it("当前就在线上分支本身：说明只剩未提交 / 未推送的", () => {
    expect(note({ onBaseBranch: true, branch: "main" })).toContain("当前就在线上分支 main 上");
  });

  it("chat：当前分支相对线上分支；找不到线上分支就提示手动选基线", () => {
    expect(note({}, { chat: true })).toContain("当前分支相对线上分支的全部改动（已提交 + 未提交）");
    expect(note({ branch: null }, { chat: true })).toContain("当前检出提交相对线上分支");
    const noBase = note({ base: { kind: "head", label: "HEAD", shortSha: "abc1234" } }, { chat: true });
    expect(noBase).toContain("没找到可对比的线上分支");
    expect(noBase).toContain("手动选一个基线");
  });

  it("task 直接在原仓干活：说明看到的是整条分支、不只是本任务的增量", () => {
    expect(note({ isolated: false })).toContain("任务直接在原仓库工作：显示当前分支的整体改动");
    expect(
      note({ isolated: false, base: { kind: "head", label: "HEAD", shortSha: "abc1234" } }),
    ).toContain("任务直接在原仓库工作，改动可能混有你本地原有的未提交内容");
  });

  it("task 在隔离 worktree 里：没有额外说明（改动就是它自己的）", () => {
    const html = note({ isolated: true });
    expect(html).not.toContain("任务直接在原仓库工作");
    expect(html).not.toContain("只显示");
  });

  it("读不到的仓不带范围说明", () => {
    const html = render({ repos: [makeRepo({ unavailable: "not_git", base: null })], chat: true });
    expect(html).not.toContain("当前分支相对线上分支");
  });
});

describe("FileList：读不到 / 没内容 / 被截断", () => {
  it("每种 unavailable 都展示对应的中文原因", () => {
    for (const [reason, text] of Object.entries(UNAVAILABLE_TEXT)) {
      const html = render({
        repos: [makeRepo({ unavailable: reason as keyof typeof UNAVAILABLE_TEXT, base: null })],
      });
      expect(html, reason).toContain(text);
    }
  });

  it("没有改动：提示「暂无改动」", () => {
    expect(render({ repos: [makeRepo({ files: [] })] })).toContain("暂无改动");
  });

  it("文件数超限被截断：说明只列了前多少个、一共多少个", () => {
    const html = render({
      repos: [
        makeRepo({
          files: FILES,
          filesTruncated: true,
          totals: { files: 1200, added: 0, removed: 0 },
        }),
      ],
    });
    expect(html).toContain("改动文件太多，仅列出前 3 个（共 1200 个）");
  });

  it("新建文件清单没读全：如实提示", () => {
    expect(render({ repos: [repoWith({ untrackedSkipped: true })] })).toContain("新建文件清单读取失败，可能没列全");
  });

  it("刷新失败：在列表顶上显示原因（保留旧数据不清空）", () => {
    const html = render({ error: "网络断了" });
    expect(html).toContain("刷新失败：网络断了");
    expect(html).toContain(">a.tsx<");
  });
});
