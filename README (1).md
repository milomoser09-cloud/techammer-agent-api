# Techammer Agent API

The three tools the Mike agent calls, plus the suppression check that must run before any outbound SMS.

**Why this exists separately from the voice platform:** this is the part Techammer owns. Business logic and call data live here, so switching voice vendors is a config change rather than a rebuild. Keep it that way — resist putting logic into the platform's flow builder.

---

## Run locally

```bash
npm install
cp .env.example .env        # then edit it
API_KEY=your-key TRANSFER_NUMBER=+1XXXXXXXXXX npm start
npm test                    # smoke test, 12 checks
```

## Deploy

Any Node host works — Railway, Render, Fly. Two things to get right:

1. **Set `API_KEY` to a long random string.** It's the only thing standing between the internet and your opt-out table.
2. **Attach a persistent volume** and point `DB_PATH` at it. SQLite on ephemeral disk means your suppression list disappears on redeploy, which is a compliance failure, not an inconvenience.

For real volume, move to Postgres. The schema ports directly.

---

## Endpoints

All require `x-api-key` except `/health`.

### Tools — wired to the agent

| Method | Path | Purpose |
|---|---|---|
| POST | `/tools/transfer` | Returns transfer destination or an honest "no human available" |
| POST | `/tools/qualification` | Saves what Mike collected |
| POST | `/tools/opt-out` | Writes suppression synchronously |

### Suppression — wired to your SMS sender

| Method | Path | Purpose |
|---|---|---|
| GET | `/suppression/:phone` | Single check |
| POST | `/suppression/check` | Bulk scrub a send list |
| POST | `/suppression` | Manual entry — STOP replies, human-logged opt-outs |

### Audit

| Method | Path | Purpose |
|---|---|---|
| GET | `/calls/:call_id` | Full event history for one call |
| GET | `/stats/transfers` | Transfer reasons by count — your containment rate |

---

## Wiring to Retell

Add each as a Custom Function. Header: `x-api-key: <your key>`.

**transfer_to_human** → `POST /tools/transfer`
```json
{
  "call_id": "{{call_id}}",
  "phone": "{{from_number}}",
  "reason": "requested_human",
  "summary": "one or two sentences for the human picking up",
  "prompt_version": "2.1"
}
```
Response includes `transfer_available`. When false, Mike books a callback instead of pretending. Don't strip that branch — an agent that promises a transfer to nowhere is worse than one that admits nobody's there.

**save_qualification** → `POST /tools/qualification`
```json
{
  "call_id": "{{call_id}}",
  "phone": "{{from_number}}",
  "first_name": "", "last_name": "", "email": "",
  "vehicle_year": 0, "vehicle_make": "", "vehicle_model": "",
  "mileage": 0,
  "current_issue": false,
  "current_issue_detail": "",
  "prompt_version": "2.1"
}
```

**log_opt_out** → `POST /tools/opt-out`
```json
{
  "call_id": "{{call_id}}",
  "phone": "{{from_number}}",
  "verbatim_request": "exactly what they said",
  "prompt_version": "2.1"
}
```

---

## Before any outbound SMS

```js
const res = await fetch(`${API}/suppression/check`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({ phones: list })
});
const { results } = await res.json();
const sendTo = results.filter(r => r.valid && !r.suppressed).map(r => r.phone);
```

Run it on every send. Not on import, not nightly — every send.

Numbers are normalized to E.164 on both write and read, so `(305) 555-1234` and `+13055551234` resolve to the same person. Suppression that only matches one format is suppression that doesn't work.

---

## Configure before production

- **`isWithinBusinessHours()` in server.js** is a placeholder: 9am–6pm Eastern, weekdays. Replace with EazeDrive's actual staffed hours.
- Transfer falls back to callbacks outside those hours. Confirm someone is genuinely reachable during them.
- Federal and state DNC scrubbing is **not** in here. That's a separate vendor feed and it's still required.
- `prompt_version` is logged on every event. Bump it whenever you edit the prompt — when something goes wrong you'll want to know which version said it.
