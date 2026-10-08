import { useEffect, useRef, useState, type FormEvent } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { ApiError, api, existsSoon, newKey, unwrap, type PlaceAccountCommand } from "../api/client";
import { Announcements } from "../announce";
import { t } from "../i18n";
import { amountOf, useBucketDefinitions, useCommand, useCurrencies } from "../queries";
import { MoneyField } from "./MoneyField";

interface Props {
  open: boolean;
  onClose(): void;
  onPlaced(accountPk: string, caughtUp: boolean): void;
}

type ContractType = PlaceAccountCommand["contract_type"];

export function PlaceAccountDialog({ open, onClose, onPlaced }: Props) {
  const definitions = useBucketDefinitions();
  const [number, setNumber] = useState("");
  const [debtType, setDebtType] = useState("");
  const [contractType, setContractType] = useState<ContractType>("third_party_contingency");
  const [currency, setCurrency] = useState("USD");
  const [listDate, setListDate] = useState("");
  const [itemizationDate, setItemizationDate] = useState("");
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(0);
  const [accountPk, setAccountPk] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const currencies = useCurrencies();

  const command = useCommand((body: PlaceAccountCommand) =>
    unwrap(api.POST("/api/v1/commands/place-account", { body })),
  );

  useEffect(() => {
    if (open) {
      setNumber("");
      setDebtType("");
      setContractType("third_party_contingency");
      setCurrency("USD");
      setListDate("");
      setItemizationDate("");
      setBalances({});
      setTried(0);
      setAccountPk(newKey());
      command.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (tried > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [tried]);

  const currencyValid = (currencies.data ?? []).some((item) => item.code === currency);
  const opening: Record<string, number> = {};
  let balanceTextInvalid = false;
  for (const definition of definitions.data ?? []) {
    const text = balances[definition.code] ?? "";
    if (text.trim() === "") continue;
    const value = currencyValid ? amountOf(text, currency) : null;
    if (value === null) balanceTextInvalid = true;
    else opening[definition.code] = value;
  }
  const hasBalance = Object.keys(opening).length > 0;
  const valid =
    number.trim() !== "" &&
    debtType.trim() !== "" &&
    currencyValid &&
    listDate !== "" &&
    itemizationDate !== "" &&
    hasBalance &&
    !balanceTextInvalid;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (command.isPending) return;
    if (!valid) {
      setTried((count) => count + 1);
      return;
    }
    command.mutate(
      {
        account_pk: accountPk,
        client_account_number: number.trim(),
        debt_type: debtType.trim(),
        contract_type: contractType,
        currency_code: currency,
        list_date: listDate,
        itemization_date: itemizationDate,
        opening_balances: opening,
      },
      {
        onSuccess: (result) => onPlaced(result.account_pk, result.caughtUp),
        // No answer is not the same as no account. Look before the person retries.
        onError: async (error) => {
          if (!(error instanceof ApiError) || !error.outcomeUnknown) return;
          const look = () => unwrap(api.GET("/api/v1/accounts/{account_pk}", { params: { path: { account_pk: accountPk } } }));
          if (await existsSoon(look)) onPlaced(accountPk, true);
        },
      },
    );
  }

  const required = (value: string) => (tried > 0 && value.trim() === "" ? t("place.required") : undefined);
  const noBuckets = definitions.data !== undefined && definitions.data.length === 0;

  return (
    <Dialog
      open={open}
      onClose={command.isPending ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="place-title"
    >
      <form onSubmit={submit} noValidate ref={form}>
        <DialogTitle id="place-title">{t("place.title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Announcements />
            {command.isError && <Alert severity="error">{command.error.message}</Alert>}
            {noBuckets && <Alert severity="warning">{t("place.noBuckets")}</Alert>}
            <TextField
              label={t("place.number")}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              error={Boolean(required(number))}
              helperText={required(number)}
              required
              autoFocus
            />
            <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
              <TextField
                label={t("place.debtType")}
                value={debtType}
                onChange={(event) => setDebtType(event.target.value)}
                error={Boolean(required(debtType))}
                helperText={required(debtType)}
                required
              />
              <TextField
                select
                label={t("place.contractType")}
                value={contractType}
                onChange={(event) => setContractType(event.target.value as ContractType)}
              >
                <MenuItem value="third_party_contingency">{t("account.contract.third_party_contingency")}</MenuItem>
                <MenuItem value="purchase">{t("account.contract.purchase")}</MenuItem>
              </TextField>
              <TextField
                label={t("place.listDate")}
                type="date"
                value={listDate}
                onChange={(event) => setListDate(event.target.value)}
                error={Boolean(required(listDate))}
                helperText={required(listDate)}
                required
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                label={t("place.itemizationDate")}
                type="date"
                value={itemizationDate}
                onChange={(event) => setItemizationDate(event.target.value)}
                error={Boolean(required(itemizationDate))}
                helperText={required(itemizationDate)}
                required
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                select
                label={t("place.currency")}
                value={currencyValid ? currency : ""}
                onChange={(event) => setCurrency(event.target.value)}
                error={currencies.isError || (tried > 0 && !currencyValid)}
                helperText={currencies.isError ? t("place.currency.unavailable") : undefined}
                required
              >
                {(currencies.data ?? []).map((item) => (
                  <MenuItem key={item.code} value={item.code}>
                    {item.code}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            <Typography variant="subtitle2" component="h3">
              {t("place.balances")}
            </Typography>
            {tried > 0 && !hasBalance && !noBuckets && <Alert severity="error">{t("place.balances.none")}</Alert>}
            {(definitions.data ?? []).map((definition) => (
              <MoneyField
                key={definition.code}
                label={definition.label}
                value={balances[definition.code] ?? ""}
                onChange={(value) => setBalances((current) => ({ ...current, [definition.code]: value }))}
                currency={currencyValid ? currency : "USD"}
                showErrors={tried > 0}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={command.isPending}>
            {t("app.cancel")}
          </Button>
          <Button type="submit" variant="contained" disabled={command.isPending || noBuckets}>
            {command.isPending ? t("app.updating") : t("place.submit")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
