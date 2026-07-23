import { cn } from "@/lib/utils";

/**
 * 创建人小字：「by {author}」——Skill / Action 列表与只读查看共用。
 */

type Props = {
  author: string;
  className?: string;
};

export const AuthorByline = ({ author, className }: Props) => (
  <span
    className={cn(
      "shrink-0 text-[11px] font-normal text-muted-foreground",
      className,
    )}
  >
    by {author}
  </span>
);
