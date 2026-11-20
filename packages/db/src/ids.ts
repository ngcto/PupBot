import { v7 } from "uuid";

/** UUID v7: time-ordered, so ids sort by creation. */
export function newId(): string {
  return v7();
}
