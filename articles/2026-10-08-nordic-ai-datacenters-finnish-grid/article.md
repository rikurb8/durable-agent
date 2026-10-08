# The Nordic AI Data-Center Buildout and What It Means for Finland's Grid and Electricity Prices

**Prepared:** 8 October 2026

> **Methodology note.** Research used parallel web searches across several angles (new projects and
> MW loads, Fingrid/grid-connection queues, consumption and price forecasts, municipal/land-use
> decisions, and criticism/cancellations). URLs were deduplicated before classification.
> **The relevance classifier did NOT run:** `tools.classify_source` returned an error
> (`System One API error (402): Insufficient account funds`), so no relevance probabilities are
> available. Findings below were shortlisted by source type (primary sources prioritized) and each
> was read before inclusion. **Confirmed figures vs. projections are labeled explicitly**, and
> unverified claims are flagged.

---

## 1. Where Finland stands: confirmed consumption and connection data

- **Fingrid (transmission system operator), H1 2026 half-year report:** Finland's electricity
  consumption was **46.1 TWh in Jan–Jun 2026**, up **6.3%** year-on-year (43.4 TWh in H1 2025),
  driven especially by cold weather early in the year. Emission factor 32 gCO₂/kWh.
  ([Fingrid H1 2026 report](https://www.fingrid.fi/en/news/news/2026/fingrid-groups-half-year-report-1.1.30.6.2026))
- **Confirmed pipeline (signed connection agreements):** By end-June 2026, the planned total
  capacity of **data-centre projects that had signed grid connection agreements was "over three
  gigawatts."** By mid-August 2026 Fingrid reported this had grown to **"nearly 5 gigawatts"**
  (including projects connected to distribution networks). This is *contracted intent*, not built
  capacity — actual delivery depends on projects being completed.
  ([Fingrid H1 2026](https://www.fingrid.fi/en/news/news/2026/fingrid-groups-half-year-report-1.1.30.6.2026);
  [Fingrid, consumption growth](https://www.fingrid.fi/en/news/news/2026/electricity-consumption-is-set-to-increase-sharply--more-balancing-power-will-also-be-needed))
- **Scale of the queue:** Fingrid says if **all** projects with signed connection agreements were
  fully implemented, they would raise Finland's electricity consumption by **nearly 40%** versus
  2025 — a growth Fingrid estimates would take **at least five years** to achieve. Electric-boiler
  projects under construction/operating also exceeded 3 GW, and ~4 GW of grid energy storage had
  signed agreements.
  ([Fingrid, consumption growth](https://www.fingrid.fi/en/news/news/2026/electricity-consumption-is-set-to-increase-sharply--more-balancing-power-will-also-be-needed))
- **Current installed base (confirmed, historical):** Finnish data centres consumed **1.6 TWh in
  2024, ~2% of national consumption (82.7 TWh)**, with a total capacity of **285 MW**, per Nordea
  citing the Confederation of Finnish Industries' Green Transition Data Window.
  ([Nordea](https://corporate.nordea.com/article/101924/finland-data-centers-midas-touch-or-achilles-heel))

## 2. The project pipeline (announced capacities)

These are **announced/planned capacities**, not verified operating load. Where a figure is a
"pathway" rather than secured power, this is noted.

| Project / location | Announced capacity | Status | Source |
|---|---|---|---|
| Google, Muhos/Kajaani/Vaala + Hamina expansion | €13bn investment; buys **half of Loviisa nuclear plant output for 22 years** | Site work **halted** by regulator (see §4) | [TechTarget](https://www.techtarget.com/it-infrastructure/news/366651937/Finland-tells-Google-to-halt-site-work-on-13B-data-center-expansion) |
| Pure DC, Seinäjoki | **550 MW** campus (phase 1 = 110 MW); >€7.5bn; access to >700 MVA renewable power | Phase 1 fully leased (Microsoft reportedly a customer) | [Computer Weekly](https://www.computerweekly.com/news/366645729/Pure-DC-launches-75bn-Finland-AI-datacentre-campus) |
| Nebius, Lappeenranta | **310 MW** AI factory; Mäntsälä site expanded to 75 MW | Announced | [Nebius](https://nebius.com/newsroom/nebius-to-construct-310-mw-ai-factory-in-finland) |
| atNorth, Salo (FIN05) | **75 MW secured**, pathway to **230 MW**; ~€2bn | 75 MW secured; no construction timetable given | [Techerati](https://www.techerati.com/news-hub/atnorth-plans-e2bn-finland-data-centre-with-pathway-to-230mw/) |
| AmpTank/DataTank, Utajärvi | **200 MW** | Building permits granted, binding grid connection signed; construction from H2 2026 | [PR Newswire](https://www.prnewswire.com/da/pressemeddelelser/amptank-announces-200-mw-ai-data-center-project-in-utajarvi-finland-302797942.html) |
| Cerebras / Compute Nordic, Mikkeli | **165 MW** (scales 50→80→165 MW) | Seven-year contracted capacity agreement | [GlobeNewswire](https://www.globenewswire.com/news-release/2026/09/01/3353779/0/en/cerebras-and-compute-nordic-finland-announce-new-165-mw-ai-data-centre-in-mikkeli-finland.html) |
| Microsoft (near Helsinki) | **~650 MW** combined | Part of project pipeline | [Montel](https://montelnews.com/news/891265b9-5293-4a73-9afc-6d59cb43fbb6/finland-eyes-1-5-gw-from-data-centre-demand-by-2030-lobby) |

**Note on aggregation:** Individual announcements cannot simply be summed, because some overlap in
scope, some are "pathways" rather than secured power, and some may not proceed. Treat the table as a
list of announced intents, not a confirmed build total.

## 3. Demand and price forecasts (projections — not confirmed)

- **Confederation of Finnish Industries / Finnish Data Centre Association (FDCA), study by
  Ramboll (projection):** Finnish data-centre power demand could reach **1.5 GW by 2030**, up from
  285 MW today. Annual demand growth could exceed **50% until 2027**, levelling to 21% by 2030.
  This is a **lobby-commissioned scenario**, dependent on projects under planning being realised.
  ([Montel](https://montelnews.com/news/891265b9-5293-4a73-9afc-6d59cb43fbb6/finland-eyes-1-5-gw-from-data-centre-demand-by-2030-lobby))
- **AFRY study, commissioned by the Finnish government (projection):** In a **2,500 MW** data-centre
  scenario, average annual electricity prices could rise by **~10% by 2030**. AFRY projects that for
  ~100 hours/year data-centre demand would push prices above **50 cents/kWh**, and for ~30 hours/year
  prices could spike as high as **90 cents/kWh**. Note this scenario (~2,500 MW) is larger than the
  FDCA's 1.5 GW 2030 projection.
  ([Yle](https://yle.fi/a/74-20192344))
- **Nordea (projection):** Data centres will not significantly raise electricity prices in the short
  term but will **increase price volatility**. Nordea estimates that centres already with investment
  decisions, completing 2025–2027, total ~**1,400 MW**, implying ~**6 TWh/year** additional
  consumption at 50% utilization — roughly quadrupling data-centre consumption in a few years.
  ([Nordea](https://corporate.nordea.com/article/101924/finland-data-centers-midas-touch-or-achilles-heel))
- **Nordea/AFRY sensitivity:** A 1,200 MW increase would add ~20–30 hours/year above 20 cents/kWh; a
  2,400 MW increase would add ~150 such expensive hours and raise average prices ~10%. Large
  operators are reportedly willing to pay **10 cents/kWh — about double the current Finnish level**.
  ([Nordea](https://corporate.nordea.com/article/101924/finland-data-centers-midas-touch-or-achilles-heel))
- **Supply-side counterpoint (industry association, projection):** Suomen uusiutuvat (Finnish
  Renewables) says Finland has **>7.2 GW of permitted onshore wind and solar ready for construction**
  and **>64 GW in zoning/permitting**, enough to build **>15 TWh** of generation quickly. It estimates
  the 2030 data-centre demand corresponds to ~**2.2 GW** of wind capacity.
  ([Suomen uusiutuvat](https://suomenuusiutuvat.fi/en/there-is-already-a-solution-to-data-centre-electricity-demand/))

## 4. Grid-connection reform and regulatory constraints

- **First-come, first-served being scrapped (proposed):** A **draft amendment to Finland's
  Electricity Market Act** would replace first-come, first-served grid connections with four priority
  groups. Group 1 prioritizes small connectors (≤3 MW), critical infrastructure and small storage.
  Group 2 covers data centres >1 MW but ≤10 MW (unless they have flexibility/production commitments).
  Large data centres would effectively be **moved down the queue** unless they commit to flexibility
  or local production. **This is a proposal/draft, not yet confirmed law.**
  ([Data Center Dynamics](https://www.datacenterdynamics.com/en/news/finland-to-abandon-first-come-first-served-grid-connections-dropping-data-centers-down-the-queue/))
- **Grid congestion confirmed:** Fingrid states that although the transmission grid is being expanded
  at record pace, "additional connection capacity created by ongoing transmission grid investments
  has already been almost fully reserved in many areas," and region-specific waiting times are
  expected to continue.
  ([Fingrid, consumption growth](https://www.fingrid.fi/en/news/news/2026/electricity-consumption-is-set-to-increase-sharply--more-balancing-power-will-also-be-needed))
- **South vs. north:** Northern Finland has greater available renewable power, transmission capacity
  and land; the southern Uusimaa region faces **temporary grid constraints for large consumers**.
  ([Montel](https://montelnews.com/news/891265b9-5293-4a73-9afc-6d59cb43fbb6/finland-eyes-1-5-gw-from-data-centre-demand-by-2030-lobby))
- **Environmental permitting can block even grid-connected projects:** The Finnish Licensing and
  Supervisory Authority (LVV) ordered Google's subsidiary **Tuike Finland Oy to suspend site
  preparation** at its Muhos and Kajaani data-centre projects for doing land clearing before required
  environmental impact assessments were completed. Environmental impact assessments were expected in
  2026. Google says it followed forestry rules. **Note:** the claim that Google "failed to comply with
  the EIA Act" is attributed to an outside analyst (Paloniitty) cited by TechTarget — treat as
  contested, not an official finding.
  ([TechTarget](https://www.techtarget.com/it-infrastructure/news/366651937/Finland-tells-Google-to-halt-site-work-on-13B-data-center-expansion))

## 5. Tax, policy and municipal/land-use context

- **Tax category change (confirmed policy direction):** Data centres are moving to a **higher
  electricity tax category**, increasing the electricity price they pay by ~2 cents/kWh. Nordea
  estimates this raises electricity tax revenue from current data-centre consumption by ~**€47m/year**;
  a quadrupling of consumption would raise it to **>€200m/year**.
  ([Nordea](https://corporate.nordea.com/article/101924/finland-data-centers-midas-touch-or-achilles-heel))
- **Possible offsetting support (under review, not confirmed):** PM Petteri Orpo said the government
  is assessing whether to offset the tax increase via electricity-tax breaks or other support; the tax
  scheme for data centres is under review. Finance Minister Riikka Purra raised concerns in Parliament
  about price impacts. **No final support package is confirmed.**
  ([Yle](https://yle.fi/a/74-20192344); [Montel](https://montelnews.com/news/891265b9-5293-4a73-9afc-6d59cb43fbb6/finland-eyes-1-5-gw-from-data-centre-demand-by-2030-lobby))
- **Land use / municipal approvals:** AmpTank's 200 MW Utajärvi project received **legally valid
  building permits** and a binding grid connection agreement (municipal approval confirmed in the
  company's own announcement). Pure DC's Seinäjoki site is described as having **planning permission**
  and its first substation built and live.
  ([PR Newswire](https://www.prnewswire.com/da/pressemeddelelser/amptank-announces-200-mw-ai-data-center-project-in-utajarvi-finland-302797942.html);
  [Computer Weekly](https://www.computerweekly.com/news/366645729/Pure-DC-launches-75bn-Finland-AI-datacentre-campus))
- **National policy:** Finland's government has published a **National Roadmap for Data Centres**
  (rapporteur's report) and stated it aims to safeguard competitiveness in attracting data-centre
  investments.
  ([Valtioneuvosto roadmap](https://julkaisut.valtioneuvosto.fi/bitstreams/057514dd-ba36-4fa4-b000-fce8f83e5183/download);
  [Valtioneuvosto announcement](https://valtioneuvosto.fi/en/-/government-safeguards-finland-s-competitiveness-in-attracting-data-centre-investments))

## 6. Criticism, security concerns and cancellations

- **Security/political concern:** Economic Affairs Minister **Rydman** suggested a planned data centre
  could let **China bypass AI processor export curbs**, and that allowing it could risk Finland's
  relations with the US.
  ([Yle](https://yle.fi/a/74-20161766))
- **Fingrid CEO's position:** Fingrid CEO **Asta Sihvonen-Punkka** says individual data-centre
  projects do **not have a direct impact** on the general electricity price, but acknowledged price
  trends are hard to predict.
  ([Yle](https://yle.fi/a/74-20161766))
- **Cross-border price effects:** Analysts warn Google's Finnish investments could raise Estonian
  electricity prices by ~**0.5 cents/kWh** if no new generation is added, since Finland would have
  less cheap surplus to export. Estonia has imported ~40% of its electricity from Finland and other
  Nordics.
  ([ERR](https://news.err.ee/1610135347/major-data-center-developments-in-finland-could-hike-electricity-prices-in-estonia))
- **Google expansion paused (reported):** Yle's article referenced a report that "HS: Google puts
  plans for Finnish data centre expansion on i[ce]" — i.e., Helsingin Sanomat reported Google pausing
  its Finnish expansion. **Flagged: I could not retrieve the full HS article to verify the specifics;
  this should be confirmed directly in Helsingin Sanomat before being relied on.**
  ([Yle, partial reference](https://yle.fi/a/74-20192344))

## 7. Bottom line

- **Confirmed:** Finland's consumption is rising (H1 2026 +6.3%); data centres have signed grid
  connection agreements totaling ~3 GW (end-June) to ~5 GW (mid-August); the grid is already congested
  in many areas; Google's northern sites were ordered to suspend preparatory work over environmental
  permitting; data centres face a higher electricity tax category.
- **Projected (not confirmed):** 2030 data-centre demand of **1.5 GW** (FDCA/Ramboll) to **2.5 GW**
  (AFRY scenario); electricity price increases of up to **~10% by 2030** in the high-growth scenario;
  significantly increased price **volatility**.
- **Contested/unverified:** The exact Google EIA-compliance finding; the HS report that Google paused
  its Finnish expansion; and the final shape of any tax-support package.

---

## Sources (with classifier status)

**Classifier status:** `tools.classify_source` failed for all candidates with
`System One API error (402): Insufficient account funds`. **No relevance scores were produced.**
All sources below were manually shortlisted and read.

- Fingrid, "Electricity consumption is set to increase sharply – more balancing power will also be needed" — https://www.fingrid.fi/en/news/news/2026/electricity-consumption-is-set-to-increase-sharply--more-balancing-power-will-also-be-needed
- Fingrid, "Fingrid group's half-year report 1.1.–30.6.2026" — https://www.fingrid.fi/en/news/news/2026/fingrid-groups-half-year-report-1.1.30.6.2026
- Yle, "Study: Big growth in data centres could raise electricity prices by 10% by 2030" — https://yle.fi/a/74-20192344
- Yle, "Why are so many data centres popping up in Finland?" — https://yle.fi/a/74-20161766
- Nordea Corporate, "Finland: Data Centers – Midas Touch or Achilles' Heel" — https://corporate.nordea.com/article/101924/finland-data-centers-midas-touch-or-achilles-heel
- Montel News, "Finland eyes 1.5 GW from data centre demand by 2030 – lobby" — https://montelnews.com/news/891265b9-5293-4a73-9afc-6d59cb43fbb6/finland-eyes-1-5-gw-from-data-centre-demand-by-2030-lobby
- Data Center Dynamics, "Finland to abandon first-come, first-served grid connections..." — https://www.datacenterdynamics.com/en/news/finland-to-abandon-first-come-first-served-grid-connections-dropping-data-centers-down-the-queue/
- TechTarget, "Finland tells Google to halt site work on €13B data center expansion" — https://www.techtarget.com/it-infrastructure/news/366651937/Finland-tells-Google-to-halt-site-work-on-13B-data-center-expansion
- ERR News, "Major data center developments in Finland could hike electricity prices in Estonia" — https://news.err.ee/1610135347/major-data-center-developments-in-finland-could-hike-electricity-prices-in-estonia
- Suomen uusiutuvat, "There is already a solution to data centre electricity demand..." — https://suomenuusiutuvat.fi/en/there-is-already-a-solution-to-data-centre-electricity-demand/
- Computer Weekly, "Pure DC launches €7.5bn Finland AI datacentre campus" — https://www.computerweekly.com/news/366645729/Pure-DC-launches-75bn-Finland-AI-datacentre-campus
- Techerati, "atNorth plans €2bn Finland data centre with pathway to 230MW" — https://www.techerati.com/news-hub/atnorth-plans-e2bn-finland-data-centre-with-pathway-to-230mw/
- Nebius, "Nebius to construct 310 MW AI factory in Finland" — https://nebius.com/newsroom/nebius-to-construct-310-mw-ai-factory-in-finland
- PR Newswire, "AmpTank Announces 200 MW AI Data Center Project in Utajärvi, Finland" — https://www.prnewswire.com/da/pressemeddelelser/amptank-announces-200-mw-ai-data-center-project-in-utajarvi-finland-302797942.html
- GlobeNewswire, "Cerebras and Compute Nordic Finland Announce New 165 MW AI Data Centre in Mikkeli, Finland" — https://www.globenewswire.com/news-release/2026/09/01/3353779/0/en/cerebras-and-compute-nordic-finland-announce-new-165-mw-ai-data-centre-in-mikkeli-finland.html
- Finnish Government (Valtioneuvosto), "National Roadmap for Data Centres: Rapporteur's Report" — https://julkaisut.valtioneuvosto.fi/bitstreams/057514dd-ba36-4fa4-b000-fce8f83e5183/download
- Finnish Government (Valtioneuvosto), "Government safeguards Finland's competitiveness in attracting data centre investments" — https://valtioneuvosto.fi/en/-/government-safeguards-finland-s-competitiveness-in-attracting-data-centre-investments

### Not used (secondary/aggregator, or paywalled/unretrievable)
- Bloomberg, Arizton, Fair Edih, Tracxn company pages, Computer Weekly tax article, Daily Finland,
  Financial Times announcements page — these are secondary aggregators or paywalled, so not relied on
  for figures.
- Energiavirasto "National Report on the State of Electricity and Gas Markets in Finland" and
  Finnish Energy monthly statistics were identified as useful primary sources but **not fetched**;
  their specific figures are therefore not cited here.
