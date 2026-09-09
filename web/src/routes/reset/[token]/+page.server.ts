import type { PageServerLoad } from './$types';

// The token itself is never validated here - only the confirm endpoint
// (POST /api/auth/password/reset) checks it, and only after a submit. A
// `load` that previewed validity would let a GET distinguish a live link
// from a dead one before anyone submits anything, which is the same
// account-enumeration shape #509 rules out on the request side.
export const load: PageServerLoad = async (event) => {
  return {
    authOn: process.env.PITCHBOX_AUTH === 'on',
    token: event.params.token,
  };
};
