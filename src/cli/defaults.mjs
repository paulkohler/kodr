// cli/defaults.mjs — default CLI/runtime constants.
// Extracted from app.mjs in phase 148 (app split) so both the arg parser
// (cli/args.mjs) and the run pipeline (app.mjs) can import them without
// importing from each other.

export const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
export const DEFAULT_MODEL_ID = 'qwen/qwen3.6-35b-a3b';
export const DEFAULT_TIMEOUT_MS = 600000;
// The reviewer is advisory and non-fatal, so it fails fast by default rather
// than tying up a full model timeout. Capped against --timeout-ms and
// overridable with --review-timeout-ms.
export const DEFAULT_REVIEW_TIMEOUT_MS = 180000;
export const DEFAULT_SERVE_HOST = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 8787;

export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';
