import { getAccessToken, getHeaders, getTenantId } from './servicetitan/auth.js';

const HST_RATE = 1.13;

// Same JOB_TYPE_MAP as the Win the Day front-end
const JOB_TYPE_MAP = {
  'Install HVAC': 'Install',
  'Service - Old JT': 'Service',
  'Diagnostic or Call Out - Residential HVAC': 'Service',
  'Diagnostic or Call Out - Commercial HVAC': 'Service',
  'Repair': 'Service',
  'Workmanship Callback': 'Service',
  'Warranty Repair': 'Service',
  'Service Workmanship Callback': 'Service',
  'Commercial Maintenance': 'Service',
  'Imported Default JobType': 'Service',
  'Residential Maintenance 1 Piece': 'Maintenance',
  'Residential Maintenance 2 piece': 'Maintenance',
  'Residential Maintanance 2 Piece': 'Maintenance',
  'Residential Membership Plan Visit': 'Maintenance',
  'Residential Duct Cleaning': 'Ducts',
};

// Job types that count as "Leads" (sales appointments)
const LEAD_JOB_TYPES = ['Sales Visit', 'Sales Follow Up'];
// Job types that count as "Plan Sales" goal
const PLAN_JOB_TYPES = ['Residential Membership Plan Visit'];

// Calculate today + next 2 business days (skip weekends) in EST
function getThreeBusinessDays() {
  const now = new Date();
  const estMs = now.getTime() + (now.getTimezoneOffset() * 60000) - (5 * 3600000);
  const est = new Date(estMs);
  const today = new Date(est.getFullYear(), est.getMonth(), est.getDate());
  const days = [today];
  let current = new Date(today);
  let added = 0;
  while (added < 2) {
    current.setDate(current.getDate() + 1);
    if (current.getDay() !== 0 && current.getDay() !== 6) {
      days.push(new Date(current));
      added++;
    }
  }
  return days;
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getDayLabel(d, isToday) {
  const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (isToday) return `Today — ${dayName}, ${monthDay}`;
  return `${dayName}, ${monthDay}`;
}

async function fetchJobTypes(tenantId, headers) {
  const allTypes = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const url = new URL(`https://api.servicetitan.io/jpm/v2/tenant/${tenantId}/job-types`);
    url.searchParams.append('page', page);
    url.searchParams.append('pageSize', 100);
    const response = await fetch(url, { headers });
    if (!response.ok) break;
    const data = await response.json();
    allTypes.push(...(data.data || []));
    hasMore = data.hasMore;
    page++;
    if (page > 10) break;
  }
  return Object.fromEntries(allTypes.map(jt => [jt.id, jt.name]));
}

async function fetchDayAppointments(tenantId, headers, dateStr, nextDateStr) {
  const all = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const url = new URL(`https://api.servicetitan.io/jpm/v2/tenant/${tenantId}/appointments`);
    url.searchParams.append('startsOnOrAfter', dateStr);
    url.searchParams.append('startsBefore', nextDateStr);
    url.searchParams.append('page', page);
    url.searchParams.append('pageSize', 200);
    const response = await fetch(url, { headers });
    if (!response.ok) break;
    const data = await response.json();
    all.push(...(data.data || []));
    hasMore = data.hasMore;
    page++;
    if (page > 10) break;
  }
  return all.filter(a => {
    const status = (a.status || '').toLowerCase();
    return status !== 'canceled' && status !== 'cancelled' && status !== 'unused';
  });
}

async function fetchJobById(tenantId, headers, jobId) {
  try {
    const url = `https://api.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${jobId}`;
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return response.json();
  } catch { return null; }
}

async function batchFetchJobs(tenantId, headers, jobIds) {
  const jobs = {};
  const batchSize = 15;
  for (let i = 0; i < jobIds.length; i += batchSize) {
    const batch = jobIds.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(id => fetchJobById(tenantId, headers, id)));
    batch.forEach((id, idx) => { if (results[idx]) jobs[id] = results[idx]; });
    if (i + batchSize < jobIds.length) await new Promise(r => setTimeout(r, 50));
  }
  return jobs;
}

