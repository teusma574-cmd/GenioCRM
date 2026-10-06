/**
 * NEGÓCIO ENCERRADO CALA A IA.
 *
 * Quando o negócio de um contato vai para GANHO ou PERDIDO, a IA para de falar
 * com ele: não responde mensagem nova e não dispara follow-up nem retorno
 * agendado. Pedido do operador — o cliente que já fechou (ou já recusou) não
 * pode continuar recebendo mensagem automática de venda.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * O contato está "encerrado" quando tem PELO MENOS UM negócio ganho/perdido e
 * NENHUM negócio em aberto. A conversa não tem `lead_id` (ela pende do contato,
 * e um contato pode ter vários negócios), então a regra é por contato:
 *
 *   - cliente que volta e ganha um negócio novo em aberto → a IA volta a atender;
 *   - negócio reaberto (volta para etapa aberta)          → a IA volta a atender;
 *   - contato sem negócio nenhum                          → nada muda.
 *
 * É a mesma leitura de `resolveActiveLeadForContact` (`./active-lead.ts`), que
 * só considera `status = 'open'` como negócio ativo.
 *
 * ─── Por que é lido na hora, e não gravado ──────────────────────────────────
 *
 * Um carimbo de "silenciado" teria de ser desfeito em toda reabertura, em todo
 * negócio novo, em toda importação — e `bot_silenced_until = 'infinity'` é
 * devolvido à IA pelo cron de devolução automática. Ler `crm_leads.status` no
 * instante do envio não tem corrida com o dreno de eventos e se cura sozinho.
 * O cancelamento do que já estava agendado (`cancelarFollowupsDoContato`) é
 * faxina por cima disso, não a garantia.
 *
 * O que NÃO é alcançado, de propósito: envio de pessoa pela tela, resposta
 * aprovada por pessoa, automações, campanhas e lembretes de agenda.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Gravado em `followup_enrollments.cancel_reason`. */
export const MOTIVO_CANCELAMENTO_POR_NEGOCIO_ENCERRADO = "negocio_encerrado";

/** Status de inscrição que ainda podem voltar a falar com o contato. */
const STATUS_DE_INSCRICAO_VIVA = [
  "active",
  "waiting_reply",
  "dormente",
  "paused_handoff",
  "paused_manual",
  "coletando",
] as const;

/** O mínimo de `pg.Pool`/`pg.PoolClient` que este módulo usa. */
export interface ConsultaPg {
  query<R = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Expressão SQL booleana da regra, para embutir em outra consulta.
 * `org` e `contato` são expressões SQL (coluna ou placeholder), nunca valor.
 */
export function sqlNegocioEncerrado(org: string, contato: string): string {
  return `(
    exists (
      select 1 from crm_leads nl
      where nl.organization_id = ${org} and nl.contact_id = ${contato}
        and nl.status in ('won', 'lost')
    )
    and not exists (
      select 1 from crm_leads nl
      where nl.organization_id = ${org} and nl.contact_id = ${contato}
        and nl.status = 'open'
    )
  )`;
}

/** A regra pura, sobre os status dos negócios do contato. */
export function negocioEncerradoPelosStatus(statuses: readonly string[]): boolean {
  return (
    statuses.some((s) => s === "won" || s === "lost") && !statuses.some((s) => s === "open")
  );
}

export async function contatoComNegocioEncerrado(
  db: ConsultaPg,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ encerrado: boolean }>(
    `select ${sqlNegocioEncerrado("$1", "$2")} as encerrado`,
    [organizationId, contactId],
  );
  return rows[0]?.encerrado === true;
}

/** Lança em erro de banco — o chamador decide (os caminhos de IA falham fechado). */
export async function contatoComNegocioEncerradoViaSupabase(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("crm_leads")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .limit(1000);
  if (error) throw new Error(`negócio encerrado: leitura falhou — ${error.message}`);
  return negocioEncerradoPelosStatus(
    ((data ?? []) as { status: string }[]).map((l) => l.status),
  );
}

export interface FollowupsCancelados {
  inscricoes: number;
  retornos: number;
}

/**
 * Cancela o que estava agendado para o contato: inscrições vivas em fluxo de
 * follow-up e retornos prometidos (`cron_jobs`). Idempotente — a segunda
 * passada não encontra linha viva.
 */
export async function cancelarFollowupsDoContato(
  db: ConsultaPg,
  organizationId: string,
  contactId: string,
): Promise<FollowupsCancelados> {
  const inscricoes = await db.query(
    `update followup_enrollments
        set status = 'cancelled', cancel_reason = $3, completed_at = now(),
            next_eval_at = null, claimed_until = null, updated_at = now()
      where organization_id = $1 and contact_id = $2 and status = any($4::text[])`,
    [
      organizationId,
      contactId,
      MOTIVO_CANCELAMENTO_POR_NEGOCIO_ENCERRADO,
      [...STATUS_DE_INSCRICAO_VIVA],
    ],
  );
  const retornos = await db.query(
    `update cron_jobs set enabled = false, updated_at = now()
      where organization_id = $1 and contact_id = $2 and enabled = true`,
    [organizationId, contactId],
  );
  return { inscricoes: inscricoes.rowCount ?? 0, retornos: retornos.rowCount ?? 0 };
}

export async function cancelarFollowupsDoContatoViaSupabase(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<FollowupsCancelados> {
  const { data: insc, error: inscErr } = await admin
    .from("followup_enrollments")
    .update({
      status: "cancelled",
      cancel_reason: MOTIVO_CANCELAMENTO_POR_NEGOCIO_ENCERRADO,
      completed_at: new Date().toISOString(),
      next_eval_at: null,
      claimed_until: null,
    })
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", [...STATUS_DE_INSCRICAO_VIVA])
    .select("id");
  if (inscErr) throw new Error(`followup_enrollments: ${inscErr.message}`);

  const { data: crons, error: cronErr } = await admin
    .from("cron_jobs")
    .update({ enabled: false })
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("enabled", true)
    .select("id");
  if (cronErr) throw new Error(`cron_jobs: ${cronErr.message}`);

  return { inscricoes: (insc ?? []).length, retornos: (crons ?? []).length };
}
