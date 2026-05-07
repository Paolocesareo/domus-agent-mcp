// Domus Agent MCP Server v1.0.1
// Cloudflare Worker - Streamable HTTP transport
// Auth via API key in query string: /mcp?key=xxx

const SUPABASE_URL = "https://nvdodhvpbiwfhnoixslz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52ZG9kaHZwYml3Zmhub2l4c2x6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjU0MzEzNCwiZXhwIjoyMDg4MTE5MTM0fQ.8y2lPxg68eFzdl26CC7_YvZLsoMiR6rPeCJ2oR8hVJI";

async function supaQuery(table, params = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`Supabase error on ${table}: ${res.status}`);
  return res.json();
}

async function resolveApiKey(key) {
  if (!key) return null;
  const rows = await supaQuery("api_keys", `select=studio_id,is_active&api_key=eq.${encodeURIComponent(key)}`);
  if (!rows.length || !rows[0].is_active) return null;
  const studioId = rows[0].studio_id;
  const archivi = await supaQuery("archivi", `select=id,nome_archivio&studio_id=eq.${encodeURIComponent(studioId)}`);
  fetch(`${SUPABASE_URL}/rest/v1/api_keys?api_key=eq.${encodeURIComponent(key)}`, { method: "PATCH", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ last_used_at: new Date().toISOString() }) });
  return { studioId, archivi };
}

const TOOLS = [
  { name: "lista_edifici", description: "Elenca tutti gli edifici/condomini gestiti con indirizzo e codice fiscale", inputSchema: { type: "object", properties: { archivio: { type: "string", description: "Nome archivio (opzionale)" } } } },
  { name: "dettaglio_edificio", description: "Mostra dettaglio di un edificio: unita, proprietari, conduttori", inputSchema: { type: "object", properties: { nome_edificio: { type: "string", description: "Nome o parte del nome" } }, required: ["nome_edificio"] } },
  { name: "situazione_rate", description: "Mostra le rate emesse per un edificio con data e descrizione", inputSchema: { type: "object", properties: { nome_edificio: { type: "string", description: "Nome edificio (opzionale)" } } } },
  { name: "cerca_morosi", description: "Trova condomini con rate non pagate con importi e contatti", inputSchema: { type: "object", properties: { nome_edificio: { type: "string", description: "Nome edificio (opzionale)" }, importo_minimo: { type: "number", description: "Importo minimo (default 0)" } } } },
  { name: "lista_assemblee", description: "Elenca assemblee con data convocazione, OdG e presenze", inputSchema: { type: "object", properties: { nome_edificio: { type: "string", description: "Nome edificio (opzionale)" } } } },
  { name: "lista_segnalazioni", description: "Elenca segnalazioni (guasti, problemi) con stato e log", inputSchema: { type: "object", properties: { nome_edificio: { type: "string", description: "Nome edificio (opzionale)" } } } },
  { name: "cerca_anagrafica", description: "Cerca persona per nome, CF, telefono o email", inputSchema: { type: "object", properties: { termine: { type: "string", description: "Termine di ricerca" } }, required: ["termine"] } },
  { name: "lista_promemoria", description: "Elenca i promemoria attivi o completati", inputSchema: { type: "object", properties: { solo_attivi: { type: "boolean", description: "Se true solo non completati" } } } },
];

