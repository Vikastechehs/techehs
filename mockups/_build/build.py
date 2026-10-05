#!/usr/bin/env python3
"""Render TECH EHS page mockups from mockups/data/NN.json into mockups/pages/*.html + mockups/index.html.

Usage: python3 build.py            # build every page that has a data file
       python3 build.py 1 5 60     # build only these Sr. Nos (index is always rebuilt)
"""
import csv, json, os, sys, datetime
from html import escape as _e

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "pages")
SITE = "https://techehs.com/"
TODAY = datetime.date.today()

PAGES = {int(r["no"]): r for r in csv.DictReader(open(os.path.join(ROOT, "_build", "pages.csv")))}
BY_PATH = {r["path"]: int(n) for n, r in PAGES.items()}


def e(s):
    return _e(str(s if s is not None else ""), quote=True)


def fname(path):
    return path.replace("/", "__") + ".html"


def load(n):
    f = os.path.join(DATA, f"{n:02d}.json")
    return json.load(open(f, encoding="utf-8")) if os.path.exists(f) else None


def label_for(path):
    d = load(BY_PATH[path]) if path in BY_PATH else None
    if d and d.get("nav_label"):
        return d["nav_label"]
    slug = path.split("/")[-1]
    return slug.replace("-2", "").replace("-", " ").title()


# ---------- icons (24px stroke icons, drawn for this project) ----------
P = {
    "shield": '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    "clipboard": '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
    "alert": '<path d="M12 3l9.5 17h-19L12 3z"/><path d="M12 10v4M12 17.5v.5"/>',
    "users": '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.8.3 5 2.6 5 5.8"/>',
    "chart": '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    "mobile": '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
    "bell": '<path d="M6 16V11a6 6 0 1112 0v5l1.5 2h-15L6 16z"/><path d="M10 20.5a2 2 0 004 0"/>',
    "lock": '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 118 0v3M12 14.5v2.5"/>',
    "file": '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    "check": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/>',
    "cog": '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    "leaf": '<path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15z"/><path d="M5 19l7-7"/>',
    "hardhat": '<path d="M3 17h18M5 17v-3a7 7 0 0114 0v3"/><path d="M10 7.5V5h4v2.5"/><path d="M3 17v2h18v-2"/>',
    "eye": '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    "calendar": '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    "book": '<path d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z"/><path d="M4 20.5A2.5 2.5 0 016.5 18H20v3H6.5"/>',
    "play": '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5.5 3.5-5.5 3.5z"/>',
    "globe": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.8 3.8 5.8 3.8 9s-1.3 6.2-3.8 9c-2.5-2.8-3.8-5.8-3.8-9S9.5 5.8 12 3z"/>',
    "layers": '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    "search": '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    "flame": '<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.7-5.6 3.8-8.8.9 1.4 1.4 2.7 1.5 4 1.6-1.3 2.9-3.5 3-6 2.8 2.4 4.7 6.1 4.7 10.2 0 4-2.6 6.8-6.5 6.8z"/>',
    "truck": '<path d="M2.5 6h11v10h-11zM13.5 9.5h4l3 3.5V16h-7"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    "zap": '<path d="M13 2.5L4.5 13.5H12l-1 8 8.5-11H12l1-8z"/>',
    "award": '<circle cx="12" cy="9" r="5.5"/><path d="M8.5 13.5L7 21l5-2.5 5 2.5-1.5-7.5"/>',
    "map": '<path d="M9 4L3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4z"/><path d="M9 4v14M15 6v14"/>',
    "message": '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
    "tool": '<path d="M14.5 6.5a4 4 0 00-5.3 5.1L3.5 17.3 6.7 20.5l5.7-5.7a4 4 0 005.1-5.3L15 12l-3-3 2.5-2.5z"/>',
    "building": '<path d="M4 21V4h10v17M14 9h6v12M2.5 21h19"/><path d="M7.5 8h3M7.5 12h3M7.5 16h3"/>',
    "factory": '<path d="M3 21V10l5 3V10l5 3V6h3l1 15"/><path d="M2 21h20M17 6h3v15"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
}


