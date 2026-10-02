import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/ai/agents/:id/attachments/:attachmentId — nome, quando enviar,
 *        teto de envios por conversa, ligado/desligado.
 * DELETE /api/v1/ai/agents/:id/attachments/:attachmentId — remove a linha e o
 *        arquivo do bucket.
 *
 * O arquivo em si não é trocado: quem quer outro arquivo remove e sobe de novo
 * (o formato é conferido no upload, e só lá).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { anexoPertenceAoAgente, BUCKET_DOS_ANEXOS } from "@/lib/ai/agents/anexos";
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { COLUNAS_DO_ANEXO, edicaoDoAnexoSchema, UUID_RX } from "../_comum";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; attachmentId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, attachmentId } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(attachmentId)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = edicaoDoAnexoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const { data, error } = await createAdminClient()
    .from("ai_agent_attachments")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("agent_id", id)
    .eq("id", attachmentId)
    .select(COLUNAS_DO_ANEXO)
    .maybeSingle();
  if (error?.code === "23505") {
    return fail("conflict", t("Este agente já tem um arquivo com esse nome."), 409, { requestId });
  }
  if (error) {
    logger.error("[agentes/anexos] update falhou", { detalhe: error.message, requestId });
    return fail("internal_error", "Erro ao salvar o arquivo.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Arquivo não encontrado."), 404, { requestId });

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "ai_agent.attachment_updated",
    resourceType: "ai_agents",
    resourceId: id,
    metadata: { attachment_id: attachmentId, campos: Object.keys(parsed.data) },
    requestId,
  });

  return ok({ attachment: data }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, attachmentId } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(attachmentId)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_agent_attachments")
    .delete()
    .eq("organization_id", orgId)
    .eq("agent_id", id)
    .eq("id", attachmentId)
    .select("id, storage_path")
    .maybeSingle();
  if (error) {
    logger.error("[agentes/anexos] delete falhou", { detalhe: error.message, requestId });
    return fail("internal_error", "Erro ao remover o arquivo.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Arquivo não encontrado."), 404, { requestId });

  // Só apaga do bucket o caminho que É deste agente, na forma que a rota gera.
  const caminho = (data as { storage_path: string }).storage_path;
  if (anexoPertenceAoAgente(caminho, orgId, id)) {
    const { error: erroRm } = await admin.storage.from(BUCKET_DOS_ANEXOS).remove([caminho]);
    if (erroRm) {
      logger.error("[agentes/anexos] arquivo não removido do bucket", {
        detalhe: erroRm.message,
        requestId,
      });
    }
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "ai_agent.attachment_removed",
    resourceType: "ai_agents",
    resourceId: id,
    metadata: { attachment_id: attachmentId },
    requestId,
  });

  return ok({ removed: true }, { requestId });
}