async function executeTool(name, args, ctx) {
  const ids = ctx.archivi.map((a) => a.id);
  const AF = `archivio_id=in.(${ids.join(",")})`;

  async function findEdificio(n) {
    return await supaQuery("edifici", `select=*&${AF}&intestazione=ilike.*${encodeURIComponent(n)}*`);
  }

  switch (name) {
    case "lista_edifici": {
      let f = AF;
      if (args.archivio) { const a = ctx.archivi.find((x) => x.nome_archivio.toLowerCase().includes(args.archivio.toLowerCase())); if (a) f = `archivio_id=eq.${a.id}`; }
      const ed = await supaQuery("edifici", `select=intestazione,indirizzo,citta,cap,prov,codice_fiscale&${f}`);
      return ed.length ? ed.map((e) => `🏢 ${e.intestazione}\n   ${e.indirizzo||""}, ${e.cap||""} ${e.citta||""} (${e.prov|""})\n   CF: ${e.codice_fiscale||"N/D"}`).join("\n\n") : "Nessun edificio trovato.";
    }
    case "dettaglio_edificio": {
      const ed = await findEdificio(args.nome_edificio);
      if (!ed.length) return `Nessun edificio "${args.nome_edificio}"`;
      const e = ed[0];
      const u = await supaQuery("unita", `select=interno,piano,tipo,subalterno&${AF}&edificio_domustudio_id=eq.${e.domustudio_id}&order=interno.asc`);
      return [`🏢 ${e.intestazione}`, `📍 ${e.indirizzo||""}, ${e.cap||""} ${e.citta||""}`, `CF: ${e.codice_fiscale||"N/D"}`, `\n📊 Unità: ${u.length}`, ...u.map((x) => `  • Int. ${x.interno||"?"} Piano ${x.piano||"?"} ${x.tipo||""} Sub.${x.subalterno||"?"}`)].join("\n");
    }
    case "situazione_rate": {
      if (args.nome_edificio) {
        const ed = await findEdificio(args.nome_edificio);
        if (!ed.length) return `Nessun edificio "${args.nome_edificio}"`;
        const es = await supaQuery("esercizi", `select=domustudio_id&${AF}&edificio_domustudio_id=eq.${ed[0].domustudio_id}`);
        if (es.length) {
          const esIds = es.map((x) => x.domustudio_id).join(",");
          const rate = await supaQuery("rate", `select=domustudio_id,data_rata,descrizione,is_straordinaria&${AF}&esercizio_domustudio_id=in.(${esIds})&order=data_rata.desc&limit=15`);
          const res = [];
          for (const r of rate) {
            const imp = await supaQuery("rate_importi", `select=importo&${AF}&rata_domustudio_id=eq.${r.domustudio_id}`);
            const tot = imp.reduce((s, i) => s + (parseFloat(i.importo)||0), 0);
            res.push(`📄 ${r.descrizione||"Rata"} - ${r.data_rata||""}\n   Totale: €${tot.toFixed(2)}${r.is_straordinaria ? " (STRAORD.)" : ""}`);
          }
          return res.length ? res.join("\n\n") : "Nessuna rata trovata.";
        }
      }
      const rate = await supaQuery("rate", `select=descrizione,data_rata&${AF}&order=data_rata.desc&limit=20`);
      return rate.length ? rate.map((r) => `📄 ${r.descrizione||"Rata"} - ${r.data_rata||""}`).join("\n") : "Nessuna rata.";
    }
    case "cerca_morosi": {
      const minImp = args.importo_minimo || 0;
      const importi = await supaQuery("rate_importi", `select=rata_domustudio_id,unita_domustudio_id,anagrafica_domustudio_id,importo,archivio_id&${AF}&importo=gt.${minImp}&limit=500`);
      const ricevute = await supaQuery("ricevute_rate_unita", `select=unita_domustudio_id,ricevuta_domustudio_id&${AF}&limit=2000`);
      const ricRate = await supaQuery("ricevute_rate", `select=domustudio_id,anagrafica_domustudio_id&${AF}&limit=2000`);
      const pagate = new Set();
      for (const ru of ricevute) { const rr = ricRate.find(r => r.domustudio_id === ru.ricevuta_domustudio_id); if (rr) pagate.add(`${rr.anagrafica_domustudio_id}-${ru.unita_domustudio_id}`); }
      const pp = {};
      for (const i of importi) { const k = `${i.archivio_id}-${i.anagrafica_domustudio_id}`; if (!pp[k]) pp[k] = { anagId: i.anagrafica_domustudio_id, archId: i.archivio_id, tot: 0, cnt: 0 }; pp[k].tot += parseFloat(i.importo)||0; pp[k].cnt++; }
      if (!Object.keys(pp).length) return "Nessun moroso trovato! Tutti in regola. ✅";
      const sorted = Object.values(pp).sort((a,b) => b.tot - a.tot).slice(0, 20);
      const res = [];
      for (const p of sorted) {
        const an = await supaQuery("anagrafiche", `select=descrizione,telefono1,email&archivio_id=eq.${p.archId}&domustudio_id=eq.${p.anagId}&limit=1`);
        const nm = an.length ? an[0].descrizione : `ID ${p.anagId}`;
        const tel = an.length && an[0].telefono1 ? ` Tel:${an[0].telefono1}` : "";
        const em = an.length && an[0].email ? ` ${an[0].email}` : "";
        res.push(`⚠️ ${nm}: €${p.tot.toFixed(2)} (${p.cnt} rate)${tel}${em}`);
      }
      return `Trovati ${Object.keys(pp).length} posizioni:\n\n${res.join("\n")}`;
    }
    case "lista_assemblee": {
      let f = AF;
      if (args.nome_edificio) { const ed = await findEdificio(args.nome_edificio); if (ed.length) f = `${AF}&edificio_domustudio_id=eq.${ed[0].domustudio_id}`; else return `Nessun edificio "${args.nome_edificio}"`; }
      const ass = await supaQuery("assemblee", `select=domustudio_id,prima_convocazione_data,prima_convocazione_ora,prima_convocazione_luogo,seconda_convocazione_data,seconda_convocazione_ora,descrizione,archivio_id&${f}&order=prima_convocazione_data.desc&limit=10`);
      if (!ass.length) return "Nessuna assemblea trovata.";
      const res = [];
      for (const a of ass) {
        const odg = await supaQuery("assemblee_odg", `select=voce,sort_id&archivio_id=eq.${a.archivio_id}&assemblea_domustudio_id=eq.${a.domustudio_id}&order=sort_id.asc`);
        const pres = await supaQuery("assemblee_presenti", `select=domustudio_id&archivio_id=eq.${a.archivio_id}&assemblea_domustudio_id=eq.${a.domustudio_id}`);
        res.push([`📋 Assemblea ${a.prima_convocazione_data||"?"}${a.prima_convocazione_ora?" ore "+a.prima_convocazione_ora:""}`, `   Luogo: ${a.prima_convocazione_luogo||"N/D"}`, a.seconda_convocazione_data?`   2ª conv: ${a.seconda_convocazione_data}`:null, `   Presenti: ${pres.length}`, ...(odg.length?[`   OdG:\n${odg.map(o=>`     ${o.sort_id}. ${o.voce}`).join("\n")}`]:[])].filter(Boolean).join("\n"));
      }
      return res.join("\n\n");
    }
    case "lista_segnalazioni": {
      let f = AF;
      if (args.nome_edificio) { const ed = await findEdificio(args.nome_edificio); if (ed.length) f = `${AF}&edificio_domustudio_id=eq.${ed[0].domustudio_id}`; }
      const seg = await supaQuery("segnalazioni", `select=domustudio_id,oggetto,data,stato,priorita,tipo_segnalazione_domustudio_id,data_chiusura,archivio_id&${f}&order=data.desc&limit=20`);
      if (!seg.length) return "Nessuna segnalazione trovata.";
      const tipi = await supaQuery("segnalazioni_tipo", `select=domustudio_id,descrizione&${AF}`);
      const tm = {}; for (const t of tipi) tm[t.domustudio_id] = t.descrizione;
      const res = [];
      for (const s of seg) {
        const logs = await supaQuery("segnalazioni_log", `select=log_timestamp,desc_extra_data_short&archivio_id=eq.${s.archivio_id}&segnalazione_domustudio_id=eq.${s.domustudio_id}&order=log_timestamp.desc&limit=3`);
        res.push([`🔧 ${s.oggetto||"Segnalazione"} [${tm[s.tipo_segnalazione_domustudio_id]||""}]`, `   Data: ${s.data||"?"} Stato: ${s.stato||"?"} Priorità: ${s.priorita||"?"}`, s.data_chiusura?`   Chiusa: ${s.data_chiusura}`:null, ...(logs.length?logs.map(l=>`   └ ${l.log_timestamp||""}: ${l.desc_extra_data_short||""}`):[])].filter(Boolean).join("\n"));
      }
      return res.join("\n\n");
    }
    case "cerca_anagrafica": {
      const t = encodeURIComponent(args.termine);
      const an = await supaQuery("anagrafiche", `select=descrizione,indirizzo,citta,codice_fiscale,partita_iva,telefono1,telefono2,email,pec,is_fornitore&${AF}&or=(descrizione.ilike.*${t}*,codice_fiscale.ilike.*${t}*,telefono1.ilike.*${t}*,email.ilike.*${t}*)&limit=10`);
      if (!an.length) return `Nessuna persona trovata per "${args.termine}"`;
      return an.map(a => `👤 ${a.descrizione}${a.is_fornitore?" [FORNITORE]":""}\n   ${a.indirizzo||""} ${a.citta||""}\n   CF: ${a.codice_fiscale||"N/D"} | P.IVA: ${a.partita_iva||"N/D"}\n   Tel: ${a.telefono1||"N/D"} | Email: ${a.email||"N/D"}${a.pec?` | PEC: ${a.pec}`:""}`).join("\n\n");
    }
    case "lista_promemoria": {
      const pm = await supaQuery("promemoria", `select=*&${AF}&order=data.desc&limit=20`);
      if (!pm.length) return "Nessun promemoria.";
      return pm.map(p => `${p.eseguito?"✅":"⏳"} ${p.oggetto||"Promemoria"} - ${p.data||"?"}\n   ${p.descrizione||""}`).join("\n\n");
    }
    default: return `Tool "${name}" non riconosciuto.`;
  }
}

function jsonRpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMcpRequest(body, ctx) {
  const { method, id, params } = body;
  switch (method) {
    case "initialize": return jsonRpc(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Domus Agent", version: "1.0.1" } });
    case "notifications/initialized": return null;
    case "tools/list": return jsonRpc(id, { tools: TOOLS });
    case "tools/call": {
      try { const result = await executeTool(params?.name, params?.arguments||{}, ctx); return jsonRpc(id, { content: [{ type: "text", text: result }] }); }
      catch (err) { return jsonRpc(id, { content: [{ type: "text", text: `Errore: ${err.message}` }], isError: true }); }
    }
    case "ping": return jsonRpc(id, {});
    default: return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (path === "/" || path === "/health") return new Response(JSON.stringify({ status: "ok", service: "Domus Agent MCP", version: "1.0.1" }), { headers: { ...cors, "Content-Type": "application/json" } });
    if (path === "/mcp" || path === "/sse") {
      const apiKey = url.searchParams.get("key");
      if (!apiKey) return new Response(JSON.stringify({ error: "API key richiesta" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
      const ctx = await resolveApiKey(apiKey);
      if (!ctx) return new Response(JSON.stringify({ error: "API key non valida" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
      if (request.method === "POST") {
        const body = await request.json();
        if (Array.isArray(body)) { const r = []; for (const req of body) { const res = await handleMcpRequest(req, ctx); if (res) r.push(res); } return new Response(JSON.stringify(r), { headers: { ...cors, "Content-Type": "application/json" } }); }
        const result = await handleMcpRequest(body, ctx);
        if (!result) return new Response("", { status: 204, headers: cors });
        return new Response(JSON.stringify(result), { headers: { ...cors, "Content-Type": "application/json" } });
      }
      if (request.method === "GET") return new Response(JSON.stringify({ name: "Domus Agent MCP", version: "1.0.1", tools: TOOLS.length, archivi: ctx.archivi.map(a => a.nome_archivio) }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404, headers: cors });
  },
};
