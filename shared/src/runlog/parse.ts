// Shared types and backwards-compat re-exports.
// New code should import from './types.js' or './parsers/claude-code.js' directly.

export type { EventKind, CliEnvelope, ParsedEvent, EventPayload } from './types.js';
export { tryParseCliEnvelope } from './parsers/claude-code.js';

// Backwards-compat alias — the runner-specific parser is now in parsers/claude-code.ts.
// Prefer importing `parseClaudeCodeLine` from './parsers/claude-code.js' in new code.
export { parseClaudeCodeLine as parseEvent } from './parsers/claude-code.js';
