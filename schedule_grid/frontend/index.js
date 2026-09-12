import {useCallback, useMemo, useState} from 'react';
import {
    initializeBlock,
    useBase,
    useRecords,
    useCustomProperties,
    useSession,
    expandRecord,
} from '@airtable/blocks/interface/ui';
import {FieldType} from '@airtable/blocks/interface/models';
import './style.css';

// === CONSTANTS ===

// Week starts on Sunday to match the existing TSD schedule layout.
const DAY_LABELS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

// The "Événements" row is always rendered first; staff categories follow.
const EVENTS_ROW_KEY = '__events__';
const EVENTS_ROW_LABEL = 'Événements';

// Preferred ordering for staff category rows; unknown values fall through alphabetically.
const CATEGORY_PRIORITY_ORDER = ['Placiers', 'Placiers seniors', 'Merch'];

// Shifts not yet dispatched to an event sort after every event group. A finite value, not
// Infinity: the comparator subtracts these and Infinity - Infinity is NaN.
const NO_EVENT_SORT_KEY = Number.MAX_SAFE_INTEGER;
const NO_EVENT_GROUP_LABEL = 'Sans événement';

const MS_PER_DAY = 86400000;
const SECONDS_PER_DAY = 86400;

// Airtable caps createRecordsAsync/updateRecordsAsync at 50 records per call.
const MAX_RECORDS_PER_CALL = 50;
const MAX_SHIFT_QUANTITY = 50;

// Diffusion modes hidden by default (the venue is only rented out: nothing to staff).
const DEFAULT_HIDDEN_MODES = 'Location';

// Only front-of-house roles are offered when creating shifts.
const DEFAULT_ROLE_CATEGORY = 'accueil';

// Shifts created in bulk are overwhelmingly usher shifts, so preselect that role.
const DEFAULT_ROLE_NEEDLE = 'placier';

// Only employees can be assigned to a shift (Contacts also holds producers, venue staff, etc.).
const DEFAULT_CONTACT_CATEGORY = 'Employés';

// The portal's "Mes disponibilités" calendar writes one record per contact × available day into
// this table. The grid only reads it, to rank the assignment dropdown: who is actually dispatched
// stays the operations director's decision, so nothing is ever written back here.
const AVAILABILITY_TABLE_NEEDLE = 'disponibilit';

// The collective agreement's 14-day periods (Annexe C) and the frozen schedule
// versions published from this grid.
const PERIODES_TABLE_NEEDLE = 'periodes_horaire';
const PUBLICATIONS_TABLE_NEEDLE = 'publications_horaire';

// Which team's schedule this grid publishes. Accueil (placiers, gérants) and technique are two
// different schedules for two different audiences: without the tag, both would write into the same
// period and the last one would win, showing a placier the technical crew's hours.
const DEFAULT_PUBLICATION_TEAM = 'Accueil';

// The three In/Out duration pairs, keyed by their custom-property keys.
const SHIFT_PAIRS = [
    {key: 'montage', label: 'Montage', inKey: 'montageInField', outKey: 'montageOutField'},
    {key: 'showcall', label: 'Show call', inKey: 'showcallInField', outKey: 'showcallOutField'},
    {key: 'demontage', label: 'Démontage', inKey: 'demontageInField', outKey: 'demontageOutField'},
];

// === HELPERS ===

// Parse any Airtable date/datetime/formula cell into a local-midnight Date. Returns null if unparseable.
function parseDate(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        const d = new Date(value);
        d.setHours(0, 0, 0, 0);
        return d;
    }
    const str = String(value);
    // ISO first (YYYY-MM-DD, optionally with time) — this is what getCellValue returns for date fields.
    const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    // French display format (DD/MM/YYYY or DD-MM-YYYY), in case a string-typed field is used.
    const fr = str.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (fr) return new Date(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]));
    const fallback = new Date(str);
    if (isNaN(fallback.getTime())) return null;
    fallback.setHours(0, 0, 0, 0);
    return fallback;
}

// Convert a UTC datetime ISO string to local time while keeping the "Z" suffix, so the
// extracted calendar day matches what the user sees in Airtable. Date-only strings
// ("YYYY-MM-DD", no "T") and non-strings are returned untouched (no timezone to shift).
function toLocalIso(iso) {
    if (!iso || typeof iso !== 'string' || !iso.includes('T')) return iso;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
}

// Read a date cell as a local-midnight Date. getCellValue returns ISO (in UTC for
// date/time fields) regardless of the field's display format; toLocalIso shifts it back
// to the local calendar day before parsing. Falls back to the formatted string.
function readDate(record, field) {
    const raw = record.getCellValue(field);
    if (raw == null) return parseDate(record.getCellValueAsString(field));
    if (typeof raw === 'string') return parseDate(toLocalIso(raw));
    return parseDate(raw) ?? parseDate(record.getCellValueAsString(field));
}

// Read a date/time cell as an exact instant — unlike readDate, which normalizes to midnight and
// would make two publications of the same day indistinguishable.
function readDateTime(record, field) {
    if (!field) return null;
    const raw = record.getCellValue(field);
    const d = raw ? new Date(raw) : null;
    return d && !isNaN(d.getTime()) ? d : null;
}

// Sunday-anchored start of the week containing `date`, normalized to midnight.
function weekStart(date) {
    const x = new Date(date);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - x.getDay());
    return x;
}

function addDays(date, days) {
    const x = new Date(date);
    x.setDate(x.getDate() + days);
    return x;
}

