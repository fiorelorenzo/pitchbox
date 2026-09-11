# Per-area catalogue modules

`dict-en.ts` and `dict-it.ts` hold the keys that already existed when LOR-263's
first part landed. Everything added after that goes in a module here instead,
one file per surface, with both locales side by side:

```ts
// web/src/lib/i18n/dict/campaigns.ts
import type { Dict } from '../types.js';

export const campaignsEn = {
  'campaigns.title': 'Campaigns',
} satisfies Dict;

export const campaignsIt = {
  'campaigns.title': 'Campagne',
} satisfies Dict;
```

Then register it once in each dictionary, as a spread:

```ts
// dict-en.ts
import { campaignsEn } from './dict/campaigns.js';
export const en = { ...campaignsEn, /* existing keys */ } satisfies Dict;
```

Two reasons, both learned the hard way in this repo.

A single pair of dictionary files is an **append-only conflict magnet**, the
same shape as `docs/design/DECISIONS.md`: every branch adds its keys at the
end, so every branch collides, and `git rerere` cannot help. A wave of four
agents converting four surfaces would spend its time rebasing instead of
translating. An area module collides only on its own two registration lines.

And keeping `en` and `it` **in one file, adjacent** is what makes a missing
translation visible while you are writing it rather than at test time. The
parity test in `web/tests/i18n-catalogue.test.ts` is the gate, not the first
line of defence.
