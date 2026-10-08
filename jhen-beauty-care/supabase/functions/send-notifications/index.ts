// =============================================================================
// Edge Function: send-notifications (estrutura pronta para integração)
// Consome a fila de notificações externas (tabela notifications, channel <> 'in_app',
// status 'pending') e envia por e-mail, WhatsApp ou SMS. Agende com pg_cron (README).
//
// Provedores sugeridos (troque à vontade, a fila é independente do provedor):
//   E-mail   → Resend          (RESEND_API_KEY, EMAIL_FROM)
//   WhatsApp → WhatsApp Cloud API da Meta (WHATSAPP_TOKEN, WHATSAPP_PHONE_ID)
//   SMS      → Twilio          (TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM)
// Canal sem credencial configurada é ignorado (a mensagem continua na fila).
// Proteja a chamada com o header x-cron-secret = CRON_SECRET.
// =============================================================================
import { adminClient } from '../_shared/utils.ts';

type Row = { id: string; channel: string; title: string; message: string; user: { full_name: string; email: string; phone: string | null } };

const digits = (v: string | null) => (v ?? '').replace(/\D/g, '');
const brPhone = (v: string | null) => { const d = digits(v); return d.startsWith('55') ? d : `55${d}`; };

async function sendEmail(r: Row) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return 'skip';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: Deno.env.get('EMAIL_FROM'), to: r.user.email, subject: r.title, text: r.message }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
  return 'sent';
}

async function sendWhatsApp(r: Row) {
  const token = Deno.env.get('WHATSAPP_TOKEN');
  const phoneId = Deno.env.get('WHATSAPP_PHONE_ID');
  if (!token || !phoneId || !r.user.phone) return 'skip';
  // Mensagens iniciadas pela empresa exigem TEMPLATE aprovado na Meta. Ajuste o nome/idioma.
  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: brPhone(r.user.phone),
      type: 'template',
      template: { name: 'aviso_agendamento', language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: r.message }] }] },
    }),
  });
  if (!res.ok) throw new Error(`whatsapp ${res.status}`);
  return 'sent';
}

async function sendSms(r: Row) {
  const sid = Deno.env.get('TWILIO_SID');
  const token = Deno.env.get('TWILIO_TOKEN');
  if (!sid || !token || !r.user.phone) return 'skip';
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: `+${brPhone(r.user.phone)}`, From: Deno.env.get('TWILIO_FROM') ?? '', Body: `${r.title}: ${r.message}` }),
  });
  if (!res.ok) throw new Error(`twilio ${res.status}`);
  return 'sent';
}

const SENDERS: Record<string, (r: Row) => Promise<string>> = { email: sendEmail, whatsapp: sendWhatsApp, sms: sendSms };

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const db = adminClient();
  const { data, error } = await db
    .from('notifications')
    .select('id, channel, title, message, user:profiles(full_name, email, phone)')
    .neq('channel', 'in_app')
    .eq('status', 'pending')
    .order('created_at')
    .limit(50);
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0;
  for (const row of (data ?? []) as unknown as Row[]) {
    try {
      const result = await SENDERS[row.channel]?.(row);
      if (result === 'sent') {
        await db.from('notifications').update({ status: 'sent', sent_at: new Date().toISOString(), error: null }).eq('id', row.id);
        sent++;
      }
    } catch (err) {
      await db.from('notifications').update({ status: 'failed', error: String(err).slice(0, 300) }).eq('id', row.id);
    }
  }
  return new Response(JSON.stringify({ processed: data?.length ?? 0, sent }), { headers: { 'Content-Type': 'application/json' } });
});
