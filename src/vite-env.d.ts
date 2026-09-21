/// <reference types="vite/client" />

import type { DesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    harnessDesktop: DesktopApi;
  }
}

export {};
