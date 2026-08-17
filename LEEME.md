# Bot de WhatsApp en la nube — gratis, sin Cloud API, sin depender del PC

Método "WhatsApp Web": el bot se conecta como un dispositivo vinculado más del
573207333874 (igual que WhatsApp Web en un navegador). Cerebro: API gratuita de
NVIDIA. Sesión y estado: Supabase Storage — el bot puede morir, redesplegarse o
cambiar de host y retoma la sesión sin re-escanear.

Código: https://github.com/anthonyjdiaz89/wa-bot-nube (privado)

## Por qué no Vercel
Vercel solo corre funciones que viven segundos; la conexión de WhatsApp Web
necesita un proceso encendido 24/7 con websocket. Por eso el bot va en Render
(plan Free, sin tarjeta) y se mantiene despierto auto-pingueándose (SELF_URL).

## Encenderlo (una sola vez)

1. **API key de NVIDIA (gratis):** build.nvidia.com → cuenta gratuita →
   "Get API Key". Modelo por defecto: meta/llama-3.3-70b-instruct.
2. **Render:** render.com → Sign in with GitHub → New → Web Service →
   repo `wa-bot-nube` → plan **Free**. Variables de entorno:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET` (los mismos
     de `D:\pd\web\meta\.env`)
   - `NVIDIA_API_KEY` (paso 1)
   - `SELF_URL` = la URL del servicio (https://wa-bot-persistencia.onrender.com)
3. **Vincular el número:** al arrancar sin sesión, el bot publica el QR en
   Supabase (`wa-bot-nube/qr.txt`) y en los logs de Render. Claude lo renderiza
   como imagen para escanearlo desde el WhatsApp del terminal EDA51
   (Dispositivos vinculados → Vincular dispositivo). Una sola vez.
4. **Apagar el interino del PC:** cuando el de Render responda, deshabilitar en
   el registro (HKCU\...\Run) "WhatsApp Bridge Clientes" y "WhatsApp Bot
   Clientes" y matar sus procesos — si quedan los dos prendidos el cliente
   recibe respuesta doble.

## Qué hace
- Persona de recepción/ventas (sin emojis, sin precios, captura de lead).
- Escalada [AVISAR_EQUIPO: ...] → lead a Supabase (`wa-bot-nube/leads/`) y aviso
  por WhatsApp al 573207317444 (PD Admin).
- Historial corto por chat, tope 40 respuestas/cliente/día, ignora grupos,
  estados y los números internos del equipo.
