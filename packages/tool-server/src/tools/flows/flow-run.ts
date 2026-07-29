import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, isLiveServiceState } from "@argent/registry";
import type {
  DeviceInfo,
  FileInputSpec,
  Registry,
  ResolvedFileInput,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import {
  appIdForPlatform,
  assertSafeFlowName,
  chromiumLaunchSpec,
  describeSelector,
  describeTextExpectation,
  getFlowPath,
  parseFlow,
  setActiveProjectRoot,
  type FlowFile,
  type FlowSelector,
  type FlowStep,
  type Launch,
  type WhenCondition,
  LAUNCH_PLATFORMS,
  SELECTOR_RELATIONS,
} from "./flow-utils";
import type { TextMatchMode, WaitCondition } from "../../utils/ui-tree-match";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { isUnmetUiWaitResult } from "../await-ui-element";
import { resolveFlowDevice, bindDeviceArgs, type FlowPlatform } from "./flow-device";
import {
  runDirective,
  invokeOnDevice,
  ABORTED_OUTCOME,
  probeWhenCondition,
  type ActionEnv,
  type DirectiveOutcome,
} from "./flow-actions";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  chromiumCdpRef,
  CHROMIUM_CDP_NAMESPACE,
  type ChromiumCdpApi,
} from "../../blueprints/chromium-cdp";
import {
  bootElectronApp,
  killChromiumByPort,
  killChromiumByPortAndWait,
} from "../devices/boot-electron";
import { untrackChromiumPort } from "../../utils/chromium-discovery";
import { resolveDevice } from "../../utils/device-info";
import { runSnapshot, DEFAULT_MAX_MISMATCH, type SnapshotArtifacts } from "./flow-visual";
import { describeVega } from "../describe/platforms/vega";
import { pinStatusBar, restoreStatusBar } from "../../utils/status-bar";

const zodSchema = z.object({
  name: z.string().describe('Name of the flow to run (e.g. "settings-explore")'),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory that contains `.argent/flows/<name>.yaml`."
    ),
  flow_file: z
    .string()
    .optional()
    .describe(
      "Path to the flow .yaml as readable by the tool-server. Internal — the argent client derives it from project_root and name automatically; leave unset."
    ),
  device: z
    .string()
    .optional()
    .describe(
      "Device id to run against (iOS UDID, Android/Vega serial, Chromium id). Auto-detected when omitted."
    ),
  platform: z
    .enum(LAUNCH_PLATFORMS)
    .optional()
    .describe("Restrict auto-detection to this platform when several devices are booted."),
  updateBaselines: z
    .boolean()
    .optional()
    .describe(
      "Write/refresh screenshot baselines for `snapshot` steps instead of diffing against them."
    ),
  prerequisiteAcknowledged: z
    .boolean()
    .optional()
    .describe(
      "Set to true to confirm the execution prerequisite has been met. Required (LLM path) when a fragment defines an executionPrerequisite."
    ),
});

type Params = z.infer<typeof zodSchema>;

const fileInputs: FileInputSpec[] = [
  { target: "flow_file", path: "${project_root}/.argent/flows/${name}.yaml", kind: "file" },
];

export type StepStatus = "pass" | "fail" | "skip" | "error";

export interface StepReport {
  index: number;
  kind: FlowStep["kind"];
  status: StepStatus;
  /**
   * Machine-readable explanation of the outcome. Always set when the step did
   * not pass; also set on some passing reports whose result is self-narrating —
   * the `when:` guard marker (`condition met (…)`), snapshot passes (diff
   * percentage, baseline written/updated), and a chromium `launch` that booted
   * an instance (naming the device the run moved onto).
   */
  reason?: string;
  /** Underlying tool id for `tool` steps. */
  tool?: string;
  /** Tool result for `tool` steps. */
  result?: unknown;
  /** The tool's adapter output hint (e.g. "image"), for clients that render it. */
  outputHint?: string;
  /** The args the tool ran with (device id injected). */
  args?: unknown;
  /** Echo message. */
  message?: string;
  /** The fragment a step belongs to (set on `run` and the steps it expands). */
  flow?: string;
  /**
   * Human-readable "what this step acts on" — the selector for directive
   * steps, the snapshot name — so a report line reads `tap "Clear logs"`,
   * not a bare `tap`. Display-only; derived from the step definition.
   */
  target?: string;
  /**
   * Baseline key stem (`<name>__<platform>-WxH`, plus `-crop-<hash>` for
   * cropOn snapshots) for snapshot steps that carry artifacts — clients
   * exporting them to a durable location (the CLI's `--output`) name files
   * by it.
   */
  snapshotKey?: string;
  /** Snapshot-step artifacts (baseline/current/diff) as materializable handles. */
  artifacts?: SnapshotArtifacts;
  /**
   * Nesting depth for display: omitted at top level, +1 inside each block
   * directive's expanded steps (a `when:` block's guarded steps, a `run:`
   * fragment's steps). Renderers indent by it without knowing which directives
   * nest — the report is a flat list with no block-end marker, so depth cannot
   * be reconstructed downstream.
   */
  depth?: number;
}

export interface FlowRunResult {
  flow: string;
  device: string;
  executionPrerequisite: string;
  ok: boolean;
  /**
   * The run was cancelled mid-flight — set so a FAIL whose step statuses are
   * all pass/skip is self-explanatory. Absent on completed runs.
   */
  aborted?: boolean;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  steps: StepReport[];
}

export interface FlowPrerequisiteNotice {
  flow: string;
  notice: string;
  executionPrerequisite: string;
}

const MAX_RUN_DEPTH = 20;

/**
 * Grace period to let a freshly (re)launched app settle before the first step
 * runs. A cold start can outlast the first directive's default auto-wait (e.g. a
 * short-grace `assert`, or a `tap` whose budget is eaten by the launch), so we
 * give the app a head start here rather than inflating every step's timeout.
 */
