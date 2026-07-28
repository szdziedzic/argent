import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { exitAfterFlush, flow, parseRunArgs } from "../src/flow.js";
import { ToolInvocationError } from "@argent/tools-client";
import { FlagParseException } from "../src/flag-parser.js";

const toolsClientMock = vi.hoisted(() => ({
  callTool: vi.fn(),
  baseUrl: vi.fn(async () => ({ url: "http://127.0.0.1:4141", token: "tok" })),
}));
// Identity materialization; a spy so tests can assert it is only invoked for
// the failed-snapshot artifacts that --output actually copies.
const materializeArtifactsMock = vi.hoisted(() =>
  vi.fn(async (data: unknown) => ({ result: data, images: [] }))
);
const getResolvedToolsUrlMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ url: string | null; source: "none" | "env" | "link" }> => ({
      url: null,
      source: "none",
    })
  )
);

vi.mock("@argent/tools-client", async (importOriginal) => ({
  // Keep the real isArtifactHandle — the display-path fallback under test
  // must recognize genuine wire handles.
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  createToolsClient: vi.fn(() => toolsClientMock),
  getResolvedToolsUrl: getResolvedToolsUrlMock,
  materializeArtifacts: materializeArtifactsMock,
}));

interface StepFixture {
  index: number;
  kind: string;
  status: "pass" | "fail" | "skip" | "error";
  reason?: string;
  warning?: string;
  tool?: string;
  flow?: string;
  message?: string;
  snapshotKey?: string;
  artifacts?: Record<string, unknown>;
  /** Wire-only tool-step payload; the CLI StepReport type has no such field. */
  result?: unknown;
}

/** A wire artifact handle as the tool-server emits it (image/png). */
function handle(hostPath?: string): Record<string, unknown> {
  return {
    __argentArtifact: true,
    id: "art-1",
    filename: "art.png",
    mimeType: "image/png",
    size: 4,
    ...(hostPath ? { hostPath } : {}),
  };
}

/**
 * Whether a mode-000 file is actually unreadable to this process. `access(R_OK)`
 * succeeds for root regardless of mode (some CI containers run as root), and
 * Windows has no POSIX mode bits at all — in both cases the fixture would be
 * readable and the assertion would pass for the wrong reason. Skip the
 * unreadable-file cases there rather than let them go green vacuously.
 */
const canDenyRead = process.platform !== "win32" && process.getuid?.() !== 0;

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const steps: StepFixture[] = [{ index: 0, kind: "tap", status: "pass" }];
  return {
    flow: "checkout",
    device: "SIM-1",
    executionPrerequisite: "",
    ok: true,
    passed: 1,
    failed: 0,
    skipped: 0,
    errored: 0,
    steps,
    ...overrides,
  };
}