def icon(name, cls=""):
    body = P.get(name, P["check"])
    return f'<svg class="{cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{body}</svg>'


CHECK = icon("check")
CLIENTS = ["Gulf Keystone", "Gujarat Fluorochemicals", "ACG", "Rubis", "JK Cement", "NatSteel", "Sembcorp", "Jindal Steel"]
TYPE_HUB = {
    "Software": ("EHS Software", "software"),
    "E-learning": ("HSE E-learning", "hse-elearning"),
    "Animation": ("Safety Animation", "animated-safety-videos"),
    "Training": ("EHS Training", "ehs-training"),
    "Consulting": ("Consulting", None),
    "Manpower": ("EHS Manpower", None),
    "Industry": ("Industries", None),
}


def link(path):
    return fname(path) if path in BY_PATH else "#"


# ---------- shared chrome ----------
def header():
    def col(title, paths):
        return f'<div><h4>{e(title)}</h4>' + "".join(f'<a href="{link(p)}">{e(label_for(p))}</a>' for p in paths) + "</div>"
    sw = col("Platform", ["software", "software/ehs-safety-software", "software/hse-mobile-app", "software/safety-dashboard", "software/custom-software"]) + \
         col("Safety operations", ["software/incident-management-software", "software/permit-to-work-software", "software/contractor-management-software", "software/audit-management-software", "software/capa-software"]) + \
         col("Health, quality & ESG", ["software/occupational-health-and-safety-software", "software/training-management-software", "software/msds-software", "software/esg-management", "software/non-conformance-management"])
    learn = col("E-learning", ["hse-elearning", "hse-elearning/elearning-courses", "hse-elearning/custom-courses"]) + \
            col("Animation", ["animated-safety-videos", "animated-safety-videos/incident-near-miss-recreation", "animated-safety-videos/standard-operating-procedure", "animated-safety-videos/induction-employee-contractor-visitor"]) + \
            col("Proof", ["animated-safety-videos/video-gallery", "animated-safety-videos/animation-case-studies", "hse-elearning/elearning-case-study"])
    svc = col("Training", ["ehs-training", "behaviour-based-safety-training-programs", "hira-jsa", "5-day-training-workshop-on-jsa-hira-and-irai"]) + \
          col("Consulting", ["ehs-audit", "hazop-study-gap-analysis", "ehs-documentation-development-review-revision"]) + \
          col("People", ["ehs-manpower", "scaffolding-solutions", "audits-safety-excellence-program-2"])
    ind = col("Energy", ["industries/oil-and-gas", "industries/power-utilities", "industries/renewable-energy"]) + \
          col("Process & heavy", ["industries/chemical", "industries/pharmaceutical", "industries/cement", "industries/metal-mining-operations"]) + \
          col("Build & operate", ["industries/construction", "industries/data-centers", "industries/manufacturing", "industries/telecommunications", "industries/ports-and-logistics"])
    return f'''<header class="site-header" id="top">
  <div class="wrap">
    <a class="logo" href="../index.html" aria-label="TECH EHS home"><span class="logo-mark">{icon("shield")}</span><span>TECH EHS<small>SOLUTION</small></span></a>
    <nav class="nav" aria-label="Main">
      <div><button type="button" aria-haspopup="true">Software</button><div class="mega">{sw}</div></div>
      <div><button type="button" aria-haspopup="true">Learning</button><div class="mega">{learn}</div></div>
      <div><button type="button" aria-haspopup="true">Services</button><div class="mega">{svc}</div></div>
      <div><button type="button" aria-haspopup="true">Industries</button><div class="mega">{ind}</div></div>
      <a href="{link("software/software-case-studies")}">Case studies</a>
    </nav>
    <button class="menu-toggle" type="button" aria-expanded="false">Menu</button>
    <div class="head-actions"><a class="btn btn-ghost" href="#">Log in</a><a class="btn btn-primary" href="#demo">Book a Demo</a></div>
  </div>
</header>'''


