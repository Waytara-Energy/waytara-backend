import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/lib/redact.js";

describe("redactUrl", () => {
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
