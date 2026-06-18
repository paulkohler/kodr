# Example Idea: Full-Stack Auth App

An Express REST API backed by PostgreSQL (Docker), with bcrypt password hashing
and JWT session tokens. A vanilla HTML/JS frontend (React via CDN) with register,
login, and a protected dashboard. Two kodr sessions: Session 1 builds the backend;
Session 2 adds the frontend and wires a static file server.

## Areas exercised

- Docker Compose integration (PostgreSQL 16, wait-for-healthy pattern)
- `pg` connection pool, async migrations, prepared-statement style queries
- `bcryptjs` password hashing + `jsonwebtoken` sign/verify
- Express route composition and JWT middleware
- Session 2 adds frontend without touching backend test suite
- Heal loop pressure: ESM + CommonJS interop (`bcryptjs` vs `bcrypt`), missing
  `await` on async middleware, `pg` Pool vs Client distinction

## File structure after Session 1

```
docker-compose.yml  — postgres:16 service, healthcheck, port 5432
package.json        — ESM, deps: express, pg, bcryptjs, jsonwebtoken
src/db.mjs          — createPool(), migrate(pool)
src/auth.mjs        — register(pool, username, password), login(pool, username, password)
src/server.mjs      — createApp(pool), startServer(port)
test/auth.test.mjs  — node:test integration tests (require running Postgres)
```

## File structure after Session 2

```
(all Session 1 files unchanged)
public/index.html   — React 18 via esm.sh CDN, React.createElement (no JSX),
                      RegisterView → LoginView → DashboardView
src/static.mjs      — serveStatic(app): serves public/ on GET /* (after API routes)
src/server.mjs      — updated to call serveStatic(app)
test/static.test.mjs — node:test: GET / returns 200 with HTML containing 'React'
```

## Session 1 prompt

```
Build an Express authentication API backed by PostgreSQL.

docker-compose.yml — version "3.9". Service db: image postgres:16, environment
  POSTGRES_DB=authdb POSTGRES_USER=authuser POSTGRES_PASSWORD=authpass, ports
  "5432:5432", healthcheck: test ["CMD","pg_isready","-U","authuser","-d","authdb"],
  interval 5s, timeout 3s, retries 10.

package.json — {"type":"module","dependencies":{"express":"^4","pg":"^8",
  "bcryptjs":"^3","jsonwebtoken":"^9"}}, no devDependencies.

src/db.mjs — import pg from 'pg'. Export function createPool(): returns new
  pg.Pool({connectionString: process.env.DATABASE_URL ||
  'postgres://authuser:authpass@localhost:5432/authdb'}). Export async function
  migrate(pool): executes CREATE TABLE IF NOT EXISTS users(id serial primary key,
  username text unique not null, password_hash text not null, created_at timestamptz
  default now()).

src/auth.mjs — import bcrypt from 'bcryptjs'; import jwt from 'jsonwebtoken'.
  const SECRET = process.env.JWT_SECRET || 'dev-secret-do-not-use'.
  Export async function register(pool, username, password): hash password with
    bcrypt.hash(password, 10), insert into users, return {id, username}. Throw
    Error with code 'DUPLICATE' if username already exists (pg error code 23505).
  Export async function login(pool, username, password): query user by username,
    compare with bcrypt.compare, on match return jwt.sign({id, username}, SECRET,
    {expiresIn:'24h'}), throw Error with code 'INVALID_CREDENTIALS' otherwise.
  Export function verifyToken(token): return jwt.verify(token, SECRET) (throws on invalid).

src/server.mjs — import express; import {createPool, migrate} from './db.mjs'; import
  {register, login, verifyToken} from './auth.mjs'.
  Export function createApp(pool):
    const app = express(); app.use(express.json()).
    POST /register: call register(), respond 201 {id,username}; on DUPLICATE error 409
      {error:'username taken'}; on other error 500.
    POST /login: call login(), respond 200 {token}; on INVALID_CREDENTIALS 401
      {error:'invalid credentials'}; on other error 500.
    Middleware authMiddleware: reads Authorization header, calls verifyToken, sets
      req.user = payload; on failure respond 401.
    GET /me: apply authMiddleware, respond {id: req.user.id, username: req.user.username}.
    Return app.
  Export async function startServer(port=3000): pool=createPool(), await migrate(pool),
    app=createApp(pool), app.listen(port). Return {app, pool, server}.

test/auth.test.mjs — node:test integration tests. These require a running PostgreSQL
  instance. In before(): call startServer(3001), run migrate, delete from users.
  In after(): pool.end(), server.close().
  Use node:http or globalThis.fetch to test the running server on port 3001.
  Tests:
    - POST /register returns 201 with {id, username}
    - POST /register duplicate username returns 409
    - POST /login correct password returns {token}
    - POST /login wrong password returns 401
    - GET /me with valid Bearer token returns {id, username}
    - GET /me without token returns 401
    - GET /me with invalid token returns 401
```

## Session 2 prompt (fresh run in same workspace)

