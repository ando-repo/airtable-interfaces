# Schedule Grid — Airtable Interface Extension

A custom Airtable Interface Extension that displays records as a schedule grid (timetable).
Built for the **Espace Saint-Denis** schedule board.

## Configuration

All fields are configured from the extension settings panel (nothing is hardcoded). Sensible
defaults are auto-detected by field name.

**Table Événements**

- **Libellé événement** — text shown in the "Événements" row (default `identifiant_court`).
- **Date événement** — date used to place the event in the right day column (default
  `Date de l'événement`).

- **Mode de diffusion** — optional (default `mode_diffusion`, a lookup from Projets). Combined with
  **Modes de diffusion à masquer** (comma-separated, default `Location`), it hides matching events
  *and* the shifts linked to them — the venue is merely rented out, so there is nothing to staff.
  Matching is case-insensitive. Leave the field unset to disable hiding entirely.

**Table Équipe accueil (quarts)**

- **Nom du contact** — host name (default `nom_contact`); empty → cell highlighted yellow.
- **Catégorie** — staff role grouping the rows (default `Rôles`: Placiers / Placiers seniors /
  Merch).
- **Date du quart** — day the shift belongs to (default `date_courte`).
- **Montage / Show call / Démontage — In/Out** — three optional work shifts, each an In + Out
  duration. The cell shows the smallest In to the largest Out across the filled shifts
  (e.g. `12:30 - 17:15`).

### Write features (all optional)

Left unconfigured, the extension stays strictly read-only and behaves exactly as before. Airtable
does **not** pre-fill a property that was added after the extension was first configured: each new
property must be pointed at its field once, by hand, in the settings panel.

- **Date du quart — champ inscriptible** — a real `Date` field, required to create shifts.
  `date_courte` is a *rollup* of the linked event's `date_courte_avec_heure`, so it cannot be
  written. Shifts are created for a day and dispatched to an event later, so they need a date of
  their own. The grid places a shift by its event when it has one, and by this field otherwise —
  existing shifts are therefore unaffected.
- **Lien Événement (sur les quarts)** — record link to Événements. Used to hide the shifts of a
  hidden event, and to dispatch a shift to an event when assigning it.
- **Lien Contact (sur les quarts)** + **Table Contacts** — record link used to assign a shift.
  `nom_contact` is the lookup of this link, so an assigned shift stops being yellow on its own.
- **Catégorie de contact** + **Catégorie de contact à proposer** (default `Employés`) — Contacts also
  holds producers and venue teams, so the assignment list is narrowed to one category.
- **Lien Projet (sur les quarts)** + **Lien Projet (sur Événements)** — `equipe_accueil` carries a
  `Projets` link but does not derive it, and the Projet interface page lists shifts by it: a shift
  without it is simply absent there. It is copied from the event's own `Projets` link whenever an
  event is set, and cleared when the event is removed, so the two never diverge.
- **URL du side-sheet Projet — parties 1/2 and 2/2** — clicking an event opens its project's
  side-sheet. Paste one such URL and only its `rowId` is swapped, so the page and element ids stay
  yours. It is split across two properties because **Airtable truncates a string property at 255
  characters** and these URLs are longer — a silent truncation that corrupts the base64 payload.

**Créer des quarts** (toolbar button) creates N identical open shifts: a date, a role, a work block
(Montage / Show call / Démontage) whose In/Out pair receives the hours, a start and end time, and a
quantity. An overnight shift (e.g. `23:00 → 01:00`) is stored as `25:00`, consistent with how
durations are already totalled. The contact and the event are left empty on purpose: the shift is
open, and gets dispatched later.

**Clicking a shift** opens the edit panel: the three In/Out pairs (a shift may legitimately have
more than one filled — clearing both ends of a pair erases it), the **role**, the contact, and the
event. It also carries a **Supprimer** button, armed by a first click and only destructive on the
second. Reassigning the role moves the shift to another category row, since the rows *are* the
roles. When the shift's current role is not among the offered ones (a role never linked elsewhere,
so absent from the dropdown — see below), the select shows *Rôle actuel (non proposé)* and leaving
it there writes nothing, rather than silently swapping the role for the first option in the list.

**The Portail flag** (⚑ / ⚐, beside each event chip) toggles the `portail` checkbox on the
Événement. It is what the employee portal's **Disponibilités** tab lists — the `portail-public`
view is filtered on it — so ticking it is how the venue tells employees that shifts are or will be
open on that event. The portal shows nothing more than that: employees declare whole days from
their calendar, never a role, and the dispatch stays this grid's job. The flag sits beside the chip
rather than inside it so clicking the event still opens the Projet side-sheet.

**The event cells** show the event's title on its own line, then its time and venue underneath.
`identifiant_court` already packs the three on three lines, but HTML collapses those newlines into
one run-on string, so the grid splits the label itself. A label that is a single line simply has no
second line.

**Shifts are grouped by event** inside each day cell, under a small heading carrying the event's
**title only** — otherwise a column of `Marie Tremblay : 12:30 - 17:15` says nothing about *which*
event is being staffed on a day holding several. Groups follow the events' own order (read from the
time on the label's second line, not from the title), shifts keep their start-time order within a
group, and shifts not yet dispatched fall into a last **Sans événement** group. Every group is
labelled, including when there is only one: on a busy day an unlabelled group would still leave the
question unanswered.

**Shifts with no event** are gathered under the ⚠ **Sans événement** group and counted per day
in the footer. Their `date_courte` rollup is
empty, so they are correctly dated *in this extension only*: any Airtable view grouping by
`date_courte` will not show them, and the Projet page will not list them either. The clean fix is to
turn `date_courte` into a formula — the event's date when there is one, the shift's own date
otherwise.

