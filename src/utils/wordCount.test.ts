import { describe, expect, it } from "vitest";
import { countWords } from "./wordCount";

describe("countWords", () => {
  it("counts words, not markdown punctuation", () => {
    expect(countWords("Father Bill had a list. **Money**, *mood*, and the mirror.")).toBe(10);
    expect(countWords("- one\n- two\n\n***")).toBe(2);
  });

  it("leaves a leading H1 out, matching the published body", () => {
    expect(countWords("# The five M's\n\nOne two three.")).toBe(3);
    expect(countWords("\n\n# Title only\n")).toBe(0);
  });

  it("counts a first line that is not a heading", () => {
    expect(countWords("Just a thought.\n\nMore of it.")).toBe(6);
  });

  it("is zero for an empty room", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\n")).toBe(0);
  });
});