const POST_LAUNCH_SETTLE_MS = 1500;

/**
 * Flows resolve selectors against the native UIView tree, served over the
 * native-devtools connection the injected dylib opens asynchronously after
 * launch. The post-launch settle alone can race a slow cold start, so we
 * additionally poll for the connection before step 1. `fetchFlowTree` treats a
 * missing connection as a hard per-read error (it never degrades to the
 * collapsing AX tree — see flow-tree.ts), so without this gate a slow cold
 * start would fail the first directive with a raw tree-source error; gating
 * the launch step reports the problem where it belongs, with a relaunch hint.
 */
const NATIVE_READY_TIMEOUT_MS = 8000;
const NATIVE_READY_POLL_MS = 250;

/**
 * Poll until native-devtools is connected for `bundleId`. Returns true once
 * connected, false on timeout / abort / the service being unavailable. The
 * caller decides how to treat false (iOS flows fail; see treeSourceGate).
 */
async function waitForNativeDevtools(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<boolean> {
  let api: NativeDevtoolsApi;
  try {
    const ref = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  } catch {
    return false; // native-devtools service unavailable
  }
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return false;
    if (api.isConnected(bundleId)) return true;
    if (Date.now() >= deadline) return false;
    if (!(await sleepOrAbort(NATIVE_READY_POLL_MS, signal))) return false;
  }
}

/**
 * Poll until the Vega automation toolkit — the only tree source on Vega —
 * serves a page source. Like iOS's injected dylib, the toolkit attaches
 * asynchronously at app launch, and `describeVega` degrades to an empty tree +
 * relaunch hint until it does; gating the launch on a served page source keeps
 * that window from eating the first directive's auto-wait (or silently
 * confirming a `hidden` assert against a blind read).
 */
async function waitForVegaAutomation(device: DeviceInfo, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return false;
    try {
      const data = await describeVega(device.id);
      if (!data.hint) return true;
    } catch {
      // transient adb/forward failure mid-boot — retry until the deadline
    }
    if (Date.now() >= deadline) return false;
    if (!(await sleepOrAbort(NATIVE_READY_POLL_MS, signal))) return false;
  }
}

/**
 * Probe whether the android-devtools helper — the full-hierarchy source flows
 * resolve testIDs against (`flow-android-tree.ts`) — is usable.
 *
 * Unlike iOS's native-devtools (a connection the injected dylib opens
 * asynchronously *after* launch, which `waitForNativeDevtools` must poll for),
 * the Android helper is a separate `am instrument` process the registry spawns
 * synchronously on first `resolveService`. There is no post-launch race to wait
 * out: one resolution either brings the helper up (install + spawn + ping
 * handshake in the factory) or it can't run on this device. So this is a
 * one-shot probe, not a poll.
 */
async function androidDevtoolsReady(registry: Registry, device: DeviceInfo): Promise<boolean> {
  try {
    const ref = androidDevtoolsRef(device);
    const api = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
    return api.isReady();
  } catch {
    return false; // helper can't be installed / spawned on this device
  }
}

/**
 * Gate a launch on the platform's full-hierarchy tree source being ready. If
 * it never comes up, every selector read would fail — `fetchFlowTree` refuses
 * to degrade to the trimmed AX tree (see flow-tree.ts) — so the launch step
 * fails outright with an actionable, platform-specific reason instead of
 * letting the first directive surface a raw tree-source error. Returns null
 * when ready (or the platform needs no gate / the run was aborted), else the
 * reason to report.
 */
async function treeSourceGate(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (device.platform === "ios" && !signal?.aborted) {
    const connected = await waitForNativeDevtools(registry, device, bundleId, signal);
    if (!connected && !signal?.aborted) {
      return (
        `could not connect to native devtools for ${bundleId}. Re-run to relaunch the app and retry. ` +
        `If it keeps failing, a stale or duplicate argent server may be holding the devtools connection — restart the argent server and try again.`
      );
    }
  }
  if (device.platform === "android" && !signal?.aborted) {
    const ready = await androidDevtoolsReady(registry, device);
    if (!ready && !signal?.aborted) {
      return (
        `could not reach the Android devtools helper (full-hierarchy source for testID selectors). ` +
        `Confirm the device is unlocked and the argent helper can be installed (\`adb install -t\`); a locked device or a blocked install is the usual cause. Re-run once resolved.`
      );
    }
  }
  if (device.platform === "vega" && !signal?.aborted) {
    const ready = await waitForVegaAutomation(device, signal);
    if (!ready && !signal?.aborted) {
      return (
        `the Vega automation toolkit never served a page source for ${bundleId} (the flow tree source). ` +
        `The toolkit attaches at app launch — re-run to relaunch; if it keeps failing, confirm the app was built with automation support and the VVD is reachable over adb.`
      );
    }
  }
  return null;
}

/**
 * Execute a `launch` step: start the app from a clean state — terminate and
 * relaunch via `restart-app`, so a copy left running by a prior run can't leak
 * state in. Then let the app settle and wait for the platform's full-hierarchy
 * tree source (see {@link treeSourceGate}), so a slow cold start doesn't eat
 * into the next step's auto-wait budget or degrade it to the wrong tree.
 * Failures are reported as step outcomes, not thrown, so the run still returns
 * a structured report; a run cancelled mid-launch returns the shared aborted
 * outcome (reported as a skip), never a pass that verified nothing or an error
 * blaming the app.
 *
 * Chromium can't relaunch in place — see {@link runChromiumLaunch}.
 */
