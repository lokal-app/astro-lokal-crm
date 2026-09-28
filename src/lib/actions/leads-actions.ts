"use server";

import { z } from "zod";
import { pool } from "@/lib/db";
import { requireUser, requireRole, type Role } from "@/lib/auth";
import type { LeadRow, CallAttemptRow, QuestionRow, ExpertProfileRow, UserRow, InterviewRoundRow } from "@/lib/db-types";
import {
  appendAudit,
  transitionLead,
  poolMembers,
  recordStageAssignment,
  loadRoundConfig,
  loadLeadOwned,
} from "@/lib/helpers";
import { findDuplicateLead, logDuplicate, normalizeContact } from "@/lib/dedup";
import type { FormResponseEntry } from "@/lib/intake";

// ---------- Dashboard / reads ----------

export async function listMyLeads() {
  const u = await requireUser();
  const me = u.email;

  type OwnedRow = Pick<
    LeadRow,
    "id" | "lead_id" | "name" | "contact" | "source" | "priority" | "current_stage" | "current_owner_email" | "assigned_to_email" | "updated_at" | "lead_date"
  >;
  const { rows: owned } = await pool.query<OwnedRow>(
    `SELECT id, lead_id, name, contact, source, priority, current_stage, current_owner_email, assigned_to_email, updated_at, lead_date
     FROM leads WHERE current_owner_email = $1
     ORDER BY priority ASC, updated_at DESC
     LIMIT 1000`,
    [me],
  );

  const callingIds = owned.filter((l) => l.current_stage === "calling_pending").map((l) => l.id);
  const attemptsByLead = new Map<string, { n: number; outcome: string }[]>();
  if (callingIds.length > 0) {
    const { rows: atts } = await pool.query<Pick<CallAttemptRow, "lead_id" | "attempt_number" | "outcome" | "connected">>(
      `SELECT lead_id, attempt_number, outcome, connected FROM call_attempts WHERE lead_id = ANY($1::uuid[])`,
      [callingIds],
    );
    for (const a of atts) {
      const arr = attemptsByLead.get(a.lead_id) ?? [];
      arr.push({ n: a.attempt_number, outcome: a.outcome ?? (a.connected ? "connected" : "rnr") });
      attemptsByLead.set(a.lead_id, arr);
    }
  }

  type ActiveLead = OwnedRow & { bucket: string; attempts_logged: number };
  const active: ActiveLead[] = [];
  for (const l of owned) {
    let bucket = l.current_stage;
    let attempts_logged = 0;
    if (l.current_stage === "calling_pending") {
      const arr = (attemptsByLead.get(l.id) ?? []).sort((a, b) => a.n - b.n);
      attempts_logged = arr.length;
      const last = arr[arr.length - 1];
      if (last && ["connected", "junk", "not_interested", "failed", "dropped_off"].includes(last.outcome)) continue;
      if (arr.length >= 3) continue;
      bucket = `calling_pending_${arr.length + 1}`;
    } else if (!l.current_stage.endsWith("_pending")) {
      continue;
    }
    active.push({ ...l, bucket, attempts_logged });
  }

  const { num_rounds: numRounds } = await loadRoundConfig();

  return {
    cfg: { num_rounds: numRounds },
    active,
  };
}

export async function getLead(input: { id: string }) {
  const { id } = z.object({ id: z.string().uuid() }).parse(input);
  await requireUser();
  const { rows: leadRows } = await pool.query<LeadRow>(`SELECT * FROM leads WHERE id = $1`, [id]);
  const lead = leadRows[0];
  if (!lead) throw new Error("Lead not found");

  const [attemptsRes, statusRes, roundsRes, profileRes, assignmentsRes] = await Promise.all([
    pool.query<CallAttemptRow>(`SELECT * FROM call_attempts WHERE lead_id = $1 ORDER BY attempt_number`, [lead.id]),
    pool.query(`SELECT * FROM calling_status WHERE lead_id = $1`, [lead.id]),
    pool.query<InterviewRoundRow>(`SELECT * FROM interview_rounds WHERE lead_id = $1 ORDER BY round_number`, [lead.id]),
    pool.query<ExpertProfileRow>(`SELECT * FROM expert_profiles WHERE lead_id = $1`, [lead.id]),
    pool.query<{ stage: string; assigned_email: string }>(
      `SELECT stage, assigned_email FROM lead_stage_assignments WHERE lead_id = $1`,
      [lead.id],
    ),
  ]);
  const { num_rounds } = await loadRoundConfig();
  const { rows: users } = await pool.query<Pick<UserRow, "email" | "name">>(`SELECT email, name FROM users`);
  const names: Record<string, string> = Object.fromEntries(users.map((u) => [u.email, u.name]));

  return {
    lead,
    attempts: attemptsRes.rows,
    status: statusRes.rows[0] ?? null,
    rounds: roundsRes.rows,
    profile: profileRes.rows[0] ?? null,
    assignments: assignmentsRes.rows,
    cfg: { num_rounds },
    names,
  };
}

/**
 * The Google Form Q&A captured at intake for this lead, in form order, or
 * null if none (older leads, manual/CSV adds, forms on the old script).
 * TODO(ops): rows older than 1 YEAR should be removed by a scheduled cleanup
 * job — see the note in lib/intake.ts; no automatic deletion here.
 */
