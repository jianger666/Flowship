/**
 * 脱敏 src/components + src/app 注释 / 日志里的 review 轮次编号。
 * 对齐 scripts/_sanitize-server-comments.mjs 的保守策略：
 * - 只动注释与日志字符串
 * - 保留 V0.x / v1.x、产品迭代 P5 / P4.1 / P5.1、协议名 V12
 * - 不删中文枚举用的斜杠分隔，不动 JSDoc 结束符 / $() / https://
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = [
  path.resolve("src/components"),
  path.resolve("src/app"),
];

/**
 * Review 标签：
 * - R36-7 / R29 / R23-4a / R29-C / R29-P2 / R36-12
 * - P1-01 / P1-2（必须带连字符；裸 P5/P4 当产品名保留）
 * - P1 #6
 * - 波次字母+数字：X S T U N G K L W D（不含 V——V12 协议名；不含 M——SVG path 的 M27 命令）
 */
const TAG =
  "R\\d+(?:-[0-9A-Za-z]+)*(?:\\/\\d+)?|P\\d+-\\d+|P\\d+\\s*#\\s*\\d+(?:\\s*/\\s*#\\s*\\d+)?|[XSTUNGKLWD]\\d+(?:-[0-9A-Za-z]+)*";

/** 标签簇：允许 `R36-2/4`（无空格）与 `R35-2 / R40-1` */
const TAG_CLUSTER = `(?:${TAG})(?:\\s*\\/\\s*(?:${TAG}))*`;

const LEADING = new RegExp(
  `^(?:\\/\\s*)?${TAG_CLUSTER}(?:\\s*[（(][^）)]*[）)])?(?:\\s*[：:]\\s*|\\s+)`,
);

const PROCESS_LEADING =
  /^(?:蓝军|审计|复审|终审|reviewAI)(?:\s+(?:P\d+(?:-\d+)?|[A-Z]\d+(?:-[0-9A-Za-z]+)*))*(?:\s*[（(]\d+\s*轮[）)])?\s*[：:.]?\s*/;

const isCommentLine = (line) => {
  const t = line.trimStart();
  return (
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("{/*")
  );
};

const splitTrailingClose = (body) => {
  const m = body.match(/^(.*?)(\s*\*\/)\s*$/);
  if (m && m[1].length > 0) return { core: m[1], close: m[2] };
  if (/^\s*\*\/\s*$/.test(body) || body.trim() === "*/")
    return { core: null, close: body };
  return { core: body, close: "" };
};

const sanitizeCore = (core) => {
  let s = core;

  // 主线合并括注
  s = s.replace(/[（(]主线合并[）)]/g, "");

  // 过程词前缀：蓝军 P1： / 复审（11 轮）： / 终审 P3： / reviewAI P2
  for (let i = 0; i < 3; i++) {
    if (!PROCESS_LEADING.test(s)) break;
    s = s.replace(PROCESS_LEADING, "");
  }

  // 复审（11 轮）：嵌在行中
  s = s.replace(/(?:蓝军|审计|复审|终审|reviewAI)[（(]\d+\s*轮[）)]\s*[：:]?\s*/g, "");
  s = s.replace(/reviewAI\s*提醒/g, "");

  // 行首标签簇
  for (let i = 0; i < 5; i++) {
    const m = s.match(LEADING);
    if (!m) break;
    s = s.slice(m[0].length);
  }

  // 括号内前导标签：（R20-2：xxx → （xxx ； （蓝军 P1：xxx → （xxx
  s = s.replace(
    new RegExp(
      `([（(])(?:蓝军|审计|复审|终审|reviewAI)\\s+(?:${TAG_CLUSTER})\\s*[：:]\\s*`,
      "g",
    ),
    "$1",
  );
  s = s.replace(
    new RegExp(`([（(])${TAG_CLUSTER}\\s*[：:]\\s*`, "g"),
    "$1",
  );
  // 纯标签括号：（R36-10 / R37-2）/（T2）/（蓝军 P1）
  s = s.replace(
    new RegExp(
      `[（(]\\s*(?:(?:蓝军|审计|复审|终审|reviewAI)\\s+)?${TAG_CLUSTER}\\s*[）)]`,
      "g",
    ),
    "",
  );

  // 「走 R3 队列」→「走队列」
  s = s.replace(
    new RegExp(`(走\\s+)${TAG_CLUSTER}(\\s+)`, "g"),
    "$1$2",
  );

  // 行内「标签：」残留（空白/顿号后）
  s = s.replace(
    new RegExp(`(^|[\\s、，,;；])${TAG_CLUSTER}\\s*[：:]\\s*`, "g"),
    "$1",
  );

  // 发版前蓝军 P1 / 句中过程词+标签
  s = s.replace(
    /(?:发版前)?(?:蓝军|审计|复审|终审|reviewAI)\s+(?:P\d+(?:-\d+)?|[A-Z]\d+(?:-[0-9A-Za-z]+)*)\s*[：:]?\s*/g,
    "",
  );

  // 版本旁的 -P1 / P0：V0.13-P1 → V0.13（保留版本）
  s = s.replace(/(V\d+\.\d+(?:\.\d+)?)[- ]P\d+\b/g, "$1");

  // 空白规整（不碰单独的 / ）
  s = s.replace(/\s{2,}/g, " ");
  s = s.replace(/、\s+/g, "、");
  s = s.replace(/（\s+/g, "（");
  s = s.replace(/\s+）/g, "）");
  s = s.replace(/（\s*）/g, "");
  s = s.replace(/^[：:\s]+/, "");
  s = s.replace(/\s+$/g, "");
  // 剥标签后残留「、：」壳
  s = s.replace(/、\s*[：:]\s*/g, "，");
  s = s.replace(/（、/g, "（");

  return s;
};