async function runLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  const { registry, device, signal } = state;

  if (device.platform === "chromium") return runChromiumLaunch(state, app);

  const bundleId = appIdForPlatform(app, device.platform);
  if (!bundleId) {
    return {
      ok: false,
      reason: `no app id declared for platform "${device.platform}" — add a launch entry for it`,
    };
  }
  try {
    await invokeOnDevice(state, "restart-app", { bundleId });
  } catch (err) {
    // A cancellation makes the sub-tool itself reject; that rejection is the
    // abort, not an app failure, so it must not be attributed to restart-app.
    if (signal?.aborted) return ABORTED_OUTCOME;
    return { ok: false, reason: `restart-app failed: ${errMsg(err)}` };
  }
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  const gate = await treeSourceGate(registry, device, bundleId, signal);
  // The gate returns null (ready) on abort — check the signal before trusting
  // it, or a cancelled gate would read as a launch that verified readiness.
  if (signal?.aborted) return ABORTED_OUTCOME;
  if (gate) return { ok: false, reason: gate };
  return { ok: true };
}

/**
 * Execute a `launch` step on a Chromium device. A chromium "device" IS the
 * booted process (its id is the CDP port), so there is no in-place relaunch:
 * only the run's FIRST launch can be satisfied without booting — settling the
 * boot {@link resolveRunDevice} hoisted, or attaching to an instance the runner
 * does not own. Later launches boot their own ({@link bootChromiumForLaunch}).
 */
async function runChromiumLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  const { registry, device, signal } = state;

  if (state.chromiumLaunched) return bootChromiumForLaunch(state, app);
  state.chromiumLaunched = true;

  if (ownedInstance(state)) {
    // Seconds old and already fronted; just settle.
    if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
    return { ok: true };
  }
  if (!appIdForPlatform(app, "chromium")) {
    return { ok: false, reason: noChromiumAppReason(device) };
  }
  // Attach over CDP, not via `launch-app`: a chromium launch value is an app
  // path, which launch-app's bundleId grammar rejects.
  try {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    await api.refreshViewport();
  } catch (err) {
    return {
      ok: false,
      reason: `could not attach to chromium instance "${device.id}": ${errMsg(err)}`,
    };
  }
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  return { ok: true };
}

/**
 * Boot a fresh Chromium instance for a `launch` step and move the run onto it —
 * steps read `state.device` per call, so reassigning it is all the plumbing a
 * new id needs. An instance of the same app that this run owns is killed first:
 * an Electron app holding a single-instance lock makes the second process quit
 * on startup, so its CDP endpoint would never come up. Instances the run does
 * not own are never killed.
 */
async function bootChromiumForLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  const { registry, signal } = state;

  const spec = chromiumLaunchSpec(app);
  if (!spec) return { ok: false, reason: noChromiumAppReason(state.device) };
  const appPath = resolveAppPath(spec.path, state.flowsDir);

  const retiring = state.owned.findIndex((o) => o.appPath === appPath);
  if (retiring !== -1) {
    // Awaited to the process's actual exit, not just the signal: the
    // replacement would otherwise race the dying instance's lock.
    const [prev] = state.owned.splice(retiring, 1);
    await teardownBootedChromium(registry, prev!, { awaitExit: true });
  }

  let booted: BootedChromium;
  try {
    booted = await bootChromiumForFlow(spec, state.flowsDir);
  } catch (err) {
    // The one boot failure the underlying error can't explain.
    const foreign =
      retiring === -1 && !ownedInstance(state)
        ? ` An instance this run does not own is running on ${state.device.id}; if it is this same app, its single-instance lock would refuse a second copy.`
        : "";
    return { ok: false, reason: `could not boot the chromium app: ${errMsg(err)}${foreign}` };
  }
  // Recorded before the next await so a cancelled run still reclaims it.
  state.owned.push(booted);
  state.device = resolveDevice(booted.deviceId);

  await frontChromiumPage(registry, state.device);
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  return { ok: true, reason: `booted chromium instance ${booted.deviceId}` };
}

/** The instance the runner booted for the current device, when it owns it. */
function ownedInstance(state: ExecState): BootedChromium | undefined {
  return state.owned.find((o) => o.deviceId === state.device.id);
}

/**
 * Reason for a launch naming no chromium app while the run is on chromium —
 * names the device, since a run can move onto one mid-flight.
 */
function noChromiumAppReason(device: DeviceInfo): string {
  return `no chromium app declared — the run is on ${device.id}; add a \`chromium:\` entry to this launch`;
}

interface ExecState extends ActionEnv {
  flowsDir: string;
  topFlowName: string;
  updateBaselines: boolean;
  reports: StepReport[];
  stopped: boolean;
  /** Whether the status bar was pinned for this run (and so must be restored). */
  pinned: boolean;
  /**
   * Chromium instances the runner booted, oldest first — torn down in reverse at
   * run end. A chromium e2e flow's leading launch has its boot hoisted into
   * {@link resolveRunDevice}, so that one is here before step 1.
   */
  owned: BootedChromium[];
  /** True once a chromium `launch` step has run; every later one boots its own instance. */
  chromiumLaunched: boolean;
  /** Live progress hook: receives every report the moment it is appended. */
  onStepReport?: (report: StepReport) => void;
}

/** A chromium instance the runner booted and must tear down after the run. */
interface BootedChromium {
  deviceId: string;
  port: number;
  pid: number;
  /** Absolute app path it was booted from — identifies a relaunch of the same app. */
  appPath: string;
}

