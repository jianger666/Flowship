/** 本地文件链接的智能默认动作与显式打开方式入口接线契约。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSrc = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

const localFileLink = readSrc("src/components/ui/local-file-link.tsx");
const artifactPanel = readSrc("src/components/tasks/artifact-panel.tsx");

describe("本地文件打开方式", () => {
  it("行内链接支持右键菜单及全部显式动作", () => {
    expect(localFileLink).toContain("<ContextMenu>");
    expect(localFileLink).toContain("在浏览器打开");
    expect(localFileLink).toContain("在 Flowship 预览源码");
    expect(localFileLink).toContain("在文件管理器中显示");
    expect(localFileLink).toContain("复制路径");
    expect(localFileLink).toContain("右键选择打开方式");
  });

  it("产物区文件链接显示 hover 更多入口", () => {
    expect(artifactPanel).toContain("showActions");
    expect(localFileLink).toContain("浏览器打开");
    expect(localFileLink).toContain("Flowship 预览");
    expect(localFileLink).toContain("JUMP_IDE_LABEL[jumpIde]");
    expect(localFileLink).toContain("group-hover/local-file:opacity-100");
    expect(localFileLink).toContain("更多打开方式");
  });
});
