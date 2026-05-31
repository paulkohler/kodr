export const BASE_URL =
	process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

export async function fetch(path, options = {}) {
	const url = new URL(path, BASE_URL);
	const res = await fetch(url.toString(), {
		method: options.method || 'GET',
		headers: { 'Content-Type': 'application/json', ...options.headers },
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}
