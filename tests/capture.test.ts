/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import source from "../src-tauri/src/engine/capture.js?raw";

describe("capture.js", () => {
  it("is geldige JavaScript", () => {
    // Bij een syntaxfout draait het script niet en loopt elke site vast op een time-out.
    expect(source.length).toBeGreaterThan(1000);
    expect(() => new Function(source)).not.toThrow();
  });
});
