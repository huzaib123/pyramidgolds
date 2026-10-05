// Paste this into the Leads Google Sheet: Extensions -> Apps Script.
// Set SECRET to the same value as the SHEET_WEBHOOK_SECRET GitHub secret, then
// Deploy -> New deployment -> Web app (Execute as: Me, Who has access: Anyone).
// The deployment's URL is the SHEET_WEBHOOK_URL secret.

const SECRET = 'PASTE_THE_SAME_SECRET_HERE';
const TAB = 'Leads';

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'bad json' }); }
  if (!data || data.secret !== SECRET || !Array.isArray(data.row)) return reply({ ok: false, error: 'forbidden' });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB) || SpreadsheetApp.getActiveSpreadsheet().insertSheet(TAB);
  if (sheet.getLastRow() === 0) sheet.appendRow(['Time', 'Name', 'Contact', 'Inquiry', 'Status']);
  // A leading apostrophe stores each value as plain text: phone numbers keep their +, and nothing runs as a formula.
  const row = data.row.slice(0, 5).map(v => "'" + String(v == null ? '' : v).slice(0, 300));
  sheet.appendRow(row);
  return reply({ ok: true });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
