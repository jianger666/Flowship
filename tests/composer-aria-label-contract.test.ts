/**
 * 输入框可访问名称（第四轮 N2-06）
 *
 * 旧：Lexical 的 contenteditable 只有 aria-placeholder，没有可访问名称；同屏的底部输入条 /
 * 答题卡每题的自定义回答 / 推进弹窗指令对读屏用户全是「未命名文本框」。
 * 新：ComposerEditor 把调用方传入的 ariaLabel 透传给 ContentEditable，所有调用点各给一个互不重名的名字。
 * （含 JSX 的 .tsx 在 node 测试里不能直接渲染，这里用源码契约：扫所有调用点 + 名称唯一。）
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(import.meta.dirname, "..", "src");
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), "utf8");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
};

/** 取 `<Tag ...>` 开标签文本（到第一个顶层 `/>` 或 `>` 前的 props 区，容忍 props 里的箭头函数与模板串） */
const openingTagProps = (src: string, tag: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // 跳过注释 / 文档里提到的 `<RichInput …>`：真实用法后面紧跟空白 + props，且所在行不是注释行
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const linePrefix = src.slice(lineStart, m.index);
    if (/^\s*(\*|\/\/)/.test(linePrefix) || linePrefix.includes("{/*")) continue;
    if (!/\s/.test(src.charAt(m.index + m[0].length))) continue;
    let depth = 0;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length; i += 1) {
      const c = src[i]!;
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (depth === 0 && c === ">" && src[i - 1] !== "=") break;
    }
    out.push(src.slice(start, i));
  }
  return out;
};

describe("N2-06：每个输入框调用点都带唯一的 ariaLabel", () => {
  const files = walk(SRC).filter(
    (f) => !f.endsWith("rich-input.tsx") && !f.endsWith("conversation-composer.tsx"),
  );
  const uses: Array<{ file: string; tag: string; props: string }> = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const tag of ["RichInput", "ConversationComposer"]) {
      for (const props of openingTagProps(src, tag)) {
        uses.push({ file: path.relative(SRC, f), tag, props });
      }
    }
  }

  it("扫到的调用点覆盖已知 4 处（chat 输入岛 / task 跟 AI 说 / 答题卡 / 推进弹窗）", () => {
    const where = uses.map((u) => u.file).sort();
    expect(where).toEqual(
      [
        "components/tasks/advance-dialog.tsx",
        "components/tasks/ask-user-inline.tsx",
        "components/tasks/event-stream.tsx",
        "components/tasks/task-talk-composer.tsx",
      ].sort(),
    );
  });

  it("每个调用点都显式传了 ariaLabel", () => {
    for (const u of uses) {
      expect(u.props, `${u.file} 的 <${u.tag}> 缺 ariaLabel`).toMatch(/\bariaLabel=/);
    }
  });

  it("名称互不重名（同屏可区分）", () => {
    const labels = uses.map((u) => {
      const m = /\bariaLabel=(?:"([^"]+)"|\{`([^`]+)`\})/.exec(u.props);
      return (m?.[1] ?? m?.[2] ?? "").replace(/\$\{[^}]+\}/g, "N");
    });
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("链路透传：ConversationComposer → RichInput → ComposerEditor → ContentEditable", () => {
    expect(read("components", "conversation-composer.tsx")).toMatch(/ariaLabel=\{ariaLabel\}/);
    expect(read("components", "rich-input.tsx")).toMatch(/ariaLabel=\{ariaLabel\}/);
    const editor = read("components", "composer-editor.tsx");
    expect(editor).toMatch(/ariaLabel=\{ariaLabel \?\? "消息输入框"\}/);
  });

  it("答题卡的名字带题号（多题同屏可区分）", () => {
    expect(read("components", "tasks", "ask-user-inline.tsx")).toMatch(/ariaLabel=\{`[^`]*\$\{index\}[^`]*`\}/);
  });
});