export async function getFormResponse(input: { lead_id: string }): Promise<FormResponseEntry[] | null> {
  const { lead_id } = z.object({ lead_id: z.string().uuid() }).parse(input);
  await requireUser();
  const { rows } = await pool.query<{ response: unknown }>(
    `SELECT response FROM form_responses WHERE lead_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
    [lead_id],
  );
  const response = rows[0]?.response;
  return Array.isArray(response) && response.length > 0 ? (response as FormResponseEntry[]) : null;
}

export async function getPool(input: { stage: string }) {
  const { stage } = z
    .object({ stage: z.enum(["calling", "round_1", "round_2", "round_3", "round_4", "expert_creation"]) })
    .parse(input);
  await requireUser();
  const members = await poolMembers(stage);
  const { rows: users } = await pool.query<Pick<UserRow, "email" | "name">>(
    `SELECT email, name FROM users WHERE email = ANY($1::text[])`,
    [members],
  );
  const names: Record<string, string> = Object.fromEntries(users.map((u) => [u.email, u.name]));
  return { members, names };
}

// The lead's current_stage value while each reassignable stage is the live,
// in-progress one — used to tell "still working this stage" apart from
// "already moved on" so reassign touches the right field either way.
const CURRENT_STAGE_FOR: Record<string, string> = {
  calling: "calling_pending",
  round_1: "round_1_pending",
  round_2: "round_2_pending",
  round_3: "round_3_pending",
  round_4: "round_4_pending",
  expert_creation: "profile_creation_pending",
};

/**
 * Reassigns who owns a specific, already-reached stage of one lead — used by
 * the Reassign control on the lead detail Timeline only. If the stage is
 * still the lead's live stage, this moves current_owner_email too (they
 * become the rightful current worker); otherwise it corrects whichever field
 * is the historical record for that stage (assigned_to_email for calling,
 * interview_rounds.conducted_by for a submitted round, expert_profiles.linked_by
 * for a linked profile) since that's what the Timeline actually displays for
 * a completed stage.
 */
export async function reassignStageOwner(input: { lead_id: string; stage: string; new_email: string }) {
  const data = z
    .object({
      lead_id: z.string().uuid(),
      stage: z.enum(["calling", "round_1", "round_2", "round_3", "round_4", "expert_creation"]),
      new_email: z.string().email().max(255),
    })
    .parse(input);
  const u = await requireUser();
  const newEmail = data.new_email.toLowerCase();

  const eligiblePool = await poolMembers(data.stage);
  if (!eligiblePool.includes(newEmail)) throw new Error("Selected person is not in this stage's pool");

  const { rows: leadRows } = await pool.query<Pick<LeadRow, "id" | "current_stage">>(
    `SELECT id, current_stage FROM leads WHERE id = $1`,
    [data.lead_id],
  );
  const lead = leadRows[0];
  if (!lead) throw new Error("Lead not found");

  const isCurrentStage = lead.current_stage === CURRENT_STAGE_FOR[data.stage];

  if (isCurrentStage) {
    await recordStageAssignment(lead.id, data.stage, newEmail, u.email);
    if (data.stage === "calling") {
      await pool.query(`UPDATE leads SET current_owner_email = $1, assigned_to_email = $1 WHERE id = $2`, [newEmail, lead.id]);
    } else {
      await pool.query(`UPDATE leads SET current_owner_email = $1 WHERE id = $2`, [newEmail, lead.id]);
      // A live round can already have an unsubmitted row (from a Round 1
      // reschedule) — move its conducted_by to the new owner. Only that
      // column: reschedule_count/history carry over as-is.
      if (data.stage.startsWith("round_")) {
        await pool.query(
          `UPDATE interview_rounds SET conducted_by = $1 WHERE lead_id = $2 AND round_number = $3 AND submitted_at IS NULL`,
          [newEmail, lead.id, Number(data.stage.slice("round_".length))],
        );
      }
    }
  } else if (data.stage === "calling") {
    await pool.query(`UPDATE leads SET assigned_to_email = $1 WHERE id = $2`, [newEmail, lead.id]);
  } else if (data.stage.startsWith("round_")) {
    const roundNumber = Number(data.stage.slice("round_".length));
    const { rows: roundRows } = await pool.query<{ id: string }>(
      `SELECT id FROM interview_rounds WHERE lead_id = $1 AND round_number = $2`,
      [lead.id, roundNumber],
    );
    const roundRow = roundRows[0];
    if (!roundRow) throw new Error(`Round ${roundNumber} hasn't been conducted yet`);
    await pool.query(`UPDATE interview_rounds SET conducted_by = $1 WHERE id = $2`, [newEmail, roundRow.id]);
  } else {
    const { rows: profileRows } = await pool.query<{ id: string }>(
      `SELECT id FROM expert_profiles WHERE lead_id = $1`,
      [lead.id],
    );
    const profileRow = profileRows[0];
    if (!profileRow) throw new Error("No expert profile exists for this lead yet");
    await pool.query(`UPDATE expert_profiles SET linked_by = $1 WHERE id = $2`, [newEmail, profileRow.id]);
  }

  await appendAudit(lead.id, `reassigned:${data.stage}`, u.email, { new_email: newEmail });
  return { ok: true };
}

const RETAKE_STAGES = ["calling", "round_1", "expert_creation", "round_2", "round_3", "round_4"] as const;

/**
 * Pipeline order, trimmed to the configured round count: Calling → Round 1 →
 * Expert Creation → Round 2 → … Round N. Retake wipes everything after the
 * retaken stage in this order.
 */
function stageSequence(numRounds: number): string[] {
  const later = Array.from({ length: Math.max(numRounds - 1, 0) }, (_, i) => `round_${i + 2}`);
  return ["calling", "round_1", "expert_creation", ...later];
}

