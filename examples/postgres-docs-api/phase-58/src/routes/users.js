import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

/**
 * POST /users
 * Create a new user
 */
router.post('/', async (req, res, next) => {
	try {
		const { email, display_name } = req.body;

		if (!email || !display_name) {
			return res
				.status(400)
				.json({ error: 'email and display_name are required' });
		}

		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			return res.status(400).json({ error: 'Invalid email format' });
		}

		const result = await query(
			`INSERT INTO users (email, display_name)
       VALUES ($1, $2)
       RETURNING id, email, display_name, created_at, updated_at`,
			[email, display_name],
		);

		const user = result.rows[0];

		// Create default settings
		await query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [user.id]);

		res.status(201).json(user);
	} catch (err) {
		if (err.code === '23505') {
			return res.status(409).json({ error: 'Email already exists' });
		}
		next(err);
	}
});

/**
 * GET /users/:id
 * Get a user by ID
 */
router.get('/:id', async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await query(
			`SELECT u.id, u.email, u.display_name, u.created_at, u.updated_at,
              us.theme, us.notifications_enabled
       FROM users u
       LEFT JOIN user_settings us ON u.id = us.user_id
       WHERE u.id = $1`,
			[id],
		);

		if (result.rows.length === 0) {
			return res.status(404).json({ error: 'User not found' });
		}

		res.json(result.rows[0]);
	} catch (err) {
		next(err);
	}
});

/**
 * PATCH /users/:id/settings
 * Update user settings
 */
router.patch('/:id/settings', async (req, res, next) => {
	try {
		const { id } = req.params;
		const { theme, notifications_enabled } = req.body;

		// Check user exists
		const userResult = await query('SELECT id FROM users WHERE id = $1', [id]);
		if (userResult.rows.length === 0) {
			return res.status(404).json({ error: 'User not found' });
		}

		// Build update set
		const updates = [];
		const values = [];
		let paramIndex = 1;

		if (theme !== undefined) {
			updates.push(`theme = $${paramIndex++}`);
			values.push(theme);
		}
		if (notifications_enabled !== undefined) {
			updates.push(`notifications_enabled = $${paramIndex++}`);
			values.push(notifications_enabled);
		}

		if (updates.length === 0) {
			return res.status(400).json({ error: 'No valid fields to update' });
		}

		updates.push(`updated_at = NOW()`);
		values.push(id);

		const result = await query(
			`UPDATE user_settings
       SET ${updates.join(', ')}
       WHERE user_id = $${paramIndex}
       RETURNING user_id, theme, notifications_enabled, created_at, updated_at`,
			values,
		);

		res.json(result.rows[0]);
	} catch (err) {
		next(err);
	}
});

export default router;
