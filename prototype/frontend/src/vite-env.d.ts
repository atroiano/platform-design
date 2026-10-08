/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The release this bundle was built for. Unset in development. */
  readonly VITE_RELEASE?: string;
}
