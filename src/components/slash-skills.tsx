"use client";

/**
 * 输入框 `/` 唤起 skill（Codex 式内联 token）
 *
 * 交互：
 * - 光标前正在打 `/xxx`（行首或空格后）→ 输入框上方弹 skill 菜单、继续打字过滤
 * - ↑↓ 选、Enter/Tab 确认、Esc 关；点击也可选
 * - 选中：把光标前的 `/partial` **补全成 `/skill-name `**（留在文本流里、可夹在任意文字中间）
 * - 高亮：Composer 用 mirror overlay 给命中的 `/skill-name` 铺品牌色底衬（见 composer.tsx）
 * - 发送时调 buildSkillPrefix() 拼消息头：点名让 AI 先 read 对应 SKILL.md 再执行；
 *   正文原样保留 `/skill-name` 字样
 *
 * 用法：const slash = useSlashSkills({ applyDraft }) 后把 slash 整个传给
 * <Composer slash={slash} />（菜单 / 键盘 / 光标同步都在 Composer 内接好）、
 * 发送时 text = slash.buildSkillPrefix() + text、成功后 slash.reset()（只清菜单态）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SlashSkill {
  name: string;
  description: string;
  absPath: string;
}

// 模块级缓存：skills 列表全局一份、多个输入框 / 反复挂载不重复拉。
// TTL 60s（审计 P1：永不失效会让「对话创建」刚建好的 skill 唤不起）——过期后
// 下一个输入框 mount 时重拉
const SKILLS_CACHE_TTL_MS = 60_000;
let skillsCache: SlashSkill[] | null = null;
let skillsCachedAt = 0;
let skillsInflight: Promise<SlashSkill[]> | null = null;

const fetchSkills = async (): Promise<SlashSkill[]> => {
  if (skillsCache && Date.now() - skillsCachedAt < SKILLS_CACHE_TTL_MS) {
    return skillsCache;
  }
  skillsCache = null;
  skillsInflight ??= fetch("/api/skills", { cache: "no-store" })
    .then((r) => r.json())
    .then((d: { skills?: Array<{ name?: string; description?: string; absPath?: string; enabled?: boolean }> }) => {
      // 同名多来源（builtin/app/cursor…）按扫描顺序去重取首个——跟 loadSkills 注入优先级一致；
      // v1.1.x：用户关掉的（enabled=false）不进菜单
      const seen = new Set<string>();
      const out: SlashSkill[] = [];
      for (const s of d.skills ?? []) {
        if (!s.name || !s.absPath || seen.has(s.name)) continue;
        seen.add(s.name);
        if (s.enabled === false) continue;
        out.push({ name: s.name, description: s.description ?? "", absPath: s.absPath });
      }
      skillsCache = out;
      skillsCachedAt = Date.now();
      skillsInflight = null; // 下次过期后能重新发起
      return out;
    })
    .catch(() => {
      skillsInflight = null; // 失败不缓存、下次重试
      return [] as SlashSkill[];
    });
  return skillsInflight;
};

// 光标前文本匹配「正在打 slash 词」：行首或空白后的 /xxx（xxx 允许空 = 刚打出 /）
const SLASH_RE = /(^|\s)\/([a-zA-Z0-9._-]*)$/;

/**
 * 全文扫描已完成的 skill token（与菜单触发同源：行首或空白后的 `/name`）。
 * 名字必须精确命中 knownNames 才算引用——打到一半的 `/ski` 不高亮、也不进 references。
 *
 * 边界：中文紧邻如「帮我/skill-creator建」因前面不是空白、不算 token（可接受）。
 */
export const SKILL_TOKEN_RE = /(^|\s)\/([a-zA-Z0-9._-]+)/g;

/** 一次匹配：前缀空白（或空）+ `/name` 整体 */
export interface SkillTokenMatch {
  /** `/name` 在全文中的起始下标（不含前导空白） */
  start: number;
  /** `/name` 结束下标（不含） */
  end: number;
  name: string;
}

/**
 * 从草稿解析命中已知 skill 的内联 token（去重前可重复出现）。
 * Composer overlay 与 hook.references 共用、避免两份正则漂移。
 */
export const parseSkillTokens = (
  text: string,
  knownNames: Set<string> | ReadonlySet<string>,
): SkillTokenMatch[] => {
  const out: SkillTokenMatch[] = [];
  // 每次调用重置 lastIndex（全局 g 标志会残留）
  SKILL_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SKILL_TOKEN_RE.exec(text)) !== null) {
    const name = m[2];
    if (!knownNames.has(name)) continue;
    // m[0] = 前导空白 + `/name`；token 本体从空白之后开始
    const full = m[0];
    const leading = m[1] ?? "";
    const start = m.index + leading.length;
    const end = start + full.length - leading.length;
    out.push({ start, end, name });
  }
  return out;
};