def footer(d):
    def col(title, paths):
        return f'<div><h4>{e(title)}</h4><ul>' + "".join(f'<li><a href="{link(p)}">{e(label_for(p))}</a></li>' for p in paths) + "</ul></div>"
    return f'''<footer class="site-footer">
  <div class="wrap foot-grid">
    <div class="about"><a class="logo" href="../index.html"><span class="logo-mark">{icon("shield")}</span><span>TECH EHS<small>SOLUTION</small></span></a>
      <p>EHS software, HSE e-learning, safety animation and consulting for high-risk industries. 17+ years in EHS. Offices in India and the USA.</p>
      <div class="certs"><span>ISO 9001:2015</span><span>ISO 14001:2015</span><span>ISO 45001:2018</span></div></div>
    {col("Software", ["software/ehs-safety-software", "software/incident-management-software", "software/permit-to-work-software", "software/audit-management-software", "software/hse-mobile-app"])}
    {col("Learning", ["hse-elearning", "hse-elearning/elearning-courses", "animated-safety-videos", "animated-safety-videos/video-gallery"])}
    {col("Services", ["ehs-training", "ehs-audit", "hazop-study-gap-analysis", "ehs-manpower"])}
    {col("Industries", ["industries/oil-and-gas", "industries/construction", "industries/chemical", "industries/data-centers"])}
  </div>
  <div class="wrap foot-bottom">
    <span>© {TODAY.year} TECH EHS Solution. All rights reserved.</span>
    <span>Last updated: {TODAY.strftime("%B %Y")}</span>
    <span class="footnote">* Placeholder figure. Replace with verified client data before publishing.</span>
  </div>
</footer>'''


def ribbon(d):
    n = d["no"]
    prev_n = max([k for k in PAGES if k < n and load(k)], default=None)
    next_n = min([k for k in PAGES if k > n and load(k)], default=None)
    nav = ""
    if prev_n: nav += f'<a href="{fname(PAGES[prev_n]["path"])}">← #{prev_n:02d}</a>'
    if next_n: nav += f'<a href="{fname(PAGES[next_n]["path"])}">#{next_n:02d} →</a>'
    return f'''<div class="ribbon"><div class="wrap"><span>MOCKUP · Page {n:02d}/{len(PAGES)} · {e(d["type"])} · template: {e(d["template"])}</span>
<span>Live URL: {e(SITE + d["path"])}</span><span class="sp"></span>{nav}<a href="../index.html">All pages</a></div></div>'''


# ---------- hero visual ----------
def hero_visual(v):
    if not v:
        return ""
    kind = v.get("kind", "dashboard")
    kpis = "".join(f'<div class="mock-kpi"><b>{e(k["value"])}</b><span>{e(k["label"])}</span></div>' for k in v.get("kpis", [])[:3])
    rows = "".join(f'<div class="mock-row"><span>{e(r["title"])}</span><i class="pill pill-{e(str(r.get("status","Live")).lower())}">{e(r.get("status",""))}</i></div>' for r in v.get("rows", [])[:4])
    title = e(v.get("title", ""))
    if kind == "mobile":
        return f'''<div class="mock-phone" aria-hidden="true"><div class="mock"><div class="mock-bar"><span>9:41 · TECH EHS</span></div>
<div class="mock-body"><div class="mock-title">{title}<em>OFFLINE OK</em></div><div class="mock-kpis">{kpis}</div><div class="mock-rows">{rows}</div><div class="mock-cta">+ Report now</div></div></div></div>'''
    bar = f'<div class="mock-bar"><i></i><i></i><i></i><span>app.techehs.com</span></div>'
    if kind == "video":
        return f'''<div class="mock" aria-hidden="true">{bar}<div class="mock-body"><div class="mock-video"><div class="scene"></div><div class="figure"></div><div class="play"></div><div class="cc">EN · HI · AR · ES subtitles</div></div>
<div class="mock-progress"><i></i></div><div class="mock-title">{title}<em>4K · 3D</em></div><div class="mock-rows">{rows}</div></div></div>'''
    if kind == "course":
        return f'''<div class="mock" aria-hidden="true">{bar}<div class="mock-body"><div class="mock-title">{title}<em>SCORM</em></div><div class="mock-video"><div class="scene"></div><div class="figure"></div><div class="play"></div></div>
<div class="mock-progress"><i></i></div><div class="mock-kpis">{kpis}</div><div class="mock-rows">{rows}</div></div></div>'''
    if kind == "map":
        pins = '<b style="left:18%;top:40%"></b><b class="a" style="left:34%;top:62%"></b><b style="left:52%;top:30%"></b><b class="r" style="left:63%;top:55%"></b><b style="left:80%;top:45%"></b>'
        return f'''<div class="mock" aria-hidden="true">{bar}<div class="mock-body"><div class="mock-title">{title}<em>LIVE</em></div><div class="mock-map">{pins}</div><div class="mock-kpis">{kpis}</div><div class="mock-rows">{rows}</div></div></div>'''
    if kind == "report":
        k0 = v.get("kpis", [{}])[0] if v.get("kpis") else {"value": "", "label": ""}
        return f'''<div class="mock" aria-hidden="true">{bar}<div class="mock-body"><div class="mock-title">{title}<em>REPORT</em></div>
<div class="mock-score"><div class="mock-ring"><span>{e(k0.get("value",""))}</span></div><div><b>{e(k0.get("label",""))}</b><br><span style="color:#5a6b7c;font-size:.8rem">Benchmarked against ISO 45001 clauses 4–10</span></div></div><div class="mock-rows">{rows}</div></div></div>'''
    bars = "".join(f'<i style="height:{h}%"></i>' for h in (45, 62, 38, 70, 55, 82, 48, 66, 74, 58, 90, 64))
    return f'''<div class="mock" aria-hidden="true">{bar}<div class="mock-body"><div class="mock-title">{title}<em>LIVE</em></div><div class="mock-kpis">{kpis}</div><div class="mock-chart">{bars}</div><div class="mock-rows">{rows}</div></div></div>'''