```
The backend API is done and tests pass. Add a browser frontend.

public/index.html — A single HTML file that implements the full auth UI using
  React 18 loaded from esm.sh CDN (no build tools, no JSX — use React.createElement).
  Import React and ReactDOM from 'https://esm.sh/react@18' and
  'https://esm.sh/react-dom@18/client'. Use <script type="module">.
  
  Three components using React.createElement:
  - RegisterForm: username + password inputs, submit POSTs to /register. On success
    calls onSuccess(). Shows error message on failure.
  - LoginForm: username + password inputs, submit POSTs to /login. On success stores
    token in localStorage('auth_token') and calls onSuccess(). Shows error on failure.
  - Dashboard: on mount fetches GET /me with Authorization: Bearer <token from
    localStorage>. Shows "Welcome, <username>" and a Logout button that clears
    localStorage and calls onLogout(). Shows loading state while fetching.
  
  Root App component: state 'view' starts as 'login'. If 'register' shows RegisterForm
  with onSuccess → switch to 'login'. If 'login' shows LoginForm with onSuccess →
  switch to 'dashboard'. If 'dashboard' shows Dashboard with onLogout → switch to
  'login'. Also show a link to toggle between register and login views.
  
  Mount with ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App))
  Add a <div id="root"> in the body.

src/static.mjs — export function serveStatic(app): app.use(express.static('public')).
  Also add app.get('*', (req, res) => res.sendFile('index.html', {root:'public'}))
  so client-side routing works.

Update src/server.mjs: import {serveStatic} from './static.mjs'. In createApp(pool),
  call serveStatic(app) after all API routes are registered (so API takes priority).

test/static.test.mjs — node:test: create a pool-less version of the app by calling
  createApp(null) (the static handler doesn't need the pool), start it on port 3002.
  Test: GET / returns status 200 and response body contains the string 'React'.
  Teardown: server.close().
```

## What to watch for

- Does the model use `bcryptjs` (ESM-compatible) rather than `bcrypt` (native)?
- Does it correctly handle the `pg` error code `23505` for duplicate usernames?
- Does Session 2 use `React.createElement` correctly, or does it use JSX (which would
  fail in-browser without Babel)?
- Does `serveStatic` come after API routes? Reversed order breaks /register, /login.
- Does `createApp(null)` in the static test survive without a pool reference?
- How many heal cycles does each session need?

## Prerequisites

Start PostgreSQL before running Session 1 tests:

```sh
cd ~/src/kodr-testing/phase-201/auth-app-1
docker compose up -d
# wait for healthy: docker compose ps
npm install
```

## Run commands

```sh
# Session 1
mkdir -p ~/src/kodr-testing/phase-201/auth-app-1
cd ~/src/kodr-testing/phase-201/auth-app-1
# start postgres and npm install first (see Prerequisites)
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 1 prompt>"

# Session 2 (fresh run in same workspace)
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 2 prompt>"
```

## Results — 2026-06-18 trial run (qwen3.6, 32K context)

### Session 1

**First pass, all 4 files, all 7 tests green.**

`bcryptjs` worked correctly with ESM (`import bcrypt from 'bcryptjs'`). The pg error code
`23505` was correctly detected and converted to `code: 'DUPLICATE'`. `globalThis.fetch`
worked in Node 24 for integration tests. JWT sign/verify was correct.

### Session 2

First pass applied `public/index.html`, `src/static.mjs`, updated `src/server.mjs`, and
created `test/static.test.mjs`. **5 targeted fix passes were needed to reach 9/9 green.**

Regressions introduced:

1. **`server.mjs` API contract broken**: Session 2 completely rewrote `server.mjs`.
   - Changed `startServer(port)` to `startServer(pool, port)` — reversed arg order, pool now external
   - Returned raw `server` (http.Server) instead of `{app, pool, server, close}`
   - Registered async route handlers as `app.post('/register', register(pool))` — this calls `register(pool)` immediately and passes the returned Promise as the Express callback. Express throws: "Route.post() requires a callback function but got a [object Promise]".
   - Required 1 fix pass to restore correct API.

2. **`static.mjs` missing express import**: The model wrote `app.use(express.static(...))` without importing express. Required 1 fix pass.

3. **`static.mjs` wrong path and missing catch-all**: The "add import" fix pass rewrote `static.mjs` entirely with `__dirname + '/static'` instead of the `public` directory. Also dropped the `app.get('*', ...)` catch-all. Required another rewrite pass.

4. **`test/static.test.mjs` wrong signature**: Test called `startServer(pool, 3002)` (Session 2's broken API) instead of `startServer(3002)`. Required 1 fix pass.

Total: 4 fix passes for Session 2 regressions.

### Key learnings

| Observation | Detail |
|-------------|--------|
| Session 1: first pass clean | 4 files, 7 integration tests green — complex npm stack (express, pg, bcryptjs, jwt) generated correctly |
| Session 2: API contract broken | Model rewrote server.mjs from scratch with wrong signature and broken async-as-callback pattern |
| async route antipattern | `app.post('/register', register(pool))` — model passes result of async call as handler. Correct: `async (req,res) => { const result = await register(pool, ...); }` |
| "Fix import" pass rewrites | Small fix pass (add import) rewrote entire file with wrong implementation |
| static path via __dirname | `express.static('public')` is CWD-relative; `express.static(join(__dirname,'..','public'))` is file-relative and correct |
| bcryptjs ESM | `bcryptjs` (not `bcrypt`) is the pure-JS version; works in ESM without native bindings |
| globalThis.fetch in Node 24 | Works for integration tests without any polyfill |
| 23505 → DUPLICATE | Model correctly mapped pg duplicate-key error code to a domain error |
