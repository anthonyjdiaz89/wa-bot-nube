// Bot de recepción de Persistencia Digital — método WhatsApp Web (gratis, sin
// Cloud API). Mantiene la sesión del 573207333874 como "dispositivo vinculado",
// piensa con la API de NVIDIA y persiste todo en Supabase Storage, así que puede
// vivir en cualquier host gratuito always-on (Render) sin depender de un PC.
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrterm from "qrcode-terminal";
import pino from "pino";
import http from "node:http";
import { PERSONA, NEGOCIO } from "./negocio.js";
import { subir, bajar, restaurarAuth, respaldarAuth } from "./supabase.js";

const AUTH_DIR = "./auth";
const ALERTA_JID = (process.env.ALERT_WA || "573207317444") + "@s.whatsapp.net";
// chats internos que jamás se atienden (evita bucles con los sistemas del equipo)
const INTERNOS = new Set([
  "573207317444@s.whatsapp.net",
  "78379009204263@lid",
  "235687152496883@lid",
]);
const RE_AVISO = /\[AVISAR_EQUIPO:\s*([\s\S]+?)\]/;
const MAX_POR_DIA = 40;
const MAX_HISTORIAL = 16;

// ------------------------------------------------------------------ cerebro

// Cadena de cerebros (todas las APIs son OpenAI-compatibles): se intenta en
// orden y si uno se cuelga o falla, sigue el próximo — el cliente nunca espera.
// OpenRouter va primero si hay key (modelos :free); NVIDIA es la base probada.
const CEREBROS = [];
if (process.env.OPENROUTER_API_KEY) {
  CEREBROS.push({
    nombre: "openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: process.env.OPENROUTER_API_KEY,
    modelo: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
    timeout: 45000,
  });
}
if (process.env.NVIDIA_API_KEY) {
  CEREBROS.push(
    {
      nombre: "nvidia-70b",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      key: process.env.NVIDIA_API_KEY,
      modelo: process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct",
      timeout: 45000,
    },
    {
      nombre: "nvidia-8b",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      key: process.env.NVIDIA_API_KEY,
      modelo: "meta/llama-3.1-8b-instruct",
      timeout: 30000,
    }
  );
}

async function pensarCon(cerebro, historial, texto) {
  const r = await fetch(cerebro.url, {
    method: "POST",
    signal: AbortSignal.timeout(cerebro.timeout),
    headers: {
      Authorization: `Bearer ${cerebro.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cerebro.modelo,
      max_tokens: 400,
      temperature: 0.6,
      messages: [
        { role: "system", content: PERSONA + "\n\n---\n" + NEGOCIO },
        ...historial,
        { role: "user", content: texto },
      ],
    }),
  });
  if (!r.ok) throw new Error(`${cerebro.nombre} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const salida = (data.choices?.[0]?.message?.content || "").trim();
  if (!salida) throw new Error(`${cerebro.nombre}: respuesta vacía`);
  return salida;
}

async function pensar(historial, texto) {
  let ultimo = null;
  for (const cerebro of CEREBROS) {
    try {
      return await pensarCon(cerebro, historial, texto);
    } catch (e) {
      console.error(cerebro.nombre + ":", e.message);
      ultimo = e;
    }
  }
  throw ultimo || new Error("sin cerebros configurados");
}

// ------------------------------------------------------- estado por cliente

async function leerEstado(jid) {
  const b = await bajar(`wa-bot-nube/chats/${jid}.json`);
  if (!b) return { historial: [], dia: "", cuenta: 0 };
  try { return JSON.parse(b.toString("utf-8")); } catch { return { historial: [], dia: "", cuenta: 0 }; }
}

async function guardarEstado(jid, estado) {
  await subir(`wa-bot-nube/chats/${jid}.json`, JSON.stringify(estado), "application/json");
}

// ------------------------------------------------------------------ whatsapp

let sock = null;

async function conectar() {
  const restaurados = await restaurarAuth(AUTH_DIR);
  console.log(`auth restaurada de supabase: ${restaurados} archivos`);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    browser: ["Persistencia Digital", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await respaldarAuth(AUTH_DIR);
  });

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      qrterm.generate(qr, { small: true });
      await subir("wa-bot-nube/qr.txt", qr, "text/plain");
      console.log("QR nuevo publicado en supabase (wa-bot-nube/qr.txt)");
    }
    if (connection === "open") {
      console.log("conectado a WhatsApp");
      await respaldarAuth(AUTH_DIR);
    }
    if (connection === "close") {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      console.log("conexión cerrada, código", codigo);
      if (codigo !== DisconnectReason.loggedOut) {
        setTimeout(conectar, 3000);
      } else {
        console.log("SESIÓN CERRADA: hay que volver a vincular (borrar auth y reiniciar)");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await atender(m);
      } catch (e) {
        console.error("atender:", e.message);
      }
    }
  });
}