# ---------- sections ----------
def opt(tag, val, cls=""):
    if not val:
        return ""
    c = f' class="{cls}"' if cls else ""
    return f"<{tag}{c}>{e(val)}</{tag}>"


def sec_head(label, title, intro=""):
    lab = f'<span class="label">{e(label)}</span>' if label else ""
    return f'<div class="sec-head">{lab}<h2>{e(title)}</h2>{opt("p", intro)}</div>'


def breadcrumb(d):
    hub = TYPE_HUB.get(d["type"])
    items = [("Home", "../index.html")]
    if hub and hub[1] and hub[1] != d["path"]:
        items.append((hub[0], link(hub[1])))
    elif hub and not hub[1]:
        items.append((hub[0], "#"))
    out = ' <span aria-hidden="true">/</span> '.join(f'<a href="{h}">{e(t)}</a>' for t, h in items)
    return f'<nav class="crumbs" aria-label="Breadcrumb">{out} <span aria-hidden="true">/</span> <span>{e(d.get("nav_label") or d["h1"])}</span></nav>'


def hero(d):
    bullets = "".join(f"<li>{CHECK}{e(b)}</li>" for b in d.get("hero_bullets", []))
    sec = d.get("secondary_cta")
    trust = "ISO 9001 · ISO 14001 · ISO 45001 CERTIFIED · 17+ YEARS IN EHS"
    vis = hero_visual(d.get("hero_visual"))
    grid_style = "" if vis else ' style="grid-template-columns:minmax(0,1fr)"'
    return f'''<section class="hero"><div class="wrap">{breadcrumb(d)}
<div class="hero-grid"{grid_style}><div>
  <span class="label">{e(d.get("eyebrow", d["type"]))}</span>
  <h1>{e(d["h1"])}</h1>
  <p class="answer"><b>In short</b>{e(d["definition"])}</p>
  {f'<p class="hero-sub">{e(d["hero_sub"])}</p>' if d.get("hero_sub") else ""}
  {f'<ul class="hero-bullets">{bullets}</ul>' if bullets else ""}
  <div class="hero-ctas"><a class="btn btn-primary" href="#demo">{e(d.get("primary_cta", "Book a Demo"))}</a>{f'<a class="btn btn-light" href="#overview">{icon("play")}{e(sec)}</a>' if sec else ""}</div>
  <p class="hero-trust">{trust}</p>
</div>{f"<div>{vis}</div>" if vis else ""}</div></div></section>'''


