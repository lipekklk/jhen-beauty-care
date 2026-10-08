/**
 * Consultas compartilhadas (com cache por página) e chamadas RPC de negócio.
 */
import { supabase } from './supabase.js';
import { setTimezone, unwrap } from './utils.js';

const cache = new Map();
const cached = (key, loader) => {
  if (!cache.has(key)) cache.set(key, loader().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
};
export const invalidate = (key) => (key ? cache.delete(key) : cache.clear());

/** Configurações públicas do negócio (contato, políticas, provedor de pagamento). */
export const getSettings = () => cached('settings', async () => {
  const data = unwrap(await supabase.from('settings').select('*').eq('id', 1).single());
  setTimezone(data.timezone);
  return data;
});

export const getBusinessHours = () => cached('business_hours', async () =>
  unwrap(await supabase.from('business_hours').select('*').order('weekday')));

export const getActiveServices = () => cached('services', async () =>
  unwrap(await supabase.from('services')
    .select('id, name, description, price, duration_minutes, image_url, payment_mode, deposit_amount, allow_on_site, sort_order, is_test_data')
    .eq('is_active', true)
    .order('sort_order').order('name')));

/** Profissionais ativas que realizam um procedimento. */
export async function getEmployeesForService(serviceId) {
  const rows = unwrap(await supabase.from('employee_services')
    .select('employee:employees!inner(id, display_name, title, bio, photo_url, is_active, is_test_data)')
    .eq('service_id', serviceId)
    .eq('employee.is_active', true));
  return rows.map((r) => r.employee).filter(Boolean).sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export const getMonthAvailability = (serviceId, monthKey, employeeId = null) =>
  supabase.rpc('get_month_availability', { p_service_id: serviceId, p_month: monthKey, p_employee_id: employeeId }).then(unwrap);

export const getAvailableSlots = (serviceId, dateKey, employeeId = null, ignoreAppointment = null) =>
  supabase.rpc('get_available_slots', {
    p_service_id: serviceId, p_date: dateKey, p_employee_id: employeeId, p_ignore_appointment: ignoreAppointment,
  }).then(unwrap);

export const bookAppointment = (params) => supabase.rpc('book_appointment', params).then(unwrap);
export const cancellationQuote = (id) => supabase.rpc('cancellation_quote', { p_appointment_id: id }).then(unwrap);
export const cancelAppointment = (id, reason) => supabase.rpc('cancel_appointment', { p_appointment_id: id, p_reason: reason || null }).then(unwrap);
export const rescheduleAppointment = (id, start, employeeId = null) =>
  supabase.rpc('reschedule_appointment', { p_appointment_id: id, p_new_start: start, p_employee_id: employeeId }).then(unwrap);
export const updateAppointmentStatus = (id, status) =>
  supabase.rpc('update_appointment_status', { p_appointment_id: id, p_status: status }).then(unwrap);

/** Seleção padrão de agendamento com relações usadas nas telas de cliente/admin. */
export const APPOINTMENT_SELECT = `
  id, starts_at, ends_at, status, price, notes, reschedule_count, cancel_reason, cancelled_at, cancellation_fee,
  client_id, employee_id, service_id, created_at, is_test_data,
  service:services(id, name, duration_minutes, image_url, payment_mode),
  employee:employees(id, display_name),
  payments(id, amount, kind, method, status, provider, created_at, paid_at, refund_amount)`;
