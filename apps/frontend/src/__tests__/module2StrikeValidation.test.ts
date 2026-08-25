import { describe, it, expect } from "vitest";
import {
  Module2SessionStartSchema,
  Module2StrikeUpdateSchema,
  SelectedStrikesSchema,
  isCallStrike,
  isPutStrike,
} from "@stock/shared";

describe("Module 2 Strike Validation Rules", () => {
  const generateStrikes = (ceCount: number, peCount: number) => {
    const strikes: string[] = [];
    for (let i = 1; i <= ceCount; i++) {
      strikes.push(`NIFTY${22000 + i * 50}CE`);
    }
    for (let i = 1; i <= peCount; i++) {
      strikes.push(`NIFTY${22000 + i * 50}PE`);
    }
    return strikes;
  };

  it("classifies CE and PE strikes correctly", () => {
    expect(isCallStrike("NIFTY22100CE")).toBe(true);
    expect(isCallStrike("NIFTY22100PE")).toBe(false);
    expect(isPutStrike("NIFTY22100PE")).toBe(true);
    expect(isPutStrike("NIFTY22100CE")).toBe(false);
  });

  it("5 CE + 5 PE (Total 10) -> PASS", () => {
    const strikes = generateStrikes(5, 5);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(true);

    const sessionResult = Module2SessionStartSchema.safeParse({
      sessionType: "mixed",
      indexSymbol: "NIFTY50",
      expiryDate: "2026-08-27",
      selectedStrikes: strikes,
    });
    expect(sessionResult.success).toBe(true);
  });

  it("10 CE + 10 PE (Total 20) -> PASS", () => {
    const strikes = generateStrikes(10, 10);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(true);

    const sessionResult = Module2SessionStartSchema.safeParse({
      sessionType: "mixed",
      indexSymbol: "NIFTY50",
      expiryDate: "2026-08-27",
      selectedStrikes: strikes,
    });
    expect(sessionResult.success).toBe(true);
  });

  it("10 CE + 0 PE (Total 10) -> PASS", () => {
    const strikes = generateStrikes(10, 0);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(true);

    const sessionResult = Module2SessionStartSchema.safeParse({
      sessionType: "CE",
      indexSymbol: "NIFTY50",
      expiryDate: "2026-08-27",
      selectedStrikes: strikes,
    });
    expect(sessionResult.success).toBe(true);
  });

  it("0 CE + 10 PE (Total 10) -> PASS", () => {
    const strikes = generateStrikes(0, 10);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(true);

    const sessionResult = Module2SessionStartSchema.safeParse({
      sessionType: "PE",
      indexSymbol: "NIFTY50",
      expiryDate: "2026-08-27",
      selectedStrikes: strikes,
    });
    expect(sessionResult.success).toBe(true);
  });

  it("11 CE + 0 PE (Total 11) -> FAIL (>10 CE)", () => {
    const strikes = generateStrikes(11, 0);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.message.includes("Call (CE)"))).toBe(true);
    }
  });

  it("0 CE + 11 PE (Total 11) -> FAIL (>10 PE)", () => {
    const strikes = generateStrikes(0, 11);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.message.includes("Put (PE)"))).toBe(true);
    }
  });

  it("11 CE + 9 PE (Total 20) -> FAIL (>10 CE)", () => {
    const strikes = generateStrikes(11, 9);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.message.includes("Call (CE)"))).toBe(true);
    }
  });

  it("10 CE + 11 PE (Total 21) -> FAIL (>10 PE and >20 Total)", () => {
    const strikes = generateStrikes(10, 11);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.length).toBeGreaterThan(0);
    }
  });

  it("12 CE + 8 PE (Total 20) -> FAIL (>10 CE)", () => {
    const strikes = generateStrikes(12, 8);
    const result = SelectedStrikesSchema.safeParse(strikes);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.message.includes("Call (CE)"))).toBe(true);
    }
  });

  it("20 total with valid 10/10 split -> PASS", () => {
    const strikes = generateStrikes(10, 10);
    const updateResult = Module2StrikeUpdateSchema.safeParse({ selectedStrikes: strikes });
    expect(updateResult.success).toBe(true);
  });

  it("21 total -> FAIL", () => {
    const strikes = [...generateStrikes(10, 10), "NIFTY23000CE"];
    const updateResult = Module2StrikeUpdateSchema.safeParse({ selectedStrikes: strikes });
    expect(updateResult.success).toBe(false);
  });
});
