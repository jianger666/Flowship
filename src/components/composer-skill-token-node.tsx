/**
 * Composer skill token 的 Lexical DecoratorNode。
 *
 * 为什么用 DecoratorNode 而不是带样式的 TextNode：
 * - 光标进不去内部、Backspace/Delete 天然整删（原子节点）
 * - decorate() 渲染品牌色 tag，视觉跟旧 mirror overlay 对齐
 * - getTextContent() 仍是 `/skill-name`，对外协议 / 复制粘贴保持纯文本形态
 */

import type { JSX } from "react";
import { Sparkles } from "lucide-react";
import {
  DecoratorNode,
  type DOMExportOutput,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";

export type SerializedSkillTokenNode = Spread<
  { name: string; type: "skill-token"; version: 1 },
  SerializedLexicalNode
>;

/** 视觉：品牌色 tag，显示 `/skill-name`（光标不可入内） */
const SkillTokenView = ({ name }: { name: string }) => (
  <span
    className="mx-0.5 inline-flex items-center gap-0.5 rounded bg-primary/20 px-1 py-px align-baseline text-sm leading-normal text-primary ring-1 ring-inset ring-primary/30"
    contentEditable={false}
    data-skill-token={name}
  >
    <Sparkles className="size-3 shrink-0 opacity-80" aria-hidden />
    <span className="font-medium">{`/${name}`}</span>
  </span>
);

export class SkillTokenNode extends DecoratorNode<JSX.Element> {
  __name: string;

  static getType(): string {
    return "skill-token";
  }

  static clone(node: SkillTokenNode): SkillTokenNode {
    return new SkillTokenNode(node.__name, node.__key);
  }

  constructor(name: string, key?: NodeKey) {
    super(key);
    this.__name = name;
  }

  getName(): string {
    return this.__name;
  }

  /** 序列化 / 复制 / references 解析都靠这个纯文本形态 */
  getTextContent(): string {
    return `/${this.__name}`;
  }

  createDOM(): HTMLElement {
    const span = document.createElement("span");
    // 行内原子：跟周围文字同一行流排
    span.style.display = "inline-flex";
    span.style.verticalAlign = "baseline";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  /** 可选中整颗 token，但不能进内部编辑 */
  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(): JSX.Element {
    return <SkillTokenView name={this.__name} />;
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement("span");
    span.textContent = `/${this.__name}`;
    return { element: span };
  }

  exportJSON(): SerializedSkillTokenNode {
    return {
      type: "skill-token",
      version: 1,
      name: this.__name,
    };
  }

  static importJSON(serialized: SerializedSkillTokenNode): SkillTokenNode {
    return $createSkillTokenNode(serialized.name);
  }
}

export const $createSkillTokenNode = (name: string): SkillTokenNode =>
  new SkillTokenNode(name);

export const $isSkillTokenNode = (
  node: LexicalNode | null | undefined,
): node is SkillTokenNode => node instanceof SkillTokenNode;
