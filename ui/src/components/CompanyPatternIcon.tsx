import { useEffect, useId, useState } from "react";
import { cn } from "../lib/utils";

interface CompanyPatternIconProps {
  companyName: string;
  logoUrl?: string | null;
  /**
   * Kept for API compatibility with prior dither-pattern implementation.
   * The tethr placeholder is monochrome by design, so this prop is no
   * longer used to colour the artwork.
   */
  brandColor?: string | null;
  className?: string;
  logoFit?: "cover" | "contain";
}

/**
 * Static placeholder mark: white square, black border, faint diagonal
 * hatching behind the company's first initial. Inverts cleanly in dark
 * mode via currentColor / theme tokens. When a real logoUrl is set the
 * placeholder is replaced with the uploaded image.
 */
function PlaceholderArt({ initial, patternId }: { initial: string; patternId: string }) {
  // The border lives on the parent wrapper (so it follows whatever
  // border-radius the caller applies). The SVG only draws background +
  // hatch + letter.
  return (
    <svg
      viewBox="0 0 44 44"
      xmlns="http://www.w3.org/2000/svg"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width="4"
          height="4"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" strokeWidth="1" opacity="0.16" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="44" height="44" fill="var(--background)" />
      <rect x="0" y="0" width="44" height="44" fill={`url(#${patternId})`} />
      <text
        x="50%"
        y="52%"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="var(--font-sans)"
        fontWeight="800"
        fontSize="22"
        fill="currentColor"
      >
        {initial}
      </text>
    </svg>
  );
}

export function CompanyPatternIcon({
  companyName,
  logoUrl,
  className,
  logoFit = "cover",
}: CompanyPatternIconProps) {
  const initial = companyName.trim().charAt(0).toUpperCase() || "?";
  const [imageError, setImageError] = useState(false);
  const logo = !imageError && typeof logoUrl === "string" && logoUrl.trim().length > 0 ? logoUrl : null;
  const patternId = useId();

  useEffect(() => {
    setImageError(false);
  }, [logoUrl]);

  return (
    <div
      className={cn(
        "relative flex items-center justify-center w-11 h-11 overflow-hidden text-foreground",
        // Border only when we're showing the placeholder — sits on the
        // wrapper so it follows whatever border-radius the caller applied
        // (rounded-[14px], rounded-full, etc.) instead of getting clipped.
        !logo && "border-2 border-foreground",
        className,
      )}
    >
      {logo ? (
        <img
          src={logo}
          alt={`${companyName} logo`}
          onError={() => setImageError(true)}
          className={cn(
            "absolute inset-0 h-full w-full",
            logoFit === "contain" ? "object-contain" : "object-cover",
          )}
        />
      ) : (
        <PlaceholderArt initial={initial} patternId={patternId} />
      )}
    </div>
  );
}
