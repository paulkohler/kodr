import { Router } from 'express';
import { query, transaction } from '../db.js';

const router = Router();

/**
 * POST /documents
 * Create a new document
 */
router.post('/', async (req, res, next) => {
	try {
		const { owner_id, title, body, status } = req.body;

		if (!owner_id || !title) {
			return res.status(400).json({ error: 'owner_id and title are required' });
		}

		const docStatus = status || 'draft';
		const validStatuses = ['draft', 'published', 'archived'];
		if (!validStatuses.includes(docStatus)) {
			return res.status(400).json({
				error: 'Invalid status. Must be one of: draft, published, archived',
			});
		}

		const result = await query(
			`INSERT INTO documents (owner_id, title, body, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, owner_id, title, body, status, created_at, updated_at`,
			[owner_id, title, body || '', docStatus],
		);

		const doc = result.rows[0];

		// Create initial version
		await query(
			`INSERT INTO document_versions (document_id, version_number, title, body)
       VALUES ($1, 1, $2, $3)`,
			[doc.id, title, body || ''],
		);

		res.status(201).json(doc);
	} catch (err) {
		if (err.code === '23503') {
			return res.status(404).json({ error: 'Owner user not found' });
		}
		next(err);
	}
});

/**
 * GET /documents
 * List documents (with optional filters)
 */
