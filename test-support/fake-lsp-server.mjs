/**
 * Fake LSP server that speaks real framed JSON-RPC over stdio.
 *
 * Usage:
 *   spawn(process.execPath, ['test-support/fake-lsp-server.mjs', JSON.stringify(config)])
 *
 * Config shape (JSON-serialized first argument):
 * {
 *   // Delay initialize response by this many ms (to test timeout)
 *   initDelayMs?: number,
 *   // Never answer initialize — forces client to kill on timeout
 *   hangOnInit?: boolean,
 *   // Symbols to return for textDocument/documentSymbol requests
 *   symbols?: LspDocumentSymbol[],
 *   // Diagnostics to push via textDocument/publishDiagnostics after didOpen
 *   diagnostics?: LspDiagnostic[],
 *   // workspaceSymbols to return for workspace/symbol
 *   workspaceSymbols?: LspSymbolInformation[],
 * }
 */

import { createInterface } from 'node:readline';

const config = (() => {
	try {
		return JSON.parse(process.argv[2] || '{}');
	} catch {
		return {};
	}
})();

const decoder = makeDecoder();

process.stdin.on('data', (chunk) => {
	const messages = decoder.push(chunk);
	for (const msg of messages) handleMessage(msg);
});

process.stdin.on('end', () => process.exit(0));

function handleMessage(msg) {
	if (!msg || typeof msg !== 'object') return;

	// Notification — no response needed
	if (!('id' in msg)) {
		if (msg.method === 'textDocument/didOpen' && config.diagnostics) {
			// Push diagnostics after a short delay
			setTimeout(() => {
				const uri = msg.params?.textDocument?.uri ?? '';
				sendNotification('textDocument/publishDiagnostics', {
					diagnostics: config.diagnostics,
					uri,
				});
			}, 20);
		}
		if (msg.method === 'exit') {
			process.exit(0);
		}
		return;
	}

	// Request
	const { id, method } = msg;

	if (method === 'initialize') {
		if (config.hangOnInit) return; // Never respond — force timeout
		const delay = config.initDelayMs ?? 0;
		setTimeout(() => {
			sendResponse(id, {
				capabilities: {
					documentSymbolProvider: true,
					referencesProvider: true,
					workspaceSymbolProvider: true,
				},
			});
		}, delay);
		return;
	}

	if (method === 'shutdown') {
		sendResponse(id, null);
		return;
	}

	if (method === 'textDocument/documentSymbol') {
		sendResponse(id, config.symbols ?? []);
		return;
	}

	if (method === 'workspace/symbol') {
		sendResponse(id, config.workspaceSymbols ?? []);
		return;
	}

	if (method === 'textDocument/references') {
		sendResponse(id, config.references ?? []);
		return;
	}

	// Unknown request — respond with empty result
	sendResponse(id, null);
}

function sendResponse(id, result) {
	send({ id, jsonrpc: '2.0', result });
}

function sendNotification(method, params) {
	send({ jsonrpc: '2.0', method, params });
}

function send(msg) {
	const body = JSON.stringify(msg);
	const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
	process.stdout.write(frame);
}

// Content-Length framing decoder (same logic as LspClient, self-contained)
function makeDecoder() {
	let buf = Buffer.alloc(0);
	return {
		push(chunk) {
			buf = Buffer.concat([
				buf,
				chunk instanceof Buffer ? chunk : Buffer.from(chunk),
			]);
			const out = [];
			let msg;
			while ((msg = tryDecode()) !== null) out.push(msg);
			return out;
		},
	};

	function tryDecode() {
		let sep = -1;
		for (let i = 0; i < buf.length - 3; i++) {
			if (
				buf[i] === 13 &&
				buf[i + 1] === 10 &&
				buf[i + 2] === 13 &&
				buf[i + 3] === 10
			) {
				sep = i;
				break;
			}
		}
		if (sep === -1) return null;

		const header = buf.slice(0, sep).toString('ascii');
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
			buf = buf.slice(bodyStart);
			return null;
		}
		if (buf.length < bodyStart + contentLength) return null;

		const body = buf
			.slice(bodyStart, bodyStart + contentLength)
			.toString('utf8');
		buf = buf.slice(bodyStart + contentLength);
		try {
			return JSON.parse(body);
		} catch {
			return null;
		}
	}
}
