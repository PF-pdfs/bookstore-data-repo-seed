# Payment-path failure audit

Every failure mode in the webhook, what happens, and what it cost to get
there. Written because this is the one path in the system where being
wrong costs real money.

**The two rules everything below is built around:**

1. Never take a payment and end up with **no shipment and nobody told**.
2. Never take one payment and create **two shipments**.

Every branch is either verified by an automated test (80 end-to-end
checks in `worker.e2e.mjs`) or explicitly flagged as unverifiable from
code.

---

## Problems found in this audit, and fixed

These were real holes in the version handed over before this audit.

### 1. Failure + undeliverable alert = order vanishes

**Was:** if Courier Karo rejected the booking *and* the alert email
couldn't be sent (Resend down, bad key, quota exhausted), the Worker
logged to console, marked the payment "processed", and returned **200**.
Razorpay saw success and never retried. Money taken, nothing shipped,
nobody told, no trace outside Worker logs.

**Now:** `alert()` reports whether any channel actually delivered. If
nothing did, the payment is *not* marked processed and the Worker returns
**5xx**, so Razorpay retries — another delivery is another chance to
reach you. Applies to all three pre-booking failure branches.

*Tested:* scenarios 10, 11, 13.

### 2. Duplicate-shipment race

**Was:** the "already processed" marker was written **after** the Courier
Karo booking succeeded. If the Worker died in between — a KV hiccup, a
CPU limit, an evicted isolate — Razorpay retried, found no marker, and
booked a **second shipment**. Two parcels, one payment, silently.

**Now:** the payment is **claimed before** booking
(`booking_in_progress`), and the claim is replaced by the AWB on success.
A retry that finds a claim will **never auto-book again** — it alerts a
human to check Courier Karo for that order, because it's impossible to
tell from here whether the first attempt reached them.

The tradeoff is deliberate: if the Worker died *before* Courier Karo
received anything, the retry still won't auto-book, so a human has to
confirm. That's the cheap failure. Two parcels is the expensive one.

*Tested:* scenario 12 — the headline test in the file.

### 3. Unreadable payload = silent infinite retry

**Was:** `JSON.parse` and `payload.payload.payment.entity` were
unguarded. A valid-signature request whose shape differed (Razorpay
changing their format) threw, returned 5xx, and Razorpay retried the same
unreadable body on a schedule — failing identically every time, silently,
until it gave up and the order was lost.

**Now:** guarded. You get an alert with the raw body, and a 200 to stop
the pointless retries.

*Tested:* scenarios 14, 15.

### 4. An alert that asserted something it couldn't know

**Was:** the Courier Karo failure alert said *"Payment succeeded but NO
shipment was created."* That branch also catches a dropped connection or
an unreadable reply — cases where Courier Karo may well **have** created
the shipment. Acting on that wording could create a duplicate by hand.

**Now:** the alert says to check the Courier Karo dashboard for the order
id *first*, and only create it manually if it isn't already there.

### 5. A KV write per order, spent on nothing

**Was:** the catalog was re-cached to KV on **every single webhook**,
rewriting identical bytes. KV's free tier is metered in **writes per
day**, so this spent roughly a third of the daily order ceiling
re-storing data that hadn't changed.

**Now:** written only when the content actually differs. Steady state
drops from 3 KV writes per order to 2.

### 6. Nothing handled the write quota running out

**Was:** if the claim write failed (quota exhausted), it threw
unhandled — 5xx, retry, fail again, silently.

**Now:** caught explicitly. It refuses to book (booking without a claim
risks duplicates), alerts you naming the likely cause, and returns 5xx so
Razorpay retries — by which point the daily quota may have reset.

---

## Every failure mode, and what happens now

| What fails | Booked? | You're told? | Razorpay retries? | Safe? |
|---|---|---|---|---|
| Forged / missing signature | No | No (by design) | No — 401 | ✅ Correct: not a real payment |
| Unreadable / changed payload | No | **Yes** | No — 200 | ✅ Alert carries raw body |
| Product name not in catalog | No | **Yes** | No — 200 | ✅ Alert lists known names |
| …and alert undeliverable | No | Not yet | **Yes** — 5xx | ✅ Retry is another chance |
| Bad pincode / phone | No | **Yes** | No — 200 | ✅ Deliberate: won't ship to a bad address |
| …and alert undeliverable | No | Not yet | **Yes** — 5xx | ✅ |
| KV claim write fails (quota) | No | **Yes** | **Yes** — 5xx | ✅ Refuses to book unclaimed |
| Courier Karo rejects | No | **Yes** | No — 200 | ✅ Alert says verify before re-creating |
| …and alert undeliverable | No | Not yet | **Yes** — 5xx | ✅ Claim released first |
| Worker dies mid-booking | **Maybe** | **Yes, on retry** | Retry handled | ✅ Never double-books; human verifies |
| Courier Karo response missing `awb_no` | Yes | **Yes** | No — 200 | ✅ Customer still emailed, no "undefined" |
| Customer email fails | Yes | **Yes** | No — 200 | ✅ Shipment is fine; you're told to send by hand |
| GitHub Pages (catalog) down | Yes | No | No — 200 | ✅ Serves from KV cache |
| …and KV cache empty | Depends | **Yes** | No — 200 | ✅ Falls back to FALLBACK_CATALOG, else alerts |
| Duplicate webhook delivery | No 2nd | No | No — 200 | ✅ Dedup guard |
| Worker entirely down | No | No | **Yes** | ⚠️ See backstop below |

