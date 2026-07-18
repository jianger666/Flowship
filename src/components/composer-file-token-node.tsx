/**
 * Composer 文件引用 token 的 Lexical 节点（TextNode 子类 + token 模式）。
 *
 * 跟 SkillTokenNode 同构：token 模式原子整删、文本即 `@rel/path`（目录尾 `/`）、
 * 样式走 ui/skill-token 的 FILE_TOKEN_CLASS 单一来源。
 * 行区间 `:10-50` 不进本节点——选中后在 token 后手打纯文本即可。
 */

import {
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

import { FILE_TOKEN_CLASS } from "@/components/ui/skill-token";

export type SerializedFileTokenNode = Spread<
  { path: string },
  SerializedTextNode
>;

export class FileTokenNode extends TextNode {
  __path: string;

  static getType(): string {
    return "file-token";
  }

  static clone(node: FileTokenNode): FileTokenNode {
    return new FileTokenNode(node.__path, node.__text, node.__key);
  }

  constructor(filePath: string, text?: string, key?: NodeKey) {
    super(text ?? `@${filePath}`, key);
    this.__path = filePath;
  }

  getPath(): string {
    return this.__path;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = FILE_TOKEN_CLASS;
    dom.setAttribute("data-file-token", this.__path);
    return dom;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }

  isTextEntity(): boolean {
    return true;
  }

  exportJSON(): SerializedFileTokenNode {
    return {
      ...super.exportJSON(),
      path: this.__path,
      type: "file-token",
      version: 1,
    };
  }

  static importJSON(serialized: SerializedFileTokenNode): FileTokenNode {
    return $createFileTokenNode(serialized.path).updateFromJSON(serialized);
  }
}

export const $createFileTokenNode = (filePath: string): FileTokenNode => {
  const node = new FileTokenNode(filePath);
  node.setMode("token");
  return node;
};

export const $isFileTokenNode = (
  node: LexicalNode | null | undefined,
): node is FileTokenNode => node instanceof FileTokenNode;
