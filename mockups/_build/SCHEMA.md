# Page content schema (one JSON file per page: `mockups/data/NN.json`, NN = 2-digit Sr. No., e.g. `05.json`, `98.json`)

All keys are optional except `no`, `path`, `type`, `template`, `meta_title`, `meta_description`, `h1`, `definition`.
The renderer skips any section whose key is missing or empty, so leave out sections that don't suit a page
(e.g. a FAQ page has no `comparison`, a gallery page has no `steps`).

```jsonc
{
  "no": 5,
  "path": "software/permit-to-work-software",       // exactly as in pages.csv
  "type": "Software",                               // Software | E-learning | Animation | Training | Consulting | Manpower | Industry
  "template": "product",                            // product | hub | service | industry | faq | gallery | case-studies | about
  "meta_title": "Permit to Work Software | Digital PTW System | TECH EHS",   // <= 60 chars
  "meta_description": "…",                          // 140-160 chars
  "nav_label": "Permit to Work",                    // short name used in breadcrumb, related cards, index
  "eyebrow": "Permit to Work Software",             // small label above H1
  "h1": "…",                                        // benefit-led, <= 70 chars
  "definition": "…",                                // ONE answer-first sentence, 30-50 words: "TECH EHS Permit to Work software is a … that …"
  "hero_sub": "…",                                  // 1-2 sentences supporting the H1
  "hero_bullets": ["…","…","…"],                    // 3 short proof bullets (<= 8 words each)
  "primary_cta": "Book a Demo",                     // pick fitting CTA for page type (e.g. "Get a Quote", "Request Sample Video", "Talk to a Consultant")
  "secondary_cta": "Watch 2-min Overview",
  "hero_visual": {                                  // drives the CSS-drawn product mock in the hero
    "kind": "dashboard",                            // dashboard | mobile | video | course | report | map
    "title": "Active Permits",                      // header text inside the mock
    "kpis": [{"label":"Open","value":"24"},{"label":"Pending approval","value":"6"},{"label":"Closed today","value":"18"}],
    "rows": [                                       // 3-4 list rows shown in the mock
      {"title":"Hot Work – Tank 4B","status":"Approved"},  // status one of: Approved | Pending | Overdue | Closed | Live | Draft
      {"title":"Confined Space – Pit 2","status":"Pending"}
    ]
  },
  "stats": [{"value":"17+","label":"Years in EHS"}, …],   // exactly 4
  "problem": {                                      // "Why … matters" / pain points
    "title": "…",
    "intro": "…",
    "points": [{"title":"…","text":"…"}, …]         // 3
  },
  "features_title": "…",
  "features_intro": "…",
  "features": [{"icon":"lock","title":"…","text":"…"}, …],   // 6 (icon names: see list below)
  "steps_title": "How it works",
  "steps": [{"title":"…","text":"…"}, …],           // 4 (a real sequence)
  "outcomes_title": "…",
  "outcomes": [{"metric":"40%*","label":"…","text":"…"}, …], // 3
  "standards_title": "Built around the standards you're audited against",
  "standards": ["ISO 45001:2018","OSHA 29 CFR 1910.146", …],  // 4-8 real, relevant standards/regulations
  "comparison": {
    "title": "…",
    "cols": ["Paper / spreadsheets","TECH EHS Permit to Work"],
    "rows": [["Approval time","Hours of chasing signatures","Mobile approvals in minutes"], …]  // 5-6 rows
  },
  "sections": [                                     // OPTIONAL extra blocks, rendered after features, in order
    {
      "kind": "cards",                              // cards | gallery | case_studies | catalog | timeline | text | logos
      "id": "modules",                              // anchor id
      "title": "…",
      "intro": "…",
      "items": [                                    // shape depends on kind:
        // cards:        {"icon","title","text","link"}   (link = a path from pages.csv, optional)
        // gallery:      {"title","tag","meta"}           (tag = category, meta = e.g. "2:30 min" or "Site go-live, 2025")
        // case_studies: {"title","tag","text","metric","metric_label","link"}
        // catalog:      {"title","tag","meta","text"}    (courses/videos: tag = category, meta = "45 min · SCORM")
        // timeline:     {"title","meta","text"}          (meta = year/phase)
        // text:         {"title","text"}                 (prose blocks)
        // logos:        {"title"}                        (names only)
      ]
    }
  ],
  "testimonial": {"quote":"…","name":"[Client name]","role":"HSE Head","company":"[Client company], Oil & Gas"},
  "related": ["software/incident-management-software", …],     // 3-4 paths from pages.csv
  "faqs": [{"q":"…","a":"…"}, …],                   // 5-6 (FAQ template pages: 12-16, optionally with "group")
  "cta": {"title":"…","text":"…","button":"…"}
}
```

