// Persistencia en Supabase Storage: la sesión de WhatsApp (carpeta auth/) y el
// estado de conversaciones viven en el bucket — el bot puede morir, moverse de
// host o redesplegarse y retoma la misma sesión sin re-escanear nada.
import fs from "node:fs";
import path from "node:path";

const URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = process.env.SUPABASE_BUCKET || "";

const cab = { Authorization: `Bearer ${KEY}`, apikey: KEY };

export async function subir(ruta, contenido, tipo = "application/octet-stream") {
  const r = await fetch(`${URL}/storage/v1/object/${BUCKET}/${ruta}`, {
    method: "POST",
    headers: { ...cab, "Content-Type": tipo, "x-upsert": "true" },
    body: contenido,
  });
  if (!r.ok) console.error("supabase subir", ruta, r.status);
  return r.ok;
}

export async function bajar(ruta) {
  const r = await fetch(`${URL}/storage/v1/object/${BUCKET}/${ruta}`, { headers: cab });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

export async function listar(prefijo) {
  const r = await fetch(`${URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...cab, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: prefijo, limit: 500 }),
  });
  if (!r.ok) return [];
  const items = await r.json();
  return (items || []).filter((i) => i.id).map((i) => i.name);
}

// ---- espejo de la carpeta auth/ (credenciales de la sesión de WhatsApp) ----

const PREFIJO = "wa-bot-nube/auth";

export async function restaurarAuth(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const nombres = await listar(PREFIJO);
  let n = 0;
  for (const nombre of nombres) {
    const cuerpo = await bajar(`${PREFIJO}/${nombre}`);
    if (cuerpo) {
      fs.writeFileSync(path.join(dir, nombre), cuerpo);
      n++;
    }
  }
  return n;
}

const subidos = new Map(); // nombre -> mtime ya sincronizado

export async function respaldarAuth(dir) {
  if (!fs.existsSync(dir)) return;
  for (const nombre of fs.readdirSync(dir)) {
    const ruta = path.join(dir, nombre);
    const mt = fs.statSync(ruta).mtimeMs;
    if (subidos.get(nombre) === mt) continue;
    await subir(`${PREFIJO}/${nombre}`, fs.readFileSync(ruta));
    subidos.set(nombre, mt);
  }
}