export function createRunFlowTool(
  registry: Registry
): ToolDefinition<Params, FlowRunResult | FlowPrerequisiteNotice> {
  return {
    id: "flow-execute",
    description: `Run a saved flow from the .argent/flows/ directory.
Steps run in order: \`launch\` starts an app from scratch (terminate + relaunch) and waits until it is
ready; \`tool\` calls dispatch through the registry; \`tap\`/\`long-press\`/\`type\` resolve a selector to an
element and act on it (\`tap: { on, times: 2 }\` double-taps; \`long-press: { on, duration }\` presses and
holds; \`tap\`/\`long-press\` alternatively take a raw normalized point — bare \`{ x, y }\` or \`on: { x, y }\`;
any selector may scope its matches geometrically, the CSS combinators read off frames: \`within: <selector>\`
(descendant — inside that container's frame), \`after: <selector>\` (CSS \`~\` — following it in reading
order), \`next: <selector>\` (CSS \`+\` — the nearest such follower, which unlike CSS reaches past a
non-matching neighbour rather than failing), plus \`any: true\` (CSS \`*\` — legal only WITH a scope and
never beside text/id/role). Scopes nest to disambiguate — \`within: { id: card, within: { id: list } }\`
reads "inside card inside list", each container's frame inside the next);
\`scroll-to\` scrolls (momentum-free) until a target is visible; \`pinch\` zooms
(\`pinch: { on?, scale }\` — scale > 1 in, < 1 out; screen center when \`on\` is omitted); \`rotate\` is the
two-finger rotation gesture (\`rotate: { on?, by }\` — degrees, + clockwise, within ±3000°; screen center
when \`on\` is omitted; distinct from the \`rotate\` tool, which changes device orientation); \`await\` waits
for a UI condition; \`wait\` pauses for a fixed number of milliseconds; \`assert\` checks one now; \`snapshot\`
diffs a screenshot — or, with \`cropOn: <selector>\`, one element's cropped region — against a stored
baseline (a missing baseline fails the step — set updateBaselines to adopt the current screen; a
cropped element whose size drifted fails on dimensions); \`echo\` annotates; \`run\` executes a referenced fragment inline.
A \`when:\` block (condition + \`steps:\`, no else) runs its steps only if the condition holds —
checked once with the short assert grace — for one-sided divergences like interstitials and coach
marks; a skipped block reports distinctly and failures inside an entered block are real failures.
A flow that begins with a \`launch\` step is a self-contained e2e flow; one that doesn't runs against the
device's current state. Device id is injected by the runner (flows store none) — pass \`device\` or
\`platform\` to pick one, else the single booted device is used. On Chromium a \`launch\` step's value is an
Electron app path ({ chromium: <path> | { path, args } }) the runner boots (on the tool-server host) rather
than an installed app id it relaunches. With no explicit \`device\`, a run whose leading launch is
unambiguously chromium (\`platform: chromium\`, or a lone \`{ chromium: … }\` target) boots that app and
starts there — following a leading \`run:\`, so a fragment that composes a chromium e2e flow boots too;
otherwise the first launch attaches to an already-running instance and never kills it. Every later
launch — a nested e2e flow's own, or a mid-flow relaunch — boots a fresh instance the run moves onto,
replacing the one it already owns for that app. Instances the runner booted are torn down when the run
ends. A launch declaring no id for the run's platform is an error, not a cue to switch platforms.
Every step hard-stops the flow on failure;
later steps are reported as skipped. Returns a structured report ({ ok, passed, failed, skipped, errored, steps }).

If a fragment has an execution prerequisite and prerequisiteAcknowledged is not set to true, the tool
returns a notice with the prerequisite instead of running.`,
    longRunning: true,
    zodSchema,
    fileInputs,
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const signal = ctx?.signal;
      const filePath = resolveFlowFilePath(params, ctx?.fileInputs?.flow_file);
      const flowsDir = path.dirname(filePath);
      const flow = parseFlow(await fs.readFile(filePath, "utf8"));

      // LLM-path prerequisite handshake (fragments only; a flow with a leading
      // launch step cannot declare one — validated at parse).
      if (flow.executionPrerequisite && !params.prerequisiteAcknowledged) {
        return {
          flow: params.name,
          notice:
            "This flow has an execution prerequisite that must be fulfilled before it can run. " +
            "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true.",
          executionPrerequisite: flow.executionPrerequisite,
        };
      }

      // Resolve the run device (a Chromium e2e flow boots + owns its own app; see
      // resolveRunDevice). Any instance it booted is torn down in the finally.
      const resolved = await resolveRunDevice(registry, ctx, flow, params, flowsDir);
      // The device the run STARTS on — `state.device` moves when a chromium
      // launch boots one, so the status-bar restore below must not follow it.
      const device = resolved.device;
      const env: ActionEnv = { registry, ctx, device, signal };

      // Normalize the status bar (clock/battery/signal) for the whole run so it
      // never drives a snapshot diff and every screenshot is consistent. Pinned
      // before step 1 — it's a device-level override independent of the app, so
      // an e2e flow's leading launch step (relaunch + settle) doubles as
      // propagation headroom before anything is captured. No-op (returns false)
      // on chromium/vega; restored on teardown.
      const statusBarPinned = await pinStatusBar(device);

      // The chromium equivalent of that normalization: front the page so a
      // backgrounded window doesn't throttle rendering — wheel-event acks
      // (scroll steps) stall on a throttled compositor. Covers the instance the
      // run starts on; a launch that boots one fronts it itself. Best-effort:
      // bringToFront can focus a page but cannot unhide a minimized window
      // (gesture-scroll fails fast on that case itself).
      if (device.platform === "chromium") await frontChromiumPage(registry, device);

      const state: ExecState = {
        ...env,
        flowsDir,
        topFlowName: params.name,
        updateBaselines: Boolean(params.updateBaselines),
        reports: [],
        stopped: false,
        pinned: statusBarPinned,
        owned: resolved.booted ? [resolved.booted] : [],
        chromiumLaunched: false,
        ...(ctx?.emitProgress ? { onStepReport: ctx.emitProgress } : {}),
      };

      let aborted: boolean;
      try {
        await execSteps(state, flow.steps, {
          flow: params.name,
          runStack: [params.name],
          depth: 0,
        });
      } finally {
        // Sample the cancel flag before teardown: a client disconnect during
        // status-bar restore / chromium teardown lands after every step
        // already ran, and must not flip a finished run to FAIL.
        aborted = state.signal?.aborted === true;
        // Restored on the device the pin was applied to — `state.device` may
        // have moved on since.
        if (state.pinned) await restoreStatusBar(device);
        // Reverse order: a nested flow's instance goes before the parent's.
        for (let i = state.owned.length - 1; i >= 0; i--) {
          await teardownBootedChromium(registry, state.owned[i]!);
        }
      }

      // The starting device: a run that switched says so on the launch step.
      return summarize(params.name, device.id, flow.executionPrerequisite, state.reports, aborted);
    },
  };
}

