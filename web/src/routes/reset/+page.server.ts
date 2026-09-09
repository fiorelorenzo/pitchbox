import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  return { authOn: process.env.PITCHBOX_AUTH === 'on' };
};
