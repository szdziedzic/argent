import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";
import {
  __resetPixelCaptureSupportCacheForTesting,
  capturePixels,
  FIRST_PIXEL_CAPTURE_TIMEOUT_MS,
  getPixelCaptureSupport,
  PIXEL_CAPTURE_TIMEOUT_MS,
  PIXEL_SETTLE_POLL_MS,
  PIXEL_SETTLE_TIMEOUT_MS,
  pixelsDiffer,
  settlePixels,
  type PixelFrame,
} from "../../src/tools/flows/flow-pixels";
import { getSimulatorRuntimeKind } from "../../src/utils/ios-devices";
import { FIRST_FRAME_WAIT_MS } from "../../src/utils/simulator-client";

vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  getSimulatorRuntimeKind: vi.fn(async () => "mobile"),
}));

let tmpDir: string;
const mockGetSimulatorRuntimeKind = vi.mocked(getSimulatorRuntimeKind);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pixels-"));
  __resetPixelCaptureSupportCacheForTesting();
  mockGetSimulatorRuntimeKind.mockReset().mockResolvedValue("mobile");
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A solid-color RGBA frame — the unit under test only compares RGB. */
function solid(width: number, height: number, [r, g, b]: [number, number, number]): PixelFrame {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Flip `count` pixels of `base` to `color`, in place, returning it. */
function withChangedPixels(base: PixelFrame, count: number, color: number): PixelFrame {
  for (let i = 0; i < count; i++) {
    base.data[i * 4] = color;
    base.data[i * 4 + 1] = color;
    base.data[i * 4 + 2] = color;
  }
  return base;
}

describe("pixelsDiffer", () => {
  it("reports no motion for two identical frames", () => {
    expect(pixelsDiffer(solid(30, 30, [10, 20, 30]), solid(30, 30, [10, 20, 30]))).toBe(false);
  });

  it("reports motion when the whole frame changes", () => {
    expect(pixelsDiffer(solid(30, 30, [0, 0, 0]), solid(30, 30, [255, 255, 255]))).toBe(true);
  });

  it("treats a dimension change as motion (a resizing/rotating surface)", () => {
    expect(pixelsDiffer(solid(30, 30, [0, 0, 0]), solid(30, 31, [0, 0, 0]))).toBe(true);
  });

  it("ignores a sub-threshold per-pixel color drift (encoder / resample noise)", () => {
    // +5 on every channel is well under the per-pixel tolerance, so no pixel
    // counts as changed — two captures of a static screen must read as still.
    expect(pixelsDiffer(solid(30, 30, [100, 100, 100]), solid(30, 30, [105, 105, 105]))).toBe(
      false
    );
  });

  it("ignores a handful of changed pixels below the motion fraction", () => {
    // 900 px, fraction 0.002 → ~1.8 px budget: one changed pixel stays "still"
    // (a blinking cursor), three tips it over into motion.
    const base = solid(30, 30, [0, 0, 0]);
    expect(pixelsDiffer(base, withChangedPixels(solid(30, 30, [0, 0, 0]), 1, 255))).toBe(false);
    expect(pixelsDiffer(base, withChangedPixels(solid(30, 30, [0, 0, 0]), 3, 255))).toBe(true);
  });
});

describe("capturePixels", () => {
  it("returns undefined on Vega without touching the registry (no capture backend there)", async () => {
    let resolved = false;
    const env = {
      device: { platform: "vega", id: "vega-serial" },
      registry: {
        resolveService: () => {
          resolved = true;
          throw new Error("should not be called");
        },
      },
    } as unknown as ActionEnv;

    expect(await capturePixels(env)).toBeUndefined();
    expect(resolved).toBe(false);
  });

  it.each(["ios", "android", "chromium"] as const)(
    "returns undefined (never throws) on %s when the capture backend can't be resolved",
    async (platform) => {
      const env = {
        device: { platform, id: "some-device" },
        registry: {}, // no resolveService — resolving throws, capture soft-fails
      } as unknown as ActionEnv;

      expect(await capturePixels(env)).toBeUndefined();
    }
  );

  it.each([
    ["ios", "simulator"],
    ["android", "emulator"],
  ] as const)(
    "captures and cleans up decodable pixels through the native %s backend",
    async (platform, kind) => {
      const file = path.join(tmpDir, `${platform}-native.png`);
      const png = new PNG({ width: 2, height: 1 });
      png.data.set([10, 20, 30, 255, 40, 50, 60, 255]);
      await fs.writeFile(file, PNG.sync.write(png));
      const screenshot = vi.fn(async () => ({ path: file, url: `file://${file}` }));
      const device = { platform, kind, id: `${platform}-device` };
      const resolveService = vi.fn(async () => ({
        transport: { screenshot },
      }));
      const env = {
        device,
        registry: { resolveService },
      } as unknown as ActionEnv;

      const pixels = await capturePixels(env);

      expect(pixels).toMatchObject({ width: 2, height: 1 });
      expect([...pixels!.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
      expect(resolveService).toHaveBeenCalledWith(`SimulatorServer:${device.id}`, { device });
      expect(screenshot).toHaveBeenCalledWith({
        rotation: undefined,
        scale: 0.25,
        signal: undefined,
      });
      await expect(fs.access(file)).rejects.toThrow();
    }
  );

  it("classifies tvOS before service resolution and leaves Android TV capture-capable", async () => {
    mockGetSimulatorRuntimeKind.mockResolvedValue("tv");
    const resolveService = vi.fn(() => {
      throw new Error("simulator-server must not be resolved for tvOS");
    });
    const tvOs = {
      platform: "ios",
      kind: "simulator",
      id: "00000000-0000-0000-0000-0000000000TV",
    } as const;

    await expect(getPixelCaptureSupport(tvOs)).resolves.toBe("absent");
    await expect(
      capturePixels({ device: tvOs, registry: { resolveService } } as unknown as ActionEnv)
    ).resolves.toBeUndefined();
    expect(resolveService).not.toHaveBeenCalled();

    mockGetSimulatorRuntimeKind.mockClear();
    await expect(
      getPixelCaptureSupport({ platform: "android", kind: "emulator", id: "android-tv" })
    ).resolves.toBe("available");
    expect(mockGetSimulatorRuntimeKind).not.toHaveBeenCalled();
  });

  it("evicts an unknown iOS verdict while keeping each failed capture honest", async () => {
    mockGetSimulatorRuntimeKind.mockResolvedValue(undefined);
    const device = {
      platform: "ios",
      kind: "simulator",
      id: "00000000-0000-0000-0000-0000000000ab",
    } as const;
    const resolveService = vi.fn(() => {
      throw new Error("unknown support must not be treated as available");
    });
    const env = { device, registry: { resolveService } } as unknown as ActionEnv;

    await expect(capturePixels(env)).resolves.toBeUndefined();
    await expect(capturePixels(env)).resolves.toBeUndefined();

    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(2);
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("shares a pending unknown probe, then retries the same device and recovers to mobile", async () => {
    let resolveFirst!: (kind: "mobile" | "tv" | undefined) => void;
    const first = new Promise<"mobile" | "tv" | undefined>((resolve) => {
      resolveFirst = resolve;
    });
    mockGetSimulatorRuntimeKind.mockImplementationOnce(() => first).mockResolvedValue("mobile");
    const device = {
      platform: "ios",
      kind: "simulator",
      id: "00000000-0000-0000-0000-0000000000ac",
    } as const;

    const pendingA = getPixelCaptureSupport(device);
    const pendingB = getPixelCaptureSupport(device);
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(1);
    resolveFirst(undefined);
    await expect(Promise.all([pendingA, pendingB])).resolves.toEqual(["unknown", "unknown"]);

    await expect(getPixelCaptureSupport(device)).resolves.toBe("available");
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(2);

    const file = path.join(tmpDir, "recovered-mobile.png");
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([10, 20, 30, 255]);
    await fs.writeFile(file, PNG.sync.write(png));
    const screenshot = vi.fn(async () => ({ path: file, url: `file://${file}` }));
    const resolveService = vi.fn(async () => ({ transport: { screenshot } }));
    const env = { device, registry: { resolveService } } as unknown as ActionEnv;

    await expect(capturePixels(env)).resolves.toMatchObject({ width: 1, height: 1 });
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(2);
    expect(resolveService).toHaveBeenCalledTimes(1);
    await expect(fs.access(file)).rejects.toThrow();
  });
});

describe("settlePixels", () => {
  function chromiumEnv(
    captureScreenshot: () => Promise<{ path: string }>,
    signal?: AbortSignal
  ): ActionEnv {
    return {
      device: { platform: "chromium", id: "chromium-cdp-9222" },
      signal,
      registry: {
        resolveService: vi.fn(async () => ({ captureScreenshot })),
      },
    } as unknown as ActionEnv;
  }

  function simulatorEnv(captureScreenshot: () => Promise<{ path: string }>): ActionEnv {
    return {
      device: { platform: "ios", id: "00000000-0000-0000-0000-0000000000ab" },
      registry: {
        resolveService: vi.fn(async () => ({
          transport: { screenshot: captureScreenshot },
        })),
      },
    } as unknown as ActionEnv;
  }

  function captureFactory(colors: Array<[number, number, number]>) {
    let index = 0;
    return async (): Promise<{ path: string }> => {
      const color = colors[Math.min(index, colors.length - 1)]!;
      const png = new PNG({ width: 2, height: 2 });
      for (let i = 0; i < 4; i++) {
        png.data[i * 4] = color[0];
        png.data[i * 4 + 1] = color[1];
        png.data[i * 4 + 2] = color[2];
        png.data[i * 4 + 3] = 255;
      }
      const file = path.join(tmpDir, `capture-${index++}.png`);
      await fs.writeFile(file, PNG.sync.write(png));
      return { path: file };
    };
  }

  it("reports settled after two matching captures", async () => {
    const captureScreenshot = vi.fn(captureFactory([[10, 20, 30]]));

    await expect(settlePixels(chromiumEnv(captureScreenshot))).resolves.toBe("settled");
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
  });

  it("shares a default window sized for first-frame and steady-state capture latency", () => {
    expect(FIRST_PIXEL_CAPTURE_TIMEOUT_MS).toBeGreaterThan(FIRST_FRAME_WAIT_MS);
    expect(PIXEL_CAPTURE_TIMEOUT_MS).toBe(2_000);
    expect(PIXEL_SETTLE_POLL_MS).toBe(150);
    expect(PIXEL_SETTLE_TIMEOUT_MS).toBe(
      FIRST_PIXEL_CAPTURE_TIMEOUT_MS + PIXEL_SETTLE_POLL_MS + PIXEL_CAPTURE_TIMEOUT_MS
    );
  });

  it("settles a first-frame-boundary capture plus completion overhead and a warm capture", async () => {
    const files = [path.join(tmpDir, "slow-0.png"), path.join(tmpDir, "slow-1.png")];
    for (const file of files) {
      const png = new PNG({ width: 2, height: 2 });
      png.data.fill(255);
      await fs.writeFile(file, PNG.sync.write(png));
    }
    vi.useFakeTimers();
    let index = 0;
    const captureScreenshot = vi.fn(async () => {
      const delay = index === 0 ? FIRST_FRAME_WAIT_MS + 250 : PIXEL_CAPTURE_TIMEOUT_MS - 100;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return { path: files[index++]! };
    });
    const startedAt = Date.now();
    const pending = settlePixels(simulatorEnv(captureScreenshot));
    let settledAt: number | undefined;
    const measured = pending.then((outcome) => {
      settledAt = Date.now();
      return outcome;
    });

    await vi.advanceTimersByTimeAsync(FIRST_FRAME_WAIT_MS + 250);
    // Allow the real file read/decode/removal and observation gap to finish.
    await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(PIXEL_CAPTURE_TIMEOUT_MS - 100);

    await expect(measured).resolves.toBe("settled");
    expect(settledAt! - startedAt).toBeLessThan(PIXEL_SETTLE_TIMEOUT_MS);
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
    await expect(Promise.all(files.map((file) => fs.access(file)))).rejects.toThrow();
  });

  it("reports unavailable when no pixel source exists", async () => {
    const env = {
      device: { platform: "vega", id: "vega-serial" },
      registry: {},
    } as unknown as ActionEnv;

    await expect(settlePixels(env)).resolves.toBe("unavailable");
  });

  it("bounds a hung capture by the pixel deadline", async () => {
    vi.useFakeTimers();
    const captureScreenshot = vi.fn(() => new Promise<{ path: string }>(() => {}));
    const pending = settlePixels(chromiumEnv(captureScreenshot), {
      absoluteDeadline: Date.now() + 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe("timed-out");
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
  });

  it("expires a hung Chromium first capture at its per-capture timeout", async () => {
    vi.useFakeTimers();
    const captureScreenshot = vi.fn(() => new Promise<{ path: string }>(() => {}));
    let outcome: Awaited<ReturnType<typeof settlePixels>> | undefined;
    const pending = settlePixels(chromiumEnv(captureScreenshot)).then((value) => {
      outcome = value;
      return value;
    });

    await vi.advanceTimersByTimeAsync(PIXEL_CAPTURE_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe("timed-out");
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
  });

  it("expires a hung subsequent capture at its own timeout", async () => {
    vi.useFakeTimers();
    const file = path.join(tmpDir, "first.png");
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    await fs.writeFile(file, PNG.sync.write(png));
    let calls = 0;
    let outcome: Awaited<ReturnType<typeof settlePixels>> | undefined;
    let settledAt = -1;
    let secondStartedAt = -1;
    const captureScreenshot = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve({ path: file });
      secondStartedAt = Date.now();
      return new Promise<{ path: string }>(() => {});
    });
    const pending = settlePixels(chromiumEnv(captureScreenshot)).then((value) => {
      outcome = value;
      settledAt = Date.now();
      return value;
    });

    await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(PIXEL_CAPTURE_TIMEOUT_MS);

    await expect(pending).resolves.toBe("timed-out");
    expect(outcome).toBe("timed-out");
    expect(settledAt - secondStartedAt).toBe(PIXEL_CAPTURE_TIMEOUT_MS);
  });

  it("reports aborted without capturing when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const captureScreenshot = vi.fn(captureFactory([[10, 20, 30]]));

    await expect(settlePixels(chromiumEnv(captureScreenshot, controller.signal))).resolves.toBe(
      "aborted"
    );
    expect(captureScreenshot).not.toHaveBeenCalled();
  });
});
