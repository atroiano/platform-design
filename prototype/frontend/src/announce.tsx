import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { visuallyHidden } from "./theme";

type Announce = (message: string) => void;

const AnnounceContext = createContext<{ announce: Announce; message: string }>({ announce: () => {}, message: "" });

/**
 * What a screen reader reads out: that a command is being recorded, that it
 * was, how many rows a search found. Without it, a person who cannot see the
 * screen presses a button and hears nothing.
 */
export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const clear = useRef<number | undefined>(undefined);

  const announce = useCallback((text: string) => {
    // Emptied first so that the same message twice in a row is read twice.
    setMessage("");
    window.clearTimeout(clear.current);
    clear.current = window.setTimeout(() => setMessage(text), 50);
  }, []);
  useEffect(() => () => window.clearTimeout(clear.current), []);

  const value = useMemo(() => ({ announce, message }), [announce, message]);
  return (
    <AnnounceContext.Provider value={value}>
      {children}
      <Announcements />
    </AnnounceContext.Provider>
  );
}

/**
 * The live region itself. One sits at the top of the page. Each dialog holds
 * its own, because an open dialog hides everything outside it from assistive
 * technology, and a dialog is where most commands are sent from.
 */
export function Announcements() {
  const { message } = useContext(AnnounceContext);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" style={visuallyHidden}>
      {message}
    </div>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnounceContext).announce;
}

/** Put the keyboard and the screen reader at the top of a page that has just appeared. */
export function useFocusOnArrival<T extends HTMLElement>(ready = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (ready) ref.current?.focus();
  }, [ready]);
  return ref;
}
