/**
 * Composer 的 Lexical 层行为测试（headless：真实 Lexical 编辑器、无 DOM）
 *
 * 第四轮 N2-01 / N2-05 / N2-02：
 * - N2-01 组字（IME）期间外部写回会让 Lexical 把「组字中」标记挪到无关新节点上 → 写回要延后到组字结束；
 * - N2-05 程序性写回（发送成功清空 / 失败恢复）不进撤销栈，Cmd+Z 不能把已发送内容请回来；
 * - N2-02 手打 `/plan` 后紧贴 `/review`：界面 pill 口径要与发送时 skillRefs（整段解析）口径一致。
 * 真机 IME 行为（浏览器怎么处理被移除的 DOM 文本节点）这里验证不了，见状态文件「需用户本机验证」。
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  createEditor,
  TextNode,
  UNDO_COMMAND,
  type LexicalEditor,
} from "lexical";

import { SkillTokenNode, $isSkillTokenNode } from "@/components/composer-skill-token-node";
import { FileTokenNode } from "@/components/composer-file-token-node";
import {
  $serializeToPlainText,
  $setRootFromPlainText,
  $transformSkillTokensInTextNode,
  createExternalValueWriter,
  runWhenNotComposing,
} from "@/lib/composer-lexical";
import { parseSkillTokens } from "@/lib/skill-token";

// @lexical/history 是 @lexical/react 的传递依赖（pnpm 下不能直接 import）：按真实路径用 ESM 方式加载，
// 与测试里的 `lexical` 是同一个模块实例（用 CJS require 会拿到另一份、命令对象对不上，撤销 / 清栈都不生效）
const reactDir = fs.realpathSync(
  path.join(import.meta.dirname, "..", "node_modules", "@lexical", "react"),
);
const historyEntry = path.join(reactDir, "..", "history", "dist", "LexicalHistory.node.mjs");
const H = (await import(/* @vite-ignore */ pathToFileURL(historyEntry).href)) as {
  createEmptyHistoryState: () => {
    undoStack: unknown[];
    redoStack: unknown[];
  };
  registerHistory: (
    editor: LexicalEditor,
    state: { undoStack: unknown[]; redoStack: unknown[] },
    delay: number,
  ) => () => void;
};

// token 节点只用到 ui/skill-token 里的 class 常量；该文件含 JSX、node 测试环境不能直接加载
vi.mock("@/components/ui/skill-token", () => ({
  SKILL_TOKEN_CLASS: "skill-token",
  FILE_TOKEN_CLASS: "file-token",
}));

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const makeEditor = (names: string[] = []) => {
  const editor = createEditor({
    nodes: [SkillTokenNode, FileTokenNode],
    onError: (e) => {
      throw e;
    },
  });
  const known = new Set(names);
  editor.registerNodeTransform(TextNode, (n) =>
    $transformSkillTokensInTextNode(n, known),
  );
  return { editor, known };
};

const textOf = (editor: LexicalEditor): string => {
  let t = "";
  editor.getEditorState().read(() => {
    t = $serializeToPlainText();
  });
  return t;
};

const tokenNames = (editor: LexicalEditor): string[] => {
  const out: string[] = [];
  editor.getEditorState().read(() => {
    for (const p of $getRoot().getChildren()) {
      for (const c of (p as unknown as { getChildren: () => unknown[] }).getChildren()) {
        if ($isSkillTokenNode(c as never)) {
          out.push((c as { getTextContent: () => string }).getTextContent());
        }
      }
    }
  });
  return out;
};

/** 把末尾文本节点设成「组字中」，模拟输入法正在预编辑 */
const startComposing = (editor: LexicalEditor): string => {
  let key = "";
  editor.update(
    () => {
      const p = $getRoot().getFirstChild() as unknown as {
        getLastChild: () => TextNode;
      };
      const t = p.getLastChild();
      key = t.getKey();
      $setCompositionKey(key);
    },
    { discrete: true },
  );
  return key;
};
const endComposing = (editor: LexicalEditor) =>
  editor.update(() => $setCompositionKey(null), { discrete: true });

