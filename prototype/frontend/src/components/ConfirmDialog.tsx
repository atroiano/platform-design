import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";

import { Announcements } from "../announce";
import { t } from "../i18n";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onClose(): void;
}

/** For actions that write something permanent to an account's history. */
export function ConfirmDialog({ open, title, body, confirmLabel, busy, error, onConfirm, onClose }: Props) {
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
    >
      <DialogTitle id="confirm-title">{title}</DialogTitle>
      <DialogContent>
        <Announcements />
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <DialogContentText id="confirm-body">{body}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("app.cancel")}
        </Button>
        <Button onClick={onConfirm} variant="contained" color="warning" disabled={busy}>
          {busy ? t("app.updating") : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