---

## The one gap code cannot close

**If the Worker is unreachable for long enough, Razorpay eventually stops
retrying and the order is lost with no alert** — because the alert itself
runs *in* the Worker.

Nothing in the Worker can fix this; it's dead when it happens. The
backstop is a process, not code:

> **Periodically reconcile Razorpay payments against Courier Karo
> shipments.** Razorpay's dashboard is the source of truth for what was
> paid. Anything paid without a matching shipment needs booking by hand.

Worth doing weekly at low volume, and worth automating (a scheduled
Worker cron comparing the two) if order volume ever justifies it.

**Also unverified:** Razorpay's exact retry schedule and how many times
it retries before giving up. I could not confirm this from anything you
sent, and it determines how much slack the 5xx-and-retry behaviour
actually buys. **Check Razorpay Dashboard → Settings → Webhooks** for
their current policy.

---

## Capacity limits — researched against Cloudflare's docs

Checked directly against Cloudflare's published KV limits (Aug 2026):

| Limit | Free plan | Paid plan |
|---|---|---|
| Writes to **different** keys per day | **1,000** | Unlimited |
| Reads per day | 100,000 | Unlimited |
| Writes to the **same** key per second | **1** | **1** (yes, paid too) |

### What that means for order volume

After the fixes in this audit, a successful order costs **2 KV writes**
(the claim, then the result). So the free tier supports roughly
**~500 orders per day** — matching your estimate. The catalog cache write
only happens when the catalog actually changed, so it's negligible.

### Can it be 1 write per order? No — not safely, and here's why

The two writes are doing two different jobs: the **claim** (before
booking) is what prevents a duplicate shipment if the Worker dies
mid-booking, and the **result** (after) is what makes routine duplicate
deliveries silent no-ops. Dropping either one reopens a hole this audit
just closed:

- Drop the claim → the duplicate-shipment race comes back.
- Drop the result → every routine duplicate delivery from Razorpay would
  raise a false "check this manually" alarm.

If ~500/day ever becomes a real constraint, the correct fix is
Cloudflare's **paid Workers plan ($5/month)**, which removes the daily
write cap entirely — far cheaper than the engineering to squeeze out one
write, and at 500 orders/day the revenue easily covers it.

### What happens when the daily write limit is reached

The claim write fails. The Worker **refuses to book** (booking without a
claim risks duplicates), **alerts you** naming the quota as the likely
cause, and returns 5xx so **Razorpay retries** — the quota resets daily,
so a retry a few hours later can succeed. Nothing is silently lost.
*(Tested: the KV-claim-failure scenario.)*

### Same-key write rate: a bug this research caught in my own code

KV allows only **one write per second to the same key — on the paid plan
too**. This Worker writes the payment's key twice, separated only by the
Courier Karo round-trip, which is often under a second. As originally
written, a rate-limited second write would have thrown and turned a
**successful** order into a 5xx plus a false alarm.

**Fixed:** the result write is now non-fatal. If it's rejected, the claim
stays in place (a retry still can't double-book), the customer still gets
their email, and the worst case is one false "verify this order" question
later. *(Tested: scenario 17.)*

### Simultaneous payments — your question about concurrent KV writes

**Different customers paying at the same time: completely fine.** Each
payment writes to its own key (the Razorpay payment id), and the 1/sec
limit is per-key. Different keys don't contend with each other.

**The same payment delivered twice at nearly the same instant:** here
honesty matters. KV is **eventually consistent** — a write can take up to
~60 seconds to become visible in *other* Cloudflare locations. So if
Razorpay delivered the *same* webhook twice, near-simultaneously, to two
different Cloudflare data centres, both could check the claim, both see
nothing, and both book. KV has no atomic compare-and-set to close this
completely; that's a documented KV property, not a bug in this code.

**Why this is a low practical risk:** webhook retries from payment
providers are typically spaced seconds-to-minutes apart (which eventual
consistency comfortably covers), not fired twice in the same second to
different continents. But it is not *zero* risk, and the honest fix — if
it ever matters — is **Cloudflare Durable Objects**, which provide the
atomic guarantees KV deliberately trades away. That's an upgrade to note,
not something to build now. **This is also one of the questions worth
putting to Razorpay directly — see `QUESTIONS-FOR-RAZORPAY.md`.**

### Worker crashes mid-request

Covered by the claim design and tested: the claim survives the crash, the
retry refuses to auto-book, and a human is asked to verify against the
Courier Karo dashboard. See "Duplicate-shipment race" above.