def logos():
    return '<section class="logos" aria-label="Clients"><div class="wrap"><p>Trusted by EHS teams at</p><ul>' + "".join(f"<li>{e(c)}</li>" for c in CLIENTS) + "</ul></div></section>"


def stats(d):
    s = d.get("stats")
    if not s:
        return ""
    return '<div class="wrap stats-wrap"><div class="stats">' + "".join(f'<div class="stat"><b>{e(x["value"])}</b><span>{e(x["label"])}</span></div>' for x in s[:4]) + "</div></div>"


def problem(d):
    p = d.get("problem")
    if not p:
        return ""
    pts = "".join(f'<div><h3>{e(x["title"])}</h3><p>{e(x["text"])}</p></div>' for x in p.get("points", []))
    return f'''<section class="section" id="overview"><div class="wrap problem-grid"><div class="sec-head" style="margin:0"><span class="label">The challenge</span><h2>{e(p["title"])}</h2>{opt("p", p.get("intro"))}</div>
<div class="pain">{pts}</div></div></section>'''


def features(d):
    f = d.get("features")
    if not f:
        return ""
    items = "".join(f'<div class="feature"><span class="ico">{icon(x.get("icon","check"))}</span><h3>{e(x["title"])}</h3><p>{e(x["text"])}</p></div>' for x in f)
    return f'<section class="section alt" id="features"><div class="wrap">{sec_head("Capabilities", d.get("features_title","Key features"), d.get("features_intro",""))}<div class="features">{items}</div></div></section>'


def extra_section(s, alt):
    kind = s.get("kind", "cards")
    items = s.get("items", [])
    body = ""
    if kind == "cards":
        out = []
        for it in items:
            tag = "a" if it.get("link") else "div"
            href = f' href="{link(it["link"])}"' if it.get("link") else ""
            ic = f'<span class="ico">{icon(it["icon"])}</span>' if it.get("icon") else ""
            more = '<span class="more">Learn more →</span>' if it.get("link") else ""
            out.append(f'<{tag} class="card"{href}>{ic}<h3>{e(it.get("title"))}</h3>{opt("p", it.get("text"))}{more}</{tag}>')
        body = f'<div class="cards">{"".join(out)}</div>'
    elif kind in ("gallery", "catalog"):
        out = []
        for it in items:
            playable = kind == "catalog" or "video" in (s.get("title", "") + it.get("tag", "")).lower() or ":" in it.get("meta", "")
            dur = it.get("meta", "").split("·")[0].strip() if ":" in it.get("meta", "") else ""
            out.append(f'<div class="card"><div class="thumb{" play" if playable else ""}">{opt("span", dur)}</div>'
                       f'{opt("span", it.get("tag"), "tag")}<h3>{e(it.get("title"))}</h3>'
                       f'{opt("p", it.get("text"))}{opt("span", it.get("meta"), "meta")}</div>')
        body = f'<div class="cards">{"".join(out)}</div>'
    elif kind == "case_studies":
        out = []
        for it in items:
            tag = "a" if it.get("link") else "div"
            href = f' href="{link(it["link"])}"' if it.get("link") else ""
            m = f'<div class="cs-metric"><b>{e(it["metric"])}</b><span>{e(it.get("metric_label",""))}</span></div>' if it.get("metric") else ""
            out.append(f'<{tag} class="card"{href}>{opt("span", it.get("tag"), "tag")}<h3>{e(it.get("title"))}</h3><p>{e(it.get("text",""))}</p>{m}</{tag}>')
        body = f'<div class="cards">{"".join(out)}</div>'
    elif kind == "timeline":
        body = '<div class="timeline">' + "".join(f'<div><span class="meta">{e(it.get("meta",""))}</span><h3>{e(it.get("title"))}</h3><p>{e(it.get("text",""))}</p></div>' for it in items) + "</div>"
    elif kind == "text":
        body = '<div class="prose">' + "".join(f'<div><h3>{e(it.get("title"))}</h3><p>{e(it.get("text",""))}</p></div>' for it in items) + "</div>"
    elif kind == "logos":
        body = '<ul class="logo-grid">' + "".join(f"<li>{e(it.get('title'))}</li>" for it in items) + "</ul>"
    sid = f' id="{e(s["id"])}"' if s.get("id") else ""
    return f'<section class="section{" alt" if alt else ""}"{sid}><div class="wrap">{sec_head(s.get("label",""), s.get("title",""), s.get("intro",""))}{body}</div></section>'