describe("N2-01：组字期间外部写回延后到组字结束", () => {
  it("组字中写回只暂存：编辑器文本不动、组字标记仍在原节点上", async () => {
    const { editor, known } = makeEditor();
    editor.update(
      () => {
        $setRootFromPlainText("你好 ni", known);
        $getRoot().selectEnd();
      },
      { discrete: true },
    );
    const key = startComposing(editor);
    const writer = createExternalValueWriter({ editor, getKnownNames: () => known });

    const r = writer.write("旧草稿\n你好 ni", null);
    await settle();

    expect(r).toBe("deferred");
    expect(writer.hasPending()).toBe(true);
    expect(textOf(editor)).toBe("你好 ni"); // 预编辑字母没被整树重建冲掉
    expect(editor.isComposing()).toBe(true);
    // 组字节点没被移除、标记没被挪到别的节点
    let stillThere = false;
    editor.getEditorState().read(() => {
      stillThere = editor.getEditorState()._nodeMap.has(key);
    });
    expect(stillThere).toBe(true);
    writer.dispose();
  });

  it("组字结束后落地：写回原文在前、组字期间新敲的在后，并交还父级", async () => {
    const { editor, known } = makeEditor();
    editor.update(
      () => {
        $setRootFromPlainText("你好 ni", known);
        $getRoot().selectEnd();
      },
      { discrete: true },
    );
    startComposing(editor);
    const applied: string[] = [];
    const writer = createExternalValueWriter({
      editor,
      getKnownNames: () => known,
      onDeferredApplied: (t) => applied.push(t),
    });
    // 失败恢复：写回值 = 原文 + 换行 + 此刻草稿（含预编辑字母）
    writer.write("发送失败的原文\n你好 ni", null);
    // 用户继续组字，最后选词「你好 你」
    editor.update(
      () => {
        const t = $getRoot().getFirstChild() as unknown as { getLastChild: () => TextNode };
        t.getLastChild().setTextContent("你好 你");
      },
      { discrete: true },
    );
    expect(applied).toEqual([]); // 还在组字，不落地

    endComposing(editor);
    await settle();

    expect(applied).toEqual(["发送失败的原文\n你好 你"]);
    expect(textOf(editor)).toBe("发送失败的原文\n你好 你");
    expect(editor.isComposing()).toBe(false);
    expect(writer.hasPending()).toBe(false);
  });

  it("旧树能用：不在组字时写回照旧立刻生效（返回 applied）", async () => {
    const { editor, known } = makeEditor();
    const writer = createExternalValueWriter({ editor, getKnownNames: () => known });
    const r = writer.write("外部写入", null);
    await settle();
    expect(r).toBe("applied");
    expect(textOf(editor)).toBe("外部写入");
  });

  it("组字中连续两次写回：以最后一次为准，只落地一次", async () => {
    const { editor, known } = makeEditor();
    editor.update(
      () => {
        $setRootFromPlainText("ab", known);
        $getRoot().selectEnd();
      },
      { discrete: true },
    );
    startComposing(editor);
    const applied: string[] = [];
    const writer = createExternalValueWriter({
      editor,
      getKnownNames: () => known,
      onDeferredApplied: (t) => applied.push(t),
    });
    writer.write("甲\nab", null);
    writer.write("乙\nab", null);
    endComposing(editor);
    await settle();
    expect(applied).toEqual(["乙\nab"]);
  });

  it("写回值不以组字前草稿结尾（清空 / 整体替换）：以写回值为准", async () => {
    const { editor, known } = makeEditor();
    editor.update(
      () => {
        $setRootFromPlainText("abc", known);
        $getRoot().selectEnd();
      },
      { discrete: true },
    );
    startComposing(editor);
    const writer = createExternalValueWriter({ editor, getKnownNames: () => known });
    writer.write("", null);
    endComposing(editor);
    await settle();
    expect(textOf(editor)).toBe("");
  });

  it("runWhenNotComposing：不在组字立刻执行；组字中等到结束再执行一次", async () => {
    const { editor, known } = makeEditor();
    editor.update(() => $setRootFromPlainText("x", known), { discrete: true });
    let n = 0;
    runWhenNotComposing(editor, () => (n += 1));
    expect(n).toBe(1);
    startComposing(editor);
    runWhenNotComposing(editor, () => (n += 1));
    expect(n).toBe(1);
    endComposing(editor);
    await settle();
    expect(n).toBe(2);
  });

  it("对照（缺陷本身）：组字中直接整树重建 → 组字标记被挪到无关的新节点", () => {
    const { editor, known } = makeEditor();
    editor.update(
      () => {
        $setRootFromPlainText("你好 ni", known);
        $getRoot().selectEnd();
      },
      { discrete: true },
    );
    const oldKey = startComposing(editor);
    // 旧实现的 ExternalValuePlugin 体：无守卫直接整树重建 + selectEnd
    editor.update(
      () => {
        $setRootFromPlainText("旧草稿\n你好 ni", known);
        $getRoot().selectEnd();
      },
      { tag: "external-value", discrete: true },
    );
    expect(editor.isComposing()).toBe(true);
    let moved = false;
    editor.getEditorState().read(() => {
      moved = !editor.getEditorState()._nodeMap.has(oldKey);
    });
    expect(moved).toBe(true); // 旧组字节点被移除，标记却还挂着
  });
});

