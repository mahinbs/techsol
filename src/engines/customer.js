'use strict';

/**
 * Customer identification (#2 / #20).
 *
 * Resolve an enquiry's customer to an EXISTING Zoho Books contact, matching by a
 * stable identifier first — email, then phone — and only then by an exact name,
 * before ever creating a new contact. This is what stops the same customer being
 * duplicated in Books, and it lets the rest of the flow pull that customer's own
 * history (prices, discounts) instead of treating every enquiry as a stranger.
 *
 * Works the same for both channels: email enquiries match on the sender address,
 * WhatsApp enquiries match on the sender phone number.
 *
 * All matching is best-effort against Zoho — callers wrap it so a Zoho outage
 * never blocks the enquiry; it just falls back to the name/create path.
 */

function pickContact(resp) {
  const list = resp && Array.isArray(resp.contacts) ? resp.contacts : [];
  if (!list.length) return null;
  // The list is already constrained to the identifier we filtered on; prefer an
  // active contact, else take the first.
  return list.find((c) => String(c.status || 'active').toLowerCase() === 'active') || list[0];
}

/** Turn an enquiry's sender into an {email} or {phone} identifier by channel. */
function senderIdentifier({ source, sender } = {}) {
  const s = String(sender || '').trim();
  if (!s) return {};
  if (source === 'whatsapp') return { phone: s.replace(/[^\d+]/g, '') };
  if (s.includes('@')) return { email: s.toLowerCase() };
  if (/^\+?\d[\d\s-]{6,}$/.test(s)) return { phone: s.replace(/[^\d+]/g, '') };
  return { email: s.toLowerCase() };
}

/**
 * Look up an existing contact by email → phone → exact name.
 * @returns {Promise<{contact:object, matchedBy:'email'|'phone'|'name'}|null>}
 */
async function findContact(zoho, { name, email, phone } = {}) {
  if (email) {
    const c = pickContact(await zoho.booksListContactsBy({ email }));
    if (c && c.contact_id) return { contact: c, matchedBy: 'email' };
  }
  if (phone) {
    const c = pickContact(await zoho.booksListContactsBy({ phone }));
    if (c && c.contact_id) return { contact: c, matchedBy: 'phone' };
  }
  const nm = String(name || '').trim();
  if (nm) {
    const r = await zoho.booksListContacts(nm);
    const list = r && Array.isArray(r.contacts) ? r.contacts : [];
    const exact = list.find((c) => String(c.contact_name || '').trim().toLowerCase() === nm.toLowerCase());
    if (exact && exact.contact_id) return { contact: exact, matchedBy: 'name' };
  }
  return null;
}

/**
 * Resolve to an existing contact, or create one if there is genuinely no match.
 * @returns {Promise<{id:string, name:string, matchedBy:'email'|'phone'|'name'|'created', email?:string, phone?:string}>}
 */
async function resolveContact(zoho, { name, email, phone, contactType = 'customer' } = {}) {
  const found = await findContact(zoho, { name, email, phone });
  if (found) {
    const c = found.contact;
    return { id: String(c.contact_id), name: c.contact_name || name || '', matchedBy: found.matchedBy, email: c.email, phone: c.phone };
  }
  const nm = String(name || '').trim() || email || phone || 'Walk-in';
  const created = await zoho.booksCreateContact({
    contact_name: nm,
    contact_type: contactType,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  });
  if (!created.id) throw new Error(`Could not resolve or create ${contactType} "${nm}" in Zoho Books.`);
  return { id: String(created.id), name: nm, matchedBy: 'created', email, phone };
}

module.exports = { resolveContact, findContact, senderIdentifier, pickContact };
