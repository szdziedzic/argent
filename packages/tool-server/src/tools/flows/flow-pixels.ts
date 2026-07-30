import * as fs from "node:fs/promises";
import { PNG } from "pngjs";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { getSimulatorRuntimeKind } from "../../utils/ios-devices";
import { FIRST_FRAME_WAIT_MS, httpScreenshot } from "../../utils/simulator-client";
import { settleWithin, sleepOrAbort } from "../../utils/timing";
import type { ActionEnv } from "./flow-actions";

/**
 * A decoded capture used only to detect motion between two reads. Never an
 * artifact — the temp PNG is deleted as soon as it is decoded.
 */
export interface PixelFrame {
  width: number;
  height: number;
  data: Buffer;
}

// Hard downscale: motion detection only needs to see a large region moving,
// and a quarter-scale frame decodes ~16× faster. (Chromium without `sharp`
// ignores the scale and returns full-res — the comparison is scale-agnostic.)
const CAPTURE_SCALE = 0.25;

// Per-pixel RGB tolerance (mirrors screenshot-diff's DEFAULT_THRESHOLD) so
// encoder / resample noise between two captures never reads as motion.
const PIXEL_THRESHOLD = 0.1;
const MAX_RGB_DISTANCE_SQUARED = 255 * 255 * 3;
const PIXEL_THRESHOLD_SQUARED = PIXEL_THRESHOLD * PIXEL_THRESHOLD * MAX_RGB_DISTANCE_SQUARED;

// Captures match when fewer than this fraction of pixels changed — above the
// noise of a blinking cursor or small spinner, far below any screen-filling
// transition.
const MOTION_FRACTION = 0.002;

// `httpScreenshot` may spend its full first-frame wait before it even returns a
// file path. Leave a separate completion margin for reading, decoding, and
// removing that PNG. Warm captures retain their established two-second bound.
const FIRST_CAPTURE_COMPLETION_MARGIN_MS = 500;
export const FIRST_PIXEL_CAPTURE_TIMEOUT_MS =
  FIRST_FRAME_WAIT_MS + FIRST_CAPTURE_COMPLETION_MARGIN_MS;
export const PIXEL_CAPTURE_TIMEOUT_MS = 2_000;
export const PIXEL_SETTLE_POLL_MS = 150;
export const PIXEL_SETTLE_TIMEOUT_MS =
  FIRST_PIXEL_CAPTURE_TIMEOUT_MS + PIXEL_SETTLE_POLL_MS + PIXEL_CAPTURE_TIMEOUT_MS;

/** Result of a bounded pixel-only settle. */
export type PixelSettleOutcome = "settled" | "timed-out" | "unavailable" | "aborted";

export interface PixelSettleOptions {
  /** Optional caller deadline, further bounded by the shared default pixel window. */
  absoluteDeadline?: number;
}

export type PixelCaptureSupport = "available" | "absent" | "unknown";

// One flow environment reuses its DeviceInfo object across settling and the
// eventual capture. Preserve single-flight while a probe is pending and retain
// fixed available/absent verdicts. An unknown result is transient (simctl may
// have failed or the simulator may not be visible yet), so evict it after all
// callers already sharing that pending promise receive the result.
let pixelCaptureSupportCache = new WeakMap<ActionEnv["device"], Promise<PixelCaptureSupport>>();

/**
 * Resolve pixel support without conflating a failed runtime lookup with iOS.
 * Confirmed tvOS and Vega are architectural absences; confirmed local iOS,
 * ios-remote, Android (including TV), and Chromium are capture-capable.
 */
export function getPixelCaptureSupport(device: ActionEnv["device"]): Promise<PixelCaptureSupport> {
  if (device.platform === "vega") return Promise.resolve("absent");
  if (device.platform !== "ios") return Promise.resolve("available");
  const cached = pixelCaptureSupportCache.get(device);
  if (cached) return cached;
  const pending = getSimulatorRuntimeKind(device.id).then(
    (kind) => (kind === "tv" ? "absent" : kind === "mobile" ? "available" : "unknown"),
    () => "unknown" as const
  );
  pixelCaptureSupportCache.set(device, pending);
  void pending.then((support) => {
    if (support === "unknown" && pixelCaptureSupportCache.get(device) === pending) {
      pixelCaptureSupportCache.delete(device);
    }
  });
  return pending;
}

/** Test-only: isolate per-device capability verdicts. */
export function __resetPixelCaptureSupportCacheForTesting(): void {
  pixelCaptureSupportCache = new WeakMap();
}

/** Per-capture bound within the overall settle window. */
export function pixelCaptureTimeoutMs(device: ActionEnv["device"], firstCapture: boolean): number {
  // Only simulator-server-backed platforms can spend FIRST_FRAME_WAIT_MS
  // polling for their stream's first frame. Chromium is warm-bounded from its
  // first CDP screenshot; Vega never reaches capture.
  return firstCapture && device.platform !== "chromium"
    ? FIRST_PIXEL_CAPTURE_TIMEOUT_MS
    : PIXEL_CAPTURE_TIMEOUT_MS;
}

