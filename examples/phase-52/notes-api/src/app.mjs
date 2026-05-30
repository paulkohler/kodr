import express from 'express';
import { NoteStore } from './store.mjs';

const MAX_BODY_BYTES = 100_000;

export function createApp(options = {}) {
	const store =
		options.store || new NoteStore(options.notesFile || 'notes.json');

	const app = express();

	app.use(express.json({ limit: MAX_BODY_BYTES }));

	// GET /notes
	app.get('/notes', async (req, res) => {
		try {
			const notes = await store.list();
			res.json({ notes });
		} catch (error) {
			res.status(500).json({ error: 'Internal server error' });
		}
	});

	// POST /notes
	app.post('/notes', async (req, res) => {
		try {
			const input = validateNoteInput(req.body, { partial: false });
			const note = await store.create(input);
			res.status(201).json({ note });
		} catch (error) {
			res.status(error.statusCode || 400).json({ error: error.message });
		}
	});

	// GET /notes/:id
	app.get('/notes/:id', async (req, res) => {
		try {
			const note = await store.get(req.params.id);
			if (!note) {
				return res.status(404).json({ error: 'Note not found' });
			}
			res.json({ note });
		} catch (error) {
			res.status(500).json({ error: 'Internal server error' });
		}
	});

	// PATCH /notes/:id
	app.patch('/notes/:id', async (req, res) => {
		try {
			const input = validateNoteInput(req.body, { partial: true });
			const note = await store.update(req.params.id, input);
			if (!note) {
				return res.status(404).json({ error: 'Note not found' });
			}
			res.json({ note });
		} catch (error) {
			res.status(error.statusCode || 400).json({ error: error.message });
		}
	});

	// DELETE /notes/:id
	app.delete('/notes/:id', async (req, res) => {
		try {
			const note = await store.delete(req.params.id);
			if (!note) {
				return res.status(404).json({ error: 'Note not found' });
			}
			res.json({ note });
		} catch (error) {
			res.status(500).json({ error: 'Internal server error' });
		}
	});

	// 404 handler for unmatched routes
	app.use((_req, res) => {
		res.status(404).json({ error: 'Not found' });
	});

	// Express error handler
	app.use((error, _req, res, _next) => {
		if (error.type === 'entity.parse.failed' || error instanceof SyntaxError) {
			return res.status(400).json({ error: 'Invalid JSON body' });
		}
		const statusCode = error.statusCode || 500;
		res.status(statusCode).json({
			error: statusCode === 500 ? 'Internal server error' : error.message,
		});
	});

	return app;
}

function validateNoteInput(input, options) {
	if (input === undefined) {
		throw new SyntaxError('Invalid JSON body');
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw httpError(400, 'JSON body must be an object');
	}

	const output = {};
	if (Object.hasOwn(input, 'title')) {
		if (typeof input.title !== 'string' || input.title.trim() === '') {
			throw httpError(400, 'title must be a non-empty string');
		}
		output.title = input.title.trim();
	}
	if (Object.hasOwn(input, 'body')) {
		if (typeof input.body !== 'string') {
			throw httpError(400, 'body must be a string');
		}
		output.body = input.body;
	}

	if (!options.partial && (!output.title || !Object.hasOwn(output, 'body'))) {
		throw httpError(400, 'title and body are required');
	}
	if (options.partial && Object.keys(output).length === 0) {
		throw httpError(400, 'At least one note field is required');
	}

	return output;
}

function httpError(statusCode, message) {
	const error = new Error(message);
	error.statusCode = statusCode;
	return error;
}