describe("N2-05：程序性写回不进撤销栈", () => {
  const setup = () => {
    const { editor, known } = makeEditor(["review"]);
    const hs = H.createEmptyHistoryState();
    H.registerHistory(editor, hs, 0);
    const writer = createExternalValueWriter({ editor, getKnownNames: () => known });
    return { editor, known, hs, writer };
  };
  const type = async (editor: LexicalEditor, known: Set<string>, base: string, more: string) => {
    editor.update(
      () => {
        $setRootFromPlainText(base, known);
        $getRoot().selectEnd();
      },
      { discrete: true },
    );
    await settle();
    editor.update(
      () => {
        const sel = $getSelection();
        if ($isRangeSelection(sel)) sel.insertText(more);
      },
      { discrete: true },
    );
    await settle();
  };

  it("发送成功清空后：撤销栈为空，Cmd+Z 不会把已发送内容请回来", async () => {
    const { editor, known, hs, writer } = setup();
    await type(editor, known, "请帮我 /review 这个", "改动");
    expect(textOf(editor)).toBe("请帮我 /review 这个改动");
    expect(hs.undoStack.length).toBeGreaterThan(0);

    writer.write("", null); // 发送成功 → reset() → value=""
    await settle();
    expect(textOf(editor)).toBe("");
    expect(hs.undoStack.length).toBe(0);
    expect(hs.redoStack.length).toBe(0);

    editor.dispatchCommand(UNDO_COMMAND, undefined);
    await settle();
    expect(textOf(editor)).toBe("");
  });

  it("失败恢复写回同理不进撤销栈", async () => {
    const { editor, known, hs, writer } = setup();
    await type(editor, known, "abc", "def");
    writer.write("恢复的原文\nabcdef", null);
    await settle();
    expect(textOf(editor)).toBe("恢复的原文\nabcdef");
    expect(hs.undoStack.length).toBe(0);
  });

  it("双击 Esc 清空（undoable）：保留进撤销栈，仍能撤回", async () => {
    const { editor, known, hs, writer } = setup();
    await type(editor, known, "abc", "def");
    const before = hs.undoStack.length;
    writer.write("", null, { undoable: true });
    await settle();
    expect(textOf(editor)).toBe("");
    expect(hs.undoStack.length).toBe(before + 1);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    await settle();
    expect(textOf(editor)).toBe("abcdef");
  });
});

