# SoneRadar — live områdeoversikt

SoneRadar er en mobiltilpasset webapp som viser reelle hendelser og varsler rundt stedene brukeren selv legger til. Appen starter uten forhåndsutfylte steder og uten syntetiske hendelser. Soner lagres i nettleseren.

## Start

Krever Node.js 22 eller nyere. Kjør `npm start` i prosjektmappen eller åpne `Start-SoneRadar.cmd`. Gå til http://127.0.0.1:4173, legg til et faktisk sted og velg radius. Kildene hentes når stedet lagres og oppdateres automatisk hvert femte minutt. Serveren lytter bare lokalt som standard.

## Tilkoblede livekilder

Serveren henter kilder parallelt og mellomlagrer svar for å redusere kildebelastning. Adresseoppslag bruker Geonorge/Kartverket.

- **MET MetAlerts 2.0:** vær- og farevarsler uten skogbrannfarevarsler. Appen sammenligner varselpolygoner med den valgte radiusen og tegner overlappende polygoner i kartet.
- **NVE flomvarsling og jordskredvarsling:** aktive varsler for adressens kommune og neste tre prognosedager. Varslene er på kommunenivå og er ikke en adresse- eller radiusvurdering.
- **NVE snøskredvarsling:** kartlegger varslingsregioner som overlapper den valgte sirkelen og henter detaljerte prognoser for disse regionene.
- **Politiloggen:** aktive meldinger filtrert på kommunenavn. Politiloggen gir normalt ikke koordinater, så disse vises som kommunemeldinger og plasseres ikke på kartet.
- **OSIRIS:** åpen livefeed med satellittmålte varmepunkter filtrert etter radius. Dette er eneste kilde for kategorien «Skogbrann»; OSIRIS oppgir NASA FIRMS som underliggende datakilde. Et varmepunkt er ikke en bekreftet skogbrann.
## Geografisk presisjon

MET- og NVE-snøskredgeometri vurderes mot radiusen. NVE flom- og jordskredvarsler og Politiloggen er kommunedata; appen viser denne presisjonen tydelig og later ikke som om meldingene gjelder en bestemt gate. OSIRIS-satellittmålinger filtreres etter koordinat, men selve pikselen dekker et areal. Ingen datakilde kan garantere fullstendig risikodekning.

## Tester

`npm test` kjører de automatiske kontrollene for liveoppstart, sikker håndtering av registreringsfelt, avstand, cache, e-postbatcher, feilhåndtering og e-postbegrensning. Livekildene kan kontrolleres gjennom `/api/live` når appen åpnes eller oppdateres.

## E-postvern

Testmeldinger og hendelsesvarsler deler rullerende timegrenser. Standardverdiene er 60 e-poster totalt og 10 til samme mottaker per time. Når en grense nås, svarer serveren med HTTP 429 og `Retry-After`. Verdiene kan justeres med `MAIL_RATE_WINDOW_MS`, `MAIL_RATE_LIMIT_GLOBAL` og `MAIL_RATE_LIMIT_PER_RECIPIENT`. Telleverket ligger i serverminnet og nullstilles ved omstart; ved flere tjenesteinstanser må grensene flyttes til delt lagring.

## Render

Ved utrulling fra undermappen `SoneRadar` brukes `npm start` som startkommando. Sett `HOST=0.0.0.0` i Render, og legg SMTP-verdiene inn som hemmelige miljøvariabler der. Ikke last opp den lokale `.env`-filen.

## Personvern

Adresser og soner lagres i localStorage på enheten. Ved liveoppslag sendes senterkoordinater, radius og kommunenummer til den lokale SoneRadar-serveren, som kaller oppgitte kilder. Ingen autentiseringsnøkler går til nettleseren. Automatisk push/SMS-varsling er ikke aktivert.

## Offisiell dokumentasjon

- [MET MetAlerts 2.0](https://api.met.no/weatherapi/metalerts/2.0/documentation)
- [NVE flomvarsling](https://api.nve.no/doc/flomvarsling/)
- [NVE jordskredvarsling](https://api.nve.no/doc/jordskredvarsling/)
- [NVE snøskredvarsling](https://api.nve.no/doc/snoeskredvarsel/)
- [Politiloggen API](https://api.politiloggen.politiet.no/index.html)
- [OSIRIS API](https://osirisai.live/docs)
- [Geonorge kommuneinfo](https://ws.geonorge.no/kommuneinfo/)






