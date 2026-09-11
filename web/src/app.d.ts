// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Locale } from '$lib/i18n.js';

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      user?: { id: number; username: string };
      org?: { id: number; slug: string; role: string };
      // Resolved once per request in hooks.server.ts (LOR-260); every
      // loader and every component reads this rather than deciding again.
      locale: Locale;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
