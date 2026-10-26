export const initialSchema = `
CREATE TABLE workflows (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), document TEXT NOT NULL CHECK(json_valid(document)));
CREATE TABLE site_profiles (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), document TEXT NOT NULL CHECK(json_valid(document)));
CREATE TABLE items (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), document TEXT NOT NULL CHECK(json_valid(document)));
CREATE INDEX items_url ON items(json_extract(document, '$.url'));
CREATE TABLE download_jobs (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), document TEXT NOT NULL CHECK(json_valid(document)));
CREATE INDEX download_jobs_item ON download_jobs(json_extract(document, '$.itemId'));
CREATE TABLE run_log (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), document TEXT NOT NULL CHECK(json_valid(document)));
CREATE TABLE settings (key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), document TEXT NOT NULL CHECK(json_valid(document)));
`;
