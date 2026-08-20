JD PRESTIGE — STRIPE + POSTGRESQL VERSION

WHAT THIS VERSION ADDS
- Haircut price changed to $50.
- Haircut + Beard price changed to $55.
- Line Up remains $20.
- Customer chooses Dani or Joviel.
- Customer chooses either:
    1) Pay a 50% deposit
    2) Pay the full service amount
- Customer is redirected to Stripe Checkout for secure card payment.
- Owner dashboard shows:
    Service Total
    Amount Paid
    Amount Due
    Payment Status
- If a customer paid only the deposit, an owner can click:
    "Create Balance Payment Link"
  and send that Stripe link to the customer.
- Stripe webhook updates the amount paid automatically.
- PostgreSQL permanently stores appointments and payment totals.
- Separate Dani and Joviel owner accounts remain included.
- Dani and Joviel have separate availability.

DEFAULT PAYMENT AMOUNTS
Haircut:
  Total: $50.00
  50% Deposit: $25.00

Haircut + Beard:
  Total: $55.00
  50% Deposit: $27.50

Line Up:
  Total: $20.00
  50% Deposit: $10.00

To change the deposit percentage later, set:
  DEPOSIT_PERCENT=50

LOCAL VS CODE SETUP
1. Extract this ZIP.
2. Open the folder in VS Code.
3. Open Terminal.
4. Run:
   npm install
5. Run:
   npm start
6. Customer site:
   http://localhost:3000
7. Owner dashboard:
   http://localhost:3000/owner.html

IMPORTANT:
The site will run without Stripe locally, but checkout is intentionally disabled
until STRIPE_SECRET_KEY is configured.

OWNER TEST LOGINS
Dani
  Username: dani
  Password: DaniPrestige2026!

Joviel
  Username: joviel
  Password: JovielPrestige2026!

Change both passwords before publishing.

RAILWAY DATABASE SETUP
1. Upload the CONTENTS of this folder to the root of the GitHub repository.
2. Deploy the GitHub repo as a Railway service.
3. Add PostgreSQL to the SAME Railway project.
4. In the JD Prestige web service Variables, add DATABASE_URL using Railway's
   Postgres DATABASE_URL reference.
5. Redeploy.
6. Visit:
   /health
   It should report:
   "storage":"postgres"

STRIPE SETUP
You need a Stripe account.

In the JD Prestige Railway service, add:
  STRIPE_SECRET_KEY=your Stripe secret key
  STRIPE_WEBHOOK_SECRET=your Stripe webhook signing secret

Recommended:
  PUBLIC_BASE_URL=https://your-real-domain.com

Also add private owner passwords:
  DANI_PASSWORD=your-private-Dani-password
  JOVIEL_PASSWORD=your-private-Joviel-password

Optional:
  DANI_USERNAME=dani
  JOVIEL_USERNAME=joviel
  DEPOSIT_PERCENT=50

STRIPE WEBHOOK
After your Railway site has a public URL:

1. In Stripe, create a webhook/event destination for:
   https://YOUR-DOMAIN/api/stripe/webhook

2. Subscribe it to:
   checkout.session.completed
   checkout.session.async_payment_succeeded
   checkout.session.expired

3. Copy the webhook signing secret that starts with:
   whsec_

4. Add it to Railway as:
   STRIPE_WEBHOOK_SECRET=whsec_...

5. Redeploy the site.

WHY THE WEBHOOK MATTERS
The owner dashboard should never trust only the customer's browser redirect.
Stripe sends the webhook directly to the server after the payment succeeds.
The server records the payment and updates Paid / Due.

PAYMENT FLOW
1. Customer fills out booking.
2. Customer chooses Deposit or Pay in Full.
3. The time slot is temporarily held for 30 minutes.
4. Customer goes to Stripe Checkout.
5. Stripe confirms payment through the webhook.
6. Appointment changes from Awaiting Payment to Pending.
7. Owner sees exactly what was paid and what remains due.
8. If a balance remains, owner can create a balance payment link.
9. When that link is paid, the dashboard changes the balance due to $0.

SECURITY
- Never place STRIPE_SECRET_KEY in index.html, script.js, GitHub, or public files.
- Store Stripe secret keys only in Railway environment variables.
- Change the default owner passwords before going live.
- Use Stripe test keys first, then switch to live keys when ready.
