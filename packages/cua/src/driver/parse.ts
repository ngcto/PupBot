import type {
  CuaActionResult,
  CuaScreenshot,
  CuaEffect,
  CuaElement,
  CuaEscalation,
  CuaObservation,
  CuaPageRef,
  CuaPageState,
  CuaWindow,
} from "../types.ts";
import { readRefusal } from "./cli.ts";

/**
 * Driver payload → our shapes.
 *
 * Nothing in here decides policy; it only translates. Keeping it pure is what
 * lets the action ladder be asserted in a unit test against recorded payloads
 * instead of against a live desktop.
 */

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `px` is what the driver calls the pixel rung; ours is `element` first. */
export function readEscalation(value: unknown): CuaEscalation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  const recommended = body.recommended;
  if (recommended !== "px" && recommended !== "foreground" && recommended !== "page") return undefined;
  return { recommended, reason: str(body.reason) ?? "the driver recommends the next rung" };
}

function readEffect(value: Record<string, unknown>): CuaEffect {
  const effect = str(value.effect);
  if (
    effect === "confirmed" ||
    effect === "unverifiable" ||
    effect === "suspected_noop" ||
    effect === "partial" ||
    effect === "refused"
  ) {
    return effect;
  }
  // A payload with no `effect` is a read or a launch: those report `status: ok`.
  return str(value.status) === "ok" ? "confirmed" : "unverifiable";
}

/**
 * How far an action got, and whether a caller may call it done.
 *
 * The one rule that matters: **`ok` is true only for a change the driver could
 * read back, or for a tool that does not verify at all.** `unverifiable` is a
 * delivered event, which is exactly the case where a model would otherwise
 * claim success for a write the app echoed and dropped.
 */
export function readActionResult(
  value: Record<string, unknown>,
  durationMs: number,
): CuaActionResult {
  const refusal = readRefusal(value);
  const effect = readEffect(value);
  const verified = value.verified === true;
  const escalation = readEscalation(value.escalation);

  if (refusal) {
    return {
      ok: false,
      verified: false,
      effect: "refused",
      ...(escalation ? { escalation } : {}),
      ...(str(value.path) ? { path: str(value.path) } : {}),
      ...(str(value.summary) ? { summary: str(value.summary) } : {}),
      refusal: { code: refusal.code, message: refusal.message, ...(refusal.hint ? { hint: refusal.hint } : {}) },
      durationMs,
      raw: value,
    };
  }

  return {
    // Unverified is not failure, but it is not success either: the caller must
    // observe again before it tells anyone the change happened.
    ok: effect === "confirmed",
    verified,
    effect,
    ...(escalation ? { escalation } : {}),
    ...(str(value.path) ? { path: str(value.path) } : {}),
    ...(str(value.summary) ? { summary: str(value.summary) } : {}),
    ...(value.delivery && typeof value.delivery === "object"
      ? { delivery: value.delivery as { mode?: string } }
      : {}),
    ...(Array.isArray(value.evidence)
      ? {
          evidence: (value.evidence as Array<Record<string, unknown>>)
            .filter((entry) => entry && typeof entry === "object")
            .map((entry) => ({ kind: str(entry.kind) ?? "note", detail: str(entry.detail) ?? "" })),
        }
      : {}),
    durationMs,
    raw: value,
  };
}

function readElement(row: Record<string, unknown>): CuaElement | null {
  const token = str(row.element_token);
  const role = str(row.role);
  if (!token || !role) return null;
  const frame = row.frame as Record<string, unknown> | undefined;
  const label = str(row.label);
  return {
    token,
    role,
    ...(label ? { label } : {}),
    ...(row.value !== undefined ? { value: row.value as CuaElement["value"] } : {}),
    ...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
    ...(typeof row.selected === "boolean" ? { selected: row.selected } : {}),
    ...(Array.isArray(row.actions) ? { actions: row.actions.filter((a): a is string => typeof a === "string") } : {}),
    ...(frame && typeof frame === "object"
      ? {
          frame: {
            x: num(frame.x) ?? 0,
            y: num(frame.y) ?? 0,
            w: num(frame.w) ?? 0,
            h: num(frame.h) ?? 0,
          },
        }
      : {}),
    ...(typeof row.offscreen === "boolean" && row.offscreen ? { offscreen: true } : {}),
    ...(str(row.description) ? { description: str(row.description) } : {}),
  };
}

/**
 * The screenshot a read carried, when the caller asked for one.
 *
 * MEASURED: the driver does not use content blocks over the CLI. A window read
 * puts `screenshot_png_b64` plus `screenshot_mime_type`, `screenshot_width` and
 * `screenshot_height` at the top level; `get_desktop_state` does the same. The
 * `images[]` shape is the SDK/MCP one, so both are accepted rather than making
 * the caller care which transport produced the reply.
 */
