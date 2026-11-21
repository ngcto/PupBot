import { renderAvatarSvg, shapeById } from "@pupbot/avatars";
import { useMemo } from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";

/**
 * The same SVG the web renders, drawn with `react-native-svg`. One renderer for
 * every surface: the avatar registry is `@pupbot/avatars`, not a copy of it.
 */
export function Avatar({
  shape,
  color,
  size = 40,
  label,
}: {
  shape: string;
  color: string;
  size?: number;
  label?: string;
}) {
  const xml = useMemo(() => renderAvatarSvg({ shape, color, size }), [shape, color, size]);
  const name = label ?? `${shapeById(shape)?.name ?? "Bot"} avatar`;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={name} style={{ width: size, height: size }}>
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
}
