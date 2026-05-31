import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMigrations() {
	// Create migrations table if it doesn't exist
	await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

	// Get list of migration files
	const migrationsDir = path.join(__dirname, '..', 'migrations');
	const files = fs
		.readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();

	// Get already applied migrations
	const { rows: applied } = await query(
		'SELECT version FROM schema_migrations ORDER BY version',
	);
	const appliedVersions = new Set(applied.map((r) => r.version));

	for (const file of files) {
		const match = file.match(/^(\d+)_/);
		if (!match) continue;

		const version = parseInt(match[1], 10);
		if (appliedVersions.has(version)) {
			console.log(`Skipping migration ${version} (already applied)`);
			continue;
		}

		console.log(`Applying migration ${version}: ${file}`);
		const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
		await query(sql);
		await query('INSERT INTO schema_migrations (version) VALUES ($1)', [
			version,
		]);
		console.log(`Applied migration ${version}`);
	}

	console.log('Migrations complete');
}

runMigrations().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
