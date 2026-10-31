# Techehs API — website

Static marketing + developer site for a real-time B2B data API (profiles, companies, jobs, posts, people search, email finder).

## Pages
| File | Purpose |
|------|---------|
| `index.html` | Landing page: hero with live code sample, stats, products, features, how it works, use cases, integrations, testimonials, FAQ, CTA |
| `pricing.html` | Plans (monthly/yearly toggle), credit cost per endpoint, plan calculator, pricing FAQ |
| `docs.html` | API reference: auth, quickstart, response format, every endpoint, errors, rate limits, SDKs, changelog |
| `signup.html` / `login.html` | Account forms with validation |
| `dashboard.html` | API key (show/copy/rotate), credits, usage chart, request log, request playground |
| `contact.html` | Contact form (opens the user's email app to info@techehs.com) |
| `legal.html` | Terms, Privacy, Acceptable Use (templates — get legal review) |

Shared files: `assets/style.css`, `assets/main.js` (header, footer, menu, code tabs), `assets/auth.js`.

## Run locally
```bash
cd api-website && python3 -m http.server 8000
```
Then open http://localhost:8000.

## Important: demo-only auth
There is no backend. Sign-up stores a demo account and API key in the browser's `localStorage`, and dashboard numbers are generated demo data. Before launch, replace `assets/auth.js` and the dashboard data with calls to your real backend/billing.

Brand name, prices, endpoints and `api.techehs.com` are placeholders to adjust.
