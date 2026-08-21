/**
 * 工具失败结果 → 给人看的一句。
 *
 * SDK / MCP 常把失败包成 `{ content: [{ type: "text", text: "…" }], details: {} }`，
 * 直接 JSON.stringify 丢进事件流，用户只能看到一坨结构、看不出「rg 没装」。
 */

export const humanizeToolErrorText = (raw: unknown): string => {
  if (raw == null) return "";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return humanizeToolErrorText(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (typeof raw !== "object") return String(raw);

  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.content)) {
    const texts = o.content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === "text" && typeof b.text === "string") return b.text.trim();
        return "";
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }
  if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  if (typeof o.error === "string" && o.error.trim()) return o.error.trim();

  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
};
