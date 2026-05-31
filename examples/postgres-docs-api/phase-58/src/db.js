import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
	console.error('Unexpected error on idle client', err);
	process.exit(-1);
});

/**
 * Run a query with parameters
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @returns {Promise<{rows: Array, rowCount: number}>}
 */
export async function query(text, params) {
	const client = await pool.connect();
	try {
		const result = await client.query(text, params);
		return result;
	} finally {
		client.release();
	}
}

/**
 * Run a transaction
 * @param {Function} cb - Callback that receives a client
 * @returns {Promise<any>}
 */
export async function transaction(cb) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await cb(client);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		client.release();
	}
}

export default pool;