// Format a Date as YYYY-MM-DD (local).
function fmtDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Whole-day offset between two midnight-normalized dates.
function dayDiff(from, to) {
    return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

// Extract the first HH:MM in a string and turn it into minutes, for intra-cell sorting.
function timeSortKey(str) {
    const m = str.match(/(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 99999;
}

// Read a Duration field as a number of seconds (time-of-day since midnight). Null if empty.
function readDurationSeconds(record, field) {
    const v = record.getCellValue(field);
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return isNaN(n) ? null : n;
}

// Format a number of seconds as H:MM (e.g. 45000 -> "12:30").
function fmtDuration(seconds) {
    const totalMin = Math.round(seconds / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
}

// Zero-padded HH:MM, as <input type="time"> requires (fmtDuration yields "9:05", not "09:05").
// An overnight Out stored as 25:00 comes back as "01:00"; saving it re-wraps it to 25:00.
function fmtHHMM(seconds) {
    if (seconds === null || seconds === undefined) return '';
    const totalMin = Math.round(seconds / 60) % (24 * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Label the window an employee submitted from the portal. Either bound may be missing, which the
// portal treats as unbounded rather than as midnight.
function fmtAvailabilityWindow({start, end}) {
    if (start === null && end === null) return 'toute la journée';
    if (start === null) return `jusqu’à ${fmtHHMM(end)}`;
    if (end === null) return `à partir de ${fmtHHMM(start)}`;
    return `${fmtHHMM(start)} – ${fmtHHMM(end)}`;
}

// "17:00" -> 61200 seconds. Null when the string is not a valid HH:MM.
function parseHHMM(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 3600 + min * 60;
}

// A shift ending at or before it starts runs past midnight: 23:00 -> 01:00 becomes 25:00 (90000s).
// This matches how fmtDuration and the hours total already treat out-of-day durations.
function endSecondsWithWrap(startSeconds, endSeconds) {
    return endSeconds <= startSeconds ? endSeconds + SECONDS_PER_DAY : endSeconds;
}

function normalizeToken(value) {
    return String(value ?? '').trim().toLowerCase();
}

// "Location, Privé" -> Set {"location", "privé"}.
function parseCsvSet(str) {
    return new Set(
        String(str ?? '')
            .split(',')
            .map(normalizeToken)
            .filter(Boolean),
    );
}

// Flatten any cell value into plain strings. Covers the shapes getCellValue actually returns:
// a string; {name}; [{name}]; and MULTIPLE_LOOKUP_VALUES' [{linkedRecordId, value}] where `value`
// may itself be a string, an object or an array.
function flattenCellStrings(value, depth = 0) {
    if (value === null || value === undefined || depth > 4) return [];
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    if (Array.isArray(value)) return value.flatMap((v) => flattenCellStrings(v, depth + 1));
    if (typeof value === 'object') {
        if ('value' in value) return flattenCellStrings(value.value, depth + 1);
        if ('name' in value) return flattenCellStrings(value.name, depth + 1);
    }
    return [];
}

// Read a cell as a list of strings, falling back to the formatted string for exotic field types.
function readTextValues(record, field) {
    if (!record || !field) return [];
    const values = flattenCellStrings(record.getCellValue(field));
    if (values.length) return values;
    return record
        .getCellValueAsString(field)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

// Linked record ids of a MULTIPLE_RECORD_LINKS cell: [{id, name}] -> ["recX"].
function readLinkedIds(record, field) {
    if (!record || !field) return [];
    const raw = record.getCellValue(field);
    return Array.isArray(raw) ? raw.map((link) => link?.id).filter(Boolean) : [];
}

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

// Free text is only meaningful for an actual text field. For a link, a typed name has no id and
// would either be ignored or (in a naive implementation) create a record in the linked table.
function isRoleFreeText(field) {
    const type = field?.config?.type;
    return type === FieldType.SINGLE_LINE_TEXT || type === FieldType.MULTILINE_TEXT;
}

// `identifiant_court` packs the event on three lines — title, time, venue. HTML collapses those
// newlines into one run-on string, so the grid splits them itself: the title heads the cell, the
// rest sits under it, and the shifts below are filed under the title alone. A label that is a
// single line simply has no `meta`.
function splitEventLabel(label) {
    const lines = String(label ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return {title: lines[0] ?? '', meta: lines.slice(1).join(' · ')};
}

// The shift's current role as a choice id, in the same shape `roleChoices` offers: a linked record
// id, or a select option id. Null when the field holds neither (free text, or empty).
function readRoleChoiceId(record, field) {
    const type = field?.config?.type;
    if (type === FieldType.MULTIPLE_RECORD_LINKS) return readLinkedIds(record, field)[0] ?? null;
    if (type === FieldType.SINGLE_SELECT) return record.getCellValue(field)?.id ?? null;
    if (type === FieldType.MULTIPLE_SELECTS) {
        const value = record.getCellValue(field);
        return Array.isArray(value) && value.length ? value[0]?.id ?? null : null;
    }
    return null;
}

// True when the category field can be written at all (i.e. is not a formula/rollup/lookup).
function isRoleWritable(field) {
    const type = field?.config?.type;
    return (
        type === FieldType.SINGLE_SELECT ||
        type === FieldType.MULTIPLE_SELECTS ||
        type === FieldType.MULTIPLE_RECORD_LINKS ||
        type === FieldType.SINGLE_LINE_TEXT ||
        type === FieldType.MULTILINE_TEXT
    );
}

// Cell-write value for the category field, shaped to its own type. Returns undefined when the
// field cannot be written (formula / rollup / lookup), so the caller omits it entirely.
// `choice` is {id, name}: a select option id, or a linked record id when the field is a link.
function roleWriteValue(field, choice, text) {
    const type = field?.config?.type;
    if (type === FieldType.SINGLE_SELECT) return choice ? {id: choice.id} : undefined;
    if (type === FieldType.MULTIPLE_SELECTS) return choice ? [{id: choice.id}] : undefined;
    // A linked cell must carry an `id`: a bare {name} would CREATE a record in the linked table.
    if (type === FieldType.MULTIPLE_RECORD_LINKS) return choice ? [{id: choice.id}] : undefined;
    if (type === FieldType.SINGLE_LINE_TEXT || type === FieldType.MULTILINE_TEXT) {
        const value = choice ? choice.name : String(text ?? '').trim();
        return value || undefined;
    }
    return undefined;
}

// Locate the Rôles table: the staff table's category field may link to it, otherwise match by name.
// getCustomProperties only receives `base`, so a `field` property's table must be resolved from the
// base itself — it cannot depend on a table the user picked in another property.
function findRolesTable(base, staffTable) {
    const categoryGuess = staffTable?.fields.find((f) => {
        const n = f.name.toLowerCase();
        return ['rôle', 'role', 'categor', 'catégor', 'poste'].some((x) => n.includes(x));
    });
    const linkedTableId = categoryGuess?.config?.options?.linkedTableId;
    return (
        base.tables.find((t) => t.id === linkedTableId) ||
        base.tables.find((t) => {
            const n = t.name.toLowerCase();
            return n.includes('rôle') || n.includes('role');
        }) ||
        null
    );
}

// Airtable record-detail URLs carry a base64 `detail` payload holding the row id plus page and
// element ids specific to the interface. Those cannot be guessed, so the builder pastes one real
// URL and we swap only its rowId. The raw query string is edited in place: re-serialising it would
// percent-encode the base64 and the trailing `&rsbzG=…`-style params.
function buildRecordDetailUrl(template, recordId) {
    if (!template || !recordId) return null;
    const match = /([?&]detail=)([^&]+)/.exec(template);
    if (!match) return null;
    try {
        const padded = match[2] + '='.repeat((4 - (match[2].length % 4)) % 4);
        const payload = JSON.parse(atob(padded));
        payload.rowId = recordId;
        // Airtable emits unpadded base64; mirror that rather than relying on it tolerating `=`.
        const encoded = btoa(JSON.stringify(payload)).replace(/=+$/, '');
        return template.slice(0, match.index) + match[1] + encoded +
            template.slice(match.index + match[0].length);
    } catch {
        return null; // malformed template: the caller falls back to expandRecord
    }
}

// Split a day's already-sorted shifts into one group per event, in first-appearance order (so the
// groups inherit the sort). Every group is labelled, including when there is only one: on a day
// holding several events, an unlabelled group would still leave "which event is this?" unanswered
// — which is the whole point of the grouping.
function groupEntriesByEvent(entries) {
    const groups = [];
    const byKey = new Map();
    for (const entry of entries) {
        const key = entry.eventId ?? '__none__';
        let group = byKey.get(key);
        if (!group) {
            group = {
                key,
                label: entry.eventLabel ?? NO_EVENT_GROUP_LABEL,
                orphan: !entry.eventId,
                entries: [],
            };
            byKey.set(key, group);
            groups.push(group);
        }
        group.entries.push(entry);
    }
    return groups;
}

function compareCategories(a, b) {
    const ai = CATEGORY_PRIORITY_ORDER.indexOf(a);
    const bi = CATEGORY_PRIORITY_ORDER.indexOf(b);
    const an = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const bn = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    if (an !== bn) return an - bn;
    return a.localeCompare(b, 'fr');
}

// === COLORS ===

// Airtable single-select option color names → {bg, text}.
const AIRTABLE_COLORS = {
    blueBright: {bg: '#2d7ff9', text: '#fff'},
    blueLight1: {bg: '#9cc7ff', text: '#333'},
    blueLight2: {bg: '#cfdfff', text: '#333'},
    cyanBright: {bg: '#18bfff', text: '#fff'},
    cyanLight1: {bg: '#77d1f3', text: '#333'},
    cyanLight2: {bg: '#d0f0fd', text: '#333'},
    tealBright: {bg: '#20d9d2', text: '#fff'},
    tealLight1: {bg: '#72ddc3', text: '#333'},
    tealLight2: {bg: '#c2f5e9', text: '#333'},
    greenBright: {bg: '#20c933', text: '#fff'},
    greenLight1: {bg: '#93e088', text: '#333'},
    greenLight2: {bg: '#d1f7c4', text: '#333'},
    yellowBright: {bg: '#fcb400', text: '#333'},
    yellowLight1: {bg: '#ffd66e', text: '#333'},
    yellowLight2: {bg: '#ffeab6', text: '#333'},
    orangeBright: {bg: '#ff6f2c', text: '#fff'},
    orangeLight1: {bg: '#ffaa57', text: '#333'},
    orangeLight2: {bg: '#fee2d5', text: '#333'},
    redBright: {bg: '#f82b60', text: '#fff'},
    redLight1: {bg: '#ff9eb7', text: '#333'},
    redLight2: {bg: '#ffdce5', text: '#333'},
    pinkBright: {bg: '#ff08c2', text: '#fff'},
    pinkLight1: {bg: '#f99de2', text: '#333'},
    pinkLight2: {bg: '#ffdaf6', text: '#333'},
    purpleBright: {bg: '#8b46ff', text: '#fff'},
    purpleLight1: {bg: '#cdb0ff', text: '#333'},
    purpleLight2: {bg: '#ede2fe', text: '#333'},
    grayBright: {bg: '#666666', text: '#fff'},
    gray: {bg: '#aaaaaa', text: '#fff'},
};

const DEFAULT_COLOR = {bg: '#ffffff', text: '#333'};

// Fallback palette for fields with no Airtable option colors (plain text / lookup):
// salle name → deterministic distinct color.
const PALETTE = [
    'blueBright', 'greenBright', 'orangeBright', 'purpleBright', 'tealBright',
    'pinkBright', 'redBright', 'cyanBright', 'yellowBright', 'grayBright',
];

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

// Resolve the single-select option colors of a SINGLE_SELECT field or a
// MULTIPLE_LOOKUP_VALUES field pointing at one (traversing record links).
function getFieldChoices(field, base) {
    if (!field) return null;
    try {
        const {type, options} = field.config;
        if (type === FieldType.SINGLE_SELECT || type === FieldType.MULTIPLE_SELECTS) {
            return options?.choices || null;
        }
        if (type === FieldType.MULTIPLE_LOOKUP_VALUES) {
            const direct = options?.result?.options?.choices;
            if (direct) return direct;
            if (base && options?.recordLinkFieldId && options?.fieldIdInLinkedTable) {
                for (const table of base.tables) {
                    const linkField = table.fields?.find((f) => f.id === options.recordLinkFieldId);
                    const linkedTableId = linkField?.config?.options?.linkedTableId;
                    if (!linkedTableId) continue;
                    const linkedTable = base.tables.find((t) => t.id === linkedTableId);
                    const sourceField = linkedTable?.fields?.find((f) => f.id === options.fieldIdInLinkedTable);
                    const choices = sourceField?.config?.options?.choices;
                    if (choices) return choices;
                }
            }
        }
    } catch {
        /* field config unavailable */
    }
    return null;
}

// Color for an event based on its "salle" field. Uses the field's own Airtable option
// color when available; otherwise derives a stable color from the salle name.
function getSalleColor(record, field, base) {
    if (!field) return DEFAULT_COLOR;
    const raw = record.getCellValue(field);

    // Direct single select: {name, color}
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.color) {
        return AIRTABLE_COLORS[raw.color] || DEFAULT_COLOR;
    }
    // Lookup / multi-select array: [{name, color}]
    if (Array.isArray(raw) && raw[0]?.color) {
        return AIRTABLE_COLORS[raw[0].color] || DEFAULT_COLOR;
    }

    const text = record.getCellValueAsString(field).trim();
    if (!text) return DEFAULT_COLOR;

    // Resolve via the field's choices (lookup without inline color object).
    const choices = getFieldChoices(field, base);
    const match = choices?.find((c) => c.name === text);
    if (match?.color) return AIRTABLE_COLORS[match.color] || DEFAULT_COLOR;

    // No Airtable color → deterministic palette by salle name.
    return AIRTABLE_COLORS[PALETTE[hashString(text) % PALETTE.length]];
}

// === CUSTOM PROPERTIES ===

function getCustomProperties(base) {
    const eventsTable =
        base.tables.find((t) => t.name.toLowerCase().includes('événement')) ||
        base.tables.find((t) => t.name.toLowerCase().includes('evenement')) ||
        base.tables[0];

    const staffTable =
        base.tables.find((t) => t.name.toLowerCase().includes('equipe_accueil')) ||
        base.tables.find((t) => t.name.toLowerCase().includes('accueil')) ||
        base.tables.find((t) => t.name.toLowerCase().includes('équipe')) ||
        base.tables[1] ||
        base.tables[0];

    const isTextLike = (field) =>
        field.config.type === FieldType.SINGLE_LINE_TEXT ||
        field.config.type === FieldType.MULTILINE_TEXT ||
        field.config.type === FieldType.FORMULA ||
        field.config.type === FieldType.MULTIPLE_LOOKUP_VALUES ||
        field.config.type === FieldType.ROLLUP;

    const isDateLike = (field) =>
        field.config.type === FieldType.DATE ||
        field.config.type === FieldType.DATE_TIME ||
        field.config.type === FieldType.FORMULA ||
        field.config.type === FieldType.ROLLUP ||
        field.config.type === FieldType.MULTIPLE_LOOKUP_VALUES ||
        field.config.type === FieldType.SINGLE_LINE_TEXT;

    const isCategoryLike = (field) =>
        field.config.type === FieldType.SINGLE_SELECT ||
        field.config.type === FieldType.MULTIPLE_SELECTS ||
        field.config.type === FieldType.MULTIPLE_RECORD_LINKS ||
        field.config.type === FieldType.SINGLE_LINE_TEXT ||
        field.config.type === FieldType.FORMULA ||
        field.config.type === FieldType.ROLLUP ||
        field.config.type === FieldType.MULTIPLE_LOOKUP_VALUES;

    const isTimeLike = (field) =>
        field.config.type === FieldType.DATE_TIME ||
        field.config.type === FieldType.SINGLE_LINE_TEXT ||
        field.config.type === FieldType.FORMULA ||
        field.config.type === FieldType.DURATION ||
        field.config.type === FieldType.MULTIPLE_LOOKUP_VALUES;

    const isLinkedRecord = (field) => field.config.type === FieldType.MULTIPLE_RECORD_LINKS;

    const isCheckbox = (field) => field.config.type === FieldType.CHECKBOX;

    // Strict, like the In/Out pairs: these are read as raw seconds-since-midnight, which only a
    // Duration field yields.
    const isDuration = (field) => field.config.type === FieldType.DURATION;

    // date_courte is a rollup of the linked event's date, so it cannot be written. Creating a shift
    // before it is dispatched to an event therefore needs a date field of its own.
    const isWritableDate = (field) =>
        field.config.type === FieldType.DATE || field.config.type === FieldType.DATE_TIME;

    const byName = (table, predicate, ...needles) =>
        table.fields.find(
            (f) => predicate(f) && needles.some((n) => f.name.toLowerCase().includes(n)),
        );

    // Match a field whose name contains ALL of `needles` and NONE of `excludes`.
    const findAll = (table, predicate, needles, excludes = []) =>
        table.fields.find((f) => {
            const n = f.name.toLowerCase();
            return (
                predicate(f) &&
                needles.every((x) => n.includes(x)) &&
                !excludes.some((x) => n.includes(x))
            );
        });

    // Derive the Contacts table from the staff->Contacts link rather than from its name: that
    // guarantees the table we offer actually matches the link we write to.
    const contactLinkGuess = byName(staffTable, isLinkedRecord, 'contact');
    const linkedContactsTableId = contactLinkGuess?.config?.options?.linkedTableId;
    const contactsTable =
        base.tables.find((t) => t.id === linkedContactsTableId) ||
        base.tables.find((t) => t.name.toLowerCase().includes('contact'));

    const rolesTable = findRolesTable(base, staffTable);

    const availabilityTable = base.tables.find((t) =>
        t.name.toLowerCase().includes(AVAILABILITY_TABLE_NEEDLE),
    );

    const periodesTable = base.tables.find((t) =>
        t.name.toLowerCase().includes(PERIODES_TABLE_NEEDLE),
    );
    const publicationsTable = base.tables.find((t) =>
        t.name.toLowerCase().includes(PUBLICATIONS_TABLE_NEEDLE),
    );

    return [
        {
            key: 'eventsTable',
            label: 'Table Événements',
            type: 'table',
            defaultValue: eventsTable,
        },
        {
            key: 'staffTable',
            label: 'Table Équipe accueil (quarts)',
            type: 'table',
            defaultValue: staffTable,
        },
        {
            key: 'eventLabelField',
            label: 'Libellé événement (ex. identifiant_court)',
            type: 'field',
            table: eventsTable,
            shouldFieldBeAllowed: isTextLike,
            defaultValue:
                eventsTable.fields.find((f) => f.name.toLowerCase() === 'identifiant_court') ||
                byName(eventsTable, isTextLike, 'identifiant', 'titre', 'nom'),
        },
        {
            key: 'eventDateField',
            label: 'Date événement',
            type: 'field',
            table: eventsTable,
            shouldFieldBeAllowed: isDateLike,
            defaultValue:
                byName(eventsTable, isDateLike, 'événement', 'evenement') ||
                byName(eventsTable, isDateLike, 'date'),
        },
        {
            key: 'salleField',
            label: 'Salle (couleur des événements)',
            type: 'field',
            table: eventsTable,
            shouldFieldBeAllowed: isCategoryLike,
            defaultValue: byName(
                eventsTable, isCategoryLike, 'salle', 'lieu', 'venue', 'théâtre', 'theatre', 'room',
            ),
        },
        // Optional. Left unset, nothing is ever hidden and the grid behaves exactly as before.
        {
            key: 'diffusionField',
            label: 'Mode de diffusion (pour masquer des événements)',
            type: 'field',
            table: eventsTable,
            shouldFieldBeAllowed: isCategoryLike,
            defaultValue: byName(eventsTable, isCategoryLike, 'mode_diffusion', 'diffusion'),
        },
        {
            key: 'hiddenModes',
            label: 'Modes de diffusion à masquer (séparés par des virgules)',
            type: 'string',
            defaultValue: DEFAULT_HIDDEN_MODES,
        },
        // A checkbox on Événements, toggled straight from the events row. It is what the employee
        // portal's Disponibilités tab lists (the `portail-public` view filters on it), so ticking it
        // here is how the venue announces that shifts are or will be open on an event. Must be
        // exposed to the extension in the interface builder — a hidden field cannot be written.
        {
            key: 'portalField',
            label: 'Case Portail (sur les événements)',
            type: 'field',
            table: eventsTable,
            shouldFieldBeAllowed: isCheckbox,
            defaultValue: byName(eventsTable, isCheckbox, 'portail', 'portal'),
        },
        // Clicking an event opens the Projet side-sheet of the interface. Paste one such URL: only
        // its rowId is swapped, so the page and element ids stay yours.
        // Airtable truncates a `string` custom property at 255 characters and these URLs are longer
        // (the base64 `detail` payload alone is ~250), so the value is split across two properties
        // and concatenated back. Cutting the base64 in half would otherwise corrupt it silently.
        {
            key: 'detailUrlPart1',
            label: 'URL du side-sheet Projet — partie 1/2 (255 car. max)',
            type: 'string',
            defaultValue: '',
        },
        {
            key: 'detailUrlPart2',
            label: 'URL du side-sheet Projet — partie 2/2 (la suite, sans espace)',
            type: 'string',
            defaultValue: '',
        },
        {
            key: 'detailLinkField',
            label: 'Lien Projet (sur Événements)',
            type: 'field',
            table: eventsTable,
            shouldFieldBeAllowed: isLinkedRecord,
            defaultValue: byName(eventsTable, isLinkedRecord, 'projet'),
        },
        {
            key: 'contactField',
            label: 'Nom du contact (ex. nom_contact)',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isTextLike,
            defaultValue:
                staffTable.fields.find((f) => f.name.toLowerCase() === 'nom_contact') ||
                byName(staffTable, isTextLike, 'contact', 'nom', 'equipier', 'équipier'),
        },
        {
            key: 'categoryField',
            label: 'Catégorie (Placiers / seniors / Merch)',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isCategoryLike,
            defaultValue: byName(staffTable, isCategoryLike, 'rôle', 'role', 'categor', 'catégor', 'type', 'poste'),
        },
        {
            key: 'staffDateField',
            label: 'Date du quart',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isDateLike,
            defaultValue:
                byName(staffTable, isDateLike, 'date_courte') ||
                byName(staffTable, isDateLike, 'date'),
        },
        // Three work shifts (Montage / Show call / Démontage), each an In + Out duration.
        // The cell shows the smallest In to the largest Out across the filled shifts.
        {
            key: 'montageInField',
            label: 'Montage — In',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isTimeLike,
            defaultValue: findAll(staffTable, isTimeLike, ['montage', 'in'], ['démontage', 'demontage']),
        },
        {
            key: 'montageOutField',
            label: 'Montage — Out',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isTimeLike,
            defaultValue: findAll(staffTable, isTimeLike, ['montage', 'out'], ['démontage', 'demontage']),
        },
        {
            key: 'showcallInField',
            label: 'Show call — In',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isTimeLike,
            defaultValue:
                findAll(staffTable, isTimeLike, ['show call', 'in']) ||
                findAll(staffTable, isTimeLike, ['appel', 'in']),
        },
        {
            key: 'showcallOutField',
            label: 'Show call — Out',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isTimeLike,
            defaultValue:
                findAll(staffTable, isTimeLike, ['show call', 'out']) ||
                findAll(staffTable, isTimeLike, ['appel', 'out']),
        },
        {
            key: 'demontageInField',
            label: 'Démontage — In',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isTimeLike,
            defaultValue:
                findAll(staffTable, isTimeLike, ['démontage', 'in']) ||
                findAll(staffTable, isTimeLike, ['demontage', 'in']),
        },
        {
            key: 'demontageOutField',
            label: 'Démontage — Out',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isTimeLike,
            defaultValue:
                findAll(staffTable, isTimeLike, ['démontage', 'out']) ||
                findAll(staffTable, isTimeLike, ['demontage', 'out']),
        },
        // --- Write features. All optional: unset, the grid stays strictly read-only. ---
        {
            key: 'staffEventLinkField',
            label: 'Lien Événement (sur les quarts)',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isLinkedRecord,
            defaultValue: byName(staffTable, isLinkedRecord, 'événement', 'evenement', 'event'),
        },
        {
            key: 'contactLinkField',
            label: 'Lien Contact (sur les quarts)',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isLinkedRecord,
            defaultValue: contactLinkGuess,
        },
        // The Projet interface page lists shifts by their Projets link, which equipe_accueil carries
        // but does not derive: it stays empty on a shift created here. We copy it from the event's
        // own Projets link whenever an event is set. Requires the field to be exposed to this
        // extension in the interface builder — a hidden field has no id and cannot be written.
        {
            key: 'staffProjectLinkField',
            label: 'Lien Projet (sur les quarts)',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isLinkedRecord,
            defaultValue: byName(staffTable, isLinkedRecord, 'projet'),
        },
        {
            key: 'contactsTable',
            label: 'Table Contacts',
            type: 'table',
            defaultValue: contactsTable,
        },
        // Contacts holds far more than staff, so the assignment list is narrowed to one category.
        // Declared only when the table is known: a `field` property with no table breaks the panel.
        ...(contactsTable
            ? [
                {
                    key: 'contactCategoryField',
                    label: 'Catégorie de contact (sur la table Contacts)',
                    type: 'field',
                    table: contactsTable,
                    shouldFieldBeAllowed: isCategoryLike,
                    defaultValue: byName(
                        contactsTable, isCategoryLike, 'catégorie de contact', 'catégor', 'categor', 'type',
                    ),
                },
                {
                    key: 'contactCategoryValue',
                    label: 'Catégorie de contact à proposer',
                    type: 'string',
                    defaultValue: DEFAULT_CONTACT_CATEGORY,
                },
            ]
            : []),
        {
            key: 'staffDateWriteField',
            label: 'Date du quart — champ inscriptible (requis pour créer)',
            type: 'field',
            table: staffTable,
            shouldFieldBeAllowed: isWritableDate,
            defaultValue: byName(staffTable, isWritableDate, 'date_quart', 'date'),
        },
        // The role dropdown is fed by the Rôles table, narrowed to one category (e.g. "accueil"),
        // so the dispatcher is not offered roles belonging to other teams. Declared only when that
        // table exists: a `field` property with an undefined table breaks the settings panel.
        ...(rolesTable
            ? [
                {
                    key: 'roleCategoryField',
                    label: 'Catégorie du rôle (sur la table Rôles)',
                    type: 'field',
                    table: rolesTable,
                    shouldFieldBeAllowed: isCategoryLike,
                    defaultValue: byName(
                        rolesTable, isCategoryLike,
                        'catégor', 'categor', 'type', 'équipe', 'equipe',
                    ),
                },
                {
                    key: 'roleCategoryValue',
                    label: 'Catégorie de rôle à proposer',
                    type: 'string',
                    defaultValue: DEFAULT_ROLE_CATEGORY,
                },
            ]
            : []),
        // Optional. Left unset, the assignment dropdown stays a flat alphabetical list — exactly
        // as it behaved before. Declared only when the table exists: a `field` property with an
        // undefined table breaks the settings panel.
        {
            key: 'availabilityTable',
            label: 'Table Disponibilités (portail employés)',
            type: 'table',
            defaultValue: availabilityTable,
        },
        ...(availabilityTable
            ? [
                {
                    key: 'availabilityDateField',
                    label: 'Jour de la disponibilité',
                    type: 'field',
                    table: availabilityTable,
                    shouldFieldBeAllowed: isDateLike,
                    defaultValue: byName(availabilityTable, isDateLike, 'date', 'jour'),
                },
                {
                    key: 'availabilityContactLinkField',
                    label: 'Lien Contact (sur les disponibilités)',
                    type: 'field',
                    table: availabilityTable,
                    shouldFieldBeAllowed: isLinkedRecord,
                    defaultValue: byName(availabilityTable, isLinkedRecord, 'contact', 'employé', 'employe'),
                },
                // Both halves of the window are optional: a day submitted without hours means
                // "available all day", not "available at 00:00".
                {
                    key: 'availabilityStartField',
                    label: 'Heure de début de la disponibilité',
                    type: 'field',
                    table: availabilityTable,
                    shouldFieldBeAllowed: isDuration,
                    defaultValue: byName(availabilityTable, isDuration, 'debut', 'début', 'start'),
                },
                {
                    key: 'availabilityEndField',
                    label: 'Heure de fin de la disponibilité',
                    type: 'field',
                    table: availabilityTable,
                    shouldFieldBeAllowed: isDuration,
                    defaultValue: byName(availabilityTable, isDuration, 'fin', 'end'),
                },
            ]
            : []),
        // Publishing the schedule. Optional as a whole: leave the two tables
        // unset and the grid keeps working exactly as before, without the
        // Sauvegarder row.
        {
            key: 'periodesTable',
            label: 'Table Périodes (convention collective)',
            type: 'table',
            defaultValue: periodesTable,
        },
        ...(periodesTable
            ? [
                {
                    key: 'periodeLabelField',
                    label: 'Libellé de la période',
                    type: 'field',
                    table: periodesTable,
                    shouldFieldBeAllowed: isTextLike,
                    defaultValue: byName(periodesTable, isTextLike, 'periode', 'période'),
                },
                {
                    key: 'periodeDebutField',
                    label: 'Premier jour de la période',
                    type: 'field',
                    table: periodesTable,
                    shouldFieldBeAllowed: isDateLike,
                    defaultValue: byName(periodesTable, isDateLike, 'debut', 'début'),
                },
                {
                    key: 'periodeFinField',
                    label: 'Dernier jour de la période',
                    type: 'field',
                    table: periodesTable,
                    shouldFieldBeAllowed: isDateLike,
                    defaultValue: byName(periodesTable, isDateLike, 'fin'),
                },
            ]
            : []),
        {
            key: 'publicationsTable',
            label: 'Table Publications de l’horaire',
            type: 'table',
            defaultValue: publicationsTable,
        },
        // A quart carries three blocks, and each team staffs against one of them: the accueil
        // team works from the show call, technical crews from montage and démontage. Publishing
        // the full span would put the other blocks in front of people they mean nothing to.
        {
            key: 'publishedPair',
            label: 'Bloc horaire publié dans le portail',
            type: 'enum',
            possibleValues: SHIFT_PAIRS.map((pair) => ({value: pair.key, label: pair.label})),
            defaultValue: 'showcall',
        },
        ...(publicationsTable
            ? [
                {
                    key: 'publicationLabelField',
                    label: 'Libellé de la publication',
                    type: 'field',
                    table: publicationsTable,
                    shouldFieldBeAllowed: isTextLike,
                    defaultValue: byName(publicationsTable, isTextLike, 'publication'),
                },
                {
                    key: 'publicationPeriodeField',
                    label: 'Lien Période (sur les publications)',
                    type: 'field',
                    table: publicationsTable,
                    shouldFieldBeAllowed: isLinkedRecord,
                    defaultValue: byName(publicationsTable, isLinkedRecord, 'periode', 'période'),
                },
                {
                    key: 'publicationDateField',
                    label: 'Date de publication',
                    type: 'field',
                    table: publicationsTable,
                    shouldFieldBeAllowed: isDateLike,
                    defaultValue: byName(publicationsTable, isDateLike, 'publie_le', 'publié'),
                },
                {
                    key: 'publicationAuteurField',
                    label: 'Publié par',
                    type: 'field',
                    table: publicationsTable,
                    shouldFieldBeAllowed: isTextLike,
                    defaultValue: byName(publicationsTable, isTextLike, 'publie_par', 'auteur'),
                },
                {
                    key: 'publicationContenuField',
                    label: 'Contenu de l’instantané (texte long)',
                    type: 'field',
                    table: publicationsTable,
                    shouldFieldBeAllowed: isTextLike,
                    defaultValue: byName(publicationsTable, isTextLike, 'contenu'),
                },
                {
                    key: 'publicationEquipeField',
                    label: 'Équipe (sur les publications)',
                    type: 'field',
                    table: publicationsTable,
                    shouldFieldBeAllowed: isCategoryLike,
                    defaultValue: byName(publicationsTable, isCategoryLike, 'equipe', 'équipe'),
                },
                {
                    key: 'publicationEquipeValue',
                    label: 'Équipe publiée par cette grille',
                    type: 'string',
                    defaultValue: DEFAULT_PUBLICATION_TEAM,
                },
            ]
            : []),
    ];
}

// === MAIN APP ===

function ScheduleGridApp() {
    const base = useBase();
    const {customPropertyValueByKey, errorState} = useCustomProperties(getCustomProperties);

    const eventsTable = customPropertyValueByKey.eventsTable;
    const staffTable = customPropertyValueByKey.staffTable;
    const eventLabelField = customPropertyValueByKey.eventLabelField;
    const eventDateField = customPropertyValueByKey.eventDateField;
    const salleField = customPropertyValueByKey.salleField;
    const contactField = customPropertyValueByKey.contactField;
    const categoryField = customPropertyValueByKey.categoryField;
    const staffDateField = customPropertyValueByKey.staffDateField;
    const montageInField = customPropertyValueByKey.montageInField;
    const showcallInField = customPropertyValueByKey.showcallInField;
    const demontageInField = customPropertyValueByKey.demontageInField;
    const montageOutField = customPropertyValueByKey.montageOutField;
    const showcallOutField = customPropertyValueByKey.showcallOutField;
    const demontageOutField = customPropertyValueByKey.demontageOutField;
    const diffusionField = customPropertyValueByKey.diffusionField;
    // Rejoin the two halves Airtable's 255-char limit forced us to split the URL into.
    const detailUrlTemplate =
        String(customPropertyValueByKey.detailUrlPart1 ?? '').trim() +
        String(customPropertyValueByKey.detailUrlPart2 ?? '').trim();
    const detailLinkField = customPropertyValueByKey.detailLinkField;
    const staffProjectLinkField = customPropertyValueByKey.staffProjectLinkField;
    const portalField = customPropertyValueByKey.portalField;
    const hiddenModesRaw = customPropertyValueByKey.hiddenModes;
    const staffEventLinkField = customPropertyValueByKey.staffEventLinkField;
    const contactLinkField = customPropertyValueByKey.contactLinkField;
    const contactsTable = customPropertyValueByKey.contactsTable;
    const contactCategoryField = customPropertyValueByKey.contactCategoryField;
    const contactCategoryValue = customPropertyValueByKey.contactCategoryValue;
    const staffDateWriteField = customPropertyValueByKey.staffDateWriteField;
    const roleCategoryField = customPropertyValueByKey.roleCategoryField;
    const roleCategoryValue = customPropertyValueByKey.roleCategoryValue;
    const availabilityTable = customPropertyValueByKey.availabilityTable;
    const availabilityDateField = customPropertyValueByKey.availabilityDateField;
    const availabilityContactLinkField = customPropertyValueByKey.availabilityContactLinkField;
    const availabilityStartField = customPropertyValueByKey.availabilityStartField;
    const availabilityEndField = customPropertyValueByKey.availabilityEndField;
    const periodesTable = customPropertyValueByKey.periodesTable;
    const periodeLabelField = customPropertyValueByKey.periodeLabelField;
    const periodeDebutField = customPropertyValueByKey.periodeDebutField;
    const periodeFinField = customPropertyValueByKey.periodeFinField;
    const publicationsTable = customPropertyValueByKey.publicationsTable;
    const publicationLabelField = customPropertyValueByKey.publicationLabelField;
    const publicationPeriodeField = customPropertyValueByKey.publicationPeriodeField;
    const publicationDateField = customPropertyValueByKey.publicationDateField;
    const publicationAuteurField = customPropertyValueByKey.publicationAuteurField;
    const publicationContenuField = customPropertyValueByKey.publicationContenuField;
    const publishedPair = customPropertyValueByKey.publishedPair;
    const publicationEquipeField = customPropertyValueByKey.publicationEquipeField;
    const publicationEquipeValue = customPropertyValueByKey.publicationEquipeValue;
    const rolesTable = useMemo(
        () => (staffTable ? findRolesTable(base, staffTable) : null),
        [base, staffTable],
    );

    // A shift's day comes from its event (the date_courte rollup). A shift created before being
    // dispatched to an event has no event yet, so it falls back to its own date field.
    const readShiftDate = useCallback(
        (record) =>
            readDate(record, staffDateField) ??
            (staffDateWriteField ? readDate(record, staffDateWriteField) : null),
        [staffDateField, staffDateWriteField],
    );

    const inFields = useMemo(
        () => [montageInField, showcallInField, demontageInField].filter(Boolean),
        [montageInField, showcallInField, demontageInField],
    );
    const outFields = useMemo(
        () => [montageOutField, showcallOutField, demontageOutField].filter(Boolean),
        [montageOutField, showcallOutField, demontageOutField],
    );

    const eventRecords = useRecords(eventsTable);
    const staffRecords = useRecords(staffTable);
    // useRecords throws on an undefined table, and contactsTable is optional: fall back to a
    // table that always exists and ignore the result when Contacts is not configured.
    const contactRecords = useRecords(contactsTable || staffTable);
    const roleRecords = useRecords(rolesTable || staffTable);
    const availabilityRecords = useRecords(availabilityTable || staffTable);
    const periodeRecords = useRecords(periodesTable || staffTable);
    const publicationRecords = useRecords(publicationsTable || staffTable);
    const session = useSession();

    const [selectedWeekMs, setSelectedWeekMs] = useState(null);
    const [numWeeks, setNumWeeks] = useState(1);
    // One panel, two modes ('create' | 'assign'); null when closed.
    const [panel, setPanel] = useState(null);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState(null);

    const configured =
        eventsTable && staffTable && eventLabelField && eventDateField &&
        contactField && categoryField && staffDateField;

    // Distinct week starts present in the data, plus the current week, sorted ascending.
    const weeks = useMemo(() => {
        const set = new Set();
        if (configured) {
            for (const r of eventRecords) {
                const d = readDate(r, eventDateField);
                if (d) set.add(weekStart(d).getTime());
            }
            for (const r of staffRecords) {
                const d = readShiftDate(r);
                if (d) set.add(weekStart(d).getTime());
            }
        }
        const today = new Date();
        set.add(weekStart(today).getTime());
        return Array.from(set).sort((a, b) => a - b);
    }, [configured, eventRecords, staffRecords, eventDateField, readShiftDate]);

    // The selected week always wins (so ◀ ▶ can reach weeks with no data); otherwise default to
    // the week containing today, then the most recent week with data.
    const effectiveWeekMs = useMemo(() => {
        if (selectedWeekMs !== null) return selectedWeekMs;
        const todayWeek = weekStart(new Date()).getTime();
        if (weeks.includes(todayWeek)) return todayWeek;
        return weeks.length ? weeks[weeks.length - 1] : todayWeek;
    }, [selectedWeekMs, weeks]);

    // Dropdown options: weeks with data plus the currently shown week (so navigation stays visible).
    const weekOptions = useMemo(() => {
        const set = new Set(weeks);
        set.add(effectiveWeekMs);
        return Array.from(set).sort((a, b) => a - b);
    }, [weeks, effectiveWeekMs]);

    const goToWeek = (ms) => setSelectedWeekMs(ms);
    const shiftWeek = (deltaWeeks) =>
        setSelectedWeekMs(addDays(new Date(effectiveWeekMs), deltaWeeks * 7).getTime());

    const weekDays = useMemo(() => {
        const start = new Date(effectiveWeekMs);
        return Array.from({length: 7 * numWeeks}, (_, i) => addDays(start, i));
    }, [effectiveWeekMs, numWeeks]);

    const hiddenModes = useMemo(
        () => parseCsvSet(hiddenModesRaw ?? DEFAULT_HIDDEN_MODES),
        [hiddenModesRaw],
    );

    // Events whose diffusion mode is hidden (e.g. "Location": the venue is rented out, so the
    // Espace does not staff it). Computed over ALL events, not just the displayed week, so that a
    // shift linked to an off-week event is still filtered out.
    const hiddenEventIds = useMemo(() => {
        const set = new Set();
        if (!diffusionField || hiddenModes.size === 0) return set;
        for (const r of eventRecords) {
            const modes = readTextValues(r, diffusionField);
            if (modes.some((m) => hiddenModes.has(normalizeToken(m)))) set.add(r.id);
        }
        return set;
    }, [eventRecords, diffusionField, hiddenModes]);

    // Build: rowKey -> dayIndex -> CellEntry[], the ordered category rows, and per-day totals.
    const {grid, categoryRows, dayTotals} = useMemo(() => {
        const map = new Map();
        const categories = new Set();
        const start = new Date(effectiveWeekMs);
        const numDays = 7 * numWeeks;
        // Per day: staff shift count, open (unassigned) shift count, total hours, event count.
        const dayTotals = Array.from(
            {length: numDays},
            () => ({shifts: 0, open: 0, hours: 0, events: 0, orphans: 0}),
        );

        const ensureRow = (key) => {
            if (!map.has(key)) map.set(key, Array.from({length: numDays}, () => []));
            return map.get(key);
        };

        // Label + time of every visible event, so each shift can name the event it staffs. Built
        // over the whole table rather than the displayed week: resolution must not depend on the
        // event happening to be in range.
        const eventInfoById = new Map();
        if (configured) {
            for (const r of eventRecords) {
                if (hiddenEventIds.has(r.id)) continue;
                const label = r.getCellValueAsString(eventLabelField).trim();
                // Shifts are filed under the title alone; the sort key still reads the whole label,
                // where the time sits on the second line.
                if (label) {
                    eventInfoById.set(r.id, {
                        label: splitEventLabel(label).title,
                        sortKey: timeSortKey(label),
                    });
                }
            }
        }

        if (configured) {
            // Événements row
            for (const r of eventRecords) {
                if (hiddenEventIds.has(r.id)) continue;
                const date = readDate(r, eventDateField);
                if (!date) continue;
                const idx = dayDiff(start, date);
                if (idx < 0 || idx >= numDays) continue;
                const text = r.getCellValueAsString(eventLabelField).trim();
                if (!text) continue;
                // The detail URL opens a Projet side-sheet, so its rowId must be a Projet record —
                // never the event's own id, which would render an empty sheet. No link, no URL: the
                // click falls back to expanding the event record.
                const detailRowId = detailLinkField ? readLinkedIds(r, detailLinkField)[0] ?? null : null;

                const {title, meta} = splitEventLabel(text);

                ensureRow(EVENTS_ROW_KEY)[idx].push({
                    title,
                    meta,
                    sortKey: timeSortKey(text),
                    highlight: false,
                    color: salleField ? getSalleColor(r, salleField, base) : null,
                    detailUrl: buildRecordDetailUrl(detailUrlTemplate, detailRowId),
                    portal: portalField ? Boolean(r.getCellValue(portalField)) : null,
                    record: r,
                });
                dayTotals[idx].events++;
            }

            // Staff category rows
            for (const r of staffRecords) {
                const date = readShiftDate(r);
                if (!date) continue;
                const idx = dayDiff(start, date);
                if (idx < 0 || idx >= numDays) continue;

                // Drop shifts belonging to a hidden event. Skipping before the dayTotals
                // increments below is what keeps the footer consistent with what is displayed.
                // A shift shared with a visible event is kept: it still has to be staffed.
                const linkedEventIds = staffEventLinkField ? readLinkedIds(r, staffEventLinkField) : [];
                if (staffEventLinkField && hiddenEventIds.size && linkedEventIds.length) {
                    if (linkedEventIds.every((id) => hiddenEventIds.has(id))) continue;
                }

                // A shift created for a day but never dispatched to an event: its date_courte rollup
                // stays empty, so it is dated here and nowhere else. Flag it rather than lose it.
                const orphan = Boolean(staffEventLinkField) && linkedEventIds.length === 0;

                // A shift shared between events is filed under the first one still visible.
                const eventId = linkedEventIds.find((id) => eventInfoById.has(id)) ?? null;
                const eventInfo = eventId ? eventInfoById.get(eventId) : null;

                const category = r.getCellValueAsString(categoryField).trim() || 'Autres';
                categories.add(category);

                const contact = r.getCellValueAsString(contactField).trim();

                // Smallest In to largest Out across the filled Montage/Show call/Démontage shifts.
                const ins = inFields
                    .map((f) => readDurationSeconds(r, f))
                    .filter((v) => v !== null);
                const outs = outFields
                    .map((f) => readDurationSeconds(r, f))
                    .filter((v) => v !== null);
                const minIn = ins.length ? Math.min(...ins) : null;
                const maxOut = outs.length ? Math.max(...outs) : null;

                let range = '';
                if (minIn !== null && maxOut !== null) range = `${fmtDuration(minIn)} - ${fmtDuration(maxOut)}`;
                else if (minIn !== null) range = fmtDuration(minIn);

                let text;
                if (contact && range) text = `${contact} : ${range}`;
                else if (contact) text = contact;
                else text = range; // unassigned shift: time only (highlighted yellow)

                ensureRow(category)[idx].push({
                    text,
                    sortKey: minIn !== null ? minIn : timeSortKey(text),
                    highlight: !contact, // yellow when no contact assigned
                    orphan,
                    eventId,
                    eventLabel: eventInfo?.label ?? null,
                    // Shifts with no event sort last, after every event group.
                    eventSortKey: eventInfo ? eventInfo.sortKey : NO_EVENT_SORT_KEY,
                    record: r,
                });

                dayTotals[idx].shifts++;
                if (!contact) dayTotals[idx].open++;
                if (orphan) dayTotals[idx].orphans++;
                if (minIn !== null && maxOut !== null) dayTotals[idx].hours += (maxOut - minIn) / 3600;
            }
        }

        // Shifts sort by their event first so each event's shifts end up contiguous, then by their
        // own start time within it. The Événements row carries no eventSortKey, so it falls
        // straight through to the second term and keeps its previous ordering.
        for (const cells of map.values()) {
            for (const day of cells) {
                day.sort(
                    (a, b) =>
                        (a.eventSortKey ?? 0) - (b.eventSortKey ?? 0) || a.sortKey - b.sortKey,
                );
            }
        }

        return {
            grid: map,
            categoryRows: Array.from(categories).sort(compareCategories),
            dayTotals,
        };
    }, [
        configured, effectiveWeekMs, numWeeks, eventRecords, staffRecords,
        eventDateField, eventLabelField, readShiftDate, categoryField,
        contactField, inFields, outFields, salleField, base,
        hiddenEventIds, staffEventLinkField, detailUrlTemplate, detailLinkField, portalField,
    ]);

    // Visible (non-hidden) events keyed by YYYY-MM-DD, for the event pickers of both panels.
    const eventsByDayIso = useMemo(() => {
        const map = new Map();
        if (!configured) return map;
        for (const r of eventRecords) {
            if (hiddenEventIds.has(r.id)) continue;
            const date = readDate(r, eventDateField);
            if (!date) continue;
            const iso = fmtDate(date);
            if (!map.has(iso)) map.set(iso, []);
            map.get(iso).push({
                id: r.id,
                label: r.getCellValueAsString(eventLabelField).trim() || r.name,
            });
        }
        return map;
    }, [configured, eventRecords, eventDateField, eventLabelField, hiddenEventIds]);

    // Role options come from the Rôles table, narrowed to one category (default "accueil"), so the
    // dispatcher is never offered a role from another team. Falls back to the field's own select
    // choices when no Rôles table is configured.
    const roleChoices = useMemo(() => {
        // Best case: the Rôles table is exposed to the interface, so it can be filtered by category.
        if (rolesTable) {
            const wanted = normalizeToken(roleCategoryValue ?? DEFAULT_ROLE_CATEGORY);
            return roleRecords
                .filter((r) => {
                    if (!roleCategoryField || !wanted) return true;
                    return readTextValues(r, roleCategoryField).some(
                        (v) => normalizeToken(v) === wanted,
                    );
                })
                .map((r) => ({id: r.id, name: r.name}))
                .sort((a, b) => compareCategories(a.name, b.name));
        }

        // Usual case: Rôles is a link to a table the interface does not expose, so it cannot be read
        // — and fetchForeignRecordsAsync would return every role in the base, category included.
        // The roles already linked from equipe_accueil ARE the front-of-house ones, by construction.
        if (categoryField?.config.type === FieldType.MULTIPLE_RECORD_LINKS) {
            const byId = new Map();
            for (const r of staffRecords) {
                const links = r.getCellValue(categoryField);
                if (!Array.isArray(links)) continue;
                for (const link of links) {
                    if (link?.id && link.name && !byId.has(link.id)) {
                        byId.set(link.id, {id: link.id, name: link.name});
                    }
                }
            }
            return [...byId.values()].sort((a, b) => compareCategories(a.name, b.name));
        }

        return getFieldChoices(categoryField, base) ?? [];
    }, [
        rolesTable, roleRecords, roleCategoryField, roleCategoryValue,
        categoryField, staffRecords, base,
    ]);

    // Why the role dropdown is empty. Both "no Rôles table" and "no record matches the category"
    // fall back to a free-text input, so say which one it is.
    const roleDiagnostic = useMemo(() => {
        if (!rolesTable) {
            if (categoryField?.config.type === FieldType.MULTIPLE_RECORD_LINKS) {
                return (
                    'la table Rôles n’est pas exposée à l’interface, et aucun quart existant n’est ' +
                    'encore rattaché à un rôle : il n’y a donc rien à proposer. Rattachez un rôle à ' +
                    'un quart dans Airtable, ou ajoutez la table Rôles aux sources de l’interface.'
                );
            }
            return `champ Catégorie « ${categoryField?.name} » sans valeurs proposables.`;
        }
        const wanted = roleCategoryValue ?? DEFAULT_ROLE_CATEGORY;
        if (!roleCategoryField) {
            return `« Catégorie du rôle » n’est pas renseigné dans les réglages : impossible de filtrer les ${roleRecords.length} rôles de « ${rolesTable.name} ».`;
        }
        const seen = new Set(
            roleRecords.flatMap((r) => readTextValues(r, roleCategoryField)),
        );
        return `aucun des ${roleRecords.length} rôles de « ${rolesTable.name} » n’a la catégorie « ${wanted} » (champ « ${roleCategoryField.name} » ; valeurs trouvées : ${[...seen].join(', ') || 'aucune'}).`;
    }, [rolesTable, roleRecords, roleCategoryField, roleCategoryValue, categoryField]);

    // Only the In/Out pairs that are configured AND are real DURATION fields can be written.
    const writablePairs = useMemo(
        () =>
            SHIFT_PAIRS.filter((p) => {
                const fIn = customPropertyValueByKey[p.inKey];
                const fOut = customPropertyValueByKey[p.outKey];
                return (
                    fIn?.config.type === FieldType.DURATION &&
                    fOut?.config.type === FieldType.DURATION
                );
            }),
        [customPropertyValueByKey],
    );

    // Contacts also holds producers, venue teams, etc.: only employees can take a shift.
    const contactOptions = useMemo(() => {
        if (!contactsTable) return [];
        const wanted = normalizeToken(contactCategoryValue ?? DEFAULT_CONTACT_CATEGORY);
        return contactRecords
            .filter((r) => {
                if (!contactCategoryField || !wanted) return true;
                return readTextValues(r, contactCategoryField).some(
                    (v) => normalizeToken(v) === wanted,
                );
            })
            .map((r) => ({id: r.id, name: r.name}))
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    }, [contactsTable, contactRecords, contactCategoryField, contactCategoryValue]);

    // Two silent failures to surface: the filter never applied (property unset — every contact is
    // offered), or it applied and matched nothing (which looks like "no contacts at all").
    const contactDiagnostic = useMemo(() => {
        if (!contactsTable) return null;
        if (!contactCategoryField) {
            return 'filtre inactif : la propriété « Catégorie de contact » n’est pas renseignée dans les réglages de l’extension — tous les contacts sont proposés.';
        }
        if (contactOptions.length) return null;
        const seen = new Set(
            contactRecords.flatMap((r) => readTextValues(r, contactCategoryField)),
        );
        const wanted = contactCategoryValue ?? DEFAULT_CONTACT_CATEGORY;
        return `aucun des ${contactRecords.length} contacts n’a la catégorie « ${wanted} » (champ « ${contactCategoryField.name} » ; valeurs trouvées : ${[...seen].join(', ') || 'aucune'}).`;
    }, [contactsTable, contactOptions, contactRecords, contactCategoryField, contactCategoryValue]);

    // Availabilities submitted from the portal, indexed by day then by contact. Employees declare
    // a whole day (with an optional time window) and never a role — the dispatch is the operations
    // director's call — so this only reorders the dropdown, it never preselects anyone.
    const availabilityByDay = useMemo(() => {
        const byDay = new Map();
        if (!availabilityTable || !availabilityDateField || !availabilityContactLinkField) {
            return byDay;
        }
        for (const record of availabilityRecords) {
            const date = readDate(record, availabilityDateField);
            if (!date) continue;
            const dayIso = fmtDate(date);
            const start = availabilityStartField
                ? readDurationSeconds(record, availabilityStartField)
                : null;
            const end = availabilityEndField
                ? readDurationSeconds(record, availabilityEndField)
                : null;
            let byContact = byDay.get(dayIso);
            if (!byContact) byDay.set(dayIso, (byContact = new Map()));
            for (const contactId of readLinkedIds(record, availabilityContactLinkField)) {
                // Two records for the same contact and day shouldn't happen (the portal saves one
                // per day), but if they do the windows are merged rather than one silently winning.
                const previous = byContact.get(contactId);
                byContact.set(
                    contactId,
                    previous
                        ? {
                            start: previous.start === null || start === null
                                ? null
                                : Math.min(previous.start, start),
                            end: previous.end === null || end === null
                                ? null
                                : Math.max(previous.end, end),
                        }
                        : {start, end},
                );
            }
        }
        return byDay;
    }, [
        availabilityTable, availabilityRecords, availabilityDateField,
        availabilityContactLinkField, availabilityStartField, availabilityEndField,
    ]);

    // === PUBLISHING THE SCHEDULE ===

    // The collective agreement's 14-day periods, oldest first. Publishing targets one of these
    // explicitly rather than "whatever the grid is showing": the grid navigates in 1- or 2-week
    // steps, so a period could otherwise be published by halves without anyone noticing.
    const canPublish = Boolean(
        periodesTable && periodeDebutField && periodeFinField &&
        publicationsTable && publicationPeriodeField && publicationContenuField,
    );

    // Silence is the wrong answer here. With the row hidden and nothing said, a misconfigured
    // extension looks identical to one where the feature was never wanted — which is exactly how
    // a missing table wastes an afternoon. Said only once a table IS picked: an extension that
    // does not publish at all should stay quiet.
    const publishDiagnostic = useMemo(() => {
        if (!periodesTable && !publicationsTable) return null;
        const missing = [];
        if (!periodesTable) missing.push('la table Périodes');
        else {
            if (!periodeDebutField) missing.push('« Premier jour de la période »');
            if (!periodeFinField) missing.push('« Dernier jour de la période »');
        }
        if (!publicationsTable) missing.push('la table Publications');
        else {
            if (!publicationPeriodeField) missing.push('« Lien Période »');
            if (!publicationContenuField) missing.push('« Contenu de l’instantané »');
        }
        if (!missing.length) return null;
        return `Publication indisponible : ${missing.join(', ')} ${missing.length > 1 ? 'ne sont pas renseignés' : 'n’est pas renseigné'} dans les réglages. Une table créée après la configuration de l’extension doit d’abord être ajoutée au panneau Données pour y apparaître.`;
    }, [
        periodesTable, periodeDebutField, periodeFinField,
        publicationsTable, publicationPeriodeField, publicationContenuField,
    ]);

    const periodes = useMemo(() => {
        if (!periodesTable || !periodeDebutField || !periodeFinField) return [];
        return periodeRecords
            .map((r) => {
                const debut = readDate(r, periodeDebutField);
                const fin = readDate(r, periodeFinField);
                if (!debut || !fin) return null;
                return {
                    id: r.id,
                    record: r,
                    debut,
                    fin,
                    label: periodeLabelField
                        ? r.getCellValueAsString(periodeLabelField).trim()
                        : `${fmtDate(debut)} → ${fmtDate(fin)}`,
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.debut - b.debut);
    }, [periodesTable, periodeRecords, periodeDebutField, periodeFinField, periodeLabelField]);

    const [selectedPeriodeId, setSelectedPeriodeId] = useState(null);

    // Default to the period covering today, falling back to the next one to come: on the day the
    // dispatcher opens the grid, that is the period being worked on.
    const effectivePeriode = useMemo(() => {
        if (!periodes.length) return null;
        const chosen = periodes.find((p) => p.id === selectedPeriodeId);
        if (chosen) return chosen;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return (
            periodes.find((p) => today >= p.debut && today <= p.fin) ??
            periodes.find((p) => p.debut >= today) ??
            periodes[periodes.length - 1] ??
            null
        );
    }, [periodes, selectedPeriodeId]);

    // Most recent publication of the selected period — what the portal is currently showing.
    const lastPublication = useMemo(() => {
        if (!publicationsTable || !publicationPeriodeField || !effectivePeriode) return null;
        const forPeriode = publicationRecords.filter((r) =>
            readLinkedIds(r, publicationPeriodeField).includes(effectivePeriode.id),
        );
        if (!forPeriode.length) return null;
        const stamped = forPeriode
            .map((r) => ({
                record: r,
                at: publicationDateField ? readDateTime(r, publicationDateField) : null,
                by: publicationAuteurField
                    ? r.getCellValueAsString(publicationAuteurField).trim()
                    : '',
            }))
            .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
        return stamped[0];
    }, [
        publicationsTable, publicationRecords, publicationPeriodeField,
        publicationDateField, publicationAuteurField, effectivePeriode,
    ]);

    // The frozen copy the portal will render. Built from what is on screen at click time, never
    // read again afterwards: a later edit to a shift does not change a publication.
    const buildSnapshot = useCallback(
        (periode) => {
            const eventById = new Map(eventRecords.map((r) => [r.id, r]));
            const rows = [];
            for (const r of staffRecords) {
                const date = readShiftDate(r);
                if (!date || date < periode.debut || date > periode.fin) continue;

                const eventId = staffEventLinkField
                    ? readLinkedIds(r, staffEventLinkField)[0] ?? null
                    : null;
                const eventRecord = eventId ? eventById.get(eventId) : null;
                const label = eventRecord
                    ? eventRecord.getCellValueAsString(eventLabelField).trim()
                    : '';

                // The published block's own In/Out. Falls back to the whole span only if that
                // block is not configured — better a wide range than no hours at all.
                const pair = SHIFT_PAIRS.find((x) => x.key === publishedPair);
                const pairIn = pair ? customPropertyValueByKey[pair.inKey] : null;
                const pairOut = pair ? customPropertyValueByKey[pair.outKey] : null;
                const pairStart = pairIn ? readDurationSeconds(r, pairIn) : null;
                const pairEnd = pairOut ? readDurationSeconds(r, pairOut) : null;

                const ins =
                    pairStart !== null
                        ? [pairStart]
                        : pairIn
                            ? []
                            : inFields.map((f) => readDurationSeconds(r, f)).filter((v) => v !== null);
                const outs =
                    pairEnd !== null
                        ? [pairEnd]
                        : pairOut
                            ? []
                            : outFields.map((f) => readDurationSeconds(r, f)).filter((v) => v !== null);

                rows.push({
                    date: fmtDate(date),
                    evenement: label ? splitEventLabel(label).title : '',
                    salle:
                        eventRecord && salleField
                            ? eventRecord.getCellValueAsString(salleField).trim()
                            : '',
                    role: r.getCellValueAsString(categoryField).trim(),
                    nom: r.getCellValueAsString(contactField).trim(),
                    debut: ins.length ? fmtHHMM(Math.min(...ins)) : '',
                    fin: outs.length ? fmtHHMM(Math.max(...outs)) : '',
                });
            }
            rows.sort(
                (a, b) =>
                    a.date.localeCompare(b.date) ||
                    a.debut.localeCompare(b.debut) ||
                    a.nom.localeCompare(b.nom, 'fr'),
            );
            return rows;
        },
        [
            staffRecords, eventRecords, readShiftDate, staffEventLinkField, eventLabelField,
            salleField, categoryField, contactField, inFields, outFields,
            publishedPair, customPropertyValueByKey,
        ],
    );

    const handlePublish = async () => {
        if (!effectivePeriode) return;
        const rows = buildSnapshot(effectivePeriode);
        if (!rows.length) {
            setFeedback({
                type: 'error',
                message: `Aucun quart sur ${effectivePeriode.label} : rien à publier.`,
            });
            return;
        }

        const now = new Date();
        const fields = {
            [publicationPeriodeField.id]: [{id: effectivePeriode.id}],
            [publicationContenuField.id]: JSON.stringify(rows),
        };
        if (publicationLabelField) {
            fields[publicationLabelField.id] =
                `${effectivePeriode.label} — ${fmtDate(now)} ${fmtHHMM(
                    now.getHours() * 3600 + now.getMinutes() * 60,
                )}`;
        }
        if (publicationDateField) fields[publicationDateField.id] = now.toISOString();
        if (publicationAuteurField) {
            fields[publicationAuteurField.id] = session.currentUser?.name ?? '';
        }
        // The team tag decides which portal reads this publication. Refusing to publish untagged
        // is deliberate: an untagged row is invisible to a portal that filters by team, so the
        // dispatcher would believe the schedule is out while nobody can see it.
        if (publicationEquipeField) {
            const wanted = normalizeToken(publicationEquipeValue ?? DEFAULT_PUBLICATION_TEAM);
            const choices = getFieldChoices(publicationEquipeField, base) ?? [];
            const choice = choices.find((c) => normalizeToken(c.name) === wanted);
            if (!choice) {
                setFeedback({
                    type: 'error',
                    message: `Équipe « ${publicationEquipeValue ?? DEFAULT_PUBLICATION_TEAM} » introuvable dans le champ « ${publicationEquipeField.name} » (valeurs : ${choices.map((c) => c.name).join(', ') || 'aucune'}). Publication annulée : sans équipe, le portail ne verrait rien.`,
                });
                return;
            }
            fields[publicationEquipeField.id] = {id: choice.id};
        }

        const check = publicationsTable.checkPermissionsForCreateRecord(fields);
        if (!check.hasPermission) {
            setFeedback({
                type: 'error',
                message: check.reasonDisplayString ?? 'Publication refusée.',
            });
            return;
        }

        setSaving(true);
        try {
            await publicationsTable.createRecordAsync(fields);
            setFeedback({
                type: 'success',
                message: `${rows.length} quart${rows.length > 1 ? 's' : ''} publié${
                    rows.length > 1 ? 's' : ''
                } pour ${effectivePeriode.label}.`,
            });
        } catch (err) {
            setFeedback({type: 'error', message: `Échec de la publication : ${err.message}`});
        } finally {
            setSaving(false);
        }
    };

    // The table is configured but unusable: without a day or a contact link there is nothing to
    // match on, and the dropdown silently stays flat.
    const availabilityDiagnostic = useMemo(() => {
        if (!availabilityTable) return null;
        const missing = [];
        if (!availabilityDateField) missing.push('« Jour de la disponibilité »');
        if (!availabilityContactLinkField) missing.push('« Lien Contact »');
        if (!missing.length) return null;
        return `disponibilités non prises en compte : ${missing.join(' et ')} ${missing.length > 1 ? 'ne sont pas renseignés' : 'n’est pas renseigné'} dans les réglages de l’extension.`;
    }, [availabilityTable, availabilityDateField, availabilityContactLinkField]);

    // Coarse checks: they decide whether the affordance is shown at all. The precise, field-aware
    // check happens right before each write (field-level restrictions only surface there).
    // Why creation is unavailable. Surfaced in the UI: a silently missing button is impossible to
    // diagnose, and every one of these causes is fixed in the settings panel or in Airtable.
    const createBlockers = useMemo(() => {
        if (!configured) return ['Extension non configurée.'];
        const reasons = [];
        // Shifts are created for a day and dispatched to an event later, so their date cannot come
        // from the event rollup: they need a date field of their own.
        if (!staffDateWriteField) {
            reasons.push(
                'aucun champ « Date du quart — champ inscriptible ». `date_courte` est un cumul de ' +
                    'la date de l’événement : tant qu’un quart n’est rattaché à aucun événement, il ' +
                    'n’a pas de date. Ajoutez un champ de type Date sur la table des quarts, puis ' +
                    'sélectionnez-le dans les réglages.',
            );
        }
        if (!writablePairs.length) {
            const pairs = SHIFT_PAIRS.map((p) => {
                const fIn = customPropertyValueByKey[p.inKey];
                const fOut = customPropertyValueByKey[p.outKey];
                const describe = (f) => (f ? `${f.name} [${f.config.type}]` : 'non configuré');
                return `${p.label} → In: ${describe(fIn)} / Out: ${describe(fOut)}`;
            });
            reasons.push(
                'aucune paire In/Out de type Durée. Les heures ne peuvent être écrites que dans ' +
                    `des champs « Duration ». État actuel — ${pairs.join(' ; ')}.`,
            );
        }
        // Permissions are decided by Airtable, not by the SDK: surface its own reason verbatim
        // rather than a generic message.
        const check = staffTable.checkPermissionsForCreateRecords();
        if (!check.hasPermission) {
            reasons.push(
                `création refusée par Airtable — ${check.reasonDisplayString ?? 'raison non fournie'}`,
            );
        }
        return reasons;
    }, [configured, staffDateWriteField, writablePairs, customPropertyValueByKey, staffTable]);

    const canCreate = createBlockers.length === 0;
    // Editing a shift covers its hours, its contact and its event. Hours only need write permission
    // and a DURATION pair; the contact select additionally needs the Contacts table and its link.
    const editBlockers = useMemo(() => {
        if (!configured) return ['Extension non configurée.'];
        const reasons = [];
        if (!writablePairs.length) {
            reasons.push('aucune paire In/Out de type Durée : les horaires ne sont pas modifiables.');
        }
        const check = staffTable.checkPermissionsForUpdateRecord();
        if (!check.hasPermission) {
            reasons.push(
                `modification refusée par Airtable — ${check.reasonDisplayString ?? 'raison non fournie'}`,
            );
        }
        return reasons;
    }, [configured, writablePairs, staffTable]);

    const canEdit = editBlockers.length === 0;

    // The event link is silent when misconfigured: the chip just falls back to expandRecord. Say so.
    const detailUrlWarning = useMemo(() => {
        if (!detailUrlTemplate) return null;
        if (!detailLinkField) {
            return 'Fiche projet : la propriété « Lien Projet (sur Événements) » n’est pas renseignée.';
        }
        if (!buildRecordDetailUrl(detailUrlTemplate, 'recXXXXXXXXXXXXXX')) {
            return `Fiche projet : URL non exploitable (${detailUrlTemplate.length} caractères recollés). Airtable coupe chaque propriété à 255 caractères : vérifiez que la partie 2/2 reprend exactement là où la partie 1/2 s’arrête, sans espace ni caractère perdu.`;
        }
        return null;
    }, [detailUrlTemplate, detailLinkField]);
    const canAssignContact = Boolean(contactsTable && contactLinkField);
    const canTogglePortal = Boolean(portalField) && eventsTable.hasPermissionToUpdateRecord();

    // The checkbox is hidden by any one of several conditions; name the missing one.
    const portalWarning = useMemo(() => {
        if (!portalField) {
            return 'Portail : la propriété « Case Portail (sur les événements) » n’est pas renseignée (ou le champ n’est pas exposé à l’extension).';
        }
        const check = eventsTable.checkPermissionsForUpdateRecord();
        if (!check.hasPermission) {
            return `Portail : Airtable refuse la modification des événements — ${check.reasonDisplayString ?? 'raison non fournie'}. Activez la modification des enregistrements Événements sur l’élément d’extension.`;
        }
        return null;
    }, [portalField, eventsTable]);

    const togglePortal = async (record, next) => {
        const fields = {[portalField.id]: next};
        const check = eventsTable.checkPermissionsForUpdateRecord(record, fields);
        if (!check.hasPermission) {
            setFeedback({type: 'error', message: check.reasonDisplayString ?? 'Modification refusée.'});
            return;
        }
        try {
            await eventsTable.updateRecordAsync(record, fields);
        } catch (err) {
            setFeedback({type: 'error', message: `Échec Portail : ${err.message}`});
        }
    };

    // Preselect the plain usher role: "senior" variants also contain "placier", so exclude them.
    const defaultRoleId = useMemo(() => {
        const matches = roleChoices.filter((c) =>
            normalizeToken(c.name).includes(DEFAULT_ROLE_NEEDLE),
        );
        const plain = matches.find((c) => !normalizeToken(c.name).includes('senior'));
        return (plain ?? matches[0] ?? roleChoices[0])?.id ?? '';
    }, [roleChoices]);

    const openCreatePanel = () => {
        setFeedback(null);
        setPanel({
            mode: 'create',
            dayIso: fmtDate(new Date(effectiveWeekMs)),
            roleId: defaultRoleId,
            roleText: '',
            pair: writablePairs.some((p) => p.key === 'showcall')
                ? 'showcall'
                : writablePairs[0]?.key,
            start: '18:00',
            end: '22:00',
            quantity: 1,
        });
    };

    // A shift may have several pairs filled at once (Montage AND Show call AND Démontage), so the
    // panel prefills all of them rather than guessing which single range the user meant.
    const openEditPanel = (record) => {
        setFeedback(null);
        const date = readShiftDate(record);
        const times = {};
        for (const pair of writablePairs) {
            times[pair.key] = {
                start: fmtHHMM(readDurationSeconds(record, customPropertyValueByKey[pair.inKey])),
                end: fmtHHMM(readDurationSeconds(record, customPropertyValueByKey[pair.outKey])),
            };
        }
        // The role prefills from the record itself. A value the dropdown does not offer (a role
        // never linked elsewhere, so absent from roleChoices) would make the select show its first
        // option and silently reassign the shift on save, so fall back to no selection.
        const roleId = readRoleChoiceId(record, categoryField);
        setPanel({
            mode: 'edit',
            recordId: record.id,
            dayIso: date ? fmtDate(date) : '',
            times,
            contactId: canAssignContact ? readLinkedIds(record, contactLinkField)[0] ?? '' : '',
            eventId: readLinkedIds(record, staffEventLinkField)[0] ?? '',
            roleId: roleChoices.some((c) => c.id === roleId) ? roleId : '',
            roleText: isRoleFreeText(categoryField)
                ? record.getCellValueAsString(categoryField)
                : '',
        });
    };

    const handleCreate = async () => {
        const startSec = parseHHMM(panel.start);
        const rawEnd = parseHHMM(panel.end);
        if (startSec === null || rawEnd === null) {
            setFeedback({type: 'error', message: 'Heures invalides (format attendu : HH:MM).'});
            return;
        }
        const pair = writablePairs.find((p) => p.key === panel.pair);
        if (!pair) {
            setFeedback({type: 'error', message: 'Aucun bloc de travail inscriptible.'});
            return;
        }
        const quantity = Math.max(1, Math.min(MAX_SHIFT_QUANTITY, Number(panel.quantity) || 1));
        const endSec = endSecondsWithWrap(startSec, rawEnd);

        const fields = {};
        fields[staffDateWriteField.id] = panel.dayIso; // DATE/DATE_TIME accept a YYYY-MM-DD string
        fields[customPropertyValueByKey[pair.inKey].id] = startSec; // DURATION = seconds
        fields[customPropertyValueByKey[pair.outKey].id] = endSec;
        // No event here: the shift is dispatched to one later, from the assignment panel.

        const choice = roleChoices.find((c) => c.id === panel.roleId) ?? null;
        const roleValue = roleWriteValue(categoryField, choice, panel.roleText);
        if (roleValue !== undefined) fields[categoryField.id] = roleValue;

        // The contact is deliberately left empty: these are open shifts, rendered yellow.

        const defs = Array.from({length: quantity}, () => ({fields: {...fields}}));
        const check = staffTable.checkPermissionsForCreateRecords(defs);
        if (!check.hasPermission) {
            setFeedback({type: 'error', message: check.reasonDisplayString ?? 'Création refusée.'});
            return;
        }

        setSaving(true);
        let created = 0;
        try {
            // Airtable rejects more than 50 records per call, and nothing is rolled back on a
            // partial failure, so report how many actually made it through.
            for (const batch of chunkArray(defs, MAX_RECORDS_PER_CALL)) {
                await staffTable.createRecordsAsync(batch);
                created += batch.length;
            }
            setPanel(null);
            setFeedback({
                type: 'success',
                message: `${created} quart${created > 1 ? 's' : ''} créé${created > 1 ? 's' : ''}.`,
            });
        } catch (err) {
            setFeedback({
                type: 'error',
                message: `Échec après ${created} quart(s) créé(s) : ${err.message}`,
            });
        } finally {
            setSaving(false);
        }
    };

    // Deleting is irreversible and Airtable asks for no confirmation of its own, so the button
    // arms itself first (`confirmDelete`) and only deletes on a second, deliberate click.
    const handleDelete = async () => {
        const record = staffRecords.find((r) => r.id === panel.recordId);
        if (!record) {
            setFeedback({type: 'error', message: 'Quart introuvable.'});
            return;
        }
        if (!panel.confirmDelete) {
            setPanel({...panel, confirmDelete: true});
            return;
        }

        const check = staffTable.checkPermissionsForDeleteRecord(record);
        if (!check.hasPermission) {
            setFeedback({
                type: 'error',
                message: check.reasonDisplayString ?? 'Suppression refusée.',
            });
            return;
        }

        setSaving(true);
        try {
            await staffTable.deleteRecordAsync(record);
            setPanel(null);
            setFeedback({type: 'success', message: 'Quart supprimé.'});
        } catch (err) {
            setFeedback({type: 'error', message: `Échec de la suppression : ${err.message}`});
        } finally {
            setSaving(false);
        }
    };

    const handleEdit = async () => {
        const record = staffRecords.find((r) => r.id === panel.recordId);
        if (!record) {
            setFeedback({type: 'error', message: 'Quart introuvable.'});
            return;
        }

        const fields = {};

        for (const pair of writablePairs) {
            const {start = '', end = ''} = panel.times[pair.key] ?? {};
            const inField = customPropertyValueByKey[pair.inKey];
            const outField = customPropertyValueByKey[pair.outKey];

            // Both empty: clear the pair. Otherwise both are required — a lone In or Out would
            // make the min-In/max-Out range meaningless.
            if (!start && !end) {
                fields[inField.id] = null;
                fields[outField.id] = null;
                continue;
            }
            const startSec = parseHHMM(start);
            const endSec = parseHHMM(end);
            if (startSec === null || endSec === null) {
                setFeedback({
                    type: 'error',
                    message: `${pair.label} : renseignez le début ET la fin (format HH:MM), ou videz les deux.`,
                });
                return;
            }
            fields[inField.id] = startSec;
            fields[outField.id] = endSecondsWithWrap(startSec, endSec);
        }

        if (Object.values(fields).every((v) => v === null)) {
            setFeedback({type: 'error', message: 'Un quart doit avoir au moins une plage horaire.'});
            return;
        }

        // Reassigning the role moves the shift to another category row. Written exactly like on
        // create: `roleWriteValue` yields undefined when nothing is selected, and the field is then
        // omitted so the current role survives untouched.
        const roleChoice = roleChoices.find((c) => c.id === panel.roleId) ?? null;
        const roleValue = roleWriteValue(categoryField, roleChoice, panel.roleText);
        if (roleValue !== undefined) fields[categoryField.id] = roleValue;

        // An empty selection must CLEAR the link, so always write the field: an empty array unlinks,
        // and skipping it would silently keep the previous value ("Non assigné" would do nothing).
        if (canAssignContact) {
            fields[contactLinkField.id] = panel.contactId ? [{id: panel.contactId}] : [];
        }
        if (staffEventLinkField) {
            fields[staffEventLinkField.id] = panel.eventId ? [{id: panel.eventId}] : [];
        }
        // The shift's project is the project of its event: derive it rather than ask for it.
        // Without it, the Projet interface page does not list the shift at all.
        if (staffProjectLinkField && detailLinkField) {
            const eventRecord = panel.eventId
                ? eventRecords.find((r) => r.id === panel.eventId)
                : null;
            const projectIds = eventRecord ? readLinkedIds(eventRecord, detailLinkField) : [];
            fields[staffProjectLinkField.id] = projectIds.map((id) => ({id}));
        }

        const check = staffTable.checkPermissionsForUpdateRecord(record, fields);
        if (!check.hasPermission) {
            setFeedback({
                type: 'error',
                message: check.reasonDisplayString ?? 'Modification refusée.',
            });
            return;
        }

        setSaving(true);
        try {
            await staffTable.updateRecordAsync(record, fields);
            setPanel(null);
            setFeedback({type: 'success', message: 'Quart mis à jour.'});
        } catch (err) {
            setFeedback({type: 'error', message: `Échec de la modification : ${err.message}`});
        } finally {
            setSaving(false);
        }
    };

    if (errorState) {
        return (
            <div className="p-4 text-sm text-red-red">
                {errorState.error?.message ?? 'Erreur de configuration'}
            </div>
        );
    }

    if (!configured) {
        return (
            <div className="p-4 text-sm text-gray-gray700 dark:text-gray-gray300">
                Configurez les tables et champs de l’extension (Événements, Équipe accueil, dates,
                contact, catégorie) dans le panneau de réglages.
            </div>
        );
    }

    const weekEnd = addDays(new Date(effectiveWeekMs), 7 * numWeeks - 1);
    const rowKeys = [EVENTS_ROW_KEY, ...categoryRows];
    const rowLabel = (key) =>
        key === EVENTS_ROW_KEY ? EVENTS_ROW_LABEL : key;
    const canExpand = (table) => table && table.hasPermissionToExpandRecords();

    return (
        <div className="p-4 text-gray-gray900 dark:text-gray-gray100" style={{zoom: 1.25}}>
            <div className="mb-3 flex items-center gap-2">
                <label className="text-sm text-gray-gray700 dark:text-gray-gray300">
                    Semaine à afficher :
                </label>
                <button
                    type="button"
                    onClick={() => shiftWeek(-1)}
                    aria-label="Semaine précédente"
                    className="inline-flex items-center justify-center rounded border border-gray-gray300 bg-white p-1.5 text-gray-gray700 hover:bg-gray-gray50 dark:border-gray-gray600 dark:bg-gray-gray800 dark:text-gray-gray200 dark:hover:bg-gray-gray700"
                >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                </button>
                <select
                    className="rounded border border-gray-gray300 bg-white px-2 py-1 text-sm dark:border-gray-gray600 dark:bg-gray-gray800"
                    value={effectiveWeekMs}
                    onChange={(e) => goToWeek(Number(e.target.value))}
                >
                    {weekOptions.map((ms) => {
                        const s = new Date(ms);
                        return (
                            <option key={ms} value={ms}>
                                {fmtDate(s)} au {fmtDate(addDays(s, 6))}
                            </option>
                        );
                    })}
                </select>
                <button
                    type="button"
                    onClick={() => shiftWeek(1)}
                    aria-label="Semaine suivante"
                    className="inline-flex items-center justify-center rounded border border-gray-gray300 bg-white p-1.5 text-gray-gray700 hover:bg-gray-gray50 dark:border-gray-gray600 dark:bg-gray-gray800 dark:text-gray-gray200 dark:hover:bg-gray-gray700"
                >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 18l6-6-6-6" />
                    </svg>
                </button>
                <button
                    type="button"
                    onClick={() => goToWeek(weekStart(new Date()).getTime())}
                    className="rounded border border-gray-gray300 bg-white px-2 py-1 text-sm dark:border-gray-gray600 dark:bg-gray-gray800 dark:text-gray-gray100"
                >
                    Aujourd’hui
                </button>
                <div className="ml-2 flex items-center gap-1">
                    {[1, 2].map((n) => (
                        <button
                            key={n}
                            type="button"
                            onClick={() => setNumWeeks(n)}
                            className={
                                'rounded border px-2 py-1 text-sm ' +
                                (numWeeks === n
                                    ? 'border-blue-blue bg-blue-blue text-white'
                                    : 'border-gray-gray300 bg-white text-gray-gray900 dark:border-gray-gray600 dark:bg-gray-gray800 dark:text-gray-gray100')
                            }
                        >
                            {n} semaine{n > 1 ? 's' : ''}
                        </button>
                    ))}
                </div>
                {canCreate && (
                    <button
                        type="button"
                        onClick={openCreatePanel}
                        className="ml-auto rounded border border-blue-blue bg-blue-blue px-2 py-1 text-sm font-medium text-white hover:opacity-90"
                    >
                        + Créer des quarts
                    </button>
                )}
            </div>

            {/* Publishing row. The period is picked explicitly — the grid navigates in 1- or
                2-week steps, so publishing "what is displayed" would cut a period in half. */}
            {publishDiagnostic && (
                <div className="mb-3 rounded border border-yellow-yellow bg-yellow-yellowLight2 px-3 py-2 text-xs text-gray-gray900">
                    {publishDiagnostic}
                </div>
            )}

            {canPublish && !effectivePeriode && (
                <div className="mb-3 rounded border border-yellow-yellow bg-yellow-yellowLight2 px-3 py-2 text-xs text-gray-gray900">
                    Publication indisponible : aucune période lisible dans « {periodesTable.name} ».
                    Vérifiez que les champs de dates sont visibles pour l’extension et que la table
                    contient les périodes de la convention.
                </div>
            )}

            {canPublish && effectivePeriode && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-gray-gray200 bg-gray-gray50 px-3 py-2 dark:border-gray-gray700 dark:bg-gray-gray800">
                    <label className="text-sm font-medium">Période</label>
                    <select
                        value={effectivePeriode.id}
                        onChange={(e) => setSelectedPeriodeId(e.target.value)}
                        className="rounded border border-gray-gray300 bg-white px-2 py-1 text-sm dark:border-gray-gray600 dark:bg-gray-gray800 dark:text-gray-gray100"
                    >
                        {periodes.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.label}
                            </option>
                        ))}
                    </select>

                    <button
                        type="button"
                        onClick={handlePublish}
                        disabled={saving}
                        className="rounded border border-blue-blue bg-blue-blue px-3 py-1 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                        {saving ? 'Publication…' : 'Sauvegarder'}
                    </button>

                    <span className="text-xs text-gray-gray600 dark:text-gray-gray400">
                        {lastPublication ? (
                            <>
                                Publié le {fmtDate(lastPublication.at ?? new Date())}
                                {lastPublication.at
                                    ? ` à ${fmtHHMM(
                                        lastPublication.at.getHours() * 3600 +
                                            lastPublication.at.getMinutes() * 60,
                                    )}`
                                    : ''}
                                {lastPublication.by ? ` par ${lastPublication.by}` : ''}
                            </>
                        ) : (
                            'Jamais publiée — les employés ne voient rien pour cette période.'
                        )}
                    </span>

                    {/* Said once, plainly: the snapshot is frozen on purpose, and a correction
                        made without clicking again is invisible to the employees. */}
                    <span className="w-full text-xs text-gray-gray500 dark:text-gray-gray400">
                        Sauvegarder fige l’horaire de la période et le publie dans le portail
                        employés. Une modification faite ensuite n’y apparaît qu’après une
                        nouvelle sauvegarde.
                    </span>
                </div>
            )}

            {feedback && (
                <div
                    className={
                        'mb-3 rounded border px-3 py-2 text-sm ' +
                        (feedback.type === 'error'
                            ? 'border-red-red bg-red-redLight2 text-gray-gray900'
                            : 'border-green-green bg-green-greenLight2 text-gray-gray900')
                    }
                >
                    {feedback.message}
                </div>
            )}

            {detailUrlWarning && (
                <div className="mb-3 rounded border border-yellow-yellow bg-yellow-yellowLight2 px-3 py-2 text-xs text-gray-gray900">
                    {detailUrlWarning}
                </div>
            )}

            {portalWarning && (
                <div className="mb-3 rounded border border-yellow-yellow bg-yellow-yellowLight2 px-3 py-2 text-xs text-gray-gray900">
                    {portalWarning}
                </div>
            )}

            {(!canCreate || !canEdit) && (
                <div className="mb-3 rounded border border-yellow-yellow bg-yellow-yellowLight2 px-3 py-2 text-xs text-gray-gray900">
                    {!canCreate && (
                        <>
                            <span className="font-semibold">Création de quarts indisponible :</span>
                            <ul className="mb-1 ml-4 list-disc">
                                {createBlockers.map((reason, i) => (
                                    <li key={i}>{reason}</li>
                                ))}
                            </ul>
                        </>
                    )}
                    {!canEdit && (
                        <>
                            <span className="font-semibold">Modification indisponible :</span>
                            <ul className="ml-4 list-disc">
                                {editBlockers.map((reason, i) => (
                                    <li key={i}>{reason}</li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            )}

            {panel?.mode === 'create' && (
                <CreateShiftsPanel
                    panel={panel}
                    setPanel={setPanel}
                    saving={saving}
                    onSubmit={handleCreate}
                    onCancel={() => setPanel(null)}
                    roleChoices={roleChoices}
                    roleDiagnostic={roleDiagnostic}
                    categoryField={categoryField}
                    writablePairs={writablePairs}
                />
            )}

            {panel?.mode === 'edit' && (
                <EditShiftPanel
                    panel={panel}
                    setPanel={setPanel}
                    saving={saving}
                    onSubmit={handleEdit}
                    onCancel={() => setPanel(null)}
                    onDelete={handleDelete}
                    canDelete={staffTable.hasPermissionToDeleteRecord()}
                    writablePairs={writablePairs}
                    canAssignContact={canAssignContact}
                    contactOptions={contactOptions}
                    contactDiagnostic={contactDiagnostic}
                    availabilityByDay={availabilityByDay}
                    availabilityDiagnostic={availabilityDiagnostic}
                    dayEvents={eventsByDayIso.get(panel.dayIso) ?? []}
                    hasEventLink={Boolean(staffEventLinkField)}
                    roleChoices={roleChoices}
                    roleDiagnostic={roleDiagnostic}
                    categoryField={categoryField}
                />
            )}

            <h1 className="mb-3 text-center font-display text-base font-semibold">
                Horaire du {fmtDate(new Date(effectiveWeekMs))} au {fmtDate(weekEnd)}
            </h1>

            <div className="overflow-x-auto">
                <table
                    className="w-full table-fixed border-collapse text-xs"
                    style={numWeeks > 1 ? {minWidth: `${112 + weekDays.length * 96}px`} : undefined}
                >
                    <thead>
                        <tr>
                            <th className="w-28 border border-gray-gray200 bg-gray-gray50 p-2 dark:border-gray-gray700 dark:bg-gray-gray800" />
                            {weekDays.map((d, i) => (
                                <th
                                    key={i}
                                    className="border border-gray-gray200 bg-gray-gray50 p-2 text-center font-semibold dark:border-gray-gray700 dark:bg-gray-gray800"
                                >
                                    <div>{DAY_LABELS_FR[i % 7]}</div>
                                    <div className="font-normal text-gray-gray600 dark:text-gray-gray400">
                                        {fmtDate(d)}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rowKeys.map((key) => {
                            const cells = grid.get(key) ?? Array.from({length: weekDays.length}, () => []);
                            const isEvent = key === EVENTS_ROW_KEY;
                            const table = isEvent ? eventsTable : staffTable;

                            // A shift opens the edit panel; an event opens its detail page in the
                            // interface, falling back to expandRecord when no URL is configured.
                            const renderEntry = (entry, j) => {
                                const editable = canEdit && !isEvent;
                                const detailUrl = isEvent ? entry.detailUrl : null;
                                const clickable =
                                    editable || Boolean(detailUrl) || canExpand(table);
                                const onClick = () => {
                                    if (editable) openEditPanel(entry.record);
                                    else if (!detailUrl && canExpand(table)) {
                                        expandRecord(entry.record);
                                    }
                                };
                                const className =
                                    'block rounded border px-1.5 py-1 leading-tight no-underline ' +
                                    (clickable ? 'cursor-pointer ' : '') +
                                    (entry.color
                                        ? 'border-transparent '
                                        : entry.highlight
                                            ? 'border-yellow-yellow bg-yellow-yellowLight1 text-gray-gray900 min-h-[1.5rem] '
                                            : 'border-gray-gray200 bg-white dark:border-gray-gray600 dark:bg-gray-gray800');
                                const style = entry.color
                                    ? {backgroundColor: entry.color.bg, color: entry.color.text}
                                    : undefined;
                                // An event reads as a title on its own line, then its time and
                                // venue underneath. A shift is a single line.
                                const content = isEvent ? (
                                    <>
                                        <div className="font-semibold">{entry.title}</div>
                                        {entry.meta && (
                                            <div className="opacity-75">{entry.meta}</div>
                                        )}
                                    </>
                                ) : (
                                    entry.text
                                );
                                // A real anchor, not window.open: the extension runs in a sandboxed
                                // iframe where popups are blocked.
                                const chip = detailUrl ? (
                                    <a
                                        href={detailUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="Ouvrir la fiche du projet"
                                        className={className}
                                        style={style}
                                    >
                                        {content}
                                    </a>
                                ) : (
                                    <div
                                        onClick={onClick}
                                        title={editable ? 'Modifier le quart' : undefined}
                                        className={className}
                                        style={style}
                                    >
                                        {content}
                                    </div>
                                );

                                // Events carry the Portail flag, toggled in place: it is what puts
                                // the event in the employee portal's Disponibilités tab. It sits
                                // beside the chip, not inside it, so the chip click still opens the
                                // side-sheet.
                                const showPortal =
                                    isEvent && entry.portal !== null && canTogglePortal;
                                if (!showPortal) {
                                    return (
                                        <div key={j} className="flex-1">
                                            {chip}
                                        </div>
                                    );
                                }
                                return (
                                    <div key={j} className="flex items-start gap-1">
                                        <button
                                            type="button"
                                            onClick={() => togglePortal(entry.record, !entry.portal)}
                                            title={
                                                entry.portal
                                                    ? 'Visible dans le portail employés — cliquer pour retirer'
                                                    : 'Absent du portail employés — cliquer pour publier'
                                            }
                                            className={
                                                'mt-0.5 shrink-0 cursor-pointer text-sm leading-none ' +
                                                (entry.portal
                                                    ? 'text-blue-blue'
                                                    : 'text-gray-gray400 hover:text-gray-gray600')
                                            }
                                        >
                                            {entry.portal ? '\u2691' : '\u2690'}
                                        </button>
                                        <div className="flex-1">{chip}</div>
                                    </div>
                                );
                            };

                            return (
                                <tr key={key}>
                                    <th className="border border-gray-gray200 bg-gray-gray50 p-2 text-center align-middle font-semibold dark:border-gray-gray700 dark:bg-gray-gray800">
                                        {rowLabel(key)}
                                    </th>
                                    {cells.map((entries, i) => (
                                        <td
                                            key={i}
                                            className="border border-gray-gray200 p-1 align-top dark:border-gray-gray700"
                                        >
                                            <div className="flex flex-col gap-1">
                                                {isEvent
                                                    ? entries.map(renderEntry)
                                                    : groupEntriesByEvent(entries).map((group) => (
                                                        <div key={group.key} className="flex flex-col gap-1">
                                                            <div
                                                                className={
                                                                    'truncate text-[10px] font-semibold leading-tight ' +
                                                                    (group.orphan
                                                                        ? 'text-orange-orange'
                                                                        : 'text-gray-gray500 dark:text-gray-gray400')
                                                                }
                                                                title={
                                                                    group.orphan
                                                                        ? 'Quarts sans événement : ils ne sont datés que dans cette extension'
                                                                        : group.label
                                                                }
                                                            >
                                                                {group.orphan ? '⚠ ' : ''}
                                                                {group.label}
                                                            </div>
                                                            {group.entries.map(renderEntry)}
                                                        </div>
                                                    ))}
                                            </div>
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot>
                        <tr>
                            <th className="border border-gray-gray200 bg-gray-gray50 p-2 text-center align-middle font-semibold dark:border-gray-gray700 dark:bg-gray-gray800">
                                Totaux
                            </th>
                            {dayTotals.map((t, i) => (
                                <td
                                    key={i}
                                    className="border border-gray-gray200 bg-gray-gray50 p-2 text-center align-top text-[11px] dark:border-gray-gray700 dark:bg-gray-gray800"
                                >
                                    {t.shifts === 0 && t.events === 0 ? (
                                        <span className="text-gray-gray400">—</span>
                                    ) : (
                                        <div className="flex flex-col leading-tight">
                                            {t.shifts > 0 && (
                                                <>
                                                    <span className="font-semibold">
                                                        {t.shifts} quart{t.shifts > 1 ? 's' : ''}
                                                    </span>
                                                    <span className="text-gray-gray600 dark:text-gray-gray400">
                                                        {(Math.round(t.hours * 10) / 10).toLocaleString('fr-FR')} h
                                                    </span>
                                                </>
                                            )}
                                            {t.open > 0 && (
                                                <span className="font-medium text-orange-orange">
                                                    {t.open} ouvert{t.open > 1 ? 's' : ''}
                                                </span>
                                            )}
                                            {t.events > 0 && (
                                                <span className="text-gray-gray600 dark:text-gray-gray400">
                                                    {t.events} évén.
                                                </span>
                                            )}
                                            {t.orphans > 0 && (
                                                <span className="font-medium text-orange-orange">
                                                    ⚠ {t.orphans} sans évén.
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </td>
                            ))}
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}

// === PANELS ===
//
// Rendered in normal flow rather than as a fixed-position modal: the root carries zoom: 1.25 and
// the extension runs in a height-constrained iframe, both of which misplace/clip a fixed overlay.

const FIELD_LABEL = 'mb-1 block text-xs font-medium text-gray-gray700 dark:text-gray-gray300';
const FIELD_INPUT =
    'w-full rounded border border-gray-gray300 bg-white px-2 py-1 text-sm dark:border-gray-gray600 dark:bg-gray-gray800 dark:text-gray-gray100';

// The action buttons sit at the end of the same row as the inputs, not on a line of their own.
function PanelShell({
    title, saving, submitLabel, onSubmit, onCancel, onDelete, deleteArmed, children,
}) {
    return (
        <div className="mb-3 rounded border border-gray-gray300 bg-gray-gray50 p-3 dark:border-gray-gray600 dark:bg-gray-gray800">
            <h2 className="mb-2 text-sm font-semibold">{title}</h2>
            <div className="flex flex-wrap items-end gap-3">
                {children}
                <div className="flex gap-2">
                    <button
                        type="button"
                        disabled={saving}
                        onClick={onSubmit}
                        className="rounded border border-blue-blue bg-blue-blue px-3 py-1 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                        {saving ? 'Enregistrement…' : submitLabel}
                    </button>
                    <button
                        type="button"
                        disabled={saving}
                        onClick={onCancel}
                        className="rounded border border-gray-gray300 bg-white px-3 py-1 text-sm disabled:opacity-50 dark:border-gray-gray600 dark:bg-gray-gray800 dark:text-gray-gray100"
                    >
                        Annuler
                    </button>
                    {onDelete && (
                        <button
                            type="button"
                            disabled={saving}
                            onClick={onDelete}
                            className={
                                'ml-4 rounded border px-3 py-1 text-sm disabled:opacity-50 ' +
                                (deleteArmed
                                    ? 'border-red-red bg-red-red font-medium text-white'
                                    : 'border-red-red bg-white text-red-red dark:bg-gray-gray800')
                            }
                        >
                            {deleteArmed ? 'Confirmer la suppression' : 'Supprimer'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function EventSelect({value, onChange, dayEvents, hasEventLink}) {
    if (!hasEventLink) return null;
    return (
        <div>
            <label className={FIELD_LABEL}>Événement</label>
            <select className={FIELD_INPUT} value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">— Aucun —</option>
                {dayEvents.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                        {ev.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

// Shared by both panels: a shift is created with a role, and reassigned to another one later.
// Falls back to a free-text input when the category field is text and no choices could be read,
// and to an explanation when the field cannot be written at all.
function RoleField({roleId, roleText, onChange, roleChoices, roleDiagnostic, categoryField}) {
    return (
        <div>
            <label className={FIELD_LABEL}>Rôle</label>
            {roleChoices.length > 0 ? (
                <select
                    className={FIELD_INPUT}
                    value={roleId}
                    onChange={(e) => onChange({roleId: e.target.value})}
                >
                    {/* Only when the shift's own role is not among the offered ones: leaving it
                        selected writes nothing, so the role stays as it is instead of being
                        silently swapped for the first option in the list. */}
                    {!roleChoices.some((c) => c.id === roleId) && (
                        <option value="">— Rôle actuel (non proposé) —</option>
                    )}
                    {roleChoices.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name}
                        </option>
                    ))}
                </select>
            ) : isRoleFreeText(categoryField) ? (
                <>
                    <input
                        type="text"
                        className={FIELD_INPUT}
                        value={roleText}
                        onChange={(e) => onChange({roleText: e.target.value})}
                    />
                    <p className="mt-1 max-w-[16rem] text-xs text-orange-orange">
                        Menu indisponible — {roleDiagnostic}
                    </p>
                </>
            ) : (
                <p className="max-w-[16rem] text-xs text-orange-orange">
                    {isRoleWritable(categoryField)
                        ? `Aucun rôle disponible — ${roleDiagnostic}`
                        : `Champ Catégorie non inscriptible (${categoryField?.config.type}) : le rôle ne sera pas renseigné.`}
                </p>
            )}
        </div>
    );
}

function CreateShiftsPanel({
    panel, setPanel, saving, onSubmit, onCancel,
    roleChoices, roleDiagnostic, categoryField, writablePairs,
}) {
    const set = (patch) => setPanel({...panel, ...patch});

    return (
        <PanelShell
            title="Créer des quarts"
            saving={saving}
            submitLabel="Créer"
            onSubmit={onSubmit}
            onCancel={onCancel}
        >
            <div>
                <label className={FIELD_LABEL}>Date</label>
                <input
                    type="date"
                    className={FIELD_INPUT}
                    value={panel.dayIso}
                    onChange={(e) => set({dayIso: e.target.value, eventId: ''})}
                />
            </div>

            <RoleField
                roleId={panel.roleId}
                roleText={panel.roleText}
                onChange={set}
                roleChoices={roleChoices}
                roleDiagnostic={roleDiagnostic}
                categoryField={categoryField}
            />

            <div>
                <label className={FIELD_LABEL}>Bloc de travail</label>
                <select
                    className={FIELD_INPUT}
                    value={panel.pair}
                    onChange={(e) => set({pair: e.target.value})}
                >
                    {writablePairs.map((p) => (
                        <option key={p.key} value={p.key}>
                            {p.label}
                        </option>
                    ))}
                </select>
            </div>

            <div>
                <label className={FIELD_LABEL}>Début</label>
                <input
                    type="time"
                    className={FIELD_INPUT}
                    value={panel.start}
                    onChange={(e) => set({start: e.target.value})}
                />
            </div>

            <div>
                <label className={FIELD_LABEL}>Fin</label>
                <input
                    type="time"
                    className={FIELD_INPUT}
                    value={panel.end}
                    onChange={(e) => set({end: e.target.value})}
                />
            </div>

            <div>
                <label className={FIELD_LABEL}>Nombre de quarts</label>
                <input
                    type="number"
                    min="1"
                    max={MAX_SHIFT_QUANTITY}
                    className={FIELD_INPUT}
                    value={panel.quantity}
                    onChange={(e) => set({quantity: e.target.value})}
                />
            </div>

            {/* No event picker here: shifts are created for a day and dispatched to an event later,
                from the assignment panel. */}
        </PanelShell>
    );
}

function EditShiftPanel({
    panel, setPanel, saving, onSubmit, onCancel, onDelete, canDelete, writablePairs,
    canAssignContact, contactOptions, contactDiagnostic, availabilityByDay,
    availabilityDiagnostic, dayEvents, hasEventLink,
    roleChoices, roleDiagnostic, categoryField,
}) {
    // Any edit disarms a pending delete confirmation: the armed button must not survive a change
    // of mind that lands on it.
    const set = (patch) => setPanel({...panel, ...patch, confirmDelete: false});
    const setTime = (pairKey, patch) =>
        set({times: {...panel.times, [pairKey]: {...panel.times[pairKey], ...patch}}});

    // The shift's own window: earliest In to latest Out across the filled pairs. Recomputed as the
    // hours are edited, so the dropdown re-ranks live while the dispatcher adjusts the times.
    const shiftWindow = useMemo(() => {
        let start = null;
        let end = null;
        for (const pair of writablePairs) {
            const s = parseHHMM(panel.times[pair.key]?.start);
            const e = parseHHMM(panel.times[pair.key]?.end);
            if (s === null || e === null) continue;
            const wrapped = endSecondsWithWrap(s, e);
            if (start === null || s < start) start = s;
            if (end === null || wrapped > end) end = wrapped;
        }
        return start === null ? null : {start, end};
    }, [panel.times, writablePairs]);

    // Three buckets: available and covering the shift's hours, available that day but outside them,
    // and everyone else. With no hours on the shift yet, the middle bucket cannot be decided and
    // every available employee lands in the first.
    const contactGroups = useMemo(() => {
        const byContact = availabilityByDay?.get(panel.dayIso);
        if (!byContact?.size) return {covering: [], partial: [], others: contactOptions};
        const covering = [];
        const partial = [];
        const others = [];
        for (const contact of contactOptions) {
            const window = byContact.get(contact.id);
            if (!window) {
                others.push(contact);
                continue;
            }
            // A missing bound is unbounded: a day submitted without hours means "all day".
            const covers =
                !shiftWindow ||
                ((window.start === null || window.start <= shiftWindow.start) &&
                    (window.end === null || window.end >= shiftWindow.end));
            (covers ? covering : partial).push({...contact, window});
        }
        return {covering, partial, others};
    }, [availabilityByDay, panel.dayIso, contactOptions, shiftWindow]);

    // Nobody submitted anything for that day: keep the plain alphabetical list rather than bury it
    // under a lone "Autres employés" heading.
    const hasAvailability =
        contactGroups.covering.length > 0 || contactGroups.partial.length > 0;

    return (
        <PanelShell
            title="Modifier le quart"
            saving={saving}
            submitLabel="Enregistrer"
            onSubmit={onSubmit}
            onCancel={onCancel}
            onDelete={canDelete ? onDelete : undefined}
            deleteArmed={Boolean(panel.confirmDelete)}
        >
            {/* All three pairs are shown: a shift can legitimately have more than one filled.
                Clearing both ends of a pair erases it. */}
            {writablePairs.map((pair) => (
                <div key={pair.key}>
                    <label className={FIELD_LABEL}>{pair.label}</label>
                    <div className="flex items-center gap-1">
                        <input
                            type="time"
                            className={FIELD_INPUT}
                            value={panel.times[pair.key]?.start ?? ''}
                            onChange={(e) => setTime(pair.key, {start: e.target.value})}
                        />
                        <span className="text-xs text-gray-gray500">→</span>
                        <input
                            type="time"
                            className={FIELD_INPUT}
                            value={panel.times[pair.key]?.end ?? ''}
                            onChange={(e) => setTime(pair.key, {end: e.target.value})}
                        />
                    </div>
                </div>
            ))}

            <RoleField
                roleId={panel.roleId}
                roleText={panel.roleText}
                onChange={set}
                roleChoices={roleChoices}
                roleDiagnostic={roleDiagnostic}
                categoryField={categoryField}
            />

            {canAssignContact && (
                <div>
                    <label className={FIELD_LABEL}>Contact</label>
                    <select
                        className={FIELD_INPUT}
                        value={panel.contactId}
                        onChange={(e) => set({contactId: e.target.value})}
                    >
                        <option value="">— Non assigné —</option>
                        {hasAvailability ? (
                            <>
                                {contactGroups.covering.length > 0 && (
                                    <optgroup label={`Disponibles (${contactGroups.covering.length})`}>
                                        {contactGroups.covering.map((c) => (
                                            <option key={c.id} value={c.id}>
                                                {c.name} — {fmtAvailabilityWindow(c.window)}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                {contactGroups.partial.length > 0 && (
                                    <optgroup label="Disponibles ce jour, hors plage du quart">
                                        {contactGroups.partial.map((c) => (
                                            <option key={c.id} value={c.id}>
                                                {c.name} — {fmtAvailabilityWindow(c.window)}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                {contactGroups.others.length > 0 && (
                                    <optgroup label="Autres employés">
                                        {contactGroups.others.map((c) => (
                                            <option key={c.id} value={c.id}>
                                                {c.name}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                            </>
                        ) : (
                            contactOptions.map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.name}
                                </option>
                            ))
                        )}
                    </select>
                    {contactDiagnostic && (
                        <p className="mt-1 max-w-[16rem] text-xs text-orange-orange">
                            {contactDiagnostic}
                        </p>
                    )}
                    {availabilityDiagnostic && (
                        <p className="mt-1 max-w-[16rem] text-xs text-orange-orange">
                            {availabilityDiagnostic}
                        </p>
                    )}
                </div>
            )}

            <EventSelect
                value={panel.eventId}
                onChange={(eventId) => set({eventId})}
                dayEvents={dayEvents}
                hasEventLink={hasEventLink}
            />
        </PanelShell>
    );
}

initializeBlock({interface: () => <ScheduleGridApp />});
