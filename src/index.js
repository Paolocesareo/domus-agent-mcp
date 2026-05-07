// Domus Agent MCP Server
// Cloudflare Worker - Streamable HTTP transport
// Auth via API key in query string: /mcp?key=xxx

const SUPABASE_URL = "https://nvdodhvpbiwfhnoixslz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52ZG9kaHZwYml3Zmhub2l4c2x6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjU0MzEzNCwiZXhwIjoyMDg4MTE5MTM0fQ.8y2lPxg68eFzdl26CC7_YvZLsoMiR6rPeCJ2oR8hVJI";

// --- Supabase helper ---
async function supaQuery(table, params = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- Auth: resolve API key to archivio IDs ---
async function resolveApiKey(key) {
  if (!key) return null;
  const rows = await supaQuery("api_keys", `select=studio_id,is_active&api_key=eq.${encodeURIComponent(key)}`);
  if (!rows.length || !rows[0].is_active) return null;
  const studioId = rows[0].studio_id;
  // Get all archivi for this studio
  const archivi = await supaQuery("archivi", `select=id,nome_archivio&studio_id=eq.${encodeURIComponent(studioId)}`);
  // Update last_used_at
  await fetch(`${SUPABASE_URL}/rest/v1/api_keys?api_key=eq.${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  });
  return { studioId, archivi };
}

// --- Tool definitions ---
const TOOLS = [
  {
    name: "lista_edifici",
    description: "Elenca tutti gli edifici/condomini gestiti con indirizzo e codice fiscale",
    inputSchema: {
      type: "object",
      properties: {
        archivio: { type: "string", description: "Nome archivio (opzionale, se non specificato mostra tutti)" },
      },
    },
  },
  {
    name: "dettaglio_edificio",
    description: "Mostra dettaglio di un edificio: unità, proprietari, conduttori",
    inputSchema: {
      type: "object",
      properties: {
        nome_edificio: { type: "string", description: "Nome o parte del nome dell'edificio" },
      },
      required: ["nome_edificio"],
    },
  },
  {
    name: "situazione_rate",
    description: "Mostra le rate emesse per un edificio o per tutti, con stato pagamento",
    inputSchema: {
      type: "object",
      properties: {
        nome_edificio: { type: "string", description: "Nome edificio (opzionale)" },
        solo_non_pagate: { type: "boolean", description: "Se true, mostra solo rate non pagate" },
      },
    },
  },
  {
    name: "cerca_morosi",
    description: "Trova condomini con rate scadute non pagate, con importi e dettagli",
    inputSchema: {
      type: "object",
      properties: {
        nome_edificio: { type: "string", description: "Nome edificio (opzionale, se vuoto cerca in tutti)" },
        importo_minimo: { type: "number", description: "Importo minimo arretrato (default 0)" },
      },
    },
  },
  {
    name: "lista_assemblee",
    description: "Elenca le assemblee con data, ordine del giorno e presenze",
    inputSchema: {
      type: "object",
      properties: {
        nome_edificio: { type: "string", description: "Nome edificio (opzionale)" },
      },
    },
  },
  {
    name: "lista_segnalazioni",
    description: "Elenca le segnalazioni (guasti, problemi, richieste) con stato e log",
    inputSchema: {
      type: "object",
      properties: {
        nome_edificio: { type: "string", description: "Nome edificio (opzionale)" },
      },
    },
  },
  {
    name: "cerca_anagrafica",
    description: "Cerca una persona per nome, cognome, codice fiscale o telefono",
    inputSchema: {
      type: "object",
      properties: {
        termine: { type: "string", description: "Termine di ricerca (nome, cognome, CF, telefono)" },
      },
      required: ["termine"],
    },
  },
  {
    name: "lista_promemoria",
    description: "Elenca i promemoria attivi o completati",
    inputSchema: {
      type: "object",
      properties: {
        solo_attivi: { type: "boolean", description: "Se true, mostra solo promemoria non completati" },
      },
    },
  },
];

// --- Tool execution ---
async function executeTool(name, args, ctx) {
  const archivioIds = ctx.archivi.map((a) => a.id);
  const archivioFilter = `archivio_id=in.(${archivioIds.join(",")})`;

  // Helper to filter by edificio name
  async function findEdificio(nome) {
    const edifici = await supaQuery("edifici", `select=*&${archivioFilter}&intestazione=ilike.*${encodeURIComponent(nome)}*`);
    return edifici;
  }

  // Helper to get esercizio IDs for an edificio
  async function getEserciziIds(edificioDomId, archivioId) {
    const esercizi = await supaQuery(
      "esercizi",
      `select=domustudio_id&archivio_id=eq.${archivioId}&edificio_domustudio_id=eq.${edificioDomId}&is_straordinario=eq.false&order=data_chiusura.desc&limit=1`
    );
    return esercizi.map((e) => e.domustudio_id);
  }

  switch (name) {
    case "lista_edifici": {
      let filter = archivioFilter;
      if (args.archivio) {
        const arch = ctx.archivi.find((a) => a.nome_archivio.toLowerCase().includes(args.archivio.toLowerCase()));
        if (arch) filter = `archivio_id=eq.${arch.id}`;
      }
      const edifici = await supaQuery("edifici", `select=intestazione,indirizzo,citta,cap,prov,codice_fiscale&${filter}`);
      return edifici.length
        ? edifici.map((e) => `🏢 ${e.intestazione}\n   ${e.indirizzo || ""}, ${e.cap || ""} ${e.citta || ""} (${e.prov || ""})\n   CF: ${e.codice_fiscale || "N/D"}`).join("\n\n")
        : "Nessun edificio trovato.";
    }

    case "dettaglio_edificio": {
      const edifici = await findEdificio(args.nome_edificio);
      if (!edifici.length) return `Nessun edificio trovato con nome "${args.nome_edificio}"`;
      const ed = edifici[0];
      // Get units for this building
      const unita = await supaQuery(
        "unita",
        `select=interno,piano,tipo,subalterno&${archivioFilter}&edificio_domustudio_id=eq.${ed.domustudio_id}&order=interno.asc`
      );
      // Get proprietari count
      const proprietari = await supaQuery(
        "proprietari",
        `select=domustudio_id&${archivioFilter}&limit=1000`
      );
      return [
        `🏢 ${ed.intestazione}`,
        `📍 ${ed.indirizzo || ""}, ${ed.cap || ""} ${ed.citta || ""}`,
        `CF: ${ed.codice_fiscale || "N/D"}`,
        `\n📊 Unità: ${unita.length}`,
        ...unita.map((u) => `  • Int. ${u.interno || "?"} - Piano ${u.piano || "?"} - ${u.tipo || "N/D"} (Sub. ${u.subalterno || "?"})`),
      ].join("\n");
    }

    case "situazione_rate": {
      let filter = archivioFilter;
      if (args.nome_edificio) {
        const edifici = await findEdificio(args.nome_edificio);
        if (!edifici.length) return `Nessun edificio trovato con nome "${args.nome_edificio}"`;
        // Get esercizi for this edificio
        const esercizi = await supaQuery(
          "esercizi",
          `select=domustudio_id&${archivioFilter}&edificio_domustudio_id=eq.${edifici[0].domustudio_id}`
        );
        const esIds = esercizi.map((e) => e.domustudio_id);
        if (esIds.length) {
          const rate = await supaQuery(
            "rate",
            `select=domustudio_id,data,descrizione,is_straordinaria&${archivioFilter}&esercizio_domustudio_id=in.(${esIds.join(",")})&order=data.desc&limit=20`
          );
          // For each rata, get importi
          const results = [];
          for (const rata of rate.slice(0, 10)) {
            const importi = await supaQuery(
              "rate_importi",
              `select=importo&${archivioFilter}&rata_domustudio_id=eq.${rata.domustudio_id}`
            );
            const totale = importi.reduce((sum, i) => sum + (parseFloat(i.importo) || 0), 0);
            // Check ricevute
            const ricevute = await supaQuery(
              "ricevute_rate",
              `select=domustudio_id&${archivioFilter}&esercizio_domustudio_id=in.(${esIds.join(",")})&limit=1`
            );
            results.push(`📄 ${rata.descrizione || "Rata"} - ${rata.data || ""}\n   Totale: €${totale.toFixed(2)}${rata.is_straordinaria ? " (STRAORDINARIA)" : ""}`);
          }
          return results.length ? results.join("\n\n") : "Nessuna rata trovata.";
        }
      }
      // General: count rate per archivio
      const rate = await supaQuery("rate", `select=domustudio_id,descrizione,data&${archivioFilter}&order=data.desc&limit=20`);
      return rate.length
        ? rate.map((r) => `📄 ${r.descrizione || "Rata"} - ${r.data || ""}`).join("\n")
        : "Nessuna rata trovata.";
    }

    case "cerca_morosi": {
      // Get rate_importi with importo > 0 and check against ricevute
      let filter = archivioFilter;
      const importoMin = args.importo_minimo || 0;

      // Get all rate_importi
      const importi = await supaQuery(
        "rate_importi",
        `select=domustudio_id,rata_domustudio_id,unita_domustudio_id,anagrafica_domustudio_id,importo,archivio_id&${filter}&importo=gt.${importoMin}&limit=500`
      );

      // Get ricevute to find paid ones
      const ricevute = await supaQuery(
        "ricevute_rate_unita",
        `select=unita_domustudio_id,rata_domustudio_id&${filter}&limit=2000`
      );

      const pagate = new Set(ricevute.map((r) => `${r.unita_domustudio_id}-${r.rata_domustudio_id}`));

      // Filter unpaid
      const nonPagate = importi.filter((i) => !pagate.has(`${i.unita_domustudio_id}-${i.rata_domustudio_id}`));

      if (!nonPagate.length) return "Nessun moroso trovato! Tutti in regola. ✅";

      // Aggregate by anagrafica
      const perPersona = {};
      for (const np of nonPagate) {
        const key = `${np.archivio_id}-${np.anagrafica_domustudio_id}`;
        if (!perPersona[key]) perPersona[key] = { anagId: np.anagrafica_domustudio_id, archivioId: np.archivio_id, totale: 0, count: 0 };
        perPersona[key].totale += parseFloat(np.importo) || 0;
        perPersona[key].count++;
      }

      // Sort by amount desc
      const sorted = Object.values(perPersona).sort((a, b) => b.totale - a.totale).slice(0, 20);

      // Get names
      const results = [];
      for (const p of sorted) {
        const anag = await supaQuery(
          "anagrafiche",
          `select=descrizione,telefono1,email&archivio_id=eq.${p.archivioId}&domustudio_id=eq.${p.anagId}&limit=1`
        );
        const nome = anag.length ? anag[0].descrizione : `ID ${p.anagId}`;
        const tel = anag.length && anag[0].telefono1 ? ` - Tel: ${anag[0].telefono1}` : "";
        const email = anag.length && anag[0].email ? ` - ${anag[0].email}` : "";
        results.push(`⚠️ ${nome}: €${p.totale.toFixed(2)} (${p.count} rate non pagate)${tel}${email}`);
      }

      return `Trovati ${Object.keys(perPersona).length} morosi:\n\n${results.join("\n")}`;
    }

    case "lista_assemblee": {
      let filter = archivioFilter;
      if (args.nome_edificio) {
        const edifici = await findEdificio(args.nome_edificio);
        if (!edifici.length) return `Nessun edificio trovato con nome "${args.nome_edificio}"`;
        const esercizi = await supaQuery(
          "esercizi",
          `select=domustudio_id&${archivioFilter}&edificio_domustudio_id=eq.${edifici[0].domustudio_id}`
        );
        const esIds = esercizi.map((e) => e.domustudio_id);
        if (esIds.length) {
          filter = `${archivioFilter}&esercizio_domustudio_id=in.(${esIds.join(",")})`;
        }
      }
      const assemblee = await supaQuery("assemblee", `select=*&${filter}&order=data.desc&limit=10`);
      if (!assemblee.length) return "Nessuna assemblea trovata.";

      const results = [];
      for (const a of assemblee) {
        const odg = await supaQuery("assemblee_odg", `select=descrizione&${archivioFilter}&assemblea_domustudio_id=eq.${a.domustudio_id}`);
        const presenti = await supaQuery("assemblee_presenti", `select=domustudio_id&${archivioFilter}&assemblea_domustudio_id=eq.${a.domustudio_id}`);
        results.push([
          `📋 Assemblea del ${a.data || "?"}`,
          `   Tipo: ${a.tipo || "Ordinaria"} - Presenti: ${presenti.length}`,
          ...(odg.length ? [`   OdG: ${odg.map((o) => o.descrizione).join("; ")}`] : []),
        ].join("\n"));
      }
      return results.join("\n\n");
    }

    case "lista_segnalazioni": {
      let filter = archivioFilter;
      const segnalazioni = await supaQuery("segnalazioni", `select=*&${filter}&order=data.desc&limit=20`);
      if (!segnalazioni.length) return "Nessuna segnalazione trovata.";

      const tipi = await supaQuery("segnalazioni_tipo", `select=domustudio_id,descrizione&${filter}`);
      const tipoMap = {};
      for (const t of tipi) tipoMap[t.domustudio_id] = t.descrizione;

      const results = [];
      for (const s of segnalazioni) {
        const logs = await supaQuery("segnalazioni_log", `select=data,descrizione&${archivioFilter}&segnalazione_domustudio_id=eq.${s.domustudio_id}&order=data.desc&limit=3`);
        results.push([
          `🔧 ${s.oggetto || "Segnalazione"} [${tipoMap[s.tipo_domustudio_id] || ""}]`,
          `   Data: ${s.data || "?"} - Stato: ${s.stato || "?"}`,
          ...(logs.length ? logs.map((l) => `   └ ${l.data}: ${l.descrizione}`) : []),
        ].join("\n"));
      }
      return results.join("\n\n");
    }

    case "cerca_anagrafica": {
      const t = encodeURIComponent(args.termine);
      const anag = await supaQuery(
        "anagrafiche",
        `select=descrizione,indirizzo,citta,codice_fiscale,partita_iva,telefono1,telefono2,email,pec,is_fornitore&${archivioFilter}&or=(descrizione.ilike.*${t}*,codice_fiscale.ilike.*${t}*,telefono1.ilike.*${t}*,email.ilike.*${t}*)&limit=10`
      );
      if (!anag.length) return `Nessuna persona trovata per "${args.termine}"`;
      return anag
        .map(
          (a) =>
            `👤 ${a.descrizione}${a.is_fornitore ? " [FORNITORE]" : ""}\n` +
            `   ${a.indirizzo || ""} ${a.citta || ""}\n` +
            `   CF: ${a.codice_fiscale || "N/D"} | P.IVA: ${a.partita_iva || "N/D"}\n` +
            `   Tel: ${a.telefono1 || "N/D"} | Email: ${a.email || "N/D"}${a.pec ? ` | PEC: ${a.pec}` : ""}`
        )
        .join("\n\n");
    }

    case "lista_promemoria": {
      let filter = archivioFilter;
      const promemoria = await supaQuery("promemoria", `select=*&${filter}&order=data.desc&limit=20`);
      if (!promemoria.length) return "Nessun promemoria trovato.";
      return promemoria
        .map((p) => {
          const stato = p.eseguito ? "✅" : "⏳";
          return `${stato} ${p.oggetto || "Promemoria"} - ${p.data || "?"}\n   ${p.descrizione || ""}`;
        })
        .join("\n\n");
    }

    default:
      return `Tool "${name}" non riconosciuto.`;
  }
}

// --- MCP Protocol Handler ---
function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMcpRequest(body, ctx) {
  const { method, id, params } = body;

  switch (method) {
    case "initialize":
      return jsonRpc(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Domus Agent", version: "1.0.0" },
      });

    case "notifications/initialized":
      return null; // notification, no response

    case "tools/list":
      return jsonRpc(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await executeTool(toolName, toolArgs, ctx);
        return jsonRpc(id, { content: [{ type: "text", text: result }] });
      } catch (err) {
        return jsonRpc(id, { content: [{ type: "text", text: `Errore: ${err.message}` }], isError: true });
      }
    }

    case "ping":
      return jsonRpc(id, {});

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// --- Worker entry point ---
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (path === "/" || path === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "Domus Agent MCP" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // MCP endpoint
    if (path === "/mcp" || path === "/sse") {
      // Auth
      const apiKey = url.searchParams.get("key");
      if (!apiKey) {
        return new Response(JSON.stringify({ error: "API key richiesta. Usa ?key=TUA_API_KEY" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const ctx = await resolveApiKey(apiKey);
      if (!ctx) {
        return new Response(JSON.stringify({ error: "API key non valida o disattivata." }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (request.method === "POST") {
        const body = await request.json();

        // Handle batch requests
        if (Array.isArray(body)) {
          const results = [];
          for (const req of body) {
            const res = await handleMcpRequest(req, ctx);
            if (res) results.push(res);
          }
          return new Response(JSON.stringify(results), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Single request
        const result = await handleMcpRequest(body, ctx);
        if (!result) return new Response("", { status: 204, headers: corsHeaders });
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET - return server info for SSE clients
      if (request.method === "GET") {
        return new Response(JSON.stringify({
          name: "Domus Agent MCP",
          version: "1.0.0",
          description: "Connettore per dati condomini da Domustudio",
          tools: TOOLS.length,
          archivi: ctx.archivi.map((a) => a.nome_archivio),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
