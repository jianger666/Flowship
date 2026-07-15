"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*                              Shared primitives                              */
/* -------------------------------------------------------------------------- */

const THEME_TOKENS = [
  "background",
  "foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "accent",
  "muted",
  "muted-foreground",
  "border",
  "ring",
  "destructive",
] as const;
type ThemeTokens = Record<(typeof THEME_TOKENS)[number], string>;

function readTheme(el: HTMLElement | null): ThemeTokens {
  const target = el ?? (typeof document !== "undefined" ? document.documentElement : null);
  const cs = target ? getComputedStyle(target) : null;
  const out = {} as ThemeTokens;
  for (const t of THEME_TOKENS) out[t] = cs ? cs.getPropertyValue(`--${t}`).trim() : "";
  return out;
}

function useGameTheme(ref: React.RefObject<HTMLElement | null>): ThemeTokens {
  const [theme, setTheme] = React.useState<ThemeTokens>(() => readTheme(null));
  React.useEffect(() => {
    const read = () => setTheme(readTheme(ref.current));
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => mo.disconnect();
  }, [ref]);
  return theme;
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

/* -------------------------------------------------------------------------- */
/*                               Game constants                                */
/* -------------------------------------------------------------------------- */

// Logical (design) coordinate space. All draw + physics happen in this space;
// the canvas is scaled to fit the responsive playfield.
const LOGW = 480;
const LOGH = 180;

const GROUND_Y_RATIO = 0.72; // ground line as fraction of logical height
const GROUND_Y = Math.floor(LOGH * GROUND_Y_RATIO);

const DINO_W = 28;
const DINO_H = 32;
const DINO_X = 60; // fixed horizontal position

const GRAVITY = 1800; // px/s²
const JUMP_VY = -560; // px/s (negative = upward) — clears tallest cactus at apex
const DUCK_HEIGHT = 18; // reduced height when ducking
const INITIAL_SPEED = 220; // px/s
const SPEED_INCREMENT = 8; // px/s per 100 score points
const MAX_SPEED = 600;

const SCORE_RATE = 10; // score points per second

// Collision forgiveness: inset both boxes so a near-miss isn't a hit.
const DINO_INSET_X = 5;
const DINO_INSET_Y = 5;
const CACTUS_INSET = 2;

/* -------------------------------------------------------------------------- */
/*                     Pixel sprites（视觉定制、不改物理）                        */
/* -------------------------------------------------------------------------- */

// 1=实体像素、0=空、2=眼睛留白（用 background 挖 1px 洞，贴近 Chrome 断网小恐龙）
type Pixel = 0 | 1 | 2;

/** "#"=实体 "o"=眼睛留白 其它=空 → 像素矩阵 */
const parseSprite = (rows: string[]): Pixel[][] =>
  rows.map((row) =>
    [...row].map((ch): Pixel => (ch === "#" ? 1 : ch === "o" ? 2 : 0)),
  );

// Chrome 风 T-Rex 剪影（朝右）：方头 + 眼洞 + 微张嘴 + 短前爪 + 粗尾上翘 + 两腿
// 奔跑两帧只换腿；下蹲用低扁形态。碰撞盒仍是 DINO_W×DINO_H / DUCK_HEIGHT，此处只负责画。
const TREX_RUN_A = parseSprite([
  "          ####### ",
  "         #########",
  "         ###o#####",
  "         #########",
  "         ######## ",
  "         #####    ",
  "  #     ######    ",
  "  ##   ########   ",
  "  #############   ",
  "  #############   ",
  "  ############    ",
  "  ###########     ",
  "  ##########      ",
  "   ########       ",
  "    ##  ###       ",
  "    ##            ",
]);

const TREX_RUN_B = parseSprite([
  "          ####### ",
  "         #########",
  "         ###o#####",
  "         #########",
  "         ######## ",
  "         #####    ",
  "  #     ######    ",
  "  ##   ########   ",
  "  #############   ",
  "  #############   ",
  "  ############    ",
  "  ###########     ",
  "  ##########      ",
  "   ########       ",
  "   ###  ##        ",
  "        ##        ",
]);

// 腾空：两腿收短（仍落在同一碰撞盒内绘制）
const TREX_JUMP = parseSprite([
  "          ####### ",
  "         #########",
  "         ###o#####",
  "         #########",
  "         ######## ",
  "         #####    ",
  "  #     ######    ",
  "  ##   ########   ",
  "  #############   ",
  "  #############   ",
  "  ############    ",
  "  ###########     ",
  "  ##########      ",
  "   ########       ",
  "    ##  ##        ",
  "                 ",
]);

// 下蹲：低扁剪影，高度对齐 DUCK_HEIGHT 缩放
const TREX_DUCK = parseSprite([
  "                   ",
  "  #################",
  " ##o###############",
  " ##################",
  "  ################ ",
  "   ##############  ",
  "    ##      ##     ",
]);

// 仙人掌剪影（按障碍宽高缩放；单株 / 带臂两套）
const CACTUS_SIMPLE = parseSprite([
  " ## ",
  " ## ",
  " ## ",
  " ## ",
  " ## ",
  " ## ",
  " ## ",
  " ## ",
]);

const CACTUS_ARMED = parseSprite([
  "  ##  ",
  "  ##  ",
  "## ## ",
  "## ## ",
  "  ####",
  "  ##  ",
  "  ##  ",
  "  ##  ",
  "  ##  ",
]);

/* -------------------------------------------------------------------------- */
/*                               Game types                                    */
/* -------------------------------------------------------------------------- */

interface Obstacle {
  id: number;
  x: number;
  w: number;
  h: number;
}

interface DinoState {
  y: number; // height of dino bottom above ground (0 = on ground)
  vy: number; // vertical velocity px/s (positive = downward)
  ducking: boolean;
  jumping: boolean;
  step: number; // accumulated phase for running leg animation
}

/* -------------------------------------------------------------------------- */
/*                                  Props                                       */
/* -------------------------------------------------------------------------- */

export interface DinoRunnerProps {
  className?: string;
  /** Optional max width (px) of the responsive game; defaults to fluid full-width. */
  width?: number;
  paused?: boolean;
  autoFocus?: boolean;
  /**
   * When true (the default), the game listens for keys on `window` so it works
   * without being focused first — ideal for single-game pages (404s, loading /
   * empty states). Set false when multiple games share a page, or the game sits
   * in scrollable content, so it only responds while focused. Ignores keys aimed
   * at form fields.
   */
  captureGlobalKeys?: boolean;
  persistHighScore?: boolean | string;
  /** 挂载即自动开跑（等待视图场景：action 一开始游戏就动起来、不用先按键） */
  autoStart?: boolean;
  onScoreChange?: (score: number) => void;
  onGameOver?: (r: { score: number; won: boolean }) => void;
  onStart?: () => void;
}

/* -------------------------------------------------------------------------- */
/*                               Component                                      */
/* -------------------------------------------------------------------------- */

export function DinoRunner({
  className,
  width,
  paused = false,
  autoFocus = true,
  captureGlobalKeys = true,
  persistHighScore = true,
  autoStart = false,
  onScoreChange,
  onGameOver,
  onStart,
}: DinoRunnerProps) {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const playfieldRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const theme = useGameTheme(wrapperRef);
  const reduce = usePrefersReducedMotion();

  const [status, setStatus] = React.useState<"idle" | "playing" | "gameover">("idle");
  const [score, setScore] = React.useState(0);
  const [high, setHigh] = React.useState(0);
  const [offscreen, setOffscreen] = React.useState(false);

  const storageKey =
    typeof persistHighScore === "string"
      ? persistHighScore
      : persistHighScore === false
        ? null
        : "gamekitui:dino-runner:hi";

  // ---- mutable live refs (read by rAF loop without re-subscribing) ----
  const statusRef = React.useRef(status);
  const pausedRef = React.useRef(paused);
  const offscreenRef = React.useRef(offscreen);
  const themeRef = React.useRef(theme);
  const reduceRef = React.useRef(reduce);
  statusRef.current = status;
  pausedRef.current = paused;
  offscreenRef.current = offscreen;
  themeRef.current = theme;
  reduceRef.current = reduce;

  // ---- game state refs ----
  const dinoRef = React.useRef<DinoState>({
    y: 0,
    vy: 0,
    ducking: false,
    jumping: false,
    step: 0,
  });
  const obstaclesRef = React.useRef<Obstacle[]>([]);
  const speedRef = React.useRef(INITIAL_SPEED);
  const scoreRef = React.useRef(0);
  const nextObstacleIdRef = React.useRef(0);
  const nextObstacleXRef = React.useRef(LOGW + 80);
  // accumulated score fraction (for smooth scoring)
  const scoreAccRef = React.useRef(0);
  // ground scroll for decorative ticks
  const groundOffsetRef = React.useRef(0);

  // ---- load high score ----
  React.useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) setHigh(Number(raw) || 0);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  const submitHigh = React.useCallback(
    (s: number) => {
      setHigh((prev) => {
        if (s <= prev) return prev;
        if (storageKey) {
          try {
            window.localStorage.setItem(storageKey, String(s));
          } catch {
            /* ignore */
          }
        }
        return s;
      });
    },
    [storageKey],
  );

  // ---- offscreen / visibility pause ----
  React.useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e) setOffscreen(!e.isIntersecting);
    });
    io.observe(el);
    const onVis = () => setOffscreen(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // ---- start / reset ----
  const start = React.useCallback(() => {
    dinoRef.current = { y: 0, vy: 0, ducking: false, jumping: false, step: 0 };
    obstaclesRef.current = [];
    speedRef.current = INITIAL_SPEED;
    scoreRef.current = 0;
    scoreAccRef.current = 0;
    groundOffsetRef.current = 0;
    nextObstacleIdRef.current = 0;
    nextObstacleXRef.current = LOGW + 80 + Math.random() * 200;
    setScore(0);
    setStatus("playing");
    onStart?.();
    onScoreChange?.(0);
    // Focus the wrapper so keyboard controls work after the Start button unmounts.
    wrapperRef.current?.focus();
  }, [onStart, onScoreChange]);

  // ---- responsive canvas sizing: match playfield CSS size × DPR, scale to logical space ----
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const field = playfieldRef.current;
    if (!canvas || !field) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const rect = field.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const scale = w / LOGW;
      // Draw in logical space (LOGW × LOGH); transform maps it onto the device pixels.
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(field);
    return () => ro.disconnect();
  }, []);

  // ---- main rAF loop + draw ----
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const groundY = GROUND_Y;

    // ---- obstacle spawning helpers ----
    const spawnGap = () => 280 + Math.random() * 220;

    const spawnObstacle = (): Obstacle => {
      const h = 22 + Math.random() * 22; // 22–44 px tall
      const w = 12 + Math.random() * 10; // 12–22 px wide
      return {
        id: nextObstacleIdRef.current++,
        x: nextObstacleXRef.current,
        w,
        h,
      };
    };

    // ---- draw helpers ----
    /**
     * 把像素点阵缩放到目标矩形内用 fillRect 画（无图片资源）。
     * 视觉定制：只动绘制；destW/destH 应对齐碰撞盒，物理不变。
     */
    const drawPixelSprite = (
      matrix: Pixel[][],
      destX: number,
      destY: number,
      destW: number,
      destH: number,
      fill: string,
      eyeColor: string,
    ) => {
      const rows = matrix.length;
      const cols = matrix[0]?.length ?? 0;
      if (!rows || !cols) return;
      const cellW = destW / cols;
      const cellH = destH / rows;
      for (let r = 0; r < rows; r++) {
        const row = matrix[r];
        if (!row) continue;
        for (let c = 0; c < cols; c++) {
          const v = row[c];
          if (!v) continue;
          ctx.fillStyle = v === 2 ? eyeColor : fill;
          // 略放大半像素，避免缩放后格子之间出现缝
          const x = destX + c * cellW;
          const y = destY + r * cellH;
          ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
        }
      }
    };

    const drawDino = (t: ThemeTokens, dino: DinoState) => {
      const ducking = dino.ducking;
      const dh = ducking ? DUCK_HEIGHT : DINO_H;
      // Bottom of the body sits `dino.y` above the ground.
      const dy = groundY - dh - dino.y; // top pixel of dino body

      const bodyColor = t.primary || "#000";
      // 眼睛留白：用面板背景色挖洞，深浅主题都能看见
      const eyeColor = t.background || "#fff";

      let sprite: Pixel[][];
      if (ducking) {
        sprite = TREX_DUCK;
      } else if (dino.jumping || dino.y > 0.5) {
        sprite = TREX_JUMP;
      } else {
        // 奔跑两帧交替换腿（step 相位与原先腿动画同源）
        sprite = Math.floor(dino.step) % 2 === 0 ? TREX_RUN_A : TREX_RUN_B;
      }

      drawPixelSprite(sprite, DINO_X, dy, DINO_W, dh, bodyColor, eyeColor);
    };

    const drawObstacle = (t: ThemeTokens, obs: Obstacle) => {
      const x = obs.x;
      const y = groundY - obs.h;
      const cactusColor = t["muted-foreground"] || "#555";
      // 高株用带臂仙人掌，矮株用单茎——仍按 obs.w/obs.h 缩放，碰撞盒不动
      const sprite = obs.h > 30 ? CACTUS_ARMED : CACTUS_SIMPLE;
      drawPixelSprite(sprite, x, y, obs.w, obs.h, cactusColor, cactusColor);
    };

    const drawGround = (t: ThemeTokens) => {
      ctx.strokeStyle = t["muted-foreground"] || "#888";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(LOGW, groundY);
      ctx.stroke();

      // scrolling tick marks
      ctx.strokeStyle = t["muted-foreground"] || "#888";
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      const spacing = 40;
      const offset = groundOffsetRef.current % spacing;
      for (let x = -offset; x < LOGW; x += spacing) {
        ctx.beginPath();
        ctx.moveTo(x, groundY + 2);
        ctx.lineTo(x + 8, groundY + 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const draw = () => {
      const t = themeRef.current;
      // 视觉定制：透明底，与 artifact 面板背景融为一体（不再铺 background 实心）
      ctx.clearRect(0, 0, LOGW, LOGH);

      drawGround(t);

      for (const obs of obstaclesRef.current) {
        drawObstacle(t, obs);
      }

      drawDino(t, dinoRef.current);
    };

    // ---- collision detection (tight AABB on both axes, with forgiveness inset) ----
    const checkCollision = (dino: DinoState): boolean => {
      const dh = dino.ducking ? DUCK_HEIGHT : DINO_H;
      // Dino body box in logical space.
      const dinoLeft = DINO_X + DINO_INSET_X;
      const dinoRight = DINO_X + DINO_W - DINO_INSET_X;
      const dinoBottom = groundY - dino.y; // rises as the dino jumps
      const dinoTop = dinoBottom - dh;
      // Apply vertical forgiveness.
      const dTop = dinoTop + DINO_INSET_Y;
      const dBottom = dinoBottom - DINO_INSET_Y;

      for (const obs of obstaclesRef.current) {
        const cLeft = obs.x + CACTUS_INSET;
        const cRight = obs.x + obs.w - CACTUS_INSET;
        const cTop = groundY - obs.h + CACTUS_INSET;
        const cBottom = groundY - CACTUS_INSET;

        const overlapX = dinoLeft < cRight && dinoRight > cLeft;
        const overlapY = dTop < cBottom && dBottom > cTop;
        if (overlapX && overlapY) return true;
      }
      return false;
    };

    // ---- game over callback holder ----
    const handleGameOver = (finalScore: number) => {
      setStatus("gameover");
      submitHigh(finalScore);
      onGameOver?.({ score: finalScore, won: false });
    };

    let raf = 0;
    let last = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (last === 0) last = now;
      const dtMs = now - last;
      last = now;

      const active =
        statusRef.current === "playing" &&
        !pausedRef.current &&
        !offscreenRef.current;

      if (active) {
        // cap dt to avoid tunneling on tab refocus; freeze under reduced motion
        const dt = reduceRef.current ? 0 : Math.min(dtMs / 1000, 0.05);

        const dino = dinoRef.current;
        const speed = speedRef.current;

        // ---- physics ----
        if (dino.jumping || dino.y > 0) {
          dino.vy += GRAVITY * dt;
          dino.y -= dino.vy * dt;
          if (dino.y <= 0) {
            dino.y = 0;
            dino.vy = 0;
            dino.jumping = false;
          }
        } else {
          // ---- running leg animation: advance step phase proportional to speed ----
          dino.step += dt * (speed / 30);
        }

        // ---- scroll obstacles ----
        groundOffsetRef.current += speed * dt;
        const surviving: Obstacle[] = [];
        for (const obs of obstaclesRef.current) {
          obs.x -= speed * dt;
          if (obs.x + obs.w > -10) surviving.push(obs);
        }
        obstaclesRef.current = surviving;

        // ---- spawn new obstacle ----
        nextObstacleXRef.current -= speed * dt;
        if (nextObstacleXRef.current <= LOGW) {
          obstaclesRef.current.push(spawnObstacle());
          nextObstacleXRef.current = LOGW + spawnGap();
        }

        // ---- score ----
        scoreAccRef.current += SCORE_RATE * dt;
        const newScore = Math.floor(scoreAccRef.current);
        if (newScore !== scoreRef.current) {
          scoreRef.current = newScore;
          setScore(newScore);
          onScoreChange?.(newScore);
          // ramp speed
          const targetSpeed = Math.min(
            INITIAL_SPEED + Math.floor(newScore / 100) * SPEED_INCREMENT,
            MAX_SPEED,
          );
          speedRef.current = targetSpeed;
        }

        // ---- collision ----
        if (checkCollision(dino)) {
          handleGameOver(scoreRef.current);
        }
      }

      draw();
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [onGameOver, onScoreChange, submitHigh]);

  // ---- keyboard input ----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // In global mode, ignore keys aimed at form fields / editable content.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;

      const key = e.key;
      const isJump = key === " " || key === "ArrowUp" || key === "w" || key === "W";
      const isDuck = key === "ArrowDown" || key === "s" || key === "S";

      if (!isJump && !isDuck) return;
      e.preventDefault();

      if (statusRef.current === "idle") {
        start();
        return;
      }
      if (statusRef.current === "gameover") {
        if (isJump) start();
        return;
      }

      const dino = dinoRef.current;
      if (isJump && !dino.jumping && dino.y === 0) {
        dino.vy = JUMP_VY;
        dino.jumping = true;
        dino.ducking = false;
      }
      if (isDuck) {
        dino.ducking = true;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const isDuck = e.key === "ArrowDown" || e.key === "s" || e.key === "S";
      if (isDuck) dinoRef.current.ducking = false;
    };

    // Single-game pages can opt into window-level capture so keys work without
    // focusing the game; otherwise listen on the wrapper (focus-scoped).
    const target: Window | HTMLElement | null = captureGlobalKeys
      ? window
      : wrapperRef.current;
    target?.addEventListener("keydown", onKey as EventListener);
    target?.addEventListener("keyup", onKeyUp as EventListener);
    return () => {
      target?.removeEventListener("keydown", onKey as EventListener);
      target?.removeEventListener("keyup", onKeyUp as EventListener);
    };
  }, [start, captureGlobalKeys]);

  // ---- pointer input (mouse + touch + pen): tap/click to start & jump ----
  React.useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onPointerDown = (e: PointerEvent) => {
      // Let overlay buttons (Start / Play again) handle their own clicks.
      if ((e.target as HTMLElement | null)?.closest("button")) return;
      e.preventDefault();
      if (statusRef.current !== "playing") {
        start();
        return;
      }
      const dino = dinoRef.current;
      if (!dino.jumping && dino.y === 0) {
        dino.vy = JUMP_VY;
        dino.jumping = true;
        dino.ducking = false;
      }
    };
    el.addEventListener("pointerdown", onPointerDown);
    return () => el.removeEventListener("pointerdown", onPointerDown);
  }, [start]);

  // ---- autofocus ----
  React.useEffect(() => {
    if (autoFocus) wrapperRef.current?.focus();
  }, [autoFocus]);

  // ---- autostart：挂载即开跑（只在初始 idle 时触发一次、game over 后不自动重开）----
  React.useEffect(() => {
    if (autoStart && statusRef.current === "idle") start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时判断一次、start 引用稳定
  }, []);

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      role="application"
      aria-label="Dino Runner game"
      style={width ? { maxWidth: width } : undefined}
      className={cn(
        // 不画 focus ring：组件挂载即自动聚焦（键盘操作需要）、ring 会常驻成一圈「边框」
        // 破坏与面板融为一体的效果（2026-07-15 用户反馈）。键盘输入不受影响。
        "relative flex w-full select-none flex-col gap-2 outline-none",
        className,
      )}
    >
      {/* Score bar —— 轻量化 HUD，去掉徽章边框底色 */}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">Score {score}</span>
        <span className="tabular-nums">Best {high}</span>
      </div>

      {/* Responsive playfield —— 去 border/圆角/底色，直接融进面板 */}
      <div
        ref={playfieldRef}
        className="relative aspect-[8/3] w-full overflow-hidden"
      >
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full touch-none" />

        {/* Overlay */}
        {status !== "playing" && (
          <div className="absolute inset-0 grid place-items-center bg-background/60">
            <div className="flex flex-col items-center gap-3 px-6 text-center">
              {status === "gameover" ? (
                <>
                  <p className="font-semibold text-lg">Game over</p>
                  <p className="text-muted-foreground text-sm">
                    You scored {score}
                    {score >= high && score > 0 ? " — new best!" : ""}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-lg">Dino Runner</p>
                  <p className="text-muted-foreground text-sm">
                    Space / Up / W to jump. Down / S to duck.
                  </p>
                </>
              )}
              <button
                type="button"
                onClick={start}
                className={cn(
                  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm",
                  "transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                {status === "gameover" ? "Play again" : "Start"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Accessible live region */}
      <div aria-live="polite" className="sr-only">
        {status === "playing" ? `Score: ${score}` : null}
        {status === "gameover" ? `Game over. Final score: ${score}. Best: ${high}.` : null}
      </div>
    </div>
  );
}

export default DinoRunner;
