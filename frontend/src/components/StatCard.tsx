import React from "react";

interface StatCardProps {
  label: string;
  value: string;
  subValue?: string;
  color?: "green" | "red" | "yellow" | "blue" | "default";
}

const colorMap = {
  green: "text-green-400",
  red: "text-red-400",
  yellow: "text-yellow-400",
  blue: "text-brand-400",
  default: "text-white",
};

export function StatCard({ label, value, subValue, color = "default" }: StatCardProps) {
  return (
    <div className="card">
      <p className="stat-label">{label}</p>
      <p className={`stat-value ${colorMap[color]}`}>{value}</p>
      {subValue && <p className="mt-1 text-xs text-gray-500">{subValue}</p>}
    </div>
  );
}