/**
 * Resolve the device a flow *starts* on. For a Chromium e2e flow with no
 * explicit `device` (see {@link chromiumBootSpec}) this boots a fresh Electron
 * instance from the launch's app path and returns it for teardown; otherwise it
 * attaches to an already-booted device. An explicit `device` never boots here —
 * the run starts attached to it, and only a launch step beyond the first moves
 * off it onto an instance the runner owns ({@link bootChromiumForLaunch}).
 * `flowDir` is the flow file's directory — the base for a relative chromium app
 * path.
 */
async function resolveRunDevice(
  registry: Registry,
  ctx: ToolContext | undefined,
  flow: FlowFile,
  params: Params,
  flowDir: string
): Promise<{ device: DeviceInfo; booted: BootedChromium | null }> {
  if (!params.device) {
    // Seeded with the top flow, exactly like `execRunStep`'s runStack — the two
    // must accept the same chains, or a boot could precede a run the executor
    // then refuses for depth.
    const leading = await leadingLaunch(flow, flowDir, [params.name]);
    const spec = leading && chromiumBootSpec(leading, params.platform);
    if (spec) {
      const booted = await bootChromiumForFlow(spec, flowDir);
      return { device: resolveDevice(booted.deviceId), booted };
    }
  }
  const device = await resolveFlowDevice(registry, ctx, {
    device: params.device,
    platform: params.platform as FlowPlatform | undefined,
  });
  return { device, booted: null };
}

/**
 * The launch the RUN begins with, following a leading `run:` — a fragment whose
 * first step composes an e2e flow starts with that flow's launch, and the runner
 * has to know that before step 1 to boot a chromium app for it. Null when the
 * run doesn't begin with a launch, or when the chain can't be read (a broken
 * `run:` target is reported properly by {@link execRunStep} when it executes).
 */
async function leadingLaunch(
  flow: FlowFile,
  flowsDir: string,
  seen: string[]
): Promise<Launch | null> {
  const first = flow.steps.find((s) => s.kind !== "echo");
  if (!first) return null;
  if (first.kind === "launch") return first.app;
  if (first.kind !== "run") return null;
  if (seen.includes(first.flow) || seen.length >= MAX_RUN_DEPTH) return null;
  try {
    assertSafeFlowName(first.flow);
    const path_ = path.join(flowsDir, `${first.flow}.yaml`);
    const nested = parseFlow(await fs.readFile(path_, "utf8"));
    return await leadingLaunch(nested, flowsDir, [...seen, first.flow]);
  } catch {
    return null;
  }
}

/**
 * The Chromium app-path spec to boot for this run, or null when the run's
 * leading launch isn't unambiguously a chromium one — `--platform chromium`, or
 * a single-platform `{ chromium: ... }` map. A multi-platform or bare launch
 * with no hint defers to device auto-detection.
 */
function chromiumBootSpec(
  app: Launch,
  platform: string | undefined
): { path: string; args?: string[] } | null {
  if (launchTargetPlatform(app, platform) !== "chromium") return null;
  return chromiumLaunchSpec(app);
}

/**
 * The platform a leading launch targets: an explicit `platform`, else the sole
 * key of a single-key launch map. Null when ambiguous (bare string, or several
 * keys) — the caller then auto-detects a booted device.
 */
function launchTargetPlatform(launch: Launch, platform: string | undefined): string | null {
  if (platform) return platform;
  if (typeof launch === "object") {
    const keys = Object.keys(launch);
    if (keys.length === 1) return keys[0]!;
  }
  return null;
}

/**
 * The absolute app path a chromium launch names — relative resolves against the
 * flow file's directory (the anchor `run:` and baselines use), absolute passes
 * through. Normalized either way, so two spellings of one app compare equal.
 */
function resolveAppPath(specPath: string, flowDir: string): string {
  return path.resolve(flowDir, specPath);
}

/**
 * Boot the Electron app a chromium launch declares. Boot failures propagate
 * as-is — the Chromium analog of `resolveFlowDevice` throwing on no booted
 * device. The app must exist on the *tool-server* host, so a flow-relative path
 * won't resolve on a remote tool-server (the flow file lives in a shipped temp
 * dir there).
 */
async function bootChromiumForFlow(
  spec: { path: string; args?: string[] },
  flowDir: string
): Promise<BootedChromium> {
  const appPath = resolveAppPath(spec.path, flowDir);
  const res = await bootElectronApp({ appPath, extraArgs: spec.args });
  return { deviceId: res.id, port: res.port, pid: res.pid, appPath: res.appPath };
}

/**
 * Tear down a Chromium instance the runner booted. Best-effort — never fail a
 * run here: dispose the CDP session (if a tool opened one), kill the process,
 * and forget its port so `list-devices` stops probing it. `awaitExit` waits for
 * the process to actually go (bounded — see {@link killChromiumByPortAndWait}),
 * which a same-app relaunch needs and run-end teardown does not.
 */
async function teardownBootedChromium(
  registry: Registry,
  booted: BootedChromium,
  opts: { awaitExit?: boolean } = {}
): Promise<void> {
  const urn = `${CHROMIUM_CDP_NAMESPACE}:${booted.deviceId}`;
  try {
    const entry = registry.getSnapshot().services.get(urn);
    if (entry && isLiveServiceState(entry.state)) await registry.disposeService(urn);
  } catch {
    /* the kill below frees the real resource regardless */
  }
  if (opts.awaitExit) await killChromiumByPortAndWait(booted.port, booted.pid);
  else killChromiumByPort(booted.port, booted.pid);
  untrackChromiumPort(booted.port);
}

