import { describe, expect, it } from "vitest";

import { capitalized } from "./text";

describe("capitalized", () => {
  it("puts the first letter in capitals and leaves the rest as written", () => {
    expect(capitalized("dinner")).toBe("Dinner");
    expect(capitalized("ground cumin")).toBe("Ground cumin");
    expect(capitalized("iPhone case")).toBe("IPhone case");
  });

  it("answers an empty text with an empty text", () => {
    expect(capitalized("")).toBe("");
  });
});
