import { describe, it, expect } from "vitest";
import { validatePhoneNumber } from "./phone-validation.js";

// Using real phone numbers that libphonenumber-js validates correctly:
// +14155552671  — US (San Francisco area)
// +447911123456 — UK mobile
// +12025551234  — US (Washington DC area)

describe("validatePhoneNumber", () => {
  // ── Valid numbers ─────────────────────────────────────────────────────────

  it("accepts a valid US E.164 number", () => {
    // Arrange
    const raw = "+14155552671";

    // Act
    const result = validatePhoneNumber(raw);

    // Assert
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.e164).toBe("+14155552671");
    }
  });

  it("accepts a valid UK E.164 number", () => {
    const result = validatePhoneNumber("+447911123456");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.e164).toMatch(/^\+447/);
    }
  });

  it("accepts a number with surrounding whitespace", () => {
    const result = validatePhoneNumber("  +14155552671  ");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.e164).toBe("+14155552671");
    }
  });

  it("normalises an international number with formatting to E.164 format", () => {
    // libphonenumber-js parses formatted numbers to E.164
    const result = validatePhoneNumber("+1 (415) 555-2671");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.e164).toBe("+14155552671");
    }
  });

  it("accepts a French number", () => {
    const result = validatePhoneNumber("+33123456789");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.e164).toMatch(/^\+33/);
    }
  });

  // ── Empty / blank ─────────────────────────────────────────────────────────

  it("rejects an empty string", () => {
    const result = validatePhoneNumber("");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("must not be empty");
    }
  });

  it("rejects a whitespace-only string", () => {
    const result = validatePhoneNumber("   ");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("must not be empty");
    }
  });

  // ── Invalid numbers ───────────────────────────────────────────────────────

  it("rejects a number without country code", () => {
    // Without a country code libphonenumber-js cannot validate
    const result = validatePhoneNumber("4155552671");
    expect(result.valid).toBe(false);
  });

  it("rejects a clearly fake number", () => {
    const result = validatePhoneNumber("+10000000000");
    expect(result.valid).toBe(false);
  });

  it("rejects a short random string", () => {
    const result = validatePhoneNumber("not-a-phone");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBeDefined();
    }
  });

  it("rejects a number with letters embedded", () => {
    const result = validatePhoneNumber("+1415ABC2671");
    expect(result.valid).toBe(false);
  });

  it("includes the invalid number in the error message", () => {
    const raw = "+10000000000";
    const result = validatePhoneNumber(raw);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain(raw);
    }
  });

  it("suggests E.164 format in the error message for invalid numbers", () => {
    const result = validatePhoneNumber("4155552671");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("E.164");
    }
  });
});
