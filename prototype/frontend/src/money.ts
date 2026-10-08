// Amounts travel as whole minor units (HIVE-0005). These two functions are
// the only place they meet text. No arithmetic on money happens in a float,
// and the number of minor-unit digits is the server's, passed in, never the
// browser's own idea of the currency.

export function formatMoney(minorUnits: number, currency: string, digits: number, locale: string): string {
  const negative = minorUnits < 0;
  const text = String(Math.abs(Math.trunc(minorUnits))).padStart(digits + 1, "0");
  const whole = text.slice(0, text.length - digits);
  const fraction = digits ? text.slice(-digits) : "";
  // Hand the formatter a decimal string, so no float ever holds the amount.
  const decimal = `${negative ? "-" : ""}${whole}${digits ? "." : ""}${fraction}`;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(decimal as unknown as number);
  } catch {
    return `${decimal} ${currency}`;
  }
}

function separators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    group: parts.find((part) => part.type === "group")?.value ?? ",",
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
  };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What a person typed, as whole minor units. Null when it is not plainly an
 * amount: empty, negative, not a number, more decimal places than the
 * currency has, or a grouping separator anywhere a group does not belong.
 *
 * The last rule matters most. "125,50" where the comma groups thousands is a
 * slip for 125.50, and reading it as 12,550 would post a hundred times the
 * money. A separator is accepted only between complete groups of digits.
 */
export function parseMoney(input: string, digits: number, locale: string): number | null {
  const { group, decimal } = separators(locale);
  // Spaces of every kind are grouping in some locales and noise in the rest.
  const spaceGroups = /^\s$/.test(group);
  let text = input.trim();
  text = text.replace(/^[^\d.,\s-]+/, "").replace(/[^\d.,\s]+$/, "").trim();
  if (spaceGroups) text = text.replace(/\s/g, " ");
  else if (/\s/.test(text)) return null;

  const groupPattern = spaceGroups ? " " : escape(group);
  const whole = `(?:\\d+|\\d{1,3}(?:${groupPattern}\\d{2,3})*${groupPattern}\\d{3})`;
  const match = new RegExp(`^(${whole})(?:${escape(decimal)}(\\d*))?$`).exec(text);
  if (!match) return null;
  const wholeDigits = (match[1] ?? "").replace(/\D/g, "");
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null;
  const minorUnits = Number(wholeDigits + fraction.padEnd(digits, "0"));
  return Number.isSafeInteger(minorUnits) ? minorUnits : null;
}
