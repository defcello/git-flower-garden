import { describe, expect, it } from "vitest";
import {
  GPU_BUDGET_MS,
  gpuVerdict,
  isSoftwareRenderer,
  resolveTier,
  TIERS,
} from "../../src/ui/scene/tier.ts";

describe("resolveTier (ADR 0018, Choosing a tier)", () => {
  it("Auto takes the GPU only on graphics hardware", () => {
    expect(resolveTier("auto", "hardware")).toBe("gpu");
    expect(resolveTier("auto", "software")).toBe("software");
    expect(resolveTier("auto", "none")).toBe("software");
  });

  it("GPU by hand accepts software WebGL, and falls back without WebGL2", () => {
    expect(resolveTier("gpu", "hardware")).toBe("gpu");
    expect(resolveTier("gpu", "software")).toBe("gpu");
    expect(resolveTier("gpu", "none")).toBe("software");
  });

  it("a lost context draws with Software until it is restored", () => {
    expect(resolveTier("auto", "hardware", true)).toBe("software");
    expect(resolveTier("gpu", "software", true)).toBe("software");
  });

  it("a slow verdict moves Auto to Software, but not GPU chosen by hand", () => {
    expect(resolveTier("auto", "hardware", false, true)).toBe("software");
    expect(resolveTier("gpu", "hardware", false, true)).toBe("gpu");
  });

  it("Software and Static never use the GPU", () => {
    for (const support of ["hardware", "software", "none"] as const) {
      expect(resolveTier("software", support)).toBe("software");
      expect(resolveTier("static", support)).toBe("static");
    }
  });

  it("offers every tier in the View menu's order", () => {
    expect(TIERS).toEqual(["auto", "gpu", "software", "static"]);
  });
});

describe("isSoftwareRenderer", () => {
  it("recognizes software WebGL, including headless Chromium's", () => {
    for (const name of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "softpipe",
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)",
    ])
      expect(isSoftwareRenderer(name), name).toBe(true);
  });

  it("accepts graphics hardware", () => {
    for (const name of [
      "Mesa Intel(R) HD Graphics 4000 (IVB GT2)",
      "ANGLE (Intel, Intel(R) HD Graphics 615 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (NVIDIA, NVIDIA GeForce MX150 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "Apple M1",
    ])
      expect(isSoftwareRenderer(name), name).toBe(false);
  });
});

describe("gpuVerdict (the GPU tier's frame-time probe)", () => {
  it("waits for three plant frames", () => {
    expect(gpuVerdict({ landscape: [100], plants: [100, 100] })).toBeNull();
    expect(gpuVerdict({ landscape: [], plants: [1, 1, 1] })).toEqual({
      slow: false,
      ms: 1,
    });
  });

  it("adds the landscape's median to the plants' and compares with half a frame", () => {
    expect(GPU_BUDGET_MS).toBeCloseTo(1000 / 15 / 2);
    const fast = gpuVerdict({ landscape: [12, 14], plants: [9, 10, 11] });
    expect(fast).toEqual({ slow: false, ms: 24 });
    const slow = gpuVerdict({ landscape: [25], plants: [9, 10, 11] });
    expect(slow?.slow).toBe(true);
    expect(slow?.ms).toBe(35);
  });

  it("takes medians, so one stalled frame does not decide", () => {
    expect(gpuVerdict({ landscape: [], plants: [5, 500, 6] })?.slow).toBe(
      false,
    );
    expect(gpuVerdict({ landscape: [], plants: [40, 50, 6] })?.slow).toBe(true);
  });
});
