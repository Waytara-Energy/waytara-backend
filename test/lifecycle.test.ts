import { afterEach, describe, expect, it, vi } from "vitest";
import { gracefulClose, type Closable } from "../src/lifecycle.js";

function fakeApp(close: () => Promise<unknown>): Closable & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    close,
    log: {
      info: (_o, msg) => void messages.push(`info:${msg}`),
      error: (_o, msg) => void messages.push(`error:${msg ?? String(_o)}`),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("gracefulClose", () => {
  it("closes the app and exits 0", async () => {
    const exit = vi.fn();
    const app = fakeApp(async () => {});
    await gracefulClose(app, "SIGTERM", exit);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(app.messages[0]).toBe("info:shutting down");
  });

  it("exits 1 if closing fails", async () => {
    const exit = vi.fn();
    const app = fakeApp(async () => {
      throw new Error("boom");
    });
    await gracefulClose(app, "SIGTERM", exit);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("forces exit 1 if closing takes too long", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const app = fakeApp(() => new Promise(() => {}));
    void gracefulClose(app, "SIGTERM", exit, 5000);
    await vi.advanceTimersByTimeAsync(5001);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(app.messages).toContain("error:shutdown took too long, forcing exit");
  });
});
