"use client";

import { useT } from "@/hooks/i18n/useT";
/**
 * OS ARQUIVOS QUE ESTE ASSISTENTE PODE ENVIAR (migration 0500).
 *
 * O dono sobe PDF, imagem ou áudio, dá um NOME, escreve QUANDO enviar e escolhe
 * quantas vezes o arquivo pode sair na mesma conversa. O assistente lê essa
 * lista a cada atendimento e manda o arquivo sozinho quando a situação aparece.
 *
 * Esta seção salva NA HORA, e não junto do rascunho do agente: arquivo é
 * material vivo (trocar o cardápio não pede republicar o prompt), e a lista vale
 * já no próximo atendimento. Por isso ela só aparece em agente que já existe.
 *
 * O teto de envios é conferido no servidor (`lib/agent-engine/agent/anexos-do-agente.ts`),
 * não é só instrução de prompt.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ENVIOS_POR_CONVERSA_MAXIMO,
  ENVIOS_POR_CONVERSA_PADRAO,
  MAXIMO_DE_ANEXOS_POR_AGENTE,
  NOME_MAXIMO,
  QUANDO_ENVIAR_MAXIMO,
  TAMANHO_MAXIMO_DO_ANEXO,
  type TipoDeAnexo,
} from "@/lib/ai/agents/anexos";
import { apiClient } from "@/lib/api/client";

interface Anexo {
  id: string;
  name: string;
  send_when: string;
  kind: TipoDeAnexo;
  mime: string;
  size_bytes: number;
  max_sends_per_conversation: number;
  is_active: boolean;
}

interface Props {
  agentId: string;
  disabled?: boolean;
}

const ACEITA = ".pdf,.jpg,.jpeg,.png,.mp3,.ogg,.m4a,application/pdf,image/jpeg,image/png,audio/*";

function tamanhoLegivel(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function razaoDaFalha(resposta: Response, padrao: string): Promise<string> {
  const corpo = (await resposta.json().catch(() => null)) as
    { error?: { message?: string } } | null;
  return corpo?.error?.message ?? padrao;
}

export function AnexosDoAgente({ agentId, disabled = false }: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const chave = React.useMemo(() => ["ai", "agents", agentId, "attachments"], [agentId]);
  const base = `/api/v1/ai/agents/${agentId}/attachments`;

  const lista = useQuery({
    queryKey: chave,
    queryFn: async () => {
      const res = await apiClient.get<{ data: { attachments: Anexo[] } }>(base);
      return res.data.attachments;
    },
  });
  const anexos = lista.data ?? [];

  // Formulário de arquivo novo.
  const [arquivo, setArquivo] = React.useState<File | null>(null);
  const [nome, setNome] = React.useState("");
  const [quando, setQuando] = React.useState("");
  const [vezes, setVezes] = React.useState(String(ENVIOS_POR_CONVERSA_PADRAO));
  const campoDoArquivo = React.useRef<HTMLInputElement>(null);

  const rotulo = (kind: TipoDeAnexo): string =>
    kind === "image" ? t("Imagem") : kind === "audio" ? t("Áudio") : "PDF";

  const subir = useMutation({
    mutationFn: async () => {
      if (!arquivo) throw new Error(t("Escolha um arquivo."));
      if (arquivo.size > TAMANHO_MAXIMO_DO_ANEXO) throw new Error(t("O arquivo precisa ter até 16 MB."));
      const corpo = new FormData();
      corpo.append("file", arquivo);
      corpo.append("name", nome.trim());
      corpo.append("send_when", quando.trim());
      corpo.append("max_sends_per_conversation", vezes || "1");
      const resposta = await fetch(base, { method: "POST", body: corpo });
      if (!resposta.ok) throw new Error(await razaoDaFalha(resposta, t("Erro ao subir o arquivo.")));
    },
    onSuccess: () => {
      toast.success(t("Arquivo adicionado. O assistente já pode enviá-lo."));
      setArquivo(null);
      setNome("");
      setQuando("");
      setVezes(String(ENVIOS_POR_CONVERSA_PADRAO));
      if (campoDoArquivo.current) campoDoArquivo.current.value = "";
      void queryClient.invalidateQueries({ queryKey: chave });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const editar = useMutation({
    mutationFn: async (input: { id: string; mudanca: Partial<Anexo> }) => {
      await apiClient.patch(`${base}/${input.id}`, input.mudanca);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: chave }),
    onError: (e: Error) => {
      toast.error(e.message || t("Erro ao salvar o arquivo."));
      void queryClient.invalidateQueries({ queryKey: chave });
    },
  });

  const remover = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`${base}/${id}`);
    },
    onSuccess: () => {
      toast.success(t("Arquivo removido."));
      void queryClient.invalidateQueries({ queryKey: chave });
    },
    onError: (e: Error) => toast.error(e.message || t("Erro ao remover o arquivo.")),
  });

  const cheio = anexos.length >= MAXIMO_DE_ANEXOS_POR_AGENTE;
  const podeSubir = !disabled && !cheio && arquivo !== null && nome.trim() !== "" && !subir.isPending;

  return (
    <Card className="space-y-4 p-4" data-testid="anexos-do-agente">
      <div>
        <h3 className="text-sm font-medium">{t("Arquivos que ele pode enviar")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Suba PDFs, imagens e áudios, dê um nome e diga quando enviar. O assistente manda o arquivo sozinho quando a situação aparecer na conversa — ou quando você citar o nome do arquivo nas instruções dele. Vale a partir do próximo atendimento, sem precisar publicar.",
          )}
        </p>
      </div>

      {lista.isLoading ? (
        <p className="text-xs text-muted-foreground">{t("Carregando os arquivos…")}</p>
      ) : lista.isError ? (
        <p className="text-xs text-destructive">
          {t("Não foi possível carregar os arquivos. Recarregue a página.")}
        </p>
      ) : anexos.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="anexos-vazio">
          {t("Nenhum arquivo ainda. Sem arquivos, ele responde só com texto.")}
        </p>
      ) : (
        <div className="space-y-3">
          {anexos.map((a) => (
            <LinhaDoAnexo
              key={`${a.id}-${a.name}-${a.send_when}-${a.max_sends_per_conversation}`}
              anexo={a}
              rotulo={rotulo(a.kind)}
              disabled={disabled || editar.isPending || remover.isPending}
              onSalvar={(mudanca) => editar.mutate({ id: a.id, mudanca })}
              onRemover={() => remover.mutate(a.id)}
            />
          ))}
        </div>
      )}

      <div className="space-y-3 rounded-md border border-dashed border-border/60 p-3">
        <p className="text-xs font-medium">{t("Adicionar arquivo")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="anexo-arquivo" className="text-xs">
              {t("Arquivo (PDF, JPG, PNG, MP3, OGG ou M4A — até 16 MB)")}
            </Label>
            <Input
              id="anexo-arquivo"
              ref={campoDoArquivo}
              type="file"
              accept={ACEITA}
              disabled={disabled || cheio}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setArquivo(f);
                // O nome do arquivo vira sugestão de nome — o dono quase sempre ajusta.
                if (f && nome.trim() === "") {
                  setNome(f.name.replace(/\.[^.]+$/, "").slice(0, NOME_MAXIMO));
                }
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="anexo-nome" className="text-xs">
              {t("Nome (é por ele que o assistente escolhe o arquivo)")}
            </Label>
            <Input
              id="anexo-nome"
              value={nome}
              maxLength={NOME_MAXIMO}
              placeholder={t("Ex.: Cardápio completo")}
              disabled={disabled || cheio}
              onChange={(e) => setNome(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="anexo-quando" className="text-xs">
            {t("Quando enviar")}
          </Label>
          <Textarea
            id="anexo-quando"
            value={quando}
            rows={2}
            maxLength={QUANDO_ENVIAR_MAXIMO}
            placeholder={t("Ex.: quando o cliente pedir o cardápio ou perguntar os preços")}
            disabled={disabled || cheio}
            onChange={(e) => setQuando(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor="anexo-vezes" className="text-xs">
              {t("Máximo de envios na mesma conversa")}
            </Label>
            <Input
              id="anexo-vezes"
              type="number"
              min={1}
              max={ENVIOS_POR_CONVERSA_MAXIMO}
              className="w-24"
              value={vezes}
              disabled={disabled || cheio}
              onChange={(e) => setVezes(e.target.value)}
            />
          </div>
          <Button type="button" size="sm" disabled={!podeSubir} onClick={() => subir.mutate()}>
            {subir.isPending ? t("Enviando…") : t("Adicionar arquivo")}
          </Button>
        </div>
        {cheio ? (
          <p className="text-xs text-warning-fg">
            {t("Cada agente tem no máximo")} {MAXIMO_DE_ANEXOS_POR_AGENTE} {t("arquivos.")}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function LinhaDoAnexo({
  anexo,
  rotulo,
  disabled,
  onSalvar,
  onRemover,
}: {
  anexo: Anexo;
  rotulo: string;
  disabled: boolean;
  onSalvar: (mudanca: Partial<Anexo>) => void;
  onRemover: () => void;
}) {
  const t = useT();
  const [nome, setNome] = React.useState(anexo.name);
  const [quando, setQuando] = React.useState(anexo.send_when);
  const [vezes, setVezes] = React.useState(String(anexo.max_sends_per_conversation));

  const vezesNumero = Math.min(ENVIOS_POR_CONVERSA_MAXIMO, Math.max(1, Number(vezes) || 1));
  const mudou =
    nome.trim() !== anexo.name ||
    quando.trim() !== anexo.send_when ||
    vezesNumero !== anexo.max_sends_per_conversation;

  return (
    <div
      className="space-y-2 rounded-md border border-border/60 p-3"
      data-testid={`anexo-${anexo.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{rotulo}</span> ·{" "}
          {tamanhoLegivel(anexo.size_bytes)}
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor={`anexo-ligado-${anexo.id}`} className="text-xs font-normal">
            {anexo.is_active ? t("Ligado") : t("Desligado")}
          </Label>
          <Switch
            id={`anexo-ligado-${anexo.id}`}
            checked={anexo.is_active}
            disabled={disabled}
            onCheckedChange={(v) => onSalvar({ is_active: v })}
          />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
        <Input
          value={nome}
          maxLength={NOME_MAXIMO}
          aria-label={t("Nome")}
          disabled={disabled}
          onChange={(e) => setNome(e.target.value)}
        />
        <Input
          type="number"
          min={1}
          max={ENVIOS_POR_CONVERSA_MAXIMO}
          value={vezes}
          aria-label={t("Máximo de envios na mesma conversa")}
          title={t("Máximo de envios na mesma conversa")}
          disabled={disabled}
          onChange={(e) => setVezes(e.target.value)}
        />
      </div>
      <Textarea
        value={quando}
        rows={2}
        maxLength={QUANDO_ENVIAR_MAXIMO}
        aria-label={t("Quando enviar")}
        placeholder={t("Quando enviar")}
        disabled={disabled}
        onChange={(e) => setQuando(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (window.confirm(t("Remover este arquivo? O assistente deixa de enviá-lo."))) onRemover();
          }}
        >
          {t("Remover")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !mudou || nome.trim() === ""}
          onClick={() =>
            onSalvar({
              name: nome.trim(),
              send_when: quando.trim(),
              max_sends_per_conversation: vezesNumero,
            })
          }
        >
          {t("Salvar")}
        </Button>
      </div>
    </div>
  );
}
