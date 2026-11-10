/**
 * R6-41 ③：card-number 规则「误杀率 / 召回率」量化用的确定性样本生成器（mulberry32，失败可复现）。
 *
 * 误杀类（普通长数字，不该被当卡号）：国际区号手机号、ISBN-13、14 位日期时间、各种位数的订单号 / JSON id / 雪花 id、18 位身份证、13 位毫秒时间戳、全数字 UUID。
 * 召回类（真卡号，必须脱敏）：Visa / Mastercard（含 2 系）/ Amex / 银联 62 / Discover / JCB / Diners / 工行农行 9558·9559，无分隔 / 空格 / 连字符分组。
 */

export type Rnd = () => number;

export const mulberry32 = (seed: number): Rnd => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const int = (rnd: Rnd, lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const digits = (rnd: Rnd, n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += String(int(rnd, 0, 9));
  return s;
};
const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const pick = <T>(rnd: Rnd, arr: readonly T[]): T => arr[int(rnd, 0, arr.length - 1)];

/** Luhn 校验位：给定不含校验位的前缀，返回完整号码 */
export const withLuhn = (body: string): string => {
  let sum = 0;
  let dbl = true; // 校验位在最右，所以 body 的最右一位要翻倍
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return body + String((10 - (sum % 10)) % 10);
};

const group = (s: string, sizes: number[], sep: string): string => {
  const out: string[] = [];
  let at = 0;
  for (const n of sizes) {
    out.push(s.slice(at, at + n));
    at += n;
  }
  if (at < s.length) out.push(s.slice(at));
  return out.filter(Boolean).join(sep);
};

// ───────────────────────── 误杀类 ─────────────────────────

export interface SampleCategory {
  name: string;
  gen: (rnd: Rnd) => string;
}

const isbn13 = (rnd: Rnd): string => {
  const body = pick(rnd, ["978", "979"]) + digits(rnd, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (body.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  const full = body + String((10 - (sum % 10)) % 10);
  return rnd() < 0.5 ? full : `${full.slice(0, 3)}-${full.slice(3, 4)}-${full.slice(4, 6)}-${full.slice(6, 12)}-${full.slice(12)}`;
};

const CN_REGIONS = ["110105", "120104", "130102", "210102", "310104", "320106", "330102", "340103", "350102", "360102", "370102", "410102", "420102", "430102", "440106", "441900", "450102", "500103", "510104", "520102", "530102", "610113", "620102", "650102"];
const cnId18 = (rnd: Rnd): string => {
  const birth = `${int(rnd, 1950, 2005)}${pad(int(rnd, 1, 12), 2)}${pad(int(rnd, 1, 28), 2)}`;
  const body = pick(rnd, CN_REGIONS) + birth + digits(rnd, 3);
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (body.charCodeAt(i) - 48) * w[i];
  return body + "10X98765432"[sum % 11];
};

const dt14 = (rnd: Rnd): string => `${int(rnd, 2000, 2035)}${pad(int(rnd, 1, 12), 2)}${pad(int(rnd, 1, 28), 2)}${pad(int(rnd, 0, 23), 2)}${pad(int(rnd, 0, 59), 2)}${pad(int(rnd, 0, 59), 2)}`;

const leading = (rnd: Rnd, n: number): string => String(int(rnd, 1, 9)) + digits(rnd, n - 1);

export const FALSE_POSITIVE_CATEGORIES: SampleCategory[] = [
  { name: "国际区号手机号 +86 1xx xxxx xxxx", gen: (r) => `+86 1${int(r, 3, 9)}${int(r, 0, 9)} ${digits(r, 4)} ${digits(r, 4)}` },
  { name: "国际区号手机号 +86-1xx-xxxx-xxxx", gen: (r) => `+86-1${int(r, 3, 9)}${int(r, 0, 9)}-${digits(r, 4)}-${digits(r, 4)}` },
  { name: "德国手机号 +49 1xx xxxxxxxx（13 位，4 开头）", gen: (r) => `+49 1${int(r, 5, 7)}${int(r, 0, 9)} ${digits(r, 8)}` },
  { name: "ISBN-13（无分隔 / 连字符）", gen: isbn13 },
  { name: "14 位日期时间 YYYYMMDDHHMMSS", gen: dt14 },
  { name: "日期 + 空格 + 时间 YYYYMMDD HHMMSS", gen: (r) => `${dt14(r).slice(0, 8)} ${dt14(r).slice(8)}` },
  { name: "16 位订单号（无分隔）", gen: (r) => leading(r, 16) },
  { name: "16 位订单号（四位一组空格分隔）", gen: (r) => group(leading(r, 16), [4, 4, 4, 4], " ") },
  { name: "17 位 JSON id", gen: (r) => leading(r, 17) },
  { name: "18 位身份证（含 X 结尾，按 17 位前缀计）", gen: cnId18 },
  { name: "19 位雪花 id（1 开头）", gen: (r) => `1${digits(r, 18)}` },
  { name: "15 位快递单号（无分隔，非 34 / 37 开头）", gen: (r) => `${pick(r, ["1", "2", "5", "7", "8", "9"])}${digits(r, 14)}` },
  { name: "13 位毫秒时间戳（改前改后都应为 0）", gen: (r) => String(int(r, 1_600_000_000_000, 1_800_000_000_000)) },
  { name: "全数字 UUID（改前改后都应为 0）", gen: (r) => `${digits(r, 8)}-${digits(r, 4)}-${digits(r, 4)}-${digits(r, 4)}-${digits(r, 12)}` },
];

// ───────────────────────── 召回类（真卡号） ─────────────────────────

export interface RealCardGen {
  name: string;
  gen: (rnd: Rnd) => { digits: string; text: string };
}

const fmt = (full: string, rnd: Rnd, sizes: number[]): string => {
  const style = int(rnd, 0, 2);
  return style === 0 ? full : group(full, sizes, style === 1 ? " " : "-");
};

const fixed = (name: string, prefixes: (rnd: Rnd) => string, len: number, sizes: number[]): RealCardGen => ({
  name,
  gen: (rnd) => {
    const p = prefixes(rnd);
    const full = withLuhn(p + digits(rnd, len - 1 - p.length));
    return { digits: full, text: fmt(full, rnd, sizes) };
  },
});

const g4 = (len: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < len; i += 4) out.push(Math.min(4, len - i));
  return out;
};

export const REAL_CARD_GENERATORS: RealCardGen[] = [
  fixed("Visa 16", () => "4", 16, g4(16)),
  fixed("Visa 19", () => "4", 19, g4(19)),
  fixed("Mastercard 51–55", (r) => `5${int(r, 1, 5)}`, 16, g4(16)),
  fixed("Mastercard 2221–2720", (r) => String(int(r, 2221, 2720)), 16, g4(16)),
  fixed("Amex 34 / 37（4-6-5 分组）", (r) => pick(r, ["34", "37"]), 15, [4, 6, 5]),
  fixed("银联 62 · 16 位", () => "62", 16, g4(16)),
  fixed("银联 62 · 17 位", () => "62", 17, g4(17)),
  fixed("银联 62 · 18 位", () => "62", 18, g4(18)),
  fixed("银联 62 · 19 位", () => "62", 19, g4(19)),
  fixed("银联 81 · 16 位", () => "81", 16, g4(16)),
  fixed("Discover 6011 / 65 / 644–649", (r) => pick(r, ["6011", "65", String(int(r, 644, 649))]), 16, g4(16)),
  fixed("JCB 3528–3589", (r) => String(int(r, 3528, 3589)), 16, g4(16)),
  fixed("Diners 36 / 38 / 300–305 · 14 位（4-6-4 分组）", (r) => pick(r, ["36", "38", String(int(r, 300, 305))]), 14, [4, 6, 4]),
  fixed("Diners 36 · 16 位", () => "36", 16, g4(16)),
  fixed("工行 9558 / 农行 9559 · 19 位", (r) => pick(r, ["9558", "9559"]), 19, g4(19)),
  // R6-41 验收补（变异存活：删掉 maestro / mir 品牌项原测试仍全绿）
  fixed("Maestro 5018 / 5020 / 5038 / 5893 / 6304 / 6759 / 6761–6763 · 16 位", (r) => pick(r, ["5018", "5020", "5038", "5893", "6304", "6759", "6761", "6762", "6763"]), 16, g4(16)),
  fixed("Maestro 6759 · 19 位", () => "6759", 19, g4(19)),
  fixed("Mir 2200–2204 · 16 位", (r) => String(int(r, 2200, 2204)), 16, g4(16)),
];