def steps(d):
    s = d.get("steps")
    if not s:
        return ""
    items = "".join(f'<div class="step"><h3>{e(x["title"])}</h3><p>{e(x["text"])}</p></div>' for x in s)
    return f'<section class="section"><div class="wrap">{sec_head("Process", d.get("steps_title","How it works"))}<div class="steps">{items}</div></div></section>'


def outcomes(d):
    o = d.get("outcomes")
    if not o:
        return ""
    items = "".join(f'<div class="outcome"><b>{e(x["metric"])}</b><h3>{e(x["label"])}</h3><p>{e(x.get("text",""))}</p></div>' for x in o)
    return f'<section class="section alt"><div class="wrap">{sec_head("Outcomes", d.get("outcomes_title","Results teams see"))}<div class="outcomes">{items}</div></div></section>'


def comparison(d):
    c = d.get("comparison")
    if not c:
        return ""
    cols = c.get("cols", ["Manual", "TECH EHS"])
    head = "<tr><th>Criteria</th>" + "".join(f"<th>{e(x)}</th>" for x in cols) + "</tr>"
    rows = "".join("<tr>" + "".join(f"<td>{e(cell)}</td>" for cell in r) + "</tr>" for r in c.get("rows", []))
    return f'<section class="section"><div class="wrap">{sec_head("Compare", c.get("title","Why switch"))}<div class="table-scroll"><table class="compare"><thead>{head}</thead><tbody>{rows}</tbody></table></div></div></section>'


DEPLOY = [("globe", "Cloud SaaS", "Hosted, ISO-certified"), ("building", "On-premise", "Your servers, your data"),
          ("mobile", "Android & iOS", "Offline field capture"), ("lock", "Azure AD SSO", "Single sign-on"),
          ("chart", "Power BI", "Enterprise analytics"), ("layers", "API & ERP", "SAP, HRMS, LMS links")]


def standards(d):
    st = d.get("standards")
    show_deploy = d["type"] == "Software" and d["template"] in ("product", "hub")
    if not st and not show_deploy:
        return ""
    left = f'<div>{sec_head("Compliance", d.get("standards_title","Aligned to the standards you are audited against"))}<ul class="chips">' + "".join(f"<li>{e(x)}</li>" for x in st) + "</ul></div>" if st else ""
    right = ""
    if show_deploy:
        right = f'<div>{sec_head("Deployment", "Deploy the way your IT team prefers")}<div class="deploy">' + "".join(f"<div>{icon(i)}<b>{t}</b><span>{s}</span></div>" for i, t, s in DEPLOY) + "</div></div>"
    inner = f'<div class="split">{left}{right}</div>' if left and right else (left or right)
    return f'<section class="section alt"><div class="wrap">{inner}</div></section>'


def testimonial(d):
    t = d.get("testimonial")
    if not t:
        return ""
    return f'''<section class="section"><div class="wrap"><figure class="quote" style="margin:0"><span class="qmark" aria-hidden="true">“</span><div><blockquote>{e(t["quote"])}</blockquote>
<figcaption><b>{e(t.get("name",""))}</b>, {e(t.get("role",""))} · {e(t.get("company",""))}</figcaption></div></figure></div></section>'''


def related(d):
    r = [p for p in d.get("related", []) if p in BY_PATH]
    if not r:
        return ""
    cards = ""
    for p in r:
        rd = load(BY_PATH[p])
        txt = (rd or {}).get("meta_description", "")
        cards += f'<a class="card" href="{link(p)}"><span class="tag">{e(PAGES[BY_PATH[p]]["type"])}</span><h3>{e(label_for(p))}</h3>{opt("p", txt)}<span class="more">Explore →</span></a>'
    return f'<section class="section alt"><div class="wrap">{sec_head("Related", "Works well with")}<div class="related">{cards}</div></div></section>'