export default async function handler(req, res) {
  try {
    const accessToken = await getAccessToken();
    const tenantId = getTenantId();
    const headers = getHeaders(accessToken);

    // Fetch job type lookup table
    const jtMap = await fetchJobTypes(tenantId, headers);

    const businessDays = getThreeBusinessDays();

    // Fetch appointments for all 3 days in parallel
    const allDayAppointments = await Promise.all(
      businessDays.map(day => {
        const dateStr = toDateStr(day);
        const nextDay = new Date(day);
        nextDay.setDate(nextDay.getDate() + 1);
        return fetchDayAppointments(tenantId, headers, dateStr, toDateStr(nextDay));
      })
    );

    // Collect unique job IDs per day
    const allJobIds = new Set();
    const dayJobIds = [];
    allDayAppointments.forEach(appointments => {
      const jobIds = [...new Set(appointments.map(a => a.jobId).filter(Boolean))];
      dayJobIds.push(jobIds);
      jobIds.forEach(id => allJobIds.add(id));
    });

    // Batch fetch all unique jobs
    const jobsMap = await batchFetchJobs(tenantId, headers, [...allJobIds]);

    // =============================================
    // APPOINTMENT-BASED REVENUE ALLOCATION
    // =============================================
    const dayApptCounts = [];
    const jobTotalAppts = {};

    allDayAppointments.forEach((appointments, dayIdx) => {
      const counts = {};
      appointments.forEach(a => {
        if (!a.jobId) return;
        counts[a.jobId] = (counts[a.jobId] || 0) + 1;
        jobTotalAppts[a.jobId] = (jobTotalAppts[a.jobId] || 0) + 1;
      });
      dayApptCounts.push(counts);
    });

    const multiDayJobs = [];

    // Build day summaries with department breakdowns
    const days = businessDays.map((day, i) => {
      const jobIds = dayJobIds[i];
      const apptCounts = dayApptCounts[i];
      const depts = { Install: { jobs: 0, rev: 0 }, Service: { jobs: 0, rev: 0 }, Maintenance: { jobs: 0, rev: 0 }, Ducts: { jobs: 0, rev: 0 } };
      let leadsRun = 0;
      let leadsRevenue = 0;
      let planSales = 0;
      let totalJobs = 0;
      let totalRevenue = 0;
      let excluded = 0;

      jobIds.forEach(id => {
        const job = jobsMap[id];
        if (!job) return;

        const jobTypeName = jtMap[job.jobTypeId] || '';
        const dept = JOB_TYPE_MAP[jobTypeName] || null;
        const fullPreTaxRevenue = Math.round(((job.total || 0) / HST_RATE) * 100) / 100;

        // Split revenue by this day's appointment share
        const dayAppts = apptCounts[id] || 1;
        const totalAppts = jobTotalAppts[id] || 1;
        const allocatedRevenue = Math.round((fullPreTaxRevenue * dayAppts / totalAppts) * 100) / 100;

        // Track multi-day jobs for debugging (only log once on first day seen)
        if (totalAppts > 1 && i === 0 && apptCounts[id]) {
          multiDayJobs.push({
            jobId: id,
            jobType: jobTypeName,
            fullRevenue: fullPreTaxRevenue,
            totalAppointments: totalAppts,
            dayBreakdown: dayApptCounts.map((dc, di) => ({
              day: toDateStr(businessDays[di]),
              appointments: dc[id] || 0
            })).filter(d => d.appointments > 0)
          });
        }

        // Track leads (Sales Visit / Sales Follow Up) separately
        if (LEAD_JOB_TYPES.includes(jobTypeName)) {
          leadsRun++;
          leadsRevenue += allocatedRevenue;
        }

        // Track plan sales
        if (PLAN_JOB_TYPES.includes(jobTypeName)) planSales++;

        if (dept) {
          depts[dept].jobs++;
          depts[dept].rev += allocatedRevenue;
          totalJobs++;
          totalRevenue += allocatedRevenue;
        } else {
          excluded++;
        }
      });

      return {
        date: toDateStr(day),
        label: getDayLabel(day, i === 0),
        isToday: i === 0,
        totalJobs,
        totalRevenue: Math.round(totalRevenue),
        departments: depts,
        leadsRun,
        leadsRevenue: Math.round(leadsRevenue),
        planSales,
        excluded
      };
    });

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      days,
      multiDayJobs: multiDayJobs.length > 0 ? multiDayJobs : undefined
    });
  } catch (error) {
    console.error('Upcoming WTD fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
