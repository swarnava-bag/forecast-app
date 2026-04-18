"use client";
import { useEffect, useState } from "react";

export default function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!now) return null;

  const date = now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const time = now.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-atlas-surface-soft/60 border border-atlas-line rounded-lg">
      <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider">IST</span>
      <div className="text-right">
        <p className="text-xs font-mono text-atlas-ink leading-none">{time}</p>
        <p className="text-[10px] text-atlas-ink-muted leading-none mt-0.5">{date}</p>
      </div>
    </div>
  );
}