/**
 * 按出现顺序去重，映射成 SlashSkill[]（未知名已在 parse 阶段滤掉）。
 */
export const resolveSkillReferences = (
  text: string,
  skills: SlashSkill[],
): SlashSkill[] => {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const known = new Set(byName.keys());
  const seen = new Set<string>();
  const refs: SlashSkill[] = [];
  for (const t of parseSkillTokens(text, known)) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    const s = byName.get(t.name);
    if (s) refs.push(s);
  }
  return refs;
};

// 跨页 handoff：别处（如设置页「对话创建 skill」）跳转进对话前写入、
// 输入框 mount 时消费一次——往草稿头部插入 `/skill-name `（用完即删、不残留）
const PENDING_KEY = "fe-ai-flow:pending-slash-skill";

/** 跳转到对话页前调：让目标页输入框自动带上指定 skill 的内联 token */
export const setPendingSlashSkill = (name: string) => {
  try {
    sessionStorage.setItem(PENDING_KEY, name);
  } catch {
    /* sessionStorage 不可用、降级为用户自己 / 唤起 */
  }
};

export interface SlashSkillsApi {
  /** 菜单是否打开（有匹配的 slash 词 + 有候选） */
  menuOpen: boolean;
  /** 过滤后的候选（按 query 前缀 > 包含 排序） */
  filtered: SlashSkill[];
  /** 键盘高亮索引 */
  activeIndex: number;
  /**
   * 当前草稿里解析出的 skill 引用（去重、按出现序）。
   * 供发送拼 prefix；UI 高亮走 parseSkillTokens + mirror，不靠这个渲染 chip。
   */
  references: SlashSkill[];
  /** 已知 enabled skill 名集合——Composer mirror 解析 token 用 */
  knownNames: ReadonlySet<string>;
  /** textarea onChange 时调（传最新草稿 + 光标位置） */
  onDraftChange: (draft: string, cursor: number) => void;
  /** textarea onKeyDown 最前面调；返回 true = 事件已被菜单消费、调用方直接 return */
  onKeyDown: (e: KeyboardEvent) => boolean;
  /** 点击菜单项：把光标前 `/partial` 补全成 `/skill-name ` */
  pickAt: (index: number) => void;
  /** 发送时拼消息头（没引用返回空串）；调用方发送成功后调 reset() */
  buildSkillPrefix: () => string;
  /** 只清菜单态（不清草稿——草稿由调用方清） */
  reset: () => void;
}

