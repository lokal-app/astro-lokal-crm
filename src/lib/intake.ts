import "server-only";
import { pool } from "@/lib/db";
import { findDuplicateLead, logDuplicate, normalizeContact } from "@/lib/dedup";
import { appendAudit } from "@/lib/helpers";
import { resolvePriority } from "@/lib/actions/leads-actions";

// Shared intake pipeline — the single implementation behind both the public
// /api/intake-lead route (Google Forms Apps Script, Pabbly, any external
// poster) and the in-process sheet sync (sheet-sync-actions.ts). Port of
// backend/routes/intake-lead.js, rebuilt on the app's own dedup helpers so
// the codebase has exactly one dedup rule (findDuplicateLead) instead of two
// divergent copies.
//
// Response wording and audit-log strings intentionally match the backend
// service byte-for-byte — Recent Activity renders "Duplicate blocked — …"
// entries specially, and external callers key off the same JSON shapes the
// Supabase Edge Function returned.

export type IntakeResult =
  | { kind: "invalid"; error: string }
  | { kind: "blocked"; reason: string; matched_lead_id: string }
  | { kind: "created"; id: string; lead_id: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function optStr(v: unknown): string | null {
  return str(v) || null;
}

/** One question/answer pair from a Google Form submission, in form order. */
export type FormResponseEntry = { question: string; answer: string };

// Max pairs kept per submission — a guard against oversized payloads, well
// above any real form.
const MAX_FORM_RESPONSE_ENTRIES = 300;

/**
 * Normalises the Apps Script's optional `form_response` object ({ question:
 * answer }, text answers only) into an ordered array. Stored as an array, not
 * the object as-is, because JSONB re-sorts object keys and the form's
 * question order would be lost. Non-string/empty answers are dropped.
 */
function parseFormResponse(v: unknown): FormResponseEntry[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const entries: FormResponseEntry[] = [];
  for (const [question, answer] of Object.entries(v as Record<string, unknown>)) {
    if (typeof answer !== "string" || !question.trim() || !answer.trim()) continue;
    entries.push({ question: question.trim(), answer: answer.trim() });
    if (entries.length >= MAX_FORM_RESPONSE_ENTRIES) break;
  }
  return entries;
}

function generateLeadId() {
  return `REF-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export async function intakeLead(payload: Record<string, unknown>): Promise<IntakeResult> {
  const name = str(payload.name);
  const rawContact = str(payload.contact);
  const source = str(payload.source);
  const email = optStr(payload.email);
  const city = optStr(payload.city);
  const language = optStr(payload.language);

  if (!name || !rawContact || !source) {
    return { kind: "invalid", error: "name, contact, and source are required" };
  }
  if (!normalizeContact(rawContact)) {
    return { kind: "invalid", error: "contact must be a valid 10-digit number" };
  }

  const dup = await findDuplicateLead(rawContact);
  if (dup.blocking && dup.match) {
    const reason = dup.reason === "active" ? "lead is still active" : "closed within cooldown period";
    await logDuplicate({
      incoming_name: name,
      incoming_contact: rawContact,
      incoming_source: source,
      matched_lead_id: dup.match.id,
      detected_by: "system",
      payload: { name, contact: rawContact, email, city, language, source },
    });
    await appendAudit(dup.match.id, `Duplicate blocked — ${name} (${rawContact})`, "system", {
      source,
      contact: rawContact,
      name,
      reason,
    });
    return { kind: "blocked", reason, matched_lead_id: dup.match.id };
  }

  const priority = await resolvePriority(source);
  const lead_id = generateLeadId();
  const { rows } = await pool.query<{ id: string; lead_id: string }>(
    `INSERT INTO leads (lead_id, name, contact, email, city, language, source, priority, current_stage, lead_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'calling_pending', $9)
     RETURNING id, lead_id`,
    [lead_id, name, rawContact, email, city, language, source, priority, new Date().toISOString().slice(0, 10)],
  );
  const inserted = rows[0];
  await appendAudit(inserted.id, `Lead created via ${source} form`, "system", {
    source,
    contact: rawContact,
    name,
  });

  // Full text-only Q&A snapshot from the Google Form Apps Script (new leads
  // only — never backfilled). Best-effort: the lead is already created, so a
  // failure here is logged and swallowed rather than failing the intake.
  // TODO(ops): form_responses has no automatic expiry — a scheduled cleanup
  // job should delete rows older than 1 YEAR (submitted_at < now() - interval
  // '1 year'). Deliberately not implemented in application code.
  const formResponse = parseFormResponse(payload.form_response);
  if (formResponse.length > 0) {
    try {
      await pool.query(`INSERT INTO form_responses (lead_id, response, submitted_at) VALUES ($1, $2, now())`, [
        inserted.id,
        JSON.stringify(formResponse),
      ]);
    } catch (err) {
      console.error(`form_responses insert failed for lead ${inserted.id}:`, err);
    }
  }

  return { kind: "created", id: inserted.id, lead_id: inserted.lead_id };
}
