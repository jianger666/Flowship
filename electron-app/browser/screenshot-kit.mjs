/**
 * 截图增强的纯逻辑（E2·P5a / B6）：参数校验、捕获区域、annotate 的取框 / legend / 位图绘制、图片头尺寸解析。
 * 无 Electron / CDP 依赖，可直接单测；tab.screenshot 与 index.mjs 的 normalizeOpArgs 调用它。
 *
 * 关键安全取舍（annotate）：**不往页面里注入任何东西**。契约建议用「临时覆盖层」，但页面 DOM 是页面脚本可读的
 * （MutationObserver / querySelectorAll），isolated world 创建的节点同样挂在共享 DOM 上。这里改为：先让 CDP 截一张无标注的原图，
 * 在主进程拿到位图后直接在像素上画框 + 编号。页面里没有任何残留可言，失败路径也无需清理，也不会污染 snapshot / ref 表。
 */

/** 允许的输出格式 */
export const SCREENSHOT_FORMATS = Object.freeze(["png", "jpeg", "webp"]);
/** annotate 最多标注的元素数 */
export const MAX_ANNOTATIONS = 80;
/** clip 单边上限（CSS 像素） */
export const CLIP_MAX_SIDE = 8192;
/** legend 里单个元素名字的长度上限 */
const LEGEND_NAME_MAX = 60;

/** 默认值：与改造前一致（jpeg / 70 / 1280），保证老调用方的结果形状不变 */
export const DEFAULT_QUALITY = 70;
export const DEFAULT_MAX_WIDTH = 1280;
/** 显式传了 scale 却没传 max_width 时的缩放上限：否则 scale>1 会被默认 1280 立刻缩回去，等于没生效 */
export const SCALED_DEFAULT_MAX_WIDTH = 4096;

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * screenshot op 的参数规整（纯函数）。h = index.mjs 的 OP_HELPERS（bad / optStr / optBool / optNum / optEnum / isObj）。
 * 越界不再静默夹取，直接 BAD_ARGS——模型传了 quality:500 多半是误解，告诉它范围比悄悄改掉更好。
 * 互斥关系（都给 BAD_ARGS 并说明替代做法）：
 *   clip × full_page / ref；annotate × full_page / ref / clip / webp；omit_background 必须 png。
 */
export const normalizeScreenshotArgs = (args, h) => {
  const { bad, isObj } = h;
  const ref = h.optStr(args, "ref", 20);
  const fullPage = h.optBool(args, "fullPage", false);
  const format = h.optEnum(args, "format", SCREENSHOT_FORMATS, "jpeg");
  const rangeNum = (key, min, max, integer) => {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`参数 ${key} 必须是有限数字`);
    if (integer && !Number.isInteger(v)) throw bad(`参数 ${key} 必须是整数`);
    if (v < min || v > max) throw bad(`参数 ${key} 必须在 ${min}–${max} 之间，收到 ${v}`);
    return v;
  };
  const quality = rangeNum("quality", 1, 100, true);
  const maxWidthIn = rangeNum("maxWidth", 100, 4096, true);
  const scale = rangeNum("scale", 0.1, 3, false);
  const omitBackground = h.optBool(args, "omitBackground", false);
  const annotate = h.optBool(args, "annotate", false);

  let clip;
  if (args.clip !== undefined && args.clip !== null) {
    if (!isObj(args.clip)) throw bad("clip 必须是对象 {x, y, width, height}（视口 CSS 像素）");
    const c = args.clip;
    for (const k of ["x", "y", "width", "height"]) {
      if (!isFiniteNum(c[k])) throw bad(`clip.${k} 必须是有限数字`);
    }
    if (c.x < 0 || c.y < 0) throw bad("clip.x / clip.y 不能为负（原点是视口左上角）");
    if (c.width <= 0 || c.height <= 0) throw bad("clip.width / clip.height 必须大于 0");
    if (c.width > CLIP_MAX_SIDE || c.height > CLIP_MAX_SIDE || c.x > CLIP_MAX_SIDE * 4 || c.y > CLIP_MAX_SIDE * 4) {
      throw bad(`clip 的宽高不能超过 ${CLIP_MAX_SIDE}（CSS 像素）；只需要局部时请缩小范围，或用 ref 截取某个元素`);
    }
    clip = { x: c.x, y: c.y, width: c.width, height: c.height };
  }

  if (clip && fullPage) throw bad("clip 与 full_page 互斥：clip 是视口内的一块区域，full_page 是整页。请二选一");
  if (clip && ref) throw bad("clip 与 ref 互斥：ref 已经是按元素截取。请二选一");
  if (omitBackground && format !== "png") throw bad("omit_background（透明背景）只对 png 有效，请同时传 format:\"png\"");
  if (annotate) {
    if (fullPage) throw bad("annotate 只能标注当前视口：请去掉 full_page（先 browser_scroll 到目标区域再截）");
    if (ref) throw bad("annotate 标注的是整个视口里的元素，不能与 ref 同用：请去掉 ref");
    if (clip) throw bad("annotate 不能与 clip 同用：请去掉 clip");
    if (format === "webp") throw bad("annotate 不支持 webp（需要在像素上绘制标注）：请用 format:\"png\" 或 \"jpeg\"");
  }

  const maxWidth = maxWidthIn ?? (scale !== undefined ? SCALED_DEFAULT_MAX_WIDTH : DEFAULT_MAX_WIDTH);
  return {
    fullPage,
    ...(ref ? { ref } : {}),
    format,
    quality: quality ?? DEFAULT_QUALITY,
    maxWidth,
    ...(clip ? { clip } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(omitBackground ? { omitBackground: true } : {}),
    ...(annotate ? { annotate: true } : {}),
  };
};

