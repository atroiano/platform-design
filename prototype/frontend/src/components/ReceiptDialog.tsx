import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

import { api, unwrap } from "../api/client";
import { Announcements } from "../announce";
import { formatDateTime, t } from "../i18n";
import { bucketList, money, useBucketDefinitions, useCommand } from "../queries";
import { useReadOnly } from "./ReleaseStatus";

interface Props {
  paymentPk: string | null;
  /** Shown above the receipt, for example when the server had already recorded the payment. */
  notice?: string | null;
  onClose(): void;
}

/**
 * What a payment actually did, read back from the server: what was received,
 * what landed on each account it was taken against, and what was left
 * unapplied. It is also where a payment is reversed, so that the person
 * reversing it sees every account the reversal will touch first.
 */
export function ReceiptDialog({ paymentPk, notice, onClose }: Props) {
  const readOnly = useReadOnly();
  const definitions = useBucketDefinitions();
  const [confirming, setConfirming] = useState(false);
  const receipt = useQuery({
    queryKey: ["payment", paymentPk],
    queryFn: () => unwrap(api.GET("/api/v1/payments/{payment_pk}", { params: { path: { payment_pk: paymentPk! } } })),
    enabled: paymentPk !== null,
    // The read model may trail the command. Keep asking until it has the payment.
    refetchInterval: (query) => (query.state.data ? false : 1000),
    retry: false,
  });
  const reverse = useCommand((payment_pk: string) =>
    unwrap(api.POST("/api/v1/commands/reverse-payment", { body: { payment_pk } })),
  );

  useEffect(() => {
    setConfirming(false);
    reverse.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentPk]);

  const data = receipt.data;
  const currency = data?.currency_code ?? "USD";
  const reversed = data?.status === "reversed";
  const nothingApplied = data !== undefined && data.accounts.every((account) => account.applied_minor_units === 0);

  return (
    <Dialog
      open={paymentPk !== null}
      onClose={reverse.isPending ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="receipt-title"
    >
      <DialogTitle id="receipt-title">{reversed ? t("receipt.reversedTitle") : t("receipt.title")}</DialogTitle>
      <DialogContent>
        <Announcements />
        {notice && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {notice}
          </Alert>
        )}
        {reverse.isError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {reverse.error.message}
          </Alert>
        )}
        {!data && (
          <>
            <LinearProgress aria-label={t("receipt.loading")} />
            <Typography sx={{ mt: 1, color: "text.secondary" }}>{t("receipt.loading")}</Typography>
          </>
        )}
        {data && reversed && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t("receipt.status.reversed")}
          </Alert>
        )}
        {data && (
          <Table aria-labelledby="receipt-title">
            <TableBody>
              <TableRow>
                <TableCell component="th" scope="row">
                  {t("receipt.received")}
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {formatDateTime(data.received_at)}
                  </Typography>
                </TableCell>
                <TableCell align="right">{money(data.amount_minor_units, currency)}</TableCell>
              </TableRow>
              {data.accounts.map((account) => (
                <TableRow key={account.account_pk}>
                  <TableCell component="th" scope="row">
                    {account.client_account_number
                      ? t("receipt.account", { number: account.client_account_number })
                      : t("receipt.account.unknown")}
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      {account.applied_minor_units === 0
                        ? t("receipt.nothingHere")
                        : bucketList(account.bucket_amounts, currency, definitions.data)}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">{money(account.applied_minor_units, currency)}</TableCell>
                </TableRow>
              ))}
              {data.unapplied_minor_units > 0 && !reversed && (
                <TableRow>
                  <TableCell component="th" scope="row">
                    {t("receipt.unapplied")}
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      {t("receipt.unapplied.note")}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">{money(data.unapplied_minor_units, currency)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
        {data && !reversed && nothingApplied && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {t("receipt.nothingApplied")}
          </Alert>
        )}
        {confirming && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {t("receipt.reverse.explain")}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        {data && !reversed && !confirming && (
          <Button color="warning" disabled={readOnly} onClick={() => setConfirming(true)} sx={{ mr: "auto" }}>
            {t("receipt.reverse")}
          </Button>
        )}
        {confirming ? (
          <>
            <Button onClick={() => setConfirming(false)} disabled={reverse.isPending} autoFocus>
              {t("receipt.reverse.keep")}
            </Button>
            <Button
              variant="contained"
              color="warning"
              disabled={reverse.isPending || !paymentPk}
              onClick={() => paymentPk && reverse.mutate(paymentPk, { onSuccess: () => setConfirming(false) })}
            >
              {reverse.isPending ? t("app.updating") : t("receipt.reverse.confirm")}
            </Button>
          </>
        ) : (
          <Button onClick={onClose} variant="contained">
            {t("app.close")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
