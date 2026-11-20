import { renderAvatarSvg } from "./render.ts";
import { shapeById } from "./shapes.ts";
import type { AvatarRenderInput } from "./types.ts";

export interface AvatarProps extends AvatarRenderInput {
  className?: string;
  /** Accessible name; pass "" to mark decorative. */
  title?: string;
}

export function Avatar({ shape, color, size = 64, title, className }: AvatarProps) {
  const label = title ?? shapeById(shape)?.name ?? String(shape);
  const decorative = title === "";

  if (decorative) {
    return (
      <span
        className={className}
        style={{ display: "inline-flex", width: size, height: size, flex: "none" }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: renderAvatarSvg({ shape, color, size, title: "" }) }}
      />
    );
  }

  return (
    <span
      className={className}
      style={{ display: "inline-flex", width: size, height: size, flex: "none" }}
      role="img"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: renderAvatarSvg({ shape, color, size, title: "" }) }}
    />
  );
}
