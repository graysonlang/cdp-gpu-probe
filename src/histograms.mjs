// GPU-related UMA histograms via CDP's Browser domain. These surface stability
// and timing signals — GPU process lifetime, context losses, crashes, draw/swap
// timing — that memory accounting alone can't show.
//
// Two modes:
//   absolute: a snapshot of cumulative counts for this Chrome instance.
//   delta:    the change bracketed around the page's lifetime, so a climbing
//             context-loss / crash count is attributable to the page under test.
//             Browser.getHistograms({delta:true}) returns the change since the
//             previous delta read and resets the running counter, so we take one
//             throwaway delta read as the baseline before navigating.

// Substring filters passed to Browser.getHistograms. Chrome emits thousands of
// histograms; querying by prefix keeps the payload small. Names drift between
// Chrome versions, so the formatter promotes by pattern rather than exact name
// and `--json` always carries the full matched set.
export const GPU_HISTOGRAM_PREFIXES = ['GPU.', 'Memory.GPU.', 'Compositing.', 'Graphics.'];

// Names promoted into the formatted "health" view.
const HEALTH_PATTERN = /lost|crash|lifetime|hang|fallback|blocklist|blacklist|fail|error/i;

function normalize(histogram) {
  return {
    name: histogram.name,
    sum: histogram.sum ?? 0,
    count: histogram.count ?? 0,
    buckets: histogram.buckets || [],
  };
}

// One throwaway delta read zeroes the running delta counters so the next delta
// read reflects only what happened in between.
export async function resetHistogramDelta(client) {
  try {
    await client.send('Browser.getHistograms', { delta: true });
  } catch {
    // delta unsupported on this channel; caller falls back to absolute counts.
  }
}

export async function captureGpuHistograms(client, options = {}) {
  const { prefixes = GPU_HISTOGRAM_PREFIXES, delta = false } = options;

  const byName = new Map();
  for (const query of prefixes) {
    let result;
    try {
      result = await client.send('Browser.getHistograms', { query, delta });
    } catch {
      continue;
    }
    for (const histogram of result.histograms || []) {
      byName.set(histogram.name, normalize(histogram));
    }
  }

  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    delta,
    prefixes,
    health: all.filter(histogram => HEALTH_PATTERN.test(histogram.name) && histogram.count > 0),
    all,
  };
}
