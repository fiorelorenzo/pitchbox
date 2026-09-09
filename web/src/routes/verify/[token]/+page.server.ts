import type { PageServerLoad } from './$types';

// Same reasoning as /reset/[token]: the token is never validated here, only
// on an explicit POST from the page - a `load` that previewed validity
// would let a plain GET (an attacker-embedded image, a mail scanner
// prefetching links) burn a single-use token before the real recipient
// ever clicks it.
export const load: PageServerLoad = async (event) => {
  return {
    authOn: process.env.PITCHBOX_AUTH === 'on',
    token: event.params.token,
  };
};