**The role dropdown.** `Rôles` is a link to a table the interface does not expose, so it cannot be
read — and `fetchForeignRecordsAsync` would return every role in the base, categories included. The
options are therefore the roles **already linked from `equipe_accueil`**, which are the front-of-house
ones by construction. Caveat: a role never yet used on a shift will not appear. Exposing the Rôles
table to the interface removes that limitation — the code then switches on its own to filtering it by
**Catégorie du rôle** / **Catégorie de rôle à proposer** (default `accueil`), and those two properties
appear in the settings panel.

### Availability ranking (read-only, optional)

The employee portal has a **Mes disponibilités** tab where a contact multi-selects the days they are
available, each with an optional time window. It writes one record per contact × day into a
`disponibilites` table (`Contacts` link, `date`, `heure_debut` / `heure_fin` as Duration fields).
Employees never pick a role there — the dispatch stays the operations director's decision — so this
extension **only reads** that table, to reorder the assignment dropdown. It never writes back and
never preselects anyone.

The edit panel's **Contact** dropdown then groups the employees in three:

- **Disponibles (n)** — submitted that day, and their window covers the shift's hours;
- **Disponibles ce jour, hors plage du quart** — submitted, but the window falls short;
- **Autres employés** — everyone else, as before.

The shift's window is the earliest In to the latest Out across its filled pairs, and it is
recomputed as the hours are edited, so the ranking re-sorts live. A shift with no hours yet cannot
split the first two buckets, so every available employee lands in **Disponibles**. A day submitted
with no hours means *all day*, not midnight — a missing bound is treated as unbounded. When nobody
submitted for that day the dropdown stays the plain alphabetical list it always was.

Configured by four properties, all auto-detected by name: **Table Disponibilités**, **Jour de la
disponibilité**, **Lien Contact**, **Heure de début / de fin**. Leave the table unset and the feature
is simply off. The two time fields are optional; the day and the contact link are not, and the panel
says so when one is missing.

### Publishing the schedule (optional)

**Sauvegarder** freezes the shifts of one collective-agreement period and publishes them to the
employee portal, where the whole team reads them. Each click writes a row in
`publications_horaire` — period, timestamp, author (`useSession()`), and the snapshot as JSON —
so the saves accumulate into a history of what was published and by whom.

**It is a frozen copy on purpose.** The portal renders the snapshot, never the live
`equipe_accueil` rows: otherwise every edit made after publishing would move the schedule under
the employees' feet, which is exactly what the button exists to prevent. The consequence has to be
said out loud, and the row says it under the button: **a correction made without clicking
Sauvegarder again stays invisible to them.**

**The period is picked explicitly**, from `periodes_horaire` (Annexe C of the collective
agreement: a Saturday 9:00 deadline, then a 14-day Sunday→Saturday period). Not "whatever the grid
is displaying" — the grid navigates in 1- or 2-week steps, so a period would sooner or later be
published by halves without anyone noticing. The selector opens on the period covering today,
falling back to the next one to come.

**Only one block's hours are published**, chosen by **Bloc horaire publié dans le portail**
(default *Show call*). A quart carries three — montage, show call, démontage — and each team
staffs against one of them: the accueil team works from the show call, technical crews from
montage and démontage. Publishing the whole span would put in front of a placier the hours of a
block that means nothing to them. If the chosen block is not configured, the snapshot falls back
to the widest span rather than publishing no hours at all.

**Restaurer une version** puts the live quarts back to a saved state. It is a **true restore**:
the shifts of that version are put back, the ones deleted since are recreated, and **the ones
created since are deleted** — the period ends up exactly as it was saved. The panel states the
three counts before acting and the button arms on a first click, like deleting a shift; all three
permissions are checked up front, because a restore that stops halfway leaves the period in a state
that is neither the saved one nor the one before.

**Restoring does not publish.** The portal keeps showing the last publication until someone clicks
Sauvegarder: restoring is a correction to the working schedule, and whether employees should see it
is a separate decision.

For that to work the snapshot carries record ids (quart, contact, rôle, événement) and **all three
In/Out pairs in raw seconds**, not only the published one — writing back the show call alone would
silently wipe the montage a technical crew had entered. **A version published before those ids
existed cannot be restored**, and the panel says so rather than failing oddly: a name cannot
rebuild a link, since two contacts can share one and a role can be renamed.

Configured by **Table Périodes** (libellé / premier jour / dernier jour) and **Table Publications**
(libellé / lien Période / date / publié par / contenu). Leave either table unset and the row does
not appear — the grid behaves exactly as before.

### Two limits of the Interface Extensions SDK you will hit

**An interface extension sees only the tables and fields the page exposes to it.** A field it cannot
see has no id and cannot be written — silently. That is why `Projets` was invisible until it was
exposed on the extension element, and why the Rôles table still is. The `disponibilites` table is
the same story: it is linked from Contacts, not from `equipe_accueil`, so it has to be exposed
explicitly before the availability properties can even be pointed at it. When a value refuses to be
written — or a table refuses to appear in the settings — check this before suspecting the code.

**Record creation, editing and deletion are three separate toggles** on the extension element in the
interface builder. Otherwise Airtable refuses the write; the extension reports its reason verbatim
rather than hiding the affordance silently.

## Development

```bash
cd schedule_grid/
npm install --legacy-peer-deps
block run
```

## Publishing

```bash
cd schedule_grid/
block release
```

## Stack

- `@airtable/blocks/interface/ui` + `@airtable/blocks/interface/models`
- React 19 (new JSX transform)
- Tailwind CSS with Airtable design tokens (`style.css` + `tailwind.config.js`)
