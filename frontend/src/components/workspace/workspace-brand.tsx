"use client";

import Image from "next/image";

import logoTrade from "@/assets/logo-trade.png";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Sidebar brand block (project title), ported from the ai-agent-harness
 * workspace header. Renders the logo plus the two-line title when the
 * sidebar is expanded, and just the logo when collapsed.
 */
export function WorkspaceBrand({ className }: { className?: string }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <div
      className={cn(
        "flex min-w-0 cursor-default items-center",
        collapsed ? "justify-center" : "ml-2 gap-2",
        className,
      )}
    >
      <Image
        src={logoTrade}
        alt="Logo"
        className="size-8 shrink-0 object-contain"
      />
      {!collapsed && (
        <div className="flex min-w-0 flex-col">
          <span className="text-foreground whitespace-nowrap text-[15px] leading-tight font-semibold tracking-wide">
            易信 Trade AI
          </span>
          <span className="text-[9px] text-[#94a3b8] dark:text-slate-400">
            全连接AI原生交易平台
          </span>
        </div>
      )}
    </div>
  );
}
