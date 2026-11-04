"use client";

/**
 * 播放器控制区：两排（时间 + 进度条另在 media-timeline-row）。
 * 第一排 = 传输：三栏对称（`grid-cols-[1fr_auto_1fr]`）——中间是 上一个 / 后退 / 播放 / 前进 / 下一个（真正居中，
 * 不随两侧内容宽度偏移），左栏倍速、右栏音量；
 * 第二排 = 工具（逐帧 / 字幕 / 循环 / 画中画 / 全屏 / 更多）。
 * 所有按钮只发 MediaCommand（与键盘快捷键同一套），真正执行在 media-player-dock。
 *
 * 窄窗口不挤：悬浮窗最窄 300px（控制区 282px）。居中要两侧栏等宽，所以按「中间 152px（有对比组时的五个按钮）+ 2 × 48px
 * （较宽的一侧是倍速按钮）= 248px」算，放得下；音量滑块再占 ~56px，所以只在控制区够宽（@sm = 384px）时才出现，窄时只留静音键。
 * 以前时间文字和逐帧键都挤在第一排，窄窗里时间被截成「0…」、音量滑块被挤出窗外。
 */

import type { ReactElement, ReactNode } from "react";
import {
  Captions,
  CaptionsOff,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FastForward,
  FolderOpen,
  Keyboard,
  Maximize,
  MoreHorizontal,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  Repeat1,
  RefreshCw,
  Rewind,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MediaElementState } from "@/components/media/use-media-element-state";
import type { MediaKind } from "@/lib/media/media-kind";
import { RATES, type LoopMode } from "@/lib/media/media-memory";
import type { MediaCommand } from "@/lib/media/media-shortcuts";
import { cn } from "@/lib/utils";

export type DockMode = "float" | "mini";

export interface MoreAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export interface TransportProps {
  kind: MediaKind;
  state: MediaElementState;
  rate: number;
  volume: number;
  muted: boolean;
  loop: LoopMode;
  groupSize: number;
  hasCaptionTracks: boolean;
  captionsOn: boolean;
  pipSupported: boolean;
  isFullscreen: boolean;
  onCommand: (cmd: MediaCommand) => void;
  onSetRate: (rate: number) => void;
  onSetVolume: (volume: number) => void;
  moreActions: MoreAction[];
  /** 倍速 / 更多菜单展开收起：全屏自动隐藏控件时，菜单开着不能收 */
  onMenuOpenChange?: (open: boolean) => void;
}

const BTN =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors " +
  "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 " +
  "[&_svg]:size-4 [&_svg]:shrink-0";

const Ctl = ({
  label,
  shortcut,
  onClick,
  active,
  disabled,
  className,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}): ReactElement => (
  <Tooltip content={shortcut ? `${label}（${shortcut}）` : label}>
    <button
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
      className={cn(BTN, active && "bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary", className)}
    >
      {children}
    </button>
  </Tooltip>
);

const formatRate = (r: number): string => `${Number.isInteger(r) ? r : r.toString()}×`;

const VolumeIcon = ({ volume, muted }: { volume: number; muted: boolean }) =>
  muted || volume === 0 ? <VolumeX /> : volume < 0.5 ? <Volume1 /> : <Volume2 />;

