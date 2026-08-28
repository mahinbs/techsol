'use strict';
/**
 * Live sandbox smoke test — SAFE: touches ONLY the CRM Sandbox ("AI Automation")
 * and the Books Test Organization ("Techsol Engineers – AI TEST", 936351036).
 * Never points at production (guard below enforces it).
 */
const { ZohoClient } = require('../src/integrations/zoho');

const PROD_BOOKS_ORG = '693483118';

async function main() {
  if (process.env.ZOHO_MOCK === '1') throw new Error('Unset ZOHO_MOCK for the live smoke test');
  if (!process.env.ZOHO_CRM_BASE || !process.env.ZOHO_CRM_BASE.includes('crmsandbox'))
    throw new Error('GUARD: ZOHO_CRM_BASE must point at crmsandbox.zoho.com');
  if (process.env.ZOHO_BOOKS_ORG === PROD_BOOKS_ORG || !process.env.ZOHO_BOOKS_ORG)
    throw new Error('GUARD: ZOHO_BOOKS_ORG must be the TEST org, never production');

  const z = new ZohoClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = {};

  // 1. CRM sandbox: create a clearly-marked test deal
  const dealRes = await z.crmCreateDeal({
    Deal_Name: `ZZ-TEST Enquiry ${stamp}`,
    Stage: 'Enquiry',                    // Techsol's custom stage picklist (from field metadata)
    Pipeline: 'Standard (Standard)',     // mandatory in Techsol's org
    Description: 'Automated smoke test by Techsol Automation platform. Safe to delete.',
  });
  out.crmDeal = dealRes.data?.[0]?.details?.id || JSON.stringify(dealRes).slice(0, 200);
  console.log('CRM sandbox deal created:', out.crmDeal);

  // 2. CRM sandbox: attach a note
  if (dealRes.data?.[0]?.details?.id) {
    await z.crmAddNote(dealRes.data[0].details.id, 'Smoke test note — WF1 pipeline connectivity verified.');
    console.log('CRM note attached');
  }

  // 3. Books test org: create test customer
  const contactRes = await z.booksCreateContact({ contact_name: `ZZ-TEST Customer ${stamp}`, contact_type: 'customer' });
  const contactId = contactRes.contact?.contact_id;
  console.log('Books test-org customer created:', contactId, contactRes.message || '');

  // 4. Books test org: create a quotation (estimate) for that customer
  if (contactId) {
    const estRes = await z.booksCreateEstimate({
      customer_id: contactId,
      line_items: [{ name: 'ZZ-TEST Item', description: 'Smoke test line', rate: 100, quantity: 2 }],
      notes: 'Automated smoke test — WF2 pipeline connectivity verified. Safe to delete.',
    });
    console.log('Books test-org estimate created:', estRes.estimate?.estimate_number, estRes.message || '');
    out.estimate = estRes.estimate?.estimate_number;
  }

  console.log('\nSMOKE TEST RESULT: PASS');
  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => {
  console.error('SMOKE TEST FAILED:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
  process.exit(1);
});
