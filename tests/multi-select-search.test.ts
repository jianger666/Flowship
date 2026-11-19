/**
 * 选仓库时支持搜索（启动表单「目标仓库」/ 编辑任务里的「目标仓库」）。
 *
 * 没有 jsdom，弹层里敲字的手感不在这里验证（靠手测）；这里钉：
 * - 匹配规则（空格分词、都要命中、不分大小写、名称和路径都能搜）；
 * - 接线：MultiSelect 传了 getSearchText 才开搜索框并把过滤回调交给 Picker；两处仓库选择器都传了「名称 + 路径」。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { matchesSearchQuery, resolveEnterPick } from "@/lib/search-match";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf-8");

const REPOS = [
  { name: "app-bridge-sdk", path: "/Users/x/code/gitlab.wukongedu.net/frontend/app-bridge-sdk" },
  { name: "student-center", path: "/Users/x/code/gitlab.wukongedu.net/frontend/student-center" },
  { name: "infra", path: "/Users/x/code/gitlab.wukongedu.net/frontend/infra" },
  { name: "cp-class-advisor-center", path: "/Users/x/code/gitlab.wukongedu.net/frontend/cp-class-advisor-center" },
  { name: "sales-service", path: "/Users/x/code/gitlab.wukongedu.net/frontend/sales-service" },
  { name: "tracking-platform", path: "/Users/x/code/gitlab.wukongedu.net/frontend/tracking-platform" },
];
const search = (q: string): string[] =>
  REPOS.filter((r) => matchesSearchQuery(`${r.name} ${r.path}`, q)).map((r) => r.name);

describe("matchesSearchQuery", () => {
  it("空 / 全空白的搜索词：全部命中（没搜就是全列表）", () => {
    expect(matchesSearchQuery("anything", "")).toBe(true);
    expect(matchesSearchQuery("anything", "   ")).toBe(true);
    expect(search("")).toHaveLength(REPOS.length);
  });

  it("按仓库名子串搜，不分大小写", () => {
    expect(search("student")).toEqual(["student-center"]);
    expect(search("STUDENT")).toEqual(["student-center"]);
    expect(search("center")).toEqual(["student-center", "cp-class-advisor-center"]);
  });

  it("按路径搜（名称之外的目录名也能命中）", () => {
    expect(search("frontend/infra")).toEqual(["infra"]);
  });

  it("空格分词、每个词都要命中：`class center` 能找到 cp-class-advisor-center；多敲的空格不影响", () => {
    expect(search("class center")).toEqual(["cp-class-advisor-center"]);
    expect(search("  class   center  ")).toEqual(["cp-class-advisor-center"]);
    expect(search("student sales")).toEqual([]);
  });

  it("没有匹配 → 空（Picker 会显示「没有匹配…的项」）", () => {
    expect(search("no-such-repo")).toEqual([]);
  });
});

describe("resolveEnterPick：搜索框回车选哪一项", () => {
  const opts = [{ value: "a" }, { value: "b" }, { value: "c", disabled: true }];

  it("选第一个可选的匹配项（跳过被禁用的）", () => {
    expect(
      resolveEnterPick({ filtered: [{ value: "x", disabled: true }, ...opts], customCandidate: null, multiple: true, selectedKeys: [] }),
    ).toBe("a");
  });

  it("多选：第一项已经选中 → 不动（返回 null），回车不会把它 toggle 掉", () => {
    expect(resolveEnterPick({ filtered: opts, customCandidate: null, multiple: true, selectedKeys: ["a"] })).toBeNull();
    // 不改成「顺延选下一个」：用户看到的第一项就是回车的目标，选到别的项更意外
    expect(resolveEnterPick({ filtered: opts, customCandidate: null, multiple: true, selectedKeys: ["a", "b"] })).toBeNull();
  });

  it("多选：第一项没选、别的项选了 → 照常选第一项", () => {
    expect(resolveEnterPick({ filtered: opts, customCandidate: null, multiple: true, selectedKeys: ["b"] })).toBe("a");
  });

  it("单选：目标已选中也照常返回（重选同一项无副作用，保持原行为）", () => {
    expect(resolveEnterPick({ filtered: opts, customCandidate: null, multiple: false, selectedKeys: ["a"] })).toBe("a");
  });

  it("没有可选项 → 退回手填值；多选里手填值已选中同样不动；都没有 → null", () => {
    expect(resolveEnterPick({ filtered: [], customCandidate: "new-one", multiple: true, selectedKeys: [] })).toBe("new-one");
    expect(resolveEnterPick({ filtered: [{ value: "x", disabled: true }], customCandidate: "new-one", multiple: false, selectedKeys: [] })).toBe("new-one");
    expect(resolveEnterPick({ filtered: [], customCandidate: "new-one", multiple: true, selectedKeys: ["new-one"] })).toBeNull();
    expect(resolveEnterPick({ filtered: [], customCandidate: null, multiple: true, selectedKeys: [] })).toBeNull();
  });
});

describe("接线", () => {
  const multi = read("src/components/ui/multi-select.tsx");

  it("MultiSelect：传了 getSearchText 才开搜索，并把基于搜索文本的过滤交给 Picker；没传保持原样", () => {
    expect(multi).toContain("getSearchText?: (item: T) => string;");
    expect(multi).toContain("searchable={searchTextByKey !== null}");
    expect(multi).toContain("matchesSearchQuery(searchTextByKey.get(option.value) ?? option.value, query)");
    expect(multi).toMatch(/getSearchText\s*\?\s*new Map\(/);
    expect(multi).toContain(": null");
  });

  it.each([
    ["启动表单", "src/components/tasks/task-launch-form.tsx"],
    ["编辑任务", "src/components/tasks/edit-task-dialog.tsx"],
  ])("%s 的「目标仓库」选择器：搜索文本 = 名称 + 路径", (_name, file) => {
    const src = read(file);
    const at = src.indexOf("<MultiSelect<RepoConfig>");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("/>", src.indexOf("renderOption", at)));
    expect(block).toContain("getSearchText={(r) => `${r.name} ${r.path}`}");
    expect(block).toContain('searchPlaceholder="搜索仓库名 / 路径"');
  });

  it("Picker 搜索框回车走 resolveEnterPick（不再直接 pick 第一项）", () => {
    const picker = read("src/components/ui/picker.tsx");
    expect(picker).toContain('import { resolveEnterPick } from "@/lib/search-match";');
    expect(picker).toMatch(/resolveEnterPick\(\{[\s\S]*?multiple,[\s\S]*?selectedKeys,[\s\S]*?\}\)/);
    expect(picker).not.toContain("filtered.find((o) => !o.disabled)?.value ?? customCandidate");
  });
});
