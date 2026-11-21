"use client";

import { COLORS, SHAPES, type AvatarColorId, type AvatarShapeId } from "@pupbot/avatars";
import { Avatar } from "@pupbot/avatars/react";
import { cn } from "@pupbot/ui";

/** Six 30px avatars and their 22px gaps fit the 438px dialog on one line. */
const PER_ROW = 6;

export function AvatarPicker({
  shape,
  color,
  onShape,
  onColor,
}: {
  shape: AvatarShapeId;
  color: AvatarColorId;
  onShape: (shape: AvatarShapeId) => void;
  onColor: (color: AvatarColorId) => void;
}) {
  const rows = [];
  for (let index = 0; index < SHAPES.length; index += PER_ROW) rows.push(SHAPES.slice(index, index + PER_ROW));

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col gap-[22px]">
        {rows.map((row, index) => (
          <div key={index} className="flex justify-center gap-[22px]">
            {row.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-label={`Shape ${entry.name}`}
                aria-pressed={shape === entry.id}
                title={entry.note}
                onClick={() => onShape(entry.id)}
                className={cn(
                  "rounded-md p-0.5 transition-transform hover:scale-105",
                  shape === entry.id ? "ring-1 ring-ink-muted ring-offset-[3px] ring-offset-canvas" : "",
                )}
              >
                <Avatar shape={entry.id} color={color} size={30} title="" />
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="flex w-[240px] flex-wrap justify-center gap-[18px]">
        {COLORS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-label={`Colour ${entry.name}`}
            aria-pressed={color === entry.id}
            onClick={() => onColor(entry.id)}
            className={cn(
              "size-6 rounded-pill transition-transform hover:scale-105",
              color === entry.id ? "ring-1 ring-ink-muted ring-offset-2 ring-offset-canvas" : "",
            )}
            style={{ background: entry.hex }}
          />
        ))}
      </div>
    </div>
  );
}
