import { renderAvatarSvg } from "./render.ts";
import { shapeById } from "./shapes.ts";
import type { AvatarRenderInput } from "./types.ts";

export interface AvatarProps extends AvatarRenderInput {
  className?: string;
  /** Accessible name; pass "" for a decorative avatar beside a visible label. */
  title?: string;
}

/**
 * Server and client render the same SVG string, so there is never a hydration
 * mismatch and no second renderer to keep in sync.
 */
export function Avatar({ shape, color, size = 32, className, title }: AvatarProps) {
  const label = title ?? `${shapeById(shape).name} avatar`;
  return (
    <span
      className={className}
      style={{ display: "inline-flex", width: size, height: size, flex: "none" }}
      role="img"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: renderAvatarSvg({ shape, color, size }) }}
    />
  );
}
