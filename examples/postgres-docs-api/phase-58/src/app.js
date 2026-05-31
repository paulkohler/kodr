import express from 'express';
import { query } from './db.js';
import usersRouter from './routes/users.js';
import documentsRouter from './routes/documents.js';

const app = express();

// Middleware
app.use(express.json());

// Routes
app.get('/health', async (_req, res) => {
	try {
		await query('SELECT 1');
		res.json({ status: 'ok', database: 'connected' });
	} catch (err) {
		res
			.status(503)
			.json({ status: 'error', database: 'disconnected', error: err.message });
	}
});

app.use('/users', usersRouter);
app.use('/documents', documentsRouter);

// 404 handler
app.use((_req, res) => {
	res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, _req, res, _next) => {
	console.error(err.stack);
	res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
	app.listen(PORT, () => {
		console.log(`Server running on port ${PORT}`);
	});
}

export default app;
