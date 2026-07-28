import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const ANDROID_DEVICE = "emulator-5554";
let tmpDir: string;

interface Call {
  id: string;
  args: Record<string, unknown>;
}

/**
 * Android hierarchy with one focused EditText, shaped like a real device: the
 * hint arrives as `content-desc` (which becomes the node's LABEL) and the
 * entered contents as `text` (which becomes its VALUE). The two must differ,
 * or the flow tree treats the text as the label and emits no `value` at all —
 * exactly what an emptied field looks like.
 */
const fieldXml = (text: string, password = false) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="${text}" focused="true" password="${password}" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

function mockRegistry(calls: Call[], getHierarchy: () => { xml: string }): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args });
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => getHierarchy()),
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

/** Keyboard call args with the auto-injected `udid` stripped, in call order. */
const keyboardArgs = (calls: Call[]) =>
  calls
    .filter((c) => c.id === "keyboard")
    .map(({ args }) => {
      const { udid: _udid, ...rest } = args;
      return rest;
    });

const run = (registry: Registry) =>
  createRunFlowTool(registry).execute(
    {},
    { name: "f", project_root: tmpDir, device: ANDROID_DEVICE }
  );

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-type-clear-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("type directive — clear dispatch", () => {
  it("clears before typing, and submits after (tap → clear → text → enter)", async () => {
    const calls: Call[] = [];
    // Field reads empty from the start: the pre-clear reads and the post-clear
    // verification all see "", so the clear is treated as having landed.
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);

    // The clear is its own keyboard call and must precede the text. A combined
    // call is deliberately NOT used: `typeTv` rejects `key` before typing, so
    // collapsing these would break TV targets.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }, { text: "new@example.com" }, { key: "enter" }]);

    // …and the focusing tap comes before all of them.
    const order = calls
      .filter((c) => c.id === "gesture-tap" || c.id === "keyboard")
      .map((c) => c.id);
    expect(order[0]).toBe("gesture-tap");
  });

  it("does not submit a clear-only step", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    // Enter into a field the step just emptied is never the intent — and on a
    // search box it would run an empty query.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }]);
  });

  it("submits a clear-only step when the author asks for it explicitly", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true, submit: true }],
    });

    asRun(await run(registry));
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }, { key: "enter" }]);
  });

  it("issues no clear call for a plain type step", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x" }],
    });

    asRun(await run(registry));
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ text: "x" }, { key: "enter" }]);
  });
});

describe("type directive — post-clear verification", () => {
  it("fails the step when the field is still populated after the clear", async () => {
    const calls: Call[] = [];
    // The field never empties — e.g. a backend where the clear silently no-ops.
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("old@example.com") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toMatch(/clear left .* non-empty/);
    expect(result.steps[0]!.reason).toContain("old@example.com");

    // The text must NOT be typed after a failed clear: that is exactly the
    // append this feature exists to prevent, and it would fail later at an
    // assert pointing at the wrong step.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }]);
  });

  it("passes when the emptied field reports only its placeholder", async () => {
    const calls: Call[] = [];
    // An empty Android field reports NO `text` attribute, while its hint still
    // surfaces as the node's label ("Username or email address"). Reading the
    // label as content would fail every successful clear — observed on a real
    // device before the check was narrowed to `value`.
    const registry = mockRegistry(calls, () => ({
      xml: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`,
    }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true }, { text: "x" }, { key: "enter" }]);
  });

  it("skips the check on a password field instead of reading it as empty", async () => {
    const calls: Call[] = [];
    // uiautomator reports empty text for password nodes, so an unconditional
    // check would be a false PASS there — worse than not checking. The node
    // below carries a non-empty text to prove the skip is driven by the
    // password flag, not by the field looking empty.
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("still-here", true) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "hunter2", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }, { text: "hunter2" }, { key: "enter" }]);
  });

  it("does not read the tree back at all when the step has no clear", async () => {
    let reads = 0;
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: fieldXml("") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x" }],
    });
    asRun(await run(registry));
    const withoutClear = reads;

    reads = 0;
    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x", clear: true }],
    });
    asRun(await run(registry));

    // The verification costs exactly one extra tree read, and only when asked.
    expect(reads).toBe(withoutClear + 1);
  });
});