/**
 * Focus the chromium page for the run. Best-effort: a flow must never fail
 * over focus housekeeping, so resolution/CDP errors are swallowed — the run
 * proceeds and any genuinely blocked step reports its own failure.
 */
async function frontChromiumPage(registry: Registry, device: DeviceInfo): Promise<void> {
  try {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    await api.cdp.send("Page.bringToFront");
  } catch {
    /* focus is best-effort */
  }
}

function summarize(
  flowName: string,
  deviceId: string,
  executionPrerequisite: string,
  steps: StepReport[],
  aborted: boolean
): FlowRunResult {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  for (const s of steps) {
    // Echo is narration, not a test step — counting it would let the summary
    // disagree with the renderers' step numbering (which skips echo too).
    if (s.kind === "echo") continue;
    if (s.status === "pass") passed++;
    else if (s.status === "fail") failed++;
    else if (s.status === "skip") skipped++;
    else errored++;
  }
  return {
    flow: flowName,
    device: deviceId,
    executionPrerequisite,
    // A cancelled run must never read as PASS — it may contain skips alone
    // (no fail/error report), so the verdict folds the abort in directly. A
    // skip by itself is NOT a failure: an unmet `when:` guard skips its block
    // as a successful omission, and a hard stop already carries its own
    // fail/error report.
    ok: failed === 0 && errored === 0 && !aborted,
    ...(aborted ? { aborted: true } : {}),
    passed,
    failed,
    skipped,
    errored,
    steps,
  };
}

/**
 * Append a report to the run and hand it to any live progress consumer. The
 * single choke point for every report — a push site that bypasses it would
 * silently drop steps from the progress stream.
 */
function pushReport(state: ExecState, report: StepReport): void {
  state.reports.push(report);
  state.onStepReport?.(report);
}

function selectorLabel(sel: FlowSelector): string {
  const parts: string[] = [];
  // The universal selector prints as CSS spells it, so a scope-only target
  // never renders as an empty label.
  if (sel.any) parts.push("*");
  if (sel.text !== undefined) parts.push(`"${sel.text}"`);
  if (sel.textMatches !== undefined) parts.push(`/${sel.textMatches}/`);
  if (sel.identifier) parts.push(`id=${sel.identifier}`);
  if (sel.role) parts.push(`role=${sel.role}`);
  // Each relational scope renders after the fields, parenthesized and
  // recursive, so two steps that differ only by scope don't collapse to the
  // same target label in the report — mirroring `describeSelector`'s
  // reason-string spelling so the two surfaces stay in lockstep (see
  // `conditionLabel`).
  for (const relation of SELECTOR_RELATIONS) {
    const scope = sel[relation];
    if (scope !== undefined) parts.push(`${relation} (${selectorLabel(scope)})`);
  }
  return parts.join(" ");
}

/**
 * One template for rendering an await/assert/when-guard UI condition,
 * parameterized by selector spelling — {@link selectorLabel} for report
 * targets, `describeSelector` for reason strings — so the two surfaces share
 * a single shape and cannot drift.
 */
function conditionLabel(
  cond: {
    condition: WaitCondition;
    selector: FlowSelector;
    expectedText?: string;
    textMatch?: TextMatchMode;
  },
  renderSelector: (sel: FlowSelector) => string
): string {
  const sel = renderSelector(cond.selector);
  // A text condition checks expectedText against the element the selector
  // locates; the other conditions are about the selector itself.
  if (cond.condition === "text") {
    return `${sel} ${describeTextExpectation(cond.expectedText, cond.textMatch)}`;
  }
  return `${cond.condition} ${sel}`;
}

/** Display-only "what this step acts on" for {@link StepReport.target}. */
function stepTarget(step: FlowStep): string | undefined {
  switch (step.kind) {
    case "tap":
    case "long-press":
      if (step.selector) return selectorLabel(step.selector);
      if (step.x !== undefined && step.y !== undefined) return `(${step.x}, ${step.y})`;
      return undefined;
    case "type":
      return `into ${selectorLabel(step.into)}`;
    case "await":
    case "assert":
      return conditionLabel(step, selectorLabel);
    case "when":
      return step.condition.kind === "platform"
        ? `platform ${step.condition.platform}`
        : conditionLabel(step.condition, selectorLabel);
    case "scroll-to": {
      const dir = step.direction !== "down" ? ` (${step.direction})` : "";
      return `${selectorLabel(step.target)}${dir}`;
    }
    case "pinch": {
      const scale = `scale ${step.scale}`;
      return step.selector ? `${selectorLabel(step.selector)} (${scale})` : scale;
    }
    case "rotate": {
      const by = `by ${step.by}°`;
      return step.selector ? `${selectorLabel(step.selector)} (${by})` : by;
    }
    case "snapshot":
      return step.cropOn ? `"${step.name}" cropOn ${selectorLabel(step.cropOn)}` : `"${step.name}"`;
    default:
      return undefined;
  }
}

/**
 * Where a list of steps executes: the fragment they are attributed to
 * (StepReport.flow), the `run:` chain for the cycle/depth guards, and the
 * nesting depth block directives accumulate for display. Threaded as one value
 * so a new block directive only has to hand its children {@link childScope}.
 */
interface StepScope {
  flow: string;
  runStack: string[];
  depth: number;
}

/** The scope a block directive's children execute in — one level deeper. */
function childScope(
  scope: StepScope,
  overrides: Partial<Omit<StepScope, "depth">> = {}
): StepScope {
  return { ...scope, ...overrides, depth: scope.depth + 1 };
}

/**
 * The depth stamp for a report — omitted at top level, so a flow with no block
 * directives produces a report byte-identical to the pre-depth shape.
 */
function depthOf(scope: StepScope): Pick<StepReport, "depth"> {
  return scope.depth ? { depth: scope.depth } : {};
}

