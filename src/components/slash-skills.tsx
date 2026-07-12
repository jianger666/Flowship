"use client";

/**
 * 输入框 `/` 唤起 skill（v1.0、用户点名「所有聊天框都可以用 / 唤起并高亮 skill」）
 *
 * 交互（对齐 Cursor / Claude Code 的 slash 菜单）：
 * - 光标前正在打 `/xxx`（行首或空格后）→ 输入框上方弹 skill 菜单、继续打字过滤
 * - ↑↓ 选、Enter/Tab 确认、Esc 关；点击也可选
 * - 选中：把文本里的 `/xxx` 摘掉、变成输入框上方的 **skill chip**（高亮可删）——
 *   不在 textarea 里做富文本高亮（overlay mirror 成本高、chip 更清晰）
 * - 发送时调 buildSkillPrefix() 拼消息头：点名让 AI 先 read 对应 SKILL.md 再执行
 *
 * 用法：const slash = useSlashSkills({ applyDraft }) 后把 slash 整个传给
 * <Composer slash={slash} />（菜单 / chips / 键盘 / 光标同步都在 Composer 内接好）、
 * 发送时 text = slash.buildSkillPrefix() + text、成功后 slash.reset()。
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

// 跨页 handoff：别处（如设置页「对话创建 skill」）跳转进对话前写入、
// 输入框 mount 时消费一次自动挂上对应 skill chip（用完即删、不残留）
const PENDING_KEY = "fe-ai-flow:pending-slash-skill";

/** 跳转到对话页前调：让目标页输入框自动带上指定 skill 的 chip */
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
  /** 已选 skill chips */
  picked: SlashSkill[];
  /** textarea onChange 时调（传最新草稿 + 光标位置） */
  onDraftChange: (draft: string, cursor: number) => void;
  /** textarea onKeyDown 最前面调；返回 true = 事件已被菜单消费、调用方直接 return */
  onKeyDown: (e: KeyboardEvent) => boolean;
  /** 点击菜单项选中 */
  pickAt: (index: number) => void;
  /** 移除一个 chip */
  removeSkill: (name: string) => void;
  /** 发送时拼消息头（没选 skill 返回空串）；调用方发送成功后调 reset() */
  buildSkillPrefix: () => string;
  reset: () => void;
}

export const useSlashSkills = (opts: {
  /** 选中 skill 后把摘掉 /token 的新草稿写回调用方 state */
  applyDraft: (next: string) => void;
}): SlashSkillsApi => {
  // 全量 skills（首次用到时拉、模块级缓存）
  const [skills, setSkills] = useState<SlashSkill[]>([]);
  // 当前 slash 查询词（null = 没在打 slash、菜单关）
  const [query, setQuery] = useState<string | null>(null);
  // 键盘高亮索引
  const [activeIndex, setActiveIndex] = useState(0);
  // 已选 chips
  const [picked, setPicked] = useState<SlashSkill[]>([]);
  // 最近一次 onDraftChange 的草稿 + 光标（选中时做文本替换用）
  const stateRef = useRef({ draft: "", cursor: 0 });

  useEffect(() => {
    void fetchSkills().then((list) => {
      setSkills(list);
      // 消费跨页 handoff（setPendingSlashSkill 写入的）：自动挂 chip
      try {
        const pending = sessionStorage.getItem(PENDING_KEY);
        if (pending) {
          sessionStorage.removeItem(PENDING_KEY);
          const s = list.find((x) => x.name === pending);
          if (s) {
            setPicked((prev) =>
              prev.some((p) => p.name === s.name) ? prev : [...prev, s],
            );
          }
        }
      } catch {
        /* 忽略 */
      }
    });
  }, []);

  const filtered = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const pickedNames = new Set(picked.map((p) => p.name));
    const pool = skills.filter((s) => !pickedNames.has(s.name));
    if (!q) return pool.slice(0, 8);
    const starts = pool.filter((s) => s.name.toLowerCase().startsWith(q));
    const contains = pool.filter(
      (s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q),
    );
    return [...starts, ...contains].slice(0, 8);
  }, [skills, query, picked]);

  const menuOpen = query !== null && filtered.length > 0;

  const onDraftChange = useCallback((draft: string, cursor: number) => {
    stateRef.current = { draft, cursor };
    const before = draft.slice(0, cursor);
    const m = before.match(SLASH_RE);
    setQuery(m ? m[2] : null);
    setActiveIndex(0);
  }, []);

  const { applyDraft } = opts;
  const pickAt = useCallback(
    (index: number) => {
      const skill = filtered[index];
      if (!skill) return;
      const { draft, cursor } = stateRef.current;
      const before = draft.slice(0, cursor);
      const m = before.match(SLASH_RE);
      if (m) {
        // 把光标前的 `/xxx` 摘掉（保留分隔空白）、skill 转为 chip
        const cut = before.slice(0, before.length - (m[2].length + 1));
        applyDraft(cut + draft.slice(cursor));
      }
      setPicked((prev) =>
        prev.some((p) => p.name === skill.name) ? prev : [...prev, skill],
      );
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

  const removeSkill = useCallback((name: string) => {
    setPicked((prev) => prev.filter((p) => p.name !== name));
  }, []);

  const buildSkillPrefix = useCallback(() => {
    if (picked.length === 0) return "";
    return [
      "[使用 skill] 处理本条消息前、先逐个 read 以下 skill 并严格遵循：",
      ...picked.map((p) => `- ${p.name}：${p.absPath}`),
      "",
      "",
    ].join("\n");
  }, [picked]);

  const reset = useCallback(() => {
    setPicked([]);
    setQuery(null);
  }, []);

  return {
    menuOpen,
    filtered,
    activeIndex,
    picked,
    onDraftChange,
    onKeyDown,
    pickAt,
    removeSkill,
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

// 注：旧的 SlashSkillChips（独立一排小药丸）已退役——chips 渲染收进 <Composer>
// 的上下文行（Codex 风框内 token）、见 src/components/composer.tsx
