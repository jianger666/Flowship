/**
 * 消息内 URL 自动抓取正文（「URL 投喂」）
 *
 * 用户贴链接时、在拼发给 agent 的消息尾部附上网页正文快照，
 * 省掉 agent 自己 curl。best-effort：失败 / 超时不加段、不挡发送。
 * 不引 readability/cheerio——正则够用、失败降级即可。
 */

/** 单次 fetch 超时（并发跑、加总不会远超此值） */
const FETCH_TIMEOUT_MS = 5000;
/** 正文截断上限——投喂够用、避免撑爆上下文 */
const MAX_TEXT_CHARS = 8000;
/** 浏览器 UA——部分站点拒空 / bot UA */
const FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 明显静态资源扩展名——图 / 压缩包 / 字体等没正文可投喂 */
const STATIC_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|zip|tar|gz|tgz|rar|7z|pdf|mp[34]|webm|mov|avi|woff2?|ttf|eot|otf|css|js|mjs|map|wasm|dmg|exe|apk)(?:$|[?#])/i;

/**
 * 是否私网 / 本机——agent 沙箱也访问不了，抓了既无用还有 SSRF 泄漏风险。
 * 覆盖：localhost / 127.0.0.1 / 10.x / 192.168.x / 172.16–31.x / ::1
 */
const isPrivateOrLocalHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) {
    return true;
  }
  // IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
};

/** 去掉 URL 尾部常见标点（中文句读 / 英文括号后跟） */
const trimTrailingPunct = (raw: string): string =>
  raw.replace(/[),.，。；;!！?？]+$/u, "");

/**
 * 从消息文本抽取 http(s) URL。
 * 去重、最多 max 个；跳过内网 / 静态资源扩展名。
 */
export const extractHttpUrls = (text: string, max = 3): string[] => {
  if (!text || max <= 0) return [];
  // 宽松匹配，再交给 URL 校验 / 过滤
  const re = /https?:\/\/[^\s<>"'`）】\]}>]+/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const candidate = trimTrailingPunct(m[0]);
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (isPrivateOrLocalHost(parsed.hostname)) continue;
    // pathname + search 上判扩展名（query 前的路径）
    if (STATIC_EXT_RE.test(parsed.pathname)) continue;
    const normalized = parsed.href;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
};

/** HTML 取 title（失败返 undefined） */
const extractTitle = (html: string): string | undefined => {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = m[1].replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : undefined;
};

/**
 * 剥掉无用块 + 标签，压空白。
 * 正则 best-effort：嵌套复杂 HTML 可能残留噪音，投喂够用即可。
 */
const htmlToPlainText = (html: string): string => {
  let s = html
    // 先砍整块 script/style/nav/footer（含内容）
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    // noscript / svg / 注释也没正文价值
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // 块级换行提示
    .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // 剥剩余标签
    .replace(/<[^>]+>/g, " ")
    // HTML 实体常见项
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
  // 压空白：多空格 → 单空格、多空行 → 双换行
  s = s
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max) + "\n…(已截断)";

/**
 * 抓取 URL 正文。全程不抛：非 2xx / 非 html|plain / 超时 / 网络错 → null。
 */
export const fetchUrlText = async (
  url: string,
): Promise<{ title?: string; text: string } | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": FETCH_UA,
      },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const isHtml = ct.includes("text/html");
    const isPlain = ct.includes("text/plain");
    if (!isHtml && !isPlain) return null;
    const raw = await res.text();
    if (isPlain) {
      const text = truncate(raw.replace(/\s+\n/g, "\n").trim(), MAX_TEXT_CHARS);
      if (!text) return null;
      return { text };
    }
    const title = extractTitle(raw);
    const text = truncate(htmlToPlainText(raw), MAX_TEXT_CHARS);
    if (!text) return null;
    return { title, text };
  } catch {
    // AbortError / 网络错 / 非法 URL——一律降级
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 拼 [LINKED_URLS] 段。无 URL / 全失败 → 空串（调用方直接拼接、不加段）。
 */
export const buildLinkedUrlsSection = async (
  userText: string,
): Promise<string> => {
  const urls = extractHttpUrls(userText);
  if (urls.length === 0) return "";

  // 并发抓；单个 5s 超时、allSettled 不因一个挂掉整批
  const settled = await Promise.allSettled(urls.map((u) => fetchUrlText(u)));
  const blocks: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const r = settled[i];
    if (r.status !== "fulfilled" || !r.value) continue;
    const { title, text } = r.value;
    const head = title
      ? `--- ${urls[i]}（${title}）---`
      : `--- ${urls[i]} ---`;
    blocks.push(`${head}\n${text}`);
  }
  if (blocks.length === 0) return "";

  return [
    "",
    "",
    "[LINKED_URLS]",
    "以下是消息中链接的网页正文快照（自动抓取、可能不完整；需要完整内容可自行访问）：",
    ...blocks,
  ].join("\n");
};
