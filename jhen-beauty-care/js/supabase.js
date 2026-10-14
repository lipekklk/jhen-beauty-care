/**
 * Cliente Supabase único para todo o site.
 * Biblioteca oficial carregada do CDN com versão fixa (evita mudanças inesperadas).
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/** false enquanto js/config.js ainda tiver os valores de exemplo. */
export const supabaseReady = !SUPABASE_URL.includes('SEU-PROJETO') && !SUPABASE_ANON_KEY.startsWith('SUA-');

/**
 * Aceita a URL mesmo se colada com sufixos do painel (ex.: ".../rest/v1/" do "RESTful endpoint").
 * O cliente precisa só da raiz: https://<ref>.supabase.co
 */
const PROJECT_URL = SUPABASE_URL.trim().replace(/\/(rest|auth)\/v1\/?$/i, '').replace(/\/+$/, '');

export const supabase = createClient(
  supabaseReady ? PROJECT_URL : 'https://placeholder.supabase.co',
  supabaseReady ? SUPABASE_ANON_KEY : 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // links de recuperação de senha / confirmação de e-mail
    },
  },
);

/** URL pública de um arquivo do bucket "media" do Storage. */
export function publicMediaUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) return path;
  return supabase.storage.from('media').getPublicUrl(path).data.publicUrl;
}

/** Envia uma imagem para o bucket "media" e retorna a URL pública. */
export async function uploadMedia(file, folder) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('INVALID_IMAGE_TYPE');
  if (file.size > 5 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
  const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('media').upload(path, file, { cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return publicMediaUrl(path);
}
