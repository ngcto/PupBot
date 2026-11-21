/**
 * open-bot-avatar's 16 gallery avatars, vendored as data.
 *
 * The npm package ships only its 7 starter avatars (`examples`); these 16 live in
 * the upstream repository's `gallery/*.json` and are not published. They are MIT,
 * Copyright (c) 2026 Dominik Scholz — see NOTICE.md beside this file.
 *
 * Re-vendoring after an upstream change: drop the JSON files from
 * `github.com/DominikScholz/open-bot-avatar` `gallery/` into this folder unchanged,
 * keeping the `version`/`id`/`name`/`body`/`eyes` shape, and add the new file to
 * the import list below in alphabetical order.
 */
import type { AvatarDefinition } from "../types.ts";
import book from "./book.json";
import brain from "./brain.json";
import bull from "./bull.json";
import bunny from "./bunny.json";
import camera from "./camera.json";
import cat from "./cat.json";
import cloud from "./cloud.json";
import egg from "./egg.json";
import ghost from "./ghost.json";
import magnifier from "./magnifier.json";
import paintBrush from "./paint-brush.json";
import palette from "./palette.json";
import rocket from "./rocket.json";
import shield from "./shield.json";
import star from "./star.json";
import witchHat from "./witch-hat.json";

/**
 * All 16, alphabetical by id. A JSON import widens `version: 1` to `number`, so
 * the list is typed to the library's definition contract rather than inferred.
 */
export const GALLERY = [
  book,
  brain,
  bull,
  bunny,
  camera,
  cat,
  cloud,
  egg,
  ghost,
  magnifier,
  paintBrush,
  palette,
  rocket,
  shield,
  star,
  witchHat,
] as readonly AvatarDefinition[];