const sanitizeCommentBody = (body) => {
  const { core, close } = splitTrailingClose(body);
  if (core === null) return close;
  const next = sanitizeCore(core);
  if (!next.trim() && core.trim()) {
    // 空了：若原文只是标签，给一个占位提示由后续 MANUAL 覆盖；否则保留原文防误删
    if (new RegExp(`^\\s*${TAG_CLUSTER}\\s*$`).test(core.trim())) {
      return "（见字段语义）" + close;
    }
    return body;
  }
  return next + close;
};

const sanitizeStringContent = (str) => {
  let s = str;
  s = s.replace(
    new RegExp(
      `(\\[[^\\]]+\\]\\s+)?${TAG_CLUSTER}\\s*[：:]?\\s*`,
    ),
    (full, bracket, offset) => {
      if (offset > 0 && !/\s/.test(str[offset - 1])) return full;
      return bracket || "";
    },
  );
  s = s.replace(
    new RegExp(`([（(])${TAG_CLUSTER}\\s*[：:]\\s*`, "g"),
    "$1",
  );
  s = s.replace(/\s{2,}/g, " ");
  return s;
};

const hasTagSignal = (text) =>
  /R\d|[XSTUNGKLWDM]\d|P\d+-|P\d+\s*#|fable5-chat-polish|Codex\s*探针|验收\s*(?:R|P)|第?\s*\d+\s*轮|复审|蓝军|终审|reviewAI|主线合并|审计\s*P/.test(
    text,
  );

