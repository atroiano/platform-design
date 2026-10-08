import { useState, type FormEvent } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { ApiError } from "../api/client";
import { useAuth } from "../auth";
import { t } from "../i18n";
import { useTitle } from "../queries";

export function SignInPage() {
  const { signIn } = useAuth();
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useTitle(t("title.signIn"));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await signIn(key);
    } catch (error) {
      setProblem(error instanceof ApiError && error.status === 401 ? t("signIn.rejected") : (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper component="form" onSubmit={submit} sx={{ maxWidth: 440, mx: "auto", mt: 6, p: 4 }}>
      <Stack spacing={2}>
        <Typography variant="h1">{t("signIn.title")}</Typography>
        <Typography sx={{ color: "text.secondary" }}>{t("signIn.explanation")}</Typography>
        {problem && <Alert severity="error">{problem}</Alert>}
        <TextField
          label={t("signIn.key")}
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          required
          autoFocus
          slotProps={{ htmlInput: { autoComplete: "off" } }}
        />
        <Button type="submit" variant="contained" disabled={busy || key === ""}>
          {t("signIn.submit")}
        </Button>
      </Stack>
    </Paper>
  );
}
