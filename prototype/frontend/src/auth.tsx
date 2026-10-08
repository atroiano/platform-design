import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { api, readKey, SIGNED_OUT_EVENT, unwrap, writeKey } from "./api/client";

interface Auth {
  signedIn: boolean;
  signIn(key: string): Promise<void>;
  signOut(): void;
}

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(() => readKey() !== null);
  const queryClient = useQueryClient();

  const signOut = useCallback(() => {
    writeKey(null);
    queryClient.clear();
    setSignedIn(false);
  }, [queryClient]);

  // The server refusing the key anywhere in the app signs the person out.
  useEffect(() => {
    const onSignedOut = () => {
      queryClient.clear();
      setSignedIn(false);
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [queryClient]);

  const signIn = useCallback(async (key: string) => {
    writeKey(key);
    try {
      await unwrap(api.GET("/api/v1/position"));
    } catch (error) {
      writeKey(null);
      throw error;
    }
    setSignedIn(true);
  }, []);

  const value = useMemo(() => ({ signedIn, signIn, signOut }), [signedIn, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth needs AuthProvider");
  return auth;
}
