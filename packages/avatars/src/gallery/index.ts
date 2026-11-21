/**
 * open-bot-avatar's gallery avatars we ship, vendored as data.
 *
 * The npm package ships only its 7 starter avatars (`examples`); these nine live
 * in the upstream repository's `gallery/*.json` and are not published. They are
 * MIT, Copyright (c) 2026 Dominik Scholz — see NOTICE.md beside this file.
 *
 * Re-vendoring after an upstream change: drop the JSON files from
 * `github.com/DominikScholz/open-bot-avatar` `gallery/` into this folder unchanged,
 * keeping the `version`/`id`/`name`/`body`/`eyes` shape, and add the new file to
 * the import list below in alphabetical order.
 */
import type { AvatarDefinition } from "../types.ts";
import bull from "./bull.json";
import bunny from "./bunny.json";
import camera from "./camera.json";
import cat from "./cat.json";
import cloud from "./cloud.json";
import ghost from "./ghost.json";
import rocket from "./rocket.json";
import star from "./star.json";
import witchHat from "./witch-hat.json";

/**
 * All nine, alphabetical by id. A JSON import widens `version: 1` to `number`, so
 * the list is typed to the library's definition contract rather than inferred.
 */
export const GALLERY = [
  bull,
  bunny,
  camera,
  cat,
  cloud,
  ghost,
  rocket,
  star,
  witchHat,
] as readonly AvatarDefinition[];
