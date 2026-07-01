type BrandWordmarkProps = {
  className?: string;
  scale?: "default" | "large" | "splash";
};

export default function BrandWordmark({
  className = "",
  scale = "default",
}: BrandWordmarkProps) {
  return (
    <span className={["brand-bar", `brand-bar-${scale}`, className].filter(Boolean).join(" ")} aria-label="Sexualsync">
      <svg className="brand-mark" width="28" height="14" viewBox="0 0 100 50" fill="none" aria-hidden="true">
        <path
          d="M 12,25 C 22,15 38,15 50,25 C 62,35 78,35 88,25"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M 12,31 C 22,21 38,21 50,31 C 62,41 78,41 88,31"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.45"
        />
      </svg>
      <span className="brand-word">sexual</span>
      <span className="brand-dot" aria-hidden="true" />
      <span className="brand-word">sync</span>
    </span>
  );
}