export function readScreenshot(value: Record<string, unknown>): CuaScreenshot | undefined {
  const inline = str(value.screenshot_png_b64);
  if (inline) {
    return {
      data: inline,
      mime: str(value.screenshot_mime_type) ?? "image/png",
      ...(num(value.screenshot_width) !== undefined ? { width: num(value.screenshot_width) } : {}),
      ...(num(value.screenshot_height) !== undefined ? { height: num(value.screenshot_height) } : {}),
    };
  }
  const images = value.images;
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const first = images[0] as Record<string, unknown> | undefined;
  if (!first) return undefined;
  const data = str(first.data);
  if (!data) return undefined;
  return { data, mime: str(first.mime_type) ?? "image/png" };
}

export function readObservation(
  value: Record<string, unknown>,
  meta: { kind: "window" | "desktop"; pid?: number; windowId?: number; durationMs: number; screenshot?: boolean },
): CuaObservation {
  const snapshotId = str(value.snapshot_id) ?? "";
  const rows = Array.isArray(value.elements) ? (value.elements as Array<Record<string, unknown>>) : [];
  const elements = rows.map(readElement).filter((entry): entry is CuaElement => entry !== null);
  const outline = str(value.tree_markdown) ?? str(value.tree_diff) ?? "";
  const degraded = value.degraded === true || (rows.length === 0 && !outline);
  const image = meta.screenshot ? readScreenshot(value) : undefined;

  return {
    kind: meta.kind,
    ...(meta.pid !== undefined ? { pid: meta.pid } : {}),
    ...(meta.windowId !== undefined ? { windowId: meta.windowId } : {}),
    title: str(value.window_title) ?? str(value.title) ?? null,
    appName: str(value.app_name) ?? null,
    snapshotId,
    elements,
    outline,
    degraded,
    ...(str(value.degraded_reason) ? { degradedReason: str(value.degraded_reason) } : {}),
    truncated: value.truncated === true,
    ...(image ? { screenshot: image } : {}),
    ...(Array.isArray(value.invalidated_snapshot_ids)
      ? {
          invalidatedSnapshotIds: (value.invalidated_snapshot_ids as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    durationMs: meta.durationMs,
  };
}

export function readWindow(row: Record<string, unknown>): CuaWindow | null {
  const pid = num(row.pid);
  const windowId = num(row.window_id);
  if (pid === undefined || windowId === undefined) return null;
  const bounds = (row.bounds as Record<string, unknown> | undefined) ?? {};
  return {
    pid,
    windowId,
    appName: str(row.app_name) ?? null,
    title: str(row.title) ?? null,
    bounds: {
      x: num(bounds.x) ?? num(row.x) ?? 0,
      y: num(bounds.y) ?? num(row.y) ?? 0,
      width: num(bounds.width) ?? num(row.width) ?? 0,
      height: num(bounds.height) ?? num(row.height) ?? 0,
    },
    isOnScreen: row.is_on_screen === true,
    zIndex: num(row.z_index) ?? null,
  };
}

export function readWindows(value: Record<string, unknown>): CuaWindow[] {
  const rows = Array.isArray(value.windows) ? (value.windows as Array<Record<string, unknown>>) : [];
  return rows.map(readWindow).filter((entry): entry is CuaWindow => entry !== null);
}

function readPageRef(row: Record<string, unknown>): CuaPageRef | null {
  const ref = str(row.ref);
  const role = str(row.role);
  if (!ref || !role) return null;
  return {
    ref,
    role,
    name: str(row.name) ?? null,
    value: row.value === null || row.value === undefined ? null : String(row.value),
    actions: Array.isArray(row.actions) ? row.actions.filter((a): a is string => typeof a === "string") : [],
    ...(str(row.visibility) ? { visibility: str(row.visibility) } : {}),
    ...(str(row.frame) ? { frame: str(row.frame) } : {}),
  };
}

/**
 * A page snapshot. `refs` are the actionable rows and `content` the read-only
 * ones — the split is the driver's, and it is what keeps a model from trying to
 * click a paragraph.
 */
export function readPageState(value: Record<string, unknown>, durationMs: number): CuaPageState {
  const page = (value.page as Record<string, unknown> | undefined) ?? {};
  const snapshot = (value.snapshot as Record<string, unknown> | undefined) ?? {};
  const refs = Array.isArray(value.refs) ? (value.refs as Array<Record<string, unknown>>) : [];
  const content = Array.isArray(value.content_refs)
    ? (value.content_refs as Array<Record<string, unknown>>)
    : [];
  const image = readScreenshot(value);
  const continuation = str(snapshot.continuation);

  return {
    url: str(page.url) ?? null,
    title: str(page.title) ?? null,
    outline: str(value.outline) ?? "",
    refs: refs.map(readPageRef).filter((entry): entry is CuaPageRef => entry !== null),
    content: content.map(readPageRef).filter((entry): entry is CuaPageRef => entry !== null),
    snapshotId: str(snapshot.id) ?? "",
    truncated: snapshot.complete === false,
    ...(continuation ? { continuation } : {}),
    ...(image ? { screenshot: image } : {}),
    durationMs,
  };
}