def faqs(d):
    f = d.get("faqs")
    if not f:
        return ""
    out, last = [], None
    for x in f:
        g = x.get("group")
        if g and g != last:
            out.append(f'<div class="faq-group">{e(g)}</div>')
            last = g
        out.append(f'<details><summary>{e(x["q"])}</summary><p>{e(x["a"])}</p></details>')
    lead = "Straight answers to what buyers ask before choosing a solution." if d["template"] != "faq" else d.get("hero_sub", "")
    return f'''<section class="section" id="faq"><div class="wrap faq-grid"><div class="sec-head" style="margin:0"><span class="label">FAQ</span><h2>Frequently asked questions</h2><p>{e(lead)}</p></div>
<div class="faq">{"".join(out)}</div></div></section>'''


def cta(d):
    c = d.get("cta") or {"title": "See TECH EHS in action", "text": "Book a 30-minute walkthrough tailored to your sites and risks.", "button": "Book a Demo"}
    if d["type"] in ("Software",):
        points = ["30-minute walkthrough with an EHS specialist", "Configured to your forms and approval flow", "Free trial and pricing on request"]
    elif d["type"] in ("Animation", "E-learning"):
        points = ["Free sample reel for your industry", "Script and storyboard sign-off before production", "Fixed-price quote within 48 hours*"]
    else:
        points = ["Response from a certified EHS consultant", "Scope and proposal tailored to your site", "On-site or remote delivery worldwide"]
    pts = "".join(f"<li>{CHECK}{e(p)}</li>" for p in points)
    return f'''<section class="cta-band" id="demo"><div class="wrap cta-grid"><div><h2>{e(c["title"])}</h2><p>{e(c.get("text",""))}</p><ul class="cta-list">{pts}</ul></div>
<form class="form" data-demo><label>Full name<input id="f-name" name="name" required autocomplete="name" placeholder="Jane Doe"></label>
<label>Work email<input id="f-email" name="email" type="email" required autocomplete="email" placeholder="jane@company.com"></label>
<label>Company<input id="f-company" name="company" required autocomplete="organization"></label>
<label>Country<select id="f-country" name="country"><option>United States</option><option>United Kingdom</option><option>United Arab Emirates</option><option>Saudi Arabia</option><option>India</option><option>Singapore</option><option>Other</option></select></label>
<label class="full">What do you need help with?<input id="f-need" name="need" placeholder="e.g. {e(d.get("nav_label",""))} for 12 sites"></label>
<button class="btn btn-primary" type="submit">{e(c.get("button","Book a Demo"))}</button><small>We reply within one business day. No spam.</small></form></div></section>'''


