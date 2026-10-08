import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api, followUp, readKey, settle, unwrap, type BucketDefinition } from "./api/client";
import { useAnnounce } from "./announce";
import { formatList, locale, t, tMaybe } from "./i18n";
import { formatMoney, parseMoney } from "./money";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    // A 503 still carries the body that says why, so it is read, not thrown.
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/health");
      const body = data ?? error;
      if (!body) throw new Error("no health");
      return body;
    },
    refetchInterval: 15_000,
    staleTime: 0,
  });
}

/** Read models that have stopped. While any has, screens can be out of date. */
export function useStalled(enabled: boolean): string[] {
  const position = useQuery({
    queryKey: ["position"],
    queryFn: () => unwrap(api.GET("/api/v1/position")),
    enabled: enabled && readKey() !== null,
    refetchInterval: 30_000,
    staleTime: 0,
  });
  return position.data?.stopped ?? [];
}

// The server says how many minor-unit digits each currency has (HIVE-0005).
// Kept here once loaded so that formatting, which happens everywhere, does
// not need a hook. The app does not render account screens before it loads.
const minorUnitDigits = new Map<string, number>();

export function useCurrencies() {
  return useQuery({
    queryKey: ["currencies"],
    queryFn: async () => {
      const list = await unwrap(api.GET("/api/v1/currencies"));
      for (const currency of list) minorUnitDigits.set(currency.code, currency.minor_unit_digits);
      return list;
    },
    staleTime: Infinity,
  });
}

export function digitsOf(currency: string): number {
  return minorUnitDigits.get(currency) ?? 2;
}

export function money(minorUnits: number, currency: string): string {
  return formatMoney(minorUnits, currency, digitsOf(currency), locale);
}

/** Text a person typed, as minor units. Null unless it is an amount above zero. */
export function amountOf(text: string, currency: string): number | null {
  const amount = parseMoney(text, digitsOf(currency), locale);
  return amount !== null && amount > 0 ? amount : null;
}

export function useBucketDefinitions() {
  return useQuery({
    queryKey: ["bucket-definitions"],
    queryFn: () => unwrap(api.GET("/api/v1/bucket-definitions")),
    staleTime: 60_000,
  });
}

/** Bucket codes are data; their labels come from the registry (HIVE-0005). */
export function bucketLabeller(definitions: BucketDefinition[] | undefined) {
  const labels = new Map((definitions ?? []).map((definition) => [definition.code, definition.label]));
  return (code: string) => labels.get(code) ?? code;
}

/** Bucket codes in the order payments are applied, then any the registry no longer lists. */
export function inPayOrder(codes: string[], definitions: BucketDefinition[] | undefined): string[] {
  const order = new Map((definitions ?? []).map((definition, index) => [definition.code, index]));
  return [...codes].sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
  );
}

export function eventLabel(eventType: string): string {
  return tMaybe(`event.${eventType}`, eventType);
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = t("app.title");
    };
  }, [title]);
}

/**
 * Send a command, wait for the read models to pass it, then refresh every
 * query. caughtUp is false when the wait ran out: the command is recorded
 * either way, the caller says the screen is still catching up, and the
 * queries are refreshed again when it does.
 */
export function useCommand<Input, Output extends { position: number }>(send: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  return useMutation({
    // Never queued for later: offline, a command fails now and the person
    // decides what to do. It is not sent on its own when the network returns.
    networkMode: "always",
    mutationFn: async (input: Input) => {
      const output = await send(input);
      const caughtUp = await settle(output.position);
      if (!caughtUp) followUp(output.position, () => void queryClient.invalidateQueries());
      return { ...output, caughtUp };
    },
    // Said aloud for a person who cannot see the button change.
    onMutate: () => announce(t("announce.updating")),
    onSuccess: (result) => announce(result.caughtUp ? t("announce.recorded") : t("app.stillUpdating")),
    // "It failed" would be a guess when no answer came back.
    onError: (error) =>
      announce(
        error instanceof ApiError && error.outcomeUnknown
          ? t("announce.unknown")
          : t("announce.failed", { message: error.message }),
      ),
    // Whatever happened, what is on screen may no longer be true.
    onSettled: () => queryClient.invalidateQueries(),
  });
}

/** The words MUI's paging control would otherwise say in English only. */
export const pagingLabels = {
  labelRowsPerPage: t("page.rowsPerPage"),
  labelDisplayedRows: ({ from, to, count }: { from: number; to: number; count: number }) =>
    t("page.range", { from, to, count }),
  getItemAriaLabel: (type: "first" | "last" | "next" | "previous") => t(`page.${type}`),
};

/** "Interest $250.00, Fees $35.00": each part from the catalog, joined by the locale. */
export function bucketList(
  amounts: Record<string, number>,
  currency: string,
  definitions: BucketDefinition[] | undefined,
): string {
  const label = bucketLabeller(definitions);
  return formatList(
    inPayOrder(Object.keys(amounts), definitions).map((code) =>
      t("bucket.amount", { label: label(code), amount: money(amounts[code] ?? 0, currency) }),
    ),
  );
}
