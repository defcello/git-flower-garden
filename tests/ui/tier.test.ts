import { describe, expect, it } from "vitest";
import {
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
