import type { ReactNode } from "react";

interface NavButtonProps {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

export function NavButton({ active, icon, label, onClick }: NavButtonProps) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
        active 
          ? "bg-white/10 text-white shadow-lg shadow-purple-500/5 border border-white/10" 
          : "text-white/60 hover:text-white hover:bg-white/5"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
