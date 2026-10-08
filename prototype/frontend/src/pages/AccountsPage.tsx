import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { api, unwrap, type Account } from "../api/client";
import { PaymentDialog } from "../components/PaymentDialog";
import { PlaceAccountDialog } from "../components/PlaceAccountDialog";
import { ReceiptDialog } from "../components/ReceiptDialog";
import { useReadOnly } from "../components/ReleaseStatus";
import { useAnnounce, useFocusOnArrival } from "../announce";
import { formatDate, t, tMaybe } from "../i18n";
import { money, pagingLabels, useTitle } from "../queries";
import { disputedChip, visuallyHidden } from "../theme";

export function AccountsPage() {
  const navigate = useNavigate();
  const readOnly = useReadOnly();
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selected, setSelected] = useState<Record<string, Account>>({});
  const [placing, setPlacing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<{ paymentPk: string; recordedEarlier: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useTitle(t("title.accounts"));
  const heading = useFocusOnArrival<HTMLHeadingElement>();
  const announce = useAnnounce();

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText);
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchText]);

  const accounts = useQuery({
    queryKey: ["accounts", search, page, rowsPerPage],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/accounts", {
          params: { query: { search, limit: rowsPerPage, offset: page * rowsPerPage } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  // A selection made before a refresh keeps showing current balances.
  useEffect(() => {
    const fresh = accounts.data?.items ?? [];
    setSelected((current) => {
      let changed = false;
      const next = { ...current };
      for (const account of fresh) {
        if (next[account.account_pk] && next[account.account_pk] !== account) {
          next[account.account_pk] = account;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [accounts.data]);

  const total = accounts.data?.total;
  const settled = accounts.isSuccess && !accounts.isPlaceholderData;
  useEffect(() => {
    if (settled && total !== undefined) announce(t("announce.accounts", { count: total }));
  }, [settled, total, search, announce]);
  useEffect(() => {
    if (total !== undefined && page > 0 && page * rowsPerPage >= total) {
      setPage(Math.max(0, Math.ceil(total / rowsPerPage) - 1));
    }
  }, [total, page, rowsPerPage]);

  const chosen = Object.values(selected);
  const items = accounts.data?.items ?? [];

  function toggle(account: Account) {
    setSelected((current) => {
      const next = { ...current };
      if (next[account.account_pk]) delete next[account.account_pk];
      else next[account.account_pk] = account;
      return next;
    });
  }

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: { sm: "center" } }}>
        <Typography variant="h1" sx={{ flexGrow: 1, outline: "none" }} ref={heading} tabIndex={-1}>
          {t("accounts.title")}
        </Typography>
        {chosen.length > 1 && (
          <Button variant="outlined" disabled={readOnly} onClick={() => setPaying(true)}>
            {t("accounts.payAcross", { count: chosen.length })}
          </Button>
        )}
        <Button variant="contained" disabled={readOnly} onClick={() => setPlacing(true)}>
          {t("accounts.place")}
        </Button>
      </Stack>

      {notice && (
        <Alert severity="info" onClose={() => setNotice(null)} closeText={t("app.close")}>
          {notice}
        </Alert>
      )}
      {accounts.isError && (
        <Alert severity="error" action={<Button onClick={() => accounts.refetch()}>{t("app.retry")}</Button>}>
          {accounts.error.message}
        </Alert>
      )}

      <Paper>
        <Stack sx={{ p: 2 }}>
          <TextField
            label={t("accounts.search")}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            slotProps={{ htmlInput: { type: "search" } }}
          />
        </Stack>
        {accounts.isFetching ? <LinearProgress aria-label={t("app.loading")} /> : <div style={{ height: 4 }} />}
        <TableContainer>
          <Table aria-label={t("accounts.title")}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <span style={visuallyHidden}>{t("accounts.column.select")}</span>
                </TableCell>
                <TableCell>{t("accounts.column.number")}</TableCell>
                <TableCell>{t("accounts.column.debtType")}</TableCell>
                <TableCell>{t("accounts.column.listed")}</TableCell>
                <TableCell>{t("accounts.column.status")}</TableCell>
                <TableCell align="right">{t("accounts.column.balance")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((account) => (
                <TableRow key={account.account_pk} hover selected={Boolean(selected[account.account_pk])}>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={Boolean(selected[account.account_pk])}
                      onChange={() => toggle(account)}
                      slotProps={{ input: { "aria-label": t("accounts.select", { number: account.client_account_number }) } }}
                    />
                  </TableCell>
                  <TableCell>
                    <Link component={RouterLink} to={`/accounts/${account.account_pk}`}>
                      {account.client_account_number}
                    </Link>
                  </TableCell>
                  <TableCell>{account.debt_type}</TableCell>
                  <TableCell>{account.list_date ? formatDate(account.list_date) : ""}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1}>
                      <Chip size="small" label={tMaybe(`account.status.${account.status}`, account.status)} />
                      {account.is_disputed && <Chip size="small" sx={disputedChip} label={t("account.disputed")} />}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">{money(account.balance_minor_units, account.currency_code)}</TableCell>
                </TableRow>
              ))}
              {settled && total === 0 && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ py: 4, textAlign: "center", color: "text.secondary" }}>
                    {search ? t("accounts.noMatch") : t("accounts.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={accounts.data?.total ?? 0}
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

      <PlaceAccountDialog
        open={placing}
        onClose={() => setPlacing(false)}
        onPlaced={(accountPk, caughtUp) => {
          setPlacing(false);
          if (caughtUp) navigate(`/accounts/${accountPk}`);
          else setNotice(t("app.stillUpdating"));
        }}
      />
      <PaymentDialog
        open={paying}
        accounts={chosen}
        onClose={() => setPaying(false)}
        onRecorded={(paymentPk, recordedEarlier) => {
          setPaying(false);
          setReceipt({ paymentPk, recordedEarlier });
          setSelected({});
        }}
      />
      <ReceiptDialog
        paymentPk={receipt?.paymentPk ?? null}
        notice={receipt?.recordedEarlier ? t("app.recordedEarlier") : null}
        onClose={() => setReceipt(null)}
      />
    </Stack>
  );
}
