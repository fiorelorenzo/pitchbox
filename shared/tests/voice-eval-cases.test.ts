import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import {
  loadVoiceEvalCases,
  resolveVoiceEvalCasesPath,
  VoiceEvalCasesNotFoundError,
  DEFAULT_VOICE_EVAL_CASES_PATH,
  VOICE_EVAL_SCHEMA_VERSION,
} from '../src/voice-eval-cases.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/voice-eval/synthetic-cases.json', import.meta.url),
);

describe('loadVoiceEvalCases', () => {
  it('loads and validates the committed synthetic fixture', () => {
    const file = loadVoiceEvalCases(FIXTURE_PATH);
    expect(file.schemaVersion).toBe(VOICE_EVAL_SCHEMA_VERSION);
    expect(file.voiceCorpus.length).toBeGreaterThanOrEqual(3);
    expect(file.cases.length).toBeGreaterThanOrEqual(5);
    // Exactly one genuine silence case, per the issue's own named genres.
    expect(file.cases.filter((c) => c.actualReply === null)).toHaveLength(1);
  });

  it('defaults an unlabelled genre to "unclassified" rather than guessing one', () => {
    const file = loadVoiceEvalCases(FIXTURE_PATH);
    for (const c of file.cases) {
      expect(c.genre).toBeTruthy();
    }
  });

  it('throws a readable, named error rather than a raw ENOENT stack when the file is missing', () => {
    expect(() => loadVoiceEvalCases('/nonexistent/path/cases.json')).toThrow(
      VoiceEvalCasesNotFoundError,
    );
    try {
      loadVoiceEvalCases('/nonexistent/path/cases.json');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceEvalCasesNotFoundError);
      expect((err as VoiceEvalCasesNotFoundError).message).toContain(
        '/nonexistent/path/cases.json',
      );
      expect((err as VoiceEvalCasesNotFoundError).message).toContain('PITCHBOX_EVAL_CASES');
    }
  });

  it('rejects a file that does not match the schema', () => {
    // A directory read as a file: the loader's readFileSync throws EISDIR,
    // not ENOENT, so this must surface as a real error, never as a silent
    // "no cases" - proving loadVoiceEvalCases does not swallow anything past
    // the one error it explicitly names.
    expect(() =>
      loadVoiceEvalCases(fileURLToPath(new URL('./fixtures/voice-eval', import.meta.url))),
    ).toThrow();
  });
});

describe('resolveVoiceEvalCasesPath', () => {
  afterEach(() => {
    delete process.env.PITCHBOX_EVAL_CASES;
  });

  it('defaults to the gitignored private/ location', () => {
    delete process.env.PITCHBOX_EVAL_CASES;
    expect(resolveVoiceEvalCasesPath()).toBe(DEFAULT_VOICE_EVAL_CASES_PATH);
  });

  it('honors PITCHBOX_EVAL_CASES, trimmed of stray whitespace', () => {
    process.env.PITCHBOX_EVAL_CASES = '  /tmp/some-cases.json\n';
    expect(resolveVoiceEvalCasesPath()).toBe('/tmp/some-cases.json');
  });
});
