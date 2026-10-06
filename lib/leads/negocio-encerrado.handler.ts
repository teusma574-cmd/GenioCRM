/**
 * Negócio foi para GANHO ou PERDIDO → cancela o que estava agendado para o
 * contato (inscrições em fluxo de follow-up e retornos prometidos).
 *
 * É a FAXINA, não a garantia: quem impede o envio é a leitura feita na hora, no
 * gate de elegibilidade e no início de cada turno (`./negocio-encerrado.ts`).
 * Este consumidor existe para a fila de follow-ups mostrar "cancelado" assim que
 * o negócio fecha, e para um follow-up antigo não voltar a correr se o negócio
 * for reaberto semanas depois.
 *
 * Cobre toda forma de fechar (botão, arrasto no quadro, lote, IA, automação):
 * todas terminam num UPDATE de `stage_id`, e o banco emite `lead.won` /
 * `lead.lost`. Se o contato ainda tem outro negócio em aberto, nada é cancelado.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  cancelarFollowupsDoContatoViaSupabase,
  contatoComNegocioEncerradoViaSupabase,
} from "./negocio-encerrado";

const CONSUMER_KEY = "leads.negocio-encerrado-cala-followups";

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

async function handle(row: EventRow): Promise<HandlerResult> {
  const leadId =
    typeof row.payload?.lead_id === "string" && row.payload.lead_id
      ? row.payload.lead_id
      : row.entity_id;
  if (!leadId) return resultado("skipped", "sem_lead");

  const admin = createAdminClient();
  try {
    // ⚠️ Organização junto do id: o client é service-role e ignora RLS.
    const { data: lead, error } = await admin
      .from("crm_leads")
      .select("contact_id")
      .eq("organization_id", row.organization_id)
      .eq("id", leadId)
      .maybeSingle();
    if (error) return resultado("error", `leitura do negócio falhou: ${error.message}`);
    const contactId = (lead as { contact_id: string | null } | null)?.contact_id ?? null;
    if (!contactId) return resultado("skipped", "negocio_sem_contato");

    if (!(await contatoComNegocioEncerradoViaSupabase(admin, row.organization_id, contactId))) {
      return resultado("skipped", "contato_com_negocio_aberto");
    }
    const c = await cancelarFollowupsDoContatoViaSupabase(admin, row.organization_id, contactId);
    return resultado("ok", `inscricoes=${c.inscricoes} retornos=${c.retornos}`);
  } catch (err) {
    return resultado("error", (err instanceof Error ? err.message : String(err)).slice(0, 200));
  }
}

export const negocioEncerradoHandler: EventHandler = {
  key: CONSUMER_KEY,
  events: ["lead.won", "lead.lost"],
  handle,
};