/** Execute a list of steps, appending reports to state. Honors hard-stop + abort. */
async function execSteps(state: ExecState, steps: FlowStep[], scope: StepScope): Promise<void> {
  for (const step of steps) {
    const index = state.reports.length;

    if (state.stopped) {
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        flow: scope.flow,
        target: stepTarget(step),
        ...depthOf(scope),
        // Carry the echo's message so a skipped narration renders as a skip
        // line rather than vanishing — matching reportBlockSkipped.
        ...(step.kind === "echo" ? { message: step.message } : {}),
      });
      // A when block's literal steps are known — expand them so the report
      // keeps one line per authored step no matter where the stop landed.
      if (step.kind === "when") reportBlockSkipped(state, step.steps, childScope(scope));
      continue;
    }
    if (state.signal?.aborted) {
      state.stopped = true;
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        reason: "run aborted",
        flow: scope.flow,
        target: stepTarget(step),
        ...depthOf(scope),
        ...(step.kind === "echo" ? { message: step.message } : {}),
      });
      if (step.kind === "when") {
        reportBlockSkipped(state, step.steps, childScope(scope), "run aborted");
      }
      continue;
    }

    if (step.kind === "run") {
      await execRunStep(state, step, scope);
      continue;
    }
    if (step.kind === "when") {
      await execWhenStep(state, step, scope);
      continue;
    }

    const report = await execLeafStep(state, step, index, scope);
    pushReport(state, report);
    if (report.status === "fail" || report.status === "error") state.stopped = true;
  }
}

/** A compact rendering of a when guard for report reasons. */
function describeWhenCondition(cond: WhenCondition): string {
  if (cond.kind === "platform") return `platform ${cond.platform}`;
  return conditionLabel(cond, describeSelector);
}

/**
 * Report every step of a `when:` block that will not run as skipped — so a
 * run where the block was skipped (unmet guard, errored guard, hard stop, or
 * cancellation) produces the same report shape (one line per authored step,
 * at the same depth) as a run where it entered, and reports stay comparable
 * run-to-run. Nested when blocks expand (their literal steps are known); a
 * `run:` composition stays one line, matching how post-hard-stop skips report
 * a fragment that was never loaded. `scope` is the scope the steps would have
 * executed in — already the block's child scope, not the marker's.
 */
function reportBlockSkipped(
  state: ExecState,
  steps: FlowStep[],
  scope: StepScope,
  reason?: string
): void {
  for (const step of steps) {
    pushReport(state, {
      index: state.reports.length,
      kind: step.kind,
      status: "skip",
      reason,
      // A `run:` line is attributed to the fragment it names, matching the
      // executed marker in execRunStep; everything else belongs to the
      // enclosing flow.
      flow: step.kind === "run" ? step.flow : scope.flow,
      target: stepTarget(step),
      ...depthOf(scope),
      ...(step.kind === "echo" ? { message: step.message } : {}),
    });
    if (step.kind === "when") reportBlockSkipped(state, step.steps, childScope(scope), reason);
  }
}

/**
 * Execute a `when:` block: evaluate the guard (a platform test is static; a UI
 * condition probes with the short assert grace), then either expand the
 * guarded steps inline — where failures are real failures, hard-stopping as
 * usual — or report the whole block as skipped. An unreadable tree errors the
 * step instead: "could not evaluate" is not "condition false", and silently
 * skipping would let a broken tree source turn every guarded dismissal into a
 * green no-op.
 */
async function execWhenStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "when" }>,
  scope: StepScope
): Promise<void> {
  const index = state.reports.length;
  const label = describeWhenCondition(step.condition);
  const target = stepTarget(step);
  // The marker sits at the enclosing depth; the guarded steps one deeper —
  // whether they execute or report as skipped.
  const marker = { index, kind: "when", flow: scope.flow, target, ...depthOf(scope) } as const;
  const inner = childScope(scope);

  let met: boolean;
  if (step.condition.kind === "platform") {
    // "ios-remote" is an iOS simulator driven through sim-remote — for a
    // platform guard it IS ios. The parser deliberately rejects "ios-remote"
    // as a guard spelling, so without this fold no guard could ever match on
    // a remote sim and iOS-only blocks would silently skip there.
    const platform = state.device.platform === "ios-remote" ? "ios" : state.device.platform;
    met = platform === step.condition.platform;
  } else {
    const probe = await probeWhenCondition(state, step.condition);
    if (probe.aborted) {
      pushReport(state, { ...marker, status: "skip", reason: "run aborted" });
      reportBlockSkipped(state, step.steps, inner, "run aborted");
      return;
    }
    if (!probe.ok && probe.indeterminate) {
      pushReport(state, {
        ...marker,
        status: "error",
        reason: `could not evaluate when guard (${label}): ${probe.reason}`,
      });
      state.stopped = true;
      reportBlockSkipped(state, step.steps, inner, "when guard errored");
      return;
    }
    met = probe.ok;
  }

  if (!met) {
    const n = step.steps.length;
    pushReport(state, {
      ...marker,
      status: "skip",
      reason: `condition not met (${label}) — block skipped (${n} step${n === 1 ? "" : "s"})`,
    });
    reportBlockSkipped(state, step.steps, inner, "when block skipped");
    return;
  }

  // Marker for the block, then the guarded steps inline — same fragment
  // attribution, one level deeper, failures hard-stop as anywhere else.
  pushReport(state, { ...marker, status: "pass", reason: `condition met (${label})` });
  await execSteps(state, step.steps, inner);
}