/**
 * Resets an already-completed calling, round or Expert Creation stage back to in-progress —
 * used by the Retake control on the lead detail Timeline. It's a cascade:
 * every stage after the retaken one (in stageSequence order) is wiped first
 * — later interview_rounds rows (question_grades go with them via FK) and
 * the expert_profiles link if Expert Creation comes later — then the target
 * stage's own result is undone exactly as before (the latest call attempt +
 * calling_status for calling, the interview_rounds row for a round, or the
 * expert_profiles link + leads.drop_reason for Expert Creation), and
 * current_stage/current_owner_email move back to it. Stages before the target
 * (e.g. Round 1 when retaking Expert Creation) are never touched. All in one transaction
 * so a failure can't leave the lead half-reset.
 */
export async function retakeStage(input: { lead_id: string; stage: string }) {
  const data = z
    .object({ lead_id: z.string().uuid(), stage: z.enum(RETAKE_STAGES) })
    .parse(input);
  const u = await requireUser();

  const { rows: leadRows } = await pool.query<LeadRow>(`SELECT * FROM leads WHERE id = $1`, [data.lead_id]);
  const lead = leadRows[0];
  if (!lead) throw new Error("Lead not found");
  // Any retake cascades into the expert profile link, so a live Active
  // expert can never be retaken, whichever stage was asked for.
  if (lead.current_stage === "active") throw new Error("Cannot retake any stage — this lead is Active and live on the platform");

  const pendingStage = CURRENT_STAGE_FOR[data.stage];
  if (lead.current_stage === pendingStage) throw new Error("This stage is already in progress");

  const { num_rounds } = await loadRoundConfig();
  const sequence = stageSequence(num_rounds);
  const targetIdx = sequence.indexOf(data.stage);
  // A round beyond the current num_rounds (config lowered after it was taken)
  // has nothing configured after it — retake it alone, as before.
  const laterStages = targetIdx === -1 ? [] : sequence.slice(targetIdx + 1);

  const client = await pool.connect();
  const wipedStages: string[] = [];
  let nextOwner: string;
  try {
    await client.query("BEGIN");

    // 1. Wipe every later stage: its recorded result and its
    // lead_stage_assignments row, so nobody shows as assigned to it (Timeline
    // "Assigned to", People → Future Assigned) until the lead reaches it again.
    for (const stage of laterStages) {
      const result =
        stage === "expert_creation"
          ? await client.query(`DELETE FROM expert_profiles WHERE lead_id = $1`, [lead.id])
          : await client.query(`DELETE FROM interview_rounds WHERE lead_id = $1 AND round_number = $2`, [
              lead.id,
              Number(stage.slice("round_".length)),
            ]);
      const assignment = await client.query(`DELETE FROM lead_stage_assignments WHERE lead_id = $1 AND stage = $2`, [
        lead.id,
        stage,
      ]);
      if (result.rowCount || assignment.rowCount) wipedStages.push(stage);
    }

    // 2. Reset the target stage itself — unchanged from the non-cascade version.
    if (data.stage === "calling") {
      const { rows: attemptRows } = await client.query<{ id: string }>(
        `SELECT id FROM call_attempts WHERE lead_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
        [lead.id],
      );
      if (!attemptRows[0]) throw new Error("No call attempt has been logged yet");
      await client.query(`DELETE FROM call_attempts WHERE id = $1`, [attemptRows[0].id]);
      await client.query(`DELETE FROM calling_status WHERE lead_id = $1`, [lead.id]);
      nextOwner = lead.assigned_to_email ?? lead.current_owner_email ?? u.email;
      await client.query(
        `UPDATE leads SET current_stage = $1, current_owner_email = $2, assigned_to_email = $2, closed_at = NULL, drop_reason = NULL WHERE id = $3`,
        [pendingStage, nextOwner, lead.id],
      );
    } else if (data.stage === "expert_creation") {
      // Reached means either a linked profile or an Expert Creation drop.
      const { rows: profileRows } = await client.query<{ linked_by: string }>(
        `SELECT linked_by FROM expert_profiles WHERE lead_id = $1`,
        [lead.id],
      );
      const profile = profileRows[0];
      if (!profile && !lead.drop_reason) throw new Error("Expert Creation hasn't been completed or dropped yet");
      const { rows: assignRows } = await client.query<{ assigned_email: string }>(
        `SELECT assigned_email FROM lead_stage_assignments WHERE lead_id = $1 AND stage = 'expert_creation'`,
        [lead.id],
      );
      await client.query(`DELETE FROM expert_profiles WHERE lead_id = $1`, [lead.id]);
      nextOwner = profile?.linked_by ?? assignRows[0]?.assigned_email ?? lead.current_owner_email ?? u.email;
      await client.query(
        `UPDATE leads SET current_stage = $1, current_owner_email = $2, closed_at = NULL, drop_reason = NULL WHERE id = $3`,
        [pendingStage, nextOwner, lead.id],
      );
    } else {
      const roundNumber = Number(data.stage.slice("round_".length));
      const { rows: roundRows } = await client.query<{ id: string; conducted_by: string }>(
        `SELECT id, conducted_by FROM interview_rounds WHERE lead_id = $1 AND round_number = $2`,
        [lead.id, roundNumber],
      );
      const round = roundRows[0];
      if (!round) throw new Error(`Round ${roundNumber} hasn't been conducted yet`);
      await client.query(`DELETE FROM interview_rounds WHERE id = $1`, [round.id]);
      nextOwner = round.conducted_by ?? lead.current_owner_email ?? u.email;
      await client.query(
        `UPDATE leads SET current_stage = $1, current_owner_email = $2, closed_at = NULL, drop_reason = NULL WHERE id = $3`,
        [pendingStage, nextOwner, lead.id],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await appendAudit(lead.id, "retake_cascade", u.email, { retaken_stage: data.stage, wiped_stages: wipedStages });

  return { ok: true, wiped_stages: wipedStages };
}

// ---------- Telecaller ----------

export async function logCallOutcome(input: {
  lead_id: string;
  attempt_number: number;
  outcome: string;
  remarks?: string | null;
  next_owner_email?: string | null;
}) {
  const data = z
    .object({
      lead_id: z.string().uuid(),
      attempt_number: z.number().int().min(1).max(3),
      outcome: z.enum(["connected", "rnr", "reconnect", "junk", "not_interested", "failed", "dropped_off"]),
      remarks: z.string().max(2000).nullish(),
      next_owner_email: z.string().email().max(255).nullish(),
    })
    .parse(input);

  const u = await requireUser();
  const lead = await loadLeadOwned(data.lead_id, u.email);
  if (lead.current_stage !== "calling_pending") throw new Error("Lead is not in calling stage");
  if (
    (data.outcome === "junk" || data.outcome === "not_interested" || data.outcome === "failed" || data.outcome === "dropped_off") &&
    !data.remarks?.trim()
  )
    throw new Error("Remarks are required for Junk, Not Interested, Failed, or Dropped Off outcomes");

  const { rows: existing } = await pool.query<Pick<CallAttemptRow, "attempt_number" | "outcome" | "connected">>(
    `SELECT attempt_number, outcome, connected FROM call_attempts WHERE lead_id = $1 ORDER BY attempt_number`,
    [lead.id],
  );
  const last = existing[existing.length - 1];
  if (last) {
    const lastOutcome = last.outcome ?? (last.connected ? "connected" : "rnr");
    if (["connected", "junk", "not_interested"].includes(lastOutcome))
      throw new Error("Lead is already finalised — no more attempts allowed");
    if (last.attempt_number >= 3) throw new Error("All 3 attempts already logged");
  }
  if (data.attempt_number !== existing.length + 1)
    throw new Error(`Expected attempt #${existing.length + 1}, got #${data.attempt_number}`);

  let assignedKam: string | null = null;
  if (data.outcome === "connected") {
    if (!data.next_owner_email) throw new Error("Select who takes Round 1 before submitting");
    const target = data.next_owner_email.toLowerCase();
    const round1Pool = await poolMembers("round_1");
    if (!round1Pool.includes(target)) throw new Error("Selected person is not in the Round 1 pool");
    assignedKam = target;
  }

  // Remarks are optional for connected/rnr/reconnect but still stored per
  // attempt whenever given — calling_status only keeps the latest one.
  const remarks = data.remarks?.trim() || null;

  await pool.query(
    `INSERT INTO call_attempts (lead_id, attempt_number, connected, outcome, remarks, attempted_by, attempted_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (lead_id, attempt_number) DO UPDATE SET
       connected = EXCLUDED.connected, outcome = EXCLUDED.outcome, remarks = EXCLUDED.remarks,
       attempted_by = EXCLUDED.attempted_by, attempted_at = EXCLUDED.attempted_at`,
    [lead.id, data.attempt_number, data.outcome === "connected", data.outcome, remarks, u.email],
  );
  await appendAudit(lead.id, `attempt_${data.attempt_number}:${data.outcome}`, u.email, { remarks });

  await pool.query(
    `INSERT INTO calling_status (lead_id, status, remarks, assigned_kam_email, set_by, set_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (lead_id) DO UPDATE SET
       status = EXCLUDED.status, remarks = EXCLUDED.remarks, assigned_kam_email = EXCLUDED.assigned_kam_email,
       set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
    [lead.id, data.outcome, remarks, assignedKam, u.email],
  );

  if (data.outcome === "connected") {
    await recordStageAssignment(lead.id, "round_1", assignedKam!, u.email);
    await transitionLead(lead.id, "round_1_pending", assignedKam!, u.email);
  } else if (data.outcome === "junk" || data.outcome === "not_interested" || data.outcome === "failed" || data.outcome === "dropped_off") {
    await transitionLead(lead.id, data.outcome, lead.current_owner_email ?? u.email, u.email);
  } else if (data.attempt_number >= 3) {
    // 3rd RNR/Reconnect — no attempts remain. Previously this just left the
    // lead stuck in calling_pending forever with no terminal marker; now it
    // gets a real terminal stage so it (a) stops showing as pending anywhere
    // and (b) becomes eligible for dedup reuse after the cooldown period.
    await transitionLead(lead.id, "terminated", lead.current_owner_email ?? u.email, u.email);
  }

  return { ok: true };
}

// ---------- Round taker ----------

export async function startRound(input: { lead_id: string; round_number: number }) {
  const data = z
    .object({ lead_id: z.string().uuid(), round_number: z.number().int().min(1).max(4) })
    .parse(input);
  const u = await requireUser();
  const lead = await loadLeadOwned(data.lead_id, u.email);
  const expectedStage = `round_${data.round_number}_pending`;
  if (lead.current_stage !== expectedStage)
    throw new Error(`Lead is not in ${expectedStage} (currently ${lead.current_stage})`);
  const { rows: questions } = await pool.query<Pick<QuestionRow, "question_id" | "question_text" | "display_order" | "max_marks">>(
    `SELECT question_id, question_text, display_order, max_marks FROM questions WHERE round_number = $1 ORDER BY display_order`,
    [data.round_number],
  );
  return { questions };
}

export async function submitRound(input: {
  lead_id: string;
  round_number: number;
  grades: Array<{ question_id: string; question_text_used: string; grade: number }>;
  remarks?: string | null;
  next_owner_email?: string | null;
}) {
  const data = z
    .object({
      lead_id: z.string().uuid(),
      round_number: z.number().int().min(1).max(4),
      grades: z
        .array(
          z.object({
            question_id: z.string().min(1).max(100),
            question_text_used: z.string().min(1).max(2000),
            grade: z.number().int().min(0),
          }),
        )
        .min(1)
        .max(200),
      remarks: z.string().max(2000).nullish(),
      next_owner_email: z.string().email().max(255).nullish(),
    })
    .parse(input);

  const u = await requireUser();
  const lead = await loadLeadOwned(data.lead_id, u.email);
  const expectedStage = `round_${data.round_number}_pending`;
  if (lead.current_stage !== expectedStage) throw new Error(`Lead is not in ${expectedStage}`);

  const { num_rounds, rounds_required_for_verdict, marksMap } = await loadRoundConfig();

  const { rows: qs } = await pool.query<{ question_id: string }>(
    `SELECT question_id FROM questions WHERE round_number = $1`,
    [data.round_number],
  );
  const requiredIds = new Set(qs.map((q) => q.question_id));
  const givenIds = new Set(data.grades.map((g) => g.question_id));
  if (requiredIds.size === 0) throw new Error(`No questions configured for round ${data.round_number}`);
  for (const id of requiredIds) if (!givenIds.has(id)) throw new Error(`Missing grade for question ${id}`);

  const total = data.grades.reduce((sum, g) => sum + g.grade, 0);
  const isLastRound = data.round_number >= num_rounds;

  const { rows: roundRows } = await pool.query<{ id: string }>(
    `INSERT INTO interview_rounds (lead_id, round_number, conducted_by, submitted_at, total_score, remarks, next_owner_email)
     VALUES ($1, $2, $3, now(), $4, $5, NULL)
     ON CONFLICT (lead_id, round_number) DO UPDATE SET
       conducted_by = EXCLUDED.conducted_by, submitted_at = EXCLUDED.submitted_at, total_score = EXCLUDED.total_score,
       remarks = EXCLUDED.remarks, next_owner_email = EXCLUDED.next_owner_email
     RETURNING id`,
    [lead.id, data.round_number, u.email, total, data.remarks ?? null],
  );
  const roundRow = roundRows[0];

  await pool.query(`DELETE FROM question_grades WHERE interview_round_id = $1`, [roundRow.id]);
  if (data.grades.length > 0) {
    const values: string[] = [];
    const params: unknown[] = [];
    data.grades.forEach((g, i) => {
      const base = i * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(roundRow.id, g.question_id, g.question_text_used, g.grade);
    });
    await pool.query(
      `INSERT INTO question_grades (interview_round_id, question_id, question_text_used, grade) VALUES ${values.join(", ")}`,
      params,
    );
  }

  const thisRoundPass = marksMap.get(data.round_number);
  const roundPassed = thisRoundPass == null ? true : total >= thisRoundPass;

  if (!roundPassed) {
    await pool.query(
      `UPDATE interview_rounds SET passed = false, next_owner_email = NULL WHERE lead_id = $1 AND round_number = $2`,
      [lead.id, data.round_number],
    );
    await transitionLead(lead.id, "failed", lead.current_owner_email ?? u.email, u.email, {
      verdict: "failed",
      round_number: data.round_number,
      total_score: total,
    });
    return { ok: true, total_score: total, verdict: "failed" as const };
  }

  if (!isLastRound) {
    if (data.round_number === 1) {
      if (!data.next_owner_email) throw new Error("Select who creates the expert profile before submitting");
      const target = data.next_owner_email.toLowerCase();
      const creationPool = await poolMembers("expert_creation");
      if (!creationPool.includes(target)) throw new Error("Selected person is not in the Expert Creation pool");
      await pool.query(
        `UPDATE interview_rounds SET passed = true, next_owner_email = $1 WHERE lead_id = $2 AND round_number = $3`,
        [target, lead.id, data.round_number],
      );
      await recordStageAssignment(lead.id, "expert_creation", target, u.email);
      await transitionLead(lead.id, "profile_creation_pending", target, u.email, {
        round_number: data.round_number,
        total_score: total,
      });
      return { ok: true, total_score: total, verdict: "passed" as const };
    }
    const nextStageKey = `round_${data.round_number + 1}`;
    if (!data.next_owner_email) throw new Error(`Select who takes Round ${data.round_number + 1} before submitting`);
    const target = data.next_owner_email.toLowerCase();
    const nextPool = await poolMembers(nextStageKey);
    if (!nextPool.includes(target)) throw new Error(`Selected person is not in the Round ${data.round_number + 1} pool`);
    await pool.query(
      `UPDATE interview_rounds SET passed = true, next_owner_email = $1 WHERE lead_id = $2 AND round_number = $3`,
      [target, lead.id, data.round_number],
    );
    await recordStageAssignment(lead.id, nextStageKey, target, u.email);
    await transitionLead(lead.id, `${nextStageKey}_pending`, target, u.email, {
      round_number: data.round_number,
      total_score: total,
    });
    return { ok: true, total_score: total, verdict: "passed" as const };
  }

  const { rows: doneRounds } = await pool.query<{ round_number: number; total_score: number | null }>(
    `SELECT round_number, total_score FROM interview_rounds WHERE lead_id = $1 AND submitted_at IS NOT NULL ORDER BY round_number`,
    [lead.id],
  );
  if (doneRounds.length < rounds_required_for_verdict) {
    return { ok: true, total_score: total, verdict: null };
  }
  let passed = true;
  for (const r of doneRounds) {
    const need = marksMap.get(r.round_number);
    if (need == null || (r.total_score ?? -1) < need) {
      passed = false;
      break;
    }
  }
  await pool.query(`UPDATE interview_rounds SET passed = $1 WHERE lead_id = $2 AND round_number = $3`, [
    passed,
    lead.id,
    data.round_number,
  ]);

  if (passed) {
    await pool.query(
      `UPDATE interview_rounds SET passed = true WHERE lead_id = $1 AND round_number = $2`,
      [lead.id, data.round_number],
    );
    await transitionLead(lead.id, "profile_created", lead.current_owner_email ?? u.email, u.email, {
      verdict: "passed",
      total_score: total,
    });
    return { ok: true, total_score: total, verdict: "passed" as const };
  } else {
    await transitionLead(lead.id, "failed", lead.current_owner_email ?? u.email, u.email, { verdict: "failed", total_score: total });
    return { ok: true, total_score: total, verdict: "failed" as const };
  }
}

// ---------- Reschedule / drop ----------

const MAX_ROUND_1_RESCHEDULES = 3;

/**
 * Logs a Round 1 reschedule (max 3). The round_1 interview_rounds row only
 * exists once a round is submitted, so this upserts it — same ON CONFLICT
 * (lead_id, round_number) shape as submitRound — then bumps the count and
 * appends to reschedule_history in one statement. Stage and owner are left
 * untouched; the reschedule fields survive a reassign (reassignStageOwner
 * never writes them) and are wiped with the row by a retake.
 */
export async function rescheduleRound1(input: { lead_id: string; rescheduled_to: string }) {
  const data = z
    .object({ lead_id: z.string().uuid(), rescheduled_to: z.iso.datetime({ offset: true }) })
    .parse(input);
  const u = await requireUser();
  const lead = await loadLeadOwned(data.lead_id, u.email);
  if (lead.current_stage !== "round_1_pending") throw new Error("Lead is not in Round 1");

  const { rows } = await pool.query<{ reschedule_count: number }>(
    `INSERT INTO interview_rounds (lead_id, round_number, conducted_by, started_at, reschedule_count, reschedule_history)
     VALUES ($1, 1, $2, now(), 1,
       jsonb_build_array(jsonb_build_object('count', 1, 'rescheduled_to', $3::text, 'rescheduled_by', $4::text, 'logged_at', now())))
     ON CONFLICT (lead_id, round_number) DO UPDATE SET
       reschedule_count = interview_rounds.reschedule_count + 1,
       reschedule_history = COALESCE(interview_rounds.reschedule_history, '[]'::jsonb) || jsonb_build_array(
         jsonb_build_object('count', interview_rounds.reschedule_count + 1, 'rescheduled_to', $3::text, 'rescheduled_by', $4::text, 'logged_at', now()))
     WHERE interview_rounds.reschedule_count < $5
     RETURNING reschedule_count`,
    [lead.id, lead.current_owner_email ?? u.email, data.rescheduled_to, u.email, MAX_ROUND_1_RESCHEDULES],
  );
  // No row back means the ON CONFLICT WHERE blocked it — already at the max.
  if (!rows[0]) throw new Error(`Round 1 has already been rescheduled ${MAX_ROUND_1_RESCHEDULES} times`);
  const newCount = rows[0].reschedule_count;

  await appendAudit(lead.id, "round_1_rescheduled", u.email, { reschedule_count: newCount, rescheduled_to: data.rescheduled_to });
  return { ok: true, reschedule_count: newCount };
}

const DROP_STAGE_PENDING: Record<"round_1" | "expert_creation" | "round_2", string> = {
  round_1: "round_1_pending",
  expert_creation: "profile_creation_pending",
  round_2: "round_2_pending",
};

/**
 * Drops a lead out of Round 1, Expert Creation or Round 2 with a reason, into
 * the dropped_off terminal stage. Round drops record the reason on that
 * round's interview_rounds row (upserted — it may not exist yet); an Expert
 * Creation drop records it on leads.drop_reason, since no expert_profiles row
 * exists yet and creating one would count as "profile created" everywhere.
 */
export async function dropStage(input: {
  lead_id: string;
  stage: "round_1" | "expert_creation" | "round_2";
  reason: "not_interested" | "failed" | "dropped_off";
}) {
  const data = z
    .object({
      lead_id: z.string().uuid(),
      stage: z.enum(["round_1", "expert_creation", "round_2"]),
      reason: z.enum(["not_interested", "failed", "dropped_off"]),
    })
    .parse(input);
  const u = await requireUser();
  const lead = await loadLeadOwned(data.lead_id, u.email);
  const expected = DROP_STAGE_PENDING[data.stage];
  if (lead.current_stage !== expected) throw new Error(`Lead is not in ${expected} (currently ${lead.current_stage})`);

  if (data.stage === "expert_creation") {
    await pool.query(`UPDATE leads SET drop_reason = $1 WHERE id = $2`, [data.reason, lead.id]);
  } else {
    await pool.query(
      `INSERT INTO interview_rounds (lead_id, round_number, conducted_by, started_at, drop_reason)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (lead_id, round_number) DO UPDATE SET drop_reason = EXCLUDED.drop_reason`,
      [lead.id, data.stage === "round_1" ? 1 : 2, lead.current_owner_email ?? u.email, data.reason],
    );
  }

  await transitionLead(lead.id, "dropped_off", lead.current_owner_email ?? u.email, u.email, { stage: data.stage, reason: data.reason });
  await appendAudit(lead.id, "stage_dropped", u.email, { stage: data.stage, reason: data.reason });
  return { ok: true };
}

// ---------- Expert creation ----------

export async function linkExpertProfile(input: {
  lead_id: string;
  expert_id: string;
  notes?: string | null;
  next_owner_email?: string | null;
}) {
  const data = z
    .object({
      lead_id: z.string().uuid(),
      expert_id: z.string().min(1).max(200),
      notes: z.string().max(2000).nullish(),
      next_owner_email: z.string().email().max(255).nullish(),
    })
    .parse(input);
  const u = await requireUser();
  const lead = await loadLeadOwned(data.lead_id, u.email);
  if (lead.current_stage !== "profile_creation_pending") throw new Error("Lead is not in profile creation stage");

  await pool.query(
    `INSERT INTO expert_profiles (lead_id, expert_id, linked_by, is_active, notes)
     VALUES ($1, $2, $3, false, $4)
     ON CONFLICT (lead_id) DO UPDATE SET
       expert_id = EXCLUDED.expert_id, linked_by = EXCLUDED.linked_by, is_active = EXCLUDED.is_active,
       notes = EXCLUDED.notes`,
    [lead.id, data.expert_id, u.email, data.notes?.trim() || null],
  );

  const { num_rounds } = await loadRoundConfig();

  if (num_rounds <= 1) {
    await transitionLead(lead.id, "profile_created", lead.current_owner_email ?? u.email, u.email, {
      expert_id: data.expert_id,
    });
  } else {
    if (!data.next_owner_email) throw new Error("Select who takes Round 2 before linking the profile");
    const target = data.next_owner_email.toLowerCase();
    const round2Pool = await poolMembers("round_2");
    if (!round2Pool.includes(target)) throw new Error("Selected person is not in the Round 2 pool");
    await recordStageAssignment(lead.id, "round_2", target, u.email);
    await transitionLead(lead.id, "round_2_pending", target, u.email, { expert_id: data.expert_id });
  }

  return { ok: true };
}

/** Manually flips a linked profile active (stands in for the old sheet-driven sync). */
export async function activateExpertProfile(input: { lead_id: string }) {
  const { lead_id } = z.object({ lead_id: z.string().uuid() }).parse(input);
  const u = await requireRole("admin");
  const { rows: profileRows } = await pool.query<ExpertProfileRow>(
    `SELECT * FROM expert_profiles WHERE lead_id = $1`,
    [lead_id],
  );
  const profile = profileRows[0];
  if (!profile) throw new Error("No expert profile linked for this lead yet");
  await pool.query(
    `UPDATE expert_profiles SET is_active = true, activated_at = COALESCE(activated_at, now()) WHERE lead_id = $1`,
    [lead_id],
  );
  await transitionLead(lead_id, "active", profile.linked_by, u.email, { source: "manual_activation" });
  return { ok: true };
}

// ---------- Lead intake (any role — manual, CSV bulk) ----------

const INTAKE_ROLES: Role[] = ["admin", "kam", "lma", "telecaller"];

export async function resolvePriority(source: string, override?: number | null): Promise<number> {
  if (override != null) return override;
  const { rows } = await pool.query<{ priority_score: number; is_active: boolean }>(
    `SELECT priority_score, is_active FROM source_priority_config WHERE source_name ILIKE $1 LIMIT 1`,
    [source],
  );
  const srcCfg = rows[0];
  return srcCfg?.is_active ? srcCfg.priority_score : 99;
}

/**
 * Shared insert path for addLead / bulkAddLeads / forceAllowDuplicate.
 * Contact must already be normalized. `assigned_telecaller_email` is
 * optional — admin can assign a telecaller later from Admin > Allotment
 * instead of at intake time; the lead just sits in the Unassigned tab
 * until then.
 */
export async function insertLeadRow(input: {
  name: string;
  contact: string;
  email?: string | null;
  city?: string | null;
  language?: string | null;
  source: string;
  priority: number;
  lead_date: string;
  assigned_telecaller_email?: string | null;
  performedBy: string;
}) {
  await requireUser();
  const telecaller = input.assigned_telecaller_email || null;
  const lead_id = `REF-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const { rows } = await pool.query<{ id: string; lead_id: string }>(
    `INSERT INTO leads (lead_id, name, contact, email, city, language, source, priority, assigned_to_email, current_stage, current_owner_email, lead_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'calling_pending', $10, $11)
     RETURNING id, lead_id`,
    [
      lead_id,
      input.name.trim(),
      input.contact,
      input.email ?? null,
      input.city ?? null,
      input.language ?? null,
      input.source.trim(),
      input.priority,
      telecaller,
      telecaller,
      input.lead_date,
    ],
  );
  const inserted = rows[0];
  await appendAudit(inserted.id, "lead_created", input.performedBy, {
    source: input.source,
    priority: input.priority,
    manual: true,
  });
  if (telecaller) await recordStageAssignment(inserted.id, "calling", telecaller, input.performedBy);
  return inserted;
}

export async function checkDuplicate(input: { contact: string }) {
  const { contact } = z.object({ contact: z.string().min(1).max(30) }).parse(input);
  await requireRole(INTAKE_ROLES);
  const result = await findDuplicateLead(contact);
  return { duplicate: result.blocking, lead: result.match, reason: result.reason };
}

export async function addLead(input: {
  name: string;
  contact: string;
  email?: string | null;
  city?: string | null;
  language?: string | null;
  source: string;
  priority?: number | null;
  lead_date?: string | null;
  assigned_telecaller_email?: string | null;
}) {
  const data = z
    .object({
      name: z.string().min(1).max(200),
      contact: z.string().min(1).max(30),
      email: z.string().email().max(255).nullish(),
      city: z.string().max(200).nullish(),
      language: z.string().max(100).nullish(),
      source: z.string().min(1).max(200),
      priority: z.number().int().min(1).max(99).nullish(),
      lead_date: z.string().nullish(),
      assigned_telecaller_email: z.string().email().max(255).nullish(),
    })
    .parse(input);

  const u = await requireRole(INTAKE_ROLES);

  const normalized = normalizeContact(data.contact);
  if (!normalized) throw new Error("Contact number must be a valid 10-digit mobile number");

  const dedup = await findDuplicateLead(data.contact);
  if (dedup.blocking) {
    await logDuplicate({
      incoming_name: data.name,
      incoming_contact: normalized,
      incoming_source: data.source,
      matched_lead_id: dedup.match!.id,
      detected_by: u.email,
      payload: { ...data, contact: normalized },
    });
    return { ok: false as const, duplicate: true as const, matched_lead: dedup.match!, reason: dedup.reason };
  }

  // Telecaller is optional now — leaving it blank drops the lead into the
  // Unassigned tab on Admin > Allotment for later assignment.
  let telecaller: string | null = null;
  if (data.assigned_telecaller_email) {
    telecaller = data.assigned_telecaller_email.toLowerCase();
    const callingPool = await poolMembers("calling");
    if (!callingPool.includes(telecaller)) throw new Error("Selected telecaller is not in the calling pool");
  }

  const priority = await resolvePriority(data.source, data.priority);
  const inserted = await insertLeadRow({
    name: data.name,
    contact: normalized,
    email: data.email,
    city: data.city,
    language: data.language,
    source: data.source,
    priority,
    lead_date: data.lead_date ?? new Date().toISOString().slice(0, 10),
    assigned_telecaller_email: telecaller,
    performedBy: u.email,
  });
  return { ok: true as const, duplicate: false as const, lead: inserted };
}

const BulkRowSchema = z.object({
  name: z.string().min(1).max(200),
  contact: z.string().min(1).max(30),
  email: z.string().max(255).nullish(),
  city: z.string().max(200).nullish(),
  language: z.string().max(100).nullish(),
  lead_date: z.string().nullish(),
});

export async function bulkAddLeads(input: {
  rows: Array<{
    name: string;
    contact: string;
    email?: string | null;
    city?: string | null;
    language?: string | null;
    lead_date?: string | null;
  }>;
  source: string;
  assigned_telecaller_email?: string | null;
}) {
  const data = z
    .object({
      rows: z.array(BulkRowSchema).min(1).max(1000),
      source: z.string().min(1).max(200),
      assigned_telecaller_email: z.string().email().max(255).nullish(),
    })
    .parse(input);

  const u = await requireRole(INTAKE_ROLES);

  // Optional — leaving it blank drops every row into the Unassigned tab for
  // admin to allot afterwards, same as the manual Add Lead form.
  let telecaller: string | null = null;
  if (data.assigned_telecaller_email) {
    telecaller = data.assigned_telecaller_email.toLowerCase();
    const callingPool = await poolMembers("calling");
    if (!callingPool.includes(telecaller)) throw new Error("Selected telecaller is not in the calling pool");
  }

  let added = 0;
  const duplicates: Array<{
    row: number;
    name: string;
    contact: string;
    matched_lead_id: string | null;
    matched_lead_name: string;
    reason: string | null;
  }> = [];
  const errors: Array<{ row: number; message: string }> = [];
  // Catches duplicate rows within the same file, not just against the DB.
  const stagedContacts = new Set<string>();

  for (let i = 0; i < data.rows.length; i++) {
    const rowNum = i + 2; // header is row 1
    const row = data.rows[i];
    try {
      const normalized = normalizeContact(row.contact);
      if (!normalized) {
        errors.push({ row: rowNum, message: "Invalid contact number (must be 10 digits)" });
        continue;
      }
      if (stagedContacts.has(normalized)) {
        duplicates.push({
          row: rowNum,
          name: row.name,
          contact: normalized,
          matched_lead_id: null,
          matched_lead_name: "(duplicate within this file)",
          reason: "active",
        });
        continue;
      }
      const dedup = await findDuplicateLead(row.contact);
      if (dedup.blocking) {
        await logDuplicate({
          incoming_name: row.name,
          incoming_contact: normalized,
          incoming_source: data.source,
          matched_lead_id: dedup.match!.id,
          detected_by: u.email,
          payload: { ...row, contact: normalized, source: data.source, assigned_telecaller_email: telecaller },
        });
        duplicates.push({
          row: rowNum,
          name: row.name,
          contact: normalized,
          matched_lead_id: dedup.match!.id,
          matched_lead_name: dedup.match!.name,
          reason: dedup.reason,
        });
        continue;
      }
      const priority = await resolvePriority(data.source, null);
      await insertLeadRow({
        name: row.name,
        contact: normalized,
        email: row.email,
        city: row.city,
        language: row.language,
        source: data.source,
        priority,
        lead_date: row.lead_date ?? new Date().toISOString().slice(0, 10),
        assigned_telecaller_email: telecaller,
        performedBy: u.email,
      });
      stagedContacts.add(normalized);
      added++;
    } catch (e) {
      errors.push({ row: rowNum, message: (e as Error).message });
    }
  }

  return { added, duplicates, errors, total: data.rows.length };
}
