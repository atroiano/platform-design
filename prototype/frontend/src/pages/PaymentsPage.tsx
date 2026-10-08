import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

import { api, unwrap } from "../api/client";
import { useAnnounce, useFocusOnArrival } from "../announce";
import { ReceiptDialog } from "../components/ReceiptDialog";
import { formatDateTime, t } from "../i18n";
import { money, pagingLabels, useTitle } from "../queries";
import { visuallyHidden } from "../theme";

/**
 * Every payment, whichever account it was or was not applied to. Money held
 * unapplied lives on the payment, so this is where it can always be found,
 * looked at, and reversed.
 */
export function PaymentsPage() {
  const [heldOnly, setHeldOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [open, setOpen] = useState<string | null>(null);
  useTitle(t("title.payments"));
  const heading = useFocusOnArrival<HTMLHeadingElement>();
  const announce = useAnnounce();

  const payments = useQuery({
    queryKey: ["payments", heldOnly, page, rowsPerPage],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/payments", {
          params: { query: { held: heldOnly, limit: rowsPerPage, offset: page * rowsPerPage } },
        }),
      ),
    placeholderData: keepPreviousData,
  });
  const items = payments.data?.items ?? [];
  const total = payments.data?.total;
  const settled = payments.isSuccess && !payments.isPlaceholderData;
  useEffect(() => {
    if (settled && total !== undefined) announce(t("announce.payments", { count: total }));
  }, [settled, total, heldOnly, announce]);
  // Rows can leave the list while it is open. Never sit on a page past the end.
  useEffect(() => {
    if (total !== undefined && page > 0 && page * rowsPerPage >= total) {
      setPage(Math.max(0, Math.ceil(total / rowsPerPage) - 1));
    }
  }, [total, page, rowsPerPage]);

  return (
    <Stack spacing={2}>
      <Typography variant="h1" ref={heading} tabIndex={-1} sx={{ outline: "none" }}>
        {t("allPayments.title")}
      </Typography>
      <Typography sx={{ color: "text.secondary" }}>{t("allPayments.explain")}</Typography>
      {payments.isError && (
        <Alert severity="error" action={<Button onClick={() => payments.refetch()}>{t("app.retry")}</Button>}>
          {payments.error.message}
        </Alert>
      )}
      <Paper>
        <Stack sx={{ px: 2, pt: 1 }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={heldOnly}
                onChange={(event) => {
                  setHeldOnly(event.target.checked);
                  setPage(0);
                }}
              />
            }
            label={t("allPayments.heldOnly")}
          />
        </Stack>
        {payments.isFetching ? <LinearProgress aria-label={t("app.loading")} /> : <div style={{ height: 4 }} />}
        <TableContainer>
          <Table aria-label={t("allPayments.title")}>
            <TableHead>
              <TableRow>
                <TableCell>{t("allPayments.column.received")}</TableCell>
                <TableCell>{t("allPayments.column.status")}</TableCell>
                <TableCell align="right">{t("allPayments.column.amount")}</TableCell>
                <TableCell align="right">{t("allPayments.column.unapplied")}</TableCell>
                <TableCell>
                  <span style={visuallyHidden}>{t("payments.column.actions")}</span>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((payment) => (
                <TableRow key={payment.payment_pk} hover>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{formatDateTime(payment.received_at)}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant={payment.status === "posted" ? "filled" : "outlined"}
                      label={t(`allPayments.status.${payment.status}`)}
                    />
                  </TableCell>
                  <TableCell align="right">{money(payment.amount_minor_units, payment.currency_code)}</TableCell>
                  <TableCell align="right">
                    {/* A reversed payment holds nothing, whatever it held before. */}
                    {payment.status === "posted" ? money(payment.unapplied_minor_units, payment.currency_code) : t("money.none")}
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => setOpen(payment.payment_pk)}
                      aria-label={t("payments.details.label", {
                        amount: money(payment.amount_minor_units, payment.currency_code),
                        date: formatDateTime(payment.received_at),
                      })}
                    >
                      {t("payments.details")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {settled && total === 0 && (
                <TableRow>
                  <TableCell colSpan={5} sx={{ py: 4, textAlign: "center", color: "text.secondary" }}>
                    {heldOnly ? t("allPayments.emptyHeld") : t("allPayments.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={total ?? 0}
          page={page}
          onPageChange={(_event, next) => setPage(next)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(event) => {
            setRowsPerPage(Number(event.target.value));
            setPage(0);
          }}
          rowsPerPageOptions={[10, 25, 50, 100]}
          {...pagingLabels}
        />
      </Paper>
      <ReceiptDialog paymentPk={open} onClose={() => setOpen(null)} />
    </Stack>
  );
}
