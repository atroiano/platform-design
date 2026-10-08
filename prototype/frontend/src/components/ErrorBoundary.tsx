import { Component, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";

import { t } from "../i18n";

/** A rendering fault shows a message and a way out, never a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Alert
        severity="error"
        sx={{ m: 3 }}
        action={
          <Button color="inherit" onClick={() => window.location.reload()}>
            {t("app.reload")}
          </Button>
        }
      >
        {t("app.error")}
      </Alert>
    );
  }
}