router.get('/', async (req, res, next) => {
	try {
		const { owner_id, status, tag, limit = 50, offset = 0 } = req.query;

		let sql = `
      SELECT d.id, d.owner_id, d.title, d.body, d.status, d.created_at, d.updated_at
      FROM documents d
      WHERE 1=1
    `;
		const params = [];
		let paramIndex = 1;

		if (owner_id) {
			sql += ` AND d.owner_id = $${paramIndex++}`;
			params.push(owner_id);
		}
		if (status) {
			sql += ` AND d.status = $${paramIndex++}`;
			params.push(status);
		}
		if (tag) {
			sql += ` AND d.id IN (SELECT document_id FROM document_tags WHERE tag = $${paramIndex++})`;
			params.push(tag);
		}

		sql += ` ORDER BY d.updated_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
		params.push(limit, offset);

		const result = await query(sql, params);
		res.json(result.rows);
	} catch (err) {
		next(err);
	}
});

/**
 * GET /documents/:id
 * Get a document by ID
 */
router.get('/:id', async (req, res, next) => {
	try {
		const { id } = req.params;

		const docResult = await query(
			`SELECT d.id, d.owner_id, d.title, d.body, d.status, d.created_at, d.updated_at
       FROM documents d
       WHERE d.id = $1`,
			[id],
		);

		if (docResult.rows.length === 0) {
			return res.status(404).json({ error: 'Document not found' });
		}

		const tagsResult = await query(
			`SELECT tag FROM document_tags WHERE document_id = $1`,
			[id],
		);

		const doc = docResult.rows[0];
		doc.tags = tagsResult.rows.map((r) => r.tag);

		res.json(doc);
	} catch (err) {
		next(err);
	}
});

/**
 * PATCH /documents/:id
 * Update a document
 */
router.patch('/:id', async (req, res, next) => {
	try {
		const { id } = req.params;
		const { title, body, status } = req.body;

		// Check document exists
		const docResult = await query('SELECT id FROM documents WHERE id = $1', [
			id,
		]);
		if (docResult.rows.length === 0) {
			return res.status(404).json({ error: 'Document not found' });
		}

		// Build update set
		const updates = [];
		const values = [];
		let paramIndex = 1;

		if (title !== undefined) {
			updates.push(`title = $${paramIndex++}`);
			values.push(title);
		}
		if (body !== undefined) {
			updates.push(`body = $${paramIndex++}`);
			values.push(body);
		}
		if (status !== undefined) {
			const validStatuses = ['draft', 'published', 'archived'];
			if (!validStatuses.includes(status)) {
				return res.status(400).json({
					error: 'Invalid status. Must be one of: draft, published, archived',
				});
			}
			updates.push(`status = $${paramIndex++}`);
			values.push(status);
		}

		if (updates.length === 0) {
			return res.status(400).json({ error: 'No valid fields to update' });
		}

		updates.push(`updated_at = NOW()`);
		values.push(id);

		const result = await query(
			`UPDATE documents
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, owner_id, title, body, status, created_at, updated_at`,
			values,
		);

		res.json(result.rows[0]);
	} catch (err) {
		next(err);
	}
});

/**
 * DELETE /documents/:id
 * Delete a document
 */
router.delete('/:id', async (req, res, next) => {
	try {
		const { id } = req.params;

		const result = await query(
			'DELETE FROM documents WHERE id = $1 RETURNING id',
			[id],
		);

		if (result.rows.length === 0) {
			return res.status(404).json({ error: 'Document not found' });
		}

		res.status(204).send();
	} catch (err) {
		next(err);
	}
});

/**
 * POST /documents/:id/versions
 * Create a new version of a document
 */
router.post('/:id/versions', async (req, res, next) => {
	try {
		const { id } = req.params;
		const { title, body } = req.body;

		// Check document exists
		const docResult = await query('SELECT id FROM documents WHERE id = $1', [
			id,
		]);
		if (docResult.rows.length === 0) {
			return res.status(404).json({ error: 'Document not found' });
		}

		// Get current version number
		const versionResult = await query(
			`SELECT COALESCE(MAX(version_number), 0) as max_version
       FROM document_versions
       WHERE document_id = $1`,
			[id],
		);

		const nextVersion = versionResult.rows[0].max_version + 1;

		const result = await query(
			`INSERT INTO document_versions (document_id, version_number, title, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, document_id, version_number, title, body, created_at`,
			[id, nextVersion, title || null, body || null],
		);

		res.status(201).json(result.rows[0]);
	} catch (err) {
		next(err);
	}
});

/**
 * GET /documents/:id/versions
 * Get all versions of a document
 */
router.get('/:id/versions', async (req, res, next) => {
	try {
		const { id } = req.params;

		// Check document exists
		const docResult = await query('SELECT id FROM documents WHERE id = $1', [
			id,
		]);
		if (docResult.rows.length === 0) {
			return res.status(404).json({ error: 'Document not found' });
		}

		const result = await query(
			`SELECT id, document_id, version_number, title, body, created_at
       FROM document_versions
       WHERE document_id = $1
       ORDER BY version_number ASC`,
			[id],
		);

		res.json(result.rows);
	} catch (err) {
		next(err);
	}
});

/**
 * POST /documents/:id/tags
 * Add a tag to a document
 */
router.post('/:id/tags', async (req, res, next) => {
	try {
		const { id } = req.params;
		const { tag } = req.body;

		if (!tag) {
			return res.status(400).json({ error: 'tag is required' });
		}

		// Check document exists
		const docResult = await query('SELECT id FROM documents WHERE id = $1', [
			id,
		]);
		if (docResult.rows.length === 0) {
			return res.status(404).json({ error: 'Document not found' });
		}

		await query(
			`INSERT INTO document_tags (document_id, tag) VALUES ($1, $2)`,
			[id, tag],
		);

		res.status(201).json({ document_id: id, tag });
	} catch (err) {
		if (err.code === '23505') {
			return res
				.status(409)
				.json({ error: 'Tag already exists on this document' });
		}
		next(err);
	}
});

/**
 * DELETE /documents/:id/tags/:tag
 * Remove a tag from a document
 */
router.delete('/:id/tags/:tag', async (req, res, next) => {
	try {
		const { id, tag } = req.params;

		const result = await query(
			`DELETE FROM document_tags
       WHERE document_id = $1 AND tag = $2
       RETURNING document_id, tag`,
			[id, tag],
		);

		if (result.rows.length === 0) {
			return res.status(404).json({ error: 'Tag not found on this document' });
		}

		res.status(204).send();
	} catch (err) {
		next(err);
	}
});

export default router;
