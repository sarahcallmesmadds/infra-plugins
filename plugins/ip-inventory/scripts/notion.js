// Reads the inventory out of Notion over the REST API.
//
// Deliberately read-only. There is no update or create function in this file,
// so "the audit cannot change your record" is something you can verify by
// reading it rather than something the documentation asserts.
//
// The REST API is used directly rather than an MCP server for two reasons: a
// scheduled run has no MCP host to talk to, and the same code then works from
// Codex, cron and a session without three code paths.

'use strict';

const { notionToken } = require('./config');

const API = 'https://api.notion.com/v1';

function queryUrl(config) {
  const { endpointStyle, dataSourceId } = config.notion;
  // The two styles are not interchangeable, and each rejects the other's URL.
  // See the apiVersion comment in config.js.
  if (endpointStyle === 'databases') return `${API}/databases/${dataSourceId}/query`;
  return `${API}/data_sources/${dataSourceId}/query`;
}

// One page of results. Throws with the API's own message, because Notion's
// errors say exactly what is wrong ("Invalid request URL", "object_not_found")
// and rewording them would only lose detail.
async function queryPage(config, token, startCursor) {
  const body = { page_size: 100 };
  if (startCursor) body.start_cursor = startCursor;

  const response = await fetch(queryUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': config.notion.apiVersion,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Notion returned ${response.status} and a body that is not JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`Notion ${response.status} ${payload.code || ''}: ${payload.message || text.slice(0, 200)}`);
  }
  return payload;
}

// Every row, following pagination.
async function fetchRows(config) {
  if (!config.notion.dataSourceId) {
    throw new Error(
      `No database configured. Set notion.dataSourceId in ${config.configPath}.`
    );
  }
  const token = notionToken(config);
  if (!token) {
    throw new Error(
      `No Notion token. Export ${config.notion.tokenEnv}, or set notion.tokenFile in ${config.configPath} `
      + 'to a .env-style file (a scheduled run does not inherit an exported variable).'
    );
  }

  const pages = [];
  let cursor;
  do {
    const payload = await queryPage(config, token, cursor);
    pages.push(...payload.results);
    cursor = payload.has_more ? payload.next_cursor : null;
  } while (cursor);

  return pages;
}

// Flattens one Notion property object to a plain value.
//
// Switching on the property's own `type` rather than assuming one means a
// column changed from, say, status to select keeps reading correctly. That
// exact change was made to this database by hand, so it is not hypothetical.
function readProperty(property) {
  if (!property) return null;
  switch (property.type) {
    case 'title':
    case 'rich_text': {
      const parts = property[property.type] || [];
      const text = parts.map((part) => part.plain_text).join('');
      return text.length ? text : null;
    }
    case 'select':
      return property.select ? property.select.name : null;
    case 'status':
      return property.status ? property.status.name : null;
    case 'multi_select':
      return (property.multi_select || []).map((option) => option.name);
    case 'checkbox':
      // Notion returns false both for "unticked" and for "never set". They are
      // not distinguishable through the API, so callers must not read false as
      // a deliberate no.
      return property.checkbox === true;
    case 'url':
      return property.url || null;
    case 'date':
      return property.date ? property.date.start : null;
    case 'relation':
      return (property.relation || []).map((item) => item.id);
    case 'created_time':
      return property.created_time || null;
    case 'people':
      return (property.people || []).map((person) => person.id);
    default:
      return null;
  }
}

// Maps a Notion page to the flat row shape the rest of the plugin uses.
function toRow(page, properties) {
  const row = { id: page.id, url: page.url };
  for (const [logical, column] of Object.entries(properties)) {
    row[logical] = readProperty(page.properties[column]);
  }
  return row;
}

// Names in the property map that no column in the database answers to.
//
// Reported rather than ignored. A logical field silently reading null on all 88
// rows looks identical to a column everyone left blank, and the audit would
// then confidently report no drift on a field it never actually read.
function missingColumns(page, properties) {
  if (!page) return [];
  return Object.entries(properties)
    .filter(([, column]) => !(column in page.properties))
    .map(([logical, column]) => ({ logical, column }));
}

async function loadInventory(config) {
  const pages = await fetchRows(config);
  return {
    rows: pages.map((page) => toRow(page, config.properties)),
    missing: missingColumns(pages[0], config.properties),
    count: pages.length,
  };
}

module.exports = { loadInventory, fetchRows, toRow, readProperty, missingColumns };
