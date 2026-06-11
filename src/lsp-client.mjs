import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// LSP SymbolKind → repomap kind
// https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind
const SYMBOL_KIND_MAP = new Map([
	[5, 'class'], // Class
	[6, 'function'], // Method
	[7, 'variable'], // Property
	[8, 'variable'], // Field
	[9, 'function'], // Constructor
	[10, 'class'], // Enum
	[11, 'class'], // Interface
	[12, 'function'], // Function
	[13, 'variable'], // Variable
	[14, 'variable'], // Constant
	[22, 'variable'], // EnumMember
	[23, 'class'], // Struct
	[26, 'class'], // TypeParameter
]);

// Language identifier map: repomap language → LSP languageId
const LANGUAGE_ID = new Map([
	['go', 'go'],
	['javascript', 'javascript'],
	['python', 'python'],
	['rust', 'rust'],
	['typescript', 'typescript'],
]);

// Test-name heuristics matching the regex inspector's patterns
function looksLikeTest(name) {
	return /^[Tt]est[_A-Z]/.test(name) || /^test_/.test(name);
}

function mapLspKind(lspKind, name) {
	if (looksLikeTest(name)) return 'test';
	return SYMBOL_KIND_MAP.get(lspKind) ?? null;
}

// ---------------------------------------------------------------------------
// Content-Length framing decoder
// Tolerant of messages split across chunks and multiple messages per chunk.
// ---------------------------------------------------------------------------

class FrameDecoder {
	constructor() {
		this._buf = Buffer.alloc(0);
	}

	push(chunk) {
		this._buf = Buffer.concat([
			this._buf,
			chunk instanceof Buffer ? chunk : Buffer.from(chunk),
		]);
		const messages = [];
		let msg;
		while ((msg = this._tryDecode()) !== null) {
			messages.push(msg);
		}
		return messages;
	}

	_tryDecode() {
		// Find \r\n\r\n separator
		let sep = -1;
		const limit = this._buf.length - 3;
		for (let i = 0; i < limit; i++) {
			if (
				this._buf[i] === 13 &&
				this._buf[i + 1] === 10 &&
				this._buf[i + 2] === 13 &&
				this._buf[i + 3] === 10
			) {
				sep = i;
				break;
			}
		}
		if (sep === -1) return null;

		const header = this._buf.slice(0, sep).toString('ascii');
		const bodyStart = sep + 4;

		let contentLength = -1;
		for (const line of header.split('\r\n')) {
			const m = /^content-length:\s*(\d+)/i.exec(line);
			if (m) {
				contentLength = parseInt(m[1], 10);
				break;
			}
		}
		if (contentLength < 0) {
			// Malformed header — skip past separator
			this._buf = this._buf.slice(bodyStart);
			return null;
		}

		if (this._buf.length < bodyStart + contentLength) return null;

		const bodyBuf = this._buf.slice(bodyStart, bodyStart + contentLength);
		this._buf = this._buf.slice(bodyStart + contentLength);

		try {
			return JSON.parse(bodyBuf.toString('utf8'));
		} catch {
			return null;
		}
	}
}