# ---------- structured data ----------
def jsonld(d):
    url = SITE + d["path"]
    graph = [{"@type": "Organization", "@id": SITE + "#org", "name": "TECH EHS Solution", "url": SITE,
              "hasCredential": ["ISO 9001:2015", "ISO 14001:2015", "ISO 45001:2018"]},
             {"@type": "BreadcrumbList", "itemListElement": [
                 {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE},
                 {"@type": "ListItem", "position": 2, "name": d.get("nav_label") or d["h1"], "item": url}]},
             {"@type": "WebPage", "@id": url, "url": url, "name": d["meta_title"], "description": d["meta_description"],
              "dateModified": TODAY.isoformat(), "publisher": {"@id": SITE + "#org"}}]
    if d["type"] == "Software" and d["template"] in ("product", "hub"):
        graph.append({"@type": "SoftwareApplication", "name": "TECH EHS " + (d.get("nav_label") or ""), "applicationCategory": "BusinessApplication",
                      "operatingSystem": "Web, Android, iOS", "description": d["definition"], "provider": {"@id": SITE + "#org"}})
    elif d["template"] in ("service", "industry"):
        graph.append({"@type": "Service", "name": d.get("nav_label") or d["h1"], "description": d["definition"], "provider": {"@id": SITE + "#org"}, "areaServed": "Worldwide"})
    if d.get("faqs"):
        graph.append({"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q["q"], "acceptedAnswer": {"@type": "Answer", "text": q["a"]}} for q in d["faqs"]]})
    return '<script type="application/ld+json">' + json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False).replace("</", "<\\/") + "</script>"


FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=Sora:wght@600;650;700&family=Source+Sans+3:wght@400;600;650;700&display=swap">'


def render(d):
    sections = []
    alt = False
    body = [ribbon(d), header(), "<main>", hero(d)]
    if d["template"] not in ("faq",):
        body.append(logos())
        body.append(stats(d))
    body += [problem(d), features(d)]
    for i, s in enumerate(d.get("sections", [])):
        body.append(extra_section(s, alt=(i % 2 == 1)))
    body += [steps(d), outcomes(d), comparison(d), standards(d), testimonial(d), faqs(d), related(d), cta(d), "</main>", footer(d)]
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(d["meta_title"])}</title>
<meta name="description" content="{e(d["meta_description"])}">
<link rel="canonical" href="{e(SITE + d["path"])}">
<meta property="og:title" content="{e(d["meta_title"])}"><meta property="og:description" content="{e(d["meta_description"])}"><meta property="og:locale" content="en_US">
{FONTS}
<link rel="stylesheet" href="../assets/style.css">
{jsonld(d)}
</head>
<body>
{"".join(x for x in body if x)}
<script src="../assets/app.js"></script>
</body>
</html>
'''


# ---------- index ----------
def index():
    groups = {}
    for n, r in sorted(PAGES.items()):
        groups.setdefault(r["type"], []).append(n)
    built = sum(1 for n in PAGES if load(n))
    html = []
    for t, ns in groups.items():
        rows = ""
        for n in ns:
            r = PAGES[n]; d = load(n)
            if d:
                rows += f'<a class="idx-row" href="pages/{fname(r["path"])}" data-q="{e((r["path"]+" "+d.get("nav_label","")+" "+t).lower())}"><span class="n">{n:02d}</span><span><b>{e(d.get("nav_label") or d["h1"])}</b><small>/{e(r["path"])}</small></span><span class="st">Mockup ready</span></a>'
            else:
                rows += f'<div class="idx-row" data-q="{e((r["path"]+" "+t).lower())}"><span class="n">{n:02d}</span><span><b>{e(label_for(r["path"]))}</b><small>/{e(r["path"])}</small></span><span class="st todo">Queued</span></div>'
        html.append(f'<section class="idx-group" data-type="{e(t)}"><h2>{e(t)} <span>{len(ns)} pages</span></h2><div class="idx-list">{rows}</div></section>')
    types = "".join(f'<button type="button" data-filter="{e(t)}" aria-pressed="false">{e(t)}</button>' for t in groups)
    return f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>TECH EHS Page Mockups</title>{FONTS}<link rel="stylesheet" href="assets/style.css"></head>
<body><header class="idx-hero"><div class="wrap"><span class="label" style="color:#6fd8cc">techehs.com redesign</span><h1>TECH EHS page mockups</h1>
<p>{built} of {len(PAGES)} product and service pages mocked up on one shared design system. Each page follows the same global B2B pattern: answer-first hero, proof, capabilities, process, outcomes, comparison, standards, FAQ with schema, and a demo form.</p>
<div class="idx-tools"><input id="q" type="search" placeholder="Search pages, e.g. permit, oil, animation" aria-label="Search pages"><button type="button" data-filter="" aria-pressed="true">All</button>{types}</div></div></header>
<main class="wrap" style="padding-block:8px 64px">{"".join(html)}</main>
<script src="assets/app.js"></script></body></html>
'''


def main():
    os.makedirs(OUT, exist_ok=True)
    nums = [int(a) for a in sys.argv[1:]] or sorted(PAGES)
    count = 0
    for n in nums:
        d = load(n)
        if not d:
            continue
        open(os.path.join(OUT, fname(d["path"])), "w", encoding="utf-8").write(render(d))
        count += 1
    open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8").write(index())
    print(f"built {count} page(s) + index")


if __name__ == "__main__":
    main()