const sanitizeLine = (line) => {
  // 整行 JSX 注释
  const jsx = line.match(/^(\s*)\{\/\*\s*(.*?)\s*\*\/\}\s*$/);
  if (jsx) {
    if (!hasTagSignal(jsx[2])) return line;
    const body = sanitizeCommentBody(jsx[2]);
    if (!body.trim()) return line;
    return `${jsx[1]}{/* ${body.trim()} */}`;
  }

  // 多行 JSX 注释的首行（无闭合）
  const jsxOpen = line.match(/^(\s*)\{\/\*\s*(.*)$/);
  if (jsxOpen && !line.includes("*/}")) {
    if (!hasTagSignal(jsxOpen[2])) return line;
    const body = sanitizeCore(jsxOpen[2]);
    return `${jsxOpen[1]}{/* ${body}`;
  }

  // 多行 JSX 注释的续行 / 末行
  if (/^\s+.+\*\/\}\s*$/.test(line) && hasTagSignal(line)) {
    const m = line.match(/^(\s*)(.*?)(\s*\*\/\}\s*)$/);
    if (m && hasTagSignal(m[2])) {
      return m[1] + sanitizeCore(m[2]) + m[3];
    }
  }

  if (isCommentLine(line)) {
    if (!hasTagSignal(line)) return line;
    const m = line.match(/^(\s*(?:\/\/+|\/\*+|\*| \{\/\*)\s*)(.*)$/);
    // 标准 // 与 * /
    const m2 = line.match(/^(\s*(?:\/\/+|\/\*+|\*)\s*)(.*)$/);
    if (!m2) return line;
    return m2[1] + sanitizeCommentBody(m2[2]);
  }

  if (!hasTagSignal(line)) return line;

  // 非注释行：只清洗 console / throw 日志字符串，避免误伤 SVG path（M27）等
  if (!/\bconsole\.(?:log|error|warn|info)\b|\bthrow\b/.test(line)) {
    return line;
  }

  // 字符串字面量
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      out += ch;
      i++;
      continue;
    }
    const quote = ch;
    let j = i + 1;
    let esc = false;
    let hasInterp = false;
    while (j < line.length) {
      if (esc) {
        esc = false;
        j++;
        continue;
      }
      if (line[j] === "\\") {
        esc = true;
        j++;
        continue;
      }
      if (quote === "`" && line[j] === "$" && line[j + 1] === "{") {
        hasInterp = true;
        let depth = 0;
        j += 1;
        for (; j < line.length; j++) {
          if (line[j] === "{") depth++;
          else if (line[j] === "}") {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
        }
        continue;
      }
      if (line[j] === quote) break;
      j++;
    }
    if (j >= line.length || line[j] !== quote) {
      out += line.slice(i);
      break;
    }
    if (hasInterp) {
      const raw = line.slice(i + 1, j);
      let rebuilt = "";
      let k = 0;
      while (k < raw.length) {
        const idx = raw.indexOf("${", k);
        if (idx < 0) {
          rebuilt += hasTagSignal(raw.slice(k))
            ? sanitizeStringContent(raw.slice(k))
            : raw.slice(k);
          break;
        }
        const lit = raw.slice(k, idx);
        rebuilt += hasTagSignal(lit) ? sanitizeStringContent(lit) : lit;
        let depth = 0;
        let p = idx + 1;
        for (; p < raw.length; p++) {
          if (raw[p] === "{") depth++;
          else if (raw[p] === "}") {
            depth--;
            if (depth === 0) {
              p++;
              break;
            }
          }
        }
        rebuilt += raw.slice(idx, p);
        k = p;
      }
      out += "`" + rebuilt + "`";
    } else {
      const inner = line.slice(i + 1, j);
      out +=
        quote +
        (hasTagSignal(inner) ? sanitizeStringContent(inner) : inner) +
        quote;
    }
    i = j + 1;
  }
  return out;
};

const walk = (dir) => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
};

// 剥光后的定点改写（相对仓库根）
const MANUAL = new Map([
  [
    "src/components/tasks/event-stream.tsx:94",
    "  /** HTTP 不确定时为 true（与 network 轴对齐） */",
  ],
]);

let filesTouched = 0;
let changedLines = 0;
const samples = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file);
    const lines = src.split("\n");
    let n = 0;
    const next = lines.map((line, idx) => {
      const key = `${rel}:${idx + 1}`;
      if (MANUAL.has(key)) {
        const forced = MANUAL.get(key);
        if (forced !== line) {
          n++;
          if (samples.length < 40) {
            samples.push({
              file: rel,
              line: idx + 1,
              before: line.trim(),
              after: forced.trim(),
            });
          }
          return forced;
        }
      }
      const out = sanitizeLine(line);
      if (out !== line) {
        n++;
        if (samples.length < 40) {
          samples.push({
            file: rel,
            line: idx + 1,
            before: line.trim(),
            after: out.trim(),
          });
        }
      }
      return out;
    });
    if (n > 0) {
      const joined = next.join("\n");
      const closeJsdocOrig = (src.match(/\*\//g) || []).length;
      const closeJsdocNew = (joined.match(/\*\//g) || []).length;
      if (closeJsdocNew < closeJsdocOrig) {
        console.error(
          `REFUSE ${rel}: */ count ${closeJsdocOrig} -> ${closeJsdocNew}`,
        );
        continue;
      }
      if (src.includes("$()") && !joined.includes("$()")) {
        console.error(`REFUSE ${rel}: lost $()`);
        continue;
      }
      const httpsOrig = (src.match(/https:\/\//g) || []).length;
      const httpsNew = (joined.match(/https:\/\//g) || []).length;
      if (httpsNew < httpsOrig) {
        console.error(`REFUSE ${rel}: lost https://`);
        continue;
      }
      fs.writeFileSync(file, joined);
      filesTouched++;
      changedLines += n;
      console.log(`${rel}: ${n}`);
    }
  }
}

console.log(`\nSUMMARY files=${filesTouched} lines=${changedLines}`);
for (const s of samples.slice(0, 25)) {
  console.log(`${s.file}:${s.line}`);
  console.log(`  - ${s.before}`);
  console.log(`  + ${s.after}`);
}
