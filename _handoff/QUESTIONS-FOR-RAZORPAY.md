# Questions for Razorpay support

Ready to paste into an email or support ticket. Written so they reveal
nothing about your implementation — they're framed as a merchant asking
about webhook behaviour, which is exactly what you are. Each question
notes (for you, not for them) why the answer matters; delete those notes
before sending, or just send the questions.

---

## The email

> Subject: Webhook retry behaviour for payment.captured events
>
> Hi,
>
> We use webhooks (the `payment.captured` event) to trigger our
> order-fulfilment process, and I'd like to understand the delivery
> guarantees so we can handle edge cases correctly.
>
> 1. **If our webhook endpoint returns a 5xx error or times out, what is
>    your retry schedule?** How many attempts, at what intervals, and
>    over what total period before you stop retrying?
>
> 2. **After the final failed retry, is the event marked as failed
>    somewhere we can see?** Is there a dashboard view, report, or API we
>    can query for webhook deliveries that permanently failed, so we can
>    reconcile them manually?
>
> 3. **Can the same event ever be delivered more than once even when we
>    return 200?** And can two deliveries of the same event ever be
>    in-flight at the same time (e.g. a retry firing before the first
>    delivery has finished processing), or do you wait for a response
>    before retrying?
>
> 4. **If our endpoint is completely unreachable for an extended period
>    (hours), are the missed events queued and delivered when it comes
>    back**, or are they dropped after the retry window?
>
> 5. **Is there a way to be notified (email or otherwise) when webhook
>    deliveries to our endpoint start failing**, so an outage on our side
>    doesn't go unnoticed?
>
> 6. **Is there an API to list recent captured payments** so we can
>    periodically reconcile our fulfilment records against your records
>    as a safety net?
>
> Thanks!

---

## Why each answer matters (for you — don't send this part)

1. **Retry schedule** — several of our failure paths deliberately return
   5xx so Razorpay retries (e.g. when our alert email couldn't be sent).
   How much protection that actually buys depends entirely on how many
   retries there are and over how long. If it's "3 retries over 30
   minutes", a longer Resend outage still loses the alert; if it's "24
   hours", we're well covered.

2. **Failed-event visibility** — this is the backstop for the one gap
   code can't close (Worker fully down → no alert possible). If Razorpay
   exposes a "permanently failed webhooks" list, checking it weekly IS
   the reconciliation process, ready-made.

3. **Simultaneous duplicate deliveries** — our duplicate-shipment guard
   uses Cloudflare KV, which is eventually consistent (~60s global
   propagation). Two deliveries of the same event spaced seconds apart
   are handled; two truly simultaneous deliveries to different data
   centres are a theoretical race. If Razorpay confirms they wait for a
   response before retrying, that race is closed by their behaviour and
   we need do nothing. If not, it's a (still unlikely) case to weigh.

4. **Queue vs drop on long outage** — determines how urgent "the Worker
   is down" actually is. If events queue for 24h, a few hours of downtime
   self-heals. If they drop, downtime means manual reconciliation.

5. **Failure notifications from their side** — if Razorpay can email you
   when deliveries fail, that partially covers the "Worker down and can't
   alert" gap with zero code.

6. **Payments-list API** — if reconciliation ever gets automated (a
   scheduled job comparing payments against shipments), this is the API
   it would read.
