# UI Audit — design & bug checker voor VS Code

Scan je website of lokale dev-server op UI-fouten, dode knoppen/links en backend-errors. Je ziet alles per project in één dashboard en exporteert het naar Claude, Claude Code of een developer.

## Wat wordt er gecheckt?

| Categorie | Voorbeelden |
|---|---|
| **Layout & uitlijning** | Een element dat 1–8px naast de rest van zijn kolom staat, een knop die 3px lager staat dan de rest van de rij, overlappende elementen |
| **Spacing & consistentie** | Afwijkende gaps in lijsten en rijen, knoppen van dezelfde variant met andere padding/hoogte/radius, bijna-gelijke maten (42px vs 44px), spacing buiten je 4px-grid, bijna-gelijke kleuren (#333 vs #343434), koppen met afwijkende stijl |
| **Responsive / mobiel** | Horizontaal scrollen (met de veroorzaker erbij), ontbrekende viewport-meta, te kleine tikdoelen (WCAG 2.5.8), te kleine tekst, afgekapte tekst, fixed headers die het scherm bedekken |
| **Knoppen & links** | Knoppen zonder handler (werkt ook met React, Vue, Alpine, htmx), `href="#"` of leeg, ankers naar secties die niet bestaan, links met 404/500, formulieren zonder action |
| **Backend & console** | JavaScript-errors en exceptions, API-calls met 4xx/5xx, mislukte requests, trage endpoints, `undefined`, `NaN` of `[object Object]` in de UI |
| **Content & toegankelijkheid** | Kapotte, vervormde of te laag-resolutie afbeeldingen, ontbrekende alt-teksten, contrast (WCAG AA), inputs zonder label, dubbele ID's, lorem ipsum |

Elke pagina wordt gescand op **Desktop (1440px)**, **Tablet (768px)** en **Mobiel (390px, met touch en iPhone-user-agent)**. Komt dezelfde fout op meerdere formaten voor, dan zie je hem één keer, met badges per formaat.

## Gebruik

1. Klik op het **UI Audit**-icoon in de activity bar en kies **Nieuw project**. De extensie zoekt zelf naar draaiende dev-servers (poort 3000, 5173, 4321, 8080, 5500 …). Je kunt ook een URL of een lokaal HTML-bestand opgeven.
2. Het **dashboard** opent met:
   - tellingen per ernst en per categorie, en wat er sinds de vorige scan nieuw of opgelost is;
   - een lijst met issues, met selector, meting, voorgestelde fix, crop-screenshot en **het bronbestand + regelnummer** (klik om het te openen);
   - de volledige screenshot per viewport met genummerde markeringen. Klik op een markering om naar het issue te springen;
   - "Negeer (false positive)", zodat een issue niet meer meetelt.
3. **📱 Device preview**: bekijk de site direct op iPhone SE/15/Pro Max, Pixel, Galaxy, iPad of desktop, roteer hem of kies een eigen breedte. Inspect is niet nodig.
4. **Live**: zet Live aan, en dan wordt het project na elke save opnieuw gescand en de preview herladen.
5. Issues verschijnen ook in het **Problems-paneel**, op de regel in je broncode.

## Exporteren

Exporteer alle issues in beeld, of vink er een paar aan:

- **✦ Kopieer voor Claude**: kopieert een complete prompt met opdracht, selectors, bronbestanden, metingen en voorgestelde fixes. Plak hem in claude.ai.
- **⌘ Fix met Claude Code**: schrijft `.ui-audit/issues.md` en crop-screenshots in je project (staat in `.gitignore`) en start `claude` in de terminal met de opdracht om alles op te lossen.
- **✉ Mail developer**: opent je mailprogramma met een samenvatting en laat het HTML-rapport met screenshots zien, zodat je het als bijlage kunt meesturen.
- **Exporteer**: Markdown, HTML-rapport, CSV (Excel/Sheets/Jira) of JSON.

## Instellingen

| Instelling | Standaard | |
|---|---|---|
| `uiAudit.viewports` | Desktop/Tablet/Mobiel | Eigen schermformaten |
| `uiAudit.spacingBase` | `4` | Je spacing-grid in px |
| `uiAudit.clickTest` | `false` | Klikt écht op twijfelachtige knoppen om te zien of er iets gebeurt. Gebruik dit alleen op dev/test; knoppen als *verwijder/betaal/verstuur* worden overgeslagen |
| `uiAudit.checkLinks` / `checkExternalLinks` | `true` / `false` | Links controleren op 404/500 |
| `uiAudit.developerEmail` | – | Standaardontvanger voor de mail |
| `uiAudit.chromePath` | automatisch | Chrome/Edge/Brave/Chromium |
| `uiAudit.showInProblems` | `true` | Issues in het Problems-paneel |

## Vereisten

Je hebt Google Chrome, Edge, Brave of Chromium nodig. De extensie gebruikt je bestaande browser headless en downloadt zelf niets.