async function execRunStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "run" }>,
  scope: StepScope
): Promise<void> {
  const index = state.reports.length;
  const target = step.flow;

  const fail = (reason: string): void => {
    pushReport(state, {
      index,
      kind: "run",
      status: "error",
      flow: target,
      reason,
      ...depthOf(scope),
    });
    state.stopped = true;
  };

  if (scope.runStack.includes(target)) {
    return fail(`cyclic flow reference: ${[...scope.runStack, target].join(" → ")}`);
  }
  if (scope.runStack.length >= MAX_RUN_DEPTH) {
    return fail("max run depth exceeded");
  }

  let fragment: FlowFile;
  try {
    assertSafeFlowName(target);
    const fragPath = path.join(state.flowsDir, `${target}.yaml`);
    fragment = parseFlow(await fs.readFile(fragPath, "utf8"));
  } catch (err) {
    return fail(`could not load fragment "${target}": ${errMsg(err)}`);
  }

  // Marker for the composition point, then expand the fragment's steps inline,
  // one level deeper, attributed to the fragment.
  pushReport(state, { index, kind: "run", status: "pass", flow: target, ...depthOf(scope) });
  await execSteps(
    state,
    fragment.steps,
    childScope(scope, { flow: target, runStack: [...scope.runStack, target] })
  );
}

async function execLeafStep(
  state: ExecState,
  step: FlowStep,
  index: number,
  scope: StepScope
): Promise<StepReport> {
  const base = {
    index,
    kind: step.kind,
    flow: scope.flow,
    target: stepTarget(step),
    ...depthOf(scope),
  } as const;
  const { registry, ctx, device, signal } = state;

  switch (step.kind) {
    case "echo":
      return { ...base, status: "pass", message: step.message };

    case "launch": {
      const r = await runLaunch(state, step.app);
      // A run cancelled mid-launch is a skip (matching the pre-step guard and
      // the directives), never a step failure — the app did nothing wrong.
      if (r.aborted) return { ...base, status: "skip", reason: r.reason };
      return { ...base, status: r.ok ? "pass" : "error", reason: r.reason };
    }

    case "tap":
    case "long-press":
    case "type":
    case "await":
    case "assert":
    case "scroll-to":
    case "pinch":
    case "rotate": {
      // A directive that *throws* (vs. reporting a failed outcome) — e.g. a
      // touch gesture on a focus-driven TV target — must still land in the
      // structured report rather than abort the whole run unreported.
      try {
        const r = await runDirective(state, step);
        // A run cancelled mid-directive is a skip (matching the pre-step guard
        // and `wait`), never a step failure — the app did nothing wrong.
        if (r.aborted) return { ...base, status: "skip", reason: r.reason };
        return { ...base, status: r.ok ? "pass" : "fail", reason: r.reason };
      } catch (err) {
        return { ...base, status: "error", reason: errMsg(err) };
      }
    }

    case "wait": {
      if (!(await sleepOrAbort(step.ms, signal))) {
        return { ...base, status: "skip", reason: "run aborted during wait" };
      }
      return { ...base, status: "pass" };
    }

    case "snapshot": {
      try {
        const r = await runSnapshot(state, {
          flowsDir: state.flowsDir,
          flowName: state.topFlowName,
          name: step.name,
          maxMismatch: step.maxMismatch ?? DEFAULT_MAX_MISMATCH,
          updateBaselines: state.updateBaselines,
          cropOn: step.cropOn,
        });
        return {
          ...base,
          status: r.status,
          reason: r.reason,
          snapshotKey: r.snapshotKey,
          artifacts: r.artifacts,
        };
      } catch (err) {
        return { ...base, status: "error", reason: errMsg(err) };
      }
    }

    case "tool": {
      const args = bindDeviceArgs(registry, step.name, device.id, step.args);
      const outputHint = registry.getTool(step.name)?.outputHint;
      if (step.delayMs && !(await sleepOrAbort(step.delayMs, signal))) {
        return { ...base, status: "skip", tool: step.name, reason: "run aborted during delay" };
      }
      try {
        const result = await invokeSubTool(registry, ctx, step.name, args);
        if (isUnmetUiWaitResult(step.name, result)) {
          const note = (result as { note?: string }).note;
          return {
            ...base,
            status: "fail",
            tool: step.name,
            reason: `await-ui-element condition not met${note ? `: ${note}` : ""}`,
          };
        }
        return { ...base, status: "pass", tool: step.name, result, outputHint, args };
      } catch (err) {
        return { ...base, status: "error", tool: step.name, reason: errMsg(err) };
      }
    }

    default:
      return { ...base, status: "error", reason: `unsupported step kind` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the flow YAML path a tool reads. With no `flow_file`, derive it from
 * project_root + name. When `flow_file` is set it must be one of the two shapes
 * the file-input boundary legitimately produces: the exact
 * `${project_root}/.argent/flows/${name}.yaml` path (co-located client,
 * resolved in place), or a temp file THIS server materialized from uploaded
 * content (`fileInput.viaUpload` — remote client). Anything else is rejected:
 * the schema marks `flow_file` internal, and honoring an arbitrary path would
 * let a caller execute (and, under --update-baselines, write PNGs next to) any
 * YAML on the host, bypassing the project-root containment the rest of the
 * module enforces. Name and project_root are validated in every branch.
 */
export function resolveFlowFilePath(
  params: {
    name: string;
    project_root: string;
    flow_file?: string;
  },
  fileInput?: ResolvedFileInput
): string {
  assertSafeFlowName(params.name);
  setActiveProjectRoot(params.project_root);
  const expected = getFlowPath(params.name);
  if (!params.flow_file) return expected;
  // A path the boundary materialized from uploaded content is a fresh temp
  // file this process itself created (see file-inputs.ts) — trusted as-is.
  if (fileInput?.viaUpload) return params.flow_file;
  if (
    !path.isAbsolute(params.flow_file) ||
    params.flow_file.split(/[\\/]+/).includes("..") ||
    path.resolve(params.flow_file) !== path.resolve(expected)
  ) {
    throw new FailureError(
      `Invalid flow_file "${params.flow_file}": it must resolve to the flow's path under the ` +
        `project root ("${expected}"). flow_file is internal — leave it unset and pass ` +
        `project_root + name.`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_file_containment",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  return params.flow_file;
}
