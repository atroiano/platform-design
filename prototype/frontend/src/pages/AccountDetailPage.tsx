import { useEffect, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";

import { api, unwrap } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { HistoryTable } from "../components/HistoryTable";
import { PaymentDialog } from "../components/PaymentDialog";
import { ReceiptDialog } from "../components/ReceiptDialog";
import { useReadOnly } from "../components/ReleaseStatus";
import { useAnnounce, useFocusOnArrival } from "../announce";
import { formatDate, formatDateTime, formatList, t, tMaybe } from "../i18n";
import { bucketLabeller, bucketList, inPayOrder, money, useBucketDefinitions, useCommand, useTitle } from "../queries";
import { disputedChip, visuallyHidden } from "../theme";

const HISTORY_PAGE = 100;
const PAYMENTS_SHOWN = 200;

export function AccountDetailPage() {
  const { accountPk = "" } = useParams();
  const readOnly = useReadOnly();
  const definitions = useBucketDefinitions();
  const bucketLabel = bucketLabeller(definitions.data);
  const [tab, setTab] = useState<"payments" | "history">("payments");
  const [paying, setPaying] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [receipt, setReceipt] = useState<{ paymentPk: string; recordedEarlier: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const path = { account_pk: accountPk };
  const account = useQuery({
    queryKey: ["account", accountPk],
    queryFn: () => unwrap(api.GET("/api/v1/accounts/{account_pk}", { params: { path } })),
  });
  const payments = useQuery({
    queryKey: ["account", accountPk, "payments"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/accounts/{account_pk}/payments", { params: { path, query: { limit: PAYMENTS_SHOWN } } }),
      ),
  });
  // Newest first, a page at a time, so the latest events are never the ones left out.
  const history = useInfiniteQuery({
    queryKey: ["account", accountPk, "history"],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/accounts/{account_pk}/history", {
          params: { path, query: { limit: HISTORY_PAGE, offset: pageParam } },
        }),
      ),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    enabled: tab === "history",
  });

  const dispute = useCommand((account_pk: string) =>
    unwrap(api.POST("/api/v1/commands/open-dispute", { body: { account_pk } })),
  );

  const data = account.data;
  useTitle(data ? t("title.account", { number: data.client_account_number }) : t("app.title"));
  const heading = useFocusOnArrival<HTMLHeadingElement>(data !== undefined);
  const announce = useAnnounce();
  const shownEvents = history.data?.pages.reduce((count, page) => count + page.items.length, 0);
  const totalEvents = history.data?.pages[0]?.total;
  useEffect(() => {
    if (shownEvents !== undefined && totalEvents !== undefined) {
      announce(t("announce.history", { shown: shownEvents, total: totalEvents }));
    }
  }, [shownEvents, totalEvents, announce]);

  if (!data) {
    if (account.isPending) return <LinearProgress aria-label={t("app.loading")} />;
    return (
      <Stack spacing={2}>
        <Alert severity="error">{account.error?.message || t("account.notFound")}</Alert>
        <Link component={RouterLink} to="/">
          {t("account.back")}
        </Link>
      </Stack>
    );
  }

  const currency = data.currency_code;
  const codes = inPayOrder(Object.keys(data.balance_buckets), definitions.data);
  const lines = payments.data?.items ?? [];
  // The newest payment that put money on this account and still stands.
  const lastApplied = lines.find((line) => line.status === "applied");
  const events = history.data?.pages.flatMap((page) => page.items) ?? [];
  const eventTotal = history.data?.pages[0]?.total ?? 0;

  return (
    <Stack spacing={2}>
      <Link component={RouterLink} to="/">
        {t("account.back")}
      </Link>

      {account.isError && (
        // The page stays up on what it last knew, and says so.
        <Alert severity="warning" action={<Button onClick={() => account.refetch()}>{t("app.retry")}</Button>}>
          {t("account.refreshFailed")}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" onClose={() => setNotice(null)} closeText={t("app.close")}>
          {notice}
        </Alert>
      )}

      <Paper sx={{ p: 3 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={3} sx={{ justifyContent: "space-between" }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
              <Typography variant="h1" ref={heading} tabIndex={-1} sx={{ outline: "none" }}>
                {data.client_account_number}
              </Typography>
              <Chip size="small" label={tMaybe(`account.status.${data.status}`, data.status)} />
              {data.is_disputed && <Chip size="small" sx={disputedChip} label={t("account.disputed")} />}
            </Stack>
            <Typography sx={{ color: "text.secondary" }}>
              {formatList(
                [
                  data.debt_type,
                  data.contract_type && tMaybe(`account.contract.${data.contract_type}`, data.contract_type),
                  data.list_date && t("account.listed", { date: formatDate(data.list_date) }),
                ].filter((part): part is string => Boolean(part)),
              )}
            </Typography>
            {lastApplied && (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {t("account.lastPayment", {
                  amount: money(lastApplied.applied_minor_units, currency),
                  date: formatDateTime(lastApplied.received_at),
                })}
              </Typography>
            )}
          </Stack>
          <Box sx={{ textAlign: { md: "right" } }}>
            <Typography variant="overline" sx={{ color: "text.secondary" }}>
              {t("account.balance")}
            </Typography>
            <Typography variant="h4" component="p">
              {money(data.balance_minor_units, currency)}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1, justifyContent: { md: "flex-end" } }}>
              {!data.is_disputed && (
                <Button
                  variant="outlined"
                  disabled={readOnly}
                  onClick={() => {
                    dispute.reset();
                    setDisputing(true);
                  }}
                >
                  {t("account.openDispute")}
                </Button>
              )}
              <Button variant="contained" disabled={readOnly} onClick={() => setPaying(true)}>
                {t("account.takePayment")}
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Paper>

      <Paper>
        <Box sx={{ p: 2, pb: 0 }}>
          <Typography variant="h2" id="buckets-title">
            {t("account.buckets")}
          </Typography>
          {definitions.isSuccess && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("account.buckets.order")}
            </Typography>
          )}
        </Box>
        <TableContainer>
          <Table aria-labelledby="buckets-title">
            <TableHead>
              <TableRow>
                <TableCell>{t("account.bucket")}</TableCell>
                <TableCell align="right">{t("account.balance")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {codes.map((code) => (
                <TableRow key={code}>
                  <TableCell component="th" scope="row">
                    {bucketLabel(code)}
                  </TableCell>
                  <TableCell align="right">{money(data.balance_buckets[code] ?? 0, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Paper>
        <Tabs value={tab} onChange={(_event, value: "payments" | "history") => setTab(value)}>
          <Tab value="payments" label={t("account.tab.payments")} id="tab-payments" aria-controls="panel-payments" />
          <Tab value="history" label={t("account.tab.history")} id="tab-history" aria-controls="panel-history" />
        </Tabs>
        <div role="tabpanel" id="panel-payments" aria-labelledby="tab-payments" hidden={tab !== "payments"}>
          {payments.isError && <Alert severity="error">{payments.error.message}</Alert>}
          {payments.isSuccess && lines.length === 0 && (
            <Typography sx={{ p: 3, color: "text.secondary" }}>{t("payments.empty")}</Typography>
          )}
          {lines.length > 0 && (
            <TableContainer>
              <Table aria-labelledby="tab-payments">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("payments.column.received")}</TableCell>
                    <TableCell>{t("payments.column.status")}</TableCell>
                    <TableCell align="right">{t("payments.column.payment")}</TableCell>
                    <TableCell align="right">{t("payments.column.applied")}</TableCell>
                    <TableCell align="right">{t("payments.column.unapplied")}</TableCell>
                    <TableCell>
                      <span style={visuallyHidden}>{t("payments.column.actions")}</span>
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.payment_pk}>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{formatDateTime(line.received_at)}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant={line.status === "applied" ? "filled" : "outlined"}
                          label={t(`payments.status.${line.status}`)}
                        />
                      </TableCell>
                      <TableCell align="right">{money(line.payment_amount_minor_units, currency)}</TableCell>
                      <TableCell align="right">
                        {money(line.applied_minor_units, currency)}
                        {line.applied_minor_units > 0 && (
                          <Typography variant="caption" component="div" sx={{ color: "text.secondary" }}>
                            {bucketList(line.bucket_amounts, currency, definitions.data)}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {line.status === "reversed" ? t("money.none") : money(line.payment_unapplied_minor_units, currency)}
                      </TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          onClick={() => setReceipt({ paymentPk: line.payment_pk, recordedEarlier: false })}
                          aria-label={t("payments.details.label", {
                            amount: money(line.payment_amount_minor_units, currency),
                            date: formatDateTime(line.received_at),
                          })}
                        >
                          {t("payments.details")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {payments.data && payments.data.total > lines.length && (
            <Typography variant="body2" sx={{ p: 2, color: "text.secondary" }}>
              {t("payments.partial", { shown: lines.length, total: payments.data.total })}
            </Typography>
          )}
        </div>
        <div role="tabpanel" id="panel-history" aria-labelledby="tab-history" hidden={tab !== "history"}>
          {history.isPending && tab === "history" && <LinearProgress aria-label={t("app.loading")} />}
          {history.isError && <Alert severity="error">{history.error.message}</Alert>}
          {history.data && (
            <HistoryTable
              events={events}
              currency={currency}
              bucketLabel={bucketLabel}
              inOrder={(bucketCodes) => inPayOrder(bucketCodes, definitions.data)}
            />
          )}
          {history.data && events.length < eventTotal && (
            <Stack direction="row" spacing={2} sx={{ p: 2, alignItems: "center" }}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {t("history.partial", { shown: events.length, total: eventTotal })}
              </Typography>
              <Button size="small" onClick={() => history.fetchNextPage()} disabled={history.isFetchingNextPage}>
                {t("history.more")}
              </Button>
            </Stack>
          )}
        </div>
      </Paper>

      <PaymentDialog
        open={paying}
        accounts={[data]}
        onClose={() => setPaying(false)}
        onRecorded={(paymentPk, recordedEarlier) => {
          setPaying(false);
          setReceipt({ paymentPk, recordedEarlier });
        }}
      />
      <ReceiptDialog
        paymentPk={receipt?.paymentPk ?? null}
        notice={receipt?.recordedEarlier ? t("app.recordedEarlier") : null}
        onClose={() => setReceipt(null)}
      />
      <ConfirmDialog
        open={disputing}
        title={t("dispute.title")}
        body={t("dispute.body")}
        confirmLabel={t("dispute.confirm")}
        busy={dispute.isPending}
        error={dispute.isError ? dispute.error.message : null}
        onClose={() => setDisputing(false)}
        onConfirm={() =>
          dispute.mutate(data.account_pk, {
            onSuccess: (result) => {
              setDisputing(false);
              setNotice(result.caughtUp ? t("dispute.done") : t("app.stillUpdating"));
            },
          })
        }
      />
    </Stack>
  );
}
