# Phase 178: Tuning the Secret-in-Response Sensor

## What happened

Phase 173's secret-in-response sensor flagged any secret-named token appearing
near a response sink. That heuristic is too broad: OAuth flows legitimately return
`accessToken` and `refreshToken` to the client. Every login endpoint was generating
a false positive.

## Fix 1 — Safe-names allowlist

A `SAFE_SECRET_NAMES` regex strips known-safe tokens before the secret check:

```
accessToken, refreshToken, idToken, csrfToken, bearerToken, authToken, xCsrf
```

After stripping, the remaining window text must still match `SECRET_NAMES` for the
sensor to fire. This means `accessToken` alone is silent, but `accessToken` and
`password` in the same window still flags — the password survives the strip.

## Fix 2 — Per-block suppression comment

For cases the allowlist cannot cover, add:

```js
// kodr-ignore: secret-in-response
res.json({ token });
```

The sensor skips the entire ±4-line window if `IGNORE_COMMENT` matches anywhere
in it.

## Result

5 new tests; 69 total in cross-ref-sensor.test.mjs. False-positive rate on normal
OAuth endpoints drops to zero.
