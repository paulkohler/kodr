// cli-errors.mjs — shared CLI error classes.
// Extracted from app.mjs in phase 148 (app split). Command modules import
// CliError from here so they never import from app.mjs (which would create a
// circular dependency); app.mjs re-exports both for its public surface.

export class CliError extends Error {
	constructor(message) {
		super(message);
		this.name = 'CliError';
	}
}

// D3 (phase 119): thrown when native-mode model produces no tool writes and no
// parseable envelope after one re-prompt. Distinct from ProposalMissingError so
// callers can distinguish native-mode failure from envelope-mode failure.
export class NativeNoProposalError extends Error {
	constructor(message) {
		super(message);
		this.name = 'NativeNoProposalError';
	}
}
