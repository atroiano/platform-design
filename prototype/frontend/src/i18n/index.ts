// Every string a person sees comes from a message catalog (SHARED-0005).
// One locale ships in this draft. The catalog format is a flat key to
// message map with {name} placeholders, a subset of ICU MessageFormat.
import messages from "./en-US.json";

export type MessageKey = keyof typeof messages;

export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** A message whose key is built from data, such as an event type. */
export function tMaybe(key: string, fallback: string): string {
  return key in messages ? messages[key as MessageKey] : fallback;
}

/** Dates and amounts follow the browser's locale; words follow the catalog. */
export const locale: string = typeof navigator === "undefined" ? "en-US" : navigator.language;

const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
// A calendar date has no time zone. Formatting it as UTC keeps it on the day it names.
const dateOnly = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatDate(isoDate: string): string {
  return dateOnly.format(new Date(`${isoDate}T00:00:00Z`));
}

// "short" puts the locale's own separator between items; "narrow" would drop it in English.
const listing = new Intl.ListFormat(locale, { style: "short", type: "unit" });

/** Several things in a row, joined the way the reader's language joins them. */
export function formatList(items: string[]): string {
  return listing.format(items);
}
