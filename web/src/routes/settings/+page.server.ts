import {
  getExtensionToken,
  getExtensionTokenCreatedAt,
} from '@pitchbox/shared/extension-token';

export async function load() {
  return {
    extension: {
      token: await getExtensionToken(),
      createdAt: await getExtensionTokenCreatedAt(),
      backendUrl: process.env.PITCHBOX_BACKEND_URL ?? 'http://127.0.0.1:5180',
    },
  };
}