function encodeMessage(msg) {
	const body = JSON.stringify(msg);
	return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

// ---------------------------------------------------------------------------
// LspClient
// ---------------------------------------------------------------------------

export class LspClient {
	constructor(proc, { requestTimeout = 30_000 } = {}) {
		this._proc = proc;
		this._requestId = 1;
		this._pending = new Map(); // id → { resolve, reject, timer }
		this._decoder = new FrameDecoder();
		this._diagnostics = new Map(); // uri → Diagnostic[]
		this._notifHandlers = new Map(); // method → handler[]
		this._requestTimeout = requestTimeout;
		this._dead = false;

		proc.stdout.on('data', (chunk) => {
			const messages = this._decoder.push(chunk);
			for (const msg of messages) this._dispatch(msg);
		});

		proc.stdout.on('end', () => {
			this._dead = true;
			for (const { reject, timer } of this._pending.values()) {
				clearTimeout(timer);
				reject(new Error('LSP server stdout closed'));
			}
			this._pending.clear();
		});

		proc.on('error', (err) => {
			this._dead = true;
			for (const { reject, timer } of this._pending.values()) {
				clearTimeout(timer);
				reject(err);
			}
			this._pending.clear();
		});

		this._registerNotification('textDocument/publishDiagnostics', (params) => {
			if (params?.uri) {
				this._diagnostics.set(params.uri, params.diagnostics || []);
			}
		});
	}

	_registerNotification(method, handler) {
		const list = this._notifHandlers.get(method) || [];
		list.push(handler);
		this._notifHandlers.set(method, list);
	}

	_dispatch(msg) {
		if (!msg || typeof msg !== 'object') return;

		if ('id' in msg && ('result' in msg || 'error' in msg)) {
			const pending = this._pending.get(msg.id);
			if (pending) {
				clearTimeout(pending.timer);
				this._pending.delete(msg.id);
				if ('error' in msg) {
					pending.reject(
						new Error(
							`LSP error ${msg.error?.code}: ${msg.error?.message ?? 'unknown'}`,
						),
					);
				} else {
					pending.resolve(msg.result);
				}
			}
			return;
		}

		if ('method' in msg && !('id' in msg)) {
			const handlers = this._notifHandlers.get(msg.method) || [];
			for (const h of handlers) h(msg.params);
		}
	}

	_send(msg) {
		if (this._dead) throw new Error('LSP client is closed');
		this._proc.stdin.write(encodeMessage(msg));
	}

	_notify(method, params) {
		this._send({ jsonrpc: '2.0', method, params: params ?? null });
	}

	_request(method, params) {
		const id = this._requestId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`LSP request "${method}" timed out`));
			}, this._requestTimeout);
			timer.unref?.();
			this._pending.set(id, { reject, resolve, timer });
			try {
				this._send({ id, jsonrpc: '2.0', method, params: params ?? null });
			} catch (err) {
				clearTimeout(timer);
				this._pending.delete(id);
				reject(err);
			}
		});
	}

	async initialize(rootUri) {
		const result = await this._request('initialize', {
			capabilities: {
				textDocument: {
					documentSymbol: {
						hierarchicalDocumentSymbolSupport: true,
						symbolKind: { valueSet: [...SYMBOL_KIND_MAP.keys()] },
					},
					publishDiagnostics: {},
					references: {},
				},
				workspace: { symbol: {} },
			},
			processId: process.pid,
			rootUri,
		});
		this._notify('initialized', {});
		return result;
	}

	async shutdown() {
		if (this._dead) return;
		try {
			await this._request('shutdown', null);
		} catch {
			// best effort
		}
		this._notify('exit', null);
		this._dead = true;
	}

	// Opens a file, fetches its document symbols, waits diagWindow ms for
	// publishDiagnostics, then closes it. Returns { symbols, diagnostics }.
	async enrichFile(uri, languageId, content, diagWindow = 300) {
		this._notify('textDocument/didOpen', {
			textDocument: { languageId, text: content, uri, version: 1 },
		});

		let symbols = [];
		try {
			symbols =
				(await this._request('textDocument/documentSymbol', {
					textDocument: { uri },
				})) || [];
		} catch {
			// server may not support documentSymbol — continue
		}

		if (diagWindow > 0) {
			await new Promise((r) => setTimeout(r, diagWindow));
		}

		const diagnostics = this._diagnostics.get(uri) || [];
		this._notify('textDocument/didClose', { textDocument: { uri } });
		return { diagnostics, symbols };
	}

	// workspace/symbol query — returns SymbolInformation[].
	async workspaceSymbols(query = '') {
		return (await this._request('workspace/symbol', { query })) || [];
	}

	// textDocument/references for the first occurrence of a symbol at a given
	// 0-based line/character position. File must be already open.
	async references(uri, line, character) {
		return (
			(await this._request('textDocument/references', {
				context: { includeDeclaration: true },
				position: { character, line },
				textDocument: { uri },
			})) || []
		);
	}

	kill() {
		this._dead = true;
		try {
			this._proc.kill('SIGTERM');
		} catch {
			// already gone
		}
	}
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function normalizeDocumentSymbols(lspSymbols) {
	const result = [];
	flattenSymbols(lspSymbols || [], result);
	return result;
}