/**
 * Capture one downscaled screenshot to a temp file. iOS and Android share the
 * simulator-server backend; Chromium uses CDP. Combined settles never reach
 * here for Vega ({@link getPixelCaptureSupport}); the guard covers the pixels-only
 * outage fallback snapshots take when the tree source is down, where
 * `unavailable` is the honest report — nothing gated that capture.
 */
async function captureFile(env: ActionEnv): Promise<string | undefined> {
  if ((await getPixelCaptureSupport(env.device)) !== "available") return undefined;
  if (env.device.platform === "chromium") {
    const ref = chromiumCdpRef(env.device);
    const api = (await env.registry.resolveService(ref.urn, ref.options)) as ChromiumCdpApi;
    const { path } = await api.captureScreenshot({ scale: CAPTURE_SCALE });
    return path;
  }
  const ref = simulatorServerRef(env.device);
  const api = (await env.registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
  const { path } = await httpScreenshot(api, undefined, env.signal, CAPTURE_SCALE);
  return path;
}

/**
 * One capture as decoded pixels, or `undefined` when pixels can't be read here
 * (no capture source, or any capture / decode failure). Soft by design: the
 * caller treats that as "nothing to wait on" and proceeds.
 */
export async function capturePixels(env: ActionEnv): Promise<PixelFrame | undefined> {
  try {
    const file = await captureFile(env);
    if (!file) return undefined;
    try {
      const png = PNG.sync.read(await fs.readFile(file));
      return { width: png.width, height: png.height, data: png.data };
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  } catch {
    return undefined;
  }
}

type BoundedCapture = PixelFrame | "timed-out" | "aborted" | undefined;

/** Wait for one capture within both its own and the overall settle deadline. */
async function capturePixelsBefore(
  env: ActionEnv,
  overallDeadline: number,
  timeoutMs: number
): Promise<BoundedCapture> {
  if (env.signal?.aborted) return "aborted";
  const deadline = Math.min(overallDeadline, Date.now() + timeoutMs);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "timed-out";
  const result = await settleWithin(capturePixels(env), remaining, env.signal);
  if (result.type === "aborted" || env.signal?.aborted) return "aborted";
  if (result.type === "timeout") return "timed-out";
  // capturePixels is deliberately soft-failing, but preserve that contract if
  // a future capture implementation lets an error escape.
  if (result.type === "error") return undefined;
  return result.value;
}

/**
 * Wait for two matching pixel captures without consulting the describe tree.
 *
 * Snapshots use this after a combined settle proves the tree source is down:
 * the capture is gated by pixel stability alone, though nothing tree-derived
 * can ever come from this path (see the snapshot settler's `cropOn` notes).
 * A missing capture backend stays distinct from motion exhausting the
 * deadline so callers can report which degradation occurred.
 */
export async function settlePixels(
  env: ActionEnv,
  options: PixelSettleOptions = {}
): Promise<PixelSettleOutcome> {
  const deadline = Math.min(
    options.absoluteDeadline ?? Number.POSITIVE_INFINITY,
    Date.now() + PIXEL_SETTLE_TIMEOUT_MS
  );
  const first = await capturePixelsBefore(env, deadline, pixelCaptureTimeoutMs(env.device, true));
  if (first === "aborted" || first === "timed-out" || first === undefined) {
    return first === undefined ? "unavailable" : first;
  }

  let previous = first;
  for (;;) {
    const sleepMs = Math.min(PIXEL_SETTLE_POLL_MS, Math.max(0, deadline - Date.now()));
    if (sleepMs <= 0) return "timed-out";
    if (!(await sleepOrAbort(sleepMs, env.signal))) return "aborted";
    const next = await capturePixelsBefore(env, deadline, pixelCaptureTimeoutMs(env.device, false));
    if (next === "aborted" || next === "timed-out" || next === undefined) {
      return next === undefined ? "unavailable" : next;
    }
    if (!pixelsDiffer(previous, next)) return "settled";
    previous = next;
  }
}

/**
 * Did the screen move between two captures? Different dimensions count as
 * motion; otherwise the changed-pixel fraction is compared against
 * {@link MOTION_FRACTION}. Alpha is ignored — a screen capture is opaque.
 */
export function pixelsDiffer(a: PixelFrame, b: PixelFrame): boolean {
  if (a.width !== b.width || a.height !== b.height) return true;
  const total = a.width * a.height;
  if (total === 0) return false;
  const limit = Math.min(a.data.length, b.data.length);
  let changed = 0;
  for (let o = 0; o + 2 < limit; o += 4) {
    const dr = a.data[o] - b.data[o];
    const dg = a.data[o + 1] - b.data[o + 1];
    const db = a.data[o + 2] - b.data[o + 2];
    if (dr * dr + dg * dg + db * db > PIXEL_THRESHOLD_SQUARED) changed++;
  }
  return changed / total > MOTION_FRACTION;
}
