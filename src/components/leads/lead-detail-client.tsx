"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, Check } from "lucide-react";
import {
  getLead,
  getPool,
  logCallOutcome,
  startRound,
  submitRound,
  linkExpertProfile,
  reassignStageOwner,
  retakeStage,
  rescheduleRound1,
  dropStage,
  getFormResponse,
} from "@/lib/actions/leads-actions";
import { fmtSlot } from "@/lib/format";
import { RescheduleChip } from "@/components/reschedule-chip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/empty-state";
import { StatusPill, stageToPill, type StatusKind } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type LeadData = Awaited<ReturnType<typeof getLead>>;

function formatContact(c: string): string {
  if (!c) return "";
  const digits = c.replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : c;
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Matches http(s):// and bare www. links; trailing punctuation is trimmed off
// below so "see https://x.com." doesn't swallow the full stop.
const URL_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

/** Renders free text with any URLs turned into new-tab links. Display only. */
function Linkified({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = m[0];
    const url = raw.replace(TRAILING_PUNCT_RE, "");
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a
        key={start}
        href={url.startsWith("www.") ? `https://${url}` : url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline underline-offset-2 hover:no-underline"
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const OUTCOME_LABELS: Record<string, string> = {
  connected: "Connected",
  rnr: "RNR",
  reconnect: "Reconnect",
  junk: "Junk",
  not_interested: "Not Interested",
  failed: "Failed",
  dropped_off: "Dropped Off",
};

// Same wording as the Calling outcomes.
const DROP_REASONS = [
  { value: "not_interested", label: "Not Interested" },
  { value: "failed", label: "Failed" },
  { value: "dropped_off", label: "Dropped Off" },
] as const;
type DropReason = (typeof DROP_REASONS)[number]["value"];
const dropReasonLabel = (r: string | null | undefined) => (r ? (OUTCOME_LABELS[r] ?? r) : "");

export function LeadDetailClient({ id, userEmail }: { id: string; userEmail: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const leadQ = useQuery({ queryKey: ["lead", id], queryFn: () => getLead({ id }) });
  const formQ = useQuery({ queryKey: ["form-response", id], queryFn: () => getFormResponse({ lead_id: id }), staleTime: 5 * 60_000 });

  function goBack() {
    router.back();
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ["lead", id] });
    qc.invalidateQueries({ queryKey: ["my-leads"] });
  }

  if (leadQ.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  const errMsg = leadQ.error ? (leadQ.error as Error).message : null;
  if (errMsg) {
    const forbidden = errMsg.toLowerCase().includes("forbidden") || errMsg.toLowerCase().includes("not your lead");
    return (
      <EmptyState
        title={forbidden ? "This lead is no longer assigned to you" : "Couldn't load this lead"}
        description={forbidden ? "It may have moved to another stage or owner." : errMsg}
        ctaLabel="Back to dashboard"
        ctaHref="/dashboard"
      />
    );
  }

  const data = leadQ.data!;
  const pill = stageToPill(data.lead.current_stage);

  return (
    <div>
      <button
        type="button"
        onClick={goBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </button>

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-start justify-between gap-4 p-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">{data.lead.name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span className="tabular-nums">{formatContact(data.lead.contact)}</span>
              {data.lead.email && (
                <>
                  <span>·</span>
                  <span className="break-all">{data.lead.email}</span>
                </>
              )}
              <span>·</span>
              <span>{data.lead.source ?? "Direct"}</span>
              {data.lead.lead_date && (
                <>
                  <span>·</span>
                  <span>Lead date {data.lead.lead_date}</span>
                </>
              )}
            </div>
            {(data.profile?.expert_id || formQ.data) && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {data.profile?.expert_id && <Badge variant="secondary">Expert ID: {data.profile.expert_id}</Badge>}
                {formQ.data && <FormResponseDialog entries={formQ.data} />}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={data.lead.priority <= 2 ? "default" : "secondary"}>Source Priority {data.lead.priority}</Badge>
            <StatusPill kind={pill.kind} label={pill.label} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <ActionsPanel data={data} userEmail={userEmail} onChanged={refresh} />
        <LeadTimeline data={data} onChanged={refresh} />
      </div>
    </div>
  );
}

/** "View Google Form" chip → read-only list of every question/answer captured at intake. */
function FormResponseDialog({ entries }: { entries: Array<{ question: string; answer: string }> }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-primary hover:bg-accent"
        >
          View Google Form
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Google Form response</DialogTitle>
          <DialogDescription>Text answers captured when this lead was submitted. File uploads aren&apos;t included.</DialogDescription>
        </DialogHeader>
        <dl className="-mx-6 max-h-[65vh] divide-y divide-border overflow-y-auto border-t border-border">
          {entries.map((e, i) => (
            <div key={i} className="grid grid-cols-1 gap-1 px-6 py-2.5 text-sm sm:grid-cols-[2fr_3fr] sm:gap-4">
              <dt className="text-muted-foreground">{e.question}</dt>
              <dd className="whitespace-pre-wrap break-words text-foreground">{e.answer}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/* ===================== TIMELINE ===================== */

type TimelineState = "done" | "current" | "future";
type TimelineItem = {
  id: string;
  title: string;
  subtitle: string;
  state: TimelineState;
  pill: StatusKind;
  pillLabel: string;
  assignedTo?: string | null;
  details?: React.ReactNode;
};

function LeadTimeline({ data, onChanged }: { data: LeadData; onChanged: () => void }) {
  const { lead, attempts, rounds, profile, assignments, names } = data;
  const [openId, setOpenId] = React.useState<string | null>(null);
  const numRounds = data.cfg.num_rounds;
  const assignedByStage = new Map((assignments ?? []).map((a) => [a.stage, a.assigned_email]));
  const nameOf = (email: string | null | undefined) => (email ? (names[email] ?? email) : null);
  // No Retake anywhere once the lead is Active — every retake cascades into
  // the expert profile link (retakeStage refuses it server-side too).
  const canRetake = lead.current_stage !== "active";

  const items: TimelineItem[] = [];

  items.push({
    id: "created",
    title: "Lead Created",
    subtitle: lead.lead_date ?? fmtDateTime(lead.created_at),
    state: "done",
    pill: "active",
    pillLabel: "Created",
    details: (
      <div className="space-y-1 text-sm text-muted-foreground">
        <div>Source: <span className="font-medium text-foreground">{lead.source ?? "Direct"}</span></div>
        <div>Source Priority: <span className="font-medium text-foreground">{lead.priority}</span></div>
      </div>
    ),
  });

  const sortedAttempts = [...attempts].sort((a, b) => a.attempt_number - b.attempt_number);
  const lastAttempt = sortedAttempts[sortedAttempts.length - 1] as (typeof sortedAttempts)[number] | undefined;
  const callingState: TimelineState = lead.current_stage === "calling_pending" ? "current" : "done";
  const callingOutcome = lastAttempt ? (lastAttempt.outcome ?? (lastAttempt.connected ? "connected" : "rnr")) : null;
  // While calling is the live stage, current_owner_email is the authoritative
  // owner (it's what ActionsPanel's "Passed to X" also reads) — the
  // lead_stage_assignments/assigned_to_email fallback is only for the
  // historical record once the lead has moved on.
  const callingAssignedEmail = callingState === "current" ? lead.current_owner_email : (assignedByStage.get("calling") ?? lead.assigned_to_email);
  items.push({
    id: "calling",
    title: "Calling",
    subtitle: lastAttempt ? fmtDateTime(lastAttempt.attempted_at) : "No attempts yet",
    state: callingState,
    pill: callingOutcome ? (callingOutcome as StatusKind) : "pending",
    pillLabel: callingOutcome ? (OUTCOME_LABELS[callingOutcome] ?? callingOutcome) : "Pending",
    assignedTo: nameOf(callingAssignedEmail),
    details: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <div>Assigned to: <span className="font-medium text-foreground">{nameOf(callingAssignedEmail)}</span></div>
        {callingState === "current" && callingAssignedEmail && (
          <ReassignControl leadId={lead.id} stage="calling" currentEmail={callingAssignedEmail} onChanged={onChanged} />
        )}
        {callingState === "done" && canRetake && (
          <RetakeControl leadId={lead.id} stage="calling" stageLabel="Calling" onChanged={onChanged} />
        )}
        {sortedAttempts.length === 0 && <div>No attempts logged yet.</div>}
        {sortedAttempts.map((a) => {
          const o = a.outcome ?? (a.connected ? "connected" : "rnr");
          return (
            <div key={a.id} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
              <div>
                Attempt {a.attempt_number}: <span className="font-medium text-foreground">{OUTCOME_LABELS[o] ?? o}</span>
                {" · "}{fmtDateTime(a.attempted_at)}
              </div>
              {a.remarks && <div>Notes: <Linkified text={a.remarks} /></div>}
            </div>
          );
        })}
      </div>
    ),
  });

  // Round 1
  {
    const n = 1;
    const round = rounds.find((r) => r.round_number === n);
    const stageKey = "round_1";
    const isCurrentStage = lead.current_stage === "round_1_pending";
    const assignedTo = isCurrentStage ? lead.current_owner_email : assignedByStage.get(stageKey);
    const doneBy = round?.submitted_at || round?.drop_reason ? round.conducted_by : null;
    let state: TimelineState;
    let pill: StatusKind;
    let pillLabel: string;
    if (round?.submitted_at) {
      state = "done";
      pill = round.passed === true ? "passed" : round.passed === false ? "failed" : "pending";
      pillLabel = round.passed === true ? "Passed" : round.passed === false ? "Failed" : "Submitted";
    } else if (round?.drop_reason) {
      state = "done"; pill = "dropped_off"; pillLabel = "Dropped Off";
    } else if (isCurrentStage) {
      state = "current"; pill = "pending"; pillLabel = "In progress";
    } else {
      state = "future"; pill = "neutral"; pillLabel = "Not started";
    }
    items.push({
      id: stageKey,
      title: "Round 1",
      subtitle: round?.submitted_at ? fmtDateTime(round.submitted_at) : "",
      state, pill, pillLabel,
      assignedTo: nameOf(assignedTo) ?? null,
      details: (
        <div className="space-y-1 text-sm text-muted-foreground">
          <div>Conducted by: <span className="font-medium text-foreground">{nameOf(doneBy) ?? nameOf(assignedTo) ?? "Not started yet"}</span></div>
          {state === "current" && (doneBy ?? assignedTo) && (
            <ReassignControl leadId={lead.id} stage={stageKey} currentEmail={doneBy ?? assignedTo} onChanged={onChanged} />
          )}
          {state === "done" && canRetake && (
            <RetakeControl leadId={lead.id} stage={stageKey} stageLabel="Round 1" onChanged={onChanged} />
          )}
          {round?.total_score != null && <div>Score: <span className="font-medium text-foreground">{round.total_score}</span></div>}
          {round?.remarks && <div>Notes: <Linkified text={round.remarks} /></div>}
          {round?.drop_reason && <div>Drop reason: <span className="font-medium text-foreground">{dropReasonLabel(round.drop_reason)}</span></div>}
          {(round?.reschedule_history ?? []).length > 0 && (
            <ol className="mt-1 space-y-0.5 border-t border-border pt-1.5 text-xs">
              {(round?.reschedule_history ?? []).map((h) => (
                <li key={h.count}>
                  Rescheduled {h.count} — for {fmtSlot(h.rescheduled_to)} (by {nameOf(h.rescheduled_by)})
                </li>
              ))}
            </ol>
          )}
        </div>
      ),
    });
  }

  // Expert Creation (now between Round 1 and Round 2)
  {
    const isExpertCreationCurrentStage = lead.current_stage === "profile_creation_pending";
    const assignedCreation = isExpertCreationCurrentStage ? lead.current_owner_email : assignedByStage.get("expert_creation");
    let creationState: TimelineState;
    let creationPill: StatusKind;
    let creationLabel: string;
    if (lead.current_stage === "active") {
      creationState = "done"; creationPill = "active"; creationLabel = "Active";
    } else if (profile && lead.current_stage !== "round_2_pending") {
      creationState = "done"; creationPill = "inactive"; creationLabel = "Profile Created";
    } else if (profile && lead.current_stage === "round_2_pending") {
      creationState = "done"; creationPill = "inactive"; creationLabel = "Profile Created";
    } else if (lead.current_stage === "dropped_off" && lead.drop_reason) {
      creationState = "done"; creationPill = "dropped_off"; creationLabel = "Dropped Off";
    } else if (isExpertCreationCurrentStage) {
      creationState = "current"; creationPill = "pending"; creationLabel = "In progress";
    } else {
      creationState = "future"; creationPill = "neutral"; creationLabel = "Not started";
    }
    items.push({
      id: "expert_creation",
      title: "Expert Creation",
      subtitle: profile?.linked_at ? fmtDateTime(profile.linked_at) : "",
      state: creationState,
      pill: creationPill,
      pillLabel: creationLabel,
      assignedTo: nameOf(assignedCreation) ?? null,
      details: (
        <div className="space-y-1 text-sm text-muted-foreground">
          <div>
            Assigned to:{" "}
            <span className="font-medium text-foreground">{nameOf(profile?.linked_by) ?? nameOf(assignedCreation) ?? "Not started yet"}</span>
          </div>
          {creationState === "current" && (profile?.linked_by ?? assignedCreation) && (
            <ReassignControl
              leadId={lead.id}
              stage="expert_creation"
              currentEmail={profile?.linked_by ?? assignedCreation}
              onChanged={onChanged}
            />
          )}
          {creationState === "done" && canRetake && (
            <RetakeControl leadId={lead.id} stage="expert_creation" stageLabel="Expert Creation" onChanged={onChanged} />
          )}
          {profile && <div>Expert ID: <span className="font-mono text-foreground">{profile.expert_id}</span></div>}
          {profile?.notes && <div>Notes: <Linkified text={profile.notes} /></div>}
          {creationLabel === "Dropped Off" && (
            <div>Drop reason: <span className="font-medium text-foreground">{dropReasonLabel(lead.drop_reason)}</span></div>
          )}
        </div>
      ),
    });
  }

  // Rounds 2..N
  for (let n = 2; n <= numRounds; n++) {
    const round = rounds.find((r) => r.round_number === n);
    const stageKey = `round_${n}`;
    const isCurrentStage = lead.current_stage === `${stageKey}_pending`;
    const assignedTo = isCurrentStage ? lead.current_owner_email : assignedByStage.get(stageKey);
    const doneBy = round?.submitted_at || round?.drop_reason ? round.conducted_by : null;
    let state: TimelineState;
    let pill: StatusKind;
    let pillLabel: string;
    if (round?.submitted_at) {
      state = "done";
      pill = round.passed === true ? "passed" : round.passed === false ? "failed" : "pending";
      pillLabel = round.passed === true ? "Passed" : round.passed === false ? "Failed" : "Submitted";
    } else if (round?.drop_reason) {
      state = "done"; pill = "dropped_off"; pillLabel = "Dropped Off";
    } else if (isCurrentStage) {
      state = "current"; pill = "pending"; pillLabel = "In progress";
    } else {
      state = "future"; pill = "neutral"; pillLabel = "Not started";
    }
    items.push({
      id: stageKey,
      title: `Round ${n}`,
      subtitle: round?.submitted_at ? fmtDateTime(round.submitted_at) : "",
      state, pill, pillLabel,
      assignedTo: nameOf(assignedTo) ?? null,
      details: (
        <div className="space-y-1 text-sm text-muted-foreground">
          <div>Conducted by: <span className="font-medium text-foreground">{nameOf(doneBy) ?? nameOf(assignedTo) ?? "Not started yet"}</span></div>
          {state === "current" && (doneBy ?? assignedTo) && (
            <ReassignControl leadId={lead.id} stage={stageKey} currentEmail={doneBy ?? assignedTo} onChanged={onChanged} />
          )}
          {state === "done" && canRetake && (
            <RetakeControl leadId={lead.id} stage={stageKey} stageLabel={`Round ${n}`} onChanged={onChanged} />
          )}
          {round?.total_score != null && <div>Score: <span className="font-medium text-foreground">{round.total_score}</span></div>}
          {round?.remarks && <div>Notes: <Linkified text={round.remarks} /></div>}
          {round?.drop_reason && <div>Drop reason: <span className="font-medium text-foreground">{dropReasonLabel(round.drop_reason)}</span></div>}
        </div>
      ),
    });
  }

  return (
    <div className="space-y-2">
      <h2 className="mb-1 text-sm font-semibold text-foreground">Timeline</h2>
      {items.map((it) => {
        const open = openId === it.id || it.state === "current";
        const future = it.state === "future";
        return (
          <Card key={it.id} className={`overflow-hidden ${it.state === "current" ? "border-primary" : ""} ${future ? "opacity-60" : ""}`}>
            <button
              type="button"
              onClick={() => setOpenId(open && openId === it.id ? null : it.id)}
              className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors hover:bg-accent/50"
            >
              <div className="flex items-center gap-3">
                {it.state === "done" ? (
                  <Check className="h-4 w-4 text-success" />
                ) : it.state === "current" ? (
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary" />
                ) : (
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-muted-foreground/40" />
                )}
                <span className="text-sm font-medium text-foreground">{it.title}</span>
                <StatusPill kind={it.pill} label={it.pillLabel} />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {future && it.assignedTo && <span>Assigned to {it.assignedTo}</span>}
                <span>{it.subtitle}</span>
              </div>
            </button>
            {open && <div className="border-t border-border px-5 py-3">{it.details}</div>}
          </Card>
        );
      })}
    </div>
  );
}

/** Inline "Reassign" link + pool-scoped picker shown below a Timeline stage's assignee — only rendered on the lead detail page. */
function ReassignControl({
  leadId,
  stage,
  currentEmail,
  onChanged,
}: {
  leadId: string;
  stage: string;
  currentEmail: string | null | undefined;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const queryClient = useQueryClient();
  const poolQ = useQuery({ queryKey: ["pool", stage], queryFn: () => getPool({ stage }), staleTime: 5 * 60_000, enabled: open });
  const pool = poolQ.data?.members ?? [];
  const names = poolQ.data?.names ?? {};

  async function confirm() {
    if (!value) return;
    setBusy(true);
    try {
      await reassignStageOwner({ lead_id: leadId, stage, new_email: value });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pipeline-snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-admin-extras"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-activity"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pool"] });
      toast.success(`Reassigned to ${names[value] ?? value}.`);
      setOpen(false);
      setValue("");
      onChanged();
    } catch (e) {
      toast.error("Something went wrong.", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-primary hover:underline">
        Reassign
      </button>
    );
  }

  const options = pool.filter((m) => m !== currentEmail);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger className="h-8 w-48 text-xs"><SelectValue placeholder={poolQ.isLoading ? "Loading…" : "Select person"} /></SelectTrigger>
        <SelectContent>
          {options.map((m) => <SelectItem key={m} value={m}>{names[m] ?? m}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" className="h-8" disabled={!value || busy} onClick={confirm}>
        {busy ? "Saving…" : "Confirm"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8"
        onClick={() => {
          setOpen(false);
          setValue("");
        }}
      >
        Cancel
      </Button>
      {!poolQ.isLoading && options.length === 0 && <p className="w-full text-xs text-destructive">No one else is in this stage&apos;s pool.</p>}
    </div>
  );
}

/** Inline "Retake" link + confirm dialog shown on a completed calling/round Timeline stage — resets it back to in-progress and clears every later stage. */
function RetakeControl({
  leadId,
  stage,
  stageLabel,
  onChanged,
}: {
  leadId: string;
  stage: string;
  stageLabel: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const queryClient = useQueryClient();

  async function confirm() {
    setBusy(true);
    try {
      await retakeStage({ lead_id: leadId, stage });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pipeline-snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-admin-extras"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-activity"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pool"] });
      toast.success(`${stageLabel} reset for retake.`);
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error("Something went wrong.", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="text-xs font-medium text-primary hover:underline">
          Retake
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retake {stageLabel}?</DialogTitle>
          <DialogDescription>
            This will send the lead back to {stageLabel} and permanently clear all results recorded after it — including any
            completed rounds, scores, and the expert profile link. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={confirm}>
            {busy ? "Resetting…" : "Yes, retake and clear later stages"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===================== ACTIONS PANEL ===================== */

function ActionsPanel({ data, userEmail, onChanged }: { data: LeadData; userEmail: string; onChanged: () => void }) {
  const stage = data.lead.current_stage;
  const isOwner = data.lead.current_owner_email === userEmail;

  if (!isOwner) {
    const forLabel =
      stage === "calling_pending"
        ? "Calling"
        : stage === "profile_creation_pending"
          ? "Expert Profile Creation"
          : stage.startsWith("round_") && stage.endsWith("_pending")
            ? `Round ${stage.replace(/[^0-9]/g, "")}`
            : stage;
    const ownerName = data.lead.current_owner_email ? (data.names[data.lead.current_owner_email] ?? data.lead.current_owner_email) : "—";
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-base font-semibold text-foreground">Passed to {ownerName}</p>
          <p className="mt-2 text-sm text-muted-foreground">For {forLabel}</p>
          <p className="mt-4 text-sm text-muted-foreground">Your work on this lead is complete.</p>
        </CardContent>
      </Card>
    );
  }

  if (stage === "calling_pending") return <CallingActions data={data} onChanged={onChanged} />;
  const roundMatch = stage.match(/^round_(\d+)_pending$/);
  if (roundMatch) return <RoundActions data={data} round={parseInt(roundMatch[1], 10)} onChanged={onChanged} />;
  if (stage === "profile_creation_pending") return <ProfileActions data={data} onChanged={onChanged} />;
  return (
    <Card>
      <CardContent className="p-6 text-sm text-muted-foreground">Nothing to do here.</CardContent>
    </Card>
  );
}

/* ===================== CALLING ===================== */

const CALLING_OPTIONS = [
  { value: "connected", label: "Connected", desc: "I spoke to them." },
  { value: "reconnect", label: "Reconnect", desc: "They asked to call back later." },
  { value: "rnr", label: "RNR", desc: "Phone rang but no one answered." },
  { value: "junk", label: "Junk", desc: "Wrong number or fake lead." },
  { value: "not_interested", label: "Not Interested", desc: "They picked up but refused." },
  { value: "failed", label: "Failed", desc: "They did not meet the criteria." },
  { value: "dropped_off", label: "Dropped Off", desc: "They stopped responding." },
] as const;

function CallingActions({ data, onChanged }: { data: LeadData; onChanged: () => void }) {
  const { lead, attempts } = data;
  const queryClient = useQueryClient();
  const round1PoolQ = useQuery({ queryKey: ["pool", "round_1"], queryFn: () => getPool({ stage: "round_1" }), staleTime: 5 * 60_000 });

  const sorted = [...attempts].sort((a, b) => a.attempt_number - b.attempt_number);
  const last = sorted[sorted.length - 1] as ((typeof sorted)[number] & { outcome?: string | null }) | undefined;
  const lastOutcome = last ? (last.outcome ?? (last.connected ? "connected" : "rnr")) : null;
  const terminal = lastOutcome ? ["connected", "junk", "not_interested"].includes(lastOutcome) : false;
  const nextAttempt = !last ? 1 : terminal ? null : last.attempt_number >= 3 ? null : last.attempt_number + 1;

  const [outcome, setOutcome] = React.useState<string | null>(null);
  const [remarks, setRemarks] = React.useState("");
  const [nextOwner, setNextOwner] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  if (nextAttempt == null) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {terminal ? "Lead is finalised — no more attempts needed." : "All 3 attempts logged."}
        </CardContent>
      </Card>
    );
  }

  const remarksRequired = outcome === "junk" || outcome === "not_interested" || outcome === "failed" || outcome === "dropped_off";
  const round1Pool = round1PoolQ.data?.members ?? [];
  const round1Names = round1PoolQ.data?.names ?? {};

  async function save() {
    if (!outcome) {
      toast.warning("Select an outcome before saving.");
      return;
    }
    if (remarksRequired && !remarks.trim()) {
      toast.warning("Remarks are required for this outcome.");
      return;
    }
    if (outcome === "connected" && !nextOwner) {
      toast.warning("Select who takes Round 1 before submitting.");
      return;
    }
    setBusy(true);
    try {
      await logCallOutcome({
        lead_id: lead.id,
        attempt_number: nextAttempt!,
        outcome: outcome as "connected" | "rnr" | "reconnect" | "junk" | "not_interested" | "failed" | "dropped_off",
        remarks: remarks || null,
        next_owner_email: outcome === "connected" ? nextOwner : null,
      });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pipeline-snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-admin-extras"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-activity"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pool"] });
      toast.success(outcome === "connected" ? `Lead passed to ${round1Names[nextOwner] ?? nextOwner} for Round 1.` : "Attempt saved.");
      setOutcome(null);
      setRemarks("");
      setNextOwner("");
      onChanged();
    } catch (e) {
      toast.error("Something went wrong.", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const submitDisabled = busy || !outcome || (remarksRequired && !remarks.trim()) || (outcome === "connected" && !nextOwner);

  return (
    <Card>
      <CardContent className="p-6">
        <p className="text-base font-semibold text-foreground">Attempt {nextAttempt}</p>
        <p className="mt-1 text-sm text-muted-foreground">What happened on the call?</p>

        <div className="mt-5 space-y-2">
          {CALLING_OPTIONS.map((opt) => {
            const selected = outcome === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setOutcome(opt.value)}
                className={`block w-full rounded-md border px-4 py-3 text-left transition-colors ${
                  selected ? "border-primary bg-primary/5" : "border-border bg-background hover:border-muted-foreground/40"
                }`}
              >
                <div className="text-sm font-medium text-foreground">{opt.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{opt.desc}</div>
              </button>
            );
          })}
        </div>

        {outcome === "connected" && (
          <div className="mt-5 space-y-1.5">
            <Label>Who takes Round 1?</Label>
            <Select value={nextOwner} onValueChange={setNextOwner}>
              <SelectTrigger><SelectValue placeholder="Select person" /></SelectTrigger>
              <SelectContent>
                {round1Pool.map((m) => <SelectItem key={m} value={m}>{round1Names[m] ?? m}</SelectItem>)}
              </SelectContent>
            </Select>
            {round1Pool.length === 0 && (
              <p className="text-xs text-destructive">No one is in the Round 1 pool yet — contact admin.</p>
            )}
          </div>
        )}

        {outcome && (
          <div className="mt-5 space-y-1.5">
            <Label>Notes {remarksRequired ? "(required)" : "(optional)"}</Label>
            <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} placeholder={remarksRequired ? "Why? (required)" : "What happened?"} />
          </div>
        )}

        {outcome && (
          <Button onClick={save} disabled={submitDisabled} className="mt-5 w-full">
            {busy ? "Submitting…" : "Submit"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/* ===================== ROUNDS ===================== */

function RoundActions({ data, round, onChanged }: { data: LeadData; round: number; onChanged: () => void }) {
  const { lead } = data;
  const queryClient = useQueryClient();
  const startQ = useQuery({ queryKey: ["round-questions", lead.id, round], queryFn: () => startRound({ lead_id: lead.id, round_number: round }) });
  const numRounds = data.cfg.num_rounds;
  const isLastRound = round >= numRounds;
  const nextStageKey: string | null = round === 1 ? "expert_creation" : isLastRound ? null : `round_${round + 1}`;
  const nextStageLabel: string | null = round === 1 ? "Expert Creation" : isLastRound ? null : `Round ${round + 1}`;
  const nextPoolQ = useQuery({
    queryKey: ["pool", nextStageKey ?? "expert_creation"],
    queryFn: () => getPool({ stage: (nextStageKey ?? "expert_creation") as Parameters<typeof getPool>[0]["stage"] }),
    staleTime: 5 * 60_000,
    enabled: nextStageKey !== null,
  });
  const nextPool = nextPoolQ.data?.members ?? [];
  const nextNames = nextPoolQ.data?.names ?? {};

  const [grades, setGrades] = React.useState<Record<string, number>>({});
  const [remarks, setRemarks] = React.useState("");
  const [nextOwner, setNextOwner] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<{ verdict: string | null; total: number } | null>(null);

  const round1Row = round === 1 ? data.rounds.find((r) => r.round_number === 1) : undefined;
  const questions = startQ.data?.questions ?? [];
  const graded = questions.filter((q) => grades[q.question_id] != null).length;
  const allGraded = questions.length > 0 && graded === questions.length;
  const total = questions.reduce((s, q) => s + (grades[q.question_id] ?? 0), 0);

  async function submit() {
    if (!allGraded) {
      toast.warning("Grade every question before submitting.");
      return;
    }
    if (nextStageKey && !nextOwner) {
      toast.warning(`Select who takes ${nextStageLabel} before submitting.`);
      return;
    }
    setBusy(true);
    try {
      const r = await submitRound({
        lead_id: lead.id,
        round_number: round,
        grades: questions.map((q) => ({ question_id: q.question_id, question_text_used: q.question_text, grade: grades[q.question_id] ?? 0 })),
        remarks: remarks || null,
        next_owner_email: nextStageKey ? nextOwner : null,
      });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pipeline-snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-admin-extras"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-activity"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pool"] });
      setVerdict({ verdict: r.verdict ?? null, total: r.total_score ?? 0 });
      if (r.verdict === "passed") {
        toast.success(nextStageLabel ? `Round ${round} passed. Moving to ${nextStageLabel}.` : `Round ${round} passed. Lead completed.`);
      }
      else if (r.verdict === "failed") toast.error(`Round ${round} not passed.`);
      else toast.success(`Round ${round} saved.`);
      onChanged();
    } catch (e) {
      toast.error("Something went wrong.", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (verdict) {
    const passed = verdict.verdict === "passed";
    return (
      <Card>
        <CardContent className="p-6">
          <StatusPill kind={passed ? "passed" : "failed"} label={passed ? "Passed" : "Not passed"} />
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-foreground">
            Round {round} {passed ? "passed" : "not passed"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Total score: <span className="font-medium text-foreground">{verdict.total}</span>
          </p>
          {passed && (
            <p className="mt-2 text-sm text-muted-foreground">
              Lead moving to <span className="font-medium text-foreground">{nextNames[nextOwner] ?? nextOwner}</span> for {nextStageLabel}.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6">
        <p className="text-base font-semibold text-foreground">Round {round}</p>
        <p className="mt-1 text-sm text-muted-foreground">Grade each question — 0 is poor, higher is better.</p>

        {startQ.isLoading ? (
          <div className="mt-5 space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {questions.map((q, i) => (
              <div key={q.question_id}>
                <div className="text-xs font-medium text-muted-foreground">Question {i + 1} of {questions.length}</div>
                <p className="mt-1 text-sm text-foreground">{q.question_text}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Array.from({ length: (q.max_marks ?? 5) + 1 }, (_, i) => i).map((n) => {
                    const selected = grades[q.question_id] === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setGrades({ ...grades, [q.question_id]: n })}
                        className={`h-9 w-9 rounded-md border text-sm font-semibold transition-colors ${
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:border-muted-foreground/40"
                        }`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {questions.length > 0 && (
          <div className="mt-6 flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
            <span className="text-muted-foreground">Running total</span>
            <span className="font-semibold tabular-nums text-foreground">{total}</span>
          </div>
        )}

        {(round === 1 || round === 2) && (
          <div className="mt-4 flex flex-wrap items-start gap-3">
            {round === 1 && <RescheduleControl leadId={lead.id} round1={round1Row} onChanged={onChanged} />}
            <DropControl leadId={lead.id} stage={round === 1 ? "round_1" : "round_2"} onChanged={onChanged} />
          </div>
        )}

        <div className="mt-6 space-y-1.5">
          <Label>Notes (optional)</Label>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} />
        </div>

        {nextStageKey !== null && (
          <div className="mt-6 space-y-1.5">
            <Label>Who takes {nextStageLabel} if they pass?</Label>
            <Select value={nextOwner} onValueChange={setNextOwner}>
              <SelectTrigger><SelectValue placeholder="Select person" /></SelectTrigger>
              <SelectContent>
                {nextPool.map((m) => <SelectItem key={m} value={m}>{nextNames[m] ?? m}</SelectItem>)}
              </SelectContent>
            </Select>
            {nextPool.length === 0 && (
              <p className="text-xs text-destructive">No one is in the {nextStageLabel} pool yet — contact admin.</p>
            )}
          </div>
        )}

        {questions.length > 0 && (
          <div className="mt-6 text-xs text-muted-foreground">{graded} of {questions.length} questions graded</div>
        )}

        <Button onClick={submit} disabled={busy || !allGraded || (nextStageKey !== null && !nextOwner)} className="mt-4 w-full">
          {busy ? "Submitting…" : `Submit Round ${round}`}
        </Button>
      </CardContent>
    </Card>
  );
}

/* ===================== RESCHEDULE / DROP ===================== */

function invalidateDashboards(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["dashboard-pipeline-snapshot"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard-admin-extras"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard-activity"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard-pool"] });
}

const MAX_RESCHEDULES = 3;
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Round 1 only: "Reschedule" → "Reschedule 2" → "Reschedule 3", then stays
 * visible but disabled at 3. Opens a date + 12-hour time picker; the chosen
 * local time is sent as an ISO timestamp.
 */
function RescheduleControl({
  leadId,
  round1,
  onChanged,
}: {
  leadId: string;
  round1: LeadData["rounds"][number] | undefined;
  onChanged: () => void;
}) {
  const count = round1?.reschedule_count ?? 0;
  const history = round1?.reschedule_history ?? [];
  const latestTo = history[history.length - 1]?.rescheduled_to ?? null;
  const maxed = count >= MAX_RESCHEDULES;
  const label = count === 0 ? "Reschedule" : `Reschedule ${Math.min(count + 1, MAX_RESCHEDULES)}`;

  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState("");
  const [hour, setHour] = React.useState("");
  const [minute, setMinute] = React.useState("00");
  const [ampm, setAmpm] = React.useState<"AM" | "PM">("PM");
  const [busy, setBusy] = React.useState(false);
  const queryClient = useQueryClient();

  function reset() {
    setDate("");
    setHour("");
    setMinute("00");
    setAmpm("PM");
  }

  async function confirm() {
    if (!date || !hour) return;
    const [y, m, d] = date.split("-").map(Number);
    const h12 = Number(hour) % 12;
    const at = new Date(y, m - 1, d, ampm === "PM" ? h12 + 12 : h12, Number(minute));
    setBusy(true);
    try {
      const r = await rescheduleRound1({ lead_id: leadId, rescheduled_to: at.toISOString() });
      invalidateDashboards(queryClient);
      toast.success(`Round 1 rescheduled (${r.reschedule_count}/${MAX_RESCHEDULES}) for ${fmtSlot(at.toISOString())}.`);
      setOpen(false);
      reset();
      onChanged();
    } catch (e) {
      toast.error("Something went wrong.", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start gap-3">
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogTrigger asChild>
          <Button type="button" size="sm" variant="outline" disabled={maxed}>
            {label}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reschedule Round 1</DialogTitle>
            <DialogDescription>Pick the new date and time. {MAX_RESCHEDULES - count} reschedule{MAX_RESCHEDULES - count === 1 ? "" : "s"} left.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" min={todayYmd()} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Time</Label>
              <div className="flex gap-2">
                <Select value={hour} onValueChange={setHour}>
                  <SelectTrigger className="w-20"><SelectValue placeholder="Hr" /></SelectTrigger>
                  <SelectContent>{HOURS.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={minute} onValueChange={setMinute}>
                  <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                  <SelectContent>{MINUTES.map((mm) => <SelectItem key={mm} value={mm}>{mm}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={ampm} onValueChange={(v) => setAmpm(v as "AM" | "PM")}>
                  <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AM">AM</SelectItem>
                    <SelectItem value="PM">PM</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button disabled={busy || !date || !hour} onClick={confirm}>
              {busy ? "Saving…" : "Confirm reschedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {count > 0 && <RescheduleChip count={count} latestTo={latestTo} />}
    </div>
  );
}

/** "Drop" → pick a reason (Not Interested / Failed / Dropped Off) → confirm. The picker is the confirmation step. */
function DropControl({
  leadId,
  stage,
  onChanged,
}: {
  leadId: string;
  stage: "round_1" | "expert_creation" | "round_2";
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<DropReason | "">("");
  const [busy, setBusy] = React.useState(false);
  const queryClient = useQueryClient();

  async function confirm() {
    if (!reason) return;
    setBusy(true);
    try {
      await dropStage({ lead_id: leadId, stage, reason });
      invalidateDashboards(queryClient);
      toast.success(`Lead dropped — ${dropReasonLabel(reason)}.`);
      onChanged();
    } catch (e) {
      toast.error("Something went wrong.", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        Drop
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={reason} onValueChange={(v) => setReason(v as DropReason)}>
        <SelectTrigger className="h-9 w-44"><SelectValue placeholder="Drop reason" /></SelectTrigger>
        <SelectContent>
          {DROP_REASONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button type="button" size="sm" variant="destructive" disabled={!reason || busy} onClick={confirm}>
        {busy ? "Dropping…" : "Drop lead"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(false);
          setReason("");
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

/* ===================== EXPERT CREATION ===================== */

function ProfileActions({ data, onChanged }: { data: LeadData; onChanged: () => void }) {
  const { lead } = data;
  const numRounds = data.cfg.num_rounds;
  const [expertId, setExpertId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [nextOwner, setNextOwner] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const queryClient = useQueryClient();

  const round2PoolQ = useQuery({
    queryKey: ["pool", "round_2"],
    queryFn: () => getPool({ stage: "round_2" }),
    staleTime: 5 * 60_000,
    enabled: numRounds > 1,
  });
  const round2Pool = round2PoolQ.data?.members ?? [];
  const round2Names = round2PoolQ.data?.names ?? {};

  async function submit() {
    if (!expertId.trim()) { toast.warning("Enter an expert ID first."); return; }
    if (numRounds > 1 && !nextOwner) { toast.warning("Select who takes Round 2 before linking."); return; }
    setBusy(true);
    try {
      await linkExpertProfile({
        lead_id: lead.id,
        expert_id: expertId.trim(),
        notes: notes.trim() || null,
        next_owner_email: numRounds > 1 ? nextOwner : null,
      });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pipeline-snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-admin-extras"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-activity"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-pool"] });
      toast.success(numRounds > 1 ? "Expert profile linked. Moving to Round 2." : "Expert profile linked.");
      onChanged();
    } catch (e) {
      toast.error("Something went wrong.", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <p className="text-base font-semibold text-foreground">Link the expert profile</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Create the expert profile in the AstroLokal app, then enter its ID below.
        </p>
        <div className="mt-4 space-y-3">
          <Input value={expertId} onChange={(e) => setExpertId(e.target.value)} placeholder="Expert ID" />
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
          <DropControl leadId={lead.id} stage="expert_creation" onChanged={onChanged} />
          {numRounds > 1 && (
            <div className="space-y-1.5">
              <Label>Who takes Round 2?</Label>
              <Select value={nextOwner} onValueChange={setNextOwner}>
                <SelectTrigger><SelectValue placeholder="Select person" /></SelectTrigger>
                <SelectContent>
                  {round2Pool.map((m) => (
                    <SelectItem key={m} value={m}>{round2Names[m] ?? m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!round2PoolQ.isLoading && round2Pool.length === 0 && (
                <p className="text-xs text-destructive">No one is in the Round 2 pool yet — contact admin.</p>
              )}
            </div>
          )}
          <Button
            disabled={busy || !expertId.trim() || (numRounds > 1 && !nextOwner)}
            onClick={submit}
            className="w-full"
          >
            {busy ? "Linking…" : "Link and mark profile created"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