function flattenSymbols(symbols, out) {
	for (const sym of symbols) {
		if ('range' in sym) {
			// DocumentSymbol
			const kind = mapLspKind(sym.kind, sym.name);
			if (kind) {
				out.push({
					kind,
					lineEnd: (sym.range?.end?.line ?? 0) + 1,
					lineStart: (sym.range?.start?.line ?? 0) + 1,
					name: sym.name,
				});
			}
			if (Array.isArray(sym.children)) {
				flattenSymbols(sym.children, out);
			}
		} else if ('location' in sym) {
			// SymbolInformation
			const kind = mapLspKind(sym.kind, sym.name);
			if (kind) {
				out.push({
					kind,
					lineEnd: (sym.location?.range?.end?.line ?? 0) + 1,
					lineStart: (sym.location?.range?.start?.line ?? 0) + 1,
					name: sym.name,
				});
			}
		}
	}
}

export function normalizeDiagnostics(lspDiagnostics) {
	const SEVERITY = ['error', 'warning', 'information', 'hint'];
	return (lspDiagnostics || []).map((d) => ({
		line: (d.range?.start?.line ?? 0) + 1,
		message: d.message ?? '',
		severity: SEVERITY[(d.severity ?? 1) - 1] ?? 'error',
		source: d.source,
	}));
}

// Convert a file:// URI to a workspace-relative path, or null if outside.
export function uriToRelativePath(uri, workspaceRoot) {
	if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
	let absPath;
	try {
		absPath = fileURLToPath(uri);
	} catch {
		return null;
	}
	const root = workspaceRoot.endsWith('/')
		? workspaceRoot
		: workspaceRoot + '/';
	if (!absPath.startsWith(root)) return null;
	return absPath.slice(root.length);
}

// ---------------------------------------------------------------------------
// High-level enrichment pass
// ---------------------------------------------------------------------------

// Spawn an LSP server, run the enrichment pass over a list of relative file
// paths (with their base-index data for content), and shut down. Returns an
// array of InspectedFile objects ready for mergeInspectorResults.
export async function runLspInspector(
	descriptor,
	baseFiles,
	cwd,
	options = {},
) {
	const {
		initTimeout = 15_000,
		requestTimeout = 30_000,
		diagWindow = 300,
		runBudget = 60_000,
	} = options;

	const budgetDeadline = Date.now() + runBudget;

	const proc = spawn(descriptor.command, descriptor.args || [], {
		cwd,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	// Ensure stderr doesn't block the process
	proc.stderr?.resume();

	const client = new LspClient(proc, { requestTimeout });
	const rootUri = pathToFileURL(cwd).href;

	// Initialize with a separate timeout
	await withTimeout(client.initialize(rootUri), initTimeout, 'LSP initialize');

	const inspectedFiles = [];

	for (const baseFile of baseFiles) {
		if (Date.now() >= budgetDeadline) break;

		const languageId = LANGUAGE_ID.get(baseFile.language);
		if (!languageId) continue;

		const content = (baseFile.contentLines || []).map((l) => l.text).join('\n');
		const absPath = join(cwd, baseFile.path);
		const uri = pathToFileURL(absPath).href;

		const timeLeft = budgetDeadline - Date.now();
		const effectiveDiagWindow = Math.min(
			diagWindow,
			Math.max(0, timeLeft - 500),
		);

		let symbols = [];
		let diagnostics = [];
		try {
			const result = await client.enrichFile(
				uri,
				languageId,
				content,
				effectiveDiagWindow,
			);
			symbols = normalizeDocumentSymbols(result.symbols);
			diagnostics = normalizeDiagnostics(result.diagnostics);
		} catch {
			// Skip this file — fallback keeps base index entry
			continue;
		}

		if (symbols.length > 0 || diagnostics.length > 0) {
			inspectedFiles.push({
				imports: baseFile.imports || [],
				language: baseFile.language,
				lineCount: baseFile.lineCount,
				lspDiagnostics: diagnostics,
				path: baseFile.path,
				symbols,
			});
		}
	}

	try {
		await withTimeout(client.shutdown(), 5_000, 'LSP shutdown');
	} catch {
		client.kill();
	}

	return inspectedFiles;
}

function withTimeout(promise, ms, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
		timer.unref?.();
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}
