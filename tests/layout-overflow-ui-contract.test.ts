/**
 * 长路径 / 长文件名的 UI 回归契约。
 *
 * 这些组件在 node 测试环境没有真实布局引擎；这里锁住关键的 CSS 收缩链，
 * 实际视口宽度与横向滚动行为由桌面端冒烟覆盖。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf-8");

describe("长内容不撑破视口", () => {
  it("事件流 diff 标题受父宽约束，文件名截断，代码内容只在 diff 内横滚", () => {
    const toolBlock = source(
      "src/components/tasks/event-stream/tool-block.tsx",
    );

    expect(toolBlock).toContain("group/tool w-full min-w-0 max-w-full");
    expect(toolBlock).toContain(
      "flex w-full min-w-0 cursor-pointer items-center gap-1 text-left",
    );
    expect(toolBlock).toContain(
      'className="min-w-0 flex-1 truncate font-mono"',
    );
    expect(toolBlock).toContain(
      "max-h-64 w-full max-w-full overflow-auto",
    );
  });

  it("事件项、工作过程和复制容器保持连续的 min-width: 0 收缩链", () => {
    const eventStream = source("src/components/tasks/event-stream.tsx");
    const workGroup = source(
      "src/components/tasks/event-stream/work-group.tsx",
    );
    const copyButton = source("src/components/ui/copy-button.tsx");

    expect(eventStream).toContain('"min-w-0 max-w-full px-4"');
    expect(workGroup).toContain(
      "ml-2 mt-0.5 min-w-0 max-w-full space-y-0.5",
    );
    expect(copyButton).toContain(
      '"group/copyable relative min-w-0 max-w-full"',
    );
  });

  it("全局内容型基础组件限制在宿主或视口宽度内", () => {
    const markdown = source("src/components/markdown-text.tsx");
    const table = source("src/components/ui/table.tsx");
    const popover = source("src/components/ui/popover.tsx");
    const dialog = source("src/components/ui/dialog.tsx");
    const localPreview = source("src/components/ui/local-file-preview.tsx");

    expect(markdown).toContain(
      "dark:prose-invert min-w-0 max-w-full wrap-break-word",
    );
    expect(table).toContain(
      "relative min-w-0 w-full max-w-full overflow-x-auto",
    );
    expect(popover).toContain('max-w-[calc(100vw-1rem)]');
    expect(dialog).toContain("overflow-x-hidden overflow-y-auto");
    expect(localPreview).toContain(
      "max-h-[min(90vh,calc(100vh-48px))]",
    );
    expect(localPreview).toContain(
      "sm:max-w-[min(960px,80vw,calc(100vw-48px))]",
    );
    expect(localPreview).toContain("min-h-0 flex-1 overflow-x-hidden overflow-y-auto");
  });
});
