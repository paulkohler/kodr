# Example: Mock Weather REST API

A single-session Express mock weather API. No real weather data — deterministic
city map for testing. Exercises the standard create-app / before-after / fetch pattern.

**Workspace:** `~/src/kodr-testing/phase-204/weather-api-1`  
**Model:** `qwen/qwen3.6-35b-a3b`

## Files

```
package.json        — {"type":"module","dependencies":{"express":"^4"}}
src/weather.mjs     — getWeather(city), listCities() — deterministic mock data
src/server.mjs      — createApp() → Express app with /weather/:city, /cities, /health
test/server.test.mjs — node:test: 5 tests via globalThis.fetch
```

## Prompt

```
Build a mock weather REST API using Express (no other deps).

package.json — {"type":"module","dependencies":{"express":"^4"}}.

src/weather.mjs — deterministic mock weather data (no real API calls).
  const CITIES = {
    london: { temp: 15, condition: 'cloudy', humidity: 80 },
    paris:  { temp: 18, condition: 'sunny',  humidity: 60 },
    tokyo:  { temp: 22, condition: 'rainy',  humidity: 75 },
    sydney: { temp: 25, condition: 'sunny',  humidity: 55 },
  };
  export function getWeather(city) {
    const data = CITIES[city.toLowerCase()];
    if (!data) return null;
    return { city, ...data, unit: 'celsius', timestamp: new Date().toISOString() };
  }
  export function listCities() { return Object.keys(CITIES); }

src/server.mjs — Express app.
  export function createApp() {
    const app = express(); app.use(express.json());
    GET /weather/:city → 200 {city, temp, condition, humidity, unit, timestamp} or 404 {error:'City not found'}
    GET /cities → 200 {cities: ['london','paris','tokyo','sydney']}
    GET /health → 200 {status:'ok'}
    return app;
  }

test/server.test.mjs — node:test integration tests.
  Use before/after hooks for a single shared server instance.
  Start with app.listen(0); capture port from server.address().port.
  after(): server.closeAllConnections?.(); await new Promise(r => server.close(r));
  Use globalThis.fetch for HTTP requests.
  Tests:
    - GET /health returns 200 {status:'ok'}
    - GET /cities returns 200 with array containing 'london'
    - GET /weather/london returns 200 with {city:'london', temp:15, condition:'cloudy'}
    - GET /weather/LONDON (uppercase) returns 200 (case-insensitive)
    - GET /weather/atlantis returns 404 {error:'City not found'}

package.json — add 'scripts':{'test':'node --test'}
```

## Run

```sh
mkdir -p ~/src/kodr-testing/phase-204/weather-api-1
cd ~/src/kodr-testing/phase-204/weather-api-1
echo '{"type":"module","dependencies":{"express":"^4"}}' > package.json
npm install

kodr run --yes --no-heal --no-tools --no-inspect-context --no-protect-existing \
  --test "node --test" --max-turns 20 -p "<prompt>"
```

## Result

Run ok on first attempt.  
Tokens: 2,840 (prompt 1,408 / completion 1,432). Tests: 5/5 passing.

## Notes

- The model preserved req.params.city casing in the response (city name echoed back as
  typed in the URL) while still doing case-insensitive lookup with toLowerCase(). Correct.
- Simple pure-Express example with no SQLite or busboy — the model converges quickly
  (1,432 completion tokens vs 1,890 for file-upload with busboy complexity).
- The `--no-inspect-context` + `--no-heal` pattern remains the right default for qwen3.6.
