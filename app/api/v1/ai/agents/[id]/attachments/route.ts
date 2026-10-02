import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/agents/:id/attachments — os arquivos que o agente pode enviar.
 * POST /api/v1/ai/agents/:id/attachments — sobe UM arquivo (multipart `file` +
 *      `name`, `send_when`, `max_sends_per_conversation`).
 *
 * O arquivo vai para `agent-attachments` pelo service role (o bucket não tem
 * policy nenhuma); é o `requireRole("admin")` daqui que autoriza — a mesma régua
 * de editar o agente. O caminho é gerado AQUI, nunca aceito do cliente, e o
 * formato é decidido pela assinatura dos bytes. Regras em `lib/ai/agents/anexos.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import {
  BUCKET_DOS_ANEXOS,
  farejarAnexo,
  MAXIMO_DE_ANEXOS_POR_AGENTE,
  TAMANHO_MAXIMO_DO_ANEXO,
} from "@/lib/ai/agents/anexos";
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { agenteDaOrganizacao, camposDoAnexoSchema, COLUNAS_DO_ANEXO, UUID_RX } from "./_comum";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const { data, error } = await createAdminClient()
    .from("ai_agent_attachments")
    .select(COLUNAS_DO_ANEXO)
    .eq("organization_id", orgId)
    .eq("agent_id", id)
    .order("created_at", { ascending: true });
  if (error) {
    logger.error("[agentes/anexos] leitura falhou", { detalhe: error.message, requestId });
    return fail("internal_error", "Erro ao ler os arquivos.", 500, { requestId });
  }
  return ok({ attachments: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  if (!(await agenteDaOrganizacao(orgId, id))) {
    return fail("not_found", t("Agente não encontrado."), 404, { requestId });
  }

  // Recusa pelo Content-Length declarado ANTES de bufferizar o corpo; o
  // `file.size` abaixo continua sendo o check autoritativo.
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DO_ANEXO + 1_048_576) {
    return fail("payload_too_large", t("O arquivo precisa ter até 16 MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }
  const campos = camposDoAnexoSchema.safeParse({
    name: form?.get("name") ?? "",
    send_when: form?.get("send_when") ?? "",
    max_sends_per_conversation: form?.get("max_sends_per_conversation") ?? 1,
  });
  if (!campos.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: campos.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (file.size <= 0) return fail("validation_failed", t("Arquivo vazio."), 422, { requestId });
  if (file.size > TAMANHO_MAXIMO_DO_ANEXO) {
    return fail("payload_too_large", t("O arquivo precisa ter até 16 MB."), 413, { requestId });
  }

  const admin = createAdminClient();
  const { count } = await admin
    .from("ai_agent_attachments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("agent_id", id);
  if ((count ?? 0) >= MAXIMO_DE_ANEXOS_POR_AGENTE) {
    return fail(
      "validation_failed",
      `${t("Cada agente tem no máximo")} ${MAXIMO_DE_ANEXOS_POR_AGENTE} ${t("arquivos.")}`,
      422,
      { requestId },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const formato = farejarAnexo(bytes);
  if (!formato) {
    return fail(
      "unsupported_media_type",
      t("O arquivo precisa ser PDF, imagem (JPG ou PNG) ou áudio (MP3, OGG ou M4A)."),
      415,
      { requestId, details: { content_type_declarado: file.type || null } },
    );
  }

  const caminho = `${orgId}/${id}/${randomUUID()}.${formato.ext}`;
  const { error: erroUp } = await admin.storage
    .from(BUCKET_DOS_ANEXOS)
    .upload(caminho, bytes, { contentType: formato.mime, upsert: false });
  if (erroUp) {
    logger.error("[agentes/anexos] upload falhou", { detalhe: erroUp.message, requestId });
    return fail("internal_error", "Erro ao subir o arquivo.", 500, { requestId });
  }

  const { data, error } = await admin
    .from("ai_agent_attachments")
    .insert({
      organization_id: orgId,
      agent_id: id,
      name: campos.data.name,
      send_when: campos.data.send_when,
      kind: formato.kind,
      mime: formato.mime,
      storage_path: caminho,
      size_bytes: file.size,
      max_sends_per_conversation: campos.data.max_sends_per_conversation,
      created_by: authz.user.id,
    })
    .select(COLUNAS_DO_ANEXO)
    .single();
  if (error || !data) {
    // A linha não nasceu: o arquivo não pode ficar órfão no bucket.
    await admin.storage.from(BUCKET_DOS_ANEXOS).remove([caminho]);
    if (error?.code === "23505") {
      return fail("conflict", t("Este agente já tem um arquivo com esse nome."), 409, { requestId });
    }
    logger.error("[agentes/anexos] insert falhou", { detalhe: error?.message, requestId });
    return fail("internal_error", "Erro ao salvar o arquivo.", 500, { requestId });
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "ai_agent.attachment_added",
    resourceType: "ai_agents",
    resourceId: id,
    metadata: { attachment_id: (data as { id: string }).id, kind: formato.kind },
    requestId,
  });

  return ok({ attachment: data }, { requestId });
}
