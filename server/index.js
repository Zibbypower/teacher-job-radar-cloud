const candidate = {
  name: "史可微",
  targetRole: "高中英语教师",
  locationAnchor: "红莲南路地铁站",
  strengths: ["北京户籍", "应届硕士", "留学生", "英语语言文学", "高中英语", "专八", "雅思", "北京五中"]
};

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    pool TEXT NOT NULL DEFAULT 'teacher',
    title TEXT NOT NULL,
    school_name TEXT,
    district TEXT,
    area_preference TEXT,
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    detail_url TEXT NOT NULL,
    published_at TEXT,
    deadline_at TEXT,
    summary TEXT,
    contacts TEXT,
    requirements TEXT,
    apply_method TEXT,
    tier TEXT NOT NULL DEFAULT '未评级',
    tier_score INTEGER NOT NULL DEFAULT 0,
    match_score INTEGER NOT NULL DEFAULT 0,
    location_score INTEGER NOT NULL DEFAULT 0,
    urgency_score INTEGER NOT NULL DEFAULT 0,
    total_score INTEGER NOT NULL DEFAULT 0,
    match_label TEXT NOT NULL DEFAULT '需人工确认',
    status TEXT NOT NULL DEFAULT 'new',
    notes TEXT NOT NULL DEFAULT '',
    commute_minutes INTEGER,
    commute_distance_meters INTEGER,
    commute_status TEXT NOT NULL DEFAULT 'not_configured',
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    raw_text TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_jobs_pool_score ON jobs(pool, total_score DESC)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_deadline ON jobs(deadline_at)",
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    category TEXT NOT NULL,
    pool TEXT NOT NULL,
    last_checked_at TEXT,
    last_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT NOT NULL DEFAULT '',
    last_new_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    source_count INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT ''
  )`
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        await ensureSchema(env.DB);
        return await routeApi(request, env, url);
      } catch (error) {
        return json({ error: error.message || "Unexpected error" }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};

async function routeApi(request, env, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({
      ok: true,
      cloud: true,
      syncConfigured: Boolean(env.SYNC_TOKEN),
      accessCodeRequired: Boolean(env.APP_ACCESS_CODE)
    });
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const accessError = requireAppAccess(request, env);
    if (accessError) return accessError;
    const filters = {
      pool: url.searchParams.get("pool") || "teacher",
      status: url.searchParams.get("status") || "all",
      query: url.searchParams.get("query") || "",
      limit: Number(url.searchParams.get("limit") || 300)
    };
    const [jobs, sources, scans, stats] = await Promise.all([
      listJobs(env.DB, filters),
      listSources(env.DB),
      listScans(env.DB),
      getStats(env.DB)
    ]);
    return json({ candidate, stats, jobs, sources, scans, sourceDefinitions: [], cloudMode: true });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const accessError = requireAppAccess(request, env);
    if (accessError) return accessError;
    const id = decodeURIComponent(url.pathname.replace("/api/jobs/", ""));
    const job = await getJob(env.DB, id);
    return job ? json(job) : json({ error: "Job not found" }, 404);
  }

  if (request.method === "PATCH" && url.pathname.startsWith("/api/jobs/")) {
    const accessError = requireAppAccess(request, env);
    if (accessError) return accessError;
    const id = decodeURIComponent(url.pathname.replace("/api/jobs/", ""));
    const payload = await request.json();
    const job = await updateJob(env.DB, id, payload);
    return job ? json(job) : json({ error: "Job not found" }, 404);
  }

  if (request.method === "POST" && url.pathname === "/api/sync") {
    if (!env.SYNC_TOKEN) return json({ error: "SYNC_TOKEN is not configured" }, 503);
    if ((request.headers.get("authorization") || "") !== `Bearer ${env.SYNC_TOKEN}`) {
      return json({ error: "Unauthorized" }, 401);
    }
    const payload = await request.json();
    return json(await syncPayload(env.DB, payload));
  }

  return json({ error: "Not found" }, 404);
}

function requireAppAccess(request, env) {
  if (!env.APP_ACCESS_CODE) return null;
  if (request.headers.get("x-app-access-code") === env.APP_ACCESS_CODE) return null;
  return json({ error: "访问码不正确" }, 401);
}

async function ensureSchema(db) {
  await db.batch(schemaStatements.map(statement => db.prepare(statement)));
}

async function listJobs(db, filters) {
  const where = [];
  const binds = [];
  if (filters.pool && filters.pool !== "all") {
    where.push("pool = ?");
    binds.push(filters.pool);
  }
  if (filters.status && filters.status !== "all") {
    where.push("status = ?");
    binds.push(filters.status);
  }
  if (filters.query) {
    where.push("(title LIKE ? OR school_name LIKE ? OR raw_text LIKE ? OR summary LIKE ?)");
    const q = `%${filters.query}%`;
    binds.push(q, q, q, q);
  }
  const result = await db.prepare(`
    SELECT * FROM jobs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE WHEN status = 'archived' THEN 1 ELSE 0 END,
      total_score DESC,
      COALESCE(deadline_at, '9999-12-31') ASC,
      updated_at DESC
    LIMIT ?
  `).bind(...binds, filters.limit).all();
  return (result.results || []).map(rowToJob);
}

async function getJob(db, id) {
  const row = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
  return row ? rowToJob(row) : null;
}

async function updateJob(db, id, patch) {
  const allowed = { status: "status", notes: "notes", tier: "tier", tierScore: "tier_score" };
  const entries = Object.entries(patch || {}).filter(([key]) => allowed[key]);
  if (!entries.length) return getJob(db, id);
  const assignments = entries.map(([key]) => `${allowed[key]} = ?`).join(", ");
  const values = entries.map(([, value]) => value);
  await db.prepare(`UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`)
    .bind(...values, new Date().toISOString(), id)
    .run();
  return getJob(db, id);
}

async function listSources(db) {
  const result = await db.prepare("SELECT * FROM sources ORDER BY pool, category, name").all();
  return result.results || [];
}

async function listScans(db) {
  const result = await db.prepare("SELECT * FROM scans ORDER BY id DESC LIMIT 12").all();
  return result.results || [];
}

async function getStats(db) {
  const rows = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM jobs"),
    db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'new'"),
    db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE match_label = '建议投递'"),
    db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE deadline_at IS NOT NULL AND julianday(deadline_at) - julianday('now') <= 3"),
    db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE pool = 'teacher'"),
    db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE pool = 'public-sector'")
  ]);
  return {
    jobs: rows[0].results[0].count,
    newJobs: rows[1].results[0].count,
    recommended: rows[2].results[0].count,
    urgent: rows[3].results[0].count,
    teacher: rows[4].results[0].count,
    publicSector: rows[5].results[0].count
  };
}

async function syncPayload(db, payload) {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const scans = Array.isArray(payload.scans) ? payload.scans : [];
  for (const job of jobs) await upsertSyncedJob(db, job);
  for (const source of sources) await upsertSource(db, source);
  for (const scan of scans.slice(0, 50)) await upsertScan(db, scan);
  return { ok: true, jobs: jobs.length, sources: sources.length, scans: Math.min(scans.length, 50) };
}

async function upsertSource(db, source) {
  await db.prepare(`
    INSERT INTO sources (id, name, url, category, pool, last_checked_at, last_status, last_error, last_new_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url,
      category = excluded.category, pool = excluded.pool, last_checked_at = excluded.last_checked_at,
      last_status = excluded.last_status, last_error = excluded.last_error, last_new_count = excluded.last_new_count
  `).bind(
    source.id, source.name, source.url, source.category, source.pool,
    source.last_checked_at || source.lastCheckedAt || null,
    source.last_status || source.lastStatus || "pending",
    source.last_error || source.lastError || "",
    source.last_new_count || source.lastNewCount || 0
  ).run();
}

async function upsertScan(db, scan) {
  await db.prepare(`
    INSERT INTO scans (id, started_at, finished_at, status, source_count, new_count, updated_count, error_count, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, finished_at = excluded.finished_at,
      status = excluded.status, source_count = excluded.source_count, new_count = excluded.new_count,
      updated_count = excluded.updated_count, error_count = excluded.error_count, summary = excluded.summary
  `).bind(
    scan.id, scan.started_at || scan.startedAt, scan.finished_at || scan.finishedAt || null,
    scan.status, scan.source_count || scan.sourceCount || 0, scan.new_count || scan.newCount || 0,
    scan.updated_count || scan.updatedCount || 0, scan.error_count || scan.errorCount || 0, scan.summary || ""
  ).run();
}

async function upsertSyncedJob(db, job) {
  await db.prepare(`
    INSERT INTO jobs (
      id, pool, title, school_name, district, area_preference, source_name, source_url,
      detail_url, published_at, deadline_at, summary, contacts, requirements, apply_method,
      tier, tier_score, match_score, location_score, urgency_score, total_score, match_label,
      status, notes, commute_minutes, commute_distance_meters, commute_status, discovered_at,
      updated_at, raw_text, fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET pool = excluded.pool, title = excluded.title,
      school_name = excluded.school_name, district = excluded.district, area_preference = excluded.area_preference,
      source_name = excluded.source_name, source_url = excluded.source_url, detail_url = excluded.detail_url,
      published_at = excluded.published_at, deadline_at = excluded.deadline_at, summary = excluded.summary,
      contacts = excluded.contacts, requirements = excluded.requirements, apply_method = excluded.apply_method,
      tier = excluded.tier, tier_score = excluded.tier_score, match_score = excluded.match_score,
      location_score = excluded.location_score, urgency_score = excluded.urgency_score, total_score = excluded.total_score,
      match_label = excluded.match_label, commute_minutes = excluded.commute_minutes,
      commute_distance_meters = excluded.commute_distance_meters, commute_status = excluded.commute_status,
      updated_at = excluded.updated_at, raw_text = excluded.raw_text, fingerprint = excluded.fingerprint
  `).bind(
    job.id, job.pool || "teacher", job.title, job.schoolName || job.school_name || null,
    job.district || null, job.areaPreference || job.area_preference || null,
    job.sourceName || job.source_name, job.sourceUrl || job.source_url, job.detailUrl || job.detail_url,
    job.publishedAt || job.published_at || null, job.deadlineAt || job.deadline_at || null,
    job.summary || "", job.contacts || "", job.requirements || "", job.applyMethod || job.apply_method || "",
    job.tier || "未评级", job.tierScore || job.tier_score || 0, job.matchScore || job.match_score || 0,
    job.locationScore || job.location_score || 0, job.urgencyScore || job.urgency_score || 0,
    job.totalScore || job.total_score || 0, job.matchLabel || job.match_label || "需人工确认",
    job.status || "new", job.notes || "", job.commuteMinutes ?? job.commute_minutes ?? null,
    job.commuteDistanceMeters ?? job.commute_distance_meters ?? null,
    job.commuteStatus || job.commute_status || "not_configured",
    job.discoveredAt || job.discovered_at || new Date().toISOString(),
    job.updatedAt || job.updated_at || new Date().toISOString(),
    job.rawText || job.raw_text || "", job.fingerprint || job.id
  ).run();
}

function rowToJob(row) {
  return {
    id: row.id, pool: row.pool, title: row.title, schoolName: row.school_name,
    district: row.district, areaPreference: row.area_preference, sourceName: row.source_name,
    sourceUrl: row.source_url, detailUrl: row.detail_url, publishedAt: row.published_at,
    deadlineAt: row.deadline_at, summary: row.summary, contacts: row.contacts,
    requirements: row.requirements, applyMethod: row.apply_method, tier: row.tier,
    tierScore: row.tier_score, matchScore: row.match_score, locationScore: row.location_score,
    urgencyScore: row.urgency_score, totalScore: row.total_score, matchLabel: row.match_label,
    status: row.status, notes: row.notes, commuteMinutes: row.commute_minutes,
    commuteDistanceMeters: row.commute_distance_meters, commuteStatus: row.commute_status,
    discoveredAt: row.discovered_at, updatedAt: row.updated_at, rawText: row.raw_text,
    fingerprint: row.fingerprint
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
