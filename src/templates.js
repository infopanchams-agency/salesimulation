'use strict';
// Source of truth for decision templates (PRD 5.1). The form and server validation both read this.

const COMPLIANCE_LINE =
  'Simulated people must not model threats, harassment, or false urgency toward customers.';

const TEMPLATES = [
  {
    id: 'settlement_offer',
    label: 'Settlement or waiver offer',
    enabled: true,
    compliance: true,
    required: ['settlement_offer'],
    optional: ['dues_context', 'validity', 'eligible_accounts'],
    frame: 'A collections team plans to offer a settlement or waiver to overdue borrowers.',
  },
  {
    id: 'cancel_save_offer',
    label: 'Cancellation save-offer change',
    enabled: true,
    compliance: false,
    required: ['new_offer'],
    optional: ['current_offer', 'monthly_fee', 'eligible_accounts'],
    frame: 'A retention team plans to change the offer shown to customers who ask to cancel.',
  },
  {
    id: 'refund_goodwill',
    label: 'Refund or goodwill policy change',
    enabled: true,
    compliance: false,
    required: ['new_policy'],
    optional: ['current_policy', 'cap'],
    frame: 'A support team plans to change its refund or goodwill policy.',
  },
  {
    id: 'sales_script',
    label: 'Sales script or objection-handling change',
    enabled: true,
    compliance: false,
    required: ['new_script'],
    optional: ['old_script', 'target_objection'],
    frame: 'A sales team plans to change its pitch or how it handles a common objection.',
  },
  // Parked (PRD 3): present in code, never exposed.
  {
    id: 'price_change',
    label: 'Price or discount change',
    enabled: false,
    compliance: false,
    required: ['new_price'],
    optional: ['current_price', 'competitor'],
    frame: 'A company plans to change its price or discount.',
  },
  {
    id: 'rep_incentive',
    label: 'Rep incentive or quota change',
    enabled: false,
    compliance: false,
    required: ['new_plan'],
    optional: ['current_plan', 'team_context'],
    frame: 'A company plans to change its rep incentive or quota plan.',
  },
];

// Human labels and placeholders for the form.
const FIELD_META = {
  settlement_offer: { label: 'Settlement offer', placeholder: 'e.g. 70% of dues in one payment' },
  dues_context: { label: 'Dues context', placeholder: 'e.g. average dues INR 40,000, 90+ days overdue' },
  validity: { label: 'Offer validity', placeholder: 'e.g. valid for 15 days' },
  eligible_accounts: { label: 'Eligible accounts', placeholder: 'e.g. accounts 90 to 180 days overdue' },
  new_offer: { label: 'New save offer', placeholder: 'e.g. 3 months at 50% off' },
  current_offer: { label: 'Current save offer', placeholder: 'e.g. 1 month free' },
  monthly_fee: { label: 'Monthly fee', placeholder: 'e.g. INR 799' },
  new_policy: { label: 'New policy', placeholder: 'e.g. instant refund up to INR 2,000 without approval' },
  current_policy: { label: 'Current policy', placeholder: 'e.g. all refunds need supervisor approval' },
  cap: { label: 'Cap', placeholder: 'e.g. max 2 goodwill credits per customer per year' },
  new_script: { label: 'New script or approach', placeholder: 'e.g. open with a 2-minute ROI calculator' },
  old_script: { label: 'Current script', placeholder: 'e.g. open with a product demo' },
  target_objection: { label: 'Objection it targets', placeholder: 'e.g. "your price is too high"' },
  new_price: { label: 'New price' },
  current_price: { label: 'Current price' },
  competitor: { label: 'Competitor' },
  new_plan: { label: 'New plan' },
  current_plan: { label: 'Current plan' },
  team_context: { label: 'Team context' },
};

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

function enabledTemplates() {
  return TEMPLATES.filter((t) => t.enabled);
}

function publicList() {
  return enabledTemplates().map((t) => ({
    id: t.id,
    label: t.label,
    fields: [...t.required, ...t.optional].map((key) => ({
      key,
      label: (FIELD_META[key] && FIELD_META[key].label) || key,
      placeholder: (FIELD_META[key] && FIELD_META[key].placeholder) || '',
    })),
    required: [...t.required],
  }));
}

module.exports = { TEMPLATES, COMPLIANCE_LINE, getTemplate, enabledTemplates, publicList };