export const useSlashSkills = (opts: {
  /** 当前草稿——references 从这里实时解析（单一真相、不另存 picked） */
  draft: string;
  /**
   * 选中 / pending 消费时把新草稿写回调用方 state。
   * 第二参 cursor：希望 textarea 落位的光标（补全后应在 token 尾空格之后）。
   */
  applyDraft: (next: string, cursor?: number) => void;
}): SlashSkillsApi => {
  // 全量 skills（首次用到时拉、模块级缓存）
  const [skills, setSkills] = useState<SlashSkill[]>([]);
  // 当前 slash 查询词（null = 没在打 slash、菜单关）
  const [query, setQuery] = useState<string | null>(null);
  // 键盘高亮索引
  const [activeIndex, setActiveIndex] = useState(0);
  // 最近一次 onDraftChange 的草稿 + 光标（选中时做文本替换用）
  const stateRef = useRef({ draft: opts.draft, cursor: opts.draft.length });

  const { applyDraft, draft } = opts;
  // applyDraft / draft 可能每次 render 都是新引用——ref 化避免 pending effect 依赖抖动
  const applyDraftRef = useRef(applyDraft);
  applyDraftRef.current = applyDraft;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    void fetchSkills().then(setSkills);
  }, []);

  // 跨页 handoff：skills 拉齐后再往草稿头插 `/name `（保证能命中 knownNames 才高亮）
  const pendingConsumedRef = useRef(false);
  useEffect(() => {
    if (skills.length === 0 || pendingConsumedRef.current) return;
    try {
      const pending = sessionStorage.getItem(PENDING_KEY);
      if (!pending) {
        pendingConsumedRef.current = true;
        return;
      }
      if (!skills.some((x) => x.name === pending)) {
        // 名单里没有：仍清掉 pending，避免反复尝试
        sessionStorage.removeItem(PENDING_KEY);
        pendingConsumedRef.current = true;
        return;
      }
      sessionStorage.removeItem(PENDING_KEY);
      pendingConsumedRef.current = true;
      const token = `/${pending} `;
      const cur = draftRef.current;
      // 已在空白边界上出现过同名 token → 不重复插（防 Strict Mode / 多输入框）
      if (parseSkillTokens(cur, new Set([pending])).length > 0) return;
      const next = token + cur;
      const cursor = token.length;
      stateRef.current = { draft: next, cursor };
      applyDraftRef.current(next, cursor);
    } catch {
      pendingConsumedRef.current = true;
    }
  }, [skills]);

  const knownNames = useMemo(
    () => new Set(skills.map((s) => s.name)),
    [skills],
  );

  const references = useMemo(
    () => resolveSkillReferences(draft, skills),
    [draft, skills],
  );

  const filtered = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    // 已引用的 skill 仍出现在菜单——用户可能想在另一处再补全一次
    const pool = skills;
    if (!q) return pool.slice(0, 8);
    const starts = pool.filter((s) => s.name.toLowerCase().startsWith(q));
    const contains = pool.filter(
      (s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q),
    );
    return [...starts, ...contains].slice(0, 8);
  }, [skills, query]);

  const menuOpen = query !== null && filtered.length > 0;

  const onDraftChange = useCallback((nextDraft: string, cursor: number) => {
    stateRef.current = { draft: nextDraft, cursor };
    const before = nextDraft.slice(0, cursor);
    const m = before.match(SLASH_RE);
    setQuery(m ? m[2] : null);
    setActiveIndex(0);
  }, []);

  const pickAt = useCallback(
    (index: number) => {
      const skill = filtered[index];
      if (!skill) return;
      const { draft: cur, cursor } = stateRef.current;
      const before = cur.slice(0, cursor);
      const m = before.match(SLASH_RE);
      if (!m) {
        setQuery(null);
        return;
      }
      // 把光标前的 `/partial` 补全成 `/skill-name `（尾空格让菜单自然关掉、方便继续打字）
      const cut = before.slice(0, before.length - (m[2].length + 1));
      const next = `${cut}/${skill.name} ${cur.slice(cursor)}`;
      const nextCursor = cut.length + skill.name.length + 2; // `/` + name + ` `
      stateRef.current = { draft: next, cursor: nextCursor };
      applyDraft(next, nextCursor);
      setQuery(null);
    },
    [filtered, applyDraft],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!menuOpen) return false;
      // IME 组合输入中（中文选词的 Enter / ↑↓）不归菜单——否则输入法候选操作被吞（审计 P1）
      if ((e.nativeEvent as globalThis.KeyboardEvent).isComposing) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickAt(activeIndex);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setQuery(null);
        return true;
      }
      return false;
    },
    [menuOpen, filtered.length, activeIndex, pickAt],
  );

  const buildSkillPrefix = useCallback(() => {
    if (references.length === 0) return "";
    return [
      "[使用 skill] 处理本条消息前、先逐个 read 以下 skill 并严格遵循：",
      ...references.map((p) => `- ${p.name}：${p.absPath}`),
      "",
      "",
    ].join("\n");
  }, [references]);

  const reset = useCallback(() => {
    // 只清菜单态；草稿由调用方清、references 随 draft prop 自然变空
    setQuery(null);
  }, []);

  return {
    menuOpen,
    filtered,
    activeIndex,
    references,
    knownNames,
    onDraftChange,
    onKeyDown,
    pickAt,
    buildSkillPrefix,
    reset,
  };
};

/** slash 菜单（挂在输入框容器内、absolute 浮在上方）。容器需要 relative。 */
export const SlashSkillMenu = ({ slash }: { slash: SlashSkillsApi }) => {
  if (!slash.menuOpen) return null;
  return (
    <div className="absolute bottom-full left-2 z-30 mb-1 w-80 max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border bg-popover shadow-md">
      <div className="max-h-64 overflow-y-auto p-1">
        {slash.filtered.map((s, i) => (
          <button
            key={s.name}
            type="button"
            // onMouseDown 防 textarea 失焦（blur 会先于 click 关菜单）
            onMouseDown={(e) => {
              e.preventDefault();
              slash.pickAt(i);
            }}
            className={cn(
              "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
              i === slash.activeIndex ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Sparkles className="size-3 text-primary" />
              {s.name}
            </span>
            {s.description && (
              <span className="line-clamp-1 text-[11px] text-muted-foreground">
                {s.description}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="border-t bg-muted/40 px-2.5 py-1 text-[10px] text-muted-foreground">
        ↑↓ 选择 · Enter 确认 · Esc 关闭
      </div>
    </div>
  );
};