describe("N2-02：手打相邻 token 的 pill 口径 = skillRefs（整段解析）口径", () => {
  const paragraphWith = (editor: LexicalEditor, texts: string[]) => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        root.append(p);
        for (const t of texts) p.append($createTextNode(t));
      },
      { discrete: true },
    );
  };
  /** 手打：在已有段落末尾再追加一个新文本节点（模拟 pill 之后继续打字） */
  const appendTyped = (editor: LexicalEditor, text: string) =>
    editor.update(
      () => {
        const p = $getRoot().getFirstChild() as unknown as {
          append: (n: unknown) => void;
        };
        p.append($createTextNode(text));
      },
      { discrete: true },
    );

  it("`/plan` 成 pill 后紧贴 `/review`：第二个保持纯文本（发送时 skillRefs 也只认 plan）", () => {
    const { editor, known } = makeEditor(["plan", "review"]);
    paragraphWith(editor, ["/plan"]);
    appendTyped(editor, "/review");
    const plain = textOf(editor);
    expect(plain).toBe("/plan/review");
    expect(tokenNames(editor)).toEqual(["/plan"]);
    expect(parseSkillTokens(plain, known).map((t) => t.name)).toEqual(["plan"]);
  });

  it("旧树能用：`/plan` 后空格再 `/review` → 两个 pill，skillRefs 也是两个", () => {
    const { editor, known } = makeEditor(["plan", "review"]);
    paragraphWith(editor, ["/plan"]);
    appendTyped(editor, " /review");
    expect(tokenNames(editor)).toEqual(["/plan", "/review"]);
    expect(parseSkillTokens(textOf(editor), known).map((t) => t.name)).toEqual(["plan", "review"]);
  });

  it("旧树能用：单节点内 `他/review`（CJK 前缀）照常成 pill", () => {
    const { editor } = makeEditor(["review"]);
    paragraphWith(editor, ["他/review"]);
    expect(tokenNames(editor)).toEqual(["/review"]);
  });

  it("旧树能用：行首 `/review` 照常成 pill", () => {
    const { editor } = makeEditor(["review"]);
    paragraphWith(editor, ["/review"]);
    expect(tokenNames(editor)).toEqual(["/review"]);
  });

  it("随机手打序列：画出的 pill 个数 = 整段解析出的 token 个数（500 例）", () => {
    let a = 20260521;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const PIECES = ["/plan", "/review", " ", "他", "，", "x", "/", "@a/b", "写 ", "\t"];
    let mismatches = 0;
    let withPill = 0;
    for (let i = 0; i < 500; i += 1) {
      const { editor, known } = makeEditor(["plan", "review"]);
      const n = 2 + Math.floor(rnd() * 4);
      const pieces: string[] = [];
      for (let k = 0; k < n; k += 1) pieces.push(PIECES[Math.floor(rnd() * PIECES.length)]!);
      paragraphWith(editor, [pieces[0]!]);
      for (const piece of pieces.slice(1)) appendTyped(editor, piece);
      const nodes = tokenNames(editor).length;
      const refs = parseSkillTokens(textOf(editor), known).length;
      if (nodes > 0) withPill += 1;
      if (nodes !== refs) mismatches += 1;
    }
    expect(withPill).toBeGreaterThan(100); // 语料确实产生了足量 pill，性质没空转
    expect(mismatches).toBe(0);
  });

  it("无已知 skill 时 transform 直接短路（不动节点）", () => {
    const { editor } = makeEditor([]);
    paragraphWith(editor, ["/review"]);
    expect(tokenNames(editor)).toEqual([]);
    let isText = false;
    editor.getEditorState().read(() => {
      const c = ($getRoot().getFirstChild() as unknown as { getFirstChild: () => unknown }).getFirstChild();
      isText = $isTextNode(c as never) && !$isSkillTokenNode(c as never);
    });
    expect(isText).toBe(true);
  });
});