describe("parseRunArgs", () => {
  it("returns documented defaults with just a flow path", () => {
    expect(parseRunArgs(["../flows/checkout.yaml"])).toEqual({
      flowPath: "../flows/checkout.yaml",
      updateBaselines: false,
      recursive: false,
      json: false,
    });
  });

  it("parses every run flag alongside the path", () => {
    expect(
      parseRunArgs([
        "checkout.yaml",
        "--device",
        "SIM-1",
        "--platform",
        "ios",
        "--update-baselines",
      ])
    ).toEqual({
      flowPath: "checkout.yaml",
      device: "SIM-1",
      platform: "ios",
      updateBaselines: true,
      recursive: false,
      json: false,
    });
    expect(parseRunArgs(["--json", "checkout.yaml"]).json).toBe(true);
  });

  it("accepts -r and --recursive in any position", () => {
    expect(parseRunArgs(["flows", "-r"]).recursive).toBe(true);
    expect(parseRunArgs(["--recursive", "flows"]).recursive).toBe(true);
    expect(parseRunArgs(["flows"]).recursive).toBe(false);
  });

  it("throws when --recursive is given an inline value", () => {
    expect(() => parseRunArgs(["flows", "--recursive=1"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["flows", "--recursive=1"])).toThrow(
      "--recursive does not take a value"
    );
  });

  it("throws when --device is the final token", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--device"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout.yaml", "--device"])).toThrow("--device requires a value");
  });

  it("throws when --platform is the final token", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--platform"])).toThrow(
      "--platform requires a value"
    );
  });

  it("treats a following flag as a missing value, not as the value", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--device", "--json"])).toThrow(
      "--device requires a value"
    );
    expect(() => parseRunArgs(["checkout.yaml", "--platform", "--update-baselines"])).toThrow(
      "--platform requires a value"
    );
  });

  it("accepts the --flag=value form for every value-taking flag", () => {
    expect(
      parseRunArgs(["checkout.yaml", "--device=SIM-1", "--platform=ios", "--output=dir"])
    ).toEqual({
      flowPath: "checkout.yaml",
      device: "SIM-1",
      platform: "ios",
      output: "dir",
      updateBaselines: false,
      recursive: false,
      json: false,
    });
  });

  it("mixes = and space-separated forms freely", () => {
    expect(parseRunArgs(["checkout.yaml", "--device=SIM-1", "--platform", "ios"])).toEqual({
      flowPath: "checkout.yaml",
      device: "SIM-1",
      platform: "ios",
      updateBaselines: false,
      recursive: false,
      json: false,
    });
  });

  it("does not consume the next token when the value was inline", () => {
    // Guards the index bookkeeping: --device=SIM-1 must not swallow --json.
    const out = parseRunArgs(["checkout.yaml", "--device=SIM-1", "--json"]);
    expect(out.device).toBe("SIM-1");
    expect(out.json).toBe(true);
  });

  it("throws when a boolean flag is given an inline value", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--json=true"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout.yaml", "--json=true"])).toThrow(
      "--json does not take a value"
    );
    expect(() => parseRunArgs(["checkout.yaml", "--update-baselines=1"])).toThrow(
      "--update-baselines does not take a value"
    );
  });

  it("throws when an inline value is empty", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--device="])).toThrow("--device requires a value");
  });

  it("rejects unknown flags instead of silently dropping them", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--verbose"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout.yaml", "--verbose"])).toThrow(/unknown flag/);
    // A typo'd value flag must not fall back to device auto-detection.
    expect(() => parseRunArgs(["checkout.yaml", "--platfrom=ios"])).toThrow(/unknown flag/);
  });

  it("rejects extra positional arguments", () => {
    expect(() => parseRunArgs(["checkout.yaml", "extra.yaml"])).toThrow(
      "flow run accepts one YAML file or directory path"
    );
  });
});

