import { json } from '@sveltejs/kit';
import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
import {
  detectAllRunners,
  clearDetectionCache,
  type DetectResult,
} from '@pitchbox/shared/agents/detect';

type RunnerInfo = {
  slug: string;
  label: string;
  implemented: boolean;
  available: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
  detectedAt: string;
};

function shape(detections: Awaited<ReturnType<typeof detectAllRunners>>): RunnerInfo[] {
  return AGENT_RUNNER_META.map((m) => {
    const d: DetectResult = detections[m.slug];
    return {
      slug: m.slug,
      label: m.label,
      implemented: m.implemented,
      available: m.implemented && d.available,
      version: d.version,
      path: d.path,
      error: m.implemented ? d.error : 'Runner adapter not implemented yet',
      detectedAt: d.detectedAt,
    };
  });
}

export async function GET() {
  const detections = await detectAllRunners();
  return json({ runners: shape(detections) });
}

export async function POST() {
  clearDetectionCache();
  const detections = await detectAllRunners();
  return json({ runners: shape(detections) });
}
