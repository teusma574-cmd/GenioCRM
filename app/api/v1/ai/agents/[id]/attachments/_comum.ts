/**
 * O que as duas rotas de arquivos do agente compartilham (migration 0500).
 *
 * A escrita é por service role (a tabela não tem policy de escrita), então a
 * organização vem do cookie via `requireRole` e filtra TODA query explicitamente.
 */
import { z } from "zod";

import {
  ENVIOS_POR_CONVERSA_MAXIMO,
  NOME_MAXIMO,
  QUANDO_ENVIAR_MAXIMO,
} from "@/lib/ai/agents/anexos";
import { createAdminClient } from "@/lib/supabase/admin";

export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const COLUNAS_DO_ANEXO =
  "id, agent_id, name, send_when, kind, mime, size_bytes, max_sends_per_conversation, is_active, created_at, updated_at";

export const camposDoAnexoSchema = z.object({
  name: z.string().trim().min(1).max(NOME_MAXIMO),
  send_when: z.string().trim().max(QUANDO_ENVIAR_MAXIMO).default(""),
  max_sends_per_conversation: z.coerce
    .number()
    .int()
    .min(1)
    .max(ENVIOS_POR_CONVERSA_MAXIMO)
    .default(1),
});

export const edicaoDoAnexoSchema = z
  .object({
    name: z.string().trim().min(1).max(NOME_MAXIMO).optional(),
    send_when: z.string().trim().max(QUANDO_ENVIAR_MAXIMO).optional(),
    max_sends_per_conversation: z.number().int().min(1).max(ENVIOS_POR_CONVERSA_MAXIMO).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "nada_a_mudar" });

/** O agente existe NESTA organização? Service role não tem RLS para responder. */
export async function agenteDaOrganizacao(orgId: string, agentId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("ai_agents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", agentId)
    .maybeSingle();
  return data !== null;
}
