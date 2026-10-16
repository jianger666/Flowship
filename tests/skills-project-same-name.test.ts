/**
 * S13-06：多个仓有同名项目级 skill 时，React key 不能重复、「查看」要按 仓+名 读取。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pickSkillHit } from "@/lib/server/app-skills";

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf-8");

describe("pickSkillHit", () => {
  const all = [
    { name: "lint", source: "global-std" as const },
    { name: "lint", source: "project-std" as const, repoPath: "/work/a" },
    { name: "lint", source: "project-std" as const, repoPath: "/work/b/" },
  ];

  it("不带 repo：沿用旧行为（首个命中）", () => {
    expect(pickSkillHit(all, "lint", "project-std")?.repoPath).toBe("/work/a");
  });

  it("带 repo：命中指定仓而不是第一个（尾斜杠不敏感）", () => {
    expect(pickSkillHit(all, "lint", "project-std", "/work/b")?.repoPath).toBe(
      "/work/b/",
    );
    expect(pickSkillHit(all, "lint", "project-std", "/work/b/")?.repoPath).toBe(
      "/work/b/",
    );
  });

  it("repo 不在列表里 → 不回落到别的仓", () => {
    expect(pickSkillHit(all, "lint", "project-std", "/work/c")).toBeUndefined();
  });

  it("不带 source 也能按名命中", () => {
    expect(pickSkillHit(all, "lint")?.source).toBe("global-std");
    expect(pickSkillHit(all, "nope")).toBeUndefined();
  });
});

describe("接线契约", () => {
  it("列表 key 带仓标识", () => {
    expect(read("src/components/settings/skills-panel/skill-list-pane.tsx")).toContain(
      '${s.repoPath ?? ""}:${s.name}',
    );
  });
  it("查看按仓传参：row → card → API → server", () => {
    expect(read("src/components/settings/skills-panel/skill-row.tsx")).toContain(
      "onView(s.name, s.source, s.repoPath)",
    );
    expect(read("src/components/settings/skills-card.tsx")).toContain(
      "&repo=${encodeURIComponent(repoPath)}",
    );
    expect(read("src/app/api/skills/content/route.ts")).toContain(
      "readSkillContentByName(name, source, repo)",
    );
  });
});
