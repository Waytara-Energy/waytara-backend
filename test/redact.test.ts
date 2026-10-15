import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/lib/redact.js";

describe("redactUrl", () => {
  it("hides a charger's secret in its address and keeps the charger name", () => {
    expect(redactUrl("/ocpp/k3x9q2m7p4w8z1n5v6c0b2d4/WT_PZ_7k_1")).toBe("/ocpp/[redacted]/WT_PZ_7k_1");
    expect(redactUrl("/ocpp/k3x9q2m7p4w8z1n5v6c0b2d4/WT_PZ_7k_1?x=1&token=abc")).toBe("/ocpp/[redacted]/WT_PZ_7k_1?x=1&token=[redacted]");
    expect(redactUrl("/ocpp/WT_PZ_7k_1")).toBe("/ocpp/WT_PZ_7k_1"); // the Basic-authentication form has no secret in the address
  });

  it("leaves a url without a query alone", () => {
    expect(redactUrl("/healthz")).toBe("/healthz");
  });

  it("hides secret query values and keeps the rest", () => {
    expect(redactUrl("/live?ticket=abc123&equipment=42")).toBe("/live?ticket=[redacted]&equipment=42");
    expect(redactUrl("/x?token=aaa&key=bbb&password=ccc&page=2")).toBe("/x?token=[redacted]&key=[redacted]&password=[redacted]&page=2");
  });

  it("is case insensitive and handles encoded names", () => {
    expect(redactUrl("/x?Token=aaa")).toBe("/x?Token=[redacted]");
    expect(redactUrl("/x?%74oken=aaa")).toBe("/x?%74oken=[redacted]");
  });

  it("keeps a flag without a value", () => {
    expect(redactUrl("/x?debug&token=aaa")).toBe("/x?debug&token=[redacted]");
  });
});
