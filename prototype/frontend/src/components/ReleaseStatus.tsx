import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

import { useAuth } from "../auth";
import { t } from "../i18n";
import { useHealth, useStalled } from "../queries";

// The script this page is running, as the server names it. In development the
// page is not served from /assets/, and the comparison is skipped.
const ownEntry = new URL(import.meta.url).pathname;
const builtBundle = ownEntry.startsWith("/assets/");

/**
 * Which release and color this page is talking to (SHARED-0010). It warns
 * when the page is on the read-only preview port, when the database has moved
 * past this release, when a cutover or rollback has put a different build in
 * front of a page that was loaded from this one, and when the read models
 * behind the screens have stopped.
 */
export function ReleaseStatus() {
  const health = useHealth();
  const { signedIn } = useAuth();
  const stalled = useStalled(signedIn);

  if (health.isError) {
    return (
      <Alert severity="error" square>
        {t("status.unreachable")}
      </Alert>
    );
  }
  if (!health.data) return null;
  const { release, color, live, preview, status, frontend_entry: served } = health.data;

  return (
    <>
      {status !== "ok" && (
        <Alert severity="error" square>
          {t("status.incompatible")}
        </Alert>
      )}
      {stalled.length > 0 && (
        <Alert severity="error" square>
          {t("status.stalled", { names: stalled.join(", ") })}
        </Alert>
      )}
      {preview && status === "ok" && (
        <Alert severity="warning" square>
          {t("status.preview", { release })}
        </Alert>
      )}
      {builtBundle && served && served !== ownEntry && (
        <Alert
          severity="info"
          square
          action={
            <Button color="inherit" size="small" onClick={() => window.location.reload()}>
              {t("status.reload")}
            </Button>
          }
        >
          {t("status.newBuild")}
        </Alert>
      )}
      <Box sx={{ px: 3, py: 0.5, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider" }}>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary" }}
          // Which release this page's own code came from, for whoever is asked to help.
          title={import.meta.env.VITE_RELEASE ? t("status.built", { release: import.meta.env.VITE_RELEASE }) : undefined}
        >
          {t("status.line", {
            release,
            color: t(`color.${color}`),
            state: live ? t("status.live") : t("status.notLive"),
          })}
        </Typography>
      </Box>
    </>
  );
}

/** True when commands will be refused, so screens can say so up front. */
export function useReadOnly(): boolean {
  const health = useHealth();
  return !health.data || health.data.preview || health.data.status !== "ok";
}