describe("argent flow run", () => {
  let tempRoot: string;
  let checkoutPath: string;
  let bundleDirPath: string;
  let unreadablePath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const opts = { paths: {} as never };

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-flow-"));
    checkoutPath = path.join(tempRoot, "checkout.yaml");
    await fsp.writeFile(checkoutPath, "steps: []\n", "utf8");
    // The two paths `run`'s filesystem acceptance check rejects after the name
    // checks pass — both need real inodes, so they are built here rather than
    // faked: a directory that looks like a flow, and an unreadable file.
    bundleDirPath = path.join(tempRoot, "bundle.yaml");
    await fsp.mkdir(bundleDirPath, { recursive: true });
    unreadablePath = path.join(tempRoot, "noperm.yaml");
    await fsp.writeFile(unreadablePath, "steps: []\n", "utf8");
    await fsp.chmod(unreadablePath, 0o000);
  });

  afterAll(async () => {
    // Restore the mode before removing the tree: `rm` itself only needs the
    // parent's write bit, but a stray 0o000 file is a trap for anything that
    // later walks tmpdir, so never leave one behind if the rm is interrupted.
    await fsp.chmod(unreadablePath, 0o600).catch(() => {});
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getResolvedToolsUrlMock.mockResolvedValue({ url: null, source: "none" });
    toolsClientMock.callTool.mockResolvedValue({ data: report() });
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("resolves the YAML path and forwards flags to flow-execute", async () => {
    const relativeCheckoutPath = path.relative(process.cwd(), checkoutPath);
    await expect(
      flow(
        [
          "run",
          relativeCheckoutPath,
          "--device",
          "SIM-1",
          "--platform",
          "ios",
          "--update-baselines",
        ],
        opts
      )
    ).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "flow-execute",
      {
        flow_path: checkoutPath,
        project_root: process.cwd(),
        prerequisiteAcknowledged: true,
        device: "SIM-1",
        platform: "ios",
        updateBaselines: true,
      },
      { onProgress: expect.any(Function) }
    );
    expect(logs.join("\n")).toContain("PASS — 1 passed, 0 failed, 0 errored, 0 skipped");
  });

  it("exits 2 without calling the tool when --device is missing its value", async () => {
    await expect(flow(["run", "checkout", "--device"], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--device requires a value");
  });

  it("exits 2 without calling the tool when --platform is followed by another flag", async () => {
    await expect(flow(["run", "checkout", "--platform", "--json"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--platform requires a value");
  });

  it("forwards --flag=value forms to flow-execute like the space-separated ones", async () => {
    await expect(
      flow(["run", checkoutPath, "--platform=ios", "--device=SIM-1"], opts)
    ).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "flow-execute",
      {
        flow_path: checkoutPath,
        project_root: process.cwd(),
        prerequisiteAcknowledged: true,
        device: "SIM-1",
        platform: "ios",
      },
      { onProgress: expect.any(Function) }
    );
  });

  it("exits 2 without calling the tool when a boolean flag is given a value", async () => {
    await expect(flow(["run", "checkout", "--json=x"], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--json does not take a value");
  });

  it("exits 2 without calling the tool on a typo'd flag instead of auto-detecting a device", async () => {
    await expect(flow(["run", "checkout", "--platfrom=ios"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("unknown flag");
  });

  it("exits 2 when no flow path is given", async () => {
    await expect(flow(["run"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain("requires a YAML file path");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("rejects a saved-flow name with a migration hint", async () => {
    await expect(flow(["run", "checkout"], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain("Saved-flow name lookup is no longer supported");
    expect(errs.join("\n")).toContain("argent flow run .argent/flows/checkout.yaml");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("rejects missing and invalid YAML paths before routing or tool invocation", async () => {
    await expect(flow(["run", path.join(tempRoot, "missing.yaml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("Flow file not found");

    errs.length = 0;
    await expect(flow(["run", path.join(tempRoot, "checkout.yml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("Flow path must end in .yaml");

    errs.length = 0;
    await expect(flow(["run", path.join(tempRoot, "unsafe name.yaml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("Flow filename must have a non-empty name");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("names the lowercase requirement when only the extension's case is wrong", async () => {
    await expect(flow(["run", path.join(tempRoot, "Checkout.YAML")], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(errs.join("\n")).toContain("Flow extension must be lowercase .yaml, not .YAML");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it.each([[".yaml"], ["dir/.yaml"], [".YAML"]])(
    "names the missing stem when the path %s is only the extension",
    async (supplied) => {
      await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

      expect(errs.join("\n")).toContain("Flow filename must have a non-empty name");
      expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    }
  );

  it("exits 2 on a directory named like a flow instead of handing it to flow-execute", async () => {
    // `access(R_OK)` succeeds on a readable directory, so only the isFile()
    // check keeps a `bundle.yaml/` directory out of the runner.
    await expect(flow(["run", bundleDirPath], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain(`Flow path is not a file: ${bundleDirPath}`);
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  // Skipped as root / on Windows, where a mode-000 file is still readable —
  // see canDenyRead.
  it.skipIf(!canDenyRead)(
    "exits 2 on an unreadable flow file rather than letting flow-execute hit EACCES",
    async () => {
      // The exit code is the contract, not just the wording: without the
      // readability probe the EACCES surfaces out of the tool call instead,
      // which exits 1 — a CI wrapper that tells a usage error (2) from a run
      // failure (1) would silently reclassify an unreadable file as a failing run.
      await expect(flow(["run", unreadablePath], opts)).rejects.toThrow("process.exit:2");

      expect(errs.join("\n")).toContain(`Could not read flow file: ${unreadablePath}`);
      expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["env", "Unset ARGENT_TOOLS_URL"],
    ["link", "argent unlink"],
  ] as const)("rejects %s routing without invoking flow-execute", async (source, recovery) => {
    getResolvedToolsUrlMock.mockResolvedValue({
      url: "http://example.test:4141",
      source,
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain("requires the auto-started local tool server");
    expect(errs.join("\n")).toContain(recovery);
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("lists runnable YAML paths without consulting remote routing", async () => {
    const listRoot = path.join(tempRoot, "list-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(flowsDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "z-last.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "a-first.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "ignored.yml"), "steps: []\n"),
    ]);
    getResolvedToolsUrlMock.mockResolvedValue({
      url: "http://example.test:4141",
      source: "env",
    });
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(
      [".argent/flows/a-first.yaml", ".argent/flows/z-last.yaml"].join("\n")
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("omits .yaml files whose names `flow run` would reject", async () => {
    const listRoot = path.join(tempRoot, "list-unsafe-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(flowsDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "sign.in.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "sign-in.yaml"), "steps: []\n"),
    ]);
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    // Silently omitted, like non-.yaml entries — every printed path is runnable.
    expect(logs.join("\n")).toBe(".argent/flows/sign-in.yaml");
  });

  it("omits a directory named like a flow, which `flow run` rejects as not a file", async () => {
    const listRoot = path.join(tempRoot, "list-dir-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    await fsp.writeFile(path.join(flowsDir, "checkout.yaml"), "steps: []\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(".argent/flows/checkout.yaml");
  });

  // Skipped as root / on Windows, where a mode-000 file is still readable —
  // see canDenyRead.
  it.skipIf(!canDenyRead)(
    "omits an unreadable flow file, which `flow run` rejects as unreadable",
    async () => {
      const listRoot = path.join(tempRoot, "list-noperm-project");
      const flowsDir = path.join(listRoot, ".argent", "flows");
      await fsp.mkdir(flowsDir, { recursive: true });
      const unreadable = path.join(flowsDir, "noperm.yaml");
      await fsp.writeFile(path.join(flowsDir, "checkout.yaml"), "steps: []\n");
      await fsp.writeFile(unreadable, "steps: []\n");
      await fsp.chmod(unreadable, 0o000);
      const previousCwd = process.cwd();
      try {
        process.chdir(listRoot);
        await flow(["list"], opts);
      } finally {
        process.chdir(previousCwd);
        // Restore before afterAll's rm walks the tree (see there).
        await fsp.chmod(unreadable, 0o600);
      }

      // stat() succeeds on it — only the readability probe keeps `list` from
      // advertising a path `flow run` then refuses.
      expect(logs.join("\n")).toBe(".argent/flows/checkout.yaml");
    }
  );

  it("lists a symlink to a flow file, which `flow run` accepts, but not a broken one", async () => {
    const listRoot = path.join(tempRoot, "list-symlink-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(flowsDir, { recursive: true });
    await fsp.writeFile(path.join(tempRoot, "shared-flow.yaml"), "steps: []\n");
    await fsp.symlink(path.join(tempRoot, "shared-flow.yaml"), path.join(flowsDir, "linked.yaml"));
    await fsp.symlink(path.join(tempRoot, "missing-flow.yaml"), path.join(flowsDir, "broken.yaml"));
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(".argent/flows/linked.yaml");
  });

  it("prints the no-flows message when no entry in the directory is runnable", async () => {
    const listRoot = path.join(tempRoot, "list-empty-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe("No flows found in .argent/flows");
  });

  it("renders the report — echo lines unnumbered, real steps numbered, reasons and fragment tags shown — and exits 1 on failure", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        executionPrerequisite: "App on the login screen",
        ok: false,
        passed: 1,
        failed: 1,
        skipped: 1,
        steps: [
          { index: 0, kind: "echo", status: "pass", message: "Opening settings" },
          { index: 1, kind: "tap", status: "pass" },
          { index: 2, kind: "assert", status: "fail", reason: "never visible", flow: "login" },
          { index: 3, kind: "tool", tool: "screenshot", status: "skip" },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    const out = logs.join("\n");
    expect(out).toContain('Flow "checkout" on SIM-1');
    expect(out).toContain("assumes: App on the login screen");
    // Echo is narration — no index; numbering starts at the first real step.
    expect(out).toContain("› Opening settings");
    expect(out).toMatch(/✓ {2}1 tap/);
    expect(out).toMatch(/✗ {2}2 assert \[login\] — never visible/);
    expect(out).toMatch(/· {2}3 tool screenshot/);
    expect(out).toContain("FAIL — 1 passed, 1 failed, 0 errored, 1 skipped");
  });

  it("renders legacy warnings with the ⚠ glyph and counts them in the summary", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        steps: [{ index: 0, kind: "snapshot", status: "pass", warning: "no baseline; adopted" }],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:0");

    const out = logs.join("\n");
    expect(out).toMatch(/⚠ {2}1 snapshot/);
    expect(out).toContain("⚠ no baseline; adopted");
    expect(out).toContain("1 warning");
  });

  it("prints the raw report with --json", async () => {
    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow("process.exit:0");
    expect(JSON.parse(logs.join("\n"))).toEqual(report());
  });

  it("renders failed-snapshot handles as server paths without fetching when --output is absent", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        passed: 0,
        failed: 1,
        steps: [
          {
            index: 0,
            kind: "snapshot",
            status: "fail",
            reason: "1.2% differs",
            snapshotKey: "home__ios-390x844",
            artifacts: {
              baseline: handle("/srv/base.png"),
              current: handle("/srv/cur.png"),
              diff: handle("/srv/diff.png"),
            },
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    // Nothing to download: paths come straight off the handles, and the
    // server URL is never even resolved.
    expect(materializeArtifactsMock).not.toHaveBeenCalled();
    expect(toolsClientMock.baseUrl).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toContain("baseline: /srv/base.png");
    expect(out).toContain("current: /srv/cur.png");
    expect(out).toContain("diff: /srv/diff.png");
  });

  it("never materializes tool-step results (the CLI renders no images)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        steps: [
          {
            index: 0,
            kind: "tool",
            tool: "screenshot",
            status: "pass",
            result: { image: handle("/srv/shot.png") },
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:0");

    expect(materializeArtifactsMock).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toMatch(/✓ {2}1 tool screenshot/);
    expect(out).toContain("PASS — 1 passed");
  });

  it("materializes only the failed snapshot's artifacts when --output is set", async () => {
    const failedArtifacts = { baseline: handle("/srv/base.png") };
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        failed: 1,
        steps: [
          {
            index: 0,
            kind: "tool",
            tool: "screenshot",
            status: "pass",
            result: { image: handle("/srv/shot.png") },
          },
          {
            index: 1,
            kind: "snapshot",
            status: "fail",
            snapshotKey: "home__ios-390x844",
            artifacts: failedArtifacts,
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath, "--output", "flow-artifacts"], opts)).rejects.toThrow(
      "process.exit:1"
    );

    // One materialization, scoped to the failed snapshot's artifacts object —
    // not the whole report (which would pull the tool-step screenshot too).
    expect(toolsClientMock.baseUrl).toHaveBeenCalledTimes(1);
    expect(materializeArtifactsMock).toHaveBeenCalledTimes(1);
    expect(materializeArtifactsMock).toHaveBeenCalledWith(failedArtifacts, {
      toolsUrl: "http://127.0.0.1:4141",
      authToken: "tok",
    });
  });

  it("emits string artifact paths in --json without --output (hostPath, or filename)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        passed: 0,
        failed: 1,
        steps: [
          {
            index: 0,
            kind: "snapshot",
            status: "fail",
            snapshotKey: "home__ios-390x844",
            artifacts: { baseline: handle("/srv/base.png"), diff: handle() },
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(materializeArtifactsMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(logs.join("\n")) as {
      steps: { artifacts?: Record<string, unknown> }[];
    };
    // Strings, not handle objects: hostPath when present, filename otherwise.
    expect(parsed.steps[0]?.artifacts).toEqual({ baseline: "/srv/base.png", diff: "art.png" });
  });

  it("prints legacy string artifact paths as-is (pre-handle tool-server)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        passed: 0,
        failed: 1,
        steps: [
          {
            index: 0,
            kind: "snapshot",
            status: "fail",
            artifacts: { baseline: "/tmp/snaps/home.png", diff: "/tmp/snaps/home-diff.png" },
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(materializeArtifactsMock).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toContain("baseline: /tmp/snaps/home.png");
    expect(out).toContain("diff: /tmp/snaps/home-diff.png");
  });

  it("exits 1 with the error message when the tool call fails", async () => {
    toolsClientMock.callTool.mockRejectedValue(new Error("tool-server unreachable"));

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");
    expect(errs.join("\n")).toContain("tool-server unreachable");
  });

  it("exits 2 when the result is not a run report (e.g. a prerequisite notice)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: { flow: "checkout", notice: "prerequisite", executionPrerequisite: "logged in" },
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain('"checkout" did not produce a run report');
  });

  it("exits 2 on an unknown subcommand", async () => {
    await expect(flow(["frobnicate"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain('Unknown flow subcommand "frobnicate"');
  });

  it("prints help and returns (no exit) with no subcommand", async () => {
    await flow([], opts);
    expect(logs.join("\n")).toContain("Usage: argent flow");
    expect(logs.join("\n")).toContain(
      "filename (minus .yaml) names the run's report and artifacts"
    );
    expect(logs.join("\n")).toContain('contain only letters, numbers, "_", or "-"');
    expect(logs.join("\n")).toContain(
      "ARGENT_TOOLS_URL and `argent link` routing are not supported"
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints help instead of running when --help follows the flow name", async () => {
    await flow(["run", "checkout", "--help"], opts);
    expect(logs.join("\n")).toContain("Options (run):");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints help instead of running when -h trails other run flags", async () => {
    await flow(["run", "checkout", "--device", "SIM-1", "-h"], opts);
    expect(logs.join("\n")).toContain("Usage: argent flow");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });
});

describe("argent flow run <dir>", () => {
  let tempRoot: string;
  let flowsDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const opts = { paths: {} as never };

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-flow-dir-"));
    flowsDir = path.join(tempRoot, "flows");
    // Two runnable top-level flows plus every kind of entry discovery must
    // ignore: wrong extension, unsafe stem, a directory named like a flow,
    // and (non-recursively) anything nested.
    await fsp.mkdir(path.join(flowsDir, "sub"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, ".hidden"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, "node_modules"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "a-login.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "b-checkout.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "notes.yml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "bad name.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "sub", "c-search.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, ".hidden", "hidden.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "node_modules", "dep.yaml"), "steps: []\n"),
    ]);
  });

  afterAll(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getResolvedToolsUrlMock.mockResolvedValue({ url: null, source: "none" });
    toolsClientMock.callTool.mockResolvedValue({ data: report() });
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("runs each top-level flow in order without live progress and exits 0 when all pass", async () => {
    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:0");

    // Only the two safe top-level .yaml files, in lexicographic order, and
    // never with onProgress (batch output is failures-only).
    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    expect(toolsClientMock.callTool).toHaveBeenNthCalledWith(1, "flow-execute", {
      flow_path: path.join(flowsDir, "a-login.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    expect(toolsClientMock.callTool).toHaveBeenNthCalledWith(2, "flow-execute", {
      flow_path: path.join(flowsDir, "b-checkout.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    const out = logs.join("\n");
    expect(out).toContain("[1/2] a-login.yaml");
    expect(out).toContain("[2/2] b-checkout.yaml");
    expect(out).toContain("PASS on SIM-1 — 1 passed, 0 failed, 0 errored, 0 skipped");
    // Passing steps stay silent in batch mode.
    expect(out).not.toMatch(/✓ {2}1 tap/);
    expect(out).toContain("PASS — 2 flows: 2 passed, 0 failed, 0 skipped");
  });

  it("forwards run flags to every flow in the batch", async () => {
    await expect(
      flow(["run", flowsDir, "--device", "SIM-1", "--platform", "ios", "--update-baselines"], opts)
    ).rejects.toThrow("process.exit:0");

    for (const call of toolsClientMock.callTool.mock.calls) {
      expect(call[1]).toMatchObject({ device: "SIM-1", platform: "ios", updateBaselines: true });
    }
  });

  it("continues after a failed flow, printing only its failing steps, and exits 1", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({
        data: report({
          flow: "a-login",
          ok: false,
          passed: 1,
          failed: 1,
          steps: [
            { index: 0, kind: "tap", status: "pass" },
            { index: 1, kind: "assert", status: "fail", reason: "never visible" },
          ],
        }),
      })
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    const out = logs.join("\n");
    // The failing step keeps its full-report number; the passing tap is silent.
    expect(out).toMatch(/✗ {2}2 assert — never visible/);
    expect(out).not.toMatch(/✓ {2}1 tap/);
    expect(out).toContain("FAIL on SIM-1 — 1 passed, 1 failed, 0 errored, 0 skipped");
    expect(out).toContain("FAIL — 2 flows: 1 passed, 1 failed, 0 skipped");
  });

  it("stops the batch on a tool-call throw and counts the remaining flows skipped", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockRejectedValueOnce(new Error("tool-server unreachable"));

    await expect(flow(["run", flowsDir, "-r"], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    expect(errs.join("\n")).toContain("tool-server unreachable");
    const out = logs.join("\n");
    expect(out).toContain(`[3/3] ${path.join("sub", "c-search.yaml")}`);
    expect(out).toContain("· not run (batch stopped)");
    expect(out).toContain("FAIL — 3 flows: 1 passed, 1 failed, 1 skipped");
  });

  it("continues past a flow the tool-server rejects as invalid", async () => {
    toolsClientMock.callTool
      .mockRejectedValueOnce(
        new ToolInvocationError("flow file is not valid YAML", {
          errorCode: "FLOW_FILE_INVALID",
          errorKind: "validation",
        })
      )
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    // A validation rejection is specific to that flow file — the batch ran on.
    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    expect(errs.join("\n")).toContain("flow file is not valid YAML");
    const out = logs.join("\n");
    expect(out).not.toContain("not run (batch stopped)");
    expect(out).toContain("FAIL — 2 flows: 1 passed, 1 failed, 0 skipped");
  });

  it("stops the batch on a server error the signal does not mark as validation", async () => {
    toolsClientMock.callTool.mockRejectedValueOnce(
      new ToolInvocationError("simulator boot failed", { errorKind: "subprocess" })
    );

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("FAIL — 2 flows: 0 passed, 1 failed, 1 skipped");
  });

  it("treats a non-report result as a failure that stops the batch", async () => {
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: { flow: "a-login", notice: "prerequisite" },
    });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    expect(errs.join("\n")).toContain('"a-login.yaml" did not produce a run report');
    expect(logs.join("\n")).toContain("FAIL — 2 flows: 0 passed, 1 failed, 1 skipped");
  });

  it("finds nested flows with --recursive, skipping dot-directories and node_modules", async () => {
    await expect(flow(["run", flowsDir, "--recursive"], opts)).rejects.toThrow("process.exit:0");

    const flowPaths = toolsClientMock.callTool.mock.calls.map(
      (c) => (c[1] as { flow_path: string }).flow_path
    );
    expect(flowPaths).toEqual([
      path.join(flowsDir, "a-login.yaml"),
      path.join(flowsDir, "b-checkout.yaml"),
      path.join(flowsDir, "sub", "c-search.yaml"),
    ]);
    expect(logs.join("\n")).toContain(`[3/3] ${path.join("sub", "c-search.yaml")}`);
  });

  it("treats a directory named like a flow file as a directory", async () => {
    const dirYaml = path.join(tempRoot, "suite.yaml");
    await fsp.mkdir(dirYaml, { recursive: true });
    await fsp.writeFile(path.join(dirYaml, "one.yaml"), "steps: []\n");

    await expect(flow(["run", dirYaml], opts)).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith("flow-execute", {
      flow_path: path.join(dirYaml, "one.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    expect(logs.join("\n")).toContain("PASS — 1 flow: 1 passed, 0 failed, 0 skipped");
  });

  it("exits 2 when --recursive is given a file path", async () => {
    await expect(flow(["run", path.join(flowsDir, "a-login.yaml"), "-r"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(errs.join("\n")).toContain(
      `flow run --recursive requires a directory path: ${path.join(flowsDir, "a-login.yaml")}`
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("exits 2 when --recursive is given a nonexistent path", async () => {
    const missing = path.join(tempRoot, "missing-dir");
    await expect(flow(["run", missing, "-r"], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain(`Flow directory not found: ${missing}`);
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("exits 2 with a --recursive hint when a directory holds no flows", async () => {
    const emptyDir = path.join(tempRoot, "empty");
    await fsp.mkdir(emptyDir, { recursive: true });

    await expect(flow(["run", emptyDir], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain(`No flows found in ${emptyDir}`);
    expect(errs.join("\n")).toContain("-r/--recursive");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();

    // Already recursive: the hint would be a dead end, so it is omitted.
    errs.length = 0;
    await expect(flow(["run", emptyDir, "-r"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain("No flows found");
    expect(errs.join("\n")).not.toContain("subdirectories");
  });

  it("rejects remote routing before running any flow in the directory", async () => {
    getResolvedToolsUrlMock.mockResolvedValue({ url: "http://example.test:4141", source: "env" });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain("requires the auto-started local tool server");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints only the aggregate object with --json, tagging infra failures and skips", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockRejectedValueOnce(new Error("boom"));

    await expect(flow(["run", flowsDir, "--json", "-r"], opts)).rejects.toThrow("process.exit:1");

    // A single parseable object on stdout — no headers or verdict lines.
    const parsed = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: false,
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      flows: [
        { path: "a-login.yaml", status: "pass", report: report({ flow: "a-login" }) },
        { path: "b-checkout.yaml", status: "fail", error: "boom" },
        { path: path.join("sub", "c-search.yaml"), status: "skip" },
      ],
    });
  });

  it("keys --output exports by the flow's subdirectory in recursive runs", async () => {
    const diffSrc = path.join(tempRoot, "diff-src.png");
    await fsp.writeFile(diffSrc, "png-bytes");
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) })
      .mockResolvedValueOnce({
        data: report({
          flow: "c-search",
          ok: false,
          passed: 0,
          failed: 1,
          steps: [
            {
              index: 0,
              kind: "snapshot",
              status: "fail",
              snapshotKey: "home__ios-390x844",
              artifacts: { diff: diffSrc },
            },
          ],
        }),
      });
    const outDir = path.join(tempRoot, "out");

    await expect(flow(["run", flowsDir, "-r", "--output", outDir], opts)).rejects.toThrow(
      "process.exit:1"
    );

    // The nested flow's export lands under its subdirectory so a same-stem
    // flow at the top level cannot collide with it.
    const dest = path.join(outDir, "sub", "c-search", "home__ios-390x844-diff.png");
    await expect(fsp.readFile(dest, "utf8")).resolves.toBe("png-bytes");
    expect(logs.join("\n")).toContain(`diff: ${dest}`);
  });

  it("keeps a top-level batch flow's --output export at <output>/<flow> exactly", async () => {
    const diffSrc = path.join(tempRoot, "top-diff-src.png");
    await fsp.writeFile(diffSrc, "top-png-bytes");
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockResolvedValueOnce({
        data: report({
          flow: "b-checkout",
          ok: false,
          passed: 0,
          failed: 1,
          steps: [
            {
              index: 0,
              kind: "snapshot",
              status: "fail",
              snapshotKey: "home__ios-390x844",
              artifacts: { diff: diffSrc },
            },
          ],
        }),
      });
    const outDir = path.join(tempRoot, "out-top");

    await expect(flow(["run", flowsDir, "--output", outDir], opts)).rejects.toThrow(
      "process.exit:1"
    );

    // dirname(rel) is "." at the top level and must collapse into the base —
    // the single-run <output>/<flow>/ layout, not <output>/<flow>.yaml/....
    const dest = path.join(outDir, "b-checkout", "home__ios-390x844-diff.png");
    await expect(fsp.readFile(dest, "utf8")).resolves.toBe("top-png-bytes");
    expect(logs.join("\n")).toContain(`diff: ${dest}`);
  });

  it("skips an unreadable nested subdirectory instead of aborting discovery", async () => {
    // Root ignores mode bits, so the unreadable-subtree scenario cannot occur.
    if (process.getuid?.() === 0) return;
    const suiteDir = path.join(tempRoot, "suite");
    const lockedDir = path.join(suiteDir, "locked");
    await fsp.mkdir(lockedDir, { recursive: true });
    await fsp.writeFile(path.join(suiteDir, "open.yaml"), "steps: []\n");
    await fsp.writeFile(path.join(lockedDir, "hidden.yaml"), "steps: []\n");
    await fsp.chmod(lockedDir, 0o000);
    try {
      await expect(flow(["run", suiteDir, "-r"], opts)).rejects.toThrow("process.exit:0");

      // The readable top-level flow still ran; the locked subtree was skipped
      // without the top-level "Could not read flow directory" abort.
      expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
      expect(toolsClientMock.callTool).toHaveBeenCalledWith(
        "flow-execute",
        expect.objectContaining({ flow_path: path.join(suiteDir, "open.yaml") })
      );
      expect(errs.join("\n")).not.toContain("Could not read flow directory");
    } finally {
      await fsp.chmod(lockedDir, 0o755);
    }
  });
});

describe("exitAfterFlush", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("exits only after every queued write has drained (piped stdout is async)", async () => {
    // Model a pipe with a slow reader: each chunk sits in the stream's queue
    // until _write's deferred callback fires — exactly the state a >64KB
    // `--json` report is in when the old bare process.exit() truncated it.
    const flushed: string[] = [];
    let exitedEarly = false;
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _enc, cb) {
        setTimeout(() => {
          if (exitSpy.mock.calls.length > 0) exitedEarly = true;
          flushed.push(chunk.toString());
          cb();
        }, 5);
      },
    });
    slow.write("a".repeat(64 * 1024));
    slow.write("b".repeat(64 * 1024));

    await expect(exitAfterFlush(1, [slow])).rejects.toThrow("process.exit:1");

    expect(exitedEarly).toBe(false);
    expect(flushed.join("")).toContain("a".repeat(64 * 1024));
    expect(flushed.join("")).toContain("b".repeat(64 * 1024));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("preserves the exit code with nothing queued", async () => {
    const idle = new Writable({ write: (_c, _e, cb) => cb() });
    await expect(exitAfterFlush(2, [idle])).rejects.toThrow("process.exit:2");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
