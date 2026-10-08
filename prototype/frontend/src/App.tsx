import { Link as RouterLink, Navigate, Route, Routes } from "react-router-dom";
import Alert from "@mui/material/Alert";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import LinearProgress from "@mui/material/LinearProgress";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";

import { useAuth } from "./auth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ReleaseStatus } from "./components/ReleaseStatus";
import { t } from "./i18n";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { AccountsPage } from "./pages/AccountsPage";
import { PaymentsPage } from "./pages/PaymentsPage";
import { SignInPage } from "./pages/SignInPage";
import { useCurrencies } from "./queries";

/** Account screens show money, so they wait until the server has said how each currency is written. */
function SignedIn() {
  const currencies = useCurrencies();
  if (currencies.isPending) return <LinearProgress aria-label={t("app.loading")} />;
  if (currencies.isError) {
    return (
      <Alert severity="error" action={<Button onClick={() => currencies.refetch()}>{t("app.retry")}</Button>}>
        {currencies.error.message}
      </Alert>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<AccountsPage />} />
      <Route path="/accounts/:accountPk" element={<AccountDetailPage />} />
      <Route path="/payments" element={<PaymentsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  const { signedIn, signOut } = useAuth();
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" color="primary">
        <Toolbar>
          <Typography
            component={RouterLink}
            to="/"
            variant="h6"
            sx={{ flexGrow: 1, color: "inherit", textDecoration: "none" }}
          >
            {t("app.title")}
          </Typography>
          {signedIn && (
            <>
              <Box component="nav" aria-label={t("nav.label")} sx={{ display: "flex", gap: 1, mr: 2 }}>
                <Button color="inherit" component={RouterLink} to="/">
                  {t("nav.accounts")}
                </Button>
                <Button color="inherit" component={RouterLink} to="/payments">
                  {t("nav.payments")}
                </Button>
              </Box>
              <Button color="inherit" onClick={signOut}>
                {t("app.signOut")}
              </Button>
            </>
          )}
        </Toolbar>
      </AppBar>
      <ReleaseStatus />
      <Container component="main" maxWidth="lg" sx={{ flexGrow: 1, py: 3 }}>
        <ErrorBoundary>{signedIn ? <SignedIn /> : <SignInPage />}</ErrorBoundary>
      </Container>
    </Box>
  );
}
