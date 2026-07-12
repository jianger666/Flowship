/**
 * Composer skill token 的 Lexical 节点（TextNode 子类 + token 模式）。
 *
 * 为什么不用 DecoratorNode：decorator 是非文本节点、selection 落在它前沿时
 * 浏览器 contentEditable 摆不出可见 caret（实测「光标移到 tag 前就消失」）。
 * TextNode + `setMode("token")` 是 Lexical 官方 mention/tag 路线：
 * - token 模式天然原子：光标可停在前 / 后但进不去内部、Backspace/Delete 整删
 * - 文本内容就是 `/skill-name`，序列化 / 复制粘贴天然纯文本
 * - 样式走 createDOM 在真实文本 span 上加 class（代价：塞不了 React icon、可接受）
 */

import {
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

import { SKILL_TOKEN_CLASS } from "@/components/ui/skill-token";

export type SerializedSkillTokenNode = Spread<
  { name: string },
  SerializedTextNode
>;

export class SkillTokenNode extends TextNode {
  __name: string;

  static getType(): string {
    return "skill-token";
  }

  static clone(node: SkillTokenNode): SkillTokenNode {
    // afterCloneFrom 会拷 __mode/__format 等 TextNode 内部态、这里只管自有字段
    return new SkillTokenNode(node.__name, node.__text, node.__key);
  }

  constructor(name: string, text?: string, key?: NodeKey) {
    super(text ?? `/${name}`, key);
    this.__name = name;
  }

  getName(): string {
    return this.__name;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = SKILL_TOKEN_CLASS;
    dom.setAttribute("data-skill-token", this.__name);
    return dom;
  }

  /** 边界打字不并入 token：在前 / 后输入时让 Lexical 建独立 TextNode */
  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }

  isTextEntity(): boolean {
    return true;
  }

  exportJSON(): SerializedSkillTokenNode {
    return {
      ...super.exportJSON(),
      name: this.__name,
      type: "skill-token",
      version: 1,
    };
  }

  static importJSON(serialized: SerializedSkillTokenNode): SkillTokenNode {
    // updateFromJSON 恢复 text/mode/format 等 TextNode 序列化字段
    return $createSkillTokenNode(serialized.name).updateFromJSON(serialized);
  }
}

export const $createSkillTokenNode = (name: string): SkillTokenNode => {
  const node = new SkillTokenNode(name);
  // token 模式：原子（光标不入内、整删）；必须在创建处设、clone/importJSON 自动继承
  node.setMode("token");
  return node;
};

export const $isSkillTokenNode = (
  node: LexicalNode | null | undefined,
): node is SkillTokenNode => node instanceof SkillTokenNode;