function textoDe(m) {
  const c = m.message;
  if (!c) return "";
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    (c.imageMessage && "[el cliente envió una imagen]") ||
    (c.audioMessage && "[el cliente envió un audio]") ||
    (c.documentMessage && "[el cliente envió un documento]") ||
    ""
  ).trim();
}

async function atender(m) {
  if (m.key.fromMe) return;
  const jid = m.key.remoteJid || "";
  if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) return; // sin grupos ni estados
  if (INTERNOS.has(jid)) return;

  const texto = textoDe(m);
  if (!texto) return;

  const estado = await leerEstado(jid);
  const hoy = new Date().toISOString().slice(0, 10);
  if (estado.dia !== hoy) { estado.dia = hoy; estado.cuenta = 0; }
  if (estado.cuenta >= MAX_POR_DIA) return;

  await sock.presenceSubscribe(jid).catch(() => {});
  await sock.sendPresenceUpdate("composing", jid).catch(() => {});

  let respuesta;
  try {
    respuesta = await pensar(estado.historial || [], texto.slice(0, 1200));
  } catch (e) {
    console.error("cerebro:", e.message);
    respuesta = "Gracias por escribirnos. En un momento una persona del equipo sigue la conversación por acá.";
    await sock.sendMessage(ALERTA_JID, { text: `El bot no pudo responder a ${jid}. Dijo: ${texto.slice(0, 200)}` }).catch(() => {});
  }

  const aviso = respuesta.match(RE_AVISO);
  if (aviso) {
    respuesta = respuesta.replace(RE_AVISO, "").trim();
    const lead = { t: new Date().toISOString(), de: jid, resumen: aviso[1].trim() };
    await subir(`wa-bot-nube/leads/${Date.now()}.json`, JSON.stringify(lead), "application/json");
    await sock.sendMessage(ALERTA_JID, { text: `Lead del WhatsApp: ${lead.resumen} (chat ${jid})` }).catch(() => {});
  }

  if (respuesta) {
    await sock.sendMessage(jid, { text: respuesta.slice(0, 4000) });
  }
  await sock.sendPresenceUpdate("paused", jid).catch(() => {});

  estado.historial = [
    ...(estado.historial || []),
    { role: "user", content: texto.slice(0, 1200) },
    { role: "assistant", content: respuesta || "(sin respuesta)" },
  ].slice(-MAX_HISTORIAL * 2);
  estado.cuenta = (estado.cuenta || 0) + 1;
  await guardarEstado(jid, estado);
  console.log(`respondido ${jid} (${respuesta.length} chars)`);
}

// ------------------------------------- servidor de salud + mantenerse despierto

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(sock?.user ? `ok ${sock.user.id}` : "arrancando");
  })
  .listen(PORT, () => console.log(`salud en :${PORT}`));

// en hosts gratuitos que duermen por inactividad, el bot se auto-pinguea
if (process.env.SELF_URL) {
  setInterval(() => {
    fetch(process.env.SELF_URL).catch(() => {});
  }, 10 * 60 * 1000);
}

// respaldo periódico de la sesión (las llaves de cifrado rotan con el uso)
setInterval(() => respaldarAuth(AUTH_DIR).catch(() => {}), 60 * 1000);

conectar();