/**
 * 视口 CSS 像素 clip → CDP 的 clip（带 scale）。
 * 超出视口的部分夹到视口内（模型常凭印象写一个略大的框）；夹完没有面积 → BAD_ARGS 并给出当前视口尺寸。
 * @returns {{ x: number, y: number, width: number, height: number, scale: number }}
 */
export const clampClipToViewport = (clip, viewportW, viewportH, scale = 1, makeError) => {
  const vw = isFiniteNum(viewportW) && viewportW > 0 ? viewportW : CLIP_MAX_SIDE;
  const vh = isFiniteNum(viewportH) && viewportH > 0 ? viewportH : CLIP_MAX_SIDE;
  const x = Math.min(clip.x, vw);
  const y = Math.min(clip.y, vh);
  const width = Math.min(clip.width, vw - x);
  const height = Math.min(clip.height, vh - y);
  if (!(width >= 1 && height >= 1)) {
    throw makeError(`clip 超出了当前视口（视口 ${Math.round(vw)}×${Math.round(vh)}，原点在左上角）。请调整 x / y / width / height，或先 browser_scroll 再截`);
  }
  return { x, y, width, height, scale };
};

// ───────────────────────── 图片头尺寸 ─────────────────────────

/**
 * 只读文件头拿图片像素尺寸（png / jpeg / webp）。解析不了返回 null。
 * 为什么要自己解析：nativeImage 不能解 webp，而 max_width 缩放 / 结果里的 width×height 都需要尺寸。
 */
export const readImageSize = (buf) => {
  if (!buf || buf.length < 24) return null;
  // PNG：8 字节签名 + IHDR（宽高各 4 字节大端）
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WebP：RIFF....WEBP + VP8 / VP8L / VP8X
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X" && buf.length >= 30) {
      return { format: "webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (kind === "VP8L" && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { format: "webp", width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff) };
    }
    if (kind === "VP8 " && buf.length >= 30) {
      return { format: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }
  // JPEG：扫描 SOFn 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
};

export const MIME_BY_FORMAT = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });

// ───────────────────────── annotate：取框 / legend ─────────────────────────

/** 去掉控制 / 格式 / 换行字符并限长：legend 的名字来自页面，不能带换行伪造多行指令 */
export const cleanLegendText = (s, max = LEGEND_NAME_MAX) => {
  const t = String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/**
 * 从「ref + 视口坐标框」里挑出要标注的元素（纯函数）。
 * 规则：框与视口无交集 / 面积过小的丢掉；超过 max 个时保留面积最大的 max 个（大控件比小图标更值得标）；最终按阅读序（先行后列）排。
 * @param {{ ref: string, role?: string, name?: string, box: { x: number, y: number, width: number, height: number } }[]} items
 * @param {{ viewportW: number, viewportH: number, max?: number }} opts
 * @returns {{ picked: { ref: string, role?: string, name?: string, box: { x: number, y: number, width: number, height: number } }[], omitted: number }}
 */
export const pickAnnotations = (items, { viewportW, viewportH, max = MAX_ANNOTATIONS }) => {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const b = it?.box;
    if (!b || ![b.x, b.y, b.width, b.height].every(isFiniteNum)) continue;
    const x1 = Math.max(0, b.x);
    const y1 = Math.max(0, b.y);
    const x2 = Math.min(viewportW, b.x + b.width);
    const y2 = Math.min(viewportH, b.y + b.height);
    const w = x2 - x1;
    const h = y2 - y1;
    if (!(w >= 4 && h >= 4)) continue;
    out.push({ ...it, box: { x: x1, y: y1, width: w, height: h }, area: w * h });
  }
  let omitted = 0;
  let chosen = out;
  if (out.length > max) {
    chosen = [...out].sort((a, b) => b.area - a.area).slice(0, max);
    omitted = out.length - max;
  }
  chosen.sort((a, b) => {
    const ra = Math.floor(a.box.y / 8);
    const rb = Math.floor(b.box.y / 8);
    return ra !== rb ? ra - rb : a.box.x - b.box.x;
  });
  return {
    picked: chosen.map((c) => {
      const rest = { ...c };
      delete rest.area;
      return rest;
    }),
    omitted,
  };
};

