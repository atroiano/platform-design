import TextField from "@mui/material/TextField";

import { t } from "../i18n";
import { amountOf, digitsOf, money } from "../queries";

interface Props {
  label: string;
  value: string;
  onChange(value: string): void;
  currency: string;
  /** Shown once the person has tried to submit. */
  showErrors: boolean;
  /** A problem beyond "is this an amount", such as exceeding a balance. */
  error?: string;
  required?: boolean;
  autoFocus?: boolean;
  helperText?: string;
}

/**
 * Text in, minor units out. Under the field it says how the amount was read,
 * so a slip of the keyboard is seen before the money is recorded, not after.
 */
export function MoneyField({ label, value, onChange, currency, showErrors, error, required, autoFocus, helperText }: Props) {
  const empty = value.trim() === "";
  const amount = empty ? null : amountOf(value, currency);
  const invalid = empty ? Boolean(required) : amount === null;
  const understood = amount !== null ? t("payment.understood", { amount: money(amount, currency) }) : undefined;
  const message =
    showErrors && invalid
      ? t("payment.amount.invalid", { digits: digitsOf(currency) })
      : (error ?? [understood, helperText].filter(Boolean).join(". "));
  return (
    <TextField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={(showErrors && invalid) || Boolean(error)}
      helperText={message || undefined}
      required={required}
      autoFocus={autoFocus}
      slotProps={{ htmlInput: { inputMode: "decimal", autoComplete: "off", maxLength: 24 } }}
    />
  );
}
