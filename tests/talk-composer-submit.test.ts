/**
 * task 说话条：发送 POST 期间编辑器不再锁灰（第二轮 review V5-01）
 *
 * 旧：`disabled={submitting}` + `useRichInput({ disabled: submitting })`——整个发送 POST
 * （长会话下 resume 要一两分钟）期间编辑器灰着不可编辑，POST 返回后不重新聚焦，
 * 期间按 Enter 静默 return。chat 输入岛只锁发送键。
 *
 * 新：
 * - 编辑器 / 附件动作不再 disabled；发送键仍 `submitting` 禁用 + 转圈（防双发）；
 * - 提交闩锁用 ref（同帧连按两次 Enter 时 state 还没刷新，state 挡不住）；
 *   提交中再按 Enter：静默、不重复发送，输入框里新敲的字原样保留（不清、不丢）；
 * - POST 返回后把焦点还回编辑器（只在焦点掉到 body / 停在输入条内按钮上时；用户已去别处不抢）；
 * - 因为发送期间输入框可能已经有新内容，**失败恢复**不能再整个覆盖：原文放前、新敲的接后。
 *
 * 纯函数测试 + 接线源码契约（UI 在 node 下跑不起来，见 vitest.config.ts）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shouldRefocusComposerAfterSend } from "@/lib/composer-refocus";
import { mergeRestoredList, mergeRestoredText } from "@/lib/talk-draft-merge";

const readSrc = (...seg: string[]): string =>
  readFileSync(
    path.resolve(import.meta.dirname, "..", "src", ...seg),
    "utf-8",
  );

const node = (name: string, inside: unknown[] = []) => ({
  name,
  contains: (other: unknown) => other === undefined ? false : inside.includes(other),
});

describe("shouldRefocusComposerAfterSend", () => {
  const body = { name: "body" };
  const editor = { name: "editor" };
  const sendButton = { name: "send" };
  const sidebarLink = { name: "sidebar" };
  const root = node("root", [editor, sendButton]);

  it("发送键被 disabled 后焦点掉到 body → 还给编辑器", () => {
    expect(
      shouldRefocusComposerAfterSend({
        sameTask: true,
        active: body,
        body,
        root,
        activeIsEditor: false,
      }),
    ).toBe(true);
  });

  it("无焦点元素（null）→ 还给编辑器", () => {
    expect(
      shouldRefocusComposerAfterSend({
        sameTask: true,
        active: null,
        body,
        root,
        activeIsEditor: false,
      }),
    ).toBe(true);
  });

  it("焦点停在输入条内的按钮上（点发送键提交的）→ 还给编辑器", () => {
    expect(
      shouldRefocusComposerAfterSend({
        sameTask: true,
        active: sendButton,
        body,
        root,
        activeIsEditor: false,
      }),
    ).toBe(true);
  });

  it("焦点本来就在编辑器里（Enter 提交的）→ 不动（别重设用户正在敲字的选区）", () => {
    expect(
      shouldRefocusComposerAfterSend({
        sameTask: true,
        active: editor,
        body,
        root,
        activeIsEditor: true,
      }),
    ).toBe(false);
  });

  it("用户已经把焦点放到别处（侧栏 / 别的输入框）→ 不抢", () => {
    expect(
      shouldRefocusComposerAfterSend({
        sameTask: true,
        active: sidebarLink,
        body,
        root,
        activeIsEditor: false,
      }),
    ).toBe(false);
  });

  it("发送返回时用户已切到别的任务 → 不抢（那是另一个任务的输入条）", () => {
    expect(
      shouldRefocusComposerAfterSend({
        sameTask: false,
        active: body,
        body,
        root,
        activeIsEditor: false,
      }),
    ).toBe(false);
  });

  it("root 取不到（已卸载）时，焦点在 body 才还；在别处不还", () => {
    expect(
      shouldRefocusComposerAfterSend({
        sameTask: true,
        active: body,
        body,
        root: null,
        activeIsEditor: false,
      }),
    ).toBe(true);
    expect(
      shouldRefocusComposerAfterSend({
        sameTask: true,
        active: sendButton,
        body,
        root: null,
        activeIsEditor: false,
      }),
    ).toBe(false);
  });
});

describe("mergeRestoredText：失败恢复不覆盖发送期间新敲的字", () => {
  it("输入框是空的（或只有空白）→ 原样恢复原文", () => {
    expect(mergeRestoredText("改一下登录页", "")).toBe("改一下登录页");
    expect(mergeRestoredText("改一下登录页", "  \n ")).toBe("改一下登录页");
  });

  it("原文为空（只发了图 / 路径）→ 保留用户新敲的", () => {
    expect(mergeRestoredText("", "新的一句")).toBe("新的一句");
  });

  it("两边一样 → 不重复拼接", () => {
    expect(mergeRestoredText("同一句", "同一句")).toBe("同一句");
  });

  it("用户已经敲了新内容 → 原文在前、新内容接在后（一个字都不丢）", () => {
    expect(mergeRestoredText("改一下登录页", "顺便看下注册页")).toBe(
      "改一下登录页\n顺便看下注册页",
    );
  });

  it("原文末尾带换行 / 空白不叠出空行", () => {
    expect(mergeRestoredText("原文\n\n", "新的")).toBe("原文\n新的");
  });
});

describe("mergeRestoredList：路径 / 图片失败恢复合并", () => {
  it("原有的在前、新加的在后，按 key 去重（保序）", () => {
    expect(
      mergeRestoredList(["/a", "/b"], ["/b", "/c"], (x) => x, 10),
    ).toEqual(["/a", "/b", "/c"]);
  });

  it("超上限从后面截断（恢复项优先保住）", () => {
    expect(
      mergeRestoredList(["/a", "/b"], ["/c", "/d", "/e"], (x) => x, 3),
    ).toEqual(["/a", "/b", "/c"]);
  });

  it("current 为空 → 原样返回恢复项；restored 为空 → 返回 current", () => {
    expect(mergeRestoredList(["/a"], [], (x) => x, 10)).toEqual(["/a"]);
    expect(mergeRestoredList([], ["/z"], (x) => x, 10)).toEqual(["/z"]);
  });

  it("对象按自定义 key（如图片 base64）去重", () => {
    const a = { id: "1", data: "AAA" };
    const dup = { id: "2", data: "AAA" };
    const b = { id: "3", data: "BBB" };
    expect(mergeRestoredList([a], [dup, b], (i) => i.data, 6)).toEqual([a, b]);
  });
});

describe("接线源码契约", () => {
  const src = readSrc("components", "tasks", "task-talk-composer.tsx");

  it("useRichInput 选项里不再有 disabled（附件 handler 也不因发送中被短路）", () => {
    const start = src.indexOf("useRichInput({");
    const block = src.slice(start, src.indexOf("});", start));
    expect(start).toBeGreaterThan(0);
    expect(block).not.toMatch(/disabled/);
  });

  it("ConversationComposer 不再给编辑器 disabled={submitting}；发送键仍靠 submitting={submitting}", () => {
    expect(src).not.toMatch(/disabled=\{submitting\}/);
    expect(src).toContain("submitting={submitting}");
  });

  it("提交闩锁用 ref：先于 state 判断、先于去重 toast，finally 里释放", () => {
    expect(src).toContain("submitLatchRef");
    const handle = src.slice(src.indexOf("const handleSubmit = async"));
    const latchCheck = handle.indexOf("submitLatchRef.current");
    expect(latchCheck).toBeGreaterThan(0);
    expect(latchCheck).toBeLessThan(handle.indexOf("getPendingQuestionSend(task.id)"));
    expect(handle).toMatch(/finally\s*\{[\s\S]*submitLatchRef\.current = false/);
  });

  it("POST 返回后还焦点：走 shouldRefocusComposerAfterSend、调 rich.focus、放在 finally 里（成功 / 失败 / 排队都覆盖）", () => {
    expect(src).toContain("shouldRefocusComposerAfterSend(");
    const fin = src.slice(src.lastIndexOf("finally {"));
    expect(fin).toContain("submitLatchRef.current = false");
    expect(fin).toMatch(/refocus\w*\(/);
    expect(src).toMatch(/rich\.focus\(\)/);
  });

  it("失败恢复走合并（原文在前、新敲的在后）；不再无脑 setValue 覆盖", () => {
    expect(src).toContain("mergeRestoredText(");
    expect(src).toContain("mergeRestoredList(");
    expect(src).not.toMatch(/\(t\) => rich\.setValue\(t\)/);
  });

  it("切模型 / 切提供方在发送飞行中仍禁用（busy 含 submitting）——那是另一回事、不随编辑器解锁", () => {
    expect(src).toMatch(/const busy = submitting \|\| isRunning/);
    expect(src).toMatch(/disabled=\{busy \|\| savingProvider/);
  });
});
