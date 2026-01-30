import React from "react";

interface TxButtonProps {
  onClick: () => void;
  loading: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
}

export function TxButton({
  onClick,
  loading,
  disabled,
  children,
  variant = "primary",
  className = "",
}: TxButtonProps) {
  const base =
    variant === "danger" ? "btn-danger" : variant === "secondary" ? "btn-secondary" : "btn-primary";

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`${base} ${className} flex items-center justify-center gap-2`}
    >
      {loading && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {loading ? "Confirming..." : children}
    </button>
  );
}