export const MediaTransport = ({
  kind,
  state,
  rate,
  volume,
  muted,
  loop,
  groupSize,
  hasCaptionTracks,
  captionsOn,
  pipSupported,
  isFullscreen,
  onCommand,
  onSetRate,
  onSetVolume,
  moreActions,
  onMenuOpenChange,
}: TransportProps) => {
  const isVideo = kind === "video";
  const playing = !state.paused && !state.ended;

  return (
    <div className="flex flex-col gap-1">
      {/* 三栏等分两侧：中间那组永远在控制区正中（以前贴着左边，和常见播放器的习惯相反） */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex items-center justify-start">
          <DropdownMenu onOpenChange={onMenuOpenChange}>
            <Tooltip content="播放速度（[ ] 调整，\\ 复位）">
              <DropdownMenuTrigger
                aria-label={`播放速度 ${formatRate(rate)}`}
                className={cn(
                  BTN,
                  "w-auto px-1.5 font-mono text-xs tabular-nums",
                  rate !== 1 && "bg-primary/12 text-primary",
                )}
              >
                {formatRate(rate)}
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="start" side="top" className="min-w-24">
              {RATES.map((r) => (
                <DropdownMenuItem key={r} onClick={() => onSetRate(r)} className="justify-between font-mono text-xs">
                  {formatRate(r)}
                  {r === rate && <span className="text-primary">●</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-0.5">
          {groupSize > 1 && (
            <Ctl label="上一个" shortcut="PageUp" onClick={() => onCommand({ type: "prev" })}>
              <SkipBack />
            </Ctl>
          )}
          <Ctl label="后退 5 秒" shortcut="←" onClick={() => onCommand({ type: "seekBy", seconds: -5 })}>
            <Rewind />
          </Ctl>
          <Tooltip content={playing ? "暂停（空格）" : "播放（空格）"}>
            <button
              type="button"
              aria-label={playing ? "暂停" : "播放"}
              onClick={() => onCommand({ type: "toggle" })}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
            >
              {playing ? <Pause /> : <Play className="translate-x-px" />}
            </button>
          </Tooltip>
          <Ctl label="前进 5 秒" shortcut="→" onClick={() => onCommand({ type: "seekBy", seconds: 5 })}>
            <FastForward />
          </Ctl>
          {groupSize > 1 && (
            <Ctl label="下一个" shortcut="PageDown" onClick={() => onCommand({ type: "next" })}>
              <SkipForward />
            </Ctl>
          )}
        </div>

        <div className="flex items-center justify-end">
          <Ctl label={muted ? "取消静音" : "静音"} shortcut="M" onClick={() => onCommand({ type: "mute" })}>
            <VolumeIcon volume={volume} muted={muted} />
          </Ctl>
          {/* 窄控制区不放滑块（会把右侧挤出窗外），静音键 + 键盘 ↑↓ 够用；够宽再出现 */}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => onSetVolume(Number(e.target.value))}
            aria-label="音量"
            className="hidden h-1 w-14 cursor-pointer accent-primary @sm:block"
          />
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        {isVideo && (
          <>
            <Ctl
              label="上一帧"
              shortcut=","
              onClick={() => onCommand({ type: "frame", dir: -1 })}
              disabled={!state.ready}
              className="w-6"
            >
              <ChevronLeft />
            </Ctl>
            <Ctl
              label="下一帧"
              shortcut="."
              onClick={() => onCommand({ type: "frame", dir: 1 })}
              disabled={!state.ready}
              className="w-6"
            >
              <ChevronRight />
            </Ctl>
          </>
        )}
        {isVideo && hasCaptionTracks && (
          <>
            <span className="mx-1 h-4 w-px bg-border" />
            <Ctl label={captionsOn ? "关闭字幕" : "打开字幕"} shortcut="C" onClick={() => onCommand({ type: "captions" })} active={captionsOn}>
              {captionsOn ? <Captions /> : <CaptionsOff />}
            </Ctl>
          </>
        )}
        <span className="min-w-0 flex-1" />
        <Ctl
          label={loop === "off" ? "循环：关" : loop === "one" ? "循环：单个" : "循环：整组"}
          shortcut="R"
          onClick={() => onCommand({ type: "loop" })}
          active={loop !== "off"}
        >
          {loop === "one" ? <Repeat1 /> : <Repeat />}
        </Ctl>
        {isVideo && pipSupported && (
          <Ctl label="画中画" shortcut="P" onClick={() => onCommand({ type: "pip" })} active={state.pip} disabled={!state.ready}>
            <PictureInPicture2 />
          </Ctl>
        )}
        {isVideo && (
          <Ctl
            label={isFullscreen ? "退出全屏" : "全屏"}
            shortcut="F"
            onClick={() => onCommand({ type: "fullscreen" })}
            active={isFullscreen}
          >
            {isFullscreen ? <Minimize /> : <Maximize />}
          </Ctl>
        )}
        <DropdownMenu onOpenChange={onMenuOpenChange}>
          <Tooltip content="更多">
            <DropdownMenuTrigger aria-label="更多" className={BTN}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" side="top" className="min-w-52">
            {moreActions.map((a) => (
              <DropdownMenuItem key={a.key} onClick={a.onClick} disabled={a.disabled}>
                {a.icon}
                {a.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onCommand({ type: "help" })}>
              <Keyboard className="size-3.5" />
              键盘快捷键
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};

/** 「更多」菜单里常用的图标（dock 组装动作时用，避免它再单独引一遍 lucide） */
export const MORE_ICONS = {
  reveal: <FolderOpen className="size-3.5" />,
  external: <ExternalLink className="size-3.5" />,
  copy: <Copy className="size-3.5" />,
  reload: <RefreshCw className="size-3.5" />,
  captions: <Captions className="size-3.5" />,
} as const;