/** legend 一行：`[e12] button "提交"`（名字清洗 + 限长；role 只取字母数字，防页面伪造） */
export const legendLine = (it) => {
  const role = String(it?.role ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "element";
  const name = cleanLegendText(it?.name);
  const ref = String(it?.ref ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return `[${ref}] ${role}${name ? ` "${name.replace(/"/g, "'")}"` : ""}`;
};

// ───────────────────────── annotate：位图绘制 ─────────────────────────

// 3×5 点阵：数字与 "e"（ref 形如 e12）。每行 3 位二进制，高位在左
const GLYPHS = {
  0: [7, 5, 5, 5, 7],
  1: [2, 6, 2, 2, 7],
  2: [7, 1, 7, 4, 7],
  3: [7, 1, 7, 1, 7],
  4: [5, 5, 7, 1, 1],
  5: [7, 4, 7, 1, 7],
  6: [7, 4, 7, 5, 7],
  7: [7, 1, 1, 1, 1],
  8: [7, 5, 7, 5, 7],
  9: [7, 5, 7, 1, 7],
  e: [7, 5, 7, 4, 7],
};

// 标注色：品红（R=B）。toBitmap 在不同平台可能是 BGRA 或 RGBA，R 与 B 相同的颜色两种顺序下都一样
const ANN = { r: 255, g: 0, b: 255 };
const WHITE = { r: 255, g: 255, b: 255 };

const putPx = (data, width, height, x, y, c) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const o = (y * width + x) * 4;
  data[o] = c.b;
  data[o + 1] = c.g;
  data[o + 2] = c.r;
  data[o + 3] = 255;
};

const fillRect = (data, width, height, x, y, w, h, c) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) putPx(data, width, height, xx, yy, c);
};

/**
 * 在 BGRA / RGBA 位图上（原地）画框 + 编号标签。
 * @param {Buffer} data  width*height*4 字节
 * @param {{ x: number, y: number, width: number, height: number, label: string }[]} boxes  已换算成图片像素
 * @returns {number} 实际绘制的框数
 */
export const drawAnnotations = (data, width, height, boxes) => {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) return 0;
  if (!(width > 0 && height > 0) || data.length < width * height * 4) return 0;
  const cell = Math.max(2, Math.min(6, Math.round(width / 420)));
  const lineW = Math.max(2, Math.round(cell * 0.75));
  let n = 0;
  for (const b of boxes) {
    const x = Math.round(b.x);
    const y = Math.round(b.y);
    const w = Math.max(1, Math.round(b.width));
    const h = Math.max(1, Math.round(b.height));
    // 框（四条边）
    fillRect(data, width, height, x, y, w, lineW, ANN);
    fillRect(data, width, height, x, y + h - lineW, w, lineW, ANN);
    fillRect(data, width, height, x, y, lineW, h, ANN);
    fillRect(data, width, height, x + w - lineW, y, lineW, h, ANN);
    // 标签：品红底 + 白字，贴在框左上角内侧（放不下时仍画，越界像素被 putPx 丢弃）
    const text = String(b.label ?? "");
    const tagW = text.length * 4 * cell + cell;
    const tagH = 7 * cell;
    fillRect(data, width, height, x, y, tagW, tagH, ANN);
    let cx = x + cell;
    for (const ch of text) {
      const g = GLYPHS[ch];
      if (g) {
        for (let ry = 0; ry < 5; ry++) {
          for (let rx = 0; rx < 3; rx++) {
            if ((g[ry] >> (2 - rx)) & 1) fillRect(data, width, height, cx + rx * cell, y + cell + ry * cell, cell, cell, WHITE);
          }
        }
      }
      cx += 4 * cell;
    }
    n += 1;
  }
  return n;
};

/**
 * 视口 CSS 框 → 图片像素框（imgW / viewportW 为像素比，高度同理分别算：避免取整误差累积）。
 */
export const toPixelBoxes = (picked, { imgW, imgH, viewportW, viewportH }) => {
  const sx = imgW / viewportW;
  const sy = imgH / viewportH;
  return picked.map((it) => ({
    x: it.box.x * sx,
    y: it.box.y * sy,
    width: it.box.width * sx,
    height: it.box.height * sy,
    label: String(it.ref ?? ""),
  }));
};