## Icon names (use only these)
shield, clipboard, alert, users, chart, mobile, bell, lock, file, check, cog, leaf, hardhat, eye, calendar,
book, play, globe, layers, search, flame, truck, zap, award, map, message, tool, building, factory, clock

## Content rules
- Audience: global (US, UK, EU, Middle East, India, APAC) EHS / HSE managers, plant heads, ops directors, L&D heads.
  Write US English, plain and specific. No fluff ("empower", "revolutionize", "seamless", "cutting-edge", "robust").
- `definition` must answer "What is X?" in one quotable sentence that names TECH EHS. This is the most important line.
- Verified company facts you MAY state plainly: TECH EHS Solution; 17+ years in EHS; 30+ software modules;
  ISO 9001:2015, ISO 14001:2015, ISO 45001:2018 certified; offices in India and the USA; cloud, on-premise and mobile
  (Android/iOS) deployment; offline mobile capture; Power BI integration; Azure AD SSO; serves oil & gas, chemical, pharma,
  construction, mining, cement, power, data centers, manufacturing. Known clients (logo-bar only, no invented quotes):
  Gulf Keystone, Gujarat Fluorochemicals, ACG, Rubis, JK Cement, NatSteel, Sembcorp, Jindal Steel.
- ANY other number (outcome %, hours saved, user counts, course counts, video counts) is a placeholder: append `*`
  (e.g. "60%*", "250+*"). The page shows a footnote that `*` figures must be replaced with verified data.
- Testimonials: never invent a person. Use name "[Client name]", a realistic role, company "[Client company], <Industry>".
- Standards must be real and relevant (ISO 45001, ISO 14001, ISO 9001, ISO 19011, OSHA 29 CFR sections, UK HSE HSG250,
  IOGP 459, NFPA 70E, EU REACH/CLP, GHS Rev.10, ANSI Z490.1, GRI, BRSR, CSRD/ESRS, IFC PS, IEC 61882 (HAZOP), CCPS, OSHA PSM 1910.119, etc.).
- Every page should be distinct: features, FAQs and comparisons specific to that topic, not boilerplate.
- `related` must be real paths from pages.csv.
- Template choice guidance: product (software module pages), hub (software / hse-elearning / animated-safety-videos /
  ehs-safety-software / ehs-training landing), service (animation sub-services, training, consulting, manpower, custom courses),
  industry (industries/*), faq (*-faqs), gallery (photo/video gallery), case-studies (*case-stud*), about (about-animation).
- Duplicate-intent pages (e.g. permit-to-work-software / permit-to-work-system / electronic-permit-to-work-software;
  lockout-tagout-software / loto-procedure-software; the three online-induction pages; safety-observation /
  safety-observation-reporting-mobile-app; equipment-inspections / safety-equipment-inspections) must each take a
  different angle (buyer intent: e.g. "system" = process & workflow, "electronic" = paper-to-digital migration,
  "mobile app" = field/offline use) so they don't cannibalize each other. Say which angle in the `eyebrow`/`h1`.
- Valid JSON only (no comments, no trailing commas). UTF-8. Use straight quotes inside strings escaped properly.
