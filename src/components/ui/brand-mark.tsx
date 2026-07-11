import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * 品牌图形「雷芯」（v1.0.x logo 重设计、用户拍板 F1 图形 + 环流动效）
 *
 * 图形语言：实心琥珀渐变闪电（速度 / 自动执行）+ 一道贯穿裂隙 = 电路通道
 * （两端带节点、AI 电流从需求流向 PR）。桌面图标 / 站内 loading 用同一套几何——
 * loading 就是 logo 通电：一段亮电流沿闪电轮廓环流（pathLength 归一、CSS dash 动画）
 * + 背后光晕呼吸。动画 keyframes 在 globals.css（brand-*）、reduced-motion 自动停。
 *
 * 裂隙 / 节点颜色跟随页面背景（var(--background)）——亮暗主题都像「镂空」；
 * 桌面图标那份是独立渲染的位图（scripts 下 icon 模板）、不走本组件。
 */
export const BrandMark = ({
  size = 48,
  animated = false,
  className,
}: {
  size?: number;
  /** true = loading 形态（环流电流 + 光晕呼吸）、false = 静态 logo */
  animated?: boolean;
  className?: string;
}) => {
  // 渐变 id 实例唯一（同屏多个 BrandMark 时 defs id 撞了会互相串色）
  const gradId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fcd34d" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      {animated && (
        <circle className="brand-glow" cx="24" cy="24" r="20" fill="#f59e0b26" />
      )}
      {/* 主体：实心渐变闪电（stroke 同色加粗、把折角磨圆） */}
      <path
        d="M27 4 L10 27 H21 L18 44 L38 19 H26 Z"
        fill={`url(#${gradId})`}
        stroke={`url(#${gradId})`}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* 裂隙 = 电路通道（背景色镂空）+ 两端节点 */}
      <path
        d="M13 33 L34 12"
        stroke="var(--background)"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <circle cx="13" cy="33" r="2.2" fill="var(--background)" />
      <circle cx="34" cy="12" r="2.2" fill="var(--background)" />
      {/* loading 电流：一段亮电流沿闪电轮廓环流（pathLength=100 归一、dash 动画见 globals）；
          颜色随主题变量（浅色深琥珀 / 深色近白暖光、白底下白电流看不清——用户实测） */}
      {animated && (
        <path
          className="brand-current"
          d="M27 4 L10 27 H21 L18 44 L38 19 H26 Z"
          pathLength={100}
          stroke="var(--brand-current-color)"
          strokeWidth="2.6"
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  );
};
