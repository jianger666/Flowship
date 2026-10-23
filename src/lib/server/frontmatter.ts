/**
 * 统一的 frontmatter 解析入口（SKILL.md / ACTION.md / *.mdc 等所有「读到别人写的 md」的地方都走这里）。
 *
 * 为什么不能直接 `matter(raw)`：
 * gray-matter 默认带 JavaScript 引擎，`---js` / `---javascript` 前言会被 `eval`，
 * 等于「读一个 SKILL.md = 以 server 进程权限执行任意代码」（能读到 config.json 里的明文密钥）。
 * 触发路径不需要用户确认：团队库同步后启动预热就会扫描、打开含恶意 `.agents/skills` 的仓库、
 * 导入 custom-action 包都会读到。`{ language: "yaml" }` 挡不住（前言里的语言标记优先），必须覆盖 engines。
 *
 * 做法（两层，缺一层都不算安全）：
 *   1. 语言白名单：`---` 后同一行只允许空 / yaml / yml / json，其它一律抛错（含 js / coffee / 任意原型链名）
 *   2. engines 层把 js / javascript 覆盖成「调用即抛错」，即使第 1 层被绕开也不会 eval
 *
 * 契约测试（tests/frontmatter-safe.test.ts 的「契约」一节）禁止 src / electron-app / scripts 里直接 import gray-matter。
 */
import matter from "gray-matter";

type FrontmatterFile = ReturnType<typeof matter>;

const denyEngine = {
  parse: (): never => {
    throw new Error("frontmatter 不支持 js / coffee 等可执行引擎");
  },
  stringify: (): never => {
    throw new Error("frontmatter 不支持 js / coffee 等可执行引擎");
  },
};

/** 允许出现在 `---` 同一行的语言标记（小写比较） */
const ALLOWED_LANGUAGES = new Set(["", "yaml", "yml", "json"]);

const BOM = "\uFEFF";

/**
 * 取开头 `---` 之后同一行的语言标记。
 * 与 gray-matter 的 `matter.language` 同口径：去 BOM → 必须以 `---` 开头 → 取到首个换行前的内容 trim。
 * 不是以 `---` 开头（没有 frontmatter）返回 ""。
 */
const readLanguageTag = (raw: string): string => {
  const str = raw.startsWith(BOM) ? raw.slice(1) : raw;
  if (!str.startsWith("---")) return "";
  // gray-matter：开头是 `----`（4 个及以上 `-`）视为「没有 frontmatter」（分隔线 / 装饰线），
  // 第 4 个 `-` 不是语言标记。不特判的话 `----\n# 标题` 会被当成语言「-」抛错，规则 / 技能文件被静默跳过
  if (str.charAt(3) === "-") return "";
  const rest = str.slice(3);
  const nl = rest.search(/\r?\n/);
  // gray-matter 对「--- 后面没有换行」取 slice(0, -1)，这里当成整段都是标记、一律走白名单判定
  return (nl === -1 ? rest : rest.slice(0, nl)).trim().toLowerCase();
};

/**
 * 解析 frontmatter（含正文）。返回结构与 `gray-matter` 一致（`data` / `content` 等）。
 * 前言使用了非白名单语言 → 抛错（调用方沿用原有的「解析失败 → 跳过 / 返回 null」处理）。
 */
export const parseFrontmatter = (raw: string): FrontmatterFile => {
  const lang = readLanguageTag(raw);
  if (!ALLOWED_LANGUAGES.has(lang)) {
    throw new Error(`frontmatter 不支持「${lang}」引擎（只允许 yaml / json）`);
  }
  return matter(raw, {
    engines: { js: denyEngine, javascript: denyEngine, coffee: denyEngine },
  });
};
