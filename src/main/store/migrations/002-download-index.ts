// Milestone 6: the queue looks jobs up by status (startup recovery, scheduling) and by content hash (dedupe), and
// items by URL (already exists in 001). Expression indexes keep the documents the single source of truth.
export const downloadIndexes = `
CREATE INDEX download_jobs_status ON download_jobs(json_extract(document, '$.status'));
CREATE INDEX download_jobs_sha256 ON download_jobs(json_extract(document, '$.sha256'));
CREATE INDEX download_jobs_created ON download_jobs(json_extract(document, '$.createdAt'));
`;
