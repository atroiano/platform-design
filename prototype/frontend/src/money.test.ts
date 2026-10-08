import { describe, expect, it } from "vitest";

import { formatMoney, parseMoney } from "./money";

const usd = (text: string, locale = "en-US") => parseMoney(text, 2, locale);

describe("parseMoney", () => {
  it("reads what a cashier types", () => {
    expect(usd("125.50")).toBe(12550);
    expect(usd("1,250")).toBe(125000);
    expect(usd(" $1,250.5 ")).toBe(125050);
    expect(usd("0.01")).toBe(1);
    expect(usd("7")).toBe(700);
    expect(usd("1,234,567.89")).toBe(123456789);
  });

  it("never rounds: too many decimal places is an error, not a guess", () => {
    expect(usd("1.005")).toBeNull();
    expect(parseMoney("0.1", 0, "en-US")).toBeNull();
    expect(parseMoney("500", 0, "en-US")).toBe(500);
    expect(parseMoney("1.2345", 3, "en-US")).toBeNull();
    expect(parseMoney("1.234", 3, "en-US")).toBe(1234);
  });

  it("rejects what is not an amount", () => {
    for (const text of ["", "abc", "-5", "1.2.3", "1e3", "12,34.5.6", "1 250.00"]) {
      expect(usd(text)).toBeNull();
    }
  });

  it("refuses a grouping separator where a group does not belong", () => {
    // A comma typed for the period. Read as grouping, each of these would
    // post ten, a hundred, or a thousand times the money.
    for (const text of ["125,50", "12,5", "0,50", ",50", "1,2,3", "12,34", "1,25"]) {
      expect(usd(text)).toBeNull();
    }
    // The same slip in a locale that groups with a period.
    for (const text of ["12.50", "99.99", "1.5", "125.50", "10.00"]) {
      expect(usd(text, "de-DE")).toBeNull();
    }
  });

  it("does not lose a cent to floating point", () => {
    expect(usd("0.29")).toBe(29);
    expect(usd("1.15")).toBe(115);
    expect(usd("4.35")).toBe(435);
    expect(usd("90071992547409.91")).toBe(9007199254740991);
    expect(usd("900719925474099.92")).toBeNull();
  });

  it("follows the locale's separators", () => {
    expect(usd("1.250,50", "de-DE")).toBe(125050);
    expect(usd("1 250,50", "fr-FR")).toBe(125050);
    expect(usd("1250,5", "fr-FR")).toBe(125050);
    expect(usd("1,00,000.00", "en-IN")).toBe(10000000);
  });
});

describe("formatMoney", () => {
  it("shows minor units with the digits the server states", () => {
    expect(formatMoney(125050, "USD", 2, "en-US")).toBe("$1,250.50");
    expect(formatMoney(1, "USD", 2, "en-US")).toBe("$0.01");
    expect(formatMoney(0, "USD", 2, "en-US")).toBe("$0.00");
    expect(formatMoney(500, "JPY", 0, "en-US")).toBe("¥500");
  });

  it("round-trips with parseMoney", () => {
    for (const locale of ["en-US", "de-DE", "fr-FR"]) {
      for (const amount of [1, 29, 115, 435, 99999, 123456789]) {
        expect(parseMoney(formatMoney(amount, "USD", 2, locale), 2, locale)).toBe(amount);
      }
    }
  });
});
