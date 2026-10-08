import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    primary: { main: "#1f3a5f" },
    secondary: { main: "#b07a00" },
    background: { default: "#f5f6f8" },
  },
  shape: { borderRadius: 8 },
  typography: {
    h1: { fontSize: "1.6rem", fontWeight: 600 },
    h2: { fontSize: "1.15rem", fontWeight: 600 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { textTransform: "none" } } },
    MuiTab: { styleOverrides: { root: { textTransform: "none" } } },
    MuiTable: { defaultProps: { size: "small" } },
    MuiTextField: { defaultProps: { size: "small", fullWidth: true } },
  },
});

/** Dark text on a pale ground: readable at chip size, and it carries a word, not only a color. */
export const disputedChip = { bgcolor: "#fde7c5", color: "#5a3300", fontWeight: 600 } as const;

/** Present for a screen reader, absent for the eye. */
export const visuallyHidden = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;
