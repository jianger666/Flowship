/**
 * 带草稿的保存弹窗（编辑任务 / 自定义推进入口）：保存中按 Esc / X 不能直接关。
 *
 * 现状复盘：弹窗组件常驻、保存请求在途时 Esc / X 仍会关（只有「取消」按钮 disabled）；
 * 请求之后失败只剩一条 toast，而下次打开会按 task / editing 重灌草稿——用户的编辑内容丢了。
 * 与需求群弹窗（请求挂住时关不掉 → 改成放行）语义相反：这里是「保存」类、有草稿，选「保存中拦关闭 + 超时出口」。
 * 超时出口 = withTimeout（见 with-timeout.test.ts），保证挂住时 saving 会复位、不会变成关不掉。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe.each([
  {
    name: "EditTaskDialog",
    file: "src/components/tasks/edit-task-dialog.tsx",
    flag: "submitting",
  },
  {
    name: "CustomActionEditor",
    file: "src/components/custom-actions/custom-action-editor.tsx",
    flag: "saving",
  },
])("$name 保存中拦住关闭", ({ file, flag }) => {
  const src = read(file);

  it("Dialog 的 onOpenChange 走 handleOpenChange → guardCloseWhileBusy(忙标志, ...)（行为见 with-timeout.test.ts）", () => {
    expect(src).toMatch(/<Dialog open=\{open\} onOpenChange=\{handleOpenChange\}/);
    expect(src).toMatch(
      new RegExp(
        `const handleOpenChange = \\(next: boolean\\) =>\\s*guardCloseWhileBusy\\(${flag}, next, onOpenChange\\);`,
      ),
    );
  });

  it("保存请求包了超时出口（挂住时 finally 复位、不会关不掉）", () => {
    expect(src).toContain('from "@/lib/with-timeout"');
    expect(src).toMatch(/withTimeout\(/);
    expect(src).toMatch(/SAVE_TIMEOUT_MS/);
    // 复位在 finally 里：成功 / 失败 / 超时都走
    expect(src).toMatch(/finally \{\s*set(Submitting|Saving)\(false\);/);
  });

  it("成功路径仍直接调 props.onOpenChange(false)，不被保存中守卫挡住", () => {
    expect(src).toMatch(/onSaved\([a-z]+\);\s*onOpenChange\(false\);/);
  });
});
