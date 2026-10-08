import { useEffect, useRef, useState, type FormEvent } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { ApiError, api, existsSoon, newKey, unwrap, type Account, type PostPaymentCommand } from "../api/client";
import { Announcements } from "../announce";
import { t } from "../i18n";
import { amountOf, bucketLabeller, inPayOrder, money, useBucketDefinitions, useCommand } from "../queries";
import { disputedChip } from "../theme";
import { MoneyField } from "./MoneyField";

interface Props {
  open: boolean;
  /** One account, or several for a single payment shared across them. */
  accounts: Account[];
  onClose(): void;
  /** recordedEarlier is true when the server already had this payment from a request whose answer was lost. */
  onRecorded(paymentPk: string, recordedEarlier: boolean): void;
}

type Method = NonNullable<PostPaymentCommand["allocation_method"]>;

/**
 * Collects what the payer said and sends it. Where the money lands is decided
 * by the server (HIVE-0007); this form computes no allocation of its own.
 */
export function PaymentDialog({ open, accounts, onClose, onRecorded }: Props) {
  const definitions = useBucketDefinitions();
  const label = bucketLabeller(definitions.data);
  const form = useRef<HTMLFormElement>(null);
  const single = accounts.length === 1 ? accounts[0] : undefined;
  const currency = accounts[0]?.currency_code ?? "USD";
  const mixedCurrency = accounts.some((account) => account.currency_code !== currency);

  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"default" | "buckets">("default");
  const [bucketText, setBucketText] = useState<Record<string, string>>({});
  const [directedText, setDirectedText] = useState<Record<string, string>>({});
  const [consumerDirected, setConsumerDirected] = useState(false);
  const [method, setMethod] = useState<Method>("oldest_first");
  const [tried, setTried] = useState(0);
  // One key per opening of the form. The server answers a repeat of the same
  // payment under the same key as the same payment, so a retry after a lost
  // response cannot post twice.
  const [paymentPk, setPaymentPk] = useState("");

  const command = useCommand((body: PostPaymentCommand) =>
    unwrap(api.POST("/api/v1/commands/post-payment", { body })),
  );

  useEffect(() => {
    if (open) {
      setAmount("");
      setMode("default");
      setBucketText({});
      setDirectedText({});
      setConsumerDirected(false);
      setMethod("oldest_first");
      setTried(0);
      setPaymentPk(newKey());
      command.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // After a refused submit, put the person on the first field that needs fixing.
  useEffect(() => {
    if (tried > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [tried]);

  const total = amountOf(amount, currency);
  const bucketCodes = single ? inPayOrder(Object.keys(single.balance_buckets), definitions.data) : [];
  const bucketAmounts: Record<string, number> = {};
  const bucketErrors: Record<string, string> = {};
  for (const code of bucketCodes) {
    const text = bucketText[code] ?? "";
    if (text.trim() === "") continue;
    const value = amountOf(text, currency);
    if (value === null) continue;
    bucketAmounts[code] = value;
    if (single && value > (single.balance_buckets[code] ?? 0)) bucketErrors[code] = t("payment.bucket.tooMuch");
  }
  const bucketTotal = Object.values(bucketAmounts).reduce((sum, value) => sum + value, 0);
  const bucketTextInvalid = bucketCodes.some(
    (code) => (bucketText[code] ?? "").trim() !== "" && amountOf(bucketText[code] ?? "", currency) === null,
  );

  const directed: Record<string, number> = {};
  let directedTextInvalid = false;
  for (const account of accounts) {
    const text = directedText[account.account_pk] ?? "";
    if (text.trim() === "") continue;
    const value = amountOf(text, currency);
    if (value === null) directedTextInvalid = true;
    else directed[account.account_pk] = value;
  }
  const directedTotal = Object.values(directed).reduce((sum, value) => sum + value, 0);

  let problem: string | null = null;
  if (total !== null && single && mode === "buckets") {
    if (bucketTotal === 0) problem = t("payment.buckets.none");
    else if (bucketTotal > total) problem = t("payment.buckets.exceed");
    // Explicit bucket amounts land on the account. On a disputed account that
    // is only right when the consumer said so, and the form makes that explicit.
    else if (single.is_disputed && !consumerDirected) problem = t("payment.disputed.required");
  } else if (total !== null && !single && directedTotal > total) problem = t("multi.directed.exceed");

  const valid =
    total !== null &&
    !mixedCurrency &&
    problem === null &&
    !bucketTextInvalid &&
    !directedTextInvalid &&
    Object.keys(bucketErrors).length === 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (command.isPending) return;
    if (!valid || total === null) {
      setTried((count) => count + 1);
      return;
    }
    const body: PostPaymentCommand = {
      payment_pk: paymentPk,
      account_pks: accounts.map((account) => account.account_pk),
      amount_minor_units: total,
      currency_code: currency,
      allocation_method: method,
    };
    if (single && mode === "buckets") {
      body.bucket_amounts = { [single.account_pk]: bucketAmounts };
      // The server asks every caller this for a disputed account; the form's checkbox is the answer.
      if (single.is_disputed && consumerDirected) body.consumer_directed_accounts = [single.account_pk];
    }
    else if (single && single.is_disputed && consumerDirected) body.directed_allocations = { [single.account_pk]: total };
    else if (!single) body.directed_allocations = directed;
    command.mutate(body, {
      onSuccess: (result) => onRecorded(result.payment_pk, false),
      // No answer is not the same as no payment. Look before letting the
      // person try again or walk away believing nothing was recorded.
      onError: async (error) => {
        if (!(error instanceof ApiError) || !error.outcomeUnknown) return;
        const look = () => unwrap(api.GET("/api/v1/payments/{payment_pk}", { params: { path: { payment_pk: paymentPk } } }));
        if (await existsSoon(look)) onRecorded(paymentPk, true);
      },
    });
  }

  const disputed = single?.is_disputed ?? false;

  return (
    <Dialog
      open={open}
      onClose={command.isPending ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="payment-title"
    >
      <form onSubmit={submit} noValidate ref={form}>
        <DialogTitle id="payment-title">
          {single ? t("payment.title") : t("multi.title", { count: accounts.length })}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Announcements />
            {command.isError && <Alert severity="error">{command.error.message}</Alert>}
            {mixedCurrency && <Alert severity="error">{t("multi.currency")}</Alert>}
            {tried > 0 && problem && <Alert severity="error">{problem}</Alert>}
            <MoneyField
              label={t("payment.amount")}
              value={amount}
              onChange={setAmount}
              currency={currency}
              showErrors={tried > 0}
              required
              autoFocus
            />

            {disputed && (
              <Alert severity="warning">
                {t("payment.disputed.notice")}
                <FormControlLabel
                  sx={{ display: "flex", mt: 1 }}
                  control={
                    <Checkbox checked={consumerDirected} onChange={(event) => setConsumerDirected(event.target.checked)} />
                  }
                  label={t("payment.disputed.directed")}
                />
                <Typography variant="body2">
                  {mode === "buckets"
                    ? t("payment.disputed.buckets")
                    : consumerDirected
                      ? ""
                      : t("payment.disputed.held")}
                </Typography>
              </Alert>
            )}

            {single && (
              <>
                <Typography variant="subtitle2" component="h3" id="apply-mode">
                  {t("payment.apply")}
                </Typography>
                <RadioGroup
                  aria-labelledby="apply-mode"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as "default" | "buckets")}
                >
                  <FormControlLabel value="default" control={<Radio />} label={t("payment.apply.default")} />
                  <FormControlLabel value="buckets" control={<Radio />} label={t("payment.apply.buckets")} />
                </RadioGroup>
                {mode === "buckets" &&
                  bucketCodes.map((code) => (
                    <MoneyField
                      key={code}
                      label={t("payment.bucket.owed", {
                        label: label(code),
                        amount: money(single.balance_buckets[code] ?? 0, currency),
                      })}
                      value={bucketText[code] ?? ""}
                      onChange={(value) => setBucketText((current) => ({ ...current, [code]: value }))}
                      currency={currency}
                      showErrors={tried > 0}
                      error={bucketErrors[code]}
                    />
                  ))}
                {mode === "buckets" && total !== null && bucketTotal > 0 && bucketTotal < total && (
                  <Alert severity="info">
                    {t("payment.buckets.remainder", { amount: money(total - bucketTotal, currency) })}
                  </Alert>
                )}
              </>
            )}

            {!single && !mixedCurrency && (
              <>
                <TextField
                  select
                  label={t("multi.method")}
                  value={method}
                  onChange={(event) => setMethod(event.target.value as Method)}
                >
                  <MenuItem value="oldest_first">{t("multi.method.oldest_first")}</MenuItem>
                  <MenuItem value="even_split">{t("multi.method.even_split")}</MenuItem>
                </TextField>
                {accounts.map((account) => (
                  <Stack key={account.account_pk} spacing={0.5}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <Typography variant="subtitle2" component="h3">
                        {account.client_account_number}
                      </Typography>
                      <Typography variant="body2" sx={{ color: "text.secondary" }}>
                        {money(account.balance_minor_units, currency)}
                      </Typography>
                      {account.is_disputed && <Chip size="small" sx={disputedChip} label={t("account.disputed")} />}
                    </Stack>
                    <MoneyField
                      label={t("multi.directedTo", { number: account.client_account_number })}
                      value={directedText[account.account_pk] ?? ""}
                      onChange={(value) => setDirectedText((current) => ({ ...current, [account.account_pk]: value }))}
                      currency={currency}
                      showErrors={tried > 0}
                      helperText={account.is_disputed ? t("multi.disputed") : undefined}
                    />
                  </Stack>
                ))}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={command.isPending}>
            {t("app.cancel")}
          </Button>
          <Button type="submit" variant="contained" disabled={command.isPending || mixedCurrency}>
            {command.isPending ? t("app.updating") : t("payment.submit")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
