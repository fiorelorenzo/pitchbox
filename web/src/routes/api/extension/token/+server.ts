import { json } from '@sveltejs/kit';
import {
  getExtensionToken,
  getExtensionTokenCreatedAt,
  rotateExtensionToken,
} from '@pitchbox/shared/extension-token';

export async function GET() {
  return json({
    token: await getExtensionToken(),
    createdAt: await getExtensionTokenCreatedAt(),
  });
}

export async function POST() {
  const token = await rotateExtensionToken();
  return json({ token, createdAt: await getExtensionTokenCreatedAt() });
}
