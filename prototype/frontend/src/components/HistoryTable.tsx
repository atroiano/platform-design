import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

import type { AccountEvent } from "../api/client";
import { formatDate, formatDateTime, t, tMaybe } from "../i18n";
import { eventLabel, money } from "../queries";

interface Props {
  events: AccountEvent[];
  currency: string;
  bucketLabel(code: string): string;
  /** Bucket codes in the order payments are applied. */
  inOrder(codes: string[]): string[];
}

type Line = { label: string; before: string; after: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored value as a person reads it: dates by locale, coded values by their labels. */
function show(key: string, value: unknown): string {
  if (value === undefined || value === null) return t("history.none");
  if (typeof value === "boolean") return value ? t("value.true") : t("value.false");
  if (typeof value === "string") {
    if (key.endsWith("_date") && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
    if (key === "contract_type") return tMaybe(`account.contract.${value}`, value);
    if (key === "status") return tMaybe(`account.status.${value}`, value);
    return value;
  }
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** One line per field an event changed, with bucket balances shown as money. */
function changes(event: AccountEvent, { currency, bucketLabel, inOrder }: Omit<Props, "events">): Line[] {
  const prior = event.prior_value ?? {};
  const next = event.new_value ?? {};
  const lines: Line[] = [];
  for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    const before = prior[key];
    const after = next[key];
    if (key === "balance_buckets") {
      const beforeBuckets = isRecord(before) ? before : {};
      const afterBuckets = isRecord(after) ? after : {};
      for (const code of inOrder([...new Set([...Object.keys(beforeBuckets), ...Object.keys(afterBuckets)])])) {
        const amount = (value: unknown) => (typeof value === "number" ? money(value, currency) : t("history.none"));
        lines.push({ label: bucketLabel(code), before: amount(beforeBuckets[code]), after: amount(afterBuckets[code]) });
      }
    } else {
      lines.push({ label: tMaybe(`field.${key}`, key), before: show(key, before), after: show(key, after) });
    }
  }
  return lines;
}

/**
 * The account's audit trail (WAX-0001): every change, newest first, with who
 * made it, why, and the values before and after. Nothing here is computed in
 * the browser; it is the event record as stored.
 */
export function HistoryTable({ events, ...display }: Props) {
  if (events.length === 0) {
    return <Typography sx={{ p: 3, color: "text.secondary" }}>{t("history.empty")}</Typography>;
  }
  return (
    <TableContainer>
      <Table aria-label={t("account.tab.history")}>
        <TableHead>
          <TableRow>
            <TableCell>{t("history.column.sequence")}</TableCell>
            <TableCell>{t("history.column.when")}</TableCell>
            <TableCell>{t("history.column.what")}</TableCell>
            <TableCell>{t("history.column.who")}</TableCell>
            <TableCell>{t("history.column.why")}</TableCell>
            <TableCell>{t("history.column.change")}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.aggregate_sequence_number} sx={{ verticalAlign: "top" }}>
              <TableCell>{event.aggregate_sequence_number}</TableCell>
              <TableCell sx={{ whiteSpace: "nowrap" }}>{formatDateTime(event.occurred_at)}</TableCell>
              <TableCell>
                {eventLabel(event.event_type)}
                <Typography
                  variant="caption"
                  component="div"
                  sx={{ color: "text.secondary", fontFamily: "monospace" }}
                  title={event.event_hash}
                >
                  {t("history.hash", { hash: event.event_hash.slice(0, 12) })}
                </Typography>
              </TableCell>
              <TableCell>
                {tMaybe(`actor.${event.actor_type}`, event.actor_type)}
                {event.source && (
                  <Typography variant="caption" component="div" sx={{ color: "text.secondary" }}>
                    {t("history.via", { source: event.source })}
                  </Typography>
                )}
              </TableCell>
              <TableCell>{event.reason ?? ""}</TableCell>
              <TableCell>
                {changes(event, display).map((line) => (
                  <Typography key={line.label} variant="body2">
                    {event.prior_value ? t("history.changed", line) : t("history.set", line)}
                  </Typography>
                ))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
