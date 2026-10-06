import { describe, expect, it } from "vitest";

import { decidirElegibilidade, montarEstadoDeElegibilidade } from "@/lib/ai/elegibilidade/gate";

import {
  cancelarFollowupsDoContato,
  contatoComNegocioEncerrado,
  negocioEncerradoPelosStatus,
  type ConsultaPg,
} from "./negocio-encerrado";

describe("negocioEncerradoPelosStatus", () => {
  it("ganho ou perdido, sem negócio aberto → encerrado", () => {
    expect(negocioEncerradoPelosStatus(["won"])).toBe(true);
    expect(negocioEncerradoPelosStatus(["lost"])).toBe(true);
    expect(negocioEncerradoPelosStatus(["lost", "won"])).toBe(true);
  });

  it("cliente que volta: negócio novo em aberto devolve o atendimento à IA", () => {
    expect(negocioEncerradoPelosStatus(["won", "open"])).toBe(false);
    expect(negocioEncerradoPelosStatus(["lost", "open"])).toBe(false);
  });

  it("contato sem negócio, ou só com aberto, não é encerrado", () => {
    expect(negocioEncerradoPelosStatus([])).toBe(false);
    expect(negocioEncerradoPelosStatus(["open"])).toBe(false);
  });
});

describe("gate de elegibilidade — negócio encerrado", () => {
  const cru = {
    aiGate: "open",
    forceHuman: false,
    assigneeKind: "ai",
    botSilencedUntil: null,
    aiAuthorizedAt: null,
    agora: new Date("2026-10-06T12:00:00Z"),
    ttlMs: 1000,
  };

  it("veta mesmo com o gate aberto", () => {
    const d = decidirElegibilidade(montarEstadoDeElegibilidade({ ...cru, negocioEncerrado: true }));
    expect(d).toEqual({ permite: false, motivo: "negocio_encerrado", bloqueioPorAllowlist: false });
  });

  it("ausente ou falso não muda nada", () => {
    expect(decidirElegibilidade(montarEstadoDeElegibilidade(cru)).permite).toBe(true);
    expect(
      decidirElegibilidade(montarEstadoDeElegibilidade({ ...cru, negocioEncerrado: false })).permite,
    ).toBe(true);
  });
});

function dbFalso(respostas: { rows?: unknown[]; rowCount?: number }[]) {
  const chamadas: { text: string; values: unknown[] | undefined }[] = [];
  const db: ConsultaPg = {
    async query<R>(text: string, values?: unknown[]) {
      chamadas.push({ text, values });
      const r = respostas.shift() ?? {};
      return { rows: (r.rows ?? []) as R[], rowCount: r.rowCount ?? 0 };
    },
  };
  return { db, chamadas };
}

describe("consultas pg", () => {
  it("contatoComNegocioEncerrado filtra organização e contato", async () => {
    const { db, chamadas } = dbFalso([{ rows: [{ encerrado: true }] }]);
    expect(await contatoComNegocioEncerrado(db, "org", "ct")).toBe(true);
    expect(chamadas[0]!.values).toEqual(["org", "ct"]);
    expect(chamadas[0]!.text).toContain("nl.organization_id = $1 and nl.contact_id = $2");
  });

  it("cancelarFollowupsDoContato cancela inscrições vivas e retornos, sempre por organização", async () => {
    const { db, chamadas } = dbFalso([{ rowCount: 2 }, { rowCount: 1 }]);
    expect(await cancelarFollowupsDoContato(db, "org", "ct")).toEqual({ inscricoes: 2, retornos: 1 });
    expect(chamadas[0]!.text).toContain("update followup_enrollments");
    expect(chamadas[0]!.values?.slice(0, 3)).toEqual(["org", "ct", "negocio_encerrado"]);
    expect(chamadas[1]!.text).toContain("update cron_jobs set enabled = false");
    for (const c of chamadas) expect(c.text).toContain("organization_id = $1");
  });
});
